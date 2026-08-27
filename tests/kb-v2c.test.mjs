/**
 * kb-v2c.test.mjs — A4.1 窄返工回归
 * A  metric backup source=NULL 规范成 'legacy'，连续重开 3 次不增长、数值保留
 * B  第二分享 URL 同视频 duplicate → ingest task completed（非 failed）
 * C  mediaFallback 配置时快点失败 → task awaiting_fallback_media（非 failed）
 * D  DELETE video_asset 被 trigger 阻止 → 资产/包保留 + item compensation_failed + asset_id 保留
 * E  /kb/import 非稳定直链 adapter 前置失败 → batch total=1/failed=1、item failed、无签名泄漏
 * F  /ingest 同 canonical 连发两次 → 复用 1 task（deduplicated）+ 仅 1 pending item；认领后不再复用
 * G  recordReceipt evidence 单编码（读取为对象）+ 孤立 token= 片段净化
 * H  shot/provenance backup 半迁移合并、重开不增长
 * 全部隔离 temp config/dataDir/kbRoot；只终止变量记录的精确测试子进程。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const testsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(testsDir);
const AGENT_ENTRY = join(repoRoot, "local-agent", "server.mjs");
const TEST_MP4 = join(testsDir, "fixtures", "media", "sample-faststart.mp4");
const MOCK_ENRICH = join(testsDir, "fixtures", "mock-enrich.mjs");

const ROOT = join(tmpdir(), `kb_v2c_test_${Date.now()}`);
const DATA_DIR = join(ROOT, "data");
const KB_ROOT = join(ROOT, "kbroot");
const SANDBOX_MP4 = join(ROOT, "real.mp4");

let server;
let baseUrl;
let port;
let serverErr = "";

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
  await copyFile(TEST_MP4, SANDBOX_MP4);
  port = await reservePort();
  const config = {
    host: "127.0.0.1",
    port,
    knowledgeBase: KB_ROOT,
    allowedOrigins: ["http://localhost:3000"],
    polling: { intervalMs: 250, timeoutMs: 5000 },
    watcher: { intervalMs: 5000, maxRetries: 3, roots: [] },
    analysis: { yuanbaoChat: false },
    kuaidianFallback: { enabled: false },
    mediaFallback: { enabled: true, providers: [] },
    services: {},
    adapters: {},
  };
  await writeFile(join(ROOT, "config.json"), JSON.stringify(config));
  server = spawn(process.execPath, [AGENT_ENTRY], {
    cwd: repoRoot,
    env: { ...process.env, ZHITAI_CONFIG_PATH: join(ROOT, "config.json"), ZHITAI_DATA_DIR: DATA_DIR, ZHITAI_ENRICH_SCRIPT: MOCK_ENRICH },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.unref();
  server.stdout.on("data", () => {});
  server.stderr.on("data", (c) => { serverErr += c.toString(); });
  baseUrl = `http://127.0.0.1:${port}`;
  assert.equal(await waitHealthy(baseUrl), true, "server 应就绪");
});

after(async () => {
  if (serverErr.trim()) console.log("SERVER_STDERR:", serverErr.slice(-500));
  if (server && server.exitCode === null && server.signalCode === null) {
    try { server.kill("SIGTERM"); } catch { /* ignore */ }
    await new Promise((resolve) => server.once("exit", resolve));
  }
  await rm(ROOT, { recursive: true, force: true }).catch(() => {});
});

