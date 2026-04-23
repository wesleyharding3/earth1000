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
    let outliers;
    try {
      outliers = await askClaude(t, articles);
    } catch (err) {
      console.log(`✗ ERROR: ${err.message}`);
      continue;
    }

    if (!outliers.length) {
      console.log(`✓ clean`);
      continue;
    }

    flaggedCount += outliers.length;
    console.log(`🚩 ${outliers.length} outlier(s)`);
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

  console.log(`\n${DETACH ? '✅ Detach complete' : '✅ Dry run complete'} in ${el()}.`);
  console.log(`   threads_audited=${auditedThreads} outliers_flagged=${flaggedCount}${DETACH ? ` detach_rows=${detachedCount}` : ''}`);
  await pool.end();
}

// ─── Loaders ─────────────────────────────────────────────────────────────────
async function loadThreads() {
  if (THREAD_FILTER?.length) {
    const { rows } = await pool.query(
      `SELECT id, title, description, keywords, primary_category
         FROM story_threads
        WHERE id = ANY($1::int[])`,
      [THREAD_FILTER]
    );
    return rows;
  }
  const { rows } = await pool.query(`
    SELECT id, title, description, keywords, primary_category
      FROM story_threads
     WHERE status IN ('active','cooling')
       AND article_count >= ${MIN_ARTICLES}
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
  const threadBlock = `THREAD:
- id: ${thread.id}
- title: "${thread.title || ''}"
- category: ${thread.primary_category || 'unknown'}
- description: ${thread.description || '(none)'}
- keywords: ${(thread.keywords || []).slice(0, 15).join(', ')}`;

  const articleBlock = articles.map(a =>
    `#${a.id} [${a.source_name || '?'}${a.country_name ? ', ' + a.country_name : ''}] "${(a.title || '').slice(0, 160)}"\n   ${(a.summary || '').slice(0, 220).replace(/\s+/g, ' ')}`
  ).join('\n');

  const prompt = `You are auditing article-to-thread assignments for a breaking-news platform. A "thread" is a single ongoing story; an article is "out of place" if it's about a different event, unrelated topic, or only tangentially references the thread subject.

Return ONLY valid JSON matching this schema:
{
  "outliers": [
    { "article_id": 12345, "reason": "one-line reason (<20 words)" }
  ]
}

Rules:
- ONLY flag articles that are clearly NOT about this thread's story. When in doubt, keep the article attached.
- A related-but-secondary article about the same event is fine; do NOT flag it.
- Do not flag articles just because they use different vocabulary — same event, different framing, keep it.
- Tangential articles that only mention the subject in passing ARE outliers.
- Articles about a different conflict, a different country's politics, or a different event entirely ARE outliers.
- If every article belongs, return { "outliers": [] }.

${threadBlock}

ARTICLES (${articles.length}):
${articleBlock}`;

  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1400,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = (response?.content || []).map(p => typeof p?.text === 'string' ? p.text : '').join('').trim();
  const parsed = extractJson(text);
  const list = Array.isArray(parsed?.outliers) ? parsed.outliers : [];
  return list
    .map(o => ({ article_id: parseInt(o.article_id, 10), reason: String(o.reason || '').trim().slice(0, 160) }))
    .filter(o => Number.isFinite(o.article_id) && articles.some(a => a.id === o.article_id));
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
