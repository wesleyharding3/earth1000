'use strict';
/**
 * locationBriefingGenerator.js
 *
 * Generates an on-demand news briefing scoped to a single city or country node.
 * Called by the server's POST /api/briefing/location endpoint.
 *
 * Differences from the global daily briefing:
 *  - MAX_THREADS = 5  (tighter, location-focused)
 *  - No ElevenLabs audio (returns text + globe data only, ~10s vs ~45s)
 *  - Two-tier thread selection: direct article geo-match → geographic_scope fallback
 *  - 2-hour cache per location to avoid redundant Claude calls
 *  - Location-specific Claude prompt (narrator is focused on that place)
 */

require('dotenv').config();
const pool      = require('./db');
const Anthropic = require('@anthropic-ai/sdk');
const { resolveStoryContexts } = require('./storyTracker');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID       = process.env.ELEVENLABS_VOICE_ID || process.env.ELEVENLABS_VOICE_ID_ENGLISH;

// ─── Config ────────────────────────────────────────────────────────────────
const MAX_THREADS         = 5;
const MAX_ARTICLES_THREAD = 6;
const THREAD_LOOKBACK_DAYS = 5;   // slightly wider than global (3) to find enough local stories
const ARTICLE_LIMIT       = 500;  // raw article fallback search
const CACHE_HOURS         = 2;    // return cached episode if generated within this window

// ─── Helpers ───────────────────────────────────────────────────────────────
function elapsed(t0) { return `+${((Date.now() - t0) / 1000).toFixed(1)}s`; }

// ─── Main export ───────────────────────────────────────────────────────────
/**
 * @param {{ type: 'city'|'country', id: number, name: string, voiceover?: boolean, sourceFilter?: 'local'|'mix'|'global' }} location
 * @returns {Promise<object>}  Full episode row ready to serve to the player
 */
