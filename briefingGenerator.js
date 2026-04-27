#!/usr/bin/env node
/**
 * briefingGenerator.js
 *
 * Generates a daily Earth Briefing episode:
 *   1. Selects top story threads with topic + geographic diversity
 *   2. Pulls best articles + video for each thread
 *   3. Calls Claude Sonnet to write a broadcast-quality voiceover script
 *   4. Calls ElevenLabs to synthesise audio
 *   5. Stores the complete episode in briefing_episodes
 *
 * Usage:
 *   node briefingGenerator.js              # generate for today
 *   node briefingGenerator.js --force        # regenerate narrative/segments (reuses existing audio)
 *   node briefingGenerator.js --force-audio  # also re-synthesise audio (costs ElevenLabs credits)
 *   node briefingGenerator.js --no-audio     # skip ElevenLabs entirely (text + globe only)
 *   node briefingGenerator.js --pick         # interactive: choose threads manually from top 100
 */

'use strict';

// Cap this script's share of Postgres connections BEFORE db.js loads. Runs
// concurrently with web + worker + sibling crons; without this cap it would
// default to DB_POOL_MAX=60. Briefing is mostly Anthropic + ElevenLabs bound
// with sequential DB reads; 4 is plenty.
process.env.DB_POOL_MAX = "4";

require('dotenv').config();
const pool      = require('./db');
const readline  = require('readline');
const fs        = require('fs');
const path      = require('path');
const os        = require('os');
const { spawnSync } = require('child_process');
const Anthropic = require('@anthropic-ai/sdk');
const { resolveStoryContexts, saveSegmentLinks } = require('./storyTracker');
const dataPanels = require('./dataPanelGenerator');
// Consolidated deep enrichment — replaces the old per-thread
// _deepEnrichThread that re-scraped and re-Claude'd at briefing time.
// Data now lives in article_deep_context (populated by the thread
// builder's post-threading enrichment pass) and we just aggregate it.
const { loadContextForArticles, aggregateThreadContext } = require('./articleDeepEnrichment');

const client         = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID       = process.env.ELEVENLABS_VOICE_ID || process.env.ELEVENLABS_VOICE_ID_ENGLISH;

const FORCE        = process.argv.includes('--force');
const NO_AUDIO     = process.argv.includes('--no-audio');
const FORCE_AUDIO  = process.argv.includes('--force-audio'); // re-synthesise even if audio exists
const PICK_MODE    = process.argv.includes('--pick');        // interactive thread selection
const PANELS_ONLY  = process.argv.includes('--panels-only'); // regenerate only data panels for today's episode
const AUDIO_ONLY   = process.argv.includes('--audio-only');  // re-synthesise audio for an existing episode
const NO_PANELS    = process.argv.includes('--no-panels');   // skip data panel generation entirely
const MANIFEST_PATH = (() => {
  const idx = process.argv.indexOf('--manifest');
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
})();
const MANIFEST_MODE = !!MANIFEST_PATH;

// Data panel limits — 3..10 for general (auto) briefings, 2..5 for --pick / custom briefings
const PANELS_MIN_GENERAL = 3;
const PANELS_MAX_GENERAL = 10;
const PANELS_MIN_PICK    = 2;
const PANELS_MAX_PICK    = 5;

// ─── Config ────────────────────────────────────────────────────────────────
const MAX_THREADS          = 10;  // stories in one briefing
const MAX_ARTICLES_THREAD  = 6;   // articles shown per story
const MAX_CATEGORY_REPEAT  = 2;   // max threads from same category
const MAX_PER_REGION       = 2;   // max threads from the same geographic region
const MAX_ENGLISH_DOMINANT = 2;   // max threads where >70% of articles are English-sourced
const MAX_GLOBAL_BUCKET    = 3;   // cap on threads that fall through to the 'global' region bucket
                                  // (prevents US-centric stories without geo keywords from dominating)
const MIN_VIDEO_THREADS    = 3;   // at least this many story segments must have a video
const THREAD_ACTIVITY_LOOKBACK_DAYS = 3;   // thread must still have fresh activity to be briefing-eligible
const THREAD_ENRICH_LOOKBACK_DAYS   = 7;   // but enrich from a wider recent window so ongoing stories keep context
const MIN_RECENT_ARTICLES_AUTO      = 2;   // auto-selection stays stricter
const MIN_RECENT_ARTICLES_PICK      = 1;   // manual pick mode can include ongoing threads with a single fresh update
const ARTICLE_POOL_LIMIT            = 14;  // pull a wider pool, then choose a diverse representative set

// ─── Helpers ───────────────────────────────────────────────────────────────
function elapsed(t0) { return `+${((Date.now() - t0) / 1000).toFixed(1)}s`; }
function today()     { return new Date().toISOString().slice(0, 10); }
function sleep(ms)   { return new Promise(r => setTimeout(r, ms)); }

function normalizeArticleLanguage(value) {
  return String(value || 'en').trim().toLowerCase() || 'en';
}

function normalizeSourceKey(article) {
  if (article.source_key) return String(article.source_key);
  if (article.youtube_source_id != null) return `yt:${article.youtube_source_id}`;
  if (article.source_id != null) return `news:${article.source_id}`;
  return `unknown:${article.id}`;
}

function normalizeCountryKey(article) {
  return article.country_id != null ? String(article.country_id) : null;
}

function selectDiverseThreadArticles(poolArticles, limit) {
  const selected = [];
  const selectedIds = new Set();
  const sourceCounts = new Map();
  const countryCounts = new Map();
  const languageCounts = new Map();

  const articles = poolArticles.map((article, index) => ({
    ...article,
    __rank: index,
    source_key: normalizeSourceKey(article),
    article_language: normalizeArticleLanguage(article.article_language || article.language),
    country_key: normalizeCountryKey(article)
  }));

  while (selected.length < Math.min(limit, articles.length)) {
    let best = null;
    let bestScore = -Infinity;

    for (const article of articles) {
      if (selectedIds.has(article.id)) continue;

      const sourceSeen = sourceCounts.get(article.source_key) || 0;
      const countrySeen = article.country_key ? (countryCounts.get(article.country_key) || 0) : 0;
      const languageSeen = languageCounts.get(article.article_language) || 0;

      let score = (Number(article.relevance_score) || 0) * 100;
      score += Math.max(0, 20 - article.__rank);

      if (!sourceSeen) score += 14;
      else score -= sourceSeen * 7;

      if (article.country_key) {
        if (!countrySeen) score += 10;
        else score -= countrySeen * 5;
      }

      if (!languageSeen) score += 6;
      else score -= languageSeen * 2;

      if (article.video_id && !selected.some((item) => item.video_id)) score += 3;

      if (score > bestScore) {
        best = article;
        bestScore = score;
      }
    }

    if (!best) break;
    selected.push(best);
    selectedIds.add(best.id);
    sourceCounts.set(best.source_key, (sourceCounts.get(best.source_key) || 0) + 1);
    if (best.country_key) countryCounts.set(best.country_key, (countryCounts.get(best.country_key) || 0) + 1);
    languageCounts.set(best.article_language, (languageCounts.get(best.article_language) || 0) + 1);
  }

  return selected;
}

