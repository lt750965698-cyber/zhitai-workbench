import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { openKbDb } from "../local-agent/kb.mjs";
import {
  buildOperationsReport,
  linkPlatformPostLineage,
  normalizeCreativeReviews,
  normalizePublishReceipts,
  renderOperationsReportMarkdown,
} from "../local-agent/operations-metrics.mjs";
import { buildSyntheticOperationsReport, syntheticOperationsInputs } from "../local-agent/operations-synthetic.mjs";

test("合成验收报告覆盖十项指标、分轨漏斗、四个快照时点且不把 submitted 当公开", () => {
    const report = buildSyntheticOperationsReport();
    assert.equal(report.schemaVersion, "1.0.0");
    assert.equal(report.contract, "zhitai.operations_metrics");
    assert.equal(Object.keys(report.metrics).length, 10);
    assert.equal(report.synthetic, true);
    assert.equal(report.metrics.collection_volume.value, 4);
    assert.equal(report.metrics.ingestion_success_rate.value, 0.666667);
    assert.equal(report.metrics.analysis_backlog.value, 1);
    assert.equal(report.metrics.generation_success_rate.value, 0.5);
    assert.equal(report.metrics.rework_rate.value, 0.5);
    assert.equal(report.metrics.draft_rate.value, 0.333333);
    assert.equal(report.metrics.public_rate.numerator, 1);
    assert.equal(report.metrics.public_rate.denominator, 3);
    assert.equal(report.metrics.public_rate.publicAmongFinalVisibility, 0.5);
    assert.equal(report.metrics.public_rate.submittedUnknownVisibility, 1);
    assert.equal(report.kpis.collectionVolume.value, report.metrics.collection_volume.value);
    assert.equal(report.kpis.publicRate.value, report.metrics.public_rate.value);
    assert.equal(report.feedbackFunnel.content.stages.find((row) => row.key === "ingested").count, 2);
    assert.equal(report.feedbackFunnel.distribution.publishedPosts, 3);
    assert.deepEqual(Object.keys(report.snapshotCoverage), ["PT1H", "P1D", "P7D", "P30D"]);
    assert.ok(Object.values(report.snapshotCoverage).every((row) => row.recordedPosts === 3));
    assert.ok(report.platformMetricStates.availableZero >= 1);
    assert.ok(report.platformMetricStates.unavailable >= 1);
    assert.ok(report.platformMetricStates.not_collected >= 1);
    assert.ok(report.platformMetricStates.permission_denied >= 1);
    assert.deepEqual(report.reviewFramework.map((row) => row.status), ["ready", "ready", "ready"]);
    assert.ok(report.snapshots.every((row) => ["PT1H", "P1D", "P7D", "P30D"].includes(row.snapshotOffset)));
    assert.equal(report.lineage.platformPosts.length, 3);
    assert.equal(report.feedbackFunnel.generationAttempts.stages.find((row) => row.key === "completed").count, 1);
    const contentCounts = report.feedbackFunnel.content.stages.map((row) => row.count);
    assert.ok(contentCounts.every((count, index) => index === 0 || count <= contentCounts[index - 1]));
    assert.deepEqual(report.funnels.content.stages.map((row) => row.count), contentCounts);
    assert.equal(report.reviews.day7.dataCutoffAt, report.reviewFramework[0].dataCutoff);
    assert.deepEqual(report.reviews.day30.snapshotOffsets, report.reviewFramework[2].horizons);
    assert.equal(report.reviews.day7.coverage.eligibleCount, 6);
    assert.equal(report.reviews.day14.coverage.eligibleCount, 9);
    assert.equal(report.reviews.day30.coverage.eligibleCount, 9);
});

test("相同隔离夹具和固定 as_of 生成结构稳定的报告", () => {
    const first = buildSyntheticOperationsReport();
    const second = buildSyntheticOperationsReport();
    assert.deepEqual(first, second);
});

