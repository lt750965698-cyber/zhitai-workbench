import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  assertPublishScheduleBinding,
  deterministicPublishScheduleId,
  PublishScheduler,
  PublishSchedulerConflictError,
} from "../local-agent/publish-scheduler.mjs";

const serverSource = readFileSync(new URL("../local-agent/server.mjs", import.meta.url), "utf8");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function fakeClock(start = "2026-08-27T00:00:00.000Z") {
  let nowMs = Date.parse(start);
  let sequence = 0;
  const timers = new Map();
  const api = {
    now: () => new Date(nowMs),
    setTimeout(callback, delayMs) {
      const handle = { id: ++sequence, unref() {} };
      timers.set(handle.id, { callback, at: nowMs + Math.max(0, Number(delayMs) || 0), handle });
      return handle;
    },
    clearTimeout(handle) {
      timers.delete(handle?.id);
    },
    setNow(value) {
      nowMs = Date.parse(value);
    },
    advance(ms) {
      nowMs += ms;
    },
    callbacks() {
      return [...timers.values()].sort((left, right) => left.at - right.at).map((item) => item.callback);
    },
    fireDue() {
      const due = [...timers.values()]
        .filter((item) => item.at <= nowMs)
        .sort((left, right) => left.at - right.at || left.handle.id - right.handle.id);
      for (const item of due) {
        timers.delete(item.handle.id);
        item.callback();
      }
      return due.length;
    },
    timerCount() {
      return timers.size;
    },
  };
  return api;
}

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "zhitai-publish-scheduler-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const clock = options.clock || fakeClock();
  const filePath = join(directory, "publish-schedule.json");
  const scheduler = new PublishScheduler({
    filePath,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    preflight: options.preflight || (async () => ({ ok: true })),
    executeTarget: options.executeTarget || (async () => ({ status: "public" })),
    onEvent: options.onEvent || (async () => {}),
    gracePeriodMs: options.gracePeriodMs || 20 * 60_000,
    retryBaseDelayMs: options.retryBaseDelayMs,
    retryMaxDelayMs: options.retryMaxDelayMs,
  });
  await scheduler.init();
  t.after(() => scheduler.stop());
  return { directory, filePath, clock, scheduler };
}

test("two stale timer callbacks CAS-claim one task and executor never receives schedule fields", async (t) => {
  let preflightCalls = 0;
  const invocations = [];
  const { clock, scheduler, filePath } = await fixture(t, {
    preflight: async (invocation) => {
      preflightCalls += 1;
      assert.equal(JSON.stringify(invocation).includes("scheduledAt"), false);
      assert.equal(JSON.stringify(invocation).includes("publishAt"), false);
      return { ok: true };
    },
    executeTarget: async (invocation) => {
      invocations.push(invocation);
      assert.equal(JSON.stringify(invocation).includes("scheduledAt"), false);
      assert.equal(JSON.stringify(invocation).includes("publishAt"), false);
      return { status: "public", postId: "post-1" };
    },
  });
  await scheduler.schedule({
    id: "double-timer",
    scheduledAt: "2026-08-27T00:00:01.000Z",
    expiresAt: "2026-08-27T00:01:00.000Z",
    payload: { title: "测试", scheduledAt: "must-not-leak", publishAt: "must-not-leak" },
    targets: [{
      id: "xiaohongshu",
      platform: "xiaohongshu",
      scheduledAt: "must-not-leak",
      publishAt: "must-not-leak",
    }],
  });
  const [staleCallback] = clock.callbacks();
  clock.advance(1_000);
  staleCallback();
  staleCallback();
  await scheduler.waitForIdle("double-timer");

  assert.equal(preflightCalls, 1);
  assert.equal(invocations.length, 1);
  assert.equal((await scheduler.get("double-timer")).status, "public");
  assert.equal((await stat(filePath)).mode & 0o777, 0o600);
  const persisted = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(persisted.version, 1);
  assert.equal(persisted.tasks[0].targets[0].receipt.postId, "post-1");
});

