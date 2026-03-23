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
 *   node briefingGenerator.js --force      # regenerate even if today's exists
 *   node briefingGenerator.js --no-audio   # skip ElevenLabs (text only)
 */

'use strict';

require('dotenv').config();
const pool     = require('./db');
const Anthropic = require('@anthropic-ai/sdk');

const client         = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID       = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM'; // Rachel

const FORCE     = process.argv.includes('--force');
const NO_AUDIO  = process.argv.includes('--no-audio');

// ─── Config ────────────────────────────────────────────────────────────────
const MAX_THREADS          = 10;  // stories in one briefing
const MAX_ARTICLES_THREAD  = 3;   // articles shown per story
const MAX_CATEGORY_REPEAT  = 3;   // max threads from same category
const MAX_ENGLISH_DOMINANT = 4;   // max threads where >70% of articles are English-sourced
const MIN_VIDEO_THREADS    = 3;   // at least this many story segments must have a video
const THREAD_LOOKBACK_DAYS = 3;   // only threads active in last N days

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

  // Create/update episode record as 'generating'
  const { rows: [ep] } = await pool.query(`
    INSERT INTO briefing_episodes (user_id, target_date, status, segments)
    VALUES (NULL, $1, 'generating', '[]')
    ON CONFLICT (user_id, target_date) DO UPDATE SET status = 'generating', generated_at = NOW()
    RETURNING id
  `, [targetDate]);
  const episodeId = ep.id;
  console.log(`   [${elapsed(t0)}] Episode id=${episodeId} created`);

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
    const threadData = await Promise.all(threads.map(t => enrichThread(t)));

    // ── 3. Build geographic flow arcs ─────────────────────────────────────
    const allArcs = buildFlowArcs(threadData);

    // ── 4. Generate Claude narrative ──────────────────────────────────────
    console.log(`   [${elapsed(t0)}] Generating narrative with Claude...`);
    const narrative = await generateNarrative(threadData);
    console.log(`   [${elapsed(t0)}] Narrative ready — headline: "${narrative.headline}"`);

    // ── 5. Build segments JSON ────────────────────────────────────────────
    const segments = buildSegments(narrative, threadData, allArcs);

    // ── 6. Generate ElevenLabs audio ──────────────────────────────────────
    let audioData = null;
    if (!NO_AUDIO && ELEVENLABS_KEY) {
      console.log(`   [${elapsed(t0)}] Synthesising audio with ElevenLabs...`);
      const fullScript = buildFullScript(narrative);
      audioData = await synthesiseAudio(fullScript);
      console.log(`   [${elapsed(t0)}] Audio ready — ${(audioData.length / 1024).toFixed(0)}KB`);
    } else if (!NO_AUDIO && !ELEVENLABS_KEY) {
      console.warn(`   ⚠ ELEVENLABS_API_KEY not set — skipping audio`);
    }

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
      JSON.stringify(segments),
      audioData,   // BYTEA or null
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
async function selectThreads() {
  // Step 1: Pull candidate threads with video presence flagged
  const { rows: candidates } = await pool.query(`
    SELECT
      st.id, st.title, st.description, st.importance,
      st.primary_category, st.geographic_scope, st.keywords,
      st.article_count,
      COUNT(sta.article_id)                                           AS recent_articles,
      COUNT(CASE WHEN a.video_id IS NOT NULL THEN 1 END)             AS video_count
    FROM story_threads st
    JOIN story_thread_articles sta ON sta.thread_id = st.id
    JOIN news_articles a ON a.id = sta.article_id
    WHERE st.status = 'active'
      AND st.last_updated_at > NOW() - INTERVAL '${THREAD_LOOKBACK_DAYS} days'
      AND a.published_at  > NOW() - INTERVAL '${THREAD_LOOKBACK_DAYS} days'
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

  // Step 4: Select with caps — category diversity + English-dominance cap
  const selected        = [];
  const skipped         = [];
  const categoryCounts  = {};
  let englishDomCount   = 0;

  for (const thread of scored) {
    if (selected.length >= MAX_THREADS) break;
    const cat              = thread.primary_category || 'general';
    const isEngDominant    = thread.englishRatio > 0.7;

    if ((categoryCounts[cat] || 0) >= MAX_CATEGORY_REPEAT)         { skipped.push(thread); continue; }
    if (isEngDominant && englishDomCount >= MAX_ENGLISH_DOMINANT)  { skipped.push(thread); continue; }

    selected.push(thread);
    categoryCounts[cat] = (categoryCounts[cat] || 0) + 1;
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

  // Pick best video from thread articles
  const videoArticle = articles.find(a => a.video_id) || null;

  // Primary geographic focus — prefer city, fall back to country
  const geoArticle = articles.find(a => a.city_lat || a.lat);
  const globeFocus = geoArticle
    ? { lat: parseFloat(geoArticle.city_lat || geoArticle.lat), lng: parseFloat(geoArticle.city_lon || geoArticle.lon) }
    : null;

  return {
    ...thread,
    articles,
    videoId:    videoArticle?.video_id || null,
    globeFocus,
    articleIds: articles.map(a => a.id),
  };
}

// ─── Flow Arc Detection ────────────────────────────────────────────────────
function buildFlowArcs(threadData) {
  // Build arcs for threads involving multiple countries
  const arcs = [];
  for (const thread of threadData) {
    const countries = [...new Set(thread.articles.map(a => a.country_id).filter(Boolean))];
    if (countries.length < 2) continue;

    // Find geo info for each country from articles
    const countryGeo = {};
    for (const a of thread.articles) {
      if (a.country_id && a.lat && !countryGeo[a.country_id]) {
        countryGeo[a.country_id] = { id: a.country_id, name: a.country_name, lat: a.lat, lng: a.lon };
      }
    }

    const geos = Object.values(countryGeo);
    for (let i = 0; i < geos.length - 1; i++) {
      arcs.push({
        thread_id:    thread.id,
        from_country: geos[i].id,
        to_country:   geos[i + 1].id,
        from_name:    geos[i].name,
        to_name:      geos[i + 1].name,
        from_lat:     parseFloat(geos[i].lat),
        from_lng:     parseFloat(geos[i].lng),
        to_lat:       parseFloat(geos[i + 1].lat),
        to_lng:       parseFloat(geos[i + 1].lng),
        label:        thread.title
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
- Intro: 2-3 natural, engaging sentences welcoming the listener. 40-50 words.
- Each story segment: 55-75 words. Factual, clear, global perspective. No jargon.
- Transitions: 1 sentence naturally bridging stories. Vary them — never reuse phrases.
- Outro: 1-2 warm closing sentences. 20-30 words.
- Total script should be 650-850 words for a ~5-6 minute briefing.
- Write conversationally — this will be spoken aloud by a professional voice.
- Connect stories when genuinely related (e.g. economic ripple effects, diplomatic links).
- This briefing draws from sources in multiple languages and countries. When relevant, surface non-Western or non-English perspectives — e.g. how Beijing, Moscow, Tehran, or Seoul view a story, not just Washington or London. Avoid defaulting to a single national lens.

Return ONLY valid JSON in this exact structure:
{
  "headline": "Today's briefing headline (max 12 words, present tense)",
  "intro": "Intro paragraph text",
  "segments": [
    {
      "thread_id": <number>,
      "voiceover": "Story segment text",
      "transition": "Transition to next story (omit for last segment)"
    }
  ],
  "outro": "Closing paragraph text"
}`;

  const response = await client.messages.create({
    model:      'claude-sonnet-4-5',
    max_tokens: 4096,
    messages:   [{ role: 'user', content: prompt }]
  });

  const text      = response.content[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude returned no valid JSON for narrative');

  return JSON.parse(jsonMatch[0]);
}

// ─── Segment Builder ───────────────────────────────────────────────────────
function buildSegments(narrative, threadData, allArcs) {
  const segments = [];

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

    segments.push({
      type:           'story',
      thread_id:      thread.id,
      thread_title:   thread.title,
      article_ids:    thread.articleIds,
      video_id:       thread.videoId,
      voiceover_text: ns.voiceover,
      transition:     ns.transition || null,
      globe_focus:    thread.globeFocus,
      flow_arcs:      arcs,
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
