/**
 * linkedin.js — publish a text post to LinkedIn via the v2 REST API.
 *
 * Auth: OAuth 2.0 bearer token issued for your LinkedIn application.
 * Standard "Share on LinkedIn" scope (w_member_social) is required.
 * The token can post on behalf of:
 *   - a person (urn:li:person:{id})
 *   - a company page (urn:li:organization:{id}) — requires admin access
 *
 * Setup steps (one-time):
 *   1. Create app at https://developer.linkedin.com/
 *   2. Request "Share on LinkedIn" product (instant approval for personal)
 *   3. Use OAuth 2.0 authorization-code flow to get an access token
 *      (LinkedIn provides a token-generator tool in the developer portal
 *      for testing personal tokens — these last 60 days)
 *   4. Find your author URN via GET /v2/userinfo with the token; it
 *      returns "sub" which is the urn:li:person:{id} suffix.
 *
 * Env vars required:
 *   LINKEDIN_ACCESS_TOKEN — bearer token from OAuth flow
 *   LINKEDIN_AUTHOR_URN   — either "urn:li:person:XXXX" or "urn:li:organization:XXXX"
 *
 * Posting endpoint (v2 latest, "Posts API"):
 *   POST https://api.linkedin.com/v2/posts
 *   X-Restli-Protocol-Version: 2.0.0
 *   LinkedIn-Version: 202403   (LinkedIn requires a version header on newer endpoints)
 *
 * Permalink: response contains "id" in a URN form; we map to
 *   https://www.linkedin.com/feed/update/{urn}
 *
 * LinkedIn caps text content at 3000 chars. Composer already enforces this.
 */

'use strict';

const name = 'linkedin';

function isConfigured(env) {
  return !!(env.LINKEDIN_ACCESS_TOKEN && env.LINKEDIN_AUTHOR_URN);
}

async function publish(draft, env) {
  const text = String(draft.body || '').slice(0, 3000);
  if (!text.trim()) return { ok: false, error: 'empty body' };

  const payload = {
    author:       env.LINKEDIN_AUTHOR_URN,
    commentary:   text,
    visibility:   'PUBLIC',
    distribution: {
      feedDistribution:             'MAIN_FEED',
      targetEntities:               [],
      thirdPartyDistributionChannels: [],
    },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };

  const res = await fetch('https://api.linkedin.com/v2/posts', {
    method: 'POST',
    headers: {
      'Authorization':              `Bearer ${env.LINKEDIN_ACCESS_TOKEN}`,
      'Content-Type':               'application/json',
      'X-Restli-Protocol-Version':  '2.0.0',
      'LinkedIn-Version':           '202403',
    },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  let json = null; try { json = JSON.parse(body); } catch (_) {}

  if (!res.ok) {
    const msg = json?.message || json?.error_description || body.slice(0, 200) || `HTTP ${res.status}`;
    return { ok: false, error: `LinkedIn API: ${msg}` };
  }

  // The v2 Posts API returns the post URN in the x-restli-id header AND
  // in the response body under "id". Either works.
  const urn = res.headers.get('x-restli-id') || json?.id || null;
  if (!urn) return { ok: false, error: 'LinkedIn returned no post id' };

  // URN looks like "urn:li:share:7195837..."  → feed URL takes the URN verbatim.
  const permalink = `https://www.linkedin.com/feed/update/${urn}`;
  return { ok: true, permalink, urn };
}

module.exports = { name, isConfigured, publish };