/* ─────────── A：旧 source=NULL metric backup 连续重开 3 次不增长 ─────────── */
test("旧 metric_snapshot source=NULL：连续重开 3 次计数不增长，数值保留，source 规范为 legacy", async () => {
  const { openKbDb } = await import("../local-agent/kb.mjs");
  const dir = join(ROOT, "a-db");
  await mkdir(dir, { recursive: true });
  const dbPath = join(dir, "kb.sqlite");
  let db = openKbDb(dbPath);
  const iso = new Date().toISOString();
  db.prepare("INSERT INTO video_asset (id, content_id, sha256, title, created_at, updated_at) VALUES ('vaA', 'sph:srcnull', 'shaA', '源NULL资产', ?, ?)").run(iso, iso);
  db.exec("DROP TABLE metric_snapshot");
  db.exec("CREATE TABLE metric_snapshot (id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id TEXT NOT NULL, captured_at TEXT, plays INTEGER, likes INTEGER, comments INTEGER, favorites INTEGER, shares INTEGER, source TEXT)");
  // source=NULL 与 source='' 各 1 行
  db.prepare("INSERT INTO metric_snapshot (asset_id, captured_at, plays, likes, comments, favorites, shares, source) VALUES ('vaA', '2026-08-01T00:00:00.000Z', 111, 222, 333, 444, NULL, NULL)").run();
  db.prepare("INSERT INTO metric_snapshot (asset_id, captured_at, plays, likes, comments, favorites, shares, source) VALUES ('vaA', '2026-08-02T00:00:00.000Z', 55, 66, 77, 88, NULL, '')").run();
  db.close();
  for (let i = 0; i < 3; i++) {
    db = openKbDb(dbPath);
    const rows = db.prepare("SELECT * FROM metric_snapshot ORDER BY id").all();
    assert.equal(rows.length, 2, `第 ${i + 1} 次重开应稳定 2 行`);
    assert.equal(rows[0].likes, 222, "数值保留");
    assert.equal(rows[0].favorites, 444);
    assert.ok(rows.every((r) => r.source === "legacy"), "NULL/空 source 规范为稳定非空 'legacy'");
    db.close();
  }
});

/* ─────────── G：recordReceipt evidence 单编码 + 孤立 token 片段净化 ─────────── */
test("recordReceipt：evidence 只编码一次（读取为对象）；孤立 token=/decodeKey= 片段被净化", async () => {
  const { openKbDb, recordReceipt } = await import("../local-agent/kb.mjs");
  const { makeReceipt } = await import("../local-agent/downloader-adapter.mjs");
  const dir = join(ROOT, "g-db");
  await mkdir(dir, { recursive: true });
  const db = openKbDb(join(dir, "kb.sqlite"));
  const iso = new Date().toISOString();
  const receipt = makeReceipt({
    channel: "kuaidian", startedAt: iso,
    title: "标题带 token=TOKV1 与 https://evil.example/x?encfilekey=EFKV2 和 decodeKey=DKV3",
    error: "错误 auth_key=AKV4 wsSecret=WSV5 token=TOKV6",
    validationEvidence: { ftyp: true, note: "孤立 token=TOKV7 片段", inner: { decodeKey: "DKV8" } },
    sourceUrl: "https://evil.example/v?auth_key=EVILURL",
  });
  recordReceipt(db, receipt, { assetId: null, outcome: "failed_primary:no_fallback" });
  const row = db.prepare("SELECT * FROM download_receipt ORDER BY id DESC LIMIT 1").get();
  // evidence 单编码：JSON.parse 后是对象（不是双重 JSON 字符串）
  assert.equal(row.source_url, null, "非稳定 sourceUrl 不落库");
  const evidence = JSON.parse(row.evidence);
  assert.equal(typeof evidence, "object", "evidence 读取后是对象（只编码一次）");
  const all = JSON.stringify({ title: row.title, error: row.outcome, evidence, observation: row.outcome });
  for (const bad of ["TOKV1", "EFKV2", "DKV3", "AKV4", "WSV5", "TOKV6", "TOKV7", "DKV8", "EVILURL", "evil.example"]) {
    assert.ok(!all.includes(bad), `不应泄漏 ${bad}`);
  }
  assert.ok(!JSON.stringify(evidence).includes("decodeKey"), "敏感键整键剔除");
  db.close();
});

