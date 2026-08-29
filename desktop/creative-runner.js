#!/usr/bin/env node
"use strict";

const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { postprocessAudio } = require("./audio-postprocessor.js");

const AGENT = "http://127.0.0.1:17890";
const FFMPEG = path.join(os.homedir(), ".local", "share", "zhitai-runtime", "engines", "ffmpeg", "ffmpeg");
const FFPROBE = path.join(os.homedir(), ".local", "share", "zhitai-runtime", "engines", "ffmpeg", "ffprobe");
const OUTPUT_ROOT = path.join(os.homedir(), ".local", "share", "zhitai-runtime", "generation");
const WATERMARK_ROOT = path.join(os.homedir(), ".local", "share", "zhitai-runtime", "engines", "seedance-watermark-remover");
const WATERMARK_PYTHON = path.join(WATERMARK_ROOT, ".venv", "bin", "python");
const WATERMARK_SCRIPT = path.join(os.homedir(), ".local", "share", "zhitai-runtime", "scripts", "seedance-watermark-remover.py");
const GPT_PAGE_BUSY_CODE = "GPT_PAGE_BUSY_RETRYABLE";
const GPT_IMAGE_TIMEOUT_CODE = "GPT_IMAGE_TIMEOUT_RETRYABLE";
const DOUBAO_DUPLICATE_CLIP_CODE = "DOUBAO_DUPLICATE_CLIP_RETRYABLE";
const DOUBAO_RESULT_IDENTITY_CODE = "DOUBAO_RESULT_IDENTITY_RETRYABLE";
const DOUBAO_VIDEO_TIMEOUT_CODE = "DOUBAO_VIDEO_TIMEOUT_RETRYABLE";
const DOUBAO_UNEXPECTED_RESULT_CODE = "DOUBAO_UNEXPECTED_RESULT_IDENTITY";
const DOUBAO_VIDEO_TIMEOUT_UNSAFE_CODE = "DOUBAO_VIDEO_TIMEOUT_UNSAFE";
const DOUBAO_ORPHAN_RECOVERY_EXHAUSTED_CODE = "DOUBAO_ORPHAN_RECOVERY_EXHAUSTED";
const DOUBAO_ALL_ACCOUNTS_QUOTA_EXHAUSTED_CODE = "DOUBAO_ALL_ACCOUNTS_QUOTA_EXHAUSTED";
const LOCAL_MOTION_ENGINE = "ZhitaiLocalMotion";
const LOCAL_MOTION_PIPELINE_VERSION = "zhitai-local-motion-v1";
const LOCAL_MOTION_MANIFEST = "local-motion-manifest.json";
const LOCAL_MOTION_WIDTH = 1080;
const LOCAL_MOTION_HEIGHT = 1920;
const LOCAL_MOTION_FPS = 30;
const LOCAL_MOTION_SEGMENT_FRAMES = 250;
const LOCAL_MOTION_TOTAL_FRAMES = 750;
const LOCAL_MOTION_DURATION_MS = 25_000;
const LOCAL_MOTION_MOTIONS = Object.freeze([
  Object.freeze({
    name: "gentle_push_in",
    zoompan: "z='1+0.12*on/249':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'",
  }),
  Object.freeze({
    name: "gentle_horizontal_pan",
    zoompan: "z='1.10':x='(iw-iw/zoom)*on/249':y='ih/2-(ih/zoom/2)'",
  }),
  Object.freeze({
    name: "gentle_pull_out_reverse",
    zoompan: "z='1.12-0.12*on/249':x='(iw-iw/zoom)*(1-on/249)':y='ih/2-(ih/zoom/2)'",
  }),
]);

// Public builds never embed machine-specific job, asset, account or file
// fingerprints. A private deployment may inject an explicitly reviewed list at
// the call boundary; an unknown legacy artifact always fails closed.
const TRUSTED_LEGACY_STORYBOARD_MIGRATIONS = Object.freeze([]);
const TRUSTED_LEGACY_DOUBAO_TIMEOUT_MIGRATIONS = Object.freeze([]);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sanitizeId(value) { return String(value || "job").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120); }

function gptPageBusyError(detail = "GPT 页面仍忙，发送按钮尚未恢复") {
  const error = new Error(`${GPT_PAGE_BUSY_CODE}: ${detail}`);
  error.code = GPT_PAGE_BUSY_CODE;
  error.retryable = true;
  return error;
}

function gptImageTimeoutError(detail = "GPT 生图等待超时，未发现登录或额度异常") {
  const error = new Error(`${GPT_IMAGE_TIMEOUT_CODE}: ${detail}`);
  error.code = GPT_IMAGE_TIMEOUT_CODE;
  error.retryable = true;
  return error;
}

function doubaoDuplicateClipError(detail = "豆包返回了与前序镜头相同的成片") {
  const error = new Error(`${DOUBAO_DUPLICATE_CLIP_CODE}: ${detail}`);
  error.code = DOUBAO_DUPLICATE_CLIP_CODE;
  error.retryable = true;
  return error;
}

function doubaoResultIdentityError(detail = "豆包结果无法唯一对应当前镜头") {
  const error = new Error(`${DOUBAO_RESULT_IDENTITY_CODE}: ${detail}`);
  error.code = DOUBAO_RESULT_IDENTITY_CODE;
  error.retryable = true;
  return error;
}

function doubaoVideoTimeoutError(detail = "豆包视频生成等待超时，本轮未出现新结果", timeoutEvidence = null) {
  const error = new Error(`${DOUBAO_VIDEO_TIMEOUT_CODE}: ${detail}`);
  error.code = DOUBAO_VIDEO_TIMEOUT_CODE;
  error.retryable = true;
  error.noNewResultIdentity = true;
  if (timeoutEvidence) error.timeoutEvidence = timeoutEvidence;
  return error;
}

function doubaoUnexpectedResultError(detail = "豆包出现了与断点不匹配的新结果") {
  const error = new Error(`${DOUBAO_UNEXPECTED_RESULT_CODE}: ${detail}`);
  error.code = DOUBAO_UNEXPECTED_RESULT_CODE;
  error.retryable = false;
  return error;
}

function doubaoUnsafeTimeoutError(detail = "豆包视频等待超时，但无法证明可以安全重提", timeoutEvidence = null) {
  const error = new Error(`${DOUBAO_VIDEO_TIMEOUT_UNSAFE_CODE}: ${detail}`);
  error.code = DOUBAO_VIDEO_TIMEOUT_UNSAFE_CODE;
  error.retryable = false;
  error.noNewResultIdentity = true;
  if (timeoutEvidence) error.timeoutEvidence = timeoutEvidence;
  return error;
}

function doubaoOrphanRecoveryExhaustedError(detail = "豆包孤儿恢复重提也已超时") {
  const error = new Error(`${DOUBAO_ORPHAN_RECOVERY_EXHAUSTED_CODE}: ${detail}`);
  error.code = DOUBAO_ORPHAN_RECOVERY_EXHAUSTED_CODE;
  error.retryable = false;
  return error;
}

function doubaoAllAccountsQuotaExhaustedError(detail = "所有豆包账号的视频生成额度均已明确耗尽", evidence = null) {
  const error = new Error(`${DOUBAO_ALL_ACCOUNTS_QUOTA_EXHAUSTED_CODE}: ${detail}`);
  error.code = DOUBAO_ALL_ACCOUNTS_QUOTA_EXHAUSTED_CODE;
  error.retryable = false;
  if (/^[a-f0-9]{64}$/.test(String(evidence?.evidenceSha256 || ""))) {
    // 错误对象只携带不可逆摘要，不附账号标识、页面地址或完整观测。
    error.quotaEvidenceSha256 = evidence.evidenceSha256;
  }
  return error;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalJson(value) {
  const normalize = (item) => {
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.keys(item).sort()
        .filter((key) => item[key] !== undefined)
        .map((key) => [key, normalize(item[key])]));
    }
    return item;
  };
  return JSON.stringify(normalize(value));
}

function localMotionFallbackEnabled(value = process.env.ZHITAI_LOCAL_MOTION_FALLBACK) {
  // 精确错误码仍是主门；该开关是运维 kill switch。默认开启才能在无人值守
  // 场景恢复，设置为 0/false/off 可立即关闭而不改变任何豆包提交逻辑。
  return !/^(?:0|false|off|disabled)$/i.test(String(value ?? "1").trim());
}

function strictOriginalMotionWorkflow(detail) {
  const originality = detail?.remake_plan?.plan?.seedanceWorkflow?.originality || {};
  return originality.policy === "strict_full_original"
    && originality.status === "remediated"
    && originality.referenceVideoAllowed === false
    && originality.sourceAudioAllowed === false
    && originality.sourceMusicAllowed === false
    && originality.originalVisualsRequired === true
    && originality.originalVoiceoverRequired === true;
}

function exactDoubaoQuotaState(value) {
  if (!value || typeof value !== "object"
    || value.loginRequired !== false
    || value.quotaExhausted !== true
    || value.authorizationRequired !== false
    || value.riskBlocked !== false
    || value.probeFailed !== false
    || ![true, false, "unknown"].includes(value.assistantFinishState)) return null;
  return {
    loginRequired: false,
    quotaExhausted: true,
    authorizationRequired: false,
    riskBlocked: false,
    assistantFinishState: value.assistantFinishState,
    probeFailed: false,
  };
}

function safeDoubaoQuotaTimeoutEvidence(value) {
  if (value?.noNewResultIdentity !== true
    || value?.loginRequired !== false
    || value?.quotaExhausted !== true
    || value?.authorizationRequired !== false
    || value?.probeFailed !== false
    || ![true, false, "unknown"].includes(value?.assistantFinishState)) return null;
  return {
    noNewResultIdentity: true,
    loginRequired: false,
    quotaExhausted: true,
    authorizationRequired: false,
    assistantFinishState: value.assistantFinishState,
    probeFailed: false,
  };
}

function quotaEvidencePayload(value) {
  if (!value || typeof value !== "object") return null;
  const {
    schemaVersion,
    kind,
    jobId,
    assetId,
    shotIndex,
    inputFingerprint,
    pendingInputLocked,
    pendingTimeoutEvidenceSha256,
    accountCount,
    accountPoolSha256,
    observations,
    capturedAt,
  } = value;
  return {
    schemaVersion,
    kind,
    jobId,
    assetId,
    shotIndex,
    inputFingerprint,
    pendingInputLocked,
    pendingTimeoutEvidenceSha256,
    accountCount,
    accountPoolSha256,
    observations,
    capturedAt,
  };
}

function validatedDoubaoQuotaEvidence(evidence, { jobId, assetId, inputFingerprint } = {}) {
  const expectedKeys = [
    "accountCount", "accountPoolSha256", "assetId", "capturedAt", "evidenceSha256", "inputFingerprint",
    "jobId", "kind", "observations", "pendingInputLocked", "pendingTimeoutEvidenceSha256", "schemaVersion", "shotIndex",
  ];
  if (!evidence || canonicalJson(Object.keys(evidence).sort()) !== canonicalJson(expectedKeys.sort())
    || evidence.schemaVersion !== 1 || evidence.kind !== "all_accounts_exact_quota"
    || typeof evidence.jobId !== "string" || !evidence.jobId
    || typeof evidence.assetId !== "string" || !evidence.assetId
    || (jobId !== undefined && evidence.jobId !== jobId)
    || (assetId !== undefined && evidence.assetId !== assetId)
    || !Number.isInteger(evidence.shotIndex) || evidence.shotIndex < 1
    || !/^[a-f0-9]{64}$/.test(String(evidence.inputFingerprint || ""))
    || (inputFingerprint !== undefined && evidence.inputFingerprint !== inputFingerprint)
    || typeof evidence.pendingInputLocked !== "boolean"
    || (evidence.pendingInputLocked
      ? !/^[a-f0-9]{64}$/.test(String(evidence.pendingTimeoutEvidenceSha256 || ""))
      : evidence.pendingTimeoutEvidenceSha256 !== null)
    || !Number.isInteger(evidence.accountCount) || evidence.accountCount < 1 || evidence.accountCount > 8
    || !/^[a-f0-9]{64}$/.test(String(evidence.accountPoolSha256 || ""))
    || !Array.isArray(evidence.observations) || evidence.observations.length !== evidence.accountCount
    || typeof evidence.capturedAt !== "string" || !evidence.capturedAt
    || !/^[a-f0-9]{64}$/.test(String(evidence.evidenceSha256 || ""))) return null;
  const observations = [];
  for (let index = 0; index < evidence.observations.length; index++) {
    const observation = evidence.observations[index];
    const state = exactDoubaoQuotaState(observation?.state);
    if (!observation || Number(observation.ordinal) !== index + 1
      || !/^[a-f0-9]{64}$/.test(String(observation.accountKeySha256 || ""))
      || !state
      || canonicalJson(observation.state) !== canonicalJson(state)
      || canonicalJson(Object.keys(observation).sort())
        !== canonicalJson(["accountKeySha256", "ordinal", "state"].sort())) return null;
    observations.push({
      ordinal: index + 1,
      accountKeySha256: observation.accountKeySha256,
      state,
    });
  }
  if (new Set(observations.map((entry) => entry.accountKeySha256)).size !== evidence.accountCount
    || sha256(canonicalJson(observations.map((entry) => entry.accountKeySha256))) !== evidence.accountPoolSha256) return null;
  const payload = quotaEvidencePayload({ ...evidence, observations });
  if (sha256(canonicalJson(payload)) !== evidence.evidenceSha256) return null;
  return { ...payload, evidenceSha256: evidence.evidenceSha256 };
}

async function collectDoubaoAllAccountsQuotaEvidence({
  accounts,
  readState,
  jobId,
  assetId,
  shotIndex,
  inputFingerprint,
  pendingInputLocked = false,
  pendingTimeoutEvidence = null,
  capturedAt = new Date().toISOString(),
} = {}) {
  const pool = [...new Set((Array.isArray(accounts) ? accounts : [])
    .map((accountId) => sanitizeId(accountId)).filter(Boolean))].slice(0, 8);
  if (!pool.length || typeof readState !== "function"
    || typeof jobId !== "string" || !jobId
    || typeof assetId !== "string" || !assetId
    || !Number.isInteger(Number(shotIndex)) || Number(shotIndex) < 1
    || !/^[a-f0-9]{64}$/.test(String(inputFingerprint || ""))) {
    return { action: "reject", reason: "quota_scope_invalid" };
  }
  const timeoutEvidence = pendingInputLocked === true
    ? safeDoubaoQuotaTimeoutEvidence(pendingTimeoutEvidence) : null;
  if ((pendingInputLocked === true && !timeoutEvidence)
    || (pendingInputLocked !== true && pendingTimeoutEvidence != null)) {
    return { action: "reject", reason: "pending_quota_timeout_evidence_invalid" };
  }
  const observations = [];
  let invalidCount = 0;
  for (let index = 0; index < pool.length; index++) {
    const accountId = pool[index];
    let raw = null;
    try { raw = await readState(accountId, index); } catch { /* 探测失败按 unknown 失败关闭 */ }
    const state = exactDoubaoQuotaState(raw);
    if (!state) invalidCount += 1;
    observations.push({
      ordinal: index + 1,
      accountKeySha256: sha256(canonicalJson({ namespace: "zhitai-doubao-account-v1", accountId })),
      state,
    });
  }
  if (invalidCount || observations.some((entry) => !entry.state)) {
    return {
      action: "reject",
      reason: "not_all_accounts_exact_quota",
      accountCount: pool.length,
      invalidCount,
    };
  }
  const payload = {
    schemaVersion: 1,
    kind: "all_accounts_exact_quota",
    jobId,
    assetId,
    shotIndex: Number(shotIndex),
    inputFingerprint,
    pendingInputLocked: pendingInputLocked === true,
    pendingTimeoutEvidenceSha256: timeoutEvidence ? sha256(canonicalJson(timeoutEvidence)) : null,
    accountCount: pool.length,
    accountPoolSha256: sha256(canonicalJson(observations.map((entry) => entry.accountKeySha256))),
    observations,
    capturedAt,
  };
  const evidence = { ...payload, evidenceSha256: sha256(canonicalJson(payload)) };
  return validatedDoubaoQuotaEvidence(evidence, { jobId, assetId, inputFingerprint })
    ? { action: "quota_exhausted", evidence }
    : { action: "reject", reason: "quota_evidence_invalid" };
}

function localMotionFallbackDecision({ error, detail, shots, images, enabled } = {}) {
  if (!localMotionFallbackEnabled(enabled)) return { action: "disabled", reason: "feature_disabled" };
  if (![DOUBAO_ORPHAN_RECOVERY_EXHAUSTED_CODE, DOUBAO_ALL_ACCOUNTS_QUOTA_EXHAUSTED_CODE].includes(error?.code)) {
    return { action: "reject", reason: "trigger_code_mismatch" };
  }
  if (error.code === DOUBAO_ALL_ACCOUNTS_QUOTA_EXHAUSTED_CODE
    && !/^[a-f0-9]{64}$/.test(String(error.quotaEvidenceSha256 || ""))) {
    return { action: "reject", reason: "quota_evidence_digest_missing" };
  }
  if (!strictOriginalMotionWorkflow(detail)) return { action: "reject", reason: "strict_originality_required" };
  if (!Array.isArray(shots) || shots.length !== 3 || !Array.isArray(images) || images.length !== 3) {
    return { action: "reject", reason: "exactly_three_storyboards_required" };
  }
  return { action: "fallback" };
}

function safeLocalMotionTimeoutEvidence(value) {
  if (!safeDoubaoTimeoutEvidence(value)) return null;
  return {
    noNewResultIdentity: true,
    loginRequired: false,
    quotaExhausted: false,
    authorizationRequired: false,
    assistantFinishState: false,
    probeFailed: false,
  };
}

function buildLocalMotionTriggerEvidence({ error, checkpoint, observedAt = new Date().toISOString() } = {}) {
  if (error?.code === DOUBAO_ALL_ACCOUNTS_QUOTA_EXHAUSTED_CODE) {
    const evidence = validatedDoubaoQuotaEvidence(checkpoint?.doubao?.quotaExhaustion, {
      jobId: checkpoint?.jobId,
      assetId: checkpoint?.assetId,
    });
    if (!evidence || error?.quotaEvidenceSha256 !== evidence.evidenceSha256) return null;
    return {
      code: DOUBAO_ALL_ACCOUNTS_QUOTA_EXHAUSTED_CODE,
      allAccountsQuotaExhausted: true,
      accountCount: evidence.accountCount,
      pendingInputLocked: evidence.pendingInputLocked,
      shotIndex: evidence.shotIndex,
      inputFingerprint: evidence.inputFingerprint,
      quotaEvidenceSha256: evidence.evidenceSha256,
      observedAt,
    };
  }
  if (error?.code !== DOUBAO_ORPHAN_RECOVERY_EXHAUSTED_CODE) return null;
  const shots = checkpoint?.doubao?.shots && typeof checkpoint.doubao.shots === "object"
    ? checkpoint.doubao.shots : {};
  const exhausted = Object.values(shots).find((shot) => shot
    && Number(shot.attemptNumber) === 2
    && shot.orphanRecoveryUsed === true
    && shot.recoveryExhausted === true
    && /^[a-f0-9]{64}$/.test(String(shot.inputFingerprint || ""))
    && safeLocalMotionTimeoutEvidence(shot.lastTimeoutEvidence));
  if (!exhausted) return null;
  const timeoutEvidence = safeLocalMotionTimeoutEvidence(exhausted.lastTimeoutEvidence);
  return {
    code: DOUBAO_ORPHAN_RECOVERY_EXHAUSTED_CODE,
    attemptNumber: 2,
    recoveryExhausted: true,
    shotIndex: Number(exhausted.shotIndex),
    inputFingerprint: exhausted.inputFingerprint,
    timeoutEvidenceSha256: sha256(canonicalJson(timeoutEvidence)),
    observedAt,
  };
}

