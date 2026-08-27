import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

import { NotificationCenter } from "../local-agent/notification-center.mjs";

test("notification center creates a private-looking topic and records accepted test push", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "zhitai-notify-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => { calls.push({ url: String(url), options }); return new Response("{}", { status: 200 }); };
  t.after(() => { globalThis.fetch = originalFetch; });

  const center = new NotificationCenter({ dataDir, buildDigest: async () => "摘要" });
  await center.init();
  const created = await center.createSubscription();
  assert.equal(created.ready, false);
  assert.equal(created.settings.ntfy.configured, true);
  assert.equal(created.settings.ntfy.deliveryState, "unverified");
  assert.match(created.settings.ntfy.topic, /^zhitai-[A-Za-z0-9_-]{20,}$/);
  const result = await center.test();
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Title, encodeURIComponent("织台手机通知测试"));
  assert.equal(calls[0].options.redirect, "error");
  const state = await center.publicState();
  assert.equal(state.ready, true);
  assert.equal(state.settings.ntfy.operational, true);
  assert.equal(state.deliveries[0].status, "accepted");
});

test("notification center prefers ClawBot and enables download alerts by default", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "zhitai-notify-clawbot-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const calls = [];
  const clawbot = {
    status: async () => ({ ready: true, pairedCount: 1, reason: null }),
    send: async (title, message) => { calls.push({ title, message }); return { ok: true, accepted: 1 }; },
  };
  const center = new NotificationCenter({ dataDir, buildDigest: async () => "摘要", clawbot });
  await center.init();
  const state = await center.publicState();
  assert.equal(state.clawbot.paired, true);
  assert.equal(state.clawbot.ready, false);
  assert.equal(state.clawbot.deliveryState, "unverified");
  assert.equal(state.settings.events.downloadFailure, true);
  assert.equal(state.settings.events.filehelperOffline, true);
  const result = await center.notifyEvent("FILEHELPER_LOGIN", "网页在线，但微信未登录");
  assert.equal(result.ok, true);
  assert.equal(result.channel, "clawbot");
  assert.equal((await center.publicState()).clawbot.ready, true);
  assert.deepEqual(calls, [{ title: "织台 · 文件传输助手需处理", message: "网页在线，但微信未登录" }]);
});

test("notification center falls back to ntfy and exposes recent ClawBot delivery health", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "zhitai-notify-fallback-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("{}", { status: 200 });
  t.after(() => { globalThis.fetch = originalFetch; });
  const clawbot = {
    status: async () => ({ ready: true, pairedCount: 1, reason: null }),
    send: async () => ({ ok: false, error: "sendMessage ret=-2 errmsg=prepare failed" }),
  };
  const center = new NotificationCenter({ dataDir, buildDigest: async () => "摘要", clawbot });
  await center.init();
  await center.createSubscription();

  const result = await center.send("标题", "正文", "fallback");
  assert.equal(result.ok, true);
  assert.equal(result.channel, "ntfy");
  assert.equal((await center.outbox()).length, 0);
  const state = await center.publicState();
  assert.equal(state.clawbot.paired, true);
  assert.equal(state.clawbot.ready, false);
  assert.equal(state.clawbot.operational, false);
  assert.equal(state.clawbot.deliveryState, "session_refresh_required");
  assert.equal(Boolean(state.clawbot.cooldownUntil), true);
  assert.equal(state.clawbot.lastDelivery.error, "sendMessage ret=-2 errmsg=prepare failed");
  assert.deepEqual(state.deliveries.slice(0, 2).map((item) => [item.channel, item.status]), [
    ["ntfy", "accepted"],
    ["clawbot", "failed"],
  ]);
});

