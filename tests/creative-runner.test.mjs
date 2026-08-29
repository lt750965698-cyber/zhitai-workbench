import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import runner from "../desktop/creative-runner.js";

const {
  createCreativeRunner,
  generationReadiness,
  shotPrompts,
  sanitizeId,
  doubaoVideoEntryDecision,
  doubaoResultDownloadDecision,
  doubaoVideoModelResults,
  doubaoVideoModelDecision,
  doubaoUrlResultIdentity,
  selectNewDoubaoResult,
  doubaoInputFingerprint,
  safeDoubaoTimeoutEvidence,
  trustedLegacyDoubaoTimeoutMigration,
  bindLegacyDoubaoAttempt,
  pendingDoubaoSubmission,
  doubaoPendingQuotaFastPathDecision,
  doubaoOrphanRecoveryDecision,
  markDoubaoAttemptOrphaned,
  doubaoClipManifestDecision,
  registerDoubaoClip,
  generateDoubaoClip,
  waitForDoubaoVideo,
  DOUBAO_DUPLICATE_CLIP_CODE,
  DOUBAO_VIDEO_TIMEOUT_CODE,
  DOUBAO_UNEXPECTED_RESULT_CODE,
  DOUBAO_VIDEO_TIMEOUT_UNSAFE_CODE,
  DOUBAO_ORPHAN_RECOVERY_EXHAUSTED_CODE,
  DOUBAO_ALL_ACCOUNTS_QUOTA_EXHAUSTED_CODE,
  GPT_PAGE_BUSY_CODE,
  GPT_IMAGE_TIMEOUT_CODE,
  sendPrompt,
  waitForStableGptImage,
  prepareGptConversation,
  ensureGptStoryboards,
  inspectStoryboard,
  inspectGeneratedClip,
  inspectLocalMotionArtifact,
  writeRunCheckpoint,
  effectiveCreativeStatus,
  canonicalJson,
  LOCAL_MOTION_ENGINE,
  LOCAL_MOTION_SEGMENT_FRAMES,
  LOCAL_MOTION_TOTAL_FRAMES,
  LOCAL_MOTION_DURATION_MS,
  localMotionFallbackEnabled,
  strictOriginalMotionWorkflow,
  exactDoubaoQuotaState,
  safeDoubaoQuotaTimeoutEvidence,
  validatedDoubaoQuotaEvidence,
  collectDoubaoAllAccountsQuotaEvidence,
  doubaoAllAccountsQuotaExhaustedError,
  localMotionFallbackDecision,
  buildLocalMotionTriggerEvidence,
  localMotionResumeDecision,
  localMotionSegmentArgs,
  localMotionProbeDecision,
  validateLocalMotionStoryboards,
  localMotionGenerationProvenanceSha256,
  localMotionManifestSha256,
  generateLocalMotionVisual,
  finalizeLocalMotionManifest,
} = runner;

test("无人值守执行器只接收同时具备 GPT 与 Seedance 提示词的镜头", () => {
  const detail = { remake_plan: { plan: { seedanceWorkflow: { shots: [
    { index: 1, gptImagePrompt: "首帧 A", seedancePrompt: "视频 A", negativePrompt: "不要漂移", durationSeconds: 10 },
    { index: 2, gptImagePrompt: "缺视频提示词" },
    { index: 3, imagePrompt: "首帧 C", videoPrompt: "视频 C", durationSeconds: 18 },
  ] } } } };
  assert.deepEqual(shotPrompts(detail), [
    { index: 1, imagePrompt: "首帧 A", videoPrompt: "视频 A", negativePrompt: "不要漂移", durationSeconds: 10 },
    { index: 3, imagePrompt: "首帧 C", videoPrompt: "视频 C", negativePrompt: "", durationSeconds: 10 },
  ]);
});

test("生成目录 id 不允许路径跳转", () => {
  assert.equal(sanitizeId("../../job:1"), ".._.._job_1");
  assert.equal(sanitizeId("素材-01"), "__-01");
});

test("运行入口严格拒绝而不是替换任务与素材 ID", async () => {
  const creative = createCreativeRunner({ openStudio: () => ({ ok: false }) });
  assert.deepEqual(await creative.run("../../job", "asset-1"), {
    ok: false,
    status: "invalid_scope",
    error: "任务或素材 ID 不符合安全边界",
  });
  assert.equal((await creative.run("job-1", "../asset")).status, "invalid_scope");
});

