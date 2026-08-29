import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  DIAGNOSTICS_LIMITS,
  createDiagnosticStore,
  isManagedDiagnosticFilename,
  projectDiagnosticEvent,
  resolveDiagnosticsPolicy,
} from "../local-agent/diagnostics.mjs";
import {
  DiagnosticsMaintenanceError,
  previewLegacyDiagnostics,
  runDiagnosticsMaintenanceCli,
} from "../local-agent/diagnostics-maintenance.mjs";

const IS_WINDOWS = process.platform === "win32";

const CANARIES = Object.freeze({
  credential: "sk-test-DIAG_CREDENTIAL_7Q9X",
  cookie: "COOKIE_CANARY_4K8M",
  phone: "13800138000",
  privateChat: "PRIVATE_CHAT_BODY_6W2N",
  signature: "TEMP_SIGNATURE_9P3R",
  path: "PRIVATE_PATH_CANARY_5J1D",
  html: "HTML_BODY_CANARY_8V4C",
  unknown: "UNKNOWN_FIELD_CANARY_2M7A",
});

function syntheticSensitiveInput() {
  return {
    kind: "sync_response",
    source: "filehelper_bridge",
    outcome: "observed",
    transport: "fetch",
    contentType: "html",
    url: `https://media.invalid/private/video?X-Amz-Signature=${CANARIES.signature}&token=${CANARIES.credential}`,
    text: `${CANARIES.privateChat} 联系人 ${CANARIES.phone} Authorization: Bearer ${CANARIES.credential}`,
    html: `<html><body>${CANARIES.html}</body></html>`,
    cookie: `session=${CANARIES.cookie}`,
    token: CANARIES.credential,
    localPath: `/Users/alice/Library/Private/${CANARIES.path}.json`,
    nested: {
      authorization: `Bearer ${CANARIES.credential}`,
      arbitrary: CANARIES.unknown,
    },
    metrics: {
      itemCount: 3,
      messageCount: 2,
      linkCount: 1,
      durationMs: 25,
      statusCode: 202,
    },
  };
}

function assertNoCanaries(value, label = "output") {
  const serialized = typeof value === "string" ? value : JSON.stringify(value);
  for (const [kind, marker] of Object.entries(CANARIES)) {
    assert.equal(serialized.includes(marker), false, `${label} 不得包含 ${kind} canary`);
  }
  assert.equal(serialized.includes("/Users/alice/"), false, `${label} 不得包含私有绝对路径`);
  assert.equal(serialized.includes("https://media.invalid/"), false, `${label} 不得包含 URL`);
}

async function makeTempDir(t, prefix = "zhitai-diag-test-") {
  const root = await fs.mkdtemp(join(tmpdir(), prefix));
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
  return root;
}

function sequentialIds() {
  let current = 0;
  return () => (current++).toString(16).padStart(24, "0");
}

function mode(stat) {
  return stat.mode & 0o777;
}

function modeString(stat) {
  return mode(stat).toString(8).padStart(4, "0");
}

test("policy: debug 默认关闭，只有显式 true + 60 分钟内到期时间才授权，保留值受硬上限约束", () => {
  const now = Date.UTC(2026, 7, 27, 1, 0, 0);
  const defaults = resolveDiagnosticsPolicy({}, {}, now);
  assert.equal(defaults.debug.enabled, false);
  assert.equal(defaults.debug.reason, "disabled");

  const stringTrue = resolveDiagnosticsPolicy({
    debug: { enabled: "true", expiresAt: now + 1_000 },
  }, {}, now);
  assert.equal(stringTrue.debug.enabled, false, "字符串 true 不是显式授权");

  const noExpiry = resolveDiagnosticsPolicy({ debug: { enabled: true } }, {}, now);
  assert.equal(noExpiry.debug.enabled, false);
  assert.equal(noExpiry.debug.reason, "invalid_expiry");

  const expired = resolveDiagnosticsPolicy({
    debug: { enabled: true, expiresAt: now },
  }, {}, now);
  assert.equal(expired.debug.enabled, false);
  assert.equal(expired.debug.reason, "expired");

  const tooLong = resolveDiagnosticsPolicy({
    debug: { enabled: true, expiresAt: now + DIAGNOSTICS_LIMITS.debugMaxDurationMs + 1 },
  }, {}, now);
  assert.equal(tooLong.debug.enabled, false);
  assert.equal(tooLong.debug.reason, "expiry_exceeds_limit");

  const authorized = resolveDiagnosticsPolicy({
    debug: { enabled: true, expiresAt: now + DIAGNOSTICS_LIMITS.debugMaxDurationMs },
    retention: {
      maxAgeMs: Number.MAX_SAFE_INTEGER,
      maxFiles: Number.MAX_SAFE_INTEGER,
      maxBytes: Number.MAX_SAFE_INTEGER,
      maxEventBytes: Number.MAX_SAFE_INTEGER,
    },
  }, {}, now);
  assert.equal(authorized.debug.enabled, true);
  assert.equal(authorized.debug.reason, "authorized");
  assert.deepEqual(authorized.retention, {
    maxAgeMs: DIAGNOSTICS_LIMITS.retention.hardMaxAgeMs,
    maxFiles: DIAGNOSTICS_LIMITS.retention.hardMaxFiles,
    maxBytes: DIAGNOSTICS_LIMITS.retention.hardMaxBytes,
    maxEventBytes: DIAGNOSTICS_LIMITS.retention.hardMaxEventBytes,
  });
});

