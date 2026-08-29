import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const serverSource = await readFile(new URL("../local-agent/server.mjs", import.meta.url), "utf8");

function functionSource(name, nextName) {
  const start = serverSource.indexOf(`async function ${name}`);
  const end = serverSource.indexOf(`\nasync function ${nextName}`, start + 1);
  assert.ok(start >= 0 && end > start, `应能定位 ${name}`);
  return serverSource.slice(start, end);
}

function sourceBetween(startMarker, endMarker) {
  const start = serverSource.indexOf(startMarker);
  const end = serverSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `应能定位 ${startMarker}`);
  return serverSource.slice(start, end);
}

test("生成完成后只走严格机器预检和织台自主内容审核", () => {
  const review = functionSource("autonomouslyReviewCreativeOutput", "reassessPendingCreativeReviews");
  assert.match(review, /prepareMatrixPublish\(\{/);
  assert.match(review, /skipDestinations:\s*true/);
  assert.match(review, /requireStrictGenerated:\s*true/);
  assert.match(review, /draft:\s*false/);
  assert.match(review, /assessAutonomousContentReview\(\{/);
  assert.match(review, /expectedGenerationTaskId:\s*job\.id/);
  assert.match(review, /verifyGeneratedClipSet\(\{[\s\S]*?jobId:\s*job\.id,[\s\S]*?expectedShotCount/);
  assert.match(review, /assessment\.evidence\.machine\.generatedClips\s*=\s*generatedClips/);
  assert.match(review, /recordCreativeReview\(\{ job, persistedOutput, title, assessment, machineFeedback \}\)/);

  const routeStart = serverSource.indexOf('if (persistedOutput && job?.status === "completed")');
  const routeEnd = serverSource.indexOf("sendJson(response, 200, { ok: true, job }", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart);
  const completionRoute = serverSource.slice(routeStart, routeEnd);
  assert.match(completionRoute, /autonomouslyReviewCreativeOutput\(\{ job, persistedOutput \}\)/);
  assert.match(completionRoute, /\{ trackBlocker:\s*false \}/);
  assert.doesNotMatch(completionRoute, /sendMedia|回复“选择|没有你的选择/);
});

test("严格预检把已校验音量和实际旁白证据交给自审并持久化", () => {
  assert.match(serverSource, /audioQualityEvidence\s*=\s*\{[\s\S]*?meanVolumeDb:\s*audioGate\.meanVolumeDb,[\s\S]*?maxVolumeDb:\s*audioGate\.maxVolumeDb/);
  assert.match(serverSource, /narration:\s*String\(audioQuality\.narration/);
  assert.match(serverSource, /audioQuality:\s*preparation\.audioQuality/);
  assert.match(serverSource, /existing\.reviewEvidence\s*=\s*assessment\.evidence/);
  assert.match(serverSource, /reviewPolicyVersion:\s*assessment\.policyVersion/);
  assert.match(serverSource, /status:\s*assessment\.status/);
});

test("不合格结论写入机器反馈并进入现有返工队列", () => {
  const enqueue = functionSource("enqueueAutonomousRevision", "autonomouslyReviewCreativeOutput");
  assert.match(enqueue, /persistAutonomousRevisionRequest\(review\.assetId, feedback\)/);
  assert.match(enqueue, /creativeQueue\.create\(\{ assetId: review\.assetId, title: review\.title, autoCreated: true \}\)/);
  assert.match(serverSource, /status === "needs_revision"/);
  assert.match(serverSource, /row\.revisionTaskId\s*=\s*created\.job\.id/);
  assert.match(serverSource, /source:\s*"autonomous_review"/);
  const persist = functionSource("persistAutonomousRevisionRequest", "enqueueAutonomousRevision");
  assert.match(persist, /withImmediateTransactionRetry\(db/);
  assert.match(persist, /AND plan_json=\?/);
  assert.doesNotMatch(persist, /catch\s*\{\s*return false/);
  assert.match(enqueue, /if \(!persisted\) throw new Error\("autonomous_revision_plan_not_found"\)/);
});

test("生成片段必须按分镜数齐全、非空且 SHA-256 全部不同", async (t) => {
  const verifierSource = sourceBetween(
    "async function verifyGeneratedClipSet",
    "\nfunction autonomousReviewFeedback",
  );
  const verifyGeneratedClipSet = Function(
    "readdir",
    "stat",
    "join",
    `return (${verifierSource});`,
  )(readdir, stat, join);
  const sandbox = await mkdtemp(join(tmpdir(), "zhitai-review-clips-"));
  const jobId = "creative_11111111-1111-4111-8111-111111111111";
  const outputDir = join(sandbox, jobId);
  const hashFile = async (filePath) => createHash("sha256").update(await readFile(filePath)).digest("hex");
  await mkdir(outputDir, { recursive: true });
  t.after(() => rm(sandbox, { recursive: true, force: true }));

  await Promise.all([
    writeFile(join(outputDir, "clip-01.mp4"), Buffer.from("clip one")),
    writeFile(join(outputDir, "clip-02.mp4"), Buffer.from("clip two")),
    writeFile(join(outputDir, "clip-03.mp4"), Buffer.from("clip three")),
  ]);
  const unique = await verifyGeneratedClipSet({
    jobId,
    expectedShotCount: 3,
    generationRoot: sandbox,
    hashFile,
  });
  assert.equal(unique.passed, true);
  assert.equal(unique.clips.length, 3);
  assert.equal(new Set(unique.clips.map((clip) => clip.sha256)).size, 3);

  await writeFile(join(outputDir, "clip-03.mp4"), Buffer.from("clip two"));
  const duplicate = await verifyGeneratedClipSet({
    jobId,
    expectedShotCount: 3,
    generationRoot: sandbox,
    hashFile,
  });
  assert.equal(duplicate.passed, false);
  assert.equal(duplicate.code, "generated_clip_duplicate");
  assert.match(duplicate.message, /clip-03\.mp4.*clip-02\.mp4.*SHA-256/);

  await rm(join(outputDir, "clip-03.mp4"));
  const missing = await verifyGeneratedClipSet({
    jobId,
    expectedShotCount: 3,
    generationRoot: sandbox,
    hashFile,
  });
  assert.equal(missing.passed, false);
  assert.equal(missing.code, "generated_clip_count_mismatch");
  assert.match(missing.message, /预期 3 段，实际发现 2 段/);

  await writeFile(join(outputDir, "clip-03.mp4"), Buffer.alloc(0));
  const empty = await verifyGeneratedClipSet({
    jobId,
    expectedShotCount: 3,
    generationRoot: sandbox,
    hashFile,
  });
  assert.equal(empty.passed, false);
  assert.equal(empty.code, "generated_clip_empty");

  await writeFile(join(outputDir, "clip-03.mp4"), Buffer.from("clip three"));
  const unreadable = await verifyGeneratedClipSet({
    jobId,
    expectedShotCount: 3,
    generationRoot: sandbox,
    hashFile: async (filePath) => {
      if (filePath.endsWith("clip-02.mp4")) throw new Error("https://secret.example/?token=do-not-log");
      return hashFile(filePath);
    },
  });
  assert.equal(unreadable.passed, false);
  assert.equal(unreadable.code, "generated_clip_read_failed");
  assert.equal(unreadable.message.includes("secret.example"), false);
  assert.equal(unreadable.message.includes("do-not-log"), false);
});

test("旧 pending_review 与过期自主审核逐条严格复审，远程选择命令不能通过旧草稿接口放行", () => {
  const reassess = functionSource("reassessPendingCreativeReviews", "approveCreativeReview");
  assert.match(reassess, /row\.status === "pending_review"/);
  assert.match(reassess, /row\.status === "needs_revision" && !row\.revisionTaskId/);
  assert.match(reassess, /row\.reviewer === AUTONOMOUS_REVIEWER/);
  assert.match(reassess, /row\.reviewPolicyVersion !== AUTONOMOUS_REVIEW_POLICY_VERSION/);
  assert.match(reassess, /row\.reviewPolicyVersion !== AUTONOMOUS_REVIEW_POLICY_VERSION[\s\S]*?&& !row\.revisionTaskId/);
  assert.match(reassess, /row\.status === "approved_for_publish"[\s\S]*?generatedClips\?\.passed !== true/);
  assert.match(reassess, /await startupLibraryMigration/);
  assert.match(reassess, /for \(const row of pending\)/);
  assert.match(reassess, /autonomouslyReviewCreativeOutput\(\{/);

  const approve = functionSource("approveCreativeReview", "reviseCreativeReview");
  assert.match(approve, /if \(item\.status === "pending_review"\)/);
  assert.match(approve, /autonomouslyReviewCreativeOutput\(\{/);
  assert.match(approve, /不能由旧选择命令放行/);
  assert.doesNotMatch(approve, /createPublishTask|platform_draft/);
});

test("人工返工创建任务后持久化任务绑定和去重结果", () => {
  const revise = sourceBetween(
    "async function reviseCreativeReview",
    "\nfunction canonicalAnalysisAsset",
  );
  const createAt = revise.indexOf("const created = await creativeQueue.create");
  const persistAt = revise.indexOf("row.revisionTaskId = created.job.id");
  const eventAt = revise.indexOf("await recordEvent");
  assert.ok(createAt >= 0 && persistAt > createAt && eventAt > persistAt);
  assert.match(revise, /rows\.find\(\(candidate\) => candidate\.id === target\.id\)/);
  assert.match(revise, /row\.revisionTaskId\s*=\s*created\.job\.id/);
  assert.match(revise, /row\.revisionDeduplicated\s*=\s*created\.deduplicated === true/);
});

test("策略升级可降级旧自主批准，但不会覆盖历史人工批准", () => {
  const record = functionSource("recordCreativeReview", "persistAutonomousRevisionRequest");
  assert.match(record, /existing\.reviewer === AUTONOMOUS_REVIEWER/);
  assert.match(record, /existing\.reviewPolicyVersion !== assessment\.policyVersion/);
  assert.match(record, /&& !outdatedAutonomousReview/);
});

test("启动迁移、GET 复审与手动迁移共用串行屏障", () => {
  assert.match(serverSource, /function serializeLibraryDbWork\(operation\)/);
  assert.match(serverSource, /startupLibraryMigration\s*=\s*queueLibraryMigration\(\)/);
  const reviewWrapper = functionSource("autonomouslyReviewCreativeOutput", "reassessPendingCreativeReviews");
  assert.match(reviewWrapper, /await startupLibraryMigration/);
  assert.match(reviewWrapper, /serializeLibraryDbWork\(\(\) => autonomouslyReviewCreativeOutputUnlocked\(input\)\)/);
  const route = serverSource.slice(
    serverSource.indexOf('requestUrl.pathname === "/api/v1/creative/reviews"'),
    serverSource.indexOf("const creativeReviewAction", serverSource.indexOf('requestUrl.pathname === "/api/v1/creative/reviews"')),
  );
  assert.match(route, /await reassessPendingCreativeReviews\(\)/);
});
