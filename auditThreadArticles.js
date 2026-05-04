/**
 * auditThreadArticles.js
 *
 * Outlier audit for articles attached to story_threads. For each active
 * thread, asks Claude Haiku 4.5 whether each attached article genuinely
 * belongs to the thread's story, given the thread's title + description +
 * keywords. Flags mismatches.
 *
 * By default runs dry — outputs a report of outliers, no writes. Pass
 * --detach to actually remove flagged articles from the thread (they stay
 * in news_articles; only the story_thread_articles row is deleted).
 *
 * Usage:
 *   node auditThreadArticles.js                            # dry-run, all active threads
 *   node auditThreadArticles.js --thread=123,456           # specific threads
 *   node auditThreadArticles.js --min-articles=5           # only audit threads with >= N articles
 *   node auditThreadArticles.js --max-threads=50           # cap for cost control
 *   node auditThreadArticles.js --detach                   # apply: delete flagged join rows
 *   node auditThreadArticles.js --model=claude-sonnet-4-5  # override model
 */

// override:true so local shells that pre-set ANTHROPIC_API_KEY="" (e.g. the
// Claude Desktop / Code environment exports a blank value) don't shadow the
// real key in the project .env. Production cron jobs on Render don't have
// this problem — the shell there has no conflicting pre-export.
require("dotenv").config({ override: true });
const pool = require("./db");
const Anthropic = require("@anthropic-ai/sdk");

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const ARGV = new Map(process.argv.slice(2).map(a => {
  const [k, ...rest] = a.replace(/^--/, '').split('=');
  return [k, rest.length ? rest.join('=') : true];
}));
const DETACH        = !!ARGV.get('detach');
const MODEL         = ARGV.get('model') || 'claude-haiku-4-5';
const MIN_ARTICLES  = parseInt(ARGV.get('min-articles') || '5', 10);
const MAX_THREADS   = parseInt(ARGV.get('max-threads') || '500', 10);
const THREAD_FILTER = ARGV.get('thread')
  ? String(ARGV.get('thread')).split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean)
  : null;

async function main() {
  const t0 = Date.now();
  const el = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`;

  console.log(`\n🔎 Thread Article Audit — ${new Date().toISOString()}`);
  console.log(`   mode: ${DETACH ? 'DETACH (writes)' : 'DRY RUN'} | model: ${MODEL} | min_articles=${MIN_ARTICLES} | max_threads=${MAX_THREADS}${THREAD_FILTER ? ` | ids=${THREAD_FILTER.join(',')}` : ''}\n`);

  const threadRows = await loadThreads();
  console.log(`   [${el()}] Loaded ${threadRows.length} threads`);

  let auditedThreads = 0;
  let flaggedCount = 0;
  let detachedCount = 0;

  for (const t of threadRows) {
    if (auditedThreads >= MAX_THREADS) break;

    const articles = await loadArticles(t.id);
    if (articles.length < MIN_ARTICLES) continue;

    auditedThreads++;
    process.stdout.write(`   [${el()}] Thread ${t.id} (${articles.length} arts) "${(t.title || '').slice(0, 60)}" → Claude... `);
    let auditResult;
    try {
      auditResult = await askClaude(t, articles);
    } catch (err) {
      console.log(`✗ ERROR: ${err.message}`);
      // Do NOT stamp last_audited_at — Claude failed, the audit didn't
      // happen. Next run will retry this thread.
      continue;
    }
    const { outliers, dominantTopic } = auditResult;

    if (!outliers.length) {
      console.log(`✓ clean${dominantTopic ? ` (story: "${dominantTopic.slice(0, 70)}")` : ''}`);
    } else {
      flaggedCount += outliers.length;
      console.log(`🚩 ${outliers.length} outlier(s)${dominantTopic ? ` — story: "${dominantTopic.slice(0, 70)}"` : ''}`);
      for (const o of outliers) {
        const art = articles.find(a => a.id === o.article_id);
        const title = (art?.title || '').slice(0, 80);
        console.log(`       - #${o.article_id} "${title}"  reason: ${o.reason}`);
      }

      if (DETACH) {
        const ids = outliers.map(o => o.article_id).filter(Boolean);
        if (ids.length) {
          const { rowCount } = await pool.query(
            `DELETE FROM story_thread_articles WHERE thread_id = $1 AND article_id = ANY($2::int[])`,
            [t.id, ids]
          );
          detachedCount += rowCount;
          // Tombstone — record the (thread, article) pair as ejected so
          // storyThreadBuilder's next pass won't re-cluster the article
          // back into THIS thread. ON CONFLICT DO NOTHING because the
          // PK is (thread_id, article_id); re-running the audit on the
          // same article (e.g. after a builder bug temporarily attached
          // it again) is a no-op insert. Reasons truncated to 200 char.
          // Schema: migrations/20260430_story_thread_article_ejections.sql
          const reasons = outliers.reduce((m, o) => {
            m[o.article_id] = String(o.reason || '').slice(0, 200);
            return m;
          }, {});
          for (const aid of ids) {
            try {
              await pool.query(
                `INSERT INTO story_thread_article_ejections
                       (thread_id, article_id, source, reason)
                  VALUES ($1, $2, 'audit', $3)
                  ON CONFLICT (thread_id, article_id) DO NOTHING`,
                [t.id, aid, reasons[aid] || null]
              );
            } catch (err) {
              // Don't let a tombstone insert failure break the audit
              // pass — the join row is already deleted, and missing a
              // tombstone is recoverable on the next audit cycle.
              console.warn(`   ⚠ tombstone insert failed (thread=${t.id} article=${aid}): ${err.message}`);
            }
          }
          // Recompute article_count so the thread's badge stays truthful.
          await pool.query(
            `UPDATE story_threads
                SET article_count = (SELECT COUNT(*) FROM story_thread_articles WHERE thread_id = $1),
                    last_updated_at = NOW()
              WHERE id = $1`,
            [t.id]
          );
        }
      }
    }

    // Stamp last_audited_at AFTER any other writes to this row so the
    // timestamp wins the race against the detach branch's last_updated_at
    // bump (NOW() returns a slightly later value here than there). The
    // gate in loadThreads() then correctly skips this thread on the
    // next run until new articles arrive. Done in BOTH dry-run and
    // detach modes — the audit happened either way; we shouldn't burn
    // another Claude call on the same unchanged thread tomorrow.
    await pool.query(
      `UPDATE story_threads SET last_audited_at = NOW() WHERE id = $1`,
      [t.id]
    );
  }

  console.log(`\n${DETACH ? '✅ Detach complete' : '✅ Dry run complete'} in ${el()}.`);
  console.log(`   threads_audited=${auditedThreads} outliers_flagged=${flaggedCount}${DETACH ? ` detach_rows=${detachedCount}` : ''}`);
  await pool.end();
}

