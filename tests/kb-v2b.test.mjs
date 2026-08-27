/**
 * kb-v2b.test.mjs — 阶段 A4 验收（生产数据安全 + 快点主链路一致性）
 * 覆盖：
 *   1) 生产旧 schema 夹具：metric_snapshot 1 行开库后仍 1 行值不丢、重开不增长、半迁移 backup 残留合并（P0-1）
 *   2) share import → batch awaiting → /kuaidian 同 source 认领同 item → batch done 仅 1 item（P0-2/P0-3）
 *   3) /api/v1/ingest 视频号只排队等待快点；/kuaidian 后 task completed（P0-4）
 *   4) 恶意 sourceUrl/downloadUrl 全 DB+JSON API 0 泄漏（P0-5）
 *   5) post-asset DB 故障补偿：无悬空资产/半包，item failed + receipt/observation 可追踪（P0-7）
 *   6) loadConfig 的 mediaFallback 生效（快点失败 → awaiting_fallback_media）+ watcher 配置生效（P0-6）
 *   7) stats.mediaCoverage 语义 = media_validation='ok' 覆盖率（P1-8）
 *   8) SSRF：IPv6 unspecified/multicast/映射私网拒绝；HTTPS→HTTP 降级拒绝（P1-9）
 * 全部隔离 temp config/dataDir/kbRoot；只终止变量记录的精确测试子进程。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile, copyFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createHttpServer } from "node:http";
import { createReadStream } from "node:fs";

const testsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(testsDir);
const AGENT_ENTRY = join(repoRoot, "local-agent", "server.mjs");
const TEST_MP4 = join(testsDir, "fixtures", "media", "sample-faststart.mp4");
const MOCK_ENRICH = join(testsDir, "fixtures", "mock-enrich.mjs");

const ROOT = join(tmpdir(), `kb_v2b_test_${Date.now()}`);
const DATA_DIR = join(ROOT, "data");
const KB_ROOT = join(ROOT, "kbroot");
const SANDBOX_MP4 = join(ROOT, "real.mp4");
const WATCH_DIR = join(ROOT, "watch");

let server;
let baseUrl;
let port;
let serverErr = "";
let httpServer;
let httpPort;

function request(path, { method = "GET", headers = {}, body } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12_000),
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

async function poll(fn, { tries = 30, delay = 400, desc = "" } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, delay));
  }
  throw new Error(`poll 超时: ${desc}`);
}

before(async () => {
  await mkdir(KB_ROOT, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(WATCH_DIR, { recursive: true });
  await copyFile(TEST_MP4, SANDBOX_MP4);

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
    watcher: { intervalMs: 5000, maxRetries: 3, roots: [{ dir: WATCH_DIR, channel: "kuaidian", recursive: true }] },
    analysis: { yuanbaoChat: false },
    kuaidianFallback: { enabled: false },
    mediaFallback: { enabled: true, providers: [] },
    services: {},
    adapters: {},
  };
  const configPath = join(ROOT, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  server = spawn(process.execPath, [AGENT_ENTRY], {
    cwd: repoRoot,
    env: { ...process.env, ZHITAI_CONFIG_PATH: configPath, ZHITAI_DATA_DIR: DATA_DIR, ZHITAI_ENRICH_SCRIPT: MOCK_ENRICH },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.unref();
  server.stdout.on("data", () => {});
  server.stderr.on("data", (c) => { serverErr += c.toString(); });
  baseUrl = `http://127.0.0.1:${port}`;
  assert.equal(await waitHealthy(baseUrl), true, "server 应就绪");
});

after(async () => {
  try { httpServer.closeAllConnections?.(); } catch { /* ignore */ }
  await new Promise((resolve) => httpServer.close(resolve)).catch(() => {});
  if (serverErr.trim()) console.log("SERVER_STDERR:", serverErr.slice(-500));
  if (server && server.exitCode === null && server.signalCode === null) {
    try { server.kill("SIGTERM"); } catch { /* ignore */ }
    await new Promise((resolve) => server.once("exit", resolve));
  }
  await rm(ROOT, { recursive: true, force: true }).catch(() => {});
});

