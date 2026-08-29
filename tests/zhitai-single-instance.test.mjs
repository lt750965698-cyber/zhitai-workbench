import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* 织台桌面版 · 单实例契约（静态）
 * main.js 必须 requestSingleInstanceLock；拿不到锁即退出；second-instance 聚焦已有窗口。
 */

const mainPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../desktop/main.js");
const src = fs.readFileSync(mainPath, "utf8");

test("织台在申请单实例锁前设置独立应用名与 userData", () => {
  const nameAt = src.indexOf('app.setName("Zhitai")');
  const userDataAt = src.indexOf('app.setPath("userData"');
  const lockAt = src.indexOf("app.requestSingleInstanceLock()");
  assert.ok(nameAt >= 0 && userDataAt >= 0, "必须设置织台独立 Electron 身份");
  assert.ok(nameAt < lockAt && userDataAt < lockAt, "独立身份必须在单实例锁之前设置");
});

test("内部应用名保持 ASCII，避免 Electron 把中文写入 User-Agent", () => {
  assert.match(src, /app\.setName\("Zhitai"\)/);
  assert.doesNotMatch(src, /app\.setName\("织台"\)/);
  assert.match(src, /app\.setAppUserModelId\("com\.zhitai\.desktop"\)/);
});

test("Dock 使用织台品牌图，不再显示默认 Electron 图标", () => {
  assert.match(src, /app\.dock\.setIcon\(icon\)/);
  assert.match(src, /public["',\s]+["']og\.png/);
});

test("main.js 请求单实例锁", () => {
  assert.match(src, /requestSingleInstanceLock\(\)/);
});

test("拿不到锁时退出（app.quit），不再起第二套监管", () => {
  assert.match(src, /if \(!gotSingleInstanceLock\)/);
  assert.match(src, /app\.quit\(\)/);
});

test("second-instance 只聚焦已有窗口（restore + focus）", () => {
  assert.match(src, /second-instance/);
  assert.match(src, /mainWindow\.restore\(\)/);
  assert.match(src, /mainWindow\.focus\(\)/);
});

test("桌面 App 每次启动重新获取入口 HTML，更新后无需手动刷新", () => {
  assert.match(src, /searchParams\.set\("_zhitai_launch", String\(Date\.now\(\)\)\)/);
  assert.match(src, /mainWindow\.loadURL\(launchUrl\)/);
});

test("所有后台创作窗口默认静音并移除媒体自动播放与循环", () => {
  assert.match(src, /webContents\.setAudioMuted\(true\)/);
  assert.match(src, /media\.autoplay = false/);
  assert.match(src, /media\.loop = false/);
  assert.match(src, /media\.muted = true/);
  assert.match(src, /keepCreativeStudioQuiet\(existing\)/);
  assert.match(src, /keepCreativeStudioQuiet\(child\)/);
});

test("主窗口进入后台时立即静音并暂停媒体，回到前台不自动续播", () => {
  assert.match(src, /function stopWindowMediaWhenBackgrounded\(child\)/);
  assert.match(src, /child\.on\("blur", pauseMedia\)/);
  assert.match(src, /child\.on\("minimize", pauseMedia\)/);
  assert.match(src, /media\.pause\(\)/);
  assert.match(src, /stopWindowMediaWhenBackgrounded\(mainWindow\)/);
});
