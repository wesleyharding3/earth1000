#!/usr/bin/env node
//
// downloadBriefing.js — pull a briefing episode + its segment audio from
// the running API, save everything to ./briefings/<date>-<id>/.
//
// Usage:
//   node downloadBriefing.js                # latest published episode
//   node downloadBriefing.js --latest       # explicit (same as default)
//   node downloadBriefing.js --id 42        # specific episode by id
//   node downloadBriefing.js --date 2026-05-19   # episode for a given target_date
//
// Auth:
//   EARTH_API_BASE      base URL of the API (default https://earth-wjr6.onrender.com)
//   EARTH_ADMIN_TOKEN   Supabase Bearer token for an admin user (required)
//
// Output (per run):
//   briefings/<YYYY-MM-DD>-<id>/
//     metadata.json                  episode metadata
//     segments.json                  full segments array (verbatim)
//     full.mp3                       entire briefing audio
//     segments/
//       00-<slug>.mp3                per-segment audio
//       00-<slug>.txt                voiceover text (for caption / quote use)
//       00-<slug>.json               just this segment's JSON (for inspection)
//
// Each segment is sliced from the full briefing using the existing
// /api/briefing/audio/:id/:segIdx endpoint (CBR 128kbps, 16 bytes/ms).
// We pull each slice independently rather than slicing locally — keeps
// us honest about whatever boundary logic the server enforces.

const fs   = require('fs');
const path = require('path');

const API_BASE = (process.env.EARTH_API_BASE || 'https://earth-wjr6.onrender.com').replace(/\/+$/, '');
const TOKEN    = process.env.EARTH_ADMIN_TOKEN;

if (!TOKEN) {
  console.error(`❌ EARTH_ADMIN_TOKEN not set.
   Add it to your environment (or .env) — a Supabase Bearer token for an admin user.
   Then re-run.`);
  process.exit(1);
}

const args = process.argv.slice(2);
function argVal(name) {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
}
const wantId      = argVal('--id');
const wantDate    = argVal('--date');
const wantLatest  = args.includes('--latest') || (!wantId && !wantDate);

function authHeaders(extra = {}) {
  return { Authorization: `Bearer ${TOKEN}`, ...extra };
}

async function getJson(url) {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} on ${url}\n${body.slice(0, 240)}`);
  }
  return res.json();
}

async function getBuffer(url) {
  const res = await fetch(url, { headers: authHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`${res.status} ${res.statusText} on ${url}\n${body.slice(0, 240)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// Resolve which episode id we're pulling.
async function resolveEpisodeId() {
  if (wantId) return parseInt(wantId, 10);
  if (wantDate) {
    // /api/briefing/recent returns the archive list — filter by target_date.
    const recent = await getJson(`${API_BASE}/api/briefing/recent`);
    const list   = Array.isArray(recent) ? recent : (recent.episodes || []);
    const hit    = list.find(e =>
      String(e.target_date || '').slice(0, 10) === wantDate
    );
    if (!hit) throw new Error(`No briefing found for date ${wantDate}`);
    return hit.id;
  }
  // --latest (default) — admin status endpoint returns today's episode.
  const st = await getJson(`${API_BASE}/api/admin/briefing-editor/status`);
  if (!st || st.status === 'none' || !st.episode_id) {
    throw new Error('No episode for today. Pass --id or --date to target a specific one.');
  }
  return st.episode_id;
}

function slug(s, max = 60) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max) || 'untitled';
}

function pad2(n) { return String(n).padStart(2, '0'); }

function segLabel(seg, idx) {
  const type = seg.segment_type || seg.type || 'segment';
  if (type === 'intro')    return 'intro';
  if (type === 'outro')    return 'outro';
  if (type === 'keywords') return 'keywords';
  if (type === 'summary')  return 'summary';
  // story segment — prefer thread_title, fall back to first sentence.
  const t = seg.thread_title
    || (seg.voiceover_text || seg.voiceover || '').split(/[.!?]/)[0]
    || `seg-${idx}`;
  return slug(t);
}

function segVoiceover(seg) {
  return [
    seg.voiceover_before_video,
    seg.voiceover_text || seg.voiceover,
    seg.voiceover_after_video,
  ].filter(Boolean).join('\n\n');
}

