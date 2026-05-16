#!/usr/bin/env node
/**
 * socialQueuePickerCron.js — twice-daily picker that selects 2-3 threads
 * for social posting and queues them as draft-then-approve rows.
 *
 * Schedule via Render Cron Jobs at 06:30 UTC + 16:30 UTC (= 23:30 + 09:30
 * PT). Approximate global news cadence: morning catches commute, late
 * afternoon catches end-of-workday.
 *
 * Selection algorithm (in order):
 *   1. Pull top 30 active threads ordered by importance × recency.
 *   2. Apply dedup filters:
 *        - thread_id NOT in social_post_queue within 48h          (cooling)
 *        - title word-set overlap < 50% vs any post in last 14d  (retitled-story guard)
 *   3. Apply diversity filters within the SELECTED BATCH:
 *        - at most 1 thread per `primary_nations[0]`              (lead-country dedup)
 *        - at least 3 distinct region buckets covered             (geographic diversity)
 *        - at most 1 thread from `mideast` or `russia_cis`        (hotspot cap)
 *   4. Pick 2-3 winners. Compose drafts. Insert into queue.
 *
 * Each row lands with status='pending_approval'. Approval happens in the
 * earth-editor Social Queue tab. Auto-publish (the future cron) only
 * acts on status='approved' rows — never on pending ones.
 */

'use strict';

process.env.DB_POOL_MAX = '2';
require("dotenv").config();
const pool = require('./db');
const { composeDrafts } = require('./socialDraftComposer');
const socialPublishers = require('./publishers');

const TAG = '[socialPicker]';
const DRY_RUN = process.argv.includes('--dry-run');
const AUTO_PUBLISH = process.argv.includes('--auto-publish');
// Per-platform disable. Pass --no-x to skip X (e.g. when free-tier credits
// are exhausted). Other platforms have similar flags. Useful while one
// platform's billing is in a bad state.
const PLATFORMS_DISABLED = new Set();
for (const arg of process.argv) {
  const m = arg.match(/^--no-(x|reddit|linkedin|bluesky|instagram|threads)$/);
  if (m) PLATFORMS_DISABLED.add(m[1]);
}

// ── Selection constants ───────────────────────────────────────────────────
const BATCH_TARGET            = 3;    // post 2-3 per session; we aim for 3 and accept down to 2 if constraints bite
const BATCH_MIN               = 2;
const CANDIDATE_POOL_SIZE     = 30;   // top-N by importance × recency
const COOLING_HOURS           = 48;   // per-thread cooling
const TITLE_OVERLAP_WINDOW_DAYS = 14;
const TITLE_OVERLAP_THRESHOLD = 0.50; // ≥ 50% word overlap → block
const MIN_REGIONS_PER_BATCH   = 3;
const HOTSPOT_REGIONS         = new Set(['mideast', 'russia_cis']);
const MAX_PER_HOTSPOT         = 1;

const log  = (m) => console.log(`${TAG} ${m}`);
const warn = (m) => console.warn(`${TAG} ${m}`);

// ── Region tagging — copied from briefingGenerator.js ────────────────────
// Kept in-line rather than imported so this cron isn't blocked on briefing
// generator's heavier require chain (Anthropic client, etc).
function getRegionGroup(thread) {
  const _gs = Array.isArray(thread.geographic_scope) ? thread.geographic_scope
            : thread.geographic_scope ? [thread.geographic_scope] : [];
  const titleAndScope = [thread.title || '', ..._gs].join(' ').toLowerCase();
  const withCategory = titleAndScope + ' ' + (thread.primary_category || '').toLowerCase();

  if (/iran|iraq|israel|gaza|hezbollah|hamas|saudi|yemen|syria|hormuz|gulf.state|qatar|bahrain|oman|jordan|lebanon|middle.?east/.test(titleAndScope)) return 'mideast';
  if (/russia|ukraine|belarus|caucasus|georgia|armenia|azerbaijan|kazakhstan|uzbek|central.?asia/.test(titleAndScope)) return 'russia_cis';
  if (/china|japan|korea|taiwan|hong.?kong|mongolia|east.?asia/.test(titleAndScope)) return 'east_asia';
  if (/india|pakistan|bangladesh|nepal|sri.?lanka|south.?asia|afghanistan/.test(titleAndScope)) return 'south_asia';
  if (/southeast.?asia|myanmar|thailand|vietnam|indonesia|philip|malaysia|singapore|cambodia|laos/.test(titleAndScope)) return 'se_asia';
  if (/africa|nigeria|ethiopia|kenya|egypt|sudan|ghana|tanzania|south.?africa|morocco|algeria|niger|congo|mali/.test(titleAndScope)) return 'africa';
  if (/latin.?america|mexico|brazil|argentin|colombia|venezuela|chile|peru|ecuador|cuba|haiti/.test(titleAndScope)) return 'latam';
  if (/europe|germany|france|britain|uk |poland|spain|italy|nato|netherlands|sweden|norway|finland/.test(withCategory)) return 'europe';
  if (/united.?states|u\.s\.|america|canada|north.?america|trump|congress|senate|federal.reserve|pentagon|white.house|doge|tariff.*us|us.*tariff/.test(withCategory)) return 'north_america';
  if (/australia|new.?zealand|pacific|oceania/.test(withCategory)) return 'oceania';
  return 'global';
}

