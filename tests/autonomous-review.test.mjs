import test from "node:test";
import assert from "node:assert/strict";
import {
  assessAutonomousContentReview,
  AUTONOMOUS_REVIEW_POLICY_VERSION,
} from "../local-agent/autonomous-review.mjs";

function strictWorkflow({
  title = "厨房改造怎么做得更清楚耐看？",
  voiceover = "想让厨房改造更清楚耐看，先统一动线、比例和灯光。厨房改造不只看单个细节，台面、柜体和照明协调，效果才完整。",
} = {}) {
  return {
    originality: {
      policy: "strict_full_original",
      status: "remediated",
      sourceRightsStatus: "unverified",
      referenceVideoAllowed: false,
      sourceAudioAllowed: false,
      sourceMusicAllowed: false,
      originalVisualsRequired: true,
      originalVoiceoverRequired: true,
      originalTitle: title,
      originalVoiceover: voiceover,
    },
    shots: [
      { narration: voiceover.split("。")[0] + "。" },
      { narration: voiceover.split("。")[1] + "。" },
    ],
  };
}

function strictMachine({
  assetId = "asset-kitchen",
  taskId = "creative-kitchen",
  quality = "high",
  mediaSha256 = "a".repeat(64),
  mediaSizeBytes = 1234567,
  narration = "想让厨房改造更清楚耐看，先统一动线、比例和灯光。厨房改造不只看单个细节，台面、柜体和照明协调，效果才完整。",
  engine = "ZhitaiSeedance",
} = {}) {
  const storyboards = [1, 2, 3].map((index) => ({
    ...(engine === "ZhitaiLocalMotion" ? { index, width: 1080, height: 1920 } : {}),
    name: `storyboard-${String(index).padStart(2, "0")}.png`,
    sizeBytes: 1_000 + index,
    sha256: String(index).repeat(64),
  }));
  const localMotion = engine === "ZhitaiLocalMotion" ? {
    width: 1080,
    height: 1920,
    fps: 30,
    totalFrames: 750,
    durationMs: 25_000,
    segments: storyboards.map((storyboard, offset) => ({
      index: offset + 1,
      sourceStoryboard: storyboard.name,
      sourceStoryboardSha256: storyboard.sha256,
      clipName: `clip-${String(offset + 1).padStart(2, "0")}.mp4`,
      clipSha256: String.fromCharCode(100 + offset).repeat(64),
      clipSizeBytes: 2_000 + offset,
      width: 1080,
      height: 1920,
      fps: 30,
      frameCount: 250,
      durationMs: offset === 2 ? 8_334 : 8_333,
    })),
    audio: {
      codec: "aac",
      narrationComplete: true,
      timingVerified: true,
      meanVolumeDb: -20,
      maxVolumeDb: -3,
      narrationSha256: "f".repeat(64),
    },
  } : null;
  return {
    passed: true,
    strictGenerated: true,
    audioQuality: {
      ok: true,
      integrity: true,
      meanVolumeDb: -22.4,
      maxVolumeDb: -3.1,
      narration,
    },
    preparation: {
      payload: { draft: false, platforms: [] },
      content: { id: assetId, mediaSha256 },
      generation: {
        engine,
        engine_task_id: taskId,
        sha256: mediaSha256,
        size_bytes: mediaSizeBytes,
      },
      publishQuality: { state: quality },
      scheduleBinding: {
        generationEngine: engine,
        generationTaskId: taskId,
        evidenceMode: engine === "ZhitaiLocalMotion" ? "local_storyboard_motion" : "seedance_web_generation",
        generationProvenanceSha256: "d".repeat(64),
        storyboardFingerprint: "e".repeat(64),
        storyboards,
        ...(localMotion ? { motionManifestSha256: "9".repeat(64), localMotion } : {}),
        mediaSha256,
        mediaSizeBytes,
        audioQualitySha256: "b".repeat(64),
        workflowSha256: "c".repeat(64),
      },
    },
  };
}

