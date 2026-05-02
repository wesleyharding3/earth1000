#!/usr/bin/env node
'use strict';

/**
 * One-shot generator for the 15-second intro tutorial voiceover.
 *
 * Reads ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID from .env, sends the
 * locked script to ElevenLabs, saves the mp3 to www/audio/intro/welcome.mp3.
 * Re-run any time the script copy changes.
 *
 * Run:  node scripts/generateIntroAudio.js
 *
 * Cost: ~$0.40 of credits per run (single ~37-word clip).
 */

require('dotenv').config({ override: true });
const fs   = require('fs');
const path = require('path');

const SCRIPT = "Here's the globe — tap any country or city to dive in. Over here's your news tab — every story we're tracking. And the stats view shows what the world is talking about — and where. That's it. Start exploring.";

const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || process.env.ELEVENLABS_VOICE_ID_ENGLISH;
const API_KEY  = process.env.ELEVENLABS_API_KEY;

if (!API_KEY)  { console.error('ELEVENLABS_API_KEY not set in .env'); process.exit(1); }
if (!VOICE_ID) { console.error('ELEVENLABS_VOICE_ID (or ELEVENLABS_VOICE_ID_ENGLISH) not set in .env'); process.exit(1); }

const OUT_DIR  = path.join(__dirname, '..', 'www', 'audio', 'intro');
const OUT_FILE = path.join(OUT_DIR, 'welcome.mp3');

// Match the briefing generator's voice settings so the intro sounds
// consistent with the rest of the app's narration (see briefingGenerator.js).
const VOICE_SETTINGS = {
  stability:         0.45,
  similarity_boost:  0.75,
  style:             0.20,
  use_speaker_boost: true,
};

async function main() {
  console.log(`[intro-audio] generating ${SCRIPT.split(/\s+/).length}-word clip with voice ${VOICE_ID.slice(0, 8)}…`);

  const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`;
  const r = await fetch(url, {
    method:  'POST',
    headers: {
      'xi-api-key':  API_KEY,
      'Content-Type':'application/json',
      Accept:        'audio/mpeg',
    },
    body: JSON.stringify({
      text:           SCRIPT,
      model_id:       'eleven_multilingual_v2',
      voice_settings: VOICE_SETTINGS,
    }),
  });

  if (!r.ok) {
    const errText = await r.text().catch(() => '');
    console.error(`[intro-audio] ElevenLabs ${r.status}: ${errText.slice(0, 500)}`);
    process.exit(1);
  }

  const buf = Buffer.from(await r.arrayBuffer());
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_FILE, buf);

  const sizeKB = (buf.byteLength / 1024).toFixed(1);
  console.log(`[intro-audio] wrote ${OUT_FILE} (${sizeKB} KB)`);
  console.log(`[intro-audio] also bundle to www/ → use \`npx cap copy ios\` after committing.`);
}

main().catch(err => { console.error('[intro-audio] fatal:', err); process.exit(1); });
