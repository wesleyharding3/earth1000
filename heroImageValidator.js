#!/usr/bin/env node
/**
 * heroImageValidator.js
 *
 * Proactive dead-hero-image detector for threads + lines.
 *
 * Scope (keep tight):
 *   • Every image_url on articles attached to an active OR cooling
 *     thread or line.
 *   • Every catalog image_assets.public_url used as hero-assigned for
 *     those same articles (via article_image_assignments).
 *   • Dormant threads, dormant lines, unlinked articles — NOT checked.
 *
 * HEAD-check policy (design decision):
 *   • HTTP 4xx / 5xx             → dead
 *   • Timeout > 8s               → dead
 *   • Non-image Content-Type     → dead  (publisher serving HTML redirect)
 *   • Redirect chain > 3 hops    → dead
 *   • 2xx + image/*              → alive. If previously marked dead, REVIVE.
 *
 * Persistence:
 *   • news_articles.image_dead_at TIMESTAMPTZ — set to NOW() on dead, cleared on revive.
 *   • image_assets.dead_at TIMESTAMPTZ        — same, for catalog images.
 *
 * Cache:
 *   • After any state change, delete affected thread / timeline keys from
 *     server.js's _ttlCache so the next request picks up the new hero
 *     immediately instead of serving a 5-minute stale dead URL.
 *
 * Scheduling:
 *   • This script is invoked externally (Render cron). No self-scheduling.
 *
 * Usage:
 *     node heroImageValidator.js             # standard run
 *     node heroImageValidator.js --dry-run   # report, no DB writes, no cache clear
 *     node heroImageValidator.js --revival   # ALSO re-check URLs marked dead > 7d ago
 *     node heroImageValidator.js --limit=500 # cap URL count (debug)
 */
'use strict';

require('dotenv').config({ override: true });
const pool = require('./db');

// ─── CLI flags ────────────────────────────────────────────────────────────
const DRY_RUN = process.argv.includes('--dry-run');
const WITH_REVIVAL = process.argv.includes('--revival');
const URL_LIMIT = (() => {
  const flag = process.argv.find(a => a.startsWith('--limit='));
  return flag ? Math.max(1, parseInt(flag.split('=')[1], 10) || 0) : null;
})();

// ─── Tunables ─────────────────────────────────────────────────────────────
const TIMEOUT_MS          = 8000;   // per-URL HEAD timeout. 4xx/5xx/timeout all → dead.
const CONCURRENCY         = 25;     // parallel fetch workers
const MAX_REDIRECTS       = 3;      // follow up to 3 hops; more = dead
const REVIVAL_MIN_AGE_MS  = 7 * 24 * 60 * 60 * 1000;   // re-check dead URLs older than 7d

