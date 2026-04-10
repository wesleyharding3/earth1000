#!/usr/bin/env node
'use strict';
require('dotenv').config();
const jwt = require('jsonwebtoken');

const secret = process.env.SUPABASE_JWT_SECRET;
const token = process.argv[2];

if (!token) { console.log('Usage: node test-jwt.js <token>'); process.exit(1); }

console.log('Secret length:', secret?.length);
console.log('Secret preview:', secret?.slice(0, 10) + '...');

try {
  const payload = jwt.verify(token, secret);
  console.log('✅ Token valid:', { sub: payload.sub, email: payload.email, exp: new Date(payload.exp * 1000) });
} catch (e) {
  console.log('❌ Verify failed:', e.message);
  // Try decoding without verification
  const decoded = jwt.decode(token);
  console.log('Decoded (unverified):', { sub: decoded?.sub, email: decoded?.email, exp: decoded?.exp ? new Date(decoded.exp * 1000) : null });
}