test("the same logical future request persists once and invokes its external target once", async (t) => {
  let calls = 0;
  const { clock, scheduler } = await fixture(t, {
    executeTarget: async () => {
      calls += 1;
      return { status: "public", postId: "one-external-call" };
    },
  });
  const identity = {
    mediaSha256: "a".repeat(64),
    expectedMode: "public",
    targets: ["xhs:acct_123"],
  };
  const taskId = deterministicPublishScheduleId(
    "matrix_video",
    "2026-08-27T08:00:00+08:00",
    identity,
  );
  assert.equal(
    taskId,
    deterministicPublishScheduleId("matrix_video", "2026-08-27T00:00:00.000Z", identity),
    "equivalent schedule instants must share one id",
  );
  const input = {
    id: taskId,
    scheduledAt: "2026-08-27T00:00:00.000Z",
    expiresAt: "2026-08-27T00:01:00.000Z",
    payload: { kind: "matrix_video", request: { videoId: "video-1" } },
    targets: [{ id: "xhs:acct_123", platform: "xhs", accountFingerprint: "acct_123" }],
  };
  const first = await scheduler.scheduleIdempotent(input);
  const duplicate = await scheduler.scheduleIdempotent(input);
  assert.equal(first.id, taskId);
  assert.equal(duplicate.id, taskId);
  assert.equal(duplicate.deduplicated, true);
  assert.equal((await scheduler.list()).length, 1);

  clock.fireDue();
  await scheduler.waitForIdle(taskId);
  assert.equal(calls, 1);
  assert.equal((await scheduler.get(taskId)).status, "public");
});

test("a newer generation or changed storyboard is rejected before every external call", async (t) => {
  let executeCalls = 0;
  const actualBindings = new Map();
  const { clock, scheduler } = await fixture(t, {
    preflight: async ({ taskId, payload }) => {
      assertPublishScheduleBinding(payload.binding, actualBindings.get(taskId));
      return { ok: true };
    },
    executeTarget: async () => {
      executeCalls += 1;
      return { status: "public" };
    },
  });
  const videoBinding = {
    generationEngine: "ZhitaiSeedance",
    generationTaskId: "creative_old",
    mediaSha256: "a".repeat(64),
    mediaSizeBytes: 1_000,
    audioQualitySha256: "b".repeat(64),
    workflowSha256: "c".repeat(64),
  };
  const imageBinding = {
    generationEngine: "ZhitaiSeedance",
    generationTaskId: "creative_image",
    storyboards: [{ name: "storyboard-01.png", sizeBytes: 400, sha256: "d".repeat(64) }],
    storyboardFingerprint: "e".repeat(64),
    workflowSha256: "f".repeat(64),
    publishTextSha256: "1".repeat(64),
  };
  await scheduler.schedule({
    id: "newer-generation",
    scheduledAt: "2026-08-27T00:00:00.000Z",
    expiresAt: "2026-08-27T00:01:00.000Z",
    payload: { kind: "matrix_video", binding: videoBinding },
    targets: [{ id: "xhs:acct_video" }],
  });
  await scheduler.schedule({
    id: "changed-storyboard",
    scheduledAt: "2026-08-27T00:00:00.000Z",
    expiresAt: "2026-08-27T00:01:00.000Z",
    payload: { kind: "image_text", binding: imageBinding },
    targets: [{ id: "xhs:acct_image" }],
  });

  actualBindings.set("newer-generation", { ...videoBinding, generationTaskId: "creative_new" });
  actualBindings.set("changed-storyboard", {
    ...imageBinding,
    storyboards: [{ ...imageBinding.storyboards[0], sha256: "2".repeat(64) }],
    storyboardFingerprint: "3".repeat(64),
  });
  assert.equal(clock.fireDue(), 2);
  await scheduler.waitForIdle();

  assert.equal(executeCalls, 0);
  for (const taskId of ["newer-generation", "changed-storyboard"]) {
    const task = await scheduler.get(taskId);
    assert.equal(task.status, "needs_attention");
    assert.equal(task.error, "publish_schedule_binding_mismatch");
    assert.equal(task.targets[0].status, "pending");
  }
});

