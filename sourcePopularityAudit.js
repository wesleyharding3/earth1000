/**
 * sourcePopularityAudit.js
 *
 * Audits news_sources popularity_tier and popularity_score using Claude Haiku.
 * Focuses on tier 3-4 sources first (highest ranking impact due to tier 4 = 6× bonus).
 *
 * Tier definitions:
 *   4 — Major national / international news outlet (Reuters, BBC, major national TV/newspaper)
 *   3 — Solid regional or national outlet; real editorial content within its country
 *   2 — Local or niche outlet with genuine editorial content
 *   1 — Institutional PR feed (university, church, government office, port, airport, etc.)
 *
 * Score range 0.90–1.60 (continuous):
 *   1.50–1.60  top global outlets (Reuters, AP, BBC, major national flagships)
 *   1.30–1.49  strong national outlets — leading paper/broadcaster in their country
 *   1.10–1.29  solid regional editorial outlets
 *   0.95–1.09  local editorial with real content
 *   0.90–0.94  borderline / mostly institutional
 *
 * Usage:
 *   node sourcePopularityAudit.js --dry-run      # print changes, don't apply
 *   node sourcePopularityAudit.js                # apply changes to ALL ~7000 sources
 *   node sourcePopularityAudit.js --tier 4       # only audit tier 4 sources
 *   node sourcePopularityAudit.js --tier 1       # only audit tier 1 sources
 */

'use strict';
require('dotenv').config();
const { Pool }     = require('pg');
const Anthropic    = require('@anthropic-ai/sdk');

const pool   = new Pool({ connectionString: process.env.DATABASE_URL });
const claude = new Anthropic();

const DRY_RUN     = process.argv.includes('--dry-run');
const ONLY_TIER   = process.argv.includes('--tier')
  ? parseInt(process.argv[process.argv.indexOf('--tier') + 1])
  : null;
const BATCH_SIZE  = 30;   // sources per Haiku call
const CALL_DELAY  = 250;  // ms between batches (rate-limit headroom)

// ─────────────────────────────────────────────────────────────────────────────

async function loadSources() {
  const tierFilter = ONLY_TIER
    ? `AND ns.popularity_tier = ${ONLY_TIER}`
    : ``; // no filter = audit all tiers

  const { rows } = await pool.query(`
    SELECT
      ns.id,
      ns.name,
      ns.site_url,
      ns.popularity_tier,
      ns.popularity_score,
      co.name  AS country,
      l.iso_code_2 AS lang
    FROM news_sources ns
    LEFT JOIN countries  co ON co.id = ns.country_id
    LEFT JOIN languages  l  ON l.id  = ns.language_id
    WHERE ns.is_active = true
      ${tierFilter}
    ORDER BY ns.popularity_tier DESC, co.name, ns.name
  `);
  return rows;
}

// ─────────────────────────────────────────────────────────────────────────────

