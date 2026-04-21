#!/usr/bin/env node
/**
 * Standalone thread-article sanity check.
 *
 * Runs the same phase as `node storyThreadBuilder.js --sanity-check-articles`
 * but without triggering a full thread rebuild. Use this when you just want
 * to audit which articles Claude thinks don't belong on their current
 * threads — cheap, idempotent, runs in a few minutes.
 *
 *   node tmp/runThreadSanityCheck.js                     # dry run (default)
 *   node tmp/runThreadSanityCheck.js --write             # actually detach
 *   node tmp/runThreadSanityCheck.js --limit=20          # cap thread count
 *   node tmp/runThreadSanityCheck.js --status=active     # only active threads
 */
'use strict';

require('dotenv').config({ override: true });
const Anthropic = require('@anthropic-ai/sdk');
const pool = require('../db');

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('FATAL: ANTHROPIC_API_KEY not set.'); process.exit(1);
}

const WRITE     = process.argv.includes('--write');
const LIMIT     = parseInt(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || '200', 10);
const STATUS    = (process.argv.find(a => a.startsWith('--status='))?.split('=')[1] || 'active,cooling')
                    .split(',').map(s => s.trim()).filter(Boolean);

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function main() {
  const t0 = Date.now();
  console.log(`\n┌─ Thread article sanity check`);
  console.log(`│  mode:    ${WRITE ? 'WRITE (detaches will persist)' : 'DRY RUN (log only)'}`);
  console.log(`│  status:  ${STATUS.join(', ')}`);
  console.log(`│  limit:   ${LIMIT} threads\n└─\n`);

  const { rows: threads } = await pool.query(`
    SELECT id, title, description, primary_category, keywords, primary_nations, article_count
    FROM story_threads
    WHERE status = ANY($1::text[])
      AND article_count >= 3
    ORDER BY article_count DESC
    LIMIT $2
  `, [STATUS, LIMIT]);

  const stats = {
    scanned: 0, flagged: 0, detached: 0, claudeCalls: 0,
    tokensIn: 0, tokensOut: 0,
  };

  for (const t of threads) {
    const { rows: articles } = await pool.query(`
      SELECT a.id, COALESCE(a.translated_title, a.title) AS title, sta.is_anchor
      FROM story_thread_articles sta
      JOIN news_articles a ON a.id = sta.article_id
      WHERE sta.thread_id = $1
      ORDER BY sta.is_anchor DESC NULLS LAST, a.published_at DESC
      LIMIT 40
    `, [t.id]);
    if (articles.length < 3) continue;
    stats.scanned++;

    const prompt =
`You are auditing articles attached to a news thread. Identify articles that
do NOT belong to this thread's theme.

THREAD:
  title: ${t.title}
  description: ${(t.description || '').slice(0, 300)}
  keywords: ${(t.keywords || []).slice(0, 8).join(', ')}
  primary_nations: ${(t.primary_nations || []).join(', ') || '(none)'}
  category: ${t.primary_category || ''}

ARTICLES ATTACHED:
${articles.map(a => `  ${a.id}${a.is_anchor ? ' [ANCHOR]' : ''}: ${String(a.title || '').slice(0, 160)}`).join('\n')}

Rules:
  - Article belongs if it covers the same event, story, or ongoing subject.
  - Tangential keyword mentions DON'T count.
  - NEVER flag an anchor article.
  - Be strict but not pedantic. False-positive detachments are WORSE than
    false-negatives. When in doubt, keep.

Return ONLY this JSON, no prose:
{"detach": [12345, 67890], "reason": "one sentence"}`;

    let detachIds = [];
    let reason = '';
    try {
      const r = await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      });
      stats.claudeCalls++;
      stats.tokensIn  += (r.usage?.input_tokens || 0) + (r.usage?.cache_read_input_tokens || 0);
      stats.tokensOut += r.usage?.output_tokens || 0;

      const match = (r.content?.[0]?.text || '').match(/\{[\s\S]*?\}/);
      if (!match) continue;
      let parsed;
      try { parsed = JSON.parse(match[0]); } catch { continue; }
      const anchorIds = new Set(articles.filter(a => a.is_anchor).map(a => a.id));
      const attachedIds = new Set(articles.map(a => a.id));
      detachIds = (Array.isArray(parsed.detach) ? parsed.detach : [])
        .map(n => parseInt(n, 10))
        .filter(n => Number.isFinite(n) && attachedIds.has(n) && !anchorIds.has(n));
      reason = String(parsed.reason || '').slice(0, 160);
    } catch (err) {
      console.warn(`  thread #${t.id}: claude failed — ${err.message}`);
      continue;
    }

    if (!detachIds.length) continue;
    stats.flagged += detachIds.length;

    console.log(`\n  thread #${t.id} "${String(t.title || '').slice(0, 60)}"`);
    console.log(`     reason: ${reason}`);
    for (const id of detachIds) {
      const a = articles.find(x => x.id === id);
      console.log(`     detach ${id}: ${String(a?.title || '?').slice(0, 100)}`);
    }

    if (WRITE) {
      const { rowCount } = await pool.query(
        `DELETE FROM story_thread_articles WHERE thread_id = $1 AND article_id = ANY($2::int[])`,
        [t.id, detachIds]
      );
      stats.detached += rowCount || 0;
      await pool.query(
        `UPDATE story_threads SET article_count = (SELECT COUNT(*) FROM story_thread_articles WHERE thread_id = $1) WHERE id = $1`,
        [t.id]
      );
    }

    await new Promise(r => setTimeout(r, 150));
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n╔═══════════════════════════════════════════════╗`);
  console.log(`║ SUMMARY                                       ║`);
  console.log(`╚═══════════════════════════════════════════════╝`);
  console.log(`  threads_scanned  : ${stats.scanned}`);
  console.log(`  articles_flagged : ${stats.flagged}`);
  console.log(`  articles_detached: ${stats.detached}${WRITE ? '' : ' (dry run)'}`);
  console.log(`  claude_calls     : ${stats.claudeCalls}`);
  console.log(`  tokens in/out    : ${stats.tokensIn} / ${stats.tokensOut}`);
  console.log(`  runtime          : ${secs}s`);

  await pool.end();
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