test("projection: 黑白名单固定 schema，默认/debug 都不复制凭据、手机号、私聊、HTML、临时 URL 或绝对路径", () => {
  const now = Date.UTC(2026, 7, 27, 1, 0, 0);
  const input = syntheticSensitiveInput();
  const normal = projectDiagnosticEvent(input, { now });
  assert.deepEqual(Object.keys(normal), [
    "schemaVersion", "recordedAt", "kind", "source", "outcome", "metrics", "signals", "debug",
  ]);
  assert.deepEqual(Object.keys(normal.metrics), [
    "payloadBytes", "bodyBytes", "itemCount", "messageCount", "linkCount", "durationMs", "statusCode",
  ]);
  assert.deepEqual(Object.keys(normal.signals), ["hadBody", "hadHtml", "hadUrl"]);
  assert.equal(normal.kind, "sync_response");
  assert.equal(normal.source, "filehelper_bridge");
  assert.equal(normal.outcome, "observed");
  assert.equal(normal.metrics.statusCode, 202);
  assert.equal(normal.metrics.messageCount, 2);
  assert.equal(normal.signals.hadBody, true);
  assert.equal(normal.signals.hadHtml, true);
  assert.equal(normal.signals.hadUrl, true);
  assert.equal(normal.debug.active, false);
  assert.equal(normal.debug.sensitiveFieldCount, 0);
  assert.equal("url" in normal, false);
  assert.equal("text" in normal, false);
  assert.equal("html" in normal, false);
  assertNoCanaries(normal, "默认投影");

  const debug = projectDiagnosticEvent(input, { now, debugActive: true });
  assert.equal(debug.debug.active, true);
  assert.equal(debug.debug.transport, "fetch");
  assert.equal(debug.debug.contentType, "html");
  assert.equal(debug.debug.payloadShape, "object");
  assert.ok(debug.debug.sensitiveFieldCount > 0);
  assert.ok(debug.debug.credentialLikeCount > 0);
  assert.ok(debug.debug.phoneLikeCount > 0);
  assert.ok(debug.debug.signedUrlCount > 0);
  assert.ok(debug.debug.absolutePathCount > 0);
  assert.ok(debug.debug.htmlValueCount > 0);
  assertNoCanaries(debug, "debug 投影");

  const unknowns = projectDiagnosticEvent({
    kind: CANARIES.unknown,
    source: CANARIES.privateChat,
    outcome: CANARIES.credential,
    text: CANARIES.html,
  }, { now, debugActive: true, meta: { transport: CANARIES.signature, contentType: CANARIES.cookie } });
  assert.equal(unknowns.kind, "unknown");
  assert.equal(unknowns.source, "unknown");
  assert.equal(unknowns.outcome, "unknown");
  assert.equal(unknowns.debug.transport, "unknown");
  assert.equal(unknowns.debug.contentType, "unknown");
  assertNoCanaries(unknowns, "未知枚举投影");
});

