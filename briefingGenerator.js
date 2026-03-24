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
 */

'use strict';

require('dotenv').config();
const pool     = require('./db');
const Anthropic = require('@anthropic-ai/sdk');

const client         = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID       = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Rachel

const FORCE       = process.argv.includes('--force');
const NO_AUDIO    = process.argv.includes('--no-audio');
const FORCE_AUDIO = process.argv.includes('--force-audio'); // re-synthesise even if audio exists

// ─── Config ────────────────────────────────────────────────────────────────
const MAX_THREADS          = 10;  // stories in one briefing
const MAX_ARTICLES_THREAD  = 6;   // articles shown per story
const MAX_CATEGORY_REPEAT  = 2;   // max threads from same category
const MAX_PER_REGION       = 2;   // max threads from the same geographic region
const MAX_ENGLISH_DOMINANT = 4;   // max threads where >70% of articles are English-sourced
const MIN_VIDEO_THREADS    = 3;   // at least this many story segments must have a video
const THREAD_LOOKBACK_DAYS = 3;   // only threads active in last N days
const THREAD_MAX_AGE_DAYS  = 21;  // exclude threads whose first article is older than N days

// ─── Helpers ───────────────────────────────────────────────────────────────
function elapsed(t0) { return `+${((Date.now() - t0) / 1000).toFixed(1)}s`; }
function today()     { return new Date().toISOString().slice(0, 10); }
function sleep(ms)   { return new Promise(r => setTimeout(r, ms)); }

