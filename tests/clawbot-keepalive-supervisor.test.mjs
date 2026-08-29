import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import {
  clawbotKeepaliveSuccessCode,
  createClawbotKeepaliveSupervisor,
} from "../local-agent/clawbot-keepalive-supervisor.mjs";

async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), "zhitai-clawbot-keepalive-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, statePath: join(root, "private", "keepalive.json") };
}

async function waitFor(predicate, { timeoutMs = 500, intervalMs = 5 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(intervalMs);
  }
  throw new Error("wait_for_timeout");
}

function requiredState() {
  return { clawbot: { deliveryState: "session_refresh_required" } };
}

function build(statePath, overrides = {}) {
  return createClawbotKeepaliveSupervisor({
    statePath,
    getNotificationState: async () => requiredState(),
    runKeepalive: async () => JSON.stringify({ ok: true, code: clawbotKeepaliveSuccessCode }),
    verifyContextRefresh: async () => ({ contextUpdatedAt: "2026-08-29T03:00:01.000Z" }),
    notifyFallback: async () => {},
    now: () => new Date("2026-08-29T03:00:00.000Z"),
    cooldownMs: 1_000,
    transientCooldownMs: 1_000,
    successCooldownMs: 1_000,
    attemptWindowMs: 10_000,
    maxAttempts: 3,
    ...overrides,
  });
}

test("仅在嵌套 ClawBot 状态明确要求刷新时触发，且并发 tick 单飞", async (t) => {
  const { statePath } = await sandbox(t);
  let state = { deliveryState: "session_refresh_required" };
  let runs = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const supervisor = build(statePath, {
    getNotificationState: async () => state,
    runKeepalive: async () => {
      runs += 1;
      await gate;
      return { ok: true, code: "keepalive_sent" };
    },
  });
  t.after(() => supervisor.stop());

  assert.deepEqual(await supervisor.tick(), {
    outcome: "not_triggered",
    code: "session_refresh_not_required",
  });
  state = { clawbot: { deliveryState: "ready" } };
  assert.equal((await supervisor.tick()).outcome, "not_triggered");
  assert.equal(runs, 0);

  state = requiredState();
  const first = supervisor.tick();
  const second = supervisor.tick();
  assert.strictEqual(first, second);
  await waitFor(() => runs === 1);
  assert.equal(runs, 1);
  release();
  assert.deepEqual(await first, { outcome: "recovered", code: "context_refreshed" });
  assert.equal(runs, 1);
});

test("ClawBot 已就绪时仅对超过可注入阈值的会话主动保活", async (t) => {
  const { statePath } = await sandbox(t);
  const now = Date.parse("2026-08-29T09:00:00.000Z");
  let contextUpdatedAt = "2026-08-29T08:00:00.000Z";
  let operational = true;
  let runs = 0;
  const supervisor = build(statePath, {
    getNotificationState: async () => ({
      clawbot: {
        deliveryState: "ready",
        ready: operational,
        operational,
        contextUpdatedAt,
      },
    }),
    runKeepalive: async () => {
      runs += 1;
      return { ok: true, code: "keepalive_sent" };
    },
    verifyContextRefresh: async () => ({ contextUpdatedAt: "2026-08-29T09:00:01.000Z" }),
    now: () => new Date(now),
    proactiveAfterMs: 2 * 60 * 60_000,
  });
  t.after(() => supervisor.stop());

  assert.deepEqual(await supervisor.tick(), { outcome: "not_triggered", code: "context_recent" });
  assert.equal(runs, 0);

  contextUpdatedAt = "2026-08-29T06:59:59.999Z";
  assert.deepEqual(await supervisor.tick(), { outcome: "recovered", code: "context_refreshed" });
  assert.equal(runs, 1);

  operational = false;
  assert.equal((await supervisor.tick()).outcome, "not_triggered");
  assert.equal(runs, 1);
});