test("notification center persists, deduplicates, and retries failed notifications across restart", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "zhitai-notify-outbox-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let now = new Date("2026-08-27T00:00:00.000Z");
  let failedCalls = 0;
  const failingClawbot = {
    status: async () => ({ ready: true, pairedCount: 1, reason: null }),
    send: async () => { failedCalls += 1; return { ok: false, error: "sendMessage ret=-2 errmsg=prepare failed" }; },
  };
  const first = new NotificationCenter({
    dataDir,
    buildDigest: async () => "摘要",
    clawbot: failingClawbot,
    now: () => now,
    retryDelaysMs: [1_000],
    sessionRetryDelaysMs: [1_000],
  });
  await first.init();
  const results = await Promise.all(Array.from({ length: 8 }, () => first.send("同一标题", "同一正文", "same")));
  assert.equal(results[0].queued, true);
  assert.equal(results.slice(1).every((item) => item.deduplicated === true), true);
  assert.equal(failedCalls, 1);
  assert.equal((await first.outbox()).length, 1);

  const outboxPath = join(dataDir, "notification-outbox.json");
  assert.equal((await stat(outboxPath)).mode & 0o777, 0o600);
  const persisted = JSON.parse(await readFile(outboxPath, "utf8"));
  assert.equal(persisted[0].attempts, 1);
  assert.equal(persisted[0].lastError.includes("prepare failed"), true);

  let recoveredCalls = 0;
  const recoveredClawbot = {
    status: async () => ({ ready: true, pairedCount: 1, reason: null }),
    send: async () => { recoveredCalls += 1; return { ok: true, accepted: 1 }; },
  };
  now = new Date(now.getTime() + 1_000);
  const restarted = new NotificationCenter({
    dataDir,
    buildDigest: async () => "摘要",
    clawbot: recoveredClawbot,
    now: () => now,
    retryDelaysMs: [1_000],
    sessionRetryDelaysMs: [1_000],
  });
  await restarted.init();
  const retried = await restarted.drainOutbox(now);
  assert.equal(retried.length, 1);
  assert.equal(retried[0].ok, true);
  assert.equal(recoveredCalls, 1);
  assert.equal((await restarted.outbox()).length, 0);
});

test("daily schedule is marked complete when a queued retry succeeds", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "zhitai-notify-daily-retry-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let now = new Date(2026, 7, 27, 21, 31, 0, 0);
  let sendCalls = 0;
  let digestCalls = 0;
  const clawbot = {
    status: async () => ({ ready: true, pairedCount: 1, reason: null }),
    send: async () => {
      sendCalls += 1;
      return sendCalls === 1
        ? { ok: false, error: "sendMessage ret=-2 errmsg=prepare failed" }
        : { ok: true, accepted: 1 };
    },
  };
  const center = new NotificationCenter({
    dataDir,
    buildDigest: async () => { digestCalls += 1; return "学习摘要"; },
    clawbot,
    now: () => now,
    retryDelaysMs: [1_000],
    sessionRetryDelaysMs: [1_000],
  });
  await center.init();
  center.settings.schedules.ingest.enabled = false;
  await center.tick(now);
  assert.equal((await center.outbox()).length, 1);
  now = new Date(now.getTime() + 500);
  await center.tick(now);
  assert.equal(sendCalls, 1);
  assert.equal(digestCalls, 1);
  now = new Date(now.getTime() + 500);
  await center.tick(now);
  assert.equal(center.settings.schedules.learning.lastRunDate, "2026-08-27");
  assert.equal((await center.outbox()).length, 0);
  assert.equal(sendCalls, 2);
  assert.equal(digestCalls, 1);
});

test("accepted blocker stays open, repeats on the blocker cadence, and stops only after acknowledgement", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "zhitai-notify-blocker-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let now = new Date("2026-08-27T00:00:00.000Z");
  let sendCalls = 0;
  const clawbot = {
    status: async () => ({ ready: true, paired: true, pairedCount: 1, reason: null }),
    send: async () => { sendCalls += 1; return { ok: true, accepted: 1 }; },
  };
  const center = new NotificationCenter({
    dataDir,
    buildDigest: async () => "摘要",
    clawbot,
    now: () => now,
    blockerReminderDelaysMs: [1_000, 2_000, 3_000],
  });
  await center.init();

  const initial = await center.send("运行条件需处理", "请登录", "runtime_conditions");
  assert.equal(initial.ok, true);
  assert.equal(initial.accepted, true);
  assert.equal(initial.acknowledged, false);
  assert.equal(initial.resolved, false);
  assert.equal(sendCalls, 1);
  let state = await center.publicState();
  assert.equal(state.blockers.openCount, 1);
  assert.equal(state.blockers.items[0].acceptedCount, 1);

  now = new Date(now.getTime() + 500);
  const duplicate = await center.send("运行条件需处理", "请登录", "runtime_conditions");
  assert.equal(duplicate.suppressed, true);
  assert.equal(duplicate.accepted, false);
  assert.equal(duplicate.previouslyAccepted, true);
  assert.equal(duplicate.acknowledged, false);
  assert.equal(sendCalls, 1);

  now = new Date(now.getTime() + 500);
  await center.tick(now);
  assert.equal(sendCalls, 2);
  state = await center.publicState();
  assert.equal(state.blockers.items[0].acceptedCount, 2);

  const acknowledged = await center.acknowledgeFromUserReply();
  assert.equal(acknowledged.changed, 1);
  state = await center.publicState();
  assert.equal(state.blockers.openCount, 0);
  assert.equal(state.blockers.acknowledgedCount, 1);
  now = new Date(now.getTime() + 10_000);
  await center.tick(now);
  assert.equal(sendCalls, 2);

  await center.send("运行条件已恢复", "条件通过", "runtime_conditions_recovered");
  state = await center.publicState();
  assert.equal(state.blockers.acknowledgedCount, 0);
});