/* ─────────── H：shot/provenance backup 半迁移合并、重开不增长 ─────────── */
test("shot_v3_backup / field_provenance_v2_backup 半迁移残留幂等合并、重开不增长", async () => {
  const { openKbDb } = await import("../local-agent/kb.mjs");
  const dir = join(ROOT, "h-db");
  await mkdir(dir, { recursive: true });
  const dbPath = join(dir, "kb.sqlite");
  let db = openKbDb(dbPath);
  const iso = new Date().toISOString();
  db.prepare("INSERT INTO video_asset (id, title, created_at, updated_at) VALUES ('vaH', 'H资产', ?, ?)").run(iso, iso);
  // 构造半迁移：主表已是新结构（空），backup 残留 1 行
  db.exec("CREATE TABLE shot_v3_backup (id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id TEXT, idx INTEGER, start_ms INTEGER, end_ms INTEGER, shot_size TEXT, camera_angle TEXT, camera_movement TEXT, scene TEXT, composition TEXT, notes TEXT, source TEXT)");
  db.prepare("INSERT INTO shot_v3_backup (asset_id, idx, start_ms, end_ms) VALUES ('vaH', 0, 0, 500)").run();
  db.exec("CREATE TABLE field_provenance_v2_backup (id INTEGER PRIMARY KEY AUTOINCREMENT, asset_id TEXT, field TEXT, source TEXT, available INTEGER, confidence TEXT, limitation TEXT, captured_at TEXT)");
  db.prepare("INSERT INTO field_provenance_v2_backup (asset_id, field, source, available) VALUES ('vaH', 'duration_ms', 'local_media', 1)").run();
  db.close();
  // 重开两次：backup 合并且不增长
  for (let i = 0; i < 2; i++) {
    db = openKbDb(dbPath);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM shot WHERE asset_id='vaH'").get().c, 1, `shot 合并稳定（第 ${i + 1} 次）`);
    assert.equal(db.prepare("SELECT COUNT(*) c FROM field_provenance WHERE asset_id='vaH'").get().c, 1, `field_provenance 合并稳定（第 ${i + 1} 次）`);
    db.close();
  }
});