function review(overrides = {}) {
  const workflow = overrides.workflow || strictWorkflow();
  const narration = workflow?.originality?.originalVoiceover
    || (workflow?.shots || []).map((shot) => shot?.narration).filter(Boolean).join(" ");
  const machineCheck = overrides.machineCheck || strictMachine({ narration });
  return assessAutonomousContentReview({
    title: "厨房改造怎么做得更清楚耐看？",
    workflow,
    machineCheck,
    expectedAssetId: "asset-kitchen",
    expectedGenerationTaskId: "creative-kitchen",
    ...overrides,
  });
}

function reasonCodes(result) {
  return result.reasons.map((item) => item.code);
}

test("严格机器证据、原创隔离和观众文案全部通过时自主批准公开发布", () => {
  const result = review();
  assert.equal(result.status, "approved_for_publish");
  assert.equal(result.approved, true);
  assert.equal(result.reviewer, "zhitai_autonomous");
  assert.equal(AUTONOMOUS_REVIEW_POLICY_VERSION, "autonomous-content-review-v4");
  assert.equal(result.policyVersion, AUTONOMOUS_REVIEW_POLICY_VERSION);
  assert.deepEqual(result.reasons, []);
  assert.equal(result.evidence.machine.generationTaskId, "creative-kitchen");
  assert.equal(result.evidence.machine.mediaSizeBytes, 1234567);
  assert.equal(result.evidence.machine.audioQuality.reportBound, true);
  assert.equal(result.evidence.rights.mode, "strict_full_original");
  assert.equal(result.evidence.semantics.topic.matched, true);
});

test("经过严格 manifest 绑定的 LocalMotion 可按 v4 自主批准，引擎或片段篡改失败关闭", () => {
  const approved = review({ machineCheck: strictMachine({ engine: "ZhitaiLocalMotion" }) });
  assert.equal(approved.status, "approved_for_publish");
  assert.equal(approved.evidence.machine.generationEngine, "ZhitaiLocalMotion");
  assert.equal(approved.evidence.machine.evidenceMode, "local_storyboard_motion");
  assert.equal(approved.evidence.machine.localMotion.totalFrames, 750);

  const engineTampered = strictMachine({ engine: "ZhitaiLocalMotion" });
  engineTampered.preparation.generation.engine = "ZhitaiSeedance";
  assert.ok(reasonCodes(review({ machineCheck: engineTampered })).includes("generation_engine_invalid"));

  const segmentTampered = strictMachine({ engine: "ZhitaiLocalMotion" });
  segmentTampered.preparation.scheduleBinding.localMotion.segments[1].clipSha256 = "x".repeat(64);
  assert.ok(reasonCodes(review({ machineCheck: segmentTampered })).includes("local_motion_evidence_invalid"));
});

test("严格预检失败、不是公开级预检或缺少绑定时失败关闭", () => {
  const machineCheck = strictMachine();
  machineCheck.passed = false;
  machineCheck.strictGenerated = false;
  machineCheck.preparation.payload.draft = true;
  machineCheck.preparation.scheduleBinding.audioQualitySha256 = "";
  machineCheck.preparation.publishQuality.state = "unknown";
  const result = review({ machineCheck });
  assert.equal(result.status, "needs_revision");
  assert.deepEqual(reasonCodes(result), [
    "strict_preflight_failed",
    "strict_preflight_not_declared",
    "audio_quality_binding_missing",
    "public_preflight_not_used",
    "public_quality_not_ready",
  ]);
});

test("素材、任务、文件大小和 SHA-256 必须与当前审核任务完全一致", () => {
  const machineCheck = strictMachine({ assetId: "asset-other", taskId: "creative-other" });
  machineCheck.preparation.generation.engine = "legacy";
  machineCheck.preparation.generation.engine_task_id = "creative-database-other";
  machineCheck.preparation.generation.size_bytes += 1;
  const result = review({ machineCheck });
  assert.equal(result.status, "needs_revision");
  assert.ok(reasonCodes(result).includes("asset_binding_mismatch"));
  assert.ok(reasonCodes(result).includes("generation_engine_invalid"));
  assert.ok(reasonCodes(result).includes("generation_task_binding_mismatch"));
  assert.ok(reasonCodes(result).includes("generation_record_binding_mismatch"));
  assert.ok(reasonCodes(result).includes("media_binding_mismatch"));
});

