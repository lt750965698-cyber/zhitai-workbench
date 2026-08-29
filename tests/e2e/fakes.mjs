/** Offline-only adapters and deterministic fault injection for chain E2E tests. */
import { createHash } from "node:crypto";
import {
  createDeterministicMedia,
  createInvalidMedia,
  createSilentMedia,
} from "./synthetic-media.mjs";

export const FAULT_CODES = Object.freeze({
  DOWNLOAD_500: "DOWNLOAD_500",
  EXPIRED_SIGNATURE: "EXPIRED_SIGNATURE",
  INVALID_MEDIA: "INVALID_MEDIA",
  SILENT_MEDIA: "SILENT_MEDIA",
  LOGIN_EXPIRED: "LOGIN_EXPIRED",
  CAPTCHA_REQUIRED: "CAPTCHA_REQUIRED",
  PLATFORM_FAILURE: "PLATFORM_FAILURE",
  ENOSPC: "ENOSPC",
  PROCESS_CRASH: "PROCESS_CRASH",
});

const FAULT_ALIASES = new Map([
  ["download 500", FAULT_CODES.DOWNLOAD_500],
  ["download_500", FAULT_CODES.DOWNLOAD_500],
  ["500", FAULT_CODES.DOWNLOAD_500],
  ["expired signature", FAULT_CODES.EXPIRED_SIGNATURE],
  ["expired_signature", FAULT_CODES.EXPIRED_SIGNATURE],
  ["invalid", FAULT_CODES.INVALID_MEDIA],
  ["invalid_media", FAULT_CODES.INVALID_MEDIA],
  ["silent", FAULT_CODES.SILENT_MEDIA],
  ["silent_media", FAULT_CODES.SILENT_MEDIA],
  ["login expired", FAULT_CODES.LOGIN_EXPIRED],
  ["login_expired", FAULT_CODES.LOGIN_EXPIRED],
  ["captcha", FAULT_CODES.CAPTCHA_REQUIRED],
  ["captcha_required", FAULT_CODES.CAPTCHA_REQUIRED],
  ["single failure", FAULT_CODES.PLATFORM_FAILURE],
  ["single_failure", FAULT_CODES.PLATFORM_FAILURE],
  ["platform_failure", FAULT_CODES.PLATFORM_FAILURE],
  ["enospc", FAULT_CODES.ENOSPC],
  ["disk_full", FAULT_CODES.ENOSPC],
  ["process_crash", FAULT_CODES.PROCESS_CRASH],
]);

export function normalizeFaultCode(value) {
  if (!value) return null;
  const raw = typeof value === "object" ? value.code ?? value.fault : value;
  const upper = String(raw).trim().toUpperCase().replace(/[ -]+/g, "_");
  return FAULT_ALIASES.get(String(raw).trim().toLowerCase()) ?? FAULT_CODES[upper] ?? upper;
}

export class FaultInjectionError extends Error {
  constructor(code, options = {}) {
    const normalized = normalizeFaultCode(code) ?? "INJECTED_FAILURE";
    super(options.message ?? faultMessage(normalized));
    this.name = normalized === FAULT_CODES.PROCESS_CRASH ? "SimulatedProcessCrash" : "FaultInjectionError";
    this.code = normalized;
    this.status = options.status ?? (normalized === FAULT_CODES.DOWNLOAD_500 ? 500 : undefined);
    this.retryable = options.retryable ?? ![
      FAULT_CODES.INVALID_MEDIA,
      FAULT_CODES.SILENT_MEDIA,
      FAULT_CODES.CAPTCHA_REQUIRED,
      FAULT_CODES.LOGIN_EXPIRED,
      FAULT_CODES.EXPIRED_SIGNATURE,
    ].includes(normalized);
    this.injected = true;
    this.details = options.details ?? {};
  }
}

