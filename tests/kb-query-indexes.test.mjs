import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openKbDb, queryVideos } from "../local-agent/kb.mjs";

const queryIndexes = {
  ix_video_asset_created: ["video_asset", ["created_at"]],
  ix_download_receipt_asset_id: ["download_receipt", ["asset_id", "id"]],
  ix_metric_snapshot_asset_captured_id: ["metric_snapshot", ["asset_id", "captured_at", "id"]],
};

for (const legacyMetrics of [false, true]) {
  test(`列表索引在${legacyMetrics ? "旧指标表重建" : "既有库升级"}后可重开且保留数据`, async () => {
    const root = await mkdtemp(join(tmpdir(), "zhitai-query-indexes-"));
    const dbPath = join(root, "kb.sqlite");
    let db;
    try {
      db = openKbDb(dbPath);
      db.prepare("INSERT INTO video_asset (id,title,created_at) VALUES (?,?,?)")
        .run("fixture", "Fixture", "2026-09-01T00:00:00Z");
      db.prepare("INSERT INTO download_receipt (asset_id,channel) VALUES (?,?)")
        .run("fixture", "fixture");
      // Recreate the exact pre-index state without touching a user database.
      for (const index of Object.keys(queryIndexes)) db.exec(`DROP INDEX IF EXISTS ${index}`);
      if (legacyMetrics) {
        db.exec("DROP TABLE metric_snapshot");
        db.exec(`CREATE TABLE metric_snapshot (
          id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id TEXT NOT NULL,
          captured_at TEXT, plays INTEGER, likes INTEGER, comments INTEGER,
          favorites INTEGER, shares INTEGER, source TEXT
        )`);
      }
      db.prepare("INSERT INTO metric_snapshot (asset_id,captured_at,likes,source) VALUES (?,?,?,?)")
        .run("fixture", "2026-09-02T00:00:00Z", 200, "fixture");
      const assetBefore = { ...db.prepare("SELECT * FROM video_asset").get() };
      const receiptBefore = { ...db.prepare("SELECT * FROM download_receipt").get() };
      db.close();
      db = null;

      for (let reopen = 0; reopen < 2; reopen++) {
        db = openKbDb(dbPath);
        for (const [index, [table, columns]] of Object.entries(queryIndexes)) {
          const matches = db.prepare(`PRAGMA index_list(${table})`).all().filter((row) => row.name === index);
          assert.equal(matches.length, 1, `${index} must exist exactly once after reopen`);
          assert.equal(matches[0].unique, 0, "query indexes must not reject existing duplicate values");
          assert.deepEqual(db.prepare(`PRAGMA index_info(${index})`).all().map((row) => row.name), columns);
        }
        assert.deepEqual({ ...db.prepare("SELECT * FROM video_asset").get() }, assetBefore);
        assert.deepEqual({ ...db.prepare("SELECT * FROM download_receipt").get() }, receiptBefore);
        assert.equal(db.prepare("SELECT COUNT(*) count FROM metric_snapshot").get().count, 1);
        assert.equal(queryVideos(db, { sort: "likes" }).items[0].likes, 200);
        db.close();
        db = null;
      }
    } finally {
      db?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}
