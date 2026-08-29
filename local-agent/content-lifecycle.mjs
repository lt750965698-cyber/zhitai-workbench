/**
 * Unified content lifecycle contract for Zhitai.
 *
 * This module is deliberately a projection/validator over the existing
 * SQLite rows, JSON queues, package metadata and platform receipts. It does
 * not persist a second lifecycle record and it never advances a job.
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";

export const CONTENT_LIFECYCLE_VERSION = 1;

export const CONTENT_LIFECYCLE_STAGES = Object.freeze([
  "capture",
  "download",
  "ingest",
  "analyze",
  "generate",
  "quality",
  "human_review",
  "draft",
  "schedule",
  "public_readback",
  "metrics_snapshot",
  "archive",
]);

export const LIFECYCLE_STATE_MACHINES = Object.freeze({
  ingest_task: Object.freeze({
    states: Object.freeze([
      "needs_setup", "awaiting_primary_download", "awaiting_fallback_media",
      "queued", "running", "completed", "failed", "needs_attention", "cancelled",
    ]),
    transitions: Object.freeze({
      needs_setup: ["queued", "needs_attention", "cancelled"],
      awaiting_primary_download: ["awaiting_fallback_media", "completed", "failed", "needs_attention", "cancelled"],
      awaiting_fallback_media: ["completed", "failed", "needs_attention", "cancelled"],
      queued: ["running", "failed", "needs_attention", "cancelled"],
      running: ["completed", "failed", "needs_attention"],
      failed: ["queued"],
      needs_attention: ["queued", "cancelled"],
      completed: [],
      cancelled: [],
    }),
  }),
  import_item: Object.freeze({
    states: Object.freeze(["pending", "processing", "success", "linked", "duplicate", "partial", "failed", "orphaned"]),
    transitions: Object.freeze({
      pending: ["processing", "failed", "partial"],
      processing: ["pending", "success", "linked", "duplicate", "partial", "failed", "orphaned"],
      partial: ["processing"],
      failed: ["processing"],
      orphaned: ["processing"],
      success: ["orphaned"],
      linked: ["orphaned"],
      duplicate: ["orphaned"],
    }),
  }),
  creative_job: Object.freeze({
    states: Object.freeze([
      "queued", "preparing", "retry_wait", "transient_wait", "paused",
      "ready_for_images", "ready_for_seedance", "ready_for_assembly",
      "completed", "failed", "needs_attention", "cancelled",
    ]),
    transitions: Object.freeze({
      queued: ["preparing", "paused", "transient_wait", "needs_attention", "cancelled"],
      preparing: ["queued", "retry_wait", "transient_wait", "ready_for_images", "paused", "failed", "needs_attention", "cancelled"],
      retry_wait: ["queued", "paused", "transient_wait", "needs_attention", "cancelled"],
      transient_wait: ["queued", "ready_for_images", "ready_for_seedance", "ready_for_assembly", "completed", "paused", "needs_attention", "cancelled"],
      paused: ["queued", "ready_for_images", "ready_for_seedance", "ready_for_assembly", "needs_attention", "cancelled"],
      ready_for_images: ["queued", "ready_for_seedance", "transient_wait", "needs_attention", "cancelled"],
      ready_for_seedance: ["queued", "ready_for_assembly", "transient_wait", "needs_attention", "cancelled"],
      ready_for_assembly: ["queued", "completed", "transient_wait", "needs_attention", "cancelled"],
      failed: ["queued", "ready_for_images", "ready_for_seedance", "ready_for_assembly", "transient_wait", "needs_attention", "cancelled"],
      needs_attention: ["queued", "ready_for_images", "ready_for_seedance", "ready_for_assembly", "transient_wait", "cancelled"],
      completed: [],
      cancelled: [],
    }),
  }),
  analysis_part: Object.freeze({
    states: Object.freeze(["unavailable", "metadata_only", "partial", "available"]),
    transitions: Object.freeze({
      unavailable: ["metadata_only", "partial", "available"],
      metadata_only: ["partial", "available", "unavailable"],
      partial: ["available", "unavailable"],
      available: [],
    }),
  }),
  quality: Object.freeze({
    states: Object.freeze(["blocked", "unknown", "review", "standard", "high"]),
    transitions: Object.freeze({
      blocked: ["unknown", "review", "standard", "high"],
      unknown: ["blocked", "review", "standard", "high"],
      review: ["blocked", "unknown", "standard", "high"],
      standard: ["blocked", "unknown", "review", "high"],
      high: ["blocked", "unknown", "review", "standard"],
    }),
  }),
  human_review: Object.freeze({
    states: Object.freeze(["pending_review", "needs_revision", "approved_for_drafts", "approved_for_public", "approved_for_publish", "rejected"]),
    transitions: Object.freeze({
      pending_review: ["needs_revision", "approved_for_drafts", "approved_for_public", "approved_for_publish", "rejected"],
      needs_revision: ["pending_review", "rejected"],
      approved_for_drafts: [],
      approved_for_public: [],
      approved_for_publish: [],
      rejected: [],
    }),
  }),
  publish_task: Object.freeze({
    states: Object.freeze([
      "draft", "needs_setup", "scheduled", "queued", "retry_wait", "preflighting", "running", "submitting",
      "submitted", "submitted_unverified", "platform_draft", "public", "failed",
      "needs_attention", "needs_reconciliation", "cancelled",
    ]),
    transitions: Object.freeze({
      draft: ["scheduled", "queued", "cancelled"],
      needs_setup: ["queued", "needs_attention", "cancelled"],
      scheduled: ["queued", "needs_attention", "cancelled"],
      queued: ["retry_wait", "preflighting", "running", "failed", "needs_attention", "cancelled"],
      retry_wait: ["queued", "needs_attention", "cancelled"],
      preflighting: ["retry_wait", "submitting", "failed", "needs_attention", "cancelled"],
      running: ["submitting", "submitted_unverified", "platform_draft", "public", "failed", "needs_attention", "needs_reconciliation"],
      submitting: ["submitted_unverified", "platform_draft", "public", "failed", "needs_attention", "needs_reconciliation"],
      submitted: ["submitted_unverified", "platform_draft", "public", "needs_attention", "needs_reconciliation"],
      submitted_unverified: ["platform_draft", "public", "needs_attention", "needs_reconciliation"],
      failed: ["queued", "cancelled"],
      needs_attention: ["queued", "cancelled"],
      needs_reconciliation: ["platform_draft", "public", "failed", "needs_attention"],
      platform_draft: [],
      public: [],
      cancelled: [],
    }),
  }),
  platform_receipt: Object.freeze({
    states: Object.freeze(["unknown", "submitted", "scheduled", "draft", "public", "failed", "needs_reconciliation"]),
    transitions: Object.freeze({
      unknown: ["submitted", "scheduled", "draft", "public", "failed", "needs_reconciliation"],
      submitted: ["scheduled", "draft", "public", "failed", "needs_reconciliation"],
      scheduled: ["draft", "public", "failed", "needs_reconciliation"],
      needs_reconciliation: ["draft", "public", "failed"],
      draft: [],
      public: [],
      failed: [],
    }),
  }),
  archive: Object.freeze({
    states: Object.freeze(["eligible", "archived", "hold", "restore_requested", "restored"]),
    transitions: Object.freeze({
      eligible: ["archived", "hold"],
      archived: ["restore_requested"],
      hold: ["eligible"],
      restore_requested: ["restored", "hold"],
      restored: [],
    }),
  }),
});

const RETRY_EDGES = new Set([
  "ingest_task:failed:queued",
  "ingest_task:needs_attention:queued",
  "import_item:failed:processing",
  "import_item:partial:processing",
  "import_item:orphaned:processing",
  "creative_job:failed:queued",
  "creative_job:needs_attention:queued",
  "creative_job:needs_attention:ready_for_images",
  "creative_job:needs_attention:ready_for_seedance",
  "creative_job:needs_attention:ready_for_assembly",
  "publish_task:failed:queued",
  "publish_task:needs_attention:queued",
]);

const REPAIR_EDGES = new Set([
  "import_item:success:orphaned",
  "import_item:linked:orphaned",
  "import_item:duplicate:orphaned",
  "creative_job:ready_for_images:queued",
  "creative_job:ready_for_seedance:queued",
  "creative_job:ready_for_assembly:queued",
]);

// 历史 failed 任务可能已经停在网页生成断点：用户显式 resume 可以继续原
// 断点；启动对账也可以凭完整性修复恢复。两类依据任一成立即可，不能要求
// 调用方把人工重试伪装成完整性修复。
const RETRY_OR_REPAIR_EDGES = new Set([
  "creative_job:failed:ready_for_images",
  "creative_job:failed:ready_for_seedance",
  "creative_job:failed:ready_for_assembly",
]);

const RECOVERY_EDGES = new Map([
  ["import_item:processing:pending", "staleLeaseRecovery"],
  ["creative_job:preparing:queued", "interruptedRecovery"],
]);

/** Return a reasoned decision without mutating either record. */
export function lifecycleTransitionDecision(machineName, from, to, context = {}) {
  const machine = LIFECYCLE_STATE_MACHINES[machineName];
  if (!machine) return { allowed: false, code: "unknown_state_machine" };
  if (!machine.states.includes(from)) return { allowed: false, code: "unknown_from_state" };
  if (!machine.states.includes(to)) return { allowed: false, code: "unknown_to_state" };
  if (from === to) return { allowed: true, code: "idempotent_noop" };
  if (!(machine.transitions[from] || []).includes(to)) return { allowed: false, code: "illegal_transition" };

  const edge = `${machineName}:${from}:${to}`;
  if (RETRY_EDGES.has(edge) && context.explicitRetry !== true && context.transientRecovery !== true) {
    return { allowed: false, code: "explicit_retry_required" };
  }
  if (REPAIR_EDGES.has(edge) && context.integrityRepair !== true) {
    return { allowed: false, code: "integrity_repair_required" };
  }
  if (RETRY_OR_REPAIR_EDGES.has(edge)
    && context.explicitRetry !== true && context.integrityRepair !== true) {
    return { allowed: false, code: "explicit_retry_or_integrity_repair_required" };
  }
  const recoveryFlag = RECOVERY_EDGES.get(edge);
  if (recoveryFlag && context[recoveryFlag] !== true) {
    return { allowed: false, code: `${recoveryFlag.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}_required` };
  }
  if (machineName === "quality" && context.reassessment !== true) {
    return { allowed: false, code: "quality_reassessment_required" };
  }
  if (machineName === "human_review" && ["approved_for_drafts", "approved_for_public", "approved_for_publish"].includes(to)) {
    const review = context.reviewEvidence;
    if (!review || !review.reviewer || !validTime(review.reviewedAt) || !review.artifactSha256 || !review.policyVersion) {
      return { allowed: false, code: "persisted_review_evidence_required" };
    }
  }
  if (machineName === "archive" && to === "archived"
    && (context.manifestVerified !== true || context.restoreTested !== true)) {
    return { allowed: false, code: "archive_manifest_and_restore_test_required" };
  }
  if (machineName === "archive" && to === "restored" && context.restoreVerified !== true) {
    return { allowed: false, code: "archive_restore_verification_required" };
  }
  const manual = context.manualTakeover;
  const external = context.externalEvidence;
  const expectedResolution = to === "platform_draft" ? "draft" : to;
  const manualComplete = manual && typeof manual === "object" && manual.actor && manual.reason
    && validTime(manual.claimedAt) && validTime(manual.resolvedAt) && manual.resolution === expectedResolution;
  const externalComplete = external && typeof external === "object" && external.source && validTime(external.observedAt || external.readBackAt);
  if (from === "needs_reconciliation" && (!manualComplete || !externalComplete)) {
    return { allowed: false, code: "manual_reconciliation_evidence_required" };
  }
  if (to === "public" && !isPublicReadbackReceipt(external)) {
    return { allowed: false, code: "public_readback_required" };
  }
  if (RETRY_EDGES.has(edge) && context.externalSideEffectPossible === true) {
    return { allowed: false, code: "retry_forbidden_after_possible_side_effect" };
  }
  return { allowed: true, code: "allowed" };
}

