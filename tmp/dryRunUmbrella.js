// Dry-run the article umbrella phase against live DB.
// Uses the exact same SQL pre-filter + scoring as the builder but does NOT
// insert or update anything. Prints per-Line stats + top 5 hypothetical
// attachments per Line.
//
// Usage: node tmp/dryRunUmbrella.js
require('dotenv').config();
const pool = require('../db');
const { loadContextForArticles } = require('../articleDeepEnrichment');

const W_ENTITY  = 2.5, W_NATION = 2.5, W_KEYWORD = 1.0, W_TITLE = 0.4;
const ENTITY_CAP = 6, KEYWORD_CAP = 8;
const ATTACH = 4.0;  // UMBRELLA_ATTACH_THRESHOLD — lower than thread→line 6.0
const LOOKBACK = 7;
const CAND_CAP = 200;

const STOP = new Set(['the','a','an','of','in','on','at','to','for','and','or','but','is','are','was','were',
  'with','from','by','as','that','this','its','it','after','before','over','under',
  'new','old','first','last','top','all','some','any','news','report','update','coverage','story','analysis']);

function normalizeKw(k){return String(k||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/["""'`]/g,'').replace(/[^\p{L}\p{N}\s-]/gu,' ').replace(/\s+/g,' ').trim();}
function tokTitle(t){return new Set(String(t||'').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu,' ').split(/\s+/).filter(w=>w.length>2 && !STOP.has(w)));}
function inter(a,b){if(!a||!b)return 0;let n=0;for(const x of a)if(b.has(x))n++;return n;}

(async () => {
  const { rows: lines } = await pool.query(`
    SELECT id, title, status, keywords, primary_nations
    FROM story_timelines
    WHERE status IN ('active','cooling')
    ORDER BY status, last_updated_at DESC
  `);
  console.log(`Lines to scan: ${lines.length}\n`);

  // Build features (top-10 articles per Line → entity set)
  const ids = lines.map(l => l.id);
  const { rows: links } = await pool.query(`
    SELECT timeline_id, article_id FROM (
      SELECT sta.timeline_id, sta.article_id,
             ROW_NUMBER() OVER (PARTITION BY sta.timeline_id ORDER BY sta.relevance_score DESC NULLS LAST, sta.added_at DESC) AS rn
      FROM story_timeline_articles sta
      WHERE sta.timeline_id = ANY($1::int[])
    ) r WHERE rn <= 10
  `, [ids]);
  const byLine = new Map();
  const allArts = new Set();
  for (const r of links) { if(!byLine.has(r.timeline_id)) byLine.set(r.timeline_id,[]); byLine.get(r.timeline_id).push(r.article_id); allArts.add(r.article_id); }
  const ctxMap = await loadContextForArticles([...allArts]);

  const feat = new Map();
  for (const tl of lines) {
    const ents = new Set();
    for (const aid of (byLine.get(tl.id)||[])) {
      const ctx = ctxMap.get(aid);
      if (!ctx) continue;
      for (const e of (ctx.entities||[])) if(e?.text) ents.add(String(e.text).toLowerCase().trim());
    }
    feat.set(tl.id, {
      entities: ents,
      nations: new Set((tl.primary_nations||[]).map(n=>String(n).toUpperCase())),
      keywords: new Set((tl.keywords||[]).map(normalizeKw).filter(Boolean)),
      titleTokens: tokTitle(tl.title),
    });
  }

  let totCand = 0, totScored = 0, totQualified = 0, totLinesWithHits = 0, totCoolRestored = 0;
  for (const tl of lines) {
    const f = feat.get(tl.id);
    const natsArr = [...f.nations], kwsArr = [...f.keywords];
    if (!natsArr.length && !kwsArr.length) continue;

    const { rows: cands } = await pool.query(`
      SELECT DISTINCT ON (id) id, title, published_at, iso_code
      FROM (
        SELECT a.id, a.title, a.published_at, co.iso_code
        FROM news_articles a JOIN countries co ON co.id=a.country_id
        WHERE cardinality($2::text[]) > 0
          AND a.published_at >= NOW() - INTERVAL '${LOOKBACK} days'
          AND co.iso_code = ANY($2::text[])
          AND NOT EXISTS (SELECT 1 FROM story_timeline_articles sta WHERE sta.timeline_id=$1 AND sta.article_id=a.id)
        UNION
        SELECT a.id, a.title, a.published_at, co.iso_code
        FROM article_keywords ak
        JOIN news_articles a ON a.id=ak.article_id
        LEFT JOIN countries co ON co.id=a.country_id
        WHERE cardinality($3::text[]) > 0
          AND ak.normalized_keyword = ANY($3::text[])
          AND a.published_at >= NOW() - INTERVAL '${LOOKBACK} days'
          AND NOT EXISTS (SELECT 1 FROM story_timeline_articles sta WHERE sta.timeline_id=$1 AND sta.article_id=a.id)
      ) u
      ORDER BY id, published_at DESC
      LIMIT $4
    `, [tl.id, natsArr, kwsArr, CAND_CAP]);

    if (!cands.length) continue;
    totCand += cands.length;
    totScored += cands.length;

    const cIds = cands.map(c => Number(c.id));
    const cCtx = await loadContextForArticles(cIds);
    const { rows: akRows } = await pool.query(`SELECT article_id, COALESCE(normalized_keyword, LOWER(keyword)) AS kw FROM article_keywords WHERE article_id=ANY($1::int[])`, [cIds]);
    const kwMap = new Map();
    for (const r of akRows) { if(!kwMap.has(r.article_id)) kwMap.set(r.article_id, new Set()); kwMap.get(r.article_id).add(r.kw); }

    const hits = [];
    for (const c of cands) {
      const ctx = cCtx.get(Number(c.id));
      const ents = new Set();
      if (ctx) for (const e of (ctx.entities||[])) if(e?.text) ents.add(String(e.text).toLowerCase().trim());
      const artN = new Set(c.iso_code ? [String(c.iso_code).toUpperCase()] : []);
      const artKw = kwMap.get(Number(c.id)) || new Set();
      const artTt = tokTitle(c.title);

      const e = Math.min(ENTITY_CAP, inter(ents, f.entities));
      const n = inter(artN, f.nations);
      const k = Math.min(KEYWORD_CAP, inter(artKw, f.keywords));
      const t = inter(artTt, f.titleTokens);
      const score = e*W_ENTITY + n*W_NATION + k*W_KEYWORD + t*W_TITLE;
      if (score >= ATTACH) hits.push({ id: c.id, title: c.title, score, breakdown: {e,n,k,t} });
    }
    if (!hits.length) continue;
    hits.sort((a,b)=>b.score-a.score);
    totQualified += hits.length;
    totLinesWithHits++;
    if (tl.status === 'cooling') totCoolRestored++;

    console.log(`\n[${tl.status.padEnd(7)}] Line ${tl.id}: "${(tl.title||'').slice(0,60)}"  (candidates=${cands.length}, hits=${hits.length})${tl.status==='cooling'?' [WOULD RESTORE]':''}`);
    for (const h of hits.slice(0,5)) {
      console.log(`    ${h.score.toFixed(1)}  ent=${h.breakdown.e} nat=${h.breakdown.n} kw=${h.breakdown.k} ttk=${h.breakdown.t}  ${(h.title||'').slice(0,80)}`);
    }
  }

  console.log(`\n─── DRY-RUN SUMMARY ─────────────────────────────`);
  console.log(`Lines scanned:        ${lines.length}`);
  console.log(`Lines with ≥1 hit:    ${totLinesWithHits}`);
  console.log(`Cooling → active:     ${totCoolRestored}`);
  console.log(`Candidates scored:    ${totScored}`);
  console.log(`Articles to attach:   ${totQualified}`);
  await pool.end();
})().catch(e => { console.error(e); process.exit(1); });