test("音量阈值即使仅差一点也不能自主批准", () => {
  const machineCheck = strictMachine();
  machineCheck.audioQuality.meanVolumeDb = -34.1;
  machineCheck.audioQuality.maxVolumeDb = -18.1;
  const result = review({ machineCheck });
  assert.equal(result.status, "needs_revision");
  assert.ok(reasonCodes(result).includes("audio_quality_failed"));
});

test("分析术语、拍摄指令和占位话术不会进入已批准状态", () => {
  const workflow = strictWorkflow({
    title: "这个主题待确认",
    voiceover: "本镜头的 ASR 分析结果显示，拍摄对象站着并说话，后期选取稳定画面。",
  });
  const result = review({ title: "这个主题待确认", workflow });
  assert.equal(result.status, "needs_revision");
  assert.ok(reasonCodes(result).includes("analysis_language"));
  assert.ok(reasonCodes(result).includes("production_language"));
  assert.ok(reasonCodes(result).includes("placeholder_language"));
  assert.equal(result.evidence.semantics.audienceFacing, false);
});

test("旁白与标题主题错配时明确要求返工", () => {
  const workflow = strictWorkflow({
    title: "PU 线条怎么做得更清楚耐看？",
    voiceover: "厨房改造先理顺灶台、水槽和台面的动线，再统一橱柜与灯光。",
  });
  const result = review({ title: "PU 线条怎么做得更清楚耐看？", workflow });
  assert.equal(result.status, "needs_revision");
  assert.ok(reasonCodes(result).includes("narration_theme_mismatch"));
  assert.equal(result.evidence.semantics.topic.matched, false);
  assert.deepEqual(result.evidence.semantics.topic.titleGroups, ["wall_decor"]);
  assert.deepEqual(result.evidence.semantics.topic.narrationGroups, ["kitchen", "lighting"]);
});

test("旁白大量重复同一句时失败关闭并返回可核对证据", () => {
  const repeated = "我家这4㎡硬是塞进泡澡、淋浴、马桶和洗漱。";
  const workflow = strictWorkflow({
    title: "4㎡小户型卫生间布局",
    voiceover: `${repeated}${repeated}`,
  });
  const result = review({ title: "4㎡小户型卫生间布局", workflow });
  assert.equal(result.status, "needs_revision");
  assert.ok(reasonCodes(result).includes("narration_excessive_repetition"));
  assert.equal(result.evidence.semantics.narrationQuality.excessiveRepetition, true);
  assert.deepEqual(result.evidence.semantics.narrationQuality.repeatedSegments, [{
    text: "我家这4㎡硬是塞进泡澡、淋浴、马桶和洗漱",
    count: 2,
    kind: "sentence",
  }]);
});

test("同一片段在旁白中高密度重复时也失败关闭", () => {
  const workflow = strictWorkflow({
    title: "小户型卫生间干湿分区",
    voiceover: "卫生间先做干湿分区，卫生间先做干湿分区，卫生间先做干湿分区，淋浴放里面。",
  });
  const result = review({ title: "小户型卫生间干湿分区", workflow });
  assert.equal(result.status, "needs_revision");
  assert.ok(reasonCodes(result).includes("narration_excessive_repetition"));
  assert.deepEqual(result.evidence.semantics.narrationQuality.repeatedSegments, [{
    text: "卫生间先做干湿分区",
    count: 3,
    kind: "clause",
  }]);
});

