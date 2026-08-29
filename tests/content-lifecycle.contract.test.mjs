import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CONTENT_LIFECYCLE_STAGES,
  LIFECYCLE_STATE_MACHINES,
  assertLifecycleTransition,
  lifecycleIdempotencyKey,
  lifecyclePayloadFingerprint,
  lifecycleTransitionDecision,
  publishFailureDisposition,
  publicationOutcome,
  validateLifecycleSnapshot,
} from "../local-agent/content-lifecycle.mjs";
import {
  classifyMatrixPublishResult,
  publishAccountFingerprint,
  publishReceiptDedupeKey,
} from "../local-agent/matrixmedia-adapter.mjs";
import { CreativeQueue } from "../local-agent/creative-queue.mjs";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const NOW = "2026-08-27T12:00:00.000Z";

function codes(report) {
  return new Set(report.issues.map((row) => row.code));
}

function publicReceipt(overrides = {}) {
  return {
    state: "public",
    platform: "xhs",
    accountFingerprint: "acct_1234567890abcdef12345678",
    taskId: "pub-1",
    assetId: "asset-1",
    mediaSha256: SHA_A,
    postId: "post-1",
    readBackAt: NOW,
    visibility: "public",
    source: "platform_history",
    ...overrides,
  };
}

function validCreativeWorkflow() {
  return {
    sourceRights: { status: "owned" },
    targetDurationSeconds: 10,
    shotCount: 1,
    durationStrategy: { missingSignals: [] },
    shots: [{
      index: 1,
      narration: "测试文案",
      gptImagePrompt: "GPT 生图提示词",
      seedancePrompt: "Seedance 视频提示词",
      observedReference: { subject: "测试", setting: "测试场景", evidence: "测试关键帧" },
    }],
  };
}

test("生命周期固定覆盖十二个阶段且顺序不可漂移", () => {
  assert.deepEqual(CONTENT_LIFECYCLE_STAGES, [
    "capture", "download", "ingest", "analyze", "generate", "quality",
    "human_review", "draft", "schedule", "public_readback", "metrics_snapshot", "archive",
  ]);
});

test("规范状态词典覆盖机器状态且转移目标闭合", async () => {
  const doc = await readFile(new URL("../docs/CONTENT_LIFECYCLE.md", import.meta.url), "utf8");
  for (const [machineName, machine] of Object.entries(LIFECYCLE_STATE_MACHINES)) {
    assert.deepEqual(Object.keys(machine.transitions).sort(), [...machine.states].sort(), `${machineName} 每个状态都必须有转移定义`);
    for (const state of machine.states) {
      assert.ok(doc.includes(`\`${state}\``), `${machineName}.${state} 必须出现在规范状态词典`);
      for (const target of machine.transitions[state]) assert.ok(machine.states.includes(target), `${machineName}.${state}->${target} 必须闭合`);
    }
  }
});

test("非法跨级生成转移被拒绝", () => {
  assert.deepEqual(lifecycleTransitionDecision("creative_job", "queued", "ready_for_seedance"), {
    allowed: false,
    code: "illegal_transition",
  });
  assert.throws(() => assertLifecycleTransition("creative_job", "ready_for_images", "completed"), /illegal_transition/);
});

test("失败重试必须显式授权", () => {
  assert.equal(lifecycleTransitionDecision("import_item", "failed", "processing").code, "explicit_retry_required");
  assert.equal(lifecycleTransitionDecision("import_item", "failed", "processing", { explicitRetry: true }).allowed, true);
});

test("历史生成失败可由用户显式恢复原断点或由完整性对账修复", () => {
  for (const target of ["ready_for_images", "ready_for_seedance", "ready_for_assembly"]) {
    assert.equal(
      lifecycleTransitionDecision("creative_job", "failed", target).code,
      "explicit_retry_or_integrity_repair_required",
    );
    assert.equal(lifecycleTransitionDecision("creative_job", "failed", target, { explicitRetry: true }).allowed, true);
    assert.equal(lifecycleTransitionDecision("creative_job", "failed", target, { integrityRepair: true }).allowed, true);
  }
});

