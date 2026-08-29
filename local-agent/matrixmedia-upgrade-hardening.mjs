import { createHash } from "node:crypto";
import { createReadStream, constants as fsConstants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  createPackageFromStreams,
  extractAll,
  extractFile,
  getRawHeader,
  uncache,
} from "@electron/asar";

const MATRIX_MAIN_PATH = "dist/electron/main.js";
const DOCUMENTS_PATH_RE = /getPath\((['"])documents\1\)/g;
const USER_DATA_PATH_RE = /getPath\((['"])userData\1\)/g;
const MATRIX_DATA_SUFFIX_RE = /["']MatrixMedia["']\s*,\s*["']data["']/;

function countMatches(source, expression) {
  expression.lastIndex = 0;
  let count = 0;
  while (expression.exec(source)) count += 1;
  expression.lastIndex = 0;
  return count;
}

function countMatrixDataReferences(source, expression) {
  expression.lastIndex = 0;
  let count = 0;
  while (expression.exec(source)) {
    if (MATRIX_DATA_SUFFIX_RE.test(source.slice(expression.lastIndex, expression.lastIndex + 240))) count += 1;
  }
  expression.lastIndex = 0;
  return count;
}

export function patchMatrixMediaMainSource(source) {
  const text = String(source || "");
  const documentsCount = countMatches(text, DOCUMENTS_PATH_RE);
  const matrixDocumentsCount = countMatrixDataReferences(text, DOCUMENTS_PATH_RE);
  const matrixUserDataBefore = countMatrixDataReferences(text, USER_DATA_PATH_RE);

  if (documentsCount === 0) {
    if (matrixUserDataBefore >= 3) {
      return { source: text, action: "already_user_data", patchedCount: 0 };
    }
    throw new Error("MatrixMedia app.asar 未找到 documents 数据根，且无法确认上游已改用 userData；拒绝更新");
  }
  if (documentsCount !== 3 || matrixDocumentsCount !== 3) {
    throw new Error(`MatrixMedia app.asar documents 数据根数量异常（总计 ${documentsCount}，MatrixMedia 数据根 ${matrixDocumentsCount}，期望均为 3）；拒绝更新`);
  }

  const patched = text.replace(DOCUMENTS_PATH_RE, (_whole, quote) => `getPath(${quote}userData${quote})`);
  const remainingDocuments = countMatches(patched, DOCUMENTS_PATH_RE);
  const matrixUserDataAfter = countMatrixDataReferences(patched, USER_DATA_PATH_RE);
  if (remainingDocuments !== 0 || matrixUserDataAfter !== matrixUserDataBefore + 3) {
    throw new Error("MatrixMedia app.asar data-root 补丁复核失败；拒绝更新");
  }
  return { source: patched, action: "patched", patchedCount: 3 };
}

function safeExtractedPath(root, relativePath) {
  const absoluteRoot = resolve(root);
  const absolute = resolve(root, relativePath);
  if (absolute !== absoluteRoot && !absolute.startsWith(`${absoluteRoot}/`)) {
    throw new Error("MatrixMedia app.asar 包含越界路径；拒绝更新");
  }
  return absolute;
}

async function streamsFromHeader(entry, extractedRoot, parentPath = "", inheritedUnpacked = false, rows = []) {
  for (const [name, child] of Object.entries(entry?.files || {})) {
    const relativePath = parentPath ? join(parentPath, name) : name;
    const unpacked = inheritedUnpacked || child?.unpacked === true;
    const extractedPath = safeExtractedPath(extractedRoot, relativePath);
    if (child?.files) {
      rows.push({ type: "directory", path: relativePath, unpacked });
      await streamsFromHeader(child, extractedRoot, relativePath, unpacked, rows);
      continue;
    }
    const stat = await lstat(extractedPath);
    if (typeof child?.link === "string") {
      rows.push({
        type: "link",
        path: relativePath,
        unpacked,
        stat,
        symlink: await readlink(extractedPath),
        streamGenerator: () => createReadStream(extractedPath),
      });
      continue;
    }
    rows.push({
      type: "file",
      path: relativePath,
      unpacked,
      stat,
      streamGenerator: () => createReadStream(extractedPath),
    });
  }
  return rows;
}

async function swapArchive(archivePath, replacementPath) {
  const archiveUnpacked = `${archivePath}.unpacked`;
  const replacementUnpacked = `${replacementPath}.unpacked`;
  const backupArchive = `${archivePath}.zhitai-upstream`;
  const backupUnpacked = `${archiveUnpacked}.zhitai-upstream`;
  await rm(backupArchive, { force: true });
  await rm(backupUnpacked, { recursive: true, force: true });
  const hadUnpacked = await lstat(archiveUnpacked).then(() => true, () => false);
  const hasReplacementUnpacked = await lstat(replacementUnpacked).then(() => true, () => false);
  await rename(archivePath, backupArchive);
  if (hadUnpacked) await rename(archiveUnpacked, backupUnpacked);
  try {
    await rename(replacementPath, archivePath);
    if (hasReplacementUnpacked) await rename(replacementUnpacked, archiveUnpacked);
  } catch (error) {
    await rm(archivePath, { force: true });
    await rm(archiveUnpacked, { recursive: true, force: true });
    await rename(backupArchive, archivePath);
    if (hadUnpacked) await rename(backupUnpacked, archiveUnpacked);
    throw error;
  }
  await rm(backupArchive, { force: true });
  await rm(backupUnpacked, { recursive: true, force: true });
  uncache(archivePath);
}

export async function hardenMatrixMediaAsar(archivePath, workspaceRoot) {
  const mainSource = extractFile(archivePath, MATRIX_MAIN_PATH).toString("utf8");
  const patch = patchMatrixMediaMainSource(mainSource);
  if (patch.action === "already_user_data") {
    return { action: patch.action, patchedCount: 0 };
  }

  const patchRoot = join(workspaceRoot, "matrixmedia-asar-hardening");
  const extractedRoot = join(patchRoot, "extracted");
  const replacementRoot = join(patchRoot, "replacement");
  const replacementArchive = join(replacementRoot, "app.asar");
  await rm(patchRoot, { recursive: true, force: true });
  await mkdir(extractedRoot, { recursive: true });
  await mkdir(replacementRoot, { recursive: true });
  extractAll(archivePath, extractedRoot);
  await writeFile(join(extractedRoot, MATRIX_MAIN_PATH), patch.source, "utf8");

  const { header } = getRawHeader(archivePath);
  const streams = await streamsFromHeader(header, extractedRoot);
  await createPackageFromStreams(replacementArchive, streams);
  uncache(replacementArchive);
  const replacementSource = extractFile(replacementArchive, MATRIX_MAIN_PATH).toString("utf8");
  const verified = patchMatrixMediaMainSource(replacementSource);
  if (verified.action !== "already_user_data") {
    throw new Error("MatrixMedia app.asar 补丁归档复核失败；拒绝更新");
  }
  await swapArchive(archivePath, replacementArchive);
  return { action: patch.action, patchedCount: patch.patchedCount };
}

export function matrixMediaAsarHeaderSha256(archivePath) {
  const { headerString } = getRawHeader(archivePath);
  return createHash("sha256").update(headerString).digest("hex");
}

async function migrateDirectory(sourceRoot, targetRoot, counters) {
  let entries;
  try {
    entries = await readdir(sourceRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await mkdir(targetRoot, { recursive: true });
  for (const entry of entries) {
    const source = join(sourceRoot, entry.name);
    const target = join(targetRoot, entry.name);
    if (entry.isDirectory()) {
      await migrateDirectory(source, target, counters);
      continue;
    }
    if (!entry.isFile()) throw new Error("MatrixMedia 历史数据包含非普通文件；为避免越界读取，拒绝迁移");
    try {
      await copyFile(source, target, fsConstants.COPYFILE_EXCL);
      counters.copied += 1;
    } catch (error) {
      if (error?.code === "EEXIST") counters.skipped += 1;
      else throw error;
    }
  }
}

export async function migrateMatrixMediaDataWithoutOverwrite(sourceRoot, targetRoot) {
  const counters = { copied: 0, skipped: 0 };
  await migrateDirectory(sourceRoot, targetRoot, counters);
  return counters;
}
