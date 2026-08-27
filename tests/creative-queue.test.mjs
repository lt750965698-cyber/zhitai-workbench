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

async function waitFor(check, timeoutMs = 1500) {
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