export function assertLifecycleTransition(machineName, from, to, context = {}) {
  const decision = lifecycleTransitionDecision(machineName, from, to, context);
  if (!decision.allowed) {
    const error = new Error(`${decision.code}:${machineName}:${from}->${to}`);
    error.code = decision.code;
    throw error;
  }
  return decision;
}

/** Classify an adapter error by whether the external side-effect window opened. */
export function publishFailureDisposition({ externalCallStarted = false, errorCode = "unknown_error" } = {}) {
  const code = String(errorCode || "unknown_error");
  if (code === "adapter_exit_4") return "needs_attention";
  const knownNoProcess = new Set(["adapter_command_not_found", "unsupported_publisher_type", "asset_changed_since_approval"]);
  if (externalCallStarted && !knownNoProcess.has(code)) return "needs_reconciliation";
  return "failed";
}

const IDEMPOTENCY_REQUIREMENTS = Object.freeze({
  capture: [["sourceKey"], ["deliveryId"], ["sourceEventId"]],
  download: [["sourceKey", "channel"], ["deliveryId", "channel"]],
  ingest: [["mediaSha256"], ["sourceKey"]],
  analyze: [["assetId", "assetSha256", "profileVersion"]],
  generate: [["assetId", "planSha256", "engine", "engineVersion"]],
  quality: [["mediaSha256", "policyVersion"]],
  human_review: [["mediaSha256", "reviewPolicyVersion"]],
  draft: [["mediaSha256", "revision", "destinationsFingerprint"]],
  schedule: [["mediaSha256", "revision", "destinationsFingerprint", "scheduledAt"]],
  public_readback: [["platform", "accountFingerprint", "platformTaskId"], ["platform", "accountFingerprint", "postId"]],
  metrics_snapshot: [["platform", "contentId", "observationId"]],
  archive: [["assetId", "manifestSha256", "retentionClass"]],
});

