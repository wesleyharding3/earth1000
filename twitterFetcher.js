/**
 * twitterFetcher.js
 *
 * Polls Twitter/X API v2 for recent tweets from world leaders.
 * Requires TWITTER_BEARER_TOKEN env var (Basic tier, $100/month).
 *
 * Usage:
 *   node twitterFetcher.js                 # One-shot fetch
 *   node twitterFetcher.js --loop          # Continuous polling (every 30 min)
 *   node twitterFetcher.js --resolve-ids   # Resolve handles → Twitter user IDs (run once)
 *
 * Budget: 50 accounts × ~2 tweets/day = ~100 tweets/day = ~3,000/month.
 * Basic tier allows 10,000 reads/month — well within budget with hourly polls.
 *
 * The fetcher pulls the 5 most recent tweets per account per cycle.
 * Duplicates are skipped via UNIQUE(tweet_id) constraint.
 */

'use strict';

require('dotenv').config();
const pool = require('./db');
const LEADER_ACCOUNTS = require('./leaderAccounts');

const BEARER_TOKEN = process.env.TWITTER_BEARER_TOKEN;
const LOOP_MODE    = process.argv.includes('--loop');
const RESOLVE_IDS  = process.argv.includes('--resolve-ids');

// Poll interval: 30 minutes (48 polls/day × 50 accounts × 1 request each = 2,400 reads/day)
// That's ~72,000/month which exceeds Basic tier. So we stagger: poll 10 accounts per cycle.
const POLL_INTERVAL_MS = 30 * 60 * 1000;
const ACCOUNTS_PER_CYCLE = 10;  // 10 accounts per 30 min = all 50 every 2.5 hours
const TWEETS_PER_ACCOUNT = 5;

// ── Twitter API helpers ────────────────────────────────────────────────────

async function twitterGet(url) {
  if (!BEARER_TOKEN) throw new Error('TWITTER_BEARER_TOKEN not set');
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${BEARER_TOKEN}` },
  });
  if (res.status === 429) {
    const reset = res.headers.get('x-rate-limit-reset');
    const waitSec = reset ? Math.max(0, parseInt(reset) - Math.floor(Date.now() / 1000)) : 60;
    console.warn(`[twitter] Rate limited. Waiting ${waitSec}s...`);
    await new Promise(r => setTimeout(r, waitSec * 1000));
    return twitterGet(url);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Twitter API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ── Resolve handles → user IDs (run once) ──────────────────────────────────

async function resolveUserIds() {
  console.log('\n🔍 Resolving Twitter handles → user IDs\n');

  // Twitter allows up to 100 usernames per lookup
  const handles = LEADER_ACCOUNTS.map(a => a.handle);
  const batches = [];
  for (let i = 0; i < handles.length; i += 100) {
    batches.push(handles.slice(i, i + 100));
  }

  const resolved = {};
  for (const batch of batches) {
    const url = `https://api.twitter.com/2/users/by?usernames=${batch.join(',')}&user.fields=id,username,name,profile_image_url`;
    const data = await twitterGet(url);
    if (data.data) {
      data.data.forEach(u => {
        resolved[u.username.toLowerCase()] = u.id;
        console.log(`  ✓ @${u.username} → ${u.id}`);
      });
    }
    if (data.errors) {
      data.errors.forEach(e => console.warn(`  ✗ @${e.value}: ${e.detail}`));
    }
  }

  // Save to a JSON file for future use
  const fs = require('fs');
  fs.writeFileSync(
    __dirname + '/leaderTwitterIds.json',
    JSON.stringify(resolved, null, 2)
  );
  console.log(`\n✓ Resolved ${Object.keys(resolved).length}/${handles.length} accounts → leaderTwitterIds.json\n`);
}

// ── Load user IDs ──────────────────────────────────────────────────────────

function loadUserIds() {
  try {
    return require('./leaderTwitterIds.json');
  } catch {
    console.error('leaderTwitterIds.json not found. Run: node twitterFetcher.js --resolve-ids');
    process.exit(1);
  }
}

// ── Fetch tweets for one account ───────────────────────────────────────────