test("旁白中的孤立空泛句必须返工", () => {
  const workflow = strictWorkflow({
    title: "小户型卫生间布局",
    voiceover: "小户型卫生间先安排洗漱、马桶和淋浴。更清楚耐看。",
  });
  const result = review({ title: "小户型卫生间布局", workflow });
  assert.equal(result.status, "needs_revision");
  assert.ok(reasonCodes(result).includes("narration_low_information_sentence"));
  assert.deepEqual(result.evidence.semantics.narrationQuality.lowInformationSentences, [{
    text: "更清楚耐看",
    index: 2,
  }]);
});

test("自审优先使用成片质检报告绑定的实际旁白，不被后续改写的计划误导", () => {
  const workflow = strictWorkflow({
    title: "小户型卫生间布局",
    voiceover: "小户型卫生间先理顺洗漱、马桶、淋浴和泡澡四区动线。",
  });
  const actualNarration = "想让我家这4㎡，硬是塞进了泡澡+淋浴+马桶+洗漱，还不显挤！更清楚耐看。不用堆满元素，围绕我家这4㎡，硬是塞进了泡澡+淋浴+马桶+洗漱。我家这4㎡，硬是塞进了泡澡+淋浴+马桶+洗漱。";
  const result = review({
    title: "小户型卫生间布局",
    workflow,
    machineCheck: strictMachine({ narration: actualNarration }),
  });
  assert.equal(result.status, "needs_revision");
  assert.ok(reasonCodes(result).includes("narration_excessive_repetition"));
  assert.ok(reasonCodes(result).includes("narration_low_information_sentence"));
  assert.equal(result.evidence.semantics.narrationSource, "bound_audio_quality_report");
  assert.equal(result.evidence.machine.audioQuality.narrationBound, true);
});

test("严格生成成片缺少实际旁白绑定时失败关闭", () => {
  const machineCheck = strictMachine({ narration: "" });
  const result = review({ machineCheck });
  assert.equal(result.status, "needs_revision");
  assert.ok(reasonCodes(result).includes("audio_narration_binding_missing"));
  assert.ok(reasonCodes(result).includes("narration_missing"));
});

test("同一主题的合理复述不会被误判为大量重复", () => {
  const workflow = strictWorkflow({
    title: "厨房改造动线和收纳",
    voiceover: "厨房改造先理顺灶台、水槽和台面的动线。厨房改造还要统一柜体尺度，给常用厨具留出顺手位置。最后用照明补足操作区亮度。",
  });
  const result = review({ title: "厨房改造动线和收纳", workflow });
  assert.equal(result.status, "approved_for_publish");
  assert.equal(result.evidence.semantics.narrationQuality.excessiveRepetition, false);
  assert.deepEqual(result.evidence.semantics.narrationQuality.repeatedSegments, []);
  assert.deepEqual(result.evidence.semantics.narrationQuality.lowInformationSentences, []);

  const parallelWorkflow = strictWorkflow({
    title: "厨房改造动线安排",
    voiceover: "厨房改造先理顺动线，灶台旁留出备菜区。厨房改造先理顺动线，水槽旁安排沥水区。",
  });
  const parallel = review({ title: "厨房改造动线安排", workflow: parallelWorkflow });
  assert.equal(parallel.status, "approved_for_publish");
  assert.equal(parallel.evidence.semantics.narrationQuality.excessiveRepetition, false);
});

test("权利明确的来源可通过权利门，但未确认来源必须走严格原创隔离", () => {
  const ownedWorkflow = {
    sourceRights: { status: "owned" },
    shots: [{ narration: "儿童房先留出活动区，再根据年龄安排书桌和收纳。" }],
  };
  const approved = review({
    title: "儿童房成长型布局",
    workflow: ownedWorkflow,
  });
  assert.equal(approved.status, "approved_for_publish");
  assert.equal(approved.evidence.rights.mode, "confirmed_source_rights");

  const unverified = review({
    title: "儿童房成长型布局",
    workflow: { ...ownedWorkflow, sourceRights: { status: "unverified" } },
  });
  assert.equal(unverified.status, "needs_revision");
  assert.ok(reasonCodes(unverified).includes("rights_or_originality_unverified"));
});
