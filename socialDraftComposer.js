/**
 * socialDraftComposer.js — pure template-fill for per-platform social
 * post drafts. NO AI. Thread title + description + flag chip row is
 * already curated content; the only thing platforms need is shape-
 * fitting (character limits, formatting conventions).
 *
 * Each platform's draft is editable by the human reviewer in earth-
 * editor before publishing. The composer's job is to produce a clean
 * STARTING DRAFT, not a publish-ready post.
 *
 * Input shape — pass an enriched thread row:
 *   {
 *     id, title, description,
 *     primary_nations:   ['US','IR','IL'],
 *     secondary_nations: ['DE','FR','GB'],
 *     primary_category:  'diplomacy',
 *     article_count:     47,
 *     last_updated_at:   '2026-05-15T...',
 *   }
 *
 * Output:
 *   {
 *     x:        { body: '...' },           // ≤ 280 chars
 *     reddit:   { title: '...', body: '...' },
 *     linkedin: { body: '...' },           // ≤ 3000 chars
 *     bluesky:  { body: '...' },           // ≤ 300 chars
 *     instagram:{ caption: '...', image_url: '...' },
 *   }
 *
 * Constants tuned to platform limits (2026). If a platform changes
 * limits, bump here.
 */

'use strict';

const X_MAX        = 280;
const REDDIT_TITLE = 300;
const LINKEDIN_MAX = 3000;
const BLUESKY_MAX  = 300;
const IG_CAPTION_MAX = 2200;

const SHARE_HOST = process.env.SHARE_HOST || 'https://earth00.com';

// ── Helpers ────────────────────────────────────────────────────────────────

// ISO 3166-1 alpha-2 → regional indicator emoji pair. Renders as a flag
// on every platform that supports emoji (X, Reddit, LinkedIn, BlueSky,
// Instagram all do). Falls back to the ISO code text if the input
// isn't a clean 2-letter code.
function isoToFlag(iso) {
  const c = String(iso || '').toUpperCase().trim();
  if (!/^[A-Z]{2}$/.test(c)) return c;
  const base = 0x1F1E6;     // regional indicator A
  const a = base + (c.charCodeAt(0) - 65);
  const b = base + (c.charCodeAt(1) - 65);
  return String.fromCodePoint(a) + String.fromCodePoint(b);
}

function flagRow(isos, limit = 8) {
  if (!Array.isArray(isos) || !isos.length) return '';
  return isos.slice(0, limit).map(isoToFlag).join(' ');
}

// Truncate at a word boundary so we don't leave a half-word at the cut.
// Reserves the last ~3 chars for an ellipsis.
function truncateAtWord(text, max) {
  if (!text) return '';
  const s = String(text).trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  const slice = lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut;
  return slice.trimEnd() + '…';
}