test("run 返回 send_uncertain 时先回读会话，已刷新则记为恢复", async (t) => {
  const { statePath } = await sandbox(t);
  const fallbacks = [];
  const verificationStarts = [];
  const supervisor = build(statePath, {
    runKeepalive: async () => ({ ok: false, code: "send_uncertain" }),
    verifyContextRefresh: async (startedAt) => {
      verificationStarts.push(startedAt);
      return { contextUpdatedAt: "2026-08-29T03:00:01.000Z" };
    },
    notifyFallback: async (code) => { fallbacks.push(code); },
  });
  t.after(() => supervisor.stop());

  assert.deepEqual(await supervisor.tick(), { outcome: "recovered", code: "context_refreshed" });
  assert.deepEqual(verificationStarts, ["2026-08-29T03:00:00.000Z"]);
  assert.deepEqual(fallbacks, []);
  assert.equal((await supervisor.status()).lastFailureCode, null);
});

function interruptedState(lastAttemptAt = "2026-08-29T03:00:00.000Z") {
  return {
    version: 1,
    incidentActive: true,
    windowStartedAt: lastAttemptAt,
    attemptCount: 1,
    cooldownUntil: null,
    notifiedFailureCodes: [],
    lastOutcome: "attempting",
    lastAttemptAt,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureCode: null,
    lastContextUpdatedAt: null,
    updatedAt: lastAttemptAt,
  };
}

test("进程重启发现 attempting 时只回读上次尝试，已刷新则不重发", async (t) => {
  const { root, statePath } = await sandbox(t);
  await mkdir(join(root, "private"), { recursive: true, mode: 0o700 });
  await writeFile(statePath, JSON.stringify(interruptedState()), { mode: 0o600 });
  let runs = 0;
  const supervisor = build(statePath, {
    runKeepalive: async () => { runs += 1; return { ok: true, code: "keepalive_sent" }; },
    verifyContextRefresh: async (startedAt) => {
      assert.equal(startedAt, "2026-08-29T03:00:00.000Z");
      return { contextUpdatedAt: "2026-08-29T03:00:01.000Z" };
    },
  });
  t.after(() => supervisor.stop());

  assert.deepEqual(await supervisor.tick(), { outcome: "recovered", code: "context_refreshed" });
  assert.equal(runs, 0);
  assert.equal((await supervisor.status()).lastOutcome, "recovered");
});

test("进程重启发现未确定 attempting 时记 send_uncertain 并进入冷却，绝不重发", async (t) => {
  const { root, statePath } = await sandbox(t);
  await mkdir(join(root, "private"), { recursive: true, mode: 0o700 });
  await writeFile(statePath, JSON.stringify(interruptedState()), { mode: 0o600 });
  let runs = 0;
  let clockMs = Date.parse("2026-08-29T03:00:00.000Z");
  const fallbacks = [];
  const supervisor = build(statePath, {
    runKeepalive: async () => { runs += 1; return { ok: true, code: "keepalive_sent" }; },
    verifyContextRefresh: async () => ({ contextUpdatedAt: null }),
    notifyFallback: async (code) => { fallbacks.push(code); },
    now: () => new Date(clockMs),
  });
  t.after(() => supervisor.stop());

  assert.deepEqual(await supervisor.tick(), {
    outcome: "needs_user",
    code: "send_uncertain",
    terminal: true,
    needs_user: true,
    reason: "send_uncertain",
    retryAt: null,
  });
  assert.equal(runs, 0);
  assert.deepEqual(fallbacks, ["send_uncertain"]);
  const status = await supervisor.status();
  assert.equal(status.lastOutcome, "needs_user");
  assert.equal(status.lastFailureCode, "send_uncertain");
  assert.equal(status.cooldownUntil, null);
  assert.equal(status.terminal, true);
  assert.equal(status.needsUser, true);
  assert.equal(status.terminalReason, "send_uncertain");

  assert.deepEqual(await supervisor.tick(), {
    outcome: "needs_user",
    code: "send_uncertain",
    terminal: true,
    needs_user: true,
    reason: "send_uncertain",
    retryAt: null,
  });
  assert.equal(runs, 0);
  clockMs += 1_001;
  assert.deepEqual(await supervisor.tick(), {
    outcome: "needs_user",
    code: "send_uncertain",
    terminal: true,
    needs_user: true,
    reason: "send_uncertain",
    retryAt: null,
  });
  assert.equal(runs, 0, "冷却到期也不得重发未确定的外部消息");
});

