import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  createPublisherLoginRecovery,
  publisherLoginAccountFingerprint,
} from "../local-agent/publisher-login-recovery.mjs";

function qrPng(width = 320, height = 320, marker = 1) {
  const png = Buffer.alloc(32, marker);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.write("IHDR", 12, "ascii");
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  return png;
}

async function waitFor(predicate, { timeoutMs = 500, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await delay(intervalMs);
  }
  throw new Error("wait_for_timeout");
}

async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "zhitai-login-recovery-"));
  return { root, statePath: join(root, "private", "publisher-login-recovery.json") };
}

function cleanupSandbox(t, root) {
  // node:test runs after hooks in registration order. Register filesystem
  // cleanup after recovery.stop(), otherwise an in-flight atomic rename can
  // race recursive removal and make an otherwise passing test flaky.
  t.after(() => rm(root, { recursive: true, force: true }));
}

test("只恢复 dy/sph 的 invalid/unverified 合法手机号账号，且并发协调保持单飞", async (t) => {
  const { root, statePath } = await sandbox();
  const starts = [];
  const recovery = createPublisherLoginRecovery({
    statePath,
    startLogin: async ({ platform, phone }) => {
      starts.push({ platform, phone });
      await delay(10);
      return { id: `${platform}-session`, status: "waiting_scan", phone };
    },
    getLogin: async () => ({ status: "waiting_scan" }),
    deliverQr: async () => {},
    pollIntervalMs: 50,
  });
  t.after(() => recovery.stop());
  cleanupSandbox(t, root);

  const rows = [
    { platform: "抖音", phone: "13800138000", authState: "invalid" },
    { platform: "dy", phone: "13800138000", authState: "unverified" },
    { platform: "视频号", phone: "13900139000", authState: "unverified" },
    { platform: "sph", phone: "not-a-phone", authState: "invalid" },
    { platform: "xhs", phone: "13700137000", authState: "invalid" },
    { platform: "dy", phone: "13600136000", authState: "verified" },
  ];
  const [first, second] = await Promise.all([
    recovery.reconcileAccounts(rows),
    recovery.reconcileAccounts(rows),
  ]);

  assert.equal(starts.length, 2);
  assert.deepEqual(new Set(starts.map((item) => item.platform)), new Set(["dy", "sph"]));
  assert.equal(starts.filter((item) => item.phone === "13800138000").length, 1);
  assert.equal(first.candidates, 2);
  assert.equal(second.candidates, 2);
  assert.equal(JSON.stringify([first, second]).includes("13800138000"), false, "协调结果不得返回手机号");
});

test("仅交付有效近方形 PNG，同一二维码 hash 在账号和重启之间只交付一次", async (t) => {
  const { root, statePath } = await sandbox();
  const png = qrPng();
  const delivered = [];
  let sessionCounter = 0;
  const build = () => createPublisherLoginRecovery({
    statePath,
    startLogin: async () => ({ id: `session-${++sessionCounter}`, status: "waiting_scan" }),
    getLogin: async () => ({ status: "waiting_scan", qrData: `data:image/png;base64,${png.toString("base64")}` }),
    deliverQr: async (event) => {
      delivered.push({ ...event, png: Buffer.from(event.png) });
      return { ok: true };
    },
    pollIntervalMs: 5,
  });

  const first = build();
  await first.reconcileAccounts([
    { platform: "dy", phone: "13800138000", authState: "invalid" },
    { platform: "sph", phone: "13900139000", authState: "unverified" },
  ]);
  await waitFor(() => delivered.length === 1);
  await delay(20);
  await first.stop();
  assert.equal(delivered.length, 1, "轮询和另一账号不得重复交付同一 hash");
  assert.equal(delivered[0].png.subarray(0, 8).equals(png.subarray(0, 8)), true);
  assert.match(delivered[0].qrHash, /^[a-f0-9]{64}$/);
  assert.match(delivered[0].accountFingerprint, /^login_[a-f0-9]{32}$/);

  const second = build();
  t.after(() => second.stop());
  cleanupSandbox(t, root);
  await second.reconcileAccounts([{ platform: "dy", phone: "13800138000", authState: "invalid" }]);
  await delay(25);
  assert.equal(delivered.length, 1, "进程重启后持久 hash 仍应去重");

  const disk = await readFile(statePath, "utf8");
  assert.equal(disk.includes("13800138000"), false);
  assert.equal(disk.includes("13900139000"), false);
  assert.equal(disk.includes("data:image"), false);
  assert.equal(disk.includes(png.toString("base64")), false);
  assert.equal(disk.toLowerCase().includes("qrpath"), false);
  assert.equal((await stat(join(root, "private"))).mode & 0o777, 0o700);
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
});

test("整页截图和非 PNG 不会交给发送层", async (t) => {
  const { root, statePath } = await sandbox();
  let polls = 0;
  let deliveries = 0;
  const recovery = createPublisherLoginRecovery({
    statePath,
    startLogin: async () => ({ id: "session-page", status: "waiting_scan" }),
    getLogin: async () => ({
      status: "waiting_scan",
      qrData: polls++ === 0
        ? `data:image/png;base64,${qrPng(1200, 772).toString("base64")}`
        : "data:image/png;base64,bm90LXBuZw==",
    }),
    deliverQr: async () => { deliveries += 1; },
    pollIntervalMs: 5,
  });
  t.after(() => recovery.stop());
  cleanupSandbox(t, root);
  await recovery.reconcileAccounts([{ platform: "sph", phone: "13800138000", authState: "invalid" }]);
  await waitFor(() => polls >= 3);
  assert.equal(deliveries, 0);
});