test("server persists and rechecks strict media bindings on preflight and execution", () => {
  assert.match(serverSource, /persistent_schedule_requires_strict_generated_media/);
  assert.match(serverSource, /persistent_schedule_requires_strict_zhitai_generation/);
  assert.match(serverSource, /persistent_schedule_generation_task_binding_missing/);
  assert.match(serverSource, /audioQualitySha256:\s*String\(audioQualitySha256/);
  assert.match(serverSource, /mediaSizeBytes:\s*Number\(publishMedia\.size_bytes/);
  assert.match(serverSource, /generationTaskId:\s*String\(generation\?\.engine_task_id/);
  assert.match(serverSource, /binding:\s*prepared\.scheduleBinding/);
  assert.match(serverSource, /requireExpectedBinding:\s*true,\s*\n\s*expectedBinding:\s*payload\.binding/);
  assert.match(serverSource, /storyboards,\s*\n\s*storyboardFingerprint/);
  assert.match(serverSource, /STRICT_ZHITAI_GENERATION_ENGINES\.includes\(bundle\.assetBinding\.generationEngine\)/);
  assert.match(serverSource, /creativeStatement,\s*\n\s*publishTextSha256/);
  assert.match(serverSource, /aiDeclarationVerified !== true/);
  assert.match(serverSource, /inspectStrictGenerationEvidence\(\{/);
  assert.match(serverSource, /if \(!\/\\baac\\b\/i\.test\(String\(publishMedia\.codec_audio \|\| ""\)\)\)/);
});

test("two scheduler instances use the on-disk CAS claim to prevent duplicate submission", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zhitai-publish-cas-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "publish-schedule.json");
  const clock = fakeClock();
  let calls = 0;
  const create = () => new PublishScheduler({
    filePath,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    executeTarget: async () => { calls += 1; return { status: "public" }; },
  });
  const first = create();
  const second = create();
  t.after(() => first.stop());
  t.after(() => second.stop());
  await first.init();
  await second.init();
  await first.schedule({
    id: "cross-instance-cas",
    scheduledAt: "2026-08-27T00:00:00.000Z",
    expiresAt: "2026-08-27T00:01:00.000Z",
    targets: [{ id: "xhs" }],
  });
  const [timerCallback] = clock.callbacks();
  timerCallback();
  const competingRun = second.run("cross-instance-cas");
  await Promise.all([first.waitForIdle(), competingRun]);
  assert.equal(calls, 1);
  assert.equal((await first.get("cross-instance-cas")).status, "public");
});

test("restart restores a future timer and runs a due task within its grace window once", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zhitai-publish-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "publish-schedule.json");
  const clock = fakeClock();
  let calls = 0;
  const create = () => new PublishScheduler({
    filePath,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    executeTarget: async () => { calls += 1; return { status: "public" }; },
  });
  const first = create();
  await first.init();
  await first.schedule({
    id: "restart-due",
    scheduledAt: "2026-08-27T00:01:00.000Z",
    expiresAt: "2026-08-27T00:03:00.000Z",
    targets: [{ id: "xhs" }],
  });
  assert.equal(clock.timerCount(), 1);
  first.stop();

  clock.setNow("2026-08-27T00:02:00.000Z");
  const restarted = create();
  t.after(() => restarted.stop());
  await restarted.init();
  assert.equal(clock.fireDue(), 1);
  await restarted.waitForIdle();
  assert.equal(calls, 1);
  assert.equal((await restarted.get("restart-due")).status, "public");

  const third = create();
  t.after(() => third.stop());
  await third.init();
  clock.fireDue();
  await third.waitForIdle();
  assert.equal(calls, 1);
});

test("cancelling while preflight is pending wins the race and prevents every submission", async (t) => {
  const entered = deferred();
  const release = deferred();
  let executeCalls = 0;
  const { clock, scheduler } = await fixture(t, {
    preflight: async () => {
      entered.resolve();
      return release.promise;
    },
    executeTarget: async () => { executeCalls += 1; return { status: "public" }; },
  });
  await scheduler.schedule({
    id: "cancel-race",
    scheduledAt: "2026-08-27T00:00:00.000Z",
    expiresAt: "2026-08-27T00:01:00.000Z",
    targets: [{ id: "xhs" }, { id: "wechat" }],
  });
  clock.fireDue();
  await entered.promise;
  const cancelled = await scheduler.cancel("cancel-race");
  assert.equal(cancelled.status, "cancelled");
  assert.equal(clock.timerCount(), 0);
  release.resolve({ ok: true });
  await scheduler.waitForIdle();
  assert.equal(executeCalls, 0);
  assert.equal((await scheduler.get("cancel-race")).status, "cancelled");
});

test("cancel conflicts while submitting and after any external receipt", async (t) => {
  const entered = deferred();
  const release = deferred();
  const { clock, scheduler } = await fixture(t, {
    executeTarget: async () => {
      entered.resolve();
      return release.promise;
    },
  });
  await scheduler.schedule({
    id: "cancel-conflict",
    scheduledAt: "2026-08-27T00:00:00.000Z",
    expiresAt: "2026-08-27T00:01:00.000Z",
    targets: [{ id: "xhs" }],
  });
  clock.fireDue();
  await entered.promise;
  await assert.rejects(
    scheduler.cancel("cancel-conflict"),
    (error) => error instanceof PublishSchedulerConflictError
      && error.statusCode === 409
      && error.code === "publish_task_submitting_conflict",
  );
  release.resolve({ status: "public", postId: "visible" });
  await scheduler.waitForIdle();
  await assert.rejects(
    scheduler.cancel("cancel-conflict"),
    (error) => error.code === "publish_task_external_receipt_conflict",
  );
});

test("restart marks a task past expiresAt as needs_attention without executing it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zhitai-publish-expired-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "publish-schedule.json");
  const clock = fakeClock();
  let calls = 0;
  const makeScheduler = () => new PublishScheduler({
    filePath,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    executeTarget: async () => { calls += 1; return { status: "public" }; },
  });
  const first = makeScheduler();
  await first.init();
  await first.schedule({
    id: "expired",
    scheduledAt: "2026-08-27T00:01:00.000Z",
    expiresAt: "2026-08-27T00:02:00.000Z",
    targets: [{ id: "xhs" }],
  });
  first.stop();
  clock.setNow("2026-08-27T00:02:00.001Z");
  const restarted = makeScheduler();
  t.after(() => restarted.stop());
  await restarted.init();
  assert.equal(clock.timerCount(), 0);
  const task = await restarted.get("expired");
  assert.equal(task.status, "needs_attention");
  assert.equal(task.error, "schedule_expired");
  assert.equal(calls, 0);
  await restarted.retry("expired");
  clock.fireDue();
  await restarted.waitForIdle();
  assert.equal(calls, 1, "an explicit retry may recover a pre-submit expiry");
});

