#!/usr/bin/env node
'use strict';

/**
 * auditNationDesignations.js
 *
 * One-shot audit of the primary_nations / secondary_nations arrays on
 * story_threads and story_timelines. Source of truth is article_locations
 * — the structured "this article mentions country X" table that the
 * nation extractor populates from each article's title + summary.
 *
 * Three severity tiers, each surfaced separately:
 *
 *   SPURIOUS_PRIMARY  — country listed in primary_nations but every
 *                       constituent article has 0 mentions of it.
 *                       The flow context AI hates these — it tries to
 *                       explain "why is Brazil central to the Iran-US
 *                       blockade story?" and visibly gives up.
 *
 *   MISSING_PRIMARY   — country mentioned in ≥40% of constituent articles
 *                       but NOT in primary_nations OR secondary_nations.
 *                       The thread is materially about that country.
 *
 *   UNDER_PRIMARY     — country in primary_nations has dramatically lower
 *                       mention rate (<5%) than the top-mentioned country
 *                       that's NOT primary. Suggests the assignment
 *                       chased a single-article outlier.
 *
 * Usage:
 *   node auditNationDesignations.js                  # default: top 50 threads + 25 timelines
 *   node auditNationDesignations.js --limit=200      # show more rows
 *   node auditNationDesignations.js --threads-only
 *   node auditNationDesignations.js --timelines-only
 *   node auditNationDesignations.js --tier=SPURIOUS_PRIMARY  # filter to one severity
 *   node auditNationDesignations.js --out=tmp/nations.json   # also write JSON
 *
 * Read-only — never modifies the DB. Pair with a follow-up cleanup script
 * once the patterns are clear.
 */

process.env.DB_POOL_MAX = '3';
require('dotenv').config({ override: true });
const fs   = require('fs');
const path = require('path');
const pool = require('./db');

const ARGV = new Map(process.argv.slice(2).map(a => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.length ? rest.join('=') : true];
}));
const LIMIT          = parseInt(ARGV.get('limit') || '50', 10);
const THREADS_ONLY   = !!ARGV.get('threads-only');
const TIMELINES_ONLY = !!ARGV.get('timelines-only');
const TIER_FILTER    = ARGV.get('tier') || null;
const OUT            = ARGV.get('out') || null;

// Mention-rate thresholds for the three severity tiers. Tuned by eye on
// the iran/hormuz cluster — too low and every thread surfaces a noisy
// "missing" country; too high and we miss real omissions.
const SPURIOUS_MAX_MENTIONS  = 0;     // primary nation with literally zero article mentions
const MISSING_RATE_THRESHOLD = 0.40;  // ≥40% of articles mention it but it's not primary/secondary
const UNDER_MAX_RATE         = 0.05;  // primary nation appears in <5% of articles…
const UNDER_BEAT_BY          = 0.30;  // …while a non-primary country has ≥30 percentage points more

const TAG = '[audit-nations]';

function sanitizeIso(s) {
  if (!s) return null;
  const code = String(s).trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return null;
  return code === 'UK' ? 'GB' : code;
}

