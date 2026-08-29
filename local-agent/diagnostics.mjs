import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import * as defaultFs from "node:fs/promises";
import { join } from "node:path";

export const MANAGED_DIAGNOSTIC_PREFIX = "zhitai-diag-v2-";
export const DIAGNOSTIC_EVENT_SCHEMA_VERSION = 2;

const MANAGED_EVENT_RE = /^zhitai-diag-v2-(\d{13})-([0-9a-f]{24})\.json$/;
const MANAGED_TEMP_RE = /^\.zhitai-diag-v2-tmp-(\d{13})-([0-9a-f]{24})\.json$/;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MANAGED_TEMP_STALE_MS = HOUR_MS;
const MAX_SAFE_METRIC = 1_000_000_000;
const MAX_SCAN_NODES = 4_096;
const MAX_SCAN_FIELDS = 16_384;
const MAX_SCANNED_STRING_CHARS = 16_384;

export const DIAGNOSTICS_LIMITS = Object.freeze({
  debugMaxDurationMs: HOUR_MS,
  retention: Object.freeze({
    defaultMaxAgeMs: DAY_MS,
    hardMaxAgeMs: 7 * DAY_MS,
    defaultMaxFiles: 100,
    hardMaxFiles: 500,
    defaultMaxBytes: 5 * 1024 * 1024,
    hardMaxBytes: 25 * 1024 * 1024,
    defaultMaxEventBytes: 16 * 1024,
    hardMaxEventBytes: 32 * 1024,
  }),
});

const EVENT_KINDS = new Set([
  "sync_response",
  "bridge_event",
  "ingest",
  "download",
  "health",
  "unknown",
]);
const EVENT_SOURCES = new Set([
  "filehelper_bridge",
  "kuaidian_bridge",
  "browser_bridge",
  "local_agent",
  "unknown",
]);
const EVENT_OUTCOMES = new Set([
  "observed",
  "accepted",
  "rejected",
  "failed",
  "unknown",
]);
const TRANSPORTS = new Set(["xhr", "fetch", "gm_xmlhttp", "local", "unknown"]);
const CONTENT_TYPES = new Set(["json", "html", "text", "binary", "unknown"]);
const PAYLOAD_SHAPES = new Set(["object", "array", "string", "number", "boolean", "null", "binary", "unknown"]);

