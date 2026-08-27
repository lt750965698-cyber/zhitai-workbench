import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CREATIVE_STATEMENTS,
  MATRIX_BINARY,
  PLATFORMS,
  buildCliLoginArgs,
  extractJson,
  formatPublishAt,
  isLikelyQrPng,
  normalizeAccounts,
  sessionAccountFromPartitionName,
  normalizeChannelsShortTitle,
} from "../local-agent/matrixmedia-adapter.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const adapterSrc = fs.readFileSync(path.resolve(here, "../local-agent/matrixmedia-adapter.mjs"), "utf8");
const serverSrc = fs.readFileSync(path.resolve(here, "../local-agent/server.mjs"), "utf8");
const pubSrc = fs.readFileSync(path.resolve(here, "../app/PublishNative.tsx"), "utf8");

test("MatrixMedia 使用本机私有 runtime 中的受管外置引擎，不依赖 GUI 或 30088", () => {
  assert.match(MATRIX_BINARY, /\.local\/share\/zhitai-runtime\/engines\/matrixmedia\.app/);
  assert.ok(!adapterSrc.includes("127.0.0.1:30088"));
  assert.doesNotMatch(adapterSrc, /\/Users\/[A-Za-z0-9._-]+\//, "不得嵌入开发者主目录");
  assert.ok(adapterSrc.includes('["publish", "-p"'));
  assert.ok(adapterSrc.includes('"--save-qr-png"'));
});

test("抖音使用内嵌二维码，视频号使用官方可交互登录窗口", () => {
  for (const platform of ["dy", "sph"]) {
    const args = buildCliLoginArgs({ platform, phone: "账号一", qrPath: "/tmp/qr.png", timeoutSec: 30 });
    assert.deepEqual(args.slice(0, 5), ["cli", "login", "-p", platform, "--phone"]);
    assert.ok(args.includes("--save-qr-png"));
    assert.ok(!args.includes("--no-terminal-qr"), "关闭默认二维码会被 MatrixMedia 以退出码 2 拒绝");
    assert.ok(!args.includes("--puppeteer-headless"), "视频号不支持 Puppeteer 无头登录");
  }
  assert.ok(buildCliLoginArgs({ platform: "dy", phone: "13800138000", qrPath: "/tmp/dy.png" }).includes("--hide"));
  assert.ok(!buildCliLoginArgs({ platform: "dy", phone: "13800138000", qrPath: "/tmp/dy.png" }).includes("--show"));
  assert.ok(buildCliLoginArgs({ platform: "sph", phone: "13800138000", qrPath: "/tmp/sph.png" }).includes("--show"));
  assert.ok(!buildCliLoginArgs({ platform: "sph", phone: "13800138000", qrPath: "/tmp/sph.png" }).includes("--hide"));
  assert.ok(adapterSrc.includes('PTY_WRAPPER = "/usr/bin/script"'));
  assert.ok(adapterSrc.includes('["-q", "/dev/null", MATRIX_BINARY, ...args]'));
});

test("视频号整页截图不再被当成二维码", () => {
  const png = (width, height) => {
    const buffer = Buffer.alloc(24);
    buffer.write("PNG", 1, "ascii");
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    return buffer;
  };
  assert.equal(isLikelyQrPng(png(320, 320)), true);
  assert.equal(isLikelyQrPng(png(1200, 772)), false);
  assert.equal(isLikelyQrPng(png(40, 40)), false);
});

test("视频号短标题会移除标点并收敛到 6～16 字", () => {
  assert.equal(normalizeChannelsShortTitle("把睡眠、学习、衣柜和楼梯收纳装进一间儿童房。"), "把睡眠学习衣柜和楼梯收纳装进一间");
  assert.equal(normalizeChannelsShortTitle("儿童房收纳设计"), "儿童房收纳设计");
  assert.equal(normalizeChannelsShortTitle("收纳"), null);
});

test("extractJson 可从 CLI 日志和多行 JSON 中提取数组", () => {
  assert.deepEqual(extractJson("[startup] ready\n[]\n[startup] done"), []);
  assert.deepEqual(extractJson("log\n[\n {\"id\":1}\n]\nend"), [{ id: 1 }]);
  assert.equal(extractJson(""), null);
});

test("extractJson 不会把 JSON 后续 startup 日志的右括号当成数组结尾", () => {
  const output = [
    "0.11.0 -------",
    "[startup] Electron app ready",
    "[",
    "  {",
    "    \"id\": \"schedule-1\",",
    "    \"status\": \"scheduled\"",
    "  }",
    "]",
    "[startup] CLI 执行结束，退出码=0",
  ].join("\n");
  assert.deepEqual(extractJson(output), [{ id: "schedule-1", status: "scheduled" }]);
});

test("平台与创作声明由织台直接提供", () => {
  assert.equal(PLATFORMS.length, 8);
  assert.ok(PLATFORMS.some((item) => item.code === "dy"));
  assert.ok(CREATIVE_STATEMENTS.some((item) => item.value === "ai_generated"));
});

test("formatPublishAt 与账号规范化保持官方契约", () => {
  assert.match(formatPublishAt("2026-08-12T12:00:00.000Z"), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(formatPublishAt("bad"), null);
  const rows = normalizeAccounts([{ platform: "dy", phone: "13800138000", loginStatus: "online" }]);
  assert.equal(rows[0].phone, "13800138000");
});

test("纯 CLI 登录分区可恢复为发布账号，不把测试分区混入列表", () => {
  assert.deepEqual(sessionAccountFromPartitionName("18657970612%E6%8A%96%E9%9F%B3"), {
    suffix: "抖音", code: "dy", platform: "抖音", cookie: "passport_assist_user",
    phone: "18657970612", partition: "persist:18657970612抖音",
  });
  assert.equal(sessionAccountFromPartitionName("fixture%E6%8A%96%E9%9F%B3"), null);
  assert.equal(sessionAccountFromPartitionName("18657970612%E8%A7%86%E9%A2%91%E5%8F%B7")?.platform, "视频号");
});

test("server 的账号、登录、历史与发布均走本机受管 CLI", () => {
  for (const route of ["/api/v1/publisher/accounts", "/api/v1/publisher/history", "/api/v1/publisher/login", "/api/v1/publish"]) {
    assert.ok(serverSrc.includes(route), `缺少 ${route}`);
  }
  assert.ok(serverSrc.includes("matrix.publishWithReceipts({"));
  assert.ok(!serverSrc.includes("matrix.httpPublish(payload)"));
});

test("发布中心区分内嵌二维码与视频号官方登录窗口", () => {
  assert.ok(pubSrc.includes("生成登录二维码"));
  assert.ok(pubSrc.includes("打开登录窗口"));
  assert.ok(pubSrc.includes("login.qrData"));
  assert.ok(!pubSrc.includes("openMatrixMedia"));
  assert.ok(!pubSrc.includes("30088"));
});
