import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BackupError,
  createBackup,
  migrateBackup,
  previewMigration,
  restoreBackup,
  verifyBackup,
} from "../local-agent/backup.mjs";

const TEST_TIMEOUT_MS = 10_000;
const TAG_FILES = ["bagit.txt", "bag-info.txt", "manifest-sha256.txt", "manifest.json"];
const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "local-agent", "backup-cli.mjs");
const CLI_NODE_ARGS = ["--disable-warning=ExperimentalWarning", CLI_PATH];

async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function sha256(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function createFixture(t, label) {
  const root = await mkdtemp(join(tmpdir(), `zhitai-backup-security-${label}-`));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const dataDir = join(root, "data");
  const knowledgeRoot = join(root, "knowledge");
  const backupPath = join(root, "bag");
  await mkdir(dataDir);
  await mkdir(knowledgeRoot);

  const db = new DatabaseSync(join(dataDir, "kb.sqlite"));
  try {
    db.exec("CREATE TABLE video_asset (id TEXT PRIMARY KEY)");
  } finally {
    db.close();
  }

  await createBackup({ dataDir, knowledgeRoot, outputPath: backupPath });
  return { root, backupPath };
}

async function cloneBag(source, root, label) {
  const target = join(root, label);
  await cp(source, target, { recursive: true, errorOnExist: true });
  return target;
}

async function rebuildChecksums(backupPath) {
  const manifestPath = join(backupPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files.sort((left, right) => left.path.localeCompare(right.path, "en"));
  manifest.payload.fileCount = manifest.files.length;
  manifest.payload.sizeBytes = manifest.files.reduce((sum, entry) => sum + entry.sizeBytes, 0);

  const bagInfoPath = join(backupPath, "bag-info.txt");
  const bagInfo = await readFile(bagInfoPath, "utf8");
  await writeFile(
    bagInfoPath,
    bagInfo.replace(/Payload-Oxum: \d+\.\d+/, `Payload-Oxum: ${manifest.payload.sizeBytes}.${manifest.payload.fileCount}`),
    "utf8",
  );
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(
    join(backupPath, "manifest-sha256.txt"),
    `${manifest.files.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n")}\n`,
    "utf8",
  );
  const tagRows = await Promise.all(TAG_FILES.map(async (name) => `${await sha256(join(backupPath, name))}  ${name}`));
  await writeFile(join(backupPath, "tagmanifest-sha256.txt"), `${tagRows.join("\n")}\n`, "utf8");
  return manifest;
}

async function injectManifestedFile(backupPath, relativePath, content) {
  const target = join(backupPath, ...relativePath.split("/"));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, "utf8");
  const info = await stat(target);
  const manifestPath = join(backupPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.files.push({
    path: relativePath,
    category: "security_test_fixture",
    sizeBytes: info.size,
    sha256: await sha256(target),
  });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await rebuildChecksums(backupPath);
}

function isBackupError(code) {
  return (error) => error instanceof BackupError && error.code === code;
}

test("restore rejects a path-escaping prefix without creating anything outside tempParent", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { root, backupPath } = await createFixture(t, "restore-prefix");
  const tempParent = join(root, "isolated");
  const before = (await readdir(root)).sort();

  await assert.rejects(
    restoreBackup({ backupPath, tempParent, prefix: "../escaped-" }),
    isBackupError("restore_prefix_invalid"),
  );

  assert.deepEqual((await readdir(root)).sort(), before, "invalid prefix must not create tempParent or a sibling restore directory");
  assert.equal(await pathExists(tempParent), false);
  await verifyBackup({ backupPath });
});

test("create rejects an output inside live data before creating missing parents", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-backup-security-create-overlap-"));
  t.after(async () => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const knowledgeRoot = join(root, "knowledge");
  await mkdir(dataDir);
  await mkdir(knowledgeRoot);
  const db = new DatabaseSync(join(dataDir, "kb.sqlite"));
  db.exec("CREATE TABLE video_asset (id TEXT PRIMARY KEY)");
  db.close();
  const forbiddenParent = join(dataDir, "new", "deep");
  await assert.rejects(
    createBackup({ dataDir, knowledgeRoot, outputPath: join(forbiddenParent, "bag") }),
    isBackupError("backup_output_inside_source"),
  );
  assert.equal(await pathExists(join(dataDir, "new")), false, "rejected create must not mutate the live data root");
});

test("restore rejects a temp parent inside the backup without modifying the bag", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { backupPath } = await createFixture(t, "restore-parent");
  const tempParent = join(backupPath, "nested-restore-parent");

  await assert.rejects(
    restoreBackup({ backupPath, tempParent }),
    isBackupError("restore_parent_inside_backup"),
  );

  assert.equal(await pathExists(tempParent), false, "rejected restore parent must not be created inside the backup");
  await verifyBackup({ backupPath });
});