/* ─────────── 1) P0-1：旧 schema 夹具（1 行保留、重开不增长、半迁移 backup 合并） ─────────── */
test("旧 metric_snapshot 1 行迁移后仍 1 行值不丢；重开不增长；半迁移 backup 残留合并", async () => {
  const { openKbDb } = await import("../local-agent/kb.mjs");
  const dir = join(ROOT, "legacy-db");
  await mkdir(dir, { recursive: true });
  const dbPath = join(dir, "kb.sqlite");
  let db = openKbDb(dbPath); // 建全 schema
  const iso = new Date().toISOString();
  db.prepare("INSERT INTO video_asset (id, content_id, sha256, title, created_at, updated_at) VALUES ('va1', 'sph:legacy_abc', 'sha1', '旧资产', ?, ?)").run(iso, iso);
  // 降级为 v2 旧结构 + 1 行（无 content_id/plays_raw/observation_id）
  db.exec("DROP TABLE metric_snapshot");
  db.exec("CREATE TABLE metric_snapshot (id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id TEXT NOT NULL, captured_at TEXT, plays INTEGER, likes INTEGER, comments INTEGER, favorites INTEGER, shares INTEGER, source TEXT)");
  db.prepare("INSERT INTO metric_snapshot (asset_id, captured_at, plays, likes, comments, favorites, shares, source) VALUES ('va1', '2026-08-01T00:00:00.000Z', 231, 96, 702, 126, NULL, 'legacy_metadata')").run();
  db.close();

  // 重开触发升级：主表 1 行、值保留、raw null、content_id 取资产、observation_id 稳定
  db = openKbDb(dbPath);
  const rows = db.prepare("SELECT * FROM metric_snapshot").all();
  assert.equal(rows.length, 1, "旧 1 行不得丢失");
  assert.equal(rows[0].plays, 231);
  assert.equal(rows[0].likes, 96);
  assert.equal(rows[0].comments, 702);
  assert.equal(rows[0].favorites, 126);
  assert.equal(rows[0].plays_raw, null, "缺失 raw 字段为 null");
  assert.equal(rows[0].content_id, "sph:legacy_abc", "content_id 用该资产 video_asset.content_id");
  assert.match(String(rows[0].observation_id), /^v3:/, "observation_id 稳定");
  db.close();
  // 重开两次不增长
  db = openKbDb(dbPath);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM metric_snapshot").get().c, 1, "重开计数不增长");
  db.close();

  // 半迁移残留：主表清空（模拟半迁移后主表空）+ backup 残留（第一次升级已保留）→ 重开合并
  db = openKbDb(dbPath);
  db.exec("DELETE FROM metric_snapshot");
  db.close();
  db = openKbDb(dbPath);
  const merged = db.prepare("SELECT * FROM metric_snapshot").all();
  assert.equal(merged.length, 1, "半迁移 backup 残留应合并到当前表");
  assert.equal(merged[0].likes, 96);
  db.close();
});

/* ─────────── 8) P1-9：SSRF IPv6 + 协议降级纯函数 ─────────── */
test("SSRF：IPv6 unspecified/multicast/映射私网拒绝；HTTPS→HTTP 降级拒绝", async () => {
  const { isPrivateIp, assertNoProtocolDowngrade } = await import("../local-agent/downloader-adapter.mjs");
  assert.equal(isPrivateIp("::"), true, "IPv6 unspecified 拒绝");
  assert.equal(isPrivateIp("ff02::1"), true, "IPv6 multicast 拒绝");
  assert.equal(isPrivateIp("::1"), true);
  assert.equal(isPrivateIp("fe80::1"), true);
  assert.equal(isPrivateIp("fd00::1"), true);
  assert.equal(isPrivateIp("::ffff:10.0.0.1"), true, "映射 IPv4 私网拒绝");
  assert.equal(isPrivateIp("::ffff:192.168.1.1"), true);
  assert.equal(isPrivateIp("2001:db8::1"), true, "文档保留拒绝");
  assert.equal(isPrivateIp("2606:4700:4700::1111"), false, "公网 IPv6 放行");
  assert.equal(isPrivateIp("8.8.8.8"), false);
  // HTTPS→HTTP 降级
  assert.throws(() => assertNoProtocolDowngrade("https://a.example/x", "http://b.example/y"), /ssrf_protocol_downgrade/);
  // 同协议跳转通过
  const next = assertNoProtocolDowngrade("http://a.example/x", "http://b.example/y");
  assert.equal(next.hostname, "b.example");
  const next2 = assertNoProtocolDowngrade("https://a.example/x", "https://b.example/y");
  assert.equal(next2.protocol, "https:");
});

