"""Batch tagger: pull N rows, tag with Haiku in parallel, emit a plan CSV.

The CSV is the input contract for `apply_plan.py`. No DB or GCS writes here.
"""

from __future__ import annotations

import argparse
import base64
import csv
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import psycopg
import requests
from anthropic import Anthropic
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(REPO_ROOT / ".env")

MODEL = "claude-haiku-4-5-20251001"
AUTO_THRESHOLD = 0.80   # >= this confidence: marked auto-approve
REVIEW_THRESHOLD = 0.60 # in [REVIEW, AUTO): marked review; below: skip
MAX_WORKERS = 8

PROMPT = """You are tagging a stock image for a news platform's image library.

Given the image plus the priors below, produce a JSON object with:
- "tags": 3-7 lowercase keyword tags ranked by relevance (specific > generic).
- "proposed_filename_stem": filename WITHOUT extension, lowercase, snake_case,
  format `<primary_subject>_<secondary>_<location_if_relevant>_<shortid>`.
  Reuse the existing short id token at the end (the trailing alphanumeric slug)
  if present — it preserves provenance.
- "confidence": 0.0-1.0, your confidence the new name is more accurate than the old.
- "override_geography": true ONLY if you are highly confident the existing
  filename's country/city token is WRONG. Default false — geography priors from
  the database are usually correct and the model often confuses similar places.
- "reason": one short sentence explaining the call.

Priors (existing DB row):
{priors}

Return ONLY the JSON object, no prose."""


def fetch_rows(conn, count: int, folder: str | None):
    sql = """
        SELECT ia.id, ia.public_url, ia.object_path, ia.folder_path, ia.file_name,
               ia.primary_category, ia.generic_category, ia.keywords,
               c.name AS city_name, co.name AS country_name
        FROM image_assets ia
        LEFT JOIN cities c ON c.id = ia.city_id
        LEFT JOIN countries co ON co.id = ia.country_id
        WHERE ia.is_active = true
        {filter}
        ORDER BY random()
        LIMIT %s
    """
    if folder:
        sql = sql.format(filter="AND ia.folder_path = %s")
        params = (folder, count)
    else:
        sql = sql.format(filter="")
        params = (count,)
    with conn.cursor(row_factory=psycopg.rows.dict_row) as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def download_image(url: str) -> tuple[bytes, str]:
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    media_type = r.headers.get("Content-Type", "image/jpeg").split(";")[0]
    return r.content, media_type


def tag_image(client: Anthropic, image_bytes: bytes, media_type: str, row: dict) -> dict:
    priors = {
        "current_file_name": row["file_name"],
        "folder_path": row["folder_path"],
        "primary_category": row["primary_category"],
        "generic_category": row["generic_category"],
        "existing_keywords": row["keywords"],
        "city_from_db": row["city_name"],
        "country_from_db": row["country_name"],
    }
    msg = client.messages.create(
        model=MODEL,
        max_tokens=400,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": base64.standard_b64encode(image_bytes).decode()}},
                    {"type": "text", "text": PROMPT.format(priors=json.dumps(priors, indent=2, default=str))},
                ],
            }
        ],
    )
    text = msg.content[0].text.strip()
    if text.startswith("```"):
        text = text.strip("`").lstrip("json").strip()
    return {"result": json.loads(text), "usage": {"input": msg.usage.input_tokens, "output": msg.usage.output_tokens}}


def cost(usage: dict) -> float:
    return usage["input"] / 1_000_000 * 1.0 + usage["output"] / 1_000_000 * 5.0


def classify(confidence: float) -> str:
    if confidence >= AUTO_THRESHOLD:
        return "auto"
    if confidence >= REVIEW_THRESHOLD:
        return "review"
    return "skip"


def process_one(client: Anthropic, row: dict) -> dict:
    out = {"id": row["id"], "old_object_path": row["object_path"], "old_keywords": row["keywords"], "error": ""}
    try:
        image_bytes, media_type = download_image(row["public_url"])
    except Exception as e:
        out["error"] = f"download: {e}"
        return out
    try:
        tagged = tag_image(client, image_bytes, media_type, row)
    except Exception as e:
        out["error"] = f"tag: {e}"
        return out
    r = tagged["result"]
    ext = Path(row["file_name"]).suffix or ".jpg"
    new_name = f"{r['proposed_filename_stem']}{ext}"
    new_object_path = f"{row['folder_path']}/{new_name}" if row["folder_path"] else new_name
    out.update({
        "new_object_path": new_object_path,
        "new_file_name": new_name,
        "new_keywords": r["tags"],
        "confidence": r["confidence"],
        "override_geography": r["override_geography"],
        "reason": r["reason"],
        "status": classify(float(r["confidence"])),
        "input_tokens": tagged["usage"]["input"],
        "output_tokens": tagged["usage"]["output"],
        "cost_usd": round(cost(tagged["usage"]), 5),
    })
    return out


def write_plan(rows: list[dict], path: Path) -> None:
    fields = ["id", "status", "confidence", "override_geography", "old_object_path", "new_object_path",
              "old_keywords", "new_keywords", "reason", "input_tokens", "output_tokens", "cost_usd", "error"]
    with path.open("w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            row = {**r}
            for k in ("old_keywords", "new_keywords"):
                if isinstance(row.get(k), list):
                    row[k] = "|".join(row[k])
            w.writerow(row)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=50)
    ap.add_argument("--folder", help="optional folder_path filter")
    ap.add_argument("--out", default="scripts/image_tagging/plan.csv")
    args = ap.parse_args()

    db_url = os.environ["DATABASE_URL"]
    api_key = os.environ["ANTHROPIC_API_KEY"]

    with psycopg.connect(db_url) as conn:
        rows = fetch_rows(conn, args.count, args.folder)
    print(f"fetched {len(rows)} rows", file=sys.stderr)

    client = Anthropic(api_key=api_key)
    results: list[dict] = []
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        futs = {ex.submit(process_one, client, row): row for row in rows}
        for i, fut in enumerate(as_completed(futs), 1):
            res = fut.result()
            results.append(res)
            tag = res.get("status") or "ERR"
            print(f"  [{i}/{len(rows)}] id={res['id']:>6} {tag:<6} {res.get('error') or res.get('new_file_name', '')}", file=sys.stderr)

    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    write_plan(results, out_path)

    total_cost = sum(r.get("cost_usd", 0) or 0 for r in results)
    counts = {"auto": 0, "review": 0, "skip": 0, "error": 0}
    for r in results:
        counts["error" if r.get("error") else r.get("status", "error")] += 1
    elapsed = time.time() - t0
    print(f"\nwrote {out_path}", file=sys.stderr)
    print(f"counts: {counts}", file=sys.stderr)
    print(f"cost:   ${total_cost:.4f} for {len(results)} images ({elapsed:.1f}s)", file=sys.stderr)
    if results:
        per_image = total_cost / len(results)
        print(f"        ${per_image:.5f}/image  →  10k images ≈ ${per_image * 10000:.0f}", file=sys.stderr)


if __name__ == "__main__":
    main()
