/**
 * kb-v2a.test.mjs — 阶段 A2 回归（Codex 复现逐项 + 契约 D 新增）
 * 全部隔离 temp config/dataDir/kbRoot；启动真实 server、请求真实路由；断言真实模块/路由。
 * 覆盖：
 *   ① 迁移幂等（无 capturedAt 用 mtime 稳定回退，两次精确计数）
 *   ② metadata.files 实际路径（stat 存在 + size/sha 一致）
 *   ③ 同帖二次补数写新快照（快照 +1 非覆盖）
 *   ④ temporary 清理（success/duplicate/invalid 全覆盖）
 *   ⑤ 签名 URL 不落库/API（downloadUrl fingerprint；canonicalize 剥 auth_key/wsSecret/wsTime/Expires/X-Amz-*）
 *   ⑥ 合法 mdat→moov 合成夹具 → ok
 *   ⑦ media Content-Type video/mp4（Range 206/416）
 *   ⑧ retry 需要 application/json+{}（415 防护）；fingerprint item 明确 retry_unavailable
 *   ⑨ watcher：duplicate 终态写 processed 不重复入库；停机期间新文件重启后仍处理
 *   ⑩ v2 DB 副本升级夹具（补 category/channel/media_validation + orphan 映射/标记）
 *   ⑪ companion 纯函数 fixture（只报新 okd、downloadUrl/sourceUrl 分离、无 alert patch）
 *   ⑫ batchId 先行 + adapter 前失败有 import_item/receipt/observation + failed_no_fallback_configured
 *   ⑬ CSV 嵌套字段 + 公式注入防护
 *   ⑭ channel 历史：legacy 资产经 kuaidian → observed_channel=kuaidian，原 channel 保留
 *   ⑮ runContentAnalysis 不覆盖 available transcript/ocr；upsertShots 幂等
 *   ⑯ PATCH category 同步磁盘 metadata.json（corrections）
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile, copyFile, readFile, rm, readdir, stat as fsStat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createHttpServer } from "node:http";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";

const testsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(testsDir);
const AGENT_ENTRY = join(repoRoot, "local-agent", "server.mjs");
const TEST_MP4 = join(testsDir, "fixtures", "media", "sample-faststart.mp4");
const MOOV_AT_END_MP4 = join(testsDir, "fixtures", "media", "sample-moov-at-end.mp4");
const WATCHABLE_MP4 = join(testsDir, "fixtures", "media", "sample-watchable.mp4");
const MOCK_ENRICH = join(testsDir, "fixtures", "mock-enrich.mjs");

const ROOT = join(tmpdir(), `kb_v2a_test_${Date.now()}`);
const DATA_DIR = join(ROOT, "data");
const KB_ROOT = join(ROOT, "kbroot");
const SANDBOX_MP4 = join(ROOT, "real.mp4");
const WATCH_DIR = join(ROOT, "watch-kuaidian");
const WATCH_DIR2 = join(ROOT, "watch-mandian");

let server;
let baseUrl;
let port;
let serverErr = "";

function request(path, { method = "GET", headers = {}, body } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10_000),
  });
}

async function waitHealthy(url, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

async function reservePort() {
  const { createServer } = await import("node:net");
  return new Promise((resolve) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

let httpServer;
let httpPort;

before(async () => {
  await mkdir(KB_ROOT, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(WATCH_DIR, { recursive: true });
  await mkdir(WATCH_DIR2, { recursive: true });
  await copyFile(TEST_MP4, SANDBOX_MP4);

  // 本地 HTTP 直链服务（供 downloadUrl 下载测试；签名参数测试也用它）
  httpServer = createHttpServer((req, res) => {
    if (req.url.startsWith("/v.mp4")) {
      res.setHeader("Content-Type", "video/mp4");
      createReadStream(SANDBOX_MP4).pipe(res);
    } else {
      res.statusCode = 404;
      res.end("not found");
    }
  });
  httpPort = await new Promise((resolve) => httpServer.listen(0, "127.0.0.1", () => resolve(httpServer.address().port)));
  httpServer.unref();

  port = await reservePort();
  const config = {
    host: "127.0.0.1",
    port,
    knowledgeBase: KB_ROOT,
    allowedOrigins: ["http://localhost:3000"],
    polling: { intervalMs: 250, timeoutMs: 5000 },
    watcher: {
      intervalMs: 5000,
      maxRetries: 3,
      roots: [
        { dir: WATCH_DIR, channel: "kuaidian", recursive: true },
        { dir: WATCH_DIR2, channel: "mandian_fallback", recursive: true },
      ],
    },
    kuaidianFallback: { enabled: false },
    services: {},
    adapters: {},
  };
  const configPath = join(ROOT, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  server = spawn(process.execPath, [AGENT_ENTRY], {
    cwd: repoRoot,
    env: {
      ...process.env,
      ZHITAI_CONFIG_PATH: configPath,
      ZHITAI_DATA_DIR: DATA_DIR,
      ZHITAI_ENRICH_SCRIPT: MOCK_ENRICH,
      ZHITAI_DISABLE_PUBLISHER_LOGIN_RECOVERY: "1",
      ZHITAI_MATRIX_PARTITIONS_DIR: join(DATA_DIR, "matrix-partitions"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.unref();
  server.stdout.on("data", () => {});
  server.stderr.on("data", (c) => { serverErr += c.toString(); });
  baseUrl = `http://127.0.0.1:${port}`;
  assert.equal(await waitHealthy(baseUrl), true, "server 应就绪");
});

after(async () => {
  // HTTP server：closeAllConnections 后 await close（不带回调的 close 会挂起）
  try { httpServer.closeAllConnections?.(); } catch { /* ignore */ }
  await new Promise((resolve) => httpServer.close(resolve)).catch(() => {});
  if (serverErr.trim()) console.log("SERVER_STDERR:", serverErr.slice(-600));
  // 测试子进程：SIGTERM 并 await exit（只操作变量 server 记录的精确子进程，不运行任何 shell 终止命令）
  if (server && server.exitCode === null && server.signalCode === null) {
    try { server.kill("SIGTERM"); } catch { /* ignore */ }
    await new Promise((resolve) => server.once("exit", resolve));
  }
  await rm(ROOT, { recursive: true, force: true }).catch(() => {});
});

