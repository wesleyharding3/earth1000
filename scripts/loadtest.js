#!/usr/bin/env node

const { performance } = require("perf_hooks");

const BASE_URL = process.env.LOADTEST_BASE_URL || "http://127.0.0.1:3000";
const CONCURRENCY = Math.max(1, parseInt(process.env.LOADTEST_CONCURRENCY || "50", 10));
const DURATION_MS = Math.max(1000, parseInt(process.env.LOADTEST_DURATION_MS || "30000", 10));
const REQUEST_TIMEOUT_MS = Math.max(1000, parseInt(process.env.LOADTEST_TIMEOUT_MS || "15000", 10));

const scenarios = {
  startup: [
    { name: "recent_articles", method: "GET", path: "/api/articles/recent?limit=60&hours=48", weight: 4 },
    { name: "threads_latest", method: "GET", path: "/api/threads/latest?limit=24", weight: 3 },
    { name: "timelines_latest", method: "GET", path: "/api/timelines/latest?limit=12", weight: 1 },
    { name: "briefing_today", method: "GET", path: "/api/briefing/today", weight: 1 },
    { name: "keywords_trending", method: "GET", path: "/api/keywords/trending?limit=12", weight: 1 },
  ],
  feed: [
    { name: "recent_articles", method: "GET", path: "/api/articles/recent?limit=60&hours=48", weight: 5 },
    { name: "threads_latest", method: "GET", path: "/api/threads/latest?limit=24", weight: 2 },
    { name: "keywords_trending", method: "GET", path: "/api/keywords/trending?limit=12", weight: 2 },
    { name: "news_search_default", method: "GET", path: "/api/news/search?limit=40", weight: 1 },
  ],
  threads: [
    { name: "threads_latest", method: "GET", path: "/api/threads/latest?limit=24", weight: 4 },
    { name: "thread_panel", method: "GET", path: "/api/threads/id/1", weight: 2 },
    { name: "thread_timeline", method: "GET", path: "/api/threads/1/timeline", weight: 2 },
    { name: "thread_flows", method: "GET", path: "/api/flows/thread/1", weight: 2 },
  ],
};

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function weightedPick(entries) {
  const total = entries.reduce((sum, entry) => sum + entry.weight, 0);
  let roll = Math.random() * total;
  for (const entry of entries) {
    roll -= entry.weight;
    if (roll <= 0) return entry;
  }
  return entries[entries.length - 1];
}

async function timedFetch(route) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const started = performance.now();

  try {
    const res = await fetch(`${BASE_URL}${route.path}`, {
      method: route.method,
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });

    const text = await res.text();
    const durationMs = performance.now() - started;

    return {
      ok: res.ok,
      status: res.status,
      durationMs,
      bytes: Buffer.byteLength(text || "", "utf8"),
      route: route.name,
      error: res.ok ? null : `http_${res.status}`,
    };
  } catch (err) {
    const durationMs = performance.now() - started;
    return {
      ok: false,
      status: 0,
      durationMs,
      bytes: 0,
      route: route.name,
      error: err?.name === "AbortError" ? "timeout" : (err?.code || err?.message || "request_failed"),
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runWorker(routes, deadline, sink) {
  while (Date.now() < deadline) {
    const route = weightedPick(routes);
    sink.push(await timedFetch(route));
  }
}

function summarize(results) {
  const total = results.length;
  const ok = results.filter((r) => r.ok).length;
  const errors = total - ok;
  const latencies = results.map((r) => r.durationMs);
  const wallSeconds = DURATION_MS / 1000;
  const routeSummary = new Map();
  const errorSummary = new Map();

  for (const result of results) {
    const routeStats = routeSummary.get(result.route) || { total: 0, ok: 0, latencies: [] };
    routeStats.total += 1;
    routeStats.ok += result.ok ? 1 : 0;
    routeStats.latencies.push(result.durationMs);
    routeSummary.set(result.route, routeStats);

    if (!result.ok) {
      errorSummary.set(result.error, (errorSummary.get(result.error) || 0) + 1);
    }
  }

  return {
    total,
    ok,
    errors,
    rps: total / wallSeconds,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    routeSummary,
    errorSummary,
  };
}

function printSummary(name, summary) {
  console.log(`\nScenario: ${name}`);
  console.log(`Base URL: ${BASE_URL}`);
  console.log(`Concurrency: ${CONCURRENCY}`);
  console.log(`Duration: ${(DURATION_MS / 1000).toFixed(1)}s`);
  console.log(`Requests: ${summary.total}`);
  console.log(`Success: ${summary.ok}`);
  console.log(`Errors: ${summary.errors}`);
  console.log(`Throughput: ${summary.rps.toFixed(1)} req/s`);
  console.log(`Latency p50/p95/p99: ${summary.p50.toFixed(1)}ms / ${summary.p95.toFixed(1)}ms / ${summary.p99.toFixed(1)}ms`);

  console.log("\nPer-route:");
  for (const [route, stats] of summary.routeSummary.entries()) {
    const rate = stats.total ? (stats.ok / stats.total) * 100 : 0;
    console.log(
      `  ${route}: count=${stats.total} ok=${stats.ok} success=${rate.toFixed(1)}% p95=${percentile(stats.latencies, 95).toFixed(1)}ms`
    );
  }

  if (summary.errorSummary.size) {
    console.log("\nErrors:");
    for (const [code, count] of summary.errorSummary.entries()) {
      console.log(`  ${code}: ${count}`);
    }
  }
}

async function main() {
  const scenarioName = process.argv[2] || "startup";
  const routes = scenarios[scenarioName];

  if (!routes) {
    console.error(`Unknown scenario "${scenarioName}". Available: ${Object.keys(scenarios).join(", ")}`);
    process.exit(1);
  }

  console.log(`Starting load test "${scenarioName}" against ${BASE_URL} ...`);
  const deadline = Date.now() + DURATION_MS;
  const results = [];

  await Promise.all(
    Array.from({ length: CONCURRENCY }, () => runWorker(routes, deadline, results))
  );

  const summary = summarize(results);
  printSummary(scenarioName, summary);

  if (summary.errors > 0) {
    process.exitCode = 2;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
