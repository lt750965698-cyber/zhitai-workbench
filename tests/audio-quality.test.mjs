import assert from "node:assert/strict";
import test from "node:test";
import { validateAudioQualityReport } from "../local-agent/audio-quality.mjs";

const media = { sizeBytes: 2048, sha256: "a".repeat(64), expectedJobId: "creative_123" };
const passed = {
  status: "passed",
  jobId: media.expectedJobId,
  meanVolumeDb: -21.3,
  maxVolumeDb: -5.2,
  outputSizeBytes: media.sizeBytes,
  outputSha256: media.sha256,
};

test("可听报告与当前成片字节一致时通过", () => {
  assert.deepEqual(validateAudioQualityReport(passed, media), {
    ok: true,
    meanVolumeDb: -21.3,
    maxVolumeDb: -5.2,
  });
});

test("缺失、失败和低响度报告被拒绝", () => {
  assert.equal(validateAudioQualityReport(null, media).reason, "missing");
  assert.equal(validateAudioQualityReport({ ...passed, status: "failed" }, media).reason, "failed");
  assert.equal(validateAudioQualityReport({ ...passed, meanVolumeDb: -40 }, media).reason, "failed");
  assert.equal(validateAudioQualityReport({ ...passed, maxVolumeDb: Number.NaN }, media).reason, "failed");
});

test("报告、数据库或任务身份与成片不一致时拒绝", () => {
  assert.equal(validateAudioQualityReport({ ...passed, outputSizeBytes: 2047 }, media).reason, "integrity");
  assert.equal(validateAudioQualityReport({ ...passed, outputSha256: "b".repeat(64) }, media).reason, "integrity");
  assert.equal(validateAudioQualityReport({ ...passed, jobId: "creative_other" }, media).reason, "integrity");
  assert.equal(validateAudioQualityReport(passed, { ...media, expectedSizeBytes: 4096 }).reason, "integrity");
  assert.equal(validateAudioQualityReport(passed, { ...media, expectedSha256: "c".repeat(64) }).reason, "integrity");
});
