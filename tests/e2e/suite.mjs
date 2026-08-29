import { ChildProcess, fork, spawn } from "node:child_process";
import { fork as clusterFork } from "node:cluster";
import dgram from "node:dgram";
import dnsPromises from "node:dns/promises";
import { mkdir, readFile } from "node:fs/promises";
import { Agent as HttpAgent, ClientRequest } from "node:http";
import { Agent as HttpsAgent } from "node:https";
import net from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Worker } from "node:worker_threads";
import {
  createChainHarness,
  STAGES,
} from "./chain-harness.mjs";
import {
  createFakePlatforms,
  FakeClock,
  FaultPlan,
  FAULT_CODES,
} from "./fakes.mjs";
import { createDeterministicMedia } from "./synthetic-media.mjs";

const SUITE = "zhitai-offline-chain-e2e";
const FIXED_NOW = "2030-01-01T00:00:00.000Z";
const PLATFORM_NAMES = Object.freeze(["fake-alpha", "fake-beta"]);
const CRASH_EXIT_CODE = 86;
const CRASH_WORKER = fileURLToPath(new URL("./crash-worker.mjs", import.meta.url));
const NETWORK_LOCKDOWN = fileURLToPath(new URL("./network-lockdown.mjs", import.meta.url));

const REQUIRED_FAULTS = Object.freeze([
  "DUPLICATE_DELIVERY",
  "DELIVERY_KEY_CONFLICT",
  FAULT_CODES.EXPIRED_SIGNATURE,
  "FORGED_SIGNATURE",
  FAULT_CODES.DOWNLOAD_500,
  FAULT_CODES.INVALID_MEDIA,
  FAULT_CODES.SILENT_MEDIA,
  FAULT_CODES.LOGIN_EXPIRED,
  FAULT_CODES.CAPTCHA_REQUIRED,
  "SINGLE_PLATFORM_FAILURE",
  "MULTI_PLATFORM_PARTIAL_SUCCESS",
  FAULT_CODES.PROCESS_CRASH,
  "PUBLISHING_PROCESS_CRASH",
  "MAC_BOOT_ID_CHANGE",
  "RECOVERY_COMMIT_FAILURE",
  "DUPLICATE_CLICK",
  FAULT_CODES.ENOSPC,
  "QUALITY_REJECTED",
  "SENSITIVE_SENTINEL",
]);

const REQUIRED_INVARIANTS = Object.freeze([
  "network_lockdown_preloaded",
  "network_lockdown_enforced",
  "unified_correlation_trace",
  "duplicate_delivery_idempotent",
  "concurrent_receive_idempotent",
  "delivery_key_payload_immutable",
  "signature_verified_before_deduplication",
  "expired_signature_rejected",
  "failed_receive_cannot_advance",
  "failed_platform_only_retry",
  "success_receipt_immutable",
  "quality_failure_not_completed",
  "process_crash_recoverable",
  "publishing_claim_recoverable",
  "same_boot_overdue_dispatchable",
  "mac_restart_requires_reapproval",
  "duplicate_click_idempotent",
  "concurrent_dispatch_idempotent",
  "concurrent_review_first_writer_wins",
  "recovery_reapproval_atomic",
  "reapproval_first_writer_wins",
  "disk_full_recoverable",
  "sensitive_fields_redacted",
]);

const SECRET_SENTINELS = Object.freeze({
  bearer: "E2E_BEARER_SENTINEL_7fc7b2",
  token: "E2E_TOKEN_SENTINEL_bcc31a",
  cookie: "E2E_COOKIE_SENTINEL_51e981",
  signature: "E2E_SIGNATURE_SENTINEL_f96d8a",
  identity: "E2E_IDENTITY_SENTINEL_880c4f",
  chat: "E2E_CHAT_SENTINEL_193ab0",
  posixPath: "/Users/e2e-sentinel/.zhitai/E2E_POSIX_PATH_SENTINEL_2d609a/payload.json",
  windowsPath: "C:\\Users\\e2e-sentinel\\AppData\\E2E_WINDOWS_PATH_SENTINEL_147fe2\\payload.json",
  email: "e2e.email.sentinel.45ca1d@example.invalid",
  phone: "13800138000",
  urlUser: "E2E_URL_USER_SENTINEL_8190ad",
  urlPassword: "E2E_URL_PASSWORD_SENTINEL_946d31",
  urlPath: "E2E_URL_PATH_SENTINEL_757fe1/private/account",
  urlQuery: "E2E_URL_QUERY_SENTINEL_22af60",
  urlFragment: "E2E_URL_FRAGMENT_SENTINEL_5f190b",
  environmentSecret: "E2E_ENV_SECRET_SENTINEL_9c40a7",
});
const SENSITIVE_DOWNLOAD_URL = `https://${SECRET_SENTINELS.urlUser}:${SECRET_SENTINELS.urlPassword}`
  + `@offline.invalid/${SECRET_SENTINELS.urlPath}?opaqueCredential=${SECRET_SENTINELS.urlQuery}`
  + `#${SECRET_SENTINELS.urlFragment}`;

class ScenarioAssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = "ScenarioAssertionError";
    this.code = "ASSERTION_FAILED";
  }
}

function normalizePathText(value, sessionRoot) {
  let text = String(value);
  if (sessionRoot) text = text.split(sessionRoot).join("[EPHEMERAL_ROOT]");
  text = text.replace(/https?:\/\/[^\s"']+/gi, (candidate) => {
    try {
      const parsed = new URL(candidate);
      parsed.username = "";
      parsed.password = "";
      if (parsed.pathname && parsed.pathname !== "/") parsed.pathname = "/[REDACTED_PATH]";
      if (parsed.search) parsed.search = "?[REDACTED]";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return "[REDACTED_URL]";
    }
  });
  return text
    .replace(/(?:\/Users|\/home|\/private\/var\/folders|\/tmp)\/[^\s"']+/g, "[PRIVATE_PATH]")
    .replace(/[A-Za-z]:\\[^\s"']+/g, "[PRIVATE_PATH]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:token|secret|password|passcode|api[_-]?key|authorization|cookie|session|credential|signature)\s*[:=]\s*[^\s,;]+/gi,
      (match) => `${match.split(/[:=]/, 1)[0]}=[REDACTED]`)
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[REDACTED_EMAIL]")
    .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, "[REDACTED_PHONE]")
    .slice(0, 1_000);
}

function sanitizeReportValue(value, sessionRoot, key = "", depth = 0) {
  if (depth > 16 || value === null || value === undefined) return value;
  if (key !== "credentialEnvironmentSanitized"
    && /(authorization|cookie|token|secret|password|credential|signature|signed.?url|account|chat|phone)/i.test(key)) {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) return value.map((item) => sanitizeReportValue(item, sessionRoot, key, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      sanitizeReportValue(childValue, sessionRoot, childKey, depth + 1),
    ]));
  }
  return typeof value === "string" ? normalizePathText(value, sessionRoot) : value;
}

function safeScenarioError(error, sessionRoot) {
  return sanitizeReportValue({
    name: error?.name || "Error",
    code: error?.code || "SCENARIO_FAILED",
    message: normalizePathText(error?.message || String(error), sessionRoot),
    stage: error?.stage || null,
  }, sessionRoot);
}

function collectCorrelationIds(value, result = new Set(), seen = new WeakSet()) {
  if (!value || typeof value !== "object") return result;
  if (seen.has(value)) return result;
  seen.add(value);
  if (typeof value.correlationId === "string") result.add(value.correlationId);
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    if (child && typeof child === "object") collectCorrelationIds(child, result, seen);
  }
  return result;
}

class ScenarioContext {
  constructor(definition, sandbox, sessionRoot) {
    this.definition = definition;
    this.id = definition.id;
    this.sandbox = sandbox;
    this.sessionRoot = sessionRoot;
    this.assertions = 0;
    this.correlationIds = new Set();
    this.handles = new Set();
    this.evidence = null;
  }

  check(condition, message) {
    this.assertions += 1;
    if (!condition) throw new ScenarioAssertionError(message);
  }

  equal(actual, expected, message) {
    this.check(Object.is(actual, expected), message);
  }

  deepEqual(actual, expected, message) {
    this.check(JSON.stringify(actual) === JSON.stringify(expected), message);
  }

  includes(values, expected, message) {
    this.check(values.includes(expected), message);
  }

  addCorrelation(value) {
    if (typeof value === "string" && value.startsWith("corr-")) this.correlationIds.add(value);
    else collectCorrelationIds(value, this.correlationIds);
    return value;
  }

  track(harness) {
    this.handles.add(harness);
    return harness;
  }

  untrack(harness) {
    this.handles.delete(harness);
  }

  setEvidence(value) {
    this.evidence = value;
  }

  async closeAll() {
    for (const harness of this.handles) {
      try { harness.close(); } catch { /* scenario result already records the primary failure */ }
    }
    this.handles.clear();
  }
}