async function generateLocationBriefing(location) {
  const { type, id, name, voiceover = false, sourceFilter = 'mix', customFilter = null, voiceId = null } = location;
  const selectedVoiceId = voiceId || VOICE_ID;
  const t0 = Date.now();
  console.log(`[locBriefing] ${name} (${type} id=${id})`);

  // ── 0. Cache check (only for default mix filter, not custom briefings) ──────
  if (sourceFilter === 'mix' && !customFilter) {
    const { rows: cached } = await pool.query(`
      SELECT id, headline, segments,
             (audio_data IS NOT NULL) AS has_audio, generated_at
      FROM briefing_episodes
      WHERE location_type = $1
        AND location_id   = $2
        AND status        = 'ready'
        AND (audio_data IS NOT NULL) = $3
        AND generated_at  > NOW() - INTERVAL '${CACHE_HOURS} hours'
      ORDER BY generated_at DESC
      LIMIT 1
    `, [type, id, voiceover]);
    if (cached.length) {
      console.log(`[locBriefing] ${elapsed(t0)} cache hit — episode id=${cached[0].id}`);
      return cached[0];
    }
  }

  // ── 1. Create episode record ──────────────────────────────────────────────
  const targetDate = new Date().toISOString().slice(0, 10);
  const { rows: [ep] } = await pool.query(`
    INSERT INTO briefing_episodes
      (user_id, target_date, status, segments, location_type, location_id, location_name)
    VALUES (NULL, $1, 'generating', '[]', $2, $3, $4)
    RETURNING id
  `, [targetDate, customFilter ? 'custom' : type, id || null, name]);
  const episodeId = ep.id;
  console.log(`[locBriefing] ${elapsed(t0)} episode id=${episodeId} created`);

  try {
    // ── 2. Select relevant story threads ──────────────────────────────────────
    let threads;
    if (customFilter) {
      // Custom briefing: build ad-hoc threads from the pre-filtered article set
      console.log(`[locBriefing] ${elapsed(t0)} custom filter mode — building ad-hoc threads`);
      threads = await buildAdHocThreadsFromFilter(customFilter, name);
    } else {
      threads = await selectLocationThreads(type, id, name, sourceFilter);
    }
    console.log(`[locBriefing] ${elapsed(t0)} ${threads.length} threads found`);

    if (!threads.length) {
      await pool.query(
        `UPDATE briefing_episodes SET status='error', headline='No stories found' WHERE id=$1`,
        [episodeId]
      );
      throw new Error(`No active story threads found for ${name}`);
    }

    // ── 3. Enrich threads with articles ───────────────────────────────────────
    const rawThreadData = await Promise.all(threads.map(t => enrichThread(t)));

    // Dedup threads with >50% article overlap (same as global briefing)
    const threadData = [];
    const seenArticles = [];
    for (const thread of rawThreadData) {
      const ids = new Set(thread.articleIds || []);
      if (!ids.size) { threadData.push(thread); continue; }
      const isDuplicate = seenArticles.some(prev => {
        const common = [...ids].filter(i => prev.has(i)).length;
        return common / Math.min(ids.size, prev.size) > 0.5;
      });
      if (!isDuplicate) { threadData.push(thread); seenArticles.push(ids); }
    }
    console.log(`[locBriefing] ${elapsed(t0)} ${threadData.length} threads after dedup`);

    // ── 4. Story continuity ───────────────────────────────────────────────────
    const storyContexts = await resolveStoryContexts(threadData).catch(() => ({}));

    // ── 5. Generate Claude narrative ──────────────────────────────────────────
    console.log(`[locBriefing] ${elapsed(t0)} generating narrative...`);
    const narrative = await generateLocationNarrative(threadData, storyContexts, name, type);
    if (!narrative.segments?.length) throw new Error('Claude returned 0 segments');
    console.log(`[locBriefing] ${elapsed(t0)} narrative ready: "${narrative.headline}"`);

    // ── 6. Resolve entity coordinates ────────────────────────────────────────
    const entityCoords = await resolveEntityCoords(narrative.segments);

    // ── 7. Build flow arcs ────────────────────────────────────────────────────
    const allArcs = buildFlowArcs(threadData, narrative, entityCoords);

    // ── 8. Assemble segments JSON ─────────────────────────────────────────────
    const segments = buildSegments(narrative, threadData, allArcs, entityCoords);

    // ── 9. Optional ElevenLabs voiceover ──────────────────────────────────────
    let audioData = null;
    if (voiceover && ELEVENLABS_KEY) {
      console.log(`[locBriefing] ${elapsed(t0)} synthesising voiceover...`);
      const textPieces = segments.map(seg => {
        const base = seg.voiceover_text || '';
        const tr   = seg.transition ? (' ' + seg.transition) : '';
        return (base + tr).trim();
      });
      const audioBuffers = [];
      const durationsMs  = [];
      for (let pi = 0; pi < textPieces.length; pi++) {
        const text = textPieces[pi];
        if (!text) { audioBuffers.push(Buffer.alloc(0)); durationsMs.push(0); continue; }
        try {
          const buf = await synthesiseAudio(text, selectedVoiceId);
          audioBuffers.push(buf);
          durationsMs.push(Math.round((buf.byteLength * 8) / 128));
          console.log(`[locBriefing] ${elapsed(t0)} audio piece ${pi + 1}/${textPieces.length} — ${(buf.byteLength / 1024).toFixed(0)}KB`);
        } catch (err) {
          console.warn(`[locBriefing] audio piece ${pi} failed: ${err.message}`);
          audioBuffers.push(Buffer.alloc(0)); durationsMs.push(0);
        }
      }
      let cumMs = 0;
      for (let si = 0; si < segments.length; si++) {
        segments[si].start_ms = cumMs;
        cumMs += durationsMs[si];
      }
      audioData = Buffer.concat(audioBuffers.filter(b => b.byteLength > 0));
      console.log(`[locBriefing] ${elapsed(t0)} audio ready — ${(audioData.length / 1024).toFixed(0)}KB`);
    } else if (voiceover && !ELEVENLABS_KEY) {
      console.warn('[locBriefing] voiceover requested but ELEVENLABS_API_KEY not set — skipping');
    }

    // ── 10. Save episode ───────────────────────────────────────────────────────
    await pool.query(`
      UPDATE briefing_episodes
      SET status     = 'ready',
          headline   = $1,
          segments   = $2,
          audio_data = $3,
          generated_at = NOW()
      WHERE id = $4
    `, [narrative.headline, JSON.stringify(segments), audioData, episodeId]);

    console.log(`[locBriefing] ${elapsed(t0)} done — ${segments.length} segments${audioData ? ' + audio' : ''}`);

    return {
      id:         episodeId,
      headline:   narrative.headline,
      segments,
      has_audio:  !!audioData,
      location_type: type,
      location_id:   id,
      location_name: name,
    };

  } catch (err) {
    await pool.query(
      `UPDATE briefing_episodes SET status='error' WHERE id=$1`, [episodeId]
    );
    throw err;
  }
}