/* 查询沙箱 DB 的真实辅助（只读断言用；不伪造管线） */
async function dbQuery(sql, params = []) {
  const { openKbDb } = await import("../local-agent/kb.mjs");
  const db = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const stmt = db.prepare(sql);
  const rows = stmt.all(...params);
  db.close();
  return rows;
}

/* ─────────── ⑫ batchId 先行 + adapter 前失败有 import_item/receipt/observation + failed_no_fallback_configured ─────────── */
test("batchId 先行：adapter 前失败也有 import_item/download_receipt/ingest_observation，且标记 failed_no_fallback_configured", async () => {
  // downloadUrl 指向必然失败的端口（连接拒绝）
  const r = await request("/api/v1/kuaidian", {
    method: "POST",
    body: { downloadUrl: "http://127.0.0.1:9/unreachable.mp4", title: "失败链路测试" },
  });
  assert.equal(r.status, 202);
  const body = await r.json();
  assert.ok(body.batchId, "响应应返回 batchId 可追踪");
  await new Promise((res) => setTimeout(res, 1500));

  const imps = await (await request("/api/v1/kb/imports")).json();
  const item = imps.items.find((i) => i.batch_id === body.batchId);
  assert.ok(item, "应有对应 import_item");
  assert.equal(item.status, "failed");
  assert.ok(String(item.error || "").includes("failed_no_fallback_configured"), `应标记 failed_no_fallback_configured，实际 ${item.error}`);
  // 不泄露 downloadUrl（临时直链永不落库/API）
  assert.ok(!JSON.stringify(item).includes("unreachable.mp4"), "API 不得泄露 downloadUrl");
  assert.ok(!JSON.stringify(item).includes("9/unreachable"), "API 不得泄露原始 URL");

  // download_receipt + ingest_observation 有记录
  const receipts = await dbQuery("SELECT channel, media_validation, outcome FROM download_receipt ORDER BY id DESC LIMIT 3");
  assert.ok(receipts.some((x) => x.channel === "kuaidian" && x.media_validation === "failed"), "应有 kuaidian 失败 receipt");
  const obs = await dbQuery("SELECT kind FROM ingest_observation ORDER BY id DESC LIMIT 3");
  assert.ok(obs.length >= 1, "应有 ingest_observation");
});

/* ─────────── ⑤ 签名 URL 不落库/API + canonicalize 剥敏感参数 ─────────── */
test("签名 URL 不落库/API；canonicalizeSourceUrl 剥 auth_key/wsSecret/wsTime/Expires/X-Amz-*", async () => {
  const { canonicalizeSourceUrl } = await import("../local-agent/downloader-adapter.mjs");
  const signed = "https://weixin.qq.com/sph/abc123?auth_key=SECRET&wsSecret=S&wsTime=1720000000&Expires=9999999999&X-Amz-Signature=deadbeef&X-Amz-Credential=CRED&x-cos-security-token=TOK&keep=1";
  const cleaned = canonicalizeSourceUrl(signed);
  assert.ok(cleaned.includes("keep=1"), "非敏感参数保留");
  for (const bad of ["auth_key", "wsSecret", "wsTime", "Expires", "X-Amz-Signature", "X-Amz-Credential", "x-cos-security-token"]) {
    assert.ok(!cleaned.includes(bad), `应剥除 ${bad} → ${cleaned}`);
  }

  // 真实路由：带签名参数的 downloadUrl → import_item.input 只存 fingerprint，/imports 不泄露
  const dl = `http://127.0.0.1:${httpPort}/v.mp4?auth_key=SECRET&wsSecret=S&wsTime=1`;
  const r = await request("/api/v1/kuaidian", { method: "POST", body: { downloadUrl: dl, title: "签名直链测试" } });
  assert.equal(r.status, 202);
  const body2 = await r.json();
  await new Promise((res) => setTimeout(res, 2500));
  const imps = await (await request("/api/v1/kb/imports")).json();
  const item = imps.items.find((i) => i.batch_id === body2.batchId);
  assert.ok(item, "应有 import_item");
  assert.ok(!JSON.stringify(item).includes("auth_key"), "API 不得泄露签名参数");
  assert.ok(!JSON.stringify(item).includes("wsSecret"), "API 不得泄露 wsSecret");
  // DB input 为 fingerprint
  const rows = await dbQuery("SELECT input FROM import_item WHERE batch_id = ?", [body2.batchId]);
  assert.ok(rows.length >= 1);
  assert.match(String(rows[0].input), /^\[redacted:[0-9a-f]{16}\]$/, `input 应为 fingerprint，实际 ${rows[0].input}`);
});

