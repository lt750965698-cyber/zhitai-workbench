import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";

export const PLATFORM_RECEIPT_FORMAT_VERSION = 1;

const RECEIPT_SOURCES = new Set(["matrixmedia_cli", "publisher_task"]);
const RECEIPT_MODES = new Set(["draft", "platform_draft", "publish"]);
const RECEIPT_STATUSES = new Set([
  "accepted",
  "draft",
  "failed",
  "needs_attention",
  "partial_failed",
  "platform_draft",
  "submitted",
  "success",
  "unknown",
]);
const RECEIPT_PLATFORMS = new Set([
  "bjh", "blbl", "douyin", "dy", "fqsp", "ks", "sph", "tt",
  "wechat_channels", "xhs", "xiaohongshu",
]);

// These are the only keys that may reach disk. In particular, account identifiers,
// headers, cookies, tokens, QR material and arbitrary upstream response fields are absent.
export const PLATFORM_RECEIPT_FIELDS = Object.freeze([
  "formatVersion",
  "receiptId",
  "operationId",
  "taskId",
  "videoId",
  "source",
  "platform",
  "mode",
  "status",
  "success",
  "scheduledAt",
  "recordedAt",
  "message",
]);

const SENSITIVE_KEY = /(?:access[-_]?token|api[-_]?key|auth(?:entication|orization)?|bearer|cookie|credential|decode[-_]?key|encfilekey|jwt|mobile|pass(?:word|wd)?|phone|qr(?:code|data|path)?|secret|session|sign(?:ature)?|ticket|token|x-amz-[a-z0-9-]*)/i;

function flatten(value) {
  return String(value ?? "").replace(/[\r\n\u2028\u2029]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, " ");
}

/**
 * Upstream status/error text is untrusted. Keep a short, single-line diagnostic while
 * conservatively removing labelled credentials, bearer values, URLs, paths, QR blobs,
 * phone numbers and token-like opaque blobs.
 */
export function redactPlatformReceiptText(value) {
  let text = flatten(value);

  // Scan candidate assignment keys instead of relying on a finite list of JSON shapes.
  // Once a sensitive assignment is found, discard the rest of the line: values can contain
  // spaces, commas, unmatched quotes or another apparent field boundary.
  const keyPattern = /[A-Za-z][A-Za-z0-9_-]{0,127}/g;
  let match;
  while ((match = keyPattern.exec(text)) !== null) {
    if (!SENSITIVE_KEY.test(match[0])) continue;
    const suffix = text.slice(match.index + match[0].length);
    if (/^(?:\\?["'])?(?:\[[^\]\r\n]{0,32}\]|\]){0,4}\s*[:=\uff1a\uff1d]/.test(suffix)) {
      text = `${text.slice(0, match.index)}[redacted]`;
      break;
    }
  }

  text = text
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+/gi, "Bearer [redacted]")
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=_-]+/gi, "[redacted:qr]")
    .replace(/(?:https?|file):\/\/[^\s<>'"]+/gi, "[redacted:url]")
    .replace(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s,;]*/g, "[redacted:path]")
    // A local path may legally contain spaces. Once a path prefix is seen, drop the
    // remainder of the diagnostic instead of risking a partial-path disclosure.
    .replace(/(^|[\s:=\uff1a\uff1d,;([{>])(?:~[\\/]|\\\\|\/)(?=\S).*$/g, "$1[redacted:path]")
    .replace(/(?<!\d)(?:\+?86[-\s]?)?1[3-9](?:[-\s]?\d){9}(?!\d)/g, "[redacted:phone]")
    .replace(/(?<![A-Za-z0-9])[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9])/g, "[redacted:value]");

  // Bare QR labels commonly precede an encoded value without an equals sign.
  text = text.replace(/(?:qr\s*code|qrcode|\u4e8c\u7ef4\u7801|\u626b\u7801\u6570\u636e)\s*[\uff1a:]\s*\S+/gi, "[redacted:qr]");
  return text.trim().slice(0, 500);
}

function safeOpaqueId(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  const raw = String(value);
  if (raw.length > 160 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(raw)) return fallback;
  if (/^(?:\+?86)?1[3-9]\d{9}$/.test(raw) || /^(?:https?|file):/i.test(raw)) return fallback;
  return raw;
}

function safePlatform(value) {
  const safe = String(value ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "_").slice(0, 40);
  return RECEIPT_PLATFORMS.has(safe) ? safe : "unknown";
}

function safeIso(value, fallback = null) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) return fallback;
  return new Date(value).toISOString();
}

function safeMode(value) {
  return RECEIPT_MODES.has(value) ? value : "unknown";
}

function safeStatus(value, success) {
  const normalized = String(value ?? "").toLowerCase().replace(/[^a-z0-9_-]/g, "_");
  if (!RECEIPT_STATUSES.has(normalized)) return success === true ? "success" : success === false ? "failed" : "unknown";
  const positive = new Set(["accepted", "draft", "platform_draft", "submitted", "success"]);
  const negative = new Set(["failed", "partial_failed"]);
  if ((success === true && negative.has(normalized)) || (success === false && positive.has(normalized))) return "unknown";
  if (success === null && normalized !== "unknown" && normalized !== "needs_attention") return "unknown";
  return normalized;
}

