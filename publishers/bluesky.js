/**
 * bluesky.js — publish a post to BlueSky via the AT Protocol REST API.
 *
 * Auth model: handle + app password (NOT your main BlueSky password).
 * Generate an app password at https://bsky.app/settings/app-passwords.
 *
 * Env vars required:
 *   BLUESKY_HANDLE        — your handle, e.g. "earth00.bsky.social"
 *   BLUESKY_APP_PASSWORD  — app password (NOT main password)
 *
 * Flow:
 *   1. POST com.atproto.server.createSession  → returns accessJwt + DID
 *   2. POST com.atproto.repo.createRecord with text → returns post URI
 *   3. Build a viewable permalink from the URI
 *
 * BlueSky's text field is 300 characters max (graphemes, not bytes).
 * socialDraftComposer truncates at 300, so by the time we get the draft
 * it's safe to send verbatim.
 *
 * Optional: link facet extraction. BlueSky doesn't auto-link URLs in
 * the way Twitter / Reddit do — you have to mark byte ranges as "link"
 * facets. We detect the FIRST http(s) URL in the body and attach a
 * single link facet so the share link is clickable. Multiple URLs
 * would need multiple facets; we keep this simple.
 */

'use strict';

const PDS = 'https://bsky.social';   // public Personal Data Server

const name = 'bluesky';

function isConfigured(env) {
  return !!(env.BLUESKY_HANDLE && env.BLUESKY_APP_PASSWORD);
}

async function _post(url, body, accessJwt) {
  const headers = { 'Content-Type': 'application/json' };
  if (accessJwt) headers['Authorization'] = `Bearer ${accessJwt}`;
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) {}
  if (!res.ok) {
    const msg = json?.error || json?.message || text || `HTTP ${res.status}`;
    throw new Error(`BlueSky ${url.split('/').pop()}: ${msg}`);
  }
  return json;
}

async function _createSession(env) {
  return _post(`${PDS}/xrpc/com.atproto.server.createSession`, {
    identifier: env.BLUESKY_HANDLE,
    password:   env.BLUESKY_APP_PASSWORD,
  });
}

// Detect the first http(s) URL in text → byte-range facet so it renders
// as a clickable link in BlueSky clients. AT Protocol uses byte indices
// (NOT grapheme), so we work in UTF-8 byte space.
function _buildLinkFacet(text) {
  const re = /https?:\/\/[^\s)]+/;
  const m = text.match(re);
  if (!m) return null;
  // Compute byte offsets by encoding the prefix up to the match start.
  const prefixBytes = Buffer.byteLength(text.slice(0, m.index), 'utf8');
  const matchBytes  = Buffer.byteLength(m[0], 'utf8');
  return {
    index: { byteStart: prefixBytes, byteEnd: prefixBytes + matchBytes },
    features: [{ $type: 'app.bsky.richtext.facet#link', uri: m[0] }],
  };
}

async function publish(draft, env) {
  const text = String(draft.body || '').slice(0, 300);
  if (!text.trim()) return { ok: false, error: 'empty body' };

  // 1. Auth
  const session = await _createSession(env);

  // 2. Build the record
  const record = {
    $type:     'app.bsky.feed.post',
    text,
    createdAt: new Date().toISOString(),
    langs:     ['en'],
  };
  const facet = _buildLinkFacet(text);
  if (facet) record.facets = [facet];

  // 3. POST createRecord
  const result = await _post(
    `${PDS}/xrpc/com.atproto.repo.createRecord`,
    {
      repo:       session.did,
      collection: 'app.bsky.feed.post',
      record,
    },
    session.accessJwt,
  );

  // result.uri is at://did:plc:.../app.bsky.feed.post/<rkey>
  // Build a viewable permalink for the editor UI.
  const rkey = String(result.uri || '').split('/').pop();
  const permalink = rkey
    ? `https://bsky.app/profile/${env.BLUESKY_HANDLE}/post/${rkey}`
    : null;
  return { ok: true, permalink, uri: result.uri };
}

module.exports = { name, isConfigured, publish };