const BODY_KEY_RE = /^(?:text|body|html|content|message|response|responseText|raw)$/i;
const HTML_KEY_RE = /html/i;
const URL_KEY_RE = /(?:^|[_-])(?:url|uri|href|link)(?:$|[_-])/i;
const SENSITIVE_KEY_RE = /(?:^|[_-])(?:auth|authorization|cookie|token|secret|signature|password|credential|session|key)(?:$|[_-])/i;
const PHONE_RE = /(?:\+?86[ -]?)?1[3-9]\d{9}/g;
const SIGNED_URL_RE = /https?:\/\/[^\s"'<>]{0,8192}[?&](?:access[_-]?token|auth|authorization|key|signature|sig|token|x-amz-signature|x-cos-signature|x-oss-security-token)=/i;
const ABSOLUTE_PATH_RE = /(?:file:\/\/\/|(?:^|[\s=:])\/(?:Users|home|private|var|tmp|opt|srv)\/|[A-Za-z]:\\(?:Users|Documents|Desktop)\\|~\/)/i;
const CREDENTIAL_RE = /(?:Bearer\s+[A-Za-z0-9._~+/-]+=*|(?:authorization|cookie|password|secret|token)\s*[=:])/i;
const HTML_VALUE_RE = /<(?:html|body|script|style|div|span|p|a|img|video)\b/i;
const URL_VALUE_RE = /https?:\/\//i;

export class DiagnosticsError extends Error {
  constructor(code) {
    super(code);
    this.name = "DiagnosticsError";
    this.code = code;
    this.stack = `${this.name}: ${code}`;
  }
}

function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function ownDataValue(value, key) {
  if (!value || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function epochMs(value) {
  const resolved = typeof value === "function" ? value() : value;
  if (resolved instanceof Date) return resolved.getTime();
  return typeof resolved === "number" ? resolved : Number.NaN;
}

function validNow(value) {
  const ms = epochMs(value);
  return Number.isFinite(ms) ? Math.trunc(ms) : Date.now();
}

function parseExpiry(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.length <= 64) return Date.parse(value);
  return Number.NaN;
}

function toIso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function boundedInteger(value, fallback, minimum, maximum) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function safeMetric(value) {
  return boundedInteger(value, 0, 0, MAX_SAFE_METRIC);
}

function firstNumber(...values) {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return 0;
}

function normalizeEnum(value, allowed) {
  if (typeof value !== "string" || value.length > 64) return "unknown";
  const normalized = value.toLowerCase();
  return allowed.has(normalized) ? normalized : "unknown";
}

function readPolicyNumber(rawRetention, key, fallback, minimum, maximum) {
  return boundedInteger(ownDataValue(rawRetention, key), fallback, minimum, maximum);
}

/**
 * Resolve a fail-closed diagnostics policy. Debug is authorized only by the
 * literal boolean `true` (or the exact environment string `"true"`) plus a
 * valid, future expiry no more than 60 minutes away.
 */
export function resolveDiagnosticsPolicy(raw = {}, env = process.env, now = Date.now()) {
  const resolvedAtMs = validNow(now);
  const rawPolicy = asRecord(raw);
  const rawRetention = asRecord(ownDataValue(rawPolicy, "retention"));
  const rawDebug = asRecord(ownDataValue(rawPolicy, "debug"));
  const safeEnv = asRecord(env);

  const retention = Object.freeze({
    maxAgeMs: readPolicyNumber(
      rawRetention,
      "maxAgeMs",
      DIAGNOSTICS_LIMITS.retention.defaultMaxAgeMs,
      60_000,
      DIAGNOSTICS_LIMITS.retention.hardMaxAgeMs,
    ),
    maxFiles: readPolicyNumber(
      rawRetention,
      "maxFiles",
      DIAGNOSTICS_LIMITS.retention.defaultMaxFiles,
      1,
      DIAGNOSTICS_LIMITS.retention.hardMaxFiles,
    ),
    maxBytes: readPolicyNumber(
      rawRetention,
      "maxBytes",
      DIAGNOSTICS_LIMITS.retention.defaultMaxBytes,
      1_024,
      DIAGNOSTICS_LIMITS.retention.hardMaxBytes,
    ),
    maxEventBytes: readPolicyNumber(
      rawRetention,
      "maxEventBytes",
      DIAGNOSTICS_LIMITS.retention.defaultMaxEventBytes,
      1_024,
      DIAGNOSTICS_LIMITS.retention.hardMaxEventBytes,
    ),
  });

  const rawHasEnabled = Object.prototype.hasOwnProperty.call(rawDebug, "enabled");
  const rawHasExpiry = Object.prototype.hasOwnProperty.call(rawDebug, "expiresAt")
    || Object.prototype.hasOwnProperty.call(rawDebug, "expiresAtMs");
  const requested = rawHasEnabled
    ? ownDataValue(rawDebug, "enabled") === true
    : ownDataValue(safeEnv, "ZHITAI_DIAGNOSTICS_DEBUG_ENABLED") === "true";
  const expiryValue = rawHasExpiry
    ? (ownDataValue(rawDebug, "expiresAt") ?? ownDataValue(rawDebug, "expiresAtMs"))
    : ownDataValue(safeEnv, "ZHITAI_DIAGNOSTICS_DEBUG_EXPIRES_AT");
  const expiresAtMs = parseExpiry(expiryValue);

  let enabled = false;
  let reason = "disabled";
  if (requested && !Number.isFinite(expiresAtMs)) {
    reason = "invalid_expiry";
  } else if (requested && expiresAtMs <= resolvedAtMs) {
    reason = "expired";
  } else if (requested && expiresAtMs - resolvedAtMs > DIAGNOSTICS_LIMITS.debugMaxDurationMs) {
    reason = "expiry_exceeds_limit";
  } else if (requested) {
    enabled = true;
    reason = "authorized";
  }

  return Object.freeze({
    schemaVersion: 1,
    retention,
    debug: Object.freeze({
      enabled,
      reason,
      authorizedAtMs: resolvedAtMs,
      expiresAtMs: enabled ? Math.trunc(expiresAtMs) : null,
      maxDurationMs: DIAGNOSTICS_LIMITS.debugMaxDurationMs,
    }),
  });
}

function debugIsActive(policy, nowMs) {
  const debug = policy.debug;
  return debug.enabled === true
    && Number.isFinite(debug.authorizedAtMs)
    && Number.isFinite(debug.expiresAtMs)
    && nowMs >= debug.authorizedAtMs
    && nowMs < debug.expiresAtMs
    && debug.expiresAtMs - debug.authorizedAtMs <= DIAGNOSTICS_LIMITS.debugMaxDurationMs
    && debug.expiresAtMs - nowMs <= DIAGNOSTICS_LIMITS.debugMaxDurationMs;
}

function addBounded(left, right) {
  return Math.min(MAX_SAFE_METRIC, safeMetric(left) + safeMetric(right));
}

function countMatches(value, pattern) {
  pattern.lastIndex = 0;
  let count = 0;
  while (pattern.exec(value) !== null) {
    count += 1;
    if (count >= MAX_SAFE_METRIC) break;
  }
  pattern.lastIndex = 0;
  return count;
}

function payloadShape(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return "binary";
  if (["object", "string", "number", "boolean"].includes(typeof value)) return typeof value;
  return "unknown";
}

function inspectInput(root) {
  const summary = {
    payloadBytes: 0,
    bodyBytes: 0,
    topLevelFieldCount: 0,
    fieldCount: 0,
    maxDepth: 0,
    hadBody: false,
    hadHtml: false,
    hadUrl: false,
    sensitiveFieldCount: 0,
    credentialLikeCount: 0,
    phoneLikeCount: 0,
    signedUrlCount: 0,
    absolutePathCount: 0,
    htmlValueCount: 0,
    payloadShape: normalizeEnum(payloadShape(root), PAYLOAD_SHAPES),
  };
  const seen = new WeakSet();
  let nodes = 0;

  function visit(value, depth, context = {}) {
    if (nodes >= MAX_SCAN_NODES || summary.fieldCount >= MAX_SCAN_FIELDS) return;
    nodes += 1;
    summary.maxDepth = Math.max(summary.maxDepth, Math.min(depth, 64));

    if (typeof value === "string") {
      const bytes = Math.min(MAX_SAFE_METRIC, Buffer.byteLength(value, "utf8"));
      summary.payloadBytes = addBounded(summary.payloadBytes, bytes);
      if (context.body) {
        summary.bodyBytes = addBounded(summary.bodyBytes, bytes);
        summary.hadBody = true;
      }
      const scanned = value.length > MAX_SCANNED_STRING_CHARS
        ? value.slice(0, MAX_SCANNED_STRING_CHARS)
        : value;
      if (URL_VALUE_RE.test(scanned)) summary.hadUrl = true;
      if (HTML_VALUE_RE.test(scanned)) {
        summary.hadHtml = true;
        summary.htmlValueCount = addBounded(summary.htmlValueCount, 1);
      }
      if (CREDENTIAL_RE.test(scanned)) summary.credentialLikeCount = addBounded(summary.credentialLikeCount, 1);
      if (SIGNED_URL_RE.test(scanned)) summary.signedUrlCount = addBounded(summary.signedUrlCount, 1);
      if (ABSOLUTE_PATH_RE.test(scanned)) summary.absolutePathCount = addBounded(summary.absolutePathCount, 1);
      summary.phoneLikeCount = addBounded(summary.phoneLikeCount, countMatches(scanned, PHONE_RE));
      return;
    }

    if (typeof value === "number") {
      summary.payloadBytes = addBounded(summary.payloadBytes, 8);
      return;
    }
    if (typeof value === "boolean") {
      summary.payloadBytes = addBounded(summary.payloadBytes, 1);
      return;
    }
    if (value === null) {
      summary.payloadBytes = addBounded(summary.payloadBytes, 4);
      return;
    }
    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
      const byteLength = safeMetric(value.byteLength);
      summary.payloadBytes = addBounded(summary.payloadBytes, byteLength);
      if (context.body) {
        summary.bodyBytes = addBounded(summary.bodyBytes, byteLength);
        summary.hadBody = true;
      }
      return;
    }
    if (!value || typeof value !== "object" || seen.has(value)) return;
    seen.add(value);

    let descriptors;
    try {
      descriptors = Object.getOwnPropertyDescriptors(value);
    } catch {
      return;
    }
    const entries = Object.entries(descriptors);
    if (depth === 0) summary.topLevelFieldCount = Math.min(MAX_SAFE_METRIC, entries.length);
    for (const [key, descriptor] of entries) {
      if (summary.fieldCount >= MAX_SCAN_FIELDS) break;
      if (!Object.prototype.hasOwnProperty.call(descriptor, "value")) continue;
      summary.fieldCount += 1;
      summary.payloadBytes = addBounded(summary.payloadBytes, Buffer.byteLength(key, "utf8"));
      const body = context.body || BODY_KEY_RE.test(key);
      if (body) summary.hadBody = true;
      if (HTML_KEY_RE.test(key)) summary.hadHtml = true;
      if (URL_KEY_RE.test(key)) summary.hadUrl = true;
      if (SENSITIVE_KEY_RE.test(key)) summary.sensitiveFieldCount = addBounded(summary.sensitiveFieldCount, 1);
      visit(descriptor.value, depth + 1, { body });
    }
  }

  visit(root, 0);
  return summary;
}

function metricObject(input) {
  return asRecord(ownDataValue(input, "metrics"));
}

/**
 * Project arbitrary input onto the sole on-disk/API-safe event schema.
 * No caller-provided string is ever copied unless it matches a fixed enum.
 */
export function projectDiagnosticEvent(input, { meta = {}, now = Date.now(), debugActive = false } = {}) {
  const recordedAtMs = validNow(now);
  const safeInput = input && typeof input === "object" ? input : input ?? null;
  const safeMeta = asRecord(meta);
  const metrics = metricObject(safeInput);
  const inspection = inspectInput(safeInput);
  const statusCode = safeMetric(firstNumber(
    ownDataValue(safeMeta, "statusCode"),
    ownDataValue(safeInput, "statusCode"),
    ownDataValue(metrics, "statusCode"),
  ));

  const kind = normalizeEnum(
    ownDataValue(safeMeta, "kind") ?? ownDataValue(safeInput, "kind"),
    EVENT_KINDS,
  );
  const source = normalizeEnum(
    ownDataValue(safeMeta, "source") ?? ownDataValue(safeInput, "source"),
    EVENT_SOURCES,
  );
  const outcome = normalizeEnum(
    ownDataValue(safeMeta, "outcome") ?? ownDataValue(safeInput, "outcome"),
    EVENT_OUTCOMES,
  );

  const active = debugActive === true;
  return {
    schemaVersion: DIAGNOSTIC_EVENT_SCHEMA_VERSION,
    recordedAt: toIso(recordedAtMs),
    kind,
    source,
    outcome,
    metrics: {
      payloadBytes: safeMetric(firstNumber(
        ownDataValue(safeMeta, "requestBytes"),
        ownDataValue(safeMeta, "payloadBytes"),
        ownDataValue(metrics, "payloadBytes"),
        inspection.payloadBytes,
      )),
      bodyBytes: safeMetric(firstNumber(
        ownDataValue(safeMeta, "bodyBytes"),
        ownDataValue(metrics, "bodyBytes"),
        inspection.bodyBytes,
      )),
      itemCount: safeMetric(firstNumber(ownDataValue(safeInput, "itemCount"), ownDataValue(metrics, "itemCount"))),
      messageCount: safeMetric(firstNumber(ownDataValue(safeInput, "messageCount"), ownDataValue(metrics, "messageCount"))),
      linkCount: safeMetric(firstNumber(ownDataValue(safeInput, "linkCount"), ownDataValue(metrics, "linkCount"))),
      durationMs: safeMetric(firstNumber(ownDataValue(safeInput, "durationMs"), ownDataValue(metrics, "durationMs"))),
      statusCode: statusCode >= 100 && statusCode <= 599 ? statusCode : 0,
    },
    signals: {
      hadBody: inspection.hadBody,
      hadHtml: inspection.hadHtml,
      hadUrl: inspection.hadUrl,
    },
    debug: {
      active,
      transport: active
        ? normalizeEnum(ownDataValue(safeMeta, "transport") ?? ownDataValue(safeInput, "transport"), TRANSPORTS)
        : "unknown",
      contentType: active
        ? normalizeEnum(ownDataValue(safeMeta, "contentType") ?? ownDataValue(safeInput, "contentType"), CONTENT_TYPES)
        : "unknown",
      payloadShape: active ? inspection.payloadShape : "unknown",
      topLevelFieldCount: active ? safeMetric(inspection.topLevelFieldCount) : 0,
      fieldCount: active ? safeMetric(inspection.fieldCount) : 0,
      maxDepth: active ? safeMetric(inspection.maxDepth) : 0,
      sensitiveFieldCount: active ? safeMetric(inspection.sensitiveFieldCount) : 0,
      credentialLikeCount: active ? safeMetric(inspection.credentialLikeCount) : 0,
      phoneLikeCount: active ? safeMetric(inspection.phoneLikeCount) : 0,
      signedUrlCount: active ? safeMetric(inspection.signedUrlCount) : 0,
      absolutePathCount: active ? safeMetric(inspection.absolutePathCount) : 0,
      htmlValueCount: active ? safeMetric(inspection.htmlValueCount) : 0,
    },
  };
}

function sanitizeStoredEvent(value) {
  const event = asRecord(value);
  if (ownDataValue(event, "schemaVersion") !== DIAGNOSTIC_EVENT_SCHEMA_VERSION) return null;
  const recordedAtMs = parseExpiry(ownDataValue(event, "recordedAt"));
  if (!Number.isFinite(recordedAtMs)) return null;
  const metrics = asRecord(ownDataValue(event, "metrics"));
  const signals = asRecord(ownDataValue(event, "signals"));
  const debug = asRecord(ownDataValue(event, "debug"));
  const active = ownDataValue(debug, "active") === true;

  const statusCode = safeMetric(ownDataValue(metrics, "statusCode"));
  return {
    schemaVersion: DIAGNOSTIC_EVENT_SCHEMA_VERSION,
    recordedAt: toIso(recordedAtMs),
    kind: normalizeEnum(ownDataValue(event, "kind"), EVENT_KINDS),
    source: normalizeEnum(ownDataValue(event, "source"), EVENT_SOURCES),
    outcome: normalizeEnum(ownDataValue(event, "outcome"), EVENT_OUTCOMES),
    metrics: {
      payloadBytes: safeMetric(ownDataValue(metrics, "payloadBytes")),
      bodyBytes: safeMetric(ownDataValue(metrics, "bodyBytes")),
      itemCount: safeMetric(ownDataValue(metrics, "itemCount")),
      messageCount: safeMetric(ownDataValue(metrics, "messageCount")),
      linkCount: safeMetric(ownDataValue(metrics, "linkCount")),
      durationMs: safeMetric(ownDataValue(metrics, "durationMs")),
      statusCode: statusCode >= 100 && statusCode <= 599 ? statusCode : 0,
    },
    signals: {
      hadBody: ownDataValue(signals, "hadBody") === true,
      hadHtml: ownDataValue(signals, "hadHtml") === true,
      hadUrl: ownDataValue(signals, "hadUrl") === true,
    },
    debug: {
      active,
      transport: active ? normalizeEnum(ownDataValue(debug, "transport"), TRANSPORTS) : "unknown",
      contentType: active ? normalizeEnum(ownDataValue(debug, "contentType"), CONTENT_TYPES) : "unknown",
      payloadShape: active ? normalizeEnum(ownDataValue(debug, "payloadShape"), PAYLOAD_SHAPES) : "unknown",
      topLevelFieldCount: active ? safeMetric(ownDataValue(debug, "topLevelFieldCount")) : 0,
      fieldCount: active ? safeMetric(ownDataValue(debug, "fieldCount")) : 0,
      maxDepth: active ? safeMetric(ownDataValue(debug, "maxDepth")) : 0,
      sensitiveFieldCount: active ? safeMetric(ownDataValue(debug, "sensitiveFieldCount")) : 0,
      credentialLikeCount: active ? safeMetric(ownDataValue(debug, "credentialLikeCount")) : 0,
      phoneLikeCount: active ? safeMetric(ownDataValue(debug, "phoneLikeCount")) : 0,
      signedUrlCount: active ? safeMetric(ownDataValue(debug, "signedUrlCount")) : 0,
      absolutePathCount: active ? safeMetric(ownDataValue(debug, "absolutePathCount")) : 0,
      htmlValueCount: active ? safeMetric(ownDataValue(debug, "htmlValueCount")) : 0,
    },
  };
}

export function isManagedDiagnosticFilename(name) {
  return typeof name === "string" && MANAGED_EVENT_RE.test(name);
}

function managedTimestamp(name) {
  const match = MANAGED_EVENT_RE.exec(name);
  return match ? Number(match[1]) : Number.NaN;
}

function managedTempTimestamp(name) {
  const match = MANAGED_TEMP_RE.exec(name);
  return match ? Number(match[1]) : Number.NaN;
}

function freshRandomId(randomId) {
  let candidate;
  try {
    candidate = typeof randomId === "function" ? randomId() : randomBytes(12).toString("hex");
  } catch {
    candidate = randomBytes(12).toString("hex");
  }
  return typeof candidate === "string" && /^[0-9a-f]{24}$/.test(candidate)
    ? candidate
    : randomBytes(12).toString("hex");
}

function safeError(error, fallback = "diagnostics_io_error") {
  return error instanceof DiagnosticsError ? error : new DiagnosticsError(fallback);
}

function emit(logger, level, payload) {
  try {
    if (logger && typeof logger[level] === "function") logger[level](payload);
  } catch {
    // Diagnostic logging must never affect the guarded operation.
  }
}

function publicLog(component, action, result, extra = {}) {
  return { schemaVersion: 1, component, action, result, ...extra };
}

async function lstatIfExists(fsApi, path) {
  try {
    return await fsApi.lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function openNoFollow(fsApi, path, flags) {
  return fsApi.open(path, flags | (fsConstants.O_NOFOLLOW ?? 0));
}

function assertCurrentOwner(stat) {
  const getuid = process.getuid;
  if (typeof getuid !== "function") return;
  let uid;
  try {
    uid = getuid.call(process);
  } catch {
    return;
  }
  if (Number.isInteger(stat.uid) && stat.uid !== uid) {
    throw new DiagnosticsError("diagnostics_owner_mismatch");
  }
}

function assertOwnedRegularStat(stat) {
  if (!stat.isFile()) throw new DiagnosticsError("diagnostics_non_regular_file_rejected");
  assertCurrentOwner(stat);
  if (Number.isInteger(stat.nlink) && stat.nlink !== 1) {
    throw new DiagnosticsError("diagnostics_hardlink_rejected");
  }
}

function assertOwnedManagedTempStat(stat) {
  if (!stat.isFile()) throw new DiagnosticsError("diagnostics_non_regular_file_rejected");
  assertCurrentOwner(stat);
  if (Number.isInteger(stat.nlink) && stat.nlink !== 1 && stat.nlink !== 2) {
    throw new DiagnosticsError("diagnostics_hardlink_rejected");
  }
}

async function hardenRegularFile(fsApi, path, { enforcePosixModes = true } = {}) {
  let handle;
  try {
    handle = await openNoFollow(fsApi, path, fsConstants.O_RDONLY);
    const stat = await handle.stat();
    assertOwnedRegularStat(stat);
    if (enforcePosixModes) await handle.chmod(0o600);
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Create a diagnostics store rooted at `<dataDir>/diag`.
 * The returned object deliberately exposes no filesystem path.
 */
export function createDiagnosticStore({
  dataDir,
  policy: rawPolicy = {},
  env = process.env,
  now = () => Date.now(),
  fs = defaultFs,
  logger = null,
  randomId = null,
  platform = process.platform,
} = {}) {
  if (typeof dataDir !== "string" || dataDir.length === 0) {
    throw new DiagnosticsError("diagnostics_data_dir_required");
  }
  const diagnosticsDir = join(dataDir, "diag");
  const createdAtMs = validNow(now);
  const policy = resolveDiagnosticsPolicy(rawPolicy, env, createdAtMs);
  const enforcePosixModes = platform !== "win32";
  let operationTail = Promise.resolve();
  let existingFilesHardened = false;

  function enqueue(action, operation) {
    const run = operationTail.then(async () => {
      try {
        return await operation();
      } catch (error) {
        const safe = safeError(error);
        emit(logger, "error", publicLog("diagnostics", action, "error", { code: safe.code }));
        throw safe;
      }
    }, async () => {
      try {
        return await operation();
      } catch (error) {
        const safe = safeError(error);
        emit(logger, "error", publicLog("diagnostics", action, "error", { code: safe.code }));
        throw safe;
      }
    });
    operationTail = run.catch(() => {});
    return run;
  }

  async function ensureSecureDirectory() {
    await fs.mkdir(diagnosticsDir, { recursive: true, mode: 0o700 });
    const directoryStat = await fs.lstat(diagnosticsDir);
    if (directoryStat.isSymbolicLink()) throw new DiagnosticsError("diagnostics_symlink_rejected");
    if (!directoryStat.isDirectory()) throw new DiagnosticsError("diagnostics_path_not_directory");
    assertCurrentOwner(directoryStat);

    if (enforcePosixModes) {
      let directoryHandle;
      try {
        directoryHandle = await openNoFollow(
          fs,
          diagnosticsDir,
          fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY ?? 0),
        );
        const openedStat = await directoryHandle.stat();
        if (!openedStat.isDirectory()) throw new DiagnosticsError("diagnostics_path_not_directory");
        assertCurrentOwner(openedStat);
        await directoryHandle.chmod(0o700);
      } finally {
        await directoryHandle?.close().catch(() => {});
      }
    }

    // Legacy files may be numerous. Tighten them once per process without
    // reading their contents; subsequent operations only scan managed v2 names.
    if (existingFilesHardened) return;
    // Complete a stale link->unlink publish window before the generic nlink=1
    // hardening pass. This inspects metadata only and accepts nlink=2 solely
    // when the strict temp and its exact final name are the same inode.
    await reconcileInterruptedPublishes(currentTime());
    const names = await fs.readdir(diagnosticsDir);
    for (const name of names) {
      const entryPath = join(diagnosticsDir, name);
      const stat = await lstatIfExists(fs, entryPath);
      if (!stat) continue;
      if (stat.isSymbolicLink()) throw new DiagnosticsError("diagnostics_symlink_rejected");
      if (stat.isFile()) {
        assertOwnedRegularStat(stat);
        await hardenRegularFile(fs, entryPath, { enforcePosixModes });
      }
    }
    existingFilesHardened = true;
  }

  async function collectManagedFiles() {
    const names = await fs.readdir(diagnosticsDir);
    const files = [];
    for (const name of names) {
      if (!isManagedDiagnosticFilename(name)) continue;
      const path = join(diagnosticsDir, name);
      const stat = await lstatIfExists(fs, path);
      if (!stat) continue;
      if (stat.isSymbolicLink()) throw new DiagnosticsError("diagnostics_symlink_rejected");
      assertOwnedRegularStat(stat);
      files.push({
        name,
        path,
        size: safeMetric(stat.size),
        mtimeMs: Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : 0,
        timestampMs: managedTimestamp(name),
      });
    }
    return files;
  }

  async function collectManagedTempFiles() {
    const names = await fs.readdir(diagnosticsDir);
    const files = [];
    for (const name of names) {
      if (!MANAGED_TEMP_RE.test(name)) continue;
      const path = join(diagnosticsDir, name);
      const stat = await lstatIfExists(fs, path);
      if (!stat) continue;
      if (stat.isSymbolicLink()) throw new DiagnosticsError("diagnostics_symlink_rejected");
      assertOwnedManagedTempStat(stat);
      files.push({
        name,
        path,
        size: safeMetric(stat.size),
        mtimeMs: Number.isFinite(stat.mtimeMs) ? stat.mtimeMs : Number.NaN,
        timestampMs: managedTempTimestamp(name),
        dev: stat.dev,
        ino: stat.ino,
        nlink: stat.nlink,
      });
    }
    return files;
  }

  async function removeManaged(file) {
    if (!isManagedDiagnosticFilename(file.name)) throw new DiagnosticsError("diagnostics_unmanaged_delete_rejected");
    const stat = await lstatIfExists(fs, file.path);
    if (!stat) return false;
    if (stat.isSymbolicLink()) throw new DiagnosticsError("diagnostics_symlink_rejected");
    assertOwnedRegularStat(stat);
    await fs.unlink(file.path);
    return true;
  }

  async function removeManagedTemp(file) {
    if (!MANAGED_TEMP_RE.test(file.name)) throw new DiagnosticsError("diagnostics_unmanaged_delete_rejected");
    const stat = await lstatIfExists(fs, file.path);
    if (!stat) return false;
    if (stat.isSymbolicLink()) throw new DiagnosticsError("diagnostics_symlink_rejected");
    assertOwnedRegularStat(stat);
    try {
      await fs.unlink(file.path);
      return true;
    } catch (error) {
      if (error?.code === "ENOENT") return false;
      throw error;
    }
  }

  function managedTempIsFresh(file, currentMs) {
    const freshestTime = Math.max(file.timestampMs, file.mtimeMs);
    return !Number.isFinite(freshestTime)
      || freshestTime > currentMs
      || currentMs - freshestTime < MANAGED_TEMP_STALE_MS;
  }

  async function validateInterruptedPublish(file) {
    const match = MANAGED_TEMP_RE.exec(file.name);
    if (!match || file.nlink !== 2) throw new DiagnosticsError("diagnostics_hardlink_rejected");
    const finalName = `${MANAGED_DIAGNOSTIC_PREFIX}${match[1]}-${match[2]}.json`;
    if (!isManagedDiagnosticFilename(finalName)) throw new DiagnosticsError("diagnostics_hardlink_rejected");
    const finalPath = join(diagnosticsDir, finalName);
    const finalStat = await lstatIfExists(fs, finalPath);
    if (!finalStat) throw new DiagnosticsError("diagnostics_hardlink_rejected");
    if (finalStat.isSymbolicLink()) throw new DiagnosticsError("diagnostics_symlink_rejected");
    if (!finalStat.isFile()) throw new DiagnosticsError("diagnostics_non_regular_file_rejected");
    assertCurrentOwner(finalStat);
    if (finalStat.nlink !== 2
      || finalStat.dev !== file.dev
      || finalStat.ino !== file.ino) {
      throw new DiagnosticsError("diagnostics_hardlink_rejected");
    }
    return { finalPath };
  }

  async function completeInterruptedPublish(file) {
    const { finalPath } = await validateInterruptedPublish(file);
    try {
      await fs.unlink(file.path);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    const completedStat = await lstatIfExists(fs, finalPath);
    if (!completedStat) throw new DiagnosticsError("diagnostics_publish_incomplete");
    assertOwnedRegularStat(completedStat);
    if (completedStat.dev !== file.dev || completedStat.ino !== file.ino) {
      throw new DiagnosticsError("diagnostics_hardlink_rejected");
    }
    await hardenRegularFile(fs, finalPath, { enforcePosixModes });
    return true;
  }

  async function reconcileInterruptedPublishes(currentMs) {
    const temps = await collectManagedTempFiles();
    for (const file of temps) {
      if (file.nlink !== 2) continue;
      await validateInterruptedPublish(file);
      if (managedTempIsFresh(file, currentMs)) {
        throw new DiagnosticsError("diagnostics_concurrent_writer_detected");
      }
      await completeInterruptedPublish(file);
    }
  }

  async function reconcileManagedTemps(currentMs, allowedFreshName = null) {
    const temps = await collectManagedTempFiles();
    if (allowedFreshName !== null && !temps.some((file) => file.name === allowedFreshName)) {
      throw new DiagnosticsError("diagnostics_temp_missing");
    }

    const stale = [];
    let removed = 0;
    for (const file of temps) {
      if (file.name === allowedFreshName) {
        if (file.nlink !== 1) throw new DiagnosticsError("diagnostics_hardlink_rejected");
        continue;
      }
      if (file.nlink === 2) await validateInterruptedPublish(file);
      if (managedTempIsFresh(file, currentMs)) {
        // A recent temp may belong to another live process. Never inspect or
        // delete it; fail closed so concurrent writers cannot bypass limits.
        throw new DiagnosticsError("diagnostics_concurrent_writer_detected");
      }
      if (file.nlink === 2) {
        if (await completeInterruptedPublish(file)) removed += 1;
      } else {
        stale.push(file);
      }
    }

    for (const file of stale) {
      if (await removeManagedTemp(file)) removed += 1;
    }
    return { removed };
  }

  async function pruneManaged({
    currentMs,
    incomingBytes = 0,
    reserveSlot = false,
    allowedFreshTempName = null,
  }) {
    const tempPruning = await reconcileManagedTemps(currentMs, allowedFreshTempName);
    if (incomingBytes > policy.retention.maxBytes || incomingBytes > policy.retention.maxEventBytes) {
      return { capacity: false, removed: tempPruning.removed };
    }
    let files = await collectManagedFiles();
    let removed = tempPruning.removed;
    const cutoff = currentMs - policy.retention.maxAgeMs;
    for (const file of files) {
      const effectiveTime = Number.isFinite(file.timestampMs) ? file.timestampMs : file.mtimeMs;
      if (effectiveTime < cutoff && await removeManaged(file)) removed += 1;
    }
    if (removed > 0) files = await collectManagedFiles();

    files.sort((left, right) => {
      const leftTime = Number.isFinite(left.timestampMs) ? left.timestampMs : left.mtimeMs;
      const rightTime = Number.isFinite(right.timestampMs) ? right.timestampMs : right.mtimeMs;
      return leftTime - rightTime || left.name.localeCompare(right.name);
    });
    let totalBytes = files.reduce((sum, file) => addBounded(sum, file.size), 0);
    const targetCount = policy.retention.maxFiles - (reserveSlot ? 1 : 0);
    const targetBytes = policy.retention.maxBytes - incomingBytes;
    while (files.length > targetCount || totalBytes > targetBytes) {
      const oldest = files.shift();
      if (!oldest) break;
      if (await removeManaged(oldest)) {
        removed += 1;
        totalBytes = Math.max(0, totalBytes - oldest.size);
      }
    }
    return {
      capacity: files.length <= targetCount && totalBytes <= targetBytes,
      removed,
    };
  }

  async function atomicWriteEvent(event, currentMs) {
    const serialized = `${JSON.stringify(event)}\n`;
    const bytes = Buffer.byteLength(serialized, "utf8");
    if (bytes > policy.retention.maxEventBytes || bytes > policy.retention.maxBytes) {
      return { written: false, bytes, code: "event_too_large", removed: 0 };
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = freshRandomId(randomId);
      const finalName = `${MANAGED_DIAGNOSTIC_PREFIX}${String(currentMs).padStart(13, "0")}-${id}.json`;
      const tempName = `.zhitai-diag-v2-tmp-${String(currentMs).padStart(13, "0")}-${id}.json`;
      if (!MANAGED_EVENT_RE.test(finalName) || !MANAGED_TEMP_RE.test(tempName)) {
        throw new DiagnosticsError("diagnostics_invalid_clock");
      }
      const finalPath = join(diagnosticsDir, finalName);
      const tempPath = join(diagnosticsDir, tempName);
      let handle;
      let published = false;
      let ownsTemp = false;
      try {
        handle = await fs.open(tempPath, "wx", 0o600);
        ownsTemp = true;
        assertOwnedRegularStat(await handle.stat());
        if (enforcePosixModes) await handle.chmod(0o600);
        // The temp name doubles as a short-lived writer claim. Re-scan after
        // acquiring it: any other fresh temp means another process may be
        // writing, so fail closed. Re-reserve capacity while our empty temp is
        // visible to cover events published after the caller's first check.
        const reservation = await pruneManaged({
          currentMs,
          incomingBytes: bytes,
          reserveSlot: true,
          allowedFreshTempName: tempName,
        });
        if (!reservation.capacity) {
          await handle.close();
          handle = null;
          await removeManagedTemp({ name: tempName, path: tempPath });
          ownsTemp = false;
          return { written: false, bytes, code: "capacity_exceeded", removed: reservation.removed };
        }
        await handle.writeFile(serialized, { encoding: "utf8" });
        await handle.sync();
        await handle.close();
        handle = null;
        // A hard link publishes the fully-written inode atomically and, unlike
        // rename(), refuses to replace an existing event on an ID collision.
        await fs.link(tempPath, finalPath);
        published = true;
        await fs.unlink(tempPath);
        ownsTemp = false;
        await hardenRegularFile(fs, finalPath, { enforcePosixModes });
        return { written: true, bytes, removed: reservation.removed };
      } catch (error) {
        await handle?.close().catch(() => {});
        let cleanupError = null;
        if (ownsTemp) {
          try {
            await removeManagedTemp({ name: tempName, path: tempPath });
          } catch (cleanupFailure) {
            cleanupError = cleanupFailure;
          }
        }
        if (published) {
          try {
            await removeManaged({ name: finalName, path: finalPath });
          } catch (cleanupFailure) {
            cleanupError ??= cleanupFailure;
          }
        }
        if (cleanupError) throw cleanupError;
        if (error?.code === "EEXIST") continue;
        throw error;
      }
    }
    throw new DiagnosticsError("diagnostics_id_collision");
  }

  async function readManagedEvent(file) {
    if (!isManagedDiagnosticFilename(file.name)) throw new DiagnosticsError("diagnostics_unmanaged_read_rejected");
    if (file.size > policy.retention.maxEventBytes) return null;
    let handle;
    try {
      handle = await openNoFollow(fs, file.path, fsConstants.O_RDONLY);
      const stat = await handle.stat();
      assertOwnedRegularStat(stat);
      if (stat.size > policy.retention.maxEventBytes) return null;
      if (enforcePosixModes) await handle.chmod(0o600);
      const text = await handle.readFile({ encoding: "utf8" });
      return sanitizeStoredEvent(JSON.parse(text));
    } catch (error) {
      if (error instanceof DiagnosticsError) throw error;
      return null;
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  function currentTime() {
    return validNow(now);
  }

  function record(input, meta = {}) {
    return enqueue("record", async () => {
      await ensureSecureDirectory();
      const currentMs = currentTime();
      const active = debugIsActive(policy, currentMs);
      const event = projectDiagnosticEvent(input, { meta, now: currentMs, debugActive: active });
      const bytes = Buffer.byteLength(`${JSON.stringify(event)}\n`, "utf8");
      const pruning = await pruneManaged({ currentMs, incomingBytes: bytes, reserveSlot: true });
      if (!pruning.capacity) {
        const result = { schemaVersion: 1, accepted: false, code: "capacity_exceeded", debugActive: active };
        emit(logger, "warn", publicLog("diagnostics", "record", "dropped", {
          code: result.code,
          debugActive: active,
        }));
        return result;
      }
      const writeResult = await atomicWriteEvent(event, currentMs);
      if (!writeResult.written) {
        const result = {
          schemaVersion: 1,
          accepted: false,
          code: writeResult.code,
          debugActive: active,
        };
        emit(logger, "warn", publicLog("diagnostics", "record", "dropped", {
          code: result.code,
          debugActive: active,
        }));
        return result;
      }
      const result = { schemaVersion: 1, accepted: true, code: "recorded", debugActive: active };
      emit(logger, "info", publicLog("diagnostics", "record", "stored", {
        debugActive: active,
        rotatedCount: safeMetric(pruning.removed + writeResult.removed),
      }));
      return result;
    });
  }

  function status() {
    return enqueue("status", async () => {
      await ensureSecureDirectory();
      const currentMs = currentTime();
      await pruneManaged({ currentMs });
      const files = await collectManagedFiles();
      const timestamps = files
        .map((file) => file.timestampMs)
        .filter(Number.isFinite)
        .sort((left, right) => left - right);
      const debugActive = debugIsActive(policy, currentMs);
      const debugReason = debugActive
        ? "authorized"
        : policy.debug.enabled && currentMs >= policy.debug.expiresAtMs
          ? "expired"
          : policy.debug.reason;
      return {
        schemaVersion: 1,
        mode: "structured_only",
        debug: {
          active: debugActive,
          reason: debugReason,
          expiresAt: policy.debug.expiresAtMs === null ? null : toIso(policy.debug.expiresAtMs),
          maxDurationMs: policy.debug.maxDurationMs,
        },
        retention: {
          maxAgeMs: policy.retention.maxAgeMs,
          maxFiles: policy.retention.maxFiles,
          maxBytes: policy.retention.maxBytes,
          maxEventBytes: policy.retention.maxEventBytes,
        },
        managedEvents: {
          count: files.length,
          totalBytes: files.reduce((sum, file) => addBounded(sum, file.size), 0),
          oldestAt: timestamps.length > 0 ? toIso(timestamps[0]) : null,
          newestAt: timestamps.length > 0 ? toIso(timestamps.at(-1)) : null,
        },
        permissions: {
          model: enforcePosixModes ? "posix_mode" : "windows_profile_acl",
          directory: enforcePosixModes ? "0700" : null,
          regularFile: enforcePosixModes ? "0600" : null,
        },
      };
    });
  }

  function exportBundle() {
    return enqueue("export", async () => {
      await ensureSecureDirectory();
      const currentMs = currentTime();
      await pruneManaged({ currentMs });
      const files = await collectManagedFiles();
      files.sort((left, right) => left.timestampMs - right.timestampMs || left.name.localeCompare(right.name));
      const events = [];
      let skippedEventCount = 0;
      for (const file of files) {
        const event = await readManagedEvent(file);
        if (event) events.push(event);
        else skippedEventCount += 1;
      }
      const bundle = {
        schemaVersion: 1,
        generatedAt: toIso(currentMs),
        eventSchemaVersion: DIAGNOSTIC_EVENT_SCHEMA_VERSION,
        eventCount: events.length,
        skippedEventCount,
        events,
      };
      emit(logger, "info", publicLog("diagnostics", "export", "created", {
        eventCount: events.length,
        skippedEventCount,
      }));
      return bundle;
    });
  }

  function initialize() {
    return enqueue("initialize", async () => {
      await ensureSecureDirectory();
      const currentMs = currentTime();
      const pruning = await pruneManaged({ currentMs });
      const result = {
        schemaVersion: 1,
        initialized: true,
        code: "ready",
        rotatedCount: safeMetric(pruning.removed),
      };
      emit(logger, "info", publicLog("diagnostics", "initialize", "ready", {
        rotatedCount: result.rotatedCount,
      }));
      return result;
    });
  }

  return Object.freeze({ initialize, record, status, exportBundle });
}