const SENSITIVE_IDENTITY_KEY = /(?:cookie|password|secret|authorization|access.?token|refresh.?token|download.?url|decode.?key|encfilekey|signature|phone)$/i;

function hasSensitiveIdentityKey(value) {
  if (Array.isArray(value)) return value.some(hasSensitiveIdentityKey);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, child]) => SENSITIVE_IDENTITY_KEY.test(key) || hasSensitiveIdentityKey(child));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Build an opaque key; raw identity values never appear in its output. */
export function lifecycleIdempotencyKey(stage, identity) {
  if (!CONTENT_LIFECYCLE_STAGES.includes(stage)) throw new Error("unknown_lifecycle_stage");
  if (!identity || typeof identity !== "object" || Array.isArray(identity)) throw new Error("lifecycle_identity_required");
  if (hasSensitiveIdentityKey(identity)) throw new Error("sensitive_lifecycle_identity_forbidden");
  const alternatives = IDEMPOTENCY_REQUIREMENTS[stage];
  const matched = alternatives.some((fields) => fields.every((field) => identity[field] !== null && identity[field] !== undefined && identity[field] !== ""));
  if (!matched) throw new Error(`lifecycle_identity_incomplete:${stage}`);
  const digest = createHash("sha256")
    .update(canonicalJson({ version: CONTENT_LIFECYCLE_VERSION, stage, identity }))
    .digest("hex");
  return `lc:${stage}:v${CONTENT_LIFECYCLE_VERSION}:${digest}`;
}

