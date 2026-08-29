import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getVideoDetail,
  localMotionGenerationProvenanceSha256,
  localMotionManifestSha256,
  localMotionStoryboardFingerprint,
  openKbDb,
  persistRemakeGeneration,
  persistZhitaiGeneration,
  strictWorkflowSha256,
  validateLocalMotionManifestBundle,
} from "../local-agent/kb.mjs";
import { writeSyntheticMp4 } from "./fixtures/synthetic-mp4.mjs";

test("MoneyPrinterTurbo 成片会复制回原内容包并出现在视频详情", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-remake-"));
  const engineRoot = join(root, "engine");
  const packagePath = join(root, "package");
  const taskId = randomUUID();
  const previousRoot = process.env.ZHITAI_MPT_ROOT;
  await mkdir(join(engineRoot, "storage", "tasks", taskId), { recursive: true });
  await mkdir(packagePath, { recursive: true });
  await writeSyntheticMp4(join(engineRoot, "storage", "tasks", taskId, "final-1.mp4"), {
    marker: "moneyprinter-generation",
    payloadBytes: 128 * 1024,
  });
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
  await writeSyntheticMp4(finalPath, { marker: "zhitai-seedance-generation", payloadBytes: 128 * 1024 });
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
    assert.equal(manifest.schemaVersion, 3);
    assert.equal(manifest.engine, "ZhitaiSeedance");
    assert.equal(manifest.evidenceMode, "seedance_web_generation");
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
  await writeSyntheticMp4(join(generationRoot, jobId, "final.mp4"), {
    marker: "zhitai-seedance-audio-gate",
    payloadBytes: 128 * 1024,
  });
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

test("LocalMotion 只能从通过哈希、分镜、片段、帧率和旁白完整性校验的 manifest 登记", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-local-motion-generation-"));
  const generationRoot = join(root, "generation");
  const packagePath = join(root, "package");
  const uuid = randomUUID();
  const jobId = `creative_${uuid}`;
  const assetId = "asset-local-motion";
  const outputDir = join(generationRoot, jobId);
  const previousRoot = process.env.ZHITAI_GENERATION_ROOT;
  await mkdir(outputDir, { recursive: true });
  await mkdir(packagePath, { recursive: true });
  const finalPath = join(outputDir, "final.mp4");
  await writeSyntheticMp4(finalPath, { marker: "local-motion-generation", payloadBytes: 128 * 1024 });
  await writeFile(join(outputDir, "final.visual.mp4"), Buffer.alloc(4_096, 6));
  const finalBytes = await readFile(finalPath);
  const finalSha256 = createHash("sha256").update(finalBytes).digest("hex");
  const narration = "小户型卫生间先排好四区动线，再用壁龛和侧柜收纳。";
  const audioReport = {
    status: "passed", jobId, meanVolumeDb: -20, maxVolumeDb: -3,
    narration,
    narrationComplete: true,
    narrationSha256: createHash("sha256").update(narration).digest("hex"),
    narrationDurationMs: 6_000,
    finalDurationMs: 25_000,
    outputDurationMs: 25_000,
    timingVerified: true,
    outputSizeBytes: finalBytes.length,
    outputSha256: finalSha256,
  };
  await writeFile(join(outputDir, "audio-quality.json"), `${JSON.stringify(audioReport)}\n`);
  const storyboards = [];
  const segments = [];
  for (let index = 1; index <= 3; index += 1) {
    const storyboardName = `storyboard-${String(index).padStart(2, "0")}.png`;
    const clipName = `clip-${String(index).padStart(2, "0")}.mp4`;
    const storyboardBytes = Buffer.alloc(2_000 + index, index);
    const clipBytes = Buffer.alloc(3_000 + index, index + 10);
    await writeFile(join(outputDir, storyboardName), storyboardBytes);
    await writeFile(join(outputDir, clipName), clipBytes);
    const storyboardSha256 = createHash("sha256").update(storyboardBytes).digest("hex");
    storyboards.push({
      index, name: storyboardName, sizeBytes: storyboardBytes.length,
      sha256: storyboardSha256, width: 1080, height: 1920,
    });
    segments.push({
      index,
      sourceStoryboard: storyboardName,
      sourceStoryboardSha256: storyboardSha256,
      clipName,
      clipSizeBytes: clipBytes.length,
      clipSha256: createHash("sha256").update(clipBytes).digest("hex"),
      width: 1080,
      height: 1920,
      fps: 30,
      frameCount: 250,
      durationMs: index === 3 ? 8_334 : 8_333,
    });
  }
  const visualBytes = await readFile(join(outputDir, "final.visual.mp4"));
  const audioRaw = await readFile(join(outputDir, "audio-quality.json"));
  const workflow = { shotCount: 3, shots: [{}, {}, {}], originality: { policy: "strict_full_original" } };
  const workflowSha256 = strictWorkflowSha256(workflow);
  const manifest = {
    schemaVersion: 1,
    engine: "ZhitaiLocalMotion",
    evidenceMode: "local_storyboard_motion",
    jobId,
    assetId,
    pipelineVersion: "zhitai-local-motion-v1",
    preset: { name: "storyboard-ken-burns-v1" },
    trigger: { code: "DOUBAO_ORPHAN_RECOVERY_EXHAUSTED", attemptNumber: 2, recoveryExhausted: true },
    environment: { ffmpegVersion: "test", ffprobeVersion: "test" },
    storyboards,
    storyboardFingerprint: localMotionStoryboardFingerprint(storyboards),
    segments,
    visualVideo: {
      name: "final.visual.mp4", sizeBytes: visualBytes.length,
      sha256: createHash("sha256").update(visualBytes).digest("hex"),
      width: 1080, height: 1920, fps: 30, totalFrames: 750, durationMs: 25_000,
    },
    finalVideo: {
      name: "final.mp4", sizeBytes: finalBytes.length, sha256: finalSha256,
      width: 1080, height: 1920, fps: 30, totalFrames: 750, durationMs: 25_000,
      audio: { codec: "aac", durationMs: 25_000, narrationComplete: true },
    },
    audioQuality: {
      name: "audio-quality.json", sizeBytes: audioRaw.length,
      sha256: createHash("sha256").update(audioRaw).digest("hex"),
      status: "passed",
      narrationComplete: true,
      narrationSha256: createHash("sha256").update(narration).digest("hex"),
      narrationDurationMs: 6_000,
      finalDurationMs: 25_000,
      meanVolumeDb: -20,
      maxVolumeDb: -3,
    },
    workflow: { sha256: workflowSha256 },
    completedAt: new Date().toISOString(),
  };
  manifest.generationProvenanceSha256 = localMotionGenerationProvenanceSha256(manifest);
  manifest.manifestSha256 = localMotionManifestSha256(manifest);
  await writeFile(join(outputDir, "local-motion-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  process.env.ZHITAI_GENERATION_ROOT = generationRoot;
  const db = openKbDb(join(root, "kb.sqlite"));
  try {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO video_asset (id,title,package_path,created_at,updated_at) VALUES (?,?,?,?,?)")
      .run(assetId, "本地动画成片", packagePath, now, now);
    db.prepare("INSERT INTO remake_plan (asset_id,plan_json,provider,created_at) VALUES (?,?,?,?)")
      .run(assetId, JSON.stringify({ seedanceWorkflow: workflow }), "test", now);
    const verified = await validateLocalMotionManifestBundle({
      bundleDir: outputDir,
      finalPath,
      expectedJobId: jobId,
      expectedAssetId: assetId,
      expectedWorkflowSha256: workflowSha256,
      expectedFinalSizeBytes: finalBytes.length,
      expectedFinalSha256: finalSha256,
    });
    assert.equal(verified.ok, true);
    const saved = await persistZhitaiGeneration(db, assetId, { jobId, subject: "本地动画兜底" });
    assert.equal(saved.ok, true);
    assert.equal(saved.engine, "ZhitaiLocalMotion");
    assert.equal(saved.localMotionEvidence.manifestSha256, manifest.manifestSha256);
    assert.equal(getVideoDetail(db, assetId).remake_generations[0].engine, "ZhitaiLocalMotion");

    const tampered = structuredClone(manifest);
    tampered.segments[0].clipSha256 = "0".repeat(64);
    tampered.generationProvenanceSha256 = localMotionGenerationProvenanceSha256(tampered);
    tampered.manifestSha256 = localMotionManifestSha256(tampered);
    await writeFile(join(outputDir, "local-motion-manifest.json"), `${JSON.stringify(tampered)}\n`);
    const rejected = await validateLocalMotionManifestBundle({ bundleDir: outputDir, finalPath });
    assert.equal(rejected.ok, false);
    assert.match(rejected.reason, /local_motion_file_binding_mismatch/);
  } finally {
    db.close();
    if (previousRoot === undefined) delete process.env.ZHITAI_GENERATION_ROOT;
    else process.env.ZHITAI_GENERATION_ROOT = previousRoot;
    await rm(root, { recursive: true, force: true });
  }
});