async function getThreadDiversityStats(threadIds, windowDays = THREAD_ACTIVITY_LOOKBACK_DAYS) {
  if (!threadIds.length) return new Map();

  const { rows } = await pool.query(`
    WITH article_lang AS (
      SELECT article_id, MIN(source_language) AS source_language
      FROM article_keywords
      WHERE article_id IN (
        SELECT sta.article_id
        FROM story_thread_articles sta
        WHERE sta.thread_id = ANY($1::int[])
      )
      GROUP BY article_id
    )
    SELECT
      sta.thread_id,
      COUNT(DISTINCT COALESCE(a.source_id::text, 'yt:' || a.youtube_source_id::text, 'unknown'))::int AS source_count,
      COUNT(DISTINCT a.country_id)::int AS country_count,
      COUNT(DISTINCT COALESCE(NULLIF(a.language, ''), al.source_language, 'en'))::int AS language_count
    FROM story_thread_articles sta
    JOIN news_articles a ON a.id = sta.article_id
    LEFT JOIN article_lang al ON al.article_id = a.id
    WHERE sta.thread_id = ANY($1::int[])
      AND a.published_at > NOW() - INTERVAL '${windowDays} days'
    GROUP BY sta.thread_id
  `, [threadIds]);

  return new Map(rows.map((row) => [Number(row.thread_id), row]));
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function run() {
  const t0 = Date.now();
  const targetDate = today();

  console.log('📡 Earth Briefing Generator');
  console.log(`   Date:  ${targetDate}`);
  console.log(`   Mode:  ${MANIFEST_MODE ? 'manifest' : PICK_MODE ? 'interactive (--pick)' : 'automatic'}`);
  console.log(`   Audio: ${NO_AUDIO ? 'disabled' : 'enabled (ElevenLabs)'}`);
  console.log();

  // Ensure preference learning table exists (idempotent)
  await ensureCurationTable();

  // ── --panels-only fast path: regenerate only data panels for today's episode
  if (PANELS_ONLY) {
    const { rows } = await pool.query(
      `SELECT id, segments FROM briefing_episodes WHERE user_id IS NULL AND target_date=$1 AND status='ready' ORDER BY id DESC LIMIT 1`,
      [targetDate]
    );
    if (!rows.length) {
      console.log(`✗ No ready briefing for ${targetDate}. Run without --panels-only first.`);
      await pool.end();
      return;
    }
    const ep = rows[0];
    const segs = typeof ep.segments === 'string' ? JSON.parse(ep.segments) : ep.segments;
    await regeneratePanelsForEpisode(ep.id, segs);
    console.log(`✅ Panels regenerated for episode ${ep.id} in ${elapsed(t0)}`);
    await pool.end();
    return;
  }

  // ── --audio-only fast path: re-synthesise audio for an existing episode ──
  if (AUDIO_ONLY) {
    const { rows } = await pool.query(
      `SELECT id, headline, segments FROM briefing_episodes WHERE user_id IS NULL AND target_date=$1 AND segments IS NOT NULL ORDER BY id DESC LIMIT 1`,
      [targetDate]
    );
    if (!rows.length) {
      console.log(`✗ No episode with segments for ${targetDate}. Generate segments first.`);
      await pool.end();
      return;
    }
    const ep = rows[0];
    let segments = typeof ep.segments === 'string' ? JSON.parse(ep.segments) : ep.segments;
    if (!segments?.length) {
      console.log(`✗ Episode ${ep.id} has no segments.`);
      await pool.end();
      return;
    }

    console.log(`   [${elapsed(t0)}] Audio-only mode: episode ${ep.id}, ${segments.length} segments`);

    if (!ELEVENLABS_KEY) {
      console.warn(`   ⚠ ELEVENLABS_API_KEY not set — cannot synthesise audio`);
      await pool.end();
      return;
    }

    // Same voice / transition split as the main path — see comment there.
    const audioBuffers     = [];
    const pieceDurationsMs = [];
    const pieceWordTimings = [];

    console.log(`   [${elapsed(t0)}] Synthesising ${segments.length} audio pieces with ElevenLabs (voice+transition split)...`);

    let pieceNum = 0;
    for (let si = 0; si < segments.length; si++) {
      const seg = segments[si];
      const voiceoverText = (seg.voiceover_text || '').trim();
      const transitionText = (seg.transition || '').trim();

      // Featured-media split: TTS the "before" and "after" halves
      // separately and concatenate their MP3 buffers. We stamp
      // _focalSplitMs (boundary within this piece) so the player can
      // fire the focal trigger at the precise sentence boundary instead
      // of an approximate percentage of segment duration.
      const fm = seg.featured_video || seg.video?.focal || seg.video_focal;
      const hasSplit = fm?.enabled
        && (seg.voiceover_before_video || '').trim()
        && (seg.voiceover_after_video  || '').trim();

      if (hasSplit) {
        pieceNum++;
        try {
          const beforePiece = await synthesiseAudio(seg.voiceover_before_video.trim());
          const afterPiece  = await synthesiseAudio(seg.voiceover_after_video.trim());
          const buffer      = Buffer.concat([beforePiece.buffer, afterPiece.buffer]);
          const durationMs  = beforePiece.durationMs + afterPiece.durationMs;
          const wordTimings = [
            ...(beforePiece.wordTimings || []),
            ...(afterPiece.wordTimings  || []).map(w => ({ ...w, t: (w.t || 0) + beforePiece.durationMs })),
          ];
          audioBuffers.push(buffer);
          pieceDurationsMs.push(durationMs);
          pieceWordTimings.push(wordTimings);
          seg._focalSplitMs = beforePiece.durationMs;
          console.log(`   [${elapsed(t0)}] Piece ${pieceNum} (seg ${si} voice split @ ${(beforePiece.durationMs/1000).toFixed(1)}s) — ${(buffer.byteLength/1024).toFixed(0)}KB · ${(durationMs/1000).toFixed(1)}s`);
        } catch (err) {
          console.warn(`   ⚠ Voiceover audio (split) for seg ${si} failed: ${err.message}`);
          audioBuffers.push(Buffer.alloc(0));
          pieceDurationsMs.push(0);
          pieceWordTimings.push([]);
        }
      } else if (voiceoverText) {
        pieceNum++;
        try {
          const { buffer, wordTimings, durationMs } = await synthesiseAudio(voiceoverText);
          audioBuffers.push(buffer);
          pieceDurationsMs.push(durationMs);
          pieceWordTimings.push(wordTimings || []);
          console.log(`   [${elapsed(t0)}] Piece ${pieceNum} (seg ${si} voice) — ${(buffer.byteLength / 1024).toFixed(0)}KB · ${(durationMs/1000).toFixed(1)}s`);
        } catch (err) {
          console.warn(`   ⚠ Voiceover audio for seg ${si} failed: ${err.message}`);
          audioBuffers.push(Buffer.alloc(0));
          pieceDurationsMs.push(0);
          pieceWordTimings.push([]);
        }
      } else {
        audioBuffers.push(Buffer.alloc(0));
        pieceDurationsMs.push(0);
        pieceWordTimings.push([]);
      }

      if (transitionText) {
        pieceNum++;
        try {
          const { buffer, wordTimings, durationMs } = await synthesiseAudio(transitionText);
          audioBuffers.push(buffer);
          pieceDurationsMs.push(durationMs);
          pieceWordTimings.push(wordTimings || []);
          console.log(`   [${elapsed(t0)}] Piece ${pieceNum} (seg ${si} trans) — ${(buffer.byteLength / 1024).toFixed(0)}KB · ${(durationMs/1000).toFixed(1)}s`);
        } catch (err) {
          console.warn(`   ⚠ Transition audio for seg ${si} failed: ${err.message}`);
          audioBuffers.push(Buffer.alloc(0));
          pieceDurationsMs.push(0);
          pieceWordTimings.push([]);
        }
      } else {
        audioBuffers.push(Buffer.alloc(0));
        pieceDurationsMs.push(0);
        pieceWordTimings.push([]);
      }
    }

    // Stamp each segment with its audio start offset + split breakdown.
    let cumMs = 0;
    for (let si = 0; si < segments.length; si++) {
      const voiceIdx = si * 2;
      const transIdx = si * 2 + 1;
      const vms = pieceDurationsMs[voiceIdx] || 0;
      const tms = pieceDurationsMs[transIdx] || 0;
      const vwords = pieceWordTimings[voiceIdx] || [];
      const twords = (pieceWordTimings[transIdx] || []).map(w => ({ ...w, start: w.start + vms, end: w.end + vms }));
      segments[si].start_ms           = cumMs;
      segments[si].duration_ms        = vms + tms;
      segments[si].voiceover_start_ms = cumMs;
      segments[si].voiceover_ms       = vms;
      segments[si].transition_start_ms= cumMs + vms;
      segments[si].transition_ms      = tms;
      segments[si].word_timings       = [...vwords, ...twords];
      // Featured-media segments: convert the within-piece split offset
      // into an absolute trigger time so the player fires focal at the
      // exact sentence boundary, no triggerPct guessing.
      if (segments[si]._focalSplitMs != null) {
        segments[si].focal_trigger_ms = cumMs + segments[si]._focalSplitMs;
        delete segments[si]._focalSplitMs;
      }
      cumMs += vms + tms;
    }

    // Concatenate all non-empty buffers into one MP3 file
    const concatted = Buffer.concat(audioBuffers.filter(b => b.byteLength > 0));
    let audioData = null;
    if (concatted.byteLength === 0) {
      console.warn(`   ⚠ All audio pieces failed — no audio stored (check ELEVENLABS_VOICE_ID and API key)`);
    } else {
      audioData = concatted;
      console.log(`   [${elapsed(t0)}] Audio ready — ${(audioData.length / 1024).toFixed(0)}KB total, ${(cumMs / 1000).toFixed(1)}s estimated`);
    }

    // Save audio_data and updated segments back to DB
    await pool.query(`
      UPDATE briefing_episodes
      SET segments   = $1,
          audio_data = $2,
          status     = 'ready',
          generated_at = NOW()
      WHERE id = $3
    `, [
      JSON.stringify(segments),
      audioData,
      ep.id
    ]);

    console.log(`✅ Audio-only regeneration complete for episode ${ep.id} in ${elapsed(t0)}`);
    await pool.end();
    return;
  }

  // Check if already generated today
  if (!FORCE) {
    const { rows } = await pool.query(
      `SELECT id, status FROM briefing_episodes WHERE user_id IS NULL AND target_date = $1 LIMIT 1`,
      [targetDate]
    );
    if (rows.length && rows[0].status === 'ready') {
      console.log(`✅ Briefing for ${targetDate} already exists (id=${rows[0].id}). Use --force to regenerate.`);
      await pool.end();
      return;
    }
  }

  // Create/update episode record as 'generating'.
  // ON CONFLICT won't match NULL user_id rows (Postgres treats NULLs as distinct),
  // so we SELECT the latest row and UPDATE it, or INSERT fresh if none exists.
  const { rows: existingRows } = await pool.query(
    `SELECT id FROM briefing_episodes WHERE user_id IS NULL AND target_date = $1 ORDER BY id DESC LIMIT 1`,
    [targetDate]
  );
  let episodeId;
  if (existingRows.length) {
    episodeId = existingRows[0].id;
    // Wipe audio when explicitly asked OR in pick-mode (manual story selection always
    // produces different content, so reusing stale audio would desync start_ms offsets
    // and leave the player with no voiceovers).
    if (FORCE_AUDIO || PICK_MODE || MANIFEST_MODE) {
      await pool.query(
        `UPDATE briefing_episodes SET status='generating', segments='[]', audio_data=NULL, generated_at=NOW() WHERE id=$1`,
        [episodeId]
      );
    } else {
      await pool.query(
        `UPDATE briefing_episodes SET status='generating', segments='[]', generated_at=NOW() WHERE id=$1`,
        [episodeId]
      );
    }
  } else {
    const { rows: [ep] } = await pool.query(`
      INSERT INTO briefing_episodes (user_id, target_date, status, segments)
      VALUES (NULL, $1, 'generating', '[]')
      RETURNING id
    `, [targetDate]);
    episodeId = ep.id;
  }
  console.log(`   [${elapsed(t0)}] Episode id=${episodeId} (${existingRows.length ? 'updated' : 'created'})`);

  try {
    // ── 1. Select story threads ───────────────────────────────────────────
    let threads;
    let manifest = null;
    if (MANIFEST_MODE) {
      manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
      console.log(`   [${elapsed(t0)}] Loaded manifest: ${manifest.selected_threads?.length || 0} threads`);
      // Fetch thread rows from DB matching manifest IDs
      const threadIds = manifest.selected_threads.map(t => t.thread_id);
      const { rows: threadRows } = await pool.query(`
        SELECT st.id, st.title, st.primary_category, st.importance, st.keywords, st.geographic_scope,
               COUNT(sta.article_id)::int AS recent_articles
        FROM story_threads st
        JOIN story_thread_articles sta ON sta.thread_id = st.id
        JOIN news_articles a ON a.id = sta.article_id
        WHERE st.id = ANY($1::int[])
          AND a.published_at > NOW() - INTERVAL '${THREAD_ACTIVITY_LOOKBACK_DAYS} days'
        GROUP BY st.id
      `, [threadIds]);
      // Preserve manifest ordering
      const rowMap = new Map(threadRows.map(r => [r.id, r]));
      threads = threadIds.map(id => rowMap.get(id)).filter(Boolean);
      if (!threads.length) throw new Error('No valid threads found from manifest');
    } else if (PICK_MODE) {
      console.log(`   [${elapsed(t0)}] Loading top 100 candidate threads for manual selection...`);
      const candidates = await listCandidateThreads(100);
      if (!candidates.length) throw new Error('No active story threads found — run storyThreadBuilder first');
      threads = await promptThreadSelection(candidates);
      if (!threads.length) throw new Error('No threads selected — aborting');
    } else {
      console.log(`   [${elapsed(t0)}] Selecting story threads...`);
      const profile = await buildPreferenceProfile();
      threads = await selectThreads(profile);
      if (!threads.length) throw new Error('No active story threads found — run storyThreadBuilder first');
    }
    console.log(`   [${elapsed(t0)}] Selected ${threads.length} threads`);
    console.log('\n── SELECTED THREADS ─────────────────────────────────────────');
    threads.forEach((t, i) => {
      console.log(`  [${i+1}] id=${t.id} | "${t.title}"`);
      const _scope = Array.isArray(t.geographic_scope) ? t.geographic_scope : (t.geographic_scope ? [t.geographic_scope] : []);
      console.log(`       category=${t.primary_category} importance=${t.importance} region=${_scope.join(',') || '?'}`);
      const _kws = Array.isArray(t.keywords) ? t.keywords : (t.keywords ? [t.keywords] : []);
      console.log(`       keywords=${_kws.slice(0,8).join(', ')}`);
    });
    console.log('─────────────────────────────────────────────────────────────\n');

    // ── 2. Pull articles for each thread ─────────────────────────────────
    console.log(`   [${elapsed(t0)}] Pulling articles for each thread...`);
    const pLimit = require('p-limit').default;
    const limit = pLimit(3); // adjust to 2–4 if needed

    const results = await Promise.allSettled(
      threads.map(t => limit(() => enrichThread(t)))
    );

    const rawThreadData = [];
    const failedThreads = [];

    results.forEach((res, i) => {
      if (res.status === 'fulfilled') {
        rawThreadData.push(res.value);
      } else {
        failedThreads.push({
          thread_id: threads[i]?.id,
          title: threads[i]?.title,
          error: res.reason?.message || String(res.reason)
        });
      }
    });

    // Optional logging so you know what failed without killing the job
    if (failedThreads.length) {
      console.warn(`⚠ ${failedThreads.length} thread(s) failed during enrichment:`);
      failedThreads.forEach(f =>
        console.warn(`   - [${f.thread_id}] ${f.title}: ${f.error}`)
      );
    }
    // ── 2b. Remove threads with >50% article overlap with a higher-ranked thread
    const threadData   = [];
    const seenArticles = [];
    for (const thread of rawThreadData) {
      const ids = new Set(thread.articleIds || []);
      if (ids.size === 0) { threadData.push(thread); continue; }
      const duplicate = seenArticles.some(prev => {
        const common = [...ids].filter(id => prev.has(id)).length;
        return common / Math.min(ids.size, prev.size) > 0.5;
      });
      if (duplicate) {
        console.log(`   Deduped thread: "${thread.title}" (>50% article overlap)`);
      } else {
        threadData.push(thread);
        seenArticles.push(ids);
      }
    }
    console.log(`   [${elapsed(t0)}] ${threadData.length} unique threads after overlap dedup`);

    // ── 2c. Load cached deep context from article_deep_context ────────────
    // Previously this block did fresh HTTP scrapes + fresh Haiku calls
    // to build thread.deepContext from scratch at briefing time
    // (_deepEnrichThread / deepEnrichAllThreads). Same work was already
    // being done by deepAnalyzer.js post-threading → we were paying
    // twice. Now articleDeepEnrichment.js persists per-article
    // enrichment to article_deep_context, and we just aggregate the
    // cached rows into thread.deepContext here. No Claude call, no
    // scrape — just a DB read.
    console.log(`   [${elapsed(t0)}] Loading cached deep context from article_deep_context...`);
    await loadDeepContextFromCache(threadData);
    console.log(`   [${elapsed(t0)}] Deep context loaded`);

    console.log('\n── ENRICHED THREADS ─────────────────────────────────────────');
    threadData.forEach((t, i) => {
      console.log(`  [${i+1}] "${t.title}" (id=${t.id})`);
      console.log(`       articles=${t.articleIds?.length || 0} | video=${t.videoId || 'none'}`);
      console.log(`       primaryCity=${JSON.stringify(t.primaryCity || null)}`);
      console.log(`       primaryCountry=${JSON.stringify(t.primaryCountry || null)}`);
      console.log(`       globeFocus=${JSON.stringify(t.globeFocus || null)}`);
    });
    console.log('─────────────────────────────────────────────────────────────\n');

    // ── 3a. Resolve story identities (continuity tracking) ───────────────
    console.log(`   [${elapsed(t0)}] Resolving story continuity...`);
    const storyContexts = await resolveStoryContexts(threadData).catch(e => {
      console.warn(`   ⚠ storyTracker failed (non-fatal): ${e.message}`);
      return {};
    });
    const ongoingCount = Object.values(storyContexts).filter(c => c.isOngoing).length;
    if (ongoingCount) console.log(`   [${elapsed(t0)}] ${ongoingCount} ongoing story/stories detected`);

    // ── 3b. Generate Claude narrative (includes story entity extraction) ──
    console.log(`   [${elapsed(t0)}] Generating narrative with Claude...`);
    const prefProfileForNarrative = (PICK_MODE || MANIFEST_MODE) ? null : await buildPreferenceProfile().catch(() => null);
    // Inject manifest steering hints into thread data for Claude
    if (MANIFEST_MODE && manifest?.selected_threads) {
      for (const mt of manifest.selected_threads) {
        if (mt.steering_hint) {
          const td = threadData.find(t => String(t.id) === String(mt.thread_id));
          if (td) td._steeringHint = mt.steering_hint;
        }
        if (mt.youtube_video) {
          const td = threadData.find(t => String(t.id) === String(mt.thread_id));
          if (td) td._youtubeOverride = mt.youtube_video;
        }
        if (mt.featured_video?.enabled) {
          const td = threadData.find(t => String(t.id) === String(mt.thread_id));
          if (td) td._featuredVideo = mt.featured_video;
        }
        // Side tweet — independent of the featured-media moment. The
        // narrator references it (the embedded post sits beside the article
        // card) but the script does NOT split with [VIDEO_HANDOFF].
        if (mt.side_tweet_url) {
          const td = threadData.find(t => String(t.id) === String(mt.thread_id));
          if (td) td._sideTweetUrl = mt.side_tweet_url;
        }
      }
    }
    let narrative;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        narrative = await generateNarrative(threadData, storyContexts, prefProfileForNarrative);
        if (!narrative.segments?.length) throw new Error('Claude returned 0 story segments');
        break;
      } catch (narErr) {
        if (attempt < 2) {
          console.warn(`   [${elapsed(t0)}] Narrative attempt ${attempt} failed (${narErr.message}), retrying...`);
        } else {
          throw new Error(`Narrative generation failed after ${attempt} attempts: ${narErr.message}`);
        }
      }
    }
    console.log(`   [${elapsed(t0)}] Narrative ready — headline: "${narrative.headline}" (${narrative.segments.length} segments)`);
    console.log('\n══ CLAUDE NARRATIVE OUTPUT ══════════════════════════════════');
    console.log(`  HEADLINE : ${narrative.headline}`);
    console.log(`  INTRO    : ${narrative.intro}`);
    console.log(`  OUTRO    : ${narrative.outro}`);
    narrative.segments.forEach((s, i) => {
      console.log(`\n  ── Segment ${i+1} (thread_id=${s.thread_id}) ─────────────────`);
      console.log(`     voiceover  : ${s.voiceover}`);
      console.log(`     transition : ${s.transition || '(none)'}`);
      console.log(`     entities   : ${JSON.stringify(s.entities || [])}`);
      console.log(`     globe_focus: ${JSON.stringify(s.globe_focus || null)}`);
    });
    console.log('═════════════════════════════════════════════════════════════\n');

    // ── Validate thread_ids before spending any ElevenLabs credits ────────
    const validThreadIds = new Set(threadData.map(t => String(t.id)));
    const badSegs = narrative.segments.filter(s => !validThreadIds.has(String(s.thread_id)));
    if (badSegs.length) {
      console.warn(`   ⚠️  ${badSegs.length} segment(s) have invalid thread_ids: ${badSegs.map(s => s.thread_id).join(', ')}`);
      console.warn(`   Valid thread_ids: ${[...validThreadIds].join(', ')}`);
      if (badSegs.length > narrative.segments.length / 2) {
        throw new Error(`Claude returned too many invalid thread_ids (${badSegs.length}/${narrative.segments.length}) — aborting to avoid wasting audio credits`);
      }
    }

    // ── 4. Resolve entity coordinates from DB ─────────────────────────────
    console.log(`   [${elapsed(t0)}] Resolving story entity coordinates...`);
    const entityCoords = await resolveEntityCoords(narrative.segments);
    console.log(`   [${elapsed(t0)}] Resolved ${Object.keys(entityCoords).length} entities`);
    console.log('\n── ENTITY COORDS ────────────────────────────────────────────');
    Object.entries(entityCoords).forEach(([name, coords]) => {
      console.log(`  ${name.padEnd(28)} lat=${String(coords.lat).padEnd(10)} lon=${coords.lon}  type=${coords.type||'?'}`);
    });
    console.log('─────────────────────────────────────────────────────────────\n');

    // ── 5. Build geographic flow arcs (entity-based, not source-based) ────
    const allArcs = buildFlowArcs(threadData, narrative, entityCoords);

    console.log('\n── FLOW ARCS ────────────────────────────────────────────────');
    if (allArcs.length === 0) {
      console.log('  (none)');
    } else {
      allArcs.forEach((a, i) => {
        console.log(`  [${i+1}] thread=${a.thread_id} | ${a.from_name} (${a.from_lat},${a.from_lng}) → ${a.to_name} (${a.to_lat},${a.to_lng})`);
      });
    }
    console.log('─────────────────────────────────────────────────────────────\n');

    // ── 6. Build segments JSON ────────────────────────────────────────────
    let segments = await buildSegments(narrative, threadData, allArcs, entityCoords);

    // ── 6a. Generate data analytics panels FIRST so they're visible in script review
    // When running in manifest mode, only generate panels for segments explicitly
    // marked as eligible via dp_eligible_segments (editor checkbox). This cuts Sonnet
    // costs by skipping segments the editor didn't flag.
    const dpEligibleSet = MANIFEST_MODE && manifest?.options?.dp_eligible_segments
      ? new Set(manifest.options.dp_eligible_segments.map(Number))
      : null; // null = all eligible (automatic/pick mode)
    if (!NO_PANELS) {
      const minTotal = PICK_MODE ? PANELS_MIN_PICK : PANELS_MIN_GENERAL;
      const maxTotal = PICK_MODE ? PANELS_MAX_PICK : PANELS_MAX_GENERAL;
      const eligibleStories = segments.filter((s, si) => {
        if (s.type !== 'story') return false;
        if (dpEligibleSet && !dpEligibleSet.has(si)) return false;
        return true;
      });
      const storyCount = eligibleStories.length || 1;
      const perStoryMax = Math.max(1, Math.ceil(maxTotal / storyCount));
      const perStoryMin = 0;
      console.log(`   [${elapsed(t0)}] Generating data panels (target ${minTotal}-${maxTotal} total, up to ${perStoryMax}/story, ${eligibleStories.length} eligible)...`);

      let totalPanels = 0;
      const usedPanels = [];  // track across segments to prevent duplicates
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (seg.type !== 'story') continue;
        // In manifest mode, skip segments not marked eligible
        if (dpEligibleSet && !dpEligibleSet.has(i)) {
          seg.data_panels = [];
          continue;
        }
        if (totalPanels >= maxTotal) { seg.data_panels = []; continue; }
        const remaining = maxTotal - totalPanels;
        const cap = Math.min(perStoryMax, remaining);
        const threadCtx = threadData.find(t => String(t.id) === String(seg.thread_id));
        try {
          const panels = await dataPanels.generatePanelsForSegment(seg, threadCtx, { min: perStoryMin, max: cap, usedPanels });
          seg.data_panels = panels;
          totalPanels += panels.length;
          panels.forEach(p => usedPanels.push({ adapter: p.adapter, title: p.title, indicator: p.query?.indicator }));
          console.log(`   [${elapsed(t0)}] seg ${i} "${(seg.thread_title||'').slice(0,40)}" → ${panels.length} panel(s)${panels.length ? ' ('+panels.map(p=>p.adapter||p.generated_by).join(',')+')' : ''}`);
        } catch (e) {
          console.warn(`   ⚠ panel gen failed for seg ${i}: ${e.message}`);
          seg.data_panels = [];
        }
      }

      console.log(`   [${elapsed(t0)}] Total data panels: ${totalPanels}`);
    }

    // ── 6b. Pick mode: interactive script review (panels visible inline) ──
    if (PICK_MODE && !MANIFEST_MODE) {
      segments = await reviewAndEditSegments(segments, threadData);
      // Then a dedicated panel review pass for edits/replacements
      if (!NO_PANELS) {
        segments = await reviewAndEditPanels(segments, threadData);
      }
    }

    // ── 7. Generate ElevenLabs audio — per-segment for accurate seek offsets
    let audioData = null;

    // Check whether today's episode already has audio so we don't re-bill ElevenLabs
    // on every --force run. Use --force-audio to explicitly re-synthesise.
    // PICK_MODE always regenerates audio — its chosen stories differ from prior runs,
    // so stale audio would desync start_ms offsets and silence the player.
    if (!NO_AUDIO && ELEVENLABS_KEY && !FORCE_AUDIO && !PICK_MODE && !MANIFEST_MODE) {
      const { rows: existingAudio } = await pool.query(
        `SELECT octet_length(audio_data) AS bytes FROM briefing_episodes WHERE id = $1 AND audio_data IS NOT NULL`,
        [episodeId]
      );
      if (existingAudio.length && existingAudio[0].bytes > 0) {
        const { rows: audioRow } = await pool.query(
          `SELECT audio_data FROM briefing_episodes WHERE id = $1`, [episodeId]
        );
        audioData = audioRow[0]?.audio_data;
        console.log(`   [${elapsed(t0)}] Reusing existing audio (${(audioData.length / 1024).toFixed(0)}KB) — use --force-audio to re-synthesise`);
      }
    }

    if (!NO_AUDIO && ELEVENLABS_KEY && !audioData) {
      console.log(`   [${elapsed(t0)}] Synthesising ${segments.length} audio pieces with ElevenLabs...`);

      // Audio synthesis is now TWO pieces per segment: voiceover and
      // transition. Previously they were concatenated into one TTS input,
      // which meant the transition's audio was locked to that segment's
      // mp3 forever — a segment reorder left transitions pointing at the
      // wrong adjacent story.
      //
      // Keeping them separate lets a future /rewrite-transitions endpoint
      // re-synthesize just the transition slices when segments reorder,
      // without touching any voiceover audio. The concatenated output
      // remains one mp3 (voice_0 + trans_0 + voice_1 + trans_1 + ...) so
      // the player pipeline is unchanged — only the segment metadata gains
      // new breakdown fields.
      const audioBuffers    = [];
      const pieceDurationsMs = [];
      const pieceWordTimings = [];
      // Per-segment breakdown: [{ voiceover_ms, transition_ms, voiceover_words, transition_words }]
      const segmentBreakdowns = [];

      let pieceNum = 0;
      for (let si = 0; si < segments.length; si++) {
        const seg = segments[si];
        const voiceoverText = (seg.voiceover_text || '').trim();
        const transitionText = (seg.transition || '').trim();
        const breakdown = { voiceover_ms: 0, transition_ms: 0, voiceover_words: [], transition_words: [] };

        // Featured-media split: TTS the before/after halves separately
        // and concat the MP3 buffers, stamping _focalSplitMs so the
        // player can fire the focal trigger at the exact sentence
        // boundary (vs an approximate triggerPct of segment duration).
        const fm = seg.featured_video || seg.video?.focal || seg.video_focal;
        const hasSplit = fm?.enabled
          && (seg.voiceover_before_video || '').trim()
          && (seg.voiceover_after_video  || '').trim();

        if (hasSplit) {
          pieceNum++;
          try {
            const beforePiece = await synthesiseAudio(seg.voiceover_before_video.trim());
            const afterPiece  = await synthesiseAudio(seg.voiceover_after_video.trim());
            const buffer      = Buffer.concat([beforePiece.buffer, afterPiece.buffer]);
            const durationMs  = beforePiece.durationMs + afterPiece.durationMs;
            const wordTimings = [
              ...(beforePiece.wordTimings || []),
              ...(afterPiece.wordTimings  || []).map(w => ({ ...w, t: (w.t || 0) + beforePiece.durationMs })),
            ];
            audioBuffers.push(buffer);
            pieceDurationsMs.push(durationMs);
            pieceWordTimings.push(wordTimings);
            breakdown.voiceover_ms = durationMs;
            breakdown.voiceover_words = wordTimings;
            seg._focalSplitMs = beforePiece.durationMs;
            console.log(`   [${elapsed(t0)}] Piece ${pieceNum} (seg ${si} voice split @ ${(beforePiece.durationMs/1000).toFixed(1)}s) — ${(buffer.byteLength/1024).toFixed(0)}KB · ${(durationMs/1000).toFixed(1)}s`);
          } catch (err) {
            console.warn(`   ⚠ Voiceover audio (split) for seg ${si} failed: ${err.message}`);
            audioBuffers.push(Buffer.alloc(0));
            pieceDurationsMs.push(0);
            pieceWordTimings.push([]);
          }
        } else if (voiceoverText) {
          pieceNum++;
          try {
            const { buffer, wordTimings, durationMs } = await synthesiseAudio(voiceoverText);
            audioBuffers.push(buffer);
            pieceDurationsMs.push(durationMs);
            pieceWordTimings.push(wordTimings || []);
            breakdown.voiceover_ms = durationMs;
            breakdown.voiceover_words = wordTimings || [];
            console.log(`   [${elapsed(t0)}] Piece ${pieceNum} (seg ${si} voice) — ${(buffer.byteLength / 1024).toFixed(0)}KB · ${(durationMs/1000).toFixed(1)}s`);
          } catch (err) {
            console.warn(`   ⚠ Voiceover audio for seg ${si} failed: ${err.message}`);
            audioBuffers.push(Buffer.alloc(0));
            pieceDurationsMs.push(0);
            pieceWordTimings.push([]);
          }
        } else {
          audioBuffers.push(Buffer.alloc(0));
          pieceDurationsMs.push(0);
          pieceWordTimings.push([]);
        }

        if (transitionText) {
          pieceNum++;
          try {
            const { buffer, wordTimings, durationMs } = await synthesiseAudio(transitionText);
            audioBuffers.push(buffer);
            pieceDurationsMs.push(durationMs);
            pieceWordTimings.push(wordTimings || []);
            breakdown.transition_ms = durationMs;
            breakdown.transition_words = wordTimings || [];
            console.log(`   [${elapsed(t0)}] Piece ${pieceNum} (seg ${si} trans) — ${(buffer.byteLength / 1024).toFixed(0)}KB · ${(durationMs/1000).toFixed(1)}s`);
          } catch (err) {
            console.warn(`   ⚠ Transition audio for seg ${si} failed: ${err.message}`);
            audioBuffers.push(Buffer.alloc(0));
            pieceDurationsMs.push(0);
            pieceWordTimings.push([]);
          }
        } else {
          // Still push a zero-byte placeholder so piece index math stays paired.
          audioBuffers.push(Buffer.alloc(0));
          pieceDurationsMs.push(0);
          pieceWordTimings.push([]);
        }

        segmentBreakdowns.push(breakdown);
      }

      // Stamp each segment with its audio start offset + per-word timings
      // spanning BOTH voice and transition, for captions. Also expose the
      // voice/transition split so the player (and a future
      // rewrite-transitions endpoint) can slice independently.
      let cumMs = 0;
      for (let si = 0; si < segments.length; si++) {
        const voiceIdx = si * 2;
        const transIdx = si * 2 + 1;
        const vms = pieceDurationsMs[voiceIdx] || 0;
        const tms = pieceDurationsMs[transIdx] || 0;
        const vwords = pieceWordTimings[voiceIdx] || [];
        const twords = (pieceWordTimings[transIdx] || []).map(w => ({ ...w, start: w.start + vms, end: w.end + vms }));
        segments[si].start_ms           = cumMs;
        segments[si].duration_ms        = vms + tms;
        segments[si].voiceover_start_ms = cumMs;
        segments[si].voiceover_ms       = vms;
        segments[si].transition_start_ms= cumMs + vms;
        segments[si].transition_ms      = tms;
        segments[si].word_timings       = [...vwords, ...twords];
        // Featured-media segments: convert the within-piece split offset
        // into an absolute trigger time so the player fires focal at the
        // exact sentence boundary, no triggerPct guessing.
        if (segments[si]._focalSplitMs != null) {
          segments[si].focal_trigger_ms = cumMs + segments[si]._focalSplitMs;
          delete segments[si]._focalSplitMs;
        }
        cumMs += vms + tms;
      }

      // Concatenate every piece into one MP3 (order: v0, t0, v1, t1, …)
      const concatted = Buffer.concat(audioBuffers.filter(b => b.byteLength > 0));
      if (concatted.byteLength === 0) {
        console.warn(`   ⚠ All audio pieces failed — storing episode without audio (check ELEVENLABS_VOICE_ID and API key)`);
        audioData = null;
      } else {
        audioData = concatted;
        console.log(`   [${elapsed(t0)}] Audio ready — ${(audioData.length / 1024).toFixed(0)}KB total, ${(cumMs / 1000).toFixed(1)}s estimated (voice+transition split)`);
      }
    } else if (!NO_AUDIO && !ELEVENLABS_KEY) {
      console.warn(`   ⚠ ELEVENLABS_API_KEY not set — skipping audio`);
    }
    // Note: if audioData is still null here (audio reused from DB), segments won't have
    // start_ms stamped — the player will fall back to word-count estimates, which is fine.

    // ── 7. Save complete episode ───────────────────────────────────────────
    await pool.query(`
      UPDATE briefing_episodes
      SET headline         = $1,
          voiceover_script = $2,
          segments         = $3,
          audio_data       = $4,
          status           = 'ready',
          generated_at     = NOW()
      WHERE id = $5
    `, [
      narrative.headline,
      buildFullScript(narrative),
      JSON.stringify(segments),   // segments now include start_ms per entry
      audioData,
      episodeId
    ]);

    // ── 8. Persist story continuity links ─────────────────────────────────
    await saveSegmentLinks(episodeId, segments, storyContexts).catch(e =>
      console.warn(`   ⚠ storyTracker saveSegmentLinks failed (non-fatal): ${e.message}`)
    );

    // ── 8b. Persist data panels for each segment ───────────────────────────
    if (!NO_PANELS) {
      await pool.query(`SELECT delete_panels_for_episode($1)`, [episodeId]).catch(() => {});
      for (let i = 0; i < segments.length; i++) {
        const seg = segments[i];
        if (!seg.data_panels?.length) continue;
        await dataPanels.savePanels(pool, seg.data_panels, {
          type: 'briefing_segment', id: episodeId, segmentIndex: i,
        }).catch(e => console.warn(`   ⚠ savePanels seg ${i}: ${e.message}`));
      }
    }

    // ── 9. Save curation choice for preference learning ───────────────────
    if (PICK_MODE || MANIFEST_MODE) {
      await saveCurationChoice(threads, episodeId).catch(e =>
        console.warn(`   ⚠ saveCurationChoice failed (non-fatal): ${e.message}`)
      );
      console.log(`   [${elapsed(t0)}] Curation choice saved (${threads.length} threads)`);
    }

    console.log();
    console.log(`✅ Briefing complete in ${elapsed(t0)}`);
    console.log(`   Episode id:  ${episodeId}`);
    console.log(`   Headline:    ${narrative.headline}`);
    console.log(`   Threads:     ${threads.length}`);
    console.log(`   Segments:    ${segments.length}`);
    console.log(`   Audio:       ${audioData ? (audioData.length / 1024).toFixed(0) + 'KB' : 'none'}`);
    console.log();
    console.log('   Segment breakdown:');
    segments.forEach((seg, i) => {
      if (seg.type === 'intro') {
        console.log(`     [${i}] intro      — ${(seg.voiceover_text || '').split(/\s+/).length} words`);
      } else if (seg.type === 'outro') {
        console.log(`     [${i}] outro      — ${(seg.voiceover_text || '').split(/\s+/).length} words`);
      } else {
        const arcsStr  = seg.flow_arcs?.length  ? ` arcs:${seg.flow_arcs.length}` : '';
        const vidStr   = seg.video_id           ? ' 🎬' : '';
        const words    = (seg.voiceover_text || '').split(/\s+/).length;
        const primary  = seg.primary_city?.name || seg.primary_city || seg.primary_country?.name || seg.primary_country || '—';
        console.log(`     [${i}] story      — "${seg.thread_title}" | focus:${primary}${arcsStr}${vidStr} | ${words}w`);
      }
    });

  } catch (err) {
    await pool.query(
      `UPDATE briefing_episodes SET status = 'failed' WHERE id = $1`,
      [episodeId]
    );
    throw err;
  } finally {
    await pool.end();
  }
}

