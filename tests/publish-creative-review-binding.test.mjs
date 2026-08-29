import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serverSource = await readFile(new URL("../local-agent/server.mjs", import.meta.url), "utf8");

function sourceBetween(startMarker, endMarker) {
  const start = serverSource.indexOf(startMarker);
  const end = serverSource.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `应能定位 ${startMarker}`);
  return serverSource.slice(start, end);
}

const assertionSource = sourceBetween(
  "function assertGenerationApprovedForPublish",
  "\nasync function approvedCreativeReviewBinding",
);
const httpError = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const assertGenerationApprovedForPublish = Function(
  "httpError",
  "AUTONOMOUS_REVIEWER",
  "AUTONOMOUS_REVIEW_POLICY_VERSION",
  "createHash",
  "STRICT_ZHITAI_GENERATION_ENGINES",
  "ZHITAI_LOCAL_MOTION_ENGINE",
  `return (${assertionSource});`,
)(httpError, "zhitai_autonomous", "autonomous-content-review-v4", createHash,
  ["ZhitaiSeedance", "ZhitaiLocalMotion"], "ZhitaiLocalMotion");

function fixture() {
  const assetId = "asset-current";
  const taskId = "creative_11111111-1111-4111-8111-111111111111";
  const generation = {
    id: "remake-current",
    engine: "ZhitaiSeedance",
    engine_task_id: taskId,
    size_bytes: 123_456,
    sha256: "a".repeat(64),
  };
  const review = {
    id: "review-current",
    assetId,
    jobId: taskId,
    generationId: generation.id,
    status: "approved_for_publish",
    reviewer: "zhitai_autonomous",
    reviewPolicyVersion: "autonomous-content-review-v4",
    reviewedAt: "2026-08-29T01:00:00.000Z",
    updatedAt: "2026-08-29T01:00:00.000Z",
    reviewEvidence: {
      machine: {
        strictPreflightPassed: true,
        strictGenerated: true,
        publicPreflight: true,
        assetId,
        generationEngine: "ZhitaiSeedance",
        generationTaskId: taskId,
        evidenceMode: "seedance_web_generation",
        generationProvenanceSha256: "9".repeat(64),
        storyboardFingerprint: "8".repeat(64),
        motionManifestSha256: null,
        storyboards: [
          { name: "storyboard-01.png", sizeBytes: 80, sha256: "1".repeat(64) },
          { name: "storyboard-02.png", sizeBytes: 81, sha256: "2".repeat(64) },
        ],
        mediaSha256: generation.sha256,
        mediaSizeBytes: generation.size_bytes,
        audioQualitySha256: "b".repeat(64),
        workflowSha256: "c".repeat(64),
        audioQuality: { reportPassed: true, integrity: true },
        generatedClips: {
          passed: true,
          expectedShotCount: 2,
          actualShotCount: 2,
          clips: [
            { name: "clip-01.mp4", sizeBytes: 100, sha256: "d".repeat(64) },
            { name: "clip-02.mp4", sizeBytes: 101, sha256: "e".repeat(64) },
          ],
        },
      },
    },
  };
  return { assetId, taskId, generation, review };
}

function rejectionMessage(run) {
  try { run(); }
  catch (error) {
    assert.equal(error.statusCode, 409);
    return error.message;
  }
  assert.fail("预期严格失败关闭");
}

test("只有任务、素材、生成记录和当前自审证据全部精确一致才可发", () => {
  const { assetId, generation, review } = fixture();
  const binding = assertGenerationApprovedForPublish([review], { assetId, generation });
  assert.equal(binding.creativeReviewId, review.id);
  assert.equal(binding.creativeReviewPolicyVersion, review.reviewPolicyVersion);
  assert.match(binding.creativeReviewSha256, /^[a-f0-9]{64}$/);

  const changed = structuredClone(review);
  changed.updatedAt = "2026-08-29T01:00:01.000Z";
  assert.notEqual(
    assertGenerationApprovedForPublish([changed], { assetId, generation }).creativeReviewSha256,
    binding.creativeReviewSha256,
    "排期应绑定具体审核版本，复审落盘后不能沿用旧绑定",
  );
});