function localMotionResumeDecision({ checkpoint, jobId, assetId, enabled } = {}) {
  if (!localMotionFallbackEnabled(enabled)) return { action: "disabled", reason: "feature_disabled" };
  const state = checkpoint?.localMotion;
  const trigger = state?.trigger;
  if (!state || state.engine !== LOCAL_MOTION_ENGINE || state.jobId !== jobId || state.assetId !== assetId
    || !["triggered", "in_progress", "visual_completed", "completed"].includes(state.status)
    || ![DOUBAO_ORPHAN_RECOVERY_EXHAUSTED_CODE, DOUBAO_ALL_ACCOUNTS_QUOTA_EXHAUSTED_CODE].includes(trigger?.code)
    || !/^[a-f0-9]{64}$/.test(String(trigger?.inputFingerprint || ""))) {
    return { action: "reject", reason: "trusted_resume_state_missing" };
  }
  if (trigger.code === DOUBAO_ALL_ACCOUNTS_QUOTA_EXHAUSTED_CODE) {
    const quotaTriggerKeys = [
      "accountCount", "allAccountsQuotaExhausted", "code", "inputFingerprint", "observedAt",
      "pendingInputLocked", "quotaEvidenceSha256", "shotIndex",
    ];
    if (canonicalJson(Object.keys(trigger).sort()) !== canonicalJson(quotaTriggerKeys.sort())
      || trigger.allAccountsQuotaExhausted !== true
      || !Number.isInteger(trigger.accountCount) || trigger.accountCount < 1 || trigger.accountCount > 8
      || typeof trigger.pendingInputLocked !== "boolean"
      || !Number.isInteger(trigger.shotIndex) || trigger.shotIndex < 1
      || !/^[a-f0-9]{64}$/.test(String(trigger.quotaEvidenceSha256 || ""))
      || Object.keys(trigger).some((key) => /(?:accountId|conversation|url)/i.test(key))) {
      return { action: "reject", reason: "trusted_quota_trigger_missing" };
    }
    const evidence = validatedDoubaoQuotaEvidence(checkpoint?.doubao?.quotaExhaustion, {
      jobId,
      assetId,
      inputFingerprint: trigger.inputFingerprint,
    });
    const matchingPendingShot = !evidence?.pendingInputLocked || Object.values(checkpoint?.doubao?.shots || {}).some((shot) => {
      const timeoutEvidence = safeDoubaoQuotaTimeoutEvidence(shot?.quotaPendingTimeoutEvidence || shot?.lastTimeoutEvidence);
      return shot && Number(shot.shotIndex) === trigger.shotIndex
        && shot.inputFingerprint === trigger.inputFingerprint
        && shot.quotaPendingLocked === true
        && ["sending", "submitted"].includes(shot.sendState)
        && Boolean(shot.submittedAt || shot.sendingAt)
        && timeoutEvidence
        && sha256(canonicalJson(timeoutEvidence)) === evidence.pendingTimeoutEvidenceSha256;
    });
    return evidence
      && evidence.evidenceSha256 === trigger.quotaEvidenceSha256
      && evidence.accountCount === trigger.accountCount
      && evidence.pendingInputLocked === trigger.pendingInputLocked
      && evidence.shotIndex === trigger.shotIndex
      && matchingPendingShot
      ? { action: "resume", trigger }
      : { action: "reject", reason: "quota_evidence_mismatch" };
  }
  if (Number(trigger?.attemptNumber) !== 2 || trigger?.recoveryExhausted !== true) {
    return { action: "reject", reason: "trusted_resume_state_missing" };
  }
  const matchingShot = Object.values(checkpoint?.doubao?.shots || {}).find((shot) => shot
    && Number(shot.attemptNumber) === 2 && shot.orphanRecoveryUsed === true
    && shot.recoveryExhausted === true && shot.inputFingerprint === trigger.inputFingerprint
    && Number(shot.shotIndex) === Number(trigger.shotIndex)
    && safeLocalMotionTimeoutEvidence(shot.lastTimeoutEvidence)
    && sha256(canonicalJson(safeLocalMotionTimeoutEvidence(shot.lastTimeoutEvidence))) === trigger.timeoutEvidenceSha256);
  return matchingShot ? { action: "resume", trigger } : { action: "reject", reason: "exhausted_attempt_missing" };
}

function localMotionPreset() {
  return {
    name: "portrait_storyboard_motion_25s_v1",
    width: LOCAL_MOTION_WIDTH,
    height: LOCAL_MOTION_HEIGHT,
    fps: LOCAL_MOTION_FPS,
    segmentFrames: LOCAL_MOTION_SEGMENT_FRAMES,
    totalFrames: LOCAL_MOTION_TOTAL_FRAMES,
    durationMs: LOCAL_MOTION_DURATION_MS,
    codec: "h264",
    encoder: "libx264",
    pixelFormat: "yuv420p",
    encoderPreset: "medium",
    crf: 18,
    concat: "hard_cut_concat_demuxer_copy",
    motions: LOCAL_MOTION_MOTIONS.map(({ name, zoompan }) => ({ name, zoompan })),
  };
}

function localMotionSegmentFilter(segmentIndex) {
  const motion = LOCAL_MOTION_MOTIONS[Number(segmentIndex) - 1];
  if (!motion) throw new Error("本地动画只允许固定的三个运动段");
  return [
    "scale=2160:3840:force_original_aspect_ratio=increase",
    "crop=2160:3840:(in_w-out_w)/2:(in_h-out_h)/2",
    "setsar=1",
    `zoompan=${motion.zoompan}:d=${LOCAL_MOTION_SEGMENT_FRAMES}:s=${LOCAL_MOTION_WIDTH}x${LOCAL_MOTION_HEIGHT}:fps=${LOCAL_MOTION_FPS}`,
    "format=yuv420p",
  ].join(",");
}

function localMotionSegmentArgs({ imagePath, outputPath, segmentIndex } = {}) {
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-loop", "1", "-framerate", String(LOCAL_MOTION_FPS), "-i", imagePath,
    "-vf", localMotionSegmentFilter(segmentIndex),
    "-frames:v", String(LOCAL_MOTION_SEGMENT_FRAMES), "-an",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18",
    "-pix_fmt", "yuv420p", "-r", String(LOCAL_MOTION_FPS),
    "-g", String(LOCAL_MOTION_FPS), "-keyint_min", String(LOCAL_MOTION_FPS), "-sc_threshold", "0",
    "-map_metadata", "-1", "-movflags", "+faststart", outputPath,
  ];
}

function localMotionConcatArgs({ listPath, outputPath } = {}) {
  return [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-y",
    "-f", "concat", "-safe", "0", "-i", listPath,
    "-map", "0:v:0", "-an", "-c", "copy", "-movflags", "+faststart", outputPath,
  ];
}

function runSilentCommand(command, args, { timeoutMs = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* best effort */ }
      finish(new Error(`${path.basename(command)} 本地动画执行超时`));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { out = (out + chunk.toString()).slice(-24_000); });
    child.stderr.on("data", (chunk) => { err = (err + chunk.toString()).slice(-24_000); });
    child.once("error", finish);
    child.once("exit", (code) => code === 0
      ? finish(null, { out, err })
      : finish(new Error(`${path.basename(command)} 本地动画退出码 ${code}：${String(err || out).trim().slice(-500)}`)));
  });
}

function rationalNumber(value) {
  const [numerator, denominator = "1"] = String(value || "").split("/");
  const result = Number(numerator) / Number(denominator);
  return Number.isFinite(result) ? result : null;
}

async function probeLocalMotionVideo(filePath, {
  ffprobePath = FFPROBE,
  runCommandImpl = runSilentCommand,
} = {}) {
  const { out } = await runCommandImpl(ffprobePath, [
    "-v", "error", "-count_frames", "-show_entries",
    "format=duration:stream=codec_type,codec_name,pix_fmt,width,height,r_frame_rate,avg_frame_rate,nb_read_frames,duration",
    "-of", "json", filePath,
  ], { timeoutMs: 120_000 });
  let payload;
  try { payload = JSON.parse(out || "{}"); } catch { throw new Error("ffprobe 本地动画结果不是有效 JSON"); }
  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  return {
    width: Number(video?.width),
    height: Number(video?.height),
    fps: rationalNumber(video?.avg_frame_rate) || rationalNumber(video?.r_frame_rate),
    totalFrames: Number(video?.nb_read_frames),
    durationMs: Math.round((Number(payload?.format?.duration) || Number(video?.duration) || 0) * 1_000),
    codec: String(video?.codec_name || ""),
    pixelFormat: String(video?.pix_fmt || ""),
    audioCodec: String(audio?.codec_name || ""),
    audioDurationMs: audio ? Math.round((Number(audio.duration) || Number(payload?.format?.duration) || 0) * 1_000) : 0,
  };
}

function localMotionProbeDecision(probe, { frames, durationMs, allowAudio = false } = {}) {
  if (!probe || probe.width !== LOCAL_MOTION_WIDTH || probe.height !== LOCAL_MOTION_HEIGHT) {
    return { passed: false, reason: "resolution_mismatch" };
  }
  if (probe.codec !== "h264" || probe.pixelFormat !== "yuv420p") {
    return { passed: false, reason: "codec_or_pixel_format_mismatch" };
  }
  if (Math.abs(Number(probe.fps) - LOCAL_MOTION_FPS) > 0.001) return { passed: false, reason: "fps_mismatch" };
  if (Number(probe.totalFrames) !== Number(frames)) return { passed: false, reason: "frame_count_mismatch" };
  if (Math.abs(Number(probe.durationMs) - Number(durationMs)) > 50) return { passed: false, reason: "duration_mismatch" };
  if (!allowAudio && probe.audioCodec) return { passed: false, reason: "visual_contains_audio" };
  if (allowAudio && probe.audioCodec !== "aac") return { passed: false, reason: "aac_audio_missing" };
  return { passed: true, reason: null };
}

async function validateLocalMotionStoryboards({
  images,
  shots,
  checkpoint,
  jobId,
  assetId,
  inspectStoryboardImpl = inspectStoryboard,
} = {}) {
  if (!Array.isArray(images) || images.length !== 3 || !Array.isArray(shots) || shots.length !== 3) {
    throw new Error("本地动画严格门要求恰好三张原创分镜");
  }
  if (checkpoint?.gpt?.jobId !== jobId || checkpoint?.gpt?.assetId !== assetId) {
    throw new Error("本地动画分镜 manifest 与当前 job/asset 不一致");
  }
  const indices = shots.map((shot) => Number(shot.index));
  if (indices.join(",") !== "1,2,3") throw new Error("本地动画只接受按 1、2、3 排序的三个分镜");
  const storyboards = [];
  const hashes = new Set();
  for (let i = 0; i < 3; i++) {
    const shot = shots[i];
    const recorded = checkpoint.gpt.storyboards?.[String(shot.index)];
    const metadata = await inspectStoryboardImpl(images[i]);
    const promptHash = sha256(String(shot.imagePrompt || ""));
    if (!metadata || !recorded || recorded.legacyMigrationId
      || recorded.promptHash !== promptHash || recorded.sha256 !== metadata.sha256
      || Number(recorded.sizeBytes) !== Number(metadata.sizeBytes)
      || Number(recorded.width) !== Number(metadata.width)
      || Number(recorded.height) !== Number(metadata.height)) {
      throw new Error(`本地动画第 ${shot.index} 张分镜缺少完整 manifest/SHA/尺寸绑定`);
    }
    if (hashes.has(metadata.sha256)) throw new Error("本地动画三张分镜 SHA-256 必须互不相同");
    hashes.add(metadata.sha256);
    storyboards.push({
      index: Number(shot.index),
      name: path.basename(images[i]),
      sizeBytes: Number(metadata.sizeBytes),
      sha256: metadata.sha256,
      width: Number(metadata.width),
      height: Number(metadata.height),
    });
  }
  return { storyboards, storyboardFingerprint: sha256(canonicalJson(storyboards)) };
}

function localMotionGenerationProvenancePayload(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    engine: manifest.engine,
    evidenceMode: manifest.evidenceMode,
    jobId: manifest.jobId,
    assetId: manifest.assetId,
    pipelineVersion: manifest.pipelineVersion,
    preset: manifest.preset,
    trigger: manifest.trigger,
    environment: manifest.environment,
    storyboardFingerprint: manifest.storyboardFingerprint,
    storyboards: manifest.storyboards,
    segments: manifest.segments,
    visualVideo: manifest.visualVideo,
  };
}

function localMotionGenerationProvenanceSha256(manifest) {
  return sha256(canonicalJson(localMotionGenerationProvenancePayload(manifest)));
}

function localMotionManifestSha256(manifest) {
  const payload = { ...(manifest || {}) };
  delete payload.manifestSha256;
  return sha256(canonicalJson(payload));
}

function bindLocalMotionManifestHashes(manifest, { includeProvenance = false } = {}) {
  const next = { ...manifest };
  next.generationProvenanceSha256 = includeProvenance
    ? localMotionGenerationProvenanceSha256(next) : null;
  next.manifestSha256 = localMotionManifestSha256(next);
  return next;
}

async function writeLocalMotionManifest(filePath, manifest, options = {}) {
  const next = bindLocalMotionManifestHashes(manifest, options);
  await writeRunCheckpoint(filePath, next);
  return next;
}

async function executableVersion(command, runCommandImpl = runSilentCommand) {
  const { out, err } = await runCommandImpl(command, ["-version"], { timeoutMs: 30_000 });
  return String(out || err || "").split(/\r?\n/)[0].trim().slice(0, 240);
}

async function inspectLocalMotionArtifact(filePath, {
  expectedFrames,
  expectedDurationMs,
  allowAudio = false,
  probeVideoImpl = probeLocalMotionVideo,
} = {}) {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.size < 1_024) return null;
  const probe = await probeVideoImpl(filePath).catch(() => null);
  const decision = localMotionProbeDecision(probe, {
    frames: expectedFrames,
    durationMs: expectedDurationMs,
    allowAudio,
  });
  if (!decision.passed) return null;
  const bytes = await fsp.readFile(filePath);
  return { ...probe, sizeBytes: stat.size, sha256: sha256(bytes) };
}

function doubaoInputFingerprint({ imageSha256, prompt, negativePrompt = "", durationSeconds } = {}) {
  const imageHash = String(imageSha256 || "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(imageHash)) return "";
  const duration = Math.max(1, Math.min(10, Number(durationSeconds) || 10));
  return sha256(JSON.stringify({
    schemaVersion: 1,
    imageSha256: imageHash,
    prompt: String(prompt || ""),
    negativePrompt: String(negativePrompt || ""),
    durationSeconds: duration,
  }));
}

function safeDoubaoTimeoutEvidence(evidence) {
  return evidence?.noNewResultIdentity === true
    && evidence?.loginRequired === false
    && evidence?.quotaExhausted === false
    && evidence?.authorizationRequired === false
    && evidence?.assistantFinishState === false
    && evidence?.probeFailed === false;
}

function isChatGptConversationUrl(value) {
  try {
    const url = new URL(String(value || ""));
    return /(^|\.)chatgpt\.com$/i.test(url.hostname)
      && /(?:^|\/)c\/[A-Za-z0-9_-]+(?:\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
}

function effectiveCreativeStatus(job) {
  const status = String(job?.status || "ready_for_images");
  const resumeStatus = String(job?.resumeStatus || "");
  if (status === "transient_wait" && ["ready_for_images", "ready_for_seedance", "ready_for_assembly"].includes(resumeStatus)) {
    return resumeStatus;
  }
  return status;
}

async function writeRunCheckpoint(filePath, value) {
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fsp.rename(temporary, filePath);
}

async function inspectStoryboard(filePath, { ffprobePath = FFPROBE, timeoutMs = 10_000 } = {}) {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.size < 1_024) return null;
  let output = "";
  try {
    output = await new Promise((resolve, reject) => {
      const child = spawn(ffprobePath, [
        "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_type,width,height",
        "-of", "json", filePath,
      ], { stdio: ["ignore", "pipe", "ignore"] });
      let text = "";
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("storyboard_probe_timeout"));
      }, timeoutMs);
      child.stdout.on("data", (chunk) => { if (text.length < 64_000) text += chunk.toString(); });
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`storyboard_probe_failed_${code}`));
        else resolve(text);
      });
    });
  } catch {
    return null;
  }
  let stream;
  try { stream = JSON.parse(output)?.streams?.[0]; } catch { return null; }
  const width = Number(stream?.width);
  const height = Number(stream?.height);
  if (stream?.codec_type !== "video" || !Number.isFinite(width) || !Number.isFinite(height)
    || width < 256 || height < 256) return null;
  const bytes = await fsp.readFile(filePath);
  return {
    path: path.basename(filePath),
    sizeBytes: stat.size,
    width,
    height,
    sha256: sha256(bytes),
  };
}

async function inspectGeneratedClip(filePath) {
  const stat = await fsp.stat(filePath).catch(() => null);
  if (!stat?.isFile() || stat.size < 1_024) return null;
  const bytes = await fsp.readFile(filePath);
  return {
    path: path.basename(filePath),
    sizeBytes: stat.size,
    sha256: sha256(bytes),
  };
}

function doubaoClipManifestDecision({ metadata, recorded, previousShots = {}, shotIndex } = {}) {
  if (!metadata) return { status: "missing" };
  if (!recorded?.resultIdentity || !recorded?.outputSha256 || recorded.outputSha256 !== metadata.sha256) {
    return { status: "untrusted" };
  }
  const duplicate = Object.entries(previousShots && typeof previousShots === "object" ? previousShots : {})
    .find(([otherKey, other]) => Number(otherKey) < Number(shotIndex)
      && other?.outputSha256 === metadata.sha256);
  if (duplicate) return { status: "duplicate", duplicateOfShotIndex: Number(duplicate[0]) };
  return { status: "reusable" };
}

async function registerDoubaoClip({
  checkpoint,
  jobId,
  assetId,
  shotIndex,
  target,
  watermarkedTarget,
  resultIdentity,
  persist,
  inspectClipImpl = inspectGeneratedClip,
} = {}) {
  const metadata = await inspectClipImpl(target);
  if (!metadata) throw new Error(`豆包第 ${shotIndex} 镜成片未完整落盘，已停止后续拼接`);
  const state = checkpoint && typeof checkpoint === "object" ? checkpoint : {};
  const previous = state.doubao && typeof state.doubao === "object" ? state.doubao : {};
  const sameScope = previous.jobId === jobId && previous.assetId === assetId;
  state.doubao = {
    ...(sameScope ? previous : {}),
    jobId,
    assetId,
    shots: sameScope && previous.shots && typeof previous.shots === "object" ? { ...previous.shots } : {},
  };
  const shotKey = String(shotIndex);
  const previousShot = state.doubao.shots[shotKey] && typeof state.doubao.shots[shotKey] === "object"
    ? state.doubao.shots[shotKey] : {};
  const resolvedIdentity = String(resultIdentity || previousShot.resultIdentity || "").slice(0, 96);
  if (!resolvedIdentity) {
    state.doubao.conversationResetRequired = true;
    state.doubao.conversationResetReason = DOUBAO_RESULT_IDENTITY_CODE;
    state.doubao.conversationResetAt = new Date().toISOString();
    delete state.doubao.shots[shotKey];
    state.doubaoUrl = null;
    await Promise.all([
      fsp.rm(target, { force: true }),
      watermarkedTarget ? fsp.rm(watermarkedTarget, { force: true }) : Promise.resolve(),
    ]);
    if (typeof persist === "function") await persist(state);
    throw doubaoResultIdentityError(`第 ${shotIndex} 镜缺少可验证的结果 identity，已删除未绑定片段`);
  }
  const duplicate = Object.entries(state.doubao.shots)
    .find(([otherKey, other]) => Number(otherKey) < Number(shotKey)
      && other?.outputSha256 === metadata.sha256);
  if (duplicate) {
    state.doubao.rejectedResults = [
      ...(Array.isArray(state.doubao.rejectedResults) ? state.doubao.rejectedResults : []),
      {
        shotIndex: Number(shotIndex),
        resultIdentity: resolvedIdentity,
        outputSha256: metadata.sha256,
        duplicateOfShotIndex: Number(duplicate[0]),
        rejectedAt: new Date().toISOString(),
      },
    ].slice(-12);
    delete state.doubao.shots[shotKey];
    state.doubao.conversationResetRequired = true;
    state.doubao.conversationResetReason = DOUBAO_DUPLICATE_CLIP_CODE;
    state.doubao.conversationResetAt = new Date().toISOString();
    state.doubaoUrl = null;
    await Promise.all([
      fsp.rm(target, { force: true }),
      watermarkedTarget ? fsp.rm(watermarkedTarget, { force: true }) : Promise.resolve(),
    ]);
    if (typeof persist === "function") await persist(state);
    throw doubaoDuplicateClipError(`第 ${shotIndex} 镜与第 ${duplicate[0]} 镜 SHA-256 相同，已删除后镜并保留可恢复断点`);
  }
  state.doubao.shots[shotKey] = {
    ...previousShot,
    resultIdentity: resolvedIdentity,
    outputSha256: metadata.sha256,
    outputSizeBytes: metadata.sizeBytes,
    outputPath: metadata.path,
    awaitingResult: false,
    completedAt: new Date().toISOString(),
  };
  state.doubao.conversationResetRequired = false;
  if (typeof persist === "function") await persist(state);
  return { checkpoint: state, metadata };
}

function shotPrompts(detail) {
  const plan = detail?.remake_plan?.plan || {};
  const workflow = plan.seedanceWorkflow || {};
  const shots = Array.isArray(workflow.shots) ? workflow.shots : [];
  const revision = String(plan.userRevisionRequest || "").trim();
  const revisionRule = revision ? "\n\n【本次返工必须执行】" + revision : "";
  return shots.map((shot, index) => ({
    index: Number(shot.index) || index + 1,
    imagePrompt: String(shot.gptImagePrompt || shot.imagePrompt || "").trim() + revisionRule,
    videoPrompt: String(shot.seedancePrompt || shot.videoPrompt || "").trim() + revisionRule,
    negativePrompt: String(shot.negativePrompt || "").trim() + (revision ? "；不得忽略用户返工意见：" + revision : ""),
    durationSeconds: Math.max(1, Math.min(10, Number(shot.durationSeconds) || 10)),
  })).filter((shot) => shot.imagePrompt && shot.videoPrompt);
}

