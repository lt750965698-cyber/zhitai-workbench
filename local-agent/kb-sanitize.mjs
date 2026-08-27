/**
 * kb-sanitize.mjs — 真实库敏感文件脱敏迁移命令（供阶段 B 手动执行；阶段 A 不运行）
 *
 * 流程（每步可回滚）：
 *   1. 备份：把内容库所有 raw-yuanbao.json 复制到私有归档目录 dataDir/private/raw-backup/（0600）
 *   2. 归档原文件：原始 raw-yuanbao.json 移入 dataDir/private/raw/<相对路径>.json（0600）
 *   3. 写脱敏替代：在原位置写 raw-yuanbao.sanitized.json（剥 videoUrl/decodeKey/token/encfilekey/cookie）
 *   4. 验证：扫描确认内容库中不再存在含敏感键的文件；私有目录权限 0600
 *
 * 用法：node kb-sanitize.mjs --kb-root <内容库> --data-dir <dataDir> [--dry-run]
 */
import { readFile, writeFile, mkdir, readdir, copyFile, rename, chmod } from "node:fs/promises";
import { join, dirname } from "node:path";
import { sanitizeRawForStorage } from "./downloader-adapter.mjs";

const SENSITIVE = /videoUrl|playableUrl|decodeKey|decryptKey|encfilekey|cookie|token|signature|authorization/i;

async function walkFiles(root, out, depth = 0) {
  if (depth > 8) return;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === ".DS_Store") continue;
    const p = join(root, e.name);
    if (e.isDirectory() && !e.name.startsWith(".")) await walkFiles(p, out, depth + 1);
    else if (e.isFile()) out.push(p);
  }
}

export async function sanitizeLibrary({ kbRoot, dataDir, dryRun = false }) {
  const privRaw = join(dataDir, "private", "raw");
  const privBackup = join(dataDir, "private", "raw-backup");
  const all = [];
  await walkFiles(kbRoot, all);
  const raws = all.filter((p) => /raw-yuanbao\.json$/.test(p) && !/\.sanitized\.json$/.test(p));
  let archived = 0, sanitizedCount = 0, alreadyClean = 0, failed = 0;

  for (const rawPath of raws) {
    try {
      const raw = JSON.parse(await readFile(rawPath, "utf8"));
      const text = JSON.stringify(raw);
      if (!SENSITIVE.test(text)) { alreadyClean++; continue; }

      const rel = rawPath.replace(kbRoot, "").replace(/^[/\\]+/, "").replace(/[/\\]/g, "__");
      if (dryRun) { console.log(`[dry-run] 将归档并脱敏: ${rel}`); sanitizedCount++; continue; }

      // 1) 备份 + 2) 归档原文件到私有目录（0600）
      await mkdir(privRaw, { recursive: true });
      await mkdir(privBackup, { recursive: true });
      await copyFile(rawPath, join(privBackup, rel + ".bak"));
      await chmod(join(privBackup, rel + ".bak"), 0o600);
      await rename(rawPath, join(privRaw, rel + ".json"));
      await chmod(join(privRaw, rel + ".json"), 0o600);
      archived++;

      // 3) 写脱敏替代
      const cleaned = sanitizeRawForStorage(raw);
      await writeFile(join(dirname(rawPath), "raw-yuanbao.sanitized.json"), JSON.stringify(cleaned, null, 2));
      sanitizedCount++;
    } catch (e) {
      failed++;
      console.error(`失败 ${rawPath}: ${e.message}`);
    }
  }

  // 4) 验证
  let residual = 0;
  if (!dryRun) {
    const after = [];
    await walkFiles(kbRoot, after);
    for (const p of after) {
      if (/raw-yuanbao\.json$/.test(p) && !/sanitized/.test(p)) residual++;
    }
  }
  return { totalRaws: raws.length, archived, sanitized: sanitizedCount, alreadyClean, failed, residual };
}

// CLI 入口
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const args = process.argv.slice(2);
  const kbRoot = args.find((a) => a.startsWith("--kb-root="))?.split("=")[1];
  const dataDir = args.find((a) => a.startsWith("--data-dir="))?.split("=")[1];
  const dryRun = args.includes("--dry-run");
  if (!kbRoot || !dataDir) {
    console.error("用法: node kb-sanitize.mjs --kb-root <内容库> --data-dir <dataDir> [--dry-run]");
    process.exit(2);
  }
  sanitizeLibrary({ kbRoot, dataDir, dryRun }).then((r) => {
    console.log("脱敏迁移结果:", JSON.stringify(r, null, 2));
    if (r.residual > 0) { console.error(`仍残留 ${r.residual} 个未脱敏 raw-yuanbao.json`); process.exit(1); }
  }).catch((e) => { console.error(e); process.exit(1); });
}
