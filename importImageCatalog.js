#!/usr/bin/env node
"use strict";

require("dotenv").config();

const path = require("path");
const pool = require("./db");

const BASE_URL = process.env.IMAGE_CATALOG_BASE_URL || "https://storage.googleapis.com/earth00.com";
const PAGE_SIZE = 1000;
const UPSERT_BATCH_SIZE = 200;
const IMAGE_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".svg", ".avif"
]);
const TOKEN_STOPWORDS = new Set([
  "a", "an", "and", "at", "by", "for", "from", "in", "into", "of", "on", "or", "the", "to", "with"
]);

const FOLDER_CATEGORY_MAP = {
  commons_imgs: {
    primary: "general",
    generic: "general",
    keywords: ["general", "world", "government", "commons"],
  },
  finance_imgs: {
    primary: "finance",
    generic: "economy",
    keywords: ["finance", "economy", "trade", "business", "industry"],
  },
  foreigngov_imgs: {
    primary: "government",
    generic: "government",
    keywords: ["government", "parliament", "state", "ministry", "civic"],
  },
  imgs: {
    primary: "general",
    generic: "general",
    keywords: ["general", "city", "country", "world"],
  },
  landscape_imgs: {
    primary: "landscape",
    generic: "general",
    keywords: ["landscape", "scenery", "terrain", "nature"],
  },
  mil_imgs: {
    primary: "military",
    generic: "security",
    keywords: ["military", "defense", "security", "arms"],
  },
  misc_imgs: {
    primary: "general",
    generic: "general",
    keywords: ["general", "misc"],
  },
  religion_imgs: {
    primary: "religion",
    generic: "religion",
    keywords: ["religion", "faith", "worship", "spiritual"],
  },
  trade_imgs: {
    primary: "trade",
    generic: "economy",
    keywords: ["trade", "shipping", "industry", "logistics", "commerce"],
  },
};

function parseArgs(argv) {
  const args = {
    dryRun: argv.includes("--dry-run"),
    limit: null,
    baseUrl: BASE_URL,
  };

  for (const arg of argv) {
    if (arg.startsWith("--limit=")) {
      const value = parseInt(arg.split("=")[1], 10);
      if (Number.isFinite(value) && value > 0) args.limit = value;
    }
    if (arg.startsWith("--base-url=")) {
      const value = arg.split("=").slice(1).join("=").trim();
      if (value) args.baseUrl = value.replace(/\/+$/, "");
    }
  }

  return args;
}

function decodeXmlText(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'");
}

function extractXmlValues(xml, tagName) {
  const regex = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, "g");
  const values = [];
  let match;
  while ((match = regex.exec(xml))) {
    values.push(decodeXmlText(match[1]));
  }
  return values;
}

function isImageKey(key) {
  const ext = path.extname(key).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[%()[\]{}]+/g, " ")
    .replace(/[_.,+-]+/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .split(/\s+/)
    .filter(token => token.length >= 2)
    .filter(token => !TOKEN_STOPWORDS.has(token))
    .filter(token => !/^\d+$/.test(token));
}

function uniqueKeywords(list) {
  return [...new Set(list.map(token => token.trim().toLowerCase()).filter(Boolean))];
}

function buildPublicUrl(baseUrl, objectPath) {
  const encodedPath = objectPath
    .split("/")
    .map(segment => encodeURIComponent(segment))
    .join("/");
  return `${baseUrl}/${encodedPath}`;
}

function deriveImageRecord(objectPath, baseUrl) {
  const parts = objectPath.split("/");
  const folder = parts[0] || "";
  const fileName = parts[parts.length - 1] || "";
  const folderConfig = FOLDER_CATEGORY_MAP[folder] || {
    primary: "general",
    generic: "general",
    keywords: ["general"],
  };

  const fileStem = fileName.replace(path.extname(fileName), "");
  const folderTokens = tokenize(folder.replace(/_imgs$/i, "").replace(/_/g, " "));
  const fileTokens = tokenize(fileStem);

  const keywords = uniqueKeywords([
    ...folderConfig.keywords,
    ...folderTokens,
    ...fileTokens,
  ]);

  return {
    public_url: buildPublicUrl(baseUrl, objectPath),
    object_path: objectPath,
    folder_path: folder,
    file_name: fileName,
    primary_category: folderConfig.primary,
    generic_category: folderConfig.generic,
    keywords,
    metadata: {
      folder,
      imported_from: "bucket-listing",
      fileStem,
    },
  };
}