function generationReadiness(detail) {
  const workflow = detail?.remake_plan?.plan?.seedanceWorkflow;
  if (!workflow || Number(workflow.schemaVersion || 0) < 3) {
    return { ready: false, status: "needs_analysis", error: "这条素材仍是旧的行业模板提示词，请重新分析后再生成" };
  }
  const state = workflow.generationReadiness;
  if (!state || typeof state.ready !== "boolean") {
    return { ready: false, status: "needs_analysis", error: "这条素材使用的是旧分析记录，请重新分析后再生成" };
  }
  if (!state.ready) {
    const reasons = Array.isArray(state.blockers) ? state.blockers.filter(Boolean).join("；") : "提示词需要重新分析";
    return { ready: false, status: "quality_blocked", error: `生成前质量门未通过：${reasons}` };
  }
  return { ready: true, status: "ready", error: null };
}

function doubaoVideoEntryDecision(entries, currentUrl = "", { allowCreative = false, modeReady = false } = {}) {
  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const compact = (value) => normalize(value).replace(/\s+/g, "").toLowerCase();
  const rows = (Array.isArray(entries) ? entries : []).map((entry, index) => ({
    index,
    label: normalize(entry?.label),
    href: normalize(entry?.href),
    visible: entry?.visible !== false,
    enabled: entry?.enabled !== false,
  })).filter((entry) => entry.visible && entry.enabled && entry.label);
  let pathname = "";
  try { pathname = new URL(String(currentUrl || "")).pathname.slice(0, 160); } catch { pathname = ""; }
  if (modeReady || /(?:create[-_/]?(?:ai-)?video|video[-_/]?(?:create|generation|generator)|generate[-_/]?video)/i.test(pathname)) {
    return { status: "already", kind: "video", index: -1, label: "", pathname, diagnostics: [] };
  }

  const denied = /语音|声音|音乐|朗读|播放|暂停|预览|试听|听一听|voice|audio|music|speech|microphone|preview|pause|play/i;
  const directLabels = new Set(["视频生成", "生成视频", "视频创作", "ai视频", "ai视频生成", "图生视频", "文生视频"]);
  const creativeLabels = new Set(["创作", "ai创作", "智能创作"]);
  const ranked = rows.map((entry) => {
    const label = compact(entry.label);
    let score = 0;
    let kind = "";
    if (denied.test(entry.label)) score = -1;
    else if (/(?:create[-_/]?(?:ai-)?video|video[-_/]?(?:create|generation|generator)|generate[-_/]?video)/i.test(entry.href)) { score = 150; kind = "video"; }
    else if (directLabels.has(label)) { score = 140; kind = "video"; }
    else if (/^(?:ai)?视频生成(?:入口|工具|功能)?$/.test(label) || /^生成视频(?:入口|工具|功能)?$/.test(label)) { score = 130; kind = "video"; }
    else if (/^(?:图生视频|文生视频|视频创作)$/.test(label)) { score = 125; kind = "video"; }
    else if (allowCreative && creativeLabels.has(label)) { score = 80; kind = "creative"; }
    return { ...entry, score, kind };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const diagnostics = rows
    .filter((entry) => /创作|视频/.test(entry.label) && !denied.test(entry.label))
    .map((entry) => entry.label).filter((label, index, all) => all.indexOf(label) === index).slice(0, 8);
  if (!ranked.length) return { status: "missing", kind: "", index: -1, label: "", pathname, diagnostics };
  const bestScore = ranked[0].score;
  const winners = ranked.filter((entry) => entry.score === bestScore);
  const winnerKeys = new Set(winners.map((entry) => `${compact(entry.label)}|${entry.href.replace(/[?#].*$/, "")}`));
  if (winnerKeys.size > 1) {
    return { status: "ambiguous", kind: "", index: -1, label: "", pathname, diagnostics: winners.map((entry) => entry.label).slice(0, 8) };
  }
  return { status: "click", kind: winners[0].kind, index: winners[0].index, label: winners[0].label, pathname, diagnostics };
}

function doubaoResultDownloadDecision({ controls = [], mediaUrls = [] } = {}) {
  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 160);
  const compact = (value) => normalize(value).replace(/\s+/g, "").toLowerCase();
  const safeUrl = (value) => /^(?:https?:|blob:)/i.test(normalize(value));
  const allowedLabel = (value) => {
    const label = compact(value);
    if (!label || /播放|预览|打开|客户端|分享|封面|图片|音频|声音|音乐|play|preview|open|client|share|image|audio|music/i.test(label)) return false;
    return /^(?:保存|下载)(?:视频|原视频|成片|到本地|到电脑)?$/.test(label)
      || /^(?:视频|原视频|成片)(?:保存|下载)$/.test(label);
  };
  const rows = (Array.isArray(controls) ? controls : []).map((entry) => ({
    domIndex: Number(entry?.domIndex),
    label: normalize(entry?.label),
    href: normalize(entry?.href),
    visible: entry?.visible !== false,
    enabled: entry?.enabled !== false,
  })).filter((entry) => Number.isInteger(entry.domIndex) && entry.visible && entry.enabled && allowedLabel(entry.label));
  const linked = rows.filter((entry) => safeUrl(entry.href));
  const linkedUrls = [...new Set(linked.map((entry) => entry.href))];
  if (linkedUrls.length === 1) return { status: "url", url: linkedUrls[0], label: linked[0].label };
  if (linkedUrls.length > 1) return { status: "ambiguous", reason: "发现多个明确的豆包下载链接" };

  const clickable = rows.filter((entry) => !entry.href);
  if (clickable.length === 1) {
    return { status: "click", domIndex: clickable[0].domIndex, label: clickable[0].label };
  }
  if (clickable.length > 1) return { status: "ambiguous", reason: "发现多个明确的豆包保存控件" };

  const urls = [...new Set((Array.isArray(mediaUrls) ? mediaUrls : []).map(normalize).filter(safeUrl))];
  if (urls.length === 1) return { status: "url", url: urls[0], label: "视频直链" };
  if (urls.length > 1) return { status: "ambiguous", reason: "当前会话存在多个视频结果且无法唯一确认" };
  return { status: "missing", reason: "未找到唯一明确的视频直链或保存控件" };
}

function doubaoVideoModelResults(values = []) {
  const decodeBase64 = (value) => {
    const source = String(value || "").trim().replace(/-/g, "+").replace(/_/g, "/");
    if (!source) return "";
    try {
      if (typeof atob === "function") return atob(source);
      if (typeof Buffer !== "undefined") return Buffer.from(source, "base64").toString("utf8");
    } catch { /* 无效 base64 */ }
    return "";
  };
  // 这个函数会被序列化到渲染页执行，因此不依赖 Node crypto。
  // 只把稳定标识的哈希带回主进程；签名 URL 仅用于实际下载，
  // 不会进断点或错误诊断。
  const stableHash = (value) => {
    const text = String(value || "");
    let h1 = 0xdeadbeef ^ text.length;
    let h2 = 0x41c6ce57 ^ text.length;
    for (let index = 0; index < text.length; index++) {
      const code = text.charCodeAt(index);
      h1 = Math.imul(h1 ^ code, 2654435761);
      h2 = Math.imul(h2 ^ code, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
  };
  const findIdentity = (roots) => {
    const keys = ["video_id", "videoId", "vid", "file_hash", "fileHash"];
    for (const key of keys) {
      const queue = (Array.isArray(roots) ? roots : []).filter((item) => item && typeof item === "object")
        .map((item) => ({ item, depth: 0 }));
      const seen = new Set();
      while (queue.length) {
        const current = queue.shift();
        if (!current?.item || seen.has(current.item)) continue;
        seen.add(current.item);
        const candidate = current.item[key];
        if (["string", "number"].includes(typeof candidate) && String(candidate).trim()) {
          return `${key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}:${stableHash(String(candidate).trim())}`;
        }
        if (current.depth >= 4) continue;
        for (const child of Object.values(current.item).slice(0, 120)) {
          if (child && typeof child === "object") queue.push({ item: child, depth: current.depth + 1 });
        }
      }
    }
    return "";
  };
  const results = [];
  for (const value of Array.isArray(values) ? values : []) {
    let model = value;
    try { if (typeof model === "string") model = JSON.parse(model); } catch { model = null; }
    const list = model?.video_list && typeof model.video_list === "object"
      ? Object.values(model.video_list) : [];
    const rows = [];
    for (const item of list) {
      const decoded = decodeBase64(item?.main_url);
      let parsed;
      try { parsed = new URL(decoded); } catch { parsed = null; }
      if (!parsed || parsed.protocol !== "https:" || parsed.username || parsed.password) continue;
      const score = (String(item?.vtype || "").toLowerCase() === "mp4" ? 100 : 0)
        + (String(item?.codec_type || "").toLowerCase() === "h264" ? 50 : 0)
        + (String(item?.encryption_method || "") === "" ? 20 : 0)
        + Math.min(20, Math.max(0, Number(item?.bitrate) || 0) / 1_000_000);
      rows.push({ item, url: parsed.href, score, codec: String(item?.codec_type || ""), definition: String(item?.definition || "") });
    }
    if (!rows.length) continue;
    rows.sort((left, right) => right.score - left.score);
    const bestScore = rows[0].score;
    const winners = [...new Map(rows.filter((row) => row.score === bestScore).map((row) => [row.url, row])).values()];
    if (winners.length !== 1) continue;
    const winner = winners[0];
    let canonicalUrl = winner.url;
    try {
      const parsed = new URL(winner.url);
      canonicalUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    } catch { /* winner.url 已在上方校验，仅作保守回退 */ }
    const identity = findIdentity([winner.item, model]) || `url:${stableHash(canonicalUrl)}`;
    results.push({ identity, url: winner.url, score: winner.score, codec: winner.codec, definition: winner.definition });
  }
  const unique = new Map();
  for (const result of results) {
    // React props 可能在同一结果卡多处重复。保留最后一份可用 URL，
    // 但 identity 仍保持稳定。
    if (unique.has(result.identity)) unique.delete(result.identity);
    unique.set(result.identity, result);
  }
  return [...unique.values()];
}

function doubaoVideoModelDecision(values = []) {
  const rows = doubaoVideoModelResults(values);
  if (!rows.length) return { status: "missing" };
  const bestScore = Math.max(...rows.map((row) => row.score));
  const winners = rows.filter((row) => row.score === bestScore);
  if (winners.length !== 1) return { status: "ambiguous" };
  return { status: "url", ...winners[0] };
}

function doubaoUrlResultIdentity(value) {
  let text = String(value || "");
  if (!/^(?:https?:|blob:)/i.test(text)) return "";
  try {
    const parsed = new URL(text);
    if (/^https?:$/i.test(parsed.protocol)) text = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch { /* blob URL 或无法规范化的媒体 URL 使用原值 */ }
  let h1 = 0xdeadbeef ^ text.length;
  let h2 = 0x41c6ce57 ^ text.length;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return `url:${(h2 >>> 0).toString(16).padStart(8, "0")}${(h1 >>> 0).toString(16).padStart(8, "0")}`;
}

function selectNewDoubaoResult(candidates = [], beforeIdentities = new Set(), expectedIdentity = "") {
  const baseline = beforeIdentities instanceof Set ? beforeIdentities : new Set(beforeIdentities || []);
  const unique = new Map();
  for (const entry of Array.isArray(candidates) ? candidates : []) {
    if (!entry || typeof entry.identity !== "string" || !entry.identity
      || !/^(?:https?:|blob:)/i.test(String(entry.url || ""))) continue;
    if (unique.has(entry.identity)) unique.delete(entry.identity);
    unique.set(entry.identity, entry);
  }
  const rows = [...unique.values()];
  if (expectedIdentity) {
    const exact = rows.filter((entry) => entry.identity === expectedIdentity);
    if (exact.length === 1) return { status: "ready", result: exact[0] };
    if (exact.length > 1) return { status: "ambiguous" };
    return { status: "waiting" };
  }
  const fresh = rows.filter((entry) => !baseline.has(entry.identity));
  if (fresh.length === 1) return { status: "ready", result: fresh[0] };
  if (fresh.length > 1) return { status: "ambiguous" };
  return { status: "waiting" };
}

function trustedLegacyDoubaoTimeoutMigration({ checkpoint, jobId, assetId, shotIndex, shotPosition, accountId } = {}, migrations = TRUSTED_LEGACY_DOUBAO_TIMEOUT_MIGRATIONS) {
  const shot = checkpoint?.doubao?.shots?.[String(shotIndex)];
  return (Array.isArray(migrations) ? migrations : []).find((entry) => entry.jobId === jobId
    && entry.assetId === assetId && entry.shotIndex === Number(shotIndex)
    && entry.shotPosition === Number(shotPosition) && entry.accountId === accountId
    && checkpoint?.jobId === jobId && checkpoint?.assetId === assetId
    && checkpoint?.accountId === accountId && Number(checkpoint?.shotIndex) === Number(shotPosition)
    && shot?.submittedAt === entry.submittedAt && shot?.lastWaitTimedOutAt === entry.lastWaitTimedOutAt
    && shot?.lastWaitHadNewIdentity === false && Array.isArray(shot?.baselineIdentities)) || null;
}

function bindLegacyDoubaoAttempt({
  checkpoint,
  jobId,
  assetId,
  shotIndex,
  shotPosition,
  accountId,
  inputFingerprint,
  legacyTimeoutCount = 1,
  legacyTimeoutCountSource = "run_state_marker",
} = {}) {
  if (!checkpoint || checkpoint.jobId !== jobId || checkpoint.assetId !== assetId
    || Number(checkpoint.shotIndex) !== Number(shotPosition) || checkpoint.accountId !== accountId
    || !/^[a-f0-9]{64}$/.test(String(inputFingerprint || ""))) return false;
  const shot = checkpoint?.doubao?.shots?.[String(shotIndex)];
  if (!shot || typeof shot !== "object" || shot.inputFingerprint
    || !shot.submittedAt || !Array.isArray(shot.baselineIdentities)) return false;
  if (shot.accountId && shot.accountId !== accountId) return false;
  if (shot.shotIndex !== undefined && Number(shot.shotIndex) !== Number(shotIndex)) return false;
  const legacyTimedOut = Boolean(shot.lastWaitTimedOutAt && shot.lastWaitHadNewIdentity === false);
  const verifiedTimeoutCount = legacyTimedOut ? Math.max(1, Math.min(2, Number(legacyTimeoutCount) || 1)) : 0;
  shot.inputFingerprint = inputFingerprint;
  shot.attemptNumber = 1;
  shot.sendState = "submitted";
  shot.zeroIdentityTimeoutCount = verifiedTimeoutCount;
  shot.timeoutEvidenceHistory = legacyTimedOut ? Array.from({ length: verifiedTimeoutCount }, (_unused, index) => ({
    attemptNumber: 1,
    inputFingerprint,
    noNewResultIdentity: true,
    legacyCompatibilityMarker: true,
    legacyTimeoutOrdinal: index + 1,
    timedOutAt: shot.lastWaitTimedOutAt,
  })) : [];
  shot.legacyTimeoutCountSource = verifiedTimeoutCount > 1 ? legacyTimeoutCountSource : "run_state_marker";
  shot.legacyAttemptBoundAt = new Date().toISOString();
  return true;
}

function pendingDoubaoSubmission({ checkpoint, jobId, assetId, shotIndex, shotPosition, accountId, inputFingerprint } = {}) {
  if (!checkpoint || checkpoint.jobId !== jobId || checkpoint.assetId !== assetId
    || Number(checkpoint.shotIndex) !== Number(shotPosition) || checkpoint.accountId !== accountId) return null;
  const shot = checkpoint?.doubao?.shots?.[String(shotIndex)];
  if (!shot || typeof shot !== "object" || !Array.isArray(shot.baselineIdentities)
    || (shot.sendState !== "sending" && !shot.submittedAt)) return null;
  if (shot.accountId && shot.accountId !== accountId) return null;
  if (shot.shotIndex !== undefined && Number(shot.shotIndex) !== Number(shotIndex)) return null;
  if (!/^[a-f0-9]{64}$/.test(String(inputFingerprint || "")) || shot.inputFingerprint !== inputFingerprint) return null;
  const baselineIdentities = [...new Set(shot.baselineIdentities
    .map(String).filter((identity) => identity && identity.length <= 96))].slice(-32);
  return {
    baselineIdentities,
    expectedIdentity: typeof shot.resultIdentity === "string" ? shot.resultIdentity.slice(0, 96) : "",
    conversationUrl: String(shot.conversationUrl || checkpoint.doubaoUrl || "").slice(0, 2_048),
    submittedAt: shot.submittedAt,
    sendState: shot.sendState === "sending" ? "sending" : "submitted",
    attemptNumber: Number(shot.attemptNumber) === 2 ? 2 : 1,
    inputFingerprint: shot.inputFingerprint,
    orphanRecoveryUsed: shot.orphanRecoveryUsed === true,
    zeroIdentityTimeoutCount: Math.max(0, Number(shot.zeroIdentityTimeoutCount) || 0),
  };
}

function doubaoPendingQuotaFastPathDecision({
  checkpoint,
  jobId,
  assetId,
  shotIndex,
  shotPosition,
  accountId,
  inputFingerprint,
  pendingSubmission,
  availability,
} = {}) {
  if (!pendingSubmission) return { action: "not_applicable", reason: "no_pending_submission" };
  const rebound = pendingDoubaoSubmission({
    checkpoint,
    jobId,
    assetId,
    shotIndex,
    shotPosition,
    accountId,
    inputFingerprint,
  });
  if (!rebound
    || rebound.inputFingerprint !== pendingSubmission.inputFingerprint
    || rebound.inputFingerprint !== inputFingerprint
    || rebound.attemptNumber !== pendingSubmission.attemptNumber
    || rebound.sendState !== pendingSubmission.sendState
    || rebound.conversationUrl !== pendingSubmission.conversationUrl
    || rebound.submittedAt !== pendingSubmission.submittedAt
    || rebound.expectedIdentity !== pendingSubmission.expectedIdentity
    || canonicalJson(rebound.baselineIdentities) !== canonicalJson(pendingSubmission.baselineIdentities)) {
    return { action: "unsafe", reason: "pending_scope_mismatch" };
  }
  const shot = checkpoint?.doubao?.shots?.[String(shotIndex)];
  const hasWaitMarker = shot?.lastWaitTimedOutAt != null
    || shot?.lastWaitHadNewIdentity != null
    || shot?.lastTimeoutEvidence != null;
  if (!hasWaitMarker) return { action: "not_applicable", reason: "no_completed_wait_checkpoint" };
  const timeoutEvidence = safeDoubaoQuotaTimeoutEvidence(shot?.lastTimeoutEvidence);
  const exactAvailability = exactDoubaoQuotaState(availability);
  const noResultOrOutput = [
    shot?.resultIdentity,
    shot?.resultReadyAt,
    shot?.outputSha256,
    shot?.outputSizeBytes,
    shot?.outputPath,
    shot?.completedAt,
  ].every((value) => value == null || value === "");
  if (typeof shot?.lastWaitTimedOutAt !== "string"
    || !Number.isFinite(Date.parse(shot.lastWaitTimedOutAt))
    || shot.lastWaitHadNewIdentity !== false
    || !timeoutEvidence
    || canonicalJson(shot.lastTimeoutEvidence) !== canonicalJson(timeoutEvidence)
    || !exactAvailability
    || !noResultOrOutput) {
    return { action: "unsafe", reason: "quota_wait_checkpoint_incomplete" };
  }
  return { action: "lock_and_probe", timeoutEvidence, availability: exactAvailability };
}

function doubaoOrphanRecoveryDecision({
  shot,
  inputFingerprint,
  accountId,
  timeoutError,
  availabilityBefore,
  availabilityAfter,
} = {}) {
  if (timeoutError?.code !== DOUBAO_VIDEO_TIMEOUT_CODE) return { action: "not_timeout" };
  if (!shot || shot.accountId !== accountId || shot.inputFingerprint !== inputFingerprint) {
    return { action: "unsafe", reason: "attempt_scope_mismatch" };
  }
  const explicitlyAvailable = (value) => value?.probeFailed !== true
    && value?.loginRequired === false && value?.quotaExhausted === false;
  if (!safeDoubaoTimeoutEvidence(timeoutError.timeoutEvidence)
    || !explicitlyAvailable(availabilityBefore) || !explicitlyAvailable(availabilityAfter)) {
    return { action: "unsafe", reason: "timeout_evidence_incomplete" };
  }
  const attemptNumber = Number(shot.attemptNumber) === 2 ? 2 : 1;
  if (attemptNumber === 2 || shot.orphanRecoveryUsed === true) return { action: "exhausted" };
  const history = (Array.isArray(shot.timeoutEvidenceHistory) ? shot.timeoutEvidenceHistory : [])
    .filter((entry) => entry?.attemptNumber === 1 && entry?.inputFingerprint === inputFingerprint);
  const lastTwo = history.slice(-2);
  const trustedLegacyPair = ["trusted_runtime_migration", "queue_transientRetryCount"].includes(shot.legacyTimeoutCountSource)
    && lastTwo.length === 2 && lastTwo.every((entry) => entry?.legacyCompatibilityMarker === true);
  const consecutiveSafeTimeouts = lastTwo.length === 2
    && lastTwo.every((entry, index) => safeDoubaoTimeoutEvidence(entry)
      || (index === 0 && entry?.legacyCompatibilityMarker === true && entry?.noNewResultIdentity === true))
    || trustedLegacyPair;
  const timeoutCount = Math.max(0, Number(shot.zeroIdentityTimeoutCount) || 0);
  if (timeoutCount < 2) return { action: "retry_wait" };
  if (timeoutCount === 2 && consecutiveSafeTimeouts) return { action: "recover_orphan" };
  return { action: "unsafe", reason: "timeout_history_not_consecutive" };
}

async function markDoubaoAttemptOrphaned({
  checkpoint,
  jobId,
  assetId,
  shotIndex,
  shotPosition,
  accountId,
  inputFingerprint,
  persist,
  now = new Date().toISOString(),
} = {}) {
  const shotKey = String(shotIndex);
  const shot = checkpoint?.doubao?.shots?.[shotKey];
  if (!checkpoint || checkpoint.jobId !== jobId || checkpoint.assetId !== assetId
    || Number(checkpoint.shotIndex) !== Number(shotPosition) || checkpoint.accountId !== accountId
    || !shot || shot.accountId !== accountId || shot.inputFingerprint !== inputFingerprint
    || Number(shot.attemptNumber || 1) !== 1 || shot.orphanRecoveryUsed === true
    || Number(shot.zeroIdentityTimeoutCount || 0) !== 2) {
    throw doubaoUnsafeTimeoutError("孤儿恢复断点与当前任务输入不一致，未重提");
  }
  const priorOrphans = Array.isArray(shot.orphanedAttempts) ? shot.orphanedAttempts : [];
  const oldAttemptFields = { ...shot };
  delete oldAttemptFields.orphanedAttempts;
  const orphanedAttempt = {
    ...oldAttemptFields,
    sendState: "orphaned",
    orphaned: true,
    orphanedAt: now,
    orphanRecoveryUsed: true,
  };
  const nextShot = {
    shotIndex: Number(shotIndex),
    accountId,
    inputFingerprint,
    attemptNumber: 2,
    sendState: "preparing_recovery",
    recoveryPreparedAt: now,
    orphanRecoveryUsed: true,
    orphanedAttempts: [...priorOrphans, orphanedAttempt].slice(-2),
    baselineIdentities: [],
    conversationUrl: "",
    submittedAt: null,
    sendingAt: null,
    awaitingResult: false,
    resultIdentity: null,
    outputSha256: null,
    outputSizeBytes: null,
    outputPath: null,
    completedAt: null,
    zeroIdentityTimeoutCount: 0,
    timeoutEvidenceHistory: [],
  };
  const nextCheckpoint = {
    ...checkpoint,
    accountId,
    shotIndex: Number(shotPosition),
    submittedAt: null,
    doubaoUrl: null,
    doubao: {
      ...checkpoint.doubao,
      jobId,
      assetId,
      shots: { ...checkpoint.doubao.shots, [shotKey]: nextShot },
      conversationResetRequired: true,
      conversationResetReason: DOUBAO_VIDEO_TIMEOUT_CODE,
      conversationResetAt: now,
    },
  };
  if (typeof persist === "function") await persist(nextCheckpoint);
  return nextCheckpoint;
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(30_000) });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error || payload?.message || `HTTP ${response.status}`);
  return payload;
}

async function waitForLoad(window, timeoutMs = 30_000) {
  const started = Date.now();
  while (window.webContents.isLoading() && Date.now() - started < timeoutMs) await wait(300);
  await wait(900);
}

async function downloadFromWindow(window, url, target, timeoutMs = 120_000) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  return new Promise((resolve, reject) => {
    const session = window.webContents.session;
    let settled = false;
    const timer = setTimeout(() => finish(new Error("下载生成结果超时")), timeoutMs);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.removeListener("will-download", onDownload);
      if (error) reject(error); else resolve(target);
    }
    function onDownload(_event, item, sourceContents) {
      if (sourceContents && sourceContents.id !== window.webContents.id) return;
      item.setSavePath(target);
      item.once("done", (_e, state) => finish(state === "completed" ? null : new Error(`下载生成结果失败：${state}`)));
    }
    session.on("will-download", onDownload);
    try { window.webContents.downloadURL(url); } catch (error) { finish(error); }
  });
}