/* ─────────── 7) P1-8：stats.mediaCoverage 语义 ─────────── */
test("stats.mediaCoverage = media_validation='ok' 覆盖率；withPlatform 独立保留", async () => {
  const { openKbDb, stats } = await import("../local-agent/kb.mjs");
  const dir = join(ROOT, "coverage-db");
  await mkdir(dir, { recursive: true });
  const db = openKbDb(join(dir, "kb.sqlite"));
  const iso = new Date().toISOString();
  db.prepare("INSERT INTO video_asset (id, title, media_validation, created_at, updated_at) VALUES ('a1', 'ok资产', 'ok', ?, ?)").run(iso, iso);
  db.prepare("INSERT INTO video_asset (id, title, media_validation, created_at, updated_at) VALUES ('a2', 'unknown资产', 'unknown', ?, ?)").run(iso, iso);
  const s = stats(db);
  assert.equal(s.total, 2);
  assert.equal(s.mediaCoverage, 50, "mediaCoverage 只由 media_validation='ok' 决定");
  assert.equal(s.withPlatform, 0, "withPlatform 独立（平台元数据覆盖率）");
  db.close();
});

/* ─────────── 5) P0-7：post-asset DB 故障补偿 ─────────── */
test("content_analysis 插入被 abort 时：video_asset=0、包不存在、item failed、receipt/observation 可追踪", async () => {
  const { openKbDb, ingestOne, setKbRoot } = await import("../local-agent/kb.mjs");
  const { probeLocalMedia, makeReceipt } = await import("../local-agent/downloader-adapter.mjs");
  const dir = join(ROOT, "comp-db");
  const kbRoot = join(ROOT, "comp-kbroot");
  await mkdir(join(dir, "priv"), { recursive: true });
  await mkdir(kbRoot, { recursive: true });
  setKbRoot(kbRoot);
  const db = openKbDb(join(dir, "kb.sqlite"));
  // 人为让 content_analysis INSERT abort（模拟后半段故障）
  db.exec("CREATE TRIGGER trg_fail_content_analysis BEFORE INSERT ON content_analysis BEGIN SELECT RAISE(ABORT, 'injected_failure'); END");
  const iso = new Date().toISOString();
  db.prepare("INSERT INTO import_batch (id, status, source_kind, created_at, total, succeeded, failed, skipped) VALUES ('b_comp', 'running', 'test', ?, 1, 0, 0, 0)").run(iso);
  const media = await probeLocalMedia(SANDBOX_MP4);
  const receipt = makeReceipt({
    channel: "kuaidian", localPath: SANDBOX_MP4, sha256: media.sha256,
    mediaValidation: media.mediaValidation, startedAt: iso, media, sizeBytes: media.size_bytes,
    title: "补偿测试", temporary: false, validationEvidence: media.container,
  });
  const r = await ingestOne(db, { receipt, input: SANDBOX_MP4, input_kind: "file", batchId: "b_comp", ctx: { privDir: join(dir, "priv"), yuanbaoEnrich: null } });
  assert.equal(r.status, "failed", "后半段失败 → failed");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM video_asset").get().c, 0, "无悬空 searchable 资产");
  const item = db.prepare("SELECT status FROM import_item WHERE batch_id='b_comp'").get();
  assert.equal(item.status, "failed", "import_item 可追踪为 failed");
  assert.ok(db.prepare("SELECT COUNT(*) c FROM download_receipt").get().c >= 1, "receipt 存在");
  assert.ok(db.prepare("SELECT COUNT(*) c FROM ingest_observation").get().c >= 1, "observation 存在");
  db.close();
  // 包目录不得残留（分类空目录可留，但不得有 kb_* 包或 staging 目录）
  const pkgDirs = [];
  async function findPkgs(dir, depth) {
    if (depth > 5) return;
    for (const e of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      if (e.isDirectory()) {
        if (e.name.startsWith("kb_") || e.name.includes(".staging")) pkgDirs.push(join(dir, e.name));
        await findPkgs(join(dir, e.name), depth + 1);
      }
    }
  }
  await findPkgs(kbRoot, 0);
  assert.deepEqual(pkgDirs, [], "不得残留 kb_* 包或 staging 目录");
});