test("store: 磁盘、日志、API ack/status 和导出包共用安全 schema", async (t) => {
  const root = await makeTempDir(t);
  const dataDir = join(root, "data");
  const diagnosticsDir = join(dataDir, "diag");
  await fs.mkdir(diagnosticsDir, { recursive: true });
  await fs.chmod(diagnosticsDir, 0o777);
  const legacyPath = join(diagnosticsDir, "sync-legacy.json");
  await fs.writeFile(legacyPath, JSON.stringify({ text: CANARIES.privateChat, token: CANARIES.credential }));
  await fs.chmod(legacyPath, 0o666);

  const logs = [];
  const logger = {
    info: (entry) => logs.push(entry),
    warn: (entry) => logs.push(entry),
    error: (entry) => logs.push(entry),
  };
  const now = Date.UTC(2026, 7, 27, 2, 0, 0);
  const store = createDiagnosticStore({
    dataDir,
    env: {},
    now: () => now,
    logger,
    randomId: () => "0123456789abcdef01234567",
  });

  const ack = await store.record(syntheticSensitiveInput());
  assert.deepEqual(ack, {
    schemaVersion: 1,
    accepted: true,
    code: "recorded",
    debugActive: false,
  });
  const status = await store.status();
  const bundle = await store.exportBundle();

  if (!IS_WINDOWS) {
    assert.equal(mode(await fs.stat(diagnosticsDir)), 0o700);
    assert.equal(mode(await fs.stat(legacyPath)), 0o600, "既有常规文件权限应收紧");
  }
  const names = await fs.readdir(diagnosticsDir);
  const managed = names.filter(isManagedDiagnosticFilename);
  assert.equal(managed.length, 1);
  const managedPath = join(diagnosticsDir, managed[0]);
  if (!IS_WINDOWS) assert.equal(mode(await fs.stat(managedPath)), 0o600);
  assert.equal(names.some((name) => name.startsWith(".zhitai-diag-v2-tmp-")), false, "原子写不应遗留临时文件");

  const managedDisk = await fs.readFile(managedPath, "utf8");
  assertNoCanaries(managedDisk, "新格式磁盘文件");
  assert.equal((await fs.readFile(legacyPath, "utf8")).includes(CANARIES.privateChat), true, "legacy 正文不得自动改写/删除");

  assert.equal(status.mode, "structured_only");
  assert.deepEqual(status.permissions, IS_WINDOWS
    ? { model: "windows_profile_acl", directory: null, regularFile: null }
    : { model: "posix_mode", directory: "0700", regularFile: "0600" });
  assert.equal(status.managedEvents.count, 1);
  assert.equal(bundle.eventCount, 1);
  assert.equal(bundle.events.length, 1);
  assertNoCanaries(ack, "API ack");
  assertNoCanaries(status, "API status");
  assertNoCanaries(bundle, "导出包");
  assertNoCanaries(logs, "结构化日志");
});