async function readGptComposerState(window) {
  return window.webContents.executeJavaScript(`(() => {
    const visible = (node) => {
      if (!node) return false;
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden'
        && style.display !== 'none' && Number(style.opacity || 1) > 0;
    };
    const editor = ['#prompt-textarea', '[data-testid="composer-text-input"]', 'main form [contenteditable="true"]']
      .flatMap((selector) => [...document.querySelectorAll(selector)]).find(visible);
    const buttons = [...document.querySelectorAll('button')].filter(visible);
    const label = (button) => [button.getAttribute('aria-label'), button.getAttribute('data-testid'), button.textContent]
      .filter(Boolean).join(' ').replace(/\\s+/g, ' ').trim();
    const stopVisible = buttons.some((button) => /stop-button|stop generating|stop streaming|停止生成|停止回答|停止输出|停止流式|正在生成/i.test(label(button)));
    const send = buttons.find((button) => !button.disabled && button.getAttribute('aria-disabled') !== 'true'
      && /send-button|发送提示|发送消息|^发送$|^send$/i.test(label(button)));
    const editorText = editor ? String('value' in editor ? editor.value : editor.textContent || '').trim() : '';
    const bodyText = String(document.body?.innerText || '').slice(0, 120000);
    return {
      editorReady: Boolean(editor),
      editorHasText: Boolean(editorText),
      sendReady: Boolean(send),
      stopVisible,
      idleReady: Boolean(editor) && !stopVisible,
      quotaExhausted: /(?:GPT|ChatGPT|图片|图像|生图).{0,24}(?:额度|次数|限制).{0,24}(?:用完|耗尽|上限|已达|不足)|(?:usage|image generation).{0,30}(?:limit|quota).{0,20}(?:reached|exhausted)/i.test(bodyText),
    };
  })()`, true).catch(() => ({
    editorReady: false, editorHasText: false, sendReady: false, stopVisible: false, idleReady: false,
    quotaExhausted: false, probeFailed: true,
  }));
}

async function waitForGptComposerIdle(window, {
  timeoutMs = 20_000,
  pollMs = 500,
  waitImpl = wait,
} = {}) {
  const attempts = Math.max(1, Math.ceil(timeoutMs / Math.max(1, pollMs)));
  let state = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    state = await readGptComposerState(window);
    // 空输入框在 ChatGPT 上可能只显示语音图标；“有编辑器且无停止按钮”
    // 才是写入前的明确 idle 信号。如果框内已有字，还必须有可用发送按钮。
    if (state?.idleReady && (!state.editorHasText || state.sendReady)) return state;
    if (attempt + 1 < attempts) await waitImpl(pollMs);
  }
  const reason = state?.stopVisible
    ? "GPT 页面仍在生成，停止按钮尚未消失"
    : "GPT 页面仍忙，发送按钮尚未恢复";
  throw gptPageBusyError(reason);
}

async function sendPrompt(window, prompt, provider, options = {}) {
  // GPT 必须在修改输入框之前完成 idle 检查。这防止上一张图刚出现时
  // 就把下一镜提示词写进仍被 stop-button 占用的 composer。
  if (provider === "gpt") await waitForGptComposerIdle(window, options);
  const result = await window.webContents.executeJavaScript(`(async () => {
    const provider = ${JSON.stringify(provider)};
    const editorSelectors = provider === 'gpt'
      ? ['#prompt-textarea', '[data-testid="composer-text-input"]', 'main form [contenteditable="true"]']
      : ['textarea', '[contenteditable="true"][role="textbox"]', '[contenteditable="true"]'];
    const editor = editorSelectors.flatMap((selector) => [...document.querySelectorAll(selector)])
      .find((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      });
    if (!editor) return { ok:false, reason:'找不到消息输入框' };
    editor.focus();
    if ('value' in editor) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), 'value')?.set;
      if (setter) setter.call(editor, ${JSON.stringify(prompt)}); else editor.value = ${JSON.stringify(prompt)};
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection?.removeAllRanges(); selection?.addRange(range);
      if (!document.execCommand('insertText', false, ${JSON.stringify(prompt)})) editor.textContent = ${JSON.stringify(prompt)};
    }
    editor.dispatchEvent(new InputEvent('beforeinput', { bubbles:true, cancelable:true, inputType:'insertText', data:${JSON.stringify(prompt)} }));
    editor.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'insertText', data:${JSON.stringify(prompt)} }));
    editor.dispatchEvent(new Event('change', { bubbles:true }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const form = editor.closest('form');
    const scope = form || editor.closest('[class*="composer"]') || document;
    const safe = (button) => {
      const label = [button.getAttribute('aria-label'), button.getAttribute('data-testid'), button.textContent].filter(Boolean).join(' ').trim();
      if (/语音|voice|麦克风|microphone|录音|audio|speech/i.test(label)) return false;
      return provider === 'gpt'
        ? /send-button|发送提示|发送消息|^发送$|^send$/i.test(label)
        : /发送|send/i.test(label);
    };
    const findSend = () => {
      const buttons = [...scope.querySelectorAll('button:not([disabled])')];
      const doubaoArrow = provider === 'doubao' ? [...document.querySelectorAll('button:not([disabled])')]
        .filter((button) => {
          const rect = button.getBoundingClientRect();
          const editorRect = editor.getBoundingClientRect();
          const style = getComputedStyle(button);
          const visible = rect.width >= 24 && rect.height >= 24
            && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0;
          const atBottomRight = rect.left >= editorRect.left + editorRect.width * 0.60
            && rect.top >= editorRect.top + editorRect.height * 0.40
            && rect.right <= editorRect.right + 60 && rect.bottom <= editorRect.bottom + 80;
          const label = [button.getAttribute('aria-label'), button.textContent].filter(Boolean).join(' ');
          return visible && atBottomRight && !/语音|voice|麦克风|microphone|录音|audio|speech/i.test(label);
        })
        .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0] : null;
      const gptSend = provider === 'gpt' ? document.querySelector('button[data-testid="send-button"]:not([disabled])') : null;
      return gptSend
        || buttons.find((button) => button.type === 'submit' && safe(button))
        || buttons.find(safe)
        || doubaoArrow;
    };
    let send = findSend();
    // 豆包上传首帧后发送箭头会短暂 disabled；GPT 则已在写入前等到 idle，
    // 这里只等 React 把空输入框的语音按钮替换为发送按钮。
    const maxAttempts = provider === 'gpt' ? 20 : 40;
    const retryDelay = provider === 'gpt' ? 100 : 500;
    for (let attempt = 0; !send && attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      send = findSend();
    }
    if (!send || (provider === 'gpt' && !safe(send))) return {
      ok:false,
      code: provider === 'gpt' ? ${JSON.stringify(GPT_PAGE_BUSY_CODE)} : '',
      reason: provider === 'gpt'
        ? ${JSON.stringify(`${GPT_PAGE_BUSY_CODE}: GPT 页面仍忙，发送按钮尚未恢复`)}
        : '找不到明确的发送按钮；为避免误触语音已停止'
    };
    send.click();
    return { ok:true };
  })()`, true);
  if (!result?.ok) {
    if (result?.code === GPT_PAGE_BUSY_CODE) throw gptPageBusyError("GPT 页面仍忙，发送按钮尚未恢复");
    throw new Error(result?.reason || "网页提示词发送失败");
  }
}

async function generatedImages(window) {
  return window.webContents.executeJavaScript(`(() => [...document.querySelectorAll('[data-message-author-role="assistant"] img, main img')]
    .filter((img) => img.naturalWidth >= 256 && img.naturalHeight >= 256)
    .map((img) => img.currentSrc || img.src).filter(Boolean))()`, true).catch(() => []);
}

async function gptGenerationSnapshot(window) {
  const [images, composer] = await Promise.all([generatedImages(window), readGptComposerState(window)]);
  return { images, ...composer };
}

async function waitForStableGptImage(window, before, {
  timeoutMs = 5 * 60_000,
  postImageIdleTimeoutMs = 45_000,
  pollMs = 2_500,
  stablePolls = 2,
  waitImpl = wait,
  snapshotReader = gptGenerationSnapshot,
  onStableCandidate = null,
} = {}) {
  const prior = before instanceof Set ? before : new Set(before || []);
  const maxPolls = Math.max(1, Math.ceil(timeoutMs / Math.max(1, pollMs)));
  const maxBusyPollsAfterImage = Math.max(1, Math.ceil(postImageIdleTimeoutMs / Math.max(1, pollMs)));
  let candidate = "";
  let lockedCandidate = "";
  let stableCount = 0;
  let busyPollsAfterImage = 0;
  let lastSnapshot = null;
  for (let poll = 0; poll < maxPolls; poll++) {
    if (poll > 0) await waitImpl(pollMs);
    const snapshot = await snapshotReader(window);
    lastSnapshot = snapshot;
    const next = lockedCandidate
      || (Array.isArray(snapshot?.images) ? snapshot.images : []).find((url) => !prior.has(url));
    if (!next) continue;
    if (lockedCandidate || next === candidate) stableCount += 1;
    else { candidate = next; stableCount = 1; }
    if (!lockedCandidate && stableCount >= Math.max(1, stablePolls)) {
      lockedCandidate = next;
      candidate = next;
      // 稳定图片一出现就先落盘并写断点。composer 仍忙只阻止下一镜发送，
      // 不能让 45 秒后的短重试又消耗一次生图额度。
      if (onStableCandidate) await onStableCandidate(lockedCandidate, snapshot);
    }
    const composerRestored = snapshot?.idleReady && !snapshot?.stopVisible
      && (!snapshot?.editorHasText || snapshot?.sendReady);
    if (lockedCandidate && composerRestored) return lockedCandidate;
    if (!composerRestored) {
      busyPollsAfterImage += 1;
      if (busyPollsAfterImage >= maxBusyPollsAfterImage) {
        throw gptPageBusyError("GPT 新图已出现，但页面仍忙，发送按钮尚未恢复");
      }
    }
  }
  if (candidate) throw gptPageBusyError("GPT 新图已出现，但页面没有恢复为可发送状态");
  if (lastSnapshot?.quotaExhausted) {
    const error = new Error("GPT 图片生成额度已用完，请在额度恢复后重试原断点");
    error.code = "GPT_QUOTA_EXHAUSTED";
    throw error;
  }
  throw gptImageTimeoutError();
}

async function generateGptImage(window, prompt, target, options = {}) {
  const before = new Set(await generatedImages(window));
  const send = options.sendPromptImpl || sendPrompt;
  await send(window, `请根据下面提示直接生成一张 9:16 竖屏分镜首帧，只输出图片，不要解释。\n\n${prompt}`, "gpt", options);
  const download = options.downloadImpl || downloadFromWindow;
  let downloadedPath = null;
  await waitForStableGptImage(window, before, {
    ...options,
    onStableCandidate: async (next, snapshot) => {
      downloadedPath = await download(window, next, target);
      if (options.onDownloaded) await options.onDownloaded(downloadedPath, { url: next, snapshot });
      if (options.onStableCandidate) await options.onStableCandidate(next, snapshot);
    },
  });
  if (!downloadedPath) throw new Error("GPT 新图已完成但未能保存到断点");
  return downloadedPath;
}

async function inspectAndActivateDoubaoEntry(window, allowCreative, activate = true) {
  return window.webContents.executeJavaScript(`(() => {
    const nodes = [...document.querySelectorAll('button, a[href], [role="button"], [role="tab"], [tabindex="0"]')];
    const rows = nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden'
        && style.display !== 'none' && Number(style.opacity || 1) > 0;
      const label = [node.getAttribute('aria-label'), node.getAttribute('title'), node.innerText, node.textContent]
        .map((value) => String(value || '').replace(/\\s+/g, ' ').trim()).find(Boolean) || '';
      const enabled = !node.matches(':disabled') && node.getAttribute('aria-disabled') !== 'true';
      return { label: label.slice(0, 80), href: String(node.getAttribute('href') || '').slice(0, 240), visible, enabled };
    });
    const editor = ['textarea', '[contenteditable="true"][role="textbox"]', '[contenteditable="true"]']
      .flatMap((selector) => [...document.querySelectorAll(selector)])
      .find((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      });
    const bodyText = (document.body?.innerText || '').slice(0, 120000);
    // 复用上一条 Seedance 会话时入口按钮可能消失；明确的视频任务状态 + 可用编辑器
    // 说明已经在视频模式。这里只读 DOM 文本，不打开或播放任何媒体。
    const modeReady = Boolean(editor) && /视频生成中|视频生成已提交|你的视频生成好了|预计等待\\s*\\d+\\s*分钟/.test(bodyText);
    const decide = ${doubaoVideoEntryDecision.toString()};
    const decision = decide(rows, location.href, { allowCreative: ${allowCreative ? "true" : "false"}, modeReady });
    if (${activate ? "true" : "false"} && decision.status === 'click') nodes[decision.index]?.click();
    return decision;
  })()`, true);
}

async function waitForDoubaoEntry(window, allowCreative, timeoutMs) {
  const started = Date.now();
  let result = null;
  do {
    result = await inspectAndActivateDoubaoEntry(window, allowCreative);
    if (result?.status !== "missing") return result;
    await wait(500);
  } while (Date.now() - started < timeoutMs);
  return result;
}

async function activateDoubaoVideoMode(window) {
  let result = await waitForDoubaoEntry(window, false, 8_000);
  if (result?.status === "already" || result?.status === "click") {
    if (result.status === "click") await wait(1000);
    return;
  }
  if (result?.status === "ambiguous") {
    throw new Error(`豆包“视频生成”入口不唯一，已停止避免误触（${result.diagnostics.join("、") || "无安全标签"}）`);
  }

  const creative = await waitForDoubaoEntry(window, true, 5_000);
  if (creative?.status === "ambiguous") {
    throw new Error(`豆包“创作”入口不唯一，已停止避免误触（${creative.diagnostics.join("、") || "无安全标签"}）`);
  }
  if (creative?.status === "click" && creative.kind === "video") {
    await wait(1000);
    return;
  }
  if (creative?.status === "click" && creative.kind === "creative") {
    await wait(1400);
    result = await waitForDoubaoEntry(window, false, 10_000);
    if (result?.status === "already" || result?.status === "click") {
      if (result.status === "click") await wait(1000);
      return;
    }
  }
  const pathname = result?.pathname || creative?.pathname || "/";
  const labels = [...new Set([...(result?.diagnostics || []), ...(creative?.diagnostics || [])])].slice(0, 8);
  throw new Error(`豆包页面找不到明确的“视频生成”入口（页面 ${pathname}${labels.length ? `；可见相关标签：${labels.join("、")}` : ""}）`);
}

async function attachFile(window, filePath) {
  const bytes = await fsp.readFile(filePath);
  const b64 = bytes.toString("base64");
  const name = path.basename(filePath);
  const result = await window.webContents.executeJavaScript(`(async () => {
    let input = document.querySelector('input[type="file"]');
    if (!input) {
      const button = [...document.querySelectorAll('button')].find((item) => /上传|添加|图片/.test((item.getAttribute('aria-label') || '') + (item.textContent || '')));
      button?.click(); await new Promise((resolve) => setTimeout(resolve, 500));
      input = document.querySelector('input[type="file"]');
    }
    if (!input) return { ok:false, reason:'找不到图片上传入口' };
    const raw = atob(${JSON.stringify(b64)}); const data = new Uint8Array(raw.length);
    for (let i=0;i<raw.length;i++) data[i]=raw.charCodeAt(i);
    const file = new File([data], ${JSON.stringify(name)}, { type:'image/png' });
    const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles:true }));
    return { ok:true };
  })()`, true);
  if (!result?.ok) throw new Error(result?.reason || "豆包首帧上传失败");
  await wait(1200);
}

