/**
 * backfillEntities.js
 *
 * One-time historical pass: walks the existing news_articles corpus and runs
 * the entity extractor + resolver on every article that hasn't been processed.
 *
 * Restricted to articles whose source has fetch_tier IN (3,4) — our highest-
 * quality sources — to keep Claude/Wikidata costs bounded.
 *
 * Resumable via article_entity_extraction_state. Crash-safe: marks each row
 * 'processing' on claim, 'done' on success, 'failed' on exception. A startup
 * sweep clears stale 'processing' rows from prior crashed runs.
 *
 * SAFETY: by default this script PRINTS THE PLAN and exits. To actually run,
 * pass --go (full corpus) or --limit=N (cap at N articles). Do --limit=10
 * first to sanity-check, then --limit=100, then --go.
 *
 * Usage:
 *   node backfillEntities.js                       # show plan, no run
 *   node backfillEntities.js --limit=10            # process at most 10
 *   node backfillEntities.js --limit=100           # process at most 100
 *   node backfillEntities.js --go                  # process everything
 *   node backfillEntities.js --go --concurrency=3  # custom concurrency
 *   node backfillEntities.js --tiers=3,4           # explicit tier list
 *   node backfillEntities.js --reset-stuck         # only reset stuck processing rows then exit
 */

'use strict';

require('dotenv').config({ override: true });
const pool = require('./db');
const { processArticleById } = require('./entityResolver');

// ─── Config (overridable via CLI) ────────────────────────────────────────────

const DEFAULTS = {
  concurrency:      5,
  tiers:            [3, 4],
  batchClaim:       50,    // claim N articles at a time from the queue
  progressEvery:    25,    // print a progress line every N completed articles
  costPerArticle:   0.001, // rough Claude Haiku estimate, USD
  stuckGraceMins:   15,    // 'processing' rows older than this are considered stuck
  maxFailRate:      0.30,  // abort if more than 30% of recent batch fails
  recentFailWindow: 50,    // window size for fail-rate check
};

// ─── CLI parsing ────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = { ...DEFAULTS, go: false, limit: null, dryRun: false, resetStuckOnly: false };
  for (const a of args) {
    if (a === '--go')               opts.go = true;
    else if (a === '--reset-stuck') opts.resetStuckOnly = true;
    else if (a === '--dry-run')     opts.dryRun = true;
    else if (a.startsWith('--limit=')) opts.limit = parseInt(a.split('=')[1], 10);
    else if (a.startsWith('--concurrency=')) opts.concurrency = parseInt(a.split('=')[1], 10);
    else if (a.startsWith('--tiers=')) opts.tiers = a.split('=')[1].split(',').map(s => parseInt(s.trim(), 10));
    else { console.error(`Unknown arg: ${a}`); process.exit(1); }
  }
  return opts;
}

// ─── Plan / preview ──────────────────────────────────────────────────────────

async function showPlan(opts) {
  const tierList = opts.tiers.join(',');

  // Total candidates
  const { rows: tierRows } = await pool.query(
    `SELECT ns.fetch_tier, COUNT(*) AS pending
       FROM news_articles na
       JOIN news_sources ns ON ns.id = na.source_id
  LEFT JOIN article_entity_extraction_state s ON s.article_id = na.id
      WHERE (s.article_id IS NULL OR s.status IN ('pending','failed'))
        AND na.summary IS NOT NULL
        AND length(na.summary) > 200
        AND ns.fetch_tier = ANY($1::int[])
   GROUP BY ns.fetch_tier
   ORDER BY ns.fetch_tier`,
    [opts.tiers]
  );

  let total = 0;
  console.log('\n═══ BACKFILL PLAN ═══════════════════════════════════════════════════════');
  console.log(`Tiers:           ${tierList}`);
  console.log(`Concurrency:     ${opts.concurrency}`);
  console.log(`Limit:           ${opts.limit ?? '(none — full corpus)'}`);
  console.log(`Mode:            ${opts.dryRun ? 'DRY RUN (no DB writes)' : 'WRITE'}`);
  console.log('');
  for (const r of tierRows) {
    console.log(`  Tier ${r.fetch_tier}: ${parseInt(r.pending).toLocaleString()} unprocessed articles`);
    total += parseInt(r.pending);
  }
  console.log('  ─────────────────────────────');
  const cap = opts.limit ? Math.min(opts.limit, total) : total;
  console.log(`  Will process:    ${cap.toLocaleString()}`);
  console.log('');
  const estCost   = cap * opts.costPerArticle;
  const estSecPer = 7;
  const estSecs   = cap * estSecPer / opts.concurrency;
  console.log(`  Estimated cost:  ~$${estCost.toFixed(2)}  (@ $${opts.costPerArticle}/article)`);
  console.log(`  Estimated time:  ~${formatDuration(estSecs)}  (@ ~${estSecPer}s/article × ${opts.concurrency} workers)`);
  console.log('═════════════════════════════════════════════════════════════════════════\n');
  return cap;
}