test("partial failure records every platform and retry executes only the failed target", async (t) => {
  const calls = [];
  let wechatRecovered = false;
  const { clock, scheduler } = await fixture(t, {
    executeTarget: async ({ targetId }) => {
      calls.push(targetId);
      if (targetId === "wechat" && !wechatRecovered) throw new Error("temporary adapter failure");
      return { status: "public", postId: `${targetId}-post` };
    },
  });
  await scheduler.schedule({
    id: "partial",
    scheduledAt: "2026-08-27T00:00:00.000Z",
    expiresAt: "2026-08-27T00:01:00.000Z",
    targets: [{ id: "xhs" }, { id: "wechat" }],
  });
  clock.fireDue();
  await scheduler.waitForIdle();
  let task = await scheduler.get("partial");
  assert.equal(task.status, "needs_attention");
  assert.deepEqual(task.targets.map((target) => [target.id, target.status]), [
    ["xhs", "public"],
    ["wechat", "failed"],
  ]);

  wechatRecovered = true;
  await scheduler.retry("partial");
  clock.fireDue();
  await scheduler.waitForIdle();
  task = await scheduler.get("partial");
  assert.equal(task.status, "public");
  assert.deepEqual(calls, ["xhs", "wechat", "wechat"]);
  assert.equal(task.targets[0].attempts, 1);
  assert.equal(task.targets[1].attempts, 2);
});