function classify({ id, title, primary, secondary, totalArticles, mentions }) {
  const issues = [];
  // Mentions: { iso → count }
  const mentionRate = iso => (mentions[iso] || 0) / Math.max(totalArticles, 1);

  // SPURIOUS_PRIMARY — primary listed but never mentioned by any article.
  for (const iso of primary) {
    if ((mentions[iso] || 0) <= SPURIOUS_MAX_MENTIONS) {
      issues.push({ tier: 'SPURIOUS_PRIMARY', iso, mentions: mentions[iso] || 0, rate: mentionRate(iso) });
    }
  }

  // MISSING_PRIMARY — heavily mentioned country isn't listed anywhere.
  const inAny = new Set([...primary, ...secondary]);
  for (const [iso, count] of Object.entries(mentions)) {
    if (inAny.has(iso)) continue;
    if ((count / Math.max(totalArticles, 1)) >= MISSING_RATE_THRESHOLD) {
      issues.push({ tier: 'MISSING_PRIMARY', iso, mentions: count, rate: count / totalArticles });
    }
  }

  // UNDER_PRIMARY — primary nation barely mentioned while a non-primary
  // country dominates by >30 percentage points.
  const sorted = Object.entries(mentions).sort((a, b) => b[1] - a[1]);
  const topNonPrimary = sorted.find(([iso]) => !primary.includes(iso));
  if (topNonPrimary) {
    const [topIso, topCount] = topNonPrimary;
    const topRate = topCount / Math.max(totalArticles, 1);
    for (const iso of primary) {
      const r = mentionRate(iso);
      if (r < UNDER_MAX_RATE && (topRate - r) >= UNDER_BEAT_BY) {
        issues.push({ tier: 'UNDER_PRIMARY', iso, mentions: mentions[iso] || 0, rate: r, beatenBy: { iso: topIso, rate: topRate } });
      }
    }
  }

  return issues;
}

async function auditTable(kind) {
  // kind: 'threads' | 'timelines'
  const isThreads = kind === 'threads';
  const itemTable = isThreads ? 'story_threads'           : 'story_timelines';
  const linkTable = isThreads ? 'story_thread_articles'   : 'story_timeline_articles';
  const idCol     = isThreads ? 'thread_id'               : 'timeline_id';
  const itemIdCol = 'id';

  console.log(`\n${TAG} auditing ${kind}…`);

  // Single big query: per item, return primary/secondary + per-iso mention
  // counts (DISTINCT article_id) joined through article_locations.
  const { rows } = await pool.query(`
    WITH active AS (
      SELECT i.${itemIdCol} AS item_id,
             i.title,
             i.primary_nations,
             i.secondary_nations,
             i.article_count,
             i.status,
             i.importance
        FROM ${itemTable} i
       WHERE i.status IN ('active','cooling','dormant')
         AND i.article_count >= 3
    ),
    item_articles AS (
      SELECT l.${idCol} AS item_id, l.article_id
        FROM ${linkTable} l
        JOIN active a ON a.item_id = l.${idCol}
    ),
    item_total AS (
      SELECT item_id, COUNT(DISTINCT article_id) AS total
        FROM item_articles
       GROUP BY item_id
    ),
    item_mentions AS (
      SELECT ia.item_id, c.iso_code, COUNT(DISTINCT ia.article_id) AS mentions
        FROM item_articles ia
        JOIN article_locations al ON al.article_id = ia.article_id
        JOIN countries c ON c.id = al.country_id
       WHERE c.iso_code IS NOT NULL
       GROUP BY ia.item_id, c.iso_code
    )
    SELECT a.item_id, a.title, a.primary_nations, a.secondary_nations,
           a.article_count, a.status, a.importance,
           it.total AS total_articles,
           COALESCE(json_agg(
             json_build_object('iso', im.iso_code, 'count', im.mentions)
             ORDER BY im.mentions DESC
           ) FILTER (WHERE im.iso_code IS NOT NULL), '[]'::json) AS mention_rows
      FROM active a
      JOIN item_total it ON it.item_id = a.item_id
 LEFT JOIN item_mentions im ON im.item_id = a.item_id
     GROUP BY a.item_id, a.title, a.primary_nations, a.secondary_nations,
              a.article_count, a.status, a.importance, it.total
  `);
  console.log(`${TAG}   loaded ${rows.length} ${kind}`);

  const flagged = [];
  for (const r of rows) {
    const primary   = (r.primary_nations   || []).map(sanitizeIso).filter(Boolean);
    const secondary = (r.secondary_nations || []).map(sanitizeIso).filter(Boolean);
    const mentions  = {};
    for (const m of (r.mention_rows || [])) {
      const iso = sanitizeIso(m.iso);
      if (iso) mentions[iso] = (mentions[iso] || 0) + (m.count || 0);
    }
    const issues = classify({
      id: r.item_id,
      title: r.title,
      primary,
      secondary,
      totalArticles: r.total_articles || 0,
      mentions,
    });
    if (!issues.length) continue;
    if (TIER_FILTER && !issues.some(i => i.tier === TIER_FILTER)) continue;
    flagged.push({
      kind,
      id:        r.item_id,
      title:     r.title,
      status:    r.status,
      importance:r.importance,
      articles:  r.total_articles,
      primary, secondary,
      topMentions: Object.entries(mentions).sort((a,b) => b[1] - a[1]).slice(0, 6)
                          .map(([iso, c]) => `${iso}:${c}`).join(' '),
      issues,
      // Severity score for sorting: spurious worst, missing next, under last.
      // Weighted by importance + article count so big stories surface first.
      score: issues.reduce((s, i) => s + (i.tier === 'SPURIOUS_PRIMARY' ? 3 : i.tier === 'MISSING_PRIMARY' ? 2 : 1), 0)
             * (1 + (r.importance || 0) / 10)
             * Math.log10(Math.max(r.total_articles || 1, 1) + 1),
    });
  }
  flagged.sort((a, b) => b.score - a.score);
  return flagged;
}

