import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CreativeQueue } from "../local-agent/creative-queue.mjs";

function validWorkflow(count = 1, targetDurationSeconds = 10) {
  return {
    sourceRights: { status: "owned" },
    targetDurationSeconds,
    shotCount: count,
    durationStrategy: { missingSignals: [] },
    shots: Array.from({ length: count }, (_, index) => ({
      index: index + 1,
      narration: `测试文案 ${index + 1}`,
      gptImagePrompt: `GPT 生图提示词 ${index + 1}`,
      seedancePrompt: `Seedance 视频提示词 ${index + 1}`,
      observedReference: { subject: "测试文案", setting: "测试场景", evidence: "测试关键帧" },
    })),
  };
}

async function waitFor(check, timeoutMs = 5000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timeout");
}

test("生成队列持久化、同素材活跃任务去重并串行准备", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-creative-"));
  const calls = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  try {
    const queue = new CreativeQueue({
      filePath: join(root, "jobs.json"),
      analyze: async (assetId) => {
        calls.push(assetId);
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((resolve) => setTimeout(resolve, 20));
        concurrent -= 1;
        return { remakePlan: { seedanceWorkflow: validWorkflow(2, 20) } };
      },
    });
    await queue.init();
    const first = await queue.create({ assetId: "asset-a", title: "A" });
    const duplicate = await queue.create({ assetId: "asset-a", title: "A" });
    await queue.create({ assetId: "asset-b", title: "B" });
    assert.equal(first.deduplicated, false);
    assert.equal(duplicate.deduplicated, true);
    const jobs = await waitFor(async () => {
      const rows = await queue.list();
      return rows.every((row) => row.status === "ready_for_images") ? rows : null;
    });
    assert.equal(jobs.length, 2);
    assert.equal(maxConcurrent, 1);
    assert.deepEqual(calls, ["asset-a", "asset-b"]);
    assert.equal(jobs[0].targetDurationSeconds, 20);
    assert.equal(jobs[0].shotCount, 2);
    assert.doesNotReject(() => readFile(join(root, "jobs.json"), "utf8"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("生成队列支持暂停、继续、阶段推进和完成", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-creative-"));
  let release;
  try {
    const queue = new CreativeQueue({
      filePath: join(root, "jobs.json"),
      analyze: (_assetId, { signal }) => new Promise((resolve, reject) => {
        release = resolve;
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
      }),
    });
    await queue.init();
    const created = await queue.create({ assetId: "asset-c", title: "C" });
    await waitFor(async () => (await queue.list())[0]?.status === "preparing");
    await queue.pause(created.job.id);
    await waitFor(async () => (await queue.list())[0]?.status === "paused");
    await queue.resume(created.job.id);
    await waitFor(async () => (await queue.list())[0]?.status === "preparing");
    release({ remakePlan: { seedanceWorkflow: validWorkflow(2, 10) } });
    await waitFor(async () => (await queue.list())[0]?.status === "ready_for_images");
    await queue.advance(created.job.id, "images_ready");
    assert.equal((await queue.list())[0].status, "ready_for_seedance");
    await queue.advance(created.job.id, "seedance_ready");
    assert.equal((await queue.list())[0].status, "ready_for_assembly");
    await queue.advance(created.job.id, "complete", { generationId: "remake-1", mediaUrl: "/generated.mp4" });
    assert.equal((await queue.list())[0].status, "completed");
    assert.equal((await queue.list())[0].generationId, "remake-1");
    assert.equal((await queue.list())[0].outputMediaUrl, "/generated.mp4");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("进程重启后 preparing 自动恢复为 queued 并继续", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-creative-"));
  const filePath = join(root, "jobs.json");
  try {
    await import("node:fs/promises").then(({ writeFile }) => writeFile(filePath, JSON.stringify([{
      id: "creative-recover", assetId: "asset-d", title: "D", status: "preparing", stage: "analysis",
      progress: 15, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    }])));
    const queue = new CreativeQueue({
      filePath,
      analyze: async () => ({ remakePlan: { seedanceWorkflow: validWorkflow(3, 30) } }),
    });
    await queue.init();
    await waitFor(async () => (await queue.list())[0]?.status === "ready_for_images");
    assert.equal((await queue.list())[0].shotCount, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("历史 database is locked 失败任务使用原 job 幂等恢复，不新建重复任务", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-creative-busy-recover-"));
  const filePath = join(root, "jobs.json");
  try {
    await import("node:fs/promises").then(({ writeFile }) => writeFile(filePath, JSON.stringify([{
      id: "creative_locked_original",
      assetId: "asset-locked",
      title: "写锁恢复",
      status: "failed",
      stage: "analysis",
      progress: 0,
      error: "database is locked",
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:01.000Z",
    }])));
    const queue = new CreativeQueue({
      filePath,
      analyze: async () => ({ remakePlan: { seedanceWorkflow: validWorkflow(1, 10) } }),
    });
    await queue.init();
    const recovered = await waitFor(async () => {
      const row = (await queue.list())[0];
      return row?.status === "ready_for_images" ? row : null;
    });
    assert.equal(recovered.id, "creative_locked_original");
    const duplicate = await queue.create({ assetId: "asset-locked", title: "不应新建" });
    assert.equal(duplicate.deduplicated, true);
    assert.equal(duplicate.job.id, "creative_locked_original");
    assert.equal((await queue.list()).length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("运行中 SQLITE_BUSY 进入可恢复退避而非终态 failed", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-creative-busy-retry-"));
  let attempts = 0;
  try {
    const queue = new CreativeQueue({
      filePath: join(root, "jobs.json"),
      analyze: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("SQLITE_BUSY: database is locked");
        return { remakePlan: { seedanceWorkflow: validWorkflow(1, 10) } };
      },
    });
    await queue.init();
    const created = await queue.create({ assetId: "asset-busy-retry", title: "自动重试" });
    const recovered = await waitFor(async () => {
      const row = (await queue.list()).find((item) => item.id === created.job.id);
      return row?.status === "ready_for_images" ? row : null;
    }, 2_500);
    assert.equal(recovered.id, created.job.id);
    assert.equal(attempts, 2);
    assert.equal(recovered.transientRetryCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("生成队列在提示词矛盾时明确失败，不会打开 GPT 或豆包", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-creative-"));
  try {
    const workflow = validWorkflow();
    workflow.shots[0].observedReference = { subject: "construction site", setting: "农村工地", evidence: "关键帧" };
    workflow.shots[0].narration = "农村工地施工过程";
    workflow.shots[0].gptImagePrompt = "中国城市住宅室内，家具数量保持一致";
    const queue = new CreativeQueue({
      filePath: join(root, "jobs.json"),
      analyze: async () => ({ remakePlan: { seedanceWorkflow: workflow } }),
    });
    await queue.init();
    await queue.create({ assetId: "asset-blocked", title: "矛盾素材" });
    const job = await waitFor(async () => {
      const row = (await queue.list())[0];
      return row?.status === "failed" ? row : null;
    });
    assert.match(job.error, /生成前质量门未通过/);
    assert.match(job.error, /行业模板内容/);
    const duplicate = await queue.create({ assetId: "asset-blocked", title: "不得丢弃原失败任务" });
    assert.equal(duplicate.deduplicated, true);
    assert.equal(duplicate.job.id, job.id, "失败任务必须通过原任务 retry，不能创建替代任务丢失断点");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("旧计划有版权或配音风险时先持久化完全原创补救，再继续生成队列", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-creative-original-"));
  const persisted = [];
  try {
    const workflow = validWorkflow();
    delete workflow.sourceRights;
    workflow.shots[0].narration = "视频前3秒重复‘我怕你’作为听觉钩子，但缺乏视觉支撑。";
    workflow.shots[0].observedReference = { subject: "墙面装饰板", setting: "室内", evidence: "关键帧" };
    workflow.shots[0].referenceVideoPrompt = "上传 @视频1";
    const queue = new CreativeQueue({
      filePath: join(root, "jobs.json"),
      analyze: async () => ({ canonicalAssetId: "asset-original-canonical", remakePlan: { seedanceWorkflow: workflow } }),
      persistRemediatedWorkflow: async (assetId, recovered, context) => {
        persisted.push({ assetId, recovered, jobId: context.jobId });
        return { ok: true, workflow: recovered };
      },
    });
    await queue.init();
    const created = await queue.create({ assetId: "asset-original", title: "墙面装饰板设计" });
    const job = await waitFor(async () => {
      const row = (await queue.list())[0];
      return row?.status === "ready_for_images" ? row : null;
    });
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].assetId, "asset-original-canonical");
    assert.equal(persisted[0].jobId, created.job.id);
    assert.equal(persisted[0].recovered.mode, "full_original_recovery");
    assert.equal(job.originalityMode, "full_original_recovery");
    assert.equal(job.assetId, "asset-original-canonical");
    assert.deepEqual(job.remediationReasons, ["source_rights_unverified", "narration_is_analysis"]);
    assert.match(job.qualityWarnings.join("；"), /完全原创补救/);
    assert.doesNotMatch(persisted[0].recovered.originality.originalVoiceover, /我怕你/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("网页真实错误持久化 needs_attention，同素材去重且 resume 从原断点继续", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-creative-attention-"));
  const filePath = join(root, "jobs.json");
  let analyzeCalls = 0;
  const analyze = async () => {
    analyzeCalls += 1;
    return { remakePlan: { seedanceWorkflow: validWorkflow(2, 20) } };
  };
  try {
    const queue = new CreativeQueue({ filePath, analyze });
    await queue.init();
    const created = await queue.create({ assetId: "asset-attention", title: "GPT 失败断点" });
    await waitFor(async () => (await queue.list())[0]?.status === "ready_for_images");

    const blocked = await queue.attention(created.job.id, { error: "GPT 登录已失效" });
    assert.equal(blocked.status, "needs_attention");
    assert.equal(blocked.resumeStatus, "ready_for_images");
    assert.equal(blocked.error, "GPT 登录已失效");
    assert.equal(blocked.attentionTransient, false);
    assert.ok(blocked.attentionAt);

    const duplicate = await queue.create({ assetId: "asset-attention", title: "不应新建" });
    assert.equal(duplicate.deduplicated, true);
    assert.equal(duplicate.job.id, created.job.id);
    assert.equal((await queue.list()).length, 1);

    const persisted = JSON.parse(await readFile(filePath, "utf8"));
    assert.equal(persisted[0].status, "needs_attention");
    assert.equal(persisted[0].error, "GPT 登录已失效");

    // 模拟本地节点重启：needs_attention 不能像 preparing 一样被偷偷重置。
    const restarted = new CreativeQueue({ filePath, analyze });
    await restarted.init();
    assert.equal((await restarted.list())[0].status, "needs_attention");

    const resumed = await restarted.resume(created.job.id);
    assert.equal(resumed.status, "ready_for_images");
    assert.equal(resumed.error, null);
    assert.equal(resumed.resumeStatus, null);
    assert.equal(analyzeCalls, 1, "恢复 GPT 断点不应重跑分析或新建生成任务");
    await restarted.advance(created.job.id, "images_ready");
    assert.equal((await restarted.list())[0].status, "ready_for_seedance");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("网页短暂 busy 显示 transient_wait 和 nextRetryAt，到期只恢复原断点", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-creative-transient-"));
  let analyzeCalls = 0;
  try {
    const queue = new CreativeQueue({
      filePath: join(root, "jobs.json"),
      analyze: async () => {
        analyzeCalls += 1;
        return { remakePlan: { seedanceWorkflow: validWorkflow(1, 10) } };
      },
    });
    await queue.init();
    const created = await queue.create({ assetId: "asset-transient", title: "按钮忙碌" });
    await waitFor(async () => (await queue.list())[0]?.status === "ready_for_images");
    const nextRetryAt = new Date(Date.now() + 80).toISOString();
    const waiting = await queue.attention(created.job.id, {
      error: "GPT 仍在生成，发送按钮尚未恢复",
      transient: true,
      nextRetryAt,
    });
    assert.equal(waiting.status, "transient_wait");
    assert.equal(waiting.resumeStatus, "ready_for_images");
    assert.equal(waiting.attentionTransient, true);
    assert.equal(waiting.nextRetryAt, nextRetryAt);
    assert.equal(waiting.transientRetryCount, 1);
    assert.match(waiting.error, /按钮尚未恢复/);

    const duplicate = await queue.create({ assetId: "asset-transient", title: "不重复" });
    assert.equal(duplicate.deduplicated, true);
    const restored = await waitFor(async () => {
      const row = (await queue.list())[0];
      return row?.status === "ready_for_images" ? row : null;
    });
    assert.equal(restored.error, null);
    assert.equal(restored.nextRetryAt, null);
    assert.equal(restored.resumeStatus, null);
    assert.equal(restored.transientRetryCount, 1, "计时器恢复必须保留连续重试次数");
    assert.equal(analyzeCalls, 1, "短重试到期只重新暴露断点，不能重跑分析/重复生图");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("网页 busy 连续三次后停止自动唤醒，用户 resume 才重置次数", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-creative-transient-cap-"));
  try {
    const queue = new CreativeQueue({
      filePath: join(root, "jobs.json"),
      analyze: async () => ({ remakePlan: { seedanceWorkflow: validWorkflow(1, 10) } }),
    });
    await queue.init();
    const created = await queue.create({ assetId: "asset-transient-cap", title: "有界短重试" });
    await waitFor(async () => (await queue.list())[0]?.status === "ready_for_images");

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      const waiting = await queue.attention(created.job.id, {
        error: `GPT busy ${attempt}`,
        transient: true,
        nextRetryAt: new Date(Date.now() + 40).toISOString(),
      });
      assert.equal(waiting.status, "transient_wait");
      assert.equal(waiting.transientRetryCount, attempt);
      await waitFor(async () => (await queue.list())[0]?.status === "ready_for_images");
    }

    const blocked = await queue.attention(created.job.id, {
      error: "GPT busy 3",
      transient: true,
      nextRetryAt: new Date(Date.now() + 40).toISOString(),
    });
    assert.equal(blocked.status, "needs_attention");
    assert.equal(blocked.attentionTransient, false);
    assert.equal(blocked.nextRetryAt, null);
    assert.equal(blocked.transientRetryCount, 3);
    assert.match(blocked.error, /连续 3 次短重试未恢复/);
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal((await queue.list())[0].status, "needs_attention", "达到阈值后不得被旧计时器恢复");

    const resumed = await queue.resume(created.job.id);
    assert.equal(resumed.status, "ready_for_images");
    assert.equal(resumed.transientRetryCount, 0);
    const retried = await queue.attention(created.job.id, {
      error: "用户显式重试后仍 busy",
      transient: true,
      nextRetryAt: new Date(Date.now() + 60_000).toISOString(),
    });
    assert.equal(retried.status, "transient_wait");
    assert.equal(retried.transientRetryCount, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transient_wait 期间收到成功 advance 可立即推进并清除错误", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-creative-transient-advance-"));
  try {
    const queue = new CreativeQueue({
      filePath: join(root, "jobs.json"),
      analyze: async () => ({ remakePlan: { seedanceWorkflow: validWorkflow(1, 10) } }),
    });
    await queue.init();
    const created = await queue.create({ assetId: "asset-transient-advance", title: "短重试成功" });
    await waitFor(async () => (await queue.list())[0]?.status === "ready_for_images");
    await queue.attention(created.job.id, {
      error: "GPT busy",
      transient: true,
      nextRetryAt: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    const advanced = await queue.advance(created.job.id, "images_ready");
    assert.equal(advanced.status, "ready_for_seedance");
    assert.equal(advanced.error, null);
    assert.equal(advanced.nextRetryAt, null);
    assert.equal(advanced.attentionTransient, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("进程重启后 transient_wait 保留可见错误并按原时间恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-creative-transient-restart-"));
  const filePath = join(root, "jobs.json");
  let analyzeCalls = 0;
  try {
    const nextRetryAt = new Date(Date.now() + 100).toISOString();
    await import("node:fs/promises").then(({ writeFile }) => writeFile(filePath, JSON.stringify([{
      id: "creative-transient-restart",
      assetId: "asset-transient-restart",
      title: "重启后恢复",
      status: "transient_wait",
      resumeStatus: "ready_for_seedance",
      stage: "seedance",
      progress: 65,
      error: "豆包页面短暂忙碌",
      attentionTransient: true,
      nextRetryAt,
      createdAt: "2026-08-28T00:00:00.000Z",
      updatedAt: "2026-08-28T00:00:01.000Z",
    }])));
    const queue = new CreativeQueue({
      filePath,
      analyze: async () => { analyzeCalls += 1; return { remakePlan: { seedanceWorkflow: validWorkflow() } }; },
    });
    await queue.init();
    const waiting = (await queue.list())[0];
    assert.equal(waiting.status, "transient_wait");
    assert.equal(waiting.error, "豆包页面短暂忙碌");
    assert.equal(waiting.nextRetryAt, nextRetryAt);
    const restored = await waitFor(async () => {
      const row = (await queue.list())[0];
      return row.status === "ready_for_seedance" ? row : null;
    });
    assert.equal(restored.stage, "seedance");
    assert.equal(restored.error, null);
    assert.equal(analyzeCalls, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
