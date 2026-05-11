'use strict';

const { normalizeIso } = require('./isoCountryCodes');

/**
 * nationDesignations.js — single source of truth for how a thread's (or
 * timeline's) `primary_nations` / `secondary_nations` arrays are derived.
 *
 * Source of truth: the `article_locations` table, FILTERED to
 * `routing_type = 'content'` — populated by locationRouter.js when a
 * country/city is explicitly NAMED in an article's title or summary.
 *
 * Source-routed rows (`routing_type = 'source'`) are deliberately
 * EXCLUDED. Those mark the publisher's home country (city-level
 * publishers only) — useful for local-feed indexing but not for thread
 * subject derivation. A Singapore newspaper writing about Sinaloa was
 * adding Singapore to primary_nations purely on publisher origin, even
 * though Singapore is never named in any constituent article. The
 * comment "iff actually mentions it" was always the intent — the SQL
 * just wasn't enforcing it.
 *
 *   PRIMARY_CAP   = 4   — the spec's intended limit for "central actors"
 *   SECONDARY_CAP = 12  — generous, captures tangential mentions a story
 *                         legitimately touches without the bloat that
 *                         was making the flow context AI incoherent
 *
 * Noise floor (MIN_COUNT_FLOOR / MIN_COUNT_FRACTION) — without it, a
 * single passing mention of "Peru" or "Nicaragua" in one article out
 * of a 200-article Ukraine thread was enough to put those countries in
 * secondary_nations (the country gets a slot any time fewer than 16
 * distinct ISOs appear, and threads usually have 8-14). This was the
 * "why is Nicaragua on the Ukraine diplomacy thread" failure. The
 * floor requires either ≥MIN_COUNT_FLOOR distinct articles OR a share
 * ≥MIN_COUNT_FRACTION of the corpus, whichever is GREATER — so big
 * threads need proportionally more evidence (e.g. 200 articles → 4
 * mentions; 1000 articles → 20 mentions). Small threads keep the
 * floor of 2 so we don't accidentally blank legitimate tags.
 */

const PRIMARY_CAP   = 4;
const SECONDARY_CAP = 12;
const MIN_COUNT_FLOOR    = 2;     // a country needs at least this many distinct articles
const MIN_COUNT_FRACTION = 0.02;  // …or this share of the thread, whichever is larger

/**
 * Compute primary/secondary nation arrays for an arbitrary article-id set.
 * Used by both the in-cron path (after thread INSERT/UPDATE) and the
 * one-shot cleanup script.
 *
 * @param {Pool} pool  pg pool (or anything with .query)
 * @param {number[]} articleIds  the thread's full article set
 * @returns {Promise<{primary: string[], secondary: string[], total: number, mentions: Array<{iso: string, count: number}>}>}
 *   - primary: up to PRIMARY_CAP isos, ranked by distinct-article mention count
 *   - secondary: up to SECONDARY_CAP additional isos (no overlap with primary)
 *   - total: number of distinct articles that contributed any country mention
 *   - mentions: full ranked list (for diagnostics / cleanup diffs)
 *
 * Returns empty arrays when there are no articles or no extractor mentions —
 * caller should preserve the existing thread state in that case (don't
 * blank out a thread just because the extractor was offline).
 */
