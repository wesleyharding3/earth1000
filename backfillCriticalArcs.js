/**
 * backfillCriticalArcs.js — one-shot article backfill for seeded timelines
 */
require("dotenv").config();
const pool = require("./db");

async function backfillTimeline(timelineId, keywords) {
  const patterns = keywords.map(k => "%" + k.toLowerCase() + "%");
  const orParts = patterns.map((_, i) =>
    `(LOWER(a.title) LIKE $${i + 1} OR LOWER(COALESCE(a.translated_title, '')) LIKE $${i + 1})`
  );

  const q = `
    SELECT a.id, a.published_at
    FROM news_articles a
    WHERE (${orParts.join(" OR ")})
      AND a.published_at > NOW() - INTERVAL '90 days'
    ORDER BY a.published_at DESC
    LIMIT 500
  `;

  const { rows } = await pool.query(q, patterns);
  console.log(`  Timeline ${timelineId}: found ${rows.length} matching articles`);

  let inserted = 0;
  for (const a of rows) {
    const ageH = (Date.now() - new Date(a.published_at).getTime()) / 3600000;
    const weight = Math.max(0.1, 1 / (1 + Math.exp(0.012 * (ageH - 24)))).toFixed(5);
    try {
      const { rowCount } = await pool.query(`
        INSERT INTO story_timeline_articles (timeline_id, article_id, parabolic_weight, relevance_score, is_anchor, added_at)
        VALUES ($1, $2, $3, 0.5, false, NOW())
        ON CONFLICT DO NOTHING
      `, [timelineId, a.id, weight]);
      if (rowCount) inserted++;
    } catch (e) { /* skip duplicates */ }
  }

  await pool.query(`
    UPDATE story_timelines SET
      article_count = (SELECT COUNT(*) FROM story_timeline_articles WHERE timeline_id = $1),
      last_updated_at = NOW()
    WHERE id = $1
  `, [timelineId]);

  console.log(`  → Inserted ${inserted} articles`);
  return inserted;
}

async function run() {
  console.log("\n🌱 Backfilling critical arc articles...\n");

  // Gaza Genocide & Israeli Occupation (timeline 330)
  await backfillTimeline(330, [
    "gaza", "palestinian", "rafah", "khan younis", "jabalia", "nuseirat",
    "deir al-balah", "genocide", "nakba", "unrwa", "hamas", "idf gaza",
    "gaza ceasefire", "gaza famine", "gaza hospital", "gaza school",
    "gaza displacement", "gaza blockade", "gaza invasion"
  ]);

  // West Bank Settler Violence & Annexation (timeline 331)
  await backfillTimeline(331, [
    "west bank", "settler violence", "settlement expansion", "annexation",
    "jenin", "nablus", "hebron", "tulkarm", "ramallah raid",
    "settler attack", "checkpoint", "demolition palestinian",
    "west bank raid", "occupied territories"
  ]);

  console.log("\n✅ Done\n");
  await pool.end();
}

run().catch(e => { console.error(e); process.exit(1); });