test("prepare failed opens a session-refresh cooldown and a newer inbound context clears it", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "zhitai-notify-session-refresh-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let now = new Date("2026-08-27T00:00:00.000Z");
  let contextUpdatedAt = new Date(now.getTime() - 1_000).toISOString();
  let sendCalls = 0;
  const clawbot = {
    status: async () => ({ ready: true, paired: true, pairedCount: 1, contextUpdatedAt, reason: null }),
    send: async () => {
      sendCalls += 1;
      return sendCalls === 1
        ? { ok: false, error: "sendMessage ret=-2 errmsg=prepare failed" }
        : { ok: true, accepted: 1 };
    },
  };
  const center = new NotificationCenter({
    dataDir,
    buildDigest: async () => "摘要",
    clawbot,
    now: () => now,
    sessionRetryDelaysMs: [10_000],
  });
  await center.init();
  const failed = await center.send("一", "一", "notification_channel", {
    blockerKey: "blocker:clawbot-session-refresh",
  });
  assert.equal(failed.errorCode, "session_refresh_required");
  assert.equal(sendCalls, 1);
  assert.equal((await center.publicState()).blockers.openCount, 1);

  const cooled = await center.send("二", "二", "ordinary_two");
  assert.equal(cooled.errorCode, "session_refresh_required");
  assert.equal(sendCalls, 1);
  let state = await center.publicState();
  assert.equal(state.clawbot.paired, true);
  assert.equal(state.clawbot.ready, false);
  assert.equal(state.clawbot.deliveryState, "session_refresh_required");

  now = new Date(now.getTime() + 1_000);
  contextUpdatedAt = now.toISOString();
  const recovered = await center.send("三", "三", "ordinary_three");
  assert.equal(recovered.ok, true);
  assert.equal(sendCalls, 2);
  state = await center.publicState();
  assert.equal(state.clawbot.ready, true);
  assert.equal(state.clawbot.deliveryState, "ready");
  assert.equal(state.blockers.openCount, 0);
  const recoveredBlocker = (await center.blockers()).find((item) => item.key === "blocker:clawbot-session-refresh");
  assert.equal(recoveredBlocker.status, "resolved");
  assert.equal(recoveredBlocker.closeReason, "clawbot_delivery_recovered");
});

test("session-refresh cooldown escalates globally from 2h to 8h to daily-equivalent stages", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "zhitai-notify-session-stage-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let now = new Date("2026-08-27T00:00:00.000Z");
  let sendCalls = 0;
  const clawbot = {
    status: async () => ({ ready: true, paired: true, pairedCount: 1, contextUpdatedAt: "2026-08-26T00:00:00.000Z", reason: null }),
    send: async () => { sendCalls += 1; return { ok: false, error: "sendMessage ret=-2 errmsg=prepare failed" }; },
  };
  const center = new NotificationCenter({
    dataDir,
    buildDigest: async () => "摘要",
    clawbot,
    now: () => now,
    sessionRetryDelaysMs: [100, 200, 300],
  });
  await center.init();
  await center.send("A", "A", "a");
  assert.equal(Date.parse(center.deliveryHealth.clawbot.cooldownUntil) - now.getTime(), 100);
  now = new Date(now.getTime() + 100);
  await center.send("B", "B", "b");
  assert.equal(Date.parse(center.deliveryHealth.clawbot.cooldownUntil) - now.getTime(), 200);
  now = new Date(now.getTime() + 200);
  await center.send("C", "C", "c");
  assert.equal(Date.parse(center.deliveryHealth.clawbot.cooldownUntil) - now.getTime(), 300);
  assert.equal(center.deliveryHealth.clawbot.sessionFailureStage, 3);
  assert.equal(sendCalls, 3);
});

