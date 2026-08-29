import test from "node:test";
import assert from "node:assert/strict";
import {
  buildCheckpointReviewReport,
  buildReviewFramework,
  concludeExperiment,
  createExperimentCard,
  EXPERIMENT_FACTORS,
} from "../local-agent/operations-metrics.mjs";
import { openKbDb } from "../local-agent/kb.mjs";
import { syntheticExperimentCards } from "../local-agent/operations-synthetic.mjs";

test("选题、前三秒、封面、标题、时长和发布时间均生成一次只改一个主要变量的实验卡", () => {
  const cards = syntheticExperimentCards();
  assert.deepEqual(cards.map((card) => card.primaryFactor), EXPERIMENT_FACTORS);
  for (const card of cards) {
    const changed = Object.keys(card.control).filter((key) => JSON.stringify(card.control[key]) !== JSON.stringify(card.variant[key]));
    assert.deepEqual(changed, [card.primaryFactor]);
    assert.ok(card.baseline.windowStartAt);
    assert.ok(card.sampleSizePlan.control > 0 && card.sampleSizePlan.variant > 0);
    assert.ok(card.successMetric.key);
    assert.ok(card.stopConditions.minimumSamplePerArm > 0);
    assert.match(card.conclusionTemplate, /不自动外推为普遍因果/);
  }
});

test("实验卡拒绝零个或两个主变量变化、非法样本量及观察性因果标签", () => {
  const base = {
    id: "exp-invalid",
    primaryFactor: "title",
    hypothesis: "测试标题",
    control: { topic: "A", hook_3s: "A", cover: "A", title: "A", duration: 20, publish_time: "20:00" },
    variant: { topic: "A", hook_3s: "A", cover: "A", title: "B", duration: 20, publish_time: "20:00" },
    baseline: { referenceId: "baseline", window: "14d", sampleSize: 8, metric: { status: "available", value: 0.1 } },
    sampleUnit: "platform_post",
    plannedSampleSize: 16,
    minimumSampleSize: 8,
    assignmentMethod: "matched",
    evidenceLevel: "associational",
    successMetric: { name: "completion_rate", direction: "increase", horizon: "P1D", minimumDetectableEffect: 0.03 },
    platforms: ["douyin"],
    stopConditions: { maxDurationDays: 14, guardrails: ["negative_feedback"], dataQuality: ["coverage"] },
    createdAt: "2026-08-01T00:00:00.000Z",
  };
  assert.doesNotThrow(() => createExperimentCard(base));
  assert.throws(() => createExperimentCard({ ...base, variant: base.control }), /exactly_one_primary_factor/);
  assert.throws(() => createExperimentCard({ ...base, variant: { ...base.variant, topic: "B" } }), /exactly_one_primary_factor/);
  assert.throws(() => createExperimentCard({ ...base, control: { topic: "A", title: "A" }, variant: { topic: "A", title: "B" } }), /cover_all_primary_factors/);
  assert.throws(() => createExperimentCard({ ...base, plannedSampleSize: 0 }), /positive_integer/);
  assert.throws(() => createExperimentCard({ ...base, evidenceLevel: "causal_randomized" }), /requires_randomization/);
});

test("未达最小样本或主指标缺失时实验结论只能是数据不足", () => {
  const card = syntheticExperimentCards()[0];
  const tooSmall = concludeExperiment(card, {
    controlSampleSize: card.stopConditions.minimumSamplePerArm - 1,
    variantSampleSize: card.stopConditions.minimumSamplePerArm,
    primaryMetric: { status: "available", value: 0.35 },
    asOf: "2026-08-10T00:00:00.000Z",
  });
  assert.equal(tooSmall.status, "insufficient_data");
  assert.match(tooSmall.conclusion, /不判断胜负/);
  const missing = concludeExperiment(card, {
    controlSampleSize: card.stopConditions.minimumSamplePerArm,
    variantSampleSize: card.stopConditions.minimumSamplePerArm,
    windowComplete: true,
    guardrailsPassed: true,
    dataQualityPassed: true,
    primaryMetric: { status: "not_collected", value: null, reasonCode: "snapshot_not_due" },
    asOf: "2026-08-10T00:00:00.000Z",
  });
  assert.equal(missing.status, "insufficient_data");
  const complete = concludeExperiment(card, {
    controlSampleSize: card.stopConditions.minimumSamplePerArm,
    variantSampleSize: card.stopConditions.minimumSamplePerArm,
    windowComplete: true,
    guardrailsPassed: true,
    dataQualityPassed: true,
    primaryMetric: { status: "available", value: 0.36 },
    decision: "adopt_for_further_test",
    asOf: "2026-08-15T00:00:00.000Z",
  });
  assert.equal(complete.status, "completed");
  assert.match(complete.conclusion, /不自动证明/);
});

test("7/14/30 天复盘按 anchor 和 as_of 定界，不提前读取未来", () => {
  const anchorAt = "2026-08-01T00:00:00.000Z";
  const beforeD7 = buildReviewFramework({ anchorAt, asOf: "2026-08-07T23:59:59.999Z", hasData: true });
  assert.deepEqual(beforeD7.map((row) => row.status), ["not_due", "not_due", "not_due"]);
  const atD14 = buildReviewFramework({ anchorAt, asOf: "2026-08-15T00:00:00.000Z", hasData: true });
  assert.deepEqual(atD14.map((row) => row.status), ["ready", "ready", "not_due"]);
  assert.equal(atD14[0].dataCutoff, "2026-08-08T00:00:00.000Z");
  assert.equal(atD14[1].dataCutoff, "2026-08-15T00:00:00.000Z");
  const missing = buildReviewFramework({ anchorAt, asOf: "2026-08-31T00:00:00.000Z", hasData: false });
  assert.deepEqual(missing.map((row) => row.status), ["missing_data", "missing_data", "missing_data"]);
});

test("D7 单独复盘不会把 D8 才形成的发布、审核或生成终态读回 D7", () => {
  const db = openKbDb(":memory:");
  try {
    const anchorAt = "2026-08-01T00:00:00.000Z";
    const common = {
      dataMode: "observed",
      anchorAt,
      checkpointDay: 7,
      asOf: "2026-08-10T00:00:00.000Z",
      publishReceipts: [{
        id: "receipt-after-cutoff",
        platform: "douyin",
        mode: "public",
        state: "public",
        createdAt: "2026-08-02T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
      }],
      creativeReviews: [{
        id: "review-after-cutoff",
        generationId: "generation-a",
        status: "needs_revision",
        createdAt: "2026-08-02T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
      }],
      creativeJobs: [{
        id: "job-after-cutoff",
        status: "completed",
        createdAt: "2026-08-02T00:00:00.000Z",
        updatedAt: "2026-08-09T00:00:00.000Z",
      }],
    };
    const result = buildCheckpointReviewReport(db, common);
    assert.equal(result.asOf, "2026-08-08T00:00:00.000Z");
    assert.equal(result.report.metrics.public_rate.status, "not_collected");
    assert.equal(result.report.metrics.rework_rate.status, "not_collected");
    assert.equal(result.report.metrics.generation_success_rate.status, "not_collected");
    assert.equal(result.report.dailyOperations.pendingReviews, 1);
  } finally {
    db.close();
  }
});