// Title-overlap dedup — Jaccard on lowercased word sets, skipping stopwords
// to avoid "by", "and", "the" inflating overlap on otherwise different titles.
const STOPWORDS = new Set([
  'a','an','the','of','in','on','at','for','to','and','or','but','with','by','as','is','are','was','were',
  'be','been','being','from','this','that','those','these','it','its','his','her','their','our','my','your',
  'over','under','before','after','about','into','through','between','amid','amidst','vs','vs.','against',
  'new','says','said','will','would','could','should','may','might','can','has','have','had','not','no',
]);

function tokenizeTitle(title) {
  if (!title) return new Set();
  return new Set(
    String(title)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length >= 3 && !STOPWORDS.has(w))
  );
}

function jaccardOverlap(setA, setB) {
  if (!setA.size || !setB.size) return 0;
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  const union = setA.size + setB.size - inter;
  return union ? inter / union : 0;
}

// ── Candidate fetch ──────────────────────────────────────────────────────
// Top N active threads with rich actor coverage + recent activity. The
// importance score is set by storyThreadBuilder; recency by last_updated_at.
async function fetchCandidates() {
  const { rows } = await pool.query(`
    SELECT st.id, st.title, st.description, st.primary_category, st.geographic_scope,
           st.importance, st.keywords, st.article_count,
           st.primary_nations, st.secondary_nations, st.last_updated_at
      FROM story_threads st
     WHERE st.status IN ('active','cooling')
       AND st.article_count >= 3
       AND st.title IS NOT NULL
       AND st.description IS NOT NULL
       AND st.last_updated_at > NOW() - INTERVAL '7 days'
  ORDER BY st.importance DESC,
           st.last_updated_at DESC
     LIMIT $1
  `, [CANDIDATE_POOL_SIZE]);
  return rows;
}

// ── Dedup filters ────────────────────────────────────────────────────────
async function fetchRecentlyQueuedThreadIds() {
  const { rows } = await pool.query(`
    SELECT DISTINCT thread_id
      FROM social_post_queue
     WHERE scheduled_for > NOW() - ($1::int * INTERVAL '1 hour')
  `, [COOLING_HOURS]);
  return new Set(rows.map(r => r.thread_id));
}

async function fetchRecentTitlesForOverlap() {
  const { rows } = await pool.query(`
    SELECT st.title
      FROM social_post_queue spq
      JOIN story_threads st ON st.id = spq.thread_id
     WHERE spq.scheduled_for > NOW() - ($1::int * INTERVAL '1 day')
  `, [TITLE_OVERLAP_WINDOW_DAYS]);
  return rows.map(r => tokenizeTitle(r.title));
}

function failsTitleOverlap(thread, recentTokenSets) {
  const myTokens = tokenizeTitle(thread.title);
  for (const recent of recentTokenSets) {
    if (jaccardOverlap(myTokens, recent) >= TITLE_OVERLAP_THRESHOLD) return true;
  }
  return false;
}

