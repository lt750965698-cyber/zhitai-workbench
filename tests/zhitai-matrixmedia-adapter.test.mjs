import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CREATIVE_STATEMENTS,
  applyMatrixAuthRecords,
  classifyMatrixAuthFailure,
  createMatrixAuthStateStore,
  isMatrixAccountUsable,
  MATRIX_BINARY,
  PLATFORMS,
  buildCliLoginArgs,
  extractJson,
  formatPublishAt,
  isLikelyQrPng,
  matrixAuthAccountFingerprint,
  normalizeAccounts,
  selectReusableLoginSession,
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
  assert.equal(rows[0].authState, "verified");
  assert.equal(rows[0].loggedIn, true);
  assert.equal(rows[0].readyForPublish, true);
});

test("分区 Cookie 元数据只能恢复待验证候选，不能伪装成已登录", () => {
  const [candidate] = normalizeAccounts([{
    platform: "视频号",
    phone: "13800138000",
    partition: "persist:13800138000视频号",
    authSource: "partition_cookie_metadata",
    loginStatus: "已登录",
    loggedIn: false,
    readyForPublish: false,
  }]);
  assert.equal(candidate.authState, "unverified");
  assert.equal(candidate.loginStatus, "待验证");
  assert.equal(candidate.loggedIn, false);
  assert.equal(candidate.readyForPublish, false);
  assert.equal(candidate.publishReady, false);
  assert.equal(isMatrixAccountUsable(candidate), false);

  const [explicit] = normalizeAccounts([{
    platform: "sph",
    phone: "13800138000",
    loggedIn: true,
    reason: "平台实时验证通过",
  }]);
  assert.equal(explicit.authState, "verified");
  assert.equal(explicit.reason, "平台实时验证通过");
  assert.equal(isMatrixAccountUsable(explicit), true);

  assert.equal(isMatrixAccountUsable({
    ...explicit,
    authState: "unverified",
    loginStatus: "已登录",
  }), false, "旧 loginStatus 文本不能绕过显式 readiness");
});