async function fetchTweetsForAccount(account, userId) {
  const url = `https://api.twitter.com/2/users/${userId}/tweets`
    + `?max_results=${TWEETS_PER_ACCOUNT}`
    + `&tweet.fields=created_at,public_metrics,referenced_tweets,attachments`
    + `&media.fields=url,preview_image_url`
    + `&expansions=attachments.media_keys`;

  const data = await twitterGet(url);
  if (!data.data) return 0;

  // Build media lookup
  const mediaMap = {};
  if (data.includes?.media) {
    data.includes.media.forEach(m => {
      mediaMap[m.media_key] = m.url || m.preview_image_url || null;
    });
  }

  let inserted = 0;
  for (const tweet of data.data) {
    const isRetweet = tweet.referenced_tweets?.some(r => r.type === 'retweeted') || false;
    const isReply   = tweet.referenced_tweets?.some(r => r.type === 'replied_to') || false;

    // Collect media URLs
    const mediaUrls = [];
    if (tweet.attachments?.media_keys) {
      tweet.attachments.media_keys.forEach(key => {
        if (mediaMap[key]) mediaUrls.push(mediaMap[key]);
      });
    }

    try {
      await pool.query(`
        INSERT INTO leader_tweets
          (tweet_id, twitter_handle, leader_name, leader_title, country, iso_code,
           tweet_text, tweet_created_at, retweet_count, like_count, reply_count,
           media_urls, is_retweet, is_reply)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (tweet_id) DO UPDATE SET
          retweet_count = EXCLUDED.retweet_count,
          like_count    = EXCLUDED.like_count,
          reply_count   = EXCLUDED.reply_count
      `, [
        tweet.id,
        account.handle,
        account.name,
        account.title,
        account.country,
        account.iso,
        tweet.text,
        tweet.created_at,
        tweet.public_metrics?.retweet_count || 0,
        tweet.public_metrics?.like_count || 0,
        tweet.public_metrics?.reply_count || 0,
        JSON.stringify(mediaUrls),
        isRetweet,
        isReply,
      ]);
      inserted++;
    } catch (err) {
      if (err.code !== '23505') console.error(`  Insert error for tweet ${tweet.id}:`, err.message);
    }
  }

  return inserted;
}

// ── Poll cycle ─────────────────────────────────────────────────────────────

let _cycleOffset = 0;

async function pollCycle() {
  const userIds = loadUserIds();
  const batch = LEADER_ACCOUNTS.slice(_cycleOffset, _cycleOffset + ACCOUNTS_PER_CYCLE);
  _cycleOffset = (_cycleOffset + ACCOUNTS_PER_CYCLE) % LEADER_ACCOUNTS.length;

  console.log(`[twitter] Polling ${batch.length} accounts (offset ${_cycleOffset})...`);

  let totalInserted = 0;
  for (const account of batch) {
    const userId = userIds[account.handle.toLowerCase()];
    if (!userId) {
      console.warn(`  ⚠ No user ID for @${account.handle} — skipping`);
      continue;
    }
    try {
      const n = await fetchTweetsForAccount(account, userId);
      if (n > 0) console.log(`  @${account.handle}: ${n} new tweets`);
      totalInserted += n;
    } catch (err) {
      console.error(`  ✗ @${account.handle}: ${err.message}`);
    }
    // Small delay between accounts to be polite
    await new Promise(r => setTimeout(r, 1000));
  }

  console.log(`[twitter] Cycle done: ${totalInserted} new tweets stored`);
}

// ── Cleanup old tweets ─────────────────────────────────────────────────────

async function cleanupOldTweets() {
  const { rowCount } = await pool.query(
    `DELETE FROM leader_tweets WHERE tweet_created_at < NOW() - INTERVAL '30 days'`
  );
  if (rowCount > 0) console.log(`[twitter] Cleaned ${rowCount} tweets older than 30 days`);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!BEARER_TOKEN) {
    console.error('Fatal: TWITTER_BEARER_TOKEN not set.');
    console.error('Get one at https://developer.x.com/en/portal/dashboard');
    console.error('Requires Basic tier ($100/month) for tweet read access.');
    process.exit(1);
  }

  if (RESOLVE_IDS) {
    await resolveUserIds();
    await pool.end();
    return;
  }

  // One-shot or loop
  await pollCycle();
  await cleanupOldTweets();

  if (LOOP_MODE) {
    console.log(`[twitter] Loop mode — polling every ${POLL_INTERVAL_MS / 60000} minutes`);
    setInterval(async () => {
      try {
        await pollCycle();
        await cleanupOldTweets();
      } catch (err) {
        console.error('[twitter] Poll error:', err.message);
      }
    }, POLL_INTERVAL_MS);
  } else {
    await pool.end();
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