async function main() {
  console.log(`📡 API base: ${API_BASE}`);
  const episodeId = await resolveEpisodeId();
  console.log(`🎯 Episode id: ${episodeId}`);

  const ep = await getJson(`${API_BASE}/api/admin/briefing-editor/segments/${episodeId}`);
  if (!ep || !Array.isArray(ep.segments)) {
    throw new Error(`Episode ${episodeId} has no segments`);
  }
  const segments  = ep.segments;
  const headline  = ep.headline || '(no headline)';
  // target_date isn't on this response; fall back to today if missing.
  const targetDate = (ep.target_date || segments[0]?.target_date || new Date().toISOString().slice(0, 10)).slice(0, 10);

  console.log(`📜 Headline   : ${headline}`);
  console.log(`📅 Date       : ${targetDate}`);
  console.log(`🎙️  Segments  : ${segments.length}`);
  console.log(`🔊 Has audio  : ${ep.has_audio ? 'yes' : 'NO (cannot download audio)'}`);

  const outDir    = path.join(process.cwd(), 'briefings', `${targetDate}-${episodeId}`);
  const segDir    = path.join(outDir, 'segments');
  fs.mkdirSync(segDir, { recursive: true });
  console.log(`📁 Output dir : ${path.relative(process.cwd(), outDir)}/`);

  // metadata.json + segments.json (always — even if no audio).
  fs.writeFileSync(path.join(outDir, 'metadata.json'), JSON.stringify({
    episode_id:    episodeId,
    target_date:   targetDate,
    headline,
    status:        ep.status,
    has_audio:     !!ep.has_audio,
    segment_count: segments.length,
    fetched_at:    new Date().toISOString(),
    api_base:      API_BASE,
  }, null, 2));
  fs.writeFileSync(path.join(outDir, 'segments.json'), JSON.stringify(segments, null, 2));

  if (!ep.has_audio) {
    console.log(`\n⚠️  No audio on this episode — skipping MP3 downloads.`);
    console.log(`✅ Saved metadata + segments JSON.`);
    return;
  }

  // Full briefing MP3.
  console.log(`\n⏬ full.mp3 …`);
  const full = await getBuffer(`${API_BASE}/api/briefing/audio/${episodeId}`);
  fs.writeFileSync(path.join(outDir, 'full.mp3'), full);
  console.log(`   ${(full.length / 1024).toFixed(1)} KB`);

  // Per-segment audio + text + json.
  for (let i = 0; i < segments.length; i++) {
    const seg   = segments[i];
    const label = `${pad2(i)}-${segLabel(seg, i)}`;
    process.stdout.write(`⏬ segments/${label}.mp3 … `);
    try {
      const buf = await getBuffer(`${API_BASE}/api/briefing/audio/${episodeId}/${i}`);
      fs.writeFileSync(path.join(segDir, `${label}.mp3`), buf);
      fs.writeFileSync(path.join(segDir, `${label}.txt`), segVoiceover(seg));
      fs.writeFileSync(path.join(segDir, `${label}.json`), JSON.stringify(seg, null, 2));
      console.log(`${(buf.length / 1024).toFixed(1)} KB`);
    } catch (e) {
      // Segment-level failure is non-fatal — log and continue.
      console.log(`SKIPPED (${e.message.split('\n')[0]})`);
      fs.writeFileSync(path.join(segDir, `${label}.txt`), segVoiceover(seg));
      fs.writeFileSync(path.join(segDir, `${label}.json`), JSON.stringify(seg, null, 2));
    }
  }

  // Summary table.
  console.log(`\n📋 Summary:`);
  console.log(`   ${'#'.padStart(3)}  ${'TYPE'.padEnd(10)}  ${'AUDIO'.padEnd(8)}  TITLE`);
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const label = `${pad2(i)}-${segLabel(seg, i)}`;
    const mp3 = path.join(segDir, `${label}.mp3`);
    const audioSize = fs.existsSync(mp3) ? `${(fs.statSync(mp3).size / 1024).toFixed(0)} KB` : '—';
    const title = seg.thread_title || seg.segment_type || seg.type || '(intro/outro/recap)';
    console.log(`   ${pad2(i).padStart(3)}  ${(seg.segment_type || seg.type || 'story').padEnd(10)}  ${audioSize.padEnd(8)}  ${title.slice(0, 70)}`);
  }

  console.log(`\n✅ Saved to ${path.relative(process.cwd(), outDir)}/`);
}

main().catch(e => {
  console.error(`\n❌ Failed: ${e.message}`);
  process.exit(1);
});
