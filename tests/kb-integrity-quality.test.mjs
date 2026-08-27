import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assessMediaQuality, getVideoDetail, openKbDb, queryVideos } from "../local-agent/kb.mjs";

test("开库修复已完成但关联资产不存在的历史导入项", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-kb-integrity-"));
  const path = join(root, "kb.sqlite");
  try {
    let db = openKbDb(path);
    db.prepare("INSERT INTO import_batch (id,status,source_kind,created_at,total,succeeded,failed,skipped) VALUES ('b1','done','legacy',?,2,2,0,0)").run(new Date().toISOString());
    db.prepare("INSERT INTO import_item (batch_id,input,status,asset_id,updated_at) VALUES ('b1','missing-one','success',NULL,?)").run(new Date().toISOString());
    db.prepare("INSERT INTO import_item (batch_id,input,status,asset_id,updated_at) VALUES ('b1','pending-one','pending',NULL,?)").run(new Date().toISOString());
    db.close();

    db = openKbDb(path);
    const item = db.prepare("SELECT status,asset_id,error FROM import_item WHERE input='missing-one'").get();
    assert.equal(item.status, "orphaned");
    assert.equal(item.asset_id, null);
    assert.equal(item.error, "orphaned: 关联资产不存在");
    const batch = db.prepare("SELECT status,total,succeeded,failed,skipped FROM import_batch WHERE id='b1'").get();
    assert.deepEqual({ ...batch }, { status: "awaiting_primary_download", total: 2, succeeded: 0, failed: 1, skipped: 0 });
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("画质分级只标注原文件，列表与详情使用同一结果", async () => {
  assert.deepEqual(assessMediaQuality({ media_validation: "encrypted" }), {
    state: "blocked", label: "媒体异常", reason: "媒体校验未通过：encrypted", sourcePreserved: true,
  });
  assert.equal(assessMediaQuality({ media_validation: "ok", width: 576, height: 624, bitrate_kbps: 420 }).state, "review");
  assert.equal(assessMediaQuality({ media_validation: "ok", size_bytes: 12_000, duration_ms: 1_000 }).state, "review");
  assert.equal(assessMediaQuality({ media_validation: "ok", width: 1080, height: 1920, bitrate_kbps: 2800 }).state, "high");

  const root = await mkdtemp(join(tmpdir(), "zhitai-kb-quality-"));
  const path = join(root, "kb.sqlite");
  try {
    const db = openKbDb(path);
    db.prepare(`INSERT INTO video_asset
      (id,title,width,height,bitrate_kbps,media_validation,created_at)
      VALUES ('v1','低码率原片',576,1024,420,'ok',?)`).run(new Date().toISOString());
    const list = queryVideos(db);
    assert.equal(list.items[0].quality.state, "review");
    assert.equal(list.items[0].quality.sourcePreserved, true);
    const detail = getVideoDetail(db, "v1");
    assert.equal(detail.asset.quality.state, "review");
    assert.match(detail.asset.quality.reason, /未转码/);
    db.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