async function doubaoResultSnapshot(window) {
  const candidates = await window.webContents.executeJavaScript(`(() => {
    const videoModels = [];
    const seenObjects = new WeakSet();
    const collectVideoModels = (value, depth = 0) => {
      if (videoModels.length >= 24 || depth > 8 || value == null) return;
      if (typeof value !== 'object' && typeof value !== 'function') return;
      if (seenObjects.has(value)) return;
      seenObjects.add(value);
      for (const [key, child] of Object.entries(value).slice(0, 120)) {
        if (key === 'videoModel' && typeof child === 'string') videoModels.push(child);
        else collectVideoModels(child, depth + 1);
      }
    };
    const resultMessages = [...document.querySelectorAll('[data-message-id]')]
      .filter((node) => String(node.innerText || '').includes('你的视频生成好了'));
    for (const message of resultMessages.slice(-12)) {
      const covers = [...message.querySelectorAll('img')]
        .filter((img) => /cover/i.test(String(img.className || '')) || img.closest('[class*="block-video"]'));
      for (const cover of covers) {
        for (let node = cover, depth = 0; node && depth < 7; node = node.parentElement, depth++) {
          const propsKey = Object.keys(node).find((key) => key.startsWith('__reactProps'));
          if (propsKey) collectVideoModels(node[propsKey]);
          if (node === message) break;
        }
      }
    }
    const modelResults = (${doubaoVideoModelResults.toString()})(videoModels);
    const identifyUrl = (${doubaoUrlResultIdentity.toString()});
    const modelUrlIdentities = new Set(modelResults.map((entry) => identifyUrl(entry.url)).filter(Boolean));
    const standardUrls = [...new Set([...document.querySelectorAll('video')]
      .flatMap((video) => [video.currentSrc, video.src, ...[...video.querySelectorAll('source')].map((source) => source.src)])
      .map((url) => String(url || '')).filter((url) => /^(?:https?:|blob:)/i.test(url)))];
    const standardResults = standardUrls.filter((url) => !modelUrlIdentities.has(identifyUrl(url))).map((url) => ({
      identity: identifyUrl(url),
      url,
      score: 0,
      codec: '',
      definition: '',
    })).filter((entry) => entry.identity);
    return [...modelResults, ...standardResults].slice(-32);
  })()`, true).catch(() => []);
  return (Array.isArray(candidates) ? candidates : []).filter((entry) => entry
    && typeof entry.identity === "string" && entry.identity.length <= 96
    && /^(?:https?:|blob:)/i.test(String(entry.url || "")));
}

async function doubaoAttemptSnapshot(window) {
  const raw = await window.webContents.executeJavaScript(`(() => {
    const text = (document.body?.innerText || '').slice(0, 120000);
    const finishStates = [];
    let visited = 0;
    const seen = new WeakSet();
    const inspect = (value, depth = 0) => {
      if (visited >= 20000 || depth > 10 || value == null
        || (typeof value !== 'object' && typeof value !== 'function') || seen.has(value)) return;
      seen.add(value); visited += 1;
      for (const key of Object.keys(value).slice(0, 160)) {
        let child;
        try { child = value[key]; } catch { continue; }
        if (key === 'assistantFinishState' && typeof child === 'boolean') finishStates.push(child);
        else inspect(child, depth + 1);
      }
    };
    const messageNodes = [...document.querySelectorAll('[data-message-id]')].slice(-8).reverse();
    for (const node of messageNodes) {
      const localStart = finishStates.length;
      for (const key of Object.getOwnPropertyNames(node)) {
        if (key.startsWith('__reactProps') || key.startsWith('__reactFiber')) inspect(node[key]);
      }
      if (finishStates.length > localStart) break;
    }
    if (!finishStates.length) {
      for (const node of [...document.querySelectorAll('main, [role="main"]')].slice(-2)) {
        for (const key of Object.getOwnPropertyNames(node)) {
          if (key.startsWith('__reactProps') || key.startsWith('__reactFiber')) inspect(node[key]);
        }
      }
    }
    const uniqueFinishStates = [...new Set(finishStates)];
    return {
      loginRequired: /登录后使用|立即登录|手机号登录/.test(text),
      quotaExhausted: /(?:免费|今日|生成|视频).{0,16}(?:次数|额度).{0,16}(?:用完|不足|耗尽|上限)|(?:次数|额度).{0,16}(?:用完|不足|耗尽|上限)/i.test(text),
      authorizationRequired: /安全确认/.test(text) && /上传、使用的素材|均已获充分授权|无侵权违法风险/.test(text),
      assistantFinishState: uniqueFinishStates.length === 1 ? uniqueFinishStates[0] : 'unknown',
    };
  })()`, true).catch(() => null);
  const loginFromUrl = /login|passport/.test(String(window.webContents.getURL?.() || ""));
  if (!raw || typeof raw.loginRequired !== "boolean" || typeof raw.quotaExhausted !== "boolean"
    || typeof raw.authorizationRequired !== "boolean"
    || ![true, false, "unknown"].includes(raw.assistantFinishState)) {
    return {
      loginRequired: loginFromUrl ? true : "unknown",
      quotaExhausted: "unknown",
      authorizationRequired: "unknown",
      assistantFinishState: "unknown",
      probeFailed: true,
    };
  }
  return {
    loginRequired: raw.loginRequired || loginFromUrl,
    quotaExhausted: raw.quotaExhausted,
    authorizationRequired: raw.authorizationRequired,
    assistantFinishState: raw.assistantFinishState,
    probeFailed: false,
  };
}

async function waitForDoubaoVideo(window, before, target, onProgress = null, {
  expectedIdentity = "",
  timeoutMs = 12 * 60_000,
  pollMs = 4_000,
  nowImpl = Date.now,
  waitImpl = wait,
  snapshotReader = doubaoResultSnapshot,
  attemptStateReader = doubaoAttemptSnapshot,
  downloadImpl = downloadFromWindow,
} = {}) {
  const baseline = before instanceof Set ? before : new Set(before || []);
  const started = nowImpl();
  let authorizationGateOpenedAt = 0;
  let lastReportedUrl = "";
  let lastAttemptState = null;
  let loginRequiredSeen = false;
  let quotaExhaustedSeen = false;
  let authorizationRequiredSeen = false;
  const observedNewIdentities = new Set();
  while (nowImpl() - started < timeoutMs) {
    const currentUrl = window.webContents.getURL();
    if (onProgress && currentUrl && currentUrl !== lastReportedUrl) {
      lastReportedUrl = currentUrl;
      await onProgress(currentUrl);
    }
    const attemptState = await attemptStateReader(window).catch(() => ({
      loginRequired: "unknown",
      quotaExhausted: "unknown",
      authorizationRequired: "unknown",
      assistantFinishState: "unknown",
      probeFailed: true,
    }));
    lastAttemptState = attemptState;
    loginRequiredSeen ||= attemptState?.loginRequired === true;
    quotaExhaustedSeen ||= attemptState?.quotaExhausted === true;
    authorizationRequiredSeen ||= attemptState?.authorizationRequired === true;
    const authorizationGate = attemptState?.authorizationRequired === true;
    if (authorizationGate) {
      if (!authorizationGateOpenedAt) {
        authorizationGateOpenedAt = nowImpl() || 1;
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        if (onProgress) {
          await onProgress(currentUrl, {
            type: "authorization_required",
            error: "豆包需要确认素材授权：请在已打开的安全确认窗口完成确认；织台已保存断点并继续等待，不会重复提交",
          });
        }
      }
      await waitImpl(pollMs);
      continue;
    }
    const candidates = await snapshotReader(window);
    for (const candidate of candidates) {
      if (candidate?.identity && !baseline.has(candidate.identity)) observedNewIdentities.add(candidate.identity);
    }
    const decision = selectNewDoubaoResult(candidates, baseline, expectedIdentity);
    if (decision.status === "ready") {
      if (onProgress) await onProgress(currentUrl, {
        type: "result_ready",
        resultIdentity: decision.result.identity,
      });
      const downloadedPath = await downloadImpl(window, decision.result.url, target, 180_000);
      return { path: downloadedPath, resultIdentity: decision.result.identity };
    }
    if (decision.status === "ambiguous") {
      throw doubaoResultIdentityError("发送后出现多个新结果，已停止避免下载错误镜头");
    }
    await waitImpl(pollMs);
  }
  if (authorizationGateOpenedAt) throw new Error("等待你确认豆包素材授权超时；任务未重复提交，可打开原会话确认后继续");
  if (observedNewIdentities.size) {
    if (onProgress) await onProgress(lastReportedUrl || window.webContents.getURL(), {
      type: "unexpected_result",
      hasNewResultIdentity: true,
    });
    throw doubaoUnexpectedResultError("等待断点结果时出现了其他新 identity，已停止以避免重复提交或绑错镜头");
  }
  const timeoutEvidence = {
    noNewResultIdentity: true,
    loginRequired: loginRequiredSeen ? true : lastAttemptState?.loginRequired,
    quotaExhausted: quotaExhaustedSeen ? true : lastAttemptState?.quotaExhausted,
    authorizationRequired: authorizationRequiredSeen ? true : lastAttemptState?.authorizationRequired,
    assistantFinishState: lastAttemptState?.assistantFinishState ?? "unknown",
    probeFailed: lastAttemptState?.probeFailed !== false,
  };
  if (onProgress) await onProgress(lastReportedUrl || window.webContents.getURL(), {
    type: "result_timeout",
    noNewResultIdentity: true,
    timeoutEvidence,
  });
  if (!safeDoubaoTimeoutEvidence(timeoutEvidence)) {
    throw doubaoUnsafeTimeoutError("本轮虽无新 result identity，但登录、额度、授权门或 assistantFinishState 证据不完整，禁止自动重提", timeoutEvidence);
  }
  throw doubaoVideoTimeoutError(undefined, timeoutEvidence);
}

async function generateDoubaoClip(window, imagePath, prompt, negativePrompt, durationSeconds, target, onSubmitted = null, {
  inputFingerprint = "",
  attemptNumber = 1,
  activateImpl = activateDoubaoVideoMode,
  snapshotReader = doubaoResultSnapshot,
  attachImpl = attachFile,
  sendPromptImpl = sendPrompt,
  waitForVideoImpl = waitForDoubaoVideo,
} = {}) {
  await activateImpl(window);
  const before = new Set((await snapshotReader(window)).map((entry) => entry.identity));
  await attachImpl(window, imagePath);
  if (onSubmitted) await onSubmitted(window.webContents.getURL(), {
    type: "sending",
    baselineIdentities: [...before],
    inputFingerprint,
    attemptNumber: Number(attemptNumber) === 2 ? 2 : 1,
  });
  await sendPromptImpl(window, `${prompt}${negativePrompt ? `\n\n禁止：${negativePrompt}` : ""}\n\n生成 ${Math.max(1, Math.min(10, Number(durationSeconds) || 10))} 秒、9:16 竖屏视频。`, "doubao");
  if (onSubmitted) await onSubmitted(window.webContents.getURL(), {
    type: "submitted",
    baselineIdentities: [...before],
    inputFingerprint,
    attemptNumber: Number(attemptNumber) === 2 ? 2 : 1,
  });
  return waitForVideoImpl(window, before, target, onSubmitted);
}

async function concatClips(clips, output) {
  if (!clips.length) throw new Error("没有可拼接的视频片段");
  if (clips.length === 1) { await fsp.copyFile(clips[0], output); return output; }
  const list = `${output}.concat.txt`;
  await fsp.writeFile(list, clips.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n") + "\n", "utf8");
  await new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", output], { stdio: "ignore" });
    child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg 拼接失败：${code}`)));
  });
  await fsp.rm(list, { force: true });
  return output;
}

function compatibleLocalMotionManifest(existing, expected) {
  return existing?.schemaVersion === 1
    && existing?.engine === LOCAL_MOTION_ENGINE
    && existing?.evidenceMode === "local_storyboard_motion"
    && existing?.jobId === expected.jobId
    && existing?.assetId === expected.assetId
    && existing?.pipelineVersion === LOCAL_MOTION_PIPELINE_VERSION
    && existing?.storyboardFingerprint === expected.storyboardFingerprint
    && canonicalJson(existing?.preset) === canonicalJson(expected.preset)
    && canonicalJson(existing?.trigger) === canonicalJson(expected.trigger)
    && canonicalJson(existing?.environment) === canonicalJson(expected.environment)
    && existing?.manifestSha256 === localMotionManifestSha256(existing);
}

async function generateLocalMotionVisual({
  outputDir,
  jobId,
  assetId,
  images,
  shots,
  checkpoint,
  trigger,
  ffmpegPath = FFMPEG,
  ffprobePath = FFPROBE,
  runCommandImpl = runSilentCommand,
  inspectStoryboardImpl = inspectStoryboard,
  probeVideoImpl,
  nowImpl = () => new Date().toISOString(),
} = {}) {
  const resumeGate = localMotionResumeDecision({ checkpoint, jobId, assetId });
  if (resumeGate.action !== "resume" || canonicalJson(resumeGate.trigger) !== canonicalJson(trigger)) {
    throw new Error("本地动画触发证据不是精确的豆包孤儿恢复耗尽或全账号额度耗尽证据");
  }
  const validated = await validateLocalMotionStoryboards({
    images, shots, checkpoint, jobId, assetId, inspectStoryboardImpl,
  });
  const probe = probeVideoImpl || ((filePath) => probeLocalMotionVideo(filePath, { ffprobePath, runCommandImpl }));
  const environment = {
    ffmpegVersion: await executableVersion(ffmpegPath, runCommandImpl),
    ffprobeVersion: await executableVersion(ffprobePath, runCommandImpl),
  };
  if (!environment.ffmpegVersion || !environment.ffprobeVersion) {
    throw new Error("本地动画无法读取 FFmpeg/ffprobe 版本，已停止");
  }
  const manifestPath = path.join(outputDir, LOCAL_MOTION_MANIFEST);
  const expected = {
    jobId,
    assetId,
    preset: localMotionPreset(),
    trigger,
    environment,
    ...validated,
  };
  let existing = null;
  try { existing = JSON.parse(await fsp.readFile(manifestPath, "utf8")); } catch { /* 首次本地生成 */ }
  const canResume = compatibleLocalMotionManifest(existing, expected);
  let manifest = {
    schemaVersion: 1,
    status: "in_progress",
    engine: LOCAL_MOTION_ENGINE,
    evidenceMode: "local_storyboard_motion",
    jobId,
    assetId,
    pipelineVersion: LOCAL_MOTION_PIPELINE_VERSION,
    preset: expected.preset,
    trigger,
    environment,
    storyboardFingerprint: validated.storyboardFingerprint,
    storyboards: validated.storyboards,
    segments: canResume && Array.isArray(existing.segments) ? [...existing.segments] : [],
    visualVideo: canResume ? existing.visualVideo || null : null,
    finalVideo: canResume ? existing.finalVideo || null : null,
    audioQuality: canResume ? existing.audioQuality || null : null,
    workflow: canResume ? existing.workflow || null : null,
    createdAt: canResume ? existing.createdAt : nowImpl(),
    updatedAt: nowImpl(),
    completedAt: canResume ? existing.completedAt || null : null,
  };
  manifest = await writeLocalMotionManifest(manifestPath, manifest);

  const segmentPaths = [];
  const segmentDurationMs = Math.round((LOCAL_MOTION_SEGMENT_FRAMES / LOCAL_MOTION_FPS) * 1_000);
  for (let i = 0; i < validated.storyboards.length; i++) {
    const storyboard = validated.storyboards[i];
    const clipName = `clip-${String(i + 1).padStart(2, "0")}.mp4`;
    const target = path.join(outputDir, clipName);
    const recorded = manifest.segments.find((segment) => Number(segment?.index) === i + 1);
    const artifact = recorded
      && recorded.sourceStoryboard === storyboard.name
      && recorded.sourceStoryboardSha256 === storyboard.sha256
      && recorded.clipName === clipName
      ? await inspectLocalMotionArtifact(target, {
        expectedFrames: LOCAL_MOTION_SEGMENT_FRAMES,
        expectedDurationMs: segmentDurationMs,
        probeVideoImpl: probe,
      }) : null;
    let verified = artifact && recorded.clipSha256 === artifact.sha256
      && Number(recorded.clipSizeBytes) === artifact.sizeBytes ? artifact : null;
    if (!verified) {
      const temporary = `${target}.local-motion-${process.pid}-${Date.now()}.tmp.mp4`;
      try {
        await runCommandImpl(ffmpegPath, localMotionSegmentArgs({
          imagePath: images[i], outputPath: temporary, segmentIndex: i + 1,
        }), { timeoutMs: 600_000 });
        verified = await inspectLocalMotionArtifact(temporary, {
          expectedFrames: LOCAL_MOTION_SEGMENT_FRAMES,
          expectedDurationMs: segmentDurationMs,
          probeVideoImpl: probe,
        });
        if (!verified) throw new Error(`本地动画第 ${i + 1} 段未通过 250 帧/30fps/1080x1920/H264 验证`);
        await fsp.rename(temporary, target);
      } catch (error) {
        await fsp.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    }
    const entry = {
      index: i + 1,
      name: LOCAL_MOTION_MOTIONS[i].name,
      sourceStoryboard: storyboard.name,
      sourceStoryboardSha256: storyboard.sha256,
      clipName,
      clipSha256: verified.sha256,
      clipSizeBytes: verified.sizeBytes,
      frameCount: verified.totalFrames,
      fps: verified.fps,
      durationMs: verified.durationMs,
      width: verified.width,
      height: verified.height,
    };
    manifest.segments = manifest.segments.filter((segment) => Number(segment?.index) !== i + 1);
    manifest.segments.push(entry);
    manifest.segments.sort((a, b) => Number(a.index) - Number(b.index));
    manifest.status = "in_progress";
    manifest.updatedAt = nowImpl();
    manifest = await writeLocalMotionManifest(manifestPath, manifest);
    segmentPaths.push(target);
  }
  if (new Set(manifest.segments.map((segment) => segment.clipSha256)).size !== 3) {
    throw new Error("本地动画三个输出段 SHA-256 重复，已停止避免重复画面");
  }

  const visualPath = path.join(outputDir, "final.visual.mp4");
  let visual = manifest.visualVideo
    ? await inspectLocalMotionArtifact(visualPath, {
      expectedFrames: LOCAL_MOTION_TOTAL_FRAMES,
      expectedDurationMs: LOCAL_MOTION_DURATION_MS,
      probeVideoImpl: probe,
    }) : null;
  if (!visual || manifest.visualVideo.sha256 !== visual.sha256
    || Number(manifest.visualVideo.sizeBytes) !== visual.sizeBytes) {
    const listPath = path.join(outputDir, `.local-motion-concat-${process.pid}-${Date.now()}.txt`);
    const temporary = `${visualPath}.local-motion-${process.pid}-${Date.now()}.tmp.mp4`;
    const concatText = `${segmentPaths.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n")}\n`;
    try {
      await fsp.writeFile(listPath, concatText, "utf8");
      await runCommandImpl(ffmpegPath, localMotionConcatArgs({ listPath, outputPath: temporary }), { timeoutMs: 300_000 });
      visual = await inspectLocalMotionArtifact(temporary, {
        expectedFrames: LOCAL_MOTION_TOTAL_FRAMES,
        expectedDurationMs: LOCAL_MOTION_DURATION_MS,
        probeVideoImpl: probe,
      });
      if (!visual) throw new Error("本地动画总片未通过 750 帧/25秒/30fps/1080x1920/H264 验证");
      await fsp.rename(temporary, visualPath);
    } catch (error) {
      await fsp.rm(temporary, { force: true }).catch(() => {});
      throw error;
    } finally {
      await fsp.rm(listPath, { force: true }).catch(() => {});
    }
  }
  manifest.visualVideo = {
    name: path.basename(visualPath),
    sizeBytes: visual.sizeBytes,
    sha256: visual.sha256,
    width: visual.width,
    height: visual.height,
    fps: visual.fps,
    totalFrames: visual.totalFrames,
    durationMs: visual.durationMs,
    codec: visual.codec,
    pixelFormat: visual.pixelFormat,
  };
  manifest.status = "visual_completed";
  manifest.updatedAt = nowImpl();
  manifest = await writeLocalMotionManifest(manifestPath, manifest, { includeProvenance: true });
  return { engine: LOCAL_MOTION_ENGINE, manifestPath, manifest, segmentPaths, visualPath };
}

async function finalizeLocalMotionManifest({
  manifestPath,
  finalVideoPath,
  audioQualityPath,
  workflow,
  probeVideoImpl = probeLocalMotionVideo,
  nowImpl = () => new Date().toISOString(),
} = {}) {
  const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf8"));
  if (!["visual_completed", "completed"].includes(manifest.status)
    || manifest.engine !== LOCAL_MOTION_ENGINE
    || manifest.manifestSha256 !== localMotionManifestSha256(manifest)
    || manifest.generationProvenanceSha256 !== localMotionGenerationProvenanceSha256(manifest)) {
    throw new Error("本地动画 manifest 完整性验证失败，未绑定最终音频成片");
  }
  const finalVideo = await inspectLocalMotionArtifact(finalVideoPath, {
    expectedFrames: LOCAL_MOTION_TOTAL_FRAMES,
    expectedDurationMs: LOCAL_MOTION_DURATION_MS,
    allowAudio: true,
    probeVideoImpl,
  });
  if (!finalVideo) throw new Error("本地动画最终成片未通过 750 帧/25秒/AAC 验证");
  const audioQualityBytes = await fsp.readFile(audioQualityPath);
  let audioQualityReport;
  try { audioQualityReport = JSON.parse(audioQualityBytes.toString("utf8")); }
  catch { throw new Error("本地动画音频质检报告不是有效 JSON"); }
  const narration = String(audioQualityReport.narration || "");
  const narrationSha256 = sha256(narration);
  if (audioQualityReport.status !== "passed" || audioQualityReport.narrationComplete !== true
    || audioQualityReport.timingVerified !== true || !narration.trim()
    || audioQualityReport.narrationSha256 !== narrationSha256
    || audioQualityReport.outputSha256 !== finalVideo.sha256
    || Number(audioQualityReport.outputSizeBytes) !== finalVideo.sizeBytes
    || Number(audioQualityReport.finalDurationMs) !== LOCAL_MOTION_DURATION_MS
    || !Number.isFinite(Number(audioQualityReport.narrationDurationMs))
    || Number(audioQualityReport.narrationDurationMs) <= 0
    || Number(audioQualityReport.narrationDurationMs) > LOCAL_MOTION_DURATION_MS - 50
    || !Number.isFinite(Number(audioQualityReport.outputDurationMs))
    || Math.abs(Number(audioQualityReport.outputDurationMs) - LOCAL_MOTION_DURATION_MS) > 80
    || !Number.isFinite(Number(audioQualityReport.meanVolumeDb)) || Number(audioQualityReport.meanVolumeDb) < -34
    || !Number.isFinite(Number(audioQualityReport.maxVolumeDb)) || Number(audioQualityReport.maxVolumeDb) < -18) {
    throw new Error("本地动画最终音频/旁白完整性证据未通过");
  }
  const next = {
    ...manifest,
    status: "completed",
    finalVideo: {
      name: path.basename(finalVideoPath),
      sizeBytes: finalVideo.sizeBytes,
      sha256: finalVideo.sha256,
      width: finalVideo.width,
      height: finalVideo.height,
      fps: finalVideo.fps,
      totalFrames: finalVideo.totalFrames,
      durationMs: finalVideo.durationMs,
      codec: finalVideo.codec,
      pixelFormat: finalVideo.pixelFormat,
      audio: {
        codec: finalVideo.audioCodec,
        durationMs: finalVideo.audioDurationMs,
        narrationComplete: true,
      },
    },
    audioQuality: {
      name: path.basename(audioQualityPath),
      sha256: sha256(audioQualityBytes),
      sizeBytes: audioQualityBytes.length,
      status: "passed",
      narrationComplete: true,
      narrationSha256,
      narrationDurationMs: Number(audioQualityReport.narrationDurationMs),
      finalDurationMs: Number(audioQualityReport.finalDurationMs),
      meanVolumeDb: Number(audioQualityReport.meanVolumeDb),
      maxVolumeDb: Number(audioQualityReport.maxVolumeDb),
    },
    workflow: {
      name: "remake_plan.plan.seedanceWorkflow",
      sha256: sha256(canonicalJson(workflow || {})),
    },
    updatedAt: nowImpl(),
    completedAt: nowImpl(),
  };
  return writeLocalMotionManifest(manifestPath, next, { includeProvenance: true });
}

async function removeSeedanceWatermark(input, output) {
  try {
    await Promise.all([fsp.access(WATERMARK_PYTHON), fsp.access(WATERMARK_SCRIPT), fsp.access(FFMPEG)]);
  } catch {
    throw new Error("豆包视频已下载，但织台去水印引擎尚未安装；为避免交付带水印成片，本次已停止");
  }
  await fsp.rm(output, { force: true });
  await new Promise((resolve, reject) => {
    const child = spawn(WATERMARK_PYTHON, [WATERMARK_SCRIPT, input, "-o", output], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PATH: `${path.dirname(FFMPEG)}:${process.env.PATH || "/usr/bin:/bin"}` },
    });
    let errorText = "";
    child.stderr.on("data", (chunk) => { errorText += chunk.toString(); if (errorText.length > 8_000) errorText = errorText.slice(-8_000); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`豆包视频去水印失败（${code}）${errorText ? `：${errorText.slice(-300)}` : ""}`)));
  });
  const result = await fsp.stat(output).catch(() => null);
  if (!result?.isFile() || result.size < 1_024) throw new Error("豆包视频去水印没有生成有效文件");
  await fsp.rm(input, { force: true });
  return output;
}