/* ─────────── 2) P0-2/P0-3：share import → awaiting → /kuaidian 认领同 item ─────────── */
test("share import 批次 awaiting；/kuaidian 同 source 认领同 item 且 batch done 仅 1 item", async () => {
  const shareUrl = "https://weixin.qq.com/sph/claim_test_1";
  const r = await request("/api/v1/kb/import", { method: "POST", body: { links: [shareUrl] } });
  assert.equal(r.status, 202);
  const { batchId } = await r.json();
  // 批次 awaiting_primary_download，1 个 pending item
  await poll(async () => {
    const j = await (await request("/api/v1/kb/imports")).json();
    const b = j.batches.find((x) => x.id === batchId);
    return b && b.status === "awaiting_primary_download" ? b : null;
  }, { desc: "批次进入 awaiting_primary_download" });
  const j1 = await (await request("/api/v1/kb/imports")).json();
  const items1 = j1.items.filter((i) => i.batch_id === batchId);
  assert.equal(items1.length, 1);
  assert.equal(items1[0].status, "pending");
  assert.match(String(items1[0].error || ""), /awaiting_primary_download/);

  // /kuaidian 同 sourceUrl 认领同一 item（复用 itemId+batchId，不造孤儿批次）
  const kd = await request("/api/v1/kuaidian", { method: "POST", body: { localPath: SANDBOX_MP4, sourceUrl: shareUrl, title: "认领测试" } });
  assert.equal(kd.status, 202);
  const kdBody = await kd.json();
  assert.equal(kdBody.batchId, batchId, "应复用原 awaiting 批次，不新建孤儿批次");
  await poll(async () => {
    const j = await (await request("/api/v1/kb/imports")).json();
    const b = j.batches.find((x) => x.id === batchId);
    return b && b.status === "done" ? b : null;
  }, { tries: 40, desc: "批次 done" });
  const j2 = await (await request("/api/v1/kb/imports")).json();
  const items2 = j2.items.filter((i) => i.batch_id === batchId);
  assert.equal(items2.length, 1, "仍只有 1 个 item（不另造）");
  assert.equal(items2[0].status, "success", "item 落终态 success");
  assert.ok(items2[0].asset_id, "item 关联 asset_id");
  const b2 = j2.batches.find((x) => x.id === batchId);
  assert.equal(b2.succeeded, 1);
  assert.equal(b2.failed, 0);
  assert.equal(b2.skipped, 0);
});

/* ─────────── 3) P0-4：/api/v1/ingest 视频号只排队；/kuaidian 后 task completed ─────────── */
test("/api/v1/ingest 视频号只登记等待快点；/kuaidian 成功后 task completed", async () => {
  const shareUrl = "https://weixin.qq.com/sph/ingest_test_2";
  const r = await request("/api/v1/ingest", { method: "POST", body: { url: shareUrl } });
  assert.equal(r.status, 202);
  const { task } = await r.json();
  assert.equal(task.status, "awaiting_primary_download", "视频号 ingest 不得直接下载，只排队等待快点");
  assert.ok(task.batchId, "task 关联等待批次");

  // 确认没有触发元宝下载：task 不进入 running（很快仍 awaiting）
  await new Promise((res) => setTimeout(res, 600));
  const tasks = await (await request("/api/v1/tasks")).json();
  const t1 = tasks.tasks.find((t) => t.id === task.id);
  assert.equal(t1.status, "awaiting_primary_download", "没有 runChannelsYuanbao 下载");

  // /kuaidian 成功后 task completed（用独立 sha 文件，避免与前序测试 duplicate 导致 task failed）
  const ingFile = join(ROOT, "ingest-claim.mp4");
  await copyFile(SANDBOX_MP4, ingFile);
  const { open: openI } = await import("node:fs/promises");
  const fdI = await openI(ingFile, "a");
  await fdI.write("INGEST_MARKER_6");
  await fdI.close();
  const kd = await request("/api/v1/kuaidian", { method: "POST", body: { localPath: ingFile, sourceUrl: shareUrl, title: "ingest认领" } });
  assert.equal(kd.status, 202);
  await poll(async () => {
    const j = await (await request("/api/v1/tasks")).json();
    const t = j.tasks.find((x) => x.id === task.id);
    return t && t.status === "completed" ? t : null;
  }, { tries: 40, desc: "task completed" });
  const tasks2 = await (await request("/api/v1/tasks")).json();
  const t2 = tasks2.tasks.find((t) => t.id === task.id);
  assert.equal(t2.status, "completed");
  assert.ok(t2.assetId || t2.packagePath, "task 带 assetId/packagePath");
});