// ─── Thread Selection ──────────────────────────────────────────────────────
// Per-region cap — hotspot regions get a tighter limit (1) since a single
// conflict can dominate many threads. Other regions stay at MAX_PER_REGION.
const HOTSPOT_REGIONS  = new Set(['mideast', 'russia_cis']);
const MAX_PER_HOTSPOT  = 1;   // max threads from mideast / russia_cis

function getRegionGroup(thread) {
  // Check title + keywords FIRST so a story like "Trump-Iran negotiations"
  // is tagged mideast (subject) rather than north_america (source country).
  const _gs = Array.isArray(thread.geographic_scope) ? thread.geographic_scope
            : thread.geographic_scope ? [thread.geographic_scope] : [];
  const titleAndScope = [thread.title || '', ..._gs].join(' ').toLowerCase();
  const withCategory = titleAndScope + ' ' + (thread.primary_category || '').toLowerCase();

  // Subject-first ordering: check high-specificity regions before broad ones
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

async function selectThreads(profile = null) {
  // Step 1: Pull candidate threads with video presence flagged.
  // Ongoing stories remain eligible as long as they are still active and have
  // fresh developments in the recent activity window.
  const { rows: candidates } = await pool.query(`
    SELECT
      st.id, st.title, st.description, st.importance,
      st.primary_category, st.geographic_scope, st.keywords,
      st.article_count,
      COUNT(sta.article_id)                                           AS recent_articles,
      COUNT(CASE WHEN a.video_id IS NOT NULL THEN 1 END)             AS video_count
    FROM story_threads st
    JOIN story_thread_articles sta ON sta.thread_id = st.id
    JOIN news_articles a           ON a.id = sta.article_id
    WHERE st.status = 'active'
      AND st.last_updated_at  > NOW() - INTERVAL '${THREAD_ACTIVITY_LOOKBACK_DAYS} days'
      AND a.published_at      > NOW() - INTERVAL '${THREAD_ACTIVITY_LOOKBACK_DAYS} days'
    GROUP BY st.id
    HAVING COUNT(sta.article_id) >= ${MIN_RECENT_ARTICLES_AUTO}
    ORDER BY st.importance DESC, COUNT(sta.article_id) DESC
    LIMIT 80
  `);

  if (!candidates.length) return [];

  // Step 2: Get per-thread language distribution via article_keywords.source_language
  // Count distinct articles (not keyword rows) to avoid inflating high-keyword articles
  const threadIds = candidates.map(t => t.id);
  const { rows: langRows } = await pool.query(`
    SELECT
      sta.thread_id,
      COUNT(DISTINCT CASE WHEN COALESCE(ak.source_language, 'en') = 'en' THEN ak.article_id END) AS english_articles,
      COUNT(DISTINCT ak.article_id)                                                               AS total_articles
    FROM story_thread_articles sta
    JOIN article_keywords ak ON ak.article_id = sta.article_id
    WHERE sta.thread_id = ANY($1)
    GROUP BY sta.thread_id
  `, [threadIds]);
  const diversityStats = await getThreadDiversityStats(threadIds, THREAD_ENRICH_LOOKBACK_DAYS);

  const langMap = {};
  for (const row of langRows) {
    const total = Number(row.total_articles);
    langMap[row.thread_id] = total > 0
      ? Number(row.english_articles) / total
      : 1.0;
  }

  // Step 3: Compute diversity-adjusted score
  // English-dominant threads (>70% English sources) get no boost.
  // Mixed/non-English threads get up to a 50% score lift so they can compete
  // without being completely buried — but raw importance still leads.
  const PREFERENCE_WEIGHT = 0.35; // max 35% boost from preference profile
  const scored = candidates.map(t => {
    const englishRatio   = langMap[t.id] ?? 1.0;
    const nonEngRatio    = 1 - englishRatio;
    const diversityBoost = nonEngRatio > 0.3 ? nonEngRatio * 0.5 : 0;
    const stats = diversityStats.get(Number(t.id));
    const sourceCount = Number(stats?.source_count) || 1;
    const countryCount = Number(stats?.country_count) || 1;
    const languageCount = Number(stats?.language_count) || 1;
    const representationBoost =
      Math.min(0.24, Math.max(0, sourceCount - 1) * 0.06) +
      Math.min(0.18, Math.max(0, countryCount - 1) * 0.06) +
      Math.min(0.14, Math.max(0, languageCount - 1) * 0.07);

    // Preference profile boost — rewards categories/regions/keywords chosen in past sessions
    let prefBoost = 0;
    if (profile) {
      const cat    = t.primary_category || 'general';
      const region = getRegionGroup(t);
      const kwList = Array.isArray(t.keywords) ? t.keywords : [];
      const catAff    = profile.categories[cat]    || 0;
      const regionAff = profile.regions[region]    || 0;
      const kwAff     = kwList.reduce((sum, kw) => sum + (profile.keywords[kw] || 0), 0) / Math.max(kwList.length, 1);
      prefBoost = Math.min(PREFERENCE_WEIGHT, (catAff * 0.4 + regionAff * 0.3 + kwAff * 0.3));
    }

    // Category tier: conflict/politics/military get a boost; environment/economy/climate get a penalty
    const _cat = (t.primary_category || '').toLowerCase();
    const catTierBoost = (_cat === 'conflict' || _cat === 'politics' || _cat === 'military') ? 0.15
                       : (_cat === 'environment' || _cat === 'climate' || _cat === 'economy') ? -0.10
                       : 0;

    return {
      ...t,
      englishRatio,
      sourceCount,
      countryCount,
      languageCount,
      diversityScore: Number(t.importance) * (1 + diversityBoost + representationBoost + prefBoost + catTierBoost),
      hasVideo:       Number(t.video_count) > 0,
    };
  });

  scored.sort((a, b) => b.diversityScore - a.diversityScore);

  // Step 4: Select with caps — category + region diversity + English-dominance cap
  const selected        = [];
  const skipped         = [];
  const categoryCounts  = {};
  const regionCounts    = {};
  let englishDomCount   = 0;

  for (const thread of scored) {
    if (selected.length >= MAX_THREADS) break;
    const cat           = thread.primary_category || 'general';
    const region        = getRegionGroup(thread);
    const isEngDominant = thread.englishRatio > 0.7;
    // Hotspot regions (mideast, russia_cis) are capped at 1 thread each to prevent
    // a single conflict dominating the briefing. Other regions allow MAX_PER_REGION.
    const regionCap = HOTSPOT_REGIONS.has(region) ? MAX_PER_HOTSPOT : MAX_PER_REGION;

    if ((categoryCounts[cat] || 0) >= MAX_CATEGORY_REPEAT)                           { skipped.push(thread); continue; }
    if (region !== 'global' && (regionCounts[region] || 0) >= regionCap)             { skipped.push(thread); continue; }
    if (region === 'global'  && (regionCounts['global'] || 0) >= MAX_GLOBAL_BUCKET)  { skipped.push(thread); continue; }
    if (isEngDominant && englishDomCount >= MAX_ENGLISH_DOMINANT)                    { skipped.push(thread); continue; }

    selected.push(thread);
    categoryCounts[cat]    = (categoryCounts[cat]    || 0) + 1;
    regionCounts[region]   = (regionCounts[region]   || 0) + 1;
    if (isEngDominant) englishDomCount++;
  }

  // If still short, fill from skipped — prefer threads from least-represented regions first
  // to maintain diversity even in fill mode. Only fall back to over-represented regions last.
  if (selected.length < MAX_THREADS) {
    const selectedIds = new Set(selected.map(t => t.id));
    const fillPool = skipped.filter(t => !selectedIds.has(t.id));
    // Sort fill pool: threads from regions with fewer selected slots come first
    fillPool.sort((a, b) => {
      const ra = getRegionGroup(a), rb = getRegionGroup(b);
      return (regionCounts[ra] || 0) - (regionCounts[rb] || 0);
    });
    for (const t of fillPool) {
      if (selected.length >= MAX_THREADS) break;
      selected.push(t);
      const region = getRegionGroup(t);
      regionCounts[region] = (regionCounts[region] || 0) + 1;
    }
  }

  // Step 5: Enforce minimum video threads
  // If fewer than MIN_VIDEO_THREADS have video, swap in the best available
  // video threads from the scored pool that weren't selected yet.
  const videoCount = selected.filter(t => t.hasVideo).length;
  if (videoCount < MIN_VIDEO_THREADS) {
    const needed      = MIN_VIDEO_THREADS - videoCount;
    const selectedIds = new Set(selected.map(t => t.id));
    const videoPool   = scored.filter(t => t.hasVideo && !selectedIds.has(t.id));

    for (let i = 0; i < Math.min(needed, videoPool.length); i++) {
      // Replace the lowest-scored non-video thread
      let replaceIdx = -1;
      for (let j = selected.length - 1; j >= 0; j--) {
        if (!selected[j].hasVideo) { replaceIdx = j; break; }
      }
      if (replaceIdx === -1) break; // all already have video
      selected[replaceIdx] = videoPool[i];
    }
  }

  return selected.slice(0, MAX_THREADS);
}

// ─── YouTube Playability Check ─────────────────────────────────────────────
async function isVideoPlayable(videoId) {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`,
      { signal: AbortSignal.timeout(4000) }
    );
    return res.ok;
  } catch (_) {
    return false;
  }
}

// Pick best playable video: prefer same-country source, fall back to any available
async function pickPlayableVideo(articles, primaryCountryId) {
  const withVideo = articles.filter(a => a.video_id);
  if (!withVideo.length) return null;

  // Sort: same-country videos first, then by relevance (original article order)
  const sorted = [
    ...withVideo.filter(a => primaryCountryId && String(a.country_id) === String(primaryCountryId)),
    ...withVideo.filter(a => !primaryCountryId || String(a.country_id) !== String(primaryCountryId)),
  ];

  for (const a of sorted) {
    if (await isVideoPlayable(a.video_id)) return a;
  }
  return null;
}

// ─── Thread Enrichment ─────────────────────────────────────────────────────
async function enrichThread(thread) {
  // Pull top recent articles for this thread from a slightly wider window than
  // selection so continuing stories keep current context without dragging in
  // stale history.
  const { rows: articlePool } = await pool.query(`
    WITH article_lang AS (
      SELECT ak.article_id, MIN(ak.source_language) AS source_language
      FROM article_keywords ak
      WHERE ak.article_id IN (
        SELECT sta2.article_id FROM story_thread_articles sta2 WHERE sta2.thread_id = $1
      )
      GROUP BY ak.article_id
    )
    SELECT
      a.id, a.title, a.translated_title, a.summary, a.translated_summary,
      a.published_at, a.video_id, a.media_type, a.article_url, a.content,
      a.language, a.source_id, a.youtube_source_id,
      COALESCE(ns.name, ys.name) AS source_name,
      co.name AS country_name, co.latitude AS lat, co.longitude AS lon,
      ci.name AS city_name, ci.latitude AS city_lat, ci.longitude AS city_lon,
      ci.id AS city_id, co.id AS country_id,
      COALESCE(a.source_id::text, 'yt:' || a.youtube_source_id::text, 'unknown') AS source_key,
      COALESCE(NULLIF(a.language, ''), al.source_language, 'en') AS article_language,
      sta.relevance_score
    FROM story_thread_articles sta
    JOIN news_articles a       ON a.id  = sta.article_id
    LEFT JOIN article_lang al  ON al.article_id = a.id
    LEFT JOIN news_sources ns  ON ns.id = a.source_id
    LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
    LEFT JOIN countries co     ON co.id = a.country_id
    LEFT JOIN cities ci        ON ci.id = a.city_id
    WHERE sta.thread_id = $1
      AND a.published_at > NOW() - INTERVAL '${THREAD_ENRICH_LOOKBACK_DAYS} days'
    ORDER BY sta.relevance_score DESC, a.published_at DESC
    LIMIT $2
  `, [thread.id, ARTICLE_POOL_LIMIT]);
  const articles = selectDiverseThreadArticles(articlePool, MAX_ARTICLES_THREAD);

  // Primary geographic focus — prefer city, fall back to country
  const geoArticle = articles.find(a => a.city_lat || a.lat);
  const globeFocus = geoArticle
    ? { lat: parseFloat(geoArticle.city_lat || geoArticle.lat), lng: parseFloat(geoArticle.city_lon || geoArticle.lon) }
    : null;

  // Determine primary country for geo-relevance filtering
  const countryFreq = {};
  for (const a of articles) {
    if (a.country_id) countryFreq[a.country_id] = (countryFreq[a.country_id] || 0) + 1;
  }
  const primaryCountryId = Object.keys(countryFreq).sort((a, b) => countryFreq[b] - countryFreq[a])[0] || null;

  // Pick best video: prefer geo-relevant (matches primary country), then any playable video
  const videoArticle = await pickPlayableVideo(articles, primaryCountryId);
  // Translate any article titles that haven't been translated yet
  await translateMissingTitles(articles);

  // Store primary city / country for globe node selection in briefing player
  const primaryCityArticle    = geoArticle?.city_name ? geoArticle : null;
  const primaryCountryArticle = geoArticle?.country_name ? geoArticle : null;

  return {
    ...thread,
    articles,
    videoId:        videoArticle?.video_id || null,
    globeFocus,
    primaryCity:    primaryCityArticle ? {
      name: primaryCityArticle.city_name,
      lat:  parseFloat(primaryCityArticle.city_lat),
      lon:  parseFloat(primaryCityArticle.city_lon),
    } : null,
    primaryCountry: primaryCountryArticle ? {
      name: primaryCountryArticle.country_name,
      lat:  parseFloat(primaryCountryArticle.lat),
      lon:  parseFloat(primaryCountryArticle.lon),
    } : null,
    articleIds: articles.map(a => a.id),
  };
}

// ─── Batch Title Translation ────────────────────────────────────────────────
async function translateMissingTitles(articles) {
  const needsTranslation = articles.filter(a => !a.translated_title && a.title);
  if (!needsTranslation.length) return;
  try {
    const prompt = `Translate these news article titles to English. Return ONLY a valid JSON object where each key is the article ID (as a string) and the value is the English translation. No extra text.\n\n${needsTranslation.map(a => `ID ${a.id}: "${a.title}"`).join('\n')}`;
    const response = await client.messages.create({
      model: 'claude-haiku-4-5', max_tokens: 1200,
      messages: [{ role: 'user', content: prompt }],
    });
    const match = response.content[0].text.match(/\{[\s\S]*\}/);
    if (!match) return;
    const map = JSON.parse(match[0]);
    for (const a of articles) {
      if (!a.translated_title && map[String(a.id)]) {
        a.translated_title = map[String(a.id)];
        // Persist so we don't re-translate next time
        await pool.query(`UPDATE news_articles SET translated_title = $1 WHERE id = $2 AND translated_title IS NULL`, [a.translated_title, a.id]).catch(() => {});
      }
    }
  } catch (_) { /* translation is best-effort, don't fail generation */ }
}

// ─── Article Deep Scraper & Enricher ──────────────────────────────────────
// Scrapes full text for ≥2/3 of each thread's text articles, then asks
// Claude Haiku to extract deeper keywords, entities, relationships, and
// geopolitical background. Result is attached as thread.deepContext and
// passed to Claude Sonnet so it writes more informed voiceovers.

const _SCRAPE_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Cache-Control':   'no-cache',
  'Sec-Fetch-Dest':  'document',
  'Sec-Fetch-Mode':  'navigate',
  'Sec-Fetch-Site':  'none',
};

function _htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function _fetchArticleText(url, timeoutMs = 10000) {
  if (!url) return null;
  try {
    const ctrl  = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const resp  = await fetch(url, { headers: _SCRAPE_HEADERS, signal: ctrl.signal, redirect: 'follow' });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const ct = resp.headers.get('content-type') || '';
    if (!ct.includes('html') && !ct.includes('text')) return null;
    const html = await resp.text();
    const text = _htmlToText(html);
    return text.length > 150 ? text.slice(0, 6000) : null;
  } catch (_) { return null; }
}

// loadDeepContextFromCache
//
// Replaces the old _deepEnrichThread + deepEnrichAllThreads pair. Those
// functions re-scraped article URLs + called Claude Haiku once per
// thread at briefing time, producing a transient thread.deepContext
// that got fed to the voiceover Sonnet prompt and then discarded. Same
// articles were already being scraped + Claude'd by the thread
// builder's post-threading deep-analysis pass (deepAnalyzer.js) whose
// output nobody read. Two pipelines, overlapping work, ~$0.60/day of
// duplicated Haiku calls.
//
// Post-consolidation: articleDeepEnrichment.js is the single scrape +
// Claude writer. It persists per-article enrichment to
// article_deep_context. Here we just batch-read those rows for every
// article in every selected thread, aggregate them into the same
// thread.deepContext shape the voiceover prompt expects
// ({ key_keywords, key_entities, relationships, background }), and
// attach. Zero scrapes, zero Claude calls at briefing time.
//
// Graceful degradation: articles without a cached deep_context row
// (e.g. not in top-N per thread, haven't been enriched yet) simply
// aren't in the loaded map. aggregateThreadContext returns null if no
// article in the thread has cached context — same semantics as the old
// "No scrape" branch, and the voiceover prompt already handles
// missing deep_context via the conditional `...(t.deepContext ? { ... } : {})`
// spread in the segment payload.
async function loadDeepContextFromCache(threadData) {
  // Gather all article IDs across every thread, dedupe, single DB round-trip
  const idsSet = new Set();
  for (const thread of threadData) {
    for (const id of (thread.articleIds || [])) idsSet.add(Number(id));
    for (const a of (thread.articles || [])) if (a?.id) idsSet.add(Number(a.id));
  }
  const allIds = [...idsSet];
  if (!allIds.length) return;

  const ctxMap = await loadContextForArticles(allIds);

  let hit = 0, miss = 0;
  for (const thread of threadData) {
    const threadIds = new Set([
      ...(thread.articleIds || []).map(Number),
      ...((thread.articles || []).map(a => Number(a?.id)).filter(Boolean)),
    ]);
    const ctxs = [...threadIds]
      .map(id => ctxMap.get(id))
      .filter(Boolean);

    const agg = aggregateThreadContext(ctxs);
    if (agg) {
      thread.deepContext = agg;
      hit++;
      console.log(`   ✓ Cached context [${thread.id}] "${thread.title.slice(0, 45)}" (${agg.scraped_count} articles)`);
    } else {
      miss++;
      console.log(`   – No cached ctx [${thread.id}] "${thread.title.slice(0, 45)}"`);
    }
  }
  console.log(`   cache: ${hit} thread(s) with context, ${miss} without`);
}

// ─── Entity Coordinate Resolution ─────────────────────────────────────────
// Look up DB coordinates for every story entity Claude identified.
// Tries countries first, then cities for anything not matched.
async function resolveEntityCoords(segments) {
  const names = new Set();
  for (const seg of segments) {
    for (const e of (seg.entities || [])) {
      if (e.name) names.add(e.name);
    }
  }
  if (!names.size) return {};

  const nameArr  = [...names];
  const nameLower = nameArr.map(n => n.toLowerCase());
  const coords   = {};

  // Countries
  const { rows: cRows } = await pool.query(
    `SELECT name, latitude AS lat, longitude AS lon FROM countries
     WHERE LOWER(name) = ANY($1::text[])`,
    [nameLower]
  );
  for (const r of cRows) {
    const orig = nameArr.find(n => n.toLowerCase() === r.name.toLowerCase());
    if (orig) coords[orig] = { lat: parseFloat(r.lat), lon: parseFloat(r.lon), type: 'country' };
  }

  // Cities — only look up names not already matched as a country
  const remaining = nameArr.filter(n => !coords[n]);
  if (remaining.length) {
    const { rows: ciRows } = await pool.query(
      `SELECT name, latitude AS lat, longitude AS lon FROM cities
       WHERE LOWER(name) = ANY($1::text[])`,
      [remaining.map(n => n.toLowerCase())]
    );
    for (const r of ciRows) {
      const orig = remaining.find(n => n.toLowerCase() === r.name.toLowerCase());
      if (orig) coords[orig] = { lat: parseFloat(r.lat), lon: parseFloat(r.lon), type: 'city' };
    }
  }

  return coords;
}

// ─── Flow Arc Detection ────────────────────────────────────────────────────
// Simple great-circle distance (km) — Haversine
function geoDistKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2
          + Math.cos(lat1 * Math.PI/180) * Math.cos(lat2 * Math.PI/180) * Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
// If a city and its containing country both appear as entities, the city is
// redundant — drop it so we never draw both Tehran→USA and Iran→USA arcs.
// "Containing" = country centroid is within 900 km of the city.
const CITY_COUNTRY_MERGE_KM = 900;

function buildFlowArcs(threadData, narrative, entityCoords) {
  const arcs = [];

  for (let ni = 0; ni < narrative.segments.length; ni++) {
    const ns     = narrative.segments[ni];
    const thread = threadData.find(t => t.id === ns.thread_id) || threadData[ni];
    if (!thread) continue;

    // ── PRIMARY PATH: use Claude's story entities ──────────────────────────
    // These are the countries/cities the story is ABOUT, not source locations.
    const resolved = (ns.entities || [])
      .map(e => ({ name: e.name, type: e.type, ...entityCoords[e.name] }))
      .filter(e => e.lat != null && e.lon != null);

    if (resolved.length >= 2) {
      // Drop any city entity whose containing country is also in the list.
      // Prevents Tehran→USA + Iran→USA double-arcs when both appear as entities.
      const dedupedResolved = resolved.filter(entity => {
        if (entity.type !== 'city') return true;
        return !resolved.some(other =>
          other !== entity &&
          other.type === 'country' &&
          geoDistKm(entity.lat, entity.lon, other.lat, other.lon) < CITY_COUNTRY_MERGE_KM
        );
      });
      // Only fall back to un-deduped list if dedup removed EVERYTHING (all-city edge case).
      // When dedup correctly leaves 1 entity (city removed because its country is present),
      // use that single entity — the loop below won't run, producing no arc (correct).
      const effectiveResolved = dedupedResolved.length > 0 ? dedupedResolved : resolved;

      // Connect all consecutive entity pairs
      for (let i = 0; i < effectiveResolved.length - 1; i++) {
        const from = effectiveResolved[i];
        const to   = effectiveResolved[i + 1];
        arcs.push({
          thread_id: thread.id,
          from_name: from.name, from_lat: from.lat, from_lng: from.lon,
          to_name:   to.name,   to_lat:   to.lat,   to_lng:   to.lon,
          is_city_arc: from.type === 'city' || to.type === 'city',
        });
      }
      continue;
    }

    // Single entity + primary city → arc from entity to city
    // Only draw if the city is NOT within the same country as the entity —
    // avoids Country → own capital/city arcs (e.g. Germany → Berlin).
    if (resolved.length === 1 && thread.primaryCity) {
      const from = resolved[0];
      const city = thread.primaryCity;
      const isSameCountry = from.type === 'country' &&
        geoDistKm(from.lat, from.lon, city.lat, city.lon) < CITY_COUNTRY_MERGE_KM;
      if (!isSameCountry && (Math.abs(from.lat - city.lat) > 0.4 || Math.abs(from.lon - city.lon) > 0.4)) {
        arcs.push({
          thread_id: thread.id,
          from_name: from.name, from_lat: from.lat, from_lng: from.lon,
          to_name:   city.name, to_lat:   city.lat, to_lng:   city.lon,
          is_city_arc: true,
        });
      }
      continue;
    }

    // No fallback — arcs are only drawn when the script explicitly mentions
    // the locations as relevant actors. Article source countries are not enough.
  }

  return arcs;
}

// ─── Claude Narrative ──────────────────────────────────────────────────────
async function generateNarrative(threadData, storyContexts = {}, preferenceProfile = null) {
  const nowMs = Date.now();
  const storySummaries = threadData.map((t, i) => {
    // Find newest article date so Claude knows how fresh the story is
    const dates = (t.articles || [])
      .map(a => a.published_at ? new Date(a.published_at).getTime() : 0)
      .filter(Boolean);
    const newestMs  = dates.length ? Math.max(...dates) : 0;
    const daysAgo   = newestMs ? Math.round((nowMs - newestMs) / 86400000) : null;
    // Also find the oldest article — wide spread means ongoing saga, not fresh break
    const oldestMs  = dates.length ? Math.min(...dates) : 0;
    const spanDays  = (newestMs && oldestMs) ? Math.round((newestMs - oldestMs) / 86400000) : 0;

    // Story continuity context — informs voiceover framing
    const ctx = storyContexts[String(t.id)];
    const continuity = ctx?.isOngoing
      ? { is_ongoing: true, briefing_day_number: ctx.dayNumber, previously_known_as: ctx.canonicalTitle }
      : { is_ongoing: false, briefing_day_number: 1 };

    return {
      index:                i + 1,
      thread_id:            t.id,
      title:                t.title,
      category:             t.primary_category,
      importance:           t.importance,
      newest_article_days_ago: daysAgo,
      article_span_days:    spanDays,
      ...continuity,
      articles: (t.articles || []).map(a => ({
        title:        a.translated_title || a.title,
        summary:      (a.translated_summary || a.summary || '').slice(0, 200),
        source:       a.source_name,
        country:      a.country_name,
        published_at: a.published_at ? a.published_at.toISOString?.() || String(a.published_at) : null,
      })),
      // Deep context from full article scraping — use to write more informed segments
      ...(t.deepContext ? {
        deep_context: {
          additional_keywords:  t.deepContext.key_keywords,
          key_people_and_orgs:  t.deepContext.key_entities,
          key_relationships:    t.deepContext.relationships,
          background_context:   t.deepContext.background,
        },
      } : {}),
      // Featured media — narrator hands off to this mid-segment.
      // The shape varies per media_type so the prompt can write the right
      // kind of transition (a video clip vs an embedded tweet vs a globe-
      // wide heatmap of a specific question).
      ...(t._featuredVideo ? {
        featured_video: {
          enabled:              true,
          duration_seconds:     t._featuredVideo.duration_sec || 15,
          // Default media_type is YouTube — it's what most threads have
          // ready (video_ids on constituent articles). Heatmap is opt-in
          // ONLY: the editor must explicitly set media_type === 'heatmap'
          // (typically alongside heatmap_question + heatmap_mode). This
          // matches the editor's UX: heatmap is a deliberate "this story
          // benefits from a country-by-country visualization" choice, not
          // a fallback for missing video.
          media_type:           t._featuredVideo.media_type || 'youtube',
          // Verbatim override the narrator must use for the last sentence
          // before the [VIDEO_HANDOFF] when filled.
          narrator_transition:      t._featuredVideo.narrator_transition || '',
          // Steering hint — guides Claude when narrator_transition is empty.
          // Editor surfaces this as a separate field so the user can shape
          // the auto-written transition without writing it themselves.
          narrator_transition_hint: t._featuredVideo.narrator_transition_hint || '',
          ...(t._featuredVideo.media_type === 'twitter_post' || t._featuredVideo.media_type === 'twitter_video'
            ? { twitter_url: t._featuredVideo.twitter_url || '' }
            : {}),
          ...(t._featuredVideo.media_type === 'heatmap'
            ? {
                heatmap_question: t._featuredVideo.heatmap_question || '',
                heatmap_mode:     t._featuredVideo.heatmap_mode || 'binary',
              }
            : {}),
        },
      } : {}),
      // Side tweet — embedded beside the article card; NOT a featured handoff.
      ...(t._sideTweetUrl ? { side_tweet_url: t._sideTweetUrl } : {}),
    };
  });

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  });

  const prompt = `You are a world-class broadcast news anchor writing a daily global briefing for Earth, a platform that presents world news through an interactive globe.

Today is ${today}. Write a complete, engaging, broadcast-quality daily briefing script for the following ${threadData.length} stories.

STORIES:
${JSON.stringify(storySummaries, null, 2)}

REQUIREMENTS:
- Intro: 2-3 natural, engaging sentences setting the global scene. 40-50 words. Open with a compelling present-tense hook (e.g. "Tensions are escalating...", "A seismic shift is underway..."). NEVER use time-of-day greetings (no "Good morning", "Good evening", "Good afternoon", "Welcome") — this briefing plays at all hours worldwide.
- Each story segment: 55-75 words. Factual, clear, global perspective. No jargon.
- Transitions: 1 sentence naturally bridging stories. Vary them — never reuse phrases.
- Outro: 1-2 warm closing sentences. 20-30 words.
- Total script should be 650-850 words for a ~5-6 minute briefing.
- Write conversationally — this will be spoken aloud by a professional voice.
- Connect stories when genuinely related (e.g. economic ripple effects, diplomatic links).
- This briefing draws from sources in multiple languages and countries. When relevant, surface non-Western or non-English perspectives — e.g. how Beijing, Moscow, Tehran, or Seoul view a story, not just Washington or London. Avoid defaulting to a single national lens.
- Many stories include a "deep_context" field extracted from full article text. Use "background_context" to add depth beyond the headline, "key_relationships" to frame cause-and-effect accurately, and "key_people_and_orgs" to name relevant actors precisely. This is your primary enrichment source — use it.

STORY CONTINUITY FRAMING (use when is_ongoing = true):
- Each story includes "is_ongoing" and "briefing_day_number" fields.
- If is_ongoing = true and briefing_day_number >= 2: open the segment with a continuity marker such as "Continuing our coverage — now day \${briefing_day_number}..." or "An update on a story we've been following..." or "Day \${briefing_day_number} of...". Vary the phrasing naturally.
- If is_ongoing = false (briefing_day_number = 1): introduce the story fresh with no continuity language.
- Never say "Day 1" — only use day markers for briefing_day_number >= 2.

RECENCY FRAMING (critical — frame stories correctly based on how old they are):
- Each story includes "newest_article_days_ago" — the age of its most recent article.
- If newest_article_days_ago <= 2: frame as breaking or developing news ("is unfolding", "has just", "is under way").
- If newest_article_days_ago is 3–7: frame as a current/active story ("continues to", "remains", "is escalating").
- If newest_article_days_ago > 7: frame as an ongoing situation or aftermath ("in the weeks since", "following last month's", "as the situation continues to unfold"). NEVER re-announce a weeks-old event as if it just happened. Example: if a leader died 5 weeks ago, do NOT open with "died today" or "has died" — instead say "in the weeks since [leader]'s death, the succession crisis continues to...".
- This is a journalism standard: you would never lead the 6 o'clock news with "JFK was assassinated today" in 1964.

SEGMENT ORDERING — GEOGRAPHIC INTERLEAVING (hard rule):
- Do NOT place two segments about the same country OR the same conflict back-to-back.
- Interleave segments so that consecutive segments are from different regions of the world.
- If you have three Iran-related threads, spread them out: e.g. positions 1, 5, 9 — not 1, 2, 3.
- Preferred order pattern: rotate through these broad regions — Middle East / Europe / Asia-Pacific / Americas / Africa / Europe / Middle East / Asia... etc.

STORY DIVERSITY (applied in tone and framing, NOT by skipping stories):
- Write EVERY story in the provided list — do not omit any thread from the segments array.
- If two stories feel similar, distinguish them clearly in tone, geography, or angle. You must still write both.

CRITICAL THREAD_ID RULE: Every segment's "thread_id" must be one of these exact integer values (copy them verbatim — do NOT modify, abbreviate, or invent new ones):
${storySummaries.map(s => s.thread_id).join(', ')}

Return ONLY valid JSON in this exact structure:
{
  "headline": "Today's briefing headline (max 12 words, present tense)",
  "intro": "Intro paragraph text",
  "segments": [
    {
      "thread_id": <must be one of the exact integers listed above>,
      "voiceover": "Story segment text",
      "transition": "Generic outbound transition (see TRANSITION RULES)",
      "entities": [
        { "name": "Russia", "type": "country" },
        { "name": "Kyiv", "type": "city" }
      ]
    }
  ],
  "outro": "Closing paragraph text"
}

TRANSITION RULES (critical for play-order robustness):
- Transitions must be ORDER-AGNOSTIC. Do NOT name the next country, topic, or segment. Segments get reordered in the editor and the transitions stay with their OWN segment, not the one that follows them.
- BAD: "Now we turn to Brazil." / "Next, the situation in Lebanon." / "Moving on to the Korean peninsula..."
- GOOD: "Onward." / "Let's shift focus." / "Moving on." / "And there's more tonight." / "Up next."
- Keep transitions short (3-8 words). They're the bridge between story N's audio and story N+1's audio; they should close N gracefully without predicting N+1.
- Omit transition entirely for the final story segment (transition to outro, handled separately).

ENTITY RULES (critical for globe arc visualisation):
- "entities" lists 2–4 geographic locations the story IS ABOUT (not where news sources are from).
- The FIRST entity must be the PRIMARY subject of the story (the main country or city the segment is about).
- For a Russia-Ukraine conflict story: entities = [Russia, Ukraine].
- For a Jeddah drone strike story: entities = [Saudi Arabia, Jeddah (city)].
- For a US-Iran diplomacy story: entities = [United States, Iran] — NOT Ukraine, NOT unrelated countries.
- For a US-China trade story: entities = [United States, China].
- For a domestic story (e.g. UK election): entities = [United Kingdom].
- Use standard English country names that match a world atlas (e.g. "Iran", "South Korea", "Democratic Republic of Congo").
- Cities must be major, well-known cities — avoid obscure towns.
- type is "country" or "city" only.
- CRITICAL: entities must match the story you are writing for that thread_id. Do NOT list entities from other stories.

FEATURED MEDIA HANDOFF (critical for timing):
- Some stories include a "featured_video" field. The "media_type" inside it tells you WHICH kind of media will appear at the handoff. The narrator's voiceover must be split into two halves around a [VIDEO_HANDOFF] marker so the player can fire the visual at the precise sentence boundary.
- The default media_type is "youtube" — a third-party video clip from a constituent article. Heatmap and Twitter media are OPT-IN: they appear only when the editor explicitly designates them. Treat each media_type by the rules below; do not assume any one is "first-class."

When "featured_video" is present, ALWAYS:
  1. Write the voiceover in TWO parts. Insert the marker [VIDEO_HANDOFF] at the split point.
  2. Transition copy precedence (use the first that applies):
     a. If "narrator_transition" is a non-empty string → use it VERBATIM as the last sentence of part 1.
     b. Else if "narrator_transition_hint" is non-empty → write the transition yourself but FOLLOW THE HINT (it's the editor's steering note, e.g. "lean into the visual surprise", "tease without giving the answer"). Reflect the hint's intent and tone — don't quote it.
     c. Else → write a natural transition tailored to the media_type per the rules below.
  3. Keep total voiceover word count at 55-75 words, split roughly 60/40 before/after.

Per media_type:

  • media_type = "youtube" — a third-party video clip (speech, press conference, street footage) plays with sound for ${'duration_seconds'} seconds.
    - Part 1 ends with a transition like "Here's a clip from the press conference..." or "Footage from the streets of Beirut shows the situation firsthand..."
    - Part 2 resumes with "Following those remarks..." or "As we saw in that footage..."
    - Do NOT describe what's in the video — the viewer will see/hear it themselves.

  • media_type = "twitter_post" or "twitter_video" — an embedded X post (or X video) appears on screen for ${'duration_seconds'} seconds. The narrator does NOT narrate over it (silent display).
    - Part 1 ends with a transition like "The Foreign Minister addressed it directly on X:" or "Reuters posted footage from the scene."
    - Part 2 resumes with "Following that post..." or "Reactions to the statement..."
    - Do NOT quote the tweet text in the script — the viewer reads it themselves.

  • media_type = "heatmap" — a per-country heatmap visualization paints over the globe for the rest of the segment, visualizing the question in "heatmap_question". The narrator KEEPS TALKING — this is NOT a silent handoff. The narrator should INTERPRET the heatmap data live for the viewer.
    - Part 1 ends with a transition that introduces the heatmap, like "Look at where this dependency is concentrated:" or "The countries highlighted across the map share one trait:"
    - Part 2 (the LARGER half here, ~60-70% of the words) discusses the heatmap pattern in detail: which countries are lit up, what the geographic clustering reveals, why this matters for the story. Reference the visualization directly ("As you can see across North Africa and the Gulf...", "The brightest spots are concentrated in...").
    - Use the heatmap_question + heatmap_mode as your guide for what to discuss. Example: question "countries with oil import dependency above 50%" mode "binary" → narrate which regions are most exposed.
    - Do NOT pretend to read specific numbers off the map — speak in qualitative regional terms.

- For stories WITHOUT "featured_video", write a normal continuous voiceover as usual.

SIDE TWEET (separate from featured_video):
- Some stories include a top-level "side_tweet_url". This is an embedded X post that displays beside the article card during the segment — it is NOT a featured handoff and DOES NOT require a [VIDEO_HANDOFF] marker.
- When present (and not also the featured tweet), weave a brief reference to the post into the voiceover so the viewer's eye is drawn to the sidebar. One sentence is plenty: "A post from the foreign ministry — visible on the side card — calls the move provocative." or "An eyewitness video circulating on X (shown alongside) captures the moment."
- Do NOT quote the tweet's full text — the viewer reads it themselves. Just signal that it's there and worth glancing at.
- A story can have BOTH a featured_video (any type) AND a side_tweet_url; treat them as independent.

CONTENT GUARDRAILS (must follow):
- Do NOT report the death, assassination, or removal from power of any sitting head of state or major world leader unless it is explicitly confirmed as verified fact in the provided articles. If articles only speculate or reference rumours, write about the speculation/rumour angle instead (e.g. "speculation is growing about...").
- Do NOT use time-of-day greetings ("Good morning", "Good evening") — viewers watch at any time.
- Do NOT write consecutive segments about the same country or conflict unless it is a distinctly different angle.${preferenceProfile && preferenceProfile._summary ? `

EDITORIAL PREFERENCES (soft guidance — reflect in tone and framing, do not skip any story):
The editor who curated today's stories has historically favoured coverage of: ${preferenceProfile._summary}. When writing segments, lean into depth, global impact, and multi-stakeholder framing for these topic areas where relevant. This is background context only — still write every story.` : ''}`;

  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 4096, // 10-story briefings can reach ~3500 tokens; 2000 causes truncation
    messages:   [{ role: 'user', content: prompt }]
  });

  const text      = response.content[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude returned no valid JSON for narrative');

  let rawJson = jsonMatch[0];
  let result;
  try {
    result = JSON.parse(rawJson);
  } catch (firstErr) {
    // Attempt repair: fix common LLM JSON issues
    // 1. Strip trailing commas before } or ]
    let repaired = rawJson.replace(/,\s*([}\]])/g, '$1');
    // 2. Fix unescaped control characters inside strings
    repaired = repaired.replace(/[\x00-\x1f]/g, m => {
      if (m === '\n') return '\\n';
      if (m === '\r') return '\\r';
      if (m === '\t') return '\\t';
      return '';
    });
    // 3. Replace smart/curly quotes with straight quotes (common LLM issue)
    repaired = repaired.replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '\\"');
    repaired = repaired.replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'");
    try {
      result = JSON.parse(repaired);
      console.warn('[narrative] JSON repaired successfully (fixed trailing commas / control chars)');
    } catch (secondErr) {
      // Log context around the failure point for debugging
      const pos = parseInt(String(firstErr.message).match(/position (\d+)/)?.[1] || '0');
      if (pos > 0) {
        const ctx = rawJson.slice(Math.max(0, pos - 80), pos + 80);
        console.error(`[narrative] JSON error near position ${pos}:\n…${ctx}…`);
      }
      throw new Error(`Claude returned malformed JSON for narrative: ${firstErr.message}`);
    }
  }
  // Cap segments to exactly the number of threads — Claude sometimes generates extras
  const validIds = new Set(threadData.map(t => t.id));
  result.segments = result.segments.filter(s => validIds.has(s.thread_id));
  if (result.segments.length > threadData.length) {
    result.segments = result.segments.slice(0, threadData.length);
  }
  // Post-process: interleave segments to break same-country/region clusters
  result.segments = interleaveSegments(result.segments, threadData);
  return result;
}

// ─── Segment Interleaver ───────────────────────────────────────────────────
// Reorders segments so no two consecutive ones share a country/region.
// Uses a greedy "most different from previous" pass.
function interleaveSegments(segments, threadData) {
  if (segments.length <= 2) return segments;

  // Build a region tag for each segment using thread entities or title keywords
  const REGION_PATTERNS = [
    { region: 'mideast',  re: /iran|iraq|israel|gaza|lebanon|syria|saudi|yemen|qatar|kuwait|hormuz|tehran|jerusalem/i },
    { region: 'europe',   re: /germany|france|ukraine|russia|uk|britain|nato|eu |poland|spain|italy|sweden|finland|norway|czech|balkan/i },
    { region: 'eastasia', re: /china|japan|korea|taiwan|hong.?kong|beijing|tokyo|seoul/i },
    { region: 'southasia',re: /india|pakistan|bangladesh|afghanistan|nepal|sri.?lanka/i },
    { region: 'americas', re: /united.?states|usa|canada|mexico|brazil|argentina|colombia|venezuela|latin/i },
    { region: 'africa',   re: /nigeria|ethiopia|kenya|south.?africa|egypt|algeria|niger|mali|sudan|congo|ghana/i },
    { region: 'seasia',   re: /indonesia|thailand|vietnam|philippines|malaysia|myanmar|singapore/i },
  ];

  function getRegion(seg) {
    const thread = threadData.find(t => String(t.id) === String(seg.thread_id));
    const text = [thread?.title || '', seg.voiceover || '', ...(seg.entities || []).map(e => e.name)].join(' ');
    for (const { region, re } of REGION_PATTERNS) {
      if (re.test(text)) return region;
    }
    return 'other';
  }

  // Also track country-level to prevent back-to-back same country
  function getCountry(seg) {
    const thread = threadData.find(t => String(t.id) === String(seg.thread_id));
    const text = [thread?.title || '', ...(seg.entities || []).map(e => e.name)].join(' ').toLowerCase();
    // Extract first recognised country word
    const countries = ['iran','ukraine','russia','germany','japan','indonesia','algeria','niger','brazil','india','china','israel','pakistan','usa','united states'];
    return countries.find(c => text.includes(c)) || 'unknown';
  }

  // Greedy interleave: always pick the segment most different from the last placed
  const tagged   = segments.map(s => ({ seg: s, region: getRegion(s), country: getCountry(s) }));
  const result   = [];
  const remaining = [...tagged];

  while (remaining.length) {
    const last = result[result.length - 1];
    let bestIdx = 0;
    if (last) {
      // Prefer: different country first, then different region
      let bestScore = -1;
      for (let i = 0; i < remaining.length; i++) {
        const cand = remaining[i];
        let score = 0;
        if (cand.country !== last.country) score += 2;
        if (cand.region  !== last.region)  score += 1;
        if (score > bestScore) { bestScore = score; bestIdx = i; }
      }
    }
    result.push(remaining.splice(bestIdx, 1)[0]);
  }

  return result.map(r => r.seg);
}

// ─── Segment Builder ───────────────────────────────────────────────────────
async function buildSegments(narrative, threadData, allArcs, entityCoords = {}) {
  const segments = [];
  const usedArticleIds = new Set();   // prevents same article appearing in two segments

  // Resolve country ISOs for every location attached to every segment. Done
  // once up-front so each segment can cheaply attach pre-computed iso_code /
  // country_iso fields that the runtime just reads — no more fuzzy lookups
  // against window.__globeCountries at playback time. Strategy:
  //   1. Load every row of the countries table (id, iso_code, name, lat, lon)
  //   2. Build a lowercase-name → iso lookup
  //   3. For any location without a name match, fall back to nearest centroid
  // Returns a function (name, lat, lon) → iso string or null.
  const _isoResolver = await (async () => {
    try {
      const { rows } = await pool.query(
        `SELECT iso_code, name, latitude, longitude
           FROM countries
          WHERE iso_code IS NOT NULL`
      );
      const byName = new Map();
      const centroids = [];
      for (const r of rows) {
        const iso = String(r.iso_code || '').toUpperCase();
        if (!iso) continue;
        if (r.name) byName.set(String(r.name).trim().toLowerCase(), iso);
        if (r.latitude != null && r.longitude != null) {
          centroids.push({ iso, lat: +r.latitude, lon: +r.longitude });
        }
      }
      // A handful of common aliases that don't appear as canonical names.
      const aliases = {
        'usa': 'US', 'u.s.': 'US', 'u.s.a.': 'US', 'united states': 'US', 'america': 'US',
        'uk': 'GB', 'britain': 'GB', 'u.k.': 'GB', 'great britain': 'GB', 'united kingdom': 'GB',
        'south korea': 'KR', 'north korea': 'KP', 'dprk': 'KP',
        'uae': 'AE', 'emirates': 'AE',
        'russia': 'RU', 'china': 'CN', 'iran': 'IR',
      };
      for (const [k, v] of Object.entries(aliases)) if (!byName.has(k)) byName.set(k, v);

      const nearest = (lat, lon) => {
        if (lat == null || lon == null) return null;
        let best = null, bestD = Infinity;
        for (const c of centroids) {
          const d = Math.abs(c.lat - lat) + Math.abs(c.lon - lon);
          if (d < bestD) { bestD = d; best = c; }
        }
        return best ? best.iso : null;
      };
      return (name, lat, lon) => {
        if (name) {
          const hit = byName.get(String(name).trim().toLowerCase());
          if (hit) return hit;
        }
        return nearest(lat, lon);
      };
    } catch (err) {
      console.warn(`   ⚠ ISO resolver init failed: ${err.message}`);
      return () => null;
    }
  })();

  // Intro segment
  const introSeg = { type: 'intro', voiceover_text: narrative.intro, globe_animate: { lat: 20, lng: 0, zoom: 0.9 } };
  console.log(`\n── SEGMENT 0 BUILD: INTRO ───────────────────────────────────`);
  console.log(`   globe_animate : ${JSON.stringify(introSeg.globe_animate)}`);
  console.log(`   voiceover     : ${(introSeg.voiceover_text||'').slice(0, 120)}…`);
  segments.push(introSeg);

  // Story segments
  for (let i = 0; i < narrative.segments.length; i++) {
    const ns     = narrative.segments[i];
    // Strict match only — positional fallback (threadData[i]) caused article/story mismatches
    // when Claude reordered segments or returned wrong thread_ids.
    const thread = threadData.find(t => String(t.id) === String(ns.thread_id));
    if (!thread) {
      console.warn(`  [buildSegments] segment ${i} has unknown thread_id ${ns.thread_id} — skipping`);
      continue;
    }

    const arcs = allArcs.filter(a => a.thread_id === thread.id);

    // secondary_locations = all story entities + arc endpoints, deduped by position.
    // Used by the globe player to pulse all relevant nodes, not just the primary.
    const secondaryLocations = [];
    const seen = new Set();
    const addLoc = (name, lat, lon) => {
      if (lat == null || lon == null) return;
      const key = `${parseFloat(lat).toFixed(2)},${parseFloat(lon).toFixed(2)}`;
      if (!seen.has(key)) { seen.add(key); secondaryLocations.push({ name, lat: parseFloat(lat), lon: parseFloat(lon) }); }
    };
    // Include all Claude-identified story entities first (most semantically correct)
    for (const e of (ns.entities || [])) {
      if (entityCoords[e.name]) addLoc(e.name, entityCoords[e.name].lat, entityCoords[e.name].lon);
    }
    // Then add arc endpoints (catches any not in entities)
    for (const arc of arcs) {
      addLoc(arc.from_name, arc.from_lat, arc.from_lng);
      addLoc(arc.to_name,   arc.to_lat,   arc.to_lng);
    }

    // Deduplicate articles: strip any article IDs already used in an earlier segment
    const rawIds     = thread.articleIds || [];
    const uniqueIds  = rawIds.filter(id => !usedArticleIds.has(id));
    uniqueIds.forEach(id => usedArticleIds.add(id));

    // ── Primary globe focus: use Claude's entity extraction (subject of story),
    //    NOT article geo-tags (source country, often wrong for international stories)
    let primaryCity    = null;
    let primaryCountry = null;
    for (const e of (ns.entities || [])) {
      const coords = entityCoords[e.name];
      if (!coords) continue;
      if (e.type === 'city'    && !primaryCity)    primaryCity    = { name: e.name, lat: coords.lat, lon: coords.lon };
      if (e.type === 'country' && !primaryCountry) primaryCountry = { name: e.name, lat: coords.lat, lon: coords.lon };
    }
    // Fallback to article-sourced location only if Claude found nothing
    if (!primaryCity && !primaryCountry) {
      primaryCity    = thread.primaryCity    || null;
      primaryCountry = thread.primaryCountry || null;
    }

    // Strip primary node(s) from secondary_locations — avoids duplication in
    // display and globe player (primary_city / primary_country shown separately).
    const primaryCoordKeys = new Set();
    const _coordKey = (lat, lon) => `${parseFloat(lat).toFixed(2)},${parseFloat(lon).toFixed(2)}`;
    if (primaryCity)    primaryCoordKeys.add(_coordKey(primaryCity.lat,    primaryCity.lon));
    if (primaryCountry) primaryCoordKeys.add(_coordKey(primaryCountry.lat, primaryCountry.lon));
    const filteredSecondaries = secondaryLocations.filter(
      s => !primaryCoordKeys.has(_coordKey(s.lat, s.lon))
    );

    // Split voiceover at [VIDEO_HANDOFF] marker if present (featured video segments)
    let voiceoverText = ns.voiceover;
    let voiceoverBeforeVideo = null;
    let voiceoverAfterVideo = null;
    if (voiceoverText.includes('[VIDEO_HANDOFF]')) {
      const parts = voiceoverText.split('[VIDEO_HANDOFF]');
      voiceoverBeforeVideo = parts[0].trim();
      voiceoverAfterVideo = parts[1]?.trim() || '';
      // Full voiceover is both parts joined (for TTS, the audio will be two separate clips)
      voiceoverText = voiceoverBeforeVideo + ' ' + voiceoverAfterVideo;
    }

    const storySeg = {
      type:                'story',
      thread_id:           thread.id,
      thread_title:        thread.title,
      article_ids:         uniqueIds,
      video_id:            thread._youtubeOverride?.video_id || thread.videoId,
      media_type:          thread._featuredVideo?.media_type || 'youtube',
      twitter_url:         thread._featuredVideo?.media_type?.startsWith('twitter') ? (thread._featuredVideo?.twitter_url || null) : null,
      voiceover_text:      voiceoverText,
      voiceover_before_video: voiceoverBeforeVideo,
      voiceover_after_video:  voiceoverAfterVideo,
      video_focal:         thread._featuredVideo?.enabled ? {
        enabled:              true,
        start_sec:            0,
        end_sec:              thread._featuredVideo?.duration_sec || 15,
        // Trigger the video handoff at the point in the voiceover where the split occurs
        trigger_pct:          voiceoverBeforeVideo
          ? Math.round((voiceoverBeforeVideo.split(/\s+/).length / voiceoverText.split(/\s+/).length) * 100)
          : 35,
        captions:             true,
        volume:               'medium',
        narrator_transition:  thread._featuredVideo?.narrator_transition || '',
      } : null,
      transition:          ns.transition || null,
      globe_focus:         thread.globeFocus
                             ? { lat: thread.globeFocus.lat, lng: thread.globeFocus.lng, zoom: 2.5 }
                             : null,
      primary_city:        primaryCity,
      primary_country:     primaryCountry,
      flow_arcs:           arcs,
      secondary_locations: filteredSecondaries,
      // Pre-computed ISOs so the runtime doesn't have to fuzzy-match names
      // at playback time. See Fix 4 in the briefing-system refactor: the
      // old name-lookup was case-sensitive and unreliable ("USA" vs "United
      // States of America"), leaving segments without highlights.
      primary_country_iso: primaryCountry
        ? _isoResolver(primaryCountry.name, primaryCountry.lat, primaryCountry.lon)
        : null,
      primary_city_country_iso: primaryCity
        ? _isoResolver(primaryCity.country_name, primaryCity.lat, primaryCity.lon)
        : null,
      secondary_country_isos: Array.from(new Set(
        filteredSecondaries
          .map(s => _isoResolver(s.name, s.lat, s.lon))
          .filter(Boolean)
      )),
      flow_arc_isos: Array.from(new Set(
        arcs.flatMap(a => [
          _isoResolver(a.from_name, a.from_lat, a.from_lng),
          _isoResolver(a.to_name,   a.to_lat,   a.to_lng),
        ]).filter(Boolean)
      )),
    };

    console.log(`\n── SEGMENT ${i+1} BUILD: "${thread.title}" ──────────────────`);
    console.log(`   thread_id        : ${storySeg.thread_id}`);
    console.log(`   video_id         : ${storySeg.video_id || '(none)'}`);
    console.log(`   article_ids      : [${storySeg.article_ids.join(', ')}]`);
    console.log(`   globe_focus      : ${JSON.stringify(storySeg.globe_focus)}`);
    console.log(`   primary_city     : ${JSON.stringify(storySeg.primary_city)}`);
    console.log(`   primary_country  : ${JSON.stringify(storySeg.primary_country)}`);
    console.log(`   flow_arcs (${String(storySeg.flow_arcs.length).padStart(2)}) : ${JSON.stringify(storySeg.flow_arcs)}`);
    console.log(`   secondary_locs   : ${JSON.stringify(storySeg.secondary_locations)}`);
    console.log(`   transition       : ${storySeg.transition || '(none)'}`);
    console.log(`   voiceover (${String((storySeg.voiceover_text||'').split(/\s+/).length).padStart(3)}w): ${(storySeg.voiceover_text||'').slice(0, 120)}…`);

    segments.push(storySeg);
  }

  // Rising keywords segment (before outro)
  try {
    const rising = await getRisingKeywordsForSegment(3);
    if (rising.length >= 2) {
      const lines = rising.map(k => {
        const x = Math.round(k.momentum);
        const badge = x >= 5 ? `up ${x}× in recent coverage` : `surging in recent coverage`;
        return `${k.keyword} — ${badge}${k.sample_title ? `, connected to: ${k.sample_title}` : ''}`;
      });
      const voiceText = `Before we close — three topics gaining rapid momentum in global news. ${lines.join('. ')}. We'll continue tracking these tomorrow.`;
      segments.push({
        type:           'keywords',
        voiceover_text: voiceText,
        keywords:       rising,
        article_ids:    rising.flatMap(k => k.article_ids || []),
        primary_country: null,
        primary_city:   null,
        arcs:           [],
        entities:       [],
        globe_animate:  { lat: 20, lng: 0, zoom: 0.9 },
        start_ms:       null,
      });
    }
  } catch (e) {
    console.warn('[buildSegments] rising keywords skipped:', e.message);
  }

  // Outro segment
  const outroSeg = { type: 'outro', voiceover_text: narrative.outro, globe_animate: { lat: 20, lng: 0, zoom: 0.9 } };
  console.log(`\n── SEGMENT ${segments.length} BUILD: OUTRO ──────────────────────────────────`);
  console.log(`   globe_animate : ${JSON.stringify(outroSeg.globe_animate)}`);
  console.log(`   voiceover     : ${(outroSeg.voiceover_text||'').slice(0, 120)}…`);
  segments.push(outroSeg);

  console.log('\n══ FINAL SEGMENTS ARRAY ═════════════════════════════════════');
  segments.forEach((seg, i) => {
    console.log(`  [${i}] type=${seg.type.padEnd(8)} | globe_animate=${JSON.stringify(seg.globe_animate||null)} | globe_focus=${JSON.stringify(seg.globe_focus||null)}`);
    if (seg.primary_city || seg.primary_country) {
      console.log(`       primary_city=${JSON.stringify(seg.primary_city||null)}  primary_country=${JSON.stringify(seg.primary_country||null)}`);
    }
    if (seg.secondary_locations?.length) {
      console.log(`       secondary_locations (${seg.secondary_locations.length}): ${seg.secondary_locations.map(l => l.name).join(', ')}`);
    }
    if (seg.flow_arcs?.length) {
      console.log(`       flow_arcs (${seg.flow_arcs.length}): ${seg.flow_arcs.map(a => `${a.from_name}→${a.to_name}`).join(', ')}`);
    }
  });
  console.log('═════════════════════════════════════════════════════════════\n');

  return segments;
}