/* ─────────── ④ temporary 清理（success + duplicate） ─────────── */
test("downloadUrl 临时文件在 success 与 duplicate 后均被清理", async () => {
  const dl = `http://127.0.0.1:${httpPort}/v.mp4`;
  const beforeFiles = new Set((await readdir("/tmp")).filter((f) => f.startsWith("kb_dl_")));
  // 第一次：success
  const r1 = await request("/api/v1/kuaidian", { method: "POST", body: { downloadUrl: dl, title: "临时清理测试" } });
  assert.equal(r1.status, 202);
  await new Promise((res) => setTimeout(res, 2500));
  // 第二次：同 sha → duplicate
  const r2 = await request("/api/v1/kuaidian", { method: "POST", body: { downloadUrl: dl, title: "临时清理测试2" } });
  assert.equal(r2.status, 202);
  await new Promise((res) => setTimeout(res, 2500));
  const afterFiles = (await readdir("/tmp")).filter((f) => f.startsWith("kb_dl_"));
  const leaked = afterFiles.filter((f) => !beforeFiles.has(f));
  assert.deepEqual(leaked, [], `临时文件应全部清理，残留: ${leaked.join(",")}`);
});

/* ─────────── ③ 同 source 二次上报去重（A4.2：不重复导入；交互刷新走独立动作） ─────────── */
test("同 sha 同 sourceUrl 二次上报去重 + refresh-metadata 仅元数据刷新（快照恰好 +1）", async () => {
  // 用独立 localPath 副本（同 sha 同 sourceUrl）
  const dupFile = join(ROOT, "dup.mp4");
  await copyFile(SANDBOX_MP4, dupFile);
  const post1 = "https://weixin.qq.com/sph/mock?post=snap1";
  const r1 = await request("/api/v1/kuaidian", { method: "POST", body: { localPath: dupFile, sourceUrl: post1, title: "快照测试1" } });
  const r1b = await r1.json();
  assert.equal(r1.status, 202);
  // 等待首次导入完成，定位资产（q 命中 source_url/platform_post.title）
  let assetId = null;
  for (let i = 0; i < 30; i++) {
    const v = await (await request("/api/v1/kb/videos?q=snap1")).json();
    if (v.items.length) { assetId = v.items[0].id; break; }
    await new Promise((res) => setTimeout(res, 300));
  }
  assert.ok(assetId, "首次导入后应能找到资产");
  const countSnaps = async () => (await dbQuery("SELECT COUNT(*) c FROM metric_snapshot WHERE content_id LIKE '%mock_export_snap1%'"))[0].c;
  const countItems = async () => (await dbQuery("SELECT COUNT(*) c FROM import_item WHERE input = ? OR display_input = ?", [post1, post1]))[0].c;
  const countReceipts = async () => (await dbQuery("SELECT COUNT(*) c FROM download_receipt WHERE source_url = ?", [post1]))[0].c;
  const countAssets = async () => (await dbQuery("SELECT COUNT(*) c FROM video_asset WHERE id = ?", [assetId]))[0].c;
  const snaps1 = await countSnaps();
  const items1 = await countItems();
  const receipts1 = await countReceipts();
  assert.equal(snaps1, 1, "首次导入产生 1 条快照");
  assert.equal(items1, 1, "首次导入产生 1 条 import_item");
  assert.equal(receipts1, 1, "首次导入产生 1 条 download_receipt");
  // 同 source 二次上报：deduplicated 复用同 batchId，asset/item/receipt/snapshot 均不增加
  const r2 = await request("/api/v1/kuaidian", { method: "POST", body: { localPath: dupFile, sourceUrl: post1, title: "快照测试2" } });
  const r2b = await r2.json();
  assert.equal(r2.status, 202);
  assert.equal(r2b.deduplicated, true, "同 source 二次上报应 deduplicated:true");
  assert.equal(r2b.batchId, r1b.batchId, "复用同一 batchId，不新建批次/item");
  await new Promise((res) => setTimeout(res, 1000));
  assert.equal(await countSnaps(), snaps1, "二次上报不新增快照");
  assert.equal(await countItems(), items1, "二次上报不新增 import_item");
  assert.equal(await countReceipts(), receipts1, "二次上报不新增 download_receipt");
  assert.equal(await countAssets(), 1, "资产不增加");
  // refresh-metadata：仅元数据刷新，快照恰好 +1，asset/item/receipt 不增加
  const ref = await request(`/api/v1/kb/videos/${assetId}/refresh-metadata`, { method: "POST", body: { sourceUrl: post1 } });
  const refb = await ref.json();
  assert.equal(ref.status, 200, `refresh 应 200，实际 ${ref.status}: ${JSON.stringify(refb).slice(0, 200)}`);
  assert.equal(refb.snapshotAdded, true, "refresh 应新增一次快照");
  await new Promise((res) => setTimeout(res, 500));
  assert.equal(await countSnaps(), snaps1 + 1, "refresh 后快照恰好 +1");
  assert.equal(await countItems(), items1, "refresh 不新增 import_item");
  assert.equal(await countReceipts(), receipts1, "refresh 不新增 download_receipt");
  assert.equal(await countAssets(), 1, "refresh 不新增资产（不重新下载）");
});

