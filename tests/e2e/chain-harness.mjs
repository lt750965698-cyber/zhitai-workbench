/**
 * Fully offline, file-backed chain harness.
 *
 * It intentionally models the workflow instead of importing production
 * adapters: every boundary is an explicitly offline fake and every durable
 * transition is observable in SQLite.
 */
import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  FAULT_CODES,
  FakeDownloader,
  FaultInjectionError,
  FaultPlan,
  createFakePlatforms,
} from "./fakes.mjs";
import {
  createDeterministicMedia,
  inspectSyntheticMedia,
} from "./synthetic-media.mjs";

export const STAGES = Object.freeze([
  "receive",
  "download",
  "media_validate",
  "ingest",
  "analyze",
  "generate",
  "quality",
  "review",
  "draft",
  "schedule",
  "readback",
  "metrics",
]);

export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY = /(?:authorization|cookie|token|secret|password|passwd|passcode|api[-_]?key|access[-_]?key|refresh[-_]?key|session|credential|captcha|verification[-_]?code|otp|signature|signed[-_]?url|account|chat|phone|e[-_]?mail)/i;
const URL_KEY = /(?:url|uri|href)$/i;
const STAGE_INDEX = new Map(STAGES.map((stage, index) => [stage, index]));

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

function sanitizeString(value) {
  return String(value)
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, (candidate) => sanitizeUrl(candidate))
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
    .replace(/\b(?:token|secret|password|passcode|api[_-]?key|authorization|cookie|session|credential|signature|captcha|otp|verification[_-]?code|account|chat)\s*[:=]\s*[^\s,;]+/gi, (match) => `${match.split(/[:=]/, 1)[0]}=${REDACTED}`)
    .replace(/([?&](?:token|secret|signature|sig|key|auth|code)=)[^&#\s]+/gi, `$1${encodeURIComponent(REDACTED)}`)
    .replace(/(?:\/Users\/|\/home\/)[^\s"'<>]+/g, "[PRIVATE_PATH]")
    .replace(/[A-Za-z]:\\Users\\[^\s"'<>]+/gi, "[PRIVATE_PATH]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, "[REDACTED_PHONE]");
}

function sanitizeUrl(value) {
  const text = String(value);
  try {
    const parsed = new URL(text);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
    }
    if (parsed.pathname && parsed.pathname !== "/") parsed.pathname = "/[REDACTED_PATH]";
    if (parsed.search) parsed.search = `?${encodeURIComponent(REDACTED)}`;
    parsed.hash = "";
    return parsed.toString();
  } catch {
    const scheme = text.match(/^([a-z][a-z0-9+.-]*:)/i)?.[1] ?? "url:";
    return `${scheme}[REDACTED_URL]`;
  }
}

/** Return a JSON-safe recursively redacted copy. Input objects are not changed. */
export function redactSensitive(value, options = {}) {
  const seen = options.seen ?? new WeakSet();
  const key = options.key ?? "";
  if (SENSITIVE_KEY.test(key) && !/^containsReal(?:Accounts|Chats)$/i.test(key)) return REDACTED;
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") return URL_KEY.test(key) ? sanitizeUrl(value) : sanitizeString(value);
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) {
    const bytes = Buffer.from(value.buffer ?? value, value.byteOffset ?? 0, value.byteLength ?? value.length);
    return `[BINARY sha256=${digest(bytes)} bytes=${bytes.length}]`;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return safeError(value);
  if (typeof value !== "object") return String(value);
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactSensitive(item, { seen }));
  const copy = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    copy[childKey] = redactSensitive(childValue, { seen, key: childKey });
  }
  return copy;
}

export const deepRedact = redactSensitive;

function safeError(error) {
  return redactSensitive({
    name: error?.name ?? "Error",
    code: error?.code ?? "CHAIN_STAGE_FAILED",
    message: sanitizeString(error?.message ?? String(error)),
    status: error?.status,
    retryable: error?.retryable ?? false,
    injected: error?.injected ?? false,
    details: error?.details ?? {},
  });
}

function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === "") return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function json(value) {
  return JSON.stringify(redactSensitive(value));
}

function toIso(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`invalid date: ${value}`);
  return date.toISOString();
}

function withoutMediaBytes(input) {
  const copy = { ...input };
  if (Buffer.isBuffer(copy.media)) copy.media = { bytes: copy.media };
  if (copy.media?.bytes) {
    const bytes = Buffer.from(copy.media.bytes);
    copy.media = {
      ...copy.media,
      bytes: `[BINARY sha256=${digest(bytes)} bytes=${bytes.length}]`,
    };
  }
  return copy;
}

export const DEFAULT_SYNTHETIC_INBOX_SECRET = "zhitai-offline-e2e-inbox-secret-v1";

function inputMediaBytes(input) {
  if (Buffer.isBuffer(input.media)) return Buffer.from(input.media);
  if (input.media?.bytes) return Buffer.from(input.media.bytes);
  return createDeterministicMedia({ seed: input.deliveryId ?? input.sourceId }).bytes;
}

function rawBodySha256(rawBody) {
  if (rawBody === undefined) return null;
  if (Buffer.isBuffer(rawBody) || ArrayBuffer.isView(rawBody)) return digest(Buffer.from(rawBody));
  if (typeof rawBody === "string") return digest(Buffer.from(rawBody));
  return digest(Buffer.from(stableJson(rawBody)));
}

function semanticDeliveryPayload(input) {
  const mediaBytes = inputMediaBytes(input);
  const mediaSha256 = digest(mediaBytes);
  const prompt = String(input.prompt ?? "Create a synthetic offline E2E derivative.");
  const promptSha256 = digest(Buffer.from(prompt));
  const deliveryKey = String(input.deliveryKey ?? input.deliveryId ?? input.messageId ?? `media-${mediaSha256}`);
  const promptId = String(input.promptId ?? `prompt-${promptSha256.slice(0, 20)}`);
  const correlationId = String(input.correlationId ?? `corr-${digest(Buffer.from(`zhitai\u0000${deliveryKey}`)).slice(0, 24)}`);
  const effectiveProvenance = input.media?.provenance ?? input.provenance ?? null;
  return {
    deliveryKey,
    sourceId: String(input.sourceId ?? ""),
    correlationId,
    mediaSha256,
    mediaType: String(input.media?.mediaType ?? "audio/wav"),
    provenanceSha256: effectiveProvenance === null
      ? null
      : digest(Buffer.from(stableJson(effectiveProvenance))),
    promptId,
    promptSha256,
    rawBodySha256: rawBodySha256(input.rawBody),
    forceQualityFailure: Boolean(input.forceQualityFailure),
    qualityPass: input.qualityPass === undefined ? null : Boolean(input.qualityPass),
  };
}

function deliveryPayloadFingerprint(input) {
  return digest(Buffer.from(stableJson(semanticDeliveryPayload(input))));
}

function canonicalSignaturePayload(input, expiresAt, nonce) {
  return stableJson({
    ...semanticDeliveryPayload(input),
    expiresAt: toIso(expiresAt),
    nonce: String(nonce),
  });
}

/** Build a local HMAC-SHA256 envelope; the synthetic secret is never persisted. */
export function signSyntheticEnvelope(input, options = {}) {
  const secret = String(options.secret ?? DEFAULT_SYNTHETIC_INBOX_SECRET);
  const expiresAt = toIso(options.expiresAt ?? input.signature?.expiresAt ?? input.signatureExpiresAt);
  const nonce = String(options.nonce ?? input.signature?.nonce ?? `nonce-${digest(Buffer.from(String(input.deliveryId ?? input.sourceId ?? "fixture"))).slice(0, 16)}`);
  const canonical = canonicalSignaturePayload(input, expiresAt, nonce);
  const value = createHmac("sha256", secret).update(canonical).digest("hex");
  const copy = { ...input };
  delete copy.signatureExpiresAt;
  delete copy.signatureValid;
  return {
    ...copy,
    signature: {
      algorithm: "HMAC-SHA256",
      value,
      expiresAt,
      nonce,
    },
  };
}

function validSyntheticSignature(input, secret) {
  const signature = input.signature ?? {};
  if (signature.algorithm && String(signature.algorithm).toUpperCase() !== "HMAC-SHA256") return false;
  const expiresAt = signature.expiresAt ?? input.signatureExpiresAt ?? input.expiresAt;
  const nonce = signature.nonce ?? input.nonce ?? "";
  if (!expiresAt || !nonce || !signature.value) return false;
  const expected = createHmac("sha256", String(secret))
    .update(canonicalSignaturePayload(input, expiresAt, nonce))
    .digest();
  let actual;
  try {
    actual = Buffer.from(String(signature.value), "hex");
  } catch {
    return false;
  }
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function rowObject(row) {
  if (!row) return null;
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === "bigint" ? Number(value) : value]));
}

function publicRun(row) {
  const value = rowObject(row);
  if (!value) return null;
  return {
    correlationId: value.correlation_id,
    deliveryKey: value.delivery_key,
    payloadFingerprint: value.payload_fingerprint,
    status: value.status,
    currentStage: value.current_stage,
    promptId: value.prompt_id,
    promptHash: value.prompt_hash,
    source: parseJson(value.source_json, {}),
    provenance: parseJson(value.provenance_json, {}),
    qualityPass: value.quality_pass === null ? null : Boolean(value.quality_pass),
    reviewDecision: value.review_decision,
    scheduledFor: value.scheduled_for,
    needsReapproval: Boolean(value.needs_reapproval),
    bootId: value.boot_id,
    lastError: parseJson(value.last_error_json),
    createdAt: value.created_at,
    updatedAt: value.updated_at,
    completedAt: value.completed_at,
  };
}

function publicEvent(row) {
  const value = rowObject(row);
  return {
    id: value.id,
    correlationId: value.correlation_id,
    stage: value.stage,
    attempt: value.attempt,
    status: value.status,
    claimActive: Boolean(value.claim_token),
    bootId: value.boot_id,
    startedAt: value.started_at,
    finishedAt: value.finished_at,
    details: parseJson(value.details_json, {}),
    error: parseJson(value.error_json),
  };
}

function publicArtifact(row) {
  const value = rowObject(row);
  return {
    correlationId: value.correlation_id,
    artifactId: value.artifact_id,
    stage: value.stage,
    kind: value.kind,
    sha256: value.sha256,
    parentArtifactId: value.parent_artifact_id,
    promptId: value.prompt_id,
    promptHash: value.prompt_hash,
    provenance: parseJson(value.provenance_json, {}),
    details: parseJson(value.details_json, {}),
    createdAt: value.created_at,
  };
}