// ─── Rising keywords for the keywords spotlight segment ─────────────────────
async function getRisingKeywordsForSegment(limit = 3) {
  const { rows } = await pool.query(`
    SELECT results FROM keyword_intelligence_cache
    WHERE mode = 'rising' AND filter_key = 'global'
    ORDER BY computed_at DESC LIMIT 1
  `);
  if (!rows.length) return [];

  const raw = rows[0].results;
  const topKeywords = (typeof raw === 'string' ? JSON.parse(raw) : raw).slice(0, limit);

  return Promise.all(topKeywords.map(async kw => {
    const { rows: arts } = await pool.query(`
      SELECT a.id, COALESCE(a.translated_title, a.title) AS sample_title
      FROM article_keywords ak
      JOIN news_articles a ON a.id = ak.article_id
      WHERE COALESCE(ak.normalized_keyword, ak.keyword) = $1
        AND a.published_at > NOW() - INTERVAL '7 days'
      ORDER BY a.published_at DESC
      LIMIT 3
    `, [kw.keyword]);
    return { ...kw, article_ids: arts.map(a => a.id), sample_title: arts[0]?.sample_title || null };
  })).then(results => results.filter(k => k.article_ids.length > 0));
}

// ─── Script Assembly ───────────────────────────────────────────────────────
function buildFullScript(narrative) {
  const parts = [narrative.intro];
  for (const seg of narrative.segments) {
    parts.push(seg.voiceover);
    if (seg.transition) parts.push(seg.transition);
  }
  parts.push(narrative.outro);
  return parts.join(' ');
}

