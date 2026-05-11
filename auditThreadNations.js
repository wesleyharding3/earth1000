#!/usr/bin/env node
'use strict';

/**
 * auditThreadNations.js — Claude-driven re-validator for
 * story_threads.primary_nations / secondary_nations.
 *
 * Motivation
 * ──────────
 * Two failure modes prompted this script:
 *
 *   (a) Path B (storyThreadBuilder.recomputeAndPersistNations) trusts
 *       article_locations.routing_type='content' rows, which are
 *       populated by locationRouter.js using DB-side keyword tables.
 *       A single bad row in country_location_keywords or
 *       city_location_keywords (e.g. a Barbadian city whose name
 *       doubles as a common English word) can quietly tag dozens of
 *       unrelated threads with the wrong country. The noise floor
 *       added to computeNationsFromArticles helps for single-article
 *       cases but not for keyword phrases that match across many
 *       articles.
 *
 *   (b) The new-thread path (storyThreadBuilder.persistThreadDef)
 *       trusts Claude's primary/secondary tags directly. Claude
 *       sometimes misses obvious primary nations ("Russian withdrawal
 *       triggers Sahel security collapse" with no Russia) and
 *       sometimes lists unrelated ones ("Chilean deputy Olivares
 *       attacked" with Slovakia + Russia, no Chile).
 *
 * This script asks Claude to re-derive primary/secondary from the
 * thread's actual article corpus AFTER thread creation, with the same
 * "ONLY IF EXPLICITLY NAMED" rule that storyThreadBuilder uses for
 * new threads. The key difference: this audit sees up to 80 articles
 * of context, while per-batch Claude only sees the new articles
 * arriving in that batch. That broader view catches both failure
 * modes above.
 *
 * Diagnostic output (the upstream-debugging payoff)
 * ─────────────────────────────────────────────────
 * For every ISO the audit proposes to REMOVE, the script prints the
 * article_locations evidence — which articles contributed that ISO and
 * via which mechanism (city keyword or country keyword). That tells
 * you exactly which DB row in country_location_keywords /
 * city_location_keywords is generating the false positive. Example:
 *
 *   Thread 9182 "Macron pushes Algeria reset"
 *   Proposed remove: BB (Barbados)
 *   Evidence — 3 articles contributed BB via article_locations:
 *     #4517391  city  Bath, BB     (article title: "...")
 *     #4517892  city  Bath, BB     (article title: "...")
 *     #4519201  city  Bath, BB     (article title: "...")
 *
 * Once you spot the bad keyword, the fix is a one-line DB update.
 *
 * Usage
 * ─────
 *   node auditThreadNations.js                          # dry-run, all active
 *   node auditThreadNations.js --thread=8742            # one thread
 *   node auditThreadNations.js --thread=8742,9011       # several
 *   node auditThreadNations.js --min-articles=5         # default 5
 *   node auditThreadNations.js --max-threads=200        # cost cap
 *   node auditThreadNations.js --max-articles=80        # per-thread sample cap
 *   node auditThreadNations.js --model=claude-haiku-4-5 # default
 *   node auditThreadNations.js --apply                  # writes
 *
 * Cost: ~$0.02/thread at Haiku rates × 200 threads = ~$4/run.
 */

// override:true so a blank ANTHROPIC_API_KEY in the local shell
// (Claude Desktop / Code exports an empty one) doesn't shadow the
// real one in .env. Production cron envs don't have this problem.
require('dotenv').config({ override: true });

process.env.DB_POOL_MAX = process.env.DB_POOL_MAX || '3';

const pool = require('./db');
const Anthropic = require('@anthropic-ai/sdk');
const { computeNationsForItem } = require('./nationDesignations');
const { normalizeIsoList } = require('./isoCountryCodes');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ARGV = new Map(process.argv.slice(2).map(a => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.length ? rest.join('=') : true];
}));
const APPLY        = !!ARGV.get('apply');
const MODEL        = ARGV.get('model') || 'claude-haiku-4-5';
const MIN_ARTICLES = parseInt(ARGV.get('min-articles') || '5', 10);
const MAX_THREADS  = parseInt(ARGV.get('max-threads') || '300', 10);
const MAX_ARTICLES = parseInt(ARGV.get('max-articles') || '80', 10);
const THREAD_FILTER = ARGV.get('thread')
  ? String(ARGV.get('thread')).split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean)
  : null;