function safeMessageCode(value) {
  const normalized = flatten(value).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!normalized) return null;
  const allowed = new Set([
    "accepted",
    "draft",
    "failed",
    "missing_platform_result",
    "platform_result_not_observed",
    "publish_intent_recorded",
    "publisher_response_received",
    "publisher_outcome_not_observed",
    "saved",
    "submitted",
    "success",
    "unmatched_platform_result",
  ]);
  if (allowed.has(normalized) || /^adapter_exit_[0-9]{1,3}$/.test(normalized)) return normalized;
  return null;
}

/** Build exactly one receipt. This is deliberately not a generic object sanitizer. */
export function createPlatformReceipt(input, options = {}) {
  const recordedAt = safeIso(options.recordedAt || input?.recordedAt, new Date().toISOString());
  const success = typeof input?.success === "boolean" ? input.success : null;
  const receipt = {
    formatVersion: PLATFORM_RECEIPT_FORMAT_VERSION,
    receiptId: safeOpaqueId(options.receiptId || input?.receiptId, `rcpt_${randomUUID()}`),
    operationId: safeOpaqueId(input?.operationId),
    taskId: safeOpaqueId(input?.taskId),
    videoId: safeOpaqueId(input?.videoId),
    source: RECEIPT_SOURCES.has(input?.source) ? input.source : "unknown",
    platform: safePlatform(input?.platform),
    mode: safeMode(input?.mode),
    status: safeStatus(input?.status, success),
    success,
    scheduledAt: safeIso(input?.scheduledAt),
    recordedAt,
    // Free-form upstream text is never persisted. Only fixed audit codes survive.
    message: safeMessageCode(input?.message),
  };
  return receipt;
}

/**
 * Pair by normalized platform identity. An omitted result is outcome-unknown, not failed:
 * a transport failure does not prove that the platform rejected the operation.
 */
export function createPlatformReceipts({ platforms = [], results = [], ...common }, options = {}) {
  const requested = Array.isArray(platforms) ? platforms : [];
  const returned = Array.isArray(results) ? results : [];
  const recordedAt = options.recordedAt || new Date().toISOString();
  const usedResults = new Set();
  const receipts = requested.map((destination, index) => {
    const destinationPlatform = typeof destination === "string" ? destination : destination?.platform;
    const normalizedDestination = safePlatform(destinationPlatform);
    let resultIndex = returned.findIndex((candidate, candidateIndex) =>
      !usedResults.has(candidateIndex) && safePlatform(candidate?.platform) === normalizedDestination,
    );
    if (resultIndex < 0 && returned[index] && !returned[index]?.platform && !usedResults.has(index)) resultIndex = index;
    const result = resultIndex >= 0 ? returned[resultIndex] : null;
    if (resultIndex >= 0) usedResults.add(resultIndex);
    const hasResult = Boolean(result && typeof result === "object");
    return createPlatformReceipt({
      ...common,
      platform: destinationPlatform || result?.platform,
      success: hasResult && typeof result.success === "boolean" ? result.success : null,
      status: hasResult ? result.status : "unknown",
      message: hasResult ? result.message : "platform_result_not_observed",
    }, {
      recordedAt,
      receiptId: typeof options.receiptIdFactory === "function" ? options.receiptIdFactory(index) : undefined,
    });
  });
  for (let index = 0; index < returned.length; index += 1) {
    if (usedResults.has(index)) continue;
    const result = returned[index];
    receipts.push(createPlatformReceipt({
      ...common,
      platform: result?.platform,
      success: typeof result?.success === "boolean" ? result.success : null,
      status: result?.status || "unknown",
      message: result?.message || "unmatched_platform_result",
    }, {
      recordedAt,
      receiptId: typeof options.receiptIdFactory === "function" ? options.receiptIdFactory(receipts.length) : undefined,
    }));
  }
  return receipts;
}

function rebuildWhitelistedReceipt(receipt) {
  return createPlatformReceipt(receipt, {
    recordedAt: receipt?.recordedAt,
    receiptId: receipt?.receiptId,
  });
}

async function syncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); }
  finally { await handle.close(); }
}

/** Atomically persist one JSON file per platform receipt. */
export async function persistPlatformReceipts(directory, receipts) {
  if (!Array.isArray(receipts) || receipts.length === 0) return [];
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const written = [];
  for (const candidate of receipts) {
    const receipt = rebuildWhitelistedReceipt(candidate);
    const targetPath = join(directory, `${receipt.receiptId}.json`);
    const temporaryPath = join(directory, `.${receipt.receiptId}.${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporaryPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(receipt, null, 2)}\n`, "utf8");
      await handle.sync();
      await handle.close();
      handle = null;
      // Hard-link publication is atomic and fails with EEXIST instead of replacing an
      // immutable receipt that already has the same ID.
      await link(temporaryPath, targetPath);
      await syncDirectory(directory);
      await rm(temporaryPath);
      await syncDirectory(directory);
      written.push(targetPath);
    } catch (error) {
      await handle?.close().catch(() => {});
      await rm(temporaryPath, { force: true }).catch(() => {});
      if (error && typeof error === "object") error.writtenCount = written.length;
      throw error;
    }
  }
  return written;
}