test("成功导入倒退只允许完整性修复", () => {
  assert.equal(lifecycleTransitionDecision("import_item", "success", "orphaned").code, "integrity_repair_required");
  assert.equal(lifecycleTransitionDecision("import_item", "success", "orphaned", { integrityRepair: true }).allowed, true);
  assert.equal(lifecycleTransitionDecision("import_item", "success", "processing").allowed, false);
});

test("public 状态必须携带外部证据", () => {
  assert.equal(lifecycleTransitionDecision("publish_task", "submitted_unverified", "public").code, "public_readback_required");
  assert.equal(lifecycleTransitionDecision("publish_task", "submitted_unverified", "public", { externalEvidence: publicReceipt() }).allowed, true);
});

test("needs_reconciliation 只能由人工凭外部证据解决", () => {
  const manualTakeover = { actor: "local-user", reason: "submission_outcome_unknown", claimedAt: NOW, resolvedAt: NOW, resolution: "public" };
  assert.equal(lifecycleTransitionDecision("publish_task", "needs_reconciliation", "public", { externalEvidence: publicReceipt() }).code, "manual_reconciliation_evidence_required");
  assert.equal(lifecycleTransitionDecision("publish_task", "needs_reconciliation", "public", { manualTakeover }).code, "manual_reconciliation_evidence_required");
  assert.equal(lifecycleTransitionDecision("publish_task", "needs_reconciliation", "public", { manualTakeover, externalEvidence: publicReceipt() }).allowed, true);
});

test("陈旧导入与中断生成恢复必须显式携带恢复原因", () => {
  assert.equal(lifecycleTransitionDecision("import_item", "processing", "pending").code, "stale_lease_recovery_required");
  assert.equal(lifecycleTransitionDecision("import_item", "processing", "pending", { staleLeaseRecovery: true }).allowed, true);
  assert.equal(lifecycleTransitionDecision("creative_job", "preparing", "queued").code, "interrupted_recovery_required");
  assert.equal(lifecycleTransitionDecision("creative_job", "preparing", "queued", { interruptedRecovery: true }).allowed, true);
});

test("幂等键与字段顺序无关且不泄漏原始身份", () => {
  const first = lifecycleIdempotencyKey("analyze", { assetId: "kb-1", assetSha256: SHA_A, profileVersion: "v3" });
  const second = lifecycleIdempotencyKey("analyze", { profileVersion: "v3", assetSha256: SHA_A, assetId: "kb-1" });
  assert.equal(first, second);
  assert.match(first, /^lc:analyze:v1:[a-f0-9]{64}$/);
  assert.equal(first.includes("kb-1"), false);
});

test("不同阶段和不同排期产生不同幂等键", () => {
  const common = { mediaSha256: SHA_A, revision: "4", destinationsFingerprint: "dest-1" };
  const draft = lifecycleIdempotencyKey("draft", common);
  const scheduleA = lifecycleIdempotencyKey("schedule", { ...common, scheduledAt: "2026-08-28T10:00:00+08:00" });
  const scheduleB = lifecycleIdempotencyKey("schedule", { ...common, scheduledAt: "2026-08-29T10:00:00+08:00" });
  assert.notEqual(draft, scheduleA);
  assert.notEqual(scheduleA, scheduleB);
});

test("幂等身份缺字段或带凭据时失败关闭", () => {
  assert.throws(() => lifecycleIdempotencyKey("metrics_snapshot", { platform: "xhs", contentId: "post-1" }), /identity_incomplete/);
  assert.throws(() => lifecycleIdempotencyKey("capture", { sourceKey: "stable", accessToken: "secret" }), /sensitive_lifecycle_identity_forbidden/);
  assert.throws(() => lifecycleIdempotencyKey("public_readback", { platform: "xhs", accountFingerprint: "acct", postId: "p", phone: "13800138000" }), /sensitive_lifecycle_identity_forbidden/);
});