// ─── Loaders ─────────────────────────────────────────────────────────────────
async function loadThreads() {
  if (THREAD_FILTER?.length) {
    // --thread=X,Y,Z bypasses the last_audited_at gate so the user
    // can force a re-audit of a specific thread on demand.
    const { rows } = await pool.query(
      `SELECT id, title, description, keywords, primary_category
         FROM story_threads
        WHERE id = ANY($1::int[])`,
      [THREAD_FILTER]
    );
    return rows;
  }
  // Gate: only audit threads that have either never been audited
  // (last_audited_at IS NULL) or have accumulated new articles since
  // their last audit (last_updated_at > last_audited_at). At a 2×/day
  // cadence + ~300 active+cooling threads, this drops the per-run
  // workload from ~300 audits to ~75 (typical 25% hit rate), turning
  // the daily Anthropic bill from ~$2.70 → ~$0.70. Index that backs
  // this query: idx_story_threads_audit_gate (migration
  // 20260430_add_last_audited_at_to_story_threads.sql).
  const { rows } = await pool.query(`
    SELECT id, title, description, keywords, primary_category
      FROM story_threads
     WHERE status IN ('active','cooling')
       AND article_count >= ${MIN_ARTICLES}
       AND (last_audited_at IS NULL OR last_updated_at > last_audited_at)
     ORDER BY article_count DESC, last_updated_at DESC
     LIMIT ${MAX_THREADS}
  `);
  return rows;
}

async function loadArticles(threadId) {
  const { rows } = await pool.query(`
    SELECT a.id,
           COALESCE(a.translated_title, a.title)     AS title,
           COALESCE(a.translated_summary, a.summary) AS summary,
           COALESCE(ns.name, ys.name)                AS source_name,
           co.name                                   AS country_name,
           a.published_at
      FROM story_thread_articles sta
      JOIN news_articles a        ON a.id = sta.article_id
      LEFT JOIN news_sources ns   ON ns.id = a.source_id
      LEFT JOIN youtube_sources ys ON ys.id = a.youtube_source_id
      LEFT JOIN countries co      ON co.id = a.country_id
     WHERE sta.thread_id = $1
     ORDER BY a.published_at DESC
     LIMIT 80
  `, [threadId]);
  return rows;
}