test("缺少尝试账本或发布回执时返回 not_collected，不伪造 0% 或 100%", () => {
  const db = openKbDb(":memory:");
  try {
    const now = "2026-08-02T00:00:00.000Z";
    db.prepare("INSERT INTO video_asset (id,title,created_at,updated_at) VALUES ('asset-only-success','A',?,?)").run(now, now);
    db.prepare(`INSERT INTO remake_generation
      (id,asset_id,engine,status,created_at,completed_at) VALUES ('generation-only-success','asset-only-success','fixture','completed',?,?)`).run(now, now);
    const report = buildOperationsReport(db, {
      dataMode: "observed",
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-03T00:00:00.000Z",
      asOf: "2026-08-03T00:00:00.000Z",
      anchorAt: "2026-08-01T00:00:00.000Z",
    });
    assert.equal(report.metrics.generation_success_rate.status, "not_collected");
    assert.equal(report.metrics.generation_success_rate.value, null);
    assert.equal(report.metrics.generation_success_rate.completedArtifactsObserved, 1);
    assert.equal(report.metrics.public_rate.status, "not_collected");
    assert.equal(report.metrics.public_rate.value, null);
    assert.equal(report.metrics.ingestion_success_rate.status, "not_collected");
  } finally {
    db.close();
  }
});

test("合成报告必须显式启用隔离核心数据，并带水印与非因果声明", () => {
  const db = openKbDb(":memory:");
  try {
    const input = syntheticOperationsInputs();
    assert.throws(() => buildOperationsReport(db, { ...input, syntheticCore: false }), /explicit_isolated_fixture_opt_in/);
    assert.throws(() => buildOperationsReport(db, { ...input, syntheticCore: true }), /explicit_isolated_fixture_opt_in/);
    const report = buildSyntheticOperationsReport();
    const markdown = renderOperationsReportMarkdown(report);
    assert.match(markdown, /合成数据验收样例/);
    assert.match(markdown, /不代表真实运营结果/);
    assert.match(markdown, /submitted\/success.*不计入公开率/);
    assert.match(markdown, /不得据此改写为因果结论/);
    assert.doesNotMatch(markdown, /真实发布成功/);
    assert.doesNotMatch(markdown, /已证明|必然导致|因为更换封面所以提升/);
  } finally {
    db.close();
  }
});

test("合成夹具自己拥有内存库，不会写入调用方连接", () => {
  const db = openKbDb(":memory:");
  try {
    const now = "2026-08-01T00:00:00.000Z";
    db.prepare("INSERT INTO video_asset (id,title,created_at,updated_at) VALUES ('caller-row','A',?,?)").run(now, now);
    assert.throws(() => buildSyntheticOperationsReport(db), /does_not_accept_external_database/);
    buildSyntheticOperationsReport();
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM video_asset").get().count, 1);
    assert.equal(db.prepare("SELECT id FROM video_asset").get().id, "caller-row");
  } finally {
    db.close();
  }
});

