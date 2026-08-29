/**
 * 织台运营指标合同与只读报告原型。
 *
 * 设计边界：
 * - 复用 video_asset / import_item / content_analysis / remake_generation /
 *   platform_post / metric_snapshot，不复制这些事实；
 * - 补充平台指标缺失语义与成片→帖子血缘；
 * - 发布回执、创作审核和每日创作状态仍以现有 JSON 账本作为输入；
 * - submitted/success 只表示平台接收，不等于内容已经公开；
 * - 报告函数只读，不登录平台、不发布、不修改账号。
 */

import { canonicalizeSourceUrl } from "./content-metadata.mjs";

export const OPERATIONS_CONTRACT_VERSION = "1.0.0";

export const VALUE_STATUSES = Object.freeze([
  "available",
  "unavailable",
  "not_collected",
  "permission_denied",
]);

export const PLATFORM_METRIC_NAMES = Object.freeze([
  "plays",
  "likes",
  "comments",
  "favorites",
  "shares",
  "avg_watch_seconds",
  "completion_rate",
]);

export const SNAPSHOT_HORIZONS = Object.freeze({
  PT1H: Object.freeze({ label: "1h", offsetMs: 60 * 60_000, toleranceMs: 30 * 60_000 }),
  P1D: Object.freeze({ label: "24h", offsetMs: 24 * 60 * 60_000, toleranceMs: 6 * 60 * 60_000 }),
  P7D: Object.freeze({ label: "7d", offsetMs: 7 * 24 * 60 * 60_000, toleranceMs: 24 * 60 * 60_000 }),
  P30D: Object.freeze({ label: "30d", offsetMs: 30 * 24 * 60 * 60_000, toleranceMs: 72 * 60 * 60_000 }),
});

const SNAPSHOT_HORIZON_ALIASES = Object.freeze({
  "1h": "PT1H",
  "24h": "P1D",
  "7d": "P7D",
  "30d": "P30D",
  PT1H: "PT1H",
  P1D: "P1D",
  P7D: "P7D",
  P30D: "P30D",
});

export const EXPERIMENT_FACTORS = Object.freeze([
  "topic",
  "hook_3s",
  "cover",
  "title",
  "duration",
  "publish_time",
]);

export const OPERATIONS_METRIC_DEFINITIONS = Object.freeze({
  collection_volume: Object.freeze({ label: "采集量", unit: "intake_items" }),
  ingestion_success_rate: Object.freeze({ label: "入库成功率", unit: "ratio" }),
  analysis_backlog: Object.freeze({ label: "分析积压", unit: "assets" }),
  generation_success_rate: Object.freeze({ label: "生成成功率", unit: "ratio" }),
  rework_rate: Object.freeze({ label: "返工率", unit: "ratio" }),
  review_duration: Object.freeze({ label: "审核时长", unit: "seconds_p50" }),
  draft_rate: Object.freeze({ label: "草稿率", unit: "ratio" }),
  public_rate: Object.freeze({ label: "公开率", unit: "ratio" }),
  receipt_latency: Object.freeze({ label: "回执延迟", unit: "seconds_p50" }),
  metric_freshness: Object.freeze({ label: "指标新鲜度", unit: "seconds_p90" }),
});

const VALUE_STATUS_SET = new Set(VALUE_STATUSES);
const PLATFORM_METRIC_NAME_SET = new Set(PLATFORM_METRIC_NAMES);
const EXPERIMENT_FACTOR_SET = new Set(EXPERIMENT_FACTORS);
const COUNT_METRICS = new Set(["plays", "likes", "comments", "favorites", "shares"]);
const TERMINAL_INGEST = new Set(["success", "linked", "duplicate", "failed", "partial", "orphaned", "needs_attention"]);
const RESOLVED_INGEST = new Set(["success", "linked", "duplicate"]);
const REVIEW_DECISIONS = new Set(["approved_for_drafts", "approved_for_publish", "needs_revision", "rejected"]);
const TERMINAL_GENERATION = new Set(["completed", "failed", "timed_out", "invalid_output"]);
const ELIGIBLE_RECEIPT_STATES = new Set(["draft", "submitted", "public", "failed", "needs_attention"]);
const FINAL_VISIBILITY_STATES = new Set(["draft", "public"]);
const SYNTHETIC_SOURCE = /^synthetic(?:$|[:_-])/i;

function cleanText(value, maxLength = 500) {
  const text = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, maxLength) : null;
}

function iso(value, field, { optional = false } = {}) {
  if ((value === null || value === undefined || value === "") && optional) return null;
  const millis = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(millis)) throw new Error(`${field}_invalid`);
  return new Date(millis).toISOString();
}

function millis(value) {
  const parsed = Date.parse(String(value ?? ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeSnapshotHorizon(value) {
  const horizon = SNAPSHOT_HORIZON_ALIASES[String(value || "")];
  if (!horizon) throw new Error("snapshot_horizon_invalid");
  return horizon;
}

function positiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number <= 0) throw new Error(`${field}_must_be_positive_integer`);
  return number;
}

function percentile(values, fraction) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * fraction;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

function isSyntheticRow(row) {
  return row?.isSynthetic === true || row?.is_synthetic === 1 || SYNTHETIC_SOURCE.test(String(row?.source || ""));
}

function rowsForMode(rows, dataMode) {
  return (Array.isArray(rows) ? rows : []).filter((row) => dataMode === "synthetic" ? isSyntheticRow(row) : !isSyntheticRow(row));
}

function safeExternalUrl(value) {
  const raw = cleanText(value, 1_000);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password) return null;
    return canonicalizeSourceUrl(parsed.toString());
  } catch {
    return null;
  }
}

function availableMetric(value, unit, detail = {}) {
  if (!Number.isFinite(value)) throw new Error("available_metric_value_invalid");
  return { status: "available", value, unit, ...detail };
}

function absentMetric(status, unit, reasonCode, detail = {}) {
  if (!VALUE_STATUS_SET.has(status) || status === "available") throw new Error("absent_metric_status_invalid");
  return { status, value: null, unit, reasonCode, ...detail };
}

function rateMetric(numerator, denominator, detail = {}) {
  const { reasonCode = "no_eligible_observations", ...rest } = detail;
  if (!Number.isFinite(denominator) || denominator <= 0) {
    return absentMetric("not_collected", "ratio", reasonCode, {
      numerator: Number.isFinite(numerator) ? numerator : 0,
      denominator: Number.isFinite(denominator) ? denominator : 0,
      ...rest,
    });
  }
  return availableMetric(round(numerator / denominator, 6), "ratio", { numerator, denominator, ...rest });
}

/**
 * 平台指标四态。0 是 available 的合法值；NULL 永远不能单独表达状态。
 */
export function normalizePlatformMetric(input, { metricName } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("platform_metric_object_required");
  if (metricName && !PLATFORM_METRIC_NAME_SET.has(metricName)) throw new Error("platform_metric_name_invalid");
  const status = String(input.status || "").trim();
  if (!VALUE_STATUS_SET.has(status)) throw new Error("platform_metric_status_invalid");
  const hasValue = input.value !== null && input.value !== undefined && input.value !== "";
  if (status === "available") {
    const value = Number(input.value);
    if (!hasValue || !Number.isFinite(value) || value < 0) throw new Error("available_platform_metric_value_invalid");
    if (metricName && COUNT_METRICS.has(metricName) && !Number.isInteger(value)) {
      throw new Error("count_platform_metric_must_be_integer");
    }
    if (metricName === "completion_rate" && value > 1) throw new Error("completion_rate_out_of_range");
    return {
      status,
      value,
      raw: input.raw === null || input.raw === undefined ? null : cleanText(input.raw, 200),
      reasonCode: null,
      sourceErrorCode: null,
    };
  }
  if (hasValue) throw new Error("absent_platform_metric_must_not_have_value");
  const reasonCode = cleanText(input.reasonCode, 120);
  if (!reasonCode) throw new Error("absent_platform_metric_reason_required");
  return {
    status,
    value: null,
    raw: input.raw === null || input.raw === undefined ? null : cleanText(input.raw, 200),
    reasonCode,
    sourceErrorCode: cleanText(input.sourceErrorCode, 120),
  };
}

/** 补充表迁移是幂等的；旧表和旧 nullable 数值列保持不变。 */
export function ensureOperationsSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ops_post_lineage (
      platform_post_id INTEGER PRIMARY KEY REFERENCES platform_post(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL REFERENCES video_asset(id) ON DELETE CASCADE,
      generation_id TEXT REFERENCES remake_generation(id) ON DELETE RESTRICT,
      origin_kind TEXT NOT NULL CHECK(origin_kind IN ('source_asset','generation')),
      publish_receipt_id TEXT,
      post_role TEXT NOT NULL DEFAULT 'published' CHECK(post_role IN ('published')),
      linked_at TEXT NOT NULL,
      source TEXT NOT NULL,
      is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK(is_synthetic IN (0,1)),
      CHECK(
        (origin_kind='source_asset' AND generation_id IS NULL)
        OR (origin_kind='generation' AND generation_id IS NOT NULL)
      )
    );
    CREATE TABLE IF NOT EXISTS ops_platform_metric_observation (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      metric_snapshot_id INTEGER REFERENCES metric_snapshot(id) ON DELETE SET NULL,
      platform_post_id INTEGER NOT NULL REFERENCES platform_post(id) ON DELETE CASCADE,
      asset_id TEXT NOT NULL REFERENCES video_asset(id) ON DELETE CASCADE,
      generation_id TEXT REFERENCES remake_generation(id) ON DELETE SET NULL,
      content_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      metric_name TEXT NOT NULL CHECK(metric_name IN ('plays','likes','comments','favorites','shares','avg_watch_seconds','completion_rate')),
      snapshot_horizon TEXT NOT NULL CHECK(snapshot_horizon IN ('PT1H','P1D','P7D','P30D')),
      target_at TEXT NOT NULL,
      source_event_at TEXT NOT NULL,
      observed_at TEXT NOT NULL,
      ingested_at TEXT NOT NULL,
      value REAL,
      value_status TEXT NOT NULL CHECK(value_status IN ('available','unavailable','not_collected','permission_denied')),
      raw_value TEXT,
      reason_code TEXT,
      source_error_code TEXT,
      source TEXT NOT NULL,
      observation_id TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
      is_synthetic INTEGER NOT NULL DEFAULT 0 CHECK(is_synthetic IN (0,1)),
      CHECK(
        (value_status='available' AND value IS NOT NULL AND value >= 0 AND reason_code IS NULL)
        OR (value_status<>'available' AND value IS NULL AND reason_code IS NOT NULL)
      ),
      UNIQUE(platform_post_id, snapshot_horizon, metric_name, source, observation_id, revision)
    );
    CREATE INDEX IF NOT EXISTS idx_ops_metric_post_horizon
      ON ops_platform_metric_observation(platform_post_id, snapshot_horizon, metric_name, revision);
    CREATE INDEX IF NOT EXISTS idx_ops_metric_freshness
      ON ops_platform_metric_observation(value_status, source_event_at, observed_at);
  `);
}

export function linkPlatformPostLineage(db, input = {}) {
  ensureOperationsSchema(db);
  const platformPostId = positiveInteger(input.platformPostId, "platform_post_id");
  const post = db.prepare("SELECT id, asset_id FROM platform_post WHERE id=?").get(platformPostId);
  if (!post) throw new Error("platform_post_not_found");
  const assetId = String(input.assetId || post.asset_id || "").trim();
  if (!assetId || post.asset_id !== assetId) throw new Error("platform_post_asset_mismatch");
  const generationId = cleanText(input.generationId, 240);
  const originKind = generationId ? "generation" : "source_asset";
  if (generationId) {
    const generation = db.prepare("SELECT id, asset_id FROM remake_generation WHERE id=?").get(generationId);
    if (!generation) throw new Error("generation_not_found");
    if (generation.asset_id !== assetId) throw new Error("generation_asset_mismatch");
  }
  const existing = db.prepare("SELECT * FROM ops_post_lineage WHERE platform_post_id=?").get(platformPostId);
  const publishReceiptId = cleanText(input.publishReceiptId, 240);
  const isSynthetic = input.isSynthetic === true ? 1 : 0;
  if (existing) {
    const same = existing.asset_id === assetId
      && (existing.generation_id || null) === (generationId || null)
      && (!publishReceiptId || (existing.publish_receipt_id || null) === publishReceiptId)
      && existing.is_synthetic === isSynthetic;
    if (!same) throw new Error("platform_post_lineage_conflict");
    return { inserted: false, lineage: existing };
  }
  const linkedAt = iso(input.linkedAt || new Date(), "linked_at");
  const source = cleanText(input.source, 160) || "operations_contract";
  db.prepare(`INSERT INTO ops_post_lineage
    (platform_post_id,asset_id,generation_id,origin_kind,publish_receipt_id,linked_at,source,is_synthetic)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(platformPostId, assetId, generationId, originKind, publishReceiptId, linkedAt, source, isSynthetic);
  return {
    inserted: true,
    lineage: db.prepare("SELECT * FROM ops_post_lineage WHERE platform_post_id=?").get(platformPostId),
  };
}