// ─── Thread selection ────────────────────────────────────────────────────
async function selectLocationThreads(type, id, name, sourceFilter = 'mix') {
  const geoCol = type === 'city' ? 'a.city_id' : 'a.country_id';

  // ── Tier 1: threads with articles directly geo-tagged to this location (local) ──
  const fetchTier1 = () => pool.query(`
    SELECT
      st.id, st.title, st.description, st.importance,
      st.primary_category, st.geographic_scope, st.keywords,
      COUNT(sta.article_id) AS recent_articles,
      COUNT(CASE WHEN a.video_id IS NOT NULL THEN 1 END) AS video_count
    FROM story_threads st
    JOIN story_thread_articles sta ON sta.thread_id = st.id
    JOIN news_articles a           ON a.id = sta.article_id
    WHERE st.status = 'active'
      AND st.last_updated_at > NOW() - INTERVAL '${THREAD_LOOKBACK_DAYS} days'
      AND a.published_at     > NOW() - INTERVAL '${THREAD_LOOKBACK_DAYS} days'
      AND ${geoCol} = $1
    GROUP BY st.id
    HAVING COUNT(sta.article_id) >= 2
    ORDER BY st.importance DESC, COUNT(sta.article_id) DESC
    LIMIT ${MAX_THREADS * 3}
  `, [id]).then(r => r.rows);

  // ── Tier 2: threads mentioning the location by name (global perspective) ──
  const fetchTier2 = (excludeIds = new Set()) => pool.query(`
    SELECT
      st.id, st.title, st.description, st.importance,
      st.primary_category, st.geographic_scope, st.keywords,
      COUNT(sta.article_id) AS recent_articles,
      COUNT(CASE WHEN a.video_id IS NOT NULL THEN 1 END) AS video_count
    FROM story_threads st
    JOIN story_thread_articles sta ON sta.thread_id = st.id
    JOIN news_articles a           ON a.id = sta.article_id
    WHERE st.status = 'active'
      AND st.last_updated_at > NOW() - INTERVAL '${THREAD_LOOKBACK_DAYS} days'
      AND a.published_at     > NOW() - INTERVAL '${THREAD_LOOKBACK_DAYS} days'
      AND (st.title ILIKE $1 OR st.description ILIKE $1)
    GROUP BY st.id
    HAVING COUNT(sta.article_id) >= 1
    ORDER BY st.importance DESC, COUNT(sta.article_id) DESC
    LIMIT ${MAX_THREADS * 3}
  `, [`%${name}%`]).then(r => r.rows.filter(t => !excludeIds.has(t.id)));

  // ── local only ────────────────────────────────────────────────────────────
  if (sourceFilter === 'local') {
    const tier1 = await fetchTier1();
    if (tier1.length >= MAX_THREADS) return selectDiverse(tier1, MAX_THREADS);
    const fallback = await buildAdHocThreads(type, id, name);
    const t1Ids = new Set(tier1.map(t => t.id));
    return selectDiverse([...tier1, ...fallback.filter(t => !t1Ids.has(t.id))], MAX_THREADS);
  }

  // ── global only ───────────────────────────────────────────────────────────
  if (sourceFilter === 'global') {
    const tier2 = await fetchTier2();
    if (!tier2.length) throw new Error(`No global story threads found mentioning ${name}`);
    return selectDiverse(tier2, MAX_THREADS);
  }

  // ── mix (default): 3 local + 2 global ────────────────────────────────────
  const LOCAL_SLOTS  = 3;
  const GLOBAL_SLOTS = MAX_THREADS - LOCAL_SLOTS; // 2

  const tier1 = await fetchTier1();
  let localThreads = selectDiverse(tier1, LOCAL_SLOTS);

  if (localThreads.length < LOCAL_SLOTS) {
    console.log(`[locBriefing] only ${tier1.length} Tier-1 threads — supplementing with ad-hoc`);
    const fallback = await buildAdHocThreads(type, id, name);
    const t1Ids = new Set(tier1.map(t => t.id));
    localThreads = selectDiverse([...tier1, ...fallback.filter(t => !t1Ids.has(t.id))], LOCAL_SLOTS);
  }

  const localIds = new Set(localThreads.map(t => t.id));
  const tier2 = await fetchTier2(localIds);
  const globalThreads = selectDiverse(tier2, GLOBAL_SLOTS);

  const combined = [...localThreads, ...globalThreads];
  if (!combined.length) throw new Error(`No story threads found for ${name}`);
  return combined;
}