test("canonical 回执/审核字段被适配，同一目的地修订只计最新状态", () => {
  const db = openKbDb(":memory:");
  try {
    db.prepare("INSERT INTO video_asset (id,title,created_at,updated_at) VALUES ('asset-a','A','2026-08-01T00:00:00.000Z','2026-08-01T00:00:00.000Z')").run();
    db.prepare("INSERT INTO import_batch (id,status,source_kind,created_at,total,succeeded,failed,skipped) VALUES ('b','done','fixture','2026-08-01T00:00:00.000Z',1,1,0,0)").run();
    db.prepare("INSERT INTO import_item (batch_id,input,input_kind,display_input,status,retry_count,asset_id,updated_at) VALUES ('b','a','fixture','a','success',0,'asset-a','2026-08-01T00:01:00.000Z')").run();
    const receiptBase = {
      receiptId: "receipt-a",
      publishTaskId: "task-a",
      materialId: "asset-a",
      generatedVideoId: "gen-a",
      platformPostId: "destination-a",
      platform: "douyin",
      accountRef: "account-a",
      requestedMode: "publish",
      sourceEventAt: "2026-08-01T01:00:00.000Z",
      source: "fixture",
      isSynthetic: false,
    };
    const publishReceipts = [
      { ...receiptBase, revision: 1, status: "platform_draft", observedAt: "2026-08-01T01:05:00.000Z", externalPostId: null, externalUrl: null },
      { ...receiptBase, revision: 2, status: "public_confirmed", observedAt: "2026-08-01T01:10:00.000Z", externalPostId: "post-a", externalUrl: null },
    ];
    const creativeReviews = [{
      reviewEventId: "review-event-a",
      reviewCycleId: "review-cycle-a",
      materialId: "asset-a",
      generatedVideoId: "gen-a",
      eventType: "decision",
      decision: "changes_requested",
      submittedAt: "2026-08-01T02:00:00.000Z",
      decisionAt: "2026-08-01T02:30:00.000Z",
      reasonCodes: ["hook_weak"],
      source: "fixture",
      isSynthetic: false,
    }];
    const normalizedReceipt = normalizePublishReceipts(publishReceipts)[1];
    assert.equal(normalizedReceipt.assetId, "asset-a");
    assert.equal(normalizedReceipt.generationId, "gen-a");
    assert.equal(normalizedReceipt.state, "public");
    assert.equal(normalizePublishReceipts([{ ...publishReceipts[1], externalPostId: null, externalUrl: null }])[0].state, "needs_attention");
    assert.equal(normalizeCreativeReviews(creativeReviews)[0].status, "needs_revision");
    const report = buildOperationsReport(db, {
      dataMode: "observed",
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
      asOf: "2026-08-02T00:00:00.000Z",
      publishReceipts,
      creativeReviews,
    });
    assert.equal(report.metrics.public_rate.value, 1);
    assert.equal(report.metrics.public_rate.denominator, 1);
    assert.equal(report.metrics.draft_rate.value, 0);
    assert.equal(report.metrics.receipt_latency.value, 600);
    assert.equal(report.metrics.rework_rate.value, 1);
    assert.equal(report.metrics.review_duration.value, 1800);
    assert.throws(() => buildOperationsReport(db, {
      dataMode: "observed",
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
      asOf: "2026-08-02T00:00:00.000Z",
      publishReceipts: [
        publishReceipts[0],
        { ...publishReceipts[0], status: "failed" },
      ],
    }), /revision_conflict/);
  } finally {
    db.close();
  }
});

test("tasks.json 的 task.result.results 按平台目的地展开", () => {
  const rows = normalizePublishReceipts([{
    id: "task-receipt",
    taskId: "task-a",
    assetId: "asset-a",
    mode: "publish",
    createdAt: "2026-08-01T01:00:00.000Z",
    updatedAt: "2026-08-01T01:05:00.000Z",
    result: { results: [
      { platform: "douyin", status: "submitted" },
      { platform: "xiaohongshu", status: "failed" },
    ] },
  }]);
  assert.deepEqual(rows.map((row) => [row.platform, row.state]), [["douyin", "submitted"], ["xiaohongshu", "failed"]]);
});

test("发布回执与帖子 URL 剥离签名参数并拒绝内嵌凭据", () => {
  const [signed] = normalizePublishReceipts([{
    id: "receipt-signed-url",
    platform: "douyin",
    mode: "public",
    state: "public",
    url: "https://www.douyin.com/video/123?safe=1&token=fixture-secret",
  }]);
  assert.equal(signed.state, "public");
  assert.equal(signed.resultUrl, "https://www.douyin.com/video/123?safe=1");
  assert.doesNotMatch(signed.resultUrl, /fixture-secret|token/i);

  const [credentialed] = normalizePublishReceipts([{
    id: "receipt-credentialed-url",
    platform: "douyin",
    mode: "public",
    state: "public",
    url: "https://fixture-user:fixture-password@example.invalid/video/123",
  }]);
  assert.equal(credentialed.state, "needs_attention");
  assert.equal(credentialed.resultUrl, null);
});

test("来源 platform_post 与旧 ad_hoc metric_snapshot 不冒充发布帖或周期快照", () => {
  const db = openKbDb(":memory:");
  try {
    const publishedAt = "2026-08-01T00:00:00.000Z";
    db.prepare("INSERT INTO video_asset (id,title,created_at,updated_at) VALUES ('source-asset','A',?,?)").run(publishedAt, publishedAt);
    db.prepare("INSERT INTO platform_post (asset_id,content_id,platform,publish_time,fetched_at) VALUES ('source-asset','source-post','douyin',?,?)").run(publishedAt, publishedAt);
    db.prepare("INSERT INTO metric_snapshot (asset_id,content_id,captured_at,plays,source,observation_id) VALUES ('source-asset','source-post','2026-08-01T01:00:00.000Z',100,'legacy','legacy-1')").run();
    const report = buildOperationsReport(db, {
      dataMode: "observed",
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-03T00:00:00.000Z",
      asOf: "2026-08-03T00:00:00.000Z",
    });
    assert.equal(report.lineage.platformPosts.length, 0);
    assert.equal(report.feedbackFunnel.distribution.publishedPosts, 0);
    assert.ok(Object.values(report.snapshotCoverage).every((row) => row.duePosts === 0 && row.recordedPosts === 0));
    assert.equal(report.metrics.metric_freshness.totalPosts, 0);
  } finally {
    db.close();
  }
});