function faultMessage(code) {
  return ({
    [FAULT_CODES.DOWNLOAD_500]: "synthetic downloader returned HTTP 500",
    [FAULT_CODES.EXPIRED_SIGNATURE]: "synthetic signed delivery has expired",
    [FAULT_CODES.INVALID_MEDIA]: "synthetic media is invalid",
    [FAULT_CODES.SILENT_MEDIA]: "synthetic media contains no audible samples",
    [FAULT_CODES.LOGIN_EXPIRED]: "fake platform login has expired",
    [FAULT_CODES.CAPTCHA_REQUIRED]: "fake platform requires a verification challenge",
    [FAULT_CODES.PLATFORM_FAILURE]: "fake platform rejected the delivery",
    [FAULT_CODES.ENOSPC]: "synthetic disk is full",
    [FAULT_CODES.PROCESS_CRASH]: "simulated process crash",
  })[code] ?? `injected fault: ${code}`;
}

function normalizeRule(rule) {
  if (typeof rule === "string") return { code: normalizeFaultCode(rule), remaining: 1 };
  if (typeof rule === "number") return { code: FAULT_CODES.PLATFORM_FAILURE, remaining: rule };
  if (!rule || typeof rule !== "object") throw new TypeError("fault rule must be a string or object");
  const times = rule.times ?? rule.remaining ?? (rule.once === false ? Number.POSITIVE_INFINITY : 1);
  return {
    ...rule,
    code: normalizeFaultCode(rule),
    remaining: times === Infinity ? Number.POSITIVE_INFINITY : Math.max(0, Number(times)),
  };
}

/**
 * A point-addressed, consumable fault plan. Points may be stages (download),
 * platform-specific stages (platform:alpha), or adapter operations
 * (alpha:readback). Rules are consumed in insertion order.
 */
export class FaultPlan {
  #rules = new Map();

  constructor(spec = {}) {
    if (spec instanceof FaultPlan) return spec;
    for (const [point, rules] of Object.entries(spec ?? {})) {
      for (const rule of Array.isArray(rules) ? rules : [rules]) this.add(point, rule);
    }
  }

  add(point, rule) {
    const key = String(point);
    const rules = this.#rules.get(key) ?? [];
    rules.push(normalizeRule(rule));
    this.#rules.set(key, rules);
    return this;
  }

  clear(point) {
    if (point === undefined) this.#rules.clear();
    else this.#rules.delete(String(point));
    return this;
  }

  peek(point) {
    return (this.#rules.get(String(point)) ?? []).find((rule) => rule.remaining > 0) ?? null;
  }

  consume(point, context = {}) {
    const candidates = [
      String(point),
      context.platform ? `${point}:${context.platform}` : null,
      context.platform ? `${context.platform}:${point}` : null,
      context.stage && context.stage !== point ? String(context.stage) : null,
    ].filter(Boolean);
    let selected = null;
    for (const candidate of candidates) {
      const rule = this.peek(candidate);
      if (rule) {
        selected = rule;
        break;
      }
    }
    if (!selected) return null;
    if (Number.isFinite(selected.remaining)) selected.remaining -= 1;
    return { ...selected, remaining: selected.remaining };
  }

  throwIf(point, context = {}) {
    const fault = this.consume(point, context);
    if (!fault) return null;
    throw new FaultInjectionError(fault.code, fault);
  }

  snapshot() {
    const result = {};
    for (const [point, rules] of this.#rules) {
      result[point] = rules.map((rule) => ({ ...rule }));
    }
    return result;
  }
}

function cloneFixture(fixture) {
  return { ...fixture, bytes: Buffer.from(fixture.bytes) };
}

export class FakeDownloader {
  constructor(options = {}) {
    this.offline = true;
    this.kind = "fake_downloader";
    this.faults = options.faults instanceof FaultPlan ? options.faults : new FaultPlan(options.faults);
    this.fixture = options.media ?? options.fixture ?? createDeterministicMedia(options.mediaOptions);
    this.calls = [];
  }