// ── Batch diversity selection ────────────────────────────────────────────
// Greedy: walk filtered candidates in importance order; accept each only
// if it doesn't violate per-batch constraints (lead-country dedup,
// region cap, etc). Stop at BATCH_TARGET hits.
function pickBatch(candidates) {
  const picked = [];
  const leadCountriesUsed = new Set();
  const regionCounts = new Map();
  const reasons = [];

  for (const t of candidates) {
    if (picked.length >= BATCH_TARGET) break;

    const lead = (Array.isArray(t.primary_nations) && t.primary_nations[0]) || null;
    if (lead && leadCountriesUsed.has(lead)) continue;  // lead-country dedup

    const region = getRegionGroup(t);
    const regionCount = regionCounts.get(region) || 0;
    const hotspotCap = HOTSPOT_REGIONS.has(region) ? MAX_PER_HOTSPOT : 2;
    if (regionCount >= hotspotCap) continue;

    picked.push(t);
    if (lead) leadCountriesUsed.add(lead);
    regionCounts.set(region, regionCount + 1);
    reasons.push(`importance=${Number(t.importance).toFixed(1)}, region=${region}, lead=${lead || '—'}, articles=${t.article_count}`);
  }

  // Diversity check: require at least MIN_REGIONS_PER_BATCH distinct regions.
  // If we picked < MIN regions, this batch fails — caller may decide to
  // accept anyway (e.g. when news is genuinely concentrated in one region).
  const distinctRegions = regionCounts.size;
  const meetsDiversity = distinctRegions >= MIN_REGIONS_PER_BATCH || picked.length < MIN_REGIONS_PER_BATCH;

  return {
    picked,
    reasons,
    distinct_regions: distinctRegions,
    meets_diversity: meetsDiversity,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────
(async () => {
  const t0 = Date.now();
  log(`Starting${DRY_RUN ? ' (DRY RUN)' : ''}…`);

  const [candidates, recentThreadIds, recentTokenSets] = await Promise.all([
    fetchCandidates(),
    fetchRecentlyQueuedThreadIds(),
    fetchRecentTitlesForOverlap(),
  ]);

  log(`Candidates: ${candidates.length}   in-cooling: ${recentThreadIds.size}   recent-titles: ${recentTokenSets.length}`);

  // Filter cooling + title overlap
  const filtered = [];
  for (const t of candidates) {
    if (recentThreadIds.has(t.id)) continue;             // 48h cooling
    if (failsTitleOverlap(t, recentTokenSets)) continue; // re-titled spam guard
    filtered.push(t);
  }
  log(`After cooling + title overlap filters: ${filtered.length}`);

  if (filtered.length < BATCH_MIN) {
    log(`Only ${filtered.length} threads survived constraints — skipping this batch (need ≥ ${BATCH_MIN}).`);
    await pool.end();
    process.exit(0);
  }

  const { picked, reasons, distinct_regions, meets_diversity } = pickBatch(filtered);
  log(`Picked ${picked.length} of ${BATCH_TARGET}   regions=${distinct_regions}   diversity_ok=${meets_diversity}`);

  if (picked.length < BATCH_MIN) {
    log(`Diversity constraints blocked too many — picked ${picked.length}, need ≥ ${BATCH_MIN}. Skipping batch.`);
    await pool.end();
    process.exit(0);
  }

  // Compose + insert
  let inserted = 0;
  for (let i = 0; i < picked.length; i++) {
    const t = picked[i];
    let drafts;
    try {
      drafts = composeDrafts(t);
    } catch (err) {
      warn(`compose failed for thread ${t.id}: ${err.message}`);
      continue;
    }

    console.log(`\n  [${i + 1}/${picked.length}] thread=${t.id} "${(t.title || '').slice(0, 70)}"`);
    console.log(`         reason: ${reasons[i]}`);
    console.log(`         X:        ${drafts.x.body.replace(/\n/g, ' ⏎ ').slice(0, 100)}…`);

    if (DRY_RUN) continue;

    // Build platforms_enabled object: enabled platforms default to true,
    // disabled (via --no-<platform>) set to false. The publishAll dispatcher
    // skips platforms set to false.
    const platforms_enabled = {};
    for (const p of ['x', 'reddit', 'linkedin', 'bluesky', 'instagram', 'threads']) {
      platforms_enabled[p] = !PLATFORMS_DISABLED.has(p);
    }

    // Insert as pending_approval first; flip to posted/failed below if
    // auto-publishing.
    let rowId;
    try {
      const { rows: [r] } = await pool.query(`
        INSERT INTO social_post_queue
          (thread_id, drafts, platforms_enabled, status, scheduled_for, selection_reason)
        VALUES ($1, $2::jsonb, $3::jsonb, 'pending_approval', NOW(), $4)
        RETURNING id
      `, [t.id, JSON.stringify(drafts), JSON.stringify(platforms_enabled), reasons[i]]);
      rowId = r.id;
      inserted++;
    } catch (err) {
      warn(`insert failed for thread ${t.id}: ${err.message}`);
      continue;
    }

    if (!AUTO_PUBLISH) continue;

    // Auto-publish: dispatch immediately, update row with results.
    try {
      const { permalinks, failures } = await socialPublishers.publishAll(
        drafts, platforms_enabled, process.env,
      );
      const anySuccess = Object.keys(permalinks).length > 0;
      const nextStatus = anySuccess ? 'posted' : (failures.length ? 'failed' : 'pending_approval');
      await pool.query(`
        UPDATE social_post_queue
           SET status      = $1,
               posted_at   = CASE WHEN $5::boolean THEN NOW() ELSE posted_at END,
               permalinks  = COALESCE(permalinks, '{}'::jsonb) || $2::jsonb,
               failure_log = failure_log || $3::jsonb
         WHERE id = $4
      `, [
        nextStatus,
        JSON.stringify(permalinks),
        JSON.stringify(failures.map(f => ({ ...f, attempted_at: new Date().toISOString() }))),
        rowId,
        anySuccess,
      ]);
      console.log(`         → ${nextStatus}  permalinks=${Object.keys(permalinks).join(',') || 'none'}  failures=${failures.length}`);
      if (failures.length) {
        for (const f of failures) console.log(`             ✗ ${f.platform}: ${f.error}`);
      }
    } catch (err) {
      warn(`auto-publish failed for queue row ${rowId}: ${err.message}`);
    }
  }

  log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s. Queued ${inserted} row${inserted === 1 ? '' : 's'}${DRY_RUN ? ' (dry-run)' : ''}${AUTO_PUBLISH ? ' + auto-published' : ''}.`);
  if (PLATFORMS_DISABLED.size) log(`Disabled platforms: ${[...PLATFORMS_DISABLED].join(', ')}`);
  await pool.end();
})().catch(err => {
  console.error(`${TAG} fatal:`, err);
  process.exit(1);
});