test("有唯一发布血缘的旧 metric_snapshot 保留为 ad_hoc，但不计入周期覆盖", () => {
  const db = openKbDb(":memory:");
  try {
    const publishedAt = "2026-08-01T00:00:00.000Z";
    db.prepare("INSERT INTO video_asset (id,title,created_at,updated_at) VALUES ('asset-a','A',?,?)").run(publishedAt, publishedAt);
    db.prepare("INSERT INTO remake_generation (id,asset_id,engine,status,created_at,completed_at) VALUES ('gen-a','asset-a','fixture','completed',?,?)").run(publishedAt, publishedAt);
    db.prepare("INSERT INTO platform_post (asset_id,content_id,post_id,url,platform,publish_time,fetched_at) VALUES ('asset-a','post-a','external-a','https://example.invalid/a?safe=1&signature=fixture-secret','douyin',?,?)").run(publishedAt, publishedAt);
    const postId = db.prepare("SELECT id FROM platform_post").get().id;
    linkPlatformPostLineage(db, { platformPostId: postId, assetId: "asset-a", generationId: "gen-a", source: "fixture", linkedAt: publishedAt });
    db.prepare("INSERT INTO metric_snapshot (asset_id,content_id,captured_at,plays,source,observation_id) VALUES ('asset-a','post-a','2026-08-01T01:00:00.000Z',0,'legacy','legacy-1')").run();
    const report = buildOperationsReport(db, {
      dataMode: "observed",
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-03T00:00:00.000Z",
      asOf: "2026-08-03T00:00:00.000Z",
    });
    assert.equal(report.snapshots.length, 1);
    assert.equal(report.snapshots[0].snapshotKind, "ad_hoc");
    assert.equal(report.snapshots[0].values.plays.value, 0);
    assert.equal(report.snapshots[0].values.likes.status, "unavailable");
    assert.equal(report.lineage.platformPosts[0].externalUrl, "https://example.invalid/a?safe=1");
    assert.doesNotMatch(JSON.stringify(report), /fixture-secret/);
    assert.equal(report.snapshotCoverage.PT1H.recordedPosts, 0);
    assert.equal(report.snapshotCoverage.PT1H.missingPosts, 1);
  } finally {
    db.close();
  }
});

test("相邻统计窗口采用 [start,end)，边界采集不重复计数", () => {
  const db = openKbDb(":memory:");
  try {
    db.prepare("INSERT INTO import_batch (id,status,source_kind,created_at,total,succeeded,failed,skipped) VALUES ('boundary','done','fixture','2026-08-02T00:00:00.000Z',1,0,1,0)").run();
    db.prepare("INSERT INTO import_item (batch_id,input,input_kind,display_input,status,retry_count,updated_at) VALUES ('boundary','a','fixture','a','failed',0,'2026-08-02T00:00:00.000Z')").run();
    const base = { dataMode: "observed", asOf: "2026-08-03T00:00:00.000Z" };
    const first = buildOperationsReport(db, { ...base, from: "2026-08-01T00:00:00.000Z", to: "2026-08-02T00:00:00.000Z" });
    const second = buildOperationsReport(db, { ...base, from: "2026-08-02T00:00:00.000Z", to: "2026-08-03T00:00:00.000Z" });
    assert.equal(first.metrics.collection_volume.value, 0);
    assert.equal(second.metrics.collection_volume.value, 1);
  } finally {
    db.close();
  }
});

test("仓库内合成示例报告由固定夹具可重复生成", async () => {
    const generated = renderOperationsReportMarkdown(buildSyntheticOperationsReport());
    const checkedIn = await readFile(new URL("../docs/examples/operations-review.synthetic.md", import.meta.url), "utf8");
    assert.equal(generated, checkedIn);
});
