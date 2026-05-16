/**
 * publishers/index.js — registry + dispatch for social platform publishers.
 *
 * Each platform module exports:
 *   - name        — string, matches the draft keys (x | reddit | linkedin | bluesky | instagram)
 *   - isConfigured(env) — boolean; returns true when required env vars are present
 *   - publish(draft, env) — async; returns { ok: boolean, permalink?: string, error?: string }
 *
 * Draft shape per platform (from socialDraftComposer):
 *   x:         { body }
 *   reddit:    { title, body }
 *   linkedin:  { body }
 *   bluesky:   { body }
 *   instagram: { caption, image_url, deep_link }
 *
 * This module:
 *   - aggregates the five publishers
 *   - exposes publishOne(platform, draft) and publishAll(drafts, enabled_platforms)
 *   - normalizes failure modes so the server endpoint can record per-platform
 *     success/failure cleanly
 *
 * Adding a new platform = drop a file here exporting the same shape and add
 * the require below. No changes needed in server.js.
 */

'use strict';

const bluesky   = require('./bluesky');
const x         = require('./x');
const reddit    = require('./reddit');
const linkedin  = require('./linkedin');
const instagram = require('./instagram');

const REGISTRY = { bluesky, x, reddit, linkedin, instagram };

function listConfigured(env = process.env) {
  return Object.entries(REGISTRY)
    .filter(([, mod]) => mod.isConfigured(env))
    .map(([name]) => name);
}

async function publishOne(platform, draft, env = process.env) {
  const mod = REGISTRY[platform];
  if (!mod) return { ok: false, error: `Unknown platform: ${platform}` };
  if (!mod.isConfigured(env)) return { ok: false, error: `${platform} not configured (missing env vars)` };
  try {
    return await mod.publish(draft || {}, env);
  } catch (err) {
    return { ok: false, error: `${platform} threw: ${err.message}` };
  }
}

/**
 * Publish a row's drafts to every enabled+configured platform.
 * Returns { permalinks: { platform: url }, failures: [{ platform, error }] }.
 *
 * Per-platform errors are NON-FATAL — one failing platform does not block
 * the others. Caller writes the result back to social_post_queue.
 */
async function publishAll(drafts, enabled, env = process.env) {
  const permalinks = {};
  const failures   = [];
  for (const [platform] of Object.entries(REGISTRY)) {
    if (enabled && enabled[platform] === false) continue;
    const draft = (drafts || {})[platform];
    if (!draft) {
      failures.push({ platform, error: 'no draft for platform' });
      continue;
    }
    const result = await publishOne(platform, draft, env);
    if (result.ok && result.permalink) {
      permalinks[platform] = result.permalink;
    } else {
      failures.push({ platform, error: result.error || 'unknown failure' });
    }
  }
  return { permalinks, failures };
}

module.exports = {
  REGISTRY,
  listConfigured,
  publishOne,
  publishAll,
};