test("new inbound context resets session-refresh escalation before another prepare failure", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "zhitai-notify-session-context-reset-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let now = new Date("2026-08-27T00:00:00.000Z");
  let contextUpdatedAt = "2026-08-26T00:00:00.000Z";
  const clawbot = {
    status: async () => ({ ready: true, paired: true, pairedCount: 1, contextUpdatedAt, reason: null }),
    send: async () => ({ ok: false, error: "sendMessage ret=-2 errmsg=prepare failed" }),
  };
  const center = new NotificationCenter({
    dataDir,
    buildDigest: async () => "摘要",
    clawbot,
    now: () => now,
    sessionRetryDelaysMs: [100, 200, 300],
  });
  await center.init();
  await center.send("A", "A", "a");
  now = new Date(now.getTime() + 100);
  await center.send("B", "B", "b");
  assert.equal(center.deliveryHealth.clawbot.sessionFailureStage, 2);

  now = new Date(now.getTime() + 200);
  contextUpdatedAt = now.toISOString();
  await center.send("C", "C", "c");
  assert.equal(center.deliveryHealth.clawbot.sessionFailureStage, 1);
  assert.equal(Date.parse(center.deliveryHealth.clawbot.cooldownUntil) - now.getTime(), 100);
});

test("corrupt outbox is preserved and degrades notification storage instead of being overwritten", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "zhitai-notify-corrupt-outbox-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const outboxPath = join(dataDir, "notification-outbox.json");
  const broken = '[{"id":"out_preserve"';
  await writeFile(outboxPath, broken);
  const center = new NotificationCenter({ dataDir, buildDigest: async () => "摘要" });
  await center.init();
  assert.equal(await readFile(outboxPath, "utf8"), broken);
  const state = await center.publicState();
  assert.equal(state.storage.degraded, true);
  assert.equal(state.storage.issues.some((item) => item.scope === "outbox_read"), true);
  await assert.rejects(center.send("标题", "正文", "test"));
  assert.equal(await readFile(outboxPath, "utf8"), broken);
});

test("critical notification storage degradation gates top-level readiness even when a channel was verified", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "zhitai-notify-critical-storage-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const createdAt = "2026-08-27T00:00:00.000Z";
  await writeFile(join(dataDir, "notification-deliveries.json"), JSON.stringify([{
    id: "ntf_previous_success",
    kind: "test",
    channel: "clawbot",
    status: "accepted",
    createdAt,
  }]));
  await writeFile(join(dataDir, "notification-outbox.json"), '[{"id":"out_broken"');
  const clawbot = {
    status: async () => ({ ready: true, paired: true, pairedCount: 1, reason: null }),
    send: async () => ({ ok: true, accepted: 1 }),
  };
  const center = new NotificationCenter({ dataDir, buildDigest: async () => "摘要", clawbot });
  await center.init();
  const state = await center.publicState();
  assert.equal(state.channelOperational, true);
  assert.equal(state.clawbot.ready, true);
  assert.equal(state.storage.criticalDegraded, true);
  assert.equal(state.acceptingNotifications, false);
  assert.equal(state.ready, false);
  await assert.rejects(center.send("新标题", "新正文", "new_event"));
});

test("ingress WAL persists a concurrent notification before an earlier network delivery finishes", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "zhitai-notify-ingress-wal-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  let releaseFirst;
  const firstReleased = new Promise((resolve) => { releaseFirst = resolve; });
  let enteredFirst;
  const firstEntered = new Promise((resolve) => { enteredFirst = resolve; });
  let calls = 0;
  const clawbot = {
    status: async () => ({ ready: true, paired: true, pairedCount: 1, reason: null }),
    send: async () => {
      calls += 1;
      if (calls === 1) {
        enteredFirst();
        await firstReleased;
      }
      return { ok: true, accepted: 1 };
    },
  };
  const center = new NotificationCenter({ dataDir, buildDigest: async () => "摘要", clawbot });
  await center.init();
  const first = center.send("A", "A", "a");
  await firstEntered;
  const second = center.send("B", "B", "b");

  let persistedIngress = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    persistedIngress = JSON.parse(await readFile(join(dataDir, "notification-ingress.json"), "utf8"));
    if (persistedIngress.some((item) => item.kind === "b")) break;
    await delay(5);
  }
  assert.equal(persistedIngress.some((item) => item.kind === "b"), true);
  const persistedOutbox = JSON.parse(await readFile(join(dataDir, "notification-outbox.json"), "utf8"));
  assert.deepEqual(persistedOutbox.map((item) => item.kind), ["a"]);

  releaseFirst();
  const [firstResult, secondResult] = await Promise.all([first, second]);
  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, true);
  assert.equal((await center.ingress()).length, 0);
  assert.equal((await center.outbox()).length, 0);
});

