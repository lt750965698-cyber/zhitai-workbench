/**
 * 隔离验收专用合成数据。不得写入真实知识库，也不得据此生成真实业务结论。
 */
import {
  buildOperationsReport,
  createExperimentCard,
  linkPlatformPostLineage,
  recordPlatformMetricSnapshot,
  snapshotSchedule,
} from "./operations-metrics.mjs";
import { openKbDb } from "./kb.mjs";

export const SYNTHETIC_AS_OF = "2026-08-31T18:00:00.000Z";
export const SYNTHETIC_ANCHOR = "2026-08-01T00:00:00.000Z";

const FACTOR_VALUES = {
  topic: "卧室收纳",
  hook_3s: "三秒展示改造前后",
  cover: "cover-a.png",
  title: "小卧室也能多出一面柜",
  duration: 28,
  publish_time: "20:00",
};

const FACTOR_VARIANTS = {
  topic: "儿童房收纳",
  hook_3s: "先展示最拥挤的角落",
  cover: "cover-b.png",
  title: "6㎡卧室这样收纳不压抑",
  duration: 22,
  publish_time: "12:30",
};

export function syntheticExperimentCards() {
  return Object.keys(FACTOR_VARIANTS).map((primaryFactor, index) => {
    const variant = { ...FACTOR_VALUES, [primaryFactor]: FACTOR_VARIANTS[primaryFactor] };
    return createExperimentCard({
      id: `synthetic-exp-${primaryFactor}`,
      dataMode: "synthetic",
      primaryFactor,
      hypothesis: `在其余主要条件保持不变时，测试 ${primaryFactor} 变体是否与 24h 完播率变化伴随出现。`,
      control: FACTOR_VALUES,
      variant,
      baseline: {
        referenceId: "synthetic-baseline-cohort",
        window: "previous_14d",
        sampleSize: 12,
        metric: { status: "available", value: (31 + index) / 100, raw: `${31 + index}%` },
      },
      sampleUnit: "platform_post",
      plannedSampleSize: 24,
      minimumSampleSize: 12,
      assignmentMethod: "matched",
      evidenceLevel: "associational",
      platforms: ["douyin"],
      successMetric: {
        name: "completion_rate",
        direction: "increase",
        horizon: "P1D",
        minimumDetectableEffect: 0.03,
      },
      stopConditions: {
        maxDurationDays: 14,
        noPeekingBeforeMinimum: true,
        guardrails: ["负反馈率不得恶化超过预设阈值"],
        dataQuality: ["24h 指标覆盖率至少 90%", "不得混入 permission_denied 指标"],
      },
      createdAt: "2026-08-01T00:00:00.000Z",
    });
  });
}