test("断点使用固定 schema、私有权限和大小上限", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zhitai-checkpoint-security-"));
  const target = join(directory, "run-state.json");
  try {
    await writeRunCheckpoint(target, { jobId: "job-1", assetId: "asset-1", gpt: {} });
    const saved = JSON.parse(await readFile(target, "utf8"));
    assert.equal(saved.schemaVersion, 1);
    assert.equal(saved.jobId, "job-1");
    if (process.platform !== "win32") {
      assert.equal((await stat(directory)).mode & 0o777, 0o700);
      assert.equal((await stat(target)).mode & 0o777, 0o600);
    }
    await assert.rejects(
      () => writeRunCheckpoint(target, { jobId: "../job", assetId: "asset-1" }),
      /jobId_invalid/,
    );
    await assert.rejects(
      () => writeRunCheckpoint(target, {
        jobId: "job-1", assetId: "asset-1", padding: "x".repeat(2 * 1024 * 1024),
      }),
      /run_checkpoint_too_large/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("成片读取拒绝符号链接并从稳定句柄计算 SHA", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "zhitai-clip-security-"));
  const originalPath = join(directory, "clip.mp4");
  const linkPath = join(directory, "linked.mp4");
  const bytes = Buffer.alloc(2_048, 7);
  try {
    await writeFile(originalPath, bytes);
    const metadata = await inspectGeneratedClip(originalPath);
    assert.equal(metadata.sizeBytes, bytes.length);
    assert.equal(metadata.sha256, createHash("sha256").update(bytes).digest("hex"));
    try {
      await symlink(originalPath, linkPath);
    } catch (error) {
      if (process.platform === "win32" && ["EPERM", "EACCES"].includes(error?.code)) {
        t.diagnostic("Windows 未授予符号链接权限，跳过链接断言");
        return;
      }
      throw error;
    }
    assert.equal(await inspectGeneratedClip(linkPath), null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("本地动画探测使用同目录私有快照且 SHA 绑定同一批字节", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zhitai-motion-snapshot-"));
  const sourcePath = join(directory, "final.visual.mp4");
  const original = Buffer.alloc(2_048, 3);
  let snapshotPath = "";
  try {
    await writeFile(sourcePath, original);
    const metadata = await inspectLocalMotionArtifact(sourcePath, {
      expectedFrames: 750,
      expectedDurationMs: 25_000,
      probeVideoImpl: async (target) => {
        snapshotPath = target;
        assert.notEqual(target, sourcePath);
        assert.equal(dirname(target), directory);
        assert.deepEqual(await readFile(target), original);
        await writeFile(sourcePath, Buffer.alloc(2_048, 9));
        return {
          width: 1080, height: 1920, fps: 30, totalFrames: 750, durationMs: 25_000,
          codec: "h264", pixelFormat: "yuv420p", audioCodec: "", audioDurationMs: 0,
        };
      },
    });
    assert.equal(metadata.sha256, createHash("sha256").update(original).digest("hex"));
    await assert.rejects(() => access(snapshotPath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("分镜 ffprobe 只探测已读字节的私有快照", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zhitai-storyboard-snapshot-"));
  const sourcePath = join(directory, "storyboard-01.png");
  const original = Buffer.alloc(2_048, 5);
  let snapshotPath = "";
  try {
    await writeFile(sourcePath, original);
    const metadata = await inspectStoryboard(sourcePath, {
      ffprobePath: "fixture-ffprobe",
      spawnImpl: (_command, args) => {
        snapshotPath = args.at(-1);
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.kill = () => {};
        queueMicrotask(() => {
          readFile(snapshotPath).then((snapshot) => {
            assert.deepEqual(snapshot, original);
            child.stdout.emit("data", Buffer.from(JSON.stringify({
              streams: [{ codec_type: "video", width: 1080, height: 1920 }],
            })));
            child.emit("exit", 0);
          }).catch((error) => child.emit("error", error));
        });
        return child;
      },
    });
    assert.equal(metadata.sha256, createHash("sha256").update(original).digest("hex"));
    assert.equal(metadata.width, 1080);
    await assert.rejects(() => access(snapshotPath));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("豆包成片保存优先使用唯一明确直链且绝不点击预览或播放", () => {
  assert.deepEqual(doubaoResultDownloadDecision({
    controls: [{ domIndex: 0, label: "下载视频", href: "https://example.invalid/result.mp4", visible: true, enabled: true }],
    mediaUrls: [],
  }), { status: "url", url: "https://example.invalid/result.mp4", label: "下载视频" });
  assert.deepEqual(doubaoResultDownloadDecision({
    controls: [
      { domIndex: 0, label: "播放视频", href: "", visible: true, enabled: true },
      { domIndex: 1, label: "保存视频", href: "", visible: true, enabled: true },
    ],
  }), { status: "click", domIndex: 1, label: "保存视频" });
});

test("豆包成片保存遇到多个候选或仅有预览控件时失败关闭", () => {
  assert.equal(doubaoResultDownloadDecision({
    controls: [
      { domIndex: 0, label: "保存", href: "", visible: true, enabled: true },
      { domIndex: 1, label: "下载", href: "", visible: true, enabled: true },
    ],
  }).status, "ambiguous");
  assert.deepEqual(doubaoResultDownloadDecision({
    controls: [{ domIndex: 0, label: "打开预览", href: "", visible: true, enabled: true }],
    mediaUrls: [],
  }), { status: "missing", reason: "未找到唯一明确的视频直链或保存控件" });
});

test("豆包结果卡片 videoModel 只读解析并优先选择 H.264 MP4", () => {
  const encoded = (url) => Buffer.from(url, "utf8").toString("base64");
  const decision = doubaoVideoModelDecision([JSON.stringify({ video_list: {
    video_1: { vtype: "mp4", codec_type: "bytevc1", bitrate: 2_000_000, encryption_method: "", main_url: encoded("https://v1.example.invalid/h265.mp4?sig=1") },
    video_2: { vtype: "mp4", codec_type: "h264", bitrate: 1_500_000, encryption_method: "", main_url: encoded("https://v2.example.invalid/h264.mp4?sig=2") },
  } })]);
  assert.equal(decision.status, "url");
  assert.equal(decision.codec, "h264");
  assert.equal(decision.url, "https://v2.example.invalid/h264.mp4?sig=2");
  assert.equal(doubaoVideoModelDecision([{ video_list: { bad: { main_url: "not-base64" } } }]).status, "missing");
});

test("豆包结果 identity 优先使用 video_id 的哈希且不泄露签名 URL", () => {
  const signedUrl = "https://video.example.invalid/result.mp4?token=secret-signature&expires=999999";
  const encoded = Buffer.from(signedUrl, "utf8").toString("base64");
  const [result] = doubaoVideoModelResults([JSON.stringify({
    video_id: "stable-video-123",
    vid: "lower-priority-id",
    video_list: { video_2: { vtype: "mp4", codec_type: "h264", main_url: encoded } },
  })]);
  assert.match(result.identity, /^video_id:[a-f0-9]{16}$/);
  assert.doesNotMatch(result.identity, /stable-video|secret|token|expires/);
  assert.equal(result.url, signedUrl);

  const fallback = doubaoUrlResultIdentity(signedUrl);
  assert.match(fallback, /^url:[a-f0-9]{16}$/);
  assert.doesNotMatch(fallback, /secret|token|expires/);
  assert.equal(fallback, doubaoUrlResultIdentity("https://video.example.invalid/result.mp4?token=rotated&expires=1"));
});

test("发送前已有的 React videoModel 不会被当作下一镜，只接受新 identity", () => {
  const encoded = (url) => Buffer.from(url, "utf8").toString("base64");
  const oldModel = JSON.stringify({
    video_id: "old-result",
    video_list: { video_2: { vtype: "mp4", codec_type: "h264", main_url: encoded("https://video.example.invalid/old.mp4?sig=old") } },
  });
  const newModel = JSON.stringify({
    video_id: "new-result",
    video_list: { video_2: { vtype: "mp4", codec_type: "h264", main_url: encoded("https://video.example.invalid/new.mp4?sig=new") } },
  });
  const before = doubaoVideoModelResults([oldModel]);
  const after = doubaoVideoModelResults([oldModel, newModel]);
  const baseline = new Set(before.map((entry) => entry.identity));

  assert.equal(selectNewDoubaoResult(before, baseline).status, "waiting");
  const selected = selectNewDoubaoResult(after, baseline);
  assert.equal(selected.status, "ready");
  assert.equal(selected.result.identity, after[1].identity);
  assert.match(selected.result.url, /\/new\.mp4/);
  assert.doesNotMatch(waitForDoubaoVideo.toString(), /downloadFromSaveButton|readyToSave/);
});

test("断点中已记录的 resultIdentity 可精确恢复，不会选其他结果", () => {
  const candidates = [
    { identity: "video_id:1111111111111111", url: "https://video.example.invalid/one.mp4" },
    { identity: "video_id:2222222222222222", url: "https://video.example.invalid/two.mp4" },
  ];
  const decision = selectNewDoubaoResult(candidates, new Set(), "video_id:2222222222222222");
  assert.equal(decision.status, "ready");
  assert.equal(decision.result.identity, "video_id:2222222222222222");
  assert.equal(selectNewDoubaoResult(candidates, new Set(), "video_id:missing0000000").status, "waiting");
});

test("豆包等待超时且本轮没有新 identity 时返回可恢复 transient，不复用旧结果", async () => {
  let now = 0;
  let downloadCalls = 0;
  const events = [];
  const oldResult = {
    identity: "video_id:old0000000000000",
    url: "https://video.example.invalid/old.mp4",
  };
  const window = {
    webContents: {
      getURL: () => "https://www.doubao.com/chat/same-shot",
      executeJavaScript: async () => false,
    },
  };

  await assert.rejects(() => waitForDoubaoVideo(
    window,
    new Set([oldResult.identity]),
    "/tmp/never-download-old.mp4",
    async (_url, event) => { if (event) events.push(event); },
    {
      timeoutMs: 8_000,
      pollMs: 4_000,
      nowImpl: () => now,
      waitImpl: async (milliseconds) => { now += milliseconds; },
      snapshotReader: async () => [oldResult],
      attemptStateReader: async () => ({
        loginRequired: false,
        quotaExhausted: false,
        authorizationRequired: false,
        assistantFinishState: false,
        probeFailed: false,
      }),
      downloadImpl: async () => { downloadCalls += 1; return "/tmp/should-not-exist.mp4"; },
    },
  ), (error) => error.code === DOUBAO_VIDEO_TIMEOUT_CODE
    && error.retryable === true
    && error.noNewResultIdentity === true);

  assert.equal(downloadCalls, 0);
  assert.equal(events.at(-1).type, "result_timeout");
  assert.equal(events.at(-1).noNewResultIdentity, true);
  assert.equal(safeDoubaoTimeoutEvidence(events.at(-1).timeoutEvidence), true);
});

test("零新 identity 但 assistantFinishState 为 unknown 时禁止 transient 与孤儿重提", async () => {
  let now = 0;
  const window = {
    webContents: {
      getURL: () => "https://www.doubao.com/chat/unknown-finish-state",
      executeJavaScript: async () => false,
    },
  };
  await assert.rejects(() => waitForDoubaoVideo(
    window,
    new Set(),
    "/tmp/never-download-unknown.mp4",
    null,
    {
      timeoutMs: 8_000,
      pollMs: 4_000,
      nowImpl: () => now,
      waitImpl: async (milliseconds) => { now += milliseconds; },
      snapshotReader: async () => [],
      attemptStateReader: async () => ({
        loginRequired: false,
        quotaExhausted: false,
        authorizationRequired: false,
        assistantFinishState: "unknown",
        probeFailed: false,
      }),
    },
  ), (error) => error.code === DOUBAO_VIDEO_TIMEOUT_UNSAFE_CODE
    && error.retryable === false
    && error.timeoutEvidence?.assistantFinishState === "unknown");
});

test("等待指定断点 identity 时若出现另一新 identity，停止而不触发 transient 重提", async () => {
  let now = 0;
  let downloadCalls = 0;
  const events = [];
  const oldResult = {
    identity: "video_id:old0000000000000",
    url: "https://video.example.invalid/old.mp4",
  };
  const unexpectedResult = {
    identity: "video_id:other00000000000",
    url: "https://video.example.invalid/other.mp4",
  };
  const window = {
    webContents: {
      getURL: () => "https://www.doubao.com/chat/same-shot",
      executeJavaScript: async () => false,
    },
  };

  await assert.rejects(() => waitForDoubaoVideo(
    window,
    new Set([oldResult.identity]),
    "/tmp/never-download-unexpected.mp4",
    async (_url, event) => { if (event) events.push(event); },
    {
      expectedIdentity: "video_id:expected00000000",
      timeoutMs: 8_000,
      pollMs: 4_000,
      nowImpl: () => now,
      waitImpl: async (milliseconds) => { now += milliseconds; },
      snapshotReader: async () => [oldResult, unexpectedResult],
      attemptStateReader: async () => ({
        loginRequired: false,
        quotaExhausted: false,
        authorizationRequired: false,
        assistantFinishState: false,
        probeFailed: false,
      }),
      downloadImpl: async () => { downloadCalls += 1; return "/tmp/should-not-exist.mp4"; },
    },
  ), (error) => error.code === DOUBAO_UNEXPECTED_RESULT_CODE && error.retryable === false);

  assert.equal(downloadCalls, 0);
  assert.deepEqual(events.at(-1), { type: "unexpected_result", hasNewResultIdentity: true });
});

test("豆包超时断点只恢复同任务、素材、镜头和账号的原提交", () => {
  const inputFingerprint = "f".repeat(64);
  const checkpoint = {
    jobId: "job-timeout",
    assetId: "asset-timeout",
    accountId: "doubao-02",
    shotIndex: 1,
    doubaoUrl: "https://www.doubao.com/chat/same-shot",
    doubao: {
      shots: {
        "2": {
          shotIndex: 2,
          accountId: "doubao-02",
          submittedAt: "2026-08-29T01:00:00.000Z",
          baselineIdentities: ["video_id:old", "video_id:old"],
          resultIdentity: null,
          inputFingerprint,
          attemptNumber: 1,
          sendState: "submitted",
        },
      },
    },
  };
  const query = {
    checkpoint,
    jobId: "job-timeout",
    assetId: "asset-timeout",
    shotIndex: 2,
    shotPosition: 1,
    accountId: "doubao-02",
    inputFingerprint,
  };

  assert.deepEqual(pendingDoubaoSubmission(query), {
    baselineIdentities: ["video_id:old"],
    expectedIdentity: "",
    conversationUrl: "https://www.doubao.com/chat/same-shot",
    submittedAt: "2026-08-29T01:00:00.000Z",
    sendState: "submitted",
    attemptNumber: 1,
    inputFingerprint,
    orphanRecoveryUsed: false,
    zeroIdentityTimeoutCount: 0,
  });
  assert.equal(pendingDoubaoSubmission({ ...query, accountId: "doubao-03" }), null);
  assert.equal(pendingDoubaoSubmission({ ...query, shotIndex: 3 }), null);
  assert.equal(pendingDoubaoSubmission({ ...query, shotPosition: 0 }), null);
  assert.equal(pendingDoubaoSubmission({ ...query, jobId: "other-job" }), null);
  assert.equal(pendingDoubaoSubmission({ ...query, inputFingerprint: "e".repeat(64) }), null);
});

test("完整 quota 超时断点可在 pageMatches 后直接锁定并只读探测，无需再次等待", () => {
  const inputFingerprint = "8".repeat(64);
  const timeoutEvidence = quotaTimeoutEvidenceFixture();
  const checkpoint = {
    jobId: "job-quota-fast",
    assetId: "asset-quota-fast",
    accountId: "account-2",
    shotIndex: 1,
    doubaoUrl: "https://www.doubao.com/chat/quota-fast",
    doubao: { shots: { "2": {
      shotIndex: 2,
      accountId: "account-2",
      inputFingerprint,
      attemptNumber: 1,
      sendState: "submitted",
      submittedAt: "2026-08-29T07:00:00.000Z",
      conversationUrl: "https://www.doubao.com/chat/quota-fast",
      baselineIdentities: ["video_id:old"],
      lastWaitTimedOutAt: "2026-08-29T07:12:00.000Z",
      lastWaitHadNewIdentity: false,
      lastTimeoutEvidence: timeoutEvidence,
      resultIdentity: null,
      resultReadyAt: null,
      outputSha256: null,
      outputSizeBytes: null,
      outputPath: null,
      completedAt: null,
    } } },
  };
  const scope = {
    checkpoint,
    jobId: checkpoint.jobId,
    assetId: checkpoint.assetId,
    shotIndex: 2,
    shotPosition: 1,
    accountId: "account-2",
    inputFingerprint,
  };
  const pendingSubmission = pendingDoubaoSubmission(scope);
  assert.ok(pendingSubmission);
  assert.deepEqual(doubaoPendingQuotaFastPathDecision({
    ...scope,
    pendingSubmission,
    availability: exactQuotaStateFixture(),
  }), {
    action: "lock_and_probe",
    timeoutEvidence,
    availability: exactQuotaStateFixture(),
  });

  const fresh = structuredClone(checkpoint);
  delete fresh.doubao.shots["2"].lastWaitTimedOutAt;
  delete fresh.doubao.shots["2"].lastWaitHadNewIdentity;
  delete fresh.doubao.shots["2"].lastTimeoutEvidence;
  fresh.doubao.shots["2"].lastError = "DOUBAO_ALL_ACCOUNTS_QUOTA_EXHAUSTED: old text only";
  const freshScope = { ...scope, checkpoint: fresh };
  assert.equal(doubaoPendingQuotaFastPathDecision({
    ...freshScope,
    pendingSubmission: pendingDoubaoSubmission(freshScope),
    availability: exactQuotaStateFixture(),
  }).action, "not_applicable", "旧错误文字不能替代结构化等待证据");
});

test("quota 快速恢复对断点缺字段、篡改、unknown 或已有结果全部拒绝", () => {
  const inputFingerprint = "7".repeat(64);
  const checkpoint = {
    jobId: "job-quota-fast-reject",
    assetId: "asset-quota-fast-reject",
    accountId: "account-1",
    shotIndex: 0,
    doubaoUrl: "https://www.doubao.com/chat/quota-fast-reject",
    doubao: { shots: { "1": {
      shotIndex: 1,
      accountId: "account-1",
      inputFingerprint,
      attemptNumber: 1,
      sendState: "submitted",
      submittedAt: "2026-08-29T07:00:00.000Z",
      conversationUrl: "https://www.doubao.com/chat/quota-fast-reject",
      baselineIdentities: [],
      lastWaitTimedOutAt: "2026-08-29T07:12:00.000Z",
      lastWaitHadNewIdentity: false,
      lastTimeoutEvidence: quotaTimeoutEvidenceFixture(),
      resultIdentity: null,
      outputSha256: null,
      outputSizeBytes: null,
      outputPath: null,
      completedAt: null,
    } } },
  };
  const baseScope = {
    jobId: checkpoint.jobId,
    assetId: checkpoint.assetId,
    shotIndex: 1,
    shotPosition: 0,
    accountId: "account-1",
    inputFingerprint,
  };
  const cases = [
    { name: "缺 timestamp", mutate: (copy) => { delete copy.doubao.shots["1"].lastWaitTimedOutAt; } },
    { name: "identity 状态缺失", mutate: (copy) => { delete copy.doubao.shots["1"].lastWaitHadNewIdentity; } },
    { name: "出现新 identity", mutate: (copy) => { copy.doubao.shots["1"].lastWaitHadNewIdentity = true; } },
    { name: "timeout evidence 缺失", mutate: (copy) => { delete copy.doubao.shots["1"].lastTimeoutEvidence; } },
    { name: "timeout evidence 非 quota", mutate: (copy) => { copy.doubao.shots["1"].lastTimeoutEvidence.quotaExhausted = false; } },
    { name: "timeout evidence unknown", mutate: (copy) => { copy.doubao.shots["1"].lastTimeoutEvidence.probeFailed = true; } },
    { name: "已有 result", mutate: (copy) => { copy.doubao.shots["1"].resultIdentity = "video_id:new"; } },
    { name: "已有 output", mutate: (copy) => { copy.doubao.shots["1"].outputSha256 = "a".repeat(64); } },
    { name: "input 被改", mutate: (copy) => { copy.doubao.shots["1"].inputFingerprint = "6".repeat(64); } },
  ];
  for (const { name, mutate } of cases) {
    const copy = structuredClone(checkpoint);
    mutate(copy);
    const originalPending = pendingDoubaoSubmission({ checkpoint, ...baseScope });
    assert.notEqual(doubaoPendingQuotaFastPathDecision({
      checkpoint: copy,
      ...baseScope,
      pendingSubmission: originalPending,
      availability: exactQuotaStateFixture(),
    }).action, "lock_and_probe", name);
  }
  const pendingSubmission = pendingDoubaoSubmission({ checkpoint, ...baseScope });
  for (const availability of [
    exactQuotaStateFixture({ loginRequired: "unknown" }),
    exactQuotaStateFixture({ quotaExhausted: "unknown" }),
    exactQuotaStateFixture({ authorizationRequired: true }),
    exactQuotaStateFixture({ riskBlocked: true }),
    exactQuotaStateFixture({ probeFailed: true }),
  ]) {
    assert.equal(doubaoPendingQuotaFastPathDecision({
      checkpoint,
      ...baseScope,
      pendingSubmission,
      availability,
    }).action, "unsafe");
  }
});

test("豆包 inputFingerprint 同时绑定首帧 SHA、提示词、负面词和时长", () => {
  const input = {
    imageSha256: "a".repeat(64),
    prompt: "保持镜头稳定并缓慢推进",
    negativePrompt: "禁止人物变形",
    durationSeconds: 10,
  };
  const fingerprint = doubaoInputFingerprint(input);
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(doubaoInputFingerprint({ ...input }), fingerprint);
  assert.notEqual(doubaoInputFingerprint({ ...input, imageSha256: "b".repeat(64) }), fingerprint);
  assert.notEqual(doubaoInputFingerprint({ ...input, prompt: `${input.prompt}。` }), fingerprint);
  assert.notEqual(doubaoInputFingerprint({ ...input, durationSeconds: 9 }), fingerprint);
  assert.equal(doubaoInputFingerprint({ ...input, imageSha256: "bad" }), "");
});

test("旧版首轮零 identity 超时断点可一次性绑定当前 fingerprint，并在第二轮安全超时后恢复", () => {
  const inputFingerprint = "c".repeat(64);
  const checkpoint = {
    jobId: "job-legacy-timeout",
    assetId: "asset-legacy-timeout",
    accountId: "account-1",
    shotIndex: 0,
    doubao: { shots: { "1": {
      shotIndex: 1,
      accountId: "account-1",
      conversationUrl: "https://www.doubao.com/chat/legacy-attempt",
      submittedAt: "2030-02-01T00:00:00.000Z",
      baselineIdentities: [],
      lastWaitTimedOutAt: "2030-02-01T00:15:00.000Z",
      lastWaitHadNewIdentity: false,
    } } },
  };
  assert.equal(bindLegacyDoubaoAttempt({
    checkpoint,
    jobId: checkpoint.jobId,
    assetId: checkpoint.assetId,
    shotIndex: 1,
    shotPosition: 0,
    accountId: "account-1",
    inputFingerprint,
  }), true);
  const shot = checkpoint.doubao.shots["1"];
  assert.equal(shot.inputFingerprint, inputFingerprint);
  assert.equal(shot.attemptNumber, 1);
  assert.equal(shot.sendState, "submitted");
  assert.equal(shot.zeroIdentityTimeoutCount, 1);
  assert.equal(shot.timeoutEvidenceHistory[0].legacyCompatibilityMarker, true);

  const timeoutEvidence = {
    noNewResultIdentity: true,
    loginRequired: false,
    quotaExhausted: false,
    authorizationRequired: false,
    assistantFinishState: false,
    probeFailed: false,
  };
  shot.zeroIdentityTimeoutCount = 2;
  shot.timeoutEvidenceHistory.push({
    ...timeoutEvidence,
    attemptNumber: 1,
    inputFingerprint,
    timedOutAt: "2026-08-29T06:00:00.000Z",
  });
  assert.deepEqual(doubaoOrphanRecoveryDecision({
    shot,
    inputFingerprint,
    accountId: "account-1",
    timeoutError: { code: DOUBAO_VIDEO_TIMEOUT_CODE, timeoutEvidence },
    availabilityBefore: { loginRequired: false, quotaExhausted: false },
    availabilityAfter: { loginRequired: false, quotaExhausted: false },
  }), { action: "recover_orphan" });
});

test("显式注入的两轮旧超时 fixture 精确迁移为 count=2，resume 后无需第三轮等待", () => {
  const inputFingerprint = "9".repeat(64);
  const checkpoint = {
    jobId: "creative_11111111-1111-4111-8111-111111111111",
    assetId: "asset-public-fixture",
    accountId: "fixture-account",
    shotIndex: 0,
    doubao: { shots: { "1": {
      shotIndex: 1,
      accountId: "fixture-account",
      submittedAt: "2030-01-01T00:00:00.000Z",
      lastWaitTimedOutAt: "2030-01-01T00:30:00.000Z",
      lastWaitHadNewIdentity: false,
      baselineIdentities: [],
    } } },
  };
  const scope = {
    checkpoint,
    jobId: checkpoint.jobId,
    assetId: checkpoint.assetId,
    shotIndex: 1,
    shotPosition: 0,
    accountId: "fixture-account",
  };
  const migration = trustedLegacyDoubaoTimeoutMigration(scope, [{
    migrationId: "public-test-two-safe-timeouts",
    jobId: checkpoint.jobId,
    assetId: checkpoint.assetId,
    shotIndex: 1,
    shotPosition: 0,
    accountId: "fixture-account",
    submittedAt: "2030-01-01T00:00:00.000Z",
    lastWaitTimedOutAt: "2030-01-01T00:30:00.000Z",
    timeoutCount: 2,
  }]);
  assert.equal(migration?.timeoutCount, 2);
  assert.equal(bindLegacyDoubaoAttempt({
    ...scope,
    inputFingerprint,
    legacyTimeoutCount: migration.timeoutCount,
    legacyTimeoutCountSource: "trusted_runtime_migration",
  }), true);
  const shot = checkpoint.doubao.shots["1"];
  assert.equal(shot.zeroIdentityTimeoutCount, 2);
  assert.equal(shot.timeoutEvidenceHistory.length, 2);
  assert.equal(shot.legacyTimeoutCountSource, "trusted_runtime_migration");

  const timeoutEvidence = {
    noNewResultIdentity: true,
    loginRequired: false,
    quotaExhausted: false,
    authorizationRequired: false,
    assistantFinishState: false,
    probeFailed: false,
  };
  assert.deepEqual(doubaoOrphanRecoveryDecision({
    shot,
    inputFingerprint,
    accountId: "fixture-account",
    timeoutError: { code: DOUBAO_VIDEO_TIMEOUT_CODE, timeoutEvidence },
    availabilityBefore: { loginRequired: false, quotaExhausted: false },
    availabilityAfter: { loginRequired: false, quotaExhausted: false },
  }), { action: "recover_orphan" });
});

test("孤儿恢复先原子封存旧 attempt，再只准备同账号第二 attempt", async () => {
  const inputFingerprint = "d".repeat(64);
  const checkpoint = {
    jobId: "job-orphan",
    assetId: "asset-orphan",
    accountId: "account-2",
    shotIndex: 1,
    submittedAt: "2026-08-29T01:00:00.000Z",
    doubaoUrl: "https://www.doubao.com/chat/old-attempt",
    doubao: {
      jobId: "job-orphan",
      assetId: "asset-orphan",
      shots: { "2": {
        shotIndex: 2,
        accountId: "account-2",
        inputFingerprint,
        attemptNumber: 1,
        sendState: "submitted",
        submittedAt: "2026-08-29T01:00:00.000Z",
        conversationUrl: "https://www.doubao.com/chat/old-attempt",
        baselineIdentities: ["video_id:old"],
        zeroIdentityTimeoutCount: 2,
      } },
    },
  };
  const persisted = [];
  const next = await markDoubaoAttemptOrphaned({
    checkpoint,
    jobId: checkpoint.jobId,
    assetId: checkpoint.assetId,
    shotIndex: 2,
    shotPosition: 1,
    accountId: "account-2",
    inputFingerprint,
    now: "2026-08-29T02:00:00.000Z",
    persist: async (value) => { persisted.push(structuredClone(value)); },
  });
  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0], next);
  assert.equal(checkpoint.doubao.shots["2"].sendState, "submitted", "持久化前不篡改旧内存断点");
  assert.equal(next.doubao.shots["2"].attemptNumber, 2);
  assert.equal(next.doubao.shots["2"].sendState, "preparing_recovery");
  assert.equal(next.doubao.shots["2"].orphanRecoveryUsed, true);
  assert.equal(next.doubao.shots["2"].conversationUrl, "");
  assert.equal(next.doubao.shots["2"].orphanedAttempts[0].sendState, "orphaned");
  assert.equal(next.doubao.shots["2"].orphanedAttempts[0].orphanRecoveryUsed, true);
  assert.equal(next.doubao.shots["2"].orphanedAttempts[0].conversationUrl, "https://www.doubao.com/chat/old-attempt");
  assert.equal(next.doubaoUrl, null);
  assert.equal(next.doubao.conversationResetRequired, true);
});

test("第二 attempt 首次安全超时即 exhausted，禁止第三次和跨账号提交", () => {
  const inputFingerprint = "e".repeat(64);
  const timeoutEvidence = {
    noNewResultIdentity: true,
    loginRequired: false,
    quotaExhausted: false,
    authorizationRequired: false,
    assistantFinishState: false,
    probeFailed: false,
  };
  assert.deepEqual(doubaoOrphanRecoveryDecision({
    shot: {
      accountId: "account-1",
      inputFingerprint,
      attemptNumber: 2,
      orphanRecoveryUsed: true,
      zeroIdentityTimeoutCount: 1,
      timeoutEvidenceHistory: [{ ...timeoutEvidence, attemptNumber: 2, inputFingerprint }],
    },
    inputFingerprint,
    accountId: "account-1",
    timeoutError: { code: DOUBAO_VIDEO_TIMEOUT_CODE, timeoutEvidence },
    availabilityBefore: { loginRequired: false, quotaExhausted: false },
    availabilityAfter: { loginRequired: false, quotaExhausted: false },
  }), { action: "exhausted" });
  assert.equal(DOUBAO_ORPHAN_RECOVERY_EXHAUSTED_CODE, "DOUBAO_ORPHAN_RECOVERY_EXHAUSTED");
});

test("豆包发送前先持久化 sending；sending 写失败或崩溃不得再次点击", async () => {
  const sequence = [];
  const window = { webContents: { getURL: () => "https://www.doubao.com/" } };
  const dependencies = {
    inputFingerprint: "f".repeat(64),
    attemptNumber: 2,
    activateImpl: async () => { sequence.push("activate"); },
    snapshotReader: async () => { sequence.push("snapshot"); return []; },
    attachImpl: async () => { sequence.push("attach"); },
    sendPromptImpl: async () => { sequence.push("send-click"); },
    waitForVideoImpl: async () => { sequence.push("readback"); return { path: "/tmp/result.mp4", resultIdentity: "video_id:new" }; },
  };
  await generateDoubaoClip(window, "/tmp/frame.png", "prompt", "negative", 10, "/tmp/result.mp4", async (_url, event) => {
    sequence.push(`persist-${event.type}`);
  }, dependencies);
  assert.deepEqual(sequence, [
    "activate", "snapshot", "attach", "persist-sending", "send-click", "persist-submitted", "readback",
  ]);

  let clickCalls = 0;
  await assert.rejects(() => generateDoubaoClip(
    window,
    "/tmp/frame.png",
    "prompt",
    "negative",
    10,
    "/tmp/result.mp4",
    async (_url, event) => { if (event.type === "sending") throw new Error("checkpoint write failed"); },
    { ...dependencies, sendPromptImpl: async () => { clickCalls += 1; } },
  ), /checkpoint write failed/);
  assert.equal(clickCalls, 0);

  const sendingCheckpoint = {
    jobId: "job-sending",
    assetId: "asset-sending",
    accountId: "account-1",
    shotIndex: 0,
    doubao: { shots: { "1": {
      shotIndex: 1,
      accountId: "account-1",
      inputFingerprint: "f".repeat(64),
      attemptNumber: 2,
      orphanRecoveryUsed: true,
      sendState: "sending",
      sendingAt: "2026-08-29T03:00:00.000Z",
      submittedAt: null,
      conversationUrl: "https://www.doubao.com/",
      baselineIdentities: [],
    } } },
  };
  assert.equal(pendingDoubaoSubmission({
    checkpoint: sendingCheckpoint,
    jobId: "job-sending",
    assetId: "asset-sending",
    shotIndex: 1,
    shotPosition: 0,
    accountId: "account-1",
    inputFingerprint: "f".repeat(64),
  }).sendState, "sending", "sending 崩溃断点必须走只读回读分支");
});

test("成片 manifest 只复用 identity 和 SHA 都匹配的镜头", () => {
  const metadata = { path: "clip-02.mp4", sizeBytes: 4096, sha256: "b".repeat(64) };
  assert.equal(doubaoClipManifestDecision({
    metadata,
    recorded: { resultIdentity: "video_id:2222", outputSha256: metadata.sha256 },
    previousShots: { "1": { outputSha256: "a".repeat(64) } },
    shotIndex: 2,
  }).status, "reusable");
  assert.equal(doubaoClipManifestDecision({
    metadata,
    recorded: { resultIdentity: "video_id:2222", outputSha256: "c".repeat(64) },
    previousShots: {},
    shotIndex: 2,
  }).status, "untrusted");
  assert.deepEqual(doubaoClipManifestDecision({
    metadata,
    recorded: { resultIdentity: "video_id:2222", outputSha256: metadata.sha256 },
    previousShots: { "1": { outputSha256: metadata.sha256 } },
    shotIndex: 2,
  }), { status: "duplicate", duplicateOfShotIndex: 1 });
});

test("后镜成片 SHA 与前镜重复时删除后镜、记录拒绝 identity 并返回可重试错误", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zhitai-doubao-duplicate-"));
  const target = join(directory, "clip-02.mp4");
  const watermarkedTarget = join(directory, "clip-02.watermarked.mp4");
  const bytes = Buffer.alloc(2_048, 7);
  const outputSha256 = createHash("sha256").update(bytes).digest("hex");
  await Promise.all([writeFile(target, bytes), writeFile(watermarkedTarget, bytes)]);
  const checkpoint = {
    jobId: "job-duplicate-video",
    assetId: "asset-duplicate-video",
    doubao: {
      jobId: "job-duplicate-video",
      assetId: "asset-duplicate-video",
      shots: {
        "1": { resultIdentity: "video_id:first", outputSha256 },
        "2": { resultIdentity: "video_id:second" },
      },
    },
  };
  const writes = [];
  try {
    await assert.rejects(() => registerDoubaoClip({
      checkpoint,
      jobId: checkpoint.jobId,
      assetId: checkpoint.assetId,
      shotIndex: 2,
      target,
      watermarkedTarget,
      resultIdentity: "video_id:second",
      persist: async (state) => { writes.push(structuredClone(state)); },
    }), (error) => error.code === DOUBAO_DUPLICATE_CLIP_CODE && error.retryable === true);
    await assert.rejects(() => access(target));
    await assert.rejects(() => access(watermarkedTarget));
    assert.equal(checkpoint.doubao.shots["2"], undefined);
    assert.equal(checkpoint.doubao.rejectedResults.at(-1).resultIdentity, "video_id:second");
    assert.equal(checkpoint.doubao.rejectedResults.at(-1).outputSha256, outputSha256);
    assert.equal(checkpoint.doubao.rejectedResults.at(-1).duplicateOfShotIndex, 1);
    assert.equal(checkpoint.doubao.conversationResetRequired, true);
    assert.equal(writes.length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("发送提示词绝不退回点击最后一个按钮（避免误触 GPT 语音）", async () => {
  const source = await readFile(new URL("../desktop/creative-runner.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /buttons\.at\(-1\)/);
  assert.match(source, /语音\|voice\|麦克风/);
  assert.match(source, /为避免误触语音已停止/);
  assert.match(source, /editorSelectors\.flatMap/);
  assert.match(source, /maxAttempts = provider === 'gpt' \? 20 : 40/);
  assert.match(source, /authorizationGateOpenedAt/);
  assert.match(source, /等待你确认豆包素材授权超时/);
  assert.match(source, /authorization_required/);
  assert.match(source, /织台已保存断点并继续等待/);
  assert.match(source, /sameCheckpointConversation/);
  assert.match(source, /视频生成已提交/);
  assert.match(source, /checkpointMatches/);
  assert.match(source, /completedDecision\.status === "reusable"/);
  assert.match(source, /baselineIdentities/);
  assert.match(source, /resultIdentity/);
  assert.match(source, /DOUBAO_VIDEO_TIMEOUT_CODE/);
  assert.match(source, /availability\.quotaExhausted && !pendingSubmission/);
  const retryableBlockStart = source.indexOf("const retryableCodes = [");
  const retryableBlock = source.slice(retryableBlockStart, source.indexOf("];", retryableBlockStart) + 2);
  assert.match(retryableBlock, /DOUBAO_VIDEO_TIMEOUT_CODE/);
  assert.doesNotMatch(retryableBlock, /DOUBAO_VIDEO_TIMEOUT_UNSAFE_CODE|DOUBAO_ORPHAN_RECOVERY_EXHAUSTED_CODE/);
  assert.match(source, /\/attention/);
});

test("GPT 只在页面 idle 后写入提示词，不会在 stop 状态留下下一镜草稿", async () => {
  const scripts = [];
  const states = [
    { editorReady: true, editorHasText: false, sendReady: false, stopVisible: true, idleReady: false },
    { editorReady: true, editorHasText: false, sendReady: false, stopVisible: false, idleReady: true },
  ];
  const window = { webContents: { executeJavaScript: async (source) => {
    scripts.push(source);
    if (source.includes("stopVisible")) return states.shift();
    return { ok: true };
  } } };
  await sendPrompt(window, "第三镜独立提示", "gpt", {
    timeoutMs: 1_000,
    pollMs: 500,
    waitImpl: async () => {},
  });
  assert.equal(scripts.length, 3);
  assert.ok(scripts.slice(0, 2).every((source) => !source.includes("第三镜独立提示")));
  assert.match(scripts[2], /第三镜独立提示/);
});

test("GPT 新图 URL 出现后仍等待图片稳定且 stop 消失", async () => {
  const snapshots = [
    { images: ["old", "new"], idleReady: false, editorHasText: false, sendReady: false, stopVisible: true },
    { images: ["old", "new"], idleReady: false, editorHasText: false, sendReady: false, stopVisible: true },
    { images: ["old", "new"], idleReady: true, editorHasText: false, sendReady: false, stopVisible: false },
  ];
  const seen = [];
  const url = await waitForStableGptImage({}, new Set(["old"]), {
    timeoutMs: 10_000,
    postImageIdleTimeoutMs: 8_000,
    pollMs: 1_000,
    stablePolls: 2,
    waitImpl: async () => {},
    snapshotReader: async () => {
      const value = snapshots.shift();
      seen.push(value);
      return value;
    },
  });
  assert.equal(url, "new");
  assert.equal(seen.length, 3, "不应在图片刚出现但 stop 仍存在时返回");
});

test("GPT 图片出现但 composer 长时未恢复时返回稳定的可重试错误码", async () => {
  const saved = [];
  await assert.rejects(() => waitForStableGptImage({}, new Set(), {
    timeoutMs: 2_000,
    postImageIdleTimeoutMs: 2_000,
    pollMs: 1_000,
    stablePolls: 2,
    waitImpl: async () => {},
    snapshotReader: async () => ({
      images: ["new"], idleReady: false, editorHasText: true, sendReady: false, stopVisible: true,
    }),
    onStableCandidate: async (url) => { saved.push(url); },
  }), (error) => error.code === GPT_PAGE_BUSY_CODE && error.message.startsWith(`${GPT_PAGE_BUSY_CODE}:`));
  assert.deepEqual(saved, ["new"], "页面忙错误之前必须先处理稳定图片候选");
});

test("GPT 未出图且没有额度证据时返回有界短重试错误码", async () => {
  await assert.rejects(() => waitForStableGptImage({}, new Set(), {
    timeoutMs: 2_000,
    pollMs: 1_000,
    waitImpl: async () => {},
    snapshotReader: async () => ({ images: [], quotaExhausted: false }),
  }), (error) => error.code === GPT_IMAGE_TIMEOUT_CODE
    && error.message.startsWith(`${GPT_IMAGE_TIMEOUT_CODE}:`));
});

test("GPT 明确显示额度耗尽时不进入短重试", async () => {
  await assert.rejects(() => waitForStableGptImage({}, new Set(), {
    timeoutMs: 2_000,
    pollMs: 1_000,
    waitImpl: async () => {},
    snapshotReader: async () => ({ images: [], quotaExhausted: true }),
  }), (error) => error.code === "GPT_QUOTA_EXHAUSTED");
});

test("新 job 通过 ChatGPT 根地址开新对话，断点 job 回到自己的对话 URL", async () => {
  const loaded = [];
  let current = "https://chatgpt.com/c/old-job";
  const window = {
    webContents: { getURL: () => current },
    loadURL: async (url) => { loaded.push(url); current = url; },
  };
  await prepareGptConversation(window, {
    jobId: "job-new",
    checkpoint: null,
    waitForStudio: async () => {},
  });
  assert.deepEqual(loaded, ["https://chatgpt.com/"]);
  loaded.length = 0;
  current = "https://chatgpt.com/c/another-job";
  await prepareGptConversation(window, {
    jobId: "job-resume",
    checkpoint: { gpt: { jobId: "job-resume", conversationUrl: "https://chatgpt.com/c/job-resume" } },
    waitForStudio: async () => {},
  });
  assert.deepEqual(loaded, ["https://chatgpt.com/c/job-resume"]);
});

test("显式可信 legacy 凭据可迁移已核验 storyboard，只生成缺失镜头", async () => {
  const valid = new Set(["storyboard-01.png", "storyboard-02.png"]);
  const generated = [];
  const checkpoints = [];
  const windowCheckpoints = [];
  const metadata = (name) => ({
    path: name, sizeBytes: 4096, width: 941, height: 1672, sha256: name.padEnd(64, "a").slice(0, 64),
  });
  const gptWindow = { webContents: { getURL: () => "https://chatgpt.com/c/job-resume" } };
  const shots = [1, 2, 3].map((index) => ({ index, imagePrompt: `prompt-${index}` }));
  const trustedLegacyStoryboards = [1, 2].map((index) => {
    const name = `storyboard-0${index}.png`;
    const file = metadata(name);
    return {
      migrationId: `reviewed-${index}`,
      jobId: "job-resume",
      assetId: "asset-1",
      shotIndex: index,
      promptHash: createHash("sha256").update(`prompt-${index}`).digest("hex"),
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
      width: file.width,
      height: file.height,
    };
  });
  const result = await ensureGptStoryboards({
    shots,
    outputDir: "/tmp/zhitai-storyboard-checkpoint-test",
    jobId: "job-resume",
    assetId: "asset-1",
    checkpoint: { gpt: { jobId: "old-job", conversationUrl: "https://chatgpt.com/c/old-job" } },
    trustedLegacyStoryboards,
    inspectStoryboardImpl: async (target) => valid.has(target.split("/").at(-1)) ? metadata(target.split("/").at(-1)) : null,
    generateGptImageImpl: async (_window, prompt, target) => {
      generated.push(prompt);
      valid.add(target.split("/").at(-1));
      return target;
    },
    getGptWindow: async (checkpoint) => { windowCheckpoints.push(structuredClone(checkpoint)); return gptWindow; },
    writeCheckpointImpl: async (_path, checkpoint) => { checkpoints.push(structuredClone(checkpoint)); },
  });
  assert.deepEqual(result.reusedIndices, [1, 2]);
  assert.deepEqual(result.generatedIndices, [3]);
  assert.deepEqual(generated, ["prompt-3"]);
  assert.equal(result.images.length, 3);
  assert.equal(windowCheckpoints[0].gpt.conversationUrl, undefined, "不能把其他 job 的对话 URL 当成本 job 断点");
  assert.ok(checkpoints.at(-1).gpt.storyboards["1"].promptHash);
  assert.equal(checkpoints.at(-1).gpt.storyboards["1"].legacyMigrationId, "reviewed-1");
  assert.ok(checkpoints.at(-1).gpt.storyboards["3"].sha256);
});

test("未知 legacy 图即使可解码也不会自动绑定当前提示词", async () => {
  const generated = [];
  const metadata = {
    path: "storyboard-01.png", sizeBytes: 4096, width: 941, height: 1672, sha256: "c".repeat(64),
  };
  const gptWindow = { webContents: { getURL: () => "https://chatgpt.com/c/job-unknown" } };
  const result = await ensureGptStoryboards({
    shots: [{ index: 1, imagePrompt: "current-prompt" }],
    outputDir: "/tmp/zhitai-storyboard-unknown-legacy-test",
    jobId: "job-unknown",
    assetId: "asset-unknown",
    inspectStoryboardImpl: async () => metadata,
    getGptWindow: async () => gptWindow,
    generateGptImageImpl: async (_window, prompt, target) => {
      generated.push(prompt);
      return target;
    },
    writeCheckpointImpl: async () => {},
  });
  assert.deepEqual(result.reusedIndices, []);
  assert.deepEqual(result.generatedIndices, [1]);
  assert.deepEqual(generated, ["current-prompt"]);
});

test("同 job 但 asset 不同的 manifest 不可复用", async () => {
  const prompt = "current-prompt";
  const fileHash = "d".repeat(64);
  let generated = 0;
  const result = await ensureGptStoryboards({
    shots: [{ index: 1, imagePrompt: prompt }],
    outputDir: "/tmp/zhitai-storyboard-wrong-asset-test",
    jobId: "job-same",
    assetId: "asset-current",
    checkpoint: { gpt: {
      jobId: "job-same",
      assetId: "asset-old",
      storyboards: { "1": { promptHash: createHash("sha256").update(prompt).digest("hex"), sha256: fileHash } },
    } },
    inspectStoryboardImpl: async () => ({
      path: "storyboard-01.png", sizeBytes: 4096, width: 941, height: 1672, sha256: fileHash,
    }),
    getGptWindow: async () => ({ webContents: { getURL: () => "https://chatgpt.com/c/job-same" } }),
    generateGptImageImpl: async (_window, _prompt, target) => { generated += 1; return target; },
    writeCheckpointImpl: async () => {},
  });
  assert.equal(generated, 1);
  assert.deepEqual(result.reusedIndices, []);
  assert.deepEqual(result.generatedIndices, [1]);
});

test("完整 job+asset+prompt+file manifest 仍正常复用", async () => {
  const prompt = "manifest-prompt";
  const promptHash = createHash("sha256").update(prompt).digest("hex");
  const fileHash = "e".repeat(64);
  const result = await ensureGptStoryboards({
    shots: [{ index: 1, imagePrompt: prompt }],
    outputDir: "/tmp/zhitai-storyboard-manifest-test",
    jobId: "job-manifest",
    assetId: "asset-manifest",
    checkpoint: { gpt: {
      jobId: "job-manifest",
      assetId: "asset-manifest",
      storyboards: { "1": { promptHash, sha256: fileHash, completedAt: "2026-08-28T00:00:00.000Z" } },
    } },
    inspectStoryboardImpl: async () => ({
      path: "storyboard-01.png", sizeBytes: 4096, width: 941, height: 1672, sha256: fileHash,
    }),
    generateGptImageImpl: async () => { throw new Error("有可信 manifest 时不应生成"); },
    writeCheckpointImpl: async () => {},
  });
  assert.deepEqual(result.reusedIndices, [1]);
  assert.deepEqual(result.generatedIndices, []);
});

test("断点中后镜与前镜 SHA 重复时只丢弃并重生后镜", async () => {
  const hashes = new Map([
    ["storyboard-01.png", "1".repeat(64)],
    ["storyboard-02.png", "2".repeat(64)],
    ["storyboard-03.png", "2".repeat(64)],
  ]);
  const shots = [1, 2, 3].map((index) => ({ index, imagePrompt: `prompt-${index}` }));
  const storyboards = Object.fromEntries(shots.map((shot) => [String(shot.index), {
    promptHash: createHash("sha256").update(shot.imagePrompt).digest("hex"),
    sha256: hashes.get(`storyboard-0${shot.index}.png`),
  }]));
  const generated = [];
  const openedWith = [];
  const result = await ensureGptStoryboards({
    shots,
    outputDir: "/tmp/zhitai-storyboard-duplicate-test",
    jobId: "job-duplicate",
    assetId: "asset-duplicate",
    checkpoint: { gpt: {
      jobId: "job-duplicate",
      assetId: "asset-duplicate",
      conversationUrl: "https://chatgpt.com/c/stale-duplicate",
      storyboards,
    } },
    inspectStoryboardImpl: async (target) => {
      const name = target.split("/").at(-1);
      const fileHash = hashes.get(name);
      return fileHash ? { path: name, sizeBytes: 4096, width: 941, height: 1672, sha256: fileHash } : null;
    },
    getGptWindow: async (checkpoint) => {
      openedWith.push(structuredClone(checkpoint));
      return { webContents: { getURL: () => "https://chatgpt.com/c/fresh-duplicate" } };
    },
    generateGptImageImpl: async (_window, prompt, target) => {
      generated.push(prompt);
      hashes.set(target.split("/").at(-1), "3".repeat(64));
      return target;
    },
    writeCheckpointImpl: async () => {},
  });
  assert.deepEqual(result.reusedIndices, [1, 2]);
  assert.deepEqual(result.generatedIndices, [3]);
  assert.deepEqual(generated, ["prompt-3"]);
  assert.equal(openedWith[0].gpt.conversationUrl, null);
  assert.equal(result.checkpoint.gpt.storyboards["3"].sha256, "3".repeat(64));
});

test("GPT 图片已落盘后即使 composer 仍忙也先写断点，下次不重复生成", async () => {
  const valid = new Set();
  const writes = [];
  let generated = 0;
  const nameOf = (target) => target.split("/").at(-1);
  const inspect = async (target) => valid.has(nameOf(target)) ? {
    path: nameOf(target), sizeBytes: 4096, width: 941, height: 1672, sha256: "b".repeat(64),
  } : null;
  const gptWindow = { webContents: { getURL: () => "https://chatgpt.com/c/job-busy" } };
  await assert.rejects(() => ensureGptStoryboards({
    shots: [{ index: 1, imagePrompt: "prompt-1" }],
    outputDir: "/tmp/zhitai-storyboard-busy-checkpoint-test",
    jobId: "job-busy",
    assetId: "asset-busy",
    getGptWindow: async () => gptWindow,
    inspectStoryboardImpl: inspect,
    generateGptImageImpl: async (_window, _prompt, target, options) => {
      generated += 1;
      valid.add(nameOf(target));
      await options.onDownloaded(target);
      const error = new Error(`${GPT_PAGE_BUSY_CODE}: stop 尚未消失`);
      error.code = GPT_PAGE_BUSY_CODE;
      throw error;
    },
    writeCheckpointImpl: async (_path, checkpoint) => { writes.push(structuredClone(checkpoint)); },
  }), (error) => error.code === GPT_PAGE_BUSY_CODE);
  const savedCheckpoint = writes.at(-1);
  assert.equal(savedCheckpoint.gpt.storyboards["1"].sha256, "b".repeat(64));
  assert.equal(savedCheckpoint.gpt.conversationUrl, null, "busy 会话必须丢弃，下一次从干净对话续镜");
  assert.equal(savedCheckpoint.gpt.lastBusyConversationUrl, "https://chatgpt.com/c/job-busy");
  assert.equal(savedCheckpoint.gpt.conversationResetReason, GPT_PAGE_BUSY_CODE);

  const resumed = await ensureGptStoryboards({
    shots: [{ index: 1, imagePrompt: "prompt-1" }],
    outputDir: "/tmp/zhitai-storyboard-busy-checkpoint-test",
    jobId: "job-busy",
    assetId: "asset-busy",
    checkpoint: savedCheckpoint,
    inspectStoryboardImpl: inspect,
    generateGptImageImpl: async () => { throw new Error("不应再生成"); },
    writeCheckpointImpl: async () => {},
  });
  assert.equal(generated, 1);
  assert.deepEqual(resumed.reusedIndices, [1]);
  assert.deepEqual(resumed.generatedIndices, []);
});

test("transient_wait 使用可信 resumeStatus 继续原生图断点", () => {
  assert.equal(effectiveCreativeStatus({ status: "transient_wait", resumeStatus: "ready_for_images" }), "ready_for_images");
  assert.equal(effectiveCreativeStatus({ status: "transient_wait", resumeStatus: "ready_for_seedance" }), "ready_for_seedance");
  assert.equal(effectiveCreativeStatus({ status: "transient_wait", resumeStatus: "completed" }), "transient_wait");
  assert.equal(effectiveCreativeStatus({ status: "ready_for_images" }), "ready_for_images");
});

test("实际断点图片必须能被 ffprobe 解码且尺寸足够", async () => {
  assert.equal(await inspectStoryboard(new URL("fixtures/not-an-image.png", import.meta.url).pathname), null);
});

function strictOriginalDetailFixture() {
  return { remake_plan: { plan: { seedanceWorkflow: { originality: {
    policy: "strict_full_original",
    status: "remediated",
    referenceVideoAllowed: false,
    sourceAudioAllowed: false,
    sourceMusicAllowed: false,
    originalVisualsRequired: true,
    originalVoiceoverRequired: true,
  } } } } };
}

function localMotionTriggerFixture() {
  const timeoutEvidence = {
    noNewResultIdentity: true,
    loginRequired: false,
    quotaExhausted: false,
    authorizationRequired: false,
    assistantFinishState: false,
    probeFailed: false,
  };
  return {
    code: DOUBAO_ORPHAN_RECOVERY_EXHAUSTED_CODE,
    attemptNumber: 2,
    recoveryExhausted: true,
    shotIndex: 1,
    inputFingerprint: "f".repeat(64),
    timeoutEvidenceSha256: createHash("sha256").update(canonicalJson(timeoutEvidence)).digest("hex"),
    observedAt: "2026-08-29T06:00:00.000Z",
  };
}

function exactQuotaStateFixture(overrides = {}) {
  return {
    loginRequired: false,
    quotaExhausted: true,
    authorizationRequired: false,
    riskBlocked: false,
    assistantFinishState: "unknown",
    probeFailed: false,
    ...overrides,
  };
}

function quotaTimeoutEvidenceFixture(overrides = {}) {
  return {
    noNewResultIdentity: true,
    loginRequired: false,
    quotaExhausted: true,
    authorizationRequired: false,
    assistantFinishState: "unknown",
    probeFailed: false,
    ...overrides,
  };
}

async function quotaEvidenceFixture({ pendingInputLocked = false, inputFingerprint = "e".repeat(64) } = {}) {
  const pendingTimeoutEvidence = pendingInputLocked ? quotaTimeoutEvidenceFixture() : null;
  const decision = await collectDoubaoAllAccountsQuotaEvidence({
    accounts: ["account-1", "account-2"],
    readState: async () => exactQuotaStateFixture(),
    jobId: "job-local-motion",
    assetId: "asset-local-motion",
    shotIndex: 2,
    inputFingerprint,
    pendingInputLocked,
    pendingTimeoutEvidence,
    capturedAt: "2026-08-29T07:00:00.000Z",
  });
  assert.equal(decision.action, "quota_exhausted");
  return { evidence: decision.evidence, pendingTimeoutEvidence };
}

function bindLocalMotionTriggerCheckpoint(checkpoint, trigger = localMotionTriggerFixture()) {
  const next = structuredClone(checkpoint);
  next.doubao = { shots: { "1": {
    shotIndex: 1,
    attemptNumber: 2,
    orphanRecoveryUsed: true,
    recoveryExhausted: true,
    inputFingerprint: trigger.inputFingerprint,
    lastTimeoutEvidence: {
      noNewResultIdentity: true,
      loginRequired: false,
      quotaExhausted: false,
      authorizationRequired: false,
      assistantFinishState: false,
      probeFailed: false,
    },
  } } };
  next.localMotion = {
    engine: LOCAL_MOTION_ENGINE,
    status: "triggered",
    jobId: next.jobId,
    assetId: next.assetId,
    trigger,
  };
  return next;
}

function localMotionStoryboardFixture() {
  const shots = [1, 2, 3].map((index) => ({ index, imagePrompt: `原创首帧 ${index}` }));
  const images = [1, 2, 3].map((index) => `/tmp/storyboard-0${index}.png`);
  const metadata = Object.fromEntries(images.map((name, index) => [name, {
    path: name.split("/").at(-1),
    sizeBytes: 2_048 + index,
    sha256: String(index + 1).repeat(64),
    width: 941,
    height: 1672,
  }]));
  const checkpoint = {
    jobId: "job-local-motion",
    assetId: "asset-local-motion",
    gpt: {
      jobId: "job-local-motion",
      assetId: "asset-local-motion",
      storyboards: Object.fromEntries(shots.map((shot, index) => [String(shot.index), {
        ...metadata[images[index]],
        promptHash: createHash("sha256").update(shot.imagePrompt).digest("hex"),
        completedAt: "2026-08-29T05:00:00.000Z",
      }])),
    },
  };
  return { shots, images, metadata, checkpoint };
}

test("本地动画只接受精确 orphan exhausted 或稳定全账号 quota 错误码", () => {
  const detail = strictOriginalDetailFixture();
  const shots = [1, 2, 3].map((index) => ({ index }));
  const images = ["a", "b", "c"];
  assert.equal(localMotionFallbackEnabled(undefined), true);
  assert.equal(localMotionFallbackEnabled("0"), false);
  assert.equal(strictOriginalMotionWorkflow(detail), true);
  assert.deepEqual(localMotionFallbackDecision({
    error: { code: DOUBAO_ORPHAN_RECOVERY_EXHAUSTED_CODE }, detail, shots, images,
  }), { action: "fallback" });
  assert.deepEqual(localMotionFallbackDecision({
    error: { code: DOUBAO_ALL_ACCOUNTS_QUOTA_EXHAUSTED_CODE, quotaEvidenceSha256: "a".repeat(64) }, detail, shots, images,
  }), { action: "fallback" });
  assert.equal(localMotionFallbackDecision({
    error: { code: DOUBAO_ALL_ACCOUNTS_QUOTA_EXHAUSTED_CODE }, detail, shots, images,
  }).reason, "quota_evidence_digest_missing");
  for (const code of [DOUBAO_VIDEO_TIMEOUT_CODE, DOUBAO_VIDEO_TIMEOUT_UNSAFE_CODE, "LOGIN_REQUIRED", "QUOTA_EXHAUSTED", "AUTH_REQUIRED"]) {
    assert.equal(localMotionFallbackDecision({ error: { code }, detail, shots, images }).action, "reject");
  }
  assert.equal(localMotionFallbackDecision({
    error: { code: DOUBAO_ORPHAN_RECOVERY_EXHAUSTED_CODE },
    detail: {}, shots, images,
  }).reason, "strict_originality_required");
});

test("本地动画触发与恢复断点不含账号或会话，并绑定第二 attempt 安全耗尽", () => {
  const safeEvidence = {
    noNewResultIdentity: true,
    loginRequired: false,
    quotaExhausted: false,
    authorizationRequired: false,
    assistantFinishState: false,
    probeFailed: false,
  };
  const checkpoint = {
    jobId: "job-local-motion",
    assetId: "asset-local-motion",
    doubao: { shots: { "1": {
      shotIndex: 1,
      accountId: "must-not-be-copied",
      conversationUrl: "https://www.doubao.com/chat/must-not-be-copied",
      attemptNumber: 2,
      orphanRecoveryUsed: true,
      recoveryExhausted: true,
      inputFingerprint: "f".repeat(64),
      lastTimeoutEvidence: safeEvidence,
    } } },
  };
  const trigger = buildLocalMotionTriggerEvidence({
    error: { code: DOUBAO_ORPHAN_RECOVERY_EXHAUSTED_CODE },
    checkpoint,
    observedAt: "2026-08-29T06:00:00.000Z",
  });
  assert.equal(trigger.code, DOUBAO_ORPHAN_RECOVERY_EXHAUSTED_CODE);
  assert.equal(trigger.attemptNumber, 2);
  assert.doesNotMatch(JSON.stringify(trigger), /doubao\.com|account|must-not-be-copied/);
  checkpoint.localMotion = {
    engine: LOCAL_MOTION_ENGINE,
    status: "triggered",
    jobId: checkpoint.jobId,
    assetId: checkpoint.assetId,
    trigger,
  };
  assert.equal(localMotionResumeDecision({
    checkpoint, jobId: checkpoint.jobId, assetId: checkpoint.assetId,
  }).action, "resume");
  assert.equal(buildLocalMotionTriggerEvidence({
    error: { code: DOUBAO_VIDEO_TIMEOUT_UNSAFE_CODE }, checkpoint,
  }), null);
});

test("全账号额度兜底要求每个账号都给出结构化 exact quota，assistantFinishState 可 unknown", async () => {
  assert.deepEqual(exactDoubaoQuotaState(exactQuotaStateFixture()), exactQuotaStateFixture());
  assert.deepEqual(safeDoubaoQuotaTimeoutEvidence(quotaTimeoutEvidenceFixture()), quotaTimeoutEvidenceFixture());
  const reads = [];
  const decision = await collectDoubaoAllAccountsQuotaEvidence({
    accounts: ["account-1", "account-2", "account-3", "account-2"],
    readState: async (accountId) => {
      reads.push(accountId);
      return exactQuotaStateFixture({ assistantFinishState: accountId === "account-2" ? false : "unknown" });
    },
    jobId: "job-local-motion",
    assetId: "asset-local-motion",
    shotIndex: 2,
    inputFingerprint: "e".repeat(64),
    capturedAt: "2026-08-29T07:00:00.000Z",
  });
  assert.equal(decision.action, "quota_exhausted");
  assert.deepEqual(reads, ["account-1", "account-2", "account-3"]);
  assert.equal(decision.evidence.accountCount, 3);
  assert.equal(decision.evidence.pendingInputLocked, false);
  assert.equal(decision.evidence.pendingTimeoutEvidenceSha256, null);
  assert.ok(validatedDoubaoQuotaEvidence(decision.evidence, {
    jobId: "job-local-motion",
    assetId: "asset-local-motion",
    inputFingerprint: "e".repeat(64),
  }));
  const serialized = JSON.stringify(decision.evidence);
  assert.doesNotMatch(serialized, /account-[123]|doubao\.com|conversationUrl/);
  const stableError = doubaoAllAccountsQuotaExhaustedError(undefined, decision.evidence);
  assert.equal(stableError.code, DOUBAO_ALL_ACCOUNTS_QUOTA_EXHAUSTED_CODE);
  assert.equal(stableError.quotaEvidenceSha256, decision.evidence.evidenceSha256);
  assert.doesNotMatch(JSON.stringify(stableError), /account-[123]|doubao\.com/);
});

test("额度兜底对 unknown、登录、授权、风控、探测失败及普通探测异常全部失败关闭", async () => {
  const unsafeOverrides = [
    { quotaExhausted: false },
    { quotaExhausted: "unknown" },
    { loginRequired: true },
    { loginRequired: "unknown" },
    { authorizationRequired: true },
    { authorizationRequired: "unknown" },
    { riskBlocked: true },
    { riskBlocked: "unknown" },
    { probeFailed: true },
    { assistantFinishState: undefined },
  ];
  for (const overrides of unsafeOverrides) {
    const result = await collectDoubaoAllAccountsQuotaEvidence({
      accounts: ["account-1", "account-2"],
      readState: async (accountId) => accountId === "account-1"
        ? exactQuotaStateFixture() : exactQuotaStateFixture(overrides),
      jobId: "job-local-motion",
      assetId: "asset-local-motion",
      shotIndex: 2,
      inputFingerprint: "e".repeat(64),
    });
    assert.equal(result.action, "reject", JSON.stringify(overrides));
    assert.equal(result.reason, "not_all_accounts_exact_quota");
  }
  let readCount = 0;
  const failedProbe = await collectDoubaoAllAccountsQuotaEvidence({
    accounts: ["account-1", "account-2", "account-3"],
    readState: async (accountId) => {
      readCount += 1;
      if (accountId === "account-2") throw new Error("ordinary probe failure");
      return exactQuotaStateFixture();
    },
    jobId: "job-local-motion",
    assetId: "asset-local-motion",
    shotIndex: 2,
    inputFingerprint: "e".repeat(64),
  });
  assert.equal(failedProbe.action, "reject");
  assert.equal(readCount, 3, "即使有 unknown 也只读完成账号池，不应提交或提前误判 all-quota");
});

test("全账号额度 trigger 脱敏并支持提交前断点恢复，篡改 scope 或 digest 均拒绝", async () => {
  const { evidence } = await quotaEvidenceFixture();
  const checkpoint = {
    jobId: evidence.jobId,
    assetId: evidence.assetId,
    doubao: { quotaExhaustion: evidence, shots: {} },
  };
  const error = doubaoAllAccountsQuotaExhaustedError(undefined, evidence);
  const trigger = buildLocalMotionTriggerEvidence({
    error,
    checkpoint,
    observedAt: "2026-08-29T07:01:00.000Z",
  });
  assert.equal(trigger.code, DOUBAO_ALL_ACCOUNTS_QUOTA_EXHAUSTED_CODE);
  assert.equal(trigger.allAccountsQuotaExhausted, true);
  assert.equal(trigger.pendingInputLocked, false);
  assert.doesNotMatch(JSON.stringify(trigger), /account-[12]|doubao\.com|conversationUrl|accountId/);
  checkpoint.localMotion = {
    engine: LOCAL_MOTION_ENGINE,
    status: "triggered",
    jobId: checkpoint.jobId,
    assetId: checkpoint.assetId,
    trigger,
  };
  assert.equal(localMotionResumeDecision({
    checkpoint, jobId: checkpoint.jobId, assetId: checkpoint.assetId,
  }).action, "resume");
  assert.equal(localMotionResumeDecision({
    checkpoint, jobId: checkpoint.jobId, assetId: checkpoint.assetId, enabled: "0",
  }).action, "disabled");

  const badDigest = structuredClone(checkpoint);
  badDigest.doubao.quotaExhaustion.observations[0].state.assistantFinishState = true;
  assert.equal(localMotionResumeDecision({
    checkpoint: badDigest, jobId: checkpoint.jobId, assetId: checkpoint.assetId,
  }).action, "reject");
  const badInput = structuredClone(checkpoint);
  badInput.localMotion.trigger.inputFingerprint = "d".repeat(64);
  assert.equal(localMotionResumeDecision({
    checkpoint: badInput, jobId: checkpoint.jobId, assetId: checkpoint.assetId,
  }).action, "reject");
  assert.equal(localMotionResumeDecision({
    checkpoint, jobId: "wrong-job", assetId: checkpoint.assetId,
  }).action, "reject");
  assert.equal(localMotionResumeDecision({
    checkpoint, jobId: checkpoint.jobId, assetId: "wrong-asset",
  }).action, "reject");
  const leakyTrigger = structuredClone(checkpoint);
  leakyTrigger.localMotion.trigger.conversationUrl = "https://www.doubao.com/chat/secret";
  assert.equal(localMotionResumeDecision({
    checkpoint: leakyTrigger, jobId: checkpoint.jobId, assetId: checkpoint.assetId,
  }).action, "reject");
});

test("提交后额度触发绑定 pending input 与超时摘要，恢复时不接受缺失或被篡改的锁", async () => {
  const inputFingerprint = "c".repeat(64);
  const { evidence, pendingTimeoutEvidence } = await quotaEvidenceFixture({
    pendingInputLocked: true,
    inputFingerprint,
  });
  const checkpoint = {
    jobId: evidence.jobId,
    assetId: evidence.assetId,
    doubao: {
      quotaExhaustion: evidence,
      shots: { "2": {
        shotIndex: 2,
        accountId: "must-not-enter-trigger",
        conversationUrl: "https://www.doubao.com/chat/must-not-enter-trigger",
        inputFingerprint,
        sendState: "submitted",
        submittedAt: "2026-08-29T06:59:00.000Z",
        quotaPendingLocked: true,
        quotaPendingTimeoutEvidence: pendingTimeoutEvidence,
      } },
    },
  };
  const error = doubaoAllAccountsQuotaExhaustedError(undefined, evidence);
  const trigger = buildLocalMotionTriggerEvidence({ error, checkpoint });
  checkpoint.localMotion = {
    engine: LOCAL_MOTION_ENGINE,
    status: "in_progress",
    jobId: checkpoint.jobId,
    assetId: checkpoint.assetId,
    trigger,
  };
  assert.equal(localMotionResumeDecision({
    checkpoint, jobId: checkpoint.jobId, assetId: checkpoint.assetId,
  }).action, "resume");
  assert.doesNotMatch(JSON.stringify(trigger), /must-not-enter-trigger|doubao\.com|conversationUrl|accountId/);

  for (const mutate of [
    (copy) => { copy.doubao.shots["2"].quotaPendingLocked = false; },
    (copy) => { copy.doubao.shots["2"].inputFingerprint = "b".repeat(64); },
    (copy) => { copy.doubao.shots["2"].quotaPendingTimeoutEvidence.probeFailed = true; },
    (copy) => { delete copy.doubao.shots["2"].submittedAt; },
    (copy) => { copy.doubao.shots["2"].sendState = "completed"; },
  ]) {
    const tampered = structuredClone(checkpoint);
    mutate(tampered);
    assert.equal(localMotionResumeDecision({
      checkpoint: tampered, jobId: checkpoint.jobId, assetId: checkpoint.assetId,
    }).action, "reject");
  }
});

test("提交后 quota 分支先锁断点、只读全账号并在任何非 exact 状态下禁止跨账号提交", async () => {
  const source = await readFile(new URL("../desktop/creative-runner.js", import.meta.url), "utf8");
  const pageMatchGate = source.indexOf("if (!pageMatches)");
  const fastStart = source.indexOf("const quotaFastPath = doubaoPendingQuotaFastPathDecision", pageMatchGate);
  const fastEnd = source.indexOf("if (pendingSubmission.attemptNumber === 1", fastStart);
  assert.ok(pageMatchGate > 0 && fastStart > pageMatchGate && fastEnd > fastStart);
  const fastBranch = source.slice(fastStart, fastEnd);
  assert.ok(fastBranch.indexOf("await writeRunCheckpoint(checkpointPath, checkpoint)")
    < fastBranch.indexOf("await readOnlyAllAccountQuotaEvidence"), "必须先持久化 pending 锁再探测账号池");
  assert.match(fastBranch, /pendingInputLocked: true/);
  assert.match(fastBranch, /preObserved: new Map/);
  assert.doesNotMatch(fastBranch, /waitForDoubaoVideo|generateDoubaoClip|sendPrompt|sendPromptImpl/);
  const start = source.indexOf("const submissionAfterError = pendingSubmission || pendingDoubaoSubmission");
  const end = source.indexOf("if (error?.code === DOUBAO_VIDEO_TIMEOUT_CODE)", start);
  assert.ok(start > 0 && end > start);
  const quotaBranch = source.slice(start, end);
  assert.match(quotaBranch, /pendingShot\.quotaPendingLocked = true/);
  assert.match(quotaBranch, /await writeRunCheckpoint\(checkpointPath, checkpoint\)/);
  assert.match(quotaBranch, /readOnlyAllAccountQuotaEvidence/);
  assert.match(quotaBranch, /pendingInputLocked: true/);
  assert.doesNotMatch(quotaBranch, /generateDoubaoClip|continue\s*;/);
  assert.match(source, /after\.quotaExhausted === true && !submissionAfterError/);
  const resumeStart = source.indexOf("if (lockedAccountId && activeAttempt?.quotaPendingLocked === true)");
  const accountLoop = source.indexOf("for (const accountId of orderedAccounts)", resumeStart);
  const resumeBranch = source.slice(resumeStart, accountLoop);
  assert.match(resumeBranch, /safeDoubaoQuotaTimeoutEvidence/);
  assert.match(resumeBranch, /resumedQuotaProbe = await readOnlyAllAccountQuotaEvidence/);
  assert.doesNotMatch(resumeBranch, /generateDoubaoClip|waitForDoubaoVideo/);
});

test("本地动画三图门拒绝缺失、重复和 manifest 篡改", async () => {
  const fixture = localMotionStoryboardFixture();
  const inspect = async (name) => fixture.metadata[name] || null;
  const valid = await validateLocalMotionStoryboards({
    ...fixture,
    jobId: fixture.checkpoint.jobId,
    assetId: fixture.checkpoint.assetId,
    inspectStoryboardImpl: inspect,
  });
  assert.equal(valid.storyboards.length, 3);
  assert.match(valid.storyboardFingerprint, /^[a-f0-9]{64}$/);

  await assert.rejects(() => validateLocalMotionStoryboards({
    ...fixture,
    jobId: fixture.checkpoint.jobId,
    assetId: fixture.checkpoint.assetId,
    inspectStoryboardImpl: async (name) => name.endsWith("02.png") ? null : fixture.metadata[name],
  }), /缺少完整 manifest/);

  const tampered = structuredClone(fixture.checkpoint);
  tampered.gpt.storyboards["2"].sizeBytes += 1;
  await assert.rejects(() => validateLocalMotionStoryboards({
    ...fixture,
    checkpoint: tampered,
    jobId: tampered.jobId,
    assetId: tampered.assetId,
    inspectStoryboardImpl: inspect,
  }), /缺少完整 manifest/);

  const duplicateMetadata = structuredClone(fixture.metadata);
  duplicateMetadata[fixture.images[2]].sha256 = duplicateMetadata[fixture.images[1]].sha256;
  const duplicateCheckpoint = structuredClone(fixture.checkpoint);
  duplicateCheckpoint.gpt.storyboards["3"].sha256 = duplicateCheckpoint.gpt.storyboards["2"].sha256;
  await assert.rejects(() => validateLocalMotionStoryboards({
    ...fixture,
    checkpoint: duplicateCheckpoint,
    jobId: duplicateCheckpoint.jobId,
    assetId: duplicateCheckpoint.assetId,
    inspectStoryboardImpl: async (name) => duplicateMetadata[name],
  }), /必须互不相同/);
});

test("本地动画固定参数为三段各 250 帧，总片严格 750 帧", () => {
  const args = localMotionSegmentArgs({ imagePath: "/tmp/frame.png", outputPath: "/tmp/clip.mp4", segmentIndex: 1 });
  assert.equal(args[args.indexOf("-frames:v") + 1], String(LOCAL_MOTION_SEGMENT_FRAMES));
  assert.match(args[args.indexOf("-vf") + 1], /s=1080x1920:fps=30/);
  assert.equal(args.includes("-an"), true);
  assert.deepEqual(localMotionProbeDecision({
    width: 1080, height: 1920, fps: 30, totalFrames: LOCAL_MOTION_TOTAL_FRAMES,
    durationMs: LOCAL_MOTION_DURATION_MS, codec: "h264", pixelFormat: "yuv420p", audioCodec: "",
  }, { frames: LOCAL_MOTION_TOTAL_FRAMES, durationMs: LOCAL_MOTION_DURATION_MS }), { passed: true, reason: null });
  assert.equal(localMotionProbeDecision({
    width: 1080, height: 1920, fps: 30, totalFrames: 749,
    durationMs: LOCAL_MOTION_DURATION_MS, codec: "h264", pixelFormat: "yuv420p", audioCodec: "",
  }, { frames: LOCAL_MOTION_TOTAL_FRAMES, durationMs: LOCAL_MOTION_DURATION_MS }).reason, "frame_count_mismatch");
});

test("本地动画 manifest 绑定输入输出且完成后幂等复用，不产生第三次远端提交", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zhitai-local-motion-"));
  const fixture = localMotionStoryboardFixture();
  const images = fixture.images.map((name, index) => join(directory, `storyboard-0${index + 1}.png`));
  const metadata = Object.fromEntries(images.map((name, index) => [name, {
    ...fixture.metadata[fixture.images[index]], path: name.split("/").at(-1),
  }]));
  const trigger = localMotionTriggerFixture();
  const checkpoint = bindLocalMotionTriggerCheckpoint(fixture.checkpoint, trigger);
  for (let i = 0; i < 3; i++) checkpoint.gpt.storyboards[String(i + 1)] = {
    ...checkpoint.gpt.storyboards[String(i + 1)], ...metadata[images[i]],
  };
  let encodeCalls = 0;
  let concatCalls = 0;
  const runCommandImpl = async (_command, args) => {
    if (args[0] === "-version") return { out: "fixture version 1\n", err: "" };
    const output = args.at(-1);
    if (args.includes("-frames:v")) {
      encodeCalls += 1;
      const filter = args[args.indexOf("-vf") + 1];
      await writeFile(output, Buffer.alloc(2_048, filter.includes("gentle") ? encodeCalls : encodeCalls + 1));
    } else {
      concatCalls += 1;
      await writeFile(output, Buffer.alloc(4_096, 9));
    }
    return { out: "", err: "" };
  };
  const probeVideoImpl = async (name) => String(name).includes("final.visual") ? {
    width: 1080, height: 1920, fps: 30, totalFrames: 750, durationMs: 25_000,
    codec: "h264", pixelFormat: "yuv420p", audioCodec: "", audioDurationMs: 0,
  } : {
    width: 1080, height: 1920, fps: 30, totalFrames: 250, durationMs: 8_333,
    codec: "h264", pixelFormat: "yuv420p", audioCodec: "", audioDurationMs: 0,
  };
  try {
    const first = await generateLocalMotionVisual({
      outputDir: directory,
      jobId: checkpoint.jobId,
      assetId: checkpoint.assetId,
      images,
      shots: fixture.shots,
      checkpoint,
      trigger,
      ffmpegPath: "/fixture/ffmpeg",
      ffprobePath: "/fixture/ffprobe",
      runCommandImpl,
      inspectStoryboardImpl: async (name) => metadata[name],
      probeVideoImpl,
      nowImpl: () => "2026-08-29T06:00:00.000Z",
    });
    assert.equal(first.manifest.status, "visual_completed");
    assert.equal(first.manifest.engine, LOCAL_MOTION_ENGINE);
    assert.equal(first.manifest.segments.length, 3);
    assert.ok(first.manifest.segments.every((segment) => segment.frameCount === 250));
    assert.equal(first.manifest.visualVideo.totalFrames, 750);
    assert.equal(first.manifest.generationProvenanceSha256, localMotionGenerationProvenanceSha256(first.manifest));
    assert.equal(first.manifest.manifestSha256, localMotionManifestSha256(first.manifest));
    assert.doesNotMatch(await readFile(first.manifestPath, "utf8"), /doubao\.com|accountId|conversationUrl/);
    assert.equal(encodeCalls, 3);
    assert.equal(concatCalls, 1);

    const second = await generateLocalMotionVisual({
      outputDir: directory,
      jobId: checkpoint.jobId,
      assetId: checkpoint.assetId,
      images,
      shots: fixture.shots,
      checkpoint,
      trigger,
      ffmpegPath: "/fixture/ffmpeg",
      ffprobePath: "/fixture/ffprobe",
      runCommandImpl,
      inspectStoryboardImpl: async (name) => metadata[name],
      probeVideoImpl,
      nowImpl: () => "2026-08-29T06:00:00.000Z",
    });
    assert.equal(second.manifest.manifestSha256, first.manifest.manifestSha256);
    assert.equal(encodeCalls, 3, "恢复时不得再次编码已绑定段，更不得回到豆包第三次提交");
    assert.equal(concatCalls, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("本地动画中途失败后从 manifest 续段，已完成首段不重做", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zhitai-local-motion-resume-"));
  const fixture = localMotionStoryboardFixture();
  const images = fixture.images.map((name, index) => join(directory, `storyboard-0${index + 1}.png`));
  const metadata = Object.fromEntries(images.map((name, index) => [name, {
    ...fixture.metadata[fixture.images[index]], path: name.split("/").at(-1),
  }]));
  const trigger = localMotionTriggerFixture();
  const checkpoint = bindLocalMotionTriggerCheckpoint(fixture.checkpoint, trigger);
  for (let i = 0; i < 3; i++) checkpoint.gpt.storyboards[String(i + 1)] = {
    ...checkpoint.gpt.storyboards[String(i + 1)], ...metadata[images[i]],
  };
  const encoded = [];
  let failSecond = true;
  const runCommandImpl = async (_command, args) => {
    if (args[0] === "-version") return { out: "fixture version 1\n", err: "" };
    const output = args.at(-1);
    if (args.includes("-frames:v")) {
      const filter = args[args.indexOf("-vf") + 1];
      const index = filter.includes("1.10") ? 2 : filter.includes("1.12") ? 3 : 1;
      encoded.push(index);
      if (index === 2 && failSecond) throw new Error("simulated crash");
      await writeFile(output, Buffer.alloc(2_048, index));
    } else await writeFile(output, Buffer.alloc(4_096, 8));
    return { out: "", err: "" };
  };
  const probeVideoImpl = async (name) => String(name).includes("final.visual") ? {
    width: 1080, height: 1920, fps: 30, totalFrames: 750, durationMs: 25_000,
    codec: "h264", pixelFormat: "yuv420p", audioCodec: "", audioDurationMs: 0,
  } : {
    width: 1080, height: 1920, fps: 30, totalFrames: 250, durationMs: 8_333,
    codec: "h264", pixelFormat: "yuv420p", audioCodec: "", audioDurationMs: 0,
  };
  const options = {
    outputDir: directory, jobId: checkpoint.jobId, assetId: checkpoint.assetId,
    images, shots: fixture.shots, checkpoint, trigger,
    ffmpegPath: "/fixture/ffmpeg", ffprobePath: "/fixture/ffprobe",
    runCommandImpl, inspectStoryboardImpl: async (name) => metadata[name], probeVideoImpl,
    nowImpl: () => "2026-08-29T06:00:00.000Z",
  };
  try {
    await assert.rejects(() => generateLocalMotionVisual(options), /simulated crash/);
    const partial = JSON.parse(await readFile(join(directory, "local-motion-manifest.json"), "utf8"));
    assert.equal(partial.status, "in_progress");
    assert.deepEqual(partial.segments.map((segment) => segment.index), [1]);
    failSecond = false;
    await generateLocalMotionVisual(options);
    assert.deepEqual(encoded, [1, 2, 2, 3]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("本地动画最终 manifest 绑定 AAC、完整旁白、质检与 workflow", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zhitai-local-motion-final-"));
  const manifestPath = join(directory, "local-motion-manifest.json");
  const finalVideoPath = join(directory, "final.mp4");
  const audioQualityPath = join(directory, "audio-quality.json");
  const narration = "小户型卫生间先排好四区动线，再把收纳放进墙面。";
  const finalBytes = Buffer.alloc(4_096, 5);
  const finalSha = createHash("sha256").update(finalBytes).digest("hex");
  const base = {
    schemaVersion: 1,
    status: "visual_completed",
    engine: LOCAL_MOTION_ENGINE,
    evidenceMode: "local_storyboard_motion",
    jobId: "job-final",
    assetId: "asset-final",
    pipelineVersion: "zhitai-local-motion-v1",
    preset: {},
    trigger: localMotionTriggerFixture(),
    environment: { ffmpegVersion: "fixture", ffprobeVersion: "fixture" },
    storyboardFingerprint: "a".repeat(64),
    storyboards: [],
    segments: [],
    visualVideo: {},
  };
  const bound = { ...base, generationProvenanceSha256: localMotionGenerationProvenanceSha256(base) };
  bound.manifestSha256 = localMotionManifestSha256(bound);
  try {
    await Promise.all([
      writeFile(manifestPath, `${JSON.stringify(bound)}\n`),
      writeFile(finalVideoPath, finalBytes),
    ]);
    const report = {
      status: "passed",
      narration,
      narrationSha256: createHash("sha256").update(narration).digest("hex"),
      narrationComplete: true,
      narrationDurationMs: 12_000,
      finalDurationMs: 25_000,
      outputDurationMs: 25_000,
      timingVerified: true,
      outputSha256: finalSha,
      outputSizeBytes: finalBytes.length,
      meanVolumeDb: -16,
      maxVolumeDb: -1.5,
    };
    await writeFile(audioQualityPath, `${JSON.stringify(report)}\n`);
    const completed = await finalizeLocalMotionManifest({
      manifestPath,
      finalVideoPath,
      audioQualityPath,
      workflow: { schemaVersion: 4, mode: "full_original_recovery" },
      probeVideoImpl: async () => ({
        width: 1080, height: 1920, fps: 30, totalFrames: 750, durationMs: 25_000,
        codec: "h264", pixelFormat: "yuv420p", audioCodec: "aac", audioDurationMs: 25_000,
      }),
      nowImpl: () => "2026-08-29T06:30:00.000Z",
    });
    assert.equal(completed.status, "completed");
    assert.equal(completed.finalVideo.audio.codec, "aac");
    assert.equal(completed.audioQuality.narrationComplete, true);
    assert.equal(completed.audioQuality.narrationSha256, report.narrationSha256);
    assert.equal(completed.manifestSha256, localMotionManifestSha256(completed));
    assert.equal(completed.generationProvenanceSha256, localMotionGenerationProvenanceSha256(completed));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("豆包入口识别支持链接、标签与两段式创作页，并拒绝声音控件", () => {
  assert.deepEqual(
    doubaoVideoEntryDecision([
      { label: "播放视频", href: "/chat/create-video", visible: true },
      { label: "视频生成", href: "", visible: true },
    ], "https://www.doubao.com/chat/"),
    {
      status: "click",
      kind: "video",
      index: 1,
      label: "视频生成",
      pathname: "/chat/",
      diagnostics: ["视频生成"],
    },
  );
  assert.equal(doubaoVideoEntryDecision([
    { label: "AI 创作", href: "/chat/create-image", visible: true },
  ], "https://www.doubao.com/chat/", { allowCreative: true }).kind, "creative");
  assert.equal(doubaoVideoEntryDecision([], "https://www.doubao.com/chat/create-video").status, "already");
  assert.equal(doubaoVideoEntryDecision([], "https://www.doubao.com/chat/38439092690721538", { modeReady: true }).status, "already");
  assert.equal(doubaoVideoEntryDecision([
    { label: "视频生成", href: "", visible: true, enabled: false },
  ], "https://www.doubao.com/chat/").status, "missing");
});

test("豆包入口有两个不同的同优先级目标时失败关闭", () => {
  const decision = doubaoVideoEntryDecision([
    { label: "视频生成", href: "/chat/create-video", visible: true },
    { label: "视频创作", href: "/studio/video-create", visible: true },
    { label: "语音创作", href: "/voice", visible: true },
  ], "https://www.doubao.com/chat/");
  assert.equal(decision.status, "ambiguous");
  assert.deepEqual(decision.diagnostics, ["视频生成", "视频创作"]);
});

test("旧分析和不合格分析不能绕过桌面执行器的质量门", () => {
  assert.deepEqual(generationReadiness({}), {
    ready: false,
    status: "needs_analysis",
    error: "这条素材仍是旧的行业模板提示词，请重新分析后再生成",
  });
  assert.deepEqual(generationReadiness({ remake_plan: { plan: { seedanceWorkflow: {
    schemaVersion: 3,
    generationReadiness: { ready: false, blockers: ["结构悬空"] },
  } } } }), {
    ready: false,
    status: "quality_blocked",
    error: "生成前质量门未通过：结构悬空",
  });
  assert.equal(generationReadiness({ remake_plan: { plan: { seedanceWorkflow: {
    schemaVersion: 3,
    generationReadiness: { ready: true, blockers: [] },
  } } } }).ready, true);
});

test("今日运行条件深检识别 GPT 和最多 8 个独立豆包账号", async () => {
  const opened = [];
  function fakeWindow(provider, accountId) {
    return {
      webContents: {
        getURL: () => provider === "gpt"
          ? "https://chatgpt.com/"
          : accountId === "account-2" ? "https://www.doubao.com/passport/login" : "https://www.doubao.com/chat/",
        executeJavaScript: async (source) => {
          if (provider === "gpt") return { loginRequired: false, editorReady: true };
          if (source.includes("const nodes =")) {
            if (accountId === "account-4") return { status: "missing", kind: "", index: -1, label: "", pathname: "/chat/", diagnostics: [] };
            return { status: "click", kind: "video", index: 0, label: "视频生成", pathname: "/chat/", diagnostics: ["视频生成"] };
          }
          if (accountId === "account-2") return {
            loginRequired: true, quotaExhausted: false, authorizationRequired: false,
            riskBlocked: false, assistantFinishState: "unknown", editorReady: false, probeFailed: false,
          };
          if (accountId === "account-3") return {
            loginRequired: false, quotaExhausted: true, authorizationRequired: false,
            riskBlocked: false, assistantFinishState: "unknown", editorReady: true, probeFailed: false,
          };
          assert.match(source, /editorReady/);
          return {
            loginRequired: false, quotaExhausted: false, authorizationRequired: false,
            riskBlocked: false, assistantFinishState: "unknown", editorReady: true, probeFailed: false,
          };
        },
      },
    };
  }
  const creative = createCreativeRunner({
    openStudio(provider, options = {}) {
      opened.push({ provider, options });
      return { ok: true, window: fakeWindow(provider, options.accountId) };
    },
    waitForStudio: async () => {},
  });
  const report = await creative.probeAccounts([
    "account-1", "account-2", "account-3", "account-4", "account-5", "account-6", "account-7", "account-8", "account-9",
  ]);
  assert.deepEqual(report.gpt, { state: "ready", reason: "已登录，生图输入框可用" });
  assert.equal(report.doubao.length, 8);
  assert.deepEqual(report.doubao.slice(0, 3).map((row) => [row.id, row.state]), [
    ["account-1", "ready"],
    ["account-2", "attention"],
    ["account-3", "attention"],
  ]);
  assert.equal(report.doubao[0].reason, "已登录，视频生成入口可用");
  assert.equal(report.doubao[3].state, "unknown");
  assert.match(report.doubao[3].reason, /尚未确认视频生成入口/);
  assert.equal(opened.filter((row) => row.provider === "gpt").length, 1);
  assert.equal(opened.filter((row) => row.provider === "seedance").length, 8);
  assert.ok(opened.every((row) => row.options.show === false), "深检不应弹出创作窗口");
  assert.doesNotMatch(JSON.stringify(report), /cookie|token|password/i);
});

test("桌面 IPC 只暴露运行条件检查参数，不传递凭证", async () => {
  const [mainSource, preloadSource, serverSource, zapiSource] = await Promise.all([
    readFile(new URL("../desktop/main.js", import.meta.url), "utf8"),
    readFile(new URL("../desktop/preload.js", import.meta.url), "utf8"),
    readFile(new URL("../local-agent/server.mjs", import.meta.url), "utf8"),
    readFile(new URL("../app/zapi.ts", import.meta.url), "utf8"),
  ]);
  assert.match(mainSource, /zhitai:runtime-conditions:check/);
  assert.match(mainSource, /runtime-conditions\/creative/);
  assert.match(mainSource, /runtime-conditions\/refresh/);
  assert.doesNotMatch(mainSource, /runtime-conditions\?refresh=/);
  assert.match(mainSource, /repairedJob/);
  assert.match(mainSource, /repairedLegacyReference/);
  assert.match(mainSource, /verifiedFixRetryReady/);
  assert.match(mainSource, /网页\/UI\/登录错误仍按提供方级 4 小时退避/);
  assert.match(mainSource, /lastError/);
  assert.match(mainSource, /isClearlyJobSpecificCreativeError/);
  assert.match(mainSource, /attemptedJobIds/);
  assert.match(mainSource, /needs_revision\/坏素材饿死队列/);
  assert.match(mainSource, /qualifiedCreativeReviewCount/);
  assert.match(mainSource, /MAX_CONSECUTIVE_REVISION_ATTEMPTS/);
  assert.match(serverSource, /advance\|attention/);
  assert.match(serverSource, /网页生成需处理/);
  assert.match(serverSource, /shouldAcknowledgeRemoteUserReply\(result\)/);
  assert.match(serverSource, /await notificationCenter\?\.stop\(\)/);
  assert.match(serverSource, /decideInboxAuthentication\(\{/);
  assert.match(serverSource, /if \(authentication === "signature"\) \{\s*await verifyWebhook\(request, raw\)/);
  assert.doesNotMatch(serverSource, /x-zhitai-signature"\]\s*&&\s*config\.webhookSecret/);
  assert.match(serverSource, /if \(runtimeConditionsRefreshInFlight\) return runtimeConditionsRefreshInFlight/);
  assert.match(serverSource, /RUNTIME_CONDITIONS_REFRESH_COOLDOWN_MS/);
  assert.match(zapiSource, /runtime-conditions\/refresh/);
  assert.match(zapiSource, /refresh \? "POST" : "GET"/);
  assert.doesNotMatch(zapiSource, /runtime-conditions\$\{query\}|\?refresh=1/);
  assert.match(preloadSource, /checkRuntimeConditions:\s*\(accountIds = \[\], refresh = false\)/);
  assert.doesNotMatch(preloadSource, /cookie|password|secret/i);
});