function publicDelivery(row) {
  const value = rowObject(row);
  return {
    correlationId: value.correlation_id,
    platform: value.platform,
    status: value.status,
    attemptCount: value.attempt_count,
    claimActive: Boolean(value.claim_token),
    claimedAt: value.claimed_at,
    draftId: value.draft_id,
    draft: parseJson(value.draft_json),
    successReceipt: parseJson(value.success_receipt_json),
    receiptHash: value.receipt_hash,
    lastError: parseJson(value.last_error_json),
    readbackStatus: value.readback_status,
    readback: parseJson(value.readback_json),
    metricsStatus: value.metrics_status,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  };
}

function publicAttempt(row) {
  const value = rowObject(row);
  return {
    id: value.id,
    correlationId: value.correlation_id,
    platform: value.platform,
    operation: value.operation,
    attempt: value.attempt,
    status: value.status,
    receiptHash: value.receipt_hash,
    error: parseJson(value.error_json),
    createdAt: value.created_at,
  };
}

function publicMetric(row) {
  const value = rowObject(row);
  return {
    id: value.id,
    correlationId: value.correlation_id,
    platform: value.platform,
    receiptHash: value.receipt_hash,
    snapshot: parseJson(value.snapshot_json, {}),
    capturedAt: value.captured_at,
  };
}

function initSchema(db) {
  // Set the lock wait policy before journal/schema PRAGMAs so simultaneous
  // worker/process startup serializes instead of failing during initialization.
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;

    CREATE TABLE IF NOT EXISTS runs (
      correlation_id TEXT PRIMARY KEY,
      delivery_key TEXT NOT NULL UNIQUE,
      payload_fingerprint TEXT NOT NULL,
      status TEXT NOT NULL,
      current_stage TEXT NOT NULL,
      prompt_id TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      source_json TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      quality_pass INTEGER,
      review_decision TEXT,
      scheduled_for TEXT,
      needs_reapproval INTEGER NOT NULL DEFAULT 0,
      boot_id TEXT NOT NULL,
      last_error_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS stage_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      correlation_id TEXT NOT NULL REFERENCES runs(correlation_id),
      stage TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      status TEXT NOT NULL,
      claim_token TEXT,
      boot_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      finished_at TEXT,
      details_json TEXT,
      error_json TEXT,
      UNIQUE(correlation_id, stage, attempt)
    );
    CREATE INDEX IF NOT EXISTS stage_events_trace_idx
      ON stage_events(correlation_id, id);

    CREATE TABLE IF NOT EXISTS media_blobs (
      correlation_id TEXT NOT NULL REFERENCES runs(correlation_id),
      role TEXT NOT NULL,
      bytes BLOB NOT NULL,
      sha256 TEXT NOT NULL,
      media_type TEXT NOT NULL,
      metadata_json TEXT NOT NULL,
      PRIMARY KEY(correlation_id, role)
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      correlation_id TEXT NOT NULL REFERENCES runs(correlation_id),
      artifact_id TEXT NOT NULL,
      stage TEXT NOT NULL,
      kind TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      parent_artifact_id TEXT,
      prompt_id TEXT NOT NULL,
      prompt_hash TEXT NOT NULL,
      provenance_json TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(correlation_id, artifact_id)
    );

    CREATE TABLE IF NOT EXISTS platform_deliveries (
      correlation_id TEXT NOT NULL REFERENCES runs(correlation_id),
      platform TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      claim_token TEXT,
      claimed_at TEXT,
      draft_id TEXT,
      draft_json TEXT,
      success_receipt_json TEXT,
      receipt_hash TEXT,
      last_error_json TEXT,
      readback_status TEXT NOT NULL DEFAULT 'pending',
      readback_json TEXT,
      metrics_status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(correlation_id, platform)
    );

    CREATE TABLE IF NOT EXISTS platform_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      correlation_id TEXT NOT NULL REFERENCES runs(correlation_id),
      platform TEXT NOT NULL,
      operation TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      status TEXT NOT NULL,
      receipt_hash TEXT,
      error_json TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS platform_attempts_trace_idx
      ON platform_attempts(correlation_id, platform, id);

    CREATE TABLE IF NOT EXISTS metric_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      correlation_id TEXT NOT NULL REFERENCES runs(correlation_id),
      platform TEXT NOT NULL,
      receipt_hash TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      captured_at TEXT NOT NULL,
      UNIQUE(correlation_id, platform, receipt_hash)
    );
  `);
  const runColumns = new Set(db.prepare("PRAGMA table_info(runs)").all().map((column) => column.name));
  if (!runColumns.has("payload_fingerprint")) {
    db.exec("ALTER TABLE runs ADD COLUMN payload_fingerprint TEXT");
    db.exec("UPDATE runs SET payload_fingerprint = 'legacy-' || correlation_id WHERE payload_fingerprint IS NULL");
  }
  const deliveryColumns = new Set(db.prepare("PRAGMA table_info(platform_deliveries)").all().map((column) => column.name));
  if (!deliveryColumns.has("claim_token")) db.exec("ALTER TABLE platform_deliveries ADD COLUMN claim_token TEXT");
  if (!deliveryColumns.has("claimed_at")) db.exec("ALTER TABLE platform_deliveries ADD COLUMN claimed_at TEXT");
  const stageColumns = new Set(db.prepare("PRAGMA table_info(stage_events)").all().map((column) => column.name));
  if (!stageColumns.has("claim_token")) db.exec("ALTER TABLE stage_events ADD COLUMN claim_token TEXT");
  const stageIndexes = new Set(db.prepare("PRAGMA index_list(stage_events)").all().map((index) => index.name));
  if (!stageIndexes.has("stage_events_one_running_idx")) {
    db.exec(`UPDATE stage_events SET status = 'interrupted', claim_token = NULL,
      finished_at = COALESCE(finished_at, started_at),
      error_json = COALESCE(error_json, '{"code":"MIGRATED_DUPLICATE_RUNNING_STAGE"}')
      WHERE status = 'running' AND id NOT IN (
        SELECT MIN(id) FROM stage_events WHERE status = 'running' GROUP BY correlation_id, stage
      )`);
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS stage_events_one_running_idx
      ON stage_events(correlation_id, stage) WHERE status = 'running'`);
  }
}

export class ChainHarness {
  constructor(options = {}) {
    const explicitDbPath = options.dbPath ? resolve(options.dbPath) : null;
    this.ownsRoot = !options.rootDir && !explicitDbPath;
    this.rootDir = resolve(options.rootDir ?? (explicitDbPath ? dirname(explicitDbPath) : mkdtempSync(join(tmpdir(), "zhitai-chain-e2e-"))));
    this.homeDir = resolve(options.homeDir ?? join(this.rootDir, "home"));
    this.dbPath = explicitDbPath ?? join(this.rootDir, "chain.sqlite");
    mkdirSync(this.rootDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.homeDir, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(this.dbPath), { recursive: true, mode: 0o700 });

    this.bootId = String(options.bootId ?? `boot-${randomUUID()}`);
    this.inboxSecret = String(options.inboxSecret ?? DEFAULT_SYNTHETIC_INBOX_SECRET);
    this.clock = options.clock ?? (() => new Date());
    this.beforeReceiveClaim = options.beforeReceiveClaim ?? options.hooks?.beforeReceiveClaim ?? null;
    if (this.beforeReceiveClaim !== null && typeof this.beforeReceiveClaim !== "function") {
      throw new TypeError("beforeReceiveClaim must be a synchronous function");
    }
    this.beforeReviewClaim = options.beforeReviewClaim ?? options.hooks?.beforeReviewClaim ?? null;
    if (this.beforeReviewClaim !== null && typeof this.beforeReviewClaim !== "function") {
      throw new TypeError("beforeReviewClaim must be a synchronous function");
    }
    this.beforeReviewPendingClaim = options.beforeReviewPendingClaim ?? options.hooks?.beforeReviewPendingClaim ?? null;
    if (this.beforeReviewPendingClaim !== null && typeof this.beforeReviewPendingClaim !== "function") {
      throw new TypeError("beforeReviewPendingClaim must be a synchronous function");
    }
    this.beforeReapprovalClaim = options.beforeReapprovalClaim ?? options.hooks?.beforeReapprovalClaim ?? null;
    if (this.beforeReapprovalClaim !== null && typeof this.beforeReapprovalClaim !== "function") {
      throw new TypeError("beforeReapprovalClaim must be a synchronous function");
    }
    this.faults = options.faults instanceof FaultPlan ? options.faults : new FaultPlan(options.faults);
    this.downloader = options.downloader ?? new FakeDownloader({ faults: options.downloadFaults });
    this.#assertOffline(this.downloader, "downloader");

    const adapters = options.platformAdapters ?? options.platforms;
    if (Array.isArray(adapters)) this.platformAdapters = createFakePlatforms(adapters);
    else if (adapters && typeof adapters === "object") this.platformAdapters = { ...adapters };
    else this.platformAdapters = createFakePlatforms();
    for (const [name, adapter] of Object.entries(this.platformAdapters)) this.#assertOffline(adapter, `platform ${name}`);

    this.env = Object.freeze({
      HOME: this.homeDir,
      ZHITAI_E2E_DB: this.dbPath,
      ZHITAI_OFFLINE: "1",
      NO_PROXY: "*",
      no_proxy: "*",
    });
    this.db = new DatabaseSync(this.dbPath);
    initSchema(this.db);
    this.closed = false;
  }

