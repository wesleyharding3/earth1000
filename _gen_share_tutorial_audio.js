#!/usr/bin/env node
'use strict';

/**
 * _gen_share_tutorial_audio.js
 *
 * One-shot script to synthesise the narration MP3 for the new
 * "Share" tutorial chapter (chapter 11, between "Briefing" and
 * "Keywords"). Uses the same ElevenLabs setup that briefingGenerator
 * already relies on — reads ELEVENLABS_API_KEY + ELEVENLABS_VOICE_ID
 * from the project .env. Output is written to
 *   www/audio/tutorial/13_share.mp3
 *
 * Naming convention: tutorial mp3s are numbered AND keyed by chapter
 * id (e.g. 10_briefing.mp3). The new file is 13_share.mp3 — file
 * numbering picks up where the existing series left off (we kept
 * 12_outro.mp3 in place and inserted Share before it as chapter 11
 * in the chapters array, but the FILE keeps a higher number to avoid
 * renaming existing assets). Both bundles' tutorial code reference
 * `AUDIO_BASE + '13_share.mp3'`.
 *
 * Usage:
 *   ELEVENLABS_API_KEY=… ELEVENLABS_VOICE_ID=… node _gen_share_tutorial_audio.js
 *   # or, with .env populated:
 *   node _gen_share_tutorial_audio.js
 *
 * Flags:
 *   --dry-run   Print the script + estimated duration, don't call the API.
 *   --out=PATH  Override output path (default: www/audio/tutorial/13_share.mp3).
 */

require('dotenv').config({ override: true });

const fs   = require('fs');
const path = require('path');

const ARGV = new Map(process.argv.slice(2).map(a => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.length ? rest.join('=') : true];
}));

const DRY_RUN = !!ARGV.get('dry-run');
const OUT     = ARGV.get('out') ||
                path.join(__dirname, 'www', 'audio', 'tutorial', '13_share.mp3');

const ELEVENLABS_KEY = process.env.ELEVENLABS_API_KEY;
const VOICE_ID       = process.env.ELEVENLABS_VOICE_ID ||
                       process.env.ELEVENLABS_VOICE_ID_ENGLISH;

// ─── Narration script ────────────────────────────────────────────────
// Pacing target: ~155-165 wpm to match the existing tutorial cadence
// (the other narrations land between 145-170 wpm depending on chapter
// energy). Approx 95 words → ~36 seconds.
//
// Structure mirrors the visual beats the chapter will trigger:
//   1. Hook + where to find share          (~0-5s) — pulse a share icon
//   2. Format intro: "three formats"        (~5-7s) — slideshow opens
//   3. Link format                          (~7-13s) — slide 1
//   4. Snapshot format                      (~13-21s) — slide 2
//   5. Clip format                          (~21-30s) — slide 3 + globe spin
//   6. Closer                               (~30-34s)
//
// Voice direction note (handled via voice_settings, not script): warm
// + conversational, same as the rest of the tutorial. No exclamations
// — the existing reels stay measured.
const SCRIPT = `Found a story worth sharing? Tap the share icon on any panel — a thread, a line, a briefing, or a heatmap question. You'll get three formats. Link is the quick version: a clean card with the headline, the source, and a deep link straight back. Snapshot captures your live globe view as a still image — square for a feed, vertical for a story. And Clip records a six-second cinematic spin of whatever you're looking at right now, perfect for posting anywhere. Send what catches your eye.`;

const wordCount = SCRIPT.split(/\s+/).filter(Boolean).length;
const estDurSec = Math.round((wordCount / 158) * 60);

console.log(`\n📝 Share tutorial narration`);
console.log(`   words:    ${wordCount}`);
console.log(`   est. duration: ~${estDurSec}s (at 158 wpm)`);
console.log(`   output:   ${OUT}\n`);
console.log(`────────────────────────────────────────────────────────────`);
console.log(SCRIPT);
console.log(`────────────────────────────────────────────────────────────\n`);

if (DRY_RUN) {
  console.log('Dry-run — no API call. Pass without --dry-run to synthesise.');
  process.exit(0);
}

if (!ELEVENLABS_KEY) {
  console.error('❌ ELEVENLABS_API_KEY not set. Add to .env or pass on the CLI.');
  process.exit(1);
}
if (!VOICE_ID) {
  console.error('❌ ELEVENLABS_VOICE_ID (or ELEVENLABS_VOICE_ID_ENGLISH) not set.');
  process.exit(1);
}

(async () => {
  // Use the SAME endpoint + voice_settings briefingGenerator uses so
  // the narrator sounds identical to the existing chapters. The
  // /with-timestamps endpoint isn't required here (we don't need word
  // timings for tutorial captions — the chapter's `caption` string
  // shows for the full duration), but it costs the same so we use
  // the simpler /text-to-speech endpoint.
  const url = `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}`;
  const body = {
    text:     SCRIPT,
    model_id: 'eleven_multilingual_v2',
    voice_settings: {
      stability:         0.55,
      similarity_boost:  0.75,
      style:             0.20,
      use_speaker_boost: true,
    },
  };

  console.log('🎙  Calling ElevenLabs…');
  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'xi-api-key':   ELEVENLABS_KEY,
      'Content-Type': 'application/json',
      'Accept':       'audio/mpeg',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`❌ ElevenLabs error ${res.status}: ${errText}`);
    process.exit(1);
  }

  const buffer = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, buffer);

  const kb = (buffer.length / 1024).toFixed(1);
  console.log(`✅ Wrote ${OUT} (${kb} KB)`);
  console.log(`   Both index.html and www/index.html reference this file via AUDIO_BASE + '13_share.mp3'.`);
  console.log(`   Test by triggering the tutorial — chapter 11 (between Briefing and Keywords).\n`);
})().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