/* ─────────── D2：OWNER_TX 原子可见性 —— 事务内后半段故障 → 未提交资产整体回滚（先于任何可见性） ─────────── */
test("OWNER_TX 原子可见性：content_analysis 注入故障 → 未提交资产随事务回滚（video_asset=0、无 kb_* 包、无 .staging-*），item failed 且 asset_id=null，receipt 恰 1 条 failed", async () => {
  const { openKbDb, ingestOne, setKbRoot } = await import("../local-agent/kb.mjs");
  const { probeLocalMedia, makeReceipt } = await import("../local-agent/downloader-adapter.mjs");
  const dir = join(ROOT, "d2-db");
  const kbRoot = join(ROOT, "d2-kbroot");
  await mkdir(join(dir, "priv"), { recursive: true });
  await mkdir(kbRoot, { recursive: true });
  setKbRoot(kbRoot);
  const db = openKbDb(join(dir, "kb.sqlite"));
  // 保留两个 trigger：
  // ① 事务内 content_analysis INSERT 注入故障（后半段故障 → OWNER_TX 回滚）
  db.exec("CREATE TRIGGER trg_fail_ca BEFORE INSERT ON content_analysis BEGIN SELECT RAISE(ABORT, 'injected_failure'); END");
  // ② DELETE video_asset 阻止（OWNER_TX 回滚后资产从未提交，本不该触发 —— 若触发说明资产已可见，即回归）
  db.exec("CREATE TRIGGER trg_block_delete BEFORE DELETE ON video_asset BEGIN SELECT RAISE(ABORT, 'block_delete'); END");
  const iso = new Date().toISOString();
  db.prepare("INSERT INTO import_batch (id, status, source_kind, created_at, total, succeeded, failed, skipped) VALUES ('b_d2', 'running', 'test', ?, 1, 0, 0, 0)").run(iso);
  const media = await probeLocalMedia(SANDBOX_MP4);
  const shaD2 = media.sha256;
  const receipt = makeReceipt({
    channel: "kuaidian", localPath: SANDBOX_MP4, sha256: shaD2,
    mediaValidation: media.mediaValidation, startedAt: iso, media, sizeBytes: media.size_bytes,
    title: "回滚可见性测试", temporary: false, validationEvidence: media.container,
  });
  const r = await ingestOne(db, { receipt, input: SANDBOX_MP4, input_kind: "file", batchId: "b_d2", ctx: { privDir: join(dir, "priv"), yuanbaoEnrich: null } });
  assert.equal(r.status, "failed", "整体失败");
  assert.match(String(r.error || ""), /injected_failure/, `应含 injected_failure，实际 ${r.error}`);
  assert.ok(!String(r.error || "").includes("compensation_failed"), "OWNER_TX 回滚优先，不得走 compensation_failed");
  // 未提交资产随事务回滚：video_asset=0（DELETE trigger 无需触发）
  assert.equal(db.prepare("SELECT COUNT(*) c FROM video_asset").get().c, 0, "未提交资产已回滚，video_asset=0");
  // item 终态 failed 且 asset_id=null
  const item = db.prepare("SELECT status, asset_id FROM import_item WHERE batch_id='b_d2'").get();
  assert.equal(item.status, "failed");
  assert.equal(item.asset_id, null, "回滚后 item 不指向任何资产");
  // 该 SHA 恰 1 条 failed receipt：asset_id=null 且无 success outcome
  const receipts = db.prepare("SELECT asset_id, outcome FROM download_receipt WHERE sha256=?").all(shaD2);
  assert.equal(receipts.length, 1, "该 SHA 恰 1 条 receipt");
  assert.equal(receipts[0].asset_id, null, "receipt asset_id 为 null");
  assert.match(String(receipts[0].outcome || ""), /failed/, "receipt outcome 为 failed");
  assert.ok(!String(receipts[0].outcome || "").includes("success"), "无 success outcome");
  // KB root 无 kb_* 包、无 .staging-* 残留
  const { readdir } = await import("node:fs/promises");
  const leftovers = [];
  const scan = async (dirPath, depth) => {
    if (depth > 8) return;
    let entries;
    try { entries = await readdir(dirPath, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === ".DS_Store") continue;
      const p = join(dirPath, e.name);
      if (e.isDirectory()) {
        if (e.name.startsWith("kb_") || e.name.includes(".staging-")) leftovers.push(p);
        await scan(p, depth + 1);
      }
    }
  };
  await scan(kbRoot, 0);
  assert.deepEqual(leftovers, [], `无 kb_* 包与 .staging-* 目录残留：${leftovers.join(",")}`);
  // 原始媒体文件仍存在（temporary=false 不清理源文件）
  const { stat } = await import("node:fs/promises");
  const info = await stat(SANDBOX_MP4);
  assert.ok(info.isFile(), "原始 SANDBOX_MP4 仍存在");
  db.close();
});

/* ─────────── E：/kb/import 非稳定直链 adapter 前置失败可追踪 ─────────── */
test("/kb/import 非稳定直链前置失败：batch total=1/failed=1、item failed、input/display/error 无签名", async () => {
  const dl = "http://127.0.0.1:9/unreachable.mp4?auth_key=IMPTOK";
  const r = await request("/api/v1/kb/import", { method: "POST", body: { links: [dl] } });
  assert.equal(r.status, 202);
  const { batchId } = await r.json();
  await poll(async () => {
    const j = await (await request("/api/v1/kb/imports")).json();
    const b = j.batches.find((x) => x.id === batchId);
    return b && b.status === "done" ? b : null;
  }, { tries: 20, desc: "import 批次终态" });
  const j = await (await request("/api/v1/kb/imports")).json();
  const b = j.batches.find((x) => x.id === batchId);
  assert.equal(b.total, 1, "预建 item → total=1");
  assert.equal(b.failed, 1, "前置失败 → failed=1");
  const item = j.items.find((i) => i.batch_id === batchId);
  assert.ok(item, "失败项可追踪（不再 items=[]）");
  assert.equal(item.status, "failed");
  assert.match(String(item.error || ""), /failed_primary/);
  assert.ok(!JSON.stringify(item).includes("IMPTOK"), "input/display/error 无签名密钥");
});