async function prepareGptConversation(window, {
  jobId,
  checkpoint = null,
  waitForStudio = waitForLoad,
  onCheckpoint = null,
} = {}) {
  const savedGpt = checkpoint?.gpt?.jobId === jobId ? checkpoint.gpt : null;
  const savedUrl = isChatGptConversationUrl(savedGpt?.conversationUrl) ? savedGpt.conversationUrl : "";
  const targetUrl = savedUrl || "https://chatgpt.com/";
  const currentUrl = window.webContents.getURL();
  // 不点击可能因语言/版本改变的“新建对话”文字：新 job 直接回到官方根地址，
  // 断点 job 则回到自己已记录的 /c/<id> 地址。这样各 job 不共用上一个主题上下文。
  if (!savedUrl || currentUrl !== targetUrl) {
    await window.loadURL(targetUrl);
    await waitForStudio(window);
  }
  const nextCheckpoint = {
    ...(checkpoint && typeof checkpoint === "object" ? checkpoint : {}),
    gpt: {
      ...(checkpoint?.gpt && typeof checkpoint.gpt === "object" ? checkpoint.gpt : {}),
      jobId,
      conversationUrl: savedUrl || null,
      startedAt: savedGpt?.startedAt || new Date().toISOString(),
    },
  };
  if (onCheckpoint) await onCheckpoint(nextCheckpoint);
  return nextCheckpoint;
}

async function ensureGptStoryboards({
  shots,
  outputDir,
  jobId,
  assetId,
  checkpoint = null,
  checkpointPath = path.join(outputDir, "run-state.json"),
  getGptWindow,
  inspectStoryboardImpl = inspectStoryboard,
  generateGptImageImpl = generateGptImage,
  writeCheckpointImpl = writeRunCheckpoint,
  trustedLegacyStoryboards = [],
} = {}) {
  let state = {
    ...(checkpoint && typeof checkpoint === "object" ? checkpoint : {}),
    jobId,
    assetId,
  };
  const previousGpt = state.gpt && typeof state.gpt === "object" ? state.gpt : {};
  // manifest 的作用域必须同时匹配 job + asset。只有 jobId 相同不足以
  // 证明图片是由当前素材/提示词生成的。
  const sameGptScope = previousGpt.jobId === jobId && previousGpt.assetId === assetId;
  state.gpt = {
    ...(sameGptScope ? previousGpt : {}),
    jobId,
    assetId,
    storyboards: sameGptScope && previousGpt.storyboards && typeof previousGpt.storyboards === "object"
      ? { ...previousGpt.storyboards }
      : {},
  };
  const images = [];
  const reusedIndices = [];
  const generatedIndices = [];
  let gptWindow = null;

  const persist = async () => {
    state.gpt.updatedAt = new Date().toISOString();
    await writeCheckpointImpl(checkpointPath, state);
  };

  for (const shot of Array.isArray(shots) ? shots : []) {
    const shotKey = String(shot.index);
    const target = path.join(outputDir, `storyboard-${String(shot.index).padStart(2, "0")}.png`);
    const promptHash = sha256(String(shot.imagePrompt || ""));
    let recorded = state.gpt.storyboards[shotKey];
    let metadata = await inspectStoryboardImpl(target);
    const duplicateStoryboard = metadata ? Object.entries(state.gpt.storyboards)
      .find(([otherKey, other]) => Number(otherKey) < Number(shotKey) && other?.sha256 === metadata.sha256) : null;
    if (duplicateStoryboard) {
      // 同一字节文件不能同时证明两个不同提示词的镜头。删除当前重复件并清空
      // 会话，让本轮只重生当前镜；前序已验 SHA 的镜头继续复用。
      await fsp.rm(target, { force: true });
      delete state.gpt.storyboards[shotKey];
      recorded = null;
      metadata = null;
      state.gpt.lastBusyConversationUrl = state.gpt.conversationUrl || null;
      state.gpt.conversationUrl = null;
      state.gpt.conversationResetReason = "GPT_DUPLICATE_STORYBOARD_REGENERATE";
      state.gpt.conversationResetAt = new Date().toISOString();
      await persist();
    }
    // 普通复用必须有完整 manifest 证据：同一 job+asset 作用域、当前
    // promptHash 与当前文件 SHA。单纯“图片能解码”绝不能自动认领。
    const manifestTrusted = Boolean(metadata && recorded
      && recorded.promptHash === promptHash
      && recorded.sha256 === metadata.sha256);
    const legacyMigration = metadata && !recorded
      ? trustedLegacyStoryboards.find((entry) => entry
        && entry.jobId === jobId
        && entry.assetId === assetId
        && Number(entry.shotIndex) === Number(shot.index)
        && entry.promptHash === promptHash
        && entry.sha256 === metadata.sha256
        && (!Number.isFinite(Number(entry.sizeBytes)) || Number(entry.sizeBytes) === Number(metadata.sizeBytes))
        && (!Number.isFinite(Number(entry.width)) || Number(entry.width) === Number(metadata.width))
        && (!Number.isFinite(Number(entry.height)) || Number(entry.height) === Number(metadata.height)))
      : null;
    if (manifestTrusted || legacyMigration) {
      images.push(target);
      reusedIndices.push(shot.index);
      state.gpt.storyboards[shotKey] = {
        ...metadata,
        promptHash,
        completedAt: recorded?.completedAt || new Date().toISOString(),
        legacyMigrationId: legacyMigration?.migrationId || recorded?.legacyMigrationId,
        legacyMigratedAt: legacyMigration ? new Date().toISOString() : recorded?.legacyMigratedAt,
      };
      await persist();
      continue;
    }

    if (!gptWindow) {
      if (typeof getGptWindow !== "function") throw new Error("缺少 GPT 生图窗口");
      const opened = await getGptWindow(state, async (nextState) => {
        state = nextState;
        await persist();
      });
      gptWindow = opened?.window || opened;
      if (!gptWindow?.webContents) throw new Error("GPT 窗口未打开");
    }
    let checkpointedGeneratedPath = null;
    const checkpointDownloadedStoryboard = async (downloadedPath) => {
      metadata = await inspectStoryboardImpl(downloadedPath || target);
      if (!metadata) throw new Error(`GPT 第 ${shot.index} 镜生图文件无法解码或尺寸不足，已停止防止使用损坏图片`);
      const duplicate = Object.entries(state.gpt.storyboards)
        .find(([otherKey, other]) => Number(otherKey) < Number(shotKey) && other?.sha256 === metadata.sha256);
      if (duplicate) {
        await fsp.rm(downloadedPath || target, { force: true });
        throw gptImageTimeoutError(`GPT 第 ${shot.index} 镜与第 ${duplicate[0]} 镜文件重复，已丢弃并等待重新生成`);
      }
      const currentUrl = gptWindow.webContents.getURL();
      if (isChatGptConversationUrl(currentUrl)) state.gpt.conversationUrl = currentUrl;
      state.gpt.storyboards[shotKey] = {
        ...metadata,
        promptHash,
        completedAt: new Date().toISOString(),
      };
      checkpointedGeneratedPath = downloadedPath || target;
      await persist();
    };
    let generatedPath;
    try {
      generatedPath = await generateGptImageImpl(gptWindow, shot.imagePrompt, target, {
        onDownloaded: checkpointDownloadedStoryboard,
      });
    } catch (error) {
      const retryableGptCode = [GPT_PAGE_BUSY_CODE, GPT_IMAGE_TIMEOUT_CODE].includes(error?.code)
        ? error.code
        : [GPT_PAGE_BUSY_CODE, GPT_IMAGE_TIMEOUT_CODE]
          .find((code) => String(error?.message || "").startsWith(`${code}:`));
      if (retryableGptCode) {
        // 该会话已经证明可能永久停在 stop 状态。图片断点仍完整保留，但下一次
        // 从 ChatGPT 根地址开一个干净对话继续下一镜，避免每 60 秒回到同一死会话。
        const busyUrl = gptWindow.webContents.getURL();
        state.gpt.lastBusyConversationUrl = isChatGptConversationUrl(busyUrl) ? busyUrl : state.gpt.conversationUrl || null;
        state.gpt.conversationUrl = null;
        state.gpt.conversationResetReason = retryableGptCode;
        state.gpt.conversationResetAt = new Date().toISOString();
        await persist();
      }
      throw error;
    }
    // 兼容注入测试和旧生成器：新默认生成器在 composer 恢复前已调用
    // onDownloaded 落盘验图与写断点；不支持回调的实现在返回后补写。
    if (!checkpointedGeneratedPath) await checkpointDownloadedStoryboard(generatedPath || target);
    images.push(generatedPath || target);
    generatedIndices.push(shot.index);
  }
  return { images, checkpoint: state, reusedIndices, generatedIndices };
}