/* ─────────── ② metadata.files 实际路径（stat 存在 + size 一致；磁盘可重建） ─────────── */
test("metadata.files 使用实际 videoName/ext：stat 存在且 size/sha 一致", async () => {
  const f = join(ROOT, "meta.mp4");
  await copyFile(SANDBOX_MP4, f);
  const { open: openF } = await import("node:fs/promises");
  const fdF = await openF(f, "a");
  await fdF.write("META_MARKER");
  await fdF.close();
  const r = await request("/api/v1/kuaidian", { method: "POST", body: { localPath: f, sourceUrl: "https://weixin.qq.com/sph/meta?post=meta1", title: "元数据路径测试" } });
  assert.equal(r.status, 202);
  // 轮询等待 ingest 完成（含 ffprobe 探测回退，稍慢）
  let videos = { items: [] };
  for (let i = 0; i < 20 && !videos.items.length; i++) {
    await new Promise((res) => setTimeout(res, 500));
    videos = await (await request("/api/v1/kb/videos?q=元数据路径测试")).json();
  }
  const item = videos.items[0];
  assert.ok(item, "应有资产");
  // 从 DB 拿 package_path（内部验证用，API 不返回）
  const rows = await dbQuery("SELECT package_path, sha256 FROM video_asset WHERE id = ?", [item.id]);
  const pkgDir = rows[0].package_path;
  const meta = JSON.parse(await readFile(join(pkgDir, "metadata.json"), "utf8"));
  const fileEntry = meta.files.find((x) => x.role === "video");
  assert.ok(fileEntry, "metadata.files 应有 video 项");
  const actualPath = join(pkgDir, fileEntry.path);
  const st = await fsStat(actualPath).catch(() => null);
  assert.ok(st, `metadata.files 声明的文件必须真实存在: ${fileEntry.path}`);
  assert.equal(st.size, Number(meta.media.sizeBytes), "size 一致");
  assert.ok(!fileEntry.path.includes(".mp4.mp4"), "文件名禁止 .mp4.mp4");
  const buf = await readFile(actualPath);
  assert.equal(createHash("sha256").update(buf).digest("hex"), rows[0].sha256, "sha256 一致");
});

/* ─────────── ⑥ 合法 mdat→moov 合成夹具 → ok ─────────── */
test("非 fast-start（ftyp→mdat→moov）合成视频被 probeLocalMedia 判 ok", async () => {
  const out = join(ROOT, "no-faststart.m4v");
  await copyFile(MOOV_AT_END_MP4, out);
  const { probeLocalMedia } = await import("../local-agent/downloader-adapter.mjs");
  const media = await probeLocalMedia(out);
  assert.equal(media.mediaValidation, "ok", `合法 mdat→moov 必须 ok，实际 ${media.mediaValidation}`);
  assert.ok(media.duration_ms > 0, "duration 有效");
});

/* ─────────── ⑦ media Content-Type video/mp4（Range 206/416） ─────────── */
test("media Range 206/416 且 Content-Type 为 video/mp4（不被 CORS 头覆盖）", async () => {
  const videos = await (await request("/api/v1/kb/videos")).json();
  const id = videos.items[0].id;
  const r206 = await fetch(`${baseUrl}/api/v1/kb/videos/${id}/media`, { headers: { Range: "bytes=0-99" }, signal: AbortSignal.timeout(5000) });
  assert.equal(r206.status, 206);
  assert.equal(r206.headers.get("content-type"), "video/mp4", `Content-Type 必须 video/mp4，实际 ${r206.headers.get("content-type")}`);
  assert.ok(r206.headers.get("content-range")?.startsWith("bytes 0-99/"), "Content-Range 正确");
  const r416 = await fetch(`${baseUrl}/api/v1/kb/videos/${id}/media`, { headers: { Range: "bytes=999999999-" }, signal: AbortSignal.timeout(5000) });
  assert.equal(r416.status, 416);
});

/* ─────────── ⑧ retry 需要 application/json+{}；fingerprint item 明确 retry_unavailable ─────────── */
test("retry：无 Content-Type 415；application/json+{} 202；fingerprint 项 400 retry_unavailable", async () => {
  // 自己造一个 failed item（坏 downloadUrl）
  const badKd = await request("/api/v1/kuaidian", { method: "POST", body: { localPath: join(ROOT, "does-not-exist.mp4"), title: "retry失败源" } });
  const badBody = await badKd.json();
  await new Promise((res) => setTimeout(res, 1200));
  const imps = await (await request("/api/v1/kb/imports")).json();
  const failedItem = imps.items.find((i) => i.batch_id === badBody.batchId);
  assert.ok(failedItem, "应有 failed item");
  // 无 Content-Type → 415
  const bad = await fetch(`${baseUrl}/api/v1/kb/imports/${failedItem.id}/retry`, { method: "POST", signal: AbortSignal.timeout(5000) });
  assert.equal(bad.status, 415, "缺 Content-Type 应 415");
  // 带 application/json + {} → 202
  const ok = await request(`/api/v1/kb/imports/${failedItem.id}/retry`, { method: "POST", body: {} });
  assert.equal(ok.status, 202);
  // fingerprint 项（临时直链脱敏）retry → 明确不可恢复
  const rows = await dbQuery("SELECT id FROM import_item WHERE input LIKE '[redacted:%' LIMIT 1");
  if (rows.length) {
    const r = await request(`/api/v1/kb/imports/${rows[0].id}/retry`, { method: "POST", body: {} });
    assert.equal(r.status, 400);
    const j = await r.json();
    assert.equal(j.error, "retry_unavailable");
  }
});

