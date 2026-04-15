"""CLIP-gated hybrid tagger.

For each image, computes how well the existing filename tokens describe the
image using CLIP cosine similarity. If the existing name is a good match
(score >= CLIP_KEEP_THRESHOLD), we skip the Haiku call entirely and emit a
'keep' row. Otherwise we fall back to the same Haiku tagging pipeline as
tag_batch.py.

The hypothesis: many existing filenames are already accurate. CLIP at $0/image
filters those out, leaving Haiku ($0.0026/image) only for the suspicious ones.
"""

from __future__ import annotations

import argparse
import base64
import csv
import io
import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import open_clip
import psycopg
import requests
import torch
from anthropic import Anthropic
from dotenv import load_dotenv
from PIL import Image

REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(REPO_ROOT / ".env")

MODEL = "claude-haiku-4-5-20251001"
CLIP_KEEP_THRESHOLD = 0.27   # cosine sim above this: trust existing filename, skip Haiku
AUTO_THRESHOLD = 0.80
REVIEW_THRESHOLD = 0.60
MAX_HAIKU_WORKERS = 8

PROMPT = """You are tagging a stock image for a news platform's image library.

Given the image plus the priors below, produce a JSON object with:
- "tags": 3-7 lowercase keyword tags ranked by relevance (specific > generic).
- "proposed_filename_stem": filename WITHOUT extension, lowercase, snake_case,
  format `<primary_subject>_<secondary>_<location_if_relevant>_<shortid>`.
  Reuse the existing short id token at the end (the trailing alphanumeric slug)
  if present — it preserves provenance.
- "confidence": 0.0-1.0, your confidence the new name is more accurate than the old.
- "override_geography": true ONLY if you are highly confident the existing
  filename's country/city token is WRONG. Default false.
- "reason": one short sentence explaining the call.

Priors (existing DB row):
{priors}

Return ONLY the JSON object, no prose."""


# ----- DB ------------------------------------------------------------------ #
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


# ----- I/O ----------------------------------------------------------------- #
def download_image(url: str) -> tuple[bytes, str]:
    r = requests.get(url, timeout=30)
    r.raise_for_status()
    media_type = r.headers.get("Content-Type", "image/jpeg").split(";")[0]
    return r.content, media_type


# ----- CLIP scoring -------------------------------------------------------- #
TOKEN_SPLIT = re.compile(r"[_\-\s\.]+")
SHORTID = re.compile(r"^[A-Za-z0-9]{6,}$")
STOPWORDS = {
    "a", "an", "the", "of", "in", "on", "at", "to", "and", "or", "for",
    "with", "from", "by", "is", "are", "was", "were", "be", "been",
    "this", "that", "these", "those", "it", "its", "as", "very", "some",
    "into", "through", "near", "front", "back", "side", "top", "bottom",
    "general", "misc", "imgs", "img", "jpg", "jpeg", "png",
}


def filename_to_phrase(file_name: str) -> str:
    stem = Path(file_name).stem
    tokens = [t.lower() for t in TOKEN_SPLIT.split(stem) if t]
    tokens = [t for t in tokens if not SHORTID.match(t) and not t.isdigit() and t not in STOPWORDS]
    return " ".join(tokens) if tokens else stem.lower()


class ClipScorer:
    def __init__(self):
        self.device = "mps" if torch.backends.mps.is_available() else "cpu"
        self.model, _, self.preprocess = open_clip.create_model_and_transforms("ViT-B-32", pretrained="laion2b_s34b_b79k")
        self.tokenizer = open_clip.get_tokenizer("ViT-B-32")
        self.model.eval().to(self.device)

    @torch.no_grad()
    def score(self, image_bytes: bytes, text: str) -> float:
        img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
        img_t = self.preprocess(img).unsqueeze(0).to(self.device)
        txt_t = self.tokenizer([text]).to(self.device)
        img_f = self.model.encode_image(img_t)
        txt_f = self.model.encode_text(txt_t)
        img_f = img_f / img_f.norm(dim=-1, keepdim=True)
        txt_f = txt_f / txt_f.norm(dim=-1, keepdim=True)
        return float((img_f @ txt_f.T).item())


# ----- Haiku --------------------------------------------------------------- #
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


# ----- Pipeline ------------------------------------------------------------ #
def haiku_step(client: Anthropic, row: dict, image_bytes: bytes, media_type: str, clip_score: float) -> dict:
    out = {"id": row["id"], "old_object_path": row["object_path"], "old_keywords": row["keywords"], "clip_score": round(clip_score, 4), "error": ""}
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
        "decided_by": "haiku",
    })
    return out


PLAN_FIELDS = ["id", "decided_by", "status", "clip_score", "confidence", "override_geography",
               "old_object_path", "new_object_path", "old_keywords", "new_keywords", "reason",
               "input_tokens", "output_tokens", "cost_usd", "error"]


def _normalize(r: dict) -> dict:
    row = {**r}
    for k in ("old_keywords", "new_keywords"):
        if isinstance(row.get(k), list):
            row[k] = "|".join(row[k])
    return row