test("持久登录真值只写不可逆标识，认证失败覆盖旧验证且重新登录可恢复", async (t) => {
  const sandbox = await mkdtemp(path.join(tmpdir(), "zhitai-matrix-auth-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const statePath = path.join(sandbox, "matrix-auth.json");
  const store = createMatrixAuthStateStore({ path: statePath, now: () => "2026-08-29T09:00:00.000Z" });
  const account = { phone: "13800138000", partition: "persist:13800138000视频号" };

  const verified = await store.markVerified("sph", account, "cli_login_success");
  assert.equal(verified.authState, "verified");
  assert.match(verified.account, /^auth_[a-f0-9]{32}$/);
  let applied = applyMatrixAuthRecords(normalizeAccounts([{
    platform: "视频号",
    ...account,
    authSource: "partition_cookie_metadata",
  }]), await store.list())[0];
  assert.equal(isMatrixAccountUsable(applied), true);
  assert.equal(isMatrixAccountUsable(normalizeAccounts([applied])[0]), true, "API 二次规范化不能丢失持久验证真值");

  await store.invalidate("sph", account, "sph_login_redirect");
  applied = applyMatrixAuthRecords([applied], await store.list())[0];
  assert.equal(applied.authState, "invalid");
  assert.equal(applied.loginStatus, "登录失效");
  assert.equal(isMatrixAccountUsable(applied), false);

  await store.markVerified("sph", account, "cli_login_success");
  applied = applyMatrixAuthRecords(normalizeAccounts([{
    platform: "视频号",
    ...account,
    authSource: "partition_cookie_metadata",
  }]), await store.list())[0];
  assert.equal(applied.authState, "verified");
  assert.equal(isMatrixAccountUsable(applied), true);

  const disk = await readFile(statePath, "utf8");
  assert.equal(disk.includes("13800138000"), false);
  assert.equal(disk.includes("persist:"), false);
  assert.equal(disk.toLowerCase().includes("cookie"), false);
});

test("视频号实际登录页重定向会被识别，普通内容文字不会误判", () => {
  assert.deepEqual(classifyMatrixAuthFailure({
    platform: "sph",
    code: 3,
    err: "[auth] 视频号登录状态已失效，请重新登录后再试: https://channels.weixin.qq.com/login.html\n登录态异常或未登录",
  }), { invalid: true, reasonCode: "sph_login_redirect" });
  assert.equal(classifyMatrixAuthFailure({
    platform: "sph",
    code: 3,
    err: "上传失败：标题包含‘登录’一词",
  }), null);
  for (const url of [
    "https://evilchannels.weixin.qq.com/login.html",
    "https://channels.weixin.qq.com.evil.example/login.html",
    "http://channels.weixin.qq.com/login.html",
    "https://attacker@channels.weixin.qq.com/login.html",
    "https://channels.weixin.qq.com/login.html.evil",
    "https://channels.weixin.qq.com/login%2ehtml",
  ]) {
    assert.equal(classifyMatrixAuthFailure({
      platform: "sph",
      code: 3,
      err: `上传失败，请重新登录：${url}`,
    }), null, `非官方精确登录地址不得污染账号状态：${url}`);
  }
  assert.deepEqual(classifyMatrixAuthFailure({
    platform: "sph",
    code: 3,
    err: "平台重定向，请重新登录：https://channels.weixin.qq.com/login?from=publish#expired",
  }), { invalid: true, reasonCode: "sph_login_redirect" });
  assert.equal(classifyMatrixAuthFailure({
    platform: "sph",
    code: 0,
    out: "[auth] 视频号登录状态已失效",
  }), null, "成功退出码不能被日志中的偶然文本反向判失效");
});

test("同一平台账号的进行中登录会话必须复用，不重复打开窗口", () => {
  const waiting = { id: "login-1", platform: "sph", phone: "13800138000", status: "waiting_scan" };
  const expired = { id: "login-2", platform: "sph", phone: "13800138000", status: "expired" };
  assert.equal(selectReusableLoginSession([expired, waiting], { platform: "sph", phone: "13800138000" }), waiting);
  assert.equal(selectReusableLoginSession([waiting], { platform: "dy", phone: "13800138000" }), null);
  assert.equal(selectReusableLoginSession([expired], { platform: "sph", phone: "13800138000" }), null);
});

test("登录真值账号指纹跨 phone/partition 表达保持一致", () => {
  assert.equal(
    matrixAuthAccountFingerprint("sph", { phone: "13800138000" }),
    matrixAuthAccountFingerprint("视频号", { partition: "persist:13800138000视频号" }),
  );
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
  assert.match(
    serverSrc,
    /resolveScheduledMatrixAccount[\s\S]*?error\.beforeExternalCall\s*=\s*true/,
    "账号解析失败必须明确标记为平台调用前错误，供调度器安全重试",
  );
});

test("发布中心区分二维码安全手机发送与视频号官方登录窗口", () => {
  assert.ok(pubSrc.includes("生成登录二维码"));
  assert.ok(pubSrc.includes("打开登录窗口"));
  assert.ok(pubSrc.includes("login.qrAvailable"));
  assert.ok(!pubSrc.includes("login.qrData"));
  assert.ok(!pubSrc.includes("openMatrixMedia"));
  assert.ok(!pubSrc.includes("30088"));
});

test("发布登录 HTTP 投影不返回手机号、二维码内容或本机路径", () => {
  const publicProjection = adapterSrc.match(/export async function getCliLogin\(id\)[\s\S]*?\n}\n\n\/\*\*/)?.[0] || "";
  assert.ok(publicProjection.includes("qrAvailable"));
  assert.doesNotMatch(publicProjection, /qrData|qrBuffer|qrPath|phone|account:/);
  assert.match(serverSrc, /publisher\/login[\s\S]*?guardJsonWrite/);
});