// Simple diversity selection: cap at 2 threads per category
function selectDiverse(candidates, limit) {
  const catCounts = {};
  const selected = [];
  for (const t of candidates) {
    const cat = t.primary_category || 'other';
    if ((catCounts[cat] || 0) >= 2) continue;
    catCounts[cat] = (catCounts[cat] || 0) + 1;
    selected.push(t);
    if (selected.length >= limit) break;
  }
  // Fill remaining slots if diversity cap left us short
  if (selected.length < limit) {
    const selectedIds = new Set(selected.map(t => t.id));
    for (const t of candidates) {
      if (!selectedIds.has(t.id)) {
        selected.push(t);
        if (selected.length >= limit) break;
      }
    }
  }
  return selected.slice(0, limit);
}

// Build lightweight ad-hoc thread objects from raw articles when no real threads exist
async function buildAdHocThreads(type, id, name) {
  const geoCol = type === 'city' ? 'a.city_id' : 'a.country_id';
  const { rows: articles } = await pool.query(`
    SELECT
      a.id, a.title, a.translated_title, a.summary, a.translated_summary,
      a.published_at, a.video_id, a.country_id, a.city_id,
      COALESCE(ak_agg.keywords, '{}') AS keywords,
      COALESCE(ns.name, ys.name) AS source_name,
      co.name AS country_name, co.latitude AS lat, co.longitude AS lon,
      ci.name AS city_name, ci.latitude AS city_lat, ci.longitude AS city_lon
    FROM news_articles a
    LEFT JOIN news_sources ns    ON ns.id = a.source_id
    LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
    LEFT JOIN countries co       ON co.id = a.country_id
    LEFT JOIN cities ci          ON ci.id = a.city_id
    LEFT JOIN LATERAL (
      SELECT ARRAY_AGG(COALESCE(normalized_keyword, keyword) ORDER BY frequency DESC) AS keywords
      FROM article_keywords WHERE article_id = a.id
    ) ak_agg ON true
    WHERE ${geoCol} = $1
      AND a.published_at > NOW() - INTERVAL '${THREAD_LOOKBACK_DAYS} days'
      AND a.title IS NOT NULL
    ORDER BY a.published_at DESC
    LIMIT $2
  `, [id, ARTICLE_LIMIT]);

  if (!articles.length) return [];

  // Group by shared keywords into ad-hoc "threads" (clusters of 2-6 articles)
  const clusters = [];
  const used = new Set();
  for (let i = 0; i < articles.length && clusters.length < MAX_THREADS; i++) {
    if (used.has(i)) continue;
    const anchor = articles[i];
    const anchorKws = new Set((anchor.keywords || []).slice(0, 5));
    const group = [anchor];
    used.add(i);
    for (let j = i + 1; j < articles.length && group.length < MAX_ARTICLES_THREAD; j++) {
      if (used.has(j)) continue;
      const other = articles[j];
      const shared = (other.keywords || []).filter(k => anchorKws.has(k));
      if (shared.length >= 2) { group.push(other); used.add(j); }
    }
    clusters.push({
      id:               -(clusters.length + 1), // negative IDs flag ad-hoc threads
      title:            anchor.translated_title || anchor.title || name,
      description:      '',
      importance:       5,
      primary_category: 'general',
      geographic_scope: [name],
      keywords:         [...anchorKws],
      recent_articles:  group.length,
      video_count:      group.filter(a => a.video_id).length,
      _adHoc:           true,
      _articles:        group,
    });
  }
  return clusters;
}

