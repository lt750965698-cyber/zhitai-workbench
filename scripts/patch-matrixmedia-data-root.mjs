#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [sourceArg, outputArg] = process.argv.slice(2);
if (!sourceArg || !outputArg) {
  console.error("usage: patch-matrixmedia-data-root.mjs <source-app.asar> <output-app.asar>");
  process.exit(2);
}

const sourceAsar = resolve(sourceArg);
const outputAsar = resolve(outputArg);
if (!existsSync(sourceAsar)) throw new Error(`source_not_found:${sourceAsar}`);
if (sourceAsar === outputAsar) throw new Error("output_must_differ_from_source");

const asarModule = process.env.ELECTRON_ASAR_MODULE;
if (!asarModule || !existsSync(asarModule)) {
  throw new Error("ELECTRON_ASAR_MODULE must point to @electron/asar/lib/asar.js");
}
const asar = await import(pathToFileURL(asarModule).href);

const scratch = mkdtempSync(join(tmpdir(), "zhitai-matrixmedia-patch-"));
const unpacked = join(scratch, "app");
try {
  asar.extractAll(sourceAsar, unpacked);
  const mainPath = join(unpacked, "dist", "electron", "main.js");
  const source = readFileSync(mainPath, "utf8");
  const protectedPathToken = 'getPath("documents")';
  const privatePathToken = 'getPath("userData")';
  const replacements = source.split(protectedPathToken).length - 1;
  if (replacements !== 3) {
    throw new Error(`unexpected_documents_path_count:${replacements}`);
  }
  const patched = source.split(protectedPathToken).join(privatePathToken);
  writeFileSync(mainPath, patched);

  mkdirSync(dirname(outputAsar), { recursive: true });
  await asar.createPackage(unpacked, outputAsar);
  const verified = asar.extractFile(outputAsar, "dist/electron/main.js").toString("utf8");
  if (verified.includes(protectedPathToken)) throw new Error("verification_documents_path_remains");
  const privatePathCount = verified.split(privatePathToken).length - 1;
  if (privatePathCount < replacements) throw new Error("verification_private_path_missing");

  const sourceData = join(homedir(), "Documents", "MatrixMedia", "data");
  const targetData = join(homedir(), "Library", "Application Support", "matrix-video", "MatrixMedia", "data");
  let migrated = false;
  if (existsSync(sourceData)) {
    mkdirSync(targetData, { recursive: true });
    cpSync(sourceData, targetData, { recursive: true, force: false, errorOnExist: false });
    migrated = true;
  }

  const sha256 = createHash("sha256").update(readFileSync(outputAsar)).digest("hex");
  console.log(JSON.stringify({
    ok: true,
    source: basename(sourceAsar),
    output: basename(outputAsar),
    replacements,
    migrated,
    sizeBytes: statSync(outputAsar).size,
    sha256,
  }));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
