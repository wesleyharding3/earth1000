/**
 * One-shot cleanup for thread #9491 ("Indonesia Train Collision Death
 * Toll Rises to 15"). The thread fused multiple unrelated events:
 *   - Indonesia / Bekasi train crash    ← the legitimate topic, KEEP
 *   - Colombia Cauca car-bomb wave      ← bleed-through, REMOVE
 *   - Mali defense minister killed      ← bleed-through, REMOVE
 *   - South Sudan plane crash           ← bleed-through, REMOVE
 *   - Taiwan bus driver argument        ← bleed-through, REMOVE
 *   - …anything else not about the train crash
 *
 * Approach: build an allow-list of "Indonesia train" title patterns.
 * Articles whose translated_title / title match ANY allow pattern stay.
 * Everything else gets removed. This is safer than a Colombia-only
 * filter because it catches the smaller bleeds (Mali / South Sudan /
 * Taiwan) without us hand-curating each.
 *
 * Dry-run by default. Pass --apply to actually write.
 *   node _cleanup_indo_thread.js
 *   node _cleanup_indo_thread.js --apply
 */

require("dotenv").config();
const pool = require("./db");

const APPLY     = process.argv.includes('--apply');
const THREAD_ID = 9491;

// Indonesia-train ALLOW patterns. ILIKE-style globs (case-insensitive,
// % is wildcard). Article must match at least one of these to be KEPT.
// Tuned against the 292-article inspection from the audit pass — every
// real train-crash article had at least one of these tokens in its
// title (Indonesian, English, Spanish, Portuguese, French, German,
// Russian, Greek, Arabic-romanized variants all covered).
const KEEP_PATTERNS = [
  // Place names
  '%indonesia%',
  '%indonésia%',     // Portuguese
  '%indonésie%',     // French
  '%индонезии%',     // Russian (Cyrillic)
  '%ινδονησία%',     // Greek
  '%bekasi%',
  '%jakarta%',
  // Indonesian/KAI rail vocabulary — broadened from word-pair matches
  // to single-word matches for Bahasa-specific tokens, since the
  // pair-style patterns ("tabrakan ka", "perjalanan ka") were missing
  // titles where another word slipped between them ("Tabrakan Maut KA",
  // "Seluruh Perjalanan KA Jarak Jauh"). The single-word forms
  // (tabrakan, kecelakaan, kereta, stasiun) are very Indonesian-
  // specific and don't appear in the bleed-through languages
  // (Spanish / Portuguese / Russian / English / etc.) so the
  // false-positive risk is near zero in this thread's context.
  '%tabrakan%',          // Bahasa: collision
  '%kecelakaan%',        // Bahasa: accident
  '%kereta%',            // Bahasa/Malay: train
  '%stasiun%',           // Bahasa: station (transliterated)
  '%krl%',
  '%kai %',
  '%ka argo%',
  '%argo bromo%',
  '%commuterline%',
  '%commuter line%',
  '%basarnas%',
  '%transjakarta%',
  '%bromo anggrek%',
  '%perjalanan ka%',
  // Common English / multilingual phrases pointing to THIS event
  '%train wreck%',
  '%train crash%',
  '%train collision%',
  '%trains collide%',
  '%trains collided%',
  '%train accident%',
  '%trens em indonesia%',
  '%trens na indonésia%',
  '%trenes en indonesia%',
  '%choque de trenes%',
  '%collision ferroviaire%',     // French
  '%столкновени%поезд%',         // Russian
  '%σύγκρουση τρένων%%',         // Greek
  '%σιδηροδρομικ%',              // Greek (railway)
  '%qatarlar toqquşdu%',         // Azerbaijani: trains collided
  // Bosnian/Croatian: "vlak" (train) + "sudar" (collision). Both
  // orderings — title can be "sudar vlakova" or "vlakov sudar".
  '%sudar vlak%',
  '%sudar%vlak%',
  '%vlak%sudar%',
  '%vlakova%',
  '%death toll%train%',
  '%train%death toll%',
  '%train%bekasi%',
  '%bekasi%train%',
  '%jakarta%train%',
  '%train%jakarta%',
];

