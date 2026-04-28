/**
 * apnsClient.js — minimal APNs HTTP/2 sender.
 *
 * Avoids the unmaintained `apn` package by using Node's built-in
 * http2 module + the existing `jsonwebtoken` dep for JWT signing.
 *
 * Required env:
 *   APNS_KEY              — full .p8 contents (PEM PKCS8). Pasted as one line
 *                           with literal "\n" between header / body / footer
 *                           lines, OR multi-line via .env file. Both work.
 *   APNS_KEY_ID           — 10-char key ID from Apple Developer (e.g. ABCDE12345)
 *   APNS_TEAM_ID          — 10-char team ID (e.g. ABCD123456)
 *   APNS_BUNDLE_ID        — iOS app bundle id (e.g. com.earth00.app)
 *   APNS_USE_SANDBOX      — '1' for sandbox APNs (TestFlight), else production
 *
 * If any of these are missing, send() becomes a no-op that returns
 * { delivered: false, error: 'apns_not_configured' } so dev doesn't
 * crash without keys.
 */

'use strict';

const http2 = require('http2');
const jwt   = require('jsonwebtoken');

const APNS_KEY        = process.env.APNS_KEY || '';
const APNS_KEY_ID     = process.env.APNS_KEY_ID || '';
const APNS_TEAM_ID    = process.env.APNS_TEAM_ID || '';
const APNS_BUNDLE_ID  = process.env.APNS_BUNDLE_ID || '';
const USE_SANDBOX     = process.env.APNS_USE_SANDBOX === '1';

const HOST = USE_SANDBOX
  ? 'https://api.sandbox.push.apple.com:443'
  : 'https://api.push.apple.com:443';

function isConfigured() {
  // Note: `\n` literal escape allowed — many hosts strip newlines.
  const keyMaterial = APNS_KEY.replace(/\\n/g, '\n');
  return !!(keyMaterial && APNS_KEY_ID && APNS_TEAM_ID && APNS_BUNDLE_ID);
}

// ─── JWT cache ────────────────────────────────────────────────────────
// APNs accepts JWTs valid up to 1 hour but throttles servers that
// generate too many. Cache for ~50 minutes and reuse.
let _cachedJWT = null;
let _cachedJWTExpiry = 0;

function _getJWT() {
  const now = Math.floor(Date.now() / 1000);
  if (_cachedJWT && _cachedJWTExpiry > now + 60) return _cachedJWT;

  const keyMaterial = APNS_KEY.replace(/\\n/g, '\n');
  _cachedJWT = jwt.sign(
    { iss: APNS_TEAM_ID, iat: now },
    keyMaterial,
    { algorithm: 'ES256', header: { alg: 'ES256', kid: APNS_KEY_ID } }
  );
  _cachedJWTExpiry = now + 50 * 60; // 50 min — Apple expires at 60.
  return _cachedJWT;
}

// ─── HTTP/2 client cache ──────────────────────────────────────────────
// One persistent connection per host — APNs accepts thousands of
// requests over a single session and prefers we reuse it.
let _client = null;
let _clientHost = null;

function _getClient() {
  if (_client && _clientHost === HOST && !_client.destroyed && !_client.closed) {
    return _client;
  }
  if (_client && !_client.closed) {
    try { _client.close(); } catch (_) {}
  }
  _client = http2.connect(HOST);
  _clientHost = HOST;
  _client.on('error', (err) => {
    console.warn('[apns] client error:', err.message);
    _client = null;
  });
  _client.on('close', () => { _client = null; });
  return _client;
}

/**
 * Send a single push notification.
 *
 * @param {Object} opts
 * @param {string} opts.token        — APNs device token (hex)
 * @param {string} opts.title        — notification title
 * @param {string} opts.body         — notification body
 * @param {Object} [opts.data]       — custom payload (kind, reference_id, etc.)
 *                                     for the deep-link handler on the client
 * @param {string} [opts.collapseId] — same id replaces the previous; nice for
 *                                     "thread updated" replacing the previous
 *                                     alert about the same thread
 * @returns {Promise<{ delivered: boolean, statusCode?: number,
 *                     error?: string, apnsId?: string }>}
 */
async function send({ token, title, body, data = {}, collapseId = null }) {
  if (!isConfigured()) {
    return { delivered: false, error: 'apns_not_configured' };
  }
  if (!token || !title || !body) {
    return { delivered: false, error: 'missing_required_fields' };
  }

  const payload = JSON.stringify({
    aps: {
      alert: { title, body },
      sound: 'default',
      badge: 1,
      'mutable-content': 1,
    },
    // Custom data fields the client uses to deep-link the user.
    // Keep keys snake_case for parity with backend; the client decodes.
    ...data,
  });

  return new Promise((resolve) => {
    let client;
    try {
      client = _getClient();
    } catch (err) {
      return resolve({ delivered: false, error: `client_connect_failed: ${err.message}` });
    }

    const headers = {
      ':method':         'POST',
      ':path':           `/3/device/${token}`,
      'authorization':   `bearer ${_getJWT()}`,
      'apns-topic':      APNS_BUNDLE_ID,
      'apns-priority':   '10', // immediate delivery for user-visible alerts
      'apns-push-type':  'alert',
      'content-type':    'application/json',
      'content-length':  Buffer.byteLength(payload),
    };
    if (collapseId) headers['apns-collapse-id'] = collapseId.slice(0, 64);

    const req = client.request(headers);
    let respChunks = [];
    let respStatus = 0;
    let apnsId = null;

    req.on('response', (h) => {
      respStatus = h[':status'] || 0;
      apnsId = h['apns-id'] || null;
    });
    req.on('data', (chunk) => respChunks.push(chunk));
    req.on('end', () => {
      const respBody = Buffer.concat(respChunks).toString('utf8');
      if (respStatus === 200) {
        resolve({ delivered: true, statusCode: 200, apnsId });
      } else {
        let reason = respBody;
        try { reason = JSON.parse(respBody)?.reason || respBody; } catch (_) {}
        resolve({
          delivered:  false,
          statusCode: respStatus,
          error:      `apns_${respStatus}_${reason}`,
          apnsId,
        });
      }
    });
    req.on('error', (err) => {
      resolve({ delivered: false, error: `apns_request_error: ${err.message}` });
    });
    req.setTimeout(8000, () => {
      try { req.close(); } catch (_) {}
      resolve({ delivered: false, error: 'apns_timeout' });
    });

    req.write(payload);
    req.end();
  });
}

// Drop the cached HTTP/2 connection (used in tests + clean shutdown).
function close() {
  if (_client && !_client.closed) {
    try { _client.close(); } catch (_) {}
  }
  _client = null;
}

module.exports = { send, isConfigured, close };