function printRow(r) {
  console.log(`\n  [${r.kind.toUpperCase()} #${r.id}] imp=${r.importance} arts=${r.articles} status=${r.status}`);
  console.log(`     ${(r.title || '').slice(0, 100)}`);
  console.log(`     primary=[${r.primary.join(',')}]  secondary=[${r.secondary.join(',')}]`);
  console.log(`     top mentions: ${r.topMentions}`);
  for (const i of r.issues) {
    if (i.tier === 'SPURIOUS_PRIMARY') {
      console.log(`     ⚠ SPURIOUS_PRIMARY ${i.iso} — listed primary but ${i.mentions} article mentions`);
    } else if (i.tier === 'MISSING_PRIMARY') {
      console.log(`     ⚠ MISSING_PRIMARY  ${i.iso} — ${i.mentions} mentions (${(i.rate*100).toFixed(0)}%) but not in primary/secondary`);
    } else if (i.tier === 'UNDER_PRIMARY') {
      console.log(`     ⚠ UNDER_PRIMARY    ${i.iso} (${(i.rate*100).toFixed(1)}%) — beaten by ${i.beatenBy.iso} (${(i.beatenBy.rate*100).toFixed(0)}%)`);
    }
  }
}

async function main() {
  const t0 = Date.now();
  console.log(`${TAG} start ${new Date().toISOString()}${TIER_FILTER ? ` filter=${TIER_FILTER}` : ''}`);

  const all = [];
  if (!TIMELINES_ONLY) all.push(...(await auditTable('threads')));
  if (!THREADS_ONLY)   all.push(...(await auditTable('timelines')));

  all.sort((a, b) => b.score - a.score);

  // Tier breakdown for the summary line.
  const counts = { SPURIOUS_PRIMARY: 0, MISSING_PRIMARY: 0, UNDER_PRIMARY: 0 };
  for (const r of all) for (const i of r.issues) counts[i.tier] = (counts[i.tier] || 0) + 1;

  console.log(`\n${TAG} flagged ${all.length} items — issues: SPURIOUS=${counts.SPURIOUS_PRIMARY} MISSING=${counts.MISSING_PRIMARY} UNDER=${counts.UNDER_PRIMARY}`);
  console.log(`${TAG} top ${Math.min(LIMIT, all.length)} by severity:`);

  const top = all.slice(0, LIMIT);
  for (const r of top) printRow(r);

  if (OUT) {
    const dir = path.dirname(path.resolve(OUT));
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
    fs.writeFileSync(OUT, JSON.stringify(all, null, 2));
    console.log(`\n${TAG} full report → ${OUT}`);
  }

  console.log(`\n${TAG} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  await pool.end();
}

main().catch(err => { console.error(`${TAG} fatal:`, err); process.exit(1); });