// Mini ILIKE — '%' acts as wildcard; case-insensitive.
function like(haystack, pattern) {
  const lit = pattern.toLowerCase();
  let rx = '';
  for (let i = 0; i < lit.length; i++) {
    const c = lit[i];
    if (c === '%') rx += '.*';
    else rx += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(rx).test(haystack);
}

function isAboutIndoTrain(title) {
  const blob = (title || '').toLowerCase();
  return KEEP_PATTERNS.some(p => like(blob, p));
}

(async () => {
  try {
    const { rows: tArr } = await pool.query(
      `SELECT id, title, primary_nations, secondary_nations, article_count
         FROM story_threads WHERE id = $1`,
      [THREAD_ID]
    );
    if (!tArr.length) {
      console.log(`Thread #${THREAD_ID} not found.`);
      await pool.end(); return;
    }
    const t = tArr[0];
    console.log(`\nThread #${t.id} — "${t.title}"`);
    console.log(`  current article_count: ${t.article_count}`);
    console.log(`  current primary:       ${JSON.stringify(t.primary_nations)}`);
    console.log(`  current secondary:     ${JSON.stringify(t.secondary_nations)}\n`);

    const { rows } = await pool.query(`
      SELECT a.id, a.title, a.translated_title,
             co.iso_code AS country_iso,
             a.country_id, a.source_id,
             a.published_at
        FROM story_thread_articles sta
        JOIN news_articles a   ON a.id = sta.article_id
        LEFT JOIN countries co ON co.id = a.country_id
       WHERE sta.thread_id = $1
       ORDER BY a.published_at DESC
    `, [THREAD_ID]);

    const keep = [];
    const remove = [];
    for (const r of rows) {
      const blob = (r.translated_title || '') + ' ' + (r.title || '');
      if (isAboutIndoTrain(blob)) keep.push(r);
      else remove.push(r);
    }
    console.log(`Total in thread:  ${rows.length}`);
    console.log(`Will KEEP:        ${keep.length}  (matches Indonesia-train allow-list)`);
    console.log(`Will REMOVE:      ${remove.length}  (no allow-list match)\n`);

    console.log('──────── REMOVE LIST ────────');
    for (const a of remove) {
      const title = a.translated_title || a.title || '';
      const iso = a.country_iso || '??';
      const date = a.published_at?.toISOString?.()?.slice(0,10) || '??';
      console.log(`  [${a.id}]  ${date}  src=${iso}  ${title.slice(0,120)}`);
    }
    console.log('');

    // Recompute primary/secondary to drop bleed countries. The rule:
    // anything left in primary/secondary that doesn't show up as the
    // SUBJECT of any kept article is dropped. We don't have a clean
    // way to derive subject country from each kept article without
    // a Claude call, so we apply a hard manual rule based on the audit:
    //   primary  → just ID (Indonesia)
    //   secondary→ just RU (Russia condolences article exists)
    // If you want a different shape, edit these two arrays.
    const newPrimary   = ['ID'];
    const newSecondary = ['RU'];

    console.log('Planned thread updates:');
    console.log(`  article_count:     ${t.article_count}  →  ${keep.length}`);
    console.log(`  primary_nations:   ${JSON.stringify(t.primary_nations)}  →  ${JSON.stringify(newPrimary)}`);
    console.log(`  secondary_nations: ${JSON.stringify(t.secondary_nations)}  →  ${JSON.stringify(newSecondary)}`);

    if (!APPLY) {
      console.log('\n(dry run — no writes. Re-run with --apply to actually clean up.)');
      await pool.end(); return;
    }

    // ── Apply phase ────────────────────────────────────────────────
    console.log('\nAPPLYING…');
    const removeIds = remove.map(r => r.id);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const delRes = await client.query(
        `DELETE FROM story_thread_articles
          WHERE thread_id = $1 AND article_id = ANY($2::int[])`,
        [THREAD_ID, removeIds]
      );
      console.log(`  story_thread_articles rows deleted: ${delRes.rowCount}`);

      const { rows: countRows } = await client.query(`
        SELECT COUNT(*)                    AS n,
               COUNT(DISTINCT a.source_id) AS sources
          FROM story_thread_articles sta
          JOIN news_articles a ON a.id = sta.article_id
         WHERE sta.thread_id = $1
      `, [THREAD_ID]);
      const realCount   = Number(countRows[0].n);
      const realSources = Number(countRows[0].sources);

      await client.query(`
        UPDATE story_threads
           SET article_count         = $2,
               distinct_source_count = $3,
               primary_nations       = $4,
               secondary_nations     = $5,
               last_updated_at       = NOW()
         WHERE id = $1
      `, [THREAD_ID, realCount, realSources, newPrimary, newSecondary]);
      console.log(`  story_threads updated: article_count=${realCount} sources=${realSources}`);

      await client.query('COMMIT');
      console.log('\n✓ Done.');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
})();