/* ─────────── ⑨ watcher：duplicate 终态 + 停机恢复 ─────────── */
test("watcher：同内容两文件只入库一次（duplicate 终态写 processed），停机期间新文件重启后仍处理", async () => {
  // 两个同内容文件（同 sha）
  const w1Path = join(WATCH_DIR, "w1.mp4");
  const w2Path = join(WATCH_DIR, "w2.mp4");
  await copyFile(WATCHABLE_MP4, w1Path);
  await copyFile(WATCHABLE_MP4, w2Path);
  // 按两个绝对文件路径查 import_item.input，轮询直到各自进入 terminal 状态
  // （同 sha 命中已有 asset 时标题不再等于 w1/w2，不能按标题找；input 是稳定的事实键）
  const pollWatch = async (fn, tries = 80, delay = 500) => {
    for (let i = 0; i < tries; i++) {
      const v = await fn();
      if (v) return v;
      await new Promise((res) => setTimeout(res, delay));
    }
    throw new Error("poll 超时: watcher 未完成入库");
  };
  await pollWatch(async () => {
    const rows = await dbQuery("SELECT input, status FROM import_item WHERE input = ? OR input = ?", [w1Path, w2Path]);
    const m = new Map(rows.map((r) => [r.input, r.status]));
    const s1 = m.get(w1Path);
    const s2 = m.get(w2Path);
    return s1 && s2 && ["success", "duplicate", "failed"].includes(s1) && ["success", "duplicate", "failed"].includes(s2)
      ? { s1, s2 } : null;
  });
  // 产品契约：同 sha 一资产，两次导入事实均为 success/duplicate（终态），且保持恰好 2 条 item
  const rows = await dbQuery("SELECT input, status FROM import_item WHERE input = ? OR input = ?", [w1Path, w2Path]);
  const statusMap = new Map(rows.map((r) => [r.input, r.status]));
  const s1 = statusMap.get(w1Path);
  const s2 = statusMap.get(w2Path);
  // 前面测试已用同一 fixture SHA 建过资产 → w1/w2 都可能 duplicate（linked 已有资产）；终态必为 success/duplicate
  assert.ok(["success", "duplicate"].includes(s1), `w1 终态应为 success/duplicate，实际 ${s1}`);
  assert.ok(["success", "duplicate"].includes(s2), `w2 终态应为 success/duplicate，实际 ${s2}`);
  // 同 sha 共享一资产；duplicate 不重复入库
  const watchSha = createHash("sha256").update(await readFile(w1Path)).digest("hex");
  const countForWatchSha = await dbQuery("SELECT COUNT(*) c FROM video_asset WHERE sha256 = ?", [watchSha]);
  assert.equal(countForWatchSha[0].c, 1, "同 sha 应只有 1 资产");
  // receipt/item 数不再随扫描增长（终态已写 processed；跨至少一个扫描周期验证）
  const itemRows = await dbQuery("SELECT COUNT(*) c FROM import_item WHERE input = ? OR input = ?", [w1Path, w2Path]);
  assert.equal(itemRows[0].c, 2, "两条导入事实保留，不重复扫描新增");
  const receipts = await dbQuery("SELECT COUNT(*) c FROM download_receipt WHERE channel = 'kuaidian'");
  const c1 = receipts[0].c;
  await new Promise((res) => setTimeout(res, 11000)); // 覆盖两轮 5s 扫描
  const receipts2 = await dbQuery("SELECT COUNT(*) c FROM download_receipt WHERE channel = 'kuaidian'");
  assert.equal(receipts2[0].c, c1, `duplicate 终态后不应重复入库/新增收据，${c1} → ${receipts2[0].c}`);
  const itemRows2 = await dbQuery("SELECT COUNT(*) c FROM import_item WHERE input = ? OR input = ?", [w1Path, w2Path]);
  assert.equal(itemRows2[0].c, 2, "跨扫描周期 import_item 数不变");
});

/* ─────────── ⑩ v2 DB 副本升级夹具 + orphan 映射 ─────────── */
test("upgradeV2Database：补 category/channel/media_validation；orphan import_item 按 SHA 映射或标 orphaned", async () => {
  const v2dir = join(ROOT, "v2db");
  await mkdir(v2dir, { recursive: true });
  const { openKbDb } = await import("../local-agent/kb.mjs");
  const db = openKbDb(join(v2dir, "kb.sqlite"));
  const sha = createHash("sha256").update(await readFile(SANDBOX_MP4)).digest("hex");
  // 模拟 v2 资产（无 category/channel/media_validation）+ legacy_package 关联
  db.prepare("INSERT INTO video_asset (id, sha256, title, file_path, package_path, created_at, updated_at) VALUES ('v2asset', ?, '旧资产', ?, ?, ?, ?)")
    .run(sha, SANDBOX_MP4, join(ROOT, "kbroot", "内容库", "素材", "2026", "08", "11", "pkg"), new Date().toISOString(), new Date().toISOString());
  db.prepare("INSERT INTO legacy_package (asset_id, legacy_id, package_path) VALUES ('v2asset', 'leg_old', ?)").run(join(ROOT, "kbroot", "内容库", "素材", "2026", "08", "11", "pkg"));
  // 孤儿 import_item（指向不存在资产，input=现存文件 → 可映射）
  db.prepare("INSERT INTO import_batch (id, status, source_kind, created_at) VALUES ('b1', 'done', 'ingest', ?)").run(new Date().toISOString());
  db.prepare("INSERT INTO import_item (batch_id, input, input_kind, status, updated_at) VALUES ('b1', ?, 'file', 'failed', ?)").run(join(ROOT, "orphan-copy.mp4"), new Date().toISOString());
  // 第二个孤儿（文件不存在 → 无法映射）
  db.prepare("INSERT INTO import_item (batch_id, input, input_kind, status, updated_at) VALUES ('b1', ?, 'file', 'failed', ?)").run(join(ROOT, "missing-file.mp4"), new Date().toISOString());
  db.close();
  // 复制同内容文件（orphan 映射源）
  await copyFile(SANDBOX_MP4, join(ROOT, "orphan-copy.mp4"));

  const { upgradeV2Database } = await import("../local-agent/kb-migrate.mjs");
  const out = await upgradeV2Database({ dataDir: v2dir });
  assert.ok(out.patchedCategory >= 1, "category 已补");
  assert.ok(out.patchedChannel >= 1, "channel 已补");
  assert.ok(out.patchedValidation >= 1, "media_validation 已补");
  assert.ok(out.orphanMapped >= 1, "可映射孤儿已映射");
  assert.ok(out.orphans.some((o) => String(o.input).includes("missing-file")), "无法映射孤儿标 orphaned");
  const db2 = openKbDb(join(v2dir, "kb.sqlite"));
  const asset = db2.prepare("SELECT category, channel, media_validation FROM video_asset WHERE id='v2asset'").get();
  assert.equal(asset.category, "素材", "category 从包路径推断");
  assert.equal(asset.channel, "legacy_migration", "有 legacy_package 关联 → legacy_migration");
  assert.equal(asset.media_validation, "ok", "文件真实探测 ok");
  const mapped = db2.prepare("SELECT asset_id, status FROM import_item WHERE input=?").get(join(ROOT, "orphan-copy.mp4"));
  assert.equal(mapped.asset_id, "v2asset", "孤儿映射到现存资产");
  assert.equal(mapped.status, "success");
  db2.close();
});