  #assertOffline(adapter, label) {
    if (!adapter || adapter.offline !== true) {
      throw new Error(`${label} must explicitly declare offline=true`);
    }
  }

  now(value) {
    if (value !== undefined) return toIso(value);
    const current = typeof this.clock === "function" ? this.clock() : this.clock.now();
    return toIso(current);
  }

  addPlatform(name, adapter) {
    this.#assertOffline(adapter, `platform ${name}`);
    this.platformAdapters[String(name)] = adapter;
    return this;
  }

  injectFault(point, rule) {
    this.faults.add(point, rule);
    return this;
  }

  clearFaults(point) {
    this.faults.clear(point);
    return this;
  }

  receive(input = {}) {
    return this.#receive(input, { signed: false });
  }

  receiveSigned(input = {}) {
    return this.#receive(input, { signed: true });
  }

  signDelivery(input, options = {}) {
    return signSyntheticEnvelope(input, { ...options, secret: this.inboxSecret });
  }

  #receive(input, { signed, validation = null }) {
    if (!input || typeof input !== "object") throw new TypeError("receive input must be an object");
    const suppliedMedia = Buffer.isBuffer(input.media) ? { bytes: input.media } : input.media;
    const media = suppliedMedia?.bytes ? suppliedMedia : createDeterministicMedia({ seed: input.deliveryId ?? input.sourceId });
    const mediaBytes = Buffer.from(media.bytes);
    const mediaHash = digest(mediaBytes);
    const prompt = String(input.prompt ?? "Create a synthetic offline E2E derivative.");
    const promptHash = digest(Buffer.from(prompt));
    const promptId = String(input.promptId ?? `prompt-${promptHash.slice(0, 20)}`);
    const deliveryKey = String(input.deliveryKey ?? input.deliveryId ?? input.messageId ?? `media-${mediaHash}`);
    const correlationId = String(input.correlationId ?? `corr-${digest(Buffer.from(`zhitai\u0000${deliveryKey}`)).slice(0, 24)}`);
    const payloadFingerprint = deliveryPayloadFingerprint(input);
    // input.receivedAt is untrusted metadata. Authentication and expiry always
    // use the harness clock so a sender cannot backdate an expired envelope.
    const now = this.now();

    // Authentication deliberately happens before looking up a dedupe key. A
    // forged retry must never receive the success semantics of an earlier,
    // legitimate delivery with the same key.
    let receiveError = validation?.error ?? null;
    if (!validation) {
      try {
        const fault = this.faults.consume("receive", { correlationId, stage: "receive" });
        if (fault) throw new FaultInjectionError(fault.code, fault);
        if (signed) {
          const expiresAt = input.signature?.expiresAt ?? input.signatureExpiresAt ?? input.expiresAt;
          if (!expiresAt) throw new FaultInjectionError(FAULT_CODES.EXPIRED_SIGNATURE, { message: "signed envelope is missing expiresAt" });
          const expiresAtMs = new Date(expiresAt).getTime();
          if (!Number.isFinite(expiresAtMs) || expiresAtMs <= new Date(now).getTime()) {
            throw new FaultInjectionError(FAULT_CODES.EXPIRED_SIGNATURE);
          }
          if (!validSyntheticSignature(input, this.inboxSecret)) {
            throw new FaultInjectionError(FAULT_CODES.EXPIRED_SIGNATURE, { message: "synthetic HMAC-SHA256 signature is invalid" });
          }
        }
      } catch (error) {
        receiveError = error;
      }
    }

    const existing = this.db.prepare("SELECT * FROM runs WHERE delivery_key = ?").get(deliveryKey);
    const persistedCorrelationId = existing?.correlation_id ?? correlationId;

    const source = redactSensitive(withoutMediaBytes({
      ...input,
      prompt: undefined,
      promptId,
      media: { ...media, bytes: mediaBytes },
    }));
    const provenance = redactSensitive({
      correlationId: persistedCorrelationId,
      sourceArtifactId: media.id ?? `source-${mediaHash.slice(0, 20)}`,
      sourceSha256: mediaHash,
      promptId,
      promptHash,
      media: media.provenance ?? input.provenance ?? { synthetic: true, authorized: true },
      delivery: { deliveryKey, signed, payloadFingerprint },
    });

    if (existing) {
      const existingProvenance = parseJson(existing.provenance_json, {});
      const acceptedReceive = this.#stageSucceeded(existing.correlation_id, "receive");
      if (!receiveError && existingProvenance.delivery?.signed && !signed) {
        receiveError = new FaultInjectionError("SIGNATURE_REQUIRED", {
          message: "a signed delivery key can only be retried through receiveSigned",
          retryable: false,
        });
      }
      if (!receiveError && acceptedReceive && existing.payload_fingerprint !== payloadFingerprint) {
        const conflict = new Error("delivery key was already accepted with a different authenticated payload");
        conflict.code = "DELIVERY_KEY_CONFLICT";
        conflict.retryable = false;
        conflict.correlationId = existing.correlation_id;
        this.#recordReceiveEvent(existing.correlation_id, "conflict", now, {
          details: {
            deliveryKey,
            acceptedPayloadFingerprint: existing.payload_fingerprint,
            rejectedPayloadFingerprint: payloadFingerprint,
          },
          error: conflict,
        });
        throw conflict;
      }
      if (receiveError) {
        this.#recordReceiveEvent(existing.correlation_id, "failed", now, {
          details: { deliveryKey, signed, authenticatedBeforeDedupe: true },
          error: receiveError,
        });
        receiveError.correlationId = existing.correlation_id;
        throw receiveError;
      }

      if (existing.status === "receive_failed" && !this.#stageSucceeded(existing.correlation_id, "receive")) {
        this.db.exec("BEGIN IMMEDIATE");
        let recoveryTransactionOpen = true;
        try {
          const locked = this.db.prepare(`SELECT status,
            EXISTS(SELECT 1 FROM stage_events
              WHERE correlation_id = ? AND stage = 'receive' AND status = 'success') AS accepted
            FROM runs WHERE correlation_id = ?`)
            .get(existing.correlation_id, existing.correlation_id);
          if (locked.status !== "receive_failed" || Boolean(locked.accepted)) {
            this.db.exec("ROLLBACK");
            recoveryTransactionOpen = false;
            return this.#receive(input, { signed, validation: { error: null } });
          }
          this.db.prepare(`UPDATE runs SET status = 'received', current_stage = 'receive',
            payload_fingerprint = ?, prompt_id = ?, prompt_hash = ?, source_json = ?, provenance_json = ?,
            quality_pass = NULL, review_decision = NULL, scheduled_for = NULL,
            needs_reapproval = 0, boot_id = ?, last_error_json = NULL,
            updated_at = ?, completed_at = NULL WHERE correlation_id = ?`)
            .run(payloadFingerprint, promptId, promptHash, json(source), json(provenance), this.bootId, now, existing.correlation_id);
          this.db.prepare(`INSERT INTO media_blobs
            (correlation_id, role, bytes, sha256, media_type, metadata_json)
            VALUES (?, 'source', ?, ?, ?, ?)
            ON CONFLICT(correlation_id, role) DO UPDATE SET bytes = excluded.bytes,
              sha256 = excluded.sha256, media_type = excluded.media_type,
              metadata_json = excluded.metadata_json`)
            .run(existing.correlation_id, mediaBytes, mediaHash, media.mediaType ?? "audio/wav", json({
              id: media.id,
              filename: media.filename,
              provenance: media.provenance,
            }));
          this.#recordReceiveEvent(existing.correlation_id, "success", now, {
            details: { deliveryKey, signed, mediaSha256: mediaHash, promptId, promptHash, recoveredReceive: true },
          });
          this.db.exec("COMMIT");
          recoveryTransactionOpen = false;
        } catch (error) {
          if (recoveryTransactionOpen) this.db.exec("ROLLBACK");
          throw error;
        }
        return {
          correlationId: existing.correlation_id,
          duplicate: false,
          recovered: true,
          status: "received",
          run: this.getRun(existing.correlation_id),
        };
      }

      this.#recordReceiveEvent(existing.correlation_id, "deduplicated", now, {
        details: { deliveryKey, duplicate: true, authenticatedBeforeDedupe: signed },
      });
      return { correlationId: existing.correlation_id, duplicate: true, status: existing.status, run: publicRun(existing) };
    }

    const status = receiveError ? "receive_failed" : "received";
    if (!validation && this.beforeReceiveClaim) {
      const hookResult = this.beforeReceiveClaim({
        correlationId,
        deliveryKey,
        payloadFingerprint,
        signed,
      });
      if (hookResult && typeof hookResult.then === "function") {
        throw new TypeError("beforeReceiveClaim must be synchronous");
      }
    }
    this.db.exec("BEGIN IMMEDIATE");
    let receiveTransactionOpen = true;
    try {
      // The preflight lookup can race another connection. Recheck only after
      // obtaining SQLite's write lock, then route the loser through the same
      // authenticated dedupe/conflict logic without consuming faults twice.
      const raced = this.db.prepare("SELECT 1 FROM runs WHERE delivery_key = ?").get(deliveryKey);
      if (raced) {
        this.db.exec("ROLLBACK");
        receiveTransactionOpen = false;
        return this.#receive(input, { signed, validation: { error: receiveError } });
      }
      this.db.prepare(`INSERT INTO runs
        (correlation_id, delivery_key, payload_fingerprint, status, current_stage, prompt_id, prompt_hash,
         source_json, provenance_json, boot_id, last_error_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'receive', ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(correlationId, deliveryKey, payloadFingerprint, status, promptId, promptHash, json(source), json(provenance),
          this.bootId, receiveError ? json(safeError(receiveError)) : null, now, now);
      this.db.prepare(`INSERT INTO media_blobs
        (correlation_id, role, bytes, sha256, media_type, metadata_json)
        VALUES (?, 'source', ?, ?, ?, ?)`)
        .run(correlationId, mediaBytes, mediaHash, media.mediaType ?? "audio/wav", json({
          id: media.id,
          filename: media.filename,
          provenance: media.provenance,
        }));
      this.db.prepare(`INSERT INTO stage_events
        (correlation_id, stage, attempt, status, boot_id, started_at, finished_at, details_json, error_json)
        VALUES (?, 'receive', 1, ?, ?, ?, ?, ?, ?)`)
        .run(correlationId, receiveError ? "failed" : "success", this.bootId, now, now,
          json({ deliveryKey, signed, mediaSha256: mediaHash, promptId, promptHash }),
          receiveError ? json(safeError(receiveError)) : null);
      this.db.exec("COMMIT");
      receiveTransactionOpen = false;
    } catch (error) {
      if (receiveTransactionOpen) this.db.exec("ROLLBACK");
      throw error;
    }
    if (receiveError) {
      receiveError.correlationId = correlationId;
      throw receiveError;
    }
    return { correlationId, duplicate: false, status, run: this.getRun(correlationId) };
  }

  getRun(correlationId) {
    return publicRun(this.db.prepare("SELECT * FROM runs WHERE correlation_id = ?").get(correlationId));
  }

  #requireRun(correlationId) {
    const run = this.getRun(correlationId);
    if (!run) throw new Error(`unknown correlationId: ${correlationId}`);
    return run;
  }

  #recordReceiveEvent(correlationId, status, now, options = {}) {
    return this.db.prepare(`INSERT INTO stage_events
      (correlation_id, stage, attempt, status, boot_id, started_at, finished_at, details_json, error_json)
      SELECT ?, 'receive', COALESCE(MAX(attempt), 0) + 1, ?, ?, ?, ?, ?, ?
      FROM stage_events WHERE correlation_id = ?`)
      .run(correlationId, status, this.bootId, now, now,
        json(options.details ?? {}), options.error ? json(safeError(options.error)) : null,
        correlationId);
  }

  #nextStageAttempt(correlationId, stage) {
    const row = this.db.prepare("SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM stage_events WHERE correlation_id = ? AND stage = ?")
      .get(correlationId, stage);
    return Number(row.attempt);
  }

  #stageSucceeded(correlationId, stage) {
    return Boolean(this.db.prepare("SELECT 1 FROM stage_events WHERE correlation_id = ? AND stage = ? AND status = 'success' LIMIT 1")
      .get(correlationId, stage));
  }

  #assertReceiveSucceeded(correlationId) {
    this.#requireRun(correlationId);
    if (!this.#stageSucceeded(correlationId, "receive")) {
      const error = new Error("run cannot advance because receive authentication did not succeed");
      error.code = "RECEIVE_NOT_ACCEPTED";
      error.correlationId = correlationId;
      error.stage = "receive";
      throw error;
    }
  }

  async #stage(correlationId, stage, execute, options = {}) {
    this.#requireRun(correlationId);
    if (stage !== "receive") this.#assertReceiveSucceeded(correlationId);
    const startedAt = this.now(options.now);
    const claimToken = `stage-claim-${randomUUID()}`;
    let attempt;
    this.db.exec("BEGIN IMMEDIATE");
    let claimTransactionOpen = true;
    try {
      const succeeded = this.#stageSucceeded(correlationId, stage);
      if (succeeded && !options.repeat) {
        this.db.exec("ROLLBACK");
        claimTransactionOpen = false;
        return { skipped: true, reason: "already_succeeded", run: this.getRun(correlationId) };
      }
      const running = this.db.prepare(`SELECT attempt FROM stage_events
        WHERE correlation_id = ? AND stage = ? AND status = 'running' LIMIT 1`)
        .get(correlationId, stage);
      if (running) {
        this.db.exec("ROLLBACK");
        claimTransactionOpen = false;
        return {
          skipped: true,
          reason: "already_running",
          ownerAttempt: Number(running.attempt),
          run: this.getRun(correlationId),
        };
      }
      attempt = this.#nextStageAttempt(correlationId, stage);
      this.db.prepare(`INSERT INTO stage_events
        (correlation_id, stage, attempt, status, claim_token, boot_id, started_at, details_json)
        VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`)
        .run(correlationId, stage, attempt, claimToken, this.bootId, startedAt, json(options.details ?? {}));
      this.db.prepare(`UPDATE runs SET status = 'running', current_stage = ?, boot_id = ?,
        last_error_json = NULL, updated_at = ? WHERE correlation_id = ?`)
        .run(stage, this.bootId, startedAt, correlationId);
      this.db.exec("COMMIT");
      claimTransactionOpen = false;
    } catch (error) {
      if (claimTransactionOpen) this.db.exec("ROLLBACK");
      throw error;
    }

    try {
      const fault = this.faults.consume(stage, { correlationId, stage });
      if (fault) throw new FaultInjectionError(fault.code, fault);
      const details = await execute({ attempt, startedAt });
      const finishedAt = this.now(options.now);
      this.db.exec("BEGIN IMMEDIATE");
      let completionTransactionOpen = true;
      try {
        const completed = this.db.prepare(`UPDATE stage_events SET status = 'success', claim_token = NULL,
          finished_at = ?, details_json = ?
          WHERE correlation_id = ? AND stage = ? AND attempt = ?
            AND status = 'running' AND claim_token = ?`)
          .run(finishedAt, json(details ?? {}), correlationId, stage, attempt, claimToken);
        if (Number(completed.changes) !== 1) {
          const leaseError = new Error("stage owner claim was lost before completion");
          leaseError.code = "STAGE_LEASE_LOST";
          throw leaseError;
        }
        this.db.prepare(`UPDATE runs SET status = ?, current_stage = ?, updated_at = ?, last_error_json = NULL
          WHERE correlation_id = ?`)
          .run(options.successStatus ?? "queued", stage, finishedAt, correlationId);
        this.db.exec("COMMIT");
        completionTransactionOpen = false;
      } catch (error) {
        if (completionTransactionOpen) this.db.exec("ROLLBACK");
        throw error;
      }
      return { skipped: false, stage, attempt, details: redactSensitive(details ?? {}), run: this.getRun(correlationId) };
    } catch (error) {
      const failedAt = this.now(options.now);
      const crash = error?.code === FAULT_CODES.PROCESS_CRASH;
      let stillOwned = false;
      if (!crash) {
        const failed = this.db.prepare(`UPDATE stage_events SET status = 'failed', claim_token = NULL,
          finished_at = ?, error_json = ?
          WHERE correlation_id = ? AND stage = ? AND attempt = ?
            AND status = 'running' AND claim_token = ?`)
          .run(failedAt, json(safeError(error)), correlationId, stage, attempt, claimToken);
        stillOwned = Number(failed.changes) === 1;
      } else {
        stillOwned = Boolean(this.db.prepare(`SELECT 1 FROM stage_events
          WHERE correlation_id = ? AND stage = ? AND attempt = ?
            AND status = 'running' AND claim_token = ?`)
          .get(correlationId, stage, attempt, claimToken));
      }
      if (stillOwned) {
        this.db.prepare(`UPDATE runs SET status = ?, current_stage = ?, updated_at = ?, last_error_json = ?
          WHERE correlation_id = ?`)
          .run(crash ? "interrupted" : options.failureStatus ?? "failed", stage, failedAt, json(safeError(error)), correlationId);
      }
      error.details = { ...(error.details ?? {}), correlationId, stage, attempt };
      error.correlationId = correlationId;
      error.stage = stage;
      throw error;
    }
  }

  #sourceBlob(correlationId, role) {
    const row = this.db.prepare("SELECT * FROM media_blobs WHERE correlation_id = ? AND role = ?")
      .get(correlationId, role);
    if (!row) throw new Error(`missing ${role} media for ${correlationId}`);
    return {
      bytes: Buffer.from(row.bytes),
      sha256: row.sha256,
      mediaType: row.media_type,
      metadata: parseJson(row.metadata_json, {}),
    };
  }

  #putBlob(correlationId, role, fixture) {
    const bytes = Buffer.from(fixture.bytes);
    const hash = digest(bytes);
    this.db.prepare(`INSERT INTO media_blobs
      (correlation_id, role, bytes, sha256, media_type, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(correlation_id, role) DO UPDATE SET
        bytes = excluded.bytes, sha256 = excluded.sha256,
        media_type = excluded.media_type, metadata_json = excluded.metadata_json`)
      .run(correlationId, role, bytes, hash, fixture.mediaType ?? "audio/wav", json({
        id: fixture.id,
        filename: fixture.filename,
        provenance: fixture.provenance,
      }));
    return hash;
  }

  #putArtifact(correlationId, stage, options) {
    const run = this.#requireRun(correlationId);
    const hash = options.sha256 ?? digest(Buffer.from(stableJson(options.details ?? {})));
    const artifactId = options.artifactId ?? `${stage}-${hash.slice(0, 20)}`;
    const now = this.now(options.now);
    const provenance = {
      correlationId,
      artifactId,
      stage,
      sourceArtifactId: run.provenance.sourceArtifactId,
      sourceSha256: run.provenance.sourceSha256,
      parentArtifactId: options.parentArtifactId ?? null,
      promptId: run.promptId,
      promptHash: run.promptHash,
      synthetic: true,
      offline: true,
      ...(options.provenance ?? {}),
    };
    this.db.prepare(`INSERT OR IGNORE INTO artifacts
      (correlation_id, artifact_id, stage, kind, sha256, parent_artifact_id,
       prompt_id, prompt_hash, provenance_json, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(correlationId, artifactId, stage, options.kind ?? "metadata", hash,
        options.parentArtifactId ?? null, run.promptId, run.promptHash,
        json(provenance), json(options.details ?? {}), now);
    return { artifactId, sha256: hash, provenance };
  }

  #lastArtifact(correlationId, stage) {
    return publicArtifact(this.db.prepare(`SELECT * FROM artifacts
      WHERE correlation_id = ? AND stage = ? ORDER BY created_at DESC, artifact_id DESC LIMIT 1`)
      .get(correlationId, stage));
  }

  async run(inputOrCorrelationId, options = {}) {
    let correlationId;
    if (typeof inputOrCorrelationId === "string") correlationId = inputOrCorrelationId;
    else correlationId = this.receive(inputOrCorrelationId ?? {}).correlationId;
    this.#assertReceiveSucceeded(correlationId);
    const stopAfter = options.stopAfter ?? "review";
    if (!STAGE_INDEX.has(stopAfter)) throw new TypeError(`unknown stopAfter stage: ${stopAfter}`);
    if (stopAfter === "receive") return this.inspect(correlationId);

    const handlers = {
      download: () => this.#download(correlationId),
      media_validate: () => this.#mediaValidate(correlationId),
      ingest: () => this.#ingest(correlationId),
      analyze: () => this.#analyze(correlationId),
      generate: () => this.#generate(correlationId),
      quality: () => this.#quality(correlationId),
    };
    for (const stage of STAGES.slice(1, STAGE_INDEX.get("quality") + 1)) {
      if (STAGE_INDEX.get(stage) > STAGE_INDEX.get(stopAfter)) break;
      const stageResult = await handlers[stage]();
      // Another process/call owns this durable stage. Do not let the loser
      // advance to dependent work while the owner's side effect is unfinished.
      if (stageResult?.skipped && stageResult.reason === "already_running") {
        return this.inspect(correlationId);
      }
    }
    if (STAGE_INDEX.get(stopAfter) <= STAGE_INDEX.get("quality")) return this.inspect(correlationId);

    if (!this.#stageSucceeded(correlationId, "review")) {
      if (!options.autoReview) {
        await this.#markReviewPending(correlationId);
        return this.inspect(correlationId);
      }
      await this.review(correlationId, { approved: true, reviewer: options.reviewer ?? "offline-human-reviewer" });
    }
    if (this.getRun(correlationId).reviewDecision !== "approved" || stopAfter === "review") return this.inspect(correlationId);
    const draftResult = await this.createDraft(correlationId, options.draft ?? {});
    if (draftResult?.skipped && draftResult.reason === "already_running") {
      return this.inspect(correlationId);
    }
    if (stopAfter === "draft") return this.inspect(correlationId);
    const scheduleResult = await this.schedule(correlationId, {
      scheduledFor: options.scheduledFor ?? this.now(),
      platforms: options.platforms ?? Object.keys(this.platformAdapters),
    });
    if (scheduleResult?.skipped && scheduleResult.reason === "already_running") {
      return this.inspect(correlationId);
    }
    if (stopAfter === "schedule" || options.dispatch === false) return this.inspect(correlationId);
    await this.dispatchDue({ correlationId, now: options.now ?? this.now() });
    if (STAGE_INDEX.get(stopAfter) <= STAGE_INDEX.get("schedule")) return this.inspect(correlationId);
    if (options.readback !== false && stopAfter === "readback") {
      await this.#readbackStage(correlationId, this.now(options.now ?? this.now()));
    } else if (options.readback !== false) {
      await this.readbackMetrics(correlationId, { now: options.now ?? this.now() });
    }
    return this.inspect(correlationId);
  }

  async runUntilReview(inputOrCorrelationId, options = {}) {
    return this.run(inputOrCorrelationId, { ...options, stopAfter: "review", autoReview: false });
  }

  async resume(correlationId, options = {}) {
    return this.run(correlationId, options);
  }

  async #download(correlationId) {
    return this.#stage(correlationId, "download", async () => {
      const run = this.#requireRun(correlationId);
      const sourceMedia = this.#sourceBlob(correlationId, "source");
      const fixture = await this.downloader.download({
        correlationId,
        sourceId: run.source.sourceId ?? run.provenance.sourceArtifactId,
        source: run.source,
        media: sourceMedia,
      });
      if (!fixture?.bytes) throw new Error("offline downloader returned no bytes");
      const mediaSha256 = this.#putBlob(correlationId, "downloaded", fixture);
      return { mediaSha256, bytes: fixture.bytes.length, mediaType: fixture.mediaType ?? "audio/wav" };
    });
  }

  async #mediaValidate(correlationId) {
    return this.#stage(correlationId, "media_validate", async () => {
      const blob = this.#sourceBlob(correlationId, "downloaded");
      const inspection = inspectSyntheticMedia(blob.bytes);
      if (!inspection.valid) throw new FaultInjectionError(FAULT_CODES.INVALID_MEDIA, { details: inspection, retryable: false });
      if (inspection.silent) throw new FaultInjectionError(FAULT_CODES.SILENT_MEDIA, { details: inspection, retryable: false });
      return inspection;
    }, { failureStatus: "media_rejected" });
  }

  async #ingest(correlationId) {
    return this.#stage(correlationId, "ingest", async () => {
      const blob = this.#sourceBlob(correlationId, "downloaded");
      return this.#putArtifact(correlationId, "ingest", {
        kind: "source_media",
        sha256: blob.sha256,
        details: { mediaType: blob.mediaType, bytes: blob.bytes.length },
      });
    });
  }

  async #analyze(correlationId) {
    return this.#stage(correlationId, "analyze", async () => {
      const blob = this.#sourceBlob(correlationId, "downloaded");
      const inspection = inspectSyntheticMedia(blob.bytes);
      const parent = this.#lastArtifact(correlationId, "ingest");
      const analysis = {
        durationMs: inspection.durationMs,
        peak: inspection.peak,
        rms: inspection.rms,
        summary: "deterministic synthetic PCM analysis",
      };
      return this.#putArtifact(correlationId, "analyze", {
        kind: "analysis",
        parentArtifactId: parent?.artifactId,
        details: analysis,
      });
    });
  }

  async #generate(correlationId) {
    return this.#stage(correlationId, "generate", async () => {
      const run = this.#requireRun(correlationId);
      const parent = this.#lastArtifact(correlationId, "analyze");
      const generated = createDeterministicMedia({
        seed: `${correlationId}:${run.promptHash}:${run.provenance.sourceSha256}`,
        durationMs: 400,
      });
      const outputSha256 = this.#putBlob(correlationId, "generated", generated);
      return this.#putArtifact(correlationId, "generate", {
        kind: "generated_media",
        sha256: outputSha256,
        parentArtifactId: parent?.artifactId,
        provenance: { generator: "deterministic_pcm_generator" },
        details: { mediaType: generated.mediaType, bytes: generated.bytes.length, durationMs: generated.durationMs },
      });
    });
  }

  async #quality(correlationId) {
    try {
      const result = await this.#stage(correlationId, "quality", async () => {
        const run = this.#requireRun(correlationId);
        const blob = this.#sourceBlob(correlationId, "generated");
        const inspection = inspectSyntheticMedia(blob.bytes);
        const explicitlyRejected = run.source.qualityPass === false || run.source.forceQualityFailure === true;
        if (!inspection.valid || inspection.silent || explicitlyRejected) {
          const error = new Error(explicitlyRejected ? "synthetic quality policy rejected output" : inspection.reason);
          error.code = "QUALITY_REJECTED";
          error.retryable = false;
          throw error;
        }
        const parent = this.#lastArtifact(correlationId, "generate");
        const artifact = this.#putArtifact(correlationId, "quality", {
          kind: "quality_report",
          parentArtifactId: parent?.artifactId,
          details: { pass: true, ...inspection },
        });
        this.db.prepare("UPDATE runs SET quality_pass = 1 WHERE correlation_id = ?").run(correlationId);
        return { pass: true, ...artifact };
      }, { successStatus: "awaiting_review", failureStatus: "quality_failed" });
      return result;
    } catch (error) {
      this.db.prepare("UPDATE runs SET quality_pass = 0 WHERE correlation_id = ?").run(correlationId);
      throw error;
    }
  }

  async #markReviewPending(correlationId) {
    const preflight = this.#requireRun(correlationId);
    if (!preflight.qualityPass) throw new Error("quality must pass before review");
    if (preflight.reviewDecision) {
      return { skipped: true, reason: "already_decided", decision: preflight.reviewDecision };
    }
    const preExisting = this.db.prepare(`SELECT attempt FROM stage_events
      WHERE correlation_id = ? AND stage = 'review' AND status = 'pending'
      ORDER BY attempt DESC LIMIT 1`).get(correlationId);
    if (preExisting) {
      return { skipped: true, reason: "already_pending", attempt: Number(preExisting.attempt) };
    }
    if (this.beforeReviewPendingClaim) {
      const hookResult = this.beforeReviewPendingClaim({ correlationId });
      if (hookResult && typeof hookResult.then === "function") {
        throw new TypeError("beforeReviewPendingClaim must be synchronous");
      }
    }
    const now = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    let transactionOpen = true;
    try {
      const locked = this.db.prepare(`SELECT quality_pass, review_decision FROM runs
        WHERE correlation_id = ?`).get(correlationId);
      if (!locked) throw new Error(`unknown correlationId: ${correlationId}`);
      if (!locked.quality_pass) throw new Error("quality must pass before review");
      // A review can win between quality completion and this pending marker.
      // Never move an immutable decision back to awaiting_review.
      if (locked.review_decision) {
        this.db.exec("ROLLBACK");
        transactionOpen = false;
        return { skipped: true, reason: "already_decided", decision: locked.review_decision };
      }
      const existing = this.db.prepare(`SELECT attempt FROM stage_events
        WHERE correlation_id = ? AND stage = 'review' AND status = 'pending'
        ORDER BY attempt DESC LIMIT 1`).get(correlationId);
      let attempt = existing ? Number(existing.attempt) : null;
      if (!existing) {
        attempt = this.#nextStageAttempt(correlationId, "review");
        this.db.prepare(`INSERT INTO stage_events
          (correlation_id, stage, attempt, status, boot_id, started_at, details_json)
          VALUES (?, 'review', ?, 'pending', ?, ?, ?)`)
          .run(correlationId, attempt, this.bootId, now, json({ manual: true }));
      }
      this.db.prepare(`UPDATE runs SET status = 'awaiting_review', current_stage = 'review', updated_at = ?
        WHERE correlation_id = ? AND review_decision IS NULL`).run(now, correlationId);
      this.db.exec("COMMIT");
      transactionOpen = false;
      return {
        skipped: Boolean(existing),
        reason: existing ? "already_pending" : undefined,
        attempt,
      };
    } catch (error) {
      if (transactionOpen) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async review(correlationId, options = {}) {
    const approved = options.approved ?? options.decision === "approved";
    const requestedDecision = approved ? "approved" : "rejected";
    const preflight = this.#requireRun(correlationId);
    if (!preflight.qualityPass) throw new Error("a failed quality gate cannot be approved");
    // Once persisted, a decision is immutable. This fast path is safe and
    // keeps deterministic barrier hooks scoped to actual claim contenders.
    if (preflight.reviewDecision) {
      return {
        duplicate: true,
        decision: preflight.reviewDecision,
        requestedDecision,
        run: preflight,
      };
    }
    if (this.beforeReviewClaim) {
      const hookResult = this.beforeReviewClaim({ correlationId, requestedDecision });
      if (hookResult && typeof hookResult.then === "function") {
        throw new TypeError("beforeReviewClaim must be synchronous");
      }
    }
    const now = this.now(options.now);
    const reviewerHash = digest(Buffer.from(String(options.reviewer ?? "offline-human-reviewer")));
    const details = { approved: Boolean(approved), reviewerHash, notes: options.notes };
    this.db.exec("BEGIN IMMEDIATE");
    let transactionOpen = true;
    try {
      // The write lock closes the preflight race. Both quality eligibility and
      // the immutable first-writer decision are authoritative only here.
      const locked = this.db.prepare(`SELECT quality_pass, review_decision FROM runs
        WHERE correlation_id = ?`).get(correlationId);
      if (!locked) throw new Error(`unknown correlationId: ${correlationId}`);
      if (!locked.quality_pass) throw new Error("a failed quality gate cannot be approved");
      if (locked.review_decision) {
        this.db.exec("ROLLBACK");
        transactionOpen = false;
        return {
          duplicate: true,
          decision: locked.review_decision,
          requestedDecision,
          run: this.getRun(correlationId),
        };
      }

      const pending = this.db.prepare(`SELECT id, attempt FROM stage_events
        WHERE correlation_id = ? AND stage = 'review' AND status = 'pending'
        ORDER BY attempt DESC LIMIT 1`).get(correlationId);
      if (pending) {
        const completed = this.db.prepare(`UPDATE stage_events
          SET status = 'success', finished_at = ?, details_json = ?
          WHERE id = ? AND status = 'pending'`)
          .run(now, json(details), pending.id);
        if (Number(completed.changes) !== 1) {
          const error = new Error("pending review was not exclusively owned");
          error.code = "REVIEW_CLAIM_LOST";
          throw error;
        }
      } else {
        const attempt = this.#nextStageAttempt(correlationId, "review");
        this.db.prepare(`INSERT INTO stage_events
          (correlation_id, stage, attempt, status, boot_id, started_at, finished_at, details_json)
          VALUES (?, 'review', ?, 'success', ?, ?, ?, ?)`)
          .run(correlationId, attempt, this.bootId, now, now, json(details));
      }
      const decided = this.db.prepare(`UPDATE runs SET status = ?, current_stage = 'review', review_decision = ?,
        updated_at = ? WHERE correlation_id = ? AND review_decision IS NULL AND quality_pass = 1`)
        .run(requestedDecision, requestedDecision, now, correlationId);
      if (Number(decided.changes) !== 1) {
        const error = new Error("review decision claim was lost before commit");
        error.code = "REVIEW_CLAIM_LOST";
        throw error;
      }
      this.db.exec("COMMIT");
      transactionOpen = false;
      return { duplicate: false, decision: requestedDecision, requestedDecision, run: this.getRun(correlationId) };
    } catch (error) {
      if (transactionOpen) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async createDraft(correlationId, options = {}) {
    const run = this.#requireRun(correlationId);
    if (run.reviewDecision !== "approved") throw new Error("approved human review is required before draft creation");
    return this.#stage(correlationId, "draft", async () => {
      const parent = this.#lastArtifact(correlationId, "generate");
      const draft = {
        title: options.title ?? `Offline draft ${correlationId.slice(-8)}`,
        caption: options.caption ?? "Synthetic offline E2E draft. Not for publication.",
        publishAllowed: false,
      };
      return this.#putArtifact(correlationId, "draft", {
        kind: "local_draft",
        parentArtifactId: parent?.artifactId,
        details: draft,
      });
    }, { successStatus: "draft_ready" });
  }

  async schedule(correlationId, options = {}) {
    const run = this.#requireRun(correlationId);
    if (!this.#stageSucceeded(correlationId, "draft")) throw new Error("draft must exist before scheduling");
    const scheduledFor = this.now(options.scheduledFor ?? this.now());
    const platforms = [...new Set(options.platforms ?? Object.keys(this.platformAdapters))].map(String);
    if (platforms.length === 0) throw new Error("at least one fake platform is required");
    for (const platform of platforms) {
      if (!this.platformAdapters[platform]) this.addPlatform(platform, createFakePlatforms([platform])[platform]);
    }
    if (this.#stageSucceeded(correlationId, "schedule")) {
      for (const platform of platforms) this.#ensureDelivery(correlationId, platform);
      return { duplicate: true, scheduledFor: run.scheduledFor, run: this.getRun(correlationId) };
    }
    const result = await this.#stage(correlationId, "schedule", async () => {
      for (const platform of platforms) this.#ensureDelivery(correlationId, platform);
      this.db.prepare(`UPDATE runs SET scheduled_for = ?, needs_reapproval = 0 WHERE correlation_id = ?`)
        .run(scheduledFor, correlationId);
      return { scheduledFor, platforms };
    }, { successStatus: "scheduled" });
    return {
      ...result,
      duplicate: Boolean(result.skipped),
      scheduledFor: result.skipped ? (result.run?.scheduledFor ?? scheduledFor) : scheduledFor,
    };
  }

  #ensureDelivery(correlationId, platform) {
    const now = this.now();
    this.db.prepare(`INSERT OR IGNORE INTO platform_deliveries
      (correlation_id, platform, status, created_at, updated_at)
      VALUES (?, ?, 'pending', ?, ?)`)
      .run(correlationId, platform, now, now);
  }

  #recordPlatformAttempt(correlationId, platform, operation, attempt, status, options = {}) {
    this.db.prepare(`INSERT INTO platform_attempts
      (correlation_id, platform, operation, attempt, status, receipt_hash, error_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(correlationId, platform, operation, attempt, status,
        options.receiptHash ?? null, options.error ? json(safeError(options.error)) : null,
        this.now(options.now));
  }

  async #dispatchPlatform(correlationId, platform, now, { failedOnly = false } = {}) {
    let delivery = publicDelivery(this.db.prepare(`SELECT * FROM platform_deliveries
      WHERE correlation_id = ? AND platform = ?`).get(correlationId, platform));
    if (!delivery) throw new Error(`platform ${platform} is not scheduled`);
    if (delivery.status === "success") return { platform, skipped: true, reason: "immutable_success" };
    if (failedOnly && delivery.status !== "failed") return { platform, skipped: true, reason: "not_failed" };

    // SQLite is the cross-call/cross-process mutex. Only the caller that moves
    // an eligible row to publishing owns the platform side effect.
    const claimToken = `claim-${randomUUID()}`;
    const claim = failedOnly
      ? this.db.prepare(`UPDATE platform_deliveries SET attempt_count = attempt_count + 1,
          status = 'publishing', claim_token = ?, claimed_at = ?, updated_at = ?
          WHERE correlation_id = ? AND platform = ? AND status = 'failed'`)
        .run(claimToken, now, now, correlationId, platform)
      : this.db.prepare(`UPDATE platform_deliveries SET attempt_count = attempt_count + 1,
          status = 'publishing', claim_token = ?, claimed_at = ?, updated_at = ?
          WHERE correlation_id = ? AND platform = ? AND status IN ('pending', 'failed')`)
        .run(claimToken, now, now, correlationId, platform);
    if (Number(claim.changes) !== 1) {
      const current = publicDelivery(this.db.prepare(`SELECT * FROM platform_deliveries
        WHERE correlation_id = ? AND platform = ?`).get(correlationId, platform));
      return {
        platform,
        skipped: true,
        reason: current?.status === "success" ? "immutable_success" : "already_claimed",
      };
    }
    delivery = publicDelivery(this.db.prepare(`SELECT * FROM platform_deliveries
      WHERE correlation_id = ? AND platform = ?`).get(correlationId, platform));
    const adapter = this.platformAdapters[platform];
    this.#assertOffline(adapter, `platform ${platform}`);
    const generated = this.#lastArtifact(correlationId, "generate");
    const localDraft = this.#lastArtifact(correlationId, "draft");
    const attempt = delivery.attemptCount;

    try {
      let draftId = delivery.draftId;
      if (!draftId) {
        try {
          const injected = this.faults.consume("draft_platform", { correlationId, platform, stage: "draft_platform" });
          if (injected) throw new FaultInjectionError(injected.code, injected);
          const draft = await adapter.createDraft({
            correlationId,
            artifactHash: generated.sha256,
            localDraft,
            now,
          });
          draftId = String(draft.draftId);
          const draftStored = this.db.prepare(`UPDATE platform_deliveries SET draft_id = ?, draft_json = ?, updated_at = ?
            WHERE correlation_id = ? AND platform = ? AND status = 'publishing' AND claim_token = ?`)
            .run(draftId, json(draft), now, correlationId, platform, claimToken);
          if (Number(draftStored.changes) !== 1) {
            const leaseError = new Error("platform publish lease was lost during draft creation");
            leaseError.code = "PUBLISH_LEASE_LOST";
            throw leaseError;
          }
          this.#recordPlatformAttempt(correlationId, platform, "draft", attempt, "success", { now });
        } catch (error) {
          this.#recordPlatformAttempt(correlationId, platform, "draft", attempt, "failed", { error, now });
          throw error;
        }
      }
      const injected = this.faults.consume("publish", { correlationId, platform, stage: "publish" });
      if (injected) throw new FaultInjectionError(injected.code, injected);
      const receipt = redactSensitive(await adapter.publish({
        correlationId,
        draftId,
        artifactHash: generated.sha256,
        scheduledFor: this.getRun(correlationId).scheduledFor,
        now,
      }));
      const receiptHash = digest(Buffer.from(stableJson(receipt)));

      this.db.exec("BEGIN IMMEDIATE");
      try {
        const current = this.db.prepare(`SELECT status, receipt_hash, claim_token FROM platform_deliveries
          WHERE correlation_id = ? AND platform = ?`).get(correlationId, platform);
        if (current.status !== "publishing" || current.claim_token !== claimToken) {
          const leaseError = new Error("platform publish lease is no longer owned by this dispatcher");
          leaseError.code = "PUBLISH_LEASE_LOST";
          throw leaseError;
        }
        const completed = this.db.prepare(`UPDATE platform_deliveries SET status = 'success',
            success_receipt_json = ?, receipt_hash = ?, last_error_json = NULL,
            claim_token = NULL, claimed_at = NULL, updated_at = ?
            WHERE correlation_id = ? AND platform = ?
              AND status = 'publishing' AND claim_token = ?`)
          .run(json(receipt), receiptHash, now, correlationId, platform, claimToken);
        if (Number(completed.changes) !== 1) {
          const leaseError = new Error("platform publish lease was lost before receipt commit");
          leaseError.code = "PUBLISH_LEASE_LOST";
          throw leaseError;
        }
        this.#recordPlatformAttempt(correlationId, platform, "publish", attempt, "success", { receiptHash, now });
        this.db.exec("COMMIT");
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
      return { platform, status: "success", receipt, receiptHash };
    } catch (error) {
      const current = this.db.prepare(`SELECT status FROM platform_deliveries
        WHERE correlation_id = ? AND platform = ?`).get(correlationId, platform);
      if (current.status !== "success") {
        this.db.prepare(`UPDATE platform_deliveries SET status = 'failed', last_error_json = ?,
          claim_token = NULL, claimed_at = NULL, updated_at = ?
          WHERE correlation_id = ? AND platform = ?
            AND status = 'publishing' AND claim_token = ?`)
          .run(json(safeError(error)), now, correlationId, platform, claimToken);
      }
      const alreadyLogged = this.db.prepare(`SELECT 1 FROM platform_attempts
        WHERE correlation_id = ? AND platform = ? AND operation = 'draft' AND attempt = ? AND status = 'failed'`)
        .get(correlationId, platform, attempt);
      if (!alreadyLogged) this.#recordPlatformAttempt(correlationId, platform, "publish", attempt, "failed", { error, now });
      if (error?.code === FAULT_CODES.PROCESS_CRASH) throw error;
      return { platform, status: "failed", error: safeError(error) };
    }
  }

  #updatePublishStatus(correlationId) {
    const counts = this.db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS succeeded,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status = 'publishing' THEN 1 ELSE 0 END) AS publishing
      FROM platform_deliveries WHERE correlation_id = ?`).get(correlationId);
    const total = Number(counts.total ?? 0);
    const succeeded = Number(counts.succeeded ?? 0);
    const failed = Number(counts.failed ?? 0);
    const publishing = Number(counts.publishing ?? 0);
    const status = total > 0 && succeeded === total
      ? "published"
      : publishing > 0
        ? "publishing"
        : succeeded > 0 && failed > 0
        ? "partial_success"
        : failed > 0
          ? "publish_failed"
          : "scheduled";
    this.db.prepare("UPDATE runs SET status = ?, updated_at = ? WHERE correlation_id = ?")
      .run(status, this.now(), correlationId);
    return { total, succeeded, failed, publishing, status };
  }

  async dispatchDue(options = {}) {
    const now = this.now(options.now ?? this.now());
    const candidates = options.correlationId
      ? this.db.prepare(`SELECT * FROM runs WHERE correlation_id = ? AND scheduled_for <= ?
          AND needs_reapproval = 0`).all(options.correlationId, now)
      : this.db.prepare(`SELECT * FROM runs WHERE scheduled_for <= ? AND needs_reapproval = 0
          AND status IN ('scheduled', 'partial_success', 'publish_failed', 'publishing')`).all(now);
    const results = [];
    for (const row of candidates) {
      const correlationId = row.correlation_id;
      this.db.prepare("UPDATE runs SET status = 'publishing', updated_at = ? WHERE correlation_id = ?")
        .run(now, correlationId);
      const deliveries = this.db.prepare(`SELECT platform FROM platform_deliveries
        WHERE correlation_id = ? AND status <> 'success' ORDER BY platform`).all(correlationId);
      const platformResults = [];
      for (const delivery of deliveries) {
        platformResults.push(await this.#dispatchPlatform(correlationId, delivery.platform, now));
      }
      results.push({ correlationId, platforms: platformResults, ...this.#updatePublishStatus(correlationId) });
    }
    return redactSensitive({ now, runs: results });
  }

  async retryFailedPlatforms(correlationId, options = {}) {
    const run = this.#requireRun(correlationId);
    if (run.needsReapproval) throw new Error("missed schedule requires reapproval before retry");
    const now = this.now(options.now ?? this.now());
    const failed = this.db.prepare(`SELECT platform FROM platform_deliveries
      WHERE correlation_id = ? AND status = 'failed' ORDER BY platform`).all(correlationId);
    const results = [];
    for (const row of failed) results.push(await this.#dispatchPlatform(correlationId, row.platform, now, { failedOnly: true }));
    return { correlationId, platforms: redactSensitive(results), ...this.#updatePublishStatus(correlationId) };
  }

  async #readbackStage(correlationId, now) {
    const pendingBefore = this.db.prepare(`SELECT COUNT(*) AS count FROM platform_deliveries
      WHERE correlation_id = ? AND status = 'success' AND readback_status <> 'success'`).get(correlationId);
    const publishCounts = this.db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS succeeded
      FROM platform_deliveries WHERE correlation_id = ?`).get(correlationId);
    const allPublished = Number(publishCounts.total ?? 0) > 0
      && Number(publishCounts.total) === Number(publishCounts.succeeded ?? 0);
    return this.#stage(correlationId, "readback", async () => {
      const deliveries = this.db.prepare(`SELECT * FROM platform_deliveries
        WHERE correlation_id = ? AND status = 'success' ORDER BY platform`).all(correlationId).map(publicDelivery);
      const results = [];
      for (const delivery of deliveries) {
        if (delivery.readbackStatus === "success") {
          results.push({ platform: delivery.platform, skipped: true });
          continue;
        }
        const adapter = this.platformAdapters[delivery.platform];
        const attempt = this.#nextPlatformOperationAttempt(correlationId, delivery.platform, "readback");
        try {
          const injected = this.faults.consume("readback", { correlationId, platform: delivery.platform, stage: "readback" });
          if (injected) throw new FaultInjectionError(injected.code, injected);
          const value = redactSensitive(await adapter.readback({
            correlationId,
            receipt: delivery.successReceipt,
            now,
          }));
          this.db.prepare(`UPDATE platform_deliveries SET readback_status = 'success', readback_json = ?,
            updated_at = ? WHERE correlation_id = ? AND platform = ?`)
            .run(json(value), now, correlationId, delivery.platform);
          this.#recordPlatformAttempt(correlationId, delivery.platform, "readback", attempt, "success", { now });
          results.push({ platform: delivery.platform, status: "success", value });
        } catch (error) {
          this.db.prepare(`UPDATE platform_deliveries SET readback_status = 'failed', updated_at = ?
            WHERE correlation_id = ? AND platform = ?`).run(now, correlationId, delivery.platform);
          this.#recordPlatformAttempt(correlationId, delivery.platform, "readback", attempt, "failed", { error, now });
          results.push({ platform: delivery.platform, status: "failed", error: safeError(error) });
        }
      }
      if (results.some((result) => result.status === "failed")) {
        const error = new Error("one or more fake platform readbacks failed");
        error.code = "READBACK_PARTIAL_FAILURE";
        error.details = results;
        throw error;
      }
      return { platforms: results };
    }, {
      successStatus: allPublished ? "readback_complete" : "partial_success",
      failureStatus: "readback_failed",
      repeat: Number(pendingBefore.count) > 0,
      now,
    });
  }

  async #metricsStage(correlationId, now) {
    const pendingBefore = this.db.prepare(`SELECT COUNT(*) AS count FROM platform_deliveries
      WHERE correlation_id = ? AND status = 'success' AND readback_status = 'success'
        AND metrics_status <> 'success'`).get(correlationId);
    const publishCounts = this.db.prepare(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS succeeded
      FROM platform_deliveries WHERE correlation_id = ?`).get(correlationId);
    const allPublished = Number(publishCounts.total ?? 0) > 0
      && Number(publishCounts.total) === Number(publishCounts.succeeded ?? 0);
    return this.#stage(correlationId, "metrics", async () => {
      const deliveries = this.db.prepare(`SELECT * FROM platform_deliveries
        WHERE correlation_id = ? AND status = 'success' AND readback_status = 'success' ORDER BY platform`)
        .all(correlationId).map(publicDelivery);
      const results = [];
      for (const delivery of deliveries) {
        if (delivery.metricsStatus === "success") {
          results.push({ platform: delivery.platform, skipped: true });
          continue;
        }
        const adapter = this.platformAdapters[delivery.platform];
        const attempt = this.#nextPlatformOperationAttempt(correlationId, delivery.platform, "metrics");
        try {
          const injected = this.faults.consume("metrics", { correlationId, platform: delivery.platform, stage: "metrics" });
          if (injected) throw new FaultInjectionError(injected.code, injected);
          const snapshot = redactSensitive(await adapter.metrics({
            correlationId,
            receipt: delivery.successReceipt,
            readback: delivery.readback,
            now,
          }));
          this.db.prepare(`INSERT OR IGNORE INTO metric_snapshots
            (correlation_id, platform, receipt_hash, snapshot_json, captured_at)
            VALUES (?, ?, ?, ?, ?)`)
            .run(correlationId, delivery.platform, delivery.receiptHash, json(snapshot), now);
          this.db.prepare(`UPDATE platform_deliveries SET metrics_status = 'success', updated_at = ?
            WHERE correlation_id = ? AND platform = ?`).run(now, correlationId, delivery.platform);
          this.#recordPlatformAttempt(correlationId, delivery.platform, "metrics", attempt, "success", { now });
          results.push({ platform: delivery.platform, status: "success", snapshot });
        } catch (error) {
          this.db.prepare(`UPDATE platform_deliveries SET metrics_status = 'failed', updated_at = ?
            WHERE correlation_id = ? AND platform = ?`).run(now, correlationId, delivery.platform);
          this.#recordPlatformAttempt(correlationId, delivery.platform, "metrics", attempt, "failed", { error, now });
          results.push({ platform: delivery.platform, status: "failed", error: safeError(error) });
        }
      }
      if (results.some((result) => result.status === "failed")) {
        const error = new Error("one or more fake platform metric snapshots failed");
        error.code = "METRICS_PARTIAL_FAILURE";
        error.details = results;
        throw error;
      }
      return { platforms: results };
    }, {
      successStatus: allPublished ? "completed" : "partial_success",
      failureStatus: "metrics_failed",
      repeat: Number(pendingBefore.count) > 0,
      now,
    });
  }

  #nextPlatformOperationAttempt(correlationId, platform, operation) {
    const row = this.db.prepare(`SELECT COALESCE(MAX(attempt), 0) + 1 AS attempt FROM platform_attempts
      WHERE correlation_id = ? AND platform = ? AND operation = ?`).get(correlationId, platform, operation);
    return Number(row.attempt);
  }

  async readbackMetrics(correlationId, options = {}) {
    const run = this.#requireRun(correlationId);
    const receipts = this.queryPlatformReceipts(correlationId);
    if (!receipts.some((receipt) => receipt.status === "success")) throw new Error("no successful fake platform receipt to read back");
    if (!["published", "partial_success", "readback_failed", "metrics_failed", "readback_complete", "completed"].includes(run.status)) {
      throw new Error(`cannot read back while run is ${run.status}`);
    }
    const now = this.now(options.now ?? this.now());
    const readbackResult = await this.#readbackStage(correlationId, now);
    if (readbackResult?.skipped && readbackResult.reason === "already_running") {
      return this.inspect(correlationId);
    }
    const metricsResult = await this.#metricsStage(correlationId, now);
    if (metricsResult?.skipped && metricsResult.reason === "already_running") {
      return this.inspect(correlationId);
    }
    this.db.prepare(`UPDATE runs SET completed_at = ?, updated_at = ?
      WHERE correlation_id = ? AND quality_pass = 1 AND status = 'completed'`)
      .run(now, now, correlationId);
    return this.inspect(correlationId);
  }

  recover(options = {}) {
    const newBootId = String(options.bootId ?? this.bootId);
    const now = this.now(options.now ?? this.now());
    const recovered = [];
    const needsReapproval = [];
    this.db.exec("BEGIN IMMEDIATE");
    let transactionOpen = true;
    try {
      // Both selections happen under the same write lock as all resulting
      // mutations. A crash can therefore expose either the entire recovery or
      // none of it; boot_id can never advance without the missed-schedule gate.
      const missedRows = this.db.prepare(`SELECT correlation_id FROM runs
        WHERE scheduled_for < ? AND needs_reapproval = 0 AND boot_id <> ?
          AND NOT EXISTS (
            SELECT 1 FROM platform_deliveries p
            WHERE p.correlation_id = runs.correlation_id AND p.status = 'success'
          )`).all(now, newBootId);
      const running = this.db.prepare(`SELECT DISTINCT r.correlation_id, r.boot_id, r.scheduled_for
        FROM runs r LEFT JOIN stage_events e ON e.correlation_id = r.correlation_id
        WHERE r.status IN ('running', 'interrupted', 'publishing') OR e.status = 'running'
          OR EXISTS (
            SELECT 1 FROM platform_deliveries p
            WHERE p.correlation_id = r.correlation_id AND p.status = 'publishing'
          )`).all();
      for (const row of running) {
        const reason = row.boot_id === newBootId ? "process_restart" : "mac_restart";
        this.db.prepare(`UPDATE stage_events SET status = 'interrupted', claim_token = NULL,
          finished_at = ?, error_json = ?
          WHERE correlation_id = ? AND status = 'running'`)
          .run(now, json({ code: "RECOVERED_INTERRUPTED_STAGE", reason }), row.correlation_id);
        this.db.prepare(`UPDATE platform_deliveries SET status = 'failed', last_error_json = ?,
          claim_token = NULL, claimed_at = NULL, updated_at = ?
          WHERE correlation_id = ? AND status = 'publishing'`)
          .run(json({ code: "RECOVERED_INTERRUPTED_DISPATCH", reason }), now, row.correlation_id);
        this.db.prepare(`UPDATE runs SET status = ?, boot_id = ?, updated_at = ?, last_error_json = NULL
          WHERE correlation_id = ?`)
          .run(row.scheduled_for ? "scheduled" : "queued", newBootId, now, row.correlation_id);
        recovered.push({ correlationId: row.correlation_id, reason });
      }
      for (const row of missedRows) {
        this.db.prepare(`UPDATE runs SET status = 'needs_reapproval', needs_reapproval = 1,
          boot_id = ?, updated_at = ? WHERE correlation_id = ?`)
          .run(newBootId, now, row.correlation_id);
        needsReapproval.push(row.correlation_id);
      }
      this.db.prepare(`UPDATE runs SET boot_id = ?, updated_at = ?
        WHERE boot_id <> ? AND completed_at IS NULL`).run(newBootId, now, newBootId);
      const fault = this.faults.consume("recover_commit", { stage: "recover_commit", bootId: newBootId });
      if (fault) throw new FaultInjectionError(fault.code, fault);
      this.db.exec("COMMIT");
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) this.db.exec("ROLLBACK");
      throw error;
    }
    this.bootId = newBootId;
    return { bootId: newBootId, recovered, needsReapproval, now };
  }

  reapproveSchedule(correlationId, options = {}) {
    const preflight = this.#requireRun(correlationId);
    const scheduledFor = this.now(options.scheduledFor ?? options.now ?? this.now());
    if (!preflight.needsReapproval) {
      return {
        duplicate: true,
        scheduledFor: preflight.scheduledFor,
        requestedScheduledFor: scheduledFor,
        run: preflight,
      };
    }
    if (this.beforeReapprovalClaim) {
      const hookResult = this.beforeReapprovalClaim({ correlationId, scheduledFor });
      if (hookResult && typeof hookResult.then === "function") {
        throw new TypeError("beforeReapprovalClaim must be a synchronous function");
      }
    }
    const now = this.now(options.now ?? this.now());
    const reviewerHash = digest(Buffer.from(String(options.reviewer ?? "offline-human-reviewer")));
    this.db.exec("BEGIN IMMEDIATE");
    let transactionOpen = true;
    try {
      const locked = this.db.prepare(`SELECT needs_reapproval, scheduled_for FROM runs
        WHERE correlation_id = ?`).get(correlationId);
      if (!locked) throw new Error(`unknown correlationId: ${correlationId}`);
      if (!locked.needs_reapproval) {
        this.db.exec("ROLLBACK");
        transactionOpen = false;
        return {
          duplicate: true,
          scheduledFor: locked.scheduled_for,
          requestedScheduledFor: scheduledFor,
          run: this.getRun(correlationId),
        };
      }
      const attempt = this.#nextStageAttempt(correlationId, "schedule");
      this.db.prepare(`INSERT INTO stage_events
        (correlation_id, stage, attempt, status, boot_id, started_at, finished_at, details_json)
        VALUES (?, 'schedule', ?, 'success', ?, ?, ?, ?)`)
        .run(correlationId, attempt, this.bootId, now, now,
          json({ reapproved: true, reviewerHash, scheduledFor }));
      const released = this.db.prepare(`UPDATE runs SET status = 'scheduled', needs_reapproval = 0,
        scheduled_for = ?, updated_at = ? WHERE correlation_id = ? AND needs_reapproval = 1`)
        .run(scheduledFor, now, correlationId);
      if (Number(released.changes) !== 1) {
        const error = new Error("schedule reapproval claim was lost before commit");
        error.code = "REAPPROVAL_CLAIM_LOST";
        throw error;
      }
      this.db.exec("COMMIT");
      transactionOpen = false;
      return { duplicate: false, scheduledFor, attempt, run: this.getRun(correlationId) };
    } catch (error) {
      if (transactionOpen) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  queryEvents(correlationId) {
    return this.db.prepare("SELECT * FROM stage_events WHERE correlation_id = ? ORDER BY id")
      .all(correlationId).map(publicEvent).map(redactSensitive);
  }

  queryArtifacts(correlationId) {
    return this.db.prepare("SELECT * FROM artifacts WHERE correlation_id = ? ORDER BY created_at, artifact_id")
      .all(correlationId).map(publicArtifact).map(redactSensitive);
  }

  queryPlatformReceipts(correlationId) {
    return this.db.prepare("SELECT * FROM platform_deliveries WHERE correlation_id = ? ORDER BY platform")
      .all(correlationId).map(publicDelivery).map(redactSensitive);
  }

  queryPlatformAttempts(correlationId) {
    return this.db.prepare("SELECT * FROM platform_attempts WHERE correlation_id = ? ORDER BY id")
      .all(correlationId).map(publicAttempt).map(redactSensitive);
  }

  queryAttemptCounts(correlationId) {
    const stages = this.db.prepare(`SELECT stage, COUNT(*) AS attempts,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures
      FROM stage_events WHERE correlation_id = ? GROUP BY stage ORDER BY MIN(id)`).all(correlationId);
    const platforms = this.db.prepare(`SELECT platform, operation, COUNT(*) AS attempts,
      SUM(CASE WHEN status = 'success' THEN 1 ELSE 0 END) AS successes,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failures
      FROM platform_attempts WHERE correlation_id = ? GROUP BY platform, operation ORDER BY platform, operation`)
      .all(correlationId);
    return redactSensitive({
      stages: stages.map(rowObject),
      platforms: platforms.map(rowObject),
    });
  }

  queryMetrics(correlationId) {
    return this.db.prepare("SELECT * FROM metric_snapshots WHERE correlation_id = ? ORDER BY id")
      .all(correlationId).map(publicMetric).map(redactSensitive);
  }

  trace(correlationId) {
    const run = this.#requireRun(correlationId);
    return redactSensitive({
      correlationId,
      prompt: { promptId: run.promptId, promptHash: run.promptHash },
      source: {
        artifactId: run.provenance.sourceArtifactId,
        sha256: run.provenance.sourceSha256,
        provenance: run.provenance.media,
      },
      artifacts: this.queryArtifacts(correlationId).map((artifact) => ({
        artifactId: artifact.artifactId,
        stage: artifact.stage,
        sha256: artifact.sha256,
        parentArtifactId: artifact.parentArtifactId,
        promptId: artifact.promptId,
        promptHash: artifact.promptHash,
      })),
      platformReceipts: this.queryPlatformReceipts(correlationId).map((delivery) => ({
        platform: delivery.platform,
        status: delivery.status,
        receiptHash: delivery.receiptHash,
        receiptId: delivery.successReceipt?.receiptId,
      })),
      metrics: this.queryMetrics(correlationId).map((metric) => ({
        platform: metric.platform,
        receiptHash: metric.receiptHash,
        capturedAt: metric.capturedAt,
      })),
    });
  }

  inspect(correlationId) {
    return redactSensitive({
      run: this.#requireRun(correlationId),
      events: this.queryEvents(correlationId),
      artifacts: this.queryArtifacts(correlationId),
      platformReceipts: this.queryPlatformReceipts(correlationId),
      platformAttempts: this.queryPlatformAttempts(correlationId),
      attemptCounts: this.queryAttemptCounts(correlationId),
      metrics: this.queryMetrics(correlationId),
      trace: this.trace(correlationId),
    });
  }

  report(correlationId) {
    const rows = correlationId
      ? this.db.prepare("SELECT correlation_id FROM runs WHERE correlation_id = ?").all(correlationId)
      : this.db.prepare("SELECT correlation_id FROM runs ORDER BY created_at, correlation_id").all();
    const runs = rows.map((row) => this.inspect(row.correlation_id));
    const summary = {
      totalRuns: runs.length,
      completedRuns: runs.filter((item) => item.run.status === "completed" && item.run.qualityPass).length,
      qualityRejectedRuns: runs.filter((item) => item.run.qualityPass === false).length,
      platformSuccesses: runs.flatMap((item) => item.platformReceipts).filter((item) => item.status === "success").length,
      platformFailures: runs.flatMap((item) => item.platformReceipts).filter((item) => item.status === "failed").length,
    };
    return redactSensitive({
      schemaVersion: "zhitai.offline-chain-report.v1",
      generatedAt: this.now(),
      offline: true,
      syntheticOnly: true,
      summary,
      runs,
    });
  }

  writeReport(filePath, correlationId) {
    const absolutePath = resolve(filePath);
    mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 });
    writeFileSync(absolutePath, `${JSON.stringify(this.report(correlationId), null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    return absolutePath;
  }

  close() {
    if (!this.closed) {
      this.db.close();
      this.closed = true;
    }
  }

  cleanup() {
    this.close();
    if (this.ownsRoot) rmSync(this.rootDir, { recursive: true, force: true });
  }
}

export function createChainHarness(options = {}) {
  return new ChainHarness(options);
}

export default createChainHarness;
