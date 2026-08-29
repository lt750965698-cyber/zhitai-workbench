import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { AnalysisQueue } from "../local-agent/analysis-queue.mjs";

async function runIsolatedNode(source, { timeoutMs = 3_000 } = {}) {
  const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const { code, signal } = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`isolated node timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("close", (exitCode, exitSignal) => {
      clearTimeout(timeout);
      resolve({ code: exitCode, signal: exitSignal });
    });
  });
  return { code, signal, stdout, stderr };
}

async function waitFor(check, { timeoutMs = 3_000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("analysis queue test timed out");
}

test("立即排队的任务会保持事件循环存活直到 drain 启动", async () => {
  const queueModule = new URL("../local-agent/analysis-queue.mjs", import.meta.url).href;
  const result = await runIsolatedNode(`
    import { AnalysisQueue } from ${JSON.stringify(queueModule)};
    import { mkdtemp, rm } from "node:fs/promises";
    import { tmpdir } from "node:os";
    import { join } from "node:path";

    const root = await mkdtemp(join(tmpdir(), "zhitai-analysis-liveness-"));
    try {
      let resolveCompleted;
      const completed = new Promise((resolve) => { resolveCompleted = resolve; });
      const queue = new AnalysisQueue({
        filePath: join(root, "analysis-jobs.json"),
        analyze: async () => ({ ok: true }),
        onEvent: async (kind) => {
          if (kind === "completed") resolveCompleted();
        },
      });
      await queue.init();
      await queue.enqueueMany([{ assetId: "asset-liveness", title: "事件循环存活" }]);
      await completed;
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  `);

  assert.equal(result.signal, null);
  assert.equal(result.code, 0, result.stderr || result.stdout);
});

test("持久分析队列首次失败进入退避，随后自动重试并成功", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-analysis-retry-"));
  const filePath = join(root, "analysis-jobs.json");
  t.after(() => rm(root, { recursive: true, force: true }));

  let calls = 0;
  let releaseRetryEvent;
  const retryEvent = new Promise((resolve) => { releaseRetryEvent = resolve; });
  let releaseCompletedEvent;
  const completedEvent = new Promise((resolve) => { releaseCompletedEvent = resolve; });
  const events = [];
  const queue = new AnalysisQueue({
    filePath,
    retryDelaysMs: [80],
    analyze: async (assetId) => {
      calls += 1;
      if (calls === 1) return { ok: false, error: "fixture_transient_failure" };
      return { ok: true, canonicalAssetId: `${assetId}-canonical` };
    },
    onEvent: async (kind) => {
      events.push(kind);
      if (kind === "retry") releaseRetryEvent();
      if (kind === "completed") releaseCompletedEvent();
    },
  });

  await queue.init();
  const created = await queue.enqueueMany([{ assetId: "asset-retry", title: "退避后成功" }]);
  assert.equal(created.created.length, 1);

  await retryEvent;
  const waiting = (await queue.list()).find((job) => job.id === created.created[0].id);
  assert.equal(waiting.status, "retry_wait");
  assert.equal(waiting.attempts, 1);
  assert.equal(waiting.error, "fixture_transient_failure");
  assert.ok(Date.parse(waiting.nextAttemptAt) > Date.parse(waiting.updatedAt));

  const completed = await waitFor(async () => {
    const job = (await queue.list()).find((row) => row.id === created.created[0].id);
    return job?.status === "completed" ? job : null;
  });
  assert.equal(calls, 2);
  assert.equal(completed.assetId, "asset-retry-canonical");
  assert.equal(completed.attempts, 2);
  assert.equal(completed.progress, 100);
  assert.equal(completed.error, null);
  assert.equal(completed.nextAttemptAt, null);
  await completedEvent;
  assert.deepEqual(events, ["retry", "completed"]);

  const persisted = JSON.parse(await readFile(filePath, "utf8"));
  assert.equal(persisted[0].status, "completed");
  assert.equal(persisted[0].attempts, 2);
});

test("进程重启时 running 任务先持久恢复为 queued，再继续执行", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-analysis-restart-"));
  const filePath = join(root, "analysis-jobs.json");
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeFile(filePath, `${JSON.stringify([{
    id: "analysis-recovered",
    assetId: "asset-recovered",
    title: "崩溃恢复任务",
    category: "素材",
    priority: 100,
    status: "running",
    progress: 60,
    attempts: 1,
    maxAttempts: 4,
    nextAttemptAt: "2026-08-26T09:00:00.000Z",
    error: "process_interrupted",
    createdAt: "2026-08-26T08:00:00.000Z",
    updatedAt: "2026-08-26T09:00:00.000Z",
    completedAt: null,
  }], null, 2)}\n`, "utf8");

  let calls = 0;
  const queue = new AnalysisQueue({
    filePath,
    analyze: async () => {
      calls += 1;
      return { ok: true };
    },
  });
  await queue.init();

  // init() 只安排下一轮 timer；当前调用栈中同步读取可验证崩溃态已先落盘恢复。
  const recoveredOnDisk = JSON.parse(readFileSync(filePath, "utf8"))[0];
  assert.equal(recoveredOnDisk.status, "queued");
  assert.equal(recoveredOnDisk.progress, 0);
  assert.equal(recoveredOnDisk.attempts, 1, "恢复本身不应消耗一次分析机会");
  assert.equal(recoveredOnDisk.nextAttemptAt, null);
  assert.equal(recoveredOnDisk.error, null);

  const completed = await waitFor(async () => {
    const job = (await queue.list())[0];
    return job?.status === "completed" ? job : null;
  });
  assert.equal(calls, 1);
  assert.equal(completed.attempts, 2);
});

test("自动重试耗尽后进入 needs_attention，人工 retry 可重新排队并完成", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-analysis-manual-retry-"));
  const filePath = join(root, "analysis-jobs.json");
  t.after(() => rm(root, { recursive: true, force: true }));

  let calls = 0;
  let releaseFailedEvent;
  let releaseCompletedEvent;
  const failedEvent = new Promise((resolve) => { releaseFailedEvent = resolve; });
  const completedEvent = new Promise((resolve) => { releaseCompletedEvent = resolve; });
  const events = [];
  const queue = new AnalysisQueue({
    filePath,
    maxAttempts: 2,
    retryDelaysMs: [30],
    analyze: async () => {
      calls += 1;
      return calls <= 2
        ? { ok: false, error: `fixture_failure_${calls}` }
        : { ok: true };
    },
    onEvent: async (kind) => {
      events.push(kind);
      if (kind === "failed") releaseFailedEvent();
      if (kind === "completed") releaseCompletedEvent();
    },
  });

  await queue.init();
  const created = await queue.enqueueMany([{ assetId: "asset-manual", title: "人工重试" }]);
  const jobId = created.created[0].id;
  const exhausted = await waitFor(async () => {
    const job = (await queue.list()).find((row) => row.id === jobId);
    return job?.status === "needs_attention" ? job : null;
  });

  assert.equal(exhausted.attempts, 2);
  assert.equal(exhausted.maxAttempts, 2);
  assert.equal(exhausted.error, "fixture_failure_2");
  assert.equal(exhausted.nextAttemptAt, null);
  await failedEvent;
  assert.deepEqual(events, ["retry", "failed"]);
  assert.deepEqual(await queue.counts(), {
    total: 1,
    queued: 0,
    running: 0,
    retryWait: 0,
    paused: 0,
    completed: 0,
    needsAttention: 1,
    remaining: 1,
  });

  const retried = await queue.retry(jobId);
  assert.equal(retried.status, "queued");
  assert.equal(retried.error, null);

  const completed = await waitFor(async () => {
    const job = (await queue.list()).find((row) => row.id === jobId);
    return job?.status === "completed" ? job : null;
  });
  assert.equal(calls, 3);
  assert.equal(completed.attempts, 3);
  assert.equal((await queue.counts()).needsAttention, 0);
  assert.equal((await queue.counts()).remaining, 0);
  await completedEvent;
  assert.deepEqual(events, ["retry", "failed", "completed"]);
});