test("已提交但 context 未刷新的保活不会在冷却后自动重发", async (t) => {
  const { statePath } = await sandbox(t);
  let clockMs = Date.parse("2026-08-29T03:00:00.000Z");
  let runs = 0;
  const fallbacks = [];
  const supervisor = build(statePath, {
    runKeepalive: async () => { runs += 1; return { ok: true, code: "keepalive_sent" }; },
    verifyContextRefresh: async () => ({ contextUpdatedAt: null }),
    notifyFallback: async (code) => { fallbacks.push(code); },
    now: () => new Date(clockMs),
    cooldownMs: 10,
  });
  t.after(() => supervisor.stop());

  assert.deepEqual(await supervisor.tick(), {
    outcome: "needs_user",
    code: "context_not_refreshed",
    terminal: true,
    needs_user: true,
    reason: "context_not_refreshed",
    retryAt: null,
  });
  assert.equal(runs, 1);
  clockMs += 11;
  assert.deepEqual(await supervisor.tick(), {
    outcome: "needs_user",
    code: "context_not_refreshed",
    terminal: true,
    needs_user: true,
    reason: "context_not_refreshed",
    retryAt: null,
  });
  assert.equal(runs, 1);
  assert.deepEqual(fallbacks, ["context_not_refreshed"]);
});

test("runner terminal/needs_user 持久后跨冷却与重启都不再调用控制软件", async (t) => {
  const { statePath } = await sandbox(t);
  let clockMs = Date.parse("2026-08-29T03:00:00.000Z");
  let runs = 0;
  const options = {
    runKeepalive: async () => {
      runs += 1;
      return {
        ok: false,
        code: "state_changed",
        terminal: true,
        needs_user: true,
        reason: "draft_present",
      };
    },
    now: () => new Date(clockMs),
    cooldownMs: 10,
  };
  const first = build(statePath, options);

  assert.deepEqual(await first.tick(), {
    outcome: "needs_user",
    code: "state_changed",
    terminal: true,
    needs_user: true,
    reason: "draft_present",
    retryAt: null,
  });
  assert.equal(runs, 1);
  clockMs += 60_000;
  assert.equal((await first.tick()).outcome, "needs_user");
  assert.equal(runs, 1);
  await first.stop();

  const restarted = build(statePath, options);
  t.after(() => restarted.stop());
  assert.equal((await restarted.tick()).outcome, "needs_user");
  assert.equal(runs, 1);
  const status = await restarted.status();
  assert.equal(status.terminal, true);
  assert.equal(status.needsUser, true);
  assert.equal(status.terminalReason, "draft_present");
});