async function fetchListingPage(baseUrl, marker) {
  const url = new URL(baseUrl);
  if (marker) url.searchParams.set("marker", marker);
  url.searchParams.set("max-keys", String(PAGE_SIZE));

  const response = await fetch(url.toString());
  if (!response.ok) {
    throw new Error(`bucket listing failed: ${response.status}`);
  }

  const xml = await response.text();
  const keys = extractXmlValues(xml, "Key").filter(isImageKey);
  const nextMarker = extractXmlValues(xml, "NextMarker")[0] || null;
  const truncated = extractXmlValues(xml, "IsTruncated")[0] === "true";

  return { keys, nextMarker, truncated };
}

async function collectAllKeys(baseUrl, limit) {
  const allKeys = [];
  let marker = null;
  let page = 0;

  while (true) {
    page += 1;
    const { keys, nextMarker, truncated } = await fetchListingPage(baseUrl, marker);
    allKeys.push(...keys);
    console.log(`[image-import] page ${page}: +${keys.length} images (${allKeys.length} total)`);

    if (limit && allKeys.length >= limit) {
      return allKeys.slice(0, limit);
    }

    if (!truncated || !nextMarker) break;
    marker = nextMarker;
  }

  return allKeys;
}

function chunkArray(items, chunkSize) {
  const chunks = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

async function upsertImageBatch(client, records) {
  const values = [];
  const placeholders = records.map((record, index) => {
    const base = index * 8;
    values.push(
      record.public_url,
      record.object_path,
      record.folder_path,
      record.file_name,
      record.primary_category,
      record.generic_category,
      record.keywords,
      JSON.stringify(record.metadata)
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}::text[], $${base + 8}::jsonb, NOW())`;
  });

  await client.query(
    `INSERT INTO image_assets (
       public_url,
       object_path,
       folder_path,
       file_name,
       primary_category,
       generic_category,
       keywords,
       metadata,
       updated_at
     )
     VALUES ${placeholders.join(",\n")}
     ON CONFLICT (object_path) DO UPDATE
     SET public_url = EXCLUDED.public_url,
         folder_path = EXCLUDED.folder_path,
         file_name = EXCLUDED.file_name,
         primary_category = EXCLUDED.primary_category,
         generic_category = EXCLUDED.generic_category,
         keywords = EXCLUDED.keywords,
         metadata = image_assets.metadata || EXCLUDED.metadata,
         updated_at = NOW()`,
    values
  );
}

async function upsertImages(records) {
  if (!records.length) return 0;

  const client = await pool.connect();
  let inserted = 0;

  try {
    const batches = chunkArray(records, UPSERT_BATCH_SIZE);
    for (let i = 0; i < batches.length; i += 1) {
      await client.query("BEGIN");
      try {
        await upsertImageBatch(client, batches[i]);
        await client.query("COMMIT");
        inserted += batches[i].length;
        console.log(`[image-import] upserted batch ${i + 1}/${batches.length} (${inserted}/${records.length})`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
    return inserted;
  } catch (err) {
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const keys = await collectAllKeys(args.baseUrl, args.limit);
  const records = keys.map(key => deriveImageRecord(key, args.baseUrl));

  console.log(`[image-import] prepared ${records.length} image records from ${args.baseUrl}`);
  if (args.dryRun) {
    console.log("[image-import] dry run only; sample records:");
    console.log(JSON.stringify(records.slice(0, 5), null, 2));
    return;
  }

  const inserted = await upsertImages(records);
  console.log(`[image-import] upserted ${inserted} image rows into image_assets`);
}

main()
  .catch(err => {
    console.error("[image-import] fatal:", err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end().catch(() => {});
    process.exit(process.exitCode || 0);
  });