test("an explicitly pre-external transient failure enters retry_wait with exponential backoff", async (t) => {
  let calls = 0;
  const events = [];
  const { clock, scheduler } = await fixture(t, {
    retryBaseDelayMs: 1_000,
    retryMaxDelayMs: 8_000,
    executeTarget: async () => {
      calls += 1;
      if (calls <= 2) {
        const error = new Error(calls === 1 ? "EPERM: account store temporarily unreadable" : "matrixmedia_cli_timeout");
        error.beforeExternalCall = true;
        throw error;
      }
      return { status: "public", postId: "after-safe-retries" };
    },
    onEvent: async (task) => events.push(task.status),
  });
  await scheduler.schedule({
    id: "pre-external-backoff",
    scheduledAt: "2026-08-27T00:00:00.000Z",
    expiresAt: "2026-08-27T00:01:00.000Z",
    targets: [{ id: "douyin" }],
  });

  assert.equal(clock.fireDue(), 1);
  await scheduler.waitForIdle();
  let task = await scheduler.get("pre-external-backoff");
  assert.equal(task.status, "retry_wait");
  assert.equal(task.nextAttemptAt, "2026-08-27T00:00:01.000Z");
  assert.equal(task.targets[0].status, "pending");
  assert.equal(task.targets[0].attempts, 1);
  assert.equal(clock.timerCount(), 1);

  clock.advance(999);
  assert.equal(clock.fireDue(), 0);
  clock.advance(1);
  assert.equal(clock.fireDue(), 1);
  await scheduler.waitForIdle();
  task = await scheduler.get("pre-external-backoff");
  assert.equal(task.status, "retry_wait");
  assert.equal(task.nextAttemptAt, "2026-08-27T00:00:03.000Z");
  assert.equal(task.targets[0].attempts, 2);

  clock.advance(1_999);
  assert.equal(clock.fireDue(), 0);
  clock.advance(1);
  assert.equal(clock.fireDue(), 1);
  await scheduler.waitForIdle();
  task = await scheduler.get("pre-external-backoff");
  assert.equal(task.status, "public");
  assert.equal(task.nextAttemptAt, null);
  assert.equal(task.targets[0].attempts, 3);
  assert.equal(task.targets[0].receipt.postId, "after-safe-retries");
  assert.equal(calls, 3);
  assert.deepEqual(events, ["retry_wait", "retry_wait", "public"]);
});

test("scheduler completion callback receives a persisted terminal failure for durable notification", async (t) => {
  const events = [];
  const { clock, scheduler } = await fixture(t, {
    executeTarget: async () => { throw new Error("platform login expired"); },
    onEvent: async (task) => events.push({ status: task.status, error: task.targets[0].error }),
  });
  await scheduler.schedule({
    id: "notify-terminal-failure",
    scheduledAt: "2026-08-27T00:00:00.000Z",
    expiresAt: "2026-08-27T00:01:00.000Z",
    targets: [{ id: "xhs" }],
  });
  clock.fireDue();
  await scheduler.waitForIdle();
  assert.deepEqual(events, [{ status: "needs_attention", error: "platform login expired" }]);
});