async function computeNationsFromArticles(pool, articleIds) {
  if (!Array.isArray(articleIds) || !articleIds.length) {
    return { primary: [], secondary: [], total: 0, mentions: [] };
  }
  const ids = articleIds.map(n => Number(n)).filter(Number.isFinite);
  if (!ids.length) return { primary: [], secondary: [], total: 0, mentions: [] };

  const { rows } = await pool.query(`
    SELECT c.iso_code AS iso, COUNT(DISTINCT al.article_id)::int AS count
      FROM article_locations al
      JOIN countries c ON c.id = al.country_id
     WHERE al.article_id = ANY($1::int[])
       AND al.routing_type = 'content'   -- only count subject mentions,
                                         -- not publisher origin (source)
       AND c.iso_code IS NOT NULL
       AND length(c.iso_code) = 2
     GROUP BY c.iso_code
     ORDER BY count DESC, iso ASC
  `, [ids]);

  const mentions = rows.map(r => ({ iso: String(r.iso).toUpperCase(), count: r.count }));

  // Noise-floor filter — see module header. A country needs at least
  // MAX(MIN_COUNT_FLOOR, ceil(MIN_COUNT_FRACTION * total)) distinct
  // article mentions to make the cut. For a 50-article thread that's
  // 2 articles; for a 200-article thread it's 4; for a 1000-article
  // thread it's 20. The intent is "the country has to be more than
  // a single passing reference in the corpus."
  const minCount = Math.max(
    MIN_COUNT_FLOOR,
    Math.ceil(MIN_COUNT_FRACTION * ids.length)
  );
  const significant = mentions.filter(m => m.count >= minCount);

  // Graceful fallback: if the filter would zero out everything (rare —
  // happens on tiny heterogeneous threads where no country gets even
  // 2 distinct-article mentions), keep the raw ranking rather than
  // blanking a thread's tags. Blanking would cascade into "no country
  // badges in the UI" + "the thread can no longer be found via country
  // filter," which is a worse failure mode than a slightly noisy tag.
  const eligible = significant.length ? significant : mentions;

  const primary   = eligible.slice(0, PRIMARY_CAP).map(m => m.iso);
  const secondary = eligible.slice(PRIMARY_CAP, PRIMARY_CAP + SECONDARY_CAP).map(m => m.iso);
  return { primary, secondary, total: ids.length, mentions };
}

/**
 * Same idea but pulls the article id list itself for a thread/timeline.
 * @param {'thread'|'timeline'} kind
 */
async function computeNationsForItem(pool, kind, itemId) {
  const linkTable = kind === 'thread' ? 'story_thread_articles'
                  : kind === 'timeline' ? 'story_timeline_articles'
                  : null;
  const idCol = kind === 'thread' ? 'thread_id'
              : kind === 'timeline' ? 'timeline_id'
              : null;
  if (!linkTable) throw new Error(`computeNationsForItem: unknown kind "${kind}"`);
  const { rows } = await pool.query(
    `SELECT article_id FROM ${linkTable} WHERE ${idCol} = $1`,
    [itemId]
  );
  return computeNationsFromArticles(pool, rows.map(r => r.article_id));
}

/**
 * Enforce the invariant that primary/secondary are disjoint AND each is
 * deduplicated within itself, AND respect the caps. Used at every write
 * site that doesn't already go through computeNationsFromArticles
 * (which produces disjoint sets by construction).
 *
 * Rules applied in order:
 *   1. Both arrays are uppercased + UK→GB normalized + length-2-iso filtered.
 *   2. Within-array dedup (preserve first occurrence).
 *   3. secondary = secondary − primary (primary wins).
 *   4. Cap primary at PRIMARY_CAP, secondary at SECONDARY_CAP.
 */
function enforceDisjointAndCapped(primaryRaw, secondaryRaw) {
  // Single-source-of-truth normalization via isoCountryCodes.normalizeIso:
  //   - rejects garbage strings ("EU", "XX", "AAAA")
  //   - canonicalizes alpha-3 → alpha-2 ("POL" → "PL", "RUS" → "RU")
  //   - applies the UK → GB legacy alias
  //   - rejects non-country codes that don't pass the whitelist
  // Replaces the prior /^[A-Za-z]{2}$/ regex which accepted ANY 2-letter
  // sequence, letting Claude hallucinations like "AA"/"XX" through, AND
  // the older /^[A-Za-z]{2,3}$/ form (still present elsewhere on the
  // read side) which allowed alpha-3 to land in primary_nations and
  // broke the FE chip's flag URL.
  const norm = (raw) => {
    const out = [], seen = new Set();
    for (const v of (raw || [])) {
      const code = normalizeIso(v);
      if (!code || seen.has(code)) continue;
      seen.add(code);
      out.push(code);
    }
    return out;
  };
  const primary   = norm(primaryRaw).slice(0, PRIMARY_CAP);
  const primarySet = new Set(primary);
  const secondary = norm(secondaryRaw)
    .filter(iso => !primarySet.has(iso))
    .slice(0, SECONDARY_CAP);
  return { primary, secondary };
}

module.exports = {
  PRIMARY_CAP,
  SECONDARY_CAP,
  computeNationsFromArticles,
  computeNationsForItem,
  enforceDisjointAndCapped,
};
