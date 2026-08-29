import assert from "node:assert/strict";
import test from "node:test";

import {
  createChannelsPageRecoverySupervisor,
  normalizeChannelsPageProbe,
} from "../local-agent/channels-page-recovery.mjs";

async function settle(iterations = 16) {
  for (let index = 0; index < iterations; index += 1) await Promise.resolve();
}

function fakeTimers(startedAt = Date.parse("2026-08-29T15:00:00.000Z")) {
  let nowMs = startedAt;
  let sequence = 0;
  const timers = [];

  function setTimer(callback, milliseconds) {
    const handle = {
      id: ++sequence,
      callback,
      milliseconds,
      dueAt: nowMs + milliseconds,
      cleared: false,
      fired: false,
    };
    timers.push(handle);
    return handle;
  }

  function clearTimer(handle) {
    if (handle) handle.cleared = true;
  }

  async function fireNext() {
    let next = null;
    for (let index = 0; index < 16 && !next; index += 1) {
      await Promise.resolve();
      next = timers
        .filter((timer) => !timer.cleared && !timer.fired)
        .sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0] || null;
    }
    assert.ok(next, "expected a pending fake timer");
    next.fired = true;
    nowMs = Math.max(nowMs, next.dueAt);
    next.callback();
    await settle();
    return next;
  }

  return {
    now: () => nowMs,
    setTimer,
    clearTimer,
    fireNext,
    timers,
    advance(milliseconds) { nowMs += milliseconds; },
    pending() { return timers.filter((timer) => !timer.cleared && !timer.fired); },
  };
}

function build(overrides = {}) {
  const clock = overrides.clock || fakeTimers();
  const supervisor = createChannelsPageRecoverySupervisor({
    probe: async () => ({ online: true, available: false }),
    requestRecovery: async () => ({ ok: true }),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    monitorIntervalMs: 100,
    pollIntervalMs: 10,
    recoveryTimeoutMs: 30,
    cooldownMs: 1_000,
    ...overrides,
    clock: undefined,
  });
  return { clock, supervisor };
}

test("严格规范化页面探测状态，available 不得掩盖引擎离线", () => {
  assert.deepEqual(normalizeChannelsPageProbe({ online: true, available: false }), {
    online: true,
    available: false,
  });
  assert.throws(
    () => normalizeChannelsPageProbe({ online: false, available: true }),
    /channels_page_recovery_probe_invalid/,
  );
  assert.throws(
    () => normalizeChannelsPageProbe({ online: true, available: 1 }),
    /channels_page_recovery_probe_invalid/,
  );
});

test("页面已连接时不请求恢复且不创建轮询 timer", async (t) => {
  let recoveries = 0;
  const { clock, supervisor } = build({
    probe: async () => ({ online: true, available: true }),
    requestRecovery: async () => { recoveries += 1; },
  });
  t.after(() => supervisor.stop());

  assert.deepEqual(await supervisor.tick(), {
    ok: true,
    outcome: "connected",
    state: { online: true, available: true },
    code: "channels_page_available",
  });
  assert.equal(recoveries, 0);
  assert.equal(clock.pending().length, 0);
});

test("offline→online 边沿请求恢复并以随后 available 探测作为唯一成功证据", async (t) => {
  const states = [
    { online: false, available: false },
    { online: true, available: false },
    { online: true, available: true },
  ];
  let probes = 0;
  const requests = [];
  const { clock, supervisor } = build({
    probe: async () => states[Math.min(probes++, states.length - 1)],
    requestRecovery: async (event) => {
      requests.push({ reason: event.reason, state: event.state });
      return { ok: true };
    },
  });
  t.after(() => supervisor.stop());

  assert.deepEqual(await supervisor.tick(), {
    ok: false,
    outcome: "offline",
    state: { online: false, available: false },
    code: "channels_engine_offline",
  });

  const recovering = supervisor.tick({ reason: "engine_restart" });
  await settle();
  assert.deepEqual(requests, [{
    reason: "engine_restart",
    state: { online: true, available: false },
  }]);
  await clock.fireNext();
  assert.deepEqual(await recovering, {
    ok: true,
    outcome: "recovered",
    state: { online: true, available: true },
    code: "channels_page_recovered",
  });
  assert.equal(supervisor.status().lastRecoveredAt, "2026-08-29T15:00:00.010Z");
});