export function snapshotSchedule(publishedAt) {
  const published = iso(publishedAt, "published_at");
  const publishedMs = Date.parse(published);
  return Object.entries(SNAPSHOT_HORIZONS).map(([horizon, config]) => ({
    horizon,
    label: config.label,
    targetAt: new Date(publishedMs + config.offsetMs).toISOString(),
    toleranceMs: config.toleranceMs,
  }));
}

/**
 * 诊断性地找出离目标最近的旧 ad_hoc metric_snapshot。
 * 返回值永远不标记为 scheduled available，不得用于四个周期槽的覆盖率。
 */
export function selectSnapshotForHorizon(snapshots, { publishedAt, horizon, asOf }) {
  const canonicalHorizon = normalizeSnapshotHorizon(horizon);
  const config = SNAPSHOT_HORIZONS[canonicalHorizon];
  const publishedMs = Date.parse(iso(publishedAt, "published_at"));
  const asOfMs = Date.parse(iso(asOf, "as_of"));
  const targetMs = publishedMs + config.offsetMs;
  if (asOfMs < targetMs) {
    return {
      status: "not_due",
      horizon: canonicalHorizon,
      targetAt: new Date(targetMs).toISOString(),
      snapshot: null,
      snapshotKind: null,
      eligibleForScheduledSlot: false,
    };
  }
  const candidates = (Array.isArray(snapshots) ? snapshots : [])
    .map((snapshot) => ({ snapshot, capturedMs: millis(snapshot?.captured_at ?? snapshot?.capturedAt) }))
    .filter((row) => row.capturedMs !== null && row.capturedMs <= asOfMs && Math.abs(row.capturedMs - targetMs) <= config.toleranceMs)
    .sort((left, right) => Math.abs(left.capturedMs - targetMs) - Math.abs(right.capturedMs - targetMs)
      || right.capturedMs - left.capturedMs);
  return {
    status: candidates.length ? "ad_hoc_candidate" : "missing_data",
    horizon: canonicalHorizon,
    targetAt: new Date(targetMs).toISOString(),
    snapshot: candidates[0]?.snapshot || null,
    snapshotKind: candidates.length ? "ad_hoc" : null,
    eligibleForScheduledSlot: false,
  };
}

/**
 * 一次平台观测写一条旧宽表快照，并为每个预期指标写一条四态明细。
 * observationId + revision 提供幂等与迟到修订；旧观测从不覆盖。
 */
export function recordPlatformMetricSnapshot(db, input = {}) {
  ensureOperationsSchema(db);
  const horizon = normalizeSnapshotHorizon(input.horizon);
  const observationId = cleanText(input.observationId, 240);
  if (!observationId) throw new Error("observation_id_required");
  const source = cleanText(input.source, 160);
  if (!source) throw new Error("snapshot_source_required");
  const revision = input.revision === undefined ? 1 : positiveInteger(input.revision, "revision");
  const metricsInput = input.metrics;
  if (!metricsInput || typeof metricsInput !== "object" || Array.isArray(metricsInput)) throw new Error("snapshot_metrics_required");
  const metricNames = Object.keys(metricsInput).sort();
  if (JSON.stringify(metricNames) !== JSON.stringify([...PLATFORM_METRIC_NAMES].sort())) {
    throw new Error("snapshot_metrics_must_cover_contract");
  }
  const metrics = Object.fromEntries(metricNames.map((name) => [name, normalizePlatformMetric(metricsInput[name], { metricName: name })]));

  let post;
  if (input.platformPostId !== undefined && input.platformPostId !== null) {
    post = db.prepare("SELECT * FROM platform_post WHERE id=?").get(positiveInteger(input.platformPostId, "platform_post_id"));
  } else {
    const assetId = cleanText(input.assetId, 240);
    const contentId = cleanText(input.contentId, 240);
    if (!assetId || !contentId) throw new Error("platform_post_identity_required");
    post = db.prepare(`SELECT * FROM platform_post WHERE asset_id=? AND content_id=?
      ORDER BY fetched_at DESC, id DESC LIMIT 1`).get(assetId, contentId);
  }
  if (!post) throw new Error("platform_post_not_found");
  if (input.assetId && String(input.assetId) !== post.asset_id) throw new Error("platform_post_asset_mismatch");

  const publishedAt = iso(post.publish_time, "published_at");
  if (input.publishedAt && iso(input.publishedAt, "published_at") !== publishedAt) {
    throw new Error("platform_post_publish_time_mismatch");
  }
  const observedAt = iso(input.observedAt || input.capturedAt, "observed_at");
  if (Date.parse(observedAt) < Date.parse(publishedAt)) throw new Error("snapshot_before_publish_time");
  const sourceEventAt = iso(input.sourceEventAt, "source_event_at");
  if (Date.parse(sourceEventAt) > Date.parse(observedAt)) throw new Error("source_event_after_observed_at");
  if (Date.parse(sourceEventAt) < Date.parse(publishedAt)) throw new Error("source_event_before_publish_time");
  const ingestedAt = iso(input.ingestedAt || new Date(), "ingested_at");
  if (Date.parse(ingestedAt) < Date.parse(observedAt)) throw new Error("ingested_before_observed_at");
  const targetAt = snapshotSchedule(publishedAt).find((row) => row.horizon === horizon).targetAt;
  if (Math.abs(Date.parse(sourceEventAt) - Date.parse(targetAt)) > SNAPSHOT_HORIZONS[horizon].toleranceMs) {
    throw new Error("snapshot_source_event_outside_horizon_tolerance");
  }
  const contentId = String(post.content_id || `platform_post:${post.id}`);
  const platform = cleanText(post.platform, 120) || "unknown";
  if (input.platform && cleanText(input.platform, 120) !== platform) throw new Error("platform_post_platform_mismatch");
  const existingLineage = db.prepare("SELECT * FROM ops_post_lineage WHERE platform_post_id=?").get(post.id);
  const suppliedGenerationId = cleanText(input.generationId, 240);
  if (existingLineage?.generation_id && suppliedGenerationId && existingLineage.generation_id !== suppliedGenerationId) {
    throw new Error("platform_post_generation_mismatch");
  }
  const generationId = suppliedGenerationId || existingLineage?.generation_id || null;
  const columnValue = (name) => metrics[name]?.status === "available" ? metrics[name].value : null;
  const columnRaw = (name) => metrics[name]?.raw ?? null;
  const snapshotObservationId = `${observationId}:${horizon}:r${revision}`;
  const synthetic = input.isSynthetic === true ? 1 : 0;
  if (existingLineage && existingLineage.is_synthetic !== synthetic) throw new Error("platform_post_lineage_data_mode_mismatch");
  db.exec("SAVEPOINT ops_metric_snapshot");
  try {
    if (generationId || input.linkSourceAsset === true) {
      linkPlatformPostLineage(db, {
        platformPostId: post.id,
        assetId: post.asset_id,
        generationId,
        publishReceiptId: input.publishReceiptId,
        linkedAt: input.linkedAt || observedAt,
        source,
        isSynthetic: input.isSynthetic === true,
      });
    }
    const existingWide = db.prepare(`SELECT * FROM metric_snapshot
      WHERE asset_id=? AND content_id=? AND source=? AND observation_id=?`)
      .get(post.asset_id, contentId, source, snapshotObservationId);
    if (existingWide) {
      const expectedWide = {
        captured_at: observedAt,
        plays: columnValue("plays"),
        plays_raw: columnRaw("plays"),
        likes: columnValue("likes"),
        likes_raw: columnRaw("likes"),
        comments: columnValue("comments"),
        comments_raw: columnRaw("comments"),
        favorites: columnValue("favorites"),
        favorites_raw: columnRaw("favorites"),
        shares: columnValue("shares"),
        shares_raw: columnRaw("shares"),
        avg_watch_seconds: columnValue("avg_watch_seconds"),
        completion_rate: columnValue("completion_rate"),
      };
      if (Object.entries(expectedWide).some(([key, value]) => (existingWide[key] ?? null) !== (value ?? null))) {
        throw new Error("metric_snapshot_idempotency_conflict");
      }
    }
    db.prepare(`INSERT OR IGNORE INTO metric_snapshot
      (asset_id,content_id,captured_at,plays,plays_raw,likes,likes_raw,comments,comments_raw,
       favorites,favorites_raw,shares,shares_raw,avg_watch_seconds,completion_rate,source,observation_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(
        post.asset_id, contentId, observedAt,
        columnValue("plays"), columnRaw("plays"),
        columnValue("likes"), columnRaw("likes"),
        columnValue("comments"), columnRaw("comments"),
        columnValue("favorites"), columnRaw("favorites"),
        columnValue("shares"), columnRaw("shares"),
        columnValue("avg_watch_seconds"), columnValue("completion_rate"),
        source, snapshotObservationId,
      );
    const snapshot = db.prepare(`SELECT id FROM metric_snapshot
      WHERE asset_id=? AND content_id=? AND source=? AND observation_id=?`)
      .get(post.asset_id, contentId, source, snapshotObservationId);
    let inserted = 0;
    const insert = db.prepare(`INSERT OR IGNORE INTO ops_platform_metric_observation
      (metric_snapshot_id,platform_post_id,asset_id,generation_id,content_id,platform,metric_name,snapshot_horizon,
       target_at,source_event_at,observed_at,ingested_at,value,value_status,raw_value,reason_code,source_error_code,
       source,observation_id,revision,is_synthetic)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const [name, metric] of Object.entries(metrics)) {
      const existingObservation = db.prepare(`SELECT * FROM ops_platform_metric_observation
        WHERE platform_post_id=? AND snapshot_horizon=? AND metric_name=? AND source=?
          AND observation_id=? AND revision=?`).get(post.id, horizon, name, source, observationId, revision);
      if (existingObservation) {
        const expected = {
          generation_id: generationId,
          platform,
          target_at: targetAt,
          source_event_at: sourceEventAt,
          observed_at: observedAt,
          value: metric.value,
          value_status: metric.status,
          raw_value: metric.raw,
          reason_code: metric.reasonCode,
          source_error_code: metric.sourceErrorCode,
          is_synthetic: synthetic,
        };
        const conflict = Object.entries(expected).some(([key, value]) => (existingObservation[key] ?? null) !== (value ?? null));
        if (conflict) throw new Error("snapshot_observation_idempotency_conflict");
        continue;
      }
      const result = insert.run(
        snapshot?.id || null, post.id, post.asset_id, generationId, contentId, platform, name, horizon,
        targetAt, sourceEventAt, observedAt, ingestedAt, metric.value, metric.status, metric.raw,
        metric.reasonCode, metric.sourceErrorCode, source, observationId, revision, synthetic,
      );
      inserted += Number(result.changes || 0);
    }
    db.exec("RELEASE ops_metric_snapshot");
    return { ok: true, snapshotId: snapshot?.id || null, observationsInserted: inserted, horizon, targetAt };
  } catch (error) {
    db.exec("ROLLBACK TO ops_metric_snapshot");
    db.exec("RELEASE ops_metric_snapshot");
    throw error;
  }
}

