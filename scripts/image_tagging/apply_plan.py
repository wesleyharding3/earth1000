"""Apply a tagging plan CSV to GCS + the image_assets table.

Default is --dry-run. Use --apply to actually mutate. Per row:
  1. GCS copy old_object_path -> new_object_path (same bucket).
  2. Verify new object exists with matching size.
  3. Delete old object.
  4. Update image_assets row (object_path, file_name, public_url, keywords) in a tx.
If any step fails for a row, the row is skipped and logged; other rows continue.
"""

from __future__ import annotations

import argparse
import csv
import os
import sys
import time
from pathlib import Path
from urllib.parse import urlparse

import psycopg
from dotenv import load_dotenv
from google.cloud import storage

REPO_ROOT = Path(__file__).resolve().parents[2]
load_dotenv(REPO_ROOT / ".env")

BUCKET = "news_imgs"
PUBLIC_URL_PREFIX = f"https://storage.googleapis.com/{BUCKET}/"


def load_plan(path: Path, only_status: set[str]) -> list[dict]:
    rows = []
    with path.open() as f:
        for r in csv.DictReader(f):
            if r.get("error"):
                continue
            if r["status"] not in only_status:
                continue
            r["new_keywords_list"] = [k for k in r.get("new_keywords", "").split("|") if k]
            rows.append(r)
    return rows


def copy_then_delete(client: storage.Client, old_path: str, new_path: str) -> tuple[bool, str]:
    bucket = client.bucket(BUCKET)
    src = bucket.blob(old_path)
    if not src.exists(client):
        return False, f"source missing: {old_path}"
    dst = bucket.blob(new_path)
    if dst.exists(client):
        return False, f"destination already exists: {new_path}"
    bucket.copy_blob(src, bucket, new_path)
    dst.reload()
    src.reload()
    if dst.size != src.size:
        return False, f"size mismatch after copy ({src.size} -> {dst.size})"
    src.delete()
    return True, "ok"


def update_db_row(conn, image_id: int, new_object_path: str, new_keywords: list[str]) -> None:
    new_file_name = new_object_path.rsplit("/", 1)[-1]
    new_public_url = PUBLIC_URL_PREFIX + new_object_path
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE image_assets
               SET object_path = %s,
                   file_name   = %s,
                   public_url  = %s,
                   keywords    = %s,
                   updated_at  = now()
             WHERE id = %s
            """,
            (new_object_path, new_file_name, new_public_url, new_keywords, image_id),
        )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--plan", default="scripts/image_tagging/plan.csv")
    ap.add_argument("--apply", action="store_true", help="actually mutate GCS + DB (default: dry-run)")
    ap.add_argument("--include", default="auto", help="comma-separated statuses to apply (e.g. auto or auto,review)")
    ap.add_argument("--limit", type=int, help="apply at most N rows (after status filter)")
    args = ap.parse_args()

    statuses = set(s.strip() for s in args.include.split(","))
    plan_path = Path(args.plan)
    if not plan_path.exists():
        print(f"plan not found: {plan_path}", file=sys.stderr)
        sys.exit(1)
    rows = load_plan(plan_path, statuses)
    if args.limit:
        rows = rows[: args.limit]
    mode = "APPLY" if args.apply else "DRY-RUN"
    print(f"[{mode}] {len(rows)} rows from {plan_path} (statuses={sorted(statuses)})", file=sys.stderr)

    if not args.apply:
        for r in rows[:10]:
            print(f"  would rename id={r['id']:>6}  {r['old_object_path']}  ->  {r['new_object_path']}", file=sys.stderr)
        if len(rows) > 10:
            print(f"  ... and {len(rows) - 10} more", file=sys.stderr)
        return

    db_url = os.environ["DATABASE_URL"]
    gcs = storage.Client()

    ok = fail = 0
    t0 = time.time()
    with psycopg.connect(db_url) as conn:
        for i, r in enumerate(rows, 1):
            image_id = int(r["id"])
            old_path = r["old_object_path"]
            new_path = r["new_object_path"]
            if old_path == new_path:
                print(f"  [{i}/{len(rows)}] id={image_id} skip (no change)", file=sys.stderr)
                continue
            try:
                copied, msg = copy_then_delete(gcs, old_path, new_path)
                if not copied:
                    print(f"  [{i}/{len(rows)}] id={image_id} GCS FAIL: {msg}", file=sys.stderr)
                    fail += 1
                    continue
                update_db_row(conn, image_id, new_path, r["new_keywords_list"])
                conn.commit()
                ok += 1
                print(f"  [{i}/{len(rows)}] id={image_id} ok   {old_path} -> {new_path}", file=sys.stderr)
            except Exception as e:
                conn.rollback()
                fail += 1
                print(f"  [{i}/{len(rows)}] id={image_id} ERROR: {e}", file=sys.stderr)

    print(f"\ndone: {ok} ok, {fail} fail in {time.time() - t0:.1f}s", file=sys.stderr)


if __name__ == "__main__":
    main()