/* ─────────── B：第二分享 URL 同视频 duplicate → ingest task completed ─────────── */
test("同视频第二分享 URL 经快点导入 duplicate：ingest task 显示 completed 而非 failed", async () => {
  const shareA = "https://weixin.qq.com/sph/dup_a_1";
  const shareB = "https://weixin.qq.com/sph/dup_b_2";
  const ta = await (await request("/api/v1/ingest", { method: "POST", body: { url: shareA } })).json();
  assert.equal(ta.task.status, "awaiting_primary_download");
  await request("/api/v1/kuaidian", { method: "POST", body: { localPath: SANDBOX_MP4, sourceUrl: shareA, title: "首个分享" } });
  await poll(async () => {
    const j = await (await request("/api/v1/tasks")).json();
    const t = j.tasks.find((x) => x.id === ta.task.id);
    return t && t.status === "completed" ? t : null;
  }, { tries: 40, desc: "taskA completed" });

  // 第二分享 URL（同一视频 = 同 sha）
  const tb = await (await request("/api/v1/ingest", { method: "POST", body: { url: shareB } })).json();
  assert.equal(tb.task.status, "awaiting_primary_download");
  await request("/api/v1/kuaidian", { method: "POST", body: { localPath: SANDBOX_MP4, sourceUrl: shareB, title: "第二分享" } });
  await poll(async () => {
    const j = await (await request("/api/v1/tasks")).json();
    const t = j.tasks.find((x) => x.id === tb.task.id);
    return t && t.status === "completed" ? t : null;
  }, { tries: 40, desc: "taskB completed（duplicate 幂等命中不是失败）" });
  const tasks = await (await request("/api/v1/tasks")).json();
  const tB = tasks.tasks.find((x) => x.id === tb.task.id);
  assert.equal(tB.status, "completed", "duplicate 命中 → completed 而非 failed");
  assert.ok(tB.assetId, "从已有资产补 assetId/packagePath");
});

/* ─────────── C：mediaFallback 时快点失败 → task awaiting_fallback_media ─────────── */
test("mediaFallback 配置时快点主通道失败：task 状态 awaiting_fallback_media（非 failed）", async () => {
  const share = "https://weixin.qq.com/sph/fallback_task_c1";
  const t = await (await request("/api/v1/ingest", { method: "POST", body: { url: share } })).json();
  assert.equal(t.task.status, "awaiting_primary_download");
  await request("/api/v1/kuaidian", {
    method: "POST",
    body: { downloadUrl: "http://127.0.0.1:9/unreachable.mp4", sourceUrl: share, title: "fallbackC" },
  });
  await poll(async () => {
    const j = await (await request("/api/v1/tasks")).json();
    const x = j.tasks.find((y) => y.id === t.task.id);
    return x && x.status !== "awaiting_primary_download" ? x : null;
  }, { tries: 30, desc: "task 离开 awaiting_primary_download" });
  const tasks = await (await request("/api/v1/tasks")).json();
  const x = tasks.tasks.find((y) => y.id === t.task.id);
  assert.equal(x.status, "awaiting_fallback_media", "有媒体回退配置时 task 与 item 状态一致");
});