function formatDuration(secs) {
  if (secs < 60) return `${Math.round(secs)}s`;
  if (secs < 3600) return `${Math.round(secs/60)}m`;
  if (secs < 86400) return `${(secs/3600).toFixed(1)}h`;
  return `${(secs/86400).toFixed(1)}d`;
}

// ─── Stuck-row sweep ─────────────────────────────────────────────────────────

async function resetStuckProcessing(graceMins) {
  const { rowCount } = await pool.query(
    `UPDATE article_entity_extraction_state
        SET status = 'pending', error_message = 'reset from stale processing state'
      WHERE status = 'processing'
        AND processed_at < NOW() - ($1::int * INTERVAL '1 minute')`,
    [graceMins]
  );
  return rowCount;
}

// ─── Queue claim ─────────────────────────────────────────────────────────────
// Claims up to `n` article IDs from the pool of (pending OR failed OR never-seen)
// articles in the configured tiers, marking them 'processing' atomically so
// other workers won't pick them up.

async function claimBatch(n, tiers) {
  const { rows } = await pool.query(
    `WITH candidates AS (
       SELECT na.id
         FROM news_articles na
         JOIN news_sources ns ON ns.id = na.source_id
    LEFT JOIN article_entity_extraction_state s ON s.article_id = na.id
        WHERE (s.article_id IS NULL OR s.status IN ('pending','failed'))
          AND na.summary IS NOT NULL
          AND length(na.summary) > 200
          AND ns.fetch_tier = ANY($2::int[])
        ORDER BY na.published_at DESC
        LIMIT $1
        FOR UPDATE OF na SKIP LOCKED
     )
     INSERT INTO article_entity_extraction_state (article_id, status, processed_at)
     SELECT id, 'processing', NOW() FROM candidates
     ON CONFLICT (article_id) DO UPDATE
       SET status = 'processing', processed_at = NOW()
     RETURNING article_id`,
    [n, tiers]
  );
  return rows.map(r => r.article_id);
}

// ─── Worker pool ─────────────────────────────────────────────────────────────

class BackfillRunner {
  constructor(opts, totalPlanned) {
    this.opts          = opts;
    this.totalPlanned  = totalPlanned;
    this.processed     = 0;
    this.succeeded     = 0;
    this.failed        = 0;
    this.skipped       = 0;
    this.entitiesMade  = 0;
    this.mentionsMade  = 0;
    this.datesMade     = 0;
    this.recentResults = []; // 'ok' | 'fail', for fail-rate guard
    this.startedAt     = Date.now();
    this.shouldStop    = false;
    this.queue         = [];

    process.on('SIGINT', () => {
      if (this.shouldStop) {
        console.log('\n⛔ Hard stop.');
        process.exit(1);
      }
      console.log('\n⚠ Caught SIGINT — finishing in-flight work, then exiting. Ctrl-C again to force.');
      this.shouldStop = true;
    });
  }

  async refillQueue() {
    if (this.shouldStop) return;
    const remaining = this.opts.limit ? this.opts.limit - this.processed : Infinity;
    if (remaining <= 0) return;
    const batchSize = Math.min(this.opts.batchClaim, remaining);
    const ids = await claimBatch(batchSize, this.opts.tiers);
    this.queue.push(...ids);
  }

  async runOne(articleId) {
    try {
      const result = await processArticleById(articleId, { dryRun: this.opts.dryRun });
      if (result.skipped) {
        this.skipped++;
      } else {
        this.succeeded++;
        this.entitiesMade += result.summary?.entities?.length || 0;
        this.mentionsMade += result.summary?.mentions_inserted || 0;
        this.datesMade    += result.summary?.dates_inserted || 0;
      }
      this.recentResults.push('ok');
    } catch (err) {
      this.failed++;
      this.recentResults.push('fail');
      // processArticleById already wrote 'failed' state on its own, but
      // we still log here so the operator sees what's happening.
      if (this.failed <= 5 || this.failed % 25 === 0) {
        console.error(`  ✗ article ${articleId}: ${err.message.slice(0, 120)}`);
      }
    } finally {
      this.processed++;
      if (this.recentResults.length > this.opts.recentFailWindow) {
        this.recentResults.shift();
      }
      this.maybeProgress();
      this.checkFailRate();
    }
  }

