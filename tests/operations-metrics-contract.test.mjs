import test from "node:test";
import assert from "node:assert/strict";
import { openKbDb } from "../local-agent/kb.mjs";
import {
  buildOperationsReport,
  ensureOperationsSchema,
  linkPlatformPostLineage,
  normalizePlatformMetric,
  recordPlatformMetricSnapshot,
  selectSnapshotForHorizon,
  snapshotSchedule,
  VALUE_STATUSES,
} from "../local-agent/operations-metrics.mjs";

test("平台指标明确区分 0、unavailable、not_collected 和 permission_denied", () => {
  assert.deepEqual(VALUE_STATUSES, ["available", "unavailable", "not_collected", "permission_denied"]);
  assert.deepEqual(normalizePlatformMetric({ status: "available", value: 0, raw: "0" }, { metricName: "plays" }), {
    status: "available",
    value: 0,
    raw: "0",
    reasonCode: null,
    sourceErrorCode: null,
  });
  for (const status of ["unavailable", "not_collected", "permission_denied"]) {
    const value = normalizePlatformMetric({ status, value: null, reasonCode: `fixture_${status}` }, { metricName: "likes" });
    assert.equal(value.status, status);
    assert.equal(value.value, null);
  }
  assert.throws(() => normalizePlatformMetric({ status: "available", value: null }, { metricName: "plays" }), /available_platform_metric_value_invalid/);
  assert.throws(() => normalizePlatformMetric({ status: "permission_denied", value: 0, reasonCode: "forbidden" }, { metricName: "plays" }), /must_not_have_value/);
  assert.throws(() => normalizePlatformMetric({ status: "not_collected", value: null }, { metricName: "plays" }), /reason_required/);
  assert.throws(() => normalizePlatformMetric({ status: "available", value: -1 }, { metricName: "plays" }), /value_invalid/);
  assert.throws(() => normalizePlatformMetric({ status: "available", value: 1.2 }, { metricName: "likes" }), /must_be_integer/);
  assert.throws(() => normalizePlatformMetric({ status: "available", value: 1.01 }, { metricName: "completion_rate" }), /out_of_range/);
});

test("素材→生成成片→多个平台帖子血缘强制同一资产且迁移幂等", () => {
  const db = openKbDb(":memory:");
  try {
    ensureOperationsSchema(db);
    ensureOperationsSchema(db);
    const now = "2026-08-01T00:00:00.000Z";
    for (const id of ["asset-a", "asset-b"]) {
      db.prepare("INSERT INTO video_asset (id,title,created_at,updated_at) VALUES (?,?,?,?)").run(id, id, now, now);
    }
    db.prepare(`INSERT INTO remake_generation
      (id,asset_id,engine,status,created_at,completed_at) VALUES ('generation-a','asset-a','fixture','completed',?,?)`).run(now, now);
    const insertPost = db.prepare(`INSERT INTO platform_post
      (asset_id,content_id,post_id,platform,publish_time,fetched_at) VALUES (?,?,?,?,?,?)`);
    insertPost.run("asset-a", "post-a-dy", "dy-1", "douyin", now, now);
    insertPost.run("asset-a", "post-a-xhs", "xhs-1", "xiaohongshu", now, now);
    const posts = db.prepare("SELECT id FROM platform_post ORDER BY id").all();

    for (const post of posts) {
      const linked = linkPlatformPostLineage(db, {
        platformPostId: post.id,
        assetId: "asset-a",
        generationId: "generation-a",
        source: "fixture",
        linkedAt: now,
      });
      assert.equal(linked.inserted, true);
    }
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ops_post_lineage").get().count, 2);
    assert.equal(linkPlatformPostLineage(db, {
      platformPostId: posts[0].id,
      assetId: "asset-a",
      generationId: "generation-a",
      source: "fixture",
      linkedAt: now,
    }).inserted, false);
    assert.throws(() => linkPlatformPostLineage(db, {
      platformPostId: posts[0].id,
      assetId: "asset-b",
      generationId: "generation-a",
      source: "fixture",
      linkedAt: now,
    }), /platform_post_asset_mismatch/);
    assert.throws(() => db.prepare("DELETE FROM remake_generation WHERE id='generation-a'").run(), /FOREIGN KEY constraint failed/);
  } finally {
    db.close();
  }
});