// ─── Claude prompt ───────────────────────────────────────────────────────────
async function askClaude(thread, articles) {
  // Title is shown as a CLUE, not authority. The previous prompt anchored
  // on the stored title — that broke for two failure modes we observed:
  //   (1) wrongly-merged titles ("antisemitic hoax threat" = antisemitic
  //       violence + one bomb-hoax article). Every article matched HALF
  //       the title → Claude returned "clean".
  //   (2) titles that drifted broad enough that off-topic articles
  //       seemed plausible (Trump scotch-tariff thread containing a
  //       Pentagon-Iran cost article).
  // The rewrite below asks Claude to derive the dominant topic from the
  // article set FIRST, then audit against THAT — so a corrupted title
  // can't shield outliers.
  const threadBlock = `THREAD (stored metadata — treat as a clue, NOT as authority):
- id: ${thread.id}
- title: "${thread.title || ''}"
- category: ${thread.primary_category || 'unknown'}
- description: ${thread.description || '(none)'}
- keywords: ${(thread.keywords || []).slice(0, 15).join(', ')}`;

  // Bumped 220 → 350 chars so the summary actually shows the article's
  // subject for medium-length pieces. The prior 220 truncation hid the
  // subject for many wire-service articles whose lede starts with
  // attribution boilerplate.
  const articleBlock = articles.map(a =>
    `#${a.id} [${a.source_name || '?'}${a.country_name ? ', ' + a.country_name : ''}] "${(a.title || '').slice(0, 180)}"\n   ${(a.summary || '').slice(0, 350).replace(/\s+/g, ' ')}`
  ).join('\n');

  const prompt = `You are auditing article-to-thread assignments for a breaking-news platform. A "thread" should be a SINGLE ongoing story — one event, one decision, one actor's narrative arc.

The thread's stored title is a CLUE. Threads accumulate articles over time, and the title sometimes gets re-synthesized to cover topics that don't actually belong together. You must NOT trust the title alone — derive the truth from the articles.

STEP 1 — Identify the dominant story.
Read every article. The "dominant story" is the single concrete event/actor/decision that the LARGEST cluster of articles covers. If the title looks like a forced merger of two unrelated topics (e.g. "Antisemitic Hoax Threat" combining antisemitic violence with one isolated bomb-hoax article), pick the larger cluster as the true story.

STEP 2 — Flag outliers.
For each article, decide if it belongs to the dominant story or is an outlier.

Return ONLY valid JSON matching this schema:
{
  "dominant_topic": "one-sentence description of the actual story you inferred from the articles",
  "outliers": [
    { "article_id": 12345, "reason": "one-line reason (<20 words)" }
  ]
}

Rules:
- If the articles split into 2+ distinct topic clusters of size ≥ 2, flag the smaller cluster(s) as outliers. A thread is one story, not a topic bucket.
- Different DOMAIN entirely → outlier (e.g., trade policy vs military operation; cultural event vs political crisis; one country's election vs another country's protest).
- A related-but-secondary article about the SAME event is fine; do NOT flag it.
- Different vocabulary describing the same event is fine; do NOT flag.
- An article that only mentions the subject in passing IS an outlier.
- Cross-topic surface noise — articles that share an actor name (e.g. "Trump") but are about a totally different decision/event — ARE outliers.
- If every article truly belongs to one story, return outliers: [].

${threadBlock}

ARTICLES (${articles.length}):
${articleBlock}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1600,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = (response?.content || []).map(p => typeof p?.text === 'string' ? p.text : '').join('').trim();
  const parsed = extractJson(text);
  const list = Array.isArray(parsed?.outliers) ? parsed.outliers : [];
  // Capture the dominant_topic into the reason metadata so the audit log
  // and tombstone reason both make clear WHY (the thread's actual story
  // wasn't this article's topic), not just "doesn't match title".
  const dominantTopic = String(parsed?.dominant_topic || '').trim().slice(0, 200);
  return {
    dominantTopic,
    outliers: list
      .map(o => ({ article_id: parseInt(o.article_id, 10), reason: String(o.reason || '').trim().slice(0, 160) }))
      .filter(o => Number.isFinite(o.article_id) && articles.some(a => a.id === o.article_id))
  };
}

function extractJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  try { return JSON.parse(raw); } catch (_) {}
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  if (s >= 0 && e > s) {
    try { return JSON.parse(raw.slice(s, e + 1)); } catch (_) {}
  }
  return null;
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });
