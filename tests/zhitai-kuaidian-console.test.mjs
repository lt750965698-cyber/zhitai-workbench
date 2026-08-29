/**
 * zhitai-kuaidian-console.test.mjs — 快点下载控制台 V1 聚焦无副作用测试。
 *
 * 覆盖：
 *  1) companion 纯函数（脚本提取）：collectReports（含 spD.u base64 回退）、resolveSpdU、
 *     isTerminalStatus/isReportedSuccess、pollUntilTerminal（注入假 fetchStatus 序列：
 *     success → reported；failed → 不 reported；持续 processing → 超时 needs attention）；
 *     源码断言 REPORTED_KEY 仅由 isReportedSuccess 写、heartbeat 负载绝不含 cookie/downloadUrl。
 *  2) server：heartbeat TTL 在线→离线→在线（ZHITAI_KUAIDIAN_TTL_MS=400）；/api/v1/kuaidian/status 五状态。
 *  3) server：/api/v1/kuaidian/jobs 聚合（全中文状态 + legacy 与 kb 按 canonical sourceUrl 去重）。
 *  4) server：诚实 retry —— local_retry（本地路径走既有 import retry 端点）、companion_resupply
 *     （离线 → 409 中文原因；在线 → 202 排队 + commands 轮询 + ack）。
 *  5) 前端/Edge 打开器：源码断言（控制台/过滤器/详情/重试按钮/显式 Microsoft Edge，不用默认浏览器）。
 *
 * 使用临时数据目录与 mock 环境，绝不触碰真实知识库/真实下载/真实浏览器打开。
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createNetServer } from "node:net";
import test from "node:test";
import assert from "node:assert/strict";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_ENTRY = join(repoRoot, "local-agent", "server.mjs");
const COMPANION_PATH = join(repoRoot, "local-agent", "zhitai-kuaidian-companion.user.js");
const WORKBENCH_PATH = join(repoRoot, "app", "ContentWorkbench.tsx");
const SERVER_PATH = join(repoRoot, "local-agent", "server.mjs");

let serverProcess;
let base = "";
let dataDir = "";
let configPath = "";
let serverErr = "";

function reservePort() {
  return new Promise((resolvePromise, reject) => {
    const net = createNetServer();
    net.listen(0, "127.0.0.1", () => {
      const port = net.address().port;
      net.close(() => resolvePromise(port));
    });
    net.on("error", reject);
  });
}

function request(path, { method = "GET", headers = {}, body } = {}) {
  return fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function waitForHealth(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`);
      if (res.ok) return;
    } catch { /* 尚未就绪 */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`本地节点未在 ${timeoutMs}ms 内就绪；stderr=${serverErr.slice(-500)}`);
}

async function openTestDb() {
  const { openKbDb } = await import("../local-agent/kb.mjs");
  return openKbDb(join(dataDir, "kb.sqlite"));
}

/** 注入一条 import_item（含 batch），用于 jobs 聚合与 retry 测试 */
async function injectItem(status, fields = {}) {
  const db = await openTestDb();
  const iso = new Date().toISOString();
  const batchId = `kb_console_${Math.random().toString(16).slice(2, 8)}`;
  if (fields.assetId) {
    db.prepare("INSERT OR IGNORE INTO video_asset (id, sha256, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(fields.assetId, `console_sha_${fields.assetId}_${Date.now()}`, `console-${fields.assetId}`, iso, iso);
  }
  db.prepare("INSERT INTO import_batch (id, status, source_kind, created_at, total, succeeded, failed, skipped) VALUES (?,?,?,?,1,0,0,0)")
    .run(batchId, "done", fields.sourceKind || "kuaidian", iso);
  const id = db.prepare(
    "INSERT INTO import_item (batch_id, input, input_kind, display_input, delivery_id, status, error, retry_count, asset_id, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  ).run(batchId, fields.input || null, fields.inputKind || "kuaidian", fields.display || "console-item", fields.deliveryId || null,
    status, fields.error || null, fields.retryCount || 0, fields.assetId || null, iso).lastInsertRowid;
  db.close();
  return { id, batchId };
}

/** 提取 companion 脚本纯函数（同 kb-v2a 模式：注入 no-op 定时器避免挂起） */
async function loadCompanionFns() {
  const code = await readFile(COMPANION_PATH, "utf8");
  const src = code.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/m, "");
  const windowObj = {};
  const store = {};
  const ctx = { data: store };
  const localStorage = { getItem: (k) => ctx.data[k] ?? null, setItem: (k, v) => { ctx.data[k] = v; } };
  const GM_getValue = (k, d) => ctx.data[k] ?? d;
  const GM_setValue = (k, v) => { ctx.data[k] = v; };
  const GM_xmlhttpRequest = () => {};
  const documentStub = { createElement: () => ({ getElementsByTagName: () => [] }), documentElement: {} };
  class DOMParserStub {
    parseFromString(input) {
      return { getElementsByTagName: (tag) => {
        if (tag !== "url") return [];
        const re = /<url[^>]*>([\s\S]*?)<\/url>/g;
        const out = [];
        let m;
        while ((m = re.exec(input)) !== null) out.push({ textContent: m[1].replace(/^.*:/, "https:") });
        return out;
      } };
    }
  }
  const fn = new Function("window", "document", "localStorage", "GM_getValue", "GM_setValue", "GM_xmlhttpRequest", "DOMParser", "setTimeout", "setInterval", src);
  fn(windowObj, documentStub, localStorage, GM_getValue, GM_setValue, GM_xmlhttpRequest, DOMParserStub, () => 0, () => 0);
  return windowObj.__zhitaiCompanion;
}

test.before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "zhitai-kuaidian-console-"));
  const kbRoot = join(dataDir, "kb");
  await mkdir(kbRoot, { recursive: true });
  configPath = join(dataDir, "config.json");
  await writeFile(configPath, JSON.stringify({
    host: "127.0.0.1",
    port: 17890,
    knowledgeBase: kbRoot,
    allowedOrigins: ["http://localhost:3000"],
    webhookSecret: "",
    polling: { intervalMs: 250, timeoutMs: 5000 },
    watcher: { intervalMs: 5000, roots: [] },
    adapters: {},
    services: {},
    mediaFallback: { enabled: false },
  }, null, 2));
  const port = await reservePort();
  serverProcess = spawn(process.execPath, [AGENT_ENTRY], {
    env: {
      ...process.env,
      ZHITAI_CONFIG_PATH: configPath,
      ZHITAI_DATA_DIR: dataDir,
      ZHITAI_PORT: String(port),
      ZHITAI_KUAIDIAN_TTL_MS: "400",
      ZHITAI_DISABLE_PUBLISHER_LOGIN_RECOVERY: "1",
      ZHITAI_MATRIX_PARTITIONS_DIR: join(dataDir, "matrix-partitions"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  serverProcess.stderr.on("data", (d) => { serverErr += d.toString(); });
  base = `http://127.0.0.1:${port}`;
  await waitForHealth();
});

test.after(() => {
  if (serverProcess) serverProcess.kill("SIGTERM");
});

/* ─────────── 1) companion 纯函数与状态机 ─────────── */
test("companion：collectReports 增量 + spD.u base64 回退 + resolveSpD.u 白名单", async () => {
  const c = await loadCompanionFns();
  // C XML 有稳定 url → 优先生效
  const okd = [{ d: "视频1", m: "msgA", u: "https://finder.video.qq.com/251/x?encfilekey=K&token=T" }];
  const spD = [{ m: "msgA", C: "<xml><url>https://weixin.qq.com/sph/real_share_1</url></xml>" }];
  const reports = c.collectReports(JSON.stringify(okd), JSON.stringify(spD), []);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].sourceUrl, "https://weixin.qq.com/sph/real_share_1");
  assert.equal(reports[0].deliveryId, "msgA");
  // C 无 url 且 spD.u 为 base64 稳定分享 → 回退生效
  const okd2 = [{ d: "视频2", m: "msgB", u: "https://finder.video.qq.com/251/y" }];
  const spD2 = [{ m: "msgB", C: "<xml><desc>无链接</desc></xml>", u: Buffer.from("https://weixin.qq.com/sph/spd_fallback_1").toString("base64") }];
  const reports2 = c.collectReports(JSON.stringify(okd2), JSON.stringify(spD2), []);
  assert.equal(reports2.length, 1);
  assert.equal(reports2[0].sourceUrl, "https://weixin.qq.com/sph/spd_fallback_1");
  // C 无 url、spD.u 非白名单 → null（绝不用直链冒充）
  const okd3 = [{ d: "视频3", m: "msgC", u: "https://finder.video.qq.com/251/z" }];
  const spD3 = [{ m: "msgC", C: "<xml>无</xml>", u: Buffer.from("https://dl.example.com/private/x.mp4").toString("base64") }];
  const reports3 = c.collectReports(JSON.stringify(okd3), JSON.stringify(spD3), []);
  assert.equal(reports3.length, 1);
  assert.equal(reports3[0].sourceUrl, null);
  // resolveSpdU 直接测
  assert.equal(c.resolveSpdU({ u: "https://weixin.qq.com/sph/direct_1" }), "https://weixin.qq.com/sph/direct_1");
  assert.equal(c.resolveSpdU({ u: "https://finder.video.qq.com/direct" }), null);
  assert.equal(c.resolveSpdU({ u: "not-base64!!" }), null);
  assert.equal(c.resolveSpdU(null), null);
  // 增量：已上报不再上报
  const reports4 = c.collectReports(JSON.stringify(okd), JSON.stringify(spD), ["msgA"]);
  assert.equal(reports4.length, 0);

  // 原版快点 1.3.0 当前链路曾把 a.m 误写成 a.MsgId，JSON 中会缺失 m；
  // companion 应按相同标题与转发顺序补回 MsgId，让已有解析结果也能入库。
  const legacyOkd = [
    { d: "重复标题", u: "https://finder.video.qq.com/251/legacy-1" },
    { d: "重复标题", u: "https://finder.video.qq.com/251/legacy-2" },
  ];
  const legacySpd = [
    { d: "重复标题", m: "legacy-msg-1", C: "<xml><url>https://weixin.qq.com/sph/legacy_1</url></xml>" },
    { d: "重复标题", m: "legacy-msg-2", C: "<xml><url>https://weixin.qq.com/sph/legacy_2</url></xml>" },
  ];
  const repaired = c.collectReports(JSON.stringify(legacyOkd), JSON.stringify(legacySpd), []);
  assert.deepEqual(repaired.map((x) => x.deliveryId), ["legacy-msg-1", "legacy-msg-2"]);
  assert.deepEqual(repaired.map((x) => x.sourceUrl), [
    "https://weixin.qq.com/sph/legacy_1",
    "https://weixin.qq.com/sph/legacy_2",
  ]);

  // 心跳给出可读的链路计数，区分“已转发”与“已拿到直连”。
  const oldStorage = c;
  assert.ok(oldStorage.getStorageSummary, "应暴露安全的存储计数摘要");
});

test("companion：终态/reported 判定与有界轮询（success→reported；failed→不；超时→needs attention）", async () => {
  const c = await loadCompanionFns();
  for (const s of ["success", "duplicate", "linked"]) {
    assert.equal(c.isTerminalStatus(s), true);
    assert.equal(c.isReportedSuccess(s), true);
  }
  for (const s of ["failed", "partial", "orphaned"]) {
    assert.equal(c.isTerminalStatus(s), true);
    assert.equal(c.isReportedSuccess(s), false);
  }
  for (const s of ["processing", "pending", "awaiting_primary_download"]) {
    assert.equal(c.isTerminalStatus(s), false);
  }
  // 轮询到 success → terminal 且 reported（注入可控同步调度；bootstrap 定时器保持 no-op）
  const syncSchedule = (fn) => fn();
  let statusSeq = ["processing", "processing", "success"];
  const pollOk = c.pollUntilTerminal((cb) => cb({ status: statusSeq.shift(), itemId: 7 }), { maxTries: 10, delay: 1, scheduler: syncSchedule });
  const r1 = await new Promise((resolvePromise) => pollOk.run(resolvePromise));
  assert.equal(r1.terminal, true);
  assert.equal(r1.status, "success");
  // 轮询到 failed → terminal 但不 reported
  let seqFail = ["processing", "failed"];
  const pollFail = c.pollUntilTerminal((cb) => cb({ status: seqFail.shift(), itemId: 8 }), { maxTries: 10, delay: 1, scheduler: syncSchedule });
  const r2 = await new Promise((resolvePromise) => pollFail.run(resolvePromise));
  assert.equal(r2.terminal, true);
  assert.equal(r2.status, "failed");
  assert.equal(c.isReportedSuccess(r2.status), false);
  // 一直 processing → 超时 → needs attention（不 reported）
  const pollTimeout = c.pollUntilTerminal((cb) => cb({ status: "processing", itemId: 9 }), { maxTries: 3, delay: 1, scheduler: syncSchedule });
  const r3 = await new Promise((resolvePromise) => pollTimeout.run(resolvePromise));
  assert.equal(r3.terminal, false);
  assert.equal(r3.timedOut, true);
});

test("companion：源码契约 —— REPORTED_KEY 仅在成功系写入；heartbeat 负载绝不含 cookie/downloadUrl", async () => {
  const code = await readFile(COMPANION_PATH, "utf8");
  assert.ok(!code.includes("alert("), "companion 不得 patch alert");
  assert.ok(code.includes("filehelper.weixin.qq.com"), "只匹配 filehelper");
  // reported 写入必须经过 isReportedSuccess 判定
  const reportBlock = code.slice(code.indexOf("result && result.reported"), code.indexOf("// 失败/超时"));
  assert.ok(reportBlock.includes("GM_setValue(REPORTED_KEY"), "reported 写入存在");
  // heartbeat 负载键白名单：绝不含 cookie/downloadUrl
  const heartbeatStart = code.indexOf("data: JSON.stringify({\n          version: VERSION,");
  const heartbeatBlock = code.slice(heartbeatStart, heartbeatStart + 420);
  assert.ok(heartbeatBlock.includes("version") && heartbeatBlock.includes("pageKind")
    && heartbeatBlock.includes("wechatLoggedIn") && heartbeatBlock.includes("originalKuaidianDetected") && heartbeatBlock.includes("pendingReportCount")
    && heartbeatBlock.includes("lastResult"), "heartbeat 负载为安全字段白名单");
  assert.ok(!heartbeatBlock.includes("cookie") && !heartbeatBlock.includes("downloadUrl"), "heartbeat 不含 cookie/下载 URL");
});

/* ─────────── 2) heartbeat TTL：在线 → 离线 → 在线 ─────────── */
test("heartbeat：TTL 内在线五状态，超时转离线，再心跳恢复", async () => {
  const beat = await request("/api/v1/kuaidian/heartbeat", {
    method: "POST",
    body: { version: "0.2.0", pageKind: "filehelper", wechatLoggedIn: true, originalKuaidianDetected: true, pendingReportCount: 2, lastResult: "ok" },
  });
  assert.equal(beat.status, 202);
  const online = await (await request("/api/v1/kuaidian/status")).json();
  assert.equal(online.states.localNode, true);
  assert.equal(online.states.companionOnline, true);
  assert.equal(online.states.filehelperPageConnected, true);
  assert.equal(online.states.wechatLoggedIn, true);
  assert.equal(online.states.originalKuaidianDetected, true);
  assert.ok(online.lastSeen, "lastSeen 存在");
  assert.equal(online.companion.version, "0.2.0");
  assert.equal(online.companion.pendingReportCount, 2);
  // 等 TTL(400ms) 过后 → 离线
  await new Promise((r) => setTimeout(r, 700));
  const offline = await (await request("/api/v1/kuaidian/status")).json();
  assert.equal(offline.states.companionOnline, false);
  assert.equal(offline.states.wechatLoggedIn, false);
  assert.equal(offline.states.originalKuaidianDetected, false);
  assert.equal(offline.lastSeen, null, "离线时 lastSeen 为 null（诚实）");
  // 再心跳 → 恢复
  await request("/api/v1/kuaidian/heartbeat", { method: "POST", body: { pageKind: "filehelper", originalKuaidianDetected: false } });
  const back = await (await request("/api/v1/kuaidian/status")).json();
  assert.equal(back.states.companionOnline, true);
  assert.equal(back.states.filehelperPageConnected, true);
  assert.equal(back.states.wechatLoggedIn, false, "网页在线不等于微信已登录");
  assert.equal(back.states.originalKuaidianDetected, false, "原版快点未检测则诚实为 false");
});

/* ─────────── 3) jobs 聚合：全中文状态 + legacy 去重 ─────────── */
test("jobs：全部状态中文 displayStatus + legacy 与 kb 按 canonical 去重", async () => {
  await injectItem("success", { assetId: "ast_s", input: "https://weixin.qq.com/sph/job_s", display: "https://weixin.qq.com/sph/job_s" });
  await injectItem("duplicate", { assetId: "ast_d", input: "https://weixin.qq.com/sph/job_d" });
  await injectItem("linked", { assetId: "ast_l", input: "https://weixin.qq.com/sph/job_l" });
  await injectItem("failed", { error: "failed_primary: failed_no_fallback_configured: 测试失败", input: "/tmp/console-missing.mp4" });
  await injectItem("partial", { error: "media_validation:encrypted" });
  await injectItem("orphaned", { error: "orphaned" });
  await injectItem("processing", {});
  await injectItem("pending", { error: "awaiting_primary_download: 分享链接需原版快点解析" });
  await injectItem("pending", { error: "awaiting_fallback_media: 慢点/TikHub 未接入" });
  // legacy tasks：与 kb 同 canonical → 去重；独立 legacy → 保留
  const legacyTasks = [
    { id: "legacy_dup", type: "ingest", status: "completed", title: "旧任务(去重)", sourceUrl: "https://weixin.qq.com/sph/job_s" },
    { id: "ing_legacy-keep", type: "ingest", status: "failed", title: "旧任务(保留)", reason: "历史失败", cardObjectId: "object-legacy", cardNonceId: "nonce-legacy" },
  ];
  await writeFile(join(dataDir, "tasks.json"), JSON.stringify(legacyTasks, null, 2));
  const res = await (await request("/api/v1/kuaidian/jobs")).json();
  assert.equal(res.ok, true);
  const jobs = res.jobs;
  assert.ok(jobs.some((j) => j.status === "success" && j.displayStatus === "已完成"), "success→已完成");
  assert.ok(jobs.some((j) => j.status === "duplicate" && j.displayStatus === "已存在（重复）"), "duplicate→已存在（重复）");
  assert.ok(jobs.some((j) => j.status === "linked" && j.displayStatus === "已关联"), "linked→已关联");
  assert.ok(jobs.some((j) => j.status === "failed" && j.displayStatus === "失败"), "failed→失败");
  assert.ok(jobs.some((j) => j.status === "partial" && j.displayStatus === "部分成功（加密/探测失败）"), "partial→部分成功");
  assert.ok(jobs.some((j) => j.status === "orphaned" && j.displayStatus === "孤立"), "orphaned→孤立");
  assert.ok(jobs.some((j) => j.status === "processing" && j.displayStatus === "处理中"), "processing→处理中");
  assert.ok(jobs.some((j) => j.status === "pending" && j.errorDisplay?.startsWith("awaiting_primary_download") && j.displayStatus === "等待快点主下载"), "pending+awaiting_primary→等待快点主下载");
  assert.ok(jobs.some((j) => j.status === "pending" && j.errorDisplay?.startsWith("awaiting_fallback_media") && j.displayStatus === "等待媒体回退"), "pending+awaiting_fallback→等待媒体回退");
  // 字段齐备
  const anyJob = jobs.find((j) => j.source === "kb");
  assert.ok(anyJob && typeof anyJob.id === "string" && "title" in anyJob && "updatedAt" in anyJob
    && "retryCount" in anyJob && "assetId" in anyJob && "errorDisplay" in anyJob && "retryMode" in anyJob, "job 字段齐备");
  // 去重：legacy_dup 因与 kb job_s 同 canonical 被去重；legacy_keep 保留
  assert.ok(!jobs.some((j) => j.id === "legacy:legacy_dup"), "同 canonical 的 legacy 条目被去重");
  assert.ok(jobs.some((j) => j.id === "legacy:ing_legacy-keep" && j.title === "旧任务(保留)" && j.legacyTaskId === "ing_legacy-keep" && j.retryMode === "legacy_retry"), "未覆盖的 legacy 历史失败任务应可受控重试");
  // counts
  assert.equal(res.counts.completed, jobs.filter((j) => ["success", "duplicate", "linked", "completed"].includes(j.status)).length);
  assert.equal(res.counts.needsAttention, jobs.filter((j) => ["failed", "partial", "orphaned", "needs_attention", "recovered_stale_processing"].includes(j.status)).length);
});

/* ─────────── 4) 诚实 retry：local_retry 与 companion_resupply ─────────── */
test("retry：本地路径 → local_retry（既有 import retry 端点）；稳定 URL 离线 → 409 中文；在线 → 排队重供 + 命令 + ack", async () => {
  // local_retry：本地缺失文件 → 走 import retry 端点（202 唯一 owner，worker 快速失败）
  const localItem = await injectItem("failed", { input: join(tmpdir(), "console-missing-xyz.mp4"), display: "console-missing-xyz.mp4" });
  const localRes = await request(`/api/v1/kuaidian/jobs/${localItem.id}/retry`, { method: "POST", body: {} });
  assert.equal(localRes.status, 202, "local_retry 202（既有 retry 端点语义）");
  const localBody = await localRes.json();
  assert.equal(localBody.retryMode, "local_retry", "local_retry 模式返回");
  // companion_resupply：稳定 URL + 无伴生桥 → 409 中文原因
  const shareItem = await injectItem("failed", { input: "https://weixin.qq.com/sph/retry_x", display: "https://weixin.qq.com/sph/retry_x" });
  const offRes = await request(`/api/v1/kuaidian/jobs/${shareItem.id}/retry`, { method: "POST", body: {} });
  assert.equal(offRes.status, 409, "离线不可重供");
  const offBody = await offRes.json();
  assert.equal(offBody.error, "resupply_offline");
  assert.ok(String(offBody.reasonZh).includes("原版快点"), "中文不可恢复原因");
  // 伴生桥 + 原版快点在线，但 item 无 deliveryId → 409 resupply_unavailable 中文（绝不排队成幽灵命令）
  await request("/api/v1/kuaidian/heartbeat", { method: "POST", body: { pageKind: "filehelper", wechatLoggedIn: true, originalKuaidianDetected: true } });
  const noDeliverRes = await request(`/api/v1/kuaidian/jobs/${shareItem.id}/retry`, { method: "POST", body: {} });
  assert.equal(noDeliverRes.status, 409, "无 deliveryId 不可重供");
  const noDeliverBody = await noDeliverRes.json();
  assert.equal(noDeliverBody.error, "resupply_unavailable");
  assert.ok(String(noDeliverBody.reasonZh).includes("投递标识"), "中文原因含投递标识");
  // 带 deliveryId 的稳定 URL failed item + 在线 → 202 排队
  const shareItem2 = await injectItem("failed", { input: "https://weixin.qq.com/sph/retry_y", display: "https://weixin.qq.com/sph/retry_y", deliveryId: "msg_retry_y" });
  const onRes = await request(`/api/v1/kuaidian/jobs/${shareItem2.id}/retry`, { method: "POST", body: {} });
  assert.equal(onRes.status, 202, "在线排队重供");
  const onBody = await onRes.json();
  assert.equal(onBody.retryMode, "companion_resupply");
  assert.equal(onBody.queued, true);
  assert.ok(onBody.commandId, "返回 commandId");
  // 命令轮询（只含 id/itemId/deliveryId）
  const cmds = await (await request("/api/v1/kuaidian/commands")).json();
  const mine = cmds.commands.find((c) => c.id === onBody.commandId);
  assert.ok(mine, "命令在队列中");
  assert.equal(mine.itemId, shareItem2.id);
  assert.equal(mine.deliveryId, "msg_retry_y");
  assert.ok(!JSON.stringify(mine).includes("downloadUrl"), "命令不含下载 URL");
  // ack success → 队列移除
  const ack = await request(`/api/v1/kuaidian/commands/${onBody.commandId}/ack`, { method: "POST", body: { outcome: "success" } });
  assert.equal(ack.status, 200);
  const cmds2 = await (await request("/api/v1/kuaidian/commands")).json();
  assert.ok(!cmds2.commands.some((c) => c.id === onBody.commandId), "ack 后命令不再排队");
  // 终态 item 不重试
  const termItem = await injectItem("success", { assetId: "ast_t" });
  const termRes = await request(`/api/v1/kuaidian/jobs/${termItem.id}/retry`, { method: "POST", body: {} });
  assert.equal(termRes.status, 409);
  assert.equal((await termRes.json()).error, "terminal_state");
});