test("preview and migrate reject direct and symlinked targets inside the backup without writes", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { root, backupPath } = await createFixture(t, "migration-overlap");
  const alias = join(root, "bag-alias");
  await symlink(backupPath, alias, "dir");

  const targets = [
    { label: "direct", path: join(backupPath, "direct-target") },
    { label: "symlink-parent", path: join(alias, "symlink-target") },
  ];
  for (const target of targets) {
    const preview = await previewMigration({ backupPath, targetRoot: target.path });
    assert.equal(preview.canMigrate, false, `${target.label} preview must fail closed`);
    assert.equal(preview.blockedReason, "target_overlaps_backup");
    assert.equal(await pathExists(target.path), false);

    await assert.rejects(
      migrateBackup({ backupPath, targetRoot: target.path }),
      isBackupError("migration_target_overlaps_backup"),
    );
    assert.equal(await pathExists(target.path), false, `${target.label} migration must not create a target`);
    await verifyBackup({ backupPath });
  }
});

test("verification fails closed for extra files and independent manifest or tag tampering", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { root, backupPath } = await createFixture(t, "tamper-basic");

  const extraBag = await cloneBag(backupPath, root, "extra-file-bag");
  await writeFile(join(extraBag, "unmanifested.txt"), "unmanifested test data\n", "utf8");
  await assert.rejects(verifyBackup({ backupPath: extraBag }), isBackupError("backup_contains_unmanifested_files"));

  const manifestBag = await cloneBag(backupPath, root, "manifest-tamper-bag");
  const manifestPath = join(manifestBag, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.backupId = `${manifest.backupId}_tampered`;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await assert.rejects(verifyBackup({ backupPath: manifestBag }), isBackupError("tag_checksum_mismatch"));

  const tagBag = await cloneBag(backupPath, root, "tag-tamper-bag");
  const tagPath = join(tagBag, "tagmanifest-sha256.txt");
  const tagText = await readFile(tagPath, "utf8");
  await writeFile(tagPath, tagText.replace(/^[0-9a-f]{64}/, "0".repeat(64)), "utf8");
  await assert.rejects(verifyBackup({ backupPath: tagBag }), isBackupError("tag_checksum_mismatch"));

  const traversalBag = await cloneBag(backupPath, root, "manifest-traversal-bag");
  const traversalManifestPath = join(traversalBag, "manifest.json");
  const traversalManifest = JSON.parse(await readFile(traversalManifestPath, "utf8"));
  traversalManifest.files[0].path = "data/state/../../outside";
  await writeFile(traversalManifestPath, `${JSON.stringify(traversalManifest, null, 2)}\n`, "utf8");
  await assert.rejects(verifyBackup({ backupPath: traversalBag }), isBackupError("unsafe_relative_path"));
});

test("self-consistent checksum rewrites cannot inject excluded state or unknown payload namespaces", { timeout: TEST_TIMEOUT_MS }, async (t) => {
  const { root, backupPath } = await createFixture(t, "tamper-rehashed");

  const excludedStateBag = await cloneBag(backupPath, root, "rehashed-state-token-bag");
  await injectManifestedFile(
    excludedStateBag,
    "data/state/token.json",
    `${JSON.stringify({ token: "FAKE_SECRET_MARKER_FOR_TEST_ONLY" })}\n`,
  );
  await assert.rejects(
    verifyBackup({ backupPath: excludedStateBag }),
    isBackupError("manifest_contains_excluded_path"),
  );

  const sanitizedCacheBag = await cloneBag(backupPath, root, "rehashed-sanitized-cache-bag");
  await injectManifestedFile(
    sanitizedCacheBag,
    "data/knowledge/.cache/raw-yuanbao.sanitized.json",
    `${JSON.stringify({ title: "must remain excluded under cache" })}\n`,
  );
  await assert.rejects(
    verifyBackup({ backupPath: sanitizedCacheBag }),
    isBackupError("manifest_contains_excluded_path"),
  );

  const unknownNamespaceBag = await cloneBag(backupPath, root, "rehashed-unknown-namespace-bag");
  await injectManifestedFile(unknownNamespaceBag, "data/other/rogue.json", "{}\n");
  await assert.rejects(
    verifyBackup({ backupPath: unknownNamespaceBag }),
    isBackupError("manifest_payload_namespace_invalid"),
  );
});

test("CLI errors expose only a stable error code and never echo a fake secret marker", { timeout: TEST_TIMEOUT_MS }, () => {
  const marker = "FAKE_CLI_SECRET_MARKER_7f43f49a_TEST_ONLY";
  const missingBackup = join(tmpdir(), marker, "missing-backup");
  const result = spawnSync(process.execPath, [...CLI_NODE_ARGS, "verify", "--backup", missingBackup], {
    encoding: "utf8",
    timeout: 5_000,
  });

  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(`${result.stdout}${result.stderr}`.includes(marker), false);

  const lines = result.stderr.trim().split(/\r?\n/);
  assert.equal(lines.length, 1, "stderr must contain one JSON error object and no stack trace");
  const parsed = JSON.parse(lines[0]);
  assert.deepEqual(Object.keys(parsed).sort(), ["error", "ok"]);
  assert.deepEqual(parsed, { ok: false, error: "backup_not_plain_directory" });
});

test("CLI accepts direct arguments and a forwarded package-manager separator", () => {
  for (const args of [["--help"], ["--", "--help"]]) {
    const result = spawnSync(process.execPath, [...CLI_NODE_ARGS, ...args], {
      encoding: "utf8",
      timeout: 5_000,
    });
    assert.equal(result.error, undefined);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /织台可验证备份/);
    assert.equal(result.stderr, "");
  }
});