test("ClawBot 安全通道失败时不把二维码误记为已送达，恢复后重试同一张", async (t) => {
  const { root, statePath } = await sandbox();
  const png = qrPng();
  let attempts = 0;
  const recovery = createPublisherLoginRecovery({
    statePath,
    startLogin: async () => ({ id: "session-retry", status: "waiting_scan" }),
    getLogin: async () => ({ status: "waiting_scan", png }),
    deliverQr: async () => ({ ok: ++attempts >= 2 }),
    pollIntervalMs: 5,
    deliveryRetryMs: 10,
  });
  t.after(() => recovery.stop());
  cleanupSandbox(t, root);
  await recovery.reconcileAccounts([{ platform: "dy", phone: "13800138000", authState: "invalid" }]);
  await waitFor(() => attempts >= 2);
  assert.equal(attempts, 2);
  const persisted = await waitFor(async () => {
    const value = JSON.parse(await readFile(statePath, "utf8"));
    return value.deliveredQrHashes.length === 1 ? value : null;
  });
  assert.equal(persisted.deliveredQrHashes.length, 1);
});

test("登录成功停止轮询并仅以匿名账号回调 recovered", async (t) => {
  const { root, statePath } = await sandbox();
  let polls = 0;
  const recoveries = [];
  const recovery = createPublisherLoginRecovery({
    statePath,
    startLogin: async () => ({ id: "success-session", status: "waiting_scan", phone: "13800138000" }),
    getLogin: async () => ({ status: ++polls >= 2 ? "success" : "waiting_scan" }),
    deliverQr: async () => {},
    recovered: async (event) => { recoveries.push(event); },
    pollIntervalMs: 5,
  });
  t.after(() => recovery.stop());
  cleanupSandbox(t, root);
  await recovery.reconcileAccounts([{ platform: "dy", phone: "13800138000", authState: "invalid" }]);
  await waitFor(() => recoveries.length === 1);
  const afterSuccess = polls;
  await delay(20);
  assert.equal(polls, afterSuccess);
  assert.deepEqual(recoveries, [{
    platform: "dy",
    accountFingerprint: publisherLoginAccountFingerprint("dy", "13800138000"),
    sessionId: "success-session",
  }]);
  assert.equal(JSON.stringify(recoveries).includes("13800138000"), false);
  assert.equal((await recovery.status()).records[0].sessionStatus, "recovered");
});

test("expired/failed 使用有界指数退避且不超过每日尝试上限", async (t) => {
  const { root, statePath } = await sandbox();
  let starts = 0;
  const delays = [];
  const recovery = createPublisherLoginRecovery({
    statePath,
    startLogin: async () => ({ id: `failed-${++starts}`, status: "waiting_scan" }),
    getLogin: async () => ({ status: starts % 2 ? "expired" : "failed" }),
    deliverQr: async () => {},
    setTimer: (callback, milliseconds) => {
      delays.push(milliseconds);
      const handle = setTimeout(callback, milliseconds);
      handle.unref?.();
      return handle;
    },
    pollIntervalMs: 2,
    retryBaseMs: 4,
    retryMaxMs: 8,
    maxAttemptsPerDay: 3,
  });
  t.after(() => recovery.stop());
  cleanupSandbox(t, root);
  await recovery.reconcileAccounts([{ platform: "sph", phone: "13800138000", authState: "invalid" }]);
  await waitFor(() => starts === 3);
  await delay(25);
  assert.equal(starts, 3);
  assert.ok(delays.includes(4));
  assert.ok(delays.includes(8));
  const [record] = (await recovery.status()).records;
  assert.equal(record.attemptCount, 3);
  assert.equal(record.sessionStatus, "daily_limit");
});

test("stop 清除轮询和重试 timer，后续协调不再启动登录", async (t) => {
  const { root, statePath } = await sandbox();
  cleanupSandbox(t, root);
  let starts = 0;
  let polls = 0;
  const recovery = createPublisherLoginRecovery({
    statePath,
    startLogin: async () => ({ id: `session-${++starts}`, status: "waiting_scan" }),
    getLogin: async () => { polls += 1; return { status: "waiting_scan" }; },
    deliverQr: async () => {},
    pollIntervalMs: 5,
  });
  await recovery.reconcileAccounts([{ platform: "dy", phone: "13800138000", authState: "unverified" }]);
  await waitFor(() => polls >= 1);
  await recovery.stop();
  const stoppedAt = polls;
  await delay(25);
  const result = await recovery.reconcileAccounts([{ platform: "dy", phone: "13800138000", authState: "invalid" }]);
  assert.equal(polls, stoppedAt);
  assert.equal(starts, 1);
  assert.deepEqual(result, { candidates: 0, started: 0, active: 0 });
});