// ─── Caps mirrored from nationDesignations.js ─────────────────────────
// We don't re-export them from the module — they're hardcoded here and
// just need to stay in sync. If those caps shift, this file needs
// to bump too. The Claude prompt also gets these values inlined.
const PRIMARY_CAP   = 4;
const SECONDARY_CAP = 12;

// ─── Main ─────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();
  const el = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

  console.log(`\n🌍 Thread Nation Audit — ${new Date().toISOString()}`);
  console.log(`   mode: ${APPLY ? 'APPLY (writes)' : 'DRY RUN'} | model: ${MODEL} | min_articles=${MIN_ARTICLES} | max_threads=${MAX_THREADS} | max_articles=${MAX_ARTICLES}${THREAD_FILTER ? ` | ids=${THREAD_FILTER.join(',')}` : ''}\n`);

  const threads = await loadThreads();
  console.log(`   [${el()}] Loaded ${threads.length} threads to audit\n`);

  let audited = 0;
  let unchanged = 0;
  let updated = 0;
  let added = 0;
  let removed = 0;

  for (const t of threads) {
    if (audited >= MAX_THREADS) break;

    const articles = await loadArticles(t.id, MAX_ARTICLES);
    if (articles.length < MIN_ARTICLES) continue;

    audited++;
    process.stdout.write(`   [${el()}] Thread ${t.id} (${articles.length} arts) "${(t.title || '').slice(0, 60)}" → Claude... `);

    let proposal;
    try {
      proposal = await askClaude(t, articles);
    } catch (err) {
      console.log(`✗ ERROR: ${err.message}`);
      continue;
    }

    const currentPrimary   = (t.primary_nations || []).map(s => String(s).toUpperCase());
    const currentSecondary = (t.secondary_nations || []).map(s => String(s).toUpperCase());
    const newPrimary       = proposal.primary;
    const newSecondary     = proposal.secondary;

    const removedP = currentPrimary.filter(c => !newPrimary.includes(c));
    const addedP   = newPrimary.filter(c => !currentPrimary.includes(c));
    const removedS = currentSecondary.filter(c => !newSecondary.includes(c));
    const addedS   = newSecondary.filter(c => !currentSecondary.includes(c));
    const anyChange = removedP.length || addedP.length || removedS.length || addedS.length;

    if (!anyChange) {
      unchanged++;
      console.log(`✓ unchanged`);
      continue;
    }

    updated++;
    added   += addedP.length + addedS.length;
    removed += removedP.length + removedS.length;

    console.log(`Δ change`);
    console.log(`      current  primary=[${currentPrimary.join(',')}]  secondary=[${currentSecondary.join(',')}]`);
    console.log(`      proposed primary=[${newPrimary.join(',')}]  secondary=[${newSecondary.join(',')}]`);
    if (proposal.rationale) {
      console.log(`      rationale: ${proposal.rationale}`);
    }

    // Diagnostic: for each REMOVED iso, show the article_locations
    // evidence so the operator can spot upstream DB-keyword bugs.
    // (Only useful for removals — additions don't have prior evidence.)
    const allRemoved = [...new Set([...removedP, ...removedS])];
    for (const iso of allRemoved) {
      const evidence = await loadIsoEvidence(t.id, iso);
      if (!evidence.length) {
        // Removed but no article_locations evidence → was a Claude
        // hallucination at thread creation that never had upstream
        // backing. Worth noting because it's a different failure mode
        // than "noisy keyword."
        console.log(`      remove ${iso}: NO article_locations evidence — likely Claude hallucination from new-thread path`);
        continue;
      }
      console.log(`      remove ${iso}: ${evidence.length} article${evidence.length === 1 ? '' : 's'} contributed via article_locations`);
      // Show up to 3 representative articles so the operator can
      // spot patterns (same keyword, same source, same publisher)
      // without drowning the log on a busy thread.
      for (const ev of evidence.slice(0, 3)) {
        const tag = ev.city_name ? `city:${ev.city_name}` : 'country-only';
        console.log(`        #${ev.article_id}  ${tag.padEnd(22)}  "${(ev.title || '').slice(0, 70)}"`);
      }
      if (evidence.length > 3) {
        console.log(`        … ${evidence.length - 3} more (re-run with --thread=${t.id} for full list)`);
      }
    }

    if (APPLY) {
      const safePrimary   = normalizeIsoList(newPrimary).slice(0, PRIMARY_CAP);
      const safeSecondary = normalizeIsoList(newSecondary)
        .filter(c => !safePrimary.includes(c))
        .slice(0, SECONDARY_CAP);
      await pool.query(
        `UPDATE story_threads
            SET primary_nations   = $2::text[],
                secondary_nations = $3::text[]
          WHERE id = $1`,
        [t.id, safePrimary, safeSecondary]
      );
      console.log(`      ✍ wrote primary=[${safePrimary.join(',')}] secondary=[${safeSecondary.join(',')}]`);
    }
  }

  const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n   ── Summary ──`);
  console.log(`   audited:   ${audited}`);
  console.log(`   unchanged: ${unchanged}`);
  console.log(`   updated:   ${updated} ${APPLY ? '(written)' : '(dry-run; pass --apply to write)'}`);
  console.log(`   isos added (proposed):   ${added}`);
  console.log(`   isos removed (proposed): ${removed}`);
  console.log(`   elapsed:   ${totalSec}s\n`);

  await pool.end().catch(() => {});
}

// ─── DB helpers ───────────────────────────────────────────────────────

async function loadThreads() {
  if (THREAD_FILTER) {
    const { rows } = await pool.query(
      `SELECT id, title, description, primary_category, keywords,
              primary_nations, secondary_nations, article_count
         FROM story_threads
        WHERE id = ANY($1::int[])`,
      [THREAD_FILTER]
    );
    return rows;
  }
  // Active + cooling threads above the article-count floor. We don't
  // gate on last_audited_at like auditThreadArticles does — nation
  // audit is meaningfully different and a parallel timestamp column
  // would need a migration. Keep it simple: --max-threads is the
  // cost ceiling, ORDER BY article_count DESC puts the busiest
  // (most-likely-to-be-noisy) threads first.
  const { rows } = await pool.query(`
    SELECT id, title, description, primary_category, keywords,
           primary_nations, secondary_nations, article_count
      FROM story_threads
     WHERE status IN ('active', 'cooling')
       AND article_count >= $1
     ORDER BY article_count DESC, last_updated_at DESC
     LIMIT $2
  `, [MIN_ARTICLES, MAX_THREADS * 2]);  // pull extra; we filter MIN_ARTICLES again client-side
  return rows;
}

async function loadArticles(threadId, limit) {
  const { rows } = await pool.query(`
    SELECT a.id,
           COALESCE(a.translated_title, a.title)     AS title,
           COALESCE(a.translated_summary, a.summary) AS summary,
           COALESCE(ns.name, ys.name)                AS source_name,
           co.name                                   AS country_name,
           a.published_at
      FROM story_thread_articles sta
      JOIN news_articles a         ON a.id = sta.article_id
      LEFT JOIN news_sources ns    ON ns.id = a.source_id
      LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
      LEFT JOIN countries co       ON co.id = a.country_id
     WHERE sta.thread_id = $1
     ORDER BY a.published_at DESC
     LIMIT $2
  `, [threadId, limit]);
  return rows;
}

// For a given thread + ISO, return the article_locations rows that
// contributed this country tag, joined to news_articles.title so the
// operator can spot which articles are pulling the bad ISO in. Used
// for the diagnostic block printed alongside each removal proposal.
async function loadIsoEvidence(threadId, iso) {
  const { rows } = await pool.query(`
    SELECT al.article_id,
           a.title,
           ci.name AS city_name,
           c.iso_code AS iso
      FROM article_locations al
      JOIN story_thread_articles sta ON sta.article_id = al.article_id
      JOIN countries c               ON c.id = al.country_id
      JOIN news_articles a           ON a.id = al.article_id
      LEFT JOIN cities ci            ON ci.id = al.city_id
     WHERE sta.thread_id = $1
       AND al.routing_type = 'content'
       AND UPPER(c.iso_code) = $2
     ORDER BY al.article_id ASC
  `, [threadId, iso.toUpperCase()]);
  return rows;
}

// ─── Claude prompt ────────────────────────────────────────────────────

async function askClaude(thread, articles) {
  const articleBlock = articles.map(a =>
    `#${a.id} [${a.source_name || '?'}${a.country_name ? ', ' + a.country_name : ''}] "${(a.title || '').slice(0, 180)}"\n   ${(a.summary || '').slice(0, 350).replace(/\s+/g, ' ')}`
  ).join('\n\n');

  const prompt = `You are auditing the primary_nations and secondary_nations arrays on a news story thread. Given the actual articles that make up the thread, decide which ISO 3166-1 alpha-2 country codes belong in each array.

STRICT RULES (these are the same rules the thread editor uses for NEW threads — apply them here, retroactively, to repair drift):

1. A country goes in primary_nations or secondary_nations ONLY IF it is EXPLICITLY NAMED in the title or summary of at least one constituent article — by canonical name, alias, demonym (e.g. "French" → FR), or a major city name. Do NOT add countries by inference, geographic proximity, regional affiliation, alliance membership, or "affected economies" hand-wave. If the country isn't literally mentioned in the text you can read, it does NOT go in the array.

2. primary_nations = the 1-${PRIMARY_CAP} country codes most CENTRAL to the story. Named actors, the site of the event, the state doing the action, the state being acted upon. A Macron–Algeria diplomacy thread = [FR, DZ]. A US airstrike on Iran = [US, IR]. A China–Taiwan summit = [CN, TW]. A Hungarian internal election = [HU].

3. secondary_nations = 0-${SECONDARY_CAP} additional countries with MEANINGFUL but non-central roles that ARE still explicitly mentioned — named allies, transit states named, rhetorical actors named, intermediaries named. If you can't point to a sentence in the provided articles that names the country, do NOT include it.

4. EU is not a country. Don't return "EU". The story's actual EU countries (FR, DE, IT, etc.) should be listed individually if they're named.

5. Use ISO 3166-1 alpha-2 codes only (two uppercase letters). NEVER alpha-3 ("FRA" is wrong; "FR" is right).

6. Be skeptical of stored arrays. The current arrays may contain garbage from old code paths — Barbados appearing on a Macron thread, Slovakia on a Chilean thread, missing the obvious primary actor. Ignore the stored arrays and decide from scratch based on the articles.

7. If the articles split into two truly distinct stories that were wrongly merged, focus primary_nations on the larger / more central cluster. (A separate audit will detach the outlier articles; you just label the dominant story.)

THREAD:
- id: ${thread.id}
- title: "${thread.title || ''}"
- category: ${thread.primary_category || 'unknown'}
- description: ${thread.description || '(none)'}
- current primary_nations:   ${JSON.stringify(thread.primary_nations || [])}
- current secondary_nations: ${JSON.stringify(thread.secondary_nations || [])}

ARTICLES (${articles.length}):
${articleBlock}

Return ONLY valid JSON in this exact schema:
{
  "primary_nations":   ["XX", ...],   // 1-${PRIMARY_CAP} alpha-2 codes
  "secondary_nations": ["XX", ...],   // 0-${SECONDARY_CAP} alpha-2 codes, disjoint from primary
  "rationale": "one-sentence explanation of the dominant story (under 25 words)"
}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1200,
    messages: [{ role: 'user', content: prompt }],
  });

  if (response?.stop_reason === 'max_tokens') {
    throw new Error(`Claude response hit max_tokens — likely truncated`);
  }

  const text = (response?.content || [])
    .map(p => typeof p?.text === 'string' ? p.text : '')
    .join('')
    .trim();
  const parsed = extractJson(text);
  if (!parsed) throw new Error(`Claude response was not valid JSON (head="${text.slice(0, 80).replace(/\s+/g, ' ')}")`);

  // Defensive normalization on the way out — normalizeIsoList strips
  // anything not on the alpha-2 whitelist (catches if Claude returned
  // alpha-3 or hallucinated codes like "EU" / "XX"), then we apply
  // the same disjoint + cap rules nationDesignations.enforceDisjointAndCapped
  // would. The audit's WRITE path also re-applies these, so this is
  // belt-and-suspenders.
  const primary = normalizeIsoList(parsed.primary_nations).slice(0, PRIMARY_CAP);
  const primarySet = new Set(primary);
  const secondary = normalizeIsoList(parsed.secondary_nations)
    .filter(c => !primarySet.has(c))
    .slice(0, SECONDARY_CAP);

  return {
    primary,
    secondary,
    rationale: String(parsed.rationale || '').trim().slice(0, 200),
  };
}

function extractJson(text) {
  const raw = String(text || '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try { return JSON.parse(raw); } catch (_) {}
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try { return JSON.parse(raw.slice(s, e + 1)); } catch (_) {}
  }
  return null;
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