test("只接受明确 JSON 成功码，并要求 contextUpdatedAt 严格晚于 startedAt", async (t) => {
  const { statePath } = await sandbox(t);
  const fallbacks = [];
  let output = JSON.stringify({ ok: true, code: "done", serial: "sensitive-device" });
  let contextUpdatedAt = "2026-08-29T03:00:01.000Z";
  let clockMs = Date.parse("2026-08-29T03:00:00.000Z");
  let notificationState = requiredState();
  const supervisor = build(statePath, {
    getNotificationState: async () => notificationState,
    runKeepalive: async () => output,
    verifyContextRefresh: async () => ({ contextUpdatedAt }),
    notifyFallback: async (code) => { fallbacks.push(code); },
    now: () => new Date(clockMs),
    cooldownMs: 1,
  });
  t.after(() => supervisor.stop());

  assert.equal((await supervisor.tick()).code, "invalid_response");
  clockMs += 2;
  notificationState = {
    clawbot: {
      deliveryState: "ready",
      ready: true,
      operational: true,
      contextUpdatedAt: new Date(clockMs).toISOString(),
    },
  };
  assert.deepEqual(await supervisor.tick(), { outcome: "not_triggered", code: "context_recent" });
  notificationState = requiredState();
  output = JSON.stringify({ ok: true, code: "keepalive_sent" });
  contextUpdatedAt = new Date(clockMs).toISOString();
  assert.equal((await supervisor.tick()).code, "context_not_refreshed");
  assert.deepEqual(fallbacks, ["invalid_response", "context_not_refreshed"]);

  notificationState = {
    clawbot: {
      deliveryState: "ready",
      ready: true,
      operational: true,
      contextUpdatedAt: new Date(clockMs).toISOString(),
    },
  };
  assert.deepEqual(await supervisor.tick(), { outcome: "not_triggered", code: "context_recent" });
  notificationState = requiredState();
  clockMs += 2;
  contextUpdatedAt = new Date(clockMs + 1).toISOString();
  assert.deepEqual(await supervisor.tick(), { outcome: "recovered", code: "context_refreshed" });
  const status = await supervisor.status();
  assert.equal(status.lastContextUpdatedAt, contextUpdatedAt);
  assert.equal(status.lastFailureCode, null);
});

test("固定错误码 fallback 按同一事件中的错误码去重，原始输出不落盘", async (t) => {
  const { statePath } = await sandbox(t);
  let clockMs = Date.parse("2026-08-29T03:00:00.000Z");
  const sensitive = "serial-123 chat-body 13800138000 raw-command-output";
  const fallbacks = [];
  let output = JSON.stringify({ ok: false, code: "device_locked", detail: sensitive });
  const supervisor = build(statePath, {
    runKeepalive: async () => output,
    notifyFallback: async (code) => { fallbacks.push(code); },
    now: () => new Date(clockMs),
    cooldownMs: 1,
    attemptWindowMs: 1_000,
  });
  t.after(() => supervisor.stop());

  assert.deepEqual(await supervisor.tick(), { outcome: "failed", code: "device_locked" });
  clockMs += 2;
  assert.deepEqual(await supervisor.tick(), { outcome: "failed", code: "device_locked" });
  clockMs += 2;
  output = JSON.stringify({ ok: false, code: "unknown_failure", detail: sensitive });
  assert.equal((await supervisor.tick()).code, "invalid_response");
  assert.deepEqual(fallbacks, ["device_locked", "invalid_response"]);

  const disk = await readFile(statePath, "utf8");
  assert.equal(disk.includes(sensitive), false);
  assert.equal(disk.includes("serial-123"), false);
  assert.equal(disk.includes("13800138000"), false);
  assert.equal((await stat(join(statePath, ".."))).mode & 0o777, 0o700);
  assert.equal((await stat(statePath)).mode & 0o777, 0o600);
});

test("持久冷却与窗口次数上限跨 supervisor 实例生效", async (t) => {
  const { statePath } = await sandbox(t);
  let clockMs = Date.parse("2026-08-29T03:00:00.000Z");
  let runs = 0;
  const options = {
    runKeepalive: async () => {
      runs += 1;
      return { ok: false, code: "timeout" };
    },
    now: () => new Date(clockMs),
    cooldownMs: 100,
    attemptWindowMs: 10_000,
    maxAttempts: 2,
  };

  const first = build(statePath, options);
  assert.equal((await first.tick()).code, "timeout");
  await first.stop();

  const second = build(statePath, options);
  t.after(() => second.stop());
  assert.deepEqual(await second.tick(), {
    outcome: "cooldown",
    code: "cooldown",
    retryAt: "2026-08-29T03:00:00.100Z",
  });
  assert.equal(runs, 1);

  clockMs += 101;
  assert.equal((await second.tick()).code, "timeout");
  assert.equal(runs, 2);
  clockMs += 101;
  assert.deepEqual(await second.tick(), {
    outcome: "attempt_limit",
    code: "attempt_limit",
    retryAt: null,
  });
  assert.equal(runs, 2);
  assert.equal((await second.status()).attemptCount, 2);
});

