'use strict';
/**
 * storyTracker.js
 *
 * Maintains persistent story identities across daily briefings.
 *
 * Two-phase API (called from briefingGenerator.js):
 *
 *   Phase 1 — BEFORE Claude narrative:
 *     const storyContexts = await resolveStoryContexts(threadData);
 *     → Returns { [threadId]: { storyIdentityId, dayNumber, isOngoing, canonicalTitle } }
 *     → Inject into the Claude prompt so voiceover says "Day 3 of..."
 *
 *   Phase 2 — AFTER episode is saved to DB:
 *     await saveSegmentLinks(episodeId, segments, storyContexts);
 *     → Persists segment → story_identity relationships for future lookups
 *
 * Matching strategy (no pgvector required):
 *   Layer 1 — Jaccard keyword overlap on story_identities.keywords (GIN index)
 *   Layer 2 — Claude Haiku verification for borderline overlap scores (cheap, fast)
 */

require('dotenv').config();
const pool      = require('./db');
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Thresholds ──────────────────────────────────────────────────────────────
const JACCARD_AUTO_MATCH  = 0.55;  // overlap ≥ this → match without Claude
const JACCARD_MAYBE_MATCH = 0.28;  // overlap ≥ this → ask Claude
const LOOKBACK_DAYS       = 60;    // how far back to search for active identities
const MAX_KEYWORDS        = 30;    // cap on keywords stored per identity

// ── Phase 1: resolve contexts before narrative generation ───────────────────
async function resolveStoryContexts(threadData) {
  const contexts = {};  // keyed by String(thread.id)

  for (const thread of threadData) {
    if (!thread.id) continue;

    const keywords = normaliseKeywords(thread.keywords);
    let storyIdentityId, dayNumber, isOngoing, canonicalTitle;

    // ── Layer 1: keyword Jaccard ──────────────────────────────────────────
    const candidates = await findCandidateIdentities(keywords);
    let matched = null;

    if (candidates.length > 0) {
      const top = candidates[0];
      if (parseFloat(top.overlap_score) >= JACCARD_AUTO_MATCH) {
        matched = top;
      } else if (parseFloat(top.overlap_score) >= JACCARD_MAYBE_MATCH) {
        // ── Layer 2: Claude Haiku verification (cheap) ──────────────────
        const ok = await claudeVerifyMatch(thread.title, top.canonical_title);
        if (ok) matched = top;
      }
    }

    if (matched) {
      // ── Continuing story ─────────────────────────────────────────────
      storyIdentityId = matched.id;
      canonicalTitle  = matched.canonical_title;
      isOngoing       = true;

      // day_number = distinct briefing dates that have covered this identity + 1
      const { rows: dayRows } = await pool.query(`
        SELECT COUNT(DISTINCT be.target_date) + 1 AS next_day
        FROM segment_story_links ssl
        JOIN briefing_episodes be ON be.id = ssl.briefing_episode_id
        WHERE ssl.story_identity_id = $1
      `, [storyIdentityId]);
      dayNumber = parseInt(dayRows[0]?.next_day || 2, 10);

      // Merge incoming keywords into identity (keeps coverage expanding)
      const merged = mergeKeywords(matched.keywords || [], keywords);
      await pool.query(`
        UPDATE story_identities
        SET last_seen_at  = NOW(),
            mention_count = mention_count + 1,
            keywords      = $2,
            is_active     = TRUE
        WHERE id = $1
      `, [storyIdentityId, merged]);

    } else {
      // ── New story — create identity ──────────────────────────────────
      canonicalTitle = thread.title;
      isOngoing      = false;
      dayNumber      = 1;

      const { rows: [row] } = await pool.query(`
        INSERT INTO story_identities (canonical_title, keywords, tags)
        VALUES ($1, $2, $3)
        RETURNING id
      `, [
        thread.title,
        keywords.slice(0, MAX_KEYWORDS),
        thread.primary_category ? [thread.primary_category] : [],
      ]);
      storyIdentityId = row.id;
    }

    contexts[String(thread.id)] = { storyIdentityId, dayNumber, isOngoing, canonicalTitle };
  }

  return contexts;
}

// ── Phase 2: persist segment links after episode DB save ────────────────────
async function saveSegmentLinks(episodeId, segments, storyContexts) {
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.type !== 'story' || !seg.thread_id) continue;

    const ctx = storyContexts[String(seg.thread_id)];
    if (!ctx) continue;

    await pool.query(`
      INSERT INTO segment_story_links
        (briefing_episode_id, segment_index, thread_id, story_identity_id, day_number)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (briefing_episode_id, segment_index) DO NOTHING
    `, [episodeId, i, seg.thread_id, ctx.storyIdentityId, ctx.dayNumber]);
  }
}

// ── Internal helpers ─────────────────────────────────────────────────────────

async function findCandidateIdentities(keywords) {
  if (!keywords.length) return [];

  // Jaccard = |A ∩ B| / |A ∪ B| computed entirely in SQL using unnest + ANY
  const { rows } = await pool.query(`
    SELECT
      si.id,
      si.canonical_title,
      si.keywords,
      si.mention_count,
      si.last_seen_at,
      (
        SELECT COUNT(*)::float
        FROM   unnest(si.keywords) k
        WHERE  k = ANY($1::text[])
      ) / NULLIF(
        array_length(si.keywords, 1)::float
        + $2::float
        - (
            SELECT COUNT(*)::float
            FROM   unnest(si.keywords) k
            WHERE  k = ANY($1::text[])
          ),
        0
      ) AS overlap_score
    FROM  story_identities si
    WHERE si.is_active = TRUE
      AND si.last_seen_at > NOW() - ($3 * INTERVAL '1 day')
      AND si.keywords && $1::text[]          -- GIN index shortcut: any overlap at all
    ORDER BY overlap_score DESC NULLS LAST,
             si.last_seen_at DESC
    LIMIT 5
  `, [keywords, keywords.length, LOOKBACK_DAYS]);

  return rows.filter(r => parseFloat(r.overlap_score) > 0);
}

async function claudeVerifyMatch(titleA, titleB) {
  try {
    const msg = await client.messages.create({
      model:      'claude-haiku-4-5',
      max_tokens: 10,
      messages:   [{
        role:    'user',
        content: `Same ongoing news story? YES or NO only.\nA: "${titleA}"\nB: "${titleB}"`,
      }],
    });
    return msg.content[0].text.trim().toUpperCase().startsWith('YES');
  } catch (e) {
    // Fail open: treat as new story rather than create a wrong link
    console.warn('[storyTracker] Claude verify failed:', e.message);
    return false;
  }
}

function normaliseKeywords(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(k => String(k).toLowerCase().trim()).filter(Boolean);
  if (typeof raw === 'string') {
    try { return normaliseKeywords(JSON.parse(raw)); } catch { return []; }
  }
  return [];
}

function mergeKeywords(existing, incoming) {
  const set = new Set([...existing, ...incoming]);
  return [...set].slice(0, MAX_KEYWORDS);
}

module.exports = { resolveStoryContexts, saveSegmentLinks };
