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
  let deletedThreads = 0;
  let renamedThreads = 0;
  let singleSourceKills = 0;
  let outlierRatioKills = 0;

  // After outlier detach, a thread that falls below this article floor is
  // deleted outright — too few articles to constitute a "story". The same
  // floor as storyThreadBuilder uses when forming new clusters, applied on
  // the back end so detach-driven attrition doesn't leave orphan stubs.
  const MIN_ARTICLES_AFTER_DETACH = 3;
  // Single-source quality floor — a thread with only one source publishing
  // >=5 articles is republish-spam, not a story. Killed pre-Claude (no
  // API call wasted).
  const SINGLE_SOURCE_MIN_ARTICLES = 5;
  // Outlier-ratio kill — if Claude flags >50% of audited articles as
  // outliers, the cluster is fundamentally broken (not just contaminated).
  // Delete the whole thread instead of leaving the surviving half as an
  // orphan stub with a now-misleading title.
  const OUTLIER_RATIO_KILL = 0.50;

  async function killThread(threadId, reason) {
    await pool.query(`DELETE FROM segment_story_links WHERE thread_id = $1`, [threadId]);
    await pool.query(`DELETE FROM story_thread_articles WHERE thread_id = $1`, [threadId]);
    await pool.query(`DELETE FROM story_threads WHERE id = $1`, [threadId]);
    console.log(`       💀 deleted: ${reason}`);
  }

  for (const t of threadRows) {
    if (auditedThreads >= MAX_THREADS) break;

    const articles = await loadArticles(t.id);
    if (articles.length < MIN_ARTICLES) continue;

    auditedThreads++;

    // Pre-Claude single-source kill. A thread with only one source
    // publishing >=5 articles is the same wire-service republished N
    // times — not a story by any meaningful definition. Skip the Claude
    // call entirely; delete and move on.
    if (DETACH
        && Number(t.distinct_source_count || 0) === 1
        && articles.length >= SINGLE_SOURCE_MIN_ARTICLES) {
      console.log(`   [${el()}] Thread ${t.id} "${(t.title || '').slice(0, 60)}" → 💀 single-source (${articles.length} arts / 1 src)`);
      try {
        await killThread(t.id, `single-source republish (${articles.length} arts / 1 src)`);
        deletedThreads++;
        singleSourceKills++;
      } catch (err) {
        console.warn(`       ⚠ single-source delete failed: ${err.message}`);
      }
      continue;
    }

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
    const { outliers, dominantTopic, titleVerdict, recommendedTitle } = auditResult;

    if (!outliers.length) {
      console.log(`✓ clean${dominantTopic ? ` (story: "${dominantTopic.slice(0, 70)}")` : ''}`);
    } else {
      // (logging the per-outlier list happens below)
    }
    // Log title verdict in BOTH dry-run and detach modes so the operator
    // can see which threads Claude flagged as dual/drifted before any
    // writes happen.
    if (titleVerdict && titleVerdict !== 'matches' && recommendedTitle) {
      console.log(`       ✏ title-verdict=${titleVerdict}  recommended="${recommendedTitle}"`);
    }
    if (outliers.length) {
      flaggedCount += outliers.length;
      console.log(`🚩 ${outliers.length} outlier(s)${dominantTopic ? ` — story: "${dominantTopic.slice(0, 70)}"` : ''}`);
      for (const o of outliers) {
        const art = articles.find(a => a.id === o.article_id);
        const title = (art?.title || '').slice(0, 80);
        console.log(`       - #${o.article_id} "${title}"  reason: ${o.reason}`);
      }

      // Outlier-ratio kill — if Claude flagged more than half the audited
      // articles as outliers, the cluster is fundamentally broken (not
      // just contaminated). The surviving half would be an orphan stub
      // with a now-misleading title (Thread #10661 case: 34/80 outliers,
      // would leave a 46-article remnant with a stale title). Kill it.
      const outlierRatio = outliers.length / articles.length;
      if (DETACH && outlierRatio > OUTLIER_RATIO_KILL) {
        try {
          await killThread(t.id, `outlier ratio ${(outlierRatio*100).toFixed(0)}% (${outliers.length}/${articles.length}) above kill threshold`);
          deletedThreads++;
          outlierRatioKills++;
          continue; // skip last_audited_at stamp — thread is gone
        } catch (err) {
          console.warn(`       ⚠ outlier-ratio delete failed: ${err.message}`);
        }
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
          const { rows: [{ new_count }] } = await pool.query(
            `UPDATE story_threads
                SET article_count = (SELECT COUNT(*) FROM story_thread_articles WHERE thread_id = $1),
                    last_updated_at = NOW()
              WHERE id = $1
            RETURNING article_count AS new_count`,
            [t.id]
          );

          // Low-signal kill: if outlier detach drops the thread below the
          // minimum-cluster floor, it's no longer a story — delete it.
          if (new_count < MIN_ARTICLES_AFTER_DETACH) {
            try {
              await killThread(t.id, `${new_count} article(s) left — below floor of ${MIN_ARTICLES_AFTER_DETACH}`);
              deletedThreads++;
              continue; // skip last_audited_at stamp — thread is gone
            } catch (err) {
              console.warn(`       ⚠ low-signal delete failed (thread=${t.id}): ${err.message}`);
            }
          }
        }
      }
    }

    // Title rename — applied even when no outliers were detached, because
    // a title can be a dual-story merger while every article still
    // matches one of the two halves (e.g. "Russia-Ukraine Prisoner Swap,
    // US-Iran Tensions" — only 1 article was an outlier, but the title
    // still misrepresents the dominant story). Runs in DETACH mode only.
    if (DETACH && titleVerdict !== 'matches' && recommendedTitle && recommendedTitle !== t.title) {
      try {
        await pool.query(
          `UPDATE story_threads SET title = $1, last_updated_at = NOW() WHERE id = $2`,
          [recommendedTitle, t.id]
        );
        renamedThreads++;
        console.log(`       ✏ renamed (${titleVerdict}): "${(t.title || '').slice(0, 60)}" → "${recommendedTitle.slice(0, 60)}"`);
      } catch (err) {
        console.warn(`       ⚠ rename failed (thread=${t.id}): ${err.message}`);
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
  console.log(`   threads_audited=${auditedThreads} outliers_flagged=${flaggedCount}${DETACH ? ` detach_rows=${detachedCount} deleted_threads=${deletedThreads} renamed_threads=${renamedThreads} (single_source_kills=${singleSourceKills} outlier_ratio_kills=${outlierRatioKills})` : ''}`);
  await pool.end();
}

// ─── Loaders ─────────────────────────────────────────────────────────────────
async function loadThreads() {
  if (THREAD_FILTER?.length) {
    // --thread=X,Y,Z bypasses the last_audited_at gate so the user
    // can force a re-audit of a specific thread on demand.
    const { rows } = await pool.query(
      `SELECT id, title, description, keywords, primary_category,
              article_count, distinct_source_count,
              primary_nations, secondary_nations
         FROM story_threads
        WHERE id = ANY($1::int[])`,
      [THREAD_FILTER]
    );
    return rows;
  }
  // Gate: re-audit a thread when ANY of:
  //   1. Never audited (last_audited_at IS NULL)
  //   2. New articles have arrived since the last audit (last_updated_at
  //      > last_audited_at)
  //   3. Last audit was > 7 days ago — a backstop forced re-audit. This
  //      is the recovery path for threads that survived a previous
  //      audit run with a silent false negative (e.g. token-budget
  //      truncation, parse failure under the old coercion logic, or
  //      LLM variability). Without this clause the King Charles
  //      whiskey thread case repeats: a single false-negative audit
  //      stamps last_audited_at, no new articles arrive, gate clauses
  //      1+2 stay false, and the thread is locked out forever even as
  //      its article set drifts further off-topic with each match
  //      cycle.
  //   4. Nation count is 3× or more the article count (and >6 nations
  //      absolute). These are over-tagged frankenstein indicators —
  //      e.g. thread #10761 had 3 articles but 33 nations because the
  //      tagging system inflated. The audit forces re-evaluation so
  //      Claude can confirm outliers + a downstream pass can recompute
  //      nation tags.
  //
  // At 2×/day cadence + ~300 active+cooling threads the typical run
  // touches ~75 (clauses 1+2). The 7-day backstop adds ~43/run amortized
  // (300/7 ÷ 14 runs/week × 2 runs/day) — well within MAX_THREADS=500.
  // Anthropic bill impact: ~$0.40/day extra at Haiku rates.
  //
  // Index that backs this query: idx_story_threads_audit_gate (migration
  // 20260430_add_last_audited_at_to_story_threads.sql).
  const { rows } = await pool.query(`
    SELECT id, title, description, keywords, primary_category,
           article_count, distinct_source_count,
           primary_nations, secondary_nations
      FROM story_threads
     WHERE status IN ('active','cooling')
       AND article_count >= ${MIN_ARTICLES}
       AND (
         last_audited_at IS NULL
         OR last_updated_at > last_audited_at
         OR last_audited_at < NOW() - INTERVAL '7 days'
         OR (
           COALESCE(array_length(primary_nations,1),0)
             + COALESCE(array_length(secondary_nations,1),0)
           > 3 * GREATEST(article_count, 1)
           AND
           COALESCE(array_length(primary_nations,1),0)
             + COALESCE(array_length(secondary_nations,1),0)
           > 6
         )
       )
     ORDER BY
       -- Prioritize threads with new content first, then forced re-audits
       CASE WHEN last_audited_at IS NULL OR last_updated_at > last_audited_at THEN 0 ELSE 1 END,
       article_count DESC,
       last_updated_at DESC
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

STEP 3 — Judge the stored title.
After identifying the dominant story, decide if the stored title accurately and ONLY describes that story.
- "matches"     → title is a fair summary of the dominant story alone.
- "dual_story"  → title contains TWO distinct stories joined by a comma, semicolon, "and", "amid", "as", "while", "&", etc. (e.g. "Iraq Sites, Hamas Chief Killed" — two events; "Baltic Airspace Breaches Amid Turkic Summit" — two events; "Beijing Summit Affirms Denuclearization; Taiwan Tensions Rise" — two events).
- "drifted"     → title describes a different story than the dominant cluster, OR is too broad / off-topic.

STEP 4 — Recommend a clean title.
Propose a 5-9 word title that captures ONLY the dominant story. Title case. No colons, commas, ampersands, or "and"/"amid"/"as"/"while" connectors between distinct events. If "matches", recommended_title may equal the existing title verbatim.

Return ONLY valid JSON matching this schema:
{
  "dominant_topic": "one-sentence description of the actual story you inferred from the articles",
  "title_verdict": "matches" | "dual_story" | "drifted",
  "recommended_title": "5-9 word title describing only the dominant story",
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
- recommended_title is REQUIRED in every response, even when title_verdict is "matches".

${threadBlock}

ARTICLES (${articles.length}):
${articleBlock}`;

  // max_tokens raised 1600 → 8000. Bug discovered via the King Charles
  // whiskey thread (id 8250): the audit was silently passing threads
  // whose outlier list was long enough to overflow the response budget.
  // When Claude's JSON response truncates mid-array, extractJson fails
  // to parse, and the catch-all `parsed?.outliers || []` coerced the
  // failure into a clean ✓ — stamping last_audited_at and locking the
  // thread out of every future audit cycle (gate at loadThreads
  // requires last_updated_at > last_audited_at to re-trigger). The
  // worst-offender threads (most articles, most drift, most outliers)
  // were the EXACT threads most likely to overflow → the threads
  // needing cleanup were systematically waved through.
  //
  // 8000 tokens covers ~60 outliers with their reasons, comfortably
  // above the worst case observed (41+) on an 80-article window.
  // Combined with the truncation detection below, no more silent
  // pass-throughs.
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    messages: [{ role: 'user', content: prompt }],
  });
  const text = (response?.content || []).map(p => typeof p?.text === 'string' ? p.text : '').join('').trim();
  // Truncation detection — if Claude reports it stopped because of the
  // max_tokens budget rather than completing, we KNOW the JSON is
  // incomplete and should not be parsed-as-clean. Throw so the caller
  // (main loop) skips stamping last_audited_at and the thread retries
  // next run with a chance for a complete response.
  if (response?.stop_reason === 'max_tokens') {
    throw new Error(`Claude response hit max_tokens=${8000} — JSON likely truncated; refusing to silently pass thread`);
  }
  const parsed = extractJson(text);
  // Parse failure is also fatal — same reasoning as truncation. The
  // previous version coerced parse failures to outliers:[] and stamped
  // last_audited_at, causing the thread-lockout bug. Throw so the
  // caller skips stamping.
  if (!parsed) {
    throw new Error(`Claude response was not valid JSON (length=${text.length}, head="${text.slice(0, 80).replace(/\s+/g,' ')}")`);
  }
  if (!Array.isArray(parsed.outliers)) {
    throw new Error(`Claude response missing 'outliers' array (keys: ${Object.keys(parsed).join(',')})`);
  }
  const list = parsed.outliers;
  // Capture the dominant_topic into the reason metadata so the audit log
  // and tombstone reason both make clear WHY (the thread's actual story
  // wasn't this article's topic), not just "doesn't match title".
  const dominantTopic = String(parsed?.dominant_topic || '').trim().slice(0, 200);
  // Title verdict + recommended title — the caller uses these to rename
  // threads whose title is a dual-story merger or has drifted from the
  // dominant cluster (the "Russia-Ukraine Prisoner Swap, US-Iran Tensions"
  // and "Israel's Covert Iraq Sites, Hamas Chief Killed" failure mode).
  const titleVerdict = ['matches', 'dual_story', 'drifted'].includes(parsed?.title_verdict)
    ? parsed.title_verdict
    : 'matches';
  const recommendedTitle = String(parsed?.recommended_title || '').trim().slice(0, 120);
  return {
    dominantTopic,
    titleVerdict,
    recommendedTitle,
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