function createCreativeRunner({ openStudio, waitForStudio = waitForLoad }) {
  let inFlight = null;
  let probeInFlight = null;
  async function advance(jobId, step) {
    await fetchJson(`${AGENT}/api/v1/creative/jobs/${encodeURIComponent(jobId)}/advance`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step }),
    });
  }
  async function doubaoState(window) {
    const url = window.webContents.getURL();
    const state = await window.webContents.executeJavaScript(`(() => {
      const text = (document.body?.innerText || '').slice(0, 120000);
      const editor = ['textarea', '[contenteditable="true"][role="textbox"]', '[contenteditable="true"]']
        .map((selector) => document.querySelector(selector))
        .find((node) => node && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0);
      return {
        quotaExhausted: /(?:免费|今日|生成|视频).{0,16}(?:次数|额度).{0,16}(?:用完|不足|耗尽|上限)|(?:次数|额度).{0,16}(?:用完|不足|耗尽|上限)/i.test(text),
        loginRequired: /登录后使用|立即登录|手机号登录/.test(text),
        authorizationRequired: /安全确认/.test(text) && /上传、使用的素材|均已获充分授权|无侵权违法风险/.test(text),
        riskBlocked: /(?:请完成|需要完成).{0,10}(?:身份|滑块|人机|安全)验证|账号.{0,12}(?:存在风险|状态异常)|操作.{0,8}(?:频繁|受限)|访问异常|captcha/i.test(text),
        assistantFinishState: 'unknown',
        editorReady: Boolean(editor),
        probeFailed: false
      };
    })()`, true).catch(() => ({
      quotaExhausted: "unknown",
      loginRequired: "unknown",
      authorizationRequired: "unknown",
      riskBlocked: "unknown",
      assistantFinishState: "unknown",
      editorReady: false,
      probeFailed: true,
    }));
    const loginFromUrl = /login|passport/.test(url);
    const loginRequired = state.loginRequired === true || loginFromUrl
      ? true : state.loginRequired === false ? false : "unknown";
    let videoEntry = { status: "unchecked", kind: "" };
    if (loginRequired === false && state.quotaExhausted === false
      && state.authorizationRequired === false && state.riskBlocked === false
      && state.probeFailed === false) {
      videoEntry = await inspectAndActivateDoubaoEntry(window, false, false)
        .catch(() => ({ status: "probe_failed", kind: "" }));
    }
    return {
      ...state,
      loginRequired,
      probeFailed: state.probeFailed === true || videoEntry.status === "probe_failed",
      videoModeReady: videoEntry.status === "already",
      videoEntryReady: videoEntry.status === "click" && videoEntry.kind === "video",
      videoEntryAmbiguous: videoEntry.status === "ambiguous",
    };
  }

  async function gptState(window) {
    const url = window.webContents.getURL();
    const state = await window.webContents.executeJavaScript(`(() => {
      const text = (document.body?.innerText || '').slice(0, 120000);
      const editor = ['#prompt-textarea', '[data-testid="composer-text-input"]', 'main form [contenteditable="true"]']
        .map((selector) => document.querySelector(selector))
        .find((node) => node && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0);
      return {
        loginRequired: /登录以继续|登录后继续|登录或注册|log\\s*in|sign\\s*in/i.test(text),
        editorReady: Boolean(editor)
      };
    })()`, true).catch(() => ({ loginRequired: false, editorReady: false, probeFailed: true }));
    return {
      ...state,
      loginRequired: state.loginRequired || /\/auth\/|\/login(?:[/?#]|$)|accounts\.google\.|auth0\.|\/signin(?:[/?#]|$)/i.test(url),
    };
  }

  function pageCondition(state, provider) {
    if (state?.loginRequired === true) {
      return { state: "attention", reason: provider === "gpt" ? "GPT 登录已失效，请重新登录" : "账号未登录或登录已失效" };
    }
    if (provider === "doubao" && state?.quotaExhausted === true) {
      return { state: "attention", reason: "今日视频生成次数或额度已用完" };
    }
    if (state?.editorReady && provider === "gpt") {
      return { state: "ready", reason: "已登录，生图输入框可用" };
    }
    if (state?.editorReady && provider === "doubao" && (state?.videoModeReady || state?.videoEntryReady)) {
      return { state: "ready", reason: state.videoModeReady ? "已登录，当前视频生成会话可用" : "已登录，视频生成入口可用" };
    }
    if (state?.editorReady && provider === "doubao") {
      return {
        state: "unknown",
        reason: state?.videoEntryAmbiguous
          ? "已登录，但视频生成入口不唯一，已停止避免误触"
          : "已登录且通用输入框可用，但尚未确认视频生成入口",
      };
    }
    return { state: "unknown", reason: state?.probeFailed ? "页面状态读取失败，稍后重试" : "页面已打开，但尚未找到可用输入框" };
  }
  function accountPool(values) {
    const source = Array.isArray(values) && values.length ? values : ["account-1"];
    return [...new Set(source.map((value) => sanitizeId(value)).filter(Boolean))].slice(0, 8);
  }

  async function probeAccounts(accountIds = ["account-1"]) {
    if (probeInFlight) return probeInFlight;
    probeInFlight = (async () => {
      let gpt = { state: "unknown", reason: "GPT 页面尚未检查" };
      try {
        const opened = openStudio("gpt", { show: false });
        if (!opened?.ok || !opened?.window) throw new Error(opened?.error || "GPT 窗口未打开");
        await waitForStudio(opened.window);
        gpt = pageCondition(await gptState(opened.window), "gpt");
      } catch (error) {
        gpt = { state: "unknown", reason: `GPT 检查失败：${String(error?.message || error).slice(0, 160)}` };
      }

      const doubao = [];
      const accounts = accountPool(accountIds);
      for (let index = 0; index < accounts.length; index++) {
        const id = accounts[index];
        let result;
        try {
          const opened = openStudio("seedance", { accountId: id, show: false });
          if (!opened?.ok || !opened?.window) throw new Error(opened?.error || "豆包窗口未打开");
          await waitForStudio(opened.window);
          result = pageCondition(await doubaoState(opened.window), "doubao");
        } catch (error) {
          result = { state: "unknown", reason: `检查失败：${String(error?.message || error).slice(0, 160)}` };
        }
        doubao.push({ id, label: `豆包账号 ${index + 1}`, ...result });
      }
      return { gpt, doubao };
    })();
    try { return await probeInFlight; }
    finally { probeInFlight = null; }
  }
  async function run(jobId, assetId, accountIds = ["account-1"]) {
    if (inFlight) return { ok: false, status: "busy", error: "已有生成任务正在运行" };
    inFlight = (async () => {
      const detail = await fetchJson(`${AGENT}/api/v1/kb/videos/${encodeURIComponent(assetId)}`);
      if (detail?.asset?.category !== "素材") return { ok: false, status: "not_material", error: "只有“素材”分类可以一键复刻" };
      const readiness = generationReadiness(detail);
      if (!readiness.ready) return { ok: false, status: readiness.status, error: readiness.error };
      const shots = shotPrompts(detail);
      if (!shots.length) return { ok: false, status: "needs_analysis", error: "这条素材还没有完整的 GPT/Seedance 分镜提示词，请先重新分析" };
      const outputDir = path.join(OUTPUT_ROOT, sanitizeId(jobId));
      await fsp.mkdir(outputDir, { recursive: true });
      const checkpointPath = path.join(outputDir, "run-state.json");
      let checkpoint = null;
      try { checkpoint = JSON.parse(await fsp.readFile(checkpointPath, "utf8")); } catch { /* 首次运行 */ }

      const queuePayload = await fetchJson(`${AGENT}/api/v1/creative/jobs`);
      const currentJob = Array.isArray(queuePayload?.jobs) ? queuePayload.jobs.find((job) => job.id === jobId) : null;
      const currentStatus = effectiveCreativeStatus(currentJob);

      const images = [];
      // ready_for_seedance 也重新走 manifest 验证；有效镜头只读复用，缺失、
      // 损坏或跨镜头 SHA 重复的文件会先补齐，绝不把坏断点直接送进豆包。
      const storyboards = await ensureGptStoryboards({
        shots,
        outputDir,
        jobId,
        assetId,
        checkpoint,
        checkpointPath,
        trustedLegacyStoryboards: TRUSTED_LEGACY_STORYBOARD_MIGRATIONS,
        getGptWindow: async (savedCheckpoint, persistCheckpoint) => {
          const opened = openStudio("gpt", { jobId });
          if (!opened?.ok || !opened?.window) throw new Error(opened?.error || "GPT 窗口未打开");
          const gpt = opened.window;
          const prepared = await prepareGptConversation(gpt, {
            jobId,
            checkpoint: savedCheckpoint,
            waitForStudio,
            onCheckpoint: persistCheckpoint,
          });
          if (/\/auth\/|\/login|accounts\.google/.test(gpt.webContents.getURL())) {
            const error = new Error("请先在打开的 GPT 窗口登录一次，然后重新点击一键生成");
            error.code = "GPT_LOGIN_REQUIRED";
            throw error;
          }
          return { window: gpt, checkpoint: prepared };
        },
      });
      images.push(...storyboards.images);
      checkpoint = storyboards.checkpoint;
      const previousDoubao = checkpoint?.doubao && typeof checkpoint.doubao === "object" ? checkpoint.doubao : {};
      const sameDoubaoScope = previousDoubao.jobId === jobId && previousDoubao.assetId === assetId;
      checkpoint.doubao = {
        ...(sameDoubaoScope ? previousDoubao : {}),
        jobId,
        assetId,
        shots: sameDoubaoScope && previousDoubao.shots && typeof previousDoubao.shots === "object"
          ? { ...previousDoubao.shots }
          : {},
      };
      if (currentStatus === "ready_for_images") await advance(jobId, "images_ready");

      const accounts = accountPool(accountIds);
      const clips = [];
      const readOnlyAllAccountQuotaEvidence = async ({
        shotIndex,
        inputFingerprint,
        pendingInputLocked = false,
        pendingTimeoutEvidence = null,
        preObserved = new Map(),
      } = {}) => collectDoubaoAllAccountsQuotaEvidence({
        accounts,
        jobId,
        assetId,
        shotIndex,
        inputFingerprint,
        pendingInputLocked,
        pendingTimeoutEvidence,
        readState: async (accountId) => {
          if (preObserved.has(accountId)) return preObserved.get(accountId);
          const opened = openStudio("seedance", { accountId, show: false });
          if (!opened?.ok || !opened?.window?.webContents) {
            throw new Error("豆包账号只读探测窗口不可用");
          }
          await waitForLoad(opened.window);
          return doubaoState(opened.window);
        },
      });
      const persistAllAccountQuotaEvidence = async (evidence) => {
        checkpoint.doubao = {
          ...(checkpoint?.doubao && typeof checkpoint.doubao === "object" ? checkpoint.doubao : {}),
          jobId,
          assetId,
          quotaExhaustion: evidence,
        };
        await writeRunCheckpoint(checkpointPath, checkpoint);
      };
      const resumeLocalMotion = localMotionResumeDecision({ checkpoint, jobId, assetId });
      let useLocalMotion = resumeLocalMotion.action === "resume";
      let localMotionTrigger = useLocalMotion ? resumeLocalMotion.trigger : null;
      if (!useLocalMotion) try {
        for (let i = 0; i < shots.length; i++) {
        const shotNumber = Number(shots[i].index);
        const shotKey = String(shotNumber);
        const target = path.join(outputDir, `clip-${String(shotNumber).padStart(2, "0")}.mp4`);
        const watermarkedTarget = path.join(outputDir, `clip-${String(shotNumber).padStart(2, "0")}.watermarked.mp4`);
        let storyboardSha256 = String(checkpoint?.gpt?.storyboards?.[shotKey]?.sha256 || "").toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(storyboardSha256)) {
          const storyboardMetadata = await inspectStoryboard(images[i]);
          storyboardSha256 = String(storyboardMetadata?.sha256 || "").toLowerCase();
        }
        const inputFingerprint = doubaoInputFingerprint({
          imageSha256: storyboardSha256,
          prompt: shots[i].videoPrompt,
          negativePrompt: shots[i].negativePrompt,
          durationSeconds: shots[i].durationSeconds,
        });
        if (!inputFingerprint) throw new Error(`第 ${shotNumber} 镜首帧缺少可信 SHA-256，未提交豆包`);
        const completedMetadata = await inspectGeneratedClip(target);
        const recordedClip = checkpoint.doubao.shots[shotKey];
        const completedDecision = doubaoClipManifestDecision({
          metadata: completedMetadata,
          recorded: recordedClip,
          previousShots: checkpoint.doubao.shots,
          shotIndex: shotNumber,
        });
        if (completedDecision.status === "reusable") {
          clips.push(target);
          continue;
        }
        if (completedDecision.status === "duplicate") {
          await registerDoubaoClip({
            checkpoint,
            jobId,
            assetId,
            shotIndex: shotNumber,
            target,
            watermarkedTarget,
            resultIdentity: recordedClip?.resultIdentity,
            persist: async () => writeRunCheckpoint(checkpointPath, checkpoint),
          });
        }
        if (completedMetadata) {
          // 旧版只要文件存在就复用，这正是错镜头的来源。没有
          // resultIdentity + SHA manifest 的旧片段不能自动绑定当前镜头。
          await Promise.all([fsp.rm(target, { force: true }), fsp.rm(watermarkedTarget, { force: true })]);
          delete checkpoint.doubao.shots[shotKey];
          await writeRunCheckpoint(checkpointPath, checkpoint);
        } else if (recordedClip?.outputSha256) {
          checkpoint.doubao.shots[shotKey] = {
            ...recordedClip,
            outputSha256: null,
            outputSizeBytes: null,
            outputPath: null,
            completedAt: null,
          };
          await writeRunCheckpoint(checkpointPath, checkpoint);
        }
        const unfinishedShot = checkpoint?.doubao?.shots?.[shotKey];
        if (unfinishedShot?.inputFingerprint && unfinishedShot.inputFingerprint !== inputFingerprint
          && (unfinishedShot.sendState === "sending" || unfinishedShot.submittedAt || unfinishedShot.orphanRecoveryUsed)) {
          throw new Error(`第 ${shotNumber} 镜已有不同 inputFingerprint 的提交断点；为避免旧结果绑到新输入，未自动重提`);
        }
        const trustedLegacyTimeout = trustedLegacyDoubaoTimeoutMigration({
          checkpoint,
          jobId,
          assetId,
          shotIndex: shotNumber,
          shotPosition: i,
          accountId: checkpoint?.accountId,
        });
        const queuedLegacyTimeoutCount = Math.max(0, Number(currentJob?.transientRetryCount) || 0);
        const legacyTimeoutCount = trustedLegacyTimeout?.timeoutCount
          || Math.min(2, queuedLegacyTimeoutCount) || 1;
        const legacyTimeoutCountSource = trustedLegacyTimeout
          ? "trusted_runtime_migration"
          : queuedLegacyTimeoutCount >= 2 ? "queue_transientRetryCount" : "run_state_marker";
        if (bindLegacyDoubaoAttempt({
          checkpoint,
          jobId,
          assetId,
          shotIndex: shotNumber,
          shotPosition: i,
          accountId: checkpoint?.accountId,
          inputFingerprint,
          legacyTimeoutCount,
          legacyTimeoutCountSource,
        })) await writeRunCheckpoint(checkpointPath, checkpoint);
        let downloadedResult = null;
        const activeAttempt = checkpoint?.doubao?.shots?.[shotKey];
        const lockedAccountId = activeAttempt?.inputFingerprint === inputFingerprint
          && (activeAttempt.sendState === "sending" || activeAttempt.submittedAt || activeAttempt.orphanRecoveryUsed)
          ? activeAttempt.accountId : "";
        if (lockedAccountId && !accounts.includes(lockedAccountId)) {
          throw new Error(`第 ${shotNumber} 镜已锁定豆包 ${lockedAccountId} 的提交断点，该账号不在本次账号列表；未跨账号重提`);
        }
        const checkpointMatches = checkpoint?.jobId === jobId && checkpoint?.assetId === assetId
          && Number(checkpoint?.shotIndex) === i && accounts.includes(checkpoint?.accountId);
        const startAt = checkpointMatches
          ? accounts.indexOf(checkpoint.accountId) : i % accounts.length;
        const orderedAccounts = lockedAccountId
          ? [lockedAccountId]
          : [...accounts.slice(startAt), ...accounts.slice(0, startAt)];
        const persistedQuotaEvidence = validatedDoubaoQuotaEvidence(checkpoint?.doubao?.quotaExhaustion, {
          jobId,
          assetId,
          inputFingerprint,
        });
        if (persistedQuotaEvidence?.pendingInputLocked === true
          && (!lockedAccountId || activeAttempt?.quotaPendingLocked !== true)) {
          throw doubaoUnsafeTimeoutError(`第 ${shotNumber} 镜的全账号额度证据与 pending input 锁不一致；失败关闭且不会提交`);
        }
        if (lockedAccountId && activeAttempt?.quotaPendingLocked === true
          && persistedQuotaEvidence?.pendingInputLocked === true
          && persistedQuotaEvidence.shotIndex === shotNumber) {
          throw doubaoAllAccountsQuotaExhaustedError(
            `第 ${shotNumber} 镜已恢复全账号精确额度耗尽断点；不会重提或转投其他账号`,
            persistedQuotaEvidence,
          );
        }
        if (lockedAccountId && activeAttempt?.quotaPendingLocked === true) {
          const lockedTimeoutEvidence = safeDoubaoQuotaTimeoutEvidence(activeAttempt.quotaPendingTimeoutEvidence);
          if (!lockedTimeoutEvidence) {
            throw doubaoUnsafeTimeoutError(`第 ${shotNumber} 镜额度 pending 锁缺少可信超时证据；不会等待、重提或转投账号`);
          }
          // 进程若恰好在“已锁 pending、尚未写完 all-quota 证据”之间退出，
          // 恢复后只重做账号状态读取，不再回到远端等待/发送路径。
          const resumedQuotaProbe = await readOnlyAllAccountQuotaEvidence({
            shotIndex: shotNumber,
            inputFingerprint,
            pendingInputLocked: true,
            pendingTimeoutEvidence: lockedTimeoutEvidence,
          });
          if (resumedQuotaProbe.action === "quota_exhausted") {
            await persistAllAccountQuotaEvidence(resumedQuotaProbe.evidence);
            throw doubaoAllAccountsQuotaExhaustedError(
              `第 ${shotNumber} 镜从 pending 锁恢复并再次只读确认全部账号额度耗尽；不会重提或跨账号提交`,
              resumedQuotaProbe.evidence,
            );
          }
          throw doubaoUnsafeTimeoutError(
            `第 ${shotNumber} 镜从额度 pending 锁恢复，但账号池不再满足全账号 exact quota；保持锁定并失败关闭`,
            lockedTimeoutEvidence,
          );
        }
        if (!lockedAccountId) {
          // 先只读检查完整账号池。只有每个账号都给出 exact quota 证据才切换
          // 本地动画；任何 unknown、登录/授权/风控或探测失败都不会触发兜底。
          const quotaPreflight = await readOnlyAllAccountQuotaEvidence({
            shotIndex: shotNumber,
            inputFingerprint,
            pendingInputLocked: false,
          });
          if (quotaPreflight.action === "quota_exhausted") {
            await persistAllAccountQuotaEvidence(quotaPreflight.evidence);
            throw doubaoAllAccountsQuotaExhaustedError(
              `第 ${shotNumber} 镜提交前已只读确认全部豆包账号额度耗尽；未向任何账号提交`,
              quotaPreflight.evidence,
            );
          }
        }
        const unavailable = [];
        for (const accountId of orderedAccounts) {
          const doubao = openStudio("seedance", { accountId, show: false }).window;
          await waitForLoad(doubao);
          const pendingSubmission = pendingDoubaoSubmission({
            checkpoint,
            jobId,
            assetId,
            shotIndex: shotNumber,
            shotPosition: i,
            accountId,
            inputFingerprint,
          });
          if (checkpoint.doubao.conversationResetRequired) {
            if (doubao.webContents.getURL() !== "https://www.doubao.com/") {
              await doubao.loadURL("https://www.doubao.com/");
              await waitForLoad(doubao);
            }
          }
          if (pendingSubmission && /^https:\/\/(?:www\.)?doubao\.com\/chat\//.test(pendingSubmission.conversationUrl)
            && doubao.webContents.getURL() !== pendingSubmission.conversationUrl) {
            await doubao.loadURL(pendingSubmission.conversationUrl);
            await waitForLoad(doubao);
          }
          const availability = await doubaoState(doubao);
          if (availability.loginRequired) {
            if (pendingSubmission) {
              throw new Error(`豆包 ${accountId} 已有第 ${shotNumber} 镜提交断点但登录已失效；未转投其他账号或重复提交`);
            }
            unavailable.push(`${accountId} 未登录`);
            continue;
          }
          // 已提交的生成不再消耗一次提交额度。即使页面此时显示今日额度
          // 已用完，也必须留在原账号/原会话等结果，不能转投另一账号重提。
          if (availability.quotaExhausted && !pendingSubmission) {
            unavailable.push(`${accountId} 今日额度已用完`);
            continue;
          }
          let persistDoubaoProgress = null;
          try {
            persistDoubaoProgress = async (doubaoUrl, attention = null) => {
              const currentDoubao = checkpoint?.doubao && typeof checkpoint.doubao === "object" ? checkpoint.doubao : {};
              const currentShots = currentDoubao.shots && typeof currentDoubao.shots === "object"
                ? { ...currentDoubao.shots } : {};
              const previousShot = currentShots[shotKey] && typeof currentShots[shotKey] === "object"
                ? currentShots[shotKey] : {};
              const eventType = String(attention?.type || "progress");
              const nextShot = {
                ...previousShot,
                shotIndex: shotNumber,
                accountId,
                conversationUrl: doubaoUrl,
              };
              if (["sending", "submitted"].includes(eventType)) {
                if (attention?.inputFingerprint !== inputFingerprint) {
                  throw new Error(`第 ${shotNumber} 镜发送事件 inputFingerprint 不一致，已在点击前停止`);
                }
                nextShot.baselineIdentities = [...new Set((Array.isArray(attention?.baselineIdentities)
                  ? attention.baselineIdentities : []).map(String).filter((identity) => identity && identity.length <= 96))].slice(-32);
                nextShot.inputFingerprint = inputFingerprint;
                nextShot.attemptNumber = Number(attention?.attemptNumber) === 2 ? 2 : 1;
                nextShot.sendState = eventType;
                if (eventType === "sending") {
                  nextShot.sendingAt = new Date().toISOString();
                  nextShot.submittedAt = null;
                  nextShot.resultIdentity = null;
                  nextShot.outputSha256 = null;
                  nextShot.outputSizeBytes = null;
                  nextShot.outputPath = null;
                  nextShot.completedAt = null;
                  nextShot.awaitingResult = true;
                  nextShot.lastWaitTimedOutAt = null;
                  nextShot.lastWaitHadNewIdentity = null;
                  nextShot.zeroIdentityTimeoutCount = 0;
                  nextShot.timeoutEvidenceHistory = [];
                } else {
                  nextShot.submittedAt = new Date().toISOString();
                  nextShot.awaitingResult = true;
                }
              } else if (eventType === "result_ready" && typeof attention?.resultIdentity === "string") {
                nextShot.resultIdentity = attention.resultIdentity.slice(0, 96);
                nextShot.resultReadyAt = new Date().toISOString();
                nextShot.awaitingResult = false;
              } else if (eventType === "result_timeout" && attention?.noNewResultIdentity === true) {
                const evidence = attention?.timeoutEvidence && typeof attention.timeoutEvidence === "object"
                  ? { ...attention.timeoutEvidence } : null;
                const evidenceIsSafe = safeDoubaoTimeoutEvidence(evidence);
                const previousCount = Math.max(0, Number(previousShot.zeroIdentityTimeoutCount) || 0);
                const previousHistory = Array.isArray(previousShot.timeoutEvidenceHistory)
                  ? previousShot.timeoutEvidenceHistory : [];
                nextShot.awaitingResult = evidenceIsSafe;
                nextShot.lastWaitTimedOutAt = new Date().toISOString();
                nextShot.lastWaitHadNewIdentity = false;
                nextShot.lastTimeoutEvidence = evidence;
                nextShot.zeroIdentityTimeoutCount = evidenceIsSafe ? previousCount + 1 : 0;
                nextShot.timeoutEvidenceHistory = evidenceIsSafe ? [...previousHistory, {
                  ...evidence,
                  attemptNumber: Number(previousShot.attemptNumber) === 2 ? 2 : 1,
                  inputFingerprint,
                  timedOutAt: nextShot.lastWaitTimedOutAt,
                }].slice(-3) : [];
              } else if (eventType === "authorization_required") {
                nextShot.awaitingResult = true;
                nextShot.zeroIdentityTimeoutCount = 0;
                nextShot.timeoutEvidenceHistory = [];
                nextShot.lastAuthorizationRequiredAt = new Date().toISOString();
              } else if (eventType === "unexpected_result" && attention?.hasNewResultIdentity === true) {
                nextShot.awaitingResult = false;
                nextShot.unexpectedResultAt = new Date().toISOString();
                nextShot.lastWaitHadNewIdentity = true;
                nextShot.zeroIdentityTimeoutCount = 0;
                nextShot.timeoutEvidenceHistory = [];
              }
              currentShots[shotKey] = nextShot;
              checkpoint = {
                ...(checkpoint && typeof checkpoint === "object" ? checkpoint : {}),
                jobId,
                assetId,
                accountId,
                doubaoUrl,
                shotIndex: i,
                submittedAt: nextShot.submittedAt || nextShot.sendingAt || checkpoint?.submittedAt || new Date().toISOString(),
                doubao: {
                  ...currentDoubao,
                  jobId,
                  assetId,
                  shots: currentShots,
                  conversationResetRequired: false,
                },
              };
              await writeRunCheckpoint(checkpointPath, checkpoint);
              if (attention?.error) {
                await fetchJson(`${AGENT}/api/v1/creative/jobs/${encodeURIComponent(jobId)}/attention`, {
                  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: attention.error }),
                }).catch(() => null);
              }
            };
            if (pendingSubmission) {
              const currentDoubaoUrl = doubao.webContents.getURL();
              let sameCheckpointConversation = false;
              try {
                const current = new URL(currentDoubaoUrl);
                const saved = new URL(pendingSubmission.conversationUrl || "");
                sameCheckpointConversation = current.hostname.replace(/^www\./, "") === saved.hostname.replace(/^www\./, "")
                  && current.pathname.replace(/\/+$/, "") === saved.pathname.replace(/\/+$/, "");
              } catch { /* 无效地址不能作为恢复依据 */ }
              const assetProbe = String(detail?.asset?.title || "").replace(/\s+/g, " ").trim().slice(0, 16);
              const promptProbe = String(shots[i].videoPrompt || "").replace(/\s+/g, " ").trim().slice(0, 24);
              const pageMatches = sameCheckpointConversation || await doubao.webContents.executeJavaScript(`(() => {
                const text = (document.body?.innerText || '').replace(/\\s+/g, ' ');
                return (${JSON.stringify(Boolean(assetProbe))} && text.includes(${JSON.stringify(assetProbe)}))
                  || (${JSON.stringify(Boolean(promptProbe))} && text.includes(${JSON.stringify(promptProbe)}));
              })()`, true).catch(() => false);
              if (!pageMatches) {
                throw doubaoResultIdentityError(`第 ${shotNumber} 镜已有提交断点，但无法安全定位原会话；未重复提交`);
              }
              const quotaFastPath = doubaoPendingQuotaFastPathDecision({
                checkpoint,
                jobId,
                assetId,
                shotIndex: shotNumber,
                shotPosition: i,
                accountId,
                inputFingerprint,
                pendingSubmission,
                availability,
              });
              if (quotaFastPath.action === "unsafe") {
                const rejected = doubaoUnsafeTimeoutError(
                  `第 ${shotNumber} 镜存在额度等待断点，但结构化状态或绑定字段不完整（${quotaFastPath.reason}）；不会重复等待、发送或跨账号`,
                  checkpoint?.doubao?.shots?.[shotKey]?.lastTimeoutEvidence,
                );
                rejected.quotaFastPathRejected = true;
                throw rejected;
              }
              if (quotaFastPath.action === "lock_and_probe") {
                const quotaPendingShot = checkpoint?.doubao?.shots?.[shotKey];
                quotaPendingShot.quotaPendingLocked = true;
                quotaPendingShot.quotaPendingLockedAt = new Date().toISOString();
                quotaPendingShot.quotaPendingTimeoutEvidence = quotaFastPath.timeoutEvidence;
                quotaPendingShot.awaitingResult = false;
                await writeRunCheckpoint(checkpointPath, checkpoint);
                const quotaDecision = await readOnlyAllAccountQuotaEvidence({
                  shotIndex: shotNumber,
                  inputFingerprint,
                  pendingInputLocked: true,
                  pendingTimeoutEvidence: quotaFastPath.timeoutEvidence,
                  preObserved: new Map([[accountId, quotaFastPath.availability]]),
                });
                if (quotaDecision.action === "quota_exhausted") {
                  await persistAllAccountQuotaEvidence(quotaDecision.evidence);
                  throw doubaoAllAccountsQuotaExhaustedError(
                    `第 ${shotNumber} 镜已从完整额度超时断点直接恢复，并只读确认全部账号额度耗尽；不会重复等待、发送或跨账号`,
                    quotaDecision.evidence,
                  );
                }
                const rejected = doubaoUnsafeTimeoutError(
                  `第 ${shotNumber} 镜已锁定额度 pending input，但账号池含 unknown、登录、授权、风控或探测失败；失败关闭`,
                  quotaFastPath.timeoutEvidence,
                );
                rejected.quotaFastPathRejected = true;
                throw rejected;
              }
              if (pendingSubmission.attemptNumber === 1 && pendingSubmission.zeroIdentityTimeoutCount >= 2
                && pendingSubmission.orphanRecoveryUsed !== true) {
                // 升级前已完成两轮的断点先做一次只读回读；若旧结果此刻已经
                // 到达仍正常接收。只有仍为零新 identity 且现场证据明确安全，
                // 才把旧 attempt 封存并进入唯一一次新会话恢复，绝不再等第三轮。
                const baseline = new Set(pendingSubmission.baselineIdentities);
                const candidates = await doubaoResultSnapshot(doubao);
                const readbackDecision = selectNewDoubaoResult(candidates, baseline, pendingSubmission.expectedIdentity);
                if (readbackDecision.status === "ready") {
                  await persistDoubaoProgress(currentDoubaoUrl, {
                    type: "result_ready",
                    resultIdentity: readbackDecision.result.identity,
                  });
                  downloadedResult = {
                    path: await downloadFromWindow(doubao, readbackDecision.result.url, watermarkedTarget, 180_000),
                    resultIdentity: readbackDecision.result.identity,
                  };
                } else {
                  const freshIdentities = candidates.filter((entry) => entry?.identity && !baseline.has(entry.identity));
                  if (readbackDecision.status === "ambiguous" || freshIdentities.length) {
                    await persistDoubaoProgress(currentDoubaoUrl, { type: "unexpected_result", hasNewResultIdentity: true });
                    throw doubaoUnexpectedResultError("孤儿恢复前只读回读发现了未绑定的新 identity，已停止避免绑错或重复提交");
                  }
                  const preflightState = await doubaoAttemptSnapshot(doubao);
                  const preflightEvidence = {
                    noNewResultIdentity: true,
                    loginRequired: preflightState.loginRequired,
                    quotaExhausted: preflightState.quotaExhausted,
                    authorizationRequired: preflightState.authorizationRequired,
                    assistantFinishState: preflightState.assistantFinishState,
                    probeFailed: preflightState.probeFailed,
                  };
                  if (!safeDoubaoTimeoutEvidence(preflightEvidence)) {
                    throw doubaoUnsafeTimeoutError(`第 ${shotNumber} 镜已有两轮旧超时，但当前 assistantFinishState 或登录/额度/授权状态不明确，未重提`, preflightEvidence);
                  }
                  throw doubaoVideoTimeoutError("已确认两轮完整零 identity 超时；进入有界 orphan 恢复预检", preflightEvidence);
                }
              }
              if (!downloadedResult) downloadedResult = await waitForDoubaoVideo(
                doubao,
                new Set(pendingSubmission.baselineIdentities),
                watermarkedTarget,
                persistDoubaoProgress,
                { expectedIdentity: pendingSubmission.expectedIdentity },
              );
            }
            if (!downloadedResult) downloadedResult = await generateDoubaoClip(
              doubao,
              images[i],
              shots[i].videoPrompt,
              shots[i].negativePrompt,
              shots[i].durationSeconds,
              watermarkedTarget,
              persistDoubaoProgress,
              {
                inputFingerprint,
                attemptNumber: Number(checkpoint?.doubao?.shots?.[shotKey]?.attemptNumber) === 2 ? 2 : 1,
              },
            );
            break;
          } catch (error) {
            const after = await doubaoState(doubao);
            const submissionAfterError = pendingSubmission || pendingDoubaoSubmission({
              checkpoint,
              jobId,
              assetId,
              shotIndex: shotNumber,
              shotPosition: i,
              accountId,
              inputFingerprint,
            });
            const quotaTimeoutEvidence = safeDoubaoQuotaTimeoutEvidence(error?.timeoutEvidence);
            if (submissionAfterError
              && error?.code === DOUBAO_VIDEO_TIMEOUT_UNSAFE_CODE
              && error?.quotaFastPathRejected !== true
              && error?.noNewResultIdentity === true
              && quotaTimeoutEvidence
              && exactDoubaoQuotaState(after)) {
              const pendingShot = checkpoint?.doubao?.shots?.[shotKey];
              if (!pendingShot || pendingShot.inputFingerprint !== inputFingerprint
                || pendingShot.accountId !== accountId
                || !["sending", "submitted"].includes(pendingShot.sendState)) {
                throw doubaoUnsafeTimeoutError(`第 ${shotNumber} 镜额度耗尽后的 pending input 无法精确锁定，未重提`, error.timeoutEvidence);
              }
              // 必须先把本轮已发送 input 锁进断点，再只读检查其他账号；从这里
              // 开始无论检查结果如何都不会再次执行远端发送或转投下一账号。
              pendingShot.quotaPendingLocked = true;
              pendingShot.quotaPendingLockedAt = new Date().toISOString();
              pendingShot.quotaPendingTimeoutEvidence = quotaTimeoutEvidence;
              pendingShot.awaitingResult = false;
              await writeRunCheckpoint(checkpointPath, checkpoint);
              const quotaDecision = await readOnlyAllAccountQuotaEvidence({
                shotIndex: shotNumber,
                inputFingerprint,
                pendingInputLocked: true,
                pendingTimeoutEvidence: quotaTimeoutEvidence,
                preObserved: new Map([[accountId, after]]),
              });
              if (quotaDecision.action === "quota_exhausted") {
                await persistAllAccountQuotaEvidence(quotaDecision.evidence);
                throw doubaoAllAccountsQuotaExhaustedError(
                  `第 ${shotNumber} 镜提交后出现额度耗尽，且全部账号均已只读确认耗尽；pending input 已锁定，不会重提或跨账号提交`,
                  quotaDecision.evidence,
                );
              }
              throw doubaoUnsafeTimeoutError(
                `第 ${shotNumber} 镜当前账号提交后额度耗尽，但其他账号存在 unknown、登录、授权、风控或探测失败；已锁定 pending input 并失败关闭`,
                error.timeoutEvidence,
              );
            }
            if (error?.code === DOUBAO_VIDEO_TIMEOUT_CODE) {
              const timedOutShot = checkpoint?.doubao?.shots?.[shotKey];
              const recoveryDecision = doubaoOrphanRecoveryDecision({
                shot: timedOutShot,
                inputFingerprint,
                accountId,
                timeoutError: error,
                availabilityBefore: availability,
                availabilityAfter: after,
              });
              if (recoveryDecision.action === "unsafe") {
                throw doubaoUnsafeTimeoutError(`第 ${shotNumber} 镜超时证据不满足孤儿恢复条件（${recoveryDecision.reason}），未重提`, error.timeoutEvidence);
              }
              if (recoveryDecision.action === "exhausted") {
                if (timedOutShot) {
                  timedOutShot.awaitingResult = false;
                  timedOutShot.recoveryTimedOutAt = new Date().toISOString();
                  timedOutShot.recoveryExhausted = true;
                  await writeRunCheckpoint(checkpointPath, checkpoint);
                }
                throw doubaoOrphanRecoveryExhaustedError(`第 ${shotNumber} 镜第二 attempt 等待超时，已停止；不会第三次提交或转投其他账号`);
              }
              if (recoveryDecision.action === "recover_orphan") {
                checkpoint = await markDoubaoAttemptOrphaned({
                  checkpoint,
                  jobId,
                  assetId,
                  shotIndex: shotNumber,
                  shotPosition: i,
                  accountId,
                  inputFingerprint,
                  persist: async (nextCheckpoint) => writeRunCheckpoint(checkpointPath, nextCheckpoint),
                });
                const orphanedConversationUrl = String(checkpoint.doubao.shots[shotKey]
                  ?.orphanedAttempts?.at(-1)?.conversationUrl || "");
                await doubao.loadURL("https://www.doubao.com/");
                await waitForLoad(doubao);
                const freshConversationUrl = doubao.webContents.getURL();
                if (/^https:\/\/(?:www\.)?doubao\.com\/chat\//.test(orphanedConversationUrl)
                  && freshConversationUrl === orphanedConversationUrl) {
                  throw doubaoUnsafeTimeoutError(`第 ${shotNumber} 镜无法打开全新豆包会话，旧 attempt 已标 orphaned 且未重提`);
                }
                const freshAvailability = await doubaoState(doubao);
                if (freshAvailability.probeFailed === true || freshAvailability.loginRequired !== false
                  || freshAvailability.quotaExhausted !== false) {
                  throw doubaoUnsafeTimeoutError(`第 ${shotNumber} 镜旧 attempt 已标 orphaned，但新会话登录/额度状态不明确，未重提`);
                }
                try {
                  downloadedResult = await generateDoubaoClip(
                    doubao,
                    images[i],
                    shots[i].videoPrompt,
                    shots[i].negativePrompt,
                    shots[i].durationSeconds,
                    watermarkedTarget,
                    persistDoubaoProgress,
                    { inputFingerprint, attemptNumber: 2 },
                  );
                } catch (recoveryError) {
                  if (recoveryError?.code === DOUBAO_VIDEO_TIMEOUT_CODE) {
                    const recoveryAfter = await doubaoState(doubao);
                    const exhaustedDecision = doubaoOrphanRecoveryDecision({
                      shot: checkpoint?.doubao?.shots?.[shotKey],
                      inputFingerprint,
                      accountId,
                      timeoutError: recoveryError,
                      availabilityBefore: freshAvailability,
                      availabilityAfter: recoveryAfter,
                    });
                    if (exhaustedDecision.action === "exhausted") {
                      const recoveryShot = checkpoint?.doubao?.shots?.[shotKey];
                      if (recoveryShot) {
                        recoveryShot.awaitingResult = false;
                        recoveryShot.recoveryTimedOutAt = new Date().toISOString();
                        recoveryShot.recoveryExhausted = true;
                        await writeRunCheckpoint(checkpointPath, checkpoint);
                      }
                      throw doubaoOrphanRecoveryExhaustedError(`第 ${shotNumber} 镜第二 attempt 等待超时，已停止；不会第三次提交或转投其他账号`);
                    }
                    throw doubaoUnsafeTimeoutError(`第 ${shotNumber} 镜第二 attempt 超时状态不明确，已停止且不会再次提交`, recoveryError.timeoutEvidence);
                  }
                  throw recoveryError;
                }
                break;
              }
              throw error;
            }
            if (after.quotaExhausted === true && !submissionAfterError) {
              unavailable.push(`${accountId} 今日额度已用完`);
              continue;
            }
            throw error;
          }
        }
        if (!downloadedResult?.path) throw new Error(`没有可用的豆包账号：${unavailable.join("；") || "请先逐个登录"}`);
        await removeSeedanceWatermark(downloadedResult.path, target);
        const registered = await registerDoubaoClip({
          checkpoint,
          jobId,
          assetId,
          shotIndex: shotNumber,
          target,
          watermarkedTarget,
          resultIdentity: downloadedResult.resultIdentity,
          persist: async () => writeRunCheckpoint(checkpointPath, checkpoint),
        });
        checkpoint = registered.checkpoint;
          clips.push(target);
        }
      } catch (error) {
        const fallback = localMotionFallbackDecision({ error, detail, shots, images });
        if (fallback.action !== "fallback") throw error;
        localMotionTrigger = buildLocalMotionTriggerEvidence({ error, checkpoint });
        if (!localMotionTrigger) {
          const evidenceError = new Error("本地动画严格门未找到可验证的孤儿恢复耗尽或全账号精确额度耗尽证据，未切换引擎");
          evidenceError.code = "LOCAL_MOTION_TRIGGER_EVIDENCE_INVALID";
          throw evidenceError;
        }
        checkpoint.localMotion = {
          engine: LOCAL_MOTION_ENGINE,
          status: "triggered",
          jobId,
          assetId,
          trigger: localMotionTrigger,
          triggeredAt: new Date().toISOString(),
        };
        await writeRunCheckpoint(checkpointPath, checkpoint);
        useLocalMotion = true;
      }

      let visualVideo;
      let generationEngine;
      let localMotionResult = null;
      if (useLocalMotion) {
        if (!strictOriginalMotionWorkflow(detail)) {
          throw new Error("本地动画恢复断点不再满足完全原创隔离要求，已停止");
        }
        localMotionResult = await generateLocalMotionVisual({
          outputDir,
          jobId,
          assetId,
          images,
          shots,
          checkpoint,
          trigger: localMotionTrigger,
        });
        visualVideo = localMotionResult.visualPath;
        generationEngine = LOCAL_MOTION_ENGINE;
        checkpoint.localMotion = {
          ...checkpoint.localMotion,
          engine: LOCAL_MOTION_ENGINE,
          status: "visual_completed",
          jobId,
          assetId,
          trigger: localMotionTrigger,
          manifestName: LOCAL_MOTION_MANIFEST,
          manifestSha256: localMotionResult.manifest.manifestSha256,
          generationProvenanceSha256: localMotionResult.manifest.generationProvenanceSha256,
          visualCompletedAt: new Date().toISOString(),
        };
        await writeRunCheckpoint(checkpointPath, checkpoint);
      } else {
        visualVideo = await concatClips(clips, path.join(outputDir, "final.visual.mp4"));
        generationEngine = "ZhitaiSeedance";
      }
      // 队列 step 名沿用既有状态机 token；真实引擎身份只取不可变 manifest，
      // 本地动画绝不写成或伪称 Seedance。
      await advance(jobId, "seedance_ready");
      const finalVideo = await postprocessAudio({
        input: visualVideo,
        output: path.join(outputDir, "final.mp4"),
        detail,
        shots: detail?.remake_plan?.plan?.seedanceWorkflow?.shots || [],
        expectedDurationSeconds: useLocalMotion ? LOCAL_MOTION_DURATION_MS / 1_000 : null,
      });
      if (useLocalMotion) {
        const completedManifest = await finalizeLocalMotionManifest({
          manifestPath: localMotionResult.manifestPath,
          finalVideoPath: finalVideo,
          audioQualityPath: path.join(outputDir, "audio-quality.json"),
          workflow: detail?.remake_plan?.plan?.seedanceWorkflow || {},
        });
        checkpoint.localMotion = {
          ...checkpoint.localMotion,
          status: "completed",
          manifestSha256: completedManifest.manifestSha256,
          generationProvenanceSha256: completedManifest.generationProvenanceSha256,
          finalVideoSha256: completedManifest.finalVideo.sha256,
          completedAt: completedManifest.completedAt,
        };
        await writeRunCheckpoint(checkpointPath, checkpoint);
      }
      await advance(jobId, "complete");
      return {
        ok: true,
        status: "completed",
        engine: generationEngine,
        finalVideo,
        ...(useLocalMotion ? { manifest: path.join(outputDir, LOCAL_MOTION_MANIFEST) } : {}),
      };
    })();
    try { return await inFlight; }
    catch (error) {
      const message = String(error?.message || error).slice(0, 500);
      const retryableCodes = [
        GPT_PAGE_BUSY_CODE,
        GPT_IMAGE_TIMEOUT_CODE,
        DOUBAO_DUPLICATE_CLIP_CODE,
        DOUBAO_RESULT_IDENTITY_CODE,
        DOUBAO_VIDEO_TIMEOUT_CODE,
      ];
      const transientGptBusy = retryableCodes.includes(error?.code)
        || retryableCodes.some((code) => message.startsWith(`${code}:`));
      await fetchJson(`${AGENT}/api/v1/creative/jobs/${encodeURIComponent(jobId)}/attention`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(transientGptBusy
          ? { error: message, transient: true, retryAfterMs: 60_000 }
          : { error: message }),
      }).catch(() => null);
      return {
        ok: false,
        status: transientGptBusy ? "transient_ui_busy" : error?.code === "GPT_LOGIN_REQUIRED" ? "waiting_gpt_login" : "needs_attention",
        ...(error?.code ? { code: error.code } : {}),
        error: message,
      };
    }
    finally { inFlight = null; }
  }
  return { run, shotPrompts, probeAccounts, isBusy: () => Boolean(inFlight) };
}

