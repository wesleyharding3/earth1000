/**
 * fetchDecode.js — charset-aware response decoder + mojibake screen
 *
 * The fetcher used to call `response.text()` directly, which forces a
 * UTF-8 decode regardless of what the remote server actually sent. For
 * Russian / Eastern European / CJK sources that still serve legacy
 * Windows-1251 / KOI8-R / GB18030 / Shift_JIS feeds, every non-ASCII
 * byte silently became `U+FFFD REPLACEMENT CHARACTER` (visible as `�`)
 * and flowed downstream into article_keywords, threads, timelines —
 * unrecoverable by the time it hits the DB, since the original bytes
 * are gone.
 *
 * This module does two things at the HTTP boundary:
 *
 *   1. Read the raw bytes once via arrayBuffer(), sniff the charset
 *      (Content-Type header → XML prolog → HTML meta → BOM → default
 *      UTF-8), and decode with iconv-lite when the declared charset
 *      isn't UTF-8 compatible.
 *
 *   2. After decode, run a mojibake ratio check. If `�` density is
 *      above a threshold, the bytes were genuinely corrupt (or the
 *      charset lied) and we reject the fetch entirely — better to skip
 *      than persist garbage.
 *
 * Exports:
 *   decodeResponseBody(response) → Promise<string>
 *     Throws on obvious mojibake. Caller should catch and skip the feed.
 *
 *   hasMojibakeRatio(text, threshold = 0.015) → boolean
 *     Standalone check for downstream defense-in-depth (e.g. on scraped
 *     content pulled from a different path).
 *
 *   sniffCharsetFromContentType(contentType) → string|null
 *     Exposed for unit tests / diagnostics.
 */

'use strict';

const iconv = require('iconv-lite');

// ── Mojibake detection ──────────────────────────────────────────────────────
// `\uFFFD` is the Unicode replacement character that TextDecoder inserts
// when it encounters invalid bytes under the declared encoding. Any
// density above ~1% in real article text means decoding went wrong.
// 0.015 (1.5%) is chosen to be permissive — a single stray replacement
// in a long article doesn't poison the whole fetch.
const MOJIBAKE_RATIO_THRESHOLD = 0.015;

function hasMojibakeRatio(text, threshold = MOJIBAKE_RATIO_THRESHOLD) {
  if (!text || typeof text !== 'string') return false;
  const len = text.length;
  if (len < 50) return false; // too short to measure meaningfully
  let n = 0;
  for (let i = 0; i < len; i++) {
    if (text.charCodeAt(i) === 0xFFFD) n++;
  }
  return (n / len) >= threshold;
}

// ── Charset sniffing ────────────────────────────────────────────────────────
// All known legacy single-byte charsets seen in the wild from feeds we
// ingest. iconv-lite handles all of these out of the box. We normalize
// to lowercase + strip quotes because Content-Type headers are wildly
// inconsistent.
const CHARSET_ALIASES = {
  'utf8':        'utf-8',
  'utf-8':       'utf-8',
  'us-ascii':    'utf-8',
  'iso-8859-1':  'latin1',
  'iso88591':    'latin1',
  'latin1':      'latin1',
  'windows-1250':'win1250',
  'win-1250':    'win1250',
  'cp1250':      'win1250',
  'windows-1251':'win1251',
  'win-1251':    'win1251',
  'cp1251':      'win1251',
  'windows-1252':'win1252',
  'win-1252':    'win1252',
  'cp1252':      'win1252',
  'windows-1253':'win1253',
  'windows-1254':'win1254',
  'windows-1255':'win1255',
  'windows-1256':'win1256',
  'windows-1257':'win1257',
  'windows-1258':'win1258',
  'koi8-r':      'koi8-r',
  'koi8r':       'koi8-r',
  'koi8-u':      'koi8-u',
  'gb2312':      'gbk',
  'gbk':         'gbk',
  'gb18030':     'gb18030',
  'big5':        'big5',
  'shift_jis':   'shift_jis',
  'shift-jis':   'shift_jis',
  'sjis':        'shift_jis',
  'euc-jp':      'euc-jp',
  'euc-kr':      'euc-kr',
};