test("扫码等明确未发送状态持续重试但不耗尽可能外发次数上限", async (t) => {
  const { statePath } = await sandbox(t);
  let clockMs = Date.parse("2026-08-29T03:00:00.000Z");
  let runs = 0;
  const supervisor = build(statePath, {
    runKeepalive: async () => {
      runs += 1;
      return { ok: false, code: "auth_required" };
    },
    now: () => new Date(clockMs),
    cooldownMs: 10,
    transientCooldownMs: 10,
    attemptWindowMs: 1_000,
    maxAttempts: 1,
  });
  t.after(() => supervisor.stop());

  assert.equal((await supervisor.tick()).code, "auth_required");
  assert.equal((await supervisor.status()).attemptCount, 0);
  clockMs += 11;
  assert.equal((await supervisor.tick()).code, "auth_required");
  assert.equal(runs, 2);
  assert.equal((await supervisor.status()).attemptCount, 0);
});

test("Cua 瞬态只读故障使用短冷却并收敛旧版本的长冷却", async (t) => {
  const { statePath } = await sandbox(t);
  let clockMs = Date.parse("2026-08-29T03:00:00.000Z");
  let runs = 0;
  const supervisor = build(statePath, {
    runKeepalive: async () => {
      runs += 1;
      return { ok: false, code: "driver_unavailable" };
    },
    now: () => new Date(clockMs),
    cooldownMs: 30_000,
    transientCooldownMs: 5_000,
  });
  t.after(() => supervisor.stop());

  assert.deepEqual(await supervisor.tick(), { outcome: "failed", code: "driver_unavailable" });
  assert.equal((await supervisor.status()).cooldownUntil, "2026-08-29T03:00:05.000Z");
  clockMs += 4_999;
  assert.equal((await supervisor.tick()).code, "cooldown");
  clockMs += 2;
  assert.equal((await supervisor.tick()).code, "driver_unavailable");
  assert.equal(runs, 2);
});

test("损坏或含未知字段的状态文件 fail-closed，绝不调用控制软件", async (t) => {
  const { root, statePath } = await sandbox(t);
  await mkdir(join(root, "private"), { recursive: true, mode: 0o700 });
  await writeFile(statePath, JSON.stringify({
    version: 1,
    incidentActive: true,
    windowStartedAt: null,
    attemptCount: 0,
    cooldownUntil: null,
    notifiedFailureCodes: [],
    lastOutcome: "idle",
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureCode: null,
    lastContextUpdatedAt: null,
    updatedAt: null,
    deviceSerial: "must-not-be-accepted",
  }), { mode: 0o600 });
  let runs = 0;
  const fallbacks = [];
  const supervisor = build(statePath, {
    runKeepalive: async () => { runs += 1; return { ok: true, code: "keepalive_sent" }; },
    notifyFallback: async (code) => { fallbacks.push(code); },
  });
  t.after(() => supervisor.stop());
  assert.deepEqual(await supervisor.tick(), { outcome: "not_triggered", code: "state_unavailable" });
  assert.deepEqual(await supervisor.tick(), { outcome: "not_triggered", code: "state_unavailable" });
  assert.equal(runs, 0);
  assert.deepEqual(fallbacks, ["state_unavailable"]);
  assert.equal((await supervisor.status()).stateAvailable, false);
  assert.equal((await stat(join(root, "private"))).mode & 0o777, 0o700);
});