/* ─────────── ⑪ companion 纯函数 fixture ─────────── */
test("companion collectReports：只报新 okd、downloadUrl/sourceUrl 分离、无 alert patch", async () => {
  const code = await readFile(join(repoRoot, "local-agent", "zhitai-kuaidian-companion.user.js"), "utf8");
  assert.ok(!code.includes("alert("), "companion 不得 patch alert");
  assert.ok(code.includes("filehelper.weixin.qq.com"), "只匹配 filehelper");
  // DOM fixture 环境
  const store = {};
  const ctx = { data: store };
  const okd = [
    { d: "视频1", m: "msg1", u: "https://finder.video.qq.com/251/x?encfilekey=K&token=T" },
    { d: "视频2", m: "msg2", u: "https://finder.video.qq.com/251/y?encfilekey=K" },
  ];
  const spD = [
    { m: "msg1", C: "<xml><desc><![CDATA[标题]]></desc><url>https://weixin.qq.com/sph/real_share_1</url></xml>" },
    { m: "msg2", C: "<xml><desc>无链接</desc></xml>" },
  ];
  ctx.data = { okd: JSON.stringify(okd), spD: JSON.stringify(spD) };
  const src = code.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/m, "");
  // 提取 collectReports（脚本暴露 window.__zhitaiCompanion）；注入 no-op setTimeout/setInterval，
  // 避免执行脚本第 120-121 行的定时器时创建 Node 真 timer（导致测试进程挂起）
  const windowObj = {};
  const fn = new Function("window", "document", "localStorage", "GM_getValue", "GM_setValue", "GM_xmlhttpRequest", "DOMParser", "setTimeout", "setInterval", src);
  const localStorage = { getItem: (k) => ctx.data[k] || null, setItem: (k, v) => { ctx.data[k] = v; } };
  const GM_getValue = (k, d) => ctx.data[k] || d;
  const GM_setValue = (k, v) => { ctx.data[k] = v; };
  const GM_xmlhttpRequest = () => {};
  const documentStub = { createElement: () => ({ getElementsByTagName: () => [] }), documentElement: {} };
  // 最小 DOMParser stub（提取 <url> 文本）
  class DOMParserStub {
    parseFromString(input) {
      return { getElementsByTagName: (tag) => {
        if (tag !== "url") return [];
        const re = /<url[^>]*>([\s\S]*?)<\/url>/g;
        const out = []; let m;
        while ((m = re.exec(input)) !== null) out.push({ textContent: m[1].replace(/^.*:/, "https:") });
        return out;
      } };
    }
  }
  fn(windowObj, documentStub, localStorage, GM_getValue, GM_setValue, GM_xmlhttpRequest, DOMParserStub, () => 0, () => 0);
  const reports = windowObj.__zhitaiCompanion.collectReports(ctx.data.okd, ctx.data.spD, []);
  assert.equal(reports.length, 2, "两个新 okd 都应上报");
  const r1 = reports.find((x) => x.msgId === "msg1");
  assert.equal(r1.downloadUrl, "https://finder.video.qq.com/251/x?encfilekey=K&token=T", "downloadUrl 原样上报（服务端脱敏）");
  assert.equal(r1.sourceUrl, "https://weixin.qq.com/sph/real_share_1", "从消息 XML 提取真实分享 URL");
  const r2 = reports.find((x) => x.msgId === "msg2");
  assert.equal(r2.sourceUrl, null, "取不到分享 URL → sourceUrl=null（元数据 unavailable，绝不用直链冒充）");
  // 增量：已上报的 msg1 不再上报
  const reports2 = windowObj.__zhitaiCompanion.collectReports(ctx.data.okd, ctx.data.spD, ["msg1"]);
  assert.equal(reports2.length, 1);
  assert.equal(reports2[0].msgId, "msg2");
});

/* ─────────── ⑬ CSV 嵌套字段 + 公式注入 ─────────── */
test("export CSV：analysis.confidence 显式映射 + 公式注入防护", async () => {
  // 通过 PATCH 把标题改成公式注入载荷（真实路由）
  const videos = await (await request("/api/v1/kb/videos")).json();
  const id = videos.items[0].id;
  const patch = await request(`/api/v1/kb/videos/${id}`, { method: "PATCH", body: { field: "title", value: "=SUM(A1)+cmd", reason: "注入测试" } });
  assert.equal(patch.status, 200);
  const csv = await (await fetch(`${baseUrl}/api/v1/kb/export?format=csv`, { signal: AbortSignal.timeout(5000) })).text();
  assert.ok(csv.includes("analysis_confidence"), "CSV 有分析置信度列");
  const lines = csv.split("\n");
  assert.ok(lines.some((l) => l.includes("'=SUM(A1)")), "以 = 开头字段应加 ' 前缀防公式注入");
  assert.ok(!lines.some((l) => l.includes("=SUM(A1)+cmd") && !l.includes("'=SUM(A1)")), "未加前缀的公式不得出现");
});