test("restart reconciles an old accepted delivery with residual ingress without redelivery", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "zhitai-notify-ingress-reconcile-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const ingressId = "in_residual_after_accept";
  const createdAt = "2026-08-27T00:00:00.000Z";
  await writeFile(join(dataDir, "notification-ingress.json"), JSON.stringify([{
    id: ingressId,
    title: "旧标题",
    message: "旧正文",
    kind: "old_event",
    options: {},
    createdAt,
  }]));
  await writeFile(join(dataDir, "notification-deliveries.json"), JSON.stringify([{
    id: "ntf_old_accept",
    ingressId,
    kind: "old_event",
    channel: "clawbot",
    status: "accepted",
    createdAt,
  }]));
  let sendCalls = 0;
  const clawbot = {
    status: async () => ({ ready: true, paired: true, pairedCount: 1, reason: null }),
    send: async () => { sendCalls += 1; return { ok: true, accepted: 1 }; },
  };
  const center = new NotificationCenter({
    dataDir,
    buildDigest: async () => "摘要",
    clawbot,
    now: () => new Date("2026-08-27T00:10:00.000Z"),
  });
  await center.init();
  const results = await center.drainIngress();
  assert.equal(results[0].reconciled, true);
  assert.equal(results[0].previouslyAccepted, true);
  assert.equal(sendCalls, 0);
  assert.equal((await center.ingress()).length, 0);
});

test("invalid saved notification settings fall back safely without blocking init", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "zhitai-notify-invalid-settings-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await writeFile(join(dataDir, "notification-settings.json"), JSON.stringify({
    ntfy: { enabled: true, server: "not a url", topic: "bad topic" },
  }));
  const center = new NotificationCenter({ dataDir, buildDigest: async () => "摘要" });
  await center.init();
  const state = await center.publicState();
  assert.equal(state.settings.ntfy.server, "https://ntfy.sh");
  assert.equal(state.settings.ntfy.enabled, false);
  assert.equal(state.storage.degraded, true);
});

test("configured ntfy is unverified until accepted and becomes non-operational after a failed probe", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "zhitai-notify-ntfy-health-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response("unavailable", { status: 503 });
  t.after(() => { globalThis.fetch = originalFetch; });
  const center = new NotificationCenter({ dataDir, buildDigest: async () => "摘要", sessionRetryDelaysMs: [1_000] });
  await center.init();
  const created = await center.createSubscription();
  assert.equal(created.ready, false);
  assert.equal(created.settings.ntfy.deliveryState, "unverified");
  const failed = await center.test();
  assert.equal(failed.ok, false);
  const state = await center.publicState();
  assert.equal(state.ready, false);
  assert.equal(state.settings.ntfy.operational, false);
  assert.equal(state.settings.ntfy.deliveryState, "delivery_failed");
  assert.equal(state.outbox.pendingCount, 1);
});

test("restart reconciliation removes an already accepted outbox item without duplicate delivery", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "zhitai-notify-reconcile-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const now = new Date("2026-08-27T00:00:00.000Z");
  const outboxId = "out_reconcile";
  await writeFile(join(dataDir, "notification-outbox.json"), JSON.stringify([{
    id: outboxId,
    dedupeKey: "reconcile",
    kind: "test",
    title: "标题",
    message: "正文",
    attempts: 1,
    nextAttemptAt: now.toISOString(),
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  }]));
  await writeFile(join(dataDir, "notification-deliveries.json"), JSON.stringify([{
    id: "ntf_reconcile",
    outboxId,
    kind: "test",
    channel: "clawbot",
    status: "accepted",
    createdAt: now.toISOString(),
  }]));
  let sendCalls = 0;
  const clawbot = {
    status: async () => ({ ready: true, paired: true, pairedCount: 1, reason: null }),
    send: async () => { sendCalls += 1; return { ok: true, accepted: 1 }; },
  };
  const center = new NotificationCenter({ dataDir, buildDigest: async () => "摘要", clawbot, now: () => now });
  await center.init();
  const results = await center.drainOutbox(now);
  assert.equal(results[0].reconciled, true);
  assert.equal(results[0].accepted, false);
  assert.equal(results[0].previouslyAccepted, true);
  assert.equal(sendCalls, 0);
  assert.equal((await center.outbox()).length, 0);
});

test("scheduler catches tick failures instead of creating an unhandled rejection", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "zhitai-notify-scheduler-health-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const now = new Date(2026, 7, 27, 21, 31, 0, 0);
  const clawbot = {
    status: async () => ({ ready: true, paired: true, pairedCount: 1, reason: null }),
    send: async () => ({ ok: true, accepted: 1 }),
  };
  const center = new NotificationCenter({
    dataDir,
    buildDigest: async () => { throw new Error("digest failed"); },
    clawbot,
    now: () => now,
  });
  await center.init();
  center.start();
  await delay(20);
  assert.equal((await center.publicState()).scheduler.state, "failed");
  await center.stop();
});