/* ─────────── F：/ingest 同 canonical 去重 + 认领后不重复复用 ─────────── */
test("/ingest 同 canonical 连发两次：复用 1 task（deduplicated）+ 仅 1 pending item；认领后不再复用", async () => {
  const share = "https://weixin.qq.com/sph/dedup_f_1";
  const t1 = await (await request("/api/v1/ingest", { method: "POST", body: { url: share } })).json();
  const t2 = await (await request("/api/v1/ingest", { method: "POST", body: { url: share } })).json();
  assert.equal(t2.task.id, t1.task.id, "同 canonical 复用同一任务");
  assert.equal(t2.task.deduplicated, true, "第二连发标记 deduplicated");
  // 仅 1 个 pending item（该 source 的 awaiting item）
  const j = await (await request("/api/v1/kb/imports")).json();
  const pendingItems = j.items.filter((i) => i.status === "pending" && String(i.displayInput).includes("dedup_f_1"));
  assert.equal(pendingItems.length, 1, "只能有 1 pending item");
  // A4.2：认领后（processing 或已终态）第二个 /kuaidian 必须 deduplicated 复用同 batchId，绝不新建批次/item
  const kd1 = await request("/api/v1/kuaidian", { method: "POST", body: { localPath: SANDBOX_MP4, sourceUrl: share, title: "F认领" } });
  const kd1b = await kd1.json();
  assert.equal(kd1b.batchId, t1.task.batchId, "第一次认领复用原批次");
  const kd2 = await request("/api/v1/kuaidian", { method: "POST", body: { localPath: SANDBOX_MP4, sourceUrl: share, title: "F再认领" } });
  const kd2b = await kd2.json();
  assert.equal(kd2b.batchId, t1.task.batchId, "第二回报 deduplicated 复用同 batchId（不新建批次）");
  assert.equal(kd2b.deduplicated, true, "第二回报明确 deduplicated:true");
  // 该 source 全程只有 1 个 item（不被第二次重复导入覆盖）
  const jj = await (await request("/api/v1/kb/imports")).json();
  const itemsForSource = jj.items.filter((i) => String(i.displayInput).includes("dedup_f_1"));
  assert.equal(itemsForSource.length, 1, "同 source 只有 1 item");
  await poll(async () => {
    const jjj = await (await request("/api/v1/tasks")).json();
    const x = jjj.tasks.find((y) => y.id === t1.task.id);
    return x && x.status === "completed" ? x : null;
  }, { tries: 40, desc: "task completed" });
});

/* ─────────── A4.2：真正 Promise.all 并发去重（不接受顺序模拟）─────────── */

test("真正并发 20 个 /ingest 相同 canonical：全部同一 taskId（19 个 deduplicated），严格 1 task/1 batch/1 item", async () => {
  const share = "https://weixin.qq.com/sph/conc_ingest_1";
  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      request("/api/v1/ingest", { method: "POST", body: { url: share } }).then((r) => r.json())),
  );
  assert.equal(results.every((r) => r.task && r.task.id), true, "全部返回 task");
  const ids = new Set(results.map((r) => r.task.id));
  assert.equal(ids.size, 1, "20 个真正并发全部返回同一 taskId");
  assert.equal(results.filter((r) => r.task.deduplicated === true).length, 19, "其余 19 个标记 deduplicated:true");
  // tasks.json 严格 1 条该 source 任务
  const tasks = await (await request("/api/v1/tasks")).json();
  assert.equal(tasks.tasks.filter((t) => t.sourceUrl === share).length, 1, "严格 1 task");
  // DB 严格 1 batch / 1 item
  const j = await (await request("/api/v1/kb/imports")).json();
  assert.equal(j.items.filter((i) => String(i.displayInput).includes("conc_ingest_1")).length, 1, "严格 1 pending item");
  assert.equal(j.batches.filter((b) => b.id === results[0].task.batchId).length, 1, "严格 1 batch");
});