  async download(request = {}) {
    this.calls.push({
      correlationId: request.correlationId ?? null,
      sourceId: request.sourceId ?? null,
      attempt: this.calls.length + 1,
    });
    const fault = this.faults.consume("download", { ...request, stage: "download" });
    if (fault?.code === FAULT_CODES.INVALID_MEDIA) return cloneFixture(createInvalidMedia({ seed: request.correlationId }));
    if (fault?.code === FAULT_CODES.SILENT_MEDIA) return cloneFixture(createSilentMedia({ seed: request.correlationId }));
    if (fault) throw new FaultInjectionError(fault.code, fault);
    const source = request.media?.bytes ? request.media : this.fixture;
    return cloneFixture(source);
  }
}

function stableId(...values) {
  return createHash("sha256").update(values.map(String).join("\u0000")).digest("hex");
}

export class FakePlatformAdapter {
  constructor(name, options = {}) {
    if (!name) throw new TypeError("fake platform name is required");
    this.name = String(name);
    this.offline = true;
    this.kind = "fake_platform";
    this.faults = options.faults instanceof FaultPlan ? options.faults : new FaultPlan(options.faults);
    this.calls = [];
    this.metricBase = Number(options.metricBase ?? 10);
  }

  #fault(operation, request) {
    const context = { ...request, platform: this.name, stage: operation };
    const fault = this.faults.consume(operation, context)
      ?? this.faults.consume("platform", context);
    if (fault) throw new FaultInjectionError(fault.code, fault);
  }

  async createDraft(request = {}) {
    this.calls.push({ operation: "createDraft", correlationId: request.correlationId, attempt: this.calls.length + 1 });
    this.#fault("draft", request);
    return {
      draftId: `fake-draft-${stableId(this.name, request.correlationId, request.artifactHash).slice(0, 18)}`,
      platform: this.name,
      state: "draft",
    };
  }

  async publish(request = {}) {
    this.calls.push({ operation: "publish", correlationId: request.correlationId, attempt: this.calls.length + 1 });
    this.#fault("publish", request);
    const receiptSeed = stableId(this.name, request.correlationId, request.draftId, request.artifactHash);
    return {
      receiptId: `fake-receipt-${receiptSeed.slice(0, 20)}`,
      platform: this.name,
      remoteState: "accepted",
      acceptedAt: request.now ?? "2000-01-01T00:00:00.000Z",
      synthetic: true,
    };
  }

  async readback(request = {}) {
    this.calls.push({ operation: "readback", correlationId: request.correlationId, attempt: this.calls.length + 1 });
    this.#fault("readback", request);
    return {
      receiptId: request.receipt?.receiptId,
      remoteState: "published",
      checkedAt: request.now ?? "2000-01-01T00:00:00.000Z",
      synthetic: true,
    };
  }

  async metrics(request = {}) {
    this.calls.push({ operation: "metrics", correlationId: request.correlationId, attempt: this.calls.length + 1 });
    this.#fault("metrics", request);
    const offset = Number.parseInt(stableId(this.name, request.correlationId).slice(0, 4), 16) % 7;
    return {
      views: this.metricBase + offset,
      likes: Math.floor((this.metricBase + offset) / 3),
      comments: Math.floor((this.metricBase + offset) / 7),
      synthetic: true,
      capturedAt: request.now ?? "2000-01-01T00:00:00.000Z",
    };
  }

  callCount(operation) {
    return this.calls.filter((call) => call.operation === operation).length;
  }
}

export function createFakePlatforms(names = ["fake-alpha", "fake-beta"], options = {}) {
  return Object.fromEntries(names.map((name) => [
    name,
    new FakePlatformAdapter(name, {
      ...options,
      faults: options.faultsByPlatform?.[name] ?? options.faults,
    }),
  ]));
}

export class FakeClock {
  constructor(now = "2030-01-01T00:00:00.000Z") {
    this.value = new Date(now).getTime();
    if (!Number.isFinite(this.value)) throw new TypeError("FakeClock requires a valid date");
  }

  now = () => new Date(this.value);

  iso = () => this.now().toISOString();

  advance(milliseconds) {
    this.value += Number(milliseconds);
    return this.now();
  }

  set(now) {
    const value = new Date(now).getTime();
    if (!Number.isFinite(value)) throw new TypeError("FakeClock requires a valid date");
    this.value = value;
    return this.now();
  }
}

export const createFakeDownloader = (options) => new FakeDownloader(options);
export const createFakePlatformAdapter = (name, options) => new FakePlatformAdapter(name, options);