test("相同幂等键不同载荷必须报告冲突", () => {
  const report = validateLifecycleSnapshot({
    idempotencyRecords: [
      { key: "same", payloadFingerprint: lifecyclePayloadFingerprint({ title: "A" }) },
      { key: "same", payloadFingerprint: lifecyclePayloadFingerprint({ title: "B" }) },
    ],
  });
  assert.equal(report.ok, false);
  assert.ok(codes(report).has("IDEMPOTENCY_KEY_REUSE_CONFLICT"));
});

test("HTTP 2xx 不能证明业务成功", () => {
  const report = validateLifecycleSnapshot({ claimBusinessSuccess: true, transport: { httpStatus: 200 } });
  assert.ok(codes(report).has("BUSINESS_SUCCESS_WITHOUT_READBACK"));
});

test("进程存活和退出码 0 不能证明业务成功", () => {
  const report = validateLifecycleSnapshot({ claimBusinessSuccess: true, transport: { processAlive: true, exitCode: 0 } });
  assert.ok(codes(report).has("BUSINESS_SUCCESS_WITHOUT_READBACK"));
});

test("本地排期不能证明业务成功", () => {
  const outcome = publicationOutcome({ intent: "public", receipts: [{ state: "scheduled" }] });
  assert.equal(outcome.businessSuccess, false);
  assert.equal(outcome.status, "submitted_unverified");
});

test("适配器 submitted 不能证明业务成功", () => {
  const outcome = publicationOutcome({ intent: "public", receipts: [{ state: "submitted", platform: "xhs" }] });
  assert.equal(outcome.businessSuccess, false);
  assert.equal(outcome.status, "submitted_unverified");
});

test("只有逐目标公开回读才是公开完成", () => {
  const outcome = publicationOutcome({ intent: "public", receipts: [
    publicReceipt(),
    publicReceipt({ platform: "sph", postId: "post-2" }),
  ] });
  assert.deepEqual(outcome, { status: "public", businessSuccess: true, complete: true });
});

test("public 字样缺平台内容身份或回读时间仍不算完成", () => {
  assert.equal(publicationOutcome({ intent: "public", receipts: [publicReceipt({ postId: null })] }).businessSuccess, false);
  assert.equal(publicationOutcome({ intent: "public", receipts: [publicReceipt({ readBackAt: null })] }).businessSuccess, false);
  assert.equal(publicationOutcome({ intent: "public", receipts: [publicReceipt({ accountFingerprint: null })] }).businessSuccess, false);
});

test("适配器即时结果、私网 URL 与未绑定回执永远不能证明公开", () => {
  assert.equal(publicationOutcome({ intent: "public", receipts: [publicReceipt({ source: "adapter_submission" })] }).businessSuccess, false);
  assert.equal(publicationOutcome({ intent: "public", receipts: [publicReceipt({ postId: null, resultUrl: "https://127.0.0.1/callback" })] }).businessSuccess, false);
  assert.equal(publicationOutcome({ intent: "public", receipts: [publicReceipt({ taskId: null, attemptId: null })] }).businessSuccess, false);
  assert.equal(publicationOutcome({ intent: "public", receipts: [publicReceipt({ assetId: null, mediaSha256: null })] }).businessSuccess, false);
});

test("公开回读必须覆盖预期目标且同一目标不能重复占位", () => {
  const receipts = [publicReceipt(), publicReceipt({ platform: "sph", accountFingerprint: "acct_abcdefabcdefabcdefabcdef", postId: "post-2" })];
  assert.equal(publicationOutcome({ intent: "public", receipts, targets: ["xhs", "sph"] }).businessSuccess, true);
  assert.equal(publicationOutcome({ intent: "public", receipts: [receipts[0]], targets: ["xhs", "sph"] }).businessSuccess, false);
  assert.equal(publicationOutcome({ intent: "public", receipts: [receipts[0], { ...receipts[0], postId: "post-3" }] }).businessSuccess, false);
});