// ─── Main ──────────────────────────────────────────────────────────────────
async function run() {
  const t0 = Date.now();
  const targetDate = today();

  console.log('📡 Earth Briefing Generator');
  console.log(`   Date:  ${targetDate}`);
  console.log(`   Audio: ${NO_AUDIO ? 'disabled' : 'enabled (ElevenLabs)'}`);
  console.log();

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
    await pool.query(
      `UPDATE briefing_episodes SET status = 'generating', segments = '[]', audio_data = NULL, generated_at = NOW() WHERE id = $1`,
      [episodeId]
    );
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
    console.log(`   [${elapsed(t0)}] Selecting story threads...`);
    const threads = await selectThreads();
    if (!threads.length) {
      throw new Error('No active story threads found — run storyThreadBuilder first');
    }
    console.log(`   [${elapsed(t0)}] Selected ${threads.length} threads`);

    // ── 2. Pull articles for each thread ─────────────────────────────────
    console.log(`   [${elapsed(t0)}] Pulling articles for each thread...`);
    const rawThreadData = await Promise.all(threads.map(t => enrichThread(t)));

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

    // ── 3. Generate Claude narrative (includes story entity extraction) ──────
    console.log(`   [${elapsed(t0)}] Generating narrative with Claude...`);
    const narrative = await generateNarrative(threadData);
    if (!narrative.segments?.length) throw new Error('Claude returned 0 story segments — aborting');
    console.log(`   [${elapsed(t0)}] Narrative ready — headline: "${narrative.headline}" (${narrative.segments.length} segments)`);

    // ── 4. Resolve entity coordinates from DB ─────────────────────────────
    console.log(`   [${elapsed(t0)}] Resolving story entity coordinates...`);
    const entityCoords = await resolveEntityCoords(narrative.segments);
    console.log(`   [${elapsed(t0)}] Resolved ${Object.keys(entityCoords).length} entities`);

    // ── 5. Build geographic flow arcs (entity-based, not source-based) ────
    const allArcs = buildFlowArcs(threadData, narrative, entityCoords);

    // ── 6. Build segments JSON ────────────────────────────────────────────
    const segments = buildSegments(narrative, threadData, allArcs, entityCoords);

    // ── 6. Generate ElevenLabs audio — per-segment for accurate seek offsets
    let audioData = null;

    // Check whether today's episode already has audio so we don't re-bill ElevenLabs
    // on every --force run. Use --force-audio to explicitly re-synthesise.
    if (!NO_AUDIO && ELEVENLABS_KEY && !FORCE_AUDIO) {
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

      // Build one text piece per segment (voiceover + optional transition)
      const textPieces = segments.map(seg => {
        const base = seg.voiceover_text || '';
        const tr   = seg.transition ? (' ' + seg.transition) : '';
        return (base + tr).trim();
      });

      const audioBuffers    = [];
      const pieceDurationsMs = [];

      for (let pi = 0; pi < textPieces.length; pi++) {
        const text = textPieces[pi];
        if (!text) { audioBuffers.push(Buffer.alloc(0)); pieceDurationsMs.push(0); continue; }
        try {
          const buf = await synthesiseAudio(text);
          audioBuffers.push(buf);
          // ElevenLabs returns 128 kbps CBR MP3: bytes × 8 / 128 = milliseconds
          pieceDurationsMs.push(Math.round((buf.byteLength * 8) / 128));
          console.log(`   [${elapsed(t0)}] Piece ${pi + 1}/${textPieces.length} — ${(buf.byteLength / 1024).toFixed(0)}KB`);
        } catch (err) {
          console.warn(`   ⚠ Audio piece ${pi} failed: ${err.message}`);
          audioBuffers.push(Buffer.alloc(0));
          pieceDurationsMs.push(0);
        }
      }

      // Stamp each segment with its audio start offset so the player can seek accurately
      let cumMs = 0;
      for (let si = 0; si < segments.length; si++) {
        segments[si].start_ms = cumMs;
        cumMs += pieceDurationsMs[si];
      }

      // Concatenate all non-empty buffers into one MP3 file
      audioData = Buffer.concat(audioBuffers.filter(b => b.byteLength > 0));
      console.log(`   [${elapsed(t0)}] Audio ready — ${(audioData.length / 1024).toFixed(0)}KB total, ${(cumMs / 1000).toFixed(1)}s estimated`);
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

    console.log();
    console.log(`✅ Briefing complete in ${elapsed(t0)}`);
    console.log(`   Episode id:  ${episodeId}`);
    console.log(`   Headline:    ${narrative.headline}`);
    console.log(`   Threads:     ${threads.length}`);
    console.log(`   Segments:    ${segments.length}`);
    console.log(`   Audio:       ${audioData ? (audioData.length / 1024).toFixed(0) + 'KB' : 'none'}`);

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
function getRegionGroup(thread) {
  const parts = [
    ...(thread.geographic_scope || []),
    thread.title || '',
    thread.primary_category || '',
  ].join(' ').toLowerCase();
  if (/middle.?east|iran|iraq|israel|saudi|yemen|syria|gulf|qatar|bahrain|oman|jordan|lebanon/.test(parts)) return 'mideast';
  if (/russia|ukraine|belarus|caucasus|georgia|armenia|azerbaijan|central.?asia|kazakhstan|uzbek/.test(parts)) return 'russia_cis';
  if (/china|japan|korea|taiwan|hong.?kong|mongolia|east.?asia/.test(parts)) return 'east_asia';
  if (/india|pakistan|bangladesh|nepal|sri.?lanka|south.?asia|afghanistan/.test(parts)) return 'south_asia';
  if (/southeast.?asia|myanmar|thailand|vietnam|indonesia|philip|malaysia|singapore|cambodia|laos/.test(parts)) return 'se_asia';
  if (/africa|nigeria|ethiopia|kenya|egypt|sudan|ghana|tanzania|south.?africa|morocco|algeria|congo/.test(parts)) return 'africa';
  if (/latin.?america|mexico|brazil|argentin|colombia|venezuela|chile|peru|ecuador|cuba|haiti/.test(parts)) return 'latam';
  if (/europe|germany|france|britain|uk |poland|spain|italy|nato|netherlands|sweden|norway|finland|ukraine/.test(parts)) return 'europe';
  if (/united.?states|u\.s\.|america|canada|north.?america/.test(parts)) return 'north_america';
  if (/australia|new.?zealand|pacific|oceania/.test(parts)) return 'oceania';
  return 'global';
}

async function selectThreads() {
  // Step 1: Pull candidate threads with video presence flagged.
  // CTE computes the earliest article date per thread (across all history)
  // to exclude threads whose story started more than THREAD_MAX_AGE_DAYS ago.
  const { rows: candidates } = await pool.query(`
    WITH thread_origin AS (
      SELECT sta2.thread_id, MIN(a2.published_at) AS first_article_date
      FROM story_thread_articles sta2
      JOIN news_articles a2 ON a2.id = sta2.article_id
      GROUP BY sta2.thread_id
    )
    SELECT
      st.id, st.title, st.description, st.importance,
      st.primary_category, st.geographic_scope, st.keywords,
      st.article_count,
      COUNT(sta.article_id)                                           AS recent_articles,
      COUNT(CASE WHEN a.video_id IS NOT NULL THEN 1 END)             AS video_count
    FROM story_threads st
    JOIN story_thread_articles sta ON sta.thread_id = st.id
    JOIN news_articles a           ON a.id = sta.article_id
    JOIN thread_origin  tori       ON tori.thread_id = st.id
    WHERE st.status = 'active'
      AND st.last_updated_at  > NOW() - INTERVAL '${THREAD_LOOKBACK_DAYS} days'
      AND a.published_at      > NOW() - INTERVAL '${THREAD_LOOKBACK_DAYS} days'
      AND tori.first_article_date > NOW() - INTERVAL '${THREAD_MAX_AGE_DAYS} days'
    GROUP BY st.id
    HAVING COUNT(sta.article_id) >= 2
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
  const scored = candidates.map(t => {
    const englishRatio   = langMap[t.id] ?? 1.0;
    const nonEngRatio    = 1 - englishRatio;
    const diversityBoost = nonEngRatio > 0.3 ? nonEngRatio * 0.5 : 0;
    return {
      ...t,
      englishRatio,
      diversityScore: Number(t.importance) * (1 + diversityBoost),
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

    if ((categoryCounts[cat] || 0) >= MAX_CATEGORY_REPEAT)              { skipped.push(thread); continue; }
    if (region !== 'global' && (regionCounts[region] || 0) >= MAX_PER_REGION) { skipped.push(thread); continue; }
    if (isEngDominant && englishDomCount >= MAX_ENGLISH_DOMINANT)        { skipped.push(thread); continue; }

    selected.push(thread);
    categoryCounts[cat]    = (categoryCounts[cat]    || 0) + 1;
    regionCounts[region]   = (regionCounts[region]   || 0) + 1;
    if (isEngDominant) englishDomCount++;
  }

  // If we're still short (few threads overall), fill from skipped without caps
  if (selected.length < MAX_THREADS) {
    const selectedIds = new Set(selected.map(t => t.id));
    for (const t of skipped) {
      if (selected.length >= MAX_THREADS) break;
      if (!selectedIds.has(t.id)) selected.push(t);
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
  // Pull top articles for this thread
  const { rows: articles } = await pool.query(`
    SELECT
      a.id, a.title, a.translated_title, a.summary, a.translated_summary,
      a.published_at, a.video_id, a.media_type,
      COALESCE(ns.name, ys.name) AS source_name,
      co.name AS country_name, co.latitude AS lat, co.longitude AS lon,
      ci.name AS city_name, ci.latitude AS city_lat, ci.longitude AS city_lon,
      ci.id AS city_id, co.id AS country_id,
      sta.relevance_score
    FROM story_thread_articles sta
    JOIN news_articles a       ON a.id  = sta.article_id
    LEFT JOIN news_sources ns  ON ns.id = a.source_id
    LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
    LEFT JOIN countries co     ON co.id = a.country_id
    LEFT JOIN cities ci        ON ci.id = a.city_id
    WHERE sta.thread_id = $1
      AND a.published_at > NOW() - INTERVAL '${THREAD_LOOKBACK_DAYS} days'
    ORDER BY sta.relevance_score DESC, a.published_at DESC
    LIMIT $2
  `, [thread.id, MAX_ARTICLES_THREAD]);

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
      // Connect consecutive entity pairs (max 2 arcs per story)
      const maxArcs = Math.min(resolved.length - 1, 2);
      for (let i = 0; i < maxArcs; i++) {
        const from = resolved[i];
        const to   = resolved[i + 1];
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
    if (resolved.length === 1 && thread.primaryCity) {
      const from = resolved[0];
      const city = thread.primaryCity;
      if (Math.abs(from.lat - city.lat) > 0.4 || Math.abs(from.lon - city.lon) > 0.4) {
        arcs.push({
          thread_id: thread.id,
          from_name: from.name, from_lat: from.lat, from_lng: from.lon,
          to_name:   city.name, to_lat:   city.lat, to_lng:   city.lon,
          is_city_arc: true,
        });
      }
      continue;
    }

    // ── FALLBACK: article source countries (old behaviour) ─────────────────
    const countryMap = {};
    const countFreq  = {};
    for (const a of thread.articles) {
      if (a.country_id && a.lat != null) {
        if (!countryMap[a.country_id]) {
          countryMap[a.country_id] = { id: a.country_id, name: a.country_name, lat: parseFloat(a.lat), lng: parseFloat(a.lon) };
        }
        countFreq[a.country_id] = (countFreq[a.country_id] || 0) + 1;
      }
    }
    const geos = Object.values(countryMap);
    if (geos.length < 2) continue;
    geos.sort((a, b) => (countFreq[b.id] || 0) - (countFreq[a.id] || 0));
    const maxFallback = Math.min(geos.length - 1, 2);
    for (let i = 0; i < maxFallback; i++) {
      const from = geos[i], to = geos[i + 1];
      arcs.push({
        thread_id: thread.id,
        from_name: from.name, from_lat: from.lat, from_lng: from.lng,
        to_name:   to.name,   to_lat:   to.lat,   to_lng:   to.lng,
        is_city_arc: false,
      });
    }
  }

  return arcs;
}

// ─── Claude Narrative ──────────────────────────────────────────────────────
async function generateNarrative(threadData) {
  const storySummaries = threadData.map((t, i) => ({
    index:      i + 1,
    thread_id:  t.id,
    title:      t.title,
    category:   t.primary_category,
    importance: t.importance,
    articles:   t.articles.map(a => ({
      title:   a.translated_title || a.title,
      summary: (a.translated_summary || a.summary || '').slice(0, 200),
      source:  a.source_name,
      country: a.country_name,
    }))
  }));

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

STORY DIVERSITY (applied in tone and framing, NOT by skipping stories):
- Write EVERY story in the provided list — do not omit any thread from the segments array.
- If two stories feel similar, distinguish them clearly in tone, geography, or angle. You must still write both.
- Vary the geographic perspective: avoid defaulting to a single national lens across consecutive segments.

Return ONLY valid JSON in this exact structure:
{
  "headline": "Today's briefing headline (max 12 words, present tense)",
  "intro": "Intro paragraph text",
  "segments": [
    {
      "thread_id": <number>,
      "voiceover": "Story segment text",
      "transition": "Transition to next story (omit for last segment)",
      "entities": [
        { "name": "Russia", "type": "country" },
        { "name": "Kyiv", "type": "city" }
      ]
    }
  ],
  "outro": "Closing paragraph text"
}

ENTITY RULES (critical for globe arc visualisation):
- "entities" lists 2–4 geographic locations the story IS ABOUT (not where news sources are from).
- For a Russia-Ukraine conflict story: entities = Russia + Ukraine.
- For a Jeddah drone strike story: entities = Saudi Arabia + Jeddah (city).
- For a US-China trade story: entities = United States + China.
- For a domestic story (e.g. UK election): entities = just that one country.
- Use standard English country names that match a world atlas (e.g. "Iran", "South Korea", "Democratic Republic of Congo").
- Cities must be major, well-known cities — avoid obscure towns.
- type is "country" or "city" only.`;

  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 4096,
    messages:   [{ role: 'user', content: prompt }]
  });

  const text      = response.content[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude returned no valid JSON for narrative');

  return JSON.parse(jsonMatch[0]);
}

// ─── Segment Builder ───────────────────────────────────────────────────────
function buildSegments(narrative, threadData, allArcs, entityCoords = {}) {
  const segments = [];
  const usedArticleIds = new Set();   // prevents same article appearing in two segments

  // Intro segment
  segments.push({
    type:           'intro',
    voiceover_text: narrative.intro,
    globe_animate:  { lat: 20, lng: 0, zoom: 0.9 },
  });

  // Story segments
  for (let i = 0; i < narrative.segments.length; i++) {
    const ns     = narrative.segments[i];
    const thread = threadData.find(t => t.id === ns.thread_id) || threadData[i];
    if (!thread) continue;

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

    segments.push({
      type:                'story',
      thread_id:           thread.id,
      thread_title:        thread.title,
      article_ids:         uniqueIds,
      video_id:            thread.videoId,
      voiceover_text:      ns.voiceover,
      transition:          ns.transition || null,
      globe_focus:         thread.globeFocus,
      primary_city:        thread.primaryCity    || null,
      primary_country:     thread.primaryCountry || null,
      flow_arcs:           arcs,
      secondary_locations: secondaryLocations,
    });
  }

  // Outro segment
  segments.push({
    type:           'outro',
    voiceover_text: narrative.outro,
    globe_animate:  { lat: 20, lng: 0, zoom: 0.9 },
  });

  return segments;
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
async function synthesiseAudio(script) {
  const url  = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`;
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
      'Accept':       'audio/mpeg',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`ElevenLabs error ${res.status}: ${errText}`);
  }

  return Buffer.from(await res.arrayBuffer());
}

// ─── Entry ─────────────────────────────────────────────────────────────────
run().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
