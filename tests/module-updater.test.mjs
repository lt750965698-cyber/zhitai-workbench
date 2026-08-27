import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  assertTrustedGithubUrl,
  chooseReleaseAsset,
  requireSha256,
} from "../local-agent/module-updater.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const updaterSource = fs.readFileSync(path.resolve(here, "../local-agent/module-updater.mjs"), "utf8");
const serverSource = fs.readFileSync(path.resolve(here, "../local-agent/server.mjs"), "utf8");
const uiSource = fs.readFileSync(path.resolve(here, "../app/ContentWorkbench.tsx"), "utf8");
const launcherSource = fs.readFileSync(path.resolve(here, "../desktop/launcher.js"), "utf8");
const analyzerSource = fs.readFileSync(path.resolve(here, "../scripts/video-analysis-server.mjs"), "utf8");

test("按架构选择 MatrixMedia 官方 macOS 安装包", () => {
  const release = { assets: [
    { name: "MatrixMedia-0.11.2-mac-x64.dmg", browser_download_url: "x64" },
    { name: "MatrixMedia-0.11.2-mac-arm64.dmg", browser_download_url: "arm64" },
  ] };
  assert.equal(chooseReleaseAsset("matrixmedia", release, "arm64").browser_download_url, "arm64");
  assert.equal(chooseReleaseAsset("matrixmedia", release, "x64").browser_download_url, "x64");
  assert.ok(updaterSource.includes('run("/usr/bin/ditto"'));
  assert.ok(updaterSource.includes("frameworkLink.startsWith"));
  assert.ok(updaterSource.includes("在最终路径再跑一次"));
});

test("闲鱼客服只接受官方 update_files.json 热更新清单", () => {
  const release = { assets: [{ name: "source.zip" }, { name: "update_files.json", browser_download_url: "manifest" }] };
  assert.equal(chooseReleaseAsset("xianyu-auto-reply", release).browser_download_url, "manifest");
});

test("模块更新 URL 绑定精确 GitHub 仓库、Release tag 与文件路径", () => {
  const releasePolicy = {
    kind: "release-asset",
    repo: "GuDong2003/xianyu-auto-reply-fix",
    tag: "v2.0.7",
    assetName: "update_files.json",
  };
  assert.equal(
    assertTrustedGithubUrl(
      "https://github.com/GuDong2003/xianyu-auto-reply-fix/releases/download/v2.0.7/update_files.json",
      releasePolicy,
    ).hostname,
    "github.com",
  );
  assert.equal(
    assertTrustedGithubUrl("https://release-assets.githubusercontent.com/github-production-release-asset/123", releasePolicy, true).hostname,
    "release-assets.githubusercontent.com",
  );
  for (const malicious of [
    "https://github.com.evil.example/GuDong2003/xianyu-auto-reply-fix/releases/download/v2.0.7/update_files.json",
    "https://github.com/GuDong2003/xianyu-auto-reply-fix/releases/download/v2.0.8/update_files.json",
    "https://attacker@github.com/GuDong2003/xianyu-auto-reply-fix/releases/download/v2.0.7/update_files.json",
    "https://github.com/GuDong2003/xianyu-auto-reply-fix/releases/download/v2.0.7/update_files.json?redirect=evil",
  ]) {
    assert.throws(() => assertTrustedGithubUrl(malicious, releasePolicy), /Release|地址/);
  }

  const rawPolicy = {
    kind: "raw-file",
    repo: "GuDong2003/xianyu-auto-reply-fix",
    tag: "v2.0.7",
    relativePath: "static/js/app.js",
  };
  assert.equal(
    assertTrustedGithubUrl(
      "https://raw.githubusercontent.com/GuDong2003/xianyu-auto-reply-fix/v2.0.7/static/js/app.js",
      rawPolicy,
    ).hostname,
    "raw.githubusercontent.com",
  );
  assert.throws(
    () => assertTrustedGithubUrl(
      "https://raw.githubusercontent.com.evil.example/GuDong2003/xianyu-auto-reply-fix/v2.0.7/static/js/app.js",
      rawPolicy,
    ),
    /热更新文件地址/,
  );
  assert.throws(
    () => assertTrustedGithubUrl(
      "https://raw.githubusercontent.com/GuDong2003/xianyu-auto-reply-fix/v2.0.7/static/js/other.js",
      rawPolicy,
    ),
    /热更新文件地址/,
  );
});

test("所有可执行 Release 资源必须提供 SHA-256", () => {
  const digest = "a".repeat(64);
  assert.equal(requireSha256(`sha256:${digest}`), digest);
  assert.equal(requireSha256(digest.toUpperCase()), digest);
  assert.throws(() => requireSha256("18dd85e369e51f6685e488a81765dfcb"), /SHA-256/);
  assert.throws(() => requireSha256(""), /SHA-256/);
  assert.ok(!updaterSource.includes('createHash("md5")'));
  assert.match(updaterSource, /sha256:\s*item\?\.sha256/);
});

test("模块更新有确认路由、旁路目录、备份和失败回滚边界", () => {
  assert.ok(serverSource.includes("moduleInstallMatch"));
  assert.ok(serverSource.includes("installModuleUpdate"));
  assert.ok(updaterSource.includes('join(RUNTIME_ROOT, "updates")'));
  assert.ok(updaterSource.includes('join(RUNTIME_ROOT, "backups")'));
  assert.ok(updaterSource.includes("当前版本未切换") || uiSource.includes("当前版本未切换"));
  assert.ok(uiSource.includes("直接更新到"));
  assert.ok(uiSource.includes("X-Zhitai-Action"));
  assert.ok(updaterSource.includes('"package-lock.json"'));
  assert.ok(updaterSource.includes('"ci", "--ignore-scripts"'));
  assert.ok(updaterSource.includes("fallbackRelease"));
  assert.ok(updaterSource.includes("cleanupModuleWorkspaces"));
  assert.ok(serverSource.includes("GitHub API 限额时回退"));
});

test("可切换模块通过稳定别名启动，不把版本号写死在运行入口", () => {
  assert.ok(launcherSource.includes("wechat-mp-tools-current"));
  assert.ok(analyzerSource.includes("mcp-video-analyzer-current"));
  assert.ok(!launcherSource.includes("wechat-mp-tools-v1.8.1"));
  assert.ok(analyzerSource.includes('PATH: `${FFMPEG_DIR}:${process.env.PATH || ""}`'));
  assert.ok(analyzerSource.includes('FFMPEG_BIN: path.join(FFMPEG_DIR, "ffmpeg")'));
});
