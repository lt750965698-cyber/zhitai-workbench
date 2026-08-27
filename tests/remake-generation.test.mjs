import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getVideoDetail, openKbDb, persistRemakeGeneration, persistZhitaiGeneration } from "../local-agent/kb.mjs";

const testsDir = dirname(fileURLToPath(import.meta.url));
const TEST_MP4 = join(testsDir, "fixtures", "media", "sample-faststart.mp4");

test("MoneyPrinterTurbo 成片会复制回原内容包并出现在视频详情", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-remake-"));
  const engineRoot = join(root, "engine");
  const packagePath = join(root, "package");
  const taskId = randomUUID();
  const previousRoot = process.env.ZHITAI_MPT_ROOT;
  await mkdir(join(engineRoot, "storage", "tasks", taskId), { recursive: true });
  await mkdir(packagePath, { recursive: true });
  await copyFile(TEST_MP4, join(engineRoot, "storage", "tasks", taskId, "final-1.mp4"));
  process.env.ZHITAI_MPT_ROOT = engineRoot;
  const db = openKbDb(join(root, "kb.sqlite"));
  try {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO video_asset (id,title,package_path,created_at,updated_at) VALUES (?,?,?,?,?)")
      .run("asset-1", "复刻样例", packagePath, now, now);
    const saved = await persistRemakeGeneration(db, "asset-1", { taskId, subject: "飘窗改造复刻" });
    assert.equal(saved.ok, true);
    assert.ok(saved.sizeBytes > 1_024);
    assert.equal(saved.quality.sourcePreserved, true);
    assert.match(saved.mediaUrl, new RegExp(`/remake-output/moneyprinter-${taskId}\\.mp4$`));
    assert.equal((await readFile(join(packagePath, "remake-output", `moneyprinter-${taskId}.mp4`))).length, saved.sizeBytes);
    const detail = getVideoDetail(db, "asset-1");
    assert.equal(detail.remake_generations.length, 1);
    assert.equal(detail.remake_generations[0].subject, "飘窗改造复刻");
    assert.equal(detail.remake_generations[0].status, "completed");
  } finally {
    db.close();
    if (previousRoot === undefined) delete process.env.ZHITAI_MPT_ROOT;
    else process.env.ZHITAI_MPT_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("复刻成片只接受托管引擎 UUID 任务目录", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-remake-invalid-"));
  const db = openKbDb(join(root, "kb.sqlite"));
  try {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO video_asset (id,title,package_path,created_at,updated_at) VALUES (?,?,?,?,?)")
      .run("asset-1", "复刻样例", root, now, now);
    const result = await persistRemakeGeneration(db, "asset-1", { taskId: "../../outside" });
    assert.equal(result.ok, false);
    assert.equal(result.error, "invalid_task_id");
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("织台 Seedance 成片登记回原内容包并可供发布", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-seedance-generation-"));
  const generationRoot = join(root, "generation");
  const packagePath = join(root, "package");
  const uuid = randomUUID();
  const jobId = `creative_${uuid}`;
  const previousRoot = process.env.ZHITAI_GENERATION_ROOT;
  await mkdir(join(generationRoot, jobId), { recursive: true });
  await mkdir(packagePath, { recursive: true });
  const finalPath = join(generationRoot, jobId, "final.mp4");
  await copyFile(TEST_MP4, finalPath);
  await writeFile(join(generationRoot, jobId, "storyboard-01.png"), Buffer.alloc(2048, 7));
  await writeFile(join(generationRoot, jobId, "run-state.json"), JSON.stringify({ shotIndex: 0 }));
  const finalBytes = await readFile(finalPath);
  await writeFile(join(generationRoot, jobId, "audio-quality.json"), JSON.stringify({
    status: "passed", jobId, meanVolumeDb: -20, maxVolumeDb: -3,
    outputSizeBytes: finalBytes.length,
    outputSha256: createHash("sha256").update(finalBytes).digest("hex"),
  }));
  process.env.ZHITAI_GENERATION_ROOT = generationRoot;
  const db = openKbDb(join(root, "kb.sqlite"));
  try {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO video_asset (id,title,package_path,created_at,updated_at) VALUES (?,?,?,?,?)")
      .run("asset-seedance", "豆包成片", packagePath, now, now);
    const saved = await persistZhitaiGeneration(db, "asset-seedance", { jobId, subject: "无人值守复刻" });
    assert.equal(saved.ok, true);
    assert.equal(saved.quality.sourcePreserved, true);
    assert.match(saved.mediaUrl, new RegExp(`/remake-output/zhitai-${uuid}\\.mp4$`));
    assert.deepEqual(saved.artifacts.sort(), ["audio-quality.json", "run-state.json", "storyboard-01.png"]);
    assert.equal((await readFile(join(packagePath, "remake-output", `zhitai-${uuid}.mp4`))).length, saved.sizeBytes);
    const manifest = JSON.parse(await readFile(join(packagePath, saved.artifactDir, "generation-manifest.json"), "utf8"));
    assert.equal(manifest.jobId, jobId);
    assert.equal(manifest.schemaVersion, 2);
    assert.deepEqual(manifest.artifacts.sort(), ["audio-quality.json", "run-state.json", "storyboard-01.png"]);
    const detail = getVideoDetail(db, "asset-seedance");
    assert.equal(detail.remake_generations[0].engine, "ZhitaiSeedance");
  } finally {
    db.close();
    if (previousRoot === undefined) delete process.env.ZHITAI_GENERATION_ROOT;
    else process.env.ZHITAI_GENERATION_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("织台 Seedance 成片缺少可听音频质检时不得登记", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-seedance-audio-gate-"));
  const generationRoot = join(root, "generation");
  const packagePath = join(root, "package");
  const jobId = `creative_${randomUUID()}`;
  const previousRoot = process.env.ZHITAI_GENERATION_ROOT;
  await mkdir(join(generationRoot, jobId), { recursive: true });
  await mkdir(packagePath, { recursive: true });
  await copyFile(TEST_MP4, join(generationRoot, jobId, "final.mp4"));
  process.env.ZHITAI_GENERATION_ROOT = generationRoot;
  const db = openKbDb(join(root, "kb.sqlite"));
  try {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO video_asset (id,title,package_path,created_at,updated_at) VALUES (?,?,?,?,?)")
      .run("asset-audio-gate", "音频门禁", packagePath, now, now);
    const missing = await persistZhitaiGeneration(db, "asset-audio-gate", { jobId });
    assert.equal(missing.ok, false);
    assert.equal(missing.error, "generated_video_audio_quality_missing");
    await writeFile(join(generationRoot, jobId, "audio-quality.json"), JSON.stringify({ status: "failed", meanVolumeDb: -46, maxVolumeDb: -28 }));
    const failed = await persistZhitaiGeneration(db, "asset-audio-gate", { jobId });
    assert.equal(failed.ok, false);
    assert.equal(failed.error, "generated_video_audio_quality_failed");
  } finally {
    db.close();
    if (previousRoot === undefined) delete process.env.ZHITAI_GENERATION_ROOT;
    else process.env.ZHITAI_GENERATION_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});

test("织台 Seedance 伪 MP4 不得登记为已完成成片", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-seedance-invalid-"));
  const generationRoot = join(root, "generation");
  const packagePath = join(root, "package");
  const jobId = `creative_${randomUUID()}`;
  const previousRoot = process.env.ZHITAI_GENERATION_ROOT;
  await mkdir(join(generationRoot, jobId), { recursive: true });
  await mkdir(packagePath, { recursive: true });
  await writeFile(join(generationRoot, jobId, "final.mp4"), Buffer.alloc(8192, 9));
  process.env.ZHITAI_GENERATION_ROOT = generationRoot;
  const db = openKbDb(join(root, "kb.sqlite"));
  try {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO video_asset (id,title,package_path,created_at,updated_at) VALUES (?,?,?,?,?)")
      .run("asset-invalid", "伪成片", packagePath, now, now);
    const saved = await persistZhitaiGeneration(db, "asset-invalid", { jobId });
    assert.equal(saved.ok, false);
    assert.match(saved.error, /^generated_video_(?:encrypted|invalid|audio_quality_(?:missing|failed))$/);
    assert.equal(getVideoDetail(db, "asset-invalid").remake_generations.length, 0);
  } finally {
    db.close();
    if (previousRoot === undefined) delete process.env.ZHITAI_GENERATION_ROOT;
    else process.env.ZHITAI_GENERATION_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
