/**
 * reddit.js — submit a self-post to Reddit via OAuth (script-type app).
 *
 * Auth: "script" application — install at https://www.reddit.com/prefs/apps
 * Choose "script" (not "web" or "installed"). Fill name + redirect (any
 * placeholder works for script apps). Use the resulting client_id +
 * client_secret with your account username/password.
 *
 * Env vars required:
 *   REDDIT_CLIENT_ID
 *   REDDIT_CLIENT_SECRET
 *   REDDIT_USERNAME       — Reddit account that will post
 *   REDDIT_PASSWORD       — Reddit account password (or app password if 2FA)
 *   REDDIT_USER_AGENT     — required by API, e.g. "earth00:v1.0 (by /u/your_handle)"
 *
 * Optional env:
 *   REDDIT_DEFAULT_SUBREDDIT — default subreddit if draft.subreddit absent
 *                              (e.g. "geopolitics" — without the r/ prefix)
 *
 * Draft schema:
 *   { title, body, subreddit? }
 *
 * Flow:
 *   1. POST /api/v1/access_token with grant_type=password + Basic auth
 *      using client_id:client_secret → bearer token
 *   2. POST /api/submit with kind=self, sr=subreddit, title, text
 *   3. Parse response for the new post URL
 *
 * Reddit's content limits:
 *   - title: ≤ 300 chars
 *   - selftext: ≤ 40,000 chars
 *
 * Reddit's spam filter is aggressive for new accounts. Expect manual
 * mod approval in many subs for the first few weeks. The API returns
 * success even if the post is held for review.
 */

'use strict';

const name = 'reddit';

function isConfigured(env) {
  return !!(
    env.REDDIT_CLIENT_ID &&
    env.REDDIT_CLIENT_SECRET &&
    env.REDDIT_USERNAME &&
    env.REDDIT_PASSWORD &&
    env.REDDIT_USER_AGENT
  );
}

async function _getAccessToken(env) {
  const basic = Buffer
    .from(`${env.REDDIT_CLIENT_ID}:${env.REDDIT_CLIENT_SECRET}`)
    .toString('base64');
  const params = new URLSearchParams({
    grant_type: 'password',
    username:   env.REDDIT_USERNAME,
    password:   env.REDDIT_PASSWORD,
  });
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type':  'application/x-www-form-urlencoded',
      'User-Agent':    env.REDDIT_USER_AGENT,
    },
    body: params,
  });
  const txt = await res.text();
  let j = null; try { j = JSON.parse(txt); } catch (_) {}
  if (!res.ok || !j?.access_token) {
    throw new Error(`Reddit auth failed: ${j?.error || j?.message || txt.slice(0, 200) || `HTTP ${res.status}`}`);
  }
  return j.access_token;
}

async function publish(draft, env) {
  const subreddit = String(draft.subreddit || env.REDDIT_DEFAULT_SUBREDDIT || '').replace(/^r\//i, '').trim();
  if (!subreddit) return { ok: false, error: 'no subreddit (set draft.subreddit or REDDIT_DEFAULT_SUBREDDIT)' };
  const title = String(draft.title || '').slice(0, 300);
  const body  = String(draft.body  || '').slice(0, 40000);
  if (!title.trim()) return { ok: false, error: 'empty title' };

  let token;
  try { token = await _getAccessToken(env); }
  catch (err) { return { ok: false, error: err.message }; }

  const submitParams = new URLSearchParams({
    api_type:  'json',
    kind:      'self',
    sr:        subreddit,
    title,
    text:      body,
    resubmit:  'true',
    sendreplies: 'true',
  });

  const res = await fetch('https://oauth.reddit.com/api/submit', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/x-www-form-urlencoded',
      'User-Agent':    env.REDDIT_USER_AGENT,
    },
    body: submitParams,
  });
  const txt = await res.text();
  let j = null; try { j = JSON.parse(txt); } catch (_) {}
  if (!res.ok) {
    return { ok: false, error: `Reddit submit: ${j?.message || txt.slice(0, 200) || `HTTP ${res.status}`}` };
  }
  // Response shape: { json: { errors: [["BAD_CAPTCHA","..."],...] | [], data: { url, name, ... } } }
  const errs = j?.json?.errors || [];
  if (errs.length) {
    return { ok: false, error: `Reddit errors: ${JSON.stringify(errs).slice(0, 200)}` };
  }
  const permalink = j?.json?.data?.url || null;
  if (!permalink) return { ok: false, error: `Reddit returned no URL: ${JSON.stringify(j).slice(0, 200)}` };
  return { ok: true, permalink, fullname: j?.json?.data?.name };
}

module.exports = { name, isConfigured, publish };