export function lifecyclePayloadFingerprint(payload) {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function validTime(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

const TRUSTED_READBACK_SOURCES = new Set([
  "official_api", "platform_history", "platform_readback", "public_page", "manual_verified",
]);

function isPublicHostname(hostname) {
  const host = String(hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost")) return false;
  const ipKind = isIP(host);
  if (ipKind === 4) {
    const [a, b] = host.split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a >= 224);
  }
  if (ipKind === 6) {
    return !(host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd")
      || host.startsWith("fe8") || host.startsWith("fe9") || host.startsWith("fea") || host.startsWith("feb")
      || host.startsWith("::ffff:"));
  }
  return true;
}

export function canonicalPublicResultUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    if (!["http:", "https:"].includes(url.protocol) || !isPublicHostname(url.hostname) || url.username || url.password) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function isPublicReadbackReceipt(receipt) {
  if (!receipt || !["public", "published"].includes(String(receipt.state || receipt.status || "").toLowerCase())) return false;
  const hasIdentity = Boolean(String(receipt.postId || "").trim()) || Boolean(canonicalPublicResultUrl(receipt.resultUrl || receipt.publicUrl));
  const observedAt = receipt.readBackAt || receipt.observedAt;
  const source = String(receipt.source || "").toLowerCase();
  const hasLocalBinding = Boolean(receipt.taskId || receipt.attemptId)
    && Boolean(receipt.assetId || /^[a-f0-9]{64}$/i.test(String(receipt.mediaSha256 || "")));
  const accountIsPseudonymous = /^acct_[a-f0-9]{16,64}$/i.test(String(receipt.accountFingerprint || ""));
  const manualEvidenceComplete = source !== "manual_verified" || Boolean(receipt.actor && receipt.reason);
  return Boolean(receipt.platform && accountIsPseudonymous && hasIdentity && hasLocalBinding
    && validTime(observedAt) && TRUSTED_READBACK_SOURCES.has(source) && manualEvidenceComplete);
}

/** Aggregate per-target receipts conservatively. */
export function publicationOutcome({ intent = "public", receipts = [], targets = [], taskId = null, mediaSha256 = null } = {}) {
  const rows = Array.isArray(receipts) ? receipts : [];
  const states = rows.map((row) => String(row?.state || row?.status || "unknown").toLowerCase());
  if (!rows.length) return { status: "submitted_unverified", businessSuccess: false, complete: false };
  if (states.some((state) => ["unknown", "needs_reconciliation"].includes(state))) {
    return { status: "needs_reconciliation", businessSuccess: false, complete: false };
  }
  if (states.some((state) => state === "failed")) return { status: "needs_attention", businessSuccess: false, complete: false };
  if (intent === "public") {
    const receiptTargetKeys = rows.map((row) => `${String(row?.platform || "")}|${String(row?.accountFingerprint || "")}`);
    const uniqueTargets = new Set(receiptTargetKeys).size === receiptTargetKeys.length;
    const expectedTargets = Array.isArray(targets) ? targets : [];
    const targetsMatch = !expectedTargets.length || (expectedTargets.length === rows.length && expectedTargets.every((target) => {
      const platform = typeof target === "string" ? target : target?.platform;
      const account = typeof target === "object" ? target?.accountFingerprint : null;
      return rows.some((row) => row?.platform === platform && (!account || row?.accountFingerprint === account));
    }));
    const bindingsMatch = rows.every((row) => (!taskId || row.taskId === taskId)
      && (!mediaSha256 || String(row.mediaSha256 || "").toLowerCase() === String(mediaSha256).toLowerCase()));
    if (rows.every(isPublicReadbackReceipt) && uniqueTargets && targetsMatch && bindingsMatch) {
      return { status: "public", businessSuccess: true, complete: true };
    }
    if (states.some((state) => state === "draft")) return { status: "needs_attention", businessSuccess: false, complete: false };
    return { status: "submitted_unverified", businessSuccess: false, complete: false };
  }
  if (intent === "platform_draft") {
    const complete = rows.every((row) => String(row?.state || row?.status || "").toLowerCase() === "draft"
      && Boolean(row.receiptId || row.platformTaskId || row.taskId)
      && validTime(row.observedAt || row.readBackAt));
    return { status: complete ? "platform_draft" : "submitted_unverified", businessSuccess: false, complete };
  }
  return { status: "draft", businessSuccess: false, complete: true };
}

function issue(code, severity, path, message) {
  return { code, severity, path, message };
}

/**
 * Validate one projection assembled from existing stores. Missing optional
 * stages are fine; a record that claims completion without its proof is not.
 */
export function validateLifecycleSnapshot(snapshot = {}, { now = new Date().toISOString() } = {}) {
  const issues = [];
  const add = (code, severity, path, message) => issues.push(issue(code, severity, path, message));
  const asset = snapshot.asset || null;
  const importItem = snapshot.importItem || null;
  const downloadReceipts = Array.isArray(snapshot.downloadReceipts) ? snapshot.downloadReceipts : [];
  const creativeJob = snapshot.creativeJob || null;
  const generation = snapshot.generation || null;
  const publishTask = snapshot.publishTask || null;
  const platformReceipts = Array.isArray(snapshot.platformReceipts) ? snapshot.platformReceipts : [];
  const metricSnapshots = Array.isArray(snapshot.metricSnapshots) ? snapshot.metricSnapshots : [];

  if (importItem && ["success", "linked", "duplicate"].includes(importItem.status)) {
    const itemAssetId = importItem.asset_id || importItem.assetId;
    if (!itemAssetId) add("INGEST_SUCCESS_ASSET_MISSING", "error", "importItem.asset_id", "成功系导入项必须绑定资产");
    if (itemAssetId && asset?.id && String(itemAssetId) !== String(asset.id)) add("INGEST_SUCCESS_ASSET_MISMATCH", "error", "importItem.asset_id", "成功系导入项必须绑定当前验证的同一资产");
    if (!asset?.sha256 || !/^[a-f0-9]{64}$/i.test(String(asset.sha256))) add("INGEST_SUCCESS_SHA256_MISSING", "error", "asset.sha256", "完成入库必须有媒体 SHA-256");
    if (asset?.media_validation !== "ok" && asset?.mediaValidation !== "ok") add("INGEST_SUCCESS_MEDIA_UNVERIFIED", "error", "asset.media_validation", "完成入库必须通过媒体校验");
    if (asset?.fileVerified !== true) add("INGEST_SUCCESS_FILE_UNVERIFIED", "error", "asset.fileVerified", "完成入库必须验证文件存在且哈希匹配");
  }

  for (const [index, receipt] of downloadReceipts.entries()) {
    if (String(receipt.media_validation || receipt.mediaValidation) === "ok") {
      if (!/^[a-f0-9]{64}$/i.test(String(receipt.sha256 || ""))) add("DOWNLOAD_OK_SHA256_MISSING", "error", `downloadReceipts[${index}].sha256`, "下载成功收据必须包含 SHA-256");
      if (!validTime(receipt.completed_at || receipt.completedAt)) add("DOWNLOAD_OK_COMPLETED_AT_MISSING", "error", `downloadReceipts[${index}].completed_at`, "下载成功收据必须有完成时间");
    }
  }

  const analysisParts = snapshot.analysis && typeof snapshot.analysis === "object" ? snapshot.analysis : {};
  for (const [name, row] of Object.entries(analysisParts)) {
    if (row?.status === "available") {
      if (!row.source && !row.provider) add("ANALYSIS_SOURCE_MISSING", "error", `analysis.${name}.source`, "可用分析必须标明来源或 provider");
      if (!validTime(row.capturedAt || row.captured_at || row.analyzedAt || row.analyzed_at)) add("ANALYSIS_TIME_MISSING", "error", `analysis.${name}`, "可用分析必须带观察/分析时间");
    }
    if (row?.status === "unavailable" && !row.reason && !row.missingCapability && !row.limitation) {
      add("ANALYSIS_UNAVAILABLE_REASON_MISSING", "error", `analysis.${name}`, "不可用分析必须标明 reason、missingCapability 或 limitation");
    }
  }

  if (creativeJob?.status === "completed") {
    if (!generation || generation.status !== "completed") add("GENERATION_RECORD_MISSING", "error", "generation", "创作队列完成必须有 SQLite remake_generation 完成记录");
    if (generation && String(generation.asset_id || generation.assetId) !== String(creativeJob.assetId)) add("GENERATION_ASSET_MISMATCH", "error", "generation.asset_id", "生成记录必须绑定同一资产");
    if (!generation?.generationId && !generation?.id) add("GENERATION_ID_MISSING", "error", "generation.id", "完成生成必须有稳定 generation id");
    if (creativeJob.generationId && generation && String(creativeJob.generationId) !== String(generation.generationId || generation.id || "")) add("GENERATION_ID_MISMATCH", "error", "creativeJob.generationId", "队列 generationId 必须与 SQLite generation 相同");
    if (!/^[a-f0-9]{64}$/i.test(String(generation?.sha256 || ""))) add("GENERATION_SHA256_MISSING", "error", "generation.sha256", "完成生成必须有媒体 SHA-256");
    if (generation?.fileVerified !== true) add("GENERATION_FILE_UNVERIFIED", "error", "generation.fileVerified", "完成生成必须验证成片存在且哈希匹配");
    if ((generation?.mediaValidation || generation?.media_validation) !== "ok") add("GENERATION_MEDIA_UNVERIFIED", "error", "generation.mediaValidation", "完成生成必须通过媒体可播放校验");
    if (!snapshot.quality || !["review", "standard", "high"].includes(snapshot.quality.state)) add("GENERATION_QUALITY_MISSING", "error", "quality", "完成生成必须有非 blocked/unknown 的质检结论");
  }

  const selectedSha = String(snapshot.selectedMediaSha256 || generation?.sha256 || asset?.sha256 || "");
  const quality = snapshot.quality || null;
  const attemptedExternalPublish = publishTask && !["draft", "cancelled", "needs_setup"].includes(String(publishTask.status || ""));
  if (quality?.state === "blocked" && attemptedExternalPublish) {
    add("QUALITY_BLOCKED_EXTERNAL_ATTEMPT", "error", "quality.state", "媒体校验 blocked 时禁止进入草稿、排期或公开发布");
  }
  if (publishTask?.mode === "publish" && attemptedExternalPublish) {
    const review = snapshot.humanReview;
    if (!review?.approved || !validTime(review.approvedAt) || !review.reviewer || review.artifactSha256 !== selectedSha) {
      add("PUBLIC_REVIEW_EVIDENCE_MISSING", "error", "humanReview", "公开发布必须有绑定当前媒体 SHA 的持久人工批准证据");
    }
  }

  if (publishTask?.status === "scheduled" && validTime(publishTask.scheduledAt) && Date.parse(publishTask.scheduledAt) <= Date.parse(now)) {
    add("SCHEDULE_ELAPSED", "error", "publishTask.scheduledAt", "到期或过期排期必须进入执行、需处理或人工接管，不能继续标 scheduled");
  }
  if (["submitted", "submitted_unverified"].includes(String(publishTask?.status)) && Number(publishTask?.progress) === 100) {
    add("SUBMITTED_PROGRESS_FALSE_COMPLETE", "error", "publishTask.progress", "适配器已提交但未公开回读时进度不能标 100% 完成");
  }

  const aggregate = publicationOutcome({
    intent: publishTask?.mode === "publish" ? "public" : publishTask?.mode === "platform_draft" ? "platform_draft" : "workbench_draft",
    receipts: platformReceipts,
    targets: publishTask?.destinations || publishTask?.targets || [],
    taskId: publishTask?.id || null,
    mediaSha256: selectedSha || null,
  });
  if (["public", "completed", "success", "succeeded"].includes(String(publishTask?.status)) && !aggregate.businessSuccess) {
    add("PUBLIC_STATUS_WITHOUT_READBACK", "error", "publishTask.status", "公开完成必须由逐平台公开回读证明");
  }
  if (snapshot.claimBusinessSuccess === true && !aggregate.businessSuccess) {
    add("BUSINESS_SUCCESS_WITHOUT_READBACK", "error", "claimBusinessSuccess", "HTTP 2xx、进程存活、本地排期或适配器提交均不能证明业务成功");
  }
  if (publishTask?.automaticRetry === true && ["running", "submitting", "submitted", "submitted_unverified", "needs_reconciliation"].includes(String(publishTask.status))) {
    add("AMBIGUOUS_PUBLISH_AUTO_RETRY", "error", "publishTask.automaticRetry", "可能已产生外部副作用的发布不得自动重试");
  }

  const observationKeys = new Map();
  const outboundPostIds = new Set(platformReceipts.filter(isPublicReadbackReceipt).map((row) => String(row.postId || "")).filter(Boolean));
  for (const [index, row] of metricSnapshots.entries()) {
    for (const field of ["content_id", "source", "observation_id", "captured_at"]) {
      if (row[field] === null || row[field] === undefined || row[field] === "") add("METRIC_IDENTITY_INCOMPLETE", "error", `metricSnapshots[${index}].${field}`, "指标快照缺少幂等身份字段");
    }
    const key = `${row.asset_id || row.assetId}|${row.content_id}|${row.source}|${row.observation_id}`;
    const fingerprint = lifecyclePayloadFingerprint(row);
    if (observationKeys.has(key) && observationKeys.get(key) !== fingerprint) add("METRIC_OBSERVATION_CONFLICT", "error", `metricSnapshots[${index}]`, "同一 observation id 不得对应不同载荷");
    observationKeys.set(key, fingerprint);
    if ((row.direction === "outbound" || row.outbound === true) && !outboundPostIds.has(String(row.content_id || ""))) {
      add("OUTBOUND_METRIC_WITHOUT_PUBLIC_RECEIPT", "error", `metricSnapshots[${index}].content_id`, "出站指标必须关联已验证公开回执的 post ID");
    }
  }

  if (snapshot.archive?.status === "archived") {
    if (!/^[a-f0-9]{64}$/i.test(String(snapshot.archive.manifestSha256 || "")) || !validTime(snapshot.archive.archivedAt)) add("ARCHIVE_PROOF_MISSING", "error", "archive", "归档必须有清单 SHA-256 和归档时间");
    if (!snapshot.archive.retentionClass) add("ARCHIVE_RETENTION_CLASS_MISSING", "error", "archive.retentionClass", "归档必须指定保留类别");
    if (snapshot.archive.restoreVerified !== true) add("ARCHIVE_RESTORE_UNVERIFIED", "error", "archive.restoreVerified", "清理热数据前必须通过恢复验证");
    const manifestFiles = Array.isArray(snapshot.archive.manifestFiles) ? snapshot.archive.manifestFiles : [];
    if (!manifestFiles.length || manifestFiles.some((row) => !row?.relativePath || row.relativePath.startsWith("/")
      || row.relativePath.split(/[\\/]+/).includes("..") || !Number.isFinite(Number(row.sizeBytes))
      || !/^[a-f0-9]{64}$/i.test(String(row.sha256 || "")) || row.fileVerified !== true)) {
      add("ARCHIVE_MANIFEST_FILE_INVALID", "error", "archive.manifestFiles", "归档清单必须逐文件记录安全相对路径、大小、SHA 和恢复校验");
    }
    const analysisTasks = Array.isArray(snapshot.analysisTasks) ? snapshot.analysisTasks : [snapshot.analysisTask].filter(Boolean);
    const active = [snapshot.importTask, importItem, creativeJob, publishTask, ...analysisTasks].filter(Boolean)
      .some((row) => ["pending", "processing", "queued", "preparing", "running", "preflighting", "submitting", "scheduled"].includes(String(row.status)));
    if (active) add("ARCHIVE_WITH_ACTIVE_WORK", "error", "archive.status", "存在活跃分析、生成或发布工作时不能终态归档");
    if (publishTask?.mode === "publish" && !aggregate.businessSuccess && snapshot.archive.disposition !== "no_publish") {
      add("ARCHIVE_PUBLIC_OUTCOME_UNRESOLVED", "error", "archive.disposition", "公开意图未回读时只能先人工处置，不能标最终归档");
    }
  }

  const keyFingerprints = new Map();
  for (const [index, row] of (snapshot.idempotencyRecords || []).entries()) {
    if (!row?.key || !row?.payloadFingerprint) continue;
    if (keyFingerprints.has(row.key) && keyFingerprints.get(row.key) !== row.payloadFingerprint) {
      add("IDEMPOTENCY_KEY_REUSE_CONFLICT", "error", `idempotencyRecords[${index}]`, "同一幂等键对应不同请求载荷必须冲突");
    }
    keyFingerprints.set(row.key, row.payloadFingerprint);
  }

  for (const [index, transition] of (snapshot.transitions || []).entries()) {
    const decision = lifecycleTransitionDecision(transition.machine, transition.from, transition.to, transition.context || {});
    if (!decision.allowed) add("ILLEGAL_STATE_TRANSITION", "error", `transitions[${index}]`, decision.code);
  }

  issues.sort((left, right) => `${left.severity}:${left.code}:${left.path}`.localeCompare(`${right.severity}:${right.code}:${right.path}`));
  return {
    ok: !issues.some((row) => row.severity === "error"),
    version: CONTENT_LIFECYCLE_VERSION,
    publication: aggregate,
    issues,
  };
}
