/**
 * x.js — publish a tweet to X (Twitter) via API v2.
 *
 * Auth: OAuth 1.0a User Context. v2 also supports OAuth 2.0 user-
 * context, but OAuth 1.0a stays viable for write endpoints and is
 * cleaner to do without third-party deps. We sign requests manually
 * with HMAC-SHA1 using Node's built-in crypto.
 *
 * Env vars required (generate from Twitter Developer Portal):
 *   X_API_KEY            — Consumer Key
 *   X_API_SECRET         — Consumer Secret
 *   X_ACCESS_TOKEN       — Access Token (user-level, "with read+write")
 *   X_ACCESS_TOKEN_SECRET — Access Token Secret
 *
 * Posting endpoint: POST https://api.twitter.com/2/tweets
 *   body: { text: "..." }
 *
 * Notes:
 *   - X's free API tier is capped at 1,500 tweets/month (Mar 2025+).
 *     For our 2-3 tweets/day cadence that's ~90/month — comfortably
 *     within the cap.
 *   - The Twitter app MUST have "User authentication settings"
 *     configured for OAuth 1.0a + Read & Write permission, AND the
 *     access tokens must be regenerated AFTER enabling write
 *     permission (otherwise you get 403 Forbidden).
 *   - Permalink format: https://x.com/{screen_name}/status/{id}
 *     We don't know the screen_name from the response alone, so we
 *     read X_SCREEN_NAME from env (optional — falls back to a
 *     generic /i/web/status/{id} link that still works).
 */

'use strict';

const crypto = require('crypto');

const name = 'x';

function isConfigured(env) {
  return !!(env.X_API_KEY && env.X_API_SECRET && env.X_ACCESS_TOKEN && env.X_ACCESS_TOKEN_SECRET);
}

// Percent-encode per RFC 3986 — stricter than encodeURIComponent for
// OAuth 1.0a signatures. ! * ' ( ) must be escaped; ~ stays unescaped.
function _pctEncode(str) {
  return encodeURIComponent(String(str)).replace(/[!*'()]/g, c =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

// Build the OAuth 1.0a Authorization header for a signed request.
function _buildOAuthHeader({ method, url, env, bodyParams = {} }) {
  const params = {
    oauth_consumer_key:     env.X_API_KEY,
    oauth_nonce:            crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp:        Math.floor(Date.now() / 1000).toString(),
    oauth_token:            env.X_ACCESS_TOKEN,
    oauth_version:          '1.0',
  };
  // Signature base string: include oauth_* + bodyParams (form) but NOT
  // JSON body. For v2 endpoints we always send JSON body, so bodyParams
  // is empty — only oauth_* params go into the signature.
  const allParams = { ...params, ...bodyParams };
  const sortedKeys = Object.keys(allParams).sort();
  const paramString = sortedKeys
    .map(k => `${_pctEncode(k)}=${_pctEncode(allParams[k])}`)
    .join('&');
  const baseString = [method.toUpperCase(), _pctEncode(url), _pctEncode(paramString)].join('&');
  const signingKey = `${_pctEncode(env.X_API_SECRET)}&${_pctEncode(env.X_ACCESS_TOKEN_SECRET)}`;
  const signature  = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
  params.oauth_signature = signature;
  const header = 'OAuth ' + Object.keys(params)
    .sort()
    .map(k => `${_pctEncode(k)}="${_pctEncode(params[k])}"`)
    .join(', ');
  return header;
}

async function publish(draft, env) {
  const text = String(draft.body || '').slice(0, 280);
  if (!text.trim()) return { ok: false, error: 'empty body' };

  const url = 'https://api.twitter.com/2/tweets';
  const authHeader = _buildOAuthHeader({ method: 'POST', url, env });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': authHeader,
      'Content-Type':  'application/json',
      'User-Agent':    'Earth00/1.0 (+https://earth00.com)',
    },
    body: JSON.stringify({ text }),
  });
  const body = await res.text();
  let json = null;
  try { json = JSON.parse(body); } catch (_) {}
  if (!res.ok) {
    const errMsg = json?.detail || json?.title || json?.errors?.[0]?.message || body.slice(0, 200) || `HTTP ${res.status}`;
    return { ok: false, error: `X API: ${errMsg}` };
  }
  const id = json?.data?.id;
  if (!id) return { ok: false, error: `X API returned no tweet id: ${JSON.stringify(json).slice(0, 200)}` };

  const handle = env.X_SCREEN_NAME || 'i/web';
  const permalink = handle === 'i/web'
    ? `https://x.com/i/web/status/${id}`
    : `https://x.com/${handle}/status/${id}`;
  return { ok: true, permalink, tweet_id: id };
}

module.exports = { name, isConfigured, publish };