// ─── Custom filter → ad-hoc threads ────────────────────────────────────────
// Used when the briefing was requested via /api/briefing/custom with arbitrary
// from/about/keyword filters rather than a geo-tagged node.
async function buildAdHocThreadsFromFilter(customFilter, name) {
  const { sqlWhere, sqlParams } = customFilter;
  const { rows: articles } = await pool.query(`
    SELECT
      a.id, a.title, a.translated_title, a.summary, a.translated_summary,
      a.published_at, a.video_id, a.country_id, a.city_id,
      COALESCE(ak_agg.keywords, '{}') AS keywords,
      COALESCE(ns.name, ys.name) AS source_name,
      co.name AS country_name, co.latitude AS lat, co.longitude AS lon,
      ci.name AS city_name, ci.latitude AS city_lat, ci.longitude AS city_lon
    FROM news_articles a
    LEFT JOIN news_sources ns    ON ns.id = a.source_id
    LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
    LEFT JOIN countries co       ON co.id = a.country_id
    LEFT JOIN cities ci          ON ci.id = a.city_id
    LEFT JOIN LATERAL (
      SELECT ARRAY_AGG(COALESCE(normalized_keyword, keyword) ORDER BY frequency DESC) AS keywords
      FROM article_keywords WHERE article_id = a.id
    ) ak_agg ON true
    WHERE ${sqlWhere}
      AND a.title IS NOT NULL
    ORDER BY RANDOM()
    LIMIT ${ARTICLE_LIMIT}
  `, sqlParams);

  if (!articles.length) return [];

  // Same keyword-cluster logic as buildAdHocThreads
  const clusters = [];
  const used = new Set();
  for (let i = 0; i < articles.length && clusters.length < MAX_THREADS; i++) {
    if (used.has(i)) continue;
    const anchor   = articles[i];
    const anchorKws = new Set((anchor.keywords || []).slice(0, 5));
    const group    = [anchor];
    used.add(i);
    for (let j = i + 1; j < articles.length && group.length < MAX_ARTICLES_THREAD; j++) {
      if (used.has(j)) continue;
      const other  = articles[j];
      const shared = (other.keywords || []).filter(k => anchorKws.has(k));
      if (shared.length >= 2) { group.push(other); used.add(j); }
    }
    clusters.push({
      id:               -(clusters.length + 1),
      title:            anchor.translated_title || anchor.title || name,
      description:      '',
      importance:       5,
      primary_category: 'general',
      geographic_scope: [name],
      keywords:         [...anchorKws],
      recent_articles:  group.length,
      video_count:      group.filter(a => a.video_id).length,
      _adHoc:           true,
      _articles:        group,
    });
  }
  return clusters;
}

// ─── Thread enrichment ───────────────────────────────────────────────────
async function enrichThread(thread) {
  // Ad-hoc threads already have their articles
  if (thread._adHoc) {
    const articles = thread._articles || [];
    const geoArticle = articles.find(a => a.city_lat || a.lat);
    return {
      ...thread,
      articles,
      articleIds: articles.map(a => a.id),
      primaryCity: geoArticle ? {
        name: geoArticle.city_name,
        lat:  parseFloat(geoArticle.city_lat),
        lon:  parseFloat(geoArticle.city_lon),
      } : null,
      globeFocus: geoArticle ? {
        lat: parseFloat(geoArticle.city_lat || geoArticle.lat),
        lng: parseFloat(geoArticle.city_lon || geoArticle.lon),
      } : null,
      hasVideo: articles.some(a => a.video_id),
    };
  }

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

  const geoArticle = articles.find(a => a.city_lat || a.lat);
  const hasVideo   = articles.some(a => a.video_id);

  return {
    ...thread,
    articles,
    articleIds: articles.map(a => a.id),
    primaryCity: geoArticle?.city_lat ? {
      name: geoArticle.city_name,
      lat:  parseFloat(geoArticle.city_lat),
      lon:  parseFloat(geoArticle.city_lon),
    } : null,
    globeFocus: geoArticle ? {
      lat: parseFloat(geoArticle.city_lat || geoArticle.lat),
      lng: parseFloat(geoArticle.city_lon || geoArticle.lon),
    } : null,
    hasVideo,
  };
}