test("恢复动作即使自报成功，20 秒窗口超时也绝不伪报页面已恢复", async (t) => {
  let requests = 0;
  let probes = 0;
  const { clock, supervisor } = build({
    probe: async () => {
      probes += 1;
      return { online: true, available: false };
    },
    requestRecovery: async () => {
      requests += 1;
      return { ok: true, recovered: true };
    },
    pollIntervalMs: 10,
    recoveryTimeoutMs: 20,
  });
  t.after(() => supervisor.stop());

  const recovering = supervisor.tick();
  await settle();
  await clock.fireNext();
  await clock.fireNext();
  assert.deepEqual(await recovering, {
    ok: false,
    outcome: "timeout",
    state: { online: true, available: false },
    code: "channels_page_recovery_timeout",
    action: "requested",
  });
  assert.equal(requests, 1);
  assert.equal(probes, 3, "初始探测加两次有界轮询");
  assert.equal(supervisor.status().ok, false);
});

test("恢复窗口按墙钟计时，慢探针不会在超时后继续追加轮询", async (t) => {
  const clock = fakeTimers();
  let probes = 0;
  const { supervisor } = build({
    clock,
    probe: async () => {
      probes += 1;
      clock.advance(15);
      return { online: true, available: false };
    },
    pollIntervalMs: 10,
    recoveryTimeoutMs: 20,
  });
  t.after(() => supervisor.stop());

  const recovering = supervisor.tick();
  await settle();
  await clock.fireNext();
  assert.equal((await recovering).outcome, "timeout");
  assert.equal(probes, 2, "初始探测后只允许一次跨过截止时刻的在途探测");
  assert.equal(clock.pending().length, 0);
});

test("并发 tick 单飞；超时后冷却，force 与 offline→online 边沿可绕过", async (t) => {
  let state = { online: true, available: false };
  let requests = 0;
  const { clock, supervisor } = build({
    probe: async () => state,
    requestRecovery: async () => { requests += 1; },
    recoveryTimeoutMs: 10,
    pollIntervalMs: 10,
  });
  t.after(() => supervisor.stop());

  const first = supervisor.tick();
  const concurrent = supervisor.tick({ force: true });
  assert.strictEqual(first, concurrent);
  await clock.fireNext();
  assert.equal((await first).outcome, "timeout");
  assert.equal(requests, 1);

  const cooling = await supervisor.tick();
  assert.equal(cooling.outcome, "cooldown");
  assert.equal(cooling.ok, false);
  assert.equal(requests, 1);

  const forced = supervisor.tick({ force: true, reason: "manual_retry" });
  await clock.fireNext();
  assert.equal((await forced).outcome, "timeout");
  assert.equal(requests, 2, "force 仅绕过冷却，不绕过后验验证");

  state = { online: false, available: false };
  assert.equal((await supervisor.tick()).outcome, "offline");
  state = { online: true, available: false };
  const edgeRecovery = supervisor.tick();
  await settle();
  state = { online: true, available: true };
  await clock.fireNext();
  assert.equal((await edgeRecovery).outcome, "recovered");
  assert.equal(requests, 3, "offline→online 边沿在原冷却期内仍发起一次恢复");
});

test("start 使用可注入 timer 周期检查，stop 清除轮询且后续 tick 保持停止", async () => {
  let probes = 0;
  const { clock, supervisor } = build({
    probe: async () => {
      probes += 1;
      return { online: true, available: false };
    },
  });

  assert.equal(supervisor.start(), true);
  assert.equal(supervisor.start(), false);
  assert.equal(clock.pending()[0].milliseconds, 0);
  await clock.fireNext();
  assert.equal(probes, 1);

  const pendingPoll = clock.pending()[0];
  assert.equal(pendingPoll.milliseconds, 10);
  await supervisor.stop();
  assert.equal(pendingPoll.cleared, true);
  assert.equal(clock.pending().length, 0);
  assert.equal(supervisor.status().stopped, true);
  assert.deepEqual(await supervisor.tick(), {
    ok: false,
    outcome: "stopped",
    state: { online: true, available: false },
    code: "stopped",
  });
});
