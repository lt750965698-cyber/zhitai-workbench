#!/usr/bin/env node
// Synthetic in-memory data only; never opens the user's knowledge base.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { openKbDb, queryVideos } from "../local-agent/kb.mjs";

const db = openKbDb(":memory:");
const assets = 3000;
const samples = 7;
try {
  const asset = db.prepare("INSERT INTO video_asset (id,title,category,created_at) VALUES (?,?,?,?)");
  const post = db.prepare("INSERT INTO platform_post (asset_id,content_id,platform,likes,fetched_at) VALUES (?,?,?,?,?)");
  const metric = db.prepare("INSERT INTO metric_snapshot (asset_id,content_id,source,observation_id,likes,captured_at) VALUES (?,?,?,?,?,?)");
  const receipt = db.prepare("INSERT INTO download_receipt (asset_id,channel) VALUES (?,?)");
  db.exec("BEGIN");
  for (let i = 0; i < assets; i++) {
    const id = `asset-${i}`;
    asset.run(id, `Fixture ${i}`, "fixture", new Date(1_700_000_000_000 + i * 1000).toISOString());
    for (let j = 0; j < 4; j++) {
      const timestamp = new Date(1_700_000_000_000 + j * 1000).toISOString();
      post.run(id, `post-${j}`, "fixture", i + j, timestamp);
      metric.run(id, `post-${j}`, "fixture", `observation-${j}`, i + j, timestamp);
      receipt.run(id, "fixture");
    }
  }
  db.exec("COMMIT");
  const results = [];
  for (const limit of [50, 500]) {
    const expected = queryVideos(db, { limit });
    assert.equal(expected.total, assets);
    assert.equal(expected.items.length, limit);
    assert.equal(expected.items[0].id, `asset-${assets - 1}`);
    assert.equal(expected.items[0].likes, assets + 2);
    const timings = [];
    for (let i = 0; i < samples; i++) {
      const started = performance.now();
      const result = queryVideos(db, { limit });
      timings.push(performance.now() - started);
      assert.deepEqual(result, expected);
    }
    timings.sort((a, b) => a - b);
    results.push({
      limit, samples,
      medianMs: Number(timings[Math.floor(samples / 2)].toFixed(3)),
      minMs: Number(timings[0].toFixed(3)),
      maxMs: Number(timings.at(-1).toFixed(3)),
      resultSha256: createHash("sha256").update(JSON.stringify(expected)).digest("hex"),
    });
  }
  console.log(JSON.stringify({ node: process.version, assets, posts: assets * 4, metrics: assets * 4, receipts: assets * 4, results }, null, 2));
} finally {
  db.close();
}