async function scoreBatch(batch) {
  const list = batch.map((s, i) =>
    `${i + 1}. ID:${s.id} | "${s.name}" | Country: ${s.country || 'Unknown'} | ${s.site_url}`
  ).join('\n');

  const prompt = `You are auditing news source quality for a global intelligence platform.
Score each source and return ONLY a valid JSON array — no explanation, no markdown.

TIER RULES (apply strictly):
  4 = Major national or international news outlet: national broadcaster, flagship newspaper, wire service (Reuters, AP, AFP, Xinhua, BBC, major country equivalents). Max ~1-3 per country.
  3 = Solid regional/national outlet with real editorial journalism. Could be the main outlet of a major city or a respected national specialist publication.
  2 = Local or niche outlet with genuine editorial content (local paper, specialist trade press).
  1 = Institutional PR feed — universities, churches, dioceses, government offices, ports, airports, embassies, event venues, sports clubs, foundations. These are NOT news outlets.

SCORE RULES (0.90–1.60, use the full range):
  1.50–1.60  = top global or flagship national outlets
  1.30–1.49  = strong national outlet, leading in its country
  1.10–1.29  = solid regional editorial
  0.95–1.09  = local editorial with real content
  0.90–0.94  = borderline or mostly institutional

KEY PRINCIPLE: Do NOT bias toward English or Western outlets.
The top general-news outlet in Uzbekistan or Cameroon deserves tier 3 (score ~1.30)
just as much as the top outlet in France. Institutional PR is tier 1 regardless of country.

Sources to evaluate:
${list}

Return ONLY a JSON array:
[{"id": 123, "tier": 3, "score": 1.35, "reason": "leading national newspaper"}, ...]`;

  let attempt = 0;
  while (attempt < 3) {
    try {
      const res = await claude.messages.create({
        model:      'claude-haiku-4-5',
        max_tokens: 2048,
        messages:   [{ role: 'user', content: prompt }]
      });
      const text  = res.content[0].text.trim();
      const match = text.match(/\[[\s\S]*\]/);
      if (!match) throw new Error('No JSON array in response');

      const scored  = JSON.parse(match[0]);
      const scoreMap = new Map(scored.map(s => [Number(s.id), s]));

      return batch.map(s => {
        const r = scoreMap.get(s.id);
        if (!r) {
          // Haiku didn't return this source — keep current values
          return {
            id: s.id, name: s.name, country: s.country,
            oldTier: s.popularity_tier, oldScore: s.popularity_score,
            newTier: s.popularity_tier, newScore: s.popularity_score,
            reason: 'not returned by model'
          };
        }
        const newTier  = Math.max(1, Math.min(4, Math.round(Number(r.tier))));
        const newScore = Math.max(0.90, Math.min(1.60, parseFloat(r.score) || 1.0));
        // Round score to 2dp for cleanliness
        const newScoreR = Math.round(newScore * 100) / 100;
        return {
          id: s.id, name: s.name, country: s.country,
          oldTier: s.popularity_tier, oldScore: s.popularity_score,
          newTier, newScore: newScoreR,
          reason: (r.reason || '').slice(0, 60)
        };
      });
    } catch (err) {
      attempt++;
      if (attempt >= 3) {
        console.warn(`Batch failed after 3 attempts: ${err.message}`);
        // Return unchanged for this batch
        return batch.map(s => ({
          id: s.id, name: s.name, country: s.country,
          oldTier: s.popularity_tier, oldScore: s.popularity_score,
          newTier: s.popularity_tier, newScore: s.popularity_score,
          reason: 'api error'
        }));
      }
      await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────

async function run() {
  const sources = await loadSources();
  const totalBatches = Math.ceil(sources.length / BATCH_SIZE);

  console.log(`\n=== Source Popularity Audit ===`);
  console.log(`Sources to audit : ${sources.length}`);
  console.log(`Haiku batches    : ${totalBatches}`);
  console.log(`Mode             : ${DRY_RUN ? 'DRY RUN (no DB writes)' : 'LIVE'}`);
  console.log('');

  const allResults = [];

  for (let i = 0; i < sources.length; i += BATCH_SIZE) {
    const batch = sources.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;
    process.stdout.write(`Batch ${batchNum}/${totalBatches}... `);

    const results = await scoreBatch(batch);
    allResults.push(...results);

    const changed = results.filter(r => r.newTier !== r.oldTier || r.newScore !== r.oldScore).length;
    console.log(`done (${changed} changes)`);

    if (i + BATCH_SIZE < sources.length) {
      await new Promise(r => setTimeout(r, CALL_DELAY));
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  const tierChanges   = allResults.filter(r => r.newTier  !== r.oldTier);
  const scoreChanges  = allResults.filter(r => r.newScore !== r.oldScore);
  const demotions     = tierChanges.filter(r => r.newTier  <  r.oldTier);
  const promotions    = tierChanges.filter(r => r.newTier  >  r.oldTier);

  console.log('\n=== Summary ===');
  console.log(`Total audited    : ${allResults.length}`);
  console.log(`Tier changes     : ${tierChanges.length} (${promotions.length} up, ${demotions.length} down)`);
  console.log(`Score changes    : ${scoreChanges.length}`);

  console.log('\n── Demotions (tier reduced) ──');
  demotions.slice(0, 50).forEach(r =>
    console.log(`  [${r.country || '?'}] ${r.name}: tier ${r.oldTier}→${r.newTier} | ${r.reason}`)
  );
  if (demotions.length > 50) console.log(`  ... and ${demotions.length - 50} more`);

  console.log('\n── Promotions (tier increased) ──');
  promotions.forEach(r =>
    console.log(`  [${r.country || '?'}] ${r.name}: tier ${r.oldTier}→${r.newTier} | ${r.reason}`)
  );

  console.log('\n── New tier distribution ──');
  const dist = { 1: 0, 2: 0, 3: 0, 4: 0 };
  allResults.forEach(r => { dist[r.newTier] = (dist[r.newTier] || 0) + 1; });
  [4, 3, 2, 1].forEach(t => console.log(`  Tier ${t}: ${dist[t] || 0} sources`));

  if (DRY_RUN) {
    console.log('\nDRY RUN — no changes written to DB.');
    await pool.end();
    return;
  }

  // ── Apply changes ────────────────────────────────────────────────────────
  console.log('\nApplying changes to DB...');
  let applied = 0;
  for (const r of allResults) {
    if (r.newTier !== r.oldTier || r.newScore !== r.oldScore) {
      await pool.query(
        `UPDATE news_sources SET popularity_tier = $1, popularity_score = $2 WHERE id = $3`,
        [r.newTier, r.newScore, r.id]
      );
      applied++;
    }
  }
  console.log(`Applied ${applied} updates.`);
  await pool.end();
  console.log('Done.');
}

run().catch(err => {
  console.error(err);
  pool.end();
  process.exit(1);
});