// "May 15, 2026"
function fmtDateLong(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function shareLink(threadId) {
  return `${SHARE_HOST}/share/thread/${threadId}`;
}

// Per-category hashtag suggestions. Light touch — heavy hashtag stuffing
// hurts engagement on X / LinkedIn, helps on Instagram.
const CATEGORY_HASHTAGS = {
  politics:    ['#geopolitics', '#worldnews'],
  diplomacy:   ['#geopolitics', '#diplomacy'],
  conflict:    ['#geopolitics', '#breakingnews'],
  military:    ['#geopolitics', '#defense'],
  economy:     ['#economy', '#worldnews'],
  technology:  ['#tech', '#worldnews'],
  environment: ['#climate', '#worldnews'],
  climate:     ['#climate', '#worldnews'],
  health:      ['#publichealth', '#worldnews'],
  business:    ['#business', '#worldnews'],
};

function hashtagsFor(category) {
  const base = ['#earth00'];
  const cat = String(category || '').toLowerCase();
  const extra = CATEGORY_HASHTAGS[cat] || ['#worldnews'];
  return [...base, ...extra].join(' ');
}

// ── Per-platform composers ─────────────────────────────────────────────────

function composeX(thread) {
  const flags = flagRow(thread.primary_nations, 6);
  const hookLine = thread.title.trim();
  // Reserve ~30 chars for flags + link + space.
  // Pattern: [hook]\n\n[trimmed description]\n\n[flags] [link]
  const link = shareLink(thread.id);
  const footer = flags ? `${flags}\n${link}` : link;
  const reserveForFooter = footer.length + 2;
  const reserveForHook = hookLine.length + 2;
  const remaining = X_MAX - reserveForFooter - reserveForHook;
  let body;
  if (remaining > 40) {
    const trimmedDesc = truncateAtWord(thread.description || '', remaining);
    body = `${hookLine}\n\n${trimmedDesc}\n\n${footer}`;
  } else {
    // Hook + footer alone is already near the limit — drop the description.
    body = `${truncateAtWord(hookLine, X_MAX - footer.length - 2)}\n\n${footer}`;
  }
  return { body: body.slice(0, X_MAX) };
}

function composeReddit(thread) {
  const title = truncateAtWord(thread.title, REDDIT_TITLE);
  const flags = flagRow(thread.primary_nations, 8);
  const link  = shareLink(thread.id);
  const body  = [
    thread.description || '',
    flags ? `\n**Countries involved:** ${flags}` : '',
    thread.article_count
      ? `\n*Tracked across ${thread.article_count} articles on [Earth00](${link}).*`
      : `\n*[Read the full briefing on Earth00](${link}).*`,
  ].filter(Boolean).join('\n');
  return { title, body };
}

function composeLinkedIn(thread) {
  const flags = flagRow(thread.primary_nations, 8);
  const link  = shareLink(thread.id);
  const updatedNote = thread.last_updated_at
    ? `Updated ${fmtDateLong(thread.last_updated_at)} — `
    : '';
  // LinkedIn favors slightly more formal framing.
  const body = [
    thread.title,
    '',
    thread.description || '',
    flags ? `\nKey countries: ${flags}` : '',
    `\n${updatedNote}Track the full storyline at ${link}`,
  ].filter(Boolean).join('\n');
  return { body: truncateAtWord(body, LINKEDIN_MAX) };
}

function composeBluesky(thread) {
  const flags = flagRow(thread.primary_nations, 5);
  const link = shareLink(thread.id);
  // BlueSky link cards render from the URL, so we keep the body tight.
  const reserve = link.length + flags.length + 4;
  const room = BLUESKY_MAX - reserve;
  const hook = truncateAtWord(thread.title, Math.max(60, room));
  const body = `${hook}\n${flags ? flags + ' ' : ''}${link}`;
  return { body: body.slice(0, BLUESKY_MAX) };
}

function composeThreads(thread) {
  // Threads: 500 char limit. Renders OG link previews automatically, so
  // text + share URL gets the stylized card for free — same pattern as
  // BlueSky (no explicit image attachment needed).
  const flags = flagRow(thread.primary_nations, 6);
  const link = shareLink(thread.id);
  const reserve = link.length + flags.length + 4;
  const room = 500 - reserve;
  const hook = truncateAtWord(thread.title, Math.max(80, Math.floor(room * 0.5)));
  const desc = thread.description
    ? truncateAtWord(thread.description, room - hook.length - 4)
    : '';
  const parts = [hook];
  if (desc) parts.push('', desc);
  parts.push('', `${flags ? flags + ' ' : ''}${link}`);
  return { body: parts.join('\n').slice(0, 500) };
}

function composeInstagram(thread) {
  const flags = flagRow(thread.primary_nations, 8);
  const link  = shareLink(thread.id);
  const tags  = hashtagsFor(thread.primary_category);
  const caption = [
    thread.title,
    '',
    thread.description || '',
    flags ? `\n${flags}` : '',
    `\nMore at earth00.com (link in bio).`,
    '',
    tags,
  ].filter(Boolean).join('\n');
  return {
    caption: truncateAtWord(caption, IG_CAPTION_MAX),
    // Server-side share image generator already exists; render at this URL.
    image_url: `${SHARE_HOST}/share/thread/${thread.id}.png`,
    deep_link: link,
  };
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Compose all per-platform drafts for a thread.
 * Returns { x, reddit, linkedin, bluesky, instagram }.
 */
function composeDrafts(thread) {
  if (!thread || !thread.id || !thread.title) {
    throw new Error('composeDrafts: thread requires id and title');
  }
  return {
    x:         composeX(thread),
    reddit:    composeReddit(thread),
    linkedin:  composeLinkedIn(thread),
    bluesky:   composeBluesky(thread),
    instagram: composeInstagram(thread),
    threads:   composeThreads(thread),
  };
}

module.exports = {
  composeDrafts,
  // Exposed for testing + reuse in the editor's live-edit UI:
  isoToFlag,
  flagRow,
  truncateAtWord,
};
