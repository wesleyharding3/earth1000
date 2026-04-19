/**
 * deepAnalyzer.js — DEPRECATED
 *
 * Replaced by articleDeepEnrichment.js as of 20260419. The original
 * module did a scrape + Haiku call per article and wrote to the
 * article_entities table that nothing in the codebase ever read from,
 * plus sentiment_score (still used). briefingGenerator._deepEnrichThread
 * was doing a second, parallel scrape+Haiku pass to build a transient
 * thread.deepContext — we were paying twice for overlapping work.
 *
 * articleDeepEnrichment.js consolidates both pipelines:
 *   - one scrape, one Claude call per article
 *   - output persisted to article_deep_context
 *   - briefingGenerator reads cached rows, never re-scrapes
 *   - sentiment_score writeback preserved so all UI + heatmap code is
 *     unaffected
 *
 * This file remains as a thin re-export so any stray `require` paths
 * keep working during rollout. Safe to delete once grep confirms no
 * consumers remain. Currently grepping shows:
 *   - articleListener.js:6  (import is dead — call is commented out)
 *   - storyThreadBuilder.js  (already migrated to articleDeepEnrichment)
 */

'use strict';

const { enrichArticle } = require('./articleDeepEnrichment');

module.exports = {
  deepAnalyzeArticle: enrichArticle,
};
