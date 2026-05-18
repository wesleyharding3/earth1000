/**
 * instagram.js — publish a single-image feed post to Instagram via
 * Meta's Graph API.
 *
 * Auth: long-lived Instagram Business API user access token. Setup is
 * the most painful of all five platforms — required pieces:
 *   1. Facebook Page (you own / admin)
 *   2. Instagram BUSINESS or CREATOR account linked to that Page
 *   3. Meta Developer app with "instagram_basic" + "instagram_content_publish"
 *      + "pages_show_list" + "pages_read_engagement" scopes
 *   4. Exchange short-lived token → long-lived token (60-day expiry)
 *   5. Refresh the long-lived token before expiry
 *
 * Env vars required:
 *   IG_ACCESS_TOKEN  — long-lived user access token (60-day)
 *   IG_USER_ID       — Instagram Business User ID (NOT the @handle)
 *
 * Optional:
 *   IG_GRAPH_VERSION — Graph API version, default 'v22.0'
 *
 * Flow (two-step):
 *   1. POST /{ig-user-id}/media   with image_url + caption
 *      → returns { id: '<container-id>' }
 *   2. POST /{ig-user-id}/media_publish with creation_id=<container-id>
 *      → returns { id: '<media-id>' } and the post is live
 *
 * Image hosting: the image_url MUST be publicly fetchable by Meta's
 * servers — our /share/thread/{id}.png endpoint already qualifies.
 * Image must be JPEG/PNG, ≤ 8MB, with min 320px wide.
 *
 * IG caption limits: 2200 chars; 30 hashtags max (composer respects this).
 *
 * Permalink: We construct it from the returned media id via
 *   GET /{media-id}?fields=permalink
 * (one extra round-trip, but it gives us the public URL).
 */

'use strict';

const name = 'instagram';

function isConfigured(env) {
  return !!(env.IG_ACCESS_TOKEN && env.IG_USER_ID);
}

function _graphBase(env) {
  const v = env.IG_GRAPH_VERSION || 'v22.0';
  return `https://graph.facebook.com/${v}`;
}