function makeInput(scenarioId, suffix = "primary", overrides = {}) {
  return {
    deliveryId: `delivery-${scenarioId}-${suffix}`,
    sourceId: `synthetic-${scenarioId}-${suffix}`,
    prompt: `Offline synthetic prompt for ${scenarioId} ${suffix}`,
    media: createDeterministicMedia({ seed: `${scenarioId}:${suffix}` }),
    provenance: {
      authorized: true,
      synthetic: true,
      networkAccess: false,
      intendedUse: "offline_e2e_only",
    },
    ...overrides,
  };
}

async function makeHarness(context, options = {}) {
  const instance = options.instance || "primary";
  const rootDir = options.rootDir || join(context.sandbox, instance);
  await mkdir(rootDir, { recursive: true, mode: 0o700 });
  const clock = options.clock || new FakeClock(options.now || FIXED_NOW);
  const platforms = options.platforms || createFakePlatforms(options.platformNames || PLATFORM_NAMES);
  const harness = await createChainHarness({
    rootDir,
    dbPath: options.dbPath,
    bootId: options.bootId || "boot-offline-1",
    clock,
    platforms,
    platformAdapters: platforms,
    faults: options.faults,
    downloadFaults: options.downloadFaults,
    beforeReceiveClaim: options.beforeReceiveClaim,
    beforeReviewClaim: options.beforeReviewClaim,
    beforeReviewPendingClaim: options.beforeReviewPendingClaim,
    beforeReapprovalClaim: options.beforeReapprovalClaim,
  });
  context.track(harness);
  return { harness, clock, platforms, rootDir, dbPath: harness.dbPath };
}

async function expectFault(context, action, code) {
  let caught = null;
  try {
    await action();
  } catch (error) {
    caught = error;
    context.addCorrelation(error?.correlationId);
  }
  context.check(Boolean(caught), `${code} must reject the operation`);
  context.equal(caught?.code, code, `${code} must be preserved as the machine-readable error code`);
  return caught;
}

async function expectOneOfFaults(context, action, codes) {
  let caught = null;
  try {
    await action();
  } catch (error) {
    caught = error;
    context.addCorrelation(error?.correlationId);
  }
  context.check(Boolean(caught), `${codes.join(" or ")} must reject the operation`);
  context.check(codes.includes(caught?.code), "rejection must preserve an accepted machine-readable signature error code");
  return caught;
}

async function assertNetworkLockdown(context) {
  context.equal(process.env.ZHITAI_E2E_ENV_SANITIZED, "1",
    "runner must mark the credential environment as sanitized before importing the suite");
  context.equal(process.env.E2E_SECRET_ENV_SENTINEL, undefined,
    "arbitrary parent-shell credentials must not reach the suite");
  const permittedEnvironment = new Set([
    "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TEMP", "TMP",
    "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
    "USER", "LOGNAME", "PATH", "LANG", "TZ", "CI",
    "SystemRoot", "SystemDrive", "ComSpec", "PATHEXT",
    "ZHITAI_E2E_OFFLINE", "ZHITAI_E2E_NETWORK_POLICY", "ZHITAI_E2E_ENV_SANITIZED",
    "ZHITAI_E2E_KERNEL_NETWORK",
  ]);
  const unexpectedEnvironment = Object.keys(process.env)
    .filter((name) => !permittedEnvironment.has(name))
    .sort();
  context.deepEqual(unexpectedEnvironment, [],
    "suite process must contain only the documented environment allowlist");
  const probes = [
    ["fetch", () => fetch("https://offline-probe.invalid/path?token=must-not-leave-process"), "ZHITAI_E2E_NETWORK_BLOCKED"],
    ["dns", () => dnsPromises.resolveTxt("offline-probe.invalid"), "ZHITAI_E2E_NETWORK_BLOCKED"],
    ["tcp", () => net.createConnection({ host: "127.0.0.1", port: 9 }), "ZHITAI_E2E_NETWORK_BLOCKED"],
    ["http_client_request", () => new ClientRequest("http://127.0.0.1:9"), "ZHITAI_E2E_NETWORK_BLOCKED"],
    ["http_agent", () => new HttpAgent().createConnection({ host: "127.0.0.1", port: 9 }),
      "ZHITAI_E2E_NETWORK_BLOCKED"],
    ["https_agent", () => new HttpsAgent().createConnection({ host: "127.0.0.1", port: 9 }),
      "ZHITAI_E2E_NETWORK_BLOCKED"],
    ["udp", () => dgram.createSocket("udp4"), "ZHITAI_E2E_NETWORK_BLOCKED"],
    ["udp_constructor", () => new dgram.Socket({ type: "udp4" }), "ZHITAI_E2E_NETWORK_BLOCKED"],
    ["udp_constructor_bind", () => new dgram.Socket({ type: "udp4" }).bind(0), "ZHITAI_E2E_NETWORK_BLOCKED"],
    ["udp_constructor_send", () => new dgram.Socket({ type: "udp4" }).send(Buffer.from("offline"), 9, "127.0.0.1"),
      "ZHITAI_E2E_NETWORK_BLOCKED"],
    ["child_process", () => spawn("/usr/bin/true"), "ZHITAI_E2E_PROCESS_BLOCKED"],
    ["child_process_constructor", () => new ChildProcess().spawn({ file: "/usr/bin/true", args: ["true"] }),
      "ZHITAI_E2E_PROCESS_BLOCKED"],
    ["cluster", () => clusterFork(), "ZHITAI_E2E_PROCESS_BLOCKED"],
    ["worker_threads", async () => {
      const worker = new Worker("setInterval(() => {}, 1000)", { eval: true, execArgv: [] });
      await worker.terminate();
    }, "ZHITAI_E2E_PROCESS_BLOCKED"],
  ];
  for (const [name, action, expectedCode] of probes) {
    let blocked = null;
    try { await action(); } catch (error) { blocked = error; }
    context.check(Boolean(blocked), `${name} isolation probe must be blocked before any external operation`);
    context.equal(blocked?.code, expectedCode, `${name} isolation probe must fail with the lockdown code`);
  }
}

async function prepareScheduled(context, harness, options = {}) {
  const received = context.addCorrelation(harness.receive(options.input || makeInput(context.id)));
  const correlationId = received.correlationId;
  await harness.runUntilReview(correlationId);
  await harness.review(correlationId, { approved: true, reviewer: "offline-human-reviewer" });
  await harness.createDraft(correlationId);
  await harness.schedule(correlationId, {
    scheduledFor: options.scheduledFor || FIXED_NOW,
    platforms: options.platforms || PLATFORM_NAMES,
  });
  return correlationId;
}

async function completeScheduled(context, harness, correlationId, now = FIXED_NOW) {
  await harness.dispatchDue({ correlationId, now });
  const receipts = harness.queryPlatformReceipts(correlationId);
  if (receipts.some((item) => item.status === "failed")) {
    await harness.retryFailedPlatforms(correlationId, { now });
  }
  const state = await harness.readbackMetrics(correlationId, { now });
  context.addCorrelation(state);
  return state;
}

function eventFor(state, stage, status = undefined) {
  return state.events.find((event) => event.stage === stage && (status === undefined || event.status === status));
}

function platformAttemptCount(state, platform, operation) {
  return state.platformAttempts.filter((attempt) => attempt.platform === platform && attempt.operation === operation).length;
}

function assertFaultStored(context, state, code) {
  const serialized = JSON.stringify(state);
  context.check(serialized.includes(`"code":"${code}"`), `${code} must be durably observable`);
}

function assertUnifiedTrace(context, state) {
  const correlationId = state.run.correlationId;
  context.equal(state.trace.correlationId, correlationId, "trace must use the run correlation ID");
  context.check(Boolean(state.trace.source?.artifactId && state.trace.source?.sha256), "trace must identify the source artifact and hash");
  context.check(Boolean(state.trace.prompt?.promptId && state.trace.prompt?.promptHash), "trace must identify the prompt and hash");
  context.check(state.trace.artifacts.length >= 5, "trace must include generated and quality artifacts");
  context.equal(state.trace.metrics.length, 2, "trace must include both terminal metric snapshots");
  for (const metric of state.trace.metrics) {
    const receipt = state.trace.platformReceipts.find((item) => item.platform === metric.platform);
    context.check(Boolean(receipt?.receiptHash), "each metric must resolve to a platform receipt");
    context.equal(metric.receiptHash, receipt.receiptHash, "metric receipt hash must match the immutable receipt");
  }
  const correlated = [...collectCorrelationIds(state)];
  context.deepEqual(correlated, [correlationId], "all durable rows must carry one correlation ID");
  for (const artifact of state.trace.artifacts) {
    context.equal(artifact.promptId, state.trace.prompt.promptId, "artifact must retain prompt ID");
    context.equal(artifact.promptHash, state.trace.prompt.promptHash, "artifact must retain prompt hash");
  }
}

function traceProof(trace) {
  return {
    correlationId: trace.correlationId,
    source: { sha256: trace.source.sha256 },
    prompt: {
      promptId: trace.prompt.promptId,
      promptHash: trace.prompt.promptHash,
    },
    artifactHashes: trace.artifacts.map((artifact) => ({
      stage: artifact.stage,
      sha256: artifact.sha256,
    })),
    receiptHashes: trace.platformReceipts.map((receipt) => ({
      platform: receipt.platform,
      receiptHash: receipt.receiptHash,
    })),
    metricReceiptLinks: trace.metrics.map((metric) => ({
      platform: metric.platform,
      receiptHash: metric.receiptHash,
    })),
  };
}