test("retry_wait survives restart and repeats only the target without an external receipt", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zhitai-publish-retry-restart-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "publish-schedule.json");
  const clock = fakeClock();
  const calls = [];
  let wechatReady = false;
  const create = () => new PublishScheduler({
    filePath,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    retryBaseDelayMs: 1_000,
    executeTarget: async ({ targetId }) => {
      calls.push(targetId);
      if (targetId === "wechat" && !wechatReady) {
        const error = new Error("account history temporarily unavailable");
        error.retryableBeforeExternalCall = true;
        throw error;
      }
      return { status: "public", postId: `${targetId}-post` };
    },
  });
  const first = create();
  await first.init();
  await first.schedule({
    id: "retry-restart",
    scheduledAt: "2026-08-27T00:00:00.000Z",
    expiresAt: "2026-08-27T00:01:00.000Z",
    targets: [{ id: "douyin" }, { id: "wechat" }],
  });
  clock.fireDue();
  await first.waitForIdle();
  assert.equal((await first.get("retry-restart")).status, "retry_wait");
  assert.deepEqual(calls, ["douyin", "wechat"]);
  first.stop();

  wechatReady = true;
  const restarted = create();
  t.after(() => restarted.stop());
  await restarted.init();
  clock.advance(1_000);
  assert.equal(clock.fireDue(), 1);
  await restarted.waitForIdle();
  const task = await restarted.get("retry-restart");
  assert.equal(task.status, "public");
  assert.deepEqual(calls, ["douyin", "wechat", "wechat"]);
  assert.deepEqual(task.targets.map((target) => target.attempts), [1, 2]);
});

test("a bare CLI timeout is not auto-retried because its external-call phase is ambiguous", async (t) => {
  let calls = 0;
  const { clock, scheduler } = await fixture(t, {
    retryBaseDelayMs: 1_000,
    executeTarget: async () => {
      calls += 1;
      throw new Error("matrixmedia_cli_timeout");
    },
  });
  await scheduler.schedule({
    id: "ambiguous-timeout",
    scheduledAt: "2026-08-27T00:00:00.000Z",
    expiresAt: "2026-08-27T00:01:00.000Z",
    targets: [{ id: "douyin" }],
  });
  clock.fireDue();
  await scheduler.waitForIdle();
  const task = await scheduler.get("ambiguous-timeout");
  assert.equal(task.status, "needs_attention");
  assert.equal(task.targets[0].status, "failed");
  assert.equal(task.nextAttemptAt, null);
  assert.equal(clock.timerCount(), 0);
  clock.advance(30_000);
  assert.equal(clock.fireDue(), 0);
  assert.equal(calls, 1);
});

test("an external receipt marker overrides a contradictory pre-external retry hint", async (t) => {
  const { clock, scheduler } = await fixture(t, {
    retryBaseDelayMs: 1_000,
    executeTarget: async () => {
      const error = new Error("receipt persistence failed after platform response");
      error.beforeExternalCall = true;
      error.externalReceipt = true;
      error.status = "failed";
      throw error;
    },
  });
  await scheduler.schedule({
    id: "receipt-wins",
    scheduledAt: "2026-08-27T00:00:00.000Z",
    expiresAt: "2026-08-27T00:01:00.000Z",
    targets: [{ id: "douyin" }],
  });
  clock.fireDue();
  await scheduler.waitForIdle();
  const task = await scheduler.get("receipt-wins");
  assert.equal(task.status, "needs_attention");
  assert.equal(task.targets[0].status, "failed");
  assert.ok(task.targets[0].externalReceiptAt);
  assert.equal(clock.timerCount(), 0);
  await assert.rejects(
    scheduler.retry("receipt-wins"),
    (error) => error.code === "publish_task_no_retryable_targets",
  );
});

test("pre-external retries stop at expiresAt instead of creating a late platform call", async (t) => {
  let calls = 0;
  const { clock, scheduler } = await fixture(t, {
    retryBaseDelayMs: 5_000,
    executeTarget: async () => {
      calls += 1;
      const error = new Error("EPERM");
      error.beforeExternalCall = true;
      throw error;
    },
  });
  await scheduler.schedule({
    id: "retry-window-exhausted",
    scheduledAt: "2026-08-27T00:00:00.000Z",
    expiresAt: "2026-08-27T00:00:04.000Z",
    targets: [{ id: "douyin" }],
  });
  clock.fireDue();
  await scheduler.waitForIdle();
  const task = await scheduler.get("retry-window-exhausted");
  assert.equal(task.status, "needs_attention");
  assert.equal(task.error, "retry_window_exhausted");
  assert.equal(task.targets[0].status, "failed");
  assert.equal(task.nextAttemptAt, null);
  assert.equal(clock.timerCount(), 0);
  assert.equal(calls, 1);
});

