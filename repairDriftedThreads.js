/**
 * repairDriftedThreads.js — one-shot cleanup of threads that have drifted.
 *
 * Problem: the old thread builder only showed Claude each candidate thread's
 * TITLE (not its member articles), and had an "aggressive cross-country
 * linking" instruction that encouraged over-merging. Result: some threads
 * accumulated unrelated articles that share only a region / category /
 * generic keyword (e.g. a thread titled "African Regional Tensions"
 * bundling a Kenya-Nigeria spat + SA police suspension + Ghana-SA xenophobia
 * + an unrelated Iran story).
 *
 * This script walks every active thread, shows Claude all of its member
 * articles at once, and asks: "which of these don't belong with the rest?"
 * Articles Claude flags are ejected — their story_thread_articles row is
 * deleted, article stays in news_articles and becomes unassigned.
 *
 * We do NOT split threads into multiple new threads here. Ejected articles
 * simply return to the unassigned pool; the next storyThreadBuilder run
 * will either group them correctly or leave them solo. This avoids
 * creating parallel near-duplicate threads.
 *
 * Usage:
 *   node repairDriftedThreads.js                 — dry run (no writes)
 *   node repairDriftedThreads.js --apply         — actually eject
 *   node repairDriftedThreads.js --apply --min=4 — only threads with ≥4 members
 *   node repairDriftedThreads.js --limit=50      — cap number of threads processed
 */

'use strict';

// One-shot cleanup. Cap concurrent DB connections; mostly Anthropic-bound.
process.env.DB_POOL_MAX = "2";

require('dotenv').config({ override: true });