/** 只在本模块自己创建且为空的 :memory: 库中写固定验收夹具。 */
function seedSyntheticOperationsFixture(db) {
  const databases = db.prepare("PRAGMA database_list").all();
  if (!databases.length || databases.some((row) => String(row.file || "") !== "")) {
    throw new Error("synthetic_fixture_requires_memory_database");
  }
  for (const table of ["video_asset", "import_batch", "platform_post", "metric_snapshot"]) {
    if (Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count) !== 0) {
      throw new Error("synthetic_fixture_requires_empty_database");
    }
  }
  db.exec("SAVEPOINT synthetic_operations_fixture");
  try {
    db.exec(`CREATE TABLE ops_synthetic_fixture_marker (
      fixture_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    )`);
    db.prepare("INSERT INTO ops_synthetic_fixture_marker (fixture_id,created_at) VALUES (?,?)")
      .run("operations-acceptance-v1", SYNTHETIC_ANCHOR);
  const insertAsset = db.prepare(`INSERT INTO video_asset
    (id,title,category,content_id,captured_at,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?)`);
  insertAsset.run("synthetic-asset-a", "合成素材 A", "素材", "source-a", "2026-08-01T00:05:00.000Z", "2026-08-01T00:05:00.000Z", "2026-08-01T00:05:00.000Z");
  insertAsset.run("synthetic-asset-b", "合成素材 B", "素材", "source-b", "2026-08-01T00:06:00.000Z", "2026-08-01T00:06:00.000Z", "2026-08-01T00:06:00.000Z");

  db.prepare(`INSERT INTO import_batch
    (id,status,source_kind,created_at,total,succeeded,failed,skipped)
    VALUES ('synthetic-batch','running','synthetic_acceptance','2026-08-01T00:00:00.000Z',4,2,1,0)`).run();
  const insertItem = db.prepare(`INSERT INTO import_item
    (batch_id,input,input_kind,display_input,status,error,retry_count,asset_id,updated_at)
    VALUES ('synthetic-batch',?,?,?,?,?,?,?,?)`);
  insertItem.run("synthetic-a", "fixture", "synthetic-a", "success", null, 0, "synthetic-asset-a", "2026-08-01T00:05:00.000Z");
  insertItem.run("synthetic-b", "fixture", "synthetic-b", "linked", null, 0, "synthetic-asset-b", "2026-08-01T00:06:00.000Z");
  insertItem.run("synthetic-failed", "fixture", "synthetic-failed", "failed", "synthetic_failure", 0, null, "2026-08-01T00:07:00.000Z");
  insertItem.run("synthetic-pending", "fixture", "synthetic-pending", "pending", null, 0, null, "2026-08-01T00:08:00.000Z");

  db.prepare(`INSERT INTO content_analysis
    (asset_id,summary,confidence,source,limitation,analyzed_at)
    VALUES ('synthetic-asset-a','合成分析，仅验收','medium','synthetic_acceptance','not_real','2026-08-01T01:00:00.000Z')`).run();

  const insertGeneration = db.prepare(`INSERT INTO remake_generation
    (id,asset_id,engine,engine_task_id,status,file_name,size_bytes,sha256,subject,created_at,completed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  insertGeneration.run("synthetic-gen-a", "synthetic-asset-a", "synthetic", "synthetic-task-a", "completed", "synthetic-a.mp4", 1000, "a".repeat(64), "合成成片 A", "2026-08-01T02:00:00.000Z", "2026-08-01T03:00:00.000Z");
  insertGeneration.run("synthetic-gen-b", "synthetic-asset-b", "synthetic", "synthetic-task-b", "completed", "synthetic-b.mp4", 1000, "b".repeat(64), "合成成片 B", "2026-08-01T02:05:00.000Z", "2026-08-01T03:10:00.000Z");

  const publishedAt = "2026-08-01T12:00:00.000Z";
  const insertPost = db.prepare(`INSERT INTO platform_post
    (asset_id,content_id,post_id,url,publish_time,title,platform,fetched_at)
    VALUES (?,?,?,?,?,?,?,?)`);
  const posts = [
    { platform: "douyin", contentId: "synthetic-dy-post", postId: "dy-post", url: "https://example.invalid/dy" },
    { platform: "wechat_channels", contentId: "synthetic-sph-post", postId: "sph-post", url: "https://example.invalid/sph" },
    { platform: "xiaohongshu", contentId: "synthetic-xhs-post", postId: "xhs-post", url: "https://example.invalid/xhs" },
  ];
  for (const post of posts) {
    insertPost.run("synthetic-asset-a", post.contentId, post.postId, post.url, publishedAt, "合成平台帖", post.platform, publishedAt);
    const row = db.prepare("SELECT id FROM platform_post WHERE asset_id=? AND content_id=?").get("synthetic-asset-a", post.contentId);
    post.id = row.id;
    linkPlatformPostLineage(db, {
      platformPostId: post.id,
      assetId: "synthetic-asset-a",
      generationId: "synthetic-gen-a",
      publishReceiptId: `synthetic-receipt-${post.platform}`,
      linkedAt: publishedAt,
      source: "synthetic_acceptance",
      isSynthetic: true,
    });
  }

  const schedules = Object.fromEntries(snapshotSchedule(publishedAt).map((row) => [row.horizon, row.targetAt]));
  for (const [postIndex, post] of posts.entries()) {
    for (const [horizonIndex, horizon] of Object.keys(schedules).entries()) {
      const targetMs = Date.parse(schedules[horizon]);
      const observedAt = new Date(targetMs + 5 * 60_000).toISOString();
      const available = (value) => ({ status: "available", value, raw: String(value) });
      const unavailable = (reasonCode) => ({ status: "unavailable", value: null, reasonCode });
      const notCollected = (reasonCode) => ({ status: "not_collected", value: null, reasonCode });
      const permissionDenied = (reasonCode) => ({ status: "permission_denied", value: null, reasonCode, sourceErrorCode: "synthetic_403" });
      const plays = post.platform === "xiaohongshu" && horizon === "P1D"
        ? permissionDenied("synthetic_permission_fixture")
        : available(postIndex === 0 && horizonIndex === 0 ? 0 : (postIndex + 1) * (horizonIndex + 1) * 100);
      const likes = post.platform === "wechat_channels" && horizon === "P7D"
        ? unavailable("synthetic_source_unsupported")
        : available((postIndex + 1) * (horizonIndex + 1) * 5);
      const comments = post.platform === "douyin" && horizon === "P30D"
        ? notCollected("synthetic_collector_missed_window")
        : available(postIndex + horizonIndex);
      recordPlatformMetricSnapshot(db, {
        platformPostId: post.id,
        assetId: "synthetic-asset-a",
        generationId: "synthetic-gen-a",
        publishReceiptId: `synthetic-receipt-${post.platform}`,
        platform: post.platform,
        publishedAt,
        horizon,
        observedAt,
        sourceEventAt: schedules[horizon],
        ingestedAt: new Date(targetMs + 7 * 60_000).toISOString(),
        source: "synthetic_acceptance",
        observationId: `synthetic-${post.platform}-${horizon}`,
        isSynthetic: true,
        metrics: {
          plays,
          likes,
          comments,
          favorites: available((postIndex + 1) * (horizonIndex + 1) * 2),
          shares: available(postIndex + horizonIndex),
          avg_watch_seconds: available(6 + postIndex + horizonIndex / 2),
          completion_rate: available((30 + postIndex * 3 + horizonIndex) / 100),
        },
      });
    }
  }

    db.exec("RELEASE synthetic_operations_fixture");
    return { posts, publishedAt };
  } catch (error) {
    db.exec("ROLLBACK TO synthetic_operations_fixture");
    db.exec("RELEASE synthetic_operations_fixture");
    throw error;
  }
}

export function syntheticOperationsInputs() {
  return {
    dataMode: "synthetic",
    syntheticCore: true,
    from: SYNTHETIC_ANCHOR,
    to: SYNTHETIC_AS_OF,
    asOf: SYNTHETIC_AS_OF,
    anchorAt: SYNTHETIC_ANCHOR,
    timezone: "Asia/Shanghai",
    creativeJobs: [
      { id: "synthetic-job-completed", assetId: "synthetic-asset-a", status: "completed", createdAt: "2026-08-01T02:00:00.000Z", updatedAt: "2026-08-01T03:00:00.000Z", isSynthetic: true },
      { id: "synthetic-job-failed", assetId: "synthetic-asset-b", status: "failed", createdAt: "2026-08-01T02:10:00.000Z", updatedAt: "2026-08-01T03:05:00.000Z", isSynthetic: true },
      { id: "synthetic-job-running", assetId: "synthetic-asset-b", status: "preparing", createdAt: "2026-08-01T02:20:00.000Z", updatedAt: "2026-08-01T03:10:00.000Z", isSynthetic: true },
    ],
    creativeReviews: [
      { id: "synthetic-review-a", assetId: "synthetic-asset-a", generationId: "synthetic-gen-a", status: "needs_revision", feedback: [{ text: "合成返工意见" }], createdAt: "2026-08-01T04:00:00.000Z", updatedAt: "2026-08-01T05:00:00.000Z", isSynthetic: true },
      { id: "synthetic-review-b", assetId: "synthetic-asset-b", generationId: "synthetic-gen-b", status: "approved_for_drafts", feedback: [], createdAt: "2026-08-01T04:10:00.000Z", updatedAt: "2026-08-01T06:10:00.000Z", isSynthetic: true },
    ],
    publishReceipts: [
      { id: "synthetic-receipt-dy", jobId: "synthetic-pub", assetId: "synthetic-asset-a", platform: "douyin", mode: "draft", state: "draft", createdAt: "2026-08-02T01:00:00.000Z", updatedAt: "2026-08-02T01:05:00.000Z", isSynthetic: true },
      { id: "synthetic-receipt-sph", jobId: "synthetic-pub", assetId: "synthetic-asset-a", platform: "wechat_channels", mode: "public", state: "submitted", createdAt: "2026-08-02T01:00:00.000Z", updatedAt: "2026-08-02T01:08:00.000Z", isSynthetic: true },
      { id: "synthetic-receipt-xhs", jobId: "synthetic-pub", assetId: "synthetic-asset-a", platform: "xiaohongshu", mode: "public", state: "public", postId: "xhs-post", createdAt: "2026-08-02T01:00:00.000Z", updatedAt: "2026-08-02T01:12:00.000Z", isSynthetic: true },
    ],
    dailyCreativeState: {
      date: "2026-08-01",
      qualifiedToday: 1,
      completedToday: 1,
      lastAttemptAt: "2026-08-01T06:10:00.000Z",
      lastError: null,
      isSynthetic: true,
    },
    experiments: syntheticExperimentCards(),
  };
}

export function buildSyntheticOperationsReport(externalDb) {
  if (externalDb !== undefined) throw new Error("synthetic_report_does_not_accept_external_database");
  const db = openKbDb(":memory:");
  try {
    seedSyntheticOperationsFixture(db);
    return buildOperationsReport(db, syntheticOperationsInputs());
  } finally {
    db.close();
  }
}
