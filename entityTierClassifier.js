/**
 * Entity Tier Classifier
 *
 * Splits a thread's / line's candidate country list into:
 *   • PRIMARY    — the 1–3 countries the story is fundamentally about
 *   • SECONDARY  — supporters, commenters, affected parties, downstream
 *                  actors (up to 8)
 *
 * Rationale (per product discussion):
 *   The current story_threads.primary_nations column is over-populated —
 *   any country appearing as subject/actor across the thread's articles
 *   ends up flagged "primary." So a Russia-Ukraine thread picks up DE, FR,
 *   US, IL, etc. as "primary" even though they're commentary / support
 *   roles. This classifier narrows that list to the principals and moves
 *   the rest into a secondary tier.
 *
 * Design:
 *   1. Call Claude Haiku with title + description + keywords + candidates.
 *      Cheap (~200 output tokens), deterministic with low temp.
 *   2. Deterministic fallback if Claude fails or returns garbage: first 3
 *      candidates = primary, rest (cap 8) = secondary. Crude but never
 *      fails a run.
 *
 * Usage:
 *   const { classifyActorTiers } = require('./entityTierClassifier');
 *   const tiers = await classifyActorTiers({
 *     title, description, keywords, primary_category,
 *     candidateIsos: thread.primary_nations
 *   });
 *   // tiers = { primary: ['RU','UA'], secondary: ['US','DE','FR'],
 *   //           _claudeCalls: 1, _usage: { input_tokens, output_tokens, ... } }
 */
'use strict';

const Anthropic = require('@anthropic-ai/sdk');

const _client = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

// Hard caps — shared with downstream consumers so flow-arc topology stays
// bounded.
const MAX_PRIMARY   = 3;
const MAX_SECONDARY = 8;

/**
 * @param {Object} subject
 * @param {string} subject.title
 * @param {string} [subject.description]
 * @param {string[]} [subject.keywords]
 * @param {string} [subject.primary_category]
 * @param {string[]} subject.candidateIsos   — ISO codes to partition (current primary_nations)
 * @returns {Promise<{primary:string[], secondary:string[], _claudeCalls:number, _usage?:object, _fallback?:boolean}>}
 */
async function classifyActorTiers(subject) {
  const title    = String(subject.title || '').trim();
  const desc     = String(subject.description || '').slice(0, 500);
  const cat      = subject.primary_category || '';
  const kws      = Array.isArray(subject.keywords)
    ? subject.keywords.slice(0, 10).join(', ')
    : '';
  const cands    = Array.isArray(subject.candidateIsos)
    ? subject.candidateIsos.map(String).map(s => s.trim().toUpperCase()).filter(Boolean)
    : [];
  const uniqueCands = Array.from(new Set(cands));

  // Trivial cases — no Claude call needed.
  if (uniqueCands.length === 0) {
    return { primary: [], secondary: [], _claudeCalls: 0 };
  }
  if (uniqueCands.length === 1) {
    return { primary: uniqueCands, secondary: [], _claudeCalls: 0 };
  }

  // Claude-backed classification — the main path.
  if (_client && title) {
    const prompt =
`A news story:
  Title: "${title}"
  Description: "${desc}"
  Category: ${cat}
  Keywords: ${kws}

Candidate countries involved (ISO codes): ${uniqueCands.join(', ')}

Classify each candidate into exactly one tier:
  - PRIMARY:   The 1–3 countries this story is fundamentally ABOUT. Without
               them the story does not exist. Strictly limit to the
               principals / named parties in the core conflict, event, or
               subject.
  - SECONDARY: Countries involved as supporters, commenters, aid providers,
               sanctioning parties, affected neighbors, or downstream
               actors. Up to 8 of these.

Rules:
  - Be strict. A country providing aid, commentary, sanctions, or
    peripheral reaction is SECONDARY, not primary.
  - If the story is about a bilateral conflict, primary is exactly 2.
  - If about a single nation's internal affairs, primary is exactly 1.
  - Never promote a country to primary just because it appears often —
    promote only if the story is inherently about that country.
  - Use ONLY ISO codes from the candidate list above. Do not invent new
    ones. Do not omit any candidate — every candidate must go into
    primary or secondary.

Return ONLY this JSON object, nothing else, no markdown fences:
{"primary":["RU","UA"],"secondary":["US","DE","FR"]}`;

    try {
      const response = await _client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      });
      const raw = response.content?.[0]?.text || '';
      const match = raw.match(/\{[\s\S]*?\}/);
      if (!match) {
        return _fallback(uniqueCands, { _claudeCalls: 1, _usage: response.usage });
      }
      let parsed;
      try { parsed = JSON.parse(match[0]); }
      catch { return _fallback(uniqueCands, { _claudeCalls: 1, _usage: response.usage }); }

      const primary = _coerceIsoList(parsed.primary).filter(i => uniqueCands.includes(i)).slice(0, MAX_PRIMARY);
      const secondary = _coerceIsoList(parsed.secondary).filter(i => uniqueCands.includes(i) && !primary.includes(i)).slice(0, MAX_SECONDARY);

      // Any candidate Claude dropped entirely → bucket as secondary (up to cap).
      for (const iso of uniqueCands) {
        if (!primary.includes(iso) && !secondary.includes(iso) && secondary.length < MAX_SECONDARY) {
          secondary.push(iso);
        }
      }

      // If Claude returned zero primaries (rare — invalid JSON shape),
      // fall back to the deterministic path so we never ship an empty
      // primary tier for a thread that clearly has at least one actor.
      if (!primary.length) {
        return _fallback(uniqueCands, { _claudeCalls: 1, _usage: response.usage });
      }

      return {
        primary,
        secondary,
        _claudeCalls: 1,
        _usage: response.usage
      };
    } catch (err) {
      // Network / rate-limit / key issue — deterministic fallback keeps
      // the pipeline moving. The caller can see `_fallback: true` to
      // decide whether to log or retry.
      return _fallback(uniqueCands, { _claudeCalls: 0, _fallbackReason: err.message });
    }
  }

  // No Claude client at all (missing API key / not provided to this
  // environment) — deterministic fallback only.
  return _fallback(uniqueCands, { _claudeCalls: 0, _fallbackReason: 'no_client' });
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

function _coerceIsoList(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map(v => String(v || '').trim().toUpperCase())
    .filter(v => /^[A-Z]{2,3}$/.test(v));
}

// Deterministic fallback used on any Claude failure: first 3 candidates
// = primary, next 8 = secondary. Preserves candidate ordering so callers
// that pre-sort candidates (e.g. by mention count) get a sensible tier.
function _fallback(candidates, extra = {}) {
  return {
    primary:   candidates.slice(0, MAX_PRIMARY),
    secondary: candidates.slice(MAX_PRIMARY, MAX_PRIMARY + MAX_SECONDARY),
    _fallback: true,
    ...extra,
  };
}

module.exports = {
  classifyActorTiers,
  MAX_PRIMARY,
  MAX_SECONDARY,
};