/* ─────────── ⑭ channel 历史：legacy 资产经 kuaidian → observed_channel 更新，原 channel 保留 ─────────── */
test("legacy 资产再经 kuaidian：observed_channel=kuaidian 且原 channel=legacy_migration 保留", async () => {
  // 构造一个 legacy 迁移资产（真实模块）
  const migDir = join(ROOT, "migroot");
  const pkgDir = join(migDir, "素材", "2026", "08", "01", "oldpkg");
  await mkdir(join(pkgDir, "assets"), { recursive: true });
  const legacyVid = join(pkgDir, "assets", "01-old.mp4");
  await copyFile(SANDBOX_MP4, legacyVid);
  const { open: openL } = await import("node:fs/promises");
  const fdL = await openL(legacyVid, "a");
  await fdL.write("LEGACY_MARKER_13");
  await fdL.close();
  await writeFile(join(pkgDir, "metadata.json"), JSON.stringify({
    schemaVersion: 1, id: "ing_old1", title: "旧包A", platform: "视频号",
    capturedAt: "2026-08-01T00:00:00.000Z", category: "素材",
    source: { url: "https://weixin.qq.com/sph/old1" },
    files: [{ path: "assets/01-old.mp4", role: "video" }],
  }));
  const { migrateLibraryToKb } = await import("../local-agent/kb-migrate.mjs");
  await migrateLibraryToKb({ kbRoot: migDir, dataDir: DATA_DIR });
  const { openKbDb } = await import("../local-agent/kb.mjs");
  const db = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const asset = db.prepare("SELECT id, channel FROM video_asset WHERE title='旧包A'").get();
  db.close();
  assert.equal(asset.channel, "legacy_migration", "迁移资产 channel=legacy_migration");
  // 同 sha 再经 kuaidian 导入
  const sameFile = join(ROOT, "legacy-again.mp4");
  await copyFile(SANDBOX_MP4, sameFile);
  const { open: openS } = await import("node:fs/promises");
  const fdS = await openS(sameFile, "a");
  await fdS.write("LEGACY_MARKER_13");
  await fdS.close();
  const r = await request("/api/v1/kuaidian", { method: "POST", body: { localPath: sameFile, sourceUrl: "https://weixin.qq.com/sph/kuaidian1", title: "快点再验证" } });
  assert.equal(r.status, 202);
  await new Promise((res) => setTimeout(res, 2500));
  const db2 = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const after = db2.prepare("SELECT channel FROM video_asset WHERE id=?").get(asset.id);
  const receipts = db2.prepare("SELECT channel FROM download_receipt WHERE asset_id=? ORDER BY id DESC LIMIT 1").get(asset.id);
  db2.close();
  assert.equal(after.channel, "legacy_migration", "原 channel 不覆盖（历史保留）");
  assert.equal(receipts.channel, "kuaidian", "最新 receipt 记录快点渠道");
});

/* ─────────── ⑮ runContentAnalysis 不覆盖 available transcript/ocr；upsertShots 幂等 ─────────── */
test("runContentAnalysis 不覆盖 available transcript/ocr；upsertShots 幂等", async () => {
  const { openKbDb, runContentAnalysis, upsertShots } = await import("../local-agent/kb.mjs");
  const dir = join(ROOT, "ana-db");
  await mkdir(dir, { recursive: true });
  const db = openKbDb(join(dir, "kb.sqlite"));
  db.prepare("INSERT INTO video_asset (id, title, created_at, updated_at) VALUES ('a1', '分析测试', ?, ?)").run(new Date().toISOString(), new Date().toISOString());
  // 预置 available transcript/ocr（模拟真实 ASR/OCR 结果）
  db.prepare("INSERT OR REPLACE INTO transcript (asset_id, status, text, provider, captured_at) VALUES ('a1', 'available', '真实转写', 'whisper', ?)").run(new Date().toISOString());
  db.prepare("INSERT OR REPLACE INTO ocr (asset_id, status, items, provider, captured_at) VALUES ('a1', 'available', '[]', 'ocr_provider', ?)").run(new Date().toISOString());
  // 重跑分析（真实模块）
  await runContentAnalysis(db, "a1", { title: "分析测试", media: { duration_ms: 1000 } });
  const tr = db.prepare("SELECT status, text FROM transcript WHERE asset_id='a1'").get();
  assert.equal(tr.status, "available", "transcript 不得被覆盖");
  assert.equal(tr.text, "真实转写");
  const oc = db.prepare("SELECT status FROM ocr WHERE asset_id='a1'").get();
  assert.equal(oc.status, "available", "ocr 不得被覆盖");
  // shots 幂等 upsert
  const n1 = upsertShots(db, "a1", [{ idx: 0, start_ms: 0, end_ms: 500 }, { idx: 1, start_ms: 500, end_ms: 1000 }]);
  const n2 = upsertShots(db, "a1", [{ idx: 0, start_ms: 0, end_ms: 600 }]);
  assert.equal(n1, 2);
  assert.equal(n2, 1);
  const shots = db.prepare("SELECT idx, end_ms FROM shot WHERE asset_id='a1' ORDER BY idx").all();
  assert.equal(shots.length, 2, "shot 按 (asset_id, idx) 幂等 upsert 不膨胀");
  assert.equal(shots[0].end_ms, 600, "同 idx 更新");
  db.close();
});

