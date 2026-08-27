import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getVideoDetail, importPerformanceEvidence, openKbDb, queryVideos } from "../local-agent/kb.mjs";

test("创作者后台指标、留存和评论正文会作为独立证据入库并写入内容包", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-performance-"));
  const packagePath = join(root, "package");
  await mkdir(packagePath, { recursive: true });
  const db = openKbDb(join(root, "kb.sqlite"));
  try {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO video_asset (id,title,package_path,content_id,created_at,updated_at) VALUES (?,?,?,?,?,?)")
      .run("asset-1", "表现数据样例", packagePath, "post-1", now, now);

    const saved = await importPerformanceEvidence(db, "asset-1", {
      source: "视频号创作者后台",
      plays: "1.2万",
      likes: "600",
      comments: 80,
      favorites: 240,
      shares: 120,
      avgWatchSeconds: 8.6,
      completionRate: "37.5%",
      retention: "0=100,3=72.5,8=41",
      trafficSource: "推荐 82%",
      commentItems: [
        { id: "c1", author: "甲", content: "开头很直接", likes: 3 },
        { id: "c2", author: "乙", content: "想看详细教程" },
      ],
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.commentsImported, 2);

    const detail = getVideoDetail(db, "asset-1");
    assert.equal(detail.metric_snapshots.length, 1);
    assert.equal(detail.metric_snapshots[0].plays, 12000);
    assert.equal(detail.metric_snapshots[0].completion_rate, 37.5);
    assert.deepEqual(detail.metric_snapshots[0].retention, [
      { second: 0, percent: 100 },
      { second: 3, percent: 72.5 },
      { second: 8, percent: 41 },
    ]);
    assert.equal(detail.comment_items.length, 2);
    assert.equal(detail.virality_analysis.verdict_label, "performance_evidence_available");
    assert.ok(detail.virality_analysis.hypotheses.some((line) => line.includes("点赞率 5.00%")));
    assert.equal(queryVideos(db, { limit: 10 }).items[0].plays, 12000);

    const performance = JSON.parse(await readFile(join(packagePath, "performance.json"), "utf8"));
    const comments = JSON.parse(await readFile(join(packagePath, "comments.json"), "utf8"));
    assert.equal(performance.counts.plays.value, 12000);
    assert.equal(performance.retention.length, 3);
    assert.equal(comments.items.length, 2);

    const duplicate = await importPerformanceEvidence(db, "asset-1", {
      source: "视频号创作者后台",
      commentItems: [{ id: "c1", author: "甲", content: "开头很直接", likes: 3 }],
    });
    assert.equal(duplicate.commentsImported, 0);
    assert.equal(getVideoDetail(db, "asset-1").comment_items.length, 2);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