// ─── Claude narrative (location-focused prompt) ──────────────────────────
async function generateLocationNarrative(threadData, storyContexts, locationName, locationType) {
  const nowMs = Date.now();
  const storySummaries = threadData.map((t, i) => {
    const dates = (t.articles || [])
      .map(a => a.published_at ? new Date(a.published_at).getTime() : 0)
      .filter(Boolean);
    const newestMs = dates.length ? Math.max(...dates) : 0;
    const daysAgo  = newestMs ? Math.round((nowMs - newestMs) / 86400000) : null;
    const oldestMs = dates.length ? Math.min(...dates) : 0;
    const spanDays = (newestMs && oldestMs) ? Math.round((newestMs - oldestMs) / 86400000) : 0;

    const ctx = storyContexts[String(t.id)];
    const continuity = ctx?.isOngoing
      ? { is_ongoing: true, briefing_day_number: ctx.dayNumber, previously_known_as: ctx.canonicalTitle }
      : { is_ongoing: false, briefing_day_number: 1 };

    return {
      index:                   i + 1,
      thread_id:               t.id,
      title:                   t.title,
      category:                t.primary_category,
      importance:              t.importance,
      newest_article_days_ago: daysAgo,
      article_span_days:       spanDays,
      ...continuity,
      articles: (t.articles || []).map(a => ({
        title:        a.translated_title || a.title,
        summary:      (a.translated_summary || a.summary || '').slice(0, 200),
        source:       a.source_name,
        country:      a.country_name,
        published_at: a.published_at?.toISOString?.() || String(a.published_at || ''),
      })),
    };
  });

  const today = new Date().toLocaleDateString('en-US', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });

  const locLabel = locationType === 'city' ? `the city of ${locationName}` : locationName;

  const prompt = `You are a world-class broadcast news anchor writing a focused news briefing specifically about ${locLabel} for Earth, a platform that presents world news through an interactive globe.

Today is ${today}. Write a complete, broadcast-quality briefing script covering the following ${threadData.length} stories — all of which relate to or affect ${locationName}.

STORIES:
${JSON.stringify(storySummaries, null, 2)}

REQUIREMENTS:
- Intro: 2-3 sentences opening on ${locationName} specifically. 35-45 words. Frame the briefing as a focused look at what's happening in or around ${locLabel}. NEVER use time-of-day greetings.
- Each story segment: 55-75 words. Factual, clear. Always connect the story back to its relevance for ${locationName} or its people.
- Transitions: 1 sentence bridging stories, vary them.
- Summary: After the last story, a rapid-fire 2-3 sentence recap hitting the headline of each story in sequence. 40-60 words. Spoken like a news bulletin summary: "In summary — [headline 1]. [headline 2]. [headline 3]..."
- Outro: 1-2 warm closing sentences referencing ${locationName}. 15-25 words.
- Write conversationally — this will be read on-screen as text.

RECENCY FRAMING:
- newest_article_days_ago <= 2: frame as breaking or developing news.
- 3–7 days: current/active story.
- > 7 days: ongoing situation or aftermath. NEVER re-announce old events as if just happened.

STORY CONTINUITY:
- is_ongoing = true and briefing_day_number >= 2: open with "Continuing our coverage..." or "An update on...". Vary phrasing.
- is_ongoing = false: introduce fresh.
- Never say "Day 1".

CRITICAL THREAD_ID RULE: Every segment's "thread_id" must be one of these exact integers:
${storySummaries.map(s => s.thread_id).join(', ')}

CONTENT GUARDRAILS:
- Do NOT report deaths or removals from power of sitting heads of state unless explicitly confirmed in the provided articles.
- Write EVERY story in the provided list — do not omit any.

Return ONLY valid JSON:
{
  "headline": "Briefing headline focused on ${locationName} (max 12 words)",
  "intro": "Intro paragraph",
  "segments": [
    {
      "thread_id": <exact integer from the list above>,
      "voiceover": "Story segment text",
      "transition": "Transition sentence (omit for last segment)",
      "entities": [
        { "name": "CountryOrCityName", "type": "country" }
      ]
    }
  ],
  "summary": "Rapid-fire recap of all stories: In summary — [headline 1]. [headline 2]...",
  "outro": "Closing paragraph"
}

ENTITY RULES:
- 2-4 geographic locations the story IS ABOUT.
- First entity = primary subject.
- Standard English names matching a world atlas.
- type = "country" or "city" only.`;

  const response = await client.messages.create({
    model:      'claude-sonnet-4-6',
    max_tokens: 3000,
    messages:   [{ role: 'user', content: prompt }],
  });

  const text      = response.content[0].text;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude returned no valid JSON');
  return JSON.parse(jsonMatch[0]);
}

