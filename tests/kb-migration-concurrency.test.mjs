import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { migrateLibraryToKb } from "../local-agent/kb-migrate.mjs";
import { openKbDb, retrySqliteBusy } from "../local-agent/kb.mjs";

async function fixture(root) {
  const kbRoot = join(root, "library");
  const pkg = join(kbRoot, "pkg", "assets");
  await mkdir(pkg, { recursive: true });
  await writeFile(join(pkg, "video.mp4"), Buffer.from("deterministic migration fixture"));
  await writeFile(join(kbRoot, "pkg", "metadata.json"), JSON.stringify({
    id: "legacy-race",
    title: "迁移竞态夹具",
    category: "其他",
    capturedAt: "2026-08-28T00:00:00.000Z",
    files: [{ role: "video", path: "assets/video.mp4" }],
  }));
  return kbRoot;
}

const okMedia = {
  mediaValidation: "ok",
  duration_ms: 1_000,
  width: 720,
  height: 1_280,
  codec_video: "h264",
  codec_audio: "aac",
};

test("迁移的文件与 ffprobe 预处理阶段不持有 SQLite 写锁", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-migration-race-"));
  try {
    const dataDir = join(root, "data");
    await mkdir(dataDir, { recursive: true });
    const kbRoot = await fixture(root);
    const seed = openKbDb(join(dataDir, "kb.sqlite"));
    seed.close();

    let releaseProbe;
    let markProbeStarted;
    const probeStarted = new Promise((resolve) => { markProbeStarted = resolve; });
    const migration = migrateLibraryToKb({
      kbRoot,
      dataDir,
      probeMedia: async () => {
        markProbeStarted();
        await new Promise((resolve) => { releaseProbe = resolve; });
        return okMedia;
      },
    });
    await probeStarted;

    const writer = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
    writer.exec("BEGIN IMMEDIATE");
    writer.prepare("INSERT INTO ingest_observation (kind, message, observed_at) VALUES ('race_writer', 'ok', ?)")
      .run("2026-08-28T00:00:00.000Z");
    writer.exec("COMMIT");
    writer.close();

    releaseProbe();
    const result = await migration;
    assert.equal(result.indexed, 1);
    const verify = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
    assert.equal(verify.prepare("SELECT COUNT(*) c FROM video_asset").get().c, 1);
    assert.equal(verify.prepare("SELECT COUNT(*) c FROM ingest_observation WHERE kind='race_writer'").get().c, 1);
    verify.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("并发迁移与短 busy_timeout 事件循环退避都能幂等收敛", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-migration-idempotent-"));
  try {
    const dataDir = join(root, "data");
    await mkdir(dataDir, { recursive: true });
    const kbRoot = await fixture(root);
    await Promise.all([
      migrateLibraryToKb({ kbRoot, dataDir, probeMedia: async () => okMedia }),
      migrateLibraryToKb({ kbRoot, dataDir, probeMedia: async () => okMedia }),
    ]);
    const first = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
    const second = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
    assert.equal(first.prepare("SELECT COUNT(*) c FROM video_asset").get().c, 1);
    assert.equal(first.prepare("SELECT COUNT(*) c FROM legacy_package").get().c, 1);

    first.exec("BEGIN IMMEDIATE");
    const release = setTimeout(() => first.exec("COMMIT"), 50);
    const changed = await retrySqliteBusy(() => second.prepare(
      "INSERT OR REPLACE INTO schema_version (key, version) VALUES ('busy_retry', 1)",
    ).run(), { timeoutMs: 2_000, minDelayMs: 10, maxDelayMs: 30 });
    clearTimeout(release);
    assert.equal(Number(changed.changes), 1);
    assert.equal(second.prepare("SELECT version FROM schema_version WHERE key='busy_retry'").get().version, 1);
    first.close();
    second.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