test("多平台部分失败不能聚合成公开完成", () => {
  const outcome = publicationOutcome({ intent: "public", receipts: [publicReceipt(), { state: "failed", platform: "sph" }] });
  assert.equal(outcome.businessSuccess, false);
  assert.equal(outcome.status, "needs_attention");
});

test("公开意图降级成平台草稿是需处理而非成功", () => {
  const outcome = publicationOutcome({ intent: "public", receipts: [{ state: "draft", platform: "xhs", taskId: "draft-1" }] });
  assert.equal(outcome.businessSuccess, false);
  assert.equal(outcome.status, "needs_attention");
});

test("success 导入缺资产、SHA 或文件校验会被验证器捕获", () => {
  const report = validateLifecycleSnapshot({
    importItem: { status: "success", asset_id: "kb-1" },
    asset: { id: "kb-1", media_validation: "ok", fileVerified: false },
  });
  const found = codes(report);
  assert.ok(found.has("INGEST_SUCCESS_SHA256_MISSING"));
  assert.ok(found.has("INGEST_SUCCESS_FILE_UNVERIFIED"));
});

test("成功导入项与被验证资产必须是同一个 ID", () => {
  const report = validateLifecycleSnapshot({
    importItem: { status: "success", asset_id: "asset-a" },
    asset: { id: "asset-b", sha256: SHA_A, media_validation: "ok", fileVerified: true },
  });
  assert.ok(codes(report).has("INGEST_SUCCESS_ASSET_MISMATCH"));
});

test("duplicate/linked 也必须绑定真实资产", () => {
  for (const status of ["duplicate", "linked"]) {
    const report = validateLifecycleSnapshot({ importItem: { status }, asset: null });
    assert.ok(codes(report).has("INGEST_SUCCESS_ASSET_MISSING"));
  }
});

test("download receipt 标 ok 时必须有 SHA 与完成时间", () => {
  const report = validateLifecycleSnapshot({ downloadReceipts: [{ media_validation: "ok" }] });
  assert.ok(codes(report).has("DOWNLOAD_OK_SHA256_MISSING"));
  assert.ok(codes(report).has("DOWNLOAD_OK_COMPLETED_AT_MISSING"));
});

test("available 分析必须有来源和时间", () => {
  const report = validateLifecycleSnapshot({ analysis: { transcript: { status: "available", text: "hello" } } });
  assert.ok(codes(report).has("ANALYSIS_SOURCE_MISSING"));
  assert.ok(codes(report).has("ANALYSIS_TIME_MISSING"));
});

test("unavailable 分析必须说明不可用原因", () => {
  const report = validateLifecycleSnapshot({ analysis: { ocr: { status: "unavailable" } } });
  assert.ok(codes(report).has("ANALYSIS_UNAVAILABLE_REASON_MISSING"));
});

test("创作队列 completed 必须有同资产、文件和 SHA 的 generation", () => {
  const missing = validateLifecycleSnapshot({ creativeJob: { status: "completed", assetId: "kb-1" } });
  assert.ok(codes(missing).has("GENERATION_RECORD_MISSING"));
  const mismatch = validateLifecycleSnapshot({
    creativeJob: { status: "completed", assetId: "kb-1" },
    generation: { id: "g-1", status: "completed", asset_id: "kb-2", sha256: SHA_A, fileVerified: true },
  });
  assert.ok(codes(mismatch).has("GENERATION_ASSET_MISMATCH"));
});

test("创作完成必须绑定相同 generation ID、媒体校验和质检", () => {
  const report = validateLifecycleSnapshot({
    creativeJob: { status: "completed", assetId: "asset-1", generationId: "generation-a" },
    generation: { id: "generation-b", status: "completed", asset_id: "asset-1", sha256: SHA_A, fileVerified: true, mediaValidation: "invalid" },
  });
  const found = codes(report);
  assert.ok(found.has("GENERATION_ID_MISMATCH"));
  assert.ok(found.has("GENERATION_MEDIA_UNVERIFIED"));
  assert.ok(found.has("GENERATION_QUALITY_MISSING"));
});