/* ─────────── 5) 前端与 Edge 打开器源码契约 ─────────── */
test("前端/Edge：控制台状态卡/过滤器/详情/重试按钮；显式 Microsoft Edge 不用默认浏览器", async () => {
  const wb = await readFile(WORKBENCH_PATH, "utf8");
  assert.ok(wb.includes("微信文件传输助手主采集"), "主采集入口标题");
  assert.ok(wb.includes("主入口 → 微信文件传输助手"), "文件传输助手明确为必需主入口");
  assert.ok(wb.includes("/api/v1/kuaidian/status") && wb.includes("/api/v1/kuaidian/jobs"), "控制台使用真实 jobs/status 源");
  assert.ok(wb.includes("setFilter") && wb.includes("filter-pills"), "过滤器");
  assert.ok(wb.includes("kuaidian-job-detail") && wb.includes("errorDisplay"), "行详情与失败原因");
  assert.ok(wb.includes("retryMode") && wb.includes("本地重试") && wb.includes("原版快点重供"), "重试按钮按 retryMode");
  assert.ok(wb.includes("legacyTaskId") && wb.includes("legacy_retry") && wb.includes("encodeURIComponent(job.legacyTaskId)"), "legacy 任务使用受控标识构造重试路径");
  assert.ok(wb.includes("/api/v1/kuaidian/legacy/") && wb.includes("重试历史卡片"), "legacy 失败任务渲染重试按钮");
  assert.ok(wb.includes("Microsoft Edge"), "打开按钮显式 Microsoft Edge");
  assert.ok(wb.includes("微信账号登录") && wb.includes("网页在线，但微信未登录"), "网页在线与微信登录态分开显示");
  assert.ok(wb.includes("/api/v1/kuaidian/open-filehelper"), "Edge 打开走本地节点端点");
  assert.ok(!wb.includes("127.0.0.1:17890") || wb.includes("LOCAL_AGENT_URL"), "UI 不硬编码显示 localhost 端口");
  const sv = await readFile(SERVER_PATH, "utf8");
  assert.ok(sv.includes("/Applications/Microsoft Edge.app"), "server 优先 Edge 二进制");
  assert.ok(sv.includes('"-a"') || sv.includes('"-a",'), "兜底 open -a 显式 Edge 应用");
  assert.ok(sv.includes("filehelper.weixin.qq.com"), "打开 filehelper URL");
  assert.ok(sv.includes("const legacyRetryMatch") && sv.includes('retryMode: "legacy_retry"'), "server 暴露受控的 legacy 卡片重试端点");
  assert.ok(sv.includes("watcherScanInFlight") && sv.includes("scanWatcherLibsSingleFlight"), "目录扫描必须单飞，避免卡住时耗尽线程池");
  assert.doesNotMatch(sv, /setInterval\(\(\) => scanWatcherLibs\(\)/, "定时器不得叠加目录扫描");
});