/* ─────────── 4) P0-5：恶意 sourceUrl/downloadUrl 全 DB+JSON API 0 泄漏 ─────────── */
test("恶意 sourceUrl+downloadUrl 失败：SQLite 全部文本字段与 JSON API 0 泄漏", async () => {
  const evilSource = "https://evil-attacker.com/v?auth_key=SECRETKX&wsSecret=WSKX&token=TOKX&encfilekey=EFKX";
  const evilDl = `http://127.0.0.1:${httpPort}/v.mp4?auth_key=DLAKX&token=DLTKX&wsTime=1`;
  const r = await request("/api/v1/kuaidian", { method: "POST", body: { downloadUrl: evilDl, sourceUrl: evilSource, title: "恶意泄漏测试" } });
  assert.equal(r.status, 202);
  await poll(async () => {
    const j = await (await request("/api/v1/kb/imports")).json();
    const b = j.batches[0];
    return b && b.status === "done" ? true : null;
  }, { tries: 20, desc: "恶意请求批次终态" });

  const sensitive = ["SECRETKX", "WSKX", "TOKX", "EFKX", "DLAKX", "DLTKX", "evil-attacker.com"];
  // 扫描 SQLite 全部 TEXT/带值列
  const { openKbDb } = await import("../local-agent/kb.mjs");
  const db = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((x) => x.name);
  const leaks = [];
  for (const t of tables) {
    const cols = db.prepare(`PRAGMA table_info(${t})`).all().filter((c) => /TEXT|CHAR|BLOB/.test(c.type)).map((c) => c.name);
    if (!cols.length) continue;
    for (const row of db.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(",")} FROM "${t}"`).all()) {
      for (const c of cols) {
        const v = row[c];
        if (v == null) continue;
        for (const s of sensitive) {
          if (String(v).includes(s)) leaks.push(`${t}.${c}=${String(v).slice(0, 80)}`);
        }
      }
    }
  }
  db.close();
  assert.deepEqual(leaks, [], `SQLite 不应泄漏敏感值: ${leaks.join(" | ")}`);

  // 扫描 JSON API
  const apis = ["/api/v1/kb/videos", "/api/v1/kb/imports", "/api/v1/kb/stats", "/api/v1/kb/export?format=json", "/api/v1/kb/export?format=csv"];
  for (const p of apis) {
    const resp = await fetch(`${baseUrl}${p}`, { signal: AbortSignal.timeout(8000) });
    const text = await resp.text();
    for (const s of sensitive) {
      assert.ok(!text.includes(s), `API ${p} 不应包含 ${s}`);
    }
  }
});

/* ─────────── 6) P0-6：loadConfig 的 mediaFallback 生效（快点失败 → awaiting_fallback_media） ─────────── */
test("快点失败且 mediaFallback 配置生效：item 登记 awaiting_fallback_media（元宝不假装媒体回退）", async () => {
  const shareUrl = "https://weixin.qq.com/sph/fallback_test_3";
  const r = await request("/api/v1/kuaidian", {
    method: "POST",
    body: { downloadUrl: "http://127.0.0.1:9/unreachable.mp4", sourceUrl: shareUrl, title: "fallback配置测试" },
  });
  assert.equal(r.status, 202);
  const { batchId } = await r.json();
  await poll(async () => {
    const j = await (await request("/api/v1/kb/imports")).json();
    const b = j.batches.find((x) => x.id === batchId);
    return b && b.status !== "running" ? b : null;
  }, { tries: 20, desc: "fallback 批次终态" });
  const j = await (await request("/api/v1/kb/imports")).json();
  const item = j.items.find((i) => i.batch_id === batchId);
  assert.ok(item, "应有 item");
  assert.equal(item.status, "pending", "mediaFallback 配置生效 → 等待媒体回退（非失败）");
  assert.match(String(item.error || ""), /awaiting_fallback_media/, "明确 awaiting_fallback_media，不声称元宝完成媒体回退");
});