class IncrementalCsv:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.f = path.open("w", newline="")
        self.w = csv.DictWriter(self.f, fieldnames=PLAN_FIELDS, extrasaction="ignore")
        self.w.writeheader()
        self.f.flush()

    def append(self, row: dict) -> None:
        self.w.writerow(_normalize(row))
        self.f.flush()

    def close(self) -> None:
        self.f.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--count", type=int, default=50)
    ap.add_argument("--folder", help="optional folder_path filter")
    ap.add_argument("--out", default="scripts/image_tagging/plan_hybrid.csv")
    ap.add_argument("--clip-threshold", type=float, default=CLIP_KEEP_THRESHOLD)
    args = ap.parse_args()

    db_url = os.environ["DATABASE_URL"]
    api_key = os.environ["ANTHROPIC_API_KEY"]

    print("loading CLIP...", file=sys.stderr)
    t0 = time.time()
    scorer = ClipScorer()
    print(f"  loaded ViT-B-32 on {scorer.device} in {time.time() - t0:.1f}s", file=sys.stderr)

    with psycopg.connect(db_url) as conn:
        rows = fetch_rows(conn, args.count, args.folder)
    print(f"fetched {len(rows)} rows", file=sys.stderr)

    out_path = Path(args.out)
    csv_out = IncrementalCsv(out_path)
    results: list[dict] = []

    # Pass 1: download + CLIP score
    t0 = time.time()
    needs_haiku: list[tuple[dict, bytes, str, float]] = []
    for i, row in enumerate(rows, 1):
        try:
            image_bytes, media_type = download_image(row["public_url"])
        except Exception as e:
            rec = {"id": row["id"], "old_object_path": row["object_path"], "error": f"download: {e}", "decided_by": "error"}
            results.append(rec); csv_out.append(rec)
            print(f"  [{i}/{len(rows)}] id={row['id']:>6} download FAIL", file=sys.stderr)
            continue
        phrase = filename_to_phrase(row["file_name"])
        score = scorer.score(image_bytes, phrase) if phrase else 0.0
        if score >= args.clip_threshold:
            rec = {
                "id": row["id"],
                "old_object_path": row["object_path"],
                "new_object_path": row["object_path"],
                "old_keywords": row["keywords"],
                "new_keywords": row["keywords"],
                "clip_score": round(score, 4),
                "confidence": round(score, 4),
                "override_geography": False,
                "reason": f"CLIP score {score:.3f} >= {args.clip_threshold} for phrase '{phrase}'; existing name retained",
                "status": "keep",
                "decided_by": "clip",
                "cost_usd": 0.0,
                "input_tokens": 0,
                "output_tokens": 0,
                "error": "",
            }
            results.append(rec); csv_out.append(rec)
            if i % 50 == 0 or i <= 20:
                print(f"  [{i}/{len(rows)}] id={row['id']:>6} clip-keep   score={score:.3f}", file=sys.stderr)
        else:
            needs_haiku.append((row, image_bytes, media_type, score))
            if i % 50 == 0 or i <= 20:
                print(f"  [{i}/{len(rows)}] id={row['id']:>6} -> haiku    score={score:.3f}", file=sys.stderr)
    pass1_elapsed = time.time() - t0

    # Pass 2: Haiku for the suspicious ones
    print(f"\npass 2: {len(needs_haiku)} images to Haiku", file=sys.stderr)
    t0 = time.time()
    client = Anthropic(api_key=api_key)
    with ThreadPoolExecutor(max_workers=MAX_HAIKU_WORKERS) as ex:
        futs = {ex.submit(haiku_step, client, row, b, mt, s): row for (row, b, mt, s) in needs_haiku}
        for i, fut in enumerate(as_completed(futs), 1):
            res = fut.result()
            results.append(res); csv_out.append(res)
            if i % 50 == 0 or i <= 20:
                tag = res.get("status") or "ERR"
                print(f"  [{i}/{len(needs_haiku)}] id={res['id']:>6} {tag:<6} {res.get('error') or res.get('new_file_name', '')}", file=sys.stderr)
    pass2_elapsed = time.time() - t0
    csv_out.close()

    counts = {"keep": 0, "auto": 0, "review": 0, "skip": 0, "error": 0}
    total_cost = 0.0
    for r in results:
        if r.get("error"):
            counts["error"] += 1
        else:
            counts[r.get("status", "error")] += 1
        total_cost += r.get("cost_usd", 0) or 0

    print(f"\nwrote {out_path}", file=sys.stderr)
    print(f"counts:    {counts}", file=sys.stderr)
    print(f"timing:    pass1 (download+CLIP) {pass1_elapsed:.1f}s | pass2 (Haiku) {pass2_elapsed:.1f}s", file=sys.stderr)
    print(f"cost:      ${total_cost:.4f} for {len(results)} images", file=sys.stderr)
    if results:
        per_img = total_cost / len(results)
        haiku_rate = len(needs_haiku) / len(results)
        print(f"           ${per_img:.5f}/image avg ({haiku_rate:.0%} hit Haiku)", file=sys.stderr)
        print(f"           10k images ≈ ${per_img * 10000:.0f} (vs ${0.00257 * 10000:.0f} Haiku-only)", file=sys.stderr)


if __name__ == "__main__":
    main()
