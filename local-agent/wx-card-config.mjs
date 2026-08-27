import { chmod, readFile, rename, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function disableWxCardSystemProxy(configText) {
  const newline = configText.includes("\r\n") ? "\r\n" : "\n";
  const lines = configText.split(/\r?\n/);
  const proxyBlocks = lines
    .map((line, index) => (/^proxy:\s*(?:#.*)?$/.test(line) ? index : -1))
    .filter((index) => index >= 0);

  if (proxyBlocks.length !== 1) {
    throw new Error(`expected one top-level proxy block, found ${proxyBlocks.length}`);
  }

  const blockStart = proxyBlocks[0];
  let blockEnd = blockStart + 1;
  while (blockEnd < lines.length && (/^\s*$/.test(lines[blockEnd]) || /^[ \t]+/.test(lines[blockEnd]))) {
    blockEnd += 1;
  }

  const systemRows = [];
  for (let index = blockStart + 1; index < blockEnd; index += 1) {
    if (/^[ \t]+system:\s*(?:true|false)\s*(?:#.*)?$/.test(lines[index])) systemRows.push(index);
  }
  if (systemRows.length !== 1) {
    throw new Error(`expected one proxy.system setting, found ${systemRows.length}`);
  }

  const systemRow = systemRows[0];
  const previous = /system:\s*(true|false)/.exec(lines[systemRow])?.[1];
  lines[systemRow] = lines[systemRow].replace(/(system:\s*)true\b/, "$1false");
  return {
    changed: previous === "true",
    previous,
    text: lines.join(newline),
  };
}

export async function ensureWxCardSystemProxyDisabled(configPath) {
  const original = await readFile(configPath, "utf8");
  const result = disableWxCardSystemProxy(original);
  if (!result.changed) return result;

  const metadata = await stat(configPath);
  const temporaryPath = `${configPath}.zhitai-${process.pid}.tmp`;
  await writeFile(temporaryPath, result.text, { mode: metadata.mode });
  await rename(temporaryPath, configPath);
  await chmod(configPath, metadata.mode);
  return result;
}

async function main() {
  const configPath = process.argv[2];
  if (!configPath) throw new Error("wx-video-card config path is required");
  const result = await ensureWxCardSystemProxyDisabled(resolve(configPath));
  process.stdout.write(result.changed
    ? "已关闭视频号引擎的全局系统代理接管。\n"
    : "视频号引擎的全局系统代理接管已关闭。\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`无法更新视频号代理配置：${error.message}\n`);
    process.exitCode = 1;
  });
}
