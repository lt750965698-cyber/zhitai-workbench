/**
 * helpers.mjs — 测试辅助（真实文件系统扫描，非模拟实现）
 */
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** 在根目录下查找 metadata.json 中 id=assetId 的包目录 */
export async function findPackageDir(root, assetId, depth = 0) {
  if (depth > 6) return null;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return null; }
  for (const e of entries) {
    if (e.name === ".DS_Store" || e.name.startsWith(".")) continue;
    const p = join(root, e.name);
    if (e.isDirectory()) {
      const found = await findPackageDir(p, assetId, depth + 1);
      if (found) return found;
    } else if (e.name === "metadata.json") {
      try {
        const meta = JSON.parse(await import("node:fs/promises").then((m) => m.readFile(p, "utf8")));
        if (meta.id === assetId) return root;
      } catch { /* ignore */ }
    }
  }
  return null;
}