async function _post(url, params) {
  const body = new URLSearchParams(params);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  const txt = await res.text();
  let j = null; try { j = JSON.parse(txt); } catch (_) {}
  if (!res.ok) {
    const msg = j?.error?.message || txt.slice(0, 200) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return j;
}

async function _get(url) {
  const res = await fetch(url);
  const txt = await res.text();
  let j = null; try { j = JSON.parse(txt); } catch (_) {}
  if (!res.ok) {
    const msg = j?.error?.message || txt.slice(0, 200) || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return j;
}

// Poll container status until processing finishes. Video containers
// need this — IG transcodes the uploaded MP4 and rejects publish while
// the container is IN_PROGRESS. Image containers reach FINISHED almost
// immediately so this is a no-op for them.
async function _waitForContainerReady(base, containerId, token, { maxAttempts = 30, intervalMs = 3000 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const status = await _get(`${base}/${containerId}?fields=status_code,status&access_token=${encodeURIComponent(token)}`);
    const code = String(status.status_code || status.status || '').toUpperCase();
    if (code === 'FINISHED') return true;
    if (code === 'ERROR' || code === 'EXPIRED') {
      throw new Error(`IG container ${code} (id=${containerId}): ${status.status || ''}`);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`IG container did not reach FINISHED after ${maxAttempts * intervalMs / 1000}s`);
}

async function publish(draft, env) {
  const caption  = String(draft.caption || '').slice(0, 2200);
  const videoUrl = draft.video_url;
  const imageUrl = draft.image_url;
  // Optional: N-item carousel of pre-rendered MP4s (typically 4 — the
  // animated portrait card, the globe arc fly-around, the country-
  // spread pie chart, and the article-bar list). When the picker
  // supplies this array, we build an all-video carousel; otherwise
  // we fall back to the legacy image+video CAROUSEL / REELS / IMAGE
  // shape so old-pipeline rows still publish cleanly during rollout.
  const carouselVideos = Array.isArray(draft.carousel_videos)
    ? draft.carousel_videos.filter(u => typeof u === 'string' && /^https?:\/\//.test(u))
    : [];
  const hasVideo = !!videoUrl;
  const hasImage = !!imageUrl;
  if (!carouselVideos.length && !hasVideo && !hasImage) {
    return { ok: false, error: 'no media URLs on draft (need carousel_videos, video_url, or image_url)' };
  }
  for (const u of [videoUrl, imageUrl]) {
    if (u && !/^https?:\/\//.test(u)) return { ok: false, error: `media URL must be public http(s): ${u}` };
  }

  const base = _graphBase(env);
  const igId = env.IG_USER_ID;
  const token = env.IG_ACCESS_TOKEN;

  // Publish modes (in priority order):
  //   VIDEO_CAROUSEL — N-item all-video carousel from draft.carousel_videos
  //                    (the current production pipeline: portrait + globe
  //                    + pie + articles). Stops the scroll on each slide.
  //   CAROUSEL       — legacy image + video (back-compat for stale drafts)
  //   REELS          — single video (back-compat / no image)
  //   IMAGE          — single image (back-compat / no video)
  let mode;
  if (carouselVideos.length >= 2)      mode = 'VIDEO_CAROUSEL';
  else if (hasVideo && hasImage)       mode = 'CAROUSEL';
  else if (hasVideo)                   mode = 'REELS';
  else                                 mode = 'IMAGE';

  // --- VIDEO_CAROUSEL path (N up to 10 video items) ------------------
  if (mode === 'VIDEO_CAROUSEL') {
    // IG carousel items max out at 10. We typically ship 4. Each item
    // must be created with media_type=VIDEO + is_carousel_item=true.
    const items = carouselVideos.slice(0, 10);
    const itemIds = [];
    for (let i = 0; i < items.length; i++) {
      let it;
      try {
        it = await _post(`${base}/${igId}/media`, {
          media_type:       'VIDEO',
          video_url:        items[i],
          is_carousel_item: 'true',
          access_token:     token,
        });
      } catch (err) {
        return { ok: false, error: `IG video-carousel item[${i}]: ${err.message}` };
      }
      if (!it.id) return { ok: false, error: `IG video-carousel item[${i}] returned no id` };
      itemIds.push(it.id);
    }

    // Wait for every item to finish transcoding. Each video container
    // takes ~5-30s on IG's side — we poll FINISHED status before the
    // parent carousel is created, otherwise the parent rejects.
    //
    // Per-item try/catch so the error tells us WHICH slide failed
    // (index + source video URL). The IG error code 2207077 is a
    // catch-all for media-upload failures, so we need the slide
    // identifier to diagnose (was it the portrait, arc, pie, or
    // articles slide?).
    for (let i = 0; i < itemIds.length; i++) {
      try {
        await _waitForContainerReady(base, itemIds[i], token);
      } catch (err) {
        return {
          ok: false,
          error: `IG video-carousel item[${i}] (${items[i]}): ${err.message}`,
        };
      }
    }

    // Parent carousel container — caption lives here, not on items.
    let carousel;
    try {
      carousel = await _post(`${base}/${igId}/media`, {
        media_type:   'CAROUSEL',
        children:     itemIds.join(','),
        caption,
        access_token: token,
      });
    } catch (err) {
      return { ok: false, error: `IG video-carousel parent: ${err.message}` };
    }
    if (!carousel.id) return { ok: false, error: 'IG video-carousel parent returned no id' };

    try {
      await _waitForContainerReady(base, carousel.id, token);
    } catch (err) {
      return { ok: false, error: err.message };
    }

    let published;
    try {
      published = await _post(`${base}/${igId}/media_publish`, {
        creation_id:  carousel.id,
        access_token: token,
      });
    } catch (err) {
      return { ok: false, error: `IG video-carousel publish: ${err.message}` };
    }
    const mediaId = published.id;
    if (!mediaId) return { ok: false, error: 'IG video-carousel publish returned no media id' };

    let permalink = null;
    try {
      const meta = await _get(`${base}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(token)}`);
      permalink = meta.permalink || null;
    } catch (_) { /* best-effort */ }

    return { ok: true, permalink, media_id: mediaId, media_kind: 'VIDEO_CAROUSEL', item_count: itemIds.length };
  }

  // --- legacy CAROUSEL path (image + single video) -------------------
  if (mode === 'CAROUSEL') {
    // Use the portrait (4:5) variant of the share image so it matches
    // the video's aspect (1080×1350). IG carousels require all items
    // at the same aspect — if they differ, the second item gets cropped
    // to the first item's aspect. Earlier with a 1.91:1 landscape image
    // + 4:5 video, the video showed as a narrow center strip with
    // most of the globe hidden.
    const carouselImageUrl = imageUrl.includes('?')
      ? `${imageUrl}&aspect=4:5`
      : `${imageUrl}?aspect=4:5`;

    // Step 1a — create the IMAGE item container (no caption on items,
    // caption goes on the parent carousel container).
    let imgItem, vidItem;
    try {
      imgItem = await _post(`${base}/${igId}/media`, {
        image_url:        carouselImageUrl,
        is_carousel_item: 'true',
        access_token:     token,
      });
    } catch (err) {
      return { ok: false, error: `IG carousel image-item: ${err.message}` };
    }
    if (!imgItem.id) return { ok: false, error: 'IG carousel image-item returned no id' };

    // Step 1b — create the VIDEO item container. media_type=VIDEO (not
    // REELS) is the carousel-item variant.
    try {
      vidItem = await _post(`${base}/${igId}/media`, {
        media_type:       'VIDEO',
        video_url:        videoUrl,
        is_carousel_item: 'true',
        access_token:     token,
      });
    } catch (err) {
      return { ok: false, error: `IG carousel video-item: ${err.message}` };
    }
    if (!vidItem.id) return { ok: false, error: 'IG carousel video-item returned no id' };

    // Step 1c — wait for both items to finish processing.
    try {
      await _waitForContainerReady(base, imgItem.id, token);
      await _waitForContainerReady(base, vidItem.id, token);
    } catch (err) {
      return { ok: false, error: err.message };
    }

    // Step 2 — create the CAROUSEL parent container referencing both
    // items, in display order. Caption lives here, not on items.
    let carousel;
    try {
      carousel = await _post(`${base}/${igId}/media`, {
        media_type:   'CAROUSEL',
        children:     `${imgItem.id},${vidItem.id}`,
        caption,
        access_token: token,
      });
    } catch (err) {
      return { ok: false, error: `IG carousel parent: ${err.message}` };
    }
    if (!carousel.id) return { ok: false, error: 'IG carousel parent returned no id' };

    try {
      await _waitForContainerReady(base, carousel.id, token);
    } catch (err) {
      return { ok: false, error: err.message };
    }

    // Step 3 — publish the carousel
    let published;
    try {
      published = await _post(`${base}/${igId}/media_publish`, {
        creation_id:  carousel.id,
        access_token: token,
      });
    } catch (err) {
      return { ok: false, error: `IG carousel publish: ${err.message}` };
    }
    const mediaId = published.id;
    if (!mediaId) return { ok: false, error: 'IG carousel publish returned no media id' };

    let permalink = null;
    try {
      const meta = await _get(`${base}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(token)}`);
      permalink = meta.permalink || null;
    } catch (_) { /* best-effort */ }

    return { ok: true, permalink, media_id: mediaId, media_kind: 'CAROUSEL' };
  }

  // --- single-media path (REELS or IMAGE) ----------------------------
  const containerParams = (mode === 'REELS')
    ? { media_type: 'REELS', video_url: videoUrl, caption, access_token: token }
    : { image_url: imageUrl, caption, access_token: token };

  let container;
  try {
    container = await _post(`${base}/${igId}/media`, containerParams);
  } catch (err) {
    return { ok: false, error: `IG media container: ${err.message}` };
  }
  const containerId = container.id;
  if (!containerId) return { ok: false, error: 'IG media returned no container id' };

  try {
    await _waitForContainerReady(base, containerId, token);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  let published;
  try {
    published = await _post(`${base}/${igId}/media_publish`, {
      creation_id:  containerId,
      access_token: token,
    });
  } catch (err) {
    return { ok: false, error: `IG media_publish: ${err.message}` };
  }
  const mediaId = published.id;
  if (!mediaId) return { ok: false, error: 'IG media_publish returned no media id' };

  // Step 3 — fetch permalink
  let permalink = null;
  try {
    const meta = await _get(`${base}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(token)}`);
    permalink = meta.permalink || null;
  } catch (_) { /* best-effort */ }

  return { ok: true, permalink, media_id: mediaId, media_kind: mode };
}

module.exports = { name, isConfigured, publish };
