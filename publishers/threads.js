/**
 * threads.js — publish a text post to Meta's Threads via the Threads API.
 *
 * Auth: long-lived Threads user access token (60-day). Generated via the
 * OAuth Authorization Window flow at https://threads.net/oauth/authorize
 * then exchanged at https://graph.threads.net/oauth/access_token. The
 * long-lived exchange uses grant_type=th_exchange_token (NOT the same
 * as Instagram's fb_exchange_token).
 *
 * Env vars required:
 *   THREADS_ACCESS_TOKEN  — long-lived user access token (60-day)
 *   THREADS_USER_ID       — numeric Threads user ID (NOT @handle)
 *
 * Flow (two-step):
 *   1. POST /{user-id}/threads with media_type=TEXT + text
 *      → returns { id: '<container-id>' }
 *   2. POST /{user-id}/threads_publish with creation_id=<container-id>
 *      → returns { id: '<media-id>' }
 *
 * Threads renders OG link previews automatically, so we send text +
 * share URL and let Threads pull the card. No image attachment needed —
 * the share PNG renders inline via the link preview.
 *
 * Text limit: 500 chars per post. Composer enforces this.
 *
 * Permalink: GET /{media-id}?fields=permalink — one extra round-trip
 * but gives us the public URL.
 */

'use strict';

const name = 'threads';

const GRAPH_BASE = 'https://graph.threads.net/v1.0';

function isConfigured(env) {
  return !!(env.THREADS_ACCESS_TOKEN && env.THREADS_USER_ID);
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

// Poll Threads container status until processing finishes. Same shape
// as IG — video containers transcode async and publish fails while
// they're in_progress. TEXT containers are typically already FINISHED
// on the first poll.
async function _waitForContainerReady(containerId, token, { maxAttempts = 30, intervalMs = 3000 } = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const status = await _get(`${GRAPH_BASE}/${containerId}?fields=status,status_code&access_token=${encodeURIComponent(token)}`);
    const code = String(status.status_code || status.status || '').toUpperCase();
    if (code === 'FINISHED') return true;
    if (code === 'ERROR' || code === 'EXPIRED') {
      throw new Error(`Threads container ${code}: ${status.status || ''}`);
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Threads container did not reach FINISHED after ${maxAttempts * intervalMs / 1000}s`);
}

async function publish(draft, env) {
  const text = String(draft.body || '').slice(0, 500);
  const videoUrl = draft.video_url;
  if (!text.trim() && !videoUrl) return { ok: false, error: 'empty body and no video' };

  const userId = env.THREADS_USER_ID;
  const token  = env.THREADS_ACCESS_TOKEN;

  // Two-step create-then-publish, same as Instagram. Threads supports
  // VIDEO media_type with a video_url pointing at a public MP4. Falls
  // back to TEXT-only when no video is attached.
  const containerParams = videoUrl
    ? { media_type: 'VIDEO', video_url: videoUrl, text, access_token: token }
    : { media_type: 'TEXT',  text,                  access_token: token };

  let container;
  try {
    container = await _post(`${GRAPH_BASE}/${userId}/threads`, containerParams);
  } catch (err) {
    return { ok: false, error: `Threads container: ${err.message}` };
  }
  const containerId = container.id;
  if (!containerId) return { ok: false, error: 'Threads returned no container id' };

  if (videoUrl) {
    try {
      await _waitForContainerReady(containerId, token);
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  let published;
  try {
    published = await _post(`${GRAPH_BASE}/${userId}/threads_publish`, {
      creation_id:  containerId,
      access_token: token,
    });
  } catch (err) {
    return { ok: false, error: `Threads publish: ${err.message}` };
  }
  const mediaId = published.id;
  if (!mediaId) return { ok: false, error: 'Threads publish returned no media id' };

  let permalink = null;
  try {
    const meta = await _get(`${GRAPH_BASE}/${mediaId}?fields=permalink&access_token=${encodeURIComponent(token)}`);
    permalink = meta.permalink || null;
  } catch (_) { /* best-effort */ }

  return { ok: true, permalink, media_id: mediaId, media_kind: videoUrl ? 'VIDEO' : 'TEXT' };
}

module.exports = { name, isConfigured, publish };