test("unknown, submitted, public, and draft receipts are never auto-retried after restart", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zhitai-publish-protected-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "publish-schedule.json");
  const clock = fakeClock();
  const statuses = new Map([
    ["unknown", "unknown"],
    ["submitted", "submitted"],
    ["public", "public"],
    ["draft", "draft"],
  ]);
  const calls = [];
  const create = () => new PublishScheduler({
    filePath,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    executeTarget: async ({ targetId }) => {
      calls.push(targetId);
      return { status: statuses.get(targetId) };
    },
  });
  const first = create();
  await first.init();
  await first.schedule({
    id: "protected-receipts",
    scheduledAt: "2026-08-27T00:00:00.000Z",
    expiresAt: "2026-08-27T00:01:00.000Z",
    targets: [...statuses.keys()].map((id) => ({ id })),
  });
  clock.fireDue();
  await first.waitForIdle();
  assert.equal((await first.get("protected-receipts")).status, "submitted_unverified");
  assert.deepEqual(calls, ["unknown", "submitted", "public", "draft"]);
  first.stop();

  const restarted = create();
  t.after(() => restarted.stop());
  await restarted.init();
  clock.advance(60_000);
  clock.fireDue();
  await restarted.waitForIdle();
  assert.deepEqual(calls, ["unknown", "submitted", "public", "draft"]);
  await assert.rejects(
    restarted.retry("protected-receipts"),
    (error) => error.code === "publish_task_not_retryable",
  );
});

test("an interrupted submitting task becomes needs_reconciliation on restart", async (t) => {
  const entered = deferred();
  const neverFinish = deferred();
  const { clock, scheduler, filePath } = await fixture(t, {
    executeTarget: async () => {
      entered.resolve();
      return neverFinish.promise;
    },
  });
  await scheduler.schedule({
    id: "interrupted",
    scheduledAt: "2026-08-27T00:00:00.000Z",
    expiresAt: "2026-08-27T00:01:00.000Z",
    targets: [{ id: "xhs" }],
  });
  clock.fireDue();
  await entered.promise;
  scheduler.stop();

  const restarted = new PublishScheduler({
    filePath,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    executeTarget: async () => assert.fail("ambiguous submission must not repeat"),
  });
  t.after(() => restarted.stop());
  await restarted.init();
  const task = await restarted.get("interrupted");
  assert.equal(task.status, "needs_reconciliation");
  assert.equal(task.targets[0].status, "needs_reconciliation");
  await assert.rejects(
    restarted.cancel("interrupted"),
    (error) => error.code === "publish_task_reconciliation_conflict" && error.statusCode === 409,
  );
  await assert.rejects(
    restarted.retry("interrupted"),
    (error) => error.code === "publish_task_not_retryable" && error.statusCode === 409,
  );
  // Let the old in-memory promise settle so the test runner has no dangling async work.
  neverFinish.resolve({ status: "unknown" });
  await scheduler.waitForIdle();
});

test("a public-intent draft receipt is needs_attention and protected from explicit retry", async (t) => {
  const { clock, scheduler } = await fixture(t, {
    executeTarget: async () => ({
      status: "failed",
      observedState: "draft",
      intentSatisfied: false,
      externalReceipt: true,
      error: "public_publish_fell_back_to_draft",
    }),
  });
  await scheduler.schedule({
    id: "draft-fallback",
    scheduledAt: "2026-08-27T00:00:00.000Z",
    expiresAt: "2026-08-27T00:01:00.000Z",
    targets: [{ id: "xhs:account", platform: "xhs", expectedMode: "public" }],
  });
  clock.fireDue();
  await scheduler.waitForIdle();
  const task = await scheduler.get("draft-fallback");
  assert.equal(task.status, "needs_attention");
  assert.equal(task.targets[0].status, "failed");
  assert.equal(task.targets[0].receipt.observedState, "draft");
  assert.ok(task.targets[0].externalReceiptAt);
  await assert.rejects(
    scheduler.retry("draft-fallback"),
    (error) => error.code === "publish_task_no_retryable_targets",
  );
});
