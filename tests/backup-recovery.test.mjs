import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  BackupError,
  createBackup,
  migrateBackup,
  previewMigration,
  restoreBackup,
  rollbackMigration,
  verifyBackup,
} from "../local-agent/backup.mjs";

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "zhitai-backup-fixture-"));
  const dataDir = join(root, "state");
  const knowledgeRoot = join(root, "knowledge");
  const packageDir = join(knowledgeRoot, "素材", "2026", "08", "27", "kb_asset-1");
  const mediaPath = join(packageDir, "assets", "clip.mp4");
  await mkdir(join(packageDir, "assets"), { recursive: true });
  await writeFile(mediaPath, Buffer.concat([
    Buffer.from([0x00, 0x00, 0x00, 0x18]),
    Buffer.from("ftypisom", "ascii"),
    Buffer.from([0x00, 0x00, 0x00, 0x00]),
    Buffer.from("isommp42", "ascii"),
  ]));
  await writeJson(join(packageDir, "metadata.json"), {
    schemaVersion: 2,
    id: "asset-1",
    packagePath: "/old-machine/knowledge/素材/2026/08/27/kb_asset-1",
    files: [{ relativePath: "assets/clip.mp4" }],
  });
  await writeJson(join(packageDir, "raw-yuanbao.sanitized.json"), { title: "safe" });
  await writeJson(join(packageDir, "raw-yuanbao.json"), { secret: "should-not-copy" });
  await writeJson(join(packageDir, "token.json"), { token: "should-not-copy" });
  await writeFile(join(packageDir, ".env.local"), "ACCESS_TOKEN=should-not-copy\n");
  await writeFile(join(packageDir, "Cookies"), Buffer.from("should-not-copy"));
  await mkdir(join(knowledgeRoot, "private"), { recursive: true });
  await writeJson(join(knowledgeRoot, "private", "raw-yuanbao.sanitized.json"), { title: "should-not-copy" });
  await mkdir(join(packageDir, ".cache"), { recursive: true });
  await writeFile(join(packageDir, ".cache", "download.bin"), "should-not-copy");
  await mkdir(join(packageDir, "engines"), { recursive: true });
  await writeFile(join(packageDir, "engines", "third-party.bin"), "should-not-copy");
  await mkdir(join(packageDir, "venv", "lib", "site-packages"), { recursive: true });
  await writeFile(join(packageDir, "venv", "lib", "site-packages", "third-party.dat"), "should-not-copy");
  await writeFile(join(packageDir, "login-qr.png"), "should-not-copy");
  await mkdir(join(packageDir, "Keychains"), { recursive: true });
  await writeFile(join(packageDir, "Keychains", "login.keychain-db"), "should-not-copy");
  await writeFile(join(packageDir, "login.keychain-db"), "should-not-copy");
  await writeFile(join(packageDir, "Passwords.csv"), "site,password\nexample,should-not-copy\n");
  await writeFile(join(packageDir, "recovery codes.txt"), "should-not-copy\n");
  await writeFile(join(packageDir, "jwt.txt"), "should-not-copy\n");
  for (const qrDir of ["qr", "qrcode", "login-qr"]) {
    await mkdir(join(packageDir, qrDir), { recursive: true });
    await writeFile(join(packageDir, qrDir, "frame.png"), "should-not-copy");
  }
  for (const spacedDir of ["QR Codes", "User Data", "Browser Profile", "Third Party"]) {
    await mkdir(join(packageDir, spacedDir), { recursive: true });
    await writeFile(join(packageDir, spacedDir, "opaque.dat"), "should-not-copy");
  }
  await writeFile(join(root, "outside.txt"), "should-not-copy");
  await symlink(join(root, "outside.txt"), join(packageDir, "escape-link"));

  await mkdir(join(dataDir, "publish-jobs"), { recursive: true });
  await mkdir(join(dataDir, "platform-receipts"), { recursive: true });
  const oldMediaPath = "/old-machine/knowledge/素材/2026/08/27/kb_asset-1/assets/clip.mp4";
  const oldPackagePath = "/old-machine/knowledge/素材/2026/08/27/kb_asset-1";
  const publishTasks = [
    { id: "pub-1", status: "scheduled", scheduledAt: "2030-08-27T12:00:00.000Z" },
    { id: "pub-2", status: "queued" },
    { id: "pub-3", status: "running" },
    { id: "pub-4", status: "draft" },
    { id: "pub-5", status: "submitted" },
  ].map((task) => ({ ...task, type: "publish", approved: true, assetPath: oldMediaPath }));
  await writeJson(join(dataDir, "tasks.json"), publishTasks);
  await writeJson(join(dataDir, "events.json"), [{ id: "event-1", kind: "PUBLISH", status: "accepted" }]);
  await writeJson(join(dataDir, "analysis-jobs.json"), [{ id: "analysis-1", assetId: "asset-1", status: "retry_wait", nextAttemptAt: "2030-08-27T10:00:00.000Z" }]);
  await writeJson(join(dataDir, "creative-jobs.json"), [{ id: "creative-1", assetId: "asset-1", status: "queued" }]);
  await writeJson(join(dataDir, "creative-reviews.json"), [{ id: "review-1", assetId: "asset-1", filePath: oldMediaPath, status: "approved_for_publish" }]);
  await writeJson(join(dataDir, "kuaidian-commands.json"), [{ id: "command-1", itemId: 1, status: "queued" }]);
  await writeJson(join(dataDir, "publisher-schedule.json"), {
    version: 1,
    revision: 3,
    tasks: [
      {
        id: "schedule-1",
        status: "scheduled",
        scheduledAt: "2030-08-27T12:00:00.000Z",
        payload: { request: { assetPath: oldMediaPath } },
        targets: [{ id: "dy:account_fixture", status: "pending", definition: { platform: "dy" } }],
      },
      {
        id: "schedule-2",
        status: "submitting",
        scheduledAt: "2030-08-27T12:05:00.000Z",
        payload: { request: { assetPath: oldMediaPath } },
        targets: [{ id: "xhs:account_fixture", status: "submitting", definition: { platform: "xhs" } }],
      },
      {
        id: "schedule-3",
        status: "public",
        scheduledAt: "2026-08-27T12:00:00.000Z",
        payload: { request: { assetPath: oldMediaPath } },
        targets: [{ id: "sph:account_fixture", status: "public", definition: { platform: "sph" } }],
      },
    ],
  });
  await writeJson(join(dataDir, "watcher-state.json"), { processed: [], files: { "/old-machine/download.mp4": { status: "pending" } } });
  for (const task of publishTasks) await writeJson(join(dataDir, "publish-jobs", `${task.id}.json`), task);
  await writeJson(join(dataDir, "platform-receipts", "receipt-1.json"), {
    receiptVersion: 1,
    taskId: "pub-1",
    platform: "dy",
    status: "accepted",
  });
  await mkdir(join(dataDir, "matrix-login"), { recursive: true });
  await writeFile(join(dataDir, "matrix-login", "real-login.png"), "should-not-copy");
  await mkdir(join(dataDir, "private", "raw"), { recursive: true });
  await writeJson(join(dataDir, "private", "raw", "response.json"), { secret: "should-not-copy" });
  await writeFile(join(dataDir, "inbox-secret"), "should-not-copy");

  const dbPath = join(dataDir, "kb.sqlite");
  const writer = new DatabaseSync(dbPath);
  writer.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA wal_autocheckpoint=0;
    PRAGMA foreign_keys=ON;
    CREATE TABLE video_asset (
      id TEXT PRIMARY KEY,
      file_path TEXT,
      package_path TEXT
    );
    CREATE TABLE platform_post (
      id INTEGER PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES video_asset(id),
      raw_json_path TEXT
    );
    CREATE TABLE legacy_package (
      id INTEGER PRIMARY KEY,
      asset_id TEXT NOT NULL REFERENCES video_asset(id),
      package_path TEXT
    );
    CREATE TABLE download_receipt (id INTEGER PRIMARY KEY, asset_id TEXT);
    CREATE TABLE ingest_observation (id INTEGER PRIMARY KEY, asset_id TEXT);
    CREATE TABLE import_batch (id TEXT PRIMARY KEY, status TEXT);
    CREATE TABLE import_item (id INTEGER PRIMARY KEY, batch_id TEXT, input TEXT, status TEXT, error TEXT);
    CREATE TABLE correction (id INTEGER PRIMARY KEY, asset_id TEXT);
    CREATE TABLE remake_generation (id TEXT PRIMARY KEY, asset_id TEXT);
    CREATE TABLE schema_version (key TEXT PRIMARY KEY, version INTEGER);
  `);
  writer.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  writer.exec("BEGIN IMMEDIATE");
  try {
    writer.prepare("INSERT INTO video_asset VALUES (?, ?, ?)").run("asset-1", oldMediaPath, oldPackagePath);
    writer.prepare("INSERT INTO platform_post VALUES (1, ?, ?)").run("asset-1", `${oldPackagePath}/raw-yuanbao.sanitized.json`);
    writer.prepare("INSERT INTO legacy_package VALUES (1, ?, ?)").run("asset-1", oldPackagePath);
    writer.prepare("INSERT INTO download_receipt VALUES (1, ?)").run("asset-1");
    writer.prepare("INSERT INTO ingest_observation VALUES (1, ?)").run("asset-1");
    writer.prepare("INSERT INTO import_batch VALUES (?, ?)").run("batch-1", "running");
    writer.prepare("INSERT INTO import_item VALUES (1, ?, ?, ?, NULL)").run("batch-1", oldMediaPath, "pending");
    writer.prepare("INSERT INTO correction VALUES (1, ?)").run("asset-1");
    writer.prepare("INSERT INTO remake_generation VALUES (?, ?)").run("generation-1", "asset-1");
    writer.prepare("INSERT INTO schema_version VALUES (?, ?)").run("kb_migrate", 2);
    writer.exec("COMMIT");
  } catch (error) {
    writer.exec("ROLLBACK");
    throw error;
  }
  assert.equal((await lstat(`${dbPath}-wal`)).isFile(), true, "fixture keeps committed rows in an active WAL");
  return { root, dataDir, knowledgeRoot, packageDir, mediaPath, oldMediaPath, writer };
}

test("SQLite source symlinks are rejected before any backup payload is created", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-backup-db-symlink-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const knowledgeRoot = join(root, "knowledge");
  await mkdir(dataDir);
  await mkdir(knowledgeRoot);
  const outsideDb = join(root, "outside.sqlite");
  const db = new DatabaseSync(outsideDb);
  db.exec("CREATE TABLE video_asset (id TEXT PRIMARY KEY)");
  db.close();
  await symlink(outsideDb, join(dataDir, "kb.sqlite"));
  const backupPath = join(root, "backup");
  await assert.rejects(
    createBackup({ dataDir, knowledgeRoot, outputPath: backupPath }),
    (error) => error instanceof BackupError && error.code === "sqlite_database_not_regular",
  );
  assert.equal(await lstat(backupPath).then(() => true, () => false), false);

  const dataDir2 = join(root, "data-sidecar");
  const knowledgeRoot2 = join(root, "knowledge-sidecar");
  await mkdir(dataDir2);
  await mkdir(knowledgeRoot2);
  const db2 = new DatabaseSync(join(dataDir2, "kb.sqlite"));
  db2.exec("CREATE TABLE video_asset (id TEXT PRIMARY KEY)");
  db2.close();
  const outsideWal = join(root, "outside-wal");
  await writeFile(outsideWal, "not a real wal");
  await symlink(outsideWal, join(dataDir2, "kb.sqlite-wal"));
  await assert.rejects(
    createBackup({ dataDir: dataDir2, knowledgeRoot: knowledgeRoot2, outputPath: join(root, "backup-sidecar") }),
    (error) => error instanceof BackupError && error.code === "sqlite_sidecar_not_regular",
  );
});

test("BagIt v1 backup absorbs active WAL, excludes secrets, and performs an isolated restore drill", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.writer.close());
  const backupPath = join(fixture.root, "backups", "drill-bag");
  const result = await createBackup({
    dataDir: fixture.dataDir,
    knowledgeRoot: fixture.knowledgeRoot,
    outputPath: backupPath,
    backupId: "backup_drill_001",
    createdAt: "2026-08-27T08:00:00.000Z",
  });
  assert.equal(result.sqlite.sourceJournalMode, "wal");
  assert.equal(result.sqlite.walPresentAtSnapshot, true);
  assert.equal(result.sqlite.rawWalCopied, false);
  assert.equal(result.metrics.videoAssetCount, 1);
  assert.equal(result.metrics.taskComponents.importItems, 1);
  assert.equal(result.metrics.taskCount, 12);
  assert.equal(result.metrics.publishJobCount, 5);
  assert.equal(result.metrics.platformReceiptCount, 2);

  const manifest = JSON.parse(await readFile(join(backupPath, "manifest.json"), "utf8"));
  assert.equal(manifest.format, "zhitai-bag");
  assert.equal(manifest.formatVersion, 1);
  assert.ok(manifest.files.every((entry) => !isAbsolute(entry.path) && !entry.path.includes("..")));
  assert.ok(manifest.files.some((entry) => entry.path.endsWith("raw-yuanbao.sanitized.json")));
  assert.ok(!manifest.files.some((entry) => /private|raw-yuanbao\.json|token\.json|passwords|recovery codes|jwt\.txt|\.env|cookies|keychain|(?:^|\/)(?:qr|qrcode|login-qr|qr codes|user data|browser profile|third party|venv|site-packages)(?:\/|$)|engines|\.cache|escape-link/i.test(entry.path)));
  assert.ok(!manifest.files.some((entry) => /kb\.sqlite-(?:wal|shm)$/.test(entry.path)));
  assert.ok(manifest.scope.exclusions.countsByRule.private_raw >= 1);
  assert.ok(manifest.scope.exclusions.countsByRule.login_qr >= 1);
  assert.ok(manifest.scope.exclusions.countsByRule.symlink >= 1);
  for (const entry of manifest.files) {
    const content = await readFile(join(backupPath, ...entry.path.split("/")));
    assert.equal(content.includes(Buffer.from("should-not-copy")), false, "excluded sentinel never enters payload");
  }

  const verified = await verifyBackup({ backupPath });
  assert.equal(verified.integrityCheck, "ok");
  assert.equal(verified.foreignKeyViolations, 0);
  assert.equal(verified.metrics.videoAssetCount, 1);

  const currentRoot = join(fixture.root, "current-user-data");
  const currentSentinel = join(currentRoot, "sentinel.txt");
  await mkdir(currentRoot);
  await writeFile(currentSentinel, "current-data-must-not-change");
  const restoreParent = join(fixture.root, "isolated-restores");
  const restored = await restoreBackup({ backupPath, tempParent: restoreParent });
  assert.equal(relative(await realpath(restoreParent), restored.restoreRoot).startsWith(".."), false);
  assert.equal(await readFile(currentSentinel, "utf8"), "current-data-must-not-change");
  assert.equal(restored.report.mode, "temporary_isolated_directory");
  assert.equal(restored.report.currentDataModified, false);
  assert.equal(restored.report.checks.integrityCheck, "ok");
  assert.equal(restored.report.checks.assetCountMatches, true);
  assert.equal(restored.report.checks.taskCountMatches, true);
  const restoredDb = new DatabaseSync(join(restored.restoreRoot, "data", "kb.sqlite"), { readOnly: true });
  assert.equal(restoredDb.prepare("SELECT COUNT(*) AS count FROM video_asset").get().count, 1);
  assert.equal(restoredDb.prepare("SELECT COUNT(*) AS count FROM import_item").get().count, 1);
  restoredDb.close();
  assert.equal(
    await sha256(join(restored.restoreRoot, "knowledge", "素材", "2026", "08", "27", "kb_asset-1", "assets", "clip.mp4")),
    await sha256(fixture.mediaPath),
  );
});

test("migration preview is read-only, migration writes only a new root, and rollback quarantines it", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.writer.close());
  const backupPath = join(fixture.root, "backups", "migration-bag");
  await createBackup({ dataDir: fixture.dataDir, knowledgeRoot: fixture.knowledgeRoot, outputPath: backupPath });
  const targetRoot = join(fixture.root, "new-machine", "zhitai-migrated");
  const preview = await previewMigration({ backupPath, targetRoot });
  assert.equal(preview.canMigrate, true);
  assert.equal(await lstat(dirname(targetRoot)).then(() => true, () => false), false, "preview does not create target parent");
  assert.ok(preview.pathRebindPreview.absoluteReferenceCounts["video_asset.file_path"] >= 1);

  const migrated = await migrateBackup({ backupPath, targetRoot });
  assert.equal(migrated.status, "ready_not_activated");
  assert.equal(await readFile(join(targetRoot, ".zhitai-migration.json"), "utf8").then(() => true), true);
  const migratedDb = new DatabaseSync(join(targetRoot, "data", "kb.sqlite"), { readOnly: true });
  const asset = migratedDb.prepare("SELECT file_path, package_path FROM video_asset WHERE id='asset-1'").get();
  const importItem = migratedDb.prepare("SELECT input, status, error FROM import_item WHERE id=1").get();
  const importBatch = migratedDb.prepare("SELECT status FROM import_batch WHERE id='batch-1'").get();
  migratedDb.close();
  assert.equal(asset.file_path, join(migrated.targetRoot, "knowledge", "素材", "2026", "08", "27", "kb_asset-1", "assets", "clip.mp4"));
  assert.equal(asset.package_path, join(migrated.targetRoot, "knowledge", "素材", "2026", "08", "27", "kb_asset-1"));
  assert.equal(importItem.input, asset.file_path);
  assert.equal(importItem.status, "needs_attention");
  assert.equal(importItem.error, "migration_reapproval_required");
  assert.equal(importBatch.status, "needs_attention");
  assert.equal(migrated.marker.pathRebind.importItemsPaused, 1);
  assert.equal(migrated.marker.pathRebind.importBatchesPaused, 1);
  assert.equal(migrated.marker.pathRebind.blockingUnresolved, 0);
  const tasks = JSON.parse(await readFile(join(targetRoot, "data", "tasks.json"), "utf8"));
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  for (const [id, originalStatus] of [["pub-1", "scheduled"], ["pub-2", "queued"], ["pub-3", "running"]]) {
    assert.equal(tasksById.get(id).status, "needs_attention");
    assert.equal(tasksById.get(id).approved, false);
    assert.equal(tasksById.get(id).migrationOriginalStatus, originalStatus);
    assert.equal(tasksById.get(id).assetPath, asset.file_path);
  }
  assert.equal(tasksById.get("pub-4").status, "draft");
  assert.equal(tasksById.get("pub-5").status, "submitted");
  const migratedPublishFiles = await readdir(join(targetRoot, "data", "publish-jobs"));
  const migratedPublishJobs = await Promise.all(migratedPublishFiles.map(async (name) => JSON.parse(await readFile(join(targetRoot, "data", "publish-jobs", name), "utf8"))));
  const publishJobsById = new Map(migratedPublishJobs.map((job) => [job.id, job]));
  for (const id of ["pub-1", "pub-2", "pub-3"]) {
    assert.equal(publishJobsById.get(id).status, "needs_attention");
    assert.equal(publishJobsById.get(id).approved, false);
  }
  assert.equal(publishJobsById.get("pub-4").status, "draft");
  assert.equal(publishJobsById.get("pub-5").status, "submitted");
  assert.equal(migrated.marker.safetyActions.publishTasksReapprovalRequired, 3);
  assert.equal(migrated.marker.safetyActions.publishJobFilesReapprovalRequired, 3);
  assert.equal(migrated.marker.networkOrPublishActionsPerformed, false);
  const creative = JSON.parse(await readFile(join(targetRoot, "data", "creative-jobs.json"), "utf8"));
  assert.equal(creative[0].status, "paused");
  const analysis = JSON.parse(await readFile(join(targetRoot, "data", "analysis-jobs.json"), "utf8"));
  assert.equal(analysis[0].status, "paused");
  assert.equal(analysis[0].migrationOriginalStatus, "retry_wait");
  const publisherSchedule = JSON.parse(await readFile(join(targetRoot, "data", "publisher-schedule.json"), "utf8"));
  const schedulesById = new Map(publisherSchedule.tasks.map((task) => [task.id, task]));
  assert.equal(schedulesById.get("schedule-1").status, "needs_attention");
  assert.equal(schedulesById.get("schedule-1").approved, false);
  assert.equal(schedulesById.get("schedule-1").targets[0].status, "failed");
  assert.equal(schedulesById.get("schedule-2").status, "needs_reconciliation");
  assert.equal(schedulesById.get("schedule-2").targets[0].status, "unknown");
  assert.equal(schedulesById.get("schedule-3").status, "public");
  assert.equal(migrated.marker.safetyActions.analysisJobsPaused, 1);
  assert.equal(migrated.marker.safetyActions.publisherSchedulesReapprovalRequired, 2);

  await assert.rejects(
    migrateBackup({ backupPath, targetRoot }),
    (error) => error instanceof BackupError && error.code === "migration_target_exists",
  );
  await assert.rejects(
    rollbackMigration({ targetRoot, migrationId: `${migrated.migrationId}/../../escape` }),
    (error) => error instanceof BackupError && error.code === "rollback_migration_id_invalid",
  );
  const unexpectedFile = join(targetRoot, "unexpected-after-migration.txt");
  await writeFile(unexpectedFile, "changed after migration");
  await assert.rejects(
    rollbackMigration({ targetRoot, migrationId: migrated.migrationId }),
    (error) => error instanceof BackupError && error.code === "rollback_target_changed_since_migration",
  );
  await rm(unexpectedFile);
  const rolledBack = await rollbackMigration({ targetRoot, migrationId: migrated.migrationId });
  assert.equal(rolledBack.deleted, false);
  assert.equal(rolledBack.recoverable, true);
  assert.equal(await lstat(targetRoot).then(() => true, () => false), false);
  assert.equal((await lstat(rolledBack.quarantineRoot)).isDirectory(), true);
});

test("unresolved active database imports are paused and block migration activation", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.writer.close());
  fixture.writer.prepare("UPDATE import_item SET input=?, status='pending', error=NULL WHERE id=1").run("/old-machine/unresolved-download.mp4");
  const backupPath = join(fixture.root, "backups", "unresolved-import-bag");
  await createBackup({ dataDir: fixture.dataDir, knowledgeRoot: fixture.knowledgeRoot, outputPath: backupPath });
  const targetRoot = join(fixture.root, "unresolved-migration", "target");
  const migrated = await migrateBackup({ backupPath, targetRoot });
  assert.equal(migrated.status, "blocked_needs_attention");
  assert.equal(migrated.marker.pathRebind.blockingUnresolved, 1);
  assert.equal(migrated.marker.networkOrPublishActionsPerformed, false);
  const db = new DatabaseSync(join(targetRoot, "data", "kb.sqlite"), { readOnly: true });
  const item = db.prepare("SELECT input, status, error FROM import_item WHERE id=1").get();
  db.close();
  assert.equal(item.input, "/old-machine/unresolved-download.mp4");
  assert.equal(item.status, "needs_attention");
  assert.equal(item.error, "migration_reapproval_required");
  await rollbackMigration({ targetRoot, migrationId: migrated.migrationId });
});

test("failed migration copy is recoverably quarantined and never leaves an active target", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.writer.close());
  const backupPath = join(fixture.root, "backups", "failure-bag");
  await createBackup({ dataDir: fixture.dataDir, knowledgeRoot: fixture.knowledgeRoot, outputPath: backupPath });
  const targetRoot = join(fixture.root, "failed-migration", "target");
  let caught;
  try {
    await migrateBackup({
      backupPath,
      targetRoot,
      copyTreeImpl: async () => { throw new Error("FAKE_SECRET_MARKER_MUST_NOT_PERSIST"); },
    });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught instanceof BackupError, true);
  assert.equal(caught.code, "migration_failed");
  assert.equal(caught.details?.targetQuarantined, true);
  assert.match(caught.details?.migrationId || "", /^migration_/);
  assert.equal(await lstat(targetRoot).then(() => true, () => false), false);
  const parent = dirname(targetRoot);
  const quarantineName = (await readdir(parent)).find((name) => name.startsWith(".target.migration-failed-"));
  assert.ok(quarantineName);
  const failure = JSON.parse(await readFile(join(parent, quarantineName, "failure.json"), "utf8"));
  assert.equal(failure.errorCode, "migration_failed");
  assert.equal(JSON.stringify(failure).includes("FAKE_SECRET_MARKER_MUST_NOT_PERSIST"), false);
  assert.equal((await lstat(join(parent, quarantineName, "payload"))).isDirectory(), true);
  await verifyBackup({ backupPath });
});

test("sensitive fields inside allowlisted JSON fail closed without copying the value", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.writer.close());
  const secretMarker = "FAKE_ACCESS_TOKEN_MARKER_MUST_NEVER_BE_COPIED";
  await writeJson(join(fixture.dataDir, "tasks.json"), [{
    id: "unsafe-test-only",
    type: "publish",
    status: "draft",
    access_token: secretMarker,
  }]);
  const backupPath = join(fixture.root, "backups", "must-not-exist");
  let caught;
  try {
    await createBackup({ dataDir: fixture.dataDir, knowledgeRoot: fixture.knowledgeRoot, outputPath: backupPath });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught instanceof BackupError, true);
  assert.equal(caught.code, "sensitive_content_detected");
  assert.equal(String(caught.message).includes(secretMarker), false);
  assert.equal(await lstat(backupPath).then(() => true, () => false), false);
  const backupParentEntries = await readdir(dirname(backupPath));
  assert.equal(backupParentEntries.some((name) => name.includes(secretMarker)), false);
});

test("backup-only credential, session, QR, private-key, passphrase, and generic key fields fail closed", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.writer.close());
  const deniedFields = [
    "credential",
    "credentials",
    "privateKey",
    "private_key",
    "sessionId",
    "session_id",
    "qrCode",
    "passphrase",
    "recoveryCodes",
    "backup_codes",
    "jwt",
    "bearer",
    "key",
  ];
  for (const [index, field] of deniedFields.entries()) {
    const secretMarker = `FAKE_BACKUP_ONLY_SECRET_${index}_MUST_NEVER_BE_COPIED`;
    await writeJson(join(fixture.dataDir, "tasks.json"), [{ id: "unsafe-test-only", [field]: secretMarker }]);
    const backupPath = join(fixture.root, "backups", `denied-field-${index}`);
    let caught;
    try {
      await createBackup({ dataDir: fixture.dataDir, knowledgeRoot: fixture.knowledgeRoot, outputPath: backupPath });
    } catch (error) {
      caught = error;
    }
    assert.equal(caught instanceof BackupError, true, field);
    assert.equal(caught.code, "sensitive_content_detected", field);
    assert.equal(String(caught.message).includes(secretMarker), false, field);
    assert.equal(await lstat(backupPath).then(() => true, () => false), false, field);
  }
});

test("sensitive assignments already present in SQLite fail closed without exposing the value", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.writer.close());
  const secretMarker = "FAKE_DATABASE_TOKEN_MARKER_MUST_NEVER_BE_COPIED";
  fixture.writer.exec("ALTER TABLE ingest_observation ADD COLUMN message TEXT");
  fixture.writer.prepare("UPDATE ingest_observation SET message=? WHERE id=1").run(`access_token=${secretMarker}`);
  const backupPath = join(fixture.root, "backups", "database-secret-must-not-exist");
  let caught;
  try {
    await createBackup({ dataDir: fixture.dataDir, knowledgeRoot: fixture.knowledgeRoot, outputPath: backupPath });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught instanceof BackupError, true);
  assert.equal(caught.code, "sensitive_content_detected");
  assert.equal(String(caught.message).includes(secretMarker), false);
  assert.equal(await lstat(backupPath).then(() => true, () => false), false);
});

test("SQLite EAV settings and sensitive container tables fail closed", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.writer.close());
  const settingsMarker = "FAKE_EAV_ACCESS_TOKEN_MUST_NEVER_BE_COPIED";
  fixture.writer.exec("CREATE TABLE settings (name TEXT, value TEXT)");
  fixture.writer.prepare("INSERT INTO settings VALUES (?, ?)").run("access_token", settingsMarker);
  const settingsBackup = join(fixture.root, "backups", "sqlite-eav-secret-must-not-exist");
  let caught;
  try {
    await createBackup({ dataDir: fixture.dataDir, knowledgeRoot: fixture.knowledgeRoot, outputPath: settingsBackup });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught instanceof BackupError, true);
  assert.equal(caught.code, "sensitive_content_detected");
  assert.equal(String(caught.message).includes(settingsMarker), false);
  assert.equal(await lstat(settingsBackup).then(() => true, () => false), false);

  fixture.writer.exec("DELETE FROM settings");
  const accessKeyMarker = "FAKE_AWS_ACCESS_KEY_MUST_NEVER_BE_COPIED";
  fixture.writer.exec("CREATE TABLE generic_config (config_key TEXT, config_value TEXT)");
  fixture.writer.prepare("INSERT INTO generic_config VALUES (?, ?)").run("aws_access_key_id", accessKeyMarker);
  const configBackup = join(fixture.root, "backups", "sqlite-config-secret-must-not-exist");
  caught = null;
  try {
    await createBackup({ dataDir: fixture.dataDir, knowledgeRoot: fixture.knowledgeRoot, outputPath: configBackup });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught instanceof BackupError, true);
  assert.equal(caught.code, "sensitive_content_detected");
  assert.equal(String(caught.message).includes(accessKeyMarker), false);
  assert.equal(await lstat(configBackup).then(() => true, () => false), false);

  fixture.writer.exec("DELETE FROM generic_config");
  fixture.writer.exec("CREATE TABLE runtime_settings (otp INTEGER)");
  fixture.writer.prepare("INSERT INTO runtime_settings VALUES (?)").run(123456);
  const numericBackup = join(fixture.root, "backups", "sqlite-numeric-secret-must-not-exist");
  caught = null;
  try {
    await createBackup({ dataDir: fixture.dataDir, knowledgeRoot: fixture.knowledgeRoot, outputPath: numericBackup });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught instanceof BackupError, true);
  assert.equal(caught.code, "sensitive_content_detected");
  assert.equal(await lstat(numericBackup).then(() => true, () => false), false);

  fixture.writer.exec("DELETE FROM runtime_settings");
  const cookieMarker = "FAKE_COOKIE_TABLE_VALUE_MUST_NEVER_BE_COPIED";
  fixture.writer.exec("CREATE TABLE browser_cookies (name TEXT, value TEXT)");
  fixture.writer.prepare("INSERT INTO browser_cookies VALUES (?, ?)").run("SID", cookieMarker);
  const cookieBackup = join(fixture.root, "backups", "sqlite-cookie-secret-must-not-exist");
  caught = null;
  try {
    await createBackup({ dataDir: fixture.dataDir, knowledgeRoot: fixture.knowledgeRoot, outputPath: cookieBackup });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught instanceof BackupError, true);
  assert.equal(caught.code, "sensitive_content_detected");
  assert.equal(String(caught.message).includes(cookieMarker), false);
  assert.equal(await lstat(cookieBackup).then(() => true, () => false), false);
});

test("sensitive assignments in allowlisted text are audited before any target copy", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.writer.close());
  const secretMarker = "FAKE_TEXT_TOKEN_MARKER_MUST_NEVER_BE_COPIED";
  await writeFile(join(fixture.packageDir, "source.url"), `access_token=${secretMarker}\n`, "utf8");
  const backupPath = join(fixture.root, "backups", "text-secret-must-not-exist");
  let caught;
  try {
    await createBackup({ dataDir: fixture.dataDir, knowledgeRoot: fixture.knowledgeRoot, outputPath: backupPath });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught instanceof BackupError, true);
  assert.equal(caught.code, "sensitive_content_detected");
  assert.equal(String(caught.message).includes(secretMarker), false);
  assert.equal(await lstat(backupPath).then(() => true, () => false), false);
  const entries = await readdir(dirname(backupPath));
  assert.equal(entries.some((name) => name.startsWith(".text-secret-must-not-exist.partial-")), false);
  assert.equal(entries.includes(".text-secret-must-not-exist.backup-lock"), false);

  await rm(join(fixture.packageDir, "source.url"));
  const compactJwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzeW50aGV0aWMifQ.SYNTHETIC_SIGNATURE_TEST_ONLY";
  await writeFile(join(fixture.packageDir, "ordinary-notes.txt"), `${compactJwt}\n`, "utf8");
  const jwtBackup = join(fixture.root, "backups", "compact-jwt-must-not-exist");
  caught = null;
  try {
    await createBackup({ dataDir: fixture.dataDir, knowledgeRoot: fixture.knowledgeRoot, outputPath: jwtBackup });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught instanceof BackupError, true);
  assert.equal(caught.code, "sensitive_content_detected");
  assert.equal(String(caught.message).includes(compactJwt), false);
  assert.equal(await lstat(jwtBackup).then(() => true, () => false), false);
});

test("unknown opaque files and text disguised as recognized media fail closed", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.writer.close());
  const marker = "FAKE_OPAQUE_TOKEN_MUST_NEVER_BE_COPIED";
  const opaquePath = join(fixture.packageDir, "opaque.dat");
  await writeFile(opaquePath, `access_token=${marker}\n`, "utf8");
  const opaqueBackup = join(fixture.root, "backups", "opaque-must-not-exist");
  let caught;
  try {
    await createBackup({ dataDir: fixture.dataDir, knowledgeRoot: fixture.knowledgeRoot, outputPath: opaqueBackup });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught instanceof BackupError, true);
  assert.equal(caught.code, "unsupported_payload_file_type");
  assert.equal(String(caught.message).includes(marker), false);
  assert.equal(await lstat(opaqueBackup).then(() => true, () => false), false);

  await rm(opaquePath);
  const plistPath = join(fixture.packageDir, "preferences.plist");
  await writeFile(plistPath, `<?xml version="1.0"?><plist><dict><key>access_token</key><string>${marker}</string></dict></plist>`, "utf8");
  const plistBackup = join(fixture.root, "backups", "plist-must-not-exist");
  caught = null;
  try {
    await createBackup({ dataDir: fixture.dataDir, knowledgeRoot: fixture.knowledgeRoot, outputPath: plistBackup });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught instanceof BackupError, true);
  assert.equal(caught.code, "unsupported_payload_file_type");
  assert.equal(String(caught.message).includes(marker), false);
  assert.equal(await lstat(plistBackup).then(() => true, () => false), false);

  await rm(plistPath);
  const disguisedPath = join(fixture.packageDir, "disguised.mp4");
  await writeFile(disguisedPath, `access_token=${marker}\n`, "utf8");
  const disguisedBackup = join(fixture.root, "backups", "disguised-media-must-not-exist");
  caught = null;
  try {
    await createBackup({ dataDir: fixture.dataDir, knowledgeRoot: fixture.knowledgeRoot, outputPath: disguisedBackup });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught instanceof BackupError, true);
  assert.equal(caught.code, "binary_asset_signature_invalid");
  assert.equal(String(caught.message).includes(marker), false);
  assert.equal(await lstat(disguisedBackup).then(() => true, () => false), false);

  await rm(disguisedPath);
  const csvPath = join(fixture.packageDir, "generic-export.csv");
  await writeFile(csvPath, `site,password\nexample.test,${marker}\n`, "utf8");
  const csvBackup = join(fixture.root, "backups", "csv-secret-must-not-exist");
  caught = null;
  try {
    await createBackup({ dataDir: fixture.dataDir, knowledgeRoot: fixture.knowledgeRoot, outputPath: csvBackup });
  } catch (error) {
    caught = error;
  }
  assert.equal(caught instanceof BackupError, true);
  assert.equal(caught.code, "sensitive_content_detected");
  assert.equal(String(caught.message).includes(marker), false);
  assert.equal(await lstat(csvBackup).then(() => true, () => false), false);
});

test("VACUUM INTO fallback is valid and payload tampering fails closed", async (t) => {
  const fixture = await createFixture();
  t.after(() => fixture.writer.close());
  const backupPath = join(fixture.root, "backups", "vacuum-bag");
  const created = await createBackup({
    dataDir: fixture.dataDir,
    knowledgeRoot: fixture.knowledgeRoot,
    outputPath: backupPath,
    backupImpl: null,
  });
  assert.equal(created.sqlite.method, "sqlite_vacuum_into");
  await verifyBackup({ backupPath });

  const tamperedPath = join(fixture.root, "backups", "tampered-bag");
  await cp(backupPath, tamperedPath, { recursive: true, errorOnExist: true });
  const manifest = JSON.parse(await readFile(join(tamperedPath, "manifest.json"), "utf8"));
  const mediaEntry = manifest.files.find((entry) => entry.path.endsWith("clip.mp4"));
  await writeFile(join(tamperedPath, ...mediaEntry.path.split("/")), "tampered");
  await assert.rejects(
    verifyBackup({ backupPath: tamperedPath }),
    (error) => error instanceof BackupError && ["payload_size_mismatch", "payload_checksum_mismatch"].includes(error.code),
  );
});