// ─── ElevenLabs TTS ────────────────────────────────────────────────────────
// Uses the /with-timestamps endpoint so we get per-character alignment data
// for word-level caption sync. Returns { buffer, wordTimings, durationMs }.
//   wordTimings: [{ w: 'Hello', t: 120, d: 380 }, ...]   (ms relative to start)
//   durationMs:  precise audio length from alignment (more accurate than the
//                CBR byte-rate estimate we were using before).
async function synthesiseAudio(script) {
  const url  = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}/with-timestamps`;
  const body = {
    text:       script,
    model_id:   'eleven_multilingual_v2',
    voice_settings: {
      stability:        0.55,
      similarity_boost: 0.75,
      style:            0.20,
      use_speaker_boost: true
    }
  };

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'xi-api-key':   ELEVENLABS_KEY,
      'Content-Type': 'application/json',
      'Accept':       'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ElevenLabs error ${res.status}: ${errText}`);
  }

  const json = await res.json();
  if (!json || !json.audio_base64) {
    throw new Error('ElevenLabs: missing audio_base64 in with-timestamps response');
  }
  const buffer = Buffer.from(json.audio_base64, 'base64');

  // Build word-level timings from per-character alignment.
  const align = json.alignment || json.normalized_alignment || null;
  const wordTimings = [];
  let durationMs = 0;
  if (align && Array.isArray(align.characters) && Array.isArray(align.character_start_times_seconds)) {
    const chars = align.characters;
    const starts = align.character_start_times_seconds;
    const ends   = align.character_end_times_seconds || starts;
    let curWord  = '';
    let curStart = -1;
    let curEnd   = 0;
    const flush = () => {
      if (curWord) {
        wordTimings.push({
          w: curWord,
          t: Math.round(curStart * 1000),
          d: Math.max(0, Math.round((curEnd - curStart) * 1000)),
        });
      }
      curWord = ''; curStart = -1; curEnd = 0;
    };
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      const isWS = /\s/.test(ch);
      if (isWS) { flush(); continue; }
      if (curStart < 0) curStart = starts[i] ?? 0;
      curWord += ch;
      curEnd   = ends[i] ?? curStart;
    }
    flush();
    if (ends.length) durationMs = Math.round((ends[ends.length - 1] || 0) * 1000);
  }

  // Fallback duration: CBR 128 kbps estimate from byte length
  if (!durationMs) durationMs = Math.round((buffer.byteLength * 8) / 128);

  return { buffer, wordTimings, durationMs };
}