test("真正并发 2 个 /kuaidian 认领同 source：1 item/1 batch/1 receipt/1 asset，batchId 相同，第二 deduplicated，批次 succeeded=1", async () => {
  const share = "https://weixin.qq.com/sph/conc_kd_1";
  // 先经 /ingest 入队一个 awaiting pending item
  const t = await (await request("/api/v1/ingest", { method: "POST", body: { url: share } })).json();
  assert.equal(t.task.status, "awaiting_primary_download");
  // 独立 sha 文件（避免与前序用例 duplicate）
  const kdFile = join(ROOT, "conc-kd.mp4");
  await copyFile(SANDBOX_MP4, kdFile);
  const { open: openC } = await import("node:fs/promises");
  const fdC = await openC(kdFile, "a");
  await fdC.write("CONC_KD_MARKER");
  await fdC.close();
  // 两个真实并发回报（Promise.all 同时发起）
  const resps = await Promise.all([
    request("/api/v1/kuaidian", { method: "POST", body: { localPath: kdFile, sourceUrl: share, title: "并发认领1" } }),
    request("/api/v1/kuaidian", { method: "POST", body: { localPath: kdFile, sourceUrl: share, title: "并发认领2" } }),
  ]);
  const bodies = await Promise.all(resps.map((r) => r.json()));
  assert.equal(new Set(bodies.map((b) => b.batchId)).size, 1, "两个 HTTP 回应 batchId 相同");
  assert.equal(bodies.filter((b) => b.deduplicated === true).length, 1, "第二个明确 deduplicated:true");
  assert.equal(bodies[0].batchId, t.task.batchId, "复用 /ingest 原批次（不另造批次）");
  // 等待资产入库
  await poll(async () => {
    const v = await (await request("/api/v1/kb/videos")).json();
    return v.items.find((i) => String(i.source_url).includes("conc_kd_1")) ? true : null;
  }, { tries: 60, delay: 400, desc: "并发认领后资产入库" });
  const { openKbDb } = await import("../local-agent/kb.mjs");
  const db = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const itemCount = db.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=?").get(t.task.batchId).c;
  const receiptCount = db.prepare("SELECT COUNT(*) c FROM download_receipt WHERE source_url=?").get(share).c;
  const assetCount = db.prepare("SELECT COUNT(*) c FROM video_asset WHERE source_url=?").get(share).c;
  const statuses = db.prepare("SELECT status FROM import_item WHERE batch_id=?").all(t.task.batchId).map((r) => r.status);
  db.close();
  assert.equal(itemCount, 1, "严格 1 item（第二回报未建新 item）");
  assert.equal(receiptCount, 1, "严格 1 download_receipt（未重复下载/探测）");
  assert.equal(assetCount, 1, "严格 1 asset");
  assert.deepEqual(statuses, ["success"], "原等待批次唯一 item 为 success");
  // 批次计数：succeeded=1（不能被第二次 duplicate 覆盖成 skipped）
  const imps = await (await request("/api/v1/kb/imports")).json();
  const b = imps.batches.find((x) => x.id === t.task.batchId);
  assert.equal(b.status, "done", "批次终态 done");
  assert.equal(b.succeeded, 1, "批次 succeeded=1");
  assert.equal(b.skipped, 0, "批次 skipped=0（无第二 duplicate item）");
});