async function spawnCrashWorker(configuration) {
  const workerHome = join(configuration.rootDir, "worker-home");
  const workerTmp = join(configuration.rootDir, "worker-tmp");
  const workerAppData = join(workerHome, "AppData", "Roaming");
  const workerLocalAppData = join(workerHome, "AppData", "Local");
  const workerConfig = join(configuration.rootDir, "worker-xdg-config");
  const workerCache = join(configuration.rootDir, "worker-xdg-cache");
  await Promise.all([workerHome, workerTmp, workerAppData, workerLocalAppData, workerConfig, workerCache]
    .map((path) => mkdir(path, { recursive: true, mode: 0o700 })));
  const windowsSystemEnvironment = process.platform === "win32"
    ? Object.fromEntries(["SystemRoot", "SystemDrive", "ComSpec", "PATHEXT"]
      .flatMap((name) => process.env[name] ? [[name, process.env[name]]] : []))
    : {};
  const child = fork(CRASH_WORKER, [], {
    cwd: fileURLToPath(new URL("../../", import.meta.url)),
    execPath: process.execPath,
    execArgv: ["--import", NETWORK_LOCKDOWN],
    env: {
      HOME: workerHome,
      USERPROFILE: workerHome,
      APPDATA: workerAppData,
      LOCALAPPDATA: workerLocalAppData,
      TMPDIR: workerTmp,
      TEMP: workerTmp,
      TMP: workerTmp,
      XDG_CONFIG_HOME: workerConfig,
      XDG_CACHE_HOME: workerCache,
      PATH: dirname(process.execPath),
      LANG: "C.UTF-8",
      TZ: "UTC",
      ZHITAI_E2E_OFFLINE: "1",
      ZHITAI_E2E_NETWORK_POLICY: "deny_all",
      ...windowsSystemEnvironment,
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const messages = [];
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("crash worker timed out"));
    }, 10_000);
    child.on("message", (message) => messages.push(message));
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, messages });
    });
    child.once("spawn", () => child.send(configuration));
  });
}