function stableComparable(value) {
  const canonical = (candidate) => {
    if (candidate === undefined) return "__undefined__";
    if (typeof candidate === "number" && !Number.isFinite(candidate)) throw new Error("experiment_value_invalid");
    if (Array.isArray(candidate)) return candidate.map(canonical);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(Object.keys(candidate).sort().map((key) => [key, canonical(candidate[key])]));
    }
    return candidate;
  };
  return JSON.stringify(canonical(value));
}

function changedExperimentKeys(control, variant) {
  if (!control || typeof control !== "object" || Array.isArray(control)
    || !variant || typeof variant !== "object" || Array.isArray(variant)) {
    throw new Error("experiment_control_and_variant_required");
  }
  const controlKeys = Object.keys(control).sort();
  const variantKeys = Object.keys(variant).sort();
  if (JSON.stringify(controlKeys) !== JSON.stringify(variantKeys)) throw new Error("experiment_arm_keys_must_match");
  if (JSON.stringify(controlKeys) !== JSON.stringify([...EXPERIMENT_FACTORS].sort())) {
    throw new Error("experiment_arms_must_cover_all_primary_factors");
  }
  return controlKeys.filter((key) => stableComparable(control[key]) !== stableComparable(variant[key]));
}

export function createExperimentCard(input = {}) {
  const primaryFactor = String(input.primaryFactor || "");
  if (!EXPERIMENT_FACTOR_SET.has(primaryFactor)) throw new Error("experiment_primary_factor_invalid");
  const changedKeys = changedExperimentKeys(input.control, input.variant);
  if (changedKeys.length !== 1 || changedKeys[0] !== primaryFactor) throw new Error("experiment_must_change_exactly_one_primary_factor");
  const plannedSampleSize = positiveInteger(input.plannedSampleSize, "planned_sample_size");
  const minimumSampleSize = positiveInteger(input.minimumSampleSize ?? plannedSampleSize, "minimum_sample_size");
  if (minimumSampleSize > plannedSampleSize) throw new Error("minimum_sample_exceeds_plan");
  const baseline = input.baseline;
  if (!baseline || typeof baseline !== "object" || Array.isArray(baseline)) throw new Error("experiment_baseline_required");
  const baselineReference = cleanText(baseline.referenceId, 240);
  if (!baselineReference) throw new Error("experiment_baseline_reference_required");
  const baselineSampleSize = positiveInteger(baseline.sampleSize, "baseline_sample_size");
  const successMetric = input.successMetric;
  if (!successMetric || typeof successMetric !== "object" || Array.isArray(successMetric)) throw new Error("experiment_success_metric_required");
  const successMetricName = cleanText(successMetric.name, 120);
  const direction = String(successMetric.direction || "");
  if (!successMetricName || !["increase", "decrease", "within_range"].includes(direction)) {
    throw new Error("experiment_success_metric_invalid");
  }
  const successHorizon = normalizeSnapshotHorizon(successMetric.horizon);
  const stop = input.stopConditions;
  if (!stop || typeof stop !== "object" || Array.isArray(stop)) throw new Error("experiment_stop_conditions_required");
  const maxDurationDays = positiveInteger(stop.maxDurationDays, "experiment_max_duration_days");
  const minimumDurationDays = positiveInteger(stop.minimumDurationDays ?? 1, "experiment_minimum_duration_days");
  if (minimumDurationDays > maxDurationDays) throw new Error("experiment_minimum_duration_exceeds_maximum");
  const sampleUnit = String(input.sampleUnit || "");
  if (!new Set(["platform_post", "generated_video", "material", "account"]).has(sampleUnit)) {
    throw new Error("experiment_sample_unit_invalid");
  }
  const assignmentMethod = String(input.assignmentMethod || "observational");
  if (!new Set(["randomized", "matched", "observational"]).has(assignmentMethod)) throw new Error("experiment_assignment_method_invalid");
  const evidenceLevel = String(input.evidenceLevel || (assignmentMethod === "randomized" ? "causal_randomized" : "associational"));
  if (!new Set(["descriptive", "associational", "causal_randomized"]).has(evidenceLevel)) throw new Error("experiment_evidence_level_invalid");
  if (evidenceLevel === "causal_randomized" && assignmentMethod !== "randomized") throw new Error("causal_evidence_requires_randomization");
  const id = cleanText(input.id, 240);
  if (!id) throw new Error("experiment_id_required");
  const hypothesis = cleanText(input.hypothesis, 1_000);
  if (!hypothesis) throw new Error("experiment_hypothesis_required");
  const heldConstant = Object.fromEntries(Object.entries(input.control).filter(([key]) => key !== primaryFactor));
  if (!Object.keys(heldConstant).length) throw new Error("experiment_held_constant_required");
  const createdAt = iso(input.createdAt || new Date(), "experiment_created_at");
  const baselineEndAt = iso(baseline.windowEndAt || createdAt, "experiment_baseline_end_at");
  const windowDays = Number(String(baseline.window || "").match(/(\d+)/)?.[1]) || 14;
  const baselineStartAt = iso(
    baseline.windowStartAt || new Date(Date.parse(baselineEndAt) - windowDays * 24 * 60 * 60_000),
    "experiment_baseline_start_at",
  );
  const normalizedBaselineMetric = baseline.metric
    ? normalizePlatformMetric(baseline.metric, { metricName: successMetricName })
    : { status: "not_collected", value: null, raw: null, reasonCode: "baseline_metric_not_collected" };
  const minimumDetectableEffect = Number(successMetric.minimumDetectableEffect);
  if (!Number.isFinite(minimumDetectableEffect) || minimumDetectableEffect < 0) {
    throw new Error("experiment_minimum_detectable_effect_invalid");
  }
  const platforms = Array.isArray(input.platforms)
    ? [...new Set(input.platforms.map((value) => cleanText(value, 80)).filter(Boolean))]
    : [];
  if (!platforms.length) throw new Error("experiment_platform_required");
  const guardrails = Array.isArray(stop.guardrails) ? stop.guardrails.map((value) => cleanText(value, 240)).filter(Boolean) : [];
  const dataQualityChecks = Array.isArray(stop.dataQuality) ? stop.dataQuality.map((value) => cleanText(value, 240)).filter(Boolean) : [];
  if (!guardrails.length || !dataQualityChecks.length) throw new Error("experiment_guardrail_and_data_quality_required");
  const plannedControl = Math.floor(plannedSampleSize / 2);
  const plannedVariant = plannedSampleSize - plannedControl;
  if (plannedControl < 1 || plannedVariant < 1) throw new Error("experiment_sample_plan_requires_two_arms");
  return {
    id,
    status: "draft",
    primaryFactor,
    hypothesis,
    allocationMethod: assignmentMethod,
    evidenceLevel,
    analysisUnit: sampleUnit,
    platforms,
    control: structuredClone(input.control),
    variant: structuredClone(input.variant),
    heldConstant,
    baseline: {
      kind: input.dataMode === "synthetic" ? "synthetic" : "historical",
      windowStartAt: baselineStartAt,
      windowEndAt: baselineEndAt,
      metricKey: successMetricName,
      metricValue: {
        status: normalizedBaselineMetric.status,
        value: normalizedBaselineMetric.value,
        reasonCode: normalizedBaselineMetric.reasonCode,
        rawValue: normalizedBaselineMetric.raw,
        approximate: false,
      },
      sampleSize: baselineSampleSize,
    },
    sampleSizePlan: { unit: sampleUnit, control: plannedControl, variant: plannedVariant },
    successMetric: {
      key: successMetricName,
      direction: direction === "within_range" ? "non_inferior" : direction,
      minimumDetectableEffect,
      unit: successMetric.unit || (successMetricName === "completion_rate" ? "ratio" : "count"),
      observationOffset: successHorizon,
    },
    stopConditions: {
      minimumSamplePerArm: Math.ceil(minimumSampleSize / 2),
      minimumDurationDays,
      maximumDurationDays: maxDurationDays,
      peekingPolicy: stop.noPeekingBeforeMinimum === false ? "pre_registered_sequential" : "fixed_horizon",
      guardrails,
      dataQualityChecks,
    },
    conclusionTemplate: "在该样本与既定控制条件下，观察到变体相对基线___；样本量___，数据覆盖___，护栏___。该结果描述本次实验观察，不自动外推为普遍因果；下一步为___。",
    conclusion: {
      status: "pending",
      observedEffect: null,
      intervalLower: null,
      intervalUpper: null,
      sampleSizeControl: 0,
      sampleSizeVariant: 0,
      coverage: {
        eligibleCount: 0,
        includedCount: 0,
        excludedCount: 0,
        coverageRatio: null,
        statusCounts: { available: 0, unavailable: 0, notCollected: 0, permissionDenied: 0 },
      },
      decision: "待达到预注册样本和观察窗口后再判断。",
      limitations: ["当前仅为实验计划，无结果数据。"],
      causalClaim: false,
    },
    createdAt,
    startedAt: null,
    endedAt: null,
    isSynthetic: input.dataMode === "synthetic",
    // referenceId 只用于输入完整性校验，canonical baseline 用时间窗和指标键表达。
  };
}

export function concludeExperiment(card, result = {}) {
  if (!card || !EXPERIMENT_FACTOR_SET.has(card.primaryFactor) || !card.sampleSizePlan) {
    throw new Error("experiment_card_invalid");
  }
  const controlSampleSize = Math.max(0, Number(result.controlSampleSize) || 0);
  const variantSampleSize = Math.max(0, Number(result.variantSampleSize) || 0);
  const observedSampleSize = controlSampleSize + variantSampleSize;
  const now = iso(result.asOf || new Date(), "experiment_as_of");
  const primary = result.primaryMetric ? normalizePlatformMetric(result.primaryMetric, { metricName: card.successMetric.key }) : null;
  const minimumPerArm = card.stopConditions.minimumSamplePerArm;
  const minimumTotal = minimumPerArm * 2;
  if (observedSampleSize < minimumTotal || controlSampleSize < minimumPerArm || variantSampleSize < minimumPerArm) {
    return {
      status: "insufficient_data",
      observedSampleSize,
      asOf: now,
      controlSampleSize,
      variantSampleSize,
      conclusion: `当前对照组 ${controlSampleSize}、变体组 ${variantSampleSize}，未同时达到每组 ${minimumPerArm} 及总样本 ${minimumTotal}；不判断胜负，也不作因果结论。`,
    };
  }
  if (result.windowComplete !== true) {
    return {
      status: "not_due",
      observedSampleSize,
      controlSampleSize,
      variantSampleSize,
      asOf: now,
      conclusion: "预设观察窗口尚未完成；不提前看结果，不判断胜负。",
    };
  }
  if (result.guardrailsPassed !== true || result.dataQualityPassed !== true) {
    return {
      status: "insufficient_data",
      observedSampleSize,
      controlSampleSize,
      variantSampleSize,
      asOf: now,
      conclusion: "护栏或数据质量条件未明确通过；本次不判断胜负，也不作因果结论。",
    };
  }
  if (!primary || primary.status !== "available") {
    return {
      status: "insufficient_data",
      observedSampleSize,
      controlSampleSize,
      variantSampleSize,
      asOf: now,
      conclusion: "主成功指标尚无可用观测；当前只能记录数据缺口，不能判断胜负或因果。",
    };
  }
  const decision = new Set(["continue", "iterate", "stop", "adopt_for_further_test"]).has(result.decision)
    ? result.decision
    : "continue";
  return {
    status: "completed",
    observedSampleSize,
    controlSampleSize,
    variantSampleSize,
    asOf: now,
    primaryMetric: primary,
    decision,
    conclusion: `在该样本中观察到主指标值 ${primary.value}；决定为 ${decision}。该观察只适用于已记录条件，不自动证明该变量导致结果变化。`,
  };
}

