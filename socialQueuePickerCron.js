#!/usr/bin/env node
/**
 * socialQueuePickerCron.js — twice-daily picker AND publisher in one
 * cron. Runs at 06:30 + 16:30 UTC.
 *
 * Two phases per run:
 *
 *   Phase 1 — PICK
 *     1. Pull top 30 active threads ordered by importance × recency.
 *     2. Apply dedup filters:
 *          - thread_id NOT in social_post_queue within 48h         (cooling)
 *          - title word-set overlap < 50% vs any post in last 14d (retitled-story guard)
 *     3. Apply diversity filters within the SELECTED BATCH:
 *          - at most 1 thread per `primary_nations[0]`              (lead-country dedup)
 *          - at least 3 distinct region buckets covered             (geographic diversity)
 *          - at most 1 thread from `mideast` or `russia_cis`        (hotspot cap)
 *     4. Pick 2-3 winners. Compose drafts. Insert with status='pending_video'.
 *
 *   Phase 2 — PUBLISH BACKLOG
 *     5. Find rows in pending_approval / approved status.
 *     6. Eligible to publish if EITHER:
 *          - /tmp/arc-cache/{thread_id}.mp4 exists (Mac worker uploaded
 *            the video), OR
 *          - row has been pending > STALE_THRESHOLD_H (image-only fallback
 *            so a vacation doesn't permanently block publishing)
 *     7. Rate-limited to MAX_PUBLISHES_PER_DAY to keep catch-up batches
 *        from spamming after a Mac-off stretch.
 *     8. Publish via socialPublishers.publishAll → flip status to 'posted'.
 *
 * Why one cron instead of two: posts go out at picker tick times anyway
 * (06:30 / 16:30 UTC). Polling for newly-eligible publishes more often
 * doesn't shift the post times. Single cron = simpler ops.
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
// --no-video skips the pending_video gate (e.g. for testing or when
// the admin's Mac worker is down for an extended period). When omitted,
// rows are inserted with status='pending_video' and only move to
// publishable state after the Mac worker uploads the arc.mp4.
const NO_VIDEO = process.argv.includes('--no-video');
// --test relaxes the diversity / hotspot / batch-min guards so a single
// thread can get picked and inserted. Use for end-to-end pipeline
// verification (Mac-worker → upload → publish) without waiting for the
// production picker quorum to be satisfied.
const TEST_MODE = process.argv.includes('--test');
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
    if (!TEST_MODE && lead && leadCountriesUsed.has(lead)) continue;  // lead-country dedup

    const region = getRegionGroup(t);
    const regionCount = regionCounts.get(region) || 0;
    const hotspotCap = HOTSPOT_REGIONS.has(region) ? MAX_PER_HOTSPOT : 2;
    if (!TEST_MODE && regionCount >= hotspotCap) continue;

    picked.push(t);
    if (lead) leadCountriesUsed.add(lead);
    regionCounts.set(region, regionCount + 1);
    reasons.push(`importance=${Number(t.importance).toFixed(1)}, region=${region}, lead=${lead || '—'}, articles=${t.article_count}${TEST_MODE ? ' [TEST_MODE]' : ''}`);
  }

  const distinctRegions = regionCounts.size;
  // TEST_MODE always reports diversity_ok=true so the caller doesn't
  // abort. Production: require >= MIN_REGIONS_PER_BATCH distinct regions
  // unless the pick was small enough that diversity is vacuous.
  const meetsDiversity = TEST_MODE
    ? true
    : (distinctRegions >= MIN_REGIONS_PER_BATCH || picked.length < MIN_REGIONS_PER_BATCH);

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

  // Filter cooling + title overlap. TEST_MODE skips both so a manual
  // trigger can re-pick threads picked earlier today (the whole point
  // of --test is to verify the pipeline; the spam guards make that
  // impossible when most candidates are already in cooling).
  const filtered = [];
  for (const t of candidates) {
    if (!TEST_MODE && recentThreadIds.has(t.id)) continue;             // 48h cooling
    if (!TEST_MODE && failsTitleOverlap(t, recentTokenSets)) continue; // re-titled spam guard
    filtered.push(t);
  }
  log(`After cooling + title overlap filters: ${filtered.length}${TEST_MODE ? ' (TEST_MODE: both filters bypassed)' : ''}`);

  const effectiveBatchMin = TEST_MODE ? 1 : BATCH_MIN;
  // Phase 1 skip conditions — don't exit the process here; we still want
  // Phase 2 (publish backlog) to run on every tick regardless of whether
  // Phase 1 finds anything pickable. Earlier these `process.exit(0)`
  // calls killed Phase 2 too, which left video-ready rows stuck in
  // pending_approval on quiet days.
  let picked = [];
  let reasons = [];
  let distinct_regions = 0;
  let meets_diversity = false;
  if (filtered.length < effectiveBatchMin) {
    log(`Only ${filtered.length} threads survived constraints — skipping Phase 1 (need ≥ ${effectiveBatchMin}).`);
  } else {
    const result = pickBatch(filtered);
    picked = result.picked;
    reasons = result.reasons;
    distinct_regions = result.distinct_regions;
    meets_diversity = result.meets_diversity;
    log(`Picked ${picked.length} of ${BATCH_TARGET}   regions=${distinct_regions}   diversity_ok=${meets_diversity}`);
    if (picked.length < effectiveBatchMin) {
      log(`Diversity constraints blocked too many — picked ${picked.length}, need ≥ ${effectiveBatchMin}. Skipping Phase 1.`);
      picked = [];
    }
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

    // Status decision:
    //   - default: 'pending_video' — wait for Mac worker to upload arc.mp4
    //     before this row becomes publishable
    //   - --no-video: 'pending_approval' (legacy behavior, no video gate)
    //   - --auto-publish: skip the video gate AND auto-publish immediately
    const initialStatus = (AUTO_PUBLISH || NO_VIDEO) ? 'pending_approval' : 'pending_video';
    let rowId;
    try {
      const { rows: [r] } = await pool.query(`
        INSERT INTO social_post_queue
          (thread_id, drafts, platforms_enabled, status, scheduled_for, selection_reason)
        VALUES ($1, $2::jsonb, $3::jsonb, $4, NOW(), $5)
        RETURNING id
      `, [t.id, JSON.stringify(drafts), JSON.stringify(platforms_enabled), initialStatus, reasons[i]]);
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

  // ── Phase 2: publish backlog ─────────────────────────────────────────
  // After picking new threads, also drain any earlier rows that have
  // since become publishable (Mac worker filled their video, or the
  // 48-hour stale fallback kicked in). One cron, two phases.
  //
  // Skipped on --dry-run and --auto-publish (auto-publish already
  // posted the rows in Phase 1, no separate publish step needed).
  if (!DRY_RUN && !AUTO_PUBLISH) {
    await _publishEligibleRows();
  }

  log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s. Queued ${inserted} row${inserted === 1 ? '' : 's'}${DRY_RUN ? ' (dry-run)' : ''}${AUTO_PUBLISH ? ' + auto-published' : ''}.`);
  if (PLATFORMS_DISABLED.size) log(`Disabled platforms: ${[...PLATFORMS_DISABLED].join(', ')}`);
  await pool.end();
})().catch(err => {
  console.error(`${TAG} fatal:`, err);
  process.exit(1);
});

// ── Phase 2 helper ─────────────────────────────────────────────────────
// Publish any rows that have moved to pending_approval (either the Mac
// worker uploaded the video OR the 48-hour stale fallback below flipped
// them). Rate-limited so vacation backlogs don't fire 20 posts at once.
//
// Source of truth is the status column (set by the web service's
// /api/video-jobs/:id/result endpoint), NOT the local filesystem —
// the cron and web service run as separate Render services with
// separate /tmp directories, so a filesystem check would never see
// the MP4 the Mac worker uploaded.
// Env-overridable so you don't need a redeploy to bump for testing.
// SOCIAL_PUBLISH_RUN_CAP — max posts per single picker run (default 3)
// SOCIAL_PUBLISH_DAILY_CAP — max posts across the UTC day (default 4)
const MAX_PUBLISHES_PER_RUN = Math.max(1, parseInt(process.env.SOCIAL_PUBLISH_RUN_CAP   || '3', 10) || 3);
const MAX_PUBLISHES_PER_DAY = Math.max(1, parseInt(process.env.SOCIAL_PUBLISH_DAILY_CAP || '4', 10) || 4);
const STALE_THRESHOLD_H     = 48;

async function _publishEligibleRows() {
  // Stale fallback: rows stuck in pending_video for > 48h get unblocked
  // so vacation / Mac-off stretches don't permanently freeze publishing.
  // They'll go out image-only on this run (no video URL in drafts).
  const { rowCount: stalePromoted } = await pool.query(`
    UPDATE social_post_queue
       SET status = 'pending_approval'
     WHERE status = 'pending_video'
       AND scheduled_for < NOW() - INTERVAL '${STALE_THRESHOLD_H} hours'
  `);
  if (stalePromoted > 0) {
    log(`  Stale-promoted ${stalePromoted} row${stalePromoted === 1 ? '' : 's'} from pending_video → pending_approval (>${STALE_THRESHOLD_H}h old)`);
  }

  const { rows: [{ count }] } = await pool.query(`
    SELECT COUNT(*)::int AS count
      FROM social_post_queue
     WHERE status = 'posted'
       AND posted_at > DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
  `);
  const publishedToday = Number(count) || 0;
  log(`\nPhase 2: publish eligible rows. Posted today: ${publishedToday} / ${MAX_PUBLISHES_PER_DAY}`);
  if (publishedToday >= MAX_PUBLISHES_PER_DAY) {
    log('  Daily cap reached. Skipping publish phase.');
    return;
  }

  const { rows: candidates } = await pool.query(`
    SELECT id, thread_id, drafts, platforms_enabled, scheduled_for,
           (arc_video IS NOT NULL) AS has_video,
           EXTRACT(EPOCH FROM (NOW() - scheduled_for))::int AS age_seconds
      FROM social_post_queue
     WHERE status IN ('pending_approval', 'approved')
     ORDER BY scheduled_for ASC
     LIMIT 20
  `);
  if (!candidates.length) { log('  No eligible rows.'); return; }

  // The base URL where publishers point Meta's servers to fetch the MP4.
  // Default to the Render direct hostname; override via PUBLIC_HOST env
  // when running behind a different ingress.
  const publicHost = (process.env.PUBLIC_HOST || 'https://earth-wjr6.onrender.com').replace(/\/+$/, '');

  let publishedThisRun = 0;
  const remainingCap = MAX_PUBLISHES_PER_DAY - publishedToday;
  for (const row of candidates) {
    if (publishedThisRun >= MAX_PUBLISHES_PER_RUN) break;
    if (publishedThisRun >= remainingCap) break;

    const ageHours = (row.age_seconds || 0) / 3600;
    const hasVideo = !!row.has_video;
    console.log(`  ▶ publish queue_id=${row.id} thread=${row.thread_id} (age=${ageHours.toFixed(1)}h, video=${hasVideo ? 'yes' : 'no'})`);

    // Inject video URLs into the drafts for platforms that support video.
    //
    // Instagram gets a four-video CAROUSEL (animated portrait → globe
    // arc → country pie → article bars). Each slide is rendered server-
    // side by the animatedCardRenderer (frame loop + ffmpeg) and served
    // from /share/thread/:id/{portrait,pie,articles}.mp4. The globe
    // clip (arc.mp4) is still produced by the Mac worker — it needs
    // real WebGL — and lives at the existing /arc.mp4 endpoint.
    //
    // Threads only supports single-media posts, so it gets the globe
    // arc.mp4 as its single video.
    //
    // Stale-fallback rows (no arc_video yet — Mac worker hasn't filled
    // them after 48h) publish image-only via the legacy path.
    const drafts = { ...(row.drafts || {}) };
    if (hasVideo) {
      const portraitUrl = `${publicHost}/share/thread/${row.thread_id}/portrait.mp4`;
      const arcUrl      = `${publicHost}/share/thread/${row.thread_id}/arc.mp4`;
      const pieUrl      = `${publicHost}/share/thread/${row.thread_id}/pie.mp4`;
      const articlesUrl = `${publicHost}/share/thread/${row.thread_id}/articles.mp4`;
      if (drafts.instagram) {
        // IG_FORCE_REELS=1 disables the 4-video carousel and posts only
        // arc.mp4 via the REELS path. Used as a diagnostic when IG keeps
        // rejecting carousel items with generic error code 2207077 — if
        // REELS succeeds with the same arc.mp4, the cards are the bad
        // item; if REELS also fails, the issue is broader (URL serving,
        // auth, etc).
        const forceReels = process.env.IG_FORCE_REELS === '1' || process.env.IG_FORCE_REELS === 'true';
        drafts.instagram = {
          ...drafts.instagram,
          // Order = scroll-stop priority: branded portrait card first
          // (best chance of stopping a fast scroll), then the cinematic
          // globe, then the data viz, then the article drill-down.
          ...(forceReels ? {} : { carousel_videos: [portraitUrl, arcUrl, pieUrl, articlesUrl] }),
          // Keep video_url for back-compat in case the publisher's
          // VIDEO_CAROUSEL path falls back to REELS on a partial outage.
          video_url:       arcUrl,
        };
      }
      if (drafts.threads) {
        // Threads also supports CAROUSEL (up to 10 items, added 2024).
        // Same 4 URLs as IG go through here; the threads publisher
        // builds a CAROUSEL when carousel_videos.length >= 2, else
        // falls back to single VIDEO using video_url.
        drafts.threads = {
          ...drafts.threads,
          carousel_videos: [portraitUrl, arcUrl, pieUrl, articlesUrl],
          video_url:       arcUrl,
        };
      }

      // ── Pre-warm the cards so Meta's transcoder fetches them from a
      // populated DB cache instead of triggering a 20-30s cold render
      // on the Render instance it happens to land on. Each card endpoint
      // checks the DB first; on cache miss it renders + writes the
      // BYTEA back to social_post_queue. After this Promise.all resolves,
      // every Render instance will serve the cards from shared DB
      // (instant) — so Meta's parallel container-create fetches all
      // succeed inside their transcoder timeout window.
      //
      // The arc.mp4 already lives in the DB (Mac worker uploads it via
      // /api/video-jobs/:thread_id/result) so we don't refetch that one.
      const t0Cards = Date.now();
      const warmRes = await Promise.allSettled([
        fetch(portraitUrl).then(r => r.arrayBuffer()),
        fetch(pieUrl).then(r => r.arrayBuffer()),
        fetch(articlesUrl).then(r => r.arrayBuffer()),
      ]);
      const warmFails = warmRes
        .map((r, i) => r.status === 'rejected' ? ['portrait','pie','articles'][i] : null)
        .filter(Boolean);
      console.log(`         pre-warmed cards in ${((Date.now() - t0Cards) / 1000).toFixed(1)}s${warmFails.length ? ` (failed: ${warmFails.join(',')})` : ''}`);
    }

    try {
      const { permalinks, failures } = await socialPublishers.publishAll(
        drafts,
        row.platforms_enabled || {},
        process.env,
      );
      const anySuccess = Object.keys(permalinks).length > 0;
      const nextStatus = anySuccess ? 'posted' : (failures.length ? 'failed' : 'approved');
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
        row.id,
        anySuccess,
      ]);
      console.log(`         → ${nextStatus} permalinks=${Object.keys(permalinks).join(',') || 'none'} failures=${failures.length}`);
      if (failures.length) for (const f of failures) console.log(`             ✗ ${f.platform}: ${f.error}`);
      if (anySuccess) publishedThisRun++;
    } catch (err) {
      warn(`publish failed for queue_id=${row.id}: ${err.message}`);
    }
  }
  log(`  Phase 2 done. Published ${publishedThisRun} row${publishedThisRun === 1 ? '' : 's'}.`);
}