test("一次快照同步复用 metric_snapshot 并为每个指标保存四态，重复观测幂等", () => {
  const db = openKbDb(":memory:");
  try {
    const publishedAt = "2026-08-01T00:00:00.000Z";
    db.prepare("INSERT INTO video_asset (id,title,created_at,updated_at) VALUES ('asset-a','A',?,?)").run(publishedAt, publishedAt);
    db.prepare(`INSERT INTO remake_generation
      (id,asset_id,engine,status,created_at,completed_at) VALUES ('gen-a','asset-a','fixture','completed',?,?)`).run(publishedAt, publishedAt);
    db.prepare(`INSERT INTO platform_post
      (asset_id,content_id,post_id,platform,publish_time,fetched_at) VALUES ('asset-a','content-a','post-a','douyin',?,?)`).run(publishedAt, publishedAt);
    const postId = db.prepare("SELECT id FROM platform_post").get().id;
    const input = {
      platformPostId: postId,
      assetId: "asset-a",
      generationId: "gen-a",
      platform: "douyin",
      publishedAt,
      horizon: "1h",
      observedAt: "2026-08-01T01:05:00.000Z",
      sourceEventAt: "2026-08-01T01:00:00.000Z",
      ingestedAt: "2026-08-01T01:06:00.000Z",
      source: "fixture",
      observationId: "observation-a",
      metrics: {
        plays: { status: "available", value: 0, raw: "0" },
        likes: { status: "unavailable", value: null, reasonCode: "source_unsupported" },
        comments: { status: "not_collected", value: null, reasonCode: "collector_not_run" },
        favorites: { status: "permission_denied", value: null, reasonCode: "scope_missing" },
        shares: { status: "available", value: 1, raw: "1" },
        avg_watch_seconds: { status: "unavailable", value: null, reasonCode: "source_unsupported" },
        completion_rate: { status: "not_collected", value: null, reasonCode: "collector_not_run" },
      },
    };
    assert.throws(() => recordPlatformMetricSnapshot(db, {
      ...input,
      observationId: "incomplete-observation",
      metrics: { plays: input.metrics.plays },
    }), /metrics_must_cover_contract/);
    const first = recordPlatformMetricSnapshot(db, input);
    const duplicate = recordPlatformMetricSnapshot(db, input);
    assert.equal(first.observationsInserted, 7);
    assert.equal(first.horizon, "PT1H");
    assert.equal(duplicate.observationsInserted, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM metric_snapshot").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM ops_platform_metric_observation").get().count, 7);
    assert.equal(db.prepare("SELECT DISTINCT snapshot_horizon AS horizon FROM ops_platform_metric_observation").get().horizon, "PT1H");
    const wide = db.prepare("SELECT plays,likes,comments,favorites FROM metric_snapshot").get();
    assert.equal(wide.plays, 0);
    assert.equal(wide.likes, null);
    assert.equal(wide.comments, null);
    assert.equal(wide.favorites, null);
    assert.deepEqual(
      db.prepare("SELECT metric_name,value_status,value FROM ops_platform_metric_observation ORDER BY metric_name").all().map((row) => ({ ...row })),
      [
        { metric_name: "avg_watch_seconds", value_status: "unavailable", value: null },
        { metric_name: "comments", value_status: "not_collected", value: null },
        { metric_name: "completion_rate", value_status: "not_collected", value: null },
        { metric_name: "favorites", value_status: "permission_denied", value: null },
        { metric_name: "likes", value_status: "unavailable", value: null },
        { metric_name: "plays", value_status: "available", value: 0 },
        { metric_name: "shares", value_status: "available", value: 1 },
      ],
    );
    const revised = recordPlatformMetricSnapshot(db, {
      ...input,
      revision: 2,
      sourceEventAt: "2026-08-01T00:55:00.000Z",
      ingestedAt: "2026-08-01T01:07:00.000Z",
      metrics: { ...input.metrics, likes: { status: "available", value: 3, raw: "3" } },
    });
    assert.equal(revised.observationsInserted, 7);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM metric_snapshot").get().count, 2);
    const revisionReport = buildOperationsReport(db, {
      dataMode: "observed",
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
      asOf: "2026-08-02T00:00:00.000Z",
    });
    assert.equal(revisionReport.snapshots[0].revision, 2);
    assert.equal(revisionReport.snapshots[0].values.likes.value, 3);
    const inherited = recordPlatformMetricSnapshot(db, {
      ...input,
      generationId: undefined,
      observationId: "observation-inherits-lineage",
      ingestedAt: "2026-08-01T01:08:00.000Z",
    });
    assert.equal(inherited.observationsInserted, 7);
    assert.equal(db.prepare("SELECT COUNT(DISTINCT generation_id) AS count FROM ops_platform_metric_observation WHERE observation_id='observation-inherits-lineage'").get().count, 1);
    assert.throws(() => recordPlatformMetricSnapshot(db, {
      ...input,
      observationId: "wrong-slot",
      horizon: "30d",
    }), /outside_horizon_tolerance/);
    assert.throws(() => recordPlatformMetricSnapshot(db, {
      ...input,
      observationId: "wrong-platform",
      platform: "xiaohongshu",
    }), /platform_mismatch/);
    assert.throws(() => recordPlatformMetricSnapshot(db, {
      ...input,
      metrics: { ...input.metrics, plays: { status: "available", value: 999 } },
    }), /idempotency_conflict/);
  } finally {
    db.close();
  }
});

test("快照目标时点固定为 1h/24h/7d/30d，选择器不读取 as_of 之后的数据", () => {
  const publishedAt = "2026-08-01T00:00:00.000Z";
  assert.deepEqual(snapshotSchedule(publishedAt).map((row) => row.targetAt), [
    "2026-08-01T01:00:00.000Z",
    "2026-08-02T00:00:00.000Z",
    "2026-08-08T00:00:00.000Z",
    "2026-08-31T00:00:00.000Z",
  ]);
  assert.deepEqual(snapshotSchedule(publishedAt).map((row) => row.horizon), ["PT1H", "P1D", "P7D", "P30D"]);
  const snapshots = [
    { id: 1, captured_at: "2026-08-01T00:35:00.000Z" },
    { id: 2, captured_at: "2026-08-01T01:10:00.000Z" },
    { id: 3, captured_at: "2026-08-01T01:01:00.000Z" },
  ];
  assert.equal(selectSnapshotForHorizon(snapshots, {
    publishedAt,
    horizon: "1h",
    asOf: "2026-08-01T00:59:59.999Z",
  }).status, "not_due");
  const selected = selectSnapshotForHorizon(snapshots, {
    publishedAt,
    horizon: "1h",
    asOf: "2026-08-01T01:05:00.000Z",
  });
  assert.equal(selected.status, "ad_hoc_candidate");
  assert.equal(selected.eligibleForScheduledSlot, false);
  assert.equal(selected.snapshot.id, 3);
  assert.equal(selectSnapshotForHorizon([], {
    publishedAt,
    horizon: "24h",
    asOf: "2026-08-03T00:00:00.000Z",
  }).status, "missing_data");
});