test("store: Windows 不打开目录句柄或伪装报告 POSIX mode", async (t) => {
  const root = await makeTempDir(t, "zhitai-diag-windows-");
  const dataDir = join(root, "data");
  const diagnosticsDir = join(dataDir, "diag");
  const chmodCalls = [];
  const windowsFs = {
    mkdir: (...args) => fs.mkdir(...args),
    lstat: (...args) => fs.lstat(...args),
    readdir: (...args) => fs.readdir(...args),
    link: (...args) => fs.link(...args),
    unlink: (...args) => fs.unlink(...args),
    open: async (...args) => {
      if (args[0] === diagnosticsDir) throw new Error("windows_directory_open_not_supported");
      const handle = await fs.open(...args);
      return new Proxy(handle, {
        get(target, property) {
          if (property === "chmod") {
            return async () => {
              chmodCalls.push(args[0]);
              throw new Error("windows_chmod_not_supported");
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
  const store = createDiagnosticStore({
    dataDir,
    env: {},
    fs: windowsFs,
    platform: "win32",
    randomId: () => "fedcbafedcbafedcbafedcba",
  });

  const ack = await store.record({ kind: "health", itemCount: 1 });
  assert.equal(ack.accepted, true);
  const status = await store.status();
  assert.deepEqual(status.permissions, {
    model: "windows_profile_acl",
    directory: null,
    regularFile: null,
  });
  assert.deepEqual(chmodCalls, []);
  assert.equal((await fs.readdir(diagnosticsDir)).filter(isManagedDiagnosticFilename).length, 1);
});

test("store: debug 在每次写入时重新检查时钟，到期后自动关闭", async (t) => {
  const root = await makeTempDir(t);
  let currentMs = Date.UTC(2026, 7, 27, 3, 0, 0);
  const expiresAt = currentMs + 1_000;
  const store = createDiagnosticStore({
    dataDir: join(root, "data"),
    env: {},
    now: () => currentMs,
    randomId: sequentialIds(),
    policy: { debug: { enabled: true, expiresAt } },
  });

  const first = await store.record(syntheticSensitiveInput());
  assert.equal(first.debugActive, true);
  currentMs += 2_000;
  const second = await store.record(syntheticSensitiveInput());
  assert.equal(second.debugActive, false);
  const bundle = await store.exportBundle();
  assert.deepEqual(bundle.events.map((event) => event.debug.active), [true, false]);
  assertNoCanaries(bundle, "debug 过期导出");
});

test("store: 年龄/数量/总字节硬上限只轮转专属新格式，legacy/未知文件永不删", async (t) => {
  const root = await makeTempDir(t);
  const dataDir = join(root, "data");
  const diagnosticsDir = join(dataDir, "diag");
  await fs.mkdir(diagnosticsDir, { recursive: true });
  const legacy = join(diagnosticsDir, "sync-1700000000000-deadbe.json");
  const unknown = join(diagnosticsDir, "operator-note.bin");
  await fs.writeFile(legacy, CANARIES.privateChat);
  await fs.writeFile(unknown, CANARIES.credential);

  let currentMs = Date.UTC(2026, 7, 27, 4, 0, 0);
  const store = createDiagnosticStore({
    dataDir,
    env: {},
    now: () => currentMs,
    randomId: sequentialIds(),
    policy: {
      retention: {
        maxAgeMs: 60_000,
        maxFiles: 2,
        maxBytes: 8 * 1024,
      },
    },
  });
  for (let index = 0; index < 3; index += 1) {
    await store.record({ kind: "health", itemCount: index });
    currentMs += 1;
  }
  let status = await store.status();
  assert.equal(status.managedEvents.count, 2, "数量上限应轮转最旧新格式事件");
  assert.equal(await fs.readFile(legacy, "utf8"), CANARIES.privateChat);
  assert.equal(await fs.readFile(unknown, "utf8"), CANARIES.credential);

  currentMs += 60_001;
  await store.record({ kind: "health" });
  status = await store.status();
  assert.equal(status.managedEvents.count, 1, "超龄新格式事件应被轮转");
  assert.equal(await fs.readFile(legacy, "utf8"), CANARIES.privateChat, "legacy 在年龄轮转中不得删除");
  assert.equal(await fs.readFile(unknown, "utf8"), CANARIES.credential, "未知文件在年龄轮转中不得删除");

  const byteRoot = await makeTempDir(t, "zhitai-diag-bytes-");
  let byteNow = Date.UTC(2026, 7, 27, 5, 0, 0);
  const byteStore = createDiagnosticStore({
    dataDir: join(byteRoot, "data"),
    env: {},
    now: () => byteNow++,
    randomId: sequentialIds(),
    policy: { retention: { maxFiles: 100, maxBytes: 1_024, maxEventBytes: 1_024 } },
  });
  for (let index = 0; index < 8; index += 1) await byteStore.record({ kind: "health", itemCount: index });
  const byteStatus = await byteStore.status();
  assert.ok(byteStatus.managedEvents.totalBytes <= 1_024, "受管新格式总字节数不得超上限");
});

function trackingFs(readPaths) {
  return {
    mkdir: (...args) => fs.mkdir(...args),
    lstat: (...args) => fs.lstat(...args),
    readdir: (...args) => fs.readdir(...args),
    link: (...args) => fs.link(...args),
    unlink: (...args) => fs.unlink(...args),
    open: async (...args) => {
      const handle = await fs.open(...args);
      return new Proxy(handle, {
        get(target, property) {
          if (property === "readFile") {
            return async (...readArgs) => {
              readPaths.push(args[0]);
              return target.readFile(...readArgs);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    },
  };
}

test("store: 崩溃遗留的严格受管 temp 只用 metadata 回收，不得绕过数量/字节上限或删除 legacy/未知文件", async (t) => {
  const root = await makeTempDir(t, "zhitai-diag-crash-temp-");
  const dataDir = join(root, "data");
  const diagnosticsDir = join(dataDir, "diag");
  await fs.mkdir(diagnosticsDir, { recursive: true });
  const currentMs = Date.UTC(2026, 7, 27, 5, 30, 0);
  const staleMs = currentMs - (2 * 60 * 60 * 1_000);
  const staleDate = new Date(staleMs);
  const strictTemps = [];
  for (let index = 0; index < 5; index += 1) {
    const id = (index + 100).toString(16).padStart(24, "0");
    const path = join(diagnosticsDir, `.zhitai-diag-v2-tmp-${staleMs}-${id}.json`);
    await fs.writeFile(path, Buffer.alloc(700, index));
    await fs.utimes(path, staleDate, staleDate);
    strictTemps.push(path);
  }
  const legacy = join(diagnosticsDir, "sync-crash-leftover.json");
  const unknown = join(diagnosticsDir, `.zhitai-diag-v2-tmp-${staleMs}-not-a-valid-managed-id.json`);
  await fs.writeFile(legacy, CANARIES.privateChat);
  await fs.writeFile(unknown, CANARIES.credential);

  const bodyReads = [];
  const store = createDiagnosticStore({
    dataDir,
    env: {},
    now: () => currentMs,
    fs: trackingFs(bodyReads),
    randomId: sequentialIds(),
    policy: { retention: { maxFiles: 2, maxBytes: 1_024, maxEventBytes: 1_024 } },
  });
  const initialized = await store.initialize();
  assert.equal(initialized.rotatedCount, strictTemps.length);
  for (const path of strictTemps) {
    await assert.rejects(fs.lstat(path), { code: "ENOENT" });
  }
  assert.deepEqual(bodyReads, [], "temp/legacy 回收和权限收紧不得读取正文");
  assert.equal(await fs.readFile(legacy, "utf8"), CANARIES.privateChat);
  assert.equal(await fs.readFile(unknown, "utf8"), CANARIES.credential);

  const ack = await store.record({ kind: "health" });
  assert.equal(ack.accepted, true);
  const status = await store.status();
  assert.ok(status.managedEvents.count <= 2);
  assert.ok(status.managedEvents.totalBytes <= 1_024);
  const remainingNames = await fs.readdir(diagnosticsDir);
  assert.equal(
    remainingNames.some((name) => /^\.zhitai-diag-v2-tmp-\d{13}-[0-9a-f]{24}\.json$/.test(name)),
    false,
    "操作后严格受管 temp 必须为零",
  );
  assert.equal(await fs.readFile(legacy, "utf8"), CANARIES.privateChat, "legacy 不得删除");
  assert.equal(await fs.readFile(unknown, "utf8"), CANARIES.credential, "非严格名称不得删除");
});

test("store: 新鲜受管 temp 视为可能的其他活跃进程并失败关闭，不读不删", async (t) => {
  const root = await makeTempDir(t, "zhitai-diag-live-temp-");
  const dataDir = join(root, "data");
  const diagnosticsDir = join(dataDir, "diag");
  await fs.mkdir(diagnosticsDir, { recursive: true });
  const currentMs = Date.UTC(2026, 7, 27, 5, 45, 0);
  const freshTemp = join(diagnosticsDir, `.zhitai-diag-v2-tmp-${currentMs}-abcdefabcdefabcdefabcdef.json`);
  await fs.writeFile(freshTemp, CANARIES.privateChat);
  await fs.utimes(freshTemp, new Date(currentMs), new Date(currentMs));
  const reads = [];
  const logs = [];
  const store = createDiagnosticStore({
    dataDir,
    env: {},
    now: () => currentMs,
    fs: trackingFs(reads),
    logger: { error: (entry) => logs.push(entry) },
  });
  await assert.rejects(store.initialize(), { code: "diagnostics_concurrent_writer_detected" });
  assert.deepEqual(reads, [], "新鲜 temp 不得读取正文");
  assert.equal(await fs.readFile(freshTemp, "utf8"), CANARIES.privateChat, "可能活跃的 temp 不得删除");
  assertNoCanaries(logs, "多进程失败关闭日志");
});

test("store: link(temp, final) 后崩溃的 nlink=2 同 inode 可仅用 metadata 完成发布，不匹配硬链接仍拒绝", async (t) => {
  const root = await makeTempDir(t, "zhitai-diag-linked-temp-");
  const dataDir = join(root, "data");
  const diagnosticsDir = join(dataDir, "diag");
  await fs.mkdir(diagnosticsDir, { recursive: true });
  const currentMs = Date.UTC(2026, 7, 27, 5, 50, 0);
  const staleMs = currentMs - (2 * 60 * 60 * 1_000);
  const id = "cccccccccccccccccccccccc";
  const finalPath = join(diagnosticsDir, `zhitai-diag-v2-${staleMs}-${id}.json`);
  const tempPath = join(diagnosticsDir, `.zhitai-diag-v2-tmp-${staleMs}-${id}.json`);
  await fs.writeFile(finalPath, CANARIES.privateChat, { mode: 0o644 });
  await fs.link(finalPath, tempPath);
  await fs.utimes(finalPath, new Date(staleMs), new Date(staleMs));
  assert.equal((await fs.lstat(finalPath)).nlink, 2);
  assert.equal((await fs.lstat(tempPath)).nlink, 2);
  const legacy = join(diagnosticsDir, "sync-must-remain.json");
  await fs.writeFile(legacy, CANARIES.credential);

  const reads = [];
  const store = createDiagnosticStore({
    dataDir,
    env: {},
    now: () => currentMs,
    fs: trackingFs(reads),
  });
  await store.initialize();
  await assert.rejects(fs.lstat(tempPath), { code: "ENOENT" });
  assert.equal((await fs.lstat(finalPath)).nlink, 1);
  if (!IS_WINDOWS) assert.equal(mode(await fs.lstat(finalPath)), 0o600);
  assert.equal(await fs.readFile(finalPath, "utf8"), CANARIES.privateChat, "完成发布不得读/改正文");
  assert.equal(await fs.readFile(legacy, "utf8"), CANARIES.credential, "legacy 不得删除");
  assert.deepEqual(reads, [], "nlink=2 恢复只得使用 metadata");
});

test("store: 两个 store 同目录并发 record 时 temp writer claim 失败关闭，两者完成后仍满足 maxFiles/maxBytes", async (t) => {
  const root = await makeTempDir(t, "zhitai-diag-concurrent-");
  const dataDir = join(root, "data");
  const currentMs = Date.UTC(2026, 7, 27, 5, 55, 0);
  let tempOpenAttempts = 0;
  let releaseTempOpens;
  const bothReady = new Promise((resolve) => {
    releaseTempOpens = resolve;
  });
  const baseFs = trackingFs([]);
  const concurrentFs = {
    ...baseFs,
    open: async (...args) => {
      if (typeof args[0] === "string"
        && args[0].includes("/.zhitai-diag-v2-tmp-")
        && args[1] === "wx") {
        tempOpenAttempts += 1;
        if (tempOpenAttempts === 2) releaseTempOpens();
        await bothReady;
      }
      return baseFs.open(...args);
    },
  };
  const policy = { retention: { maxFiles: 1, maxBytes: 1_024, maxEventBytes: 1_024 } };
  const first = createDiagnosticStore({
    dataDir,
    env: {},
    now: () => currentMs,
    fs: concurrentFs,
    policy,
    randomId: () => "aaaaaaaaaaaaaaaaaaaaaaaa",
  });
  const second = createDiagnosticStore({
    dataDir,
    env: {},
    now: () => currentMs,
    fs: concurrentFs,
    policy,
    randomId: () => "bbbbbbbbbbbbbbbbbbbbbbbb",
  });

  const results = await Promise.allSettled([
    first.record({ kind: "health", itemCount: 1 }),
    second.record({ kind: "health", itemCount: 2 }),
  ]);
  assert.equal(tempOpenAttempts, 2, "测试必须强制两个实例同时进入发布窗口");
  const accepted = results.filter((result) => result.status === "fulfilled" && result.value.accepted);
  const concurrentRejects = results.filter((result) => result.status === "rejected"
    && result.reason?.code === "diagnostics_concurrent_writer_detected");
  assert.ok(accepted.length <= 1, "重叠 writer claim 不得同时 accepted");
  assert.ok(concurrentRejects.length >= 1, "至少一个重叠 writer 必须失败关闭");

  const verifier = createDiagnosticStore({ dataDir, env: {}, now: () => currentMs, policy });
  const status = await verifier.status();
  assert.ok(status.managedEvents.count <= 1);
  assert.ok(status.managedEvents.totalBytes <= 1_024);
  const names = await fs.readdir(join(dataDir, "diag"));
  assert.equal(
    names.some((name) => /^\.zhitai-diag-v2-tmp-\d{13}-[0-9a-f]{24}\.json$/.test(name)),
    false,
    "并发失败收敛后不得遗留 temp",
  );
});

test("export: 只读专属新格式文件，且对被篡改的未知字段再次 allowlist 投影", async (t) => {
  const root = await makeTempDir(t);
  const dataDir = join(root, "data");
  const diagnosticsDir = join(dataDir, "diag");
  await fs.mkdir(diagnosticsDir, { recursive: true });
  const now = Date.UTC(2026, 7, 27, 6, 0, 0);
  const managedName = `zhitai-diag-v2-${now}-abcdefabcdefabcdefabcdef.json`;
  const managedPath = join(diagnosticsDir, managedName);
  const legacyPath = join(diagnosticsDir, `sync-${CANARIES.phone}.json`);
  await fs.writeFile(legacyPath, JSON.stringify(syntheticSensitiveInput()));
  await fs.writeFile(managedPath, JSON.stringify({
    schemaVersion: 2,
    recordedAt: new Date(now).toISOString(),
    kind: "sync_response",
    source: "filehelper_bridge",
    outcome: "observed",
    metrics: { payloadBytes: 10, statusCode: 202 },
    signals: { hadBody: true, hadHtml: true, hadUrl: true },
    debug: { active: false },
    token: CANARIES.credential,
    text: CANARIES.privateChat,
    url: `https://media.invalid/?signature=${CANARIES.signature}`,
    path: `/Users/alice/${CANARIES.path}`,
  }));

  const reads = [];
  const store = createDiagnosticStore({
    dataDir,
    env: {},
    now: () => now,
    fs: trackingFs(reads),
  });
  const bundle = await store.exportBundle();
  assert.equal(bundle.eventCount, 1);
  assert.equal(bundle.skippedEventCount, 0);
  assert.deepEqual(reads, [managedPath], "导出不得读取 legacy/未知文件正文");
  assert.equal("token" in bundle.events[0], false);
  assert.equal("text" in bundle.events[0], false);
  assert.equal("url" in bundle.events[0], false);
  assert.equal("path" in bundle.events[0], false);
  assertNoCanaries(bundle, "被篡改的受管文件导出");
  assert.equal((await fs.readFile(legacyPath, "utf8")).includes(CANARIES.credential), true);
});

test("store: symlink/硬链接/非当前 uid 均失败关闭，对外错误/日志不携带路径", {
  skip: IS_WINDOWS ? "Windows 创建符号链接需要 Developer Mode 或额外权限" : false,
}, async (t) => {
  const root = await makeTempDir(t);
  const dataDir = join(root, `data-${CANARIES.path}`);
  const realDir = join(root, "real-diag");
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(realDir);
  await fs.symlink(realDir, join(dataDir, "diag"), "dir");
  const logs = [];
  const linkedStore = createDiagnosticStore({
    dataDir,
    env: {},
    logger: { error: (entry) => logs.push(entry) },
  });
  await assert.rejects(linkedStore.initialize(), (error) => {
    assert.equal(error.code, "diagnostics_symlink_rejected");
    assert.equal(error.message, "diagnostics_symlink_rejected");
    assert.equal(error.message.includes(root), false);
    assert.equal(error.stack.includes("/Users/"), false, "安全错误 stack 不得带私有源码路径");
    return true;
  });
  assertNoCanaries(logs, "symlink 错误日志");

  const secondData = join(root, "second-data");
  const secondDiag = join(secondData, "diag");
  await fs.mkdir(secondDiag, { recursive: true });
  const target = join(root, `${CANARIES.privateChat}.txt`);
  await fs.writeFile(target, CANARIES.credential);
  await fs.symlink(target, join(secondDiag, ".zhitai-diag-v2-tmp-1787790000000-111111111111111111111111.json"));
  const entryStore = createDiagnosticStore({ dataDir: secondData, env: {} });
  await assert.rejects(entryStore.status(), { code: "diagnostics_symlink_rejected" });
  assert.equal(await fs.readFile(target, "utf8"), CANARIES.credential, "symlink 目标不得读/改/删");

  const thirdData = join(root, "third-data");
  const thirdDiag = join(thirdData, "diag");
  await fs.mkdir(thirdDiag, { recursive: true });
  const hardlinkTarget = join(root, "shared-hardlink-target.json");
  await fs.writeFile(hardlinkTarget, CANARIES.privateChat, { mode: 0o644 });
  await fs.chmod(hardlinkTarget, 0o644);
  await fs.link(hardlinkTarget, join(thirdDiag, ".zhitai-diag-v2-tmp-1787790000000-222222222222222222222222.json"));
  const hardlinkStore = createDiagnosticStore({ dataDir: thirdData, env: {} });
  await assert.rejects(hardlinkStore.initialize(), { code: "diagnostics_hardlink_rejected" });
  assert.equal(mode(await fs.stat(hardlinkTarget)), 0o644, "硬链接目标权限不得被收紧");
  assert.equal(await fs.readFile(hardlinkTarget, "utf8"), CANARIES.privateChat, "硬链接目标不得读/改/删");

  if (typeof process.getuid === "function") {
    const ownerData = join(root, "owner-data");
    const ownerDiag = join(ownerData, "diag");
    await fs.mkdir(ownerDiag, { recursive: true });
    const ownerMismatchFs = {
      mkdir: (...args) => fs.mkdir(...args),
      lstat: async (...args) => {
        const stat = await fs.lstat(...args);
        if (args[0] !== ownerDiag) return stat;
        return new Proxy(stat, {
          get(targetStat, property) {
            if (property === "uid") return process.getuid() + 1;
            const value = Reflect.get(targetStat, property, targetStat);
            return typeof value === "function" ? value.bind(targetStat) : value;
          },
        });
      },
    };
    const ownerStore = createDiagnosticStore({ dataDir: ownerData, env: {}, fs: ownerMismatchFs });
    await assert.rejects(ownerStore.initialize(), { code: "diagnostics_owner_mismatch" });
  }
});

test("maintenance preview: 仅 readdir/lstat 聚合数量、大小、mtime、权限与特殊文件，不读正文/跟链接/输出名称路径", async (t) => {
  const root = await makeTempDir(t);
  const diagnosticsDir = join(root, `diag-${CANARIES.path}`);
  await fs.mkdir(diagnosticsDir, { mode: 0o750 });
  await fs.chmod(diagnosticsDir, 0o750);
  const first = join(diagnosticsDir, `sync-${CANARIES.phone}.json`);
  const second = join(diagnosticsDir, `legacy-${CANARIES.privateChat}.json`);
  await fs.writeFile(first, CANARIES.credential);
  await fs.writeFile(second, `${CANARIES.signature}${CANARIES.html}`);
  await fs.chmod(first, 0o644);
  await fs.chmod(second, 0o600);
  const firstTime = new Date("2026-08-20T01:02:03.000Z");
  const secondTime = new Date("2026-08-21T04:05:06.000Z");
  await fs.utimes(first, firstTime, firstTime);
  await fs.utimes(second, secondTime, secondTime);
  const nested = join(diagnosticsDir, `nested-${CANARIES.unknown}`);
  await fs.mkdir(nested);
  const link = join(diagnosticsDir, `link-${CANARIES.cookie}`);
  if (!IS_WINDOWS) await fs.symlink(first, link);

  const calls = [];
  const metadataOnlyFs = {
    readdir: async (...args) => {
      calls.push("readdir");
      return fs.readdir(...args);
    },
    lstat: async (...args) => {
      calls.push("lstat");
      return fs.lstat(...args);
    },
    readFile: async () => {
      throw new Error("preview_must_not_read");
    },
    open: async () => {
      throw new Error("preview_must_not_open");
    },
    stat: async () => {
      throw new Error("preview_must_not_follow_links");
    },
  };
  const report = await previewLegacyDiagnostics({ diagnosticsDir, fs: metadataOnlyFs });
  const firstStat = await fs.lstat(first);
  const secondStat = await fs.lstat(second);
  const expectedPermissionHistogram = {};
  for (const stat of [firstStat, secondStat]) {
    const key = modeString(stat);
    expectedPermissionHistogram[key] = (expectedPermissionHistogram[key] ?? 0) + 1;
  }
  if (!IS_WINDOWS) assert.equal(report.directoryMode, "0750");
  assert.deepEqual(report.entries, {
    total: IS_WINDOWS ? 3 : 4,
    inspected: IS_WINDOWS ? 3 : 4,
    vanished: 0,
  });
  assert.equal(report.regularFiles.count, 2);
  assert.equal(report.regularFiles.managedV2Count, 0);
  assert.equal(report.regularFiles.legacyOrUnknownCount, 2);
  assert.equal(report.regularFiles.totalBytes, firstStat.size + secondStat.size);
  assert.deepEqual(report.regularFiles.permissionHistogram, expectedPermissionHistogram);
  assert.deepEqual(report.regularFiles.mtimeRange, {
    oldest: firstStat.mtime.toISOString(),
    newest: secondStat.mtime.toISOString(),
  });
  assert.deepEqual(report.specialFiles, {
    count: IS_WINDOWS ? 1 : 2,
    directories: 1,
    symlinks: IS_WINDOWS ? 0 : 1,
    other: 0,
    inaccessible: 0,
  });
  assert.ok(calls.every((call) => call === "readdir" || call === "lstat"));
  assertNoCanaries(report, "legacy preview");
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(diagnosticsDir), false);
  assert.equal(serialized.includes(basename(first)), false);
  assert.equal(serialized.includes(basename(second)), false);
  assert.equal(mode(await fs.lstat(first)), mode(firstStat), "preview 不得 chmod legacy");
  assert.equal(mode(await fs.lstat(second)), mode(secondStat));
  assert.equal((await fs.readFile(first, "utf8")), CANARIES.credential, "preview 不得改写正文");
});

test("maintenance CLI: 默认只有 preview，所有 apply/delete/cleanup/migrate/isolate 请求都拒绝", async (t) => {
  const root = await makeTempDir(t);
  const dataDir = join(root, "data");
  await fs.mkdir(join(dataDir, "diag"), { recursive: true });
  const report = await runDiagnosticsMaintenanceCli(["--data-dir", dataDir]);
  assert.equal(report.mode, "preview_only");
  assert.equal(report.entries.total, 0);

  for (const flag of ["--apply", "--delete", "--clean", "--cleanup", "--migrate", "--isolate"]) {
    await assert.rejects(
      runDiagnosticsMaintenanceCli([flag, "--data-dir", dataDir]),
      (error) => error instanceof DiagnosticsMaintenanceError
        && error.code === "destructive_action_not_implemented"
        && !error.message.includes(dataDir),
      `${flag} 必须拒绝`,
    );
  }
});

test("maintenance preview: 缺失目录返回零值安全摘要，不暴露路径", async (t) => {
  const root = await makeTempDir(t);
  const missing = join(root, CANARIES.path, "missing-diag");
  const report = await previewLegacyDiagnostics({ diagnosticsDir: missing });
  assert.equal(report.entries.total, 0);
  assert.equal(report.regularFiles.totalBytes, 0);
  assertNoCanaries(report, "缺失目录 preview");
  assert.equal(JSON.stringify(report).includes(missing), false);
});
