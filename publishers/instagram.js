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

async function publish(draft, env) {
  const caption  = String(draft.caption || '').slice(0, 2200);
  const imageUrl = draft.image_url;
  if (!imageUrl) return { ok: false, error: 'no image_url' };
  if (!/^https?:\/\//.test(imageUrl)) return { ok: false, error: `image_url must be public http(s) URL: ${imageUrl}` };

  const base = _graphBase(env);
  const igId = env.IG_USER_ID;
  const token = env.IG_ACCESS_TOKEN;

  // Step 1 — create media container
  let container;
  try {
    container = await _post(`${base}/${igId}/media`, {
      image_url:    imageUrl,
      caption,
      access_token: token,
    });
  } catch (err) {
    return { ok: false, error: `IG media container: ${err.message}` };
  }
  const containerId = container.id;
  if (!containerId) return { ok: false, error: 'IG media returned no container id' };

  // Step 2 — publish
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
  } catch (_) { /* permalink fetch is best-effort */ }

  return { ok: true, permalink, media_id: mediaId };
}

module.exports = { name, isConfigured, publish };