// ─── Curation Table ────────────────────────────────────────────────────────
async function ensureCurationTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS briefing_curation_history (
      id          SERIAL      PRIMARY KEY,
      chosen_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      episode_id  INTEGER     REFERENCES briefing_episodes(id) ON DELETE SET NULL,
      thread_ids  INTEGER[]   NOT NULL,
      categories  TEXT[]      NOT NULL DEFAULT '{}',
      keywords    TEXT[]      NOT NULL DEFAULT '{}',
      regions     TEXT[]      NOT NULL DEFAULT '{}'
    )
  `);
}

// ─── Pick Mode: List Candidates ────────────────────────────────────────────
// Returns the same candidate pool as selectThreads but without diversity caps,
// sorted by importance × diversity for display.
async function listCandidateThreads(limit = 50) {
  const { rows: candidates } = await pool.query(`
    SELECT
      st.id, st.title, st.primary_category, st.importance, st.keywords,
      st.geographic_scope,
      COUNT(sta.article_id)                                           AS recent_articles,
      COUNT(CASE WHEN a.video_id IS NOT NULL THEN 1 END)             AS video_count
    FROM story_threads st
    JOIN story_thread_articles sta ON sta.thread_id = st.id
    JOIN news_articles a           ON a.id = sta.article_id
    WHERE st.status = 'active'
      AND st.last_updated_at  > NOW() - INTERVAL '${THREAD_ACTIVITY_LOOKBACK_DAYS} days'
      AND a.published_at      > NOW() - INTERVAL '${THREAD_ACTIVITY_LOOKBACK_DAYS} days'
    GROUP BY st.id
    HAVING COUNT(sta.article_id) >= ${MIN_RECENT_ARTICLES_PICK}
    ORDER BY st.importance DESC, COUNT(sta.article_id) DESC
    LIMIT $1
  `, [limit]);
  const diversityStats = await getThreadDiversityStats(candidates.map((t) => t.id), THREAD_ENRICH_LOOKBACK_DAYS);

  // Tag video presence and region
  return candidates.map(t => ({
    ...t,
    hasVideo: Number(t.video_count) > 0,
    region:   getRegionGroup(t),
    sourceCount: Number(diversityStats.get(Number(t.id))?.source_count) || 1,
    countryCount: Number(diversityStats.get(Number(t.id))?.country_count) || 1,
    languageCount: Number(diversityStats.get(Number(t.id))?.language_count) || 1,
  }));
}

// ─── Pick Mode: Interactive Selection ─────────────────────────────────────
async function promptThreadSelection(candidates) {
  // Display formatted table
  console.log();
  console.log('┌─────────────────────────────────────────────────────────────────────────────┐');
  console.log('│  AVAILABLE STORY THREADS — choose up to 10  (showing top 100)               │');
  console.log('├────┬────────┬───────────────────────────────────────────────┬──────┬───────┤');
  console.log('│ #  │  ID    │ Title                                          │ Cat  │ 🎬/📰 │');
  console.log('├────┼────────┼───────────────────────────────────────────────┼──────┼───────┤');

  candidates.forEach((t, i) => {
    const num    = String(i + 1).padStart(2);
    const id     = String(t.id).padEnd(6);
    const title  = (t.title || '').slice(0, 46).padEnd(46);
    const cat    = (t.primary_category || 'general').slice(0, 4).padEnd(4);
    const media  = t.hasVideo ? '🎬' : '📰 ';
    const region = (t.region || '').slice(0, 10);
    console.log(`│ ${num} │ ${id} │ ${title} │ ${cat} │ ${media}    │  ${region}`);
  });

  console.log('└────┴────────┴───────────────────────────────────────────────┴──────┴───────┘');
  console.log();
  console.log(`Enter thread IDs (comma-separated), or # row numbers prefixed with #, to select up to ${MAX_THREADS} stories.`);
  console.log(`Example:  1045, 1089, 1102   or   #1, #3, #7, #12`);
  console.log();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise(resolve => rl.question('Your selection: ', resolve));
  rl.close();

  const tokens = answer.split(',').map(s => s.trim()).filter(Boolean);
  const selected = [];
  const seen = new Set();

  for (const token of tokens) {
    let thread = null;
    if (token.startsWith('#')) {
      // Row number reference — 1-indexed
      const rowNum = parseInt(token.slice(1), 10);
      if (!isNaN(rowNum) && rowNum >= 1 && rowNum <= candidates.length) {
        thread = candidates[rowNum - 1];
      } else {
        console.warn(`  ⚠ Skipping unknown row reference: ${token}`);
        continue;
      }
    } else {
      const id = parseInt(token, 10);
      thread = candidates.find(c => c.id === id);
      if (!thread) {
        console.warn(`  ⚠ Skipping unknown thread ID: ${token}`);
        continue;
      }
    }
    if (seen.has(thread.id)) continue;
    seen.add(thread.id);
    selected.push(thread);
    if (selected.length >= MAX_THREADS) break;
  }

  console.log();
  console.log(`Selected ${selected.length} thread(s):`);
  selected.forEach((t, i) => console.log(`  ${i + 1}. [${t.id}] ${t.title}`));
  console.log();

  return selected;
}

