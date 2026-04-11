/**
 * twitterFetcher.js
 *
 * oEmbed-based tweet embedder for admin-curated tweet URLs.
 * No Twitter API key needed — uses the free publish.twitter.com/oembed endpoint.
 *
 * This module exports functions used by the server's admin endpoints.
 * Admins paste tweet URLs → this fetches oEmbed data and stores it.
 */

'use strict';

const LEADER_ACCOUNTS = require('./leaderAccounts');

// Build a lookup map: handle (lowercase) → account metadata
const HANDLE_MAP = {};
LEADER_ACCOUNTS.forEach(a => {
  HANDLE_MAP[a.handle.toLowerCase()] = a;
});

/**
 * Parse a tweet URL into { handle, tweetId }.
 * Supports twitter.com and x.com URLs.
 */
function parseTweetUrl(url) {
  const m = url.match(/(?:twitter\.com|x\.com)\/([^/]+)\/status\/(\d+)/i);
  if (!m) return null;
  return { handle: m[1], tweetId: m[2] };
}

/**
 * Fetch oEmbed data for a tweet URL.
 * Free endpoint, no auth needed. Rate limited but generous.
 */
async function fetchOEmbed(tweetUrl) {
  const params = new URLSearchParams({
    url: tweetUrl,
    omit_script: 'true',  // we'll load widgets.js once globally
    dnt: 'true',
  });
  const res = await fetch(`https://publish.twitter.com/oembed?${params}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`oEmbed ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Process a single tweet URL: fetch oEmbed, match to leader, store in DB.
 * Returns the inserted/updated row or null on failure.
 */
async function processTweetUrl(pool, url, addedBy) {
  const parsed = parseTweetUrl(url.trim());
  if (!parsed) return { error: `Invalid tweet URL: ${url}` };

  const leader = HANDLE_MAP[parsed.handle.toLowerCase()];

  try {
    const oembed = await fetchOEmbed(url.trim());

    const { rows } = await pool.query(`
      INSERT INTO leader_tweets
        (tweet_id, tweet_url, twitter_handle, leader_name, leader_title,
         country, iso_code, tweet_text, oembed_html, oembed_author, added_by)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (tweet_id) DO UPDATE SET
        oembed_html = EXCLUDED.oembed_html,
        tweet_text  = EXCLUDED.tweet_text
      RETURNING id, tweet_id, twitter_handle, leader_name
    `, [
      parsed.tweetId,
      url.trim(),
      parsed.handle,
      leader?.name || oembed.author_name || parsed.handle,
      leader?.title || null,
      leader?.country || null,
      leader?.iso || null,
      // Extract text from oEmbed HTML (strip tags for plain text storage)
      oembed.html?.replace(/<[^>]*>/g, '').replace(/&mdash;.*$/, '').trim().slice(0, 1000) || '',
      oembed.html || '',
      oembed.author_name || parsed.handle,
      addedBy || null,
    ]);

    return { success: true, tweet: rows[0], isLeader: !!leader };
  } catch (err) {
    return { error: `Failed to fetch @${parsed.handle}/${parsed.tweetId}: ${err.message}` };
  }
}

/**
 * Process multiple tweet URLs (batch).
 * Accepts newline or comma-separated URLs.
 */
async function processTweetUrls(pool, urlsText, addedBy) {
  const urls = urlsText
    .split(/[\n,]+/)
    .map(u => u.trim())
    .filter(u => u && (u.includes('twitter.com') || u.includes('x.com')));

  const results = [];
  for (const url of urls) {
    const result = await processTweetUrl(pool, url, addedBy);
    results.push({ url, ...result });
    // Small delay to be polite to oEmbed endpoint
    await new Promise(r => setTimeout(r, 300));
  }

  return results;
}

module.exports = { parseTweetUrl, fetchOEmbed, processTweetUrl, processTweetUrls };
