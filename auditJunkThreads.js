/**
 * auditJunkThreads.js
 *
 * One-shot cleanup: scan ALL story threads and delete the ones that don't
 * belong on a geopolitical monitoring platform — lifestyle, education trends,
 * tourism, cultural events, entertainment, vague "X and Y coverage" buckets,
 * and other non-geopolitical fluff.
 *
 * Mirrors the same junk filter that storyThreadBuilder.js now applies at
 * thread CREATION time. This script cleans the historical pile of junk that
 * accumulated before the prompt + reject filter were added.
 *
 * Usage:
 *   node auditJunkThreads.js                # dry-run (default, no writes)
 *   node auditJunkThreads.js --apply        # actually delete
 *   node auditJunkThreads.js --apply --dormant   # mark as dormant instead of hard-deleting
 *
 * Match rule: a thread is junk if EITHER
 *   • primary_category is not in the geopolitical allow-list, OR
 *   • title matches one of the JUNK_TITLE_PATTERNS regexes.
 *
 * Hard delete removes the thread row + its story_thread_articles links.
 * Articles themselves are NEVER deleted — they remain in news_articles.
 */

require("dotenv").config();
const pool = require("./db");

const APPLY   = process.argv.includes("--apply");
const DORMANT = process.argv.includes("--dormant");

// Categories that belong on a geopolitical monitoring platform.
// Anything outside this set (society, sports, culture, lifestyle, etc.) is junk.
const ALLOWED_CATEGORIES = new Set([
  "politics", "economy", "military", "diplomacy", "environment", "technology"
]);

// Title-level junk patterns. Mirror of storyThreadBuilder.js JUNK_TITLE_PATTERNS.
const JUNK_TITLE_PATTERNS = [
  /\bstudent\b.*\b(financial|hardship|loan|debt)\b/i,
  /\b(higher|secondary|primary)\s+education\b/i,
  /\btourism\b/i,
  /\brecreation\b/i,
  /\bcultural\s+(event|festival|celebration)/i,
  /\bfestival\b/i,
  /\b(lifestyle|wellness|food|fashion|dating|shopping|retail)\b/i,
  /\bentertainment\s+(coverage|news|industry)\b/i,
  /\b(sports|entertainment|lifestyle|culture|arts)\s+and\s+(sports|entertainment|lifestyle|culture|arts|society|business)\b/i,
  /\b(celebrity|movie|film|tv|streaming|album|concert)\b/i,
  /\b(general|various|miscellaneous|other)\s+(coverage|news|topics|updates)\b/i,
  /\bcoverage\s+(roundup|recap|digest|hub)\b/i,
  /^\s*(general|various|miscellaneous|other)\b/i,
  // Additional vague-bucket patterns the user has called out
  /\b(social|community|society)\s+(trends|coverage|hardship|topics)\b/i,
  /\bhigher\s+education\s+ai\b/i,
  /\bspanish\s+cultural\b/i,
  /\bcentral\s+american\s+tourism\b/i,
];

function classifyJunk(thread) {
  const cat = String(thread.primary_category || "").toLowerCase();
  if (cat && !ALLOWED_CATEGORIES.has(cat)) {
    return `category=${cat}`;
  }
  const title = String(thread.title || "");
  for (const re of JUNK_TITLE_PATTERNS) {
    if (re.test(title)) return `title:${re.source.slice(0, 50)}`;
  }
  return null;
}

async function main() {
  console.log("─────────────────────────────────────────────");
  console.log("🧹 audit junk threads");
  console.log(`   mode: ${APPLY ? (DORMANT ? "APPLY (dormant)" : "APPLY (DELETE)") : "DRY-RUN"}`);
  console.log("─────────────────────────────────────────────\n");

  const { rows: threads } = await pool.query(`
    SELECT id, title, primary_category, status, importance, article_count, last_updated_at
    FROM story_threads
    ORDER BY id DESC
  `);
  console.log(`📦 Loaded ${threads.length} threads to evaluate\n`);

  const junk = [];
  const reasonCounts = new Map();

  for (const t of threads) {
    const reason = classifyJunk(t);
    if (!reason) continue;
    junk.push({ thread: t, reason });
    const bucket = reason.startsWith("category=") ? reason : reason.split(":")[0] + ":pattern";
    reasonCounts.set(bucket, (reasonCounts.get(bucket) || 0) + 1);
  }

  console.log(`🚫 Found ${junk.length} junk thread(s) (${(junk.length / Math.max(threads.length, 1) * 100).toFixed(1)}% of total)\n`);

  // Print summary by reason
  console.log("── breakdown by reason ──");
  const sortedReasons = [...reasonCounts.entries()].sort((a, b) => b[1] - a[1]);
  for (const [reason, count] of sortedReasons) {
    console.log(`  ${String(count).padStart(5)}  ${reason}`);
  }
  console.log("");

  // Print first 50 examples so the user can sanity-check
  console.log("── first 50 junk threads ──");
  for (const { thread, reason } of junk.slice(0, 50)) {
    const tag = `[${thread.id}] cat=${thread.primary_category || "—"} arts=${thread.article_count} imp=${thread.importance}`;
    console.log(`  ${tag.padEnd(48)}  "${thread.title}"`);
    console.log(`  ${"".padEnd(48)}    ↳ ${reason}`);
  }
  if (junk.length > 50) {
    console.log(`  … and ${junk.length - 50} more`);
  }
  console.log("");

  if (!APPLY) {
    console.log("🔍 dry-run complete. Re-run with --apply to delete (or --apply --dormant to soft-delete).");
    await pool.end();
    return;
  }

  // APPLY
  let removed = 0;
  let failed = 0;
  for (const { thread } of junk) {
    try {
      if (DORMANT) {
        await pool.query(
          `UPDATE story_threads SET status = 'dormant', last_updated_at = NOW() WHERE id = $1`,
          [thread.id]
        );
      } else {
        await pool.query(`DELETE FROM story_thread_articles WHERE thread_id = $1`, [thread.id]);
        await pool.query(`DELETE FROM story_threads WHERE id = $1`, [thread.id]);
      }
      removed++;
    } catch (err) {
      failed++;
      console.error(`  ⚠ failed on thread ${thread.id} "${thread.title}": ${err.message}`);
    }
  }

  console.log("");
  console.log(`✅ ${DORMANT ? "marked dormant" : "deleted"}: ${removed}`);
  if (failed) console.log(`⚠ failed: ${failed}`);
  await pool.end();
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