module.exports = {
  createCreativeRunner,
  canonicalJson,
  shotPrompts,
  generationReadiness,
  sanitizeId,
  doubaoVideoEntryDecision,
  doubaoResultDownloadDecision,
  doubaoVideoModelResults,
  doubaoVideoModelDecision,
  doubaoUrlResultIdentity,
  selectNewDoubaoResult,
  doubaoInputFingerprint,
  safeDoubaoTimeoutEvidence,
  trustedLegacyDoubaoTimeoutMigration,
  bindLegacyDoubaoAttempt,
  pendingDoubaoSubmission,
  doubaoPendingQuotaFastPathDecision,
  doubaoOrphanRecoveryDecision,
  markDoubaoAttemptOrphaned,
  doubaoClipManifestDecision,
  inspectGeneratedClip,
  registerDoubaoClip,
  doubaoResultSnapshot,
  doubaoAttemptSnapshot,
  waitForDoubaoVideo,
  generateDoubaoClip,
  GPT_PAGE_BUSY_CODE,
  GPT_IMAGE_TIMEOUT_CODE,
  DOUBAO_DUPLICATE_CLIP_CODE,
  DOUBAO_RESULT_IDENTITY_CODE,
  DOUBAO_VIDEO_TIMEOUT_CODE,
  DOUBAO_UNEXPECTED_RESULT_CODE,
  DOUBAO_VIDEO_TIMEOUT_UNSAFE_CODE,
  DOUBAO_ORPHAN_RECOVERY_EXHAUSTED_CODE,
  DOUBAO_ALL_ACCOUNTS_QUOTA_EXHAUSTED_CODE,
  LOCAL_MOTION_ENGINE,
  LOCAL_MOTION_PIPELINE_VERSION,
  LOCAL_MOTION_MANIFEST,
  LOCAL_MOTION_WIDTH,
  LOCAL_MOTION_HEIGHT,
  LOCAL_MOTION_FPS,
  LOCAL_MOTION_SEGMENT_FRAMES,
  LOCAL_MOTION_TOTAL_FRAMES,
  LOCAL_MOTION_DURATION_MS,
  localMotionFallbackEnabled,
  strictOriginalMotionWorkflow,
  exactDoubaoQuotaState,
  safeDoubaoQuotaTimeoutEvidence,
  validatedDoubaoQuotaEvidence,
  collectDoubaoAllAccountsQuotaEvidence,
  doubaoAllAccountsQuotaExhaustedError,
  localMotionFallbackDecision,
  buildLocalMotionTriggerEvidence,
  localMotionResumeDecision,
  localMotionPreset,
  localMotionSegmentFilter,
  localMotionSegmentArgs,
  localMotionConcatArgs,
  probeLocalMotionVideo,
  localMotionProbeDecision,
  validateLocalMotionStoryboards,
  localMotionGenerationProvenancePayload,
  localMotionGenerationProvenanceSha256,
  localMotionManifestSha256,
  bindLocalMotionManifestHashes,
  inspectLocalMotionArtifact,
  generateLocalMotionVisual,
  finalizeLocalMotionManifest,
  gptPageBusyError,
  gptImageTimeoutError,
  doubaoDuplicateClipError,
  doubaoResultIdentityError,
  doubaoVideoTimeoutError,
  doubaoUnexpectedResultError,
  doubaoUnsafeTimeoutError,
  doubaoOrphanRecoveryExhaustedError,
  readGptComposerState,
  waitForGptComposerIdle,
  sendPrompt,
  waitForStableGptImage,
  generateGptImage,
  inspectStoryboard,
  prepareGptConversation,
  ensureGptStoryboards,
  effectiveCreativeStatus,
};
