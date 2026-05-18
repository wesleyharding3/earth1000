'use strict';

/**
 * embedder.js — local CPU sentence-embedding for news articles.
 *
 * Wraps @xenova/transformers (a JS port of HuggingFace transformers) to
 * produce 384-dim float vectors from article text. Uses the model
 * `Xenova/paraphrase-multilingual-MiniLM-L12-v2`:
 *   - 384 dimensions  (matches our `vector(384)` column)
 *   - multilingual    (50+ languages; we ingest Arabic, Russian, Chinese,
 *                      Japanese, Korean, Persian, etc.)
 *   - ~470MB on disk  (cached at ~/.cache/huggingface/ after first load)
 *   - CPU-only        (no GPU required; ~10-50ms per article on a Mac)
 *   - no API calls    ($0/run after the first model download)
 *
 * Why not OpenAI embeddings: cost is negligible ($0.006/day for our
 * volume) but we avoid the per-call latency, rate limits, and a network
 * dependency. The model runs entirely in-process.
 *
 * Why not larger model (multilingual-e5-base, 768-dim): the L12-v2
 * matches our column shape and is enough for "did two articles report
 * the same event" — that's all we need at this stage. A 768-dim
 * upgrade would require a schema migration.
 *
 * Usage:
 *   const { embed, embedBatch } = require('./embedder');
 *   const vec = await embed("Iran-US Nuclear Talks Stall in Geneva");
 *   // vec is a Float32Array of length 384
 *
 *   const vecs = await embedBatch([title1, title2, title3]);
 *   // vecs is an Array<Float32Array>
 *
 * Implementation note: `transformers` lazy-loads the model on first
 * call. We cache the pipeline so subsequent calls reuse it. Multiple
 * concurrent embed() calls share the same pipeline (no thread safety
 * concerns; pipeline is a pure JS function under the hood).
 */

const MODEL_ID = 'Xenova/paraphrase-multilingual-MiniLM-L12-v2';
const EMBEDDING_DIM = 384;

let _pipelinePromise = null;

async function _getPipeline() {
  if (_pipelinePromise) return _pipelinePromise;
  _pipelinePromise = (async () => {
    // Dynamic import — @xenova/transformers is ESM-only, can't require()
    // it directly from CommonJS modules. This pattern works in both
    // CJS and ESM callers.
    const { pipeline } = await import('@xenova/transformers');
    return await pipeline('feature-extraction', MODEL_ID);
  })();
  return _pipelinePromise;
}

/**
 * Build the text we actually embed from an article record. Title + first
 * ~300 chars of summary/body keeps the signal high (the headline is the
 * highest-signal portion) while staying well under the model's 128-token
 * context window. Articles without a title fall back to summary alone.
 */
function articleToEmbeddingText(article) {
  const title   = String(article.title   || '').trim();
  const summary = String(article.summary || article.description || '').trim();
  if (title && summary) {
    return `${title}\n\n${summary.slice(0, 300)}`;
  }
  return title || summary || '';
}

/**
 * Embed a single string. Returns a Float32Array of length 384.
 * Caller is responsible for converting to pgvector text format.
 */
async function embed(text) {
  const pipe = await _getPipeline();
  const output = await pipe(text, { pooling: 'mean', normalize: true });
  // output.data is a Float32Array of length 384 (mean-pooled token
  // embeddings, L2-normalized so cosine_similarity = dot product).
  return output.data;
}

/**
 * Embed many texts in one pipeline call. More efficient than calling
 * embed() in a loop because the model's batching is amortized.
 * Returns Array<Float32Array>.
 */
async function embedBatch(texts) {
  if (!texts.length) return [];
  const pipe = await _getPipeline();
  const output = await pipe(texts, { pooling: 'mean', normalize: true });
  // For batches, output.data is a flat Float32Array of length
  // (batch_size * 384). Split it back into per-text vectors.
  const all = output.data;
  const out = [];
  for (let i = 0; i < texts.length; i++) {
    out.push(all.slice(i * EMBEDDING_DIM, (i + 1) * EMBEDDING_DIM));
  }
  return out;
}

/**
 * Convert a Float32Array (or Array<number>) into the text format
 * pgvector expects on INSERT/UPDATE: '[0.123,-0.456,...]'.
 */
function vectorToPgString(vec) {
  // Mild precision trim — vector entries are 32-bit floats, no point
  // sending 17-digit decimal strings. 6 decimals preserves all the
  // accuracy a Float32 can express.
  const parts = new Array(vec.length);
  for (let i = 0; i < vec.length; i++) parts[i] = vec[i].toFixed(6);
  return `[${parts.join(',')}]`;
}

/**
 * Cosine similarity between two embeddings. Both inputs assumed already
 * L2-normalized (true for outputs of embed/embedBatch), so this is just
 * the dot product. Result in [-1, 1]; 1 = identical, 0 = orthogonal,
 * -1 = opposite.
 */
function cosine(a, b) {
  if (a.length !== b.length) throw new Error('cosine: dim mismatch');
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

module.exports = {
  MODEL_ID,
  EMBEDDING_DIM,
  embed,
  embedBatch,
  articleToEmbeddingText,
  vectorToPgString,
  cosine,
};