test("blocked 质检禁止进入任何外部发布尝试", () => {
  const report = validateLifecycleSnapshot({
    quality: { state: "blocked" },
    publishTask: { status: "queued", mode: "platform_draft" },
  });
  assert.ok(codes(report).has("QUALITY_BLOCKED_EXTERNAL_ATTEMPT"));
});

test("人工批准必须绑定当前媒体 SHA", () => {
  const report = validateLifecycleSnapshot({
    selectedMediaSha256: SHA_B,
    publishTask: { status: "queued", mode: "publish" },
    humanReview: { approved: true, approvedAt: NOW, reviewer: "local-user", artifactSha256: SHA_A },
  });
  assert.ok(codes(report).has("PUBLIC_REVIEW_EVIDENCE_MISSING"));
});

test("到期排期不能继续停留 scheduled", () => {
  const report = validateLifecycleSnapshot({
    publishTask: { status: "scheduled", mode: "publish", scheduledAt: "2026-08-27T11:59:59.000Z" },
  }, { now: NOW });
  assert.ok(codes(report).has("SCHEDULE_ELAPSED"));
});

test("submitted 未回读时不能显示 100%", () => {
  const report = validateLifecycleSnapshot({ publishTask: { status: "submitted_unverified", progress: 100, mode: "publish" } });
  assert.ok(codes(report).has("SUBMITTED_PROGRESS_FALSE_COMPLETE"));
});

test("不确定发布状态禁止自动重试", () => {
  const report = validateLifecycleSnapshot({ publishTask: { status: "needs_reconciliation", automaticRetry: true, mode: "publish" } });
  assert.ok(codes(report).has("AMBIGUOUS_PUBLISH_AUTO_RETRY"));
});

test("进入外部提交窗口后的超时、终止和 5xx 必须待对账", () => {
  for (const errorCode of ["adapter_timeout", "adapter_terminated", "upstream_timeout", "upstream_500_error", "adapter_exit_1"]) {
    assert.equal(publishFailureDisposition({ externalCallStarted: true, errorCode }), "needs_reconciliation");
  }
  assert.equal(publishFailureDisposition({ externalCallStarted: true, errorCode: "adapter_exit_4" }), "needs_attention");
  assert.equal(publishFailureDisposition({ externalCallStarted: true, errorCode: "adapter_command_not_found" }), "failed");
  assert.equal(publishFailureDisposition({ externalCallStarted: false, errorCode: "asset_changed_since_approval" }), "failed");
});

