#!/usr/bin/env node
/**
 * _test_actor_classifier.js
 *
 * Throwaway harness for iterating on a loosened actor-classification
 * prompt. Loads three real threads from production (10744, 10774, 10761),
 * builds an evidence pack from their constituent articles, and asks
 * Claude to classify primary/secondary/mentioned actors WITHOUT the
 * "must-be-named" gate that the production clustering prompt currently
 * enforces.
 *
 * Compares the result side-by-side with what's persisted in the DB so
 * we can judge whether the loosened prompt would give us the latent
 * actors we want (Israel/Saudi/UAE/Turkey/etc. on the Iran thread,
 * NATO members on the Trump-NATO thread, Paraguay+Taiwan on the
 * Beijing thread).
 *
 * Usage:
 *   node _test_actor_classifier.js              # default thread set
 *   node _test_actor_classifier.js 10744        # single thread
 *   MODEL=claude-sonnet-4-6 node _test_actor_classifier.js   # use Sonnet
 *
 * NOTE: this does NOT write to the DB. Read-only against the threads
 * + articles tables, plus an Anthropic API call per thread.
 */

'use strict';

process.env.DB_POOL_MAX = '1';
require('dotenv').config({ override: true });

const pool      = require('./db');
const Anthropic = require('@anthropic-ai/sdk');

const MODEL          = process.env.MODEL || 'claude-haiku-4-5-20251001';
const MAX_ARTICLES   = parseInt(process.env.MAX_ARTICLES || '8', 10);
const SUMMARY_CHARS  = 280;

const DEFAULT_THREAD_IDS = [10744, 10774, 10761];

const SYSTEM_PROMPT = `You are a geopolitical-affairs classifier embedded in a news-intelligence pipeline.

For a given news story, you must list every country with a MATERIAL STAKE in the story, drawing on BOTH:
  (a) the evidence pack of article titles and summaries we provide, AND
  (b) your pretrained geopolitical knowledge (alliances, rivalries, economic exposure, regional power dynamics, treaty obligations).

You are EXPECTED to include countries that are not named in the articles when the geopolitics of the story unambiguously implicate them. Examples:
  • A story about a US-Iran negotiation has Israel as a material stakeholder even if Israel is not named — the US-Israel alliance is the central reason the US is even at the table.
  • A story about NATO's future has every NATO member as a material stakeholder, plus Russia, plus Ukraine — even if the article only quotes a US politician.
  • A story about a Latin American president visiting Taiwan implicates Paraguay, Taiwan, China (the offended party), and the US (Paraguay's diplomatic recognition of Taiwan is part of the US-China proxy struggle in the region).

Output buckets:
  PRIMARY actors:    countries directly involved — named in the story, OR unambiguously the subject/object of the action even if a synecdoche is used (e.g. "Beijing" → CN, "Washington" → US, "the Élysée" → FR). 1-6 entries.
  SECONDARY actors:  countries with a clear material stake via alliance, economic exposure, regional rivalry, treaty obligation, or geographic proximity that makes them an unavoidable party to the outcome. INCLUDES inferred actors. Be liberal here — capturing latent stakeholders is the whole point of this classifier. 0-20 entries.
  MENTIONED:         countries referenced in the articles but with no material stake (e.g. a country quoted as a comparison, or appearing in a list of historical analogues). 0-10 entries.

Each SECONDARY actor MUST have a one-sentence rationale grounded in geopolitical reality, NOT a restatement of what the articles say.

Confidence: report a 0.0-1.0 score reflecting how confident you are that this is a complete and accurate classification. Lower confidence is appropriate when:
  • The story involves obscure non-state actors you don't recognize
  • The articles describe a post-2026 geopolitical realignment you may not be fully aware of
  • The story is highly local and you can't tell who else has stake

Return STRICTLY this JSON, no surrounding text:
{
  "primary":    ["ISO2", ...],
  "secondary":  ["ISO2", ...],
  "mentioned":  ["ISO2", ...],
  "rationale":  { "ISO2": "one sentence", ... },
  "confidence": 0.0
}

ISO2 codes only (alpha-2). Use GB not UK. Sort each array alphabetically.`;

function buildUserMessage(thread, articles) {
  const lines = [];
  lines.push(`Thread title: ${thread.title}`);
  if (thread.description) lines.push(`Thread description: ${thread.description}`);
  if (thread.primary_category) lines.push(`Category: ${thread.primary_category}`);
  lines.push(`Geographic scope: ${thread.geographic_scope}`);
  lines.push(`Article count: ${thread.article_count}`);
  lines.push('');
  lines.push(`Top ${articles.length} articles (title + summary excerpt):`);
  lines.push('');
  articles.forEach((a, i) => {
    const t = a.translated_title || a.title;
    const s = (a.translated_summary || a.summary || '').slice(0, SUMMARY_CHARS);
    lines.push(`${i + 1}. ${t}`);
    if (s) lines.push(`   ${s}${s.length >= SUMMARY_CHARS ? '…' : ''}`);
    lines.push('');
  });
  lines.push('Now classify actors per the system prompt. Return JSON only.');
  return lines.join('\n');
}