async function main() {
  const t0 = Date.now();
  console.log(`\n🖼️  Hero image validator — ${new Date().toISOString()}`);
  console.log(`   dry_run=${DRY_RUN} revival=${WITH_REVIVAL} timeout=${TIMEOUT_MS}ms concurrency=${CONCURRENCY}`);

  // ── 1. Gather URLs in scope ────────────────────────────────────────────
  const scope = await gatherScope();
  console.log(`   articles in scope: ${scope.articles.length} (news_articles.image_url)`);
  console.log(`   catalog images:    ${scope.assets.length}   (image_assets.public_url)`);

  let urls = [
    ...scope.articles.map(r => ({ kind: 'article', id: r.id, url: r.image_url, was_dead: !!r.image_dead_at })),
    ...scope.assets.map(r   => ({ kind: 'asset',   id: r.id, url: r.public_url, was_dead: !!r.dead_at })),
  ];

  if (URL_LIMIT) urls = urls.slice(0, URL_LIMIT);
  console.log(`   total URLs to check: ${urls.length}`);

  if (!urls.length) {
    console.log('   nothing to validate — exiting.');
    await pool.end();
    return;
  }

  // ── 2. HEAD-check all URLs in parallel (bounded) ───────────────────────
  const results = await runValidation(urls);

  // ── 3. Tally + apply ──────────────────────────────────────────────────
  const tally = {
    alive_still:    0,
    alive_revived:  0,  // was dead in DB, now alive
    dead_new:       0,  // was alive in DB, now dead
    dead_still:     0,
    errors:         0,
  };
  const toMarkDead_articles  = [];
  const toReviveArticles     = [];
  const toMarkDead_assets    = [];
  const toReviveAssets       = [];
  const affectedArticleIds   = new Set();
  const affectedAssetIds     = new Set();

  for (const r of results) {
    if (r.err) { tally.errors++; continue; }

    if (r.alive) {
      if (r.was_dead) {
        tally.alive_revived++;
        if (r.kind === 'article') toReviveArticles.push(r.id);
        else                       toReviveAssets.push(r.id);
        if (r.kind === 'article')  affectedArticleIds.add(r.id);
        else                       affectedAssetIds.add(r.id);
      } else {
        tally.alive_still++;
      }
    } else {
      if (r.was_dead) {
        tally.dead_still++;
      } else {
        tally.dead_new++;
        if (r.kind === 'article') toMarkDead_articles.push(r.id);
        else                       toMarkDead_assets.push(r.id);
        if (r.kind === 'article')  affectedArticleIds.add(r.id);
        else                       affectedAssetIds.add(r.id);
      }
    }
  }

  console.log('');
  console.log(`   alive_still:    ${tally.alive_still}`);
  console.log(`   alive_revived:  ${tally.alive_revived}`);
  console.log(`   dead_new:       ${tally.dead_new}`);
  console.log(`   dead_still:     ${tally.dead_still}`);
  console.log(`   errors:         ${tally.errors}`);

  if (!DRY_RUN) {
    if (toMarkDead_articles.length) {
      await pool.query(
        `UPDATE news_articles SET image_dead_at = NOW() WHERE id = ANY($1::int[]) AND image_dead_at IS NULL`,
        [toMarkDead_articles]
      );
    }
    if (toReviveArticles.length) {
      await pool.query(
        `UPDATE news_articles SET image_dead_at = NULL WHERE id = ANY($1::int[]) AND image_dead_at IS NOT NULL`,
        [toReviveArticles]
      );
    }
    if (toMarkDead_assets.length) {
      await pool.query(
        `UPDATE image_assets SET dead_at = NOW() WHERE id = ANY($1::int[]) AND dead_at IS NULL`,
        [toMarkDead_assets]
      );
    }
    if (toReviveAssets.length) {
      await pool.query(
        `UPDATE image_assets SET dead_at = NULL WHERE id = ANY($1::int[]) AND dead_at IS NOT NULL`,
        [toReviveAssets]
      );
    }

    // ── 4. Clear ttlCache entries for affected threads/lines ─────────────
    // Any article whose state flipped → invalidate every thread + timeline
    // the article is attached to, so the next request picks up the new hero
    // instead of serving a 5-minute stale dead URL.
    if (affectedArticleIds.size + affectedAssetIds.size > 0) {
      await invalidateDownstreamCaches([...affectedArticleIds], [...affectedAssetIds]);
    }
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n✅ Done in ${secs}s${DRY_RUN ? '  (dry run — no writes)' : ''}.\n`);
  await pool.end();
}

// ═════════════════════════════════════════════════════════════════════════
//  Scope queries
// ═════════════════════════════════════════════════════════════════════════

/**
 * Collect every image_url / asset public_url that could surface as a hero
 * on an active or cooling thread or line. Includes ALL attached articles,
 * not just the current hero — so when the hero dies the next candidate is
 * already pre-validated and surfaces cleanly.
 */
async function gatherScope() {
  // Articles: union of (attached to active/cooling thread) + (attached to
  // active/cooling line). DISTINCT so an article on multiple threads is
  // checked once.
  const { rows: articles } = await pool.query(`
    WITH hero_pool_articles AS (
      SELECT a.id, a.image_url, a.image_dead_at
      FROM story_thread_articles sta
      JOIN story_threads t  ON t.id = sta.thread_id
      JOIN news_articles  a ON a.id = sta.article_id
      WHERE t.status IN ('active','cooling')
        AND a.image_url IS NOT NULL
        AND a.image_url <> ''
      UNION
      SELECT a.id, a.image_url, a.image_dead_at
      FROM story_timeline_articles sta
      JOIN story_timelines tl ON tl.id = sta.timeline_id
      JOIN news_articles    a  ON a.id = sta.article_id
      WHERE tl.status IN ('active','cooling')
        AND a.image_url IS NOT NULL
        AND a.image_url <> ''
    )
    SELECT id, image_url, image_dead_at
    FROM hero_pool_articles
    ${WITH_REVIVAL
      ? ''
      : `WHERE image_dead_at IS NULL OR image_dead_at < NOW() - INTERVAL '${Math.floor(REVIVAL_MIN_AGE_MS / 1000)} seconds'`}
  `);

  // Catalog images assigned to the same pool (article_image_assignments
  // gives us the bucket images the hero SQL falls back to).
  const { rows: assets } = await pool.query(`
    WITH hero_pool_articles AS (
      SELECT DISTINCT sta.article_id
      FROM story_thread_articles sta
      JOIN story_threads t ON t.id = sta.thread_id
      WHERE t.status IN ('active','cooling')
      UNION
      SELECT DISTINCT sta.article_id
      FROM story_timeline_articles sta
      JOIN story_timelines tl ON tl.id = sta.timeline_id
      WHERE tl.status IN ('active','cooling')
    )
    SELECT DISTINCT img.id, img.public_url, img.dead_at
    FROM image_assets img
    JOIN article_image_assignments aia ON aia.image_id = img.id
    JOIN hero_pool_articles p         ON p.article_id = aia.article_id
    WHERE img.public_url IS NOT NULL
    ${WITH_REVIVAL
      ? ''
      : `AND (img.dead_at IS NULL OR img.dead_at < NOW() - INTERVAL '${Math.floor(REVIVAL_MIN_AGE_MS / 1000)} seconds')`}
  `);

  return { articles, assets };
}

// ═════════════════════════════════════════════════════════════════════════
//  HEAD-check worker pool
// ═════════════════════════════════════════════════════════════════════════

async function runValidation(urls) {
  const results = new Array(urls.length);
  let next = 0;

  async function worker() {
    while (true) {
      const i = next++;
      if (i >= urls.length) break;
      const u = urls[i];
      try {
        const verdict = await checkUrl(u.url);
        results[i] = { ...u, ...verdict };
      } catch (err) {
        results[i] = { ...u, err: err.message, alive: false };
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, urls.length) }, () => worker())
  );
  return results;
}

/**
 * HEAD-check a single URL with the dead-criteria from the design:
 *   - 4xx/5xx → dead
 *   - timeout > 8s → dead
 *   - content-type not image/* → dead
 *   - redirect chain > 3 hops → dead
 *
 * Returns { alive: bool, reason: string }.
 */
async function checkUrl(url) {
  // Node 20+: AbortSignal.timeout. Fine for Node 18 too.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort('timeout'), TIMEOUT_MS);
  try {
    // Use redirect: 'manual' so we can count hops. Native fetch follows
    // up to 20 by default which is way too permissive for publisher URLs
    // that often bounce to login walls.
    let currentUrl = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const r = await fetch(currentUrl, {
        method: 'HEAD',
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'User-Agent': 'earth00-heroImageValidator/1.0' },
      });

      // Redirect — follow if we have hops left.
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        if (!loc) return { alive: false, reason: 'redirect without Location' };
        if (hop >= MAX_REDIRECTS) return { alive: false, reason: 'too many redirects' };
        // Resolve relative Location against currentUrl.
        try { currentUrl = new URL(loc, currentUrl).toString(); }
        catch { return { alive: false, reason: 'bad Location header' }; }
        continue;
      }

      if (r.status === 405 || r.status === 501) {
        // Some publishers block HEAD. Fall back to a tiny GET with
        // Range: bytes=0-0 — enough to read headers without downloading
        // the body.
        return await rangeGetCheck(currentUrl, ctrl.signal);
      }

      if (r.status >= 400) return { alive: false, reason: `http ${r.status}` };

      // 2xx — check Content-Type.
      const ct = (r.headers.get('content-type') || '').toLowerCase();
      if (ct && !ct.startsWith('image/')) {
        return { alive: false, reason: `bad content-type: ${ct.slice(0, 40)}` };
      }
      return { alive: true, reason: `ok ${r.status}` };
    }
    return { alive: false, reason: 'too many redirects' };
  } catch (err) {
    const msg = err?.name === 'AbortError' ? 'timeout'
              : err?.code === 'ENOTFOUND'  ? 'dns'
              : err?.code                   || (err?.message || 'fetch error').slice(0, 60);
    return { alive: false, reason: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** Fallback for publishers that 405/501 on HEAD. Tiny GET with Range. */
async function rangeGetCheck(url, signal) {
  try {
    const r = await fetch(url, {
      method: 'GET',
      redirect: 'manual',
      signal,
      headers: {
        'User-Agent': 'earth00-heroImageValidator/1.0',
        'Range': 'bytes=0-0',
      },
    });
    if (r.status >= 400 && r.status !== 416) return { alive: false, reason: `http ${r.status}` };
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    if (ct && !ct.startsWith('image/')) {
      return { alive: false, reason: `bad content-type: ${ct.slice(0, 40)}` };
    }
    return { alive: true, reason: `ok range ${r.status}` };
  } catch (err) {
    return { alive: false, reason: `range-get: ${err.code || err.message || 'err'}` };
  }
}

// ═════════════════════════════════════════════════════════════════════════
//  Cache invalidation — hit the server's _ttlCache via a local HTTP POST
// ═════════════════════════════════════════════════════════════════════════

/**
 * After state changes, clear the _ttlCache entries for every thread and
 * timeline that contains an affected article / asset. The server.js cache
 * is keyed by `flows/thread:${id}` etc. — we pass the ids via a small
 * admin endpoint added alongside this script.
 */
async function invalidateDownstreamCaches(articleIds, assetIds) {
  // Find threads and timelines containing those articles. Also reverse-
  // look up for asset ids via article_image_assignments.
  const allArticleIds = new Set(articleIds);
  if (assetIds.length) {
    const { rows: assetArticles } = await pool.query(
      `SELECT DISTINCT article_id FROM article_image_assignments WHERE image_id = ANY($1::int[])`,
      [assetIds]
    );
    for (const r of assetArticles) allArticleIds.add(r.article_id);
  }
  if (!allArticleIds.size) return;

  const ids = [...allArticleIds];

  const { rows: threadRows } = await pool.query(
    `SELECT DISTINCT thread_id AS id FROM story_thread_articles WHERE article_id = ANY($1::int[])`,
    [ids]
  );
  const { rows: timelineRows } = await pool.query(
    `SELECT DISTINCT timeline_id AS id FROM story_timeline_articles WHERE article_id = ANY($1::int[])`,
    [ids]
  );

  const threadIds   = threadRows.map(r => r.id);
  const timelineIds = timelineRows.map(r => r.id);

  if (!threadIds.length && !timelineIds.length) return;

  const serverUrl = process.env.SERVER_INTERNAL_URL
                 || process.env.SERVER_URL
                 || 'https://earth-wjr6.onrender.com';
  const secret = process.env.INTERNAL_CACHE_INVALIDATE_SECRET;

  if (!secret) {
    console.warn(`   ⚠ INTERNAL_CACHE_INVALIDATE_SECRET not set — skipping cache invalidation. ` +
                 `Serve will naturally refresh after TTL (~5 min).`);
    return;
  }

  try {
    const r = await fetch(`${serverUrl}/api/internal/cache/invalidate-hero`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Secret': secret },
      body: JSON.stringify({ threadIds, timelineIds }),
      // 6s is plenty — this endpoint is in-memory Map deletion, no DB.
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) {
      console.warn(`   ⚠ cache invalidate HTTP ${r.status}`);
      return;
    }
    const data = await r.json().catch(() => ({}));
    console.log(`   ✔ invalidated ${data.cleared || 0} cache key(s) across ${threadIds.length} thread(s) + ${timelineIds.length} line(s)`);
  } catch (err) {
    console.warn(`   ⚠ cache invalidate failed: ${err.message}`);
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