test("外部动作后状态落盘失败会锁住当前进程，不再自动发送", async (t) => {
  const { statePath } = await sandbox(t);
  let runs = 0;
  const fallbacks = [];
  const supervisor = build(statePath, {
    runKeepalive: async () => {
      runs += 1;
      // Reservation is already durable. Replace only this test's state file
      // with a directory so the post-send atomic rename fails deterministically.
      await rm(statePath, { force: true });
      await mkdir(statePath);
      return { ok: true, code: "keepalive_sent" };
    },
    notifyFallback: async (code) => { fallbacks.push(code); },
  });
  t.after(() => supervisor.stop());

  assert.deepEqual(await supervisor.tick(), { outcome: "failed", code: "state_unavailable" });
  assert.equal(runs, 1);
  assert.deepEqual(fallbacks, ["state_unavailable"]);
  assert.deepEqual(await supervisor.tick(), { outcome: "not_triggered", code: "state_unavailable" });
  assert.equal(runs, 1);
  assert.deepEqual(fallbacks, ["state_unavailable"]);
});

test("通知状态不可读时发送低基数 fallback，并且并发 tick 不重复通知", async (t) => {
  const { statePath } = await sandbox(t);
  const fallbacks = [];
  let releases;
  const gate = new Promise((resolve) => { releases = resolve; });
  const supervisor = build(statePath, {
    getNotificationState: async () => { throw new Error("sensitive raw failure"); },
    notifyFallback: async (code) => {
      fallbacks.push(code);
      await gate;
    },
  });
  t.after(() => supervisor.stop());

  const first = supervisor.tick();
  const second = supervisor.tick();
  assert.strictEqual(first, second);
  await waitFor(() => fallbacks.length === 1);
  assert.deepEqual(fallbacks, ["notification_state_unavailable"]);
  releases();
  assert.deepEqual(await first, {
    outcome: "not_triggered",
    code: "notification_state_unavailable",
  });
  assert.deepEqual((await supervisor.status()).notifiedFailureCodes, ["notification_state_unavailable"]);
});

test("fallback 成功后才持久已通知标记，失败不会造成永久漏通知", async (t) => {
  const { statePath } = await sandbox(t);
  let calls = 0;
  let markedDuringFallback = null;
  const supervisor = build(statePath, {
    runKeepalive: async () => ({ ok: false, code: "device_locked" }),
    cooldownMs: 1,
    now: (() => {
      let time = Date.parse("2026-08-29T03:00:00.000Z");
      return () => new Date(time += 2);
    })(),
    notifyFallback: async () => {
      calls += 1;
      const disk = JSON.parse(await readFile(statePath, "utf8"));
      markedDuringFallback = disk.notifiedFailureCodes.includes("device_locked");
      if (calls === 1) throw new Error("temporary fallback outage");
    },
  });
  t.after(() => supervisor.stop());

  assert.equal((await supervisor.tick()).code, "device_locked");
  assert.equal(markedDuringFallback, false);
  assert.deepEqual((await supervisor.status()).notifiedFailureCodes, []);
  assert.equal((await supervisor.tick()).code, "device_locked");
  assert.equal(calls, 2);
  assert.deepEqual((await supervisor.status()).notifiedFailureCodes, ["device_locked"]);
});

test("start 周期运行，stop 清理定时器并阻止后续 tick", async (t) => {
  const { statePath } = await sandbox(t);
  const callbacks = [];
  const cleared = [];
  let checks = 0;
  const supervisor = build(statePath, {
    getNotificationState: async () => {
      checks += 1;
      return { clawbot: { deliveryState: "ready" } };
    },
    setTimer: (callback, milliseconds) => {
      const handle = { callback, milliseconds };
      callbacks.push(handle);
      return handle;
    },
    clearTimer: (handle) => { cleared.push(handle); },
    intervalMs: 123,
  });

  assert.equal(supervisor.start(), true);
  assert.equal(supervisor.start(), false);
  assert.equal(callbacks[0].milliseconds, 0);
  callbacks[0].callback();
  await delay(10);
  assert.equal(checks, 1);
  assert.equal(callbacks[1].milliseconds, 123);
  await supervisor.stop();
  assert.equal(cleared.includes(callbacks[1]), true);
  assert.deepEqual(await supervisor.tick(), { outcome: "stopped", code: "stopped" });
});