async function loadThreadArticles(threadId) {
  const { rows: tr } = await pool.query(
    `SELECT id, title, description, status, primary_category, article_count,
            primary_nations, secondary_nations, geographic_scope
       FROM story_threads WHERE id = $1`,
    [threadId],
  );
  if (!tr.length) return null;
  const thread = tr[0];

  const { rows: arts } = await pool.query(
    `SELECT a.id, a.title, a.summary, a.translated_title, a.translated_summary,
            sta.relevance_score, sta.is_anchor
       FROM story_thread_articles sta
       JOIN news_articles a ON a.id = sta.article_id
      WHERE sta.thread_id = $1
      ORDER BY sta.is_anchor DESC, sta.relevance_score DESC, a.published_at DESC
      LIMIT $2`,
    [threadId, MAX_ARTICLES],
  );

  const { rows: extLocs } = await pool.query(
    `SELECT c.iso_code AS iso, COUNT(DISTINCT al.article_id)::int AS count
       FROM article_locations al
       JOIN countries c ON c.id = al.country_id
       JOIN story_thread_articles sta ON sta.article_id = al.article_id
      WHERE sta.thread_id = $1
        AND al.routing_type = 'content'
        AND c.iso_code IS NOT NULL
      GROUP BY c.iso_code
      ORDER BY count DESC, iso ASC`,
    [threadId],
  );

  return { thread, articles: arts, extractorMentions: extLocs };
}

async function classify(thread, articles) {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const userMsg = buildUserMessage(thread, articles);
  const resp = await client.messages.create({
    model: MODEL,
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userMsg }],
  });
  const text = (resp.content || [])
    .map(b => (b.type === 'text' ? b.text : ''))
    .join('')
    .trim();
  let parsed = null;
  try {
    const m = text.match(/\{[\s\S]*\}/);
    parsed = m ? JSON.parse(m[0]) : null;
  } catch (_) { /* swallow */ }
  return { raw: text, parsed, usage: resp.usage };
}

function fmtList(arr) {
  if (!Array.isArray(arr) || !arr.length) return '(none)';
  return arr.join(', ');
}

(async () => {
  const cliIds = process.argv.slice(2).map(s => Number(s)).filter(Number.isFinite);
  const ids = cliIds.length ? cliIds : DEFAULT_THREAD_IDS;
  console.log(`Model: ${MODEL}`);
  console.log(`Testing threads: ${ids.join(', ')}\n`);
  let totalIn = 0, totalOut = 0;

  for (const id of ids) {
    console.log(`\n══════════════════════════════════════════════════════════`);
    console.log(`Thread ${id}`);
    console.log(`══════════════════════════════════════════════════════════`);

    const loaded = await loadThreadArticles(id);
    if (!loaded) { console.log('  ⚠ not found'); continue; }
    const { thread, articles, extractorMentions } = loaded;

    console.log(`Title: ${thread.title}`);
    console.log(`Category: ${thread.primary_category}  Scope: ${thread.geographic_scope}  Articles: ${thread.article_count}`);
    console.log(`\n--- PERSISTED IN DB ---`);
    console.log(`primary_nations:   ${fmtList(thread.primary_nations)}`);
    console.log(`secondary_nations: ${fmtList(thread.secondary_nations)}`);
    console.log(`\n--- EXTRACTOR (article_locations content rows) ---`);
    if (!extractorMentions.length) {
      console.log(`(no rows — locationRouter found nothing)`);
    } else {
      console.log(extractorMentions.map(m => `  ${m.iso}: ${m.count}`).join('\n'));
    }
    console.log(`\n--- ARTICLES IN PACK (${articles.length}) ---`);
    articles.forEach((a, i) => {
      console.log(`  ${i + 1}. ${(a.translated_title || a.title).slice(0, 120)}`);
    });

    console.log(`\n--- CLAUDE CLASSIFICATION (${MODEL}) ---`);
    const t0 = Date.now();
    const { raw, parsed, usage } = await classify(thread, articles);
    const dt = Date.now() - t0;
    if (usage) {
      totalIn  += usage.input_tokens || 0;
      totalOut += usage.output_tokens || 0;
      console.log(`tokens: in=${usage.input_tokens}  out=${usage.output_tokens}  cached=${usage.cache_read_input_tokens || 0}  (${dt}ms)`);
    }
    if (!parsed) {
      console.log(`PARSE FAIL. Raw output:\n${raw.slice(0, 600)}`);
      continue;
    }
    console.log(`confidence: ${parsed.confidence}`);
    console.log(`primary:    ${fmtList(parsed.primary)}`);
    console.log(`secondary:  ${fmtList(parsed.secondary)}`);
    console.log(`mentioned:  ${fmtList(parsed.mentioned)}`);
    if (parsed.rationale && Object.keys(parsed.rationale).length) {
      console.log(`rationale:`);
      for (const [iso, why] of Object.entries(parsed.rationale)) {
        console.log(`  ${iso}: ${why}`);
      }
    }
  }

  console.log(`\n══════════════════════════════════════════════════════════`);
  console.log(`TOTAL: input=${totalIn}  output=${totalOut}  est. cost @ Haiku 4.5: $${((totalIn * 1 + totalOut * 5) / 1_000_000).toFixed(4)}`);
  await pool.end();
})().catch(e => {
  console.error('Test failed:', e);
  process.exit(1);
});