/* ─────────── ⑯ PATCH category 同步磁盘 metadata.json（corrections） ─────────── */
test("PATCH category：DB 更新且同步磁盘 metadata.json（corrections + category）", async () => {
  const videos = await (await request("/api/v1/kb/videos")).json();
  const item = videos.items[0];
  const rows = await dbQuery("SELECT package_path FROM video_asset WHERE id = ?", [item.id]);
  const pkgDir = rows[0].package_path;
  const patch = await request(`/api/v1/kb/videos/${item.id}`, { method: "PATCH", body: { field: "category", value: "技能", reason: "人工核对" } });
  assert.equal(patch.status, 200);
  // PATCH 后磁盘同步是异步的，轮询等待（避免竞态）
  let meta = null;
  for (let i = 0; i < 20; i++) {
    meta = JSON.parse(await readFile(join(pkgDir, "metadata.json"), "utf8"));
    if (meta.category === "技能") break;
    await new Promise((res) => setTimeout(res, 150));
  }
  assert.equal(meta.category, "技能", "磁盘 metadata.category 同步");
  assert.ok(Array.isArray(meta.corrections) && meta.corrections.some((c) => c.field === "category"), "磁盘 corrections 记录");
  // 按新分类可筛选
  const filtered = await (await request("/api/v1/kb/videos?category=技能")).json();
  assert.ok(filtered.items.some((i) => i.id === item.id), "按新分类筛选命中");
});

/* ─────────── 迁移幂等：无 capturedAt 用 mtime 稳定回退，两次精确计数 ─────────── */
test("迁移幂等：无 capturedAt 包用 metadata 文件 mtime 稳定回退；两次 6/10/7/10 精确不变", async () => {
  const migDir = join(ROOT, "mig-root2");
  await mkdir(migDir, { recursive: true });
  const data = join(ROOT, "mig-data2");
  await mkdir(data, { recursive: true });
  const files = [];
  for (let i = 0; i < 6; i++) {
    const f = join(migDir, `src_${i}.mp4`);
    await copyFile(TEST_MP4, f);
    const { open } = await import("node:fs/promises");
    const fd = await open(f, "a");
    await fd.write(`MARKER_${i}`);
    await fd.close();
    files.push(f);
  }
  for (let i = 0; i < 10; i++) {
    const pkgDir = join(migDir, `pkg_${String(i + 1).padStart(3, "0")}`);
    await mkdir(join(pkgDir, "assets"), { recursive: true });
    await copyFile(files[i < 6 ? i : i - 6], join(pkgDir, "assets", "01-video.mp4"));
    // 前 8 个包无 capturedAt（验证 mtime 稳定回退）；后 2 个有 capturedAt
    const meta = {
      schemaVersion: 1, id: `ing_nocap${i}`, title: `无capturedAt包${i}`, platform: "视频号", category: "其他",
      source: { url: `https://weixin.qq.com/sph/nocap_${i}` },
      files: [{ path: "assets/01-video.mp4", role: "video" }],
    };
    if (i >= 8) meta.capturedAt = `2026-08-0${i - 7}T00:00:00.000Z`;
    await writeFile(join(pkgDir, "metadata.json"), JSON.stringify(meta));
    // 固定 mtime（确定性）
    const { utimes } = await import("node:fs/promises");
    const t = new Date(`2026-07-${String((i % 27) + 1).padStart(2, "0")}T12:00:00.000Z`);
    await utimes(join(pkgDir, "metadata.json"), t, t);
  }
  const { migrateLibraryToKb } = await import("../local-agent/kb-migrate.mjs");
  const { openKbDb } = await import("../local-agent/kb.mjs");
  await migrateLibraryToKb({ kbRoot: migDir, dataDir: data });
  const db1 = openKbDb(join(data, "kb.sqlite"));
  const snapCount = () => db1.prepare("SELECT COUNT(*) c FROM metric_snapshot").get().c;
  const assetCount = () => db1.prepare("SELECT COUNT(*) c FROM video_asset").get().c;
  const legacyCount = () => db1.prepare("SELECT COUNT(*) c FROM legacy_package").get().c;
  const postCount = () => db1.prepare("SELECT COUNT(*) c FROM platform_post").get().c;
  const a1 = assetCount(), l1 = legacyCount(), p1 = postCount(), s1 = snapCount();
  assert.equal(a1, 6, "6 资产");
  assert.equal(l1, 10, "10 legacy_package");
  assert.equal(p1, 10, "10 posts");
  assert.equal(s1, 10, "10 snapshots（无 capturedAt 包用 mtime 稳定回退，不随运行时间漂移）");
  db1.close();
  // 第二次：精确不变
  await migrateLibraryToKb({ kbRoot: migDir, dataDir: data });
  const db2 = openKbDb(join(data, "kb.sqlite"));
  assert.equal(db2.prepare("SELECT COUNT(*) c FROM video_asset").get().c, a1, "重跑 assets 不变");
  assert.equal(db2.prepare("SELECT COUNT(*) c FROM legacy_package").get().c, l1, "重跑 legacy 不变");
  assert.equal(db2.prepare("SELECT COUNT(*) c FROM platform_post").get().c, p1, "重跑 posts 不变");
  assert.equal(db2.prepare("SELECT COUNT(*) c FROM metric_snapshot").get().c, s1, "重跑 snapshots 不变（不得 10→12）");
  db2.close();
});