// ─── Pick Mode: Data Panel Review & Edit ───────────────────────────────────
// Lets the user replace any segment's auto-generated panels with a hand-picked
// set (preset menu) or fully custom-built panels via dataPanelGenerator.
async function reviewAndEditPanels(segments, threadData) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise(resolve => rl.question(q, resolve));

  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║                     DATA PANEL REVIEW                                ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log('  Commands:  list  |  edit N  |  confirm  |  skip\n');

  function listAll() {
    segments.forEach((seg, i) => {
      if (seg.type !== 'story') return;
      const cnt = seg.data_panels?.length || 0;
      const mark = cnt === 0 ? ' (no panels)' : '';
      console.log(`  [${i}] "${(seg.thread_title||'').slice(0,50)}" — ${cnt} panel(s)${mark}`);
      (seg.data_panels || []).forEach((p, k) => {
        console.log(`        ${k+1}. [${p.chart_type}] ${p.title} — ${p.source_name||'?'}${p.generated_by==='ai_composed'?' ⚠':''}`);
      });
    });
  }
  listAll();

  while (true) {
    const cmd = (await ask('\npanels> ')).trim().toLowerCase();
    if (!cmd) continue;
    if (cmd === 'confirm' || cmd === 'skip' || cmd === 'done') break;
    if (cmd === 'list') { listAll(); continue; }

    const m = cmd.match(/^edit\s+(\d+)$/);
    if (m) {
      const idx = parseInt(m[1], 10);
      if (idx < 0 || idx >= segments.length || segments[idx].type !== 'story') {
        console.log('  ✗ not a story segment'); continue;
      }
      const seg = segments[idx];
      const threadCtx = threadData.find(t => String(t.id) === String(seg.thread_id));
      // Collect already-used panels from other segments for dedup
      const usedPanels = segments
        .filter((s, si) => s.type === 'story' && si !== idx && s.data_panels?.length)
        .flatMap(s => s.data_panels.map(p => ({ adapter: p.adapter, title: p.title, indicator: p.query?.indicator })));
      const replaced = await dataPanels.pickPanelsInteractive(seg, threadCtx, {
        rl, max: PANELS_MAX_PICK, usedPanels,
      });
      seg.data_panels = replaced;
      continue;
    }
    console.log('  Commands: list  |  edit N  |  confirm');
  }
  rl.close();
  return segments;
}

// ─── --panels-only: regenerate panels in place for an existing episode ─────
async function regeneratePanelsForEpisode(episodeId, segments) {
  // Need threadData-equivalent context — pull thread titles via segments themselves
  await pool.query(`SELECT delete_panels_for_episode($1)`, [episodeId]);
  const minTotal = PANELS_MIN_GENERAL;
  const maxTotal = PANELS_MAX_GENERAL;
  const storyCount = segments.filter(s => s.type === 'story').length || 1;
  const perStoryMax = Math.max(1, Math.ceil(maxTotal / storyCount));
  let totalPanels = 0;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (seg.type !== 'story') continue;
    if (totalPanels >= maxTotal) continue;
    const cap = Math.min(perStoryMax, maxTotal - totalPanels);
    try {
      const panels = await dataPanels.generatePanelsForSegment(seg, null, { min: 0, max: cap });
      if (panels.length) {
        await dataPanels.savePanels(pool, panels, { type: 'briefing_segment', id: episodeId, segmentIndex: i });
        totalPanels += panels.length;
        console.log(`   seg ${i} → ${panels.length} panel(s)`);
      }
    } catch (e) {
      console.warn(`   ⚠ seg ${i}: ${e.message}`);
    }
  }
  console.log(`   Total: ${totalPanels} panel(s)`);
}

