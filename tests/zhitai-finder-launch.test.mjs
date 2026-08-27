import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* 织台桌面版 · Finder 启动契约测试
 * 断言启动命令：绝对 script_dir 作为 Electron 应用参数（严禁裸 .）；
 * env -u ELECTRON_RUN_AS_NODE；日志写入 ~/Library/Logs/zhitai-desktop-electron.log。
 */

const scriptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../desktop/织台桌面版.command");
const src = fs.readFileSync(scriptPath, "utf8");

test("Finder 启动命令使用绝对 script_dir 作为最后应用参数", () => {
  assert.match(src, /env\s+-u\s+ELECTRON_RUN_AS_NODE/);
  // 形式：nohup env -u ELECTRON_RUN_AS_NODE "${ELECTRON_BIN}" "${script_dir}" >>...
  assert.match(src, /env\s+-u\s+ELECTRON_RUN_AS_NODE\s+"\$\{ELECTRON_BIN\}"\s+"\$\{script_dir\}"/);
});

test("Finder 启动命令不得以裸 . 作为应用参数", () => {
  // 变异：改回裸点（./. 或单独 .）都会破坏上面的绝对路径断言
  assert.ok(
    !/env\s+-u\s+ELECTRON_RUN_AS_NODE\s+"\$\{ELECTRON_BIN\}"\s+\.\b/.test(src),
    "检测到裸 . 作为应用参数（会打开 Electron 欢迎页）",
  );
});

test("变异：把绝对 script_dir 改回裸点会被杀死", () => {
  const mutated = src.replace(/"\$\{script_dir\}"\s*>>/, ". >>");
  assert.ok(/env\s+-u\s+ELECTRON_RUN_AS_NODE\s+"\$\{ELECTRON_BIN\}"\s+\.\s*>>/.test(mutated), "变异后应出现裸点启动形式");
  assert.ok(!/env\s+-u\s+ELECTRON_RUN_AS_NODE\s+"\$\{ELECTRON_BIN\}"\s+"\$\{script_dir\}"/.test(mutated), "变异后不应再是绝对 script_dir");
});

test("启动日志写入 ~/Library/Logs/zhitai-desktop-electron.log（不丢 /dev/null）", () => {
  assert.match(src, /zhitai-desktop-electron\.log/);
  assert.ok(!/>>\s*\/dev\/null/.test(src), "日志不得丢弃到 /dev/null");
});

test("启动命令直接调用 dist 二进制（不经 .bin/electron）", () => {
  assert.match(src, /node_modules\/electron\/dist\/Electron\.app\/Contents\/MacOS\/Electron/);
  assert.ok(!src.includes("node_modules/.bin/electron"), "不得经过 .bin/electron（依赖 PATH node）");
});
