// importImgsFolder.js
//
// Lists all objects in the `imgs/` folder of the news_imgs GCS bucket
// using the public GCS JSON API (no credentials needed for public buckets),
// diffs against image_assets, inserts new rows, and applies tags in one pass.
//
// Usage:
//   node importImgsFolder.js            # full run
//   node importImgsFolder.js --dry-run  # preview only, no writes

require("dotenv").config();
const pool = require("./db");

// ─── Config ────────────────────────────────────────────────────────────────
const BUCKET      = "news_imgs";
const FOLDER      = "imgs";               // GCS prefix to list
const PUBLIC_BASE = "https://storage.googleapis.com/news_imgs"; // public URL base — final: BASE/folder/file.jpg
const BATCH_SIZE  = 100;                   // DB insert batch size
const DRY_RUN     = process.argv.includes("--dry-run");

// ─── Tag map ───────────────────────────────────────────────────────────────
// Mirrors the seed SQL logic for the imgs folder.
// Each entry: { pattern: regex, tag: string, weight: number }
// Patterns are matched against the file_name (lowercase, no extension).
const TAG_RULES = [
  // imgs folder baseline — always applied
  { pattern: /.*/, tag: "general", weight: 1.0 },
];

// ─── GCS public list API ───────────────────────────────────────────────────
async function listAllObjects(bucket, prefix) {
  const objects = [];
  let pageToken = null;

  do {
    const url = new URL(`https://storage.googleapis.com/storage/v1/b/${bucket}/o`);
    url.searchParams.set("prefix", prefix + "/");
    url.searchParams.set("maxResults", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`GCS list failed: ${res.status} ${await res.text()}`);

    const data = await res.json();
    if (data.items) objects.push(...data.items);
    pageToken = data.nextPageToken || null;
  } while (pageToken);

  return objects;
}

// ─── Helpers ───────────────────────────────────────────────────────────────
function parseObject(gcsObj) {
  const objectPath = gcsObj.name;                          // e.g. imgs/photo.jpg
  const fileName   = objectPath.split("/").pop();          // photo.jpg
  const ext        = fileName.split(".").pop().toLowerCase();
  const folderPath = objectPath.split("/").slice(0, -1).join("/") || FOLDER;
  const publicUrl  = `${PUBLIC_BASE}/${objectPath}`;

  return { objectPath, fileName, ext, folderPath, publicUrl };
}

function getTagsForFile(fileName) {
  const base = fileName.replace(/\.[^/.]+$/, "").toLowerCase();
  return TAG_RULES
    .filter(r => r.pattern.test(base))
    .map(r => ({ tag: r.tag, weight: r.weight }));
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${DRY_RUN ? "🔍 DRY RUN — " : ""}🚀 Importing gs://${BUCKET}/${FOLDER}/`);
  console.log(`   Public base: ${PUBLIC_BASE}\n`);

  // 1. List bucket objects
  console.log("📦 Listing GCS objects...");
  const objects = await listAllObjects(BUCKET, FOLDER);
  const images  = objects.filter(o => /\.(jpg|jpeg|png|webp|gif)$/i.test(o.name));
  console.log(`   Found ${images.length} images in gs://${BUCKET}/${FOLDER}/`);

  if (!images.length) {
    console.log("Nothing to import. Exiting.");
    await pool.end();
    return;
  }

  // 2. Fetch existing object_paths for this folder from DB
  console.log("🗄️  Checking existing DB rows...");
  const { rows: existing } = await pool.query(
    `SELECT object_path FROM image_assets WHERE folder_path = $1`,
    [FOLDER]
  );
  const existingPaths = new Set(existing.map(r => r.object_path));
  console.log(`   ${existingPaths.size} already imported`);

  // 3. Filter to only new images
  const toInsert = images
    .map(parseObject)
    .filter(img => !existingPaths.has(img.objectPath));

  console.log(`   ${toInsert.length} new images to import\n`);

  if (!toInsert.length) {
    console.log("✅ Nothing new to import.");
    await pool.end();
    return;
  }

  if (DRY_RUN) {
    console.log("DRY RUN — first 20 that would be inserted:");
    toInsert.slice(0, 20).forEach(img =>
      console.log(`  ${img.objectPath} → ${img.publicUrl}`)
    );
    await pool.end();
    return;
  }

  // 4. Insert in batches + apply tags
  let inserted = 0;
  let tagged   = 0;
  let failed   = 0;

  for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
    const batch = toInsert.slice(i, i + BATCH_SIZE);

    for (const img of batch) {
      try {
        // Insert image_assets row
        const { rows } = await pool.query(`
          INSERT INTO image_assets (
            public_url, object_path, folder_path, file_name,
            primary_category, generic_category,
            keywords, metadata, is_active, priority
          ) VALUES (
            $1, $2, $3, $4,
            'general', 'general',
            '{}', '{}', true, 1.0
          )
          ON CONFLICT (object_path) DO NOTHING
          RETURNING id
        `, [img.publicUrl, img.objectPath, img.folderPath, img.fileName]);

        if (!rows.length) continue; // already existed, skip tagging
        const imageId = rows[0].id;
        inserted++;

        // Apply tags
        const tags = getTagsForFile(img.fileName);
        for (const { tag, weight } of tags) {
          await pool.query(`
            INSERT INTO image_asset_tags (image_id, tag_id, weight)
            SELECT $1, t.id, $2
            FROM tags t
            WHERE LOWER(t.name) = $3
            ON CONFLICT (image_id, tag_id) DO NOTHING
          `, [imageId, weight, tag]);
          tagged++;
        }

      } catch (err) {
        console.error(`  ❌ Failed ${img.objectPath}: ${err.message}`);
        failed++;
      }
    }

    const pct = Math.round(((i + batch.length) / toInsert.length) * 100);
    console.log(`   [${pct}%] inserted: ${inserted} | tagged: ${tagged} | failed: ${failed}`);
  }

  console.log(`\n✅ Import complete`);
  console.log(`   Inserted: ${inserted}`);
  console.log(`   Tagged:   ${tagged}`);
  console.log(`   Failed:   ${failed}`);

  await pool.end();
}

main().catch(err => {
  console.error("🚨 Fatal:", err);
  process.exit(1);
});