// ═══════════════════════════════════════════════════════════════════════════
// editorialRuleInjector — Layer 4 of the preference stack.
//
// Reads the top learned rules from editorial_rules and formats them as a
// block that gets prepended to Claude prompts in:
//
//   - storyThreadBuilder.js       (thread classification + reframe)
//   - backfillTimelinesFromThreads.js (umbrella grouping + dedup map)
//   - dedupStoryTimelines.js      (timeline dedup)
//
// Graceful degradation:
//   * If the editorial_rules table doesn't exist yet (migration not run),
//     returns an empty string. The caller's prompt works as before.
//   * If the DB query errors, we log and return an empty string.
//   * Never throws. Never blocks a Claude call.
//
// Caching: one in-memory TTL cache per entity_type. 5-minute TTL keeps DB
// load negligible even across a 30-batch backfill run.
// ═══════════════════════════════════════════════════════════════════════════

const pool = require('./db');

const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_LIMIT = parseInt(process.env.RULE_INJECT_LIMIT || '15', 10);

// Cache: key = `${entityType}|${limit}` → { expires, block }
const cache = new Map();

function fmtBlock(rules) {
  if (!rules.length) return '';
  const lines = rules.map((r, i) => `${i + 1}. ${r.rule_text}`).join('\n');
  return `═══ EDITORIAL PREFERENCES (learned from past editor corrections — apply unless clearly wrong) ═══
${lines}
═══ END EDITORIAL PREFERENCES ═══

`;
}

/**
 * Load the prompt block of top active rules for a given entity type.
 * @param {'thread'|'timeline'} entityType
 * @param {{ limit?: number, db?: any }} [opts]
 * @returns {Promise<string>}  empty string if no rules / error / table missing
 */
async function loadRulesBlock(entityType, opts = {}) {
  if (!entityType) return '';
  const limit = opts.limit || DEFAULT_LIMIT;
  const db = opts.db || pool;
  const cacheKey = `${entityType}|${limit}`;

  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.block;

  try {
    const { rows } = await db.query(`
      SELECT COALESCE(override_text, rule_text) AS rule_text, confidence, sample_count
      FROM editorial_rules
      WHERE enabled = TRUE
        AND (entity_type = $1 OR entity_type = 'both')
      ORDER BY confidence DESC, sample_count DESC
      LIMIT $2
    `, [entityType, limit]);
    const block = fmtBlock(rows);
    cache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, block });
    return block;
  } catch (err) {
    // Table missing (42P01) → silent empty. Other errors → log + empty.
    if (err.code !== '42P01') {
      console.warn('[ruleInjector] load failed:', err.message);
    }
    cache.set(cacheKey, { expires: Date.now() + CACHE_TTL_MS, block: '' });
    return '';
  }
}

// Flush cache — useful after a manual mine-rules run so new rules take
// effect immediately without waiting for the 5-minute TTL.
function invalidateCache() {
  cache.clear();
}

module.exports = { loadRulesBlock, invalidateCache };