export function buildReviewFramework({ anchorAt, asOf = new Date(), timezone = "Asia/Shanghai", hasData = true } = {}) {
  const anchor = iso(anchorAt, "review_anchor_at");
  const asOfIso = iso(asOf, "review_as_of");
  const anchorMs = Date.parse(anchor);
  const asOfMs = Date.parse(asOfIso);
  return [
    { day: 7, horizons: ["PT1H", "P1D", "P7D"], focus: ["数据完整性", "运营漏斗", "积压与首轮信号"] },
    { day: 14, horizons: ["PT1H", "P1D", "P7D"], focus: ["两周稳定性", "分段一致性", "实验样本与混杂因素"] },
    { day: 30, horizons: ["PT1H", "P1D", "P7D", "P30D"], focus: ["30 天成熟快照", "复现实验", "保留、迭代或停止决定"] },
  ].map((checkpoint) => {
    const dueAt = new Date(anchorMs + checkpoint.day * 24 * 60 * 60_000).toISOString();
    return {
      ...checkpoint,
      dueAt,
      asOf: asOfIso,
      timezone,
      status: asOfMs < Date.parse(dueAt) ? "not_due" : hasData ? "ready" : "missing_data",
      dataCutoff: asOfMs < Date.parse(dueAt) ? asOfIso : dueAt,
      conclusionTemplate: "观察到___；样本量___，覆盖率___，缺失状态___，新鲜度___。该结果不自动构成因果结论；下一步___。",
    };
  });
}

/**
 * 生成单个 D7/D14/D30 复盘。即使稍后重跑，数据截止也固定在 checkpoint dueAt，
 * 因而不会把 D8 的回执或快照带入 D7。
 */
export function buildCheckpointReviewReport(db, options = {}) {
  const checkpointDay = Number(options.checkpointDay);
  if (![7, 14, 30].includes(checkpointDay)) throw new Error("checkpoint_day_invalid");
  const anchorAt = iso(options.anchorAt, "review_anchor_at");
  const requestedAsOf = iso(options.asOf || new Date(), "review_as_of");
  const dueAt = new Date(Date.parse(anchorAt) + checkpointDay * 24 * 60 * 60_000).toISOString();
  if (Date.parse(requestedAsOf) < Date.parse(dueAt)) {
    return { checkpointDay, dueAt, asOf: requestedAsOf, status: "not_due", report: null };
  }
  const report = buildOperationsReport(db, {
    ...options,
    from: anchorAt,
    to: dueAt,
    asOf: dueAt,
    anchorAt,
  });
  const evidenceCount = Number(report.metrics.collection_volume?.value || 0)
    + Number(report.metrics.analysis_backlog?.totalAssets || 0)
    + Number(report.metrics.public_rate?.eligibleAcceptedReceipts || 0)
    + Number(report.metrics.metric_freshness?.totalPosts || 0)
    + Number(report.dailyOperations.pendingReviews || 0)
    + Number(report.dailyOperations.approvedReviews || 0)
    + Number(report.dailyOperations.needsRevision || 0);
  return {
    checkpointDay,
    dueAt,
    asOf: dueAt,
    requestedAsOf,
    status: evidenceCount > 0 ? "ready" : "missing_data",
    report,
  };
}

function normalizeReceiptState(value) {
  const token = String(value || "unknown").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["public", "public_confirmed", "published", "posted", "live", "已公开", "已发布"].includes(token)) return "public";
  if (["draft", "platform_draft", "saved_draft", "草稿", "已存草稿"].includes(token)) return "draft";
  if (token === "workbench_draft") return "workbench_draft";
  if (["scheduled", "waiting_schedule", "等待定时发布"].includes(token)) return "scheduled";
  if (["submitted", "accepted", "success", "ok", "queued", "processing"].includes(token)) return "submitted";
  if (["failed", "failure", "error", "rejected"].includes(token)) return "failed";
  if (["needs_attention", "attention_required", "partial"].includes(token)) return "needs_attention";
  return "unknown";
}

function normalizeReceiptMode(value) {
  const token = String(value || "").trim().toLowerCase();
  if (token === "workbench_draft") return "workbench_draft";
  if (["draft", "platform_draft"].includes(token)) return "platform_draft";
  if (["scheduled"].includes(token)) return "scheduled";
  if (["public", "publish"].includes(token)) return "publish";
  return "unknown";
}

/** 兼容 publisher-receipts.json、tasks.json 和 direct Matrix 结果；按平台 destination 展开。 */
export function normalizePublishReceipts(receipts = []) {
  const output = [];
  for (const receipt of Array.isArray(receipts) ? receipts : []) {
    if (!receipt || typeof receipt !== "object") continue;
    const base = {
      receiptId: cleanText(receipt.receiptId || receipt.id, 240),
      revision: Number.isInteger(Number(receipt.revision)) && Number(receipt.revision) > 0 ? Number(receipt.revision) : 1,
      jobId: cleanText(receipt.publishTaskId || receipt.jobId || receipt.taskId, 240),
      assetId: cleanText(receipt.materialId || receipt.assetId || receipt.videoId || receipt.content?.id, 240),
      generationId: cleanText(receipt.generatedVideoId || receipt.generationId, 240),
      platformPostId: cleanText(receipt.platformPostId, 240),
      accountRef: cleanText(receipt.accountRef, 240),
      mode: normalizeReceiptMode(receipt.requestedMode || receipt.mode),
      requestedAt: millis(receipt.sourceEventAt || receipt.requestedAt || receipt.createdAt) === null
        ? null
        : iso(receipt.sourceEventAt || receipt.requestedAt || receipt.createdAt, "receipt_requested_at"),
      receiptAt: millis(receipt.observedAt || receipt.receiptAt || receipt.updatedAt) === null
        ? null
        : iso(receipt.observedAt || receipt.receiptAt || receipt.updatedAt, "receipt_at"),
      source: cleanText(receipt.source, 120) || "legacy_publish_ledger",
      isSynthetic: isSyntheticRow(receipt),
    };
    const nestedResults = receipt.result?.results;
    const results = Array.isArray(receipt.results) && receipt.results.length
      ? receipt.results
      : Array.isArray(nestedResults) && nestedResults.length ? nestedResults : null;
    if (results) {
      for (const result of results) {
        const state = normalizeReceiptState(result.status || result.state || (result.success === false ? "failed" : receipt.status || receipt.state));
        const postId = cleanText(result.externalPostId || result.postId, 240);
        const resultUrl = safeExternalUrl(result.externalUrl || result.resultUrl || result.url);
        output.push({
          ...base,
          platformPostId: cleanText(result.platformPostId, 240) || base.platformPostId,
          platform: cleanText(result.platform, 80) || "unknown",
          state: state === "public" && !postId && !resultUrl ? "needs_attention" : state,
          postId,
          resultUrl,
        });
      }
      continue;
    }
    const targets = Array.isArray(receipt.targets) && receipt.targets.length ? receipt.targets : [receipt.platform || "unknown"];
    for (const target of targets) {
      const postId = cleanText(receipt.externalPostId || receipt.postId, 240);
      const resultUrl = safeExternalUrl(receipt.externalUrl || receipt.resultUrl || receipt.url);
      let state = normalizeReceiptState(receipt.status || receipt.state);
      if (state === "draft" && base.mode === "workbench_draft") state = "workbench_draft";
      if (state === "public" && !postId && !resultUrl) state = "needs_attention";
      output.push({
        ...base,
        platform: cleanText(target?.platform || target, 80) || "unknown",
        state,
        postId,
        resultUrl,
      });
    }
  }
  return output;
}

function receiptDestinationKey(row) {
  return row.platformPostId || `${row.receiptId || row.jobId || "unknown"}\0${row.platform}\0${row.accountRef || ""}`;
}