// ─── Entity coordinate resolution ───────────────────────────────────────
async function resolveEntityCoords(segments) {
  const names = new Set();
  for (const seg of segments) {
    for (const e of (seg.entities || [])) { if (e.name) names.add(e.name); }
  }
  if (!names.size) return {};

  const nameArr   = [...names];
  const nameLower = nameArr.map(n => n.toLowerCase());
  const coords    = {};

  const { rows: cRows } = await pool.query(
    `SELECT name, latitude AS lat, longitude AS lon FROM countries WHERE LOWER(name) = ANY($1::text[])`,
    [nameLower]
  );
  for (const r of cRows) {
    const orig = nameArr.find(n => n.toLowerCase() === r.name.toLowerCase());
    if (orig) coords[orig] = { lat: parseFloat(r.lat), lon: parseFloat(r.lon), type: 'country' };
  }

  const remaining = nameArr.filter(n => !coords[n]);
  if (remaining.length) {
    const { rows: ciRows } = await pool.query(
      `SELECT name, latitude AS lat, longitude AS lon FROM cities WHERE LOWER(name) = ANY($1::text[])`,
      [remaining.map(n => n.toLowerCase())]
    );
    for (const r of ciRows) {
      const orig = remaining.find(n => n.toLowerCase() === r.name.toLowerCase());
      if (orig) coords[orig] = { lat: parseFloat(r.lat), lon: parseFloat(r.lon), type: 'city' };
    }
  }
  return coords;
}

// ─── Flow arcs ────────────────────────────────────────────────────────────
function buildFlowArcs(threadData, narrative, entityCoords) {
  const arcs = [];
  for (let ni = 0; ni < narrative.segments.length; ni++) {
    const ns     = narrative.segments[ni];
    const thread = threadData.find(t => String(t.id) === String(ns.thread_id)) || threadData[ni];
    if (!thread) continue;

    const resolved = (ns.entities || [])
      .map(e => ({ name: e.name, type: e.type, ...entityCoords[e.name] }))
      .filter(e => e.lat != null);

    if (resolved.length >= 2) {
      const maxArcs = Math.min(resolved.length - 1, 2);
      for (let i = 0; i < maxArcs; i++) {
        const from = resolved[i], to = resolved[i + 1];
        arcs.push({
          thread_id:    thread.id,
          from_name: from.name, from_lat: from.lat, from_lng: from.lon,
          to_name:   to.name,   to_lat:   to.lat,   to_lng:   to.lon,
          is_city_arc: from.type === 'city' || to.type === 'city',
        });
      }
      continue;
    }

    if (resolved.length === 1 && thread.primaryCity) {
      const from = resolved[0], city = thread.primaryCity;
      if (Math.abs(from.lat - city.lat) > 0.4 || Math.abs(from.lon - city.lon) > 0.4) {
        arcs.push({
          thread_id: thread.id,
          from_name: from.name, from_lat: from.lat, from_lng: from.lon,
          to_name: city.name,   to_lat:   city.lat,  to_lng:  city.lon,
          is_city_arc: true,
        });
      }
      continue;
    }

    // Fallback: article source countries
    const countryMap = {}, countFreq = {};
    for (const a of thread.articles) {
      if (a.country_id && a.lat != null) {
        if (!countryMap[a.country_id]) {
          countryMap[a.country_id] = { id: a.country_id, name: a.country_name, lat: parseFloat(a.lat), lng: parseFloat(a.lon) };
        }
        countFreq[a.country_id] = (countFreq[a.country_id] || 0) + 1;
      }
    }
    const geos = Object.values(countryMap).sort((a, b) => (countFreq[b.id]||0) - (countFreq[a.id]||0));
    if (geos.length >= 2) {
      arcs.push({
        thread_id: thread.id,
        from_name: geos[0].name, from_lat: geos[0].lat, from_lng: geos[0].lng,
        to_name:   geos[1].name, to_lat:   geos[1].lat,  to_lng:  geos[1].lng,
        is_city_arc: false,
      });
    }
  }
  return arcs;
}