test("LocalMotion 只有在 manifest、分镜、片段和音频证据与审核全部一致时可发", () => {
  const value = fixture();
  value.generation.engine = "ZhitaiLocalMotion";
  const machine = value.review.reviewEvidence.machine;
  machine.generationEngine = "ZhitaiLocalMotion";
  machine.evidenceMode = "local_storyboard_motion";
  machine.motionManifestSha256 = "7".repeat(64);
  machine.storyboards = machine.storyboards.map((item, index) => ({
    index: index + 1,
    width: 1080,
    height: 1920,
    ...item,
  }));
  // LocalMotion 合同固定三段。
  machine.storyboards.push({
    index: 3, width: 1080, height: 1920,
    name: "storyboard-03.png", sizeBytes: 82, sha256: "3".repeat(64),
  });
  machine.generatedClips.expectedShotCount = 3;
  machine.generatedClips.actualShotCount = 3;
  machine.generatedClips.clips.push({ name: "clip-03.mp4", sizeBytes: 102, sha256: "f".repeat(64) });
  machine.localMotion = {
    width: 1080, height: 1920, fps: 30, totalFrames: 750, durationMs: 25_000,
    segments: machine.generatedClips.clips.map((clip, index) => ({
      index: index + 1,
      sourceStoryboard: machine.storyboards[index].name,
      sourceStoryboardSha256: machine.storyboards[index].sha256,
      clipName: clip.name,
      clipSha256: clip.sha256,
      clipSizeBytes: clip.sizeBytes,
      width: 1080,
      height: 1920,
      fps: 30,
      frameCount: 250,
      durationMs: index === 2 ? 8_334 : 8_333,
    })),
    audio: {
      codec: "aac", narrationComplete: true, timingVerified: true,
      meanVolumeDb: -20, maxVolumeDb: -3, narrationSha256: "6".repeat(64),
    },
  };
  assert.doesNotThrow(() => assertGenerationApprovedForPublish([value.review], {
    assetId: value.assetId,
    generation: value.generation,
  }));

  const tampered = structuredClone(value.review);
  tampered.reviewEvidence.machine.localMotion.segments[0].sourceStoryboardSha256 = "0".repeat(64);
  assert.equal(
    rejectionMessage(() => assertGenerationApprovedForPublish([tampered], {
      assetId: value.assetId,
      generation: value.generation,
    })),
    "publish_creative_review_evidence_invalid",
  );
});

test("needs_revision、pending_review 和不存在审核均失败关闭", () => {
  const { assetId, generation, review } = fixture();
  for (const status of ["needs_revision", "pending_review"]) {
    const row = { ...review, status };
    assert.match(
      rejectionMessage(() => assertGenerationApprovedForPublish([row], { assetId, generation })),
      new RegExp(`publish_creative_review_not_approved：${status}`),
    );
  }
  assert.equal(
    rejectionMessage(() => assertGenerationApprovedForPublish([], { assetId, generation })),
    "publish_creative_review_missing",
  );
});

test("已撤销、过期策略、不匹配生成记录或不唯一分镜证据不能重新可发", () => {
  const { assetId, generation, review } = fixture();
  const cases = [
    [{ ...review, revisionTaskId: "creative-revision" }, "publish_creative_review_not_current"],
    [{ ...review, reviewPolicyVersion: "autonomous-content-review-v2" }, "publish_creative_review_policy_stale"],
    [{ ...review, generationId: "remake-old" }, "publish_creative_review_generation_mismatch"],
  ];
  for (const [row, message] of cases) {
    assert.equal(
      rejectionMessage(() => assertGenerationApprovedForPublish([row], { assetId, generation })),
      message,
    );
  }
  assert.equal(
    rejectionMessage(() => assertGenerationApprovedForPublish([review], {
      assetId,
      generation: { ...generation, engine: "legacy" },
    })),
    "publish_creative_review_generation_mismatch",
  );

  const duplicate = structuredClone(review);
  duplicate.reviewEvidence.machine.generatedClips.clips[1].sha256 = "d".repeat(64);
  assert.equal(
    rejectionMessage(() => assertGenerationApprovedForPublish([duplicate], { assetId, generation })),
    "publish_creative_review_evidence_invalid",
  );
});

test("视频和图文都选最新 completed generation 并在准备、持久排期及到点预检绑定审核", () => {
  const matrix = sourceBetween(
    "async function prepareMatrixPublish",
    "\nasync function executeMatrixPublish",
  );
  assert.match(matrix, /ORDER BY completed_at DESC, created_at DESC LIMIT 1/);
  assert.match(matrix, /creativeReviewBinding = await approvedCreativeReviewBinding\(json\.videoId, generation\)/);
  assert.match(matrix, /\.\.\.\(creativeReviewBinding \|\| \{\}\)/);
  assert.match(matrix, /creative_review_candidate_scope_invalid/);
  assert.match(matrix, /creative_review_candidate_generation_mismatch/);

  const image = sourceBetween(
    "async function resolveImageTextBundle",
    "\nasync function createPublishTask",
  );
  assert.match(image, /status='completed' ORDER BY completed_at DESC, created_at DESC LIMIT 1/);
  assert.match(image, /approvedCreativeReviewBinding\(asset\.id, generation\)/);
  assert.match(image, /\.\.\.creativeReviewBinding/);

  const schedules = sourceBetween(
    "async function scheduleMatrixVideoPublish",
    "\nfunction intentAwareScheduledResult",
  );
  assert.match(schedules, /binding:\s*prepared\.scheduleBinding/);
  assert.match(schedules, /async function scheduleImageTextPublish[\s\S]*?binding:\s*prepared\.scheduleBinding/);

  const duePreflight = sourceBetween(
    "async function preflightScheduledPublish",
    "\nfunction intentAwareScheduledResult",
  );
  assert.match(duePreflight, /requireExpectedBinding:\s*true/);
  assert.match(duePreflight, /expectedBinding:\s*payload\.binding/);
});