// ─── Pick Mode: Script Review & Edit ──────────────────────────────────────
// ── Open the user's $EDITOR on a temp file containing `initial`, wait for
// them to save and exit, then return the new contents (trimmed). Falls back
// to nano on macOS / vim elsewhere if $EDITOR is unset. Returns null if the
// user left the file empty or unchanged is false and they bailed.
function openInEditor(initial, label = 'briefing-edit') {
  const editor = process.env.VISUAL || process.env.EDITOR
    || (process.platform === 'darwin' ? 'nano' : 'vim');
  const tmp = path.join(os.tmpdir(), `${label}-${Date.now()}-${process.pid}.txt`);
  // Header is stripped on read so user can see context but not have it land in script.
  const header =
`# Edit the voiceover below. Lines starting with '#' are stripped.
# Save and exit your editor when done. Leave the body empty to cancel.
# ──────────────────────────────────────────────────────────────────────
`;
  fs.writeFileSync(tmp, header + (initial || ''), 'utf8');
  const r = spawnSync(editor, [tmp], { stdio: 'inherit' });
  if (r.status !== 0 && r.error) {
    console.log(`  ✗ Editor "${editor}" failed: ${r.error.message}`);
    try { fs.unlinkSync(tmp); } catch (_) {}
    return null;
  }
  let contents = '';
  try { contents = fs.readFileSync(tmp, 'utf8'); } catch (_) { contents = ''; }
  try { fs.unlinkSync(tmp); } catch (_) {}
  // Strip comment lines and trim
  const body = contents
    .split(/\r?\n/)
    .filter(l => !l.startsWith('#'))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
  return body || null;
}

async function reviewAndEditSegments(segments, _threadData) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (prompt) => new Promise(resolve => rl.question(prompt, resolve));

  function fmtCoord(v) {
    if (v === null || v === undefined) return '—';
    return String(v);
  }

  function printSegment(seg, idx) {
    const label = `[${idx}] ${(seg.type || '?').toUpperCase()}`;
    const bar   = '─'.repeat(Math.max(0, 75 - label.length));
    console.log(`\n┌─ ${label} ${bar}┐`);

    // Globe position
    const gf = seg.globe_focus || seg.globe_animate || null;
    if (gf) {
      const tag = seg.globe_animate ? 'globe_animate' : 'globe_focus ';
      console.log(`│  ${tag}  lat=${fmtCoord(gf.lat)}  lng=${fmtCoord(gf.lng)}  zoom=${fmtCoord(gf.zoom)}`);
    }

    // Primary node
    const pCity    = seg.primary_city;
    const pCountry = seg.primary_country;
    if (pCity)    console.log(`│  primary_city     ${pCity.name}  (${fmtCoord(pCity.lat)}, ${fmtCoord(pCity.lon)})`);
    if (pCountry) console.log(`│  primary_country  ${pCountry.name}  (${fmtCoord(pCountry.lat)}, ${fmtCoord(pCountry.lon)})`);

    // Secondary locations
    const secs = seg.secondary_locations || [];
    if (secs.length) {
      console.log(`│  secondary_locations (${secs.length}):`);
      secs.forEach((s, i) => console.log(`│    [${i}] ${s.name}  (${fmtCoord(s.lat)}, ${fmtCoord(s.lon)})`));
    }

    // Flow arcs
    const arcs = seg.flow_arcs || [];
    if (arcs.length) {
      console.log(`│  flow_arcs (${arcs.length}):`);
      arcs.forEach((a, i) => console.log(`│    [${i}] thread=${a.thread_id}  ${a.from_name} → ${a.to_name}`));
    }

    // Transition
    if (seg.transition) {
      console.log(`│  transition:  "${seg.transition}"`);
    }

    // Data panels (if any)
    const panels = seg.data_panels || [];
    if (panels.length) {
      console.log(`│  data_panels (${panels.length}):`);
      panels.forEach((p, i) => {
        const tag = p.generated_by === 'ai_composed' ? '⚠ EST'
                  : p.generated_by === 'manual'      ? '✎ MAN'
                  : p.adapter ? p.adapter : p.source_name || 'real';
        console.log(`│    [${i}] [${p.chart_type}] ${(p.title||'').slice(0,52)}  — ${tag}`);
      });
    } else if (seg.type === 'story') {
      console.log(`│  data_panels: (none)`);
    }

    // Voiceover — word-wrapped at 72 chars
    const vo = seg.voiceover_text || '';
    console.log(`│  voiceover_text:`);
    const words = vo.split(' ');
    let line = '│    ';
    words.forEach(w => {
      if (line.length + w.length + 1 > 77) { console.log(line); line = '│    ' + w + ' '; }
      else { line += w + ' '; }
    });
    if (line.trim() !== '│') console.log(line);

    console.log(`└${'─'.repeat(77)}┘`);
  }

  async function editSegment(seg, idx) {
    console.log('\n  Edit fields for segment ' + idx + ':');
    console.log('    v   — voiceover_text  (opens $EDITOR for free-form editing)');
    console.log('    vl  — voiceover_text  (single-line inline edit)');
    console.log('    t   — transition');
    console.log('    f   — globe_focus / globe_animate  (enter: lat lng zoom)');
    console.log('    p   — primary node  (enter: city|country  name  lat  lon)');
    console.log('    s   — secondary_locations  (add/remove: +name lat lon  or  -index)');
    console.log('    a   — flow_arcs  (add/remove: +fromName lat lng toName lat lng  or  -index)');
    console.log('    done — finish editing this segment');
    console.log();

    while (true) {
      const cmd = (await ask(`  seg[${idx}] field> `)).trim();
      if (!cmd || cmd === 'done') break;

      if (cmd === 'v') {
        // Open the user's $EDITOR with the current voiceover so they can
        // freely rewrite, delete, or restructure sentences. Empty body = cancel.
        const next = openInEditor(seg.voiceover_text || '', `seg-${idx}-voiceover`);
        if (next == null) {
          console.log('  · voiceover unchanged');
        } else {
          seg.voiceover_text = next;
          console.log(`  ✓ voiceover updated (${next.split(/\s+/).length} words)`);
        }

      } else if (cmd === 'vl') {
        const val = (await ask('  voiceover_text> ')).trim();
        if (val) seg.voiceover_text = val;

      } else if (cmd === 't') {
        const val = (await ask('  transition (blank to clear)> ')).trim();
        seg.transition = val || null;

      } else if (cmd === 'f') {
        const val = (await ask('  lat lng zoom (space-separated)> ')).trim();
        const parts = val.split(/\s+/);
        if (parts.length >= 3) {
          const key = seg.globe_animate ? 'globe_animate' : 'globe_focus';
          seg[key] = { lat: parseFloat(parts[0]), lng: parseFloat(parts[1]), zoom: parseFloat(parts[2]) };
          console.log(`  ✓ ${key} updated`);
        } else {
          console.log('  ✗ Need 3 values: lat lng zoom');
        }

      } else if (cmd === 'p') {
        const val = (await ask('  city|country  name  lat  lon (space-separated, name may include spaces before last 2 nums)> ')).trim();
        const parts = val.split(/\s+/);
        if (parts.length >= 4) {
          const kind = parts[0].toLowerCase();
          const lon  = parseFloat(parts[parts.length - 1]);
          const lat  = parseFloat(parts[parts.length - 2]);
          const name = parts.slice(1, parts.length - 2).join(' ');
          if (kind === 'city')    { seg.primary_city    = { name, lat, lon }; console.log(`  ✓ primary_city = ${name}`); }
          else if (kind === 'country') { seg.primary_country = { name, lat, lon }; console.log(`  ✓ primary_country = ${name}`); }
          else console.log('  ✗ First token must be "city" or "country"');
        } else {
          console.log('  ✗ Need: city|country  name  lat  lon');
        }

      } else if (cmd === 's') {
        const val = (await ask('  +name lat lon  or  -index> ')).trim();
        if (!seg.secondary_locations) seg.secondary_locations = [];
        if (val.startsWith('+')) {
          const parts = val.slice(1).trim().split(/\s+/);
          if (parts.length >= 3) {
            const lon  = parseFloat(parts[parts.length - 1]);
            const lat  = parseFloat(parts[parts.length - 2]);
            const name = parts.slice(0, parts.length - 2).join(' ');
            seg.secondary_locations.push({ name, lat, lon });
            console.log(`  ✓ Added secondary: ${name}`);
          } else console.log('  ✗ Need: +name lat lon');
        } else if (val.startsWith('-')) {
          const idx2 = parseInt(val.slice(1), 10);
          if (!isNaN(idx2) && idx2 >= 0 && idx2 < seg.secondary_locations.length) {
            const removed = seg.secondary_locations.splice(idx2, 1);
            console.log(`  ✓ Removed secondary[${idx2}]: ${removed[0].name}`);
          } else console.log('  ✗ Index out of range');
        } else console.log('  ✗ Start with + to add or - to remove');

      } else if (cmd === 'a') {
        const val = (await ask('  +fromName lat lng toName lat lng  or  -index> ')).trim();
        if (!seg.flow_arcs) seg.flow_arcs = [];
        if (val.startsWith('+')) {
          const parts = val.slice(1).trim().split(/\s+/);
          // Expect: fromName fromLat fromLng toName toLat toLng
          if (parts.length >= 6) {
            const toLng   = parseFloat(parts[parts.length - 1]);
            const toLat   = parseFloat(parts[parts.length - 2]);
            const toName  = parts[parts.length - 3];
            const fromLng = parseFloat(parts[parts.length - 4]);
            const fromLat = parseFloat(parts[parts.length - 5]);
            const fromName = parts.slice(0, parts.length - 5).join(' ');
            seg.flow_arcs.push({ thread_id: null, from_name: fromName, from_lat: fromLat, from_lng: fromLng, to_name: toName, to_lat: toLat, to_lng: toLng });
            console.log(`  ✓ Added arc: ${fromName} → ${toName}`);
          } else console.log('  ✗ Need: +fromName fromLat fromLng toName toLat toLng');
        } else if (val.startsWith('-')) {
          const idx2 = parseInt(val.slice(1), 10);
          if (!isNaN(idx2) && idx2 >= 0 && idx2 < seg.flow_arcs.length) {
            const removed = seg.flow_arcs.splice(idx2, 1);
            console.log(`  ✓ Removed arc[${idx2}]: ${removed[0].from_name} → ${removed[0].to_name}`);
          } else console.log('  ✗ Index out of range');
        } else console.log('  ✗ Start with + to add or - to remove');

      } else {
        console.log('  Unknown field. Use: v  t  f  p  s  a  done');
      }

      // Re-print the segment after each change so user can see current state
      printSegment(seg, idx);
    }
  }

  // ── Main review loop ──────────────────────────────────────────────────────
  console.log('\n');
  console.log('╔═══════════════════════════════════════════════════════════════════════════════╗');
  console.log('║         SCRIPT REVIEW — verify nodes, arcs, and voiceover before TTS         ║');
  console.log('╚═══════════════════════════════════════════════════════════════════════════════╝');
  console.log(`  ${segments.length} segments total`);
  console.log('  Commands:  confirm  |  edit N  |  show N  |  delete N  |  abort');
  console.log();

  // Initial display: all segments
  segments.forEach((seg, i) => printSegment(seg, i));
  console.log();

  while (true) {
    const cmd = (await ask('review> ')).trim().toLowerCase();

    if (!cmd) continue;

    if (cmd === 'confirm') {
      console.log('\n  ✓ Script confirmed — proceeding to ElevenLabs synthesis...\n');
      rl.close();
      return segments;
    }

    if (cmd === 'abort') {
      console.log('\n  ✗ Aborted by user.\n');
      rl.close();
      process.exit(0);
    }

    const showMatch = cmd.match(/^show\s+(\d+)$/);
    if (showMatch) {
      const idx = parseInt(showMatch[1], 10);
      if (idx >= 0 && idx < segments.length) printSegment(segments[idx], idx);
      else console.log(`  ✗ Segment index out of range (0–${segments.length - 1})`);
      continue;
    }

    const editMatch = cmd.match(/^edit\s+(\d+)$/);
    if (editMatch) {
      const idx = parseInt(editMatch[1], 10);
      if (idx >= 0 && idx < segments.length) {
        await editSegment(segments[idx], idx);
      } else {
        console.log(`  ✗ Segment index out of range (0–${segments.length - 1})`);
      }
      continue;
    }

    const deleteMatch = cmd.match(/^delete\s+(\d+)$/);
    if (deleteMatch) {
      const idx = parseInt(deleteMatch[1], 10);
      if (idx < 0 || idx >= segments.length) {
        console.log(`  ✗ Segment index out of range (0–${segments.length - 1})`);
        continue;
      }
      const seg = segments[idx];
      const label = `[${idx}] ${(seg.type || '?').toUpperCase()}` +
        (seg.thread_title ? ` — ${seg.thread_title}` : '');
      const confirm = (await ask(`  Delete ${label}?  (y/N)> `)).trim().toLowerCase();
      if (confirm === 'y' || confirm === 'yes') {
        segments.splice(idx, 1);
        console.log(`  ✓ Deleted segment [${idx}]. ${segments.length} segments remain.`);
        // Re-print so user sees the new numbering
        segments.forEach((s, i) => printSegment(s, i));
      } else {
        console.log('  · cancelled');
      }
      continue;
    }

    console.log('  Commands:  confirm  |  edit N  |  show N  |  delete N  |  abort');
  }
}

// ─── Curation Persistence ──────────────────────────────────────────────────
async function saveCurationChoice(threads, episodeId) {
  const threadIds  = threads.map(t => t.id);
  const categories = [...new Set(threads.map(t => t.primary_category).filter(Boolean))];
  const regions    = [...new Set(threads.map(t => getRegionGroup(t)).filter(Boolean))];
  const keywords   = [...new Set(
    threads.flatMap(t => Array.isArray(t.keywords) ? t.keywords : []).filter(Boolean)
  )].slice(0, 60); // cap at 60 to keep the array manageable

  await pool.query(`
    INSERT INTO briefing_curation_history (episode_id, thread_ids, categories, keywords, regions)
    VALUES ($1, $2, $3, $4, $5)
  `, [episodeId || null, threadIds, categories, keywords, regions]);
}

// ─── Preference Profile Builder ────────────────────────────────────────────
// Reads the last 30 curation sessions and derives category/keyword/region
// affinities with exponential recency decay (half-life ≈ 10 sessions).
async function buildPreferenceProfile() {
  const { rows } = await pool.query(`
    SELECT categories, keywords, regions, chosen_at
    FROM briefing_curation_history
    ORDER BY chosen_at DESC
    LIMIT 30
  `);

  if (!rows.length) return null;

  const HALF_LIFE = 10; // sessions — older choices decay exponentially
  const catAff    = {};
  const kwAff     = {};
  const regAff    = {};

  rows.forEach((row, idx) => {
    // Weight decays by 50% every HALF_LIFE sessions (newest = weight 1.0)
    const weight = Math.pow(0.5, idx / HALF_LIFE);

    for (const cat of (row.categories || [])) {
      catAff[cat] = (catAff[cat] || 0) + weight;
    }
    for (const kw of (row.keywords || [])) {
      kwAff[kw] = (kwAff[kw] || 0) + weight;
    }
    for (const reg of (row.regions || [])) {
      regAff[reg] = (regAff[reg] || 0) + weight;
    }
  });

  // Normalise so the max affinity in each dimension = 1.0
  const normalise = obj => {
    const max = Math.max(...Object.values(obj), 1e-9);
    const out = {};
    for (const [k, v] of Object.entries(obj)) out[k] = v / max;
    return out;
  };

  const categories = normalise(catAff);
  const keywords   = normalise(kwAff);
  const regions    = normalise(regAff);

  // Build a human-readable summary for injection into the Claude prompt
  const topCats = Object.entries(categories).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k);
  const topRegs = Object.entries(regions).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k.replace('_', ' '));
  const topKws  = Object.entries(keywords).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k]) => k);
  const parts   = [];
  if (topCats.length) parts.push(`categories: ${topCats.join(', ')}`);
  if (topRegs.length) parts.push(`regions: ${topRegs.join(', ')}`);
  if (topKws.length)  parts.push(`topics: ${topKws.join(', ')}`);
  const _summary = parts.join('; ');

  return { categories, keywords, regions, _summary };
}

// ─── Entry ─────────────────────────────────────────────────────────────────
run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