// ─── Segment assembly ────────────────────────────────────────────────────
function buildSegments(narrative, threadData, allArcs, entityCoords) {
  const segments = [];

  // Intro
  segments.push({
    type: 'intro',
    voiceover_text: narrative.intro || '',
    primary_country: null,
    primary_city: null,
    article_ids: [],
    arcs: [],
    entities: [],
    start_ms: null,
  });

  // Story segments
  for (const ns of (narrative.segments || [])) {
    const thread = threadData.find(t => String(t.id) === String(ns.thread_id));
    if (!thread) continue;

    const segArcs = allArcs
      .filter(a => String(a.thread_id) === String(ns.thread_id))
      .map(a => ({
        from: { name: a.from_name, lat: a.from_lat, lng: a.from_lng },
        to:   { name: a.to_name,   lat: a.to_lat,   lng: a.to_lng   },
        is_city_arc: a.is_city_arc,
      }));

    const primaryEntity = (ns.entities || [])[0];
    const primaryCoords = primaryEntity ? entityCoords[primaryEntity.name] : null;

    let primaryCountry = null, primaryCity = null;
    if (primaryEntity?.type === 'city') {
      primaryCity    = { name: primaryEntity.name, ...(primaryCoords || {}) };
    } else if (primaryEntity?.type === 'country') {
      primaryCountry = { name: primaryEntity.name, ...(primaryCoords || {}) };
    }
    if (!primaryCity && thread.primaryCity) primaryCity = thread.primaryCity;

    const voiceoverText = [ns.voiceover || '', ns.transition || ''].filter(Boolean).join(' ');

    segments.push({
      type:            'story',
      thread_id:       thread.id,
      thread_title:    thread.title,
      voiceover_text:  voiceoverText,
      primary_country: primaryCountry,
      primary_city:    primaryCity,
      article_ids:     (thread.articleIds || []).slice(0, 6),
      video_id:        thread.hasVideo ? (thread.articles.find(a => a.video_id)?.video_id || null) : null,
      arcs:            segArcs,
      entities:        ns.entities || [],
      geographic_scope: thread.geographic_scope || [],
      start_ms:        null,
    });
  }

  // Summary segment (rapid-fire recap of all stories before outro)
  if (narrative.summary) {
    const allArticleIds = [...new Set(threadData.flatMap(t => (t.articleIds || []).slice(0, 2)))].slice(0, 8);
    segments.push({
      type: 'summary',
      voiceover_text: narrative.summary,
      primary_country: null,
      primary_city: null,
      article_ids: allArticleIds,
      arcs: [],
      entities: [],
      start_ms: null,
    });
  }

  // Outro
  segments.push({
    type: 'outro',
    voiceover_text: narrative.outro || '',
    primary_country: null,
    primary_city: null,
    article_ids: [],
    arcs: [],
    entities: [],
    start_ms: null,
  });

  return segments;
}

// ─── ElevenLabs TTS ─────────────────────────────────────────────────────────
async function synthesiseAudio(script, voiceId = VOICE_ID) {
  const url  = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
  const body = {
    text:       script,
    model_id:   'eleven_multilingual_v2',
    voice_settings: { stability: 0.55, similarity_boost: 0.75, style: 0.20, use_speaker_boost: true },
  };
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'xi-api-key': ELEVENLABS_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`ElevenLabs ${res.status}: ${await res.text()}`);
  return Buffer.from(await res.arrayBuffer());
}

module.exports = { generateLocationBriefing };