function latestPublishReceiptsAt(rows, cutoffMs) {
  const groups = new Map();
  for (const row of rows) {
    const key = receiptDestinationKey(row);
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  const output = [];
  for (const group of groups.values()) {
    const revisionPayloads = new Map();
    for (const row of group) {
      const key = row.revision;
      const payload = stableComparable({
        state: row.state,
        requestedAt: row.requestedAt,
        receiptAt: row.receiptAt,
        postId: row.postId,
        resultUrl: row.resultUrl,
      });
      if (revisionPayloads.has(key) && revisionPayloads.get(key) !== payload) {
        throw new Error("publish_receipt_revision_conflict");
      }
      revisionPayloads.set(key, payload);
    }
    const visible = group.filter((row) => millis(row.receiptAt) !== null && millis(row.receiptAt) <= cutoffMs)
      .sort((left, right) => right.revision - left.revision
        || (millis(right.receiptAt) || 0) - (millis(left.receiptAt) || 0));
    if (visible.length) {
      output.push(visible[0]);
      continue;
    }
    const requested = group.filter((row) => millis(row.requestedAt) !== null && millis(row.requestedAt) <= cutoffMs)
      .sort((left, right) => (millis(right.requestedAt) || 0) - (millis(left.requestedAt) || 0));
    if (requested.length) output.push({ ...requested[0], state: "unknown", receiptAt: null, stateAfterCutoff: true });
  }
  return output;
}

function normalizeReviewDecision(value) {
  const token = String(value || "").trim().toLowerCase();
  if (["approved", "approved_for_drafts", "approved_for_publish"].includes(token)) return token === "approved" ? "approved_for_drafts" : token;
  if (["changes_requested", "needs_revision"].includes(token)) return "needs_revision";
  if (token === "rejected") return "rejected";
  return "pending_review";
}

/** 将 canonical creativeReviewEvent 和旧 creative-reviews.json 投影到统一 review cycle。 */
export function normalizeCreativeReviews(events = []) {
  return (Array.isArray(events) ? events : []).filter((event) => event && typeof event === "object").map((event) => {
    const submittedValue = event.submittedAt || event.createdAt;
    const decisionValue = event.decisionAt || (event.eventType === "decision" ? event.observedAt : event.updatedAt);
    const status = event.eventType === "withdrawn"
      ? "withdrawn"
      : normalizeReviewDecision(event.decision || event.status);
    return {
      id: cleanText(event.reviewEventId || event.id, 240),
      reviewCycleId: cleanText(event.reviewCycleId || event.id, 240),
      assetId: cleanText(event.materialId || event.assetId, 240),
      generationId: cleanText(event.generatedVideoId || event.generationId, 240),
      eventType: cleanText(event.eventType, 40) || (status === "pending_review" ? "submitted" : "decision"),
      status,
      submittedAt: millis(submittedValue) === null ? null : iso(submittedValue, "review_submitted_at"),
      decisionAt: millis(decisionValue) === null ? null : iso(decisionValue, "review_decision_at"),
      reasonCodes: Array.isArray(event.reasonCodes) ? event.reasonCodes.map((value) => cleanText(value, 120)).filter(Boolean) : [],
      source: cleanText(event.source, 120) || "legacy_creative_review",
      isSynthetic: isSyntheticRow(event),
    };
  });
}

function latestReviewCyclesAt(rows, cutoffMs) {
  const groups = new Map();
  for (const row of rows) {
    const key = row.reviewCycleId || row.id || `${row.generationId}\0${row.submittedAt}`;
    const group = groups.get(key) || [];
    group.push(row);
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => {
    const first = group.slice().sort((a, b) => (millis(a.submittedAt) || 0) - (millis(b.submittedAt) || 0))[0];
    const decisions = group.filter((row) => REVIEW_DECISIONS.has(row.status)
      && millis(row.decisionAt) !== null && millis(row.decisionAt) <= cutoffMs)
      .sort((a, b) => (millis(b.decisionAt) || 0) - (millis(a.decisionAt) || 0));
    return decisions[0] || { ...first, status: "pending_review", decisionAt: null };
  });
}

function withinPeriod(row, fromMs, toMs, fields) {
  for (const field of fields) {
    const at = millis(row?.[field]);
    if (at !== null) return at >= fromMs && at < toMs;
  }
  return false;
}

function latestMetricObservations(db, dataMode, asOfIso) {
  if (!tableExists(db, "ops_platform_metric_observation")) return [];
  const rows = db.prepare(`SELECT * FROM ops_platform_metric_observation
    WHERE observed_at <= ? AND ingested_at <= ?
    ORDER BY revision DESC, ingested_at DESC, id DESC`).all(asOfIso, asOfIso);
  const filtered = rowsForMode(rows, dataMode);
  const latestRevisionByStream = new Map();
  for (const row of filtered) {
    const key = `${row.platform_post_id}\0${row.snapshot_horizon}\0${row.metric_name}\0${row.source}\0${row.observation_id}`;
    if (!latestRevisionByStream.has(key)) latestRevisionByStream.set(key, row);
  }
  const latestBySourceSlot = new Map();
  const streamRows = [...latestRevisionByStream.values()].sort((left, right) =>
    (millis(right.source_event_at) || 0) - (millis(left.source_event_at) || 0)
    || (millis(right.observed_at) || 0) - (millis(left.observed_at) || 0)
    || right.revision - left.revision);
  for (const row of streamRows) {
    const key = `${row.platform_post_id}\0${row.snapshot_horizon}\0${row.metric_name}\0${row.source}`;
    if (!latestBySourceSlot.has(key)) latestBySourceSlot.set(key, row);
  }
  return [...latestBySourceSlot.values()];
}

function queryCoreRows(db, fromIso, toIso, asOfIso) {
  const importItems = tableExists(db, "import_item") && tableExists(db, "import_batch")
    ? db.prepare(`SELECT i.id,i.status,i.asset_id,b.created_at FROM import_item i
        JOIN import_batch b ON b.id=i.batch_id WHERE b.created_at>=? AND b.created_at<?`).all(fromIso, toIso)
    : [];
  const assets = tableExists(db, "video_asset")
    ? db.prepare("SELECT id,created_at FROM video_asset WHERE COALESCE(created_at,captured_at,updated_at)<=?").all(asOfIso)
    : [];
  const analyses = tableExists(db, "content_analysis")
    ? db.prepare("SELECT asset_id,confidence,analyzed_at FROM content_analysis WHERE analyzed_at IS NOT NULL AND analyzed_at<=?").all(asOfIso)
    : [];
  const generations = tableExists(db, "remake_generation")
    ? db.prepare("SELECT id,asset_id,engine,engine_task_id,status,created_at,completed_at,sha256 FROM remake_generation WHERE created_at IS NULL OR created_at<=?").all(asOfIso)
    : [];
  const posts = tableExists(db, "platform_post")
    ? db.prepare(`SELECT id,asset_id,content_id,post_id,url,platform,publish_time,fetched_at FROM platform_post
        WHERE COALESCE(publish_time,fetched_at) IS NOT NULL AND COALESCE(publish_time,fetched_at)<=?`).all(asOfIso)
    : [];
  const snapshots = tableExists(db, "metric_snapshot")
    ? db.prepare("SELECT * FROM metric_snapshot WHERE captured_at<=? ORDER BY captured_at,id").all(asOfIso)
    : [];
  const lineages = tableExists(db, "ops_post_lineage")
    ? db.prepare("SELECT * FROM ops_post_lineage WHERE linked_at<=?").all(asOfIso)
    : [];
  return { importItems, assets, analyses, generations, posts, snapshots, lineages };
}

function buildSnapshotCoverage({ posts, observations, asOfIso }) {
  const asOfMs = Date.parse(asOfIso);
  const observationsByPostHorizon = new Map();
  for (const row of observations) {
    const key = `${row.platform_post_id}\0${row.snapshot_horizon}`;
    const rows = observationsByPostHorizon.get(key) || [];
    rows.push(row);
    observationsByPostHorizon.set(key, rows);
  }
  const coverage = {};
  for (const horizon of Object.keys(SNAPSHOT_HORIZONS)) {
    let duePosts = 0;
    let notDuePosts = 0;
    let recordedPosts = 0;
    let availablePosts = 0;
    let missingPosts = 0;
    let anchorMissingPosts = 0;
    for (const post of posts) {
      const publishedMs = millis(post.publish_time);
      if (publishedMs === null) {
        anchorMissingPosts += 1;
        continue;
      }
      const due = publishedMs + SNAPSHOT_HORIZONS[horizon].offsetMs <= asOfMs;
      if (!due) {
        notDuePosts += 1;
        continue;
      }
      duePosts += 1;
      const explicit = observationsByPostHorizon.get(`${post.id}\0${horizon}`) || [];
      if (explicit.length) {
        recordedPosts += 1;
        if (explicit.some((row) => row.value_status === "available")) availablePosts += 1;
        continue;
      }
      // 旧 metric_snapshot 无 scheduled slot 证据，只能保留为 ad_hoc，不冒充周期快照。
      missingPosts += 1;
    }
    coverage[horizon] = {
      duePosts,
      notDuePosts,
      recordedPosts,
      availablePosts,
      missingPosts,
      anchorMissingPosts,
      collectionCoverage: duePosts ? round(recordedPosts / duePosts, 6) : null,
      valueCoverage: duePosts ? round(availablePosts / duePosts, 6) : null,
    };
  }
  return coverage;
}

function buildMetricFreshness(posts, observations, asOfIso) {
  const asOfMs = Date.parse(asOfIso);
  const latestByPost = new Map();
  const statusCounts = Object.fromEntries(VALUE_STATUSES.map((status) => [status, 0]));
  for (const row of observations) {
    statusCounts[row.value_status] = (statusCounts[row.value_status] || 0) + 1;
    if (row.value_status !== "available") continue;
    const at = millis(row.source_event_at);
    if (at === null || at > asOfMs) continue;
    latestByPost.set(row.platform_post_id, Math.max(latestByPost.get(row.platform_post_id) || 0, at));
  }
  const ages = [...latestByPost.values()].map((at) => (asOfMs - at) / 1_000).filter((age) => age >= 0);
  if (!ages.length) {
    return absentMetric("not_collected", "seconds_p90", "no_available_scheduled_platform_metric_snapshots", {
      coveredPosts: 0,
      totalPosts: posts.length,
      coverage: posts.length ? 0 : null,
      statusCounts,
    });
  }
  return availableMetric(round(percentile(ages, 0.9), 3), "seconds_p90", {
    p50Seconds: round(percentile(ages, 0.5), 3),
    maxSeconds: round(Math.max(...ages), 3),
    coveredPosts: latestByPost.size,
    totalPosts: posts.length,
    coverage: posts.length ? round(latestByPost.size / posts.length, 6) : null,
    statusCounts,
  });
}

const CANONICAL_KPI_SPECS = Object.freeze({
  collectionVolume: { sourceKey: "collection_volume", unit: "count", grain: "intake_attempt", formula: "COUNT(DISTINCT import_item.id)" },
  ingestionSuccessRate: { sourceKey: "ingestion_success_rate", unit: "ratio", grain: "terminal_intake_attempt", formula: "resolved terminal attempts / all terminal attempts" },
  analysisBacklog: { sourceKey: "analysis_backlog", unit: "count", grain: "material", formula: "eligible materials without completed analysis as of cutoff" },
  generationSuccessRate: { sourceKey: "generation_success_rate", unit: "ratio", grain: "generation_attempt", formula: "completed attempts / terminal attempts" },
  reworkRate: { sourceKey: "rework_rate", unit: "ratio", grain: "generated_video", formula: "distinct videos with changes requested / distinct videos with a decision" },
  reviewDurationSeconds: { sourceKey: "review_duration", unit: "seconds", grain: "decided_review_cycle", formula: "p50(decisionAt - submittedAt) in seconds" },
  draftRate: { sourceKey: "draft_rate", unit: "ratio", grain: "platform_destination", formula: "platform_draft / eligible destination outcomes" },
  publicRate: { sourceKey: "public_rate", unit: "ratio", grain: "platform_destination", formula: "public_confirmed / eligible destination outcomes" },
  receiptLatencySeconds: { sourceKey: "receipt_latency", unit: "seconds", grain: "platform_destination_receipt", formula: "p50(observedAt - sourceEventAt) in seconds" },
  metricFreshnessSeconds: { sourceKey: "metric_freshness", unit: "seconds", grain: "published_platform_post", formula: "p90(asOf - latest available sourceEventAt) in seconds" },
});

function canonicalStatusCounts(metric, includedCount, excludedCount) {
  if (metric?.statusCounts) {
    return {
      available: Number(metric.statusCounts.available || 0),
      unavailable: Number(metric.statusCounts.unavailable || 0),
      notCollected: Number(metric.statusCounts.not_collected || metric.statusCounts.notCollected || 0),
      permissionDenied: Number(metric.statusCounts.permission_denied || metric.statusCounts.permissionDenied || 0),
    };
  }
  return {
    available: metric?.status === "available" ? includedCount : 0,
    unavailable: metric?.status === "unavailable" ? Math.max(1, excludedCount) : 0,
    notCollected: metric?.status === "not_collected" ? Math.max(1, excludedCount) : 0,
    permissionDenied: metric?.status === "permission_denied" ? Math.max(1, excludedCount) : 0,
  };
}

function canonicalKpis(metrics, asOfIso) {
  return Object.fromEntries(Object.entries(CANONICAL_KPI_SPECS).map(([property, spec]) => {
    const metric = metrics[spec.sourceKey];
    const denominator = Number.isFinite(metric?.denominator) ? metric.denominator : null;
    const sampleCount = Number.isFinite(metric?.sampleSize)
      ? metric.sampleSize
      : denominator ?? (spec.unit === "count" && Number.isFinite(metric?.value) ? metric.value : 0);
    const eligibleCount = denominator
      ?? (Number.isFinite(metric?.totalPosts) ? metric.totalPosts
        : Number.isFinite(metric?.totalAssets) ? metric.totalAssets
          : sampleCount);
    const includedCount = Number.isFinite(metric?.coveredPosts) ? metric.coveredPosts : sampleCount;
    const excludedCount = Math.max(0, eligibleCount - includedCount);
    const statistics = {
      sampleCount: Math.max(0, Math.trunc(sampleCount)),
      p50: spec.sourceKey === "review_duration" || spec.sourceKey === "receipt_latency"
        ? metric?.value ?? null
        : metric?.p50Seconds ?? null,
      p90: metric?.p90Seconds ?? (spec.sourceKey === "metric_freshness" ? metric?.value ?? null : null),
      max: metric?.maxSeconds ?? null,
    };
    if (spec.sourceKey === "review_duration") {
      statistics.openCount = Number(metric?.openCount || 0);
      statistics.openAgeP50Seconds = metric?.openAgeP50Seconds ?? null;
    }
    if (spec.sourceKey === "collection_volume") statistics.distinctResolvedAssets = Number(metric?.distinctResolvedAssets || 0);
    return [property, {
      key: spec.sourceKey,
      label: OPERATIONS_METRIC_DEFINITIONS[spec.sourceKey].label,
      grain: spec.grain,
      unit: spec.unit,
      formula: spec.formula,
      status: metric.status,
      value: metric.value,
      reasonCode: metric.status === "available" ? null : metric.reasonCode,
      numerator: Number.isFinite(metric.numerator) ? metric.numerator : null,
      denominator,
      coverage: {
        eligibleCount: Math.max(0, Math.trunc(eligibleCount)),
        includedCount: Math.max(0, Math.trunc(includedCount)),
        excludedCount: Math.max(0, Math.trunc(excludedCount)),
        coverageRatio: eligibleCount > 0 ? round(includedCount / eligibleCount, 6) : null,
        statusCounts: canonicalStatusCounts(metric, includedCount, excludedCount),
      },
      statistics,
      asOf: asOfIso,
    }];
  }));
}

function canonicalFunnelStage(stage, previousCount = null) {
  return {
    key: stage.key,
    label: stage.key,
    status: "available",
    count: stage.count,
    reasonCode: null,
    conversionFromPrevious: previousCount && Number.isFinite(stage.count) ? round(stage.count / previousCount, 6) : null,
  };
}

function canonicalFunnelRail({ key, label, grain, legacy, cohort }) {
  const stages = [];
  let previous = null;
  for (const stage of legacy.stages) {
    stages.push(canonicalFunnelStage(stage, previous));
    previous = stage.count;
  }
  for (const [outcome, count] of Object.entries(legacy.outcomes || {})) {
    stages.push(canonicalFunnelStage({ key: `outcome_${outcome}`, count }, null));
  }
  return { key, label, grain, cohort, stages };
}

/**
 * 生成可复现的运营日报/复盘底稿。所有输入都必须由调用方显式提供；不会主动读平台或账号。
 */
export function buildOperationsReport(db, options = {}) {
  const dataMode = options.dataMode === "synthetic" ? "synthetic" : "observed";
  const timezone = options.timezone || "Asia/Shanghai";
  if (timezone !== "Asia/Shanghai") throw new Error("operations_report_timezone_must_be_Asia_Shanghai");
  const syntheticDatabases = dataMode === "synthetic" ? db.prepare("PRAGMA database_list").all() : [];
  if (dataMode === "synthetic" && (options.syntheticCore !== true
    || !tableExists(db, "ops_synthetic_fixture_marker")
    || syntheticDatabases.some((row) => String(row.file || "") !== ""))) {
    throw new Error("synthetic_core_requires_explicit_isolated_fixture_opt_in");
  }
  if (dataMode === "observed" && tableExists(db, "ops_synthetic_fixture_marker")) {
    throw new Error("synthetic_fixture_cannot_produce_observed_report");
  }
  const asOfIso = iso(options.asOf || new Date(), "report_as_of");
  const fromIso = iso(options.from, "report_from");
  const requestedTo = iso(options.to || asOfIso, "report_to");
  const toIso = Date.parse(requestedTo) > Date.parse(asOfIso) ? asOfIso : requestedTo;
  if (Date.parse(fromIso) > Date.parse(toIso)) throw new Error("report_period_invalid");
  const fromMs = Date.parse(fromIso);
  const toMs = Date.parse(toIso);
  const core = queryCoreRows(db, fromIso, toIso, asOfIso);
  const allObservations = latestMetricObservations(db, dataMode, asOfIso);
  const normalizedReceipts = rowsForMode(normalizePublishReceipts(options.publishReceipts || []), dataMode)
    .filter((row) => withinPeriod(row, fromMs, toMs, ["requestedAt"]));
  const receipts = latestPublishReceiptsAt(normalizedReceipts, toMs);
  const normalizedReviews = rowsForMode(normalizeCreativeReviews(options.creativeReviews || []), dataMode)
    .filter((row) => withinPeriod(row, fromMs, toMs, ["submittedAt"]));
  const reviews = latestReviewCyclesAt(normalizedReviews, toMs);
  const creativeJobs = rowsForMode(options.creativeJobs || [], dataMode)
    .filter((row) => withinPeriod(row, fromMs, toMs, ["createdAt", "updatedAt"]))
    .map((row) => {
      if (!TERMINAL_GENERATION.has(String(row.status))) return row;
      const terminalAt = millis(row.completedAt || row.updatedAt);
      return terminalAt === null || terminalAt > toMs ? { ...row, status: "running", terminalAfterCutoff: true } : row;
    });

  const terminalIngest = core.importItems.filter((row) => TERMINAL_INGEST.has(String(row.status)));
  const resolvedIngest = terminalIngest.filter((row) => RESOLVED_INGEST.has(String(row.status)));
  const cohortAssetIds = new Set(resolvedIngest.map((row) => row.asset_id).filter(Boolean));
  const analyzedAssetIds = new Set(core.analyses.map((row) => row.asset_id));
  const allAssetIds = new Set(core.assets.map((row) => row.id));
  const backlogAssetIds = new Set([...allAssetIds].filter((assetId) => !analyzedAssetIds.has(assetId)));

  const terminalGenerationJobs = creativeJobs.filter((row) => TERMINAL_GENERATION.has(String(row.status)));
  const successfulGenerationJobs = terminalGenerationJobs.filter((row) => row.status === "completed");
  const completedGenerations = core.generations.filter((row) => row.status === "completed"
    && millis(row.completed_at) !== null && millis(row.completed_at) <= Date.parse(asOfIso));
  const cohortGenerationAssetIds = new Set(completedGenerations.filter((row) => cohortAssetIds.has(row.asset_id)).map((row) => row.asset_id));

  const decisions = reviews.filter((row) => REVIEW_DECISIONS.has(String(row.status)));
  const revisions = decisions.filter((row) => row.status === "needs_revision");
  const decisionSubjects = new Set(decisions.map((row) => row.generationId || row.id).filter(Boolean));
  const revisionSubjects = new Set(revisions.map((row) => row.generationId || row.id).filter(Boolean));
  const reviewDurations = [];
  let invalidReviewDurations = 0;
  for (const row of decisions) {
    const start = millis(row.submittedAt);
    const end = millis(row.decisionAt);
    if (start === null || end === null) continue;
    if (end < start) { invalidReviewDurations += 1; continue; }
    reviewDurations.push((end - start) / 1_000);
  }
  const openReviews = reviews.filter((row) => row.status === "pending_review");
  const openReviewAges = openReviews.map((row) => millis(row.submittedAt))
    .filter((value) => value !== null && value <= toMs)
    .map((value) => (toMs - value) / 1_000);

  const eligibleReceipts = receipts.filter((row) => ELIGIBLE_RECEIPT_STATES.has(row.state));
  const visibilityReceipts = receipts.filter((row) => FINAL_VISIBILITY_STATES.has(row.state));
  const publicReceipts = visibilityReceipts.filter((row) => row.state === "public");
  const draftReceipts = eligibleReceipts.filter((row) => row.state === "draft");
  const receiptLatencies = [];
  let invalidReceiptLatencies = 0;
  for (const row of receipts) {
    const requested = millis(row.requestedAt);
    const received = millis(row.receiptAt);
    if (requested === null || received === null) continue;
    if (received < requested) { invalidReceiptLatencies += 1; continue; }
    receiptLatencies.push((received - requested) / 1_000);
  }

  // 既有 platform_post 也会保存采集来的来源帖；只有显式 published lineage 才是发布产物。
  const reportLineages = rowsForMode(core.lineages, dataMode).filter((row) => (row.post_role || "published") === "published");
  const publishedPostIds = new Set(reportLineages.map((row) => row.platform_post_id));
  const reportPosts = core.posts.filter((row) => publishedPostIds.has(row.id));
  const observations = allObservations.filter((row) => publishedPostIds.has(row.platform_post_id));
  const platformStatusCounts = Object.fromEntries(VALUE_STATUSES.map((status) => [status, 0]));
  let availableZeroCount = 0;
  const observationVariants = new Map();
  for (const row of observations) {
    platformStatusCounts[row.value_status] = (platformStatusCounts[row.value_status] || 0) + 1;
    if (row.value_status === "available" && Number(row.value) === 0) availableZeroCount += 1;
    const key = `${row.platform_post_id}\0${row.snapshot_horizon}\0${row.metric_name}`;
    const variants = observationVariants.get(key) || new Set();
    variants.add(stableComparable({ status: row.value_status, value: row.value, reason: row.reason_code }));
    observationVariants.set(key, variants);
  }
  const multiSourceConflictCount = [...observationVariants.values()].filter((variants) => variants.size > 1).length;

  const metrics = {
    collection_volume: availableMetric(core.importItems.length, "intake_items", {
      distinctResolvedAssets: cohortAssetIds.size,
      source: "import_item JOIN import_batch",
    }),
    ingestion_success_rate: rateMetric(resolvedIngest.length, terminalIngest.length, {
      reasonCode: "no_terminal_ingest_attempts",
      pendingExcluded: core.importItems.length - terminalIngest.length,
      successStatuses: [...RESOLVED_INGEST],
    }),
    analysis_backlog: availableMetric(backlogAssetIds.size, "assets", {
      totalAssets: allAssetIds.size,
      analyzedAssets: analyzedAssetIds.size,
      scope: "knowledge_base_as_of",
    }),
    generation_success_rate: terminalGenerationJobs.length
      ? rateMetric(successfulGenerationJobs.length, terminalGenerationJobs.length, { queuedExcluded: creativeJobs.length - terminalGenerationJobs.length })
      : absentMetric("not_collected", "ratio", "generation_attempt_ledger_not_provided", {
          completedArtifactsObserved: completedGenerations.length,
          note: "remake_generation 仅能证明成片产物，不能单独构造尝试成功率",
        }),
    rework_rate: rateMetric(revisionSubjects.size, decisionSubjects.size, {
      reasonCode: "no_explicit_review_decisions",
      definition: "distinct generated videos with explicit needs_revision / distinct generated videos with explicit review decisions",
    }),
    review_duration: reviewDurations.length
      ? availableMetric(round(percentile(reviewDurations, 0.5), 3), "seconds_p50", {
          p90Seconds: round(percentile(reviewDurations, 0.9), 3),
          sampleSize: reviewDurations.length,
          openCount: openReviews.length,
          openAgeP50Seconds: percentile(openReviewAges, 0.5),
          invalidExcluded: invalidReviewDurations,
        })
      : absentMetric("not_collected", "seconds_p50", "no_completed_reviews", {
          sampleSize: 0,
          openCount: openReviews.length,
          openAgeP50Seconds: percentile(openReviewAges, 0.5),
          invalidExcluded: invalidReviewDurations,
        }),
    draft_rate: rateMetric(draftReceipts.length, eligibleReceipts.length, {
      reasonCode: "no_eligible_destination_receipts",
      unitOfAnalysis: "platform_destination_receipt",
    }),
    public_rate: rateMetric(publicReceipts.length, eligibleReceipts.length, {
      reasonCode: "no_eligible_destination_receipts",
      unitOfAnalysis: "platform_destination_receipt",
      eligibleDestinationReceipts: eligibleReceipts.length,
      eligibleAcceptedReceipts: eligibleReceipts.length,
      visibilityCoverage: eligibleReceipts.length ? round(visibilityReceipts.length / eligibleReceipts.length, 6) : null,
      publicAmongFinalVisibility: visibilityReceipts.length ? round(publicReceipts.length / visibilityReceipts.length, 6) : null,
      submittedUnknownVisibility: receipts.filter((row) => row.state === "submitted").length,
      note: "confirmed public destinations / eligible destination outcomes；submitted/success 留在分母但从不计入分子",
    }),
    receipt_latency: receiptLatencies.length
      ? availableMetric(round(percentile(receiptLatencies, 0.5), 3), "seconds_p50", {
          p90Seconds: round(percentile(receiptLatencies, 0.9), 3),
          sampleSize: receiptLatencies.length,
          invalidExcluded: invalidReceiptLatencies,
        })
      : absentMetric("not_collected", "seconds_p50", "receipt_timestamps_not_collected", { sampleSize: 0, invalidExcluded: invalidReceiptLatencies }),
    metric_freshness: buildMetricFreshness(reportPosts, observations, asOfIso),
  };

  const cohortAnalyzed = new Set([...cohortAssetIds].filter((assetId) => analyzedAssetIds.has(assetId)));
  const collectedAssetIds = new Set(core.importItems.map((row) => row.asset_id).filter(Boolean));
  const funnelGeneratedAssetIds = new Set([...cohortGenerationAssetIds].filter((assetId) => cohortAnalyzed.has(assetId)));
  const reviewedGenerationIds = new Set(reviews.map((row) => row.generationId || row.id).filter(Boolean));
  const approvedGenerationIds = new Set(reviews.filter((row) => ["approved_for_drafts", "approved_for_publish"].includes(row.status))
    .map((row) => row.generationId || row.id).filter(Boolean));
  const cohortReceiptDestinations = receipts.filter((row) => row.assetId && cohortAssetIds.has(row.assetId));
  const cohortPostIds = new Set(reportPosts.filter((post) => cohortAssetIds.has(post.asset_id)).map((post) => post.id));
  const cohortPostedAssetIds = new Set(reportPosts.filter((post) => funnelGeneratedAssetIds.has(post.asset_id)).map((post) => post.asset_id));
  const feedbackPostIds = new Set(observations.filter((row) => cohortPostIds.has(row.platform_post_id)).map((row) => row.platform_post_id));

  const snapshotCoverage = buildSnapshotCoverage({
    posts: reportPosts,
    observations,
    asOfIso,
  });
  const hasReviewData = core.importItems.length + receipts.length + observations.length > 0;
  const reviewFramework = buildReviewFramework({
    anchorAt: options.anchorAt || fromIso,
    asOf: asOfIso,
    timezone,
    hasData: hasReviewData,
  });

  const report = {
    schemaVersion: OPERATIONS_CONTRACT_VERSION,
    contract: "zhitai.operations_metrics",
    contractVersion: OPERATIONS_CONTRACT_VERSION,
    reportId: `operations:${dataMode}:${fromIso.replace(/[^0-9]/g, "")}:${toIso.replace(/[^0-9]/g, "")}`,
    reportRevision: positiveInteger(options.reportRevision ?? 1, "report_revision"),
    reportType: dataMode === "synthetic" ? "acceptance" : "review",
    dataMode,
    synthetic: dataMode === "synthetic",
    syntheticNotice: dataMode === "synthetic" ? "本报告使用合成数据，仅用于验收，不代表真实运营结果。" : null,
    generatedAt: asOfIso,
    asOf: asOfIso,
    timezone,
    reviewAnchorAt: iso(options.anchorAt || fromIso, "review_anchor_at"),
    period: { startAt: fromIso, endAt: toIso, cohortAnchor: "event_occurred_at" },
    policy: {
      zeroIsAvailable: true,
      submittedIsPublic: false,
      causalClaimsAllowedByDefault: false,
      futureDataExcluded: true,
    },
    metrics,
    feedbackFunnel: {
      content: {
        unit: "distinct_material",
        cohort: "materials carrying a stable asset_id in intake attempts during [from,to)",
        stages: [
          { key: "collected", count: collectedAssetIds.size },
          { key: "ingested", count: cohortAssetIds.size },
          { key: "analyzed", count: cohortAnalyzed.size },
          { key: "has_generation", count: funnelGeneratedAssetIds.size },
          { key: "has_any_post", count: cohortPostedAssetIds.size },
        ],
      },
      generationAttempts: {
        unit: "generation_attempt",
        cohort: "generation jobs created during [from,to)",
        stages: [
          { key: "started", count: creativeJobs.length },
          { key: "terminal", count: terminalGenerationJobs.length },
          { key: "completed", count: successfulGenerationJobs.length },
        ],
      },
      review: {
        unit: "review_cycle",
        stages: [
          { key: "submitted_for_review", count: reviewedGenerationIds.size },
          { key: "decided", count: decisionSubjects.size },
        ],
        outcomes: { approved: approvedGenerationIds.size, needsRevision: revisionSubjects.size },
      },
      distribution: {
        unit: "platform_destination",
        note: "一条成片可分叉到多个平台；不与素材阶段直接计算转换率",
        stages: [
          { key: "due", count: cohortReceiptDestinations.length },
          { key: "acknowledged", count: cohortReceiptDestinations.filter((row) => row.receiptAt).length },
        ],
        outcomes: {
          platformDraft: cohortReceiptDestinations.filter((row) => row.state === "draft").length,
          publicConfirmed: cohortReceiptDestinations.filter((row) => row.state === "public").length,
          failed: cohortReceiptDestinations.filter((row) => row.state === "failed").length,
          needsAttention: cohortReceiptDestinations.filter((row) => row.state === "needs_attention").length,
          unknown: cohortReceiptDestinations.filter((row) => row.state === "unknown").length,
        },
        publishedPosts: cohortPostIds.size,
        postsWithMetricObservation: feedbackPostIds.size,
      },
    },
    snapshotCoverage,
    platformMetricStates: { ...platformStatusCounts, availableZero: availableZeroCount },
    dailyOperations: {
      state: options.dailyCreativeState && typeof options.dailyCreativeState === "object"
        && (millis(options.dailyCreativeState.lastAttemptAt) === null || millis(options.dailyCreativeState.lastAttemptAt) <= toMs)
        ? { ...options.dailyCreativeState }
        : null,
      pendingReviews: reviews.filter((row) => row.status === "pending_review").length,
      needsRevision: revisions.length,
      approvedReviews: decisions.filter((row) => ["approved_for_drafts", "approved_for_publish"].includes(row.status)).length,
    },
    experiments: Array.isArray(options.experiments) ? options.experiments.map((card) => structuredClone(card)) : [],
    reviewFramework,
    limitations: [
      "平台 submitted/success 仅表示任务被接收，未取得 public/published 回执前不计入公开率。",
      "缺失状态不会被折算为 0；permission_denied、not_collected 与 unavailable 分别统计。",
      "基础知识库尚无显式 analysis eligibility/豁免字段，分析积压以当前全部素材为可分析代理口径，并在接入后替换。",
      ...(multiSourceConflictCount > 0
        ? [`有 ${multiSourceConflictCount} 个帖子/时点/指标存在多来源差异；报告保留各来源证据，未静默选较大值或覆盖。`] : []),
      "除非实验满足预先声明的随机化与统计条件，指标同时变化只能描述为相关或伴随变化。",
      dataMode === "synthetic" ? "本报告使用合成数据，仅验证合同、计算和展示，不代表真实运营结果。" : "本报告只汇总已提供的本地证据，不主动连接平台。",
    ],
  };
  report.kpis = canonicalKpis(report.metrics, asOfIso);
  const funnelCohort = { anchor: "event_occurred_at", startAt: fromIso, endAt: toIso, asOf: asOfIso };
  report.funnels = {
    content: canonicalFunnelRail({ key: "content", label: "素材处理", grain: "material", legacy: report.feedbackFunnel.content, cohort: funnelCohort }),
    generationAttempts: canonicalFunnelRail({ key: "generation_attempts", label: "生成尝试", grain: "generation_attempt", legacy: report.feedbackFunnel.generationAttempts, cohort: funnelCohort }),
    creativeReviews: canonicalFunnelRail({ key: "creative_reviews", label: "创作审核", grain: "review_cycle", legacy: report.feedbackFunnel.review, cohort: funnelCohort }),
    platformPosts: canonicalFunnelRail({ key: "platform_posts", label: "平台目的地", grain: "platform_destination", legacy: report.feedbackFunnel.distribution, cohort: funnelCohort }),
  };
  const canonicalReview = (checkpoint) => {
    const cutoffIso = checkpoint.dataCutoff;
    const cutoffMs = Date.parse(cutoffIso);
    const checkpointPostIds = new Set(reportLineages
      .filter((row) => millis(row.linked_at) !== null && millis(row.linked_at) <= cutoffMs)
      .map((row) => row.platform_post_id));
    const checkpointPosts = core.posts.filter((row) => checkpointPostIds.has(row.id)
      && millis(row.publish_time) !== null && millis(row.publish_time) <= cutoffMs);
    const checkpointObservations = latestMetricObservations(db, dataMode, cutoffIso)
      .filter((row) => checkpointPostIds.has(row.platform_post_id));
    const checkpointCoverage = buildSnapshotCoverage({ posts: checkpointPosts, observations: checkpointObservations, asOfIso: cutoffIso });
    const eligible = Object.values(checkpointCoverage).reduce((sum, row) => sum + row.duePosts, 0);
    const included = Object.values(checkpointCoverage).reduce((sum, row) => sum + row.recordedPosts, 0);
    const statusCounts = { available: 0, unavailable: 0, notCollected: 0, permissionDenied: 0 };
    for (const row of checkpointObservations) {
      const key = row.value_status === "not_collected"
        ? "notCollected"
        : row.value_status === "permission_denied" ? "permissionDenied" : row.value_status;
      statusCounts[key] += 1;
    }
    return {
      horizonDays: checkpoint.day,
      status: checkpoint.status,
      dueAt: checkpoint.dueAt,
      dataCutoffAt: cutoffIso,
      generatedAt: checkpoint.status === "not_due" ? null : asOfIso,
      revision: report.reportRevision,
      dataMode,
      isSynthetic: dataMode === "synthetic",
      sampleSize: core.importItems.filter((row) => millis(row.created_at) !== null && millis(row.created_at) < cutoffMs).length,
      coverage: {
        eligibleCount: eligible,
        includedCount: included,
        excludedCount: Math.max(0, eligible - included),
        coverageRatio: eligible ? round(included / eligible, 6) : null,
        statusCounts,
      },
      snapshotOffsets: checkpoint.horizons,
      kpiKeys: Object.keys(OPERATIONS_METRIC_DEFINITIONS),
      summary: checkpoint.status === "ready" ? "按固定截止时点生成；只描述已记录的相关或伴随变化。" : "当前检查点尚未就绪。",
      limitations: ["不将相关性写成因果性；缺失状态不折算为 0。"],
      decisions: [],
    };
  };
  report.reviews = Object.fromEntries(report.reviewFramework.map((checkpoint) => [`day${checkpoint.day}`, canonicalReview(checkpoint)]));
  const firstIngestedAtByAsset = new Map();
  for (const row of core.importItems) {
    if (!row.asset_id || !row.created_at) continue;
    const current = firstIngestedAtByAsset.get(row.asset_id);
    if (!current || Date.parse(row.created_at) < Date.parse(current)) firstIngestedAtByAsset.set(row.asset_id, row.created_at);
  }
  report.lineage = {
    materials: core.assets.map((row) => ({
      id: row.id,
      firstIngestedAt: firstIngestedAtByAsset.get(row.id) || row.created_at || fromIso,
      analysisEligible: true,
      source: dataMode === "synthetic" ? "synthetic_acceptance" : "knowledge_base",
      isSynthetic: dataMode === "synthetic",
    })),
    generatedVideos: core.generations.map((row) => ({
      id: row.id,
      materialIds: [row.asset_id],
      generationAttemptId: row.engine_task_id || row.id,
      status: new Set(["queued", "running", "completed", "failed", "timed_out", "invalid_output", "canceled"]).has(row.status)
        ? row.status
        : "running",
      engine: row.engine || "unknown",
      createdAt: row.created_at || fromIso,
      completedAt: row.completed_at || null,
      isSynthetic: dataMode === "synthetic",
    })),
    platformPosts: reportPosts.map((post) => {
      const lineage = reportLineages.find((row) => row.platform_post_id === post.id);
      const receipt = receipts.find((row) => row.receiptId && row.receiptId === lineage?.publish_receipt_id)
        || receipts.find((row) => row.assetId === post.asset_id && row.platform === post.platform);
      const canonicalState = {
        draft: "platform_draft",
        submitted: "submitted",
        public: "public_confirmed",
        failed: "failed",
        needs_attention: "needs_attention",
      }[receipt?.state] || "needs_attention";
      const requestedMode = ["workbench_draft", "platform_draft", "publish"].includes(receipt?.mode) ? receipt.mode : null;
      return {
        id: `platform-post:${post.id}`,
        materialId: post.asset_id,
        sourceRef: lineage?.generation_id
          ? { kind: "generated_video", id: lineage.generation_id }
          : { kind: "material", id: post.asset_id },
        role: "published",
        platform: post.platform,
        requestedMode,
        state: canonicalState,
        publisherReceiptId: lineage?.publish_receipt_id || receipt?.receiptId || null,
        publishedAt: post.publish_time || null,
        externalPostId: post.post_id || receipt?.postId || null,
        externalUrl: safeExternalUrl(post.url) || receipt?.resultUrl || null,
        isSynthetic: lineage?.is_synthetic === 1,
      };
    }),
  };
  const snapshotsByObservation = new Map();
  for (const row of observations) {
    const key = `${row.platform_post_id}\0${row.snapshot_horizon}\0${row.source}\0${row.observation_id}\0${row.revision}`;
    let snapshot = snapshotsByObservation.get(key);
    if (!snapshot) {
      const safeObservationId = String(row.observation_id).replace(/[^A-Za-z0-9_.:-]/g, "_");
      snapshot = {
        id: `snapshot:${row.platform_post_id}:${row.snapshot_horizon}:${safeObservationId}:r${row.revision}`,
        platformPostId: `platform-post:${row.platform_post_id}`,
        platform: row.platform,
        snapshotKind: "scheduled",
        snapshotOffset: row.snapshot_horizon,
        revision: row.revision,
        observationId: row.observation_id,
        targetAt: row.target_at,
        sourceEventAt: row.source_event_at,
        observedAt: row.observed_at,
        ingestedAt: row.ingested_at,
        source: row.source,
        isSynthetic: row.is_synthetic === 1,
        values: {},
      };
      snapshotsByObservation.set(key, snapshot);
    }
    snapshot.values[row.metric_name] = {
      status: row.value_status,
      value: row.value,
      reasonCode: row.reason_code,
      rawValue: row.raw_value,
      approximate: false,
    };
  }
  const scheduledSnapshotIds = new Set(observations.map((row) => row.metric_snapshot_id).filter(Boolean));
  for (const legacy of rowsForMode(core.snapshots, dataMode)) {
    if (scheduledSnapshotIds.has(legacy.id)) continue;
    const matchingPosts = reportPosts.filter((post) => post.asset_id === legacy.asset_id
      && String(post.content_id || "") === String(legacy.content_id || ""));
    if (matchingPosts.length !== 1) continue;
    const post = matchingPosts[0];
    const values = {};
    for (const metricName of PLATFORM_METRIC_NAMES) {
      const value = legacy[metricName];
      values[metricName] = value === null || value === undefined
        ? { status: "unavailable", value: null, reasonCode: "legacy_unknown", rawValue: legacy[`${metricName}_raw`] ?? null, approximate: false }
        : { status: "available", value: Number(value), reasonCode: null, rawValue: legacy[`${metricName}_raw`] ?? null, approximate: false };
    }
    const safeObservationId = String(legacy.observation_id || `legacy-${legacy.id}`).replace(/[^A-Za-z0-9_.:-]/g, "_");
    snapshotsByObservation.set(`legacy\0${legacy.id}`, {
      id: `snapshot:legacy:${legacy.id}`,
      platformPostId: `platform-post:${post.id}`,
      platform: post.platform,
      snapshotKind: "ad_hoc",
      snapshotOffset: null,
      revision: 1,
      observationId: safeObservationId,
      targetAt: null,
      sourceEventAt: null,
      observedAt: legacy.captured_at,
      ingestedAt: legacy.captured_at,
      source: legacy.source || "legacy_metric_snapshot",
      isSynthetic: isSyntheticRow(legacy),
      values,
    });
  }
  report.snapshots = [...snapshotsByObservation.values()];
  const latestTimestamp = (values) => {
    const valid = values.map(millis).filter((value) => value !== null && value <= Date.parse(asOfIso));
    return valid.length ? new Date(Math.max(...valid)).toISOString() : null;
  };
  const knowledgeBaseRecordCount = core.assets.length + core.importItems.length + core.analyses.length + core.generations.length + reportPosts.length;
  const adapterRecordCount = receipts.length + reviews.length + creativeJobs.length;
  report.provenance = [
    {
      name: "knowledge_base",
      version: null,
      recordCount: knowledgeBaseRecordCount,
      latestObservedAt: latestTimestamp([
        ...core.importItems.map((row) => row.created_at),
        ...core.assets.map((row) => row.created_at),
        ...core.analyses.map((row) => row.analyzed_at),
        ...core.generations.flatMap((row) => [row.created_at, row.completed_at]),
        ...reportPosts.flatMap((row) => [row.publish_time, row.fetched_at]),
        ...observations.flatMap((row) => [row.source_event_at, row.observed_at, row.ingested_at]),
      ]),
      notes: "只读复用 video_asset/import_item/content_analysis/remake_generation/platform_post/metric_snapshot。",
    },
    {
      name: "operations_adapters",
      version: OPERATIONS_CONTRACT_VERSION,
      recordCount: adapterRecordCount,
      latestObservedAt: latestTimestamp([
        ...receipts.flatMap((row) => [row.requestedAt, row.receiptAt]),
        ...reviews.flatMap((row) => [row.submittedAt, row.decisionAt]),
        ...creativeJobs.flatMap((row) => [row.createdAt, row.updatedAt, row.completedAt]),
      ]),
      notes: "调用方显式提供 publisher_receipt/creative_review/creative_job/daily_operations；未连接平台。",
    },
  ];
  return report;
}

function metricDisplay(metric) {
  if (!metric || metric.status !== "available") return `${metric?.status || "unavailable"} (${metric?.reasonCode || "unspecified"})`;
  if (metric.unit === "ratio") return `${round(metric.value * 100, 2)}% (${metric.numerator}/${metric.denominator})`;
  return `${metric.value} ${metric.unit}`;
}

export function renderOperationsReportMarkdown(report) {
  if (!report || report.schemaVersion !== OPERATIONS_CONTRACT_VERSION || report.contract !== "zhitai.operations_metrics") {
    throw new Error("operations_report_invalid");
  }
  const lines = ["# 织台运营指标与复盘报告", ""];
  if (report.synthetic) {
    lines.push("> **合成数据验收样例**：仅用于验证数据合同、计算与展示，不代表真实运营结果，也未执行真实平台发布。", "");
  } else {
    lines.push("> 本报告只汇总本地已提供证据；未登录平台、未修改账号、未执行发布。", "");
  }
  lines.push(
    `- 合同版本：${report.contractVersion}`,
    `- 数据模式：${report.dataMode}`,
    `- 窗口：${report.period.startAt} — ${report.period.endAt}`,
    `- as_of：${report.asOf}（${report.timezone}）`,
    "",
    "## 十项运营指标",
    "",
    "| 指标 | 结果 | 状态 |",
    "| --- | --- | --- |",
  );
  for (const [key, definition] of Object.entries(OPERATIONS_METRIC_DEFINITIONS)) {
    const metric = report.metrics[key];
    lines.push(`| ${definition.label} | ${metricDisplay(metric)} | ${metric?.status || "unavailable"} |`);
  }
  lines.push("", "## 反馈漏斗", "");
  for (const [rail, funnel] of Object.entries(report.feedbackFunnel)) {
    lines.push(`### ${rail}（${funnel.unit}）`, "");
    for (const stage of funnel.stages) lines.push(`- ${stage.key}: ${stage.count}`);
    if (funnel.outcomes) {
      for (const [key, count] of Object.entries(funnel.outcomes)) lines.push(`- outcome.${key}: ${count}`);
    }
    if (Number.isFinite(funnel.publishedPosts)) lines.push(`- publishedPosts: ${funnel.publishedPosts}`);
    if (Number.isFinite(funnel.postsWithMetricObservation)) lines.push(`- postsWithMetricObservation: ${funnel.postsWithMetricObservation}`);
    if (funnel.note) lines.push(`- 口径：${funnel.note}`);
    lines.push("");
  }
  lines.push("## 1h / 24h / 7d / 30d 快照覆盖", "", "| 时点 | 应到帖子 | 已记录 | 有可用值 | 未记录 |", "| --- | ---: | ---: | ---: | ---: |");
  for (const [horizon, coverage] of Object.entries(report.snapshotCoverage)) {
    lines.push(`| ${SNAPSHOT_HORIZONS[horizon]?.label || horizon} | ${coverage.duePosts} | ${coverage.recordedPosts} | ${coverage.availablePosts} | ${coverage.missingPosts} |`);
  }
  lines.push("", "## 7 / 14 / 30 天复盘", "");
  for (const checkpoint of report.reviewFramework) {
    lines.push(`- D${checkpoint.day} · ${checkpoint.status} · 截止 ${checkpoint.dataCutoff} · ${checkpoint.focus.join("、")}`);
  }
  if (report.experiments.length) {
    lines.push("", "## 单变量实验卡", "");
    for (const card of report.experiments) {
      const horizon = card.successMetric.observationOffset;
      const horizonLabel = SNAPSHOT_HORIZONS[horizon]?.label || horizon;
      const plannedSampleSize = Number(card.sampleSizePlan.control) + Number(card.sampleSizePlan.variant);
      lines.push(`- ${card.id}: ${card.primaryFactor}；计划样本 ${plannedSampleSize} ${card.analysisUnit}；主指标 ${card.successMetric.key}@${horizonLabel}`);
    }
  }
  lines.push("", "## 限制与下一步", "");
  for (const limitation of report.limitations) lines.push(`- ${limitation}`);
  lines.push("", "报告中的同时变化只表示相关或伴随关系；不得据此改写为因果结论。", "");
  return lines.join("\n");
}
