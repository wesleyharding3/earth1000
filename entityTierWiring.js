/**
 * entityTierWiring.js
 *
 * DB-aware glue between the pure `classifyActorTiers` helper and the
 * thread/line persistence code. Both builders (storyThreadBuilder,
 * storyTimelineBuilder) call into here so the candidate-derivation +
 * classification + write logic lives in one place.
 *
 * Contract:
 *   - Candidate pool is whatever primary_nations currently holds on the
 *     row (already the over-populated list post-extraction). For lines,
 *     we also merge in primary_nations from attached threads so the
 *     line's candidate set stays broad.
 *   - Classifier runs. primary_nations is OVERWRITTEN with the narrowed
 *     1–3 tier. secondary_nations is set to the tiered 0–8 list.
 *   - 1-candidate trivial case: no Claude call, just write primary = [that]
 *     and secondary = []. 0-candidate case: no write.
 *
 * Admin curation note: Historically `primary_nations` was only populated
 * when NULL to respect manual admin edits. The tier classifier NARROWS
 * that list — so we do overwrite. If you want per-row admin curation
 * locked against the classifier, add a `nations_curated BOOLEAN` flag
 * and gate the update on it being false. For now: one automated source
 * of truth.
 */
'use strict';

const { classifyActorTiers } = require('./entityTierClassifier');

/**
 * Classify a single thread and write both nation columns.
 *
 * @param {object} pool - pg pool
 * @param {number} threadId
 * @returns {Promise<{primary:string[], secondary:string[], _claudeCalls:number, _usage?:object, skipped?:string}>}
 */
async function classifyAndTierThread(pool, threadId) {
  // Load thread metadata + current nation lists. Candidate pool is the
  // current primary_nations ∪ secondary_nations (post-previous-tiering),
  // which preserves countries that have been demoted to secondary from
  // earlier runs.
  const { rows } = await pool.query(`
    SELECT id, title, description, primary_category, keywords,
           primary_nations, secondary_nations
    FROM story_threads
    WHERE id = $1
  `, [threadId]);
  if (!rows.length) return { skipped: 'not_found' };
  const row = rows[0];

  const candidates = _mergeIsoLists(row.primary_nations, row.secondary_nations);
  if (!candidates.length) return { skipped: 'no_candidates' };

  const tiers = await _classifyWithTrivialShortCircuit({
    title: row.title,
    description: row.description,
    keywords: row.keywords,
    primary_category: row.primary_category,
    candidateIsos: candidates,
  });

  await pool.query(
    `UPDATE story_threads
        SET primary_nations   = $1,
            secondary_nations = $2
      WHERE id = $3`,
    [tiers.primary, tiers.secondary, threadId]
  );
  return tiers;
}

/**
 * Classify a single timeline and write both nation columns. Candidate
 * pool is the timeline's current lists unioned with every attached
 * thread's primary_nations — so a line reflects the union of actors
 * across its constituents.
 */
async function classifyAndTierTimeline(pool, timelineId) {
  const { rows: tlRows } = await pool.query(`
    SELECT id, title, description, primary_category, keywords,
           primary_nations, secondary_nations
    FROM story_timelines
    WHERE id = $1
  `, [timelineId]);
  if (!tlRows.length) return { skipped: 'not_found' };
  const row = tlRows[0];

  // Union with attached threads' nations — but SKIP during the one-shot
  // reclassify sweep (caller can pass mergeThreads=false to honor the
  // current column state as-is). Default true so runtime builder wiring
  // picks up new attached threads.
  const { rows: thrRows } = await pool.query(`
    SELECT primary_nations, secondary_nations
    FROM story_threads
    WHERE timeline_id = $1
  `, [timelineId]);

  const candidates = _mergeIsoLists(
    row.primary_nations,
    row.secondary_nations,
    ...thrRows.flatMap(t => [t.primary_nations, t.secondary_nations])
  );
  if (!candidates.length) return { skipped: 'no_candidates' };

  const tiers = await _classifyWithTrivialShortCircuit({
    title: row.title,
    description: row.description,
    keywords: row.keywords,
    primary_category: row.primary_category,
    candidateIsos: candidates,
  });

  await pool.query(
    `UPDATE story_timelines
        SET primary_nations   = $1,
            secondary_nations = $2
      WHERE id = $3`,
    [tiers.primary, tiers.secondary, timelineId]
  );
  return tiers;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internals
// ─────────────────────────────────────────────────────────────────────────────

/** Merge multiple ISO arrays into a single deduped, uppercased, validated list. */
function _mergeIsoLists(...lists) {
  const seen = new Set();
  for (const lst of lists) {
    if (!Array.isArray(lst)) continue;
    for (const v of lst) {
      const iso = String(v || '').trim().toUpperCase();
      if (/^[A-Z]{2,3}$/.test(iso)) seen.add(iso);
    }
  }
  return [...seen];
}

/**
 * Wrap classifyActorTiers so single-candidate rows skip the Claude call.
 * Everything else passes through unchanged.
 */
async function _classifyWithTrivialShortCircuit(subject) {
  const cands = Array.isArray(subject.candidateIsos) ? subject.candidateIsos : [];
  if (cands.length === 0) {
    return { primary: [], secondary: [], _claudeCalls: 0 };
  }
  if (cands.length === 1) {
    return { primary: cands.slice(), secondary: [], _claudeCalls: 0 };
  }
  return classifyActorTiers(subject);
}

module.exports = {
  classifyAndTierThread,
  classifyAndTierTimeline,
};