test("视频号卡片 HTTP 202 只受理，轮询任务成功后才标 reported", async () => {
  const source = await readFile(new URL("../local-agent/zhitai-kuaidian-companion.user.js", import.meta.url), "utf8");
  assert.match(source, /if \(res\.status === 202\)[\s\S]{0,1200}pollUntilTerminal/);
  assert.match(source, /result\.terminal && isReportedSuccess\(result\.status\)[\s\S]{0,200}rememberCardReported/);
  assert.doesNotMatch(source, /if \(res\.status === 202\) \{\s*rememberCardReported/);
});

test("指标快照缺幂等身份字段会失败", () => {
  const report = validateLifecycleSnapshot({ metricSnapshots: [{ asset_id: "kb-1", likes: 10 }] });
  assert.ok(codes(report).has("METRIC_IDENTITY_INCOMPLETE"));
});

test("同一 observation id 的不同载荷会冲突", () => {
  const base = { asset_id: "kb-1", content_id: "post-1", source: "platform", observation_id: "obs-1", captured_at: NOW };
  const report = validateLifecycleSnapshot({ metricSnapshots: [{ ...base, likes: 10 }, { ...base, likes: 11 }] });
  assert.ok(codes(report).has("METRIC_OBSERVATION_CONFLICT"));
});

test("出站指标必须关联已验证公开回执", () => {
  const metric = { asset_id: "asset-1", content_id: "post-missing", source: "platform", observation_id: "obs-1", captured_at: NOW, direction: "outbound" };
  const report = validateLifecycleSnapshot({ metricSnapshots: [metric], platformReceipts: [publicReceipt()] });
  assert.ok(codes(report).has("OUTBOUND_METRIC_WITHOUT_PUBLIC_RECEIPT"));
});

test("有活跃任务时不能归档", () => {
  const report = validateLifecycleSnapshot({
    creativeJob: { status: "preparing" },
    archive: { status: "archived", manifestSha256: SHA_A, archivedAt: NOW, disposition: "no_publish" },
  });
  assert.ok(codes(report).has("ARCHIVE_WITH_ACTIVE_WORK"));
});

test("分析仍在运行、清单不完整或未做恢复验证时不能归档", () => {
  const report = validateLifecycleSnapshot({
    analysisTask: { status: "running" },
    archive: { status: "archived", manifestSha256: SHA_A, archivedAt: NOW, disposition: "no_publish" },
  });
  const found = codes(report);
  assert.ok(found.has("ARCHIVE_WITH_ACTIVE_WORK"));
  assert.ok(found.has("ARCHIVE_RETENTION_CLASS_MISSING"));
  assert.ok(found.has("ARCHIVE_RESTORE_UNVERIFIED"));
  assert.ok(found.has("ARCHIVE_MANIFEST_FILE_INVALID"));
});

test("公开意图未回读时不能最终归档", () => {
  const report = validateLifecycleSnapshot({
    publishTask: { status: "submitted_unverified", mode: "publish" },
    archive: { status: "archived", manifestSha256: SHA_A, archivedAt: NOW },
  });
  assert.ok(codes(report).has("ARCHIVE_PUBLIC_OUTCOME_UNRESOLVED"));
});

test("证据齐全的入库到归档快照满足全部完成不变量", () => {
  const receipt = publicReceipt();
  const report = validateLifecycleSnapshot({
    importItem: { status: "success", asset_id: "asset-1" },
    asset: { id: "asset-1", sha256: SHA_A, media_validation: "ok", fileVerified: true },
    downloadReceipts: [{ media_validation: "ok", sha256: SHA_A, completed_at: NOW }],
    analysis: {
      transcript: { status: "available", provider: "fixture", captured_at: NOW },
      ocr: { status: "unavailable", missingCapability: "ocr_fixture_disabled" },
    },
    creativeJob: { status: "completed", assetId: "asset-1", generationId: "generation-1" },
    generation: { id: "generation-1", status: "completed", asset_id: "asset-1", sha256: SHA_A, fileVerified: true, mediaValidation: "ok" },
    quality: { state: "standard" },
    selectedMediaSha256: SHA_A,
    humanReview: { approved: true, approvedAt: NOW, reviewer: "local-reviewer", artifactSha256: SHA_A },
    publishTask: { id: "pub-1", status: "public", mode: "publish", targets: ["xhs"], progress: 100 },
    platformReceipts: [receipt],
    metricSnapshots: [{ asset_id: "asset-1", content_id: "post-1", source: "platform", observation_id: "obs-1", captured_at: NOW, direction: "outbound" }],
    archive: {
      status: "archived",
      manifestSha256: SHA_B,
      archivedAt: NOW,
      retentionClass: "standard",
      restoreVerified: true,
      manifestFiles: [{ relativePath: "assets/video.mp4", sizeBytes: 1024, sha256: SHA_A, fileVerified: true }],
    },
  });
  assert.equal(report.ok, true, JSON.stringify(report.issues));
});

test("Matrix 普通退出码 0 只分类为 submitted", () => {
  const result = classifyMatrixPublishResult({ code: 0, out: JSON.stringify({ status: "success", message: "accepted" }) }, { mode: "public" });
  assert.equal(result.state, "submitted");
  assert.equal(result.accepted, true);
});

test("Matrix 即使即时输出 published 也只分类 submitted 候选", () => {
  const result = classifyMatrixPublishResult({ code: 0, out: JSON.stringify({ status: "published", postId: "post-1", url: "https://example.com/post-1" }) }, { mode: "public" });
  assert.equal(result.state, "submitted");
  assert.equal(result.adapterReportedState, "public");
  assert.equal(result.postId, "post-1");
  assert.equal(result.resultUrl, "https://example.com/post-1");
});

test("Matrix 候选回执剥离签名 URL、凭据、账号与 HTML", () => {
  const result = classifyMatrixPublishResult({
    code: 0,
    out: JSON.stringify({
      status: "published",
      url: "https://example.com/post-1?access_token=secret#private",
      message: "<b>ok</b> Authorization=Bearer-secret phone +86 138 0013 8000 file=/Users/private/output.json",
    }),
  }, { mode: "public" });
  assert.equal(result.resultUrl, "https://example.com/post-1");
  assert.doesNotMatch(result.platformMessage || "", /secret|138|Users|<b>/i);
  const privateResult = classifyMatrixPublishResult({ code: 0, out: JSON.stringify({ status: "published", url: "http://127.0.0.1/callback?token=x" }) }, { mode: "public" });
  assert.equal(privateResult.resultUrl, undefined);
});

test("Matrix exit 4 对草稿意图可接受，对公开意图不可接受", () => {
  const draft = classifyMatrixPublishResult({ code: 4, out: "saved" }, { mode: "draft" });
  const publicIntent = classifyMatrixPublishResult({ code: 4, out: "saved" }, { mode: "public" });
  assert.equal(draft.state, "submitted");
  assert.equal(draft.accepted, true);
  assert.equal(publicIntent.state, "draft");
  assert.equal(publicIntent.accepted, false);
});

test("发布回执幂等键覆盖平台、账号、媒体、模式和排期", () => {
  const accountFingerprint = publishAccountFingerprint("xhs", { partition: "persist:account-a" });
  const base = { platform: "xhs", accountFingerprint, mediaSha256: SHA_A, mode: "scheduled", scheduledAt: "2026-08-28T10:00:00+08:00" };
  const key = publishReceiptDedupeKey(base);
  for (const change of [
    { platform: "sph" },
    { accountFingerprint: "acct_abcdefabcdefabcdefabcdef" },
    { mediaSha256: SHA_B },
    { mode: "public", scheduledAt: null },
    { scheduledAt: "2026-08-29T10:00:00+08:00" },
  ]) assert.notEqual(publishReceiptDedupeKey({ ...base, ...change }), key);
  assert.match(accountFingerprint, /^acct_[a-f0-9]{24}$/);
  assert.equal(accountFingerprint.includes("account-a"), false);
});

test("CreativeQueue 非法 advance 明确失败且不更新时间戳", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-lifecycle-creative-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const queue = new CreativeQueue({ filePath: join(root, "jobs.json"), analyze: async () => ({ seedanceWorkflow: validCreativeWorkflow() }) });
  await queue.init();
  const created = await queue.create({ assetId: "asset-a", title: "A" });
  let row;
  for (let index = 0; index < 50; index += 1) {
    row = (await queue.list()).find((item) => item.id === created.job.id);
    if (row?.status === "ready_for_images") break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(row?.status, "ready_for_images");
  const before = row.updatedAt;
  let persistCalls = 0;
  await assert.rejects(queue.completeWithPersistence(row.id, async () => {
    persistCalls += 1;
    return { generationId: "should-not-exist", mediaUrl: "/should-not-exist" };
  }), /invalid_creative_transition/);
  assert.equal(persistCalls, 0, "非法 complete 必须在任何文件/SQLite 副作用前失败");
  await assert.rejects(queue.advance(row.id, "complete"), /invalid_creative_transition/);
  const after = (await queue.list()).find((item) => item.id === row.id);
  assert.equal(after.status, "ready_for_images");
  assert.equal(after.updatedAt, before);
  await queue.advance(row.id, "images_ready");
  await queue.advance(row.id, "seedance_ready");
  const completed = await queue.completeWithPersistence(row.id, async () => {
    persistCalls += 1;
    return { generationId: "generation-1", mediaUrl: "/media/generation-1" };
  });
  assert.equal(persistCalls, 1);
  assert.equal(completed.job.status, "completed");
  assert.equal(completed.job.generationId, "generation-1");
});