const pool = require('./db');
const Anthropic = require('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const APPLY    = process.argv.includes('--apply');
const MIN_SIZE = parseInt(process.argv.find(a => a.startsWith('--min='))?.split('=')[1] || '3', 10);
const LIMIT    = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '0', 10);
const SAMPLE   = parseInt(process.argv.find(a => a.startsWith('--sample='))?.split('=')[1] || '12', 10);
const SLEEP_MS = 1200;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function main() {
  const t0 = Date.now();
  const elapsed = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;
  console.log(`\n🩺 Thread drift repair — ${new Date().toISOString()}`);
  console.log(`   Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}  min_members=${MIN_SIZE}  sample_size=${SAMPLE}${LIMIT ? `  limit=${LIMIT}` : ''}\n`);

  const { rows: threads } = await pool.query(`
    SELECT t.id, t.title, t.primary_category,
           t.primary_nations, t.secondary_nations,
           t.article_count
      FROM story_threads t
     WHERE t.status = 'active'
       AND t.article_count >= $1
     ORDER BY t.article_count DESC, t.importance DESC
     ${LIMIT > 0 ? 'LIMIT ' + LIMIT : ''}
  `, [MIN_SIZE]);
  console.log(`   Found ${threads.length} thread(s) with ≥${MIN_SIZE} members\n`);

  let totalEjected = 0;
  let threadsTouched = 0;
  let claudeCalls = 0;

  for (let i = 0; i < threads.length; i++) {
    const th = threads[i];
    const { rows: members } = await pool.query(`
      SELECT a.id, a.title, a.summary, a.translated_summary,
             co.name AS country_name,
             sta.is_anchor, a.published_at
        FROM story_thread_articles sta
        JOIN news_articles a ON a.id = sta.article_id
        LEFT JOIN countries co ON co.id = a.country_id
       WHERE sta.thread_id = $1
       ORDER BY sta.is_anchor DESC NULLS LAST, a.published_at DESC
       LIMIT $2
    `, [th.id, SAMPLE]);
    if (members.length < MIN_SIZE) continue;

    const membersCompact = members.map(m => ({
      id:      Number(m.id),
      title:   m.title,
      summary: String(m.translated_summary || m.summary || '').slice(0, 220),
      country: m.country_name || null,
      anchor:  !!m.is_anchor,
    }));

    const prompt = `You are auditing a single news thread for drift. A thread must be a SHARP, COHERENT story — a specific event / crisis / bilateral relationship that the provided articles collectively report. Articles that share only a region, a topic, a category, or generic keywords DO NOT belong together.

THREAD
  id:    ${th.id}
  title: ${th.title}
  primary_nations:   ${JSON.stringify(th.primary_nations || [])}
  secondary_nations: ${JSON.stringify(th.secondary_nations || [])}

MEMBERS:
${JSON.stringify(membersCompact, null, 2)}

Task: decide which (if any) members do NOT belong with the rest. A member belongs only if it describes the SAME underlying event/crisis/relationship as the majority of the others, sharing named actors or a direct causal/rippling link.

Rules:
  • If the thread is genuinely coherent (all members converge on one story), return { "eject_article_ids": [], "reason": "coherent" }.
  • If a clear MAJORITY describes one story and a MINORITY is unrelated, eject the minority.
  • If the thread is fundamentally incoherent (e.g. 4 different stories with no majority), eject everything EXCEPT the largest coherent sub-group — return the outlier ids in eject_article_ids.
  • Do NOT eject on stylistic/language/source differences. Only eject on substantive story mismatch.
  • Never eject more than half the members unless the thread is clearly fragmented across multiple separate stories.

Return ONLY this JSON object (no prose, no code fence):
{ "eject_article_ids": [<ids>], "reason": "<short rationale, <=120 chars>" }`;

    process.stdout.write(`   [${elapsed()}] #${i + 1}/${threads.length}  thread ${th.id} (${members.length} members) "${String(th.title).slice(0, 60)}" ... `);
    let verdict;
    try {
      const resp = await client.messages.create({
        model:      'claude-haiku-4-5',
        max_tokens: 512,
        messages:   [{ role: 'user', content: prompt }],
      });
      claudeCalls++;
      const text = resp.content[0].text.trim();
      const jsonStart = text.indexOf('{');
      const jsonEnd   = text.lastIndexOf('}');
      if (jsonStart < 0 || jsonEnd < jsonStart) throw new Error('no JSON object');
      verdict = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
    } catch (err) {
      console.log(`✗ ${err.message}`);
      await sleep(SLEEP_MS);
      continue;
    }

    const ejectIds = Array.isArray(verdict.eject_article_ids)
      ? verdict.eject_article_ids.map(Number).filter(Number.isFinite)
      : [];
    // Safety: never allow Claude to eject > half (unless explicit incoherent flag).
    // Cheap guard against hallucination — if it wants to eject almost all,
    // almost certainly something went wrong. We log and skip rather than nuke.
    const cap = Math.floor(members.length * 0.6);
    if (ejectIds.length > cap) {
      console.log(`⚠ would eject ${ejectIds.length}/${members.length} — skipping (cap=${cap}). reason="${verdict.reason || ''}"`);
      await sleep(SLEEP_MS);
      continue;
    }
    if (!ejectIds.length) {
      console.log(`✓ coherent`);
      await sleep(SLEEP_MS);
      continue;
    }

    console.log(`✂ eject ${ejectIds.length} — "${verdict.reason || ''}"`);
    for (const id of ejectIds) {
      const m = membersCompact.find(x => x.id === id);
      console.log(`      - ${id}  ${m ? String(m.title).slice(0, 90) : '(?)'}`);
    }

    if (APPLY) {
      try {
        const res = await pool.query(`
          DELETE FROM story_thread_articles
           WHERE thread_id = $1 AND article_id = ANY($2::int[])
        `, [th.id, ejectIds]);
        if (res.rowCount > 0) {
          await pool.query(`
            UPDATE story_threads
               SET article_count = GREATEST(0, (
                     SELECT COUNT(*) FROM story_thread_articles WHERE thread_id = $1
                   )),
                   last_updated_at = NOW()
             WHERE id = $1
          `, [th.id]);
          totalEjected += res.rowCount;
          threadsTouched++;
        }
      } catch (err) {
        console.warn(`      ⚠ DB eject failed: ${err.message}`);
      }
    }

    await sleep(SLEEP_MS);
  }

  console.log(`\n✅ Done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`   Claude calls: ${claudeCalls}`);
  console.log(`   Threads touched: ${threadsTouched}`);
  console.log(`   Articles ejected: ${totalEjected}`);
  if (!APPLY) console.log(`   (dry run — no DB writes; re-run with --apply to apply)`);
  await pool.end();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