  checkFailRate() {
    if (this.recentResults.length < this.opts.recentFailWindow) return;
    const fails = this.recentResults.filter(r => r === 'fail').length;
    const rate  = fails / this.recentResults.length;
    if (rate > this.opts.maxFailRate) {
      console.error(`\n⛔ ABORT: fail rate ${(rate*100).toFixed(0)}% over last ${this.opts.recentFailWindow} articles exceeds ${(this.opts.maxFailRate*100).toFixed(0)}%`);
      console.error('   Likely cause: API auth, rate limits, or upstream outage. Inspect article_entity_extraction_state.error_message and re-run with --reset-stuck if needed.');
      this.shouldStop = true;
    }
  }

  maybeProgress() {
    if (this.processed % this.opts.progressEvery !== 0) return;
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const rate    = this.processed / elapsed;
    const remain  = (this.opts.limit ?? this.totalPlanned) - this.processed;
    const eta     = remain / Math.max(rate, 0.001);
    const cost    = this.succeeded * this.opts.costPerArticle;
    const okPct   = this.processed ? (this.succeeded / this.processed * 100).toFixed(1) : '0.0';
    console.log(
      `  [${formatDuration(elapsed).padStart(5)}] ` +
      `${this.processed}/${this.opts.limit ?? this.totalPlanned} ` +
      `(${okPct}% ok | ${this.failed} failed | ${this.skipped} skipped) ` +
      `→ ${rate.toFixed(2)}/s, ETA ${formatDuration(eta)}, $${cost.toFixed(2)} spent`
    );
  }

  async worker() {
    while (!this.shouldStop) {
      if (!this.queue.length) {
        await this.refillQueue();
        if (!this.queue.length) return; // truly done
      }
      const id = this.queue.shift();
      if (id == null) return;
      if (this.opts.limit && this.processed >= this.opts.limit) return;
      await this.runOne(id);
    }
  }

  async run() {
    const workers = [];
    for (let i = 0; i < this.opts.concurrency; i++) {
      workers.push(this.worker());
    }
    await Promise.all(workers);
    this.printFinal();
  }

  printFinal() {
    const elapsed = (Date.now() - this.startedAt) / 1000;
    const cost    = this.succeeded * this.opts.costPerArticle;
    console.log('\n═══ BACKFILL COMPLETE ═══════════════════════════════════════════════════');
    console.log(`  Total processed:  ${this.processed.toLocaleString()}`);
    console.log(`  Succeeded:        ${this.succeeded.toLocaleString()}`);
    console.log(`  Failed:           ${this.failed.toLocaleString()}`);
    console.log(`  Skipped:          ${this.skipped.toLocaleString()}`);
    console.log(`  Mentions written: ${this.mentionsMade.toLocaleString()}`);
    console.log(`  Dates written:    ${this.datesMade.toLocaleString()}`);
    console.log(`  Elapsed:          ${formatDuration(elapsed)}`);
    console.log(`  Throughput:       ${(this.processed / elapsed).toFixed(2)} articles/s`);
    console.log(`  Estimated cost:   $${cost.toFixed(2)}`);
    console.log('═════════════════════════════════════════════════════════════════════════\n');
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const opts = parseArgs();

  // Reset-stuck-only mode
  if (opts.resetStuckOnly) {
    console.log(`Resetting articles stuck in 'processing' for >${opts.stuckGraceMins} min...`);
    const n = await resetStuckProcessing(opts.stuckGraceMins);
    console.log(`Reset ${n} stuck row(s).`);
    await pool.end();
    return;
  }

  // Always start by sweeping any stale processing rows from a prior run
  const stuck = await resetStuckProcessing(opts.stuckGraceMins);
  if (stuck > 0) console.log(`Reset ${stuck} stale 'processing' row(s) from a prior run.\n`);

  const totalPlanned = await showPlan(opts);

  if (!opts.go && !opts.limit) {
    console.log('Plan only — pass --limit=N or --go to actually run.\n');
    await pool.end();
    return;
  }

  if (totalPlanned === 0) {
    console.log('Nothing to do.\n');
    await pool.end();
    return;
  }

  console.log(`▶ Starting backfill...\n`);
  const runner = new BackfillRunner(opts, totalPlanned);
  await runner.run();
  await pool.end();
}

main().catch(err => {
  console.error(err);
  pool.end().catch(() => {});
  process.exit(1);
});