function normalizeCharset(raw) {
  if (!raw) return null;
  const cleaned = String(raw).trim().toLowerCase().replace(/['"]/g, '');
  return CHARSET_ALIASES[cleaned] || cleaned;
}

function sniffCharsetFromContentType(contentType) {
  if (!contentType) return null;
  const m = String(contentType).match(/charset\s*=\s*["']?([\w\-_]+)/i);
  return m ? normalizeCharset(m[1]) : null;
}

// Scan first ~2 KB for an XML prolog or HTML charset declaration. Done
// on the raw bytes interpreted as latin1 since ASCII-range metadata is
// identical regardless of the actual payload encoding — safe because
// charset declarations only use ASCII characters.
function sniffCharsetFromBody(buffer) {
  const head = buffer.slice(0, Math.min(2048, buffer.length)).toString('latin1');
  // XML prolog: <?xml version="1.0" encoding="windows-1251"?>
  let m = head.match(/<\?xml[^>]*encoding\s*=\s*["']([\w\-_]+)["']/i);
  if (m) return normalizeCharset(m[1]);
  // HTML5 meta charset: <meta charset="utf-8">
  m = head.match(/<meta[^>]+charset\s*=\s*["']?([\w\-_]+)/i);
  if (m) return normalizeCharset(m[1]);
  // Legacy HTML meta http-equiv: <meta http-equiv="Content-Type" content="text/html; charset=windows-1251">
  m = head.match(/<meta[^>]+http-equiv\s*=\s*["']content-type["'][^>]+content\s*=\s*["'][^"']*charset\s*=\s*([\w\-_]+)/i);
  if (m) return normalizeCharset(m[1]);
  return null;
}

function sniffCharsetFromBOM(buffer) {
  if (buffer.length < 2) return null;
  const b0 = buffer[0], b1 = buffer[1], b2 = buffer[2];
  if (b0 === 0xEF && b1 === 0xBB && b2 === 0xBF) return 'utf-8';
  if (b0 === 0xFE && b1 === 0xFF)                 return 'utf-16be';
  if (b0 === 0xFF && b1 === 0xFE)                 return 'utf-16le';
  return null;
}

// ── Main decoder ────────────────────────────────────────────────────────────
async function decodeResponseBody(response, { urlForLog = '' } = {}) {
  // fetch's .arrayBuffer() gives us the raw bytes before any decode has
  // happened. We do the decode ourselves with the right charset.
  const ab = await response.arrayBuffer();
  const buffer = Buffer.from(ab);
  if (!buffer.length) return '';

  // Priority order: BOM (most reliable) → XML/HTML declaration (source
  // of truth when present) → Content-Type header (often lies) → UTF-8
  // default.
  const fromBOM          = sniffCharsetFromBOM(buffer);
  const fromBody         = sniffCharsetFromBody(buffer);
  const fromContentType  = sniffCharsetFromContentType(response.headers?.get?.('content-type'));

  const charset = fromBOM || fromBody || fromContentType || 'utf-8';

  let text;
  if (charset === 'utf-8') {
    // Use TextDecoder with fatal:false so invalid sequences become
    // U+FFFD (we'll detect below). This matches what response.text()
    // did — the difference is that for non-UTF-8 charsets we avoid
    // the forced UTF-8 decode entirely.
    text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  } else if (iconv.encodingExists(charset)) {
    try {
      text = iconv.decode(buffer, charset);
    } catch (err) {
      // iconv failed outright — fall back to UTF-8 so the caller at
      // least gets something. Mojibake check below will likely trip
      // and cause the fetch to be rejected.
      console.warn(`[fetchDecode] iconv.decode(${charset}) failed for ${urlForLog}: ${err.message}`);
      text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
    }
  } else {
    // Unknown charset — fall back to UTF-8. Same mojibake reject path.
    console.warn(`[fetchDecode] unknown charset "${charset}" for ${urlForLog}`);
    text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }

  // After decode, reject if too many replacement characters. The caller
  // should catch this and skip the feed rather than store garbage.
  if (hasMojibakeRatio(text)) {
    const err = new Error(`Mojibake detected after ${charset} decode (U+FFFD ratio exceeds ${(MOJIBAKE_RATIO_THRESHOLD*100).toFixed(1)}%)`);
    err.code = 'MOJIBAKE';
    err.charset = charset;
    err.url = urlForLog;
    throw err;
  }

  return text;
}

// Same logic as decodeResponseBody but for callers using raw Node
// https.get / http.get that accumulate chunks into a Buffer themselves
// (articleDeepEnrichment.js, the legacy scraper). Takes the Buffer plus
// the Content-Type header string so we can run the same charset sniff.
function decodeBuffer(buffer, contentTypeHeader = null, { urlForLog = '' } = {}) {
  if (!buffer || !buffer.length) return '';
  const fromBOM         = sniffCharsetFromBOM(buffer);
  const fromBody        = sniffCharsetFromBody(buffer);
  const fromContentType = sniffCharsetFromContentType(contentTypeHeader);
  const charset         = fromBOM || fromBody || fromContentType || 'utf-8';

  let text;
  if (charset === 'utf-8') {
    text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  } else if (iconv.encodingExists(charset)) {
    try {
      text = iconv.decode(buffer, charset);
    } catch (err) {
      console.warn(`[fetchDecode] iconv.decode(${charset}) failed for ${urlForLog}: ${err.message}`);
      text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
    }
  } else {
    console.warn(`[fetchDecode] unknown charset "${charset}" for ${urlForLog}`);
    text = new TextDecoder('utf-8', { fatal: false }).decode(buffer);
  }

  if (hasMojibakeRatio(text)) {
    const err = new Error(`Mojibake detected after ${charset} decode (U+FFFD ratio exceeds ${(MOJIBAKE_RATIO_THRESHOLD*100).toFixed(1)}%)`);
    err.code = 'MOJIBAKE';
    err.charset = charset;
    err.url = urlForLog;
    throw err;
  }
  return text;
}

module.exports = {
  decodeResponseBody,
  decodeBuffer,
  hasMojibakeRatio,
  sniffCharsetFromContentType,
  sniffCharsetFromBody,
  sniffCharsetFromBOM,
  normalizeCharset,
  MOJIBAKE_RATIO_THRESHOLD,
};