const SCENARIOS = [
  {
    id: "full_chain_success",
    stages: [...STAGES],
    faults: [],
    invariants: ["network_lockdown_preloaded", "network_lockdown_enforced", "unified_correlation_trace"],
    async execute(context) {
      await assertNetworkLockdown(context);
      const { harness } = await makeHarness(context);
      const correlationId = await prepareScheduled(context, harness);
      const state = await completeScheduled(context, harness, correlationId);
      context.equal(state.run.status, "completed", "successful chain must finish completed");
      context.equal(state.run.qualityPass, true, "successful chain must pass quality");
      for (const stage of STAGES) {
        context.check(Boolean(eventFor(state, stage, "success")), `${stage} must have a successful durable event`);
      }
      context.equal(state.platformReceipts.filter((item) => item.status === "success").length, 2,
        "both fake platforms must have success receipts");
      context.equal(state.metrics.length, 2, "both fake platforms must have metric snapshots");
      assertUnifiedTrace(context, state);
      context.setEvidence({ traceProof: traceProof(state.trace) });
    },
  },
  {
    id: "duplicate_delivery",
    stages: ["receive"],
    faults: ["DUPLICATE_DELIVERY", "DELIVERY_KEY_CONFLICT", "FORGED_SIGNATURE", FAULT_CODES.EXPIRED_SIGNATURE],
    invariants: ["duplicate_delivery_idempotent", "delivery_key_payload_immutable", "signature_verified_before_deduplication"],
    async execute(context) {
      const { harness } = await makeHarness(context);
      const input = makeInput(context.id, "signed", { receivedAt: FIXED_NOW });
      const valid = harness.signDelivery(input, {
        expiresAt: "2030-01-01T00:05:00.000Z",
        nonce: "duplicate-valid",
      });
      const first = context.addCorrelation(harness.receiveSigned(valid));
      const acceptedBefore = harness.inspect(first.correlationId);
      const conflictingInput = {
        ...input,
        sourceId: `${input.sourceId}-conflict`,
        prompt: `${input.prompt} conflicting payload`,
        media: createDeterministicMedia({ seed: `${context.id}:conflicting-payload` }),
      };
      const conflicting = harness.signDelivery(conflictingInput, {
        expiresAt: "2030-01-01T00:05:00.000Z",
        nonce: "duplicate-conflicting-payload",
      });
      await expectFault(context, () => harness.receiveSigned(conflicting), "DELIVERY_KEY_CONFLICT");
      const acceptedAfterConflict = harness.inspect(first.correlationId);
      context.equal(acceptedAfterConflict.run.status, "received", "conflicting authenticated payload must not replace accepted state");
      context.equal(acceptedAfterConflict.run.payloadFingerprint, acceptedBefore.run.payloadFingerprint,
        "accepted payload fingerprint must remain immutable");
      context.equal(acceptedAfterConflict.run.provenance.sourceSha256, acceptedBefore.run.provenance.sourceSha256,
        "accepted source media hash must remain immutable");
      context.equal(acceptedAfterConflict.run.promptHash, acceptedBefore.run.promptHash,
        "accepted prompt hash must remain immutable");
      const conflictEvent = acceptedAfterConflict.events.find((event) => event.stage === "receive" && event.status === "conflict");
      context.check(Boolean(conflictEvent), "payload conflict must have a durable conflict audit event");
      context.check(Boolean(conflictEvent.details.acceptedPayloadFingerprint
        && conflictEvent.details.rejectedPayloadFingerprint), "conflict audit must contain only comparison fingerprints");
      context.check(!JSON.stringify(conflictEvent).includes(conflictingInput.prompt),
        "conflict audit must not persist the rejected prompt");
      const forged = {
        ...valid,
        signature: {
          ...valid.signature,
          value: `${valid.signature.value[0] === "a" ? "b" : "a"}${valid.signature.value.slice(1)}`,
        },
      };
      await expectOneOfFaults(context, () => harness.receiveSigned(forged), ["INVALID_SIGNATURE", FAULT_CODES.EXPIRED_SIGNATURE]);
      const expired = harness.signDelivery(input, {
        expiresAt: "2029-12-31T23:59:59.000Z",
        nonce: "duplicate-expired",
      });
      await expectFault(context, () => harness.receiveSigned(expired), FAULT_CODES.EXPIRED_SIGNATURE);
      const beforeValidDuplicate = harness.inspect(first.correlationId);
      context.equal(beforeValidDuplicate.run.status, "received", "forged or expired duplicates must not alter the accepted run");
      context.equal(beforeValidDuplicate.events.filter((event) => event.status === "deduplicated").length, 0,
        "failed authentication must never be reported as successful deduplication");
      context.check(!beforeValidDuplicate.events.some((event) => event.stage !== "receive"),
        "failed duplicate authentication must not advance the workflow");

      const second = context.addCorrelation(harness.receiveSigned(valid));
      context.equal(first.correlationId, second.correlationId, "duplicate delivery must reuse the correlation ID");
      context.equal(second.duplicate, true, "duplicate delivery must be explicitly marked");
      const state = harness.inspect(first.correlationId);
      context.equal(state.events.filter((event) => event.stage === "receive" && event.status === "success").length, 1,
        "duplicate delivery must not create a second successful receive");
      context.equal(state.events.filter((event) => event.stage === "receive" && event.status === "deduplicated").length, 1,
        "duplicate receive attempt must be auditable as deduplicated");
    },
  },
  {
    id: "concurrent_receive_idempotency",
    stages: ["receive"],
    faults: ["DUPLICATE_DELIVERY"],
    invariants: ["concurrent_receive_idempotent", "duplicate_delivery_idempotent"],
    async execute(context) {
      const sharedRoot = join(context.sandbox, "shared-receive-race");
      const dbPath = join(sharedRoot, "chain.sqlite");
      const second = await makeHarness(context, {
        rootDir: sharedRoot,
        dbPath,
        instance: "receive-race-second",
      });
      const input = makeInput(context.id, "same-delivery-key", { receivedAt: FIXED_NOW });
      const signed = second.harness.signDelivery(input, {
        expiresAt: "2030-01-01T00:05:00.000Z",
        nonce: "concurrent-receive",
      });

      let innerResult = null;
      let innerError = null;
      let hookCalls = 0;
      const first = await makeHarness(context, {
        rootDir: sharedRoot,
        dbPath,
        instance: "receive-race-first",
        // Deterministic two-connection barrier: connection one has observed
        // an absent key, then connection two commits it before connection one
        // enters BEGIN IMMEDIATE and rechecks under the write lock.
        beforeReceiveClaim() {
          hookCalls += 1;
          try {
            innerResult = second.harness.receiveSigned(signed);
          } catch (error) {
            innerError = error;
          }
        },
      });
      let outerResult = null;
      let outerError = null;
      try {
        outerResult = first.harness.receiveSigned(signed);
      } catch (error) {
        outerError = error;
      }

      context.equal(hookCalls, 1, "receive race barrier must interleave the two independent SQLite connections once");
      context.equal(innerError, null, "inner receive connection must not fail with a SQLite race");
      context.equal(outerError, null, "outer receive connection must not fail with a SQLite race");
      const results = [innerResult, outerResult];
      context.equal(results.filter((result) => result?.duplicate === false).length, 1,
        "concurrent receive must have exactly one accepted winner");
      context.equal(results.filter((result) => result?.duplicate === true).length, 1,
        "concurrent receive must have exactly one deduplicated loser");
      context.equal(results[0]?.correlationId, results[1]?.correlationId,
        "both receive connections must resolve to one stable correlation ID");
      context.check(!results.some((result) => JSON.stringify(result).includes("SQLITE")),
        "concurrent receive results must not expose SQLite constraint or locking errors");

      const correlationId = results[0].correlationId;
      context.addCorrelation(correlationId);
      const state = first.harness.inspect(correlationId);
      context.equal(state.events.filter((event) => event.stage === "receive" && event.status === "success").length, 1,
        "receive race must durably record one success");
      context.equal(state.events.filter((event) => event.stage === "receive" && event.status === "deduplicated").length, 1,
        "receive race must durably record one deduplicated attempt");
      context.equal(state.run.status, "received", "receive race must leave the accepted run ready for downstream work");
    },
  },
  {
    id: "concurrent_review_first_writer_wins",
    stages: ["receive", "download", "media_validate", "ingest", "analyze", "generate", "quality", "review"],
    faults: ["DUPLICATE_CLICK"],
    invariants: ["concurrent_review_first_writer_wins"],
    async execute(context) {
      const sharedRoot = join(context.sandbox, "shared-review-race");
      const dbPath = join(sharedRoot, "chain.sqlite");
      const ownerConnection = await makeHarness(context, {
        rootDir: sharedRoot,
        dbPath,
        instance: "review-race-owner",
      });
      const received = context.addCorrelation(ownerConnection.harness.receive(makeInput(context.id)));
      const correlationId = received.correlationId;
      await ownerConnection.harness.run(correlationId, { stopAfter: "quality" });
      context.equal(ownerConnection.harness.inspect(correlationId).events
        .filter((event) => event.stage === "review").length, 0,
      "quality completion must precede creation of the pending review marker");

      let reviewOwnerPromise = null;
      let reviewHookInfo = null;
      const contenderConnection = await makeHarness(context, {
        rootDir: sharedRoot,
        dbPath,
        instance: "review-race-contender",
        beforeReviewClaim(info) {
          reviewHookInfo = info;
          // Reject wins first; the competing approval must become an immutable
          // duplicate and must not authorize draft creation.
          reviewOwnerPromise = ownerConnection.harness.review(correlationId, {
            approved: false,
            reviewer: "offline-review-owner-reject",
          });
        },
      });

      const pendingResults = await Promise.allSettled([
        ownerConnection.harness.runUntilReview(correlationId),
        contenderConnection.harness.runUntilReview(correlationId),
      ]);
      context.equal(pendingResults.filter((result) => result.status === "rejected").length, 0,
        "two SQLite connections must concurrently mark review pending without constraint or locking errors");
      context.check(pendingResults.every((result) => result.value?.run?.status === "awaiting_review"),
        "both pending-review contenders must converge on awaiting_review");
      let state = contenderConnection.harness.inspect(correlationId);
      context.equal(state.events.filter((event) => event.stage === "review" && event.status === "pending").length, 1,
        "concurrent runUntilReview calls must create exactly one pending review event");
      context.equal(state.events.filter((event) => event.stage === "review" && event.status === "success").length, 0,
        "pending-review race must not invent a human decision");

      const contenderResult = await contenderConnection.harness.review(correlationId, {
        approved: true,
        reviewer: "offline-review-contender-approve",
      });
      const ownerResult = await reviewOwnerPromise;
      const decisions = [ownerResult, contenderResult];
      context.equal(decisions.filter((result) => result.duplicate === false).length, 1,
        "opposing concurrent reviews must elect exactly one owner");
      context.equal(decisions.filter((result) => result.duplicate === true).length, 1,
        "opposing concurrent reviews must mark exactly one contender duplicate");
      context.equal(ownerResult.decision, "rejected", "first persisted rejection must win");
      context.equal(contenderResult.decision, "rejected", "later approval must observe the immutable first decision");
      context.equal(contenderResult.requestedDecision, "approved",
        "duplicate result must retain the contender's requested decision for audit");
      context.equal(reviewHookInfo?.requestedDecision, "approved",
        "review barrier must expose the contender decision without changing it");

      state = contenderConnection.harness.inspect(correlationId);
      const successfulReviews = state.events.filter((event) => event.stage === "review" && event.status === "success");
      context.equal(successfulReviews.length, 1, "opposing concurrent reviews must create one successful review event");
      context.equal(state.events.filter((event) => event.stage === "review" && event.status === "pending").length, 0,
        "persisted review decision must leave no pending review marker");
      context.equal(successfulReviews[0].details.approved ? "approved" : "rejected", state.run.reviewDecision,
        "review event decision must match the immutable run decision");
      context.equal(state.run.status, "rejected", "first rejection must determine final run status");
      let draftBlocked = null;
      try {
        await contenderConnection.harness.createDraft(correlationId);
      } catch (error) {
        draftBlocked = error;
      }
      context.check(Boolean(draftBlocked), "a losing concurrent approval must not authorize draft creation");
      context.equal(contenderConnection.harness.inspect(correlationId).artifacts
        .filter((artifact) => artifact.stage === "draft").length, 0,
      "rejected first-writer decision must have no downstream draft side effect");
    },
  },
  {
    id: "expired_signature",
    stages: ["receive"],
    faults: [FAULT_CODES.EXPIRED_SIGNATURE, "FORGED_SIGNATURE"],
    invariants: ["expired_signature_rejected", "failed_receive_cannot_advance", "sensitive_fields_redacted"],
    async execute(context) {
      const { harness } = await makeHarness(context);
      const cases = [
        { suffix: "expired", kind: "expired" },
        { suffix: "forged", kind: "forged" },
      ];
      for (const testCase of cases) {
        // receivedAt is attacker-controlled envelope data. The expired case
        // deliberately backdates it so only the injected trusted clock can
        // make the expiry decision.
        const input = makeInput(context.id, testCase.suffix, {
          receivedAt: testCase.kind === "expired" ? "2029-01-01T00:00:00.000Z" : FIXED_NOW,
        });
        const valid = harness.signDelivery(input, {
          expiresAt: "2030-01-01T00:05:00.000Z",
          nonce: `${testCase.suffix}-valid-retry`,
        });
        let rejectedEnvelope;
        let error;
        if (testCase.kind === "expired") {
          rejectedEnvelope = harness.signDelivery(input, {
            expiresAt: "2029-12-31T23:59:59.000Z",
            nonce: "expired-signature-valid-hmac",
          });
          error = await expectFault(context, () => harness.receiveSigned(rejectedEnvelope), FAULT_CODES.EXPIRED_SIGNATURE);
          context.check(Date.parse(input.receivedAt) < Date.parse(rejectedEnvelope.signature.expiresAt),
            "backdated untrusted receivedAt must predate the otherwise valid signature expiry");
        } else {
          rejectedEnvelope = {
            ...valid,
            signature: {
              ...valid.signature,
              value: `${valid.signature.value.slice(0, -1)}${valid.signature.value.endsWith("0") ? "1" : "0"}`,
            },
          };
          error = await expectOneOfFaults(context, () => harness.receiveSigned(rejectedEnvelope),
            ["INVALID_SIGNATURE", FAULT_CODES.EXPIRED_SIGNATURE]);
        }
        const correlationId = context.addCorrelation(error.correlationId);
        const failed = harness.inspect(correlationId);
        context.equal(failed.run.status, "receive_failed", "unauthenticated first delivery must remain receive_failed");
        context.check(!failed.events.some((event) => event.stage !== "receive"),
          "unauthenticated first delivery must create no downstream events");
        for (const method of ["run", "resume"]) {
          let blocked = null;
          try { await harness[method](correlationId); } catch (caught) { blocked = caught; }
          context.check(Boolean(blocked), `${method} must not bypass a failed receive gate`);
          context.equal(harness.getRun(correlationId).status, "receive_failed",
            `${method} must preserve receive_failed state`);
        }
        const accepted = context.addCorrelation(harness.receiveSigned(valid));
        context.equal(accepted.correlationId, correlationId, "valid redelivery must retain the stable correlation ID");
        context.equal(accepted.status, "received", "valid redelivery must repair the failed receive gate");
        const resumed = await harness.runUntilReview(correlationId);
        context.equal(resumed.run.status, "awaiting_review", "only a valid redelivery may start downstream work");
        const durable = JSON.stringify(harness.inspect(correlationId));
        context.check(!durable.includes(rejectedEnvelope.signature.value), "rejected signature value must never persist");
      }
    },
  },
  {
    id: "download_500_then_retry",
    stages: ["receive", "download"],
    faults: [FAULT_CODES.DOWNLOAD_500],
    invariants: [],
    async execute(context) {
      const faults = new FaultPlan({ download: { code: FAULT_CODES.DOWNLOAD_500, times: 1 } });
      const { harness } = await makeHarness(context, { faults });
      const received = context.addCorrelation(harness.receive(makeInput(context.id)));
      await expectFault(context, () => harness.run(received.correlationId), FAULT_CODES.DOWNLOAD_500);
      const failed = harness.inspect(received.correlationId);
      assertFaultStored(context, failed, FAULT_CODES.DOWNLOAD_500);
      context.equal(eventFor(failed, "download", "failed")?.attempt, 1, "first download attempt must fail");
      const resumed = context.addCorrelation(await harness.resume(received.correlationId));
      context.equal(resumed.run.status, "awaiting_review", "retry must resume at the failed download stage");
      context.equal(eventFor(resumed, "download", "success")?.attempt, 2, "second download attempt must succeed");
    },
  },
  {
    id: "invalid_media_rejected",
    stages: ["receive", "download", "media_validate"],
    faults: [FAULT_CODES.INVALID_MEDIA],
    invariants: ["quality_failure_not_completed"],
    async execute(context) {
      const downloadFaults = new FaultPlan({ download: FAULT_CODES.INVALID_MEDIA });
      const { harness } = await makeHarness(context, { downloadFaults });
      const received = context.addCorrelation(harness.receive(makeInput(context.id)));
      await expectFault(context, () => harness.run(received.correlationId), FAULT_CODES.INVALID_MEDIA);
      const state = harness.inspect(received.correlationId);
      context.equal(state.run.status, "media_rejected", "invalid media must stop before ingest");
      context.equal(state.artifacts.length, 0, "invalid media must create no artifacts");
      context.equal(harness.report(received.correlationId).summary.completedRuns, 0,
        "invalid media must not count as completed");
    },
  },
  {
    id: "silent_media_rejected",
    stages: ["receive", "download", "media_validate"],
    faults: [FAULT_CODES.SILENT_MEDIA],
    invariants: ["quality_failure_not_completed"],
    async execute(context) {
      const downloadFaults = new FaultPlan({ download: FAULT_CODES.SILENT_MEDIA });
      const { harness } = await makeHarness(context, { downloadFaults });
      const received = context.addCorrelation(harness.receive(makeInput(context.id)));
      await expectFault(context, () => harness.run(received.correlationId), FAULT_CODES.SILENT_MEDIA);
      const state = harness.inspect(received.correlationId);
      context.equal(state.run.status, "media_rejected", "silent media must fail media validation");
      context.equal(harness.report(received.correlationId).summary.completedRuns, 0,
        "silent media must not count as completed");
    },
  },
  {
    id: "login_expired",
    stages: ["receive", "download", "media_validate", "ingest", "analyze", "generate", "quality", "review", "draft", "schedule"],
    faults: [FAULT_CODES.LOGIN_EXPIRED],
    invariants: [],
    async execute(context) {
      const faults = new FaultPlan({ "publish:fake-alpha": FAULT_CODES.LOGIN_EXPIRED });
      const { harness } = await makeHarness(context, { faults });
      const correlationId = await prepareScheduled(context, harness, { platforms: ["fake-alpha"] });
      await harness.dispatchDue({ correlationId, now: FIXED_NOW });
      const state = harness.inspect(correlationId);
      context.equal(state.run.status, "publish_failed", "expired login must block the fake platform");
      context.equal(state.platformReceipts[0].status, "failed", "expired login must not create a success receipt");
      assertFaultStored(context, state, FAULT_CODES.LOGIN_EXPIRED);
    },
  },
  {
    id: "captcha_required",
    stages: ["receive", "download", "media_validate", "ingest", "analyze", "generate", "quality", "review", "draft", "schedule"],
    faults: [FAULT_CODES.CAPTCHA_REQUIRED],
    invariants: [],
    async execute(context) {
      const faults = new FaultPlan({ "publish:fake-alpha": FAULT_CODES.CAPTCHA_REQUIRED });
      const { harness } = await makeHarness(context, { faults });
      const correlationId = await prepareScheduled(context, harness, { platforms: ["fake-alpha"] });
      await harness.dispatchDue({ correlationId, now: FIXED_NOW });
      const state = harness.inspect(correlationId);
      context.equal(state.run.status, "publish_failed", "verification challenge must block dispatch");
      context.equal(state.platformReceipts[0].status, "failed", "challenge must not fabricate a receipt");
      assertFaultStored(context, state, FAULT_CODES.CAPTCHA_REQUIRED);
    },
  },
  {
    id: "single_platform_failure",
    stages: ["receive", "download", "media_validate", "ingest", "analyze", "generate", "quality", "review", "draft", "schedule"],
    faults: ["SINGLE_PLATFORM_FAILURE"],
    invariants: ["failed_platform_only_retry"],
    async execute(context) {
      const faults = new FaultPlan({ "publish:fake-alpha": FAULT_CODES.PLATFORM_FAILURE });
      const { harness } = await makeHarness(context, { faults });
      const correlationId = await prepareScheduled(context, harness, { platforms: ["fake-alpha"] });
      await harness.dispatchDue({ correlationId, now: FIXED_NOW });
      context.equal(harness.getRun(correlationId).status, "publish_failed", "single fake platform failure must be visible");
      await harness.retryFailedPlatforms(correlationId, { now: FIXED_NOW });
      const state = harness.inspect(correlationId);
      context.equal(state.run.status, "published", "retry must recover a one-off platform failure");
      context.equal(platformAttemptCount(state, "fake-alpha", "publish"), 2, "failed platform must have exactly two publish attempts");
      context.equal(state.platformReceipts[0].status, "success", "recovered platform must have one success receipt");
    },
  },
  {
    id: "multi_platform_partial_success",
    stages: [...STAGES],
    faults: ["MULTI_PLATFORM_PARTIAL_SUCCESS"],
    invariants: ["failed_platform_only_retry", "success_receipt_immutable", "unified_correlation_trace"],
    async execute(context) {
      const faults = new FaultPlan({ "publish:fake-beta": FAULT_CODES.PLATFORM_FAILURE });
      const { harness } = await makeHarness(context, { faults });
      const correlationId = await prepareScheduled(context, harness);
      await harness.dispatchDue({ correlationId, now: FIXED_NOW });
      const partial = harness.inspect(correlationId);
      context.equal(partial.run.status, "partial_success", "one of two platform failures must be partial_success");
      const alphaBefore = partial.platformReceipts.find((item) => item.platform === "fake-alpha");
      const betaBefore = partial.platformReceipts.find((item) => item.platform === "fake-beta");
      context.equal(alphaBefore.status, "success", "alpha must succeed on the first dispatch");
      context.equal(betaBefore.status, "failed", "beta must fail on the first dispatch");
      await harness.retryFailedPlatforms(correlationId, { now: FIXED_NOW });
      const published = harness.inspect(correlationId);
      const alphaAfter = published.platformReceipts.find((item) => item.platform === "fake-alpha");
      context.equal(published.run.status, "published", "retry must complete the failed fake platform only");
      context.equal(platformAttemptCount(published, "fake-alpha", "publish"), 1,
        "successful platform must not be retried");
      context.equal(platformAttemptCount(published, "fake-beta", "publish"), 2,
        "failed platform alone must be retried");
      context.equal(alphaAfter.receiptHash, alphaBefore.receiptHash, "successful receipt hash must never be overwritten");
      context.deepEqual(alphaAfter.successReceipt, alphaBefore.successReceipt, "successful receipt payload must be immutable");
      const completed = context.addCorrelation(await harness.readbackMetrics(correlationId, { now: FIXED_NOW }));
      context.equal(completed.run.status, "completed", "partial success recovery must reach metrics completion");
      assertUnifiedTrace(context, completed);
    },
  },
  {
    id: "process_crash_restart",
    stages: ["receive", "download", "media_validate", "ingest", "analyze", "generate", "quality", "review", "draft", "schedule", "readback", "metrics"],
    faults: [FAULT_CODES.PROCESS_CRASH],
    invariants: ["process_crash_recoverable", "same_boot_overdue_dispatchable", "unified_correlation_trace"],
    async execute(context) {
      const rootDir = join(context.sandbox, "crash-instance");
      const dbPath = join(rootDir, "chain.sqlite");
      await mkdir(rootDir, { recursive: true, mode: 0o700 });
      const child = await spawnCrashWorker({
        rootDir,
        dbPath,
        bootId: "boot-process-stable",
        deliveryId: `delivery-${context.id}`,
        sourceId: `synthetic-${context.id}`,
        mediaSeed: context.id,
        faultPoint: "generate",
        platformNames: PLATFORM_NAMES,
      });
      context.equal(child.code, CRASH_EXIT_CODE, "worker must terminate with the intentional crash exit code");
      context.equal(child.signal, null, "worker must use a controlled process exit rather than an external signal");
      context.check(child.messages.some((message) => message.type === "worker_armed"), "worker must persist receive before crashing");
      context.check(child.messages.some((message) => message.type === "worker_crashed"), "worker must report the injected crash boundary");
      const armed = child.messages.find((message) => message.type === "worker_armed");
      const correlationId = context.addCorrelation(armed.correlationId);

      const { harness } = await makeHarness(context, {
        rootDir,
        dbPath,
        instance: "crash-instance",
        bootId: "boot-process-stable",
      });
      const interrupted = harness.inspect(correlationId);
      context.equal(interrupted.run.status, "interrupted", "crashed process must leave a durable interrupted run");
      context.equal(eventFor(interrupted, "generate", "running")?.attempt, 1,
        "crash must leave the in-flight stage running for recovery detection");
      const recovered = harness.recover({ bootId: "boot-process-stable", now: FIXED_NOW });
      context.check(recovered.recovered.some((item) => item.correlationId === correlationId && item.reason === "process_restart"),
        "same boot ID must recover as a process restart");
      const resumed = await harness.resume(correlationId);
      context.equal(resumed.run.status, "awaiting_review", "restart must resume from the interrupted stage");
      context.equal(eventFor(resumed, "generate", "success")?.attempt, 2, "restarted generation must use attempt two");
      await harness.review(correlationId, { approved: true, reviewer: "offline-human-reviewer" });
      await harness.createDraft(correlationId);
      await harness.schedule(correlationId, {
        scheduledFor: "2030-01-01T00:01:00.000Z",
        platforms: PLATFORM_NAMES,
      });
      harness.close();
      context.untrack(harness);

      const sameBootClock = new FakeClock("2030-01-01T00:10:00.000Z");
      const restarted = await makeHarness(context, {
        rootDir,
        dbPath,
        instance: "crash-instance",
        bootId: "boot-process-stable",
        clock: sameBootClock,
      });
      const overdueRecovery = restarted.harness.recover({
        bootId: "boot-process-stable",
        now: sameBootClock.iso(),
      });
      context.check(!overdueRecovery.needsReapproval.includes(correlationId),
        "same-boot process restart must not apply Mac reboot reapproval semantics");
      context.equal(restarted.harness.getRun(correlationId).needsReapproval, false,
        "same-boot overdue schedule must remain dispatchable");
      context.equal(restarted.harness.getRun(correlationId).status, "scheduled",
        "same-boot overdue schedule must remain scheduled");
      const completed = await completeScheduled(context, restarted.harness, correlationId, sameBootClock.iso());
      context.equal(completed.run.status, "completed", "recovered process must finish the chain");
      assertUnifiedTrace(context, completed);
    },
  },
  {
    id: "publishing_crash_recovery",
    stages: [...STAGES],
    faults: ["PUBLISHING_PROCESS_CRASH"],
    invariants: ["publishing_claim_recoverable", "unified_correlation_trace"],
    async execute(context) {
      const rootDir = join(context.sandbox, "publishing-crash-instance");
      const dbPath = join(rootDir, "chain.sqlite");
      await mkdir(rootDir, { recursive: true, mode: 0o700 });
      const child = await spawnCrashWorker({
        mode: "publish",
        rootDir,
        dbPath,
        bootId: "boot-publishing-stable",
        deliveryId: `delivery-${context.id}`,
        sourceId: `synthetic-${context.id}`,
        mediaSeed: context.id,
        now: FIXED_NOW,
        crashPlatform: "fake-alpha",
        platformNames: PLATFORM_NAMES,
      });
      context.equal(child.code, CRASH_EXIT_CODE, "publishing worker must exit at the adapter side effect boundary");
      context.equal(child.signal, null, "publishing crash must use the controlled crash exit");
      context.check(child.messages.some((message) => message.type === "worker_publishing_crashed"),
        "worker must prove it entered adapter.publish before exiting");
      const armed = child.messages.find((message) => message.type === "worker_armed");
      const correlationId = context.addCorrelation(armed?.correlationId);

      const { harness } = await makeHarness(context, {
        rootDir,
        dbPath,
        instance: "publishing-crash-instance",
        bootId: "boot-publishing-stable",
      });
      const orphaned = harness.inspect(correlationId);
      const orphanedAlpha = orphaned.platformReceipts.find((item) => item.platform === "fake-alpha");
      context.equal(orphaned.run.status, "publishing", "process exit must leave an orphaned publishing run");
      context.equal(orphanedAlpha.status, "publishing", "claimed platform row must remain publishing after hard exit");
      context.equal(orphanedAlpha.claimActive, true, "orphaned publishing row must retain its durable claim");
      context.check(Boolean(orphanedAlpha.claimedAt), "orphaned publishing row must retain its claim timestamp");
      context.equal(platformAttemptCount(orphaned, "fake-alpha", "publish"), 0,
        "crash before receipt must not fabricate a publish attempt result");

      const recovered = harness.recover({
        bootId: "boot-publishing-stable",
        now: "2030-01-01T00:02:00.000Z",
      });
      context.check(recovered.recovered.some((item) => item.correlationId === correlationId && item.reason === "process_restart"),
        "recover must discover an orphaned publishing row independently of stage events");
      const retryable = harness.inspect(correlationId);
      const recoveredAlpha = retryable.platformReceipts.find((item) => item.platform === "fake-alpha");
      context.equal(retryable.run.status, "scheduled", "same-boot orphan recovery must return run to scheduled");
      context.equal(recoveredAlpha.status, "failed", "orphaned platform claim must become a retryable failure");
      context.equal(recoveredAlpha.claimActive, false, "recover must clear the orphaned claim token");
      context.equal(recoveredAlpha.claimedAt, null, "recover must clear the orphaned claim timestamp");

      await harness.dispatchDue({ correlationId, now: "2030-01-01T00:02:00.000Z" });
      const published = harness.inspect(correlationId);
      context.equal(published.platformReceipts.filter((item) => item.status === "success").length, 2,
        "retry after orphan recovery must publish both fake platforms exactly once");
      context.equal(platformAttemptCount(published, "fake-alpha", "publish"), 1,
        "recovered platform must record one real successful publish result");
      context.equal(platformAttemptCount(published, "fake-beta", "publish"), 1,
        "previously unclaimed platform must publish once");
      const completed = context.addCorrelation(await harness.readbackMetrics(correlationId, {
        now: "2030-01-01T00:02:00.000Z",
      }));
      context.equal(completed.run.status, "completed", "orphaned publishing recovery must reach metrics completion");
      assertUnifiedTrace(context, completed);
    },
  },
  {
    id: "mac_boot_change_reapproval",
    stages: ["receive", "download", "media_validate", "ingest", "analyze", "generate", "quality", "review", "draft", "schedule", "readback", "metrics"],
    faults: ["MAC_BOOT_ID_CHANGE", "RECOVERY_COMMIT_FAILURE"],
    invariants: ["mac_restart_requires_reapproval", "recovery_reapproval_atomic", "reapproval_first_writer_wins"],
    async execute(context) {
      const first = await makeHarness(context, { bootId: "boot-mac-before", instance: "shared" });
      const correlationId = await prepareScheduled(context, first.harness, {
        scheduledFor: "2030-01-01T00:01:00.000Z",
      });
      const dbPath = first.harness.dbPath;
      first.harness.close();
      context.untrack(first.harness);
      const afterRestart = new FakeClock("2030-01-01T00:10:00.000Z");
      const recoveryFaults = new FaultPlan({
        recover_commit: { code: "RECOVERY_COMMIT_FAILURE", times: 1 },
      });
      const second = await makeHarness(context, {
        rootDir: first.rootDir,
        dbPath,
        bootId: "boot-mac-after",
        clock: afterRestart,
        faults: recoveryFaults,
        instance: "shared",
      });
      const beforeRecovery = second.harness.inspect(correlationId);
      await expectFault(context,
        () => second.harness.recover({ bootId: "boot-mac-after", now: afterRestart.iso() }),
        "RECOVERY_COMMIT_FAILURE");
      const rolledBack = second.harness.inspect(correlationId);
      context.equal(rolledBack.run.status, beforeRecovery.run.status,
        "failed recovery commit must roll back run status");
      context.equal(rolledBack.run.bootId, beforeRecovery.run.bootId,
        "failed recovery commit must roll back boot ID");
      context.equal(rolledBack.run.needsReapproval, beforeRecovery.run.needsReapproval,
        "failed recovery commit must roll back reapproval flag");
      context.equal(rolledBack.events.filter((event) => event.stage === "schedule"
        && event.details?.reapproved === true).length, 0,
      "failed recovery commit must not leave a reapproval audit event");

      const recovery = second.harness.recover({ bootId: "boot-mac-after", now: afterRestart.iso() });
      context.includes(recovery.needsReapproval, correlationId, "missed schedule after boot change must require reapproval");
      const recoveredRun = second.harness.getRun(correlationId);
      context.equal(recoveredRun.status, "needs_reapproval", "run must enter needs_reapproval");
      context.equal(recoveredRun.needsReapproval, true,
        "successful recovery must atomically persist the reapproval flag");
      context.equal(recoveredRun.bootId, "boot-mac-after",
        "successful recovery must atomically persist the new boot ID");
      const blocked = await second.harness.dispatchDue({ correlationId, now: afterRestart.iso() });
      context.equal(blocked.runs.length, 0, "missed schedule must not auto-publish after reboot");
      context.equal(second.harness.queryPlatformAttempts(correlationId).length, 0,
        "no fake platform may be called before reapproval");
      let reapprovalOwnerResult = null;
      let reapprovalOwnerError = null;
      let reapprovalHookInfo = null;
      const contenderScheduledFor = "2030-01-01T00:20:00.000Z";
      const reapprovalContender = await makeHarness(context, {
        rootDir: first.rootDir,
        dbPath,
        bootId: "boot-mac-after",
        clock: afterRestart,
        instance: "reapproval-contender",
        beforeReapprovalClaim(info) {
          reapprovalHookInfo = info;
          try {
            reapprovalOwnerResult = second.harness.reapproveSchedule(correlationId, {
              reviewer: "offline-reapproval-owner",
              scheduledFor: afterRestart.iso(),
              now: afterRestart.iso(),
            });
          } catch (error) {
            reapprovalOwnerError = error;
          }
        },
      });
      const reapprovalLoserResult = await reapprovalContender.harness.reapproveSchedule(correlationId, {
        reviewer: "offline-reapproval-contender",
        scheduledFor: contenderScheduledFor,
        now: afterRestart.iso(),
      });
      reapprovalOwnerResult = await Promise.resolve(reapprovalOwnerResult);
      context.equal(reapprovalOwnerError, null, "reapproval owner connection must not expose a SQLite race");
      const reapprovals = [reapprovalOwnerResult, reapprovalLoserResult];
      context.equal(reapprovals.filter((result) => result?.duplicate === false).length, 1,
        "concurrent reapproval must elect exactly one owner");
      context.equal(reapprovals.filter((result) => result?.duplicate === true).length, 1,
        "concurrent reapproval must mark exactly one contender duplicate");
      context.equal(reapprovalOwnerResult.scheduledFor, afterRestart.iso(),
        "first reapproval schedule must win");
      context.equal(reapprovalLoserResult.scheduledFor, afterRestart.iso(),
        "losing reapproval must observe the immutable owner schedule");
      context.equal(reapprovalLoserResult.requestedScheduledFor, contenderScheduledFor,
        "losing reapproval must retain its requested schedule for audit");
      context.equal(reapprovalHookInfo?.scheduledFor, contenderScheduledFor,
        "reapproval barrier must expose the contender schedule without persisting it");
      const reapprovedState = reapprovalContender.harness.inspect(correlationId);
      const reapprovalEvents = reapprovedState.events.filter((event) => event.stage === "schedule"
        && event.status === "success" && event.details?.reapproved === true);
      context.equal(reapprovalEvents.length, 1, "concurrent reapproval must create one audit event");
      context.equal(reapprovedState.run.scheduledFor, reapprovalEvents[0].details.scheduledFor,
        "reapproval event schedule must match the persisted run schedule");
      context.equal(reapprovedState.run.needsReapproval, false,
        "reapproval owner must atomically clear the reapproval flag");
      const completed = await completeScheduled(context, reapprovalContender.harness, correlationId, afterRestart.iso());
      context.equal(completed.run.status, "completed", "explicit reapproval must allow the missed schedule to finish");
      context.equal(completed.run.needsReapproval, false, "reapproval flag must be cleared explicitly");
    },
  },
  {
    id: "duplicate_clicks",
    stages: ["receive", "download", "media_validate", "ingest", "analyze", "generate", "quality", "review", "draft", "schedule"],
    faults: ["DUPLICATE_CLICK"],
    invariants: ["duplicate_click_idempotent", "concurrent_dispatch_idempotent"],
    async execute(context) {
      const { harness } = await makeHarness(context);
      const received = context.addCorrelation(harness.receive(makeInput(context.id)));
      const correlationId = received.correlationId;
      await harness.runUntilReview(correlationId);
      await harness.review(correlationId, { approved: true, reviewer: "offline-human-reviewer" });
      const draftClicks = await Promise.all([
        harness.createDraft(correlationId),
        harness.createDraft(correlationId),
      ]);
      const draftOwner = draftClicks.find((result) => result.skipped === false);
      const draftLoser = draftClicks.find((result) => result.skipped === true);
      context.check(Boolean(draftOwner), "concurrent draft clicks must elect exactly one owner");
      context.check(Boolean(draftLoser), "concurrent draft clicks must idempotently skip exactly one loser");
      context.check(["already_running", "already_succeeded"].includes(draftLoser?.reason),
        "draft loser must explain whether the owner is running or has succeeded");

      const scheduleClicks = await Promise.all([
        harness.schedule(correlationId, { scheduledFor: FIXED_NOW, platforms: PLATFORM_NAMES }),
        harness.schedule(correlationId, { scheduledFor: FIXED_NOW, platforms: PLATFORM_NAMES }),
      ]);
      const scheduleOwner = scheduleClicks.find((result) => result.skipped === false);
      const scheduleLoser = scheduleClicks.find((result) => result.skipped === true);
      context.check(Boolean(scheduleOwner), "concurrent schedule clicks must elect exactly one owner");
      context.check(Boolean(scheduleLoser), "concurrent schedule clicks must idempotently skip exactly one loser");
      context.equal(scheduleOwner?.duplicate, false, "schedule owner must not be marked duplicate");
      context.equal(scheduleLoser?.duplicate, true, "schedule loser must be marked duplicate");
      context.check(["already_running", "already_succeeded"].includes(scheduleLoser?.reason),
        "schedule loser must explain whether the owner is running or has succeeded");
      const dispatches = await Promise.all([
        harness.dispatchDue({ correlationId, now: FIXED_NOW }),
        harness.dispatchDue({ correlationId, now: FIXED_NOW }),
      ]);
      context.equal(dispatches.length, 2, "both concurrent dispatch clicks must resolve safely");
      const state = harness.inspect(correlationId);
      context.equal(state.events.filter((event) => event.stage === "draft" && event.status === "success").length, 1,
        "duplicate draft click must produce one success event");
      context.equal(state.events.filter((event) => event.stage === "schedule" && event.status === "success").length, 1,
        "duplicate schedule click must produce one success event");
      context.equal(state.artifacts.filter((artifact) => artifact.stage === "draft").length, 1,
        "concurrent draft clicks must create one draft artifact side effect");
      context.equal(state.platformReceipts.length, 2,
        "concurrent schedule and dispatch clicks must leave exactly one delivery per platform");
      context.equal(platformAttemptCount(state, "fake-alpha", "publish"), 1,
        "repeat dispatch click must not republish alpha");
      context.equal(platformAttemptCount(state, "fake-beta", "publish"), 1,
        "repeat dispatch click must not republish beta");
    },
  },
  {
    id: "disk_full_then_resume",
    stages: ["receive", "download", "media_validate", "ingest", "analyze", "generate"],
    faults: [FAULT_CODES.ENOSPC],
    invariants: ["disk_full_recoverable", "quality_failure_not_completed"],
    async execute(context) {
      const faults = new FaultPlan({ generate: { code: FAULT_CODES.ENOSPC, times: 1 } });
      const { harness } = await makeHarness(context, { faults });
      const received = context.addCorrelation(harness.receive(makeInput(context.id)));
      await expectFault(context, () => harness.run(received.correlationId), FAULT_CODES.ENOSPC);
      const failed = harness.inspect(received.correlationId);
      context.equal(harness.report(received.correlationId).summary.completedRuns, 0,
        "disk-full failure must not count as completed");
      assertFaultStored(context, failed, FAULT_CODES.ENOSPC);
      const resumed = await harness.resume(received.correlationId);
      context.equal(resumed.run.status, "awaiting_review", "one-off disk-full fault must be resumable");
      context.equal(eventFor(resumed, "generate", "success")?.attempt, 2, "generation retry must use attempt two");
    },
  },
  {
    id: "quality_failure_not_completed",
    stages: ["receive", "download", "media_validate", "ingest", "analyze", "generate", "quality"],
    faults: ["QUALITY_REJECTED"],
    invariants: ["quality_failure_not_completed"],
    async execute(context) {
      const { harness } = await makeHarness(context);
      const received = context.addCorrelation(harness.receive(makeInput(context.id, "rejected", {
        forceQualityFailure: true,
      })));
      await expectFault(context, () => harness.run(received.correlationId), "QUALITY_REJECTED");
      const state = harness.inspect(received.correlationId);
      context.equal(state.run.status, "quality_failed", "rejected output must remain quality_failed");
      context.equal(state.run.qualityPass, false, "rejected output must persist qualityPass=false");
      const report = harness.report(received.correlationId);
      context.equal(report.summary.completedRuns, 0, "rejected output must not count in completedRuns");
      context.equal(report.summary.qualityRejectedRuns, 1, "rejected output must count only in qualityRejectedRuns");
      context.check(!state.events.some((event) => ["review", "draft", "schedule"].includes(event.stage)),
        "rejected output must never advance to review, draft, or schedule");
    },
  },
  {
    id: "sensitive_sentinel_redaction",
    stages: ["receive", "download"],
    faults: ["SENSITIVE_SENTINEL"],
    invariants: ["sensitive_fields_redacted"],
    async execute(context) {
      const injectedMessage = `Authorization: Bearer ${SECRET_SENTINELS.bearer}; token=${SECRET_SENTINELS.token}; `
        + `secret=${SECRET_SENTINELS.cookie}; download=${SENSITIVE_DOWNLOAD_URL}`;
      const faults = new FaultPlan({
        download: { code: FAULT_CODES.DOWNLOAD_500, message: injectedMessage, times: 1 },
      });
      const { harness } = await makeHarness(context, { faults });
      const input = makeInput(context.id, "sensitive", {
        receivedAt: FIXED_NOW,
        authorization: `Bearer ${SECRET_SENTINELS.bearer}`,
        accessToken: SECRET_SENTINELS.token,
        cookie: SECRET_SENTINELS.cookie,
        accountId: SECRET_SENTINELS.identity,
        chatPayload: SECRET_SENTINELS.chat,
        signedUrl: `https://offline.invalid/media?signature=${SECRET_SENTINELS.signature}&expires=9999999999`,
        signatureMemo: SECRET_SENTINELS.signature,
        title: SECRET_SENTINELS.posixPath,
        description: SECRET_SENTINELS.windowsPath,
        owner: SECRET_SENTINELS.email,
        label: SECRET_SENTINELS.phone,
        downloadUrl: SENSITIVE_DOWNLOAD_URL,
        mediaURL: SENSITIVE_DOWNLOAD_URL,
        callbackUri: SENSITIVE_DOWNLOAD_URL,
      });
      const signed = harness.signDelivery(input, {
        expiresAt: "2030-01-01T00:05:00.000Z",
        nonce: "offline-sensitive-redaction",
      });
      const received = context.addCorrelation(harness.receiveSigned(signed));
      await expectFault(context, () => harness.run(received.correlationId), FAULT_CODES.DOWNLOAD_500);
      const serialized = JSON.stringify({
        inspect: harness.inspect(received.correlationId),
        report: harness.report(received.correlationId),
      });
      for (const sentinel of Object.values(SECRET_SENTINELS)) {
        context.check(!serialized.includes(sentinel), "sensitive sentinel must be absent from inspect and report output");
      }
      context.check(!/Bearer\s+(?!\[REDACTED\])\S+/i.test(serialized), "Bearer credentials must be redacted");
      context.check(serialized.includes("[REDACTED]"), "redaction must be explicit and machine observable");
      harness.db.exec("PRAGMA wal_checkpoint(FULL)");
      const durableBytes = [];
      for (const path of [harness.dbPath, `${harness.dbPath}-wal`]) {
        try { durableBytes.push(await readFile(path)); } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
      context.check(durableBytes.length >= 1, "sensitive scan must inspect the durable SQLite bytes");
      for (const sentinel of Object.values(SECRET_SENTINELS)) {
        context.check(!durableBytes.some((bytes) => bytes.includes(Buffer.from(sentinel))),
          "sensitive sentinel must never be written to SQLite or its WAL");
      }
    },
  },
];

async function runScenario(definition, options) {
  const started = performance.now();
  const sandbox = join(options.sessionRoot, "scenarios", definition.id);
  const context = new ScenarioContext(definition, sandbox, options.sessionRoot);
  let error = null;
  try {
    await mkdir(sandbox, { recursive: true, mode: 0o700 });
    await definition.execute(context);
  } catch (caught) {
    error = safeScenarioError(caught, options.sessionRoot);
  } finally {
    await context.closeAll();
  }
  return sanitizeReportValue({
    id: definition.id,
    status: error ? "failed" : "passed",
    durationMs: Math.max(0, Math.round(performance.now() - started)),
    assertions: context.assertions,
    correlationIds: [...context.correlationIds].sort(),
    stages: definition.stages,
    faults: definition.faults,
    invariants: definition.invariants,
    ...(context.evidence ? { evidence: context.evidence } : {}),
    ...(error ? { error } : {}),
  }, options.sessionRoot);
}

function evidenceMatrix(required, scenarios, property) {
  return required.map((item) => {
    const evidence = scenarios
      .filter((scenario) => scenario.status === "passed" && scenario[property]?.includes(item))
      .map((scenario) => scenario.id);
    return { id: item, covered: evidence.length > 0, evidence };
  });
}

function coverageIsComplete(coverage) {
  return ["stages", "faults", "invariants"]
    .every((category) => Array.isArray(coverage?.[category])
      && coverage[category].length > 0
      && coverage[category].every((entry) => entry.covered === true));
}

function determineSuiteStatus(scenarios, coverage) {
  return scenarios.every((scenario) => scenario.status === "passed") && coverageIsComplete(coverage)
    ? "passed"
    : "failed";
}

function findReportLeaks(report, sessionRoot) {
  const serialized = JSON.stringify(report);
  const leaks = [];
  if (sessionRoot && serialized.includes(sessionRoot)) leaks.push("temporary_absolute_path");
  if (/(?:\/Users|\/home|\/private\/var\/folders|\/tmp)\/[^\s"']+/.test(serialized)) leaks.push("absolute_path");
  for (const [name, sentinel] of Object.entries(SECRET_SENTINELS)) {
    if (serialized.includes(sentinel)) leaks.push(`sensitive_${name}`);
  }
  if (/Bearer\s+(?!\[REDACTED\])[^\s"']+/i.test(serialized)) leaks.push("bearer_credential");
  return [...new Set(leaks)];
}

export async function runOfflineE2ESuite(options = {}) {
  if (globalThis.__ZHITAI_E2E_NETWORK_LOCKDOWN__ !== true
    || process.env.ZHITAI_E2E_NETWORK_POLICY !== "deny_all") {
    throw new Error("offline_network_lockdown_not_preloaded");
  }
  if (!options.sessionRoot) throw new TypeError("runOfflineE2ESuite requires an ephemeral sessionRoot");

  const startedAt = new Date().toISOString();
  const started = performance.now();
  const scenarios = [];
  for (const definition of SCENARIOS) {
    scenarios.push(await runScenario(definition, options));
  }

  const coverage = {
    stages: evidenceMatrix(STAGES, scenarios, "stages"),
    faults: evidenceMatrix(REQUIRED_FAULTS, scenarios, "faults"),
    invariants: evidenceMatrix(REQUIRED_INVARIANTS, scenarios, "invariants"),
  };
  const coverageComplete = coverageIsComplete(coverage);
  let report = sanitizeReportValue({
    schemaVersion: 1,
    suite: SUITE,
    runId: options.runId || "offline-e2e-manual",
    status: determineSuiteStatus(scenarios, coverage),
    offline: true,
    networkPolicy: "deny_all",
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Math.max(0, Math.round(performance.now() - started)),
    environment: {
      temporaryHome: true,
      temporaryDatabase: "per_scenario_sqlite",
      syntheticMediaOnly: true,
      fakePlatformAdaptersOnly: true,
      externalIdentityFixtures: "none",
      realPublicationEnabled: false,
      networkGuardPreloaded: true,
      kernelNetworkIsolation: process.env.ZHITAI_E2E_KERNEL_NETWORK === "none",
      credentialEnvironmentSanitized: process.env.ZHITAI_E2E_ENV_SANITIZED === "1",
      sandboxRetained: Boolean(options.keepSandbox),
    },
    summary: {
      total: scenarios.length,
      passed: scenarios.filter((scenario) => scenario.status === "passed").length,
      failed: scenarios.filter((scenario) => scenario.status === "failed").length,
      assertions: scenarios.reduce((sum, scenario) => sum + scenario.assertions, 0),
      coverageComplete,
    },
    scenarios,
    coverage,
    gaps: [
      "The current desktop/server orchestration is not imported; this is an executable state-contract reference harness until production ports adopt it.",
      "Real platform APIs, UIs, credentials, and public publishing are intentionally excluded.",
      "Real chat providers and externally signed download envelopes are replaced by synthetic envelope semantics.",
      "Real media codecs, GPU generation, and subjective content quality are not exercised.",
      "macOS launchd and a physical reboot are not invoked; durable boot-ID transition semantics are exercised.",
      "Kernel-level ENOSPC is represented by a deterministic injected filesystem fault.",
      "Strict exactly-once after remote acceptance but before local receipt commit requires platform idempotency and reconciliation; orphan claims recover on explicit startup recover().",
    ],
  }, options.sessionRoot);

  const leaks = findReportLeaks(report, options.sessionRoot);
  if (leaks.length > 0) {
    report.scenarios.push({
      id: "report_sanitization_guard",
      status: "failed",
      durationMs: 0,
      assertions: 1,
      correlationIds: [],
      stages: [],
      faults: ["SENSITIVE_SENTINEL"],
      invariants: ["sensitive_fields_redacted"],
      error: { name: "ReportLeakError", code: "REPORT_LEAK_DETECTED", message: leaks.join(",") },
    });
    report.status = "failed";
    report.summary.total += 1;
    report.summary.failed += 1;
    report.summary.assertions += 1;
  }
  return report;
}

export {
  coverageIsComplete,
  determineSuiteStatus,
  SCENARIOS,
  REQUIRED_FAULTS,
  REQUIRED_INVARIANTS,
};