/* ─────────── A4.2.1：stale processing 崩溃恢复 ─────────── */
test("超 15 分钟 processing 恢复为 pending 并被认领（recovered_stale_processing）；新 processing 不被抢", async () => {
  const { openKbDb } = await import("../local-agent/kb.mjs");
  const dbPath = join(DATA_DIR, "kb.sqlite");
  // ① 手工入队 awaiting pending item，再模拟崩溃：processing + updated_at = 16 分钟前
  const share = "https://weixin.qq.com/sph/stale_1";
  const batchId = `kb_stale_${Date.now()}`;
  const db = openKbDb(dbPath);
  db.prepare("INSERT INTO import_batch (id, status, source_kind, created_at, total, succeeded, failed, skipped) VALUES (?, 'awaiting_primary_download', 'ingest', ?, 1, 0, 0, 0)").run(batchId, new Date().toISOString());
  const itemId = db.prepare("INSERT INTO import_item (batch_id, input, input_kind, display_input, status, error, updated_at) VALUES (?,?,?,?, 'pending', 'awaiting_primary_download: 分享链接等待原版快点产出直链；元宝仅补元数据', ?)")
    .run(batchId, share, "link", share, new Date().toISOString()).lastInsertRowid;
  db.prepare("UPDATE import_item SET status='processing', updated_at=? WHERE id=?").run(new Date(Date.now() - 16 * 60 * 1000).toISOString(), itemId);
  db.close();
  // 再回报：应恢复为 pending 并认领同一 item（非 deduplicated，复用原批次）
  const staleFile = join(ROOT, "stale.mp4");
  await copyFile(SANDBOX_MP4, staleFile);
  const r = await request("/api/v1/kuaidian", { method: "POST", body: { localPath: staleFile, sourceUrl: share, title: "stale恢复" } });
  const b = await r.json();
  assert.equal(r.status, 202);
  assert.notEqual(b.deduplicated, true, "stale processing 应被恢复并正常认领（不是 deduplicated）");
  assert.equal(b.batchId, batchId, "复用原批次，不新建");
  // 等待完成：item 进入终态（同 sha 前面已导入 → 可能是 success 或 duplicate；error 不含 recovered_stale_processing）
  await poll(async () => {
    const d2 = openKbDb(dbPath);
    const row = d2.prepare("SELECT status, error FROM import_item WHERE id=?").get(itemId);
    d2.close();
    return row && ["success", "duplicate", "linked", "failed"].includes(row.status) ? row : null;
  }, { tries: 40, delay: 400, desc: "stale item 恢复后进入终态" });
  const d3 = openKbDb(dbPath);
  const fin = d3.prepare("SELECT status, error FROM import_item WHERE id=?").get(itemId);
  d3.close();
  assert.ok(["success", "duplicate"].includes(fin.status), `恢复后 item 终态应为 success/duplicate，实际 ${fin.status}`);
  assert.ok(!String(fin.error || "").includes("recovered_stale_processing"), "终态后 error 清空 recovered 说明");
  // ② 新 processing 边界：<15min 的 processing 绝不能被恢复/抢
  const share2 = "https://weixin.qq.com/sph/fresh_processing_1";
  const b2 = `kb_fresh_${Date.now()}`;
  const d4 = openKbDb(dbPath);
  d4.prepare("INSERT INTO import_batch (id, status, source_kind, created_at, total, succeeded, failed, skipped) VALUES (?, 'awaiting_primary_download', 'ingest', ?, 1, 0, 0, 0)").run(b2, new Date().toISOString());
  const it2 = d4.prepare("INSERT INTO import_item (batch_id, input, input_kind, display_input, status, error, updated_at) VALUES (?,?,?,?, 'pending', 'awaiting_primary_download: x', ?)")
    .run(b2, share2, "link", share2, new Date().toISOString()).lastInsertRowid;
  d4.close();
  const f1 = await request("/api/v1/kuaidian", { method: "POST", body: { localPath: staleFile, sourceUrl: share2, title: "fresh1" } });
  const f1b = await f1.json();
  assert.equal(f1b.batchId, b2, "fresh 认领复用原批次");
  // 把 updated_at 改为 10 分钟前（仍 <15min 边界内）→ 再回报必须 deduplicated，绝不恢复/抢
  const d5 = openKbDb(dbPath);
  d5.prepare("UPDATE import_item SET updated_at=? WHERE id=?").run(new Date(Date.now() - 10 * 60 * 1000).toISOString(), it2);
  d5.close();
  const f2 = await request("/api/v1/kuaidian", { method: "POST", body: { localPath: staleFile, sourceUrl: share2, title: "fresh2" } });
  const f2b = await f2.json();
  assert.equal(f2b.deduplicated, true, "10 分钟前认领的 processing（<15min）不被恢复/抢");
  assert.equal(f2b.batchId, b2, "仍复用同一 batchId");
});
