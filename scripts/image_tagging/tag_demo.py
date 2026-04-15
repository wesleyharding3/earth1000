"""Single-image tagging demo using Claude Haiku vision.

Pulls one row from public.image_assets, downloads the image, asks the model for
ranked tags + a proposed new filename, and prints a side-by-side comparison.
No DB or GCS writes — preview only.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
from pathlib import Path

import psycopg
import requests
from anthropic import Anthropic
from dotenv import load_dotenv

REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(REPO_ROOT / ".env")

MODEL = "claude-haiku-4-5-20251001"

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


def fetch_rows(conn, image_id: int | None, count: int):
    sql = """
        SELECT ia.id, ia.public_url, ia.object_path, ia.folder_path, ia.file_name,
               ia.primary_category, ia.generic_category, ia.keywords,
               c.name AS city_name, co.name AS country_name
        FROM image_assets ia
        LEFT JOIN cities c ON c.id = ia.city_id
        LEFT JOIN countries co ON co.id = ia.country_id
        WHERE ia.is_active = true
        {filter}
        ORDER BY {order}
        LIMIT %s
    """
    if image_id is not None:
        sql = sql.format(filter="AND ia.id = %s", order="ia.id")
        params = (image_id, count)
    else:
        sql = sql.format(filter="", order="random()")
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
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": media_type,
                            "data": base64.standard_b64encode(image_bytes).decode(),
                        },
                    },
                    {"type": "text", "text": PROMPT.format(priors=json.dumps(priors, indent=2, default=str))},
                ],
            }
        ],
    )
    text = msg.content[0].text.strip()
    if text.startswith("```"):
        text = text.strip("`").lstrip("json").strip()
    return {
        "result": json.loads(text),
        "usage": {"input": msg.usage.input_tokens, "output": msg.usage.output_tokens},
    }


def cost_estimate(usage: dict) -> float:
    # Haiku 4.5: $1/MTok input, $5/MTok output (approx).
    return usage["input"] / 1_000_000 * 1.0 + usage["output"] / 1_000_000 * 5.0


def render(row: dict, tagged: dict) -> None:
    r = tagged["result"]
    ext = Path(row["file_name"]).suffix or ".jpg"
    new_name = f"{r['proposed_filename_stem']}{ext}"
    new_object_path = f"{row['folder_path']}/{new_name}" if row["folder_path"] else new_name

    print("=" * 80)
    print(f"image_id:        {row['id']}")
    print(f"public_url:      {row['public_url']}")
    print()
    print(f"old file_name:   {row['file_name']}")
    print(f"new file_name:   {new_name}")
    print()
    print(f"old object_path: {row['object_path']}")
    print(f"new object_path: {new_object_path}")
    print()
    print(f"old keywords:    {row['keywords']}")
    print(f"new tags:        {r['tags']}")
    print()
    print(f"db city:         {row['city_name']}")
    print(f"db country:      {row['country_name']}")
    print(f"primary_cat:     {row['primary_category']}")
    print()
    print(f"confidence:      {r['confidence']}")
    print(f"override_geo:    {r['override_geography']}")
    print(f"reason:          {r['reason']}")
    print()
    print(f"tokens:          in={tagged['usage']['input']} out={tagged['usage']['output']}")
    print(f"est cost:        ${cost_estimate(tagged['usage']):.5f}")
    print("=" * 80)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--id", type=int, help="specific image_assets.id; omit for random")
    ap.add_argument("--count", type=int, default=1, help="number of samples")
    args = ap.parse_args()

    db_url = os.environ["DATABASE_URL"]
    api_key = os.environ["ANTHROPIC_API_KEY"]

    with psycopg.connect(db_url) as conn:
        rows = fetch_rows(conn, args.id, args.count)
    if not rows:
        print("no rows found", file=sys.stderr)
        sys.exit(1)

    client = Anthropic(api_key=api_key)
    total_cost = 0.0
    for row in rows:
        print(f"downloading {row['public_url']} ...", file=sys.stderr)
        try:
            image_bytes, media_type = download_image(row["public_url"])
        except Exception as e:
            print(f"  download failed: {e}", file=sys.stderr)
            continue
        try:
            tagged = tag_image(client, image_bytes, media_type, row)
        except Exception as e:
            print(f"  tag failed: {e}", file=sys.stderr)
            continue
        render(row, tagged)
        total_cost += cost_estimate(tagged["usage"])
    print(f"\ntotal estimated cost: ${total_cost:.5f} across {len(rows)} images", file=sys.stderr)


if __name__ == "__main__":
    main()
