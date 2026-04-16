// ═══════════════════════════════════════════════════════════════════════════
// editorEventLogger — append-only log of every admin mutation on threads
// and timelines. Layer 2 of the preference-learning stack.
//
// Every mutation endpoint in server.js takes a `before` snapshot, performs
// the mutation, takes an `after` snapshot, and calls logEditorEvent(). The
// row lands in `editor_events`; the Layer 3 miner reads from there.
//
// Contract: logEditorEvent NEVER throws. Logging failures are caught and
// reported to console — they must not break the underlying mutation.
// ═══════════════════════════════════════════════════════════════════════════

// Columns we snapshot on a thread. Matches the editable surface exposed
// by PUT /api/admin/threads/:id plus derived counts.
const THREAD_SNAPSHOT_COLS = `
  id, title, description, primary_category, importance, keywords,
  primary_nations, status, geographic_scope, image_url, article_count
`;

// Columns we snapshot on a timeline. Mirrors PUT /api/admin/timelines/:id.
const TIMELINE_SNAPSHOT_COLS = `
  id, title, description, scope, primary_category, importance, keywords,
  primary_nations, status, geographic_scope, article_count
`;

async function snapshotThread(db, id) {
  if (!id) return null;
  try {
    const { rows } = await db.query(
      `SELECT ${THREAD_SNAPSHOT_COLS} FROM story_threads WHERE id = $1`, [id]);
    return rows[0] || null;
  } catch (err) {
    console.warn('[editorEventLogger] snapshotThread failed:', err.message);
    return null;
  }
}

async function snapshotTimeline(db, id) {
  if (!id) return null;
  try {
    const { rows } = await db.query(
      `SELECT ${TIMELINE_SNAPSHOT_COLS} FROM story_timelines WHERE id = $1`, [id]);
    return rows[0] || null;
  } catch (err) {
    console.warn('[editorEventLogger] snapshotTimeline failed:', err.message);
    return null;
  }
}

// Deep-ish equality that handles primitives, arrays, and plain objects.
// Good enough for the columns we snapshot (strings, numbers, string[],
// nested JSON is rare on these entities).
function eq(a, b) {
  if (a === b) return true;
  if (a == null || b == null) return a == b;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!eq(a[i], b[i])) return false;
    return true;
  }
  if (typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (const k of ka) if (!eq(a[k], b[k])) return false;
    return true;
  }
  // Coerce Dates / numeric strings loosely
  if (a instanceof Date || b instanceof Date) {
    return new Date(a).getTime() === new Date(b).getTime();
  }
  return false;
}

function computeDiff(before, after) {
  if (!before || !after) return null;
  const diff = {};
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const k of keys) {
    if (!eq(before[k], after[k])) diff[k] = [before[k] ?? null, after[k] ?? null];
  }
  return Object.keys(diff).length ? diff : null;
}

/**
 * Append a single editor event. Never throws.
 *
 * @param {pg.Pool|pg.Client} db
 * @param {Object} evt
 * @param {string} evt.eventType   e.g. 'thread.update', 'timeline.merge'
 * @param {string} evt.entityType  'thread' | 'timeline'
 * @param {number} [evt.entityId]  primary affected entity
 * @param {string} [evt.editorId]  supabase user id (req.user.id)
 * @param {Object} [evt.before]    pre-mutation snapshot
 * @param {Object} [evt.after]     post-mutation snapshot
 * @param {Object} [evt.context]   op-specific metadata
 */
async function logEditorEvent(db, {
  eventType, entityType, entityId = null, editorId = null,
  before = null, after = null, context = null
}) {
  try {
    if (!eventType || !entityType) {
      console.warn('[editorEventLogger] missing eventType/entityType — skipping');
      return;
    }
    const diff = (before && after) ? computeDiff(before, after) : null;
    await db.query(`
      INSERT INTO editor_events
        (event_type, entity_type, entity_id, editor_id, before_state, after_state, diff, context)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    `, [
      eventType,
      entityType,
      entityId,
      editorId,
      before ? JSON.stringify(before) : null,
      after  ? JSON.stringify(after)  : null,
      diff   ? JSON.stringify(diff)   : null,
      context ? JSON.stringify(context) : '{}'
    ]);
  } catch (err) {
    // NEVER throw from the logger. If the table doesn't exist yet,
    // a mutation shouldn't fail just because logging is misconfigured.
    console.error('[editorEventLogger] log failed:', err.message);
  }
}

module.exports = {
  logEditorEvent,
  snapshotThread,
  snapshotTimeline,
  computeDiff,
};
