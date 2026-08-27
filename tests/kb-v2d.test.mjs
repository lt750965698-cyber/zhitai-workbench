/**
 * kb-v2d.test.mjs — A4.3-A/B 回归：/kuaidian 无预先等待项时的原子认领（P0 收口）+ 投递 ID 分离
 *
 * A（A4.3-A）：全新隔离库、**没有**预先 /ingest 等待项，20 个真正并发 Promise.all POST
 *   /api/v1/kuaidian，相同合法 sourceUrl + 相同 localPath → 严格 1 batch/1 item/1 receipt/1 asset。
 * B（A4.3-B）：okd[].m（微信 MsgId）只作为 deliveryId，绝不进入平台 contentId/标题/sourceUrl；
 *   import_item.delivery_id + partial UNIQUE index；/kuaidian 按 deliveryId 优先原子认领；
 *   显式 contentId 覆盖 adapter 推导值（不拒绝/不忽略）；非空非法 deliveryId → 400 invalid_delivery_id；
 *   复用 pending/processing item 时事务内绑定 delivery_id；迁移幂等 + 索引生效。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, writeFile, copyFile, rm, readFile, open as openFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { findPackageDir } from "./helpers.mjs";

const testsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(testsDir);
const AGENT_ENTRY = join(repoRoot, "local-agent", "server.mjs");
const TEST_MP4 = join(testsDir, "fixtures", "media", "sample-faststart.mp4");
const MOCK_ENRICH = join(testsDir, "fixtures", "mock-enrich.mjs");

const ROOT = join(tmpdir(), `kb_v2d_test_${Date.now()}`);
const DATA_DIR = join(ROOT, "data");
const KB_ROOT = join(ROOT, "kbroot");
const SANDBOX_MP4 = join(ROOT, "sandbox.mp4");
const WATCH_DIR = join(ROOT, "watch"); // 主 server 的显式隔离 watcher 目录（roots 非空）

let server;
let baseUrl;
let port;
let serverErr = "";

function request(path, { method = "GET", headers = {}, body } = {}) {
  return fetch(`${baseUrl}${path}`, {
    method,
    headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
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
  await mkdir(WATCH_DIR, { recursive: true }); // 显式隔离 watcher 目录（roots 禁止为空，避免回退真实默认目录）
  await copyFile(TEST_MP4, SANDBOX_MP4);
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
    mediaFallback: { enabled: false, providers: [] },
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

/* ─────────── A4.3-A：无预先等待项，20 并发同 source+localPath → 严格 1 套 ─────────── */
test("无预先 /ingest：20 并发同 sourceUrl+localPath → 1 batch/1 item/1 receipt/1 asset，19 deduplicated，响应 batchId/itemId 完全一致", async () => {
  const share = "https://weixin.qq.com/sph/atomic_claim_v2d_1";
  // 全新隔离库、无预先等待项：直接 20 个真正并发 POST（Promise.all 同时发起）
  const resps = await Promise.all(
    Array.from({ length: 20 }, () =>
      request("/api/v1/kuaidian", { method: "POST", body: { localPath: SANDBOX_MP4, sourceUrl: share, title: "原子认领并发" } })),
  );
  assert.equal(resps.every((r) => r.status === 202), true, "全部 202");
  const bodies = await Promise.all(resps.map((r) => r.json()));

  // 响应契约：统一 {batchId, itemId, deduplicated, ...}
  assert.equal(bodies.every((b) => b.batchId && b.itemId != null), true, "响应都携带 batchId+itemId");
  const batchIds = new Set(bodies.map((b) => b.batchId));
  const itemIds = new Set(bodies.map((b) => b.itemId));
  assert.equal(batchIds.size, 1, "20 个响应 batchId 完全相同");
  assert.equal(itemIds.size, 1, "20 个响应 itemId 完全相同");
  assert.equal(bodies.filter((b) => b.deduplicated === true).length, 19, "恰 19 个 deduplicated:true");
  assert.equal(bodies.filter((b) => b.deduplicated !== true).length, 1, "恰 1 个非 deduplicated（唯一认领者）");
  const batchId = bodies[0].batchId;
  const itemId = bodies[0].itemId;

  // 等待该 item 落终态
  const { openKbDb } = await import("../local-agent/kb.mjs");
  await poll(async () => {
    const db = openKbDb(join(DATA_DIR, "kb.sqlite"));
    const row = db.prepare("SELECT status FROM import_item WHERE id=?").get(itemId);
    db.close();
    return row && ["success", "duplicate", "linked", "failed"].includes(row.status) ? row : null;
  }, { tries: 60, delay: 400, desc: "item 终态" });

  // 严格计数：1 batch / 1 item / 1 receipt / 1 asset
  const db = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const batchCount = db.prepare("SELECT COUNT(*) c FROM import_batch WHERE id=?").get(batchId).c;
  const itemCount = db.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=?").get(batchId).c;
  const itemBySource = db.prepare("SELECT COUNT(*) c FROM import_item WHERE (input=? OR display_input=?)").get(share, share).c;
  const receiptCount = db.prepare("SELECT COUNT(*) c FROM download_receipt WHERE source_url=?").get(share).c;
  const assetCount = db.prepare("SELECT COUNT(*) c FROM video_asset WHERE source_url=?").get(share).c;
  const itemRow = db.prepare("SELECT status, asset_id FROM import_item WHERE id=?").get(itemId);
  db.close();

  assert.equal(batchCount, 1, "严格 1 batch");
  assert.equal(itemCount, 1, "严格 1 item（batch 内）");
  assert.equal(itemBySource, 1, "严格 1 item（按 source 查重键）");
  assert.equal(receiptCount, 1, "严格 1 download_receipt（只有认领者跑过 adapter/ingest）");
  assert.equal(assetCount, 1, "严格 1 video_asset（同 SHA 资产唯一）");
  assert.ok(["success", "duplicate", "linked"].includes(itemRow.status), `item 终态应为 success/duplicate/linked，实际 ${itemRow.status}`);
  assert.ok(itemRow.asset_id, "item 关联 asset_id");
});

/* ─────────── 工具：生成独立 sha 的 mp4（追加标记字节，避免与 A 用例资产冲突） ─────────── */
async function makeDistinctMp4(name, marker) {
  const p = join(ROOT, name);
  await copyFile(SANDBOX_MP4, p);
  const fd = await openFile(p, "a");
  await fd.write(marker);
  await fd.close();
  return p;
}

/* ─────────── 公共：20 并发同键 → 断言响应严格一致 + DB 严格 1 套 ─────────── */
async function assertOneSetFor20(body) {
  const resps = await Promise.all(
    Array.from({ length: 20 }, () =>
      request("/api/v1/kuaidian", { method: "POST", body }).then(async (r) => {
        assert.equal(r.status, 202, "全部 202");
        return r.json();
      })),
  );
  assert.equal(resps.every((b) => b.batchId && b.itemId != null), true, "响应都携带 batchId+itemId");
  assert.equal(new Set(resps.map((b) => b.batchId)).size, 1, "20 个响应 batchId 完全相同");
  assert.equal(new Set(resps.map((b) => b.itemId)).size, 1, "20 个响应 itemId 完全相同");
  assert.equal(resps.filter((b) => b.deduplicated === true).length, 19, "恰 19 个 deduplicated:true");
  assert.equal(resps.filter((b) => b.deduplicated !== true).length, 1, "恰 1 个非 deduplicated（唯一认领者）");
  return { batchId: resps[0].batchId, itemId: resps[0].itemId };
}

async function waitItemTerminal(itemId) {
  const { openKbDb } = await import("../local-agent/kb.mjs");
  await poll(async () => {
    const db = openKbDb(join(DATA_DIR, "kb.sqlite"));
    const row = db.prepare("SELECT status FROM import_item WHERE id=?").get(itemId);
    db.close();
    return row && ["success", "duplicate", "linked", "failed"].includes(row.status) ? row : null;
  }, { tries: 60, delay: 400, desc: "item 终态" });
}

/* ─────────── B1：companion 纯函数 —— okd[].m 只作为 deliveryId，不冒充 contentId ─────────── */
test("companion collectReports：okd[].m 只变 deliveryId（无 contentId 键）；sourceUrl 保持；不 patch alert", async () => {
  const code = await readFile(join(repoRoot, "local-agent", "zhitai-kuaidian-companion.user.js"), "utf8");
  assert.ok(!code.includes("alert("), "companion 不得 patch alert");
  assert.ok(code.includes("deliveryId"), "伴生桥必须发送 deliveryId");
  assert.ok(!code.includes("contentId: item.m"), "okd[].m 绝不再发 contentId: item.m");
  // VM 注入（与 kb-v2a ⑪ 同构）：最小 DOM/localStorage/GM stub
  const ctx = { data: {} };
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
  const windowObj = {};
  const fn = new Function("window", "document", "localStorage", "GM_getValue", "GM_setValue", "GM_xmlhttpRequest", "DOMParser", "setTimeout", "setInterval", src);
  const localStorage = { getItem: (k) => ctx.data[k] || null, setItem: (k, v) => { ctx.data[k] = v; } };
  const GM_getValue = (k, d) => ctx.data[k] || d;
  const GM_setValue = (k, v) => { ctx.data[k] = v; };
  const GM_xmlhttpRequest = () => {};
  const documentStub = { createElement: () => ({ getElementsByTagName: () => [] }), documentElement: {} };
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
  for (const r of reports) {
    assert.ok(!("contentId" in r), "collectReports 输出不得含 contentId 键");
    assert.ok(r.deliveryId, "输出必须含 deliveryId");
  }
  const r1 = reports.find((x) => x.msgId === "msg1");
  assert.equal(r1.deliveryId, "msg1", "deliveryId = okd[].m（MsgId）");
  assert.equal(r1.sourceUrl, "https://weixin.qq.com/sph/real_share_1", "sourceUrl 仍从消息 XML 提取");
  const r2 = reports.find((x) => x.msgId === "msg2");
  assert.equal(r2.deliveryId, "msg2");
  assert.equal(r2.sourceUrl, null, "取不到分享 URL → sourceUrl=null");
  // 增量：已上报的 msg1 不再上报
  const reports2 = windowObj.__zhitaiCompanion.collectReports(ctx.data.okd, ctx.data.spD, ["msg1"]);
  assert.equal(reports2.length, 1);
  assert.equal(reports2[0].msgId, "msg2");
});

/* ─────────── B2：20 并发同 deliveryId + localPath（无 sourceUrl）→ 严格 1 套 ─────────── */
test("无 sourceUrl：20 并发同 deliveryId+localPath → 1 batch/1 item/1 receipt/1 asset，19 dedup，ID 一致，delivery_id 落库", async () => {
  const deliveryId = "msg_b2_nosource_123456";
  const localPath = await makeDistinctMp4("b2-nosource.mp4", "V2D_B2_NOSOURCE_MARKER");
  const { batchId, itemId } = await assertOneSetFor20({ localPath, deliveryId, title: "B2投递" });
  await waitItemTerminal(itemId);

  const { openKbDb } = await import("../local-agent/kb.mjs");
  const db = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const batchCount = db.prepare("SELECT COUNT(*) c FROM import_batch WHERE id=?").get(batchId).c;
  const itemCount = db.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=?").get(batchId).c;
  const itemRow = db.prepare("SELECT status, asset_id, delivery_id, input, display_input FROM import_item WHERE id=?").get(itemId);
  const asset = db.prepare("SELECT id, content_id, title FROM video_asset WHERE id=?").get(itemRow.asset_id);
  const receiptCount = db.prepare("SELECT COUNT(*) c FROM download_receipt WHERE asset_id=?").get(itemRow.asset_id).c;
  db.close();
  assert.equal(batchCount, 1, "严格 1 batch");
  assert.equal(itemCount, 1, "严格 1 item");
  assert.ok(["success", "duplicate", "linked"].includes(itemRow.status), `终态 ${itemRow.status}`);
  assert.equal(itemRow.delivery_id, deliveryId, "deliveryId 落 import_item.delivery_id");
  assert.ok(asset.content_id == null, "无 sourceUrl → content_id 为 null（MsgId 不得进入）");
  assert.ok(!String(asset.title).includes(deliveryId), "MsgId 不得进入标题");
  assert.ok(!String(itemRow.input).includes(deliveryId) && !String(itemRow.display_input).includes(deliveryId), "MsgId 不得进入 item input/display_input");
  assert.equal(receiptCount, 1, "严格 1 receipt（只有认领者跑过 adapter/ingest）");
});

/* ─────────── B3：20 并发同 deliveryId + sourceUrl + localPath → 严格 1 套 + deliveryId 零泄漏 ─────────── */
test("带 sourceUrl：20 并发同 deliveryId+localPath+sourceUrl → 1 batch/1 item/1 receipt/1 asset；MsgId 零泄漏（contentId 走平台推导）", async () => {
  const deliveryId = "msg_b3_withsource_654321";
  const sourceUrl = "https://weixin.qq.com/sph/atomic_claim_v2d_b3";
  const localPath = await makeDistinctMp4("b3-withsource.mp4", "V2D_B3_WITHSOURCE_MARKER");
  const { batchId, itemId } = await assertOneSetFor20({ localPath, deliveryId, sourceUrl, title: "B3投递" });
  await waitItemTerminal(itemId);

  const { openKbDb } = await import("../local-agent/kb.mjs");
  const db = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const batchCount = db.prepare("SELECT COUNT(*) c FROM import_batch WHERE id=?").get(batchId).c;
  const itemCount = db.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=?").get(batchId).c;
  const itemRow = db.prepare("SELECT status, asset_id, delivery_id FROM import_item WHERE id=?").get(itemId);
  const asset = db.prepare("SELECT id, content_id, title FROM video_asset WHERE id=?").get(itemRow.asset_id);
  const assetCount = db.prepare("SELECT COUNT(*) c FROM video_asset WHERE id=?").get(itemRow.asset_id).c;
  const receiptCount = db.prepare("SELECT COUNT(*) c FROM download_receipt WHERE asset_id=?").get(itemRow.asset_id).c;
  const post = db.prepare("SELECT content_id FROM platform_post WHERE asset_id=?").all(itemRow.asset_id);
  const receiptContent = db.prepare("SELECT content_id FROM download_receipt WHERE asset_id=?").all(itemRow.asset_id);
  db.close();
  assert.equal(batchCount, 1, "严格 1 batch");
  assert.equal(itemCount, 1, "严格 1 item");
  assert.ok(["success", "duplicate", "linked"].includes(itemRow.status), `终态 ${itemRow.status}`);
  assert.equal(itemRow.delivery_id, deliveryId, "deliveryId 落 import_item.delivery_id");
  assert.equal(assetCount, 1, "严格 1 asset");
  assert.equal(receiptCount, 1, "严格 1 receipt");
  // deliveryId（MsgId）零泄漏：content_id 必须来自平台推导，不是 MsgId
  assert.equal(asset.content_id, "wechat_channels:sph:atomic_claim_v2d_b3", "video_asset.content_id = 平台推导（非 MsgId）");
  assert.ok(!String(asset.title).includes(deliveryId), "MsgId 不得进入标题");
  for (const p of post) assert.ok(!String(p.content_id).includes(deliveryId), "platform_post.content_id 不得含 MsgId");
  for (const r of receiptContent) assert.ok(!String(r.content_id).includes(deliveryId), "download_receipt.content_id 不得含 MsgId");
  // 包 metadata.json 的 contentId 也不得含 MsgId
  const pkgDir = await findPackageDir(KB_ROOT, itemRow.asset_id);
  assert.ok(pkgDir, "winner 包仍存在");
  const meta = JSON.parse(await readFile(join(pkgDir, "metadata.json"), "utf8"));
  assert.ok(!String(meta.identity?.contentId || "").includes(deliveryId), "metadata identity.contentId 不得含 MsgId");
  assert.equal(meta.identity.contentId, "wechat_channels:sph:atomic_claim_v2d_b3", "metadata contentId 走平台推导");
});

/* ─────────── B4：显式平台 contentId 向后兼容，且与 deliveryId 独立（不互拷/不互退） ─────────── */
test("显式 contentId 向后兼容：无推导时填充、有推导时覆盖；与 deliveryId 独立，绝不互拷/互退", async () => {
  const { openKbDb } = await import("../local-agent/kb.mjs");
  // 场景 1：无 sourceUrl（adapter 不推导）→ 显式 contentId 生效；未发 deliveryId → delivery_id 保持 null（不互退）
  const explicit = "explicit_platform_content_b4a";
  const localA = await makeDistinctMp4("b4a-explicit.mp4", "V2D_B4A_MARKER");
  const rA = await request("/api/v1/kuaidian", { method: "POST", body: { localPath: localA, contentId: explicit, title: "B4A" } });
  assert.equal(rA.status, 202, "显式 contentId 请求必须被接受（不拒绝/不忽略）");
  const bA = await rA.json();
  await waitItemTerminal(bA.itemId);
  const db1 = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const rowA = db1.prepare("SELECT status, asset_id, delivery_id FROM import_item WHERE id=?").get(bA.itemId);
  const assetA = db1.prepare("SELECT content_id, title FROM video_asset WHERE id=?").get(rowA.asset_id);
  const receiptA = db1.prepare("SELECT content_id FROM download_receipt WHERE asset_id=?").get(rowA.asset_id);
  db1.close();
  assert.equal(assetA.content_id, explicit, "显式 contentId 进 video_asset.content_id（无推导值时填充）");
  assert.equal(receiptA.content_id, explicit, "显式 contentId 进 download_receipt.content_id");
  assert.equal(rowA.delivery_id, null, "未发 deliveryId → delivery_id 为 null（contentId 不互退成 deliveryId）");
  assert.ok(!String(assetA.title).includes(explicit), "contentId 不进标题");

  // 场景 2：deliveryId + contentId + sourceUrl 并存 → 各自独立；MsgId 绝不进入 content_id（不互拷）
  const deliveryId = "msg_b4b_explicit_345678";
  const sourceUrl = "https://weixin.qq.com/sph/atomic_claim_v2d_b4b";
  const localB = await makeDistinctMp4("b4b-explicit.mp4", "V2D_B4B_MARKER");
  const { batchId, itemId } = await assertOneSetFor20({ localPath: localB, deliveryId, contentId: "explicit_platform_content_b4b", sourceUrl, title: "B4B" });
  await waitItemTerminal(itemId);
  const db2 = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const batchCount = db2.prepare("SELECT COUNT(*) c FROM import_batch WHERE id=?").get(batchId).c;
  const itemCount = db2.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=?").get(batchId).c;
  const rowB = db2.prepare("SELECT status, asset_id, delivery_id FROM import_item WHERE id=?").get(itemId);
  const assetB = db2.prepare("SELECT content_id, title FROM video_asset WHERE id=?").get(rowB.asset_id);
  const receiptB = db2.prepare("SELECT content_id FROM download_receipt WHERE asset_id=?").get(rowB.asset_id);
  db2.close();
  assert.equal(batchCount, 1, "严格 1 batch");
  assert.equal(itemCount, 1, "严格 1 item");
  assert.ok(["success", "duplicate", "linked"].includes(rowB.status), `终态 ${rowB.status}`);
  assert.equal(rowB.delivery_id, deliveryId, "deliveryId 只落 import_item.delivery_id");
  // 显式 contentId 必须覆盖 adapter 推导值：video_asset / download_receipt / metadata 均为显式值；
  // 且绝不为 MsgId（deliveryId 不互拷进 contentId）
  assert.equal(assetB.content_id, "explicit_platform_content_b4b", "显式 contentId 覆盖推导值，进 video_asset.content_id");
  assert.ok(!String(assetB.content_id).includes(deliveryId), "deliveryId 绝不复制进 contentId");
  assert.ok(!String(assetB.title).includes(deliveryId), "MsgId 不得进入标题");
  assert.equal(receiptB.content_id, "explicit_platform_content_b4b", "显式 contentId 进 download_receipt.content_id（覆盖推导）");
  const pkgDir = await findPackageDir(KB_ROOT, rowB.asset_id);
  assert.ok(pkgDir, "winner 包仍存在");
  const meta = JSON.parse(await readFile(join(pkgDir, "metadata.json"), "utf8"));
  assert.equal(meta.identity?.contentId, "explicit_platform_content_b4b", "metadata identity.contentId = 显式值（覆盖推导）");
  assert.ok(!String(meta.identity?.contentId || "").includes(deliveryId), "metadata 不得含 MsgId");
});

/* ─────────── B5：预先 /ingest 等待项 + sourceUrl+deliveryId 回报 → 复用同 batch/item 并事务内绑定 delivery_id ─────────── */
test("预先 /ingest 等待项：sourceUrl+deliveryId 回报复用同 batch/item，delivery_id 绑定到复用 item", async () => {
  const share = "https://weixin.qq.com/sph/claim_bind_v2d_b5";
  const deliveryId = "msg_b5_preingest_112233";
  const t = await (await request("/api/v1/ingest", { method: "POST", body: { url: share } })).json();
  assert.equal(t.task.status, "awaiting_primary_download", "预先等待任务就绪");
  const preBatchId = t.task.batchId;
  const { openKbDb } = await import("../local-agent/kb.mjs");
  const db0 = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const preItem = db0.prepare("SELECT id, delivery_id FROM import_item WHERE batch_id=?").get(preBatchId);
  db0.close();
  assert.ok(preItem, "预先等待项存在");
  assert.equal(preItem.delivery_id, null, "预先等待项初始未绑定 delivery_id");

  const localPath = await makeDistinctMp4("b5-bind.mp4", "V2D_B5_BIND_MARKER");
  const r = await request("/api/v1/kuaidian", { method: "POST", body: { localPath, sourceUrl: share, deliveryId, title: "B5绑定" } });
  assert.equal(r.status, 202);
  const b = await r.json();
  assert.equal(b.batchId, preBatchId, "复用预先 /ingest 的 batch（不另造）");
  assert.equal(b.itemId, preItem.id, "复用同一 item（不新建）");
  assert.notEqual(b.deduplicated, true, "认领 pending 不算 deduplicated");
  await waitItemTerminal(b.itemId);
  const db = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const item = db.prepare("SELECT status, delivery_id, asset_id FROM import_item WHERE id=?").get(b.itemId);
  const itemCount = db.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=?").get(preBatchId).c;
  db.close();
  assert.ok(["success", "duplicate", "linked"].includes(item.status), `终态 ${item.status}`);
  assert.equal(item.delivery_id, deliveryId, "delivery_id 已绑定到复用 item");
  assert.equal(itemCount, 1, "仍严格 1 item（不另造）");
  assert.ok(item.asset_id, "item 关联资产");
});

/* ─────────── B6：非空非法 deliveryId → 400 invalid_delivery_id（绝不静默置 null 落非原子路径） ─────────── */
test("非空非法 deliveryId（非法字符/超长）→ 400 invalid_delivery_id，不建 batch/item", async () => {
  const { openKbDb } = await import("../local-agent/kb.mjs");
  const db0 = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const itemsBefore = db0.prepare("SELECT COUNT(*) c FROM import_item").get().c;
  const batchesBefore = db0.prepare("SELECT COUNT(*) c FROM import_batch").get().c;
  db0.close();
  const badValues = ["msg-1!bad", "x".repeat(129), "bad id with spaces", 12345];
  for (const bad of badValues) {
    const r = await request("/api/v1/kuaidian", { method: "POST", body: { localPath: SANDBOX_MP4, deliveryId: bad, title: "非法delivery" } });
    assert.equal(r.status, 400, `非法 deliveryId ${JSON.stringify(String(bad).slice(0, 16))} 应 400`);
    const j = await r.json();
    assert.equal(j.error, "invalid_delivery_id", "错误码必须为 invalid_delivery_id");
  }
  const db1 = openKbDb(join(DATA_DIR, "kb.sqlite"));
  assert.equal(db1.prepare("SELECT COUNT(*) c FROM import_item").get().c, itemsBefore, "400 不得新增 item（未落入非原子路径）");
  assert.equal(db1.prepare("SELECT COUNT(*) c FROM import_batch").get().c, batchesBefore, "400 不得新增 batch");
  db1.close();
});

/* ─────────── B7：delivery_id 迁移幂等 + 非 NULL partial UNIQUE index 重开后存在且生效 ─────────── */
test("delivery_id 迁移幂等：重开后列与 partial UNIQUE index 仍在；同 delivery_id 第二次插入被拒，NULL 可多行", async () => {
  const { openKbDb } = await import("../local-agent/kb.mjs");
  const dir = join(ROOT, "mig-db");
  await mkdir(dir, { recursive: true });
  const dbPath = join(dir, "kb.sqlite");
  const iso = new Date().toISOString();
  let db = openKbDb(dbPath);
  let cols = db.prepare("PRAGMA table_info(import_item)").all().map((c) => c.name);
  assert.ok(cols.includes("delivery_id"), "delivery_id 列存在");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name='ux_import_item_delivery_id'").get().c, 1, "partial UNIQUE index 存在");
  // 索引真实生效：同 delivery_id 第二次插入必须被拒
  db.prepare("INSERT INTO import_batch (id, status, source_kind, created_at, total, succeeded, failed, skipped) VALUES ('b_mig', 'running', 'test', ?, 1, 0, 0, 0)").run(iso);
  db.prepare("INSERT INTO import_item (batch_id, input, input_kind, delivery_id, status, updated_at) VALUES ('b_mig', 'in1', 'file', 'dup_delivery', 'pending', ?)").run(iso);
  assert.throws(
    () => db.prepare("INSERT INTO import_item (batch_id, input, input_kind, delivery_id, status, updated_at) VALUES ('b_mig', 'in2', 'file', 'dup_delivery', 'pending', ?)").run(iso),
    /UNIQUE/i,
    "同 delivery_id 第二次插入必须被唯一索引拒绝",
  );
  // partial：NULL 可多行（索引只约束非 NULL）
  db.prepare("INSERT INTO import_item (batch_id, input, input_kind, delivery_id, status, updated_at) VALUES ('b_mig', 'in3', 'file', NULL, 'pending', ?)").run(iso);
  db.close();
  // 重开（迁移幂等）：列与索引仍在，不重复创建
  db = openKbDb(dbPath);
  cols = db.prepare("PRAGMA table_info(import_item)").all().map((c) => c.name);
  assert.ok(cols.includes("delivery_id"), "重开后 delivery_id 列仍在");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name='ux_import_item_delivery_id'").get().c, 1, "重开不重复建索引");
  db.close();
});

/* ─────────── 工具：递归枚举全部目录路径（快照对比用；能发现空/半成品 staging，不依赖 metadata.json） ─────────── */
async function listAllDirs(root, depth = 0, out = []) {
  if (depth > 10) return out;
  const { readdir } = await import("node:fs/promises");
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === ".DS_Store") continue;
    const p = join(root, e.name);
    if (e.isDirectory()) {
      out.push(p);
      await listAllDirs(p, depth + 1, out);
    }
  }
  return out;
}

/* ─────────── C1a：12 个不同投递事实并发同字节 → 严格 1 asset；12 batch/12 item/12 receipt；无残留 staging ─────────── */
test("C1a：12 并发不同 sourceUrl+deliveryId、同字节媒体 → 1 asset；12 batch/12 item/12 receipt；1 success+11 duplicate/linked；无残留 staging", async () => {
  const localPath = await makeDistinctMp4("c1a-same-bytes.mp4", "V2D_C1A_SAME_BYTES_MARKER");
  const { createHash } = await import("node:crypto");
  const shaC1 = createHash("sha256").update(await readFile(localPath)).digest("hex");
  const N = 12;
  // 目录全量快照：C1a 之前递归所有目录（含空目录），事后对比可发现任何新增 .staging-*（含空/半成品）
  const dirsBefore = new Set(await listAllDirs(KB_ROOT));
  // 12 个真正并发：各自不同 sourceUrl + 不同 deliveryId，同一 media 字节
  const bodies = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      request("/api/v1/kuaidian", { method: "POST", body: { localPath, sourceUrl: `https://weixin.qq.com/sph/c1a_fact_${i}`, deliveryId: `msg_c1a_${i}`, title: `C1a事实${i}` } })
        .then(async (r) => { assert.equal(r.status, 202, `第 ${i} 个请求应 202`); return r.json(); })),
  );
  const batchIds = bodies.map((b) => b.batchId);
  const itemIds = bodies.map((b) => b.itemId);
  assert.equal(new Set(batchIds).size, N, "12 个不同 batch");
  assert.equal(new Set(itemIds).size, N, "12 个不同 item");
  assert.equal(bodies.filter((b) => b.deduplicated === true).length, 0, "12 个不同事实各自认领（无 dedup）");

  // 等待该组（delivery_id LIKE 'msg_c1a_%'）12 个 item 全部终态
  const { openKbDb } = await import("../local-agent/kb.mjs");
  await poll(async () => {
    const db = openKbDb(join(DATA_DIR, "kb.sqlite"));
    const total = db.prepare("SELECT COUNT(*) c FROM import_item WHERE delivery_id LIKE 'msg_c1a_%'").get().c;
    const done = db.prepare("SELECT COUNT(*) c FROM import_item WHERE delivery_id LIKE 'msg_c1a_%' AND status IN ('success','duplicate','linked','failed')").get().c;
    db.close();
    return total === N && done === N ? true : null;
  }, { tries: 90, delay: 400, desc: "12 items 全部终态" });

  // 计数全部按前缀（delivery_id / source_url），响应 ID IN 之外的隐藏行也会被计入，无法漏网
  const db = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const items = db.prepare("SELECT id, status, asset_id FROM import_item WHERE delivery_id LIKE 'msg_c1a_%' ORDER BY id").all();
  const batchCount = db.prepare("SELECT COUNT(DISTINCT i.batch_id) c FROM import_item i WHERE i.delivery_id LIKE 'msg_c1a_%'").get().c;
  const itemCount = db.prepare("SELECT COUNT(*) c FROM import_item WHERE delivery_id LIKE 'msg_c1a_%'").get().c;
  const receiptCount = db.prepare("SELECT COUNT(*) c FROM download_receipt WHERE source_url LIKE '%/c1a_fact_%'").get().c;
  const assetRows = db.prepare("SELECT id FROM video_asset WHERE sha256=?").all(shaC1);
  db.close();
  assert.equal(batchCount, N, "严格 12 batch（按 delivery_id 前缀 join import_item）");
  assert.equal(itemCount, N, "严格 12 item（按 delivery_id 前缀）");
  assert.equal(receiptCount, N, "严格 12 receipt（按 c1a source 前缀）");
  assert.equal(assetRows.length, 1, "严格 1 asset（同 SHA 媒体唯一）");
  const assetId = assetRows[0].id;
  const statuses = items.map((i) => i.status);
  assert.equal(statuses.filter((s) => s === "success").length, 1, "恰 1 个资产创建者 success");
  assert.equal(statuses.filter((s) => s === "duplicate" || s === "linked").length, N - 1, "其余 11 个 duplicate/linked");
  assert.equal(items.every((i) => i.asset_id === assetId), true, "所有终态 item 指向同一 asset");

  // 目录对比：零新增 .staging-*（含空/半成品 staging）；恰 1 个新增 kb_* 包目录（winner 包仍存在且 SHA 为本组）
  const dirsAfter = await listAllDirs(KB_ROOT);
  const newDirs = dirsAfter.filter((d) => !dirsBefore.has(d));
  assert.equal(newDirs.filter((d) => d.includes(".staging-")).length, 0, "零新增 .staging-* 目录（含空/半成品 staging）");
  const kbPkgs = newDirs.filter((d) => basename(d).startsWith("kb_") && !d.includes(".staging-"));
  assert.equal(kbPkgs.length, 1, "恰 1 个新增 kb_* 包目录");
  const meta = JSON.parse(await readFile(join(kbPkgs[0], "metadata.json"), "utf8"));
  assert.equal(meta.identity?.primaryAssetSha256, shaC1, "新增包为本组 SHA 的 winner 包（仍存在）");
});

/* ─────────── C1b：video_asset.sha256 非空 partial UNIQUE index（干净库创建；历史重复组跳过且不动数据） ─────────── */
test("C1b：干净库重开索引恰 1 个、拒绝重复非空 SHA、NULL/空 SHA 可多行；历史重复 SHA 组开库不抛错、索引缺席、行与文件逐字节不变", async () => {
  const { openKbDb } = await import("../local-agent/kb.mjs");
  const iso = new Date().toISOString();

  // 场景 (a)：干净库 → 索引创建且幂等
  const dirA = join(ROOT, "c1b-clean");
  await mkdir(dirA, { recursive: true });
  const dbPathA = join(dirA, "kb.sqlite");
  let db = openKbDb(dbPathA);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name='ux_video_asset_sha256'").get().c, 1, "干净库索引存在 1 个");
  db.prepare("INSERT INTO video_asset (id, sha256, title, created_at, updated_at) VALUES ('clean1', 'SHACLEAN', 'cleanA', ?, ?)").run(iso, iso);
  assert.throws(
    () => db.prepare("INSERT INTO video_asset (id, sha256, title, created_at, updated_at) VALUES ('clean2', 'SHACLEAN', 'cleanB', ?, ?)").run(iso, iso),
    /UNIQUE/i,
    "干净库重复非空 SHA 必须被唯一索引拒绝",
  );
  // NULL 与空串 SHA 不受约束（partial index 只约束非空且非空串）—— 可多行
  db.prepare("INSERT INTO video_asset (id, sha256, title, created_at, updated_at) VALUES ('n1', NULL, 'nullA', ?, ?)").run(iso, iso);
  db.prepare("INSERT INTO video_asset (id, sha256, title, created_at, updated_at) VALUES ('n2', NULL, 'nullB', ?, ?)").run(iso, iso);
  db.prepare("INSERT INTO video_asset (id, sha256, title, created_at, updated_at) VALUES ('e1', '', 'emptyA', ?, ?)").run(iso, iso);
  db.prepare("INSERT INTO video_asset (id, sha256, title, created_at, updated_at) VALUES ('e2', '', 'emptyB', ?, ?)").run(iso, iso);
  db.close();
  db = openKbDb(dbPathA); // 重开：迁移幂等
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name='ux_video_asset_sha256'").get().c, 1, "重开后索引仍恰 1 个（幂等不重复建）");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM video_asset WHERE sha256='SHACLEAN'").get().c, 1, "重复插入被拒，SHACLEAN 仅 1 行");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM video_asset WHERE sha256 IS NULL").get().c, 2, "NULL SHA 2 行保留");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM video_asset WHERE sha256=''").get().c, 2, "空 SHA 2 行保留");
  db.close();

  // 场景 (b)：pre-migration 夹具已含两行同非空 SHA + 两个真实包目录/文件 → 两次开库不抛错、索引缺席、数据逐字节不变
  const dirB = join(ROOT, "c1b-dup");
  await mkdir(dirB, { recursive: true });
  const dbPathB = join(dirB, "kb.sqlite");
  const pkgA = join(dirB, "kb_dupA");
  const pkgB = join(dirB, "kb_dupB");
  await mkdir(join(pkgA, "assets"), { recursive: true });
  await mkdir(join(pkgB, "assets"), { recursive: true });
  const fileA = join(pkgA, "assets", "01-dup.mp4");
  const fileB = join(pkgB, "assets", "01-dup.mp4");
  const bytesA = Buffer.from("C1B_DUP_BYTES_ALPHA");
  const bytesB = Buffer.from("C1B_DUP_BYTES_BETA");
  await writeFile(fileA, bytesA);
  await writeFile(fileB, bytesB);
  // 手造 pre-migration DB：仅 video_asset（全 schema）+ 两行同 SHA，迁移前重复组已存在
  const { DatabaseSync } = await import("node:sqlite");
  const rawDb = new DatabaseSync(dbPathB);
  rawDb.exec(`CREATE TABLE video_asset (
    id TEXT PRIMARY KEY,
    source_url TEXT,
    sha256 TEXT,
    title TEXT,
    file_path TEXT,
    package_path TEXT,
    category TEXT,
    size_bytes INTEGER,
    duration_ms INTEGER,
    width INTEGER,
    height INTEGER,
    codec_video TEXT,
    codec_audio TEXT,
    bitrate_kbps REAL,
    channel TEXT,
    content_id TEXT,
    fallback_reason TEXT,
    media_validation TEXT,
    downloaded_at TEXT,
    legacy_id TEXT,
    captured_at TEXT,
    created_at TEXT,
    updated_at TEXT
  )`);
  rawDb.prepare("INSERT INTO video_asset (id, source_url, sha256, title, file_path, package_path, created_at, updated_at) VALUES ('dupA1', 'https://weixin.qq.com/sph/c1b_a', 'SHADUP', '重复A', ?, ?, ?, ?)")
    .run(fileA, pkgA, iso, iso);
  rawDb.prepare("INSERT INTO video_asset (id, source_url, sha256, title, file_path, package_path, created_at, updated_at) VALUES ('dupA2', 'https://weixin.qq.com/sph/c1b_b', 'SHADUP', '重复B', ?, ?, ?, ?)")
    .run(fileB, pkgB, iso, iso);
  rawDb.close();
  for (let i = 0; i < 2; i++) {
    db = openKbDb(dbPathB); // 必须不抛错
    assert.equal(db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='index' AND name='ux_video_asset_sha256'").get().c, 0, `第 ${i + 1} 次打开：历史重复组 → 索引必须缺席`);
    const rows = db.prepare("SELECT id, source_url, sha256, title, file_path, package_path FROM video_asset ORDER BY id").all();
    assert.equal(rows.length, 2, "两行不变");
    assert.deepEqual(
      rows.map((r) => [r.id, r.source_url, r.sha256, r.title, r.file_path, r.package_path]),
      [
        ["dupA1", "https://weixin.qq.com/sph/c1b_a", "SHADUP", "重复A", fileA, pkgA],
        ["dupA2", "https://weixin.qq.com/sph/c1b_b", "SHADUP", "重复B", fileB, pkgB],
      ],
      "行/ID/路径完全不变（不更新/删除/合并）",
    );
    db.close();
  }
  assert.deepEqual(await readFile(fileA), bytesA, "文件 A 逐字节不变");
  assert.deepEqual(await readFile(fileB), bytesB, "文件 B 逐字节不变");
});

/* ─────────── C2：两个独立 server 进程共享干净 DB/KB，屏障保证双查重后同时 INSERT → 唯一索引定 winner，loser 跨进程收敛 ─────────── */
test("C2：双进程并发同字节（不同 sourceUrl+deliveryId）→ 1 winner success、1 loser duplicate/linked；2 batch/2 item/2 receipt、无 failed、双源帖保留、仅 1 包零 staging", async () => {
  const c2Root = join(ROOT, "c2");
  const c2Data = join(c2Root, "data");
  const c2Kb = join(c2Root, "kbroot");
  await mkdir(c2Data, { recursive: true });
  await mkdir(c2Kb, { recursive: true });
  // 屏障 enrichment 模块 + 隔离屏障目录（测试临时根目录下，无生产钩子）。
  // 子进程各原子写 arrival-<PID>，只轮询父进程创建的 release 文件（绝不自行放行）；
  // 硬超时则写 timeout-<PID> 并抛错。
  const barrierDir = join(c2Root, "barrier");
  await mkdir(barrierDir, { recursive: true });
  const enrichPath = join(c2Root, "c2-barrier-enrich.mjs");
  const enrichSrc = [
    'import { readdir, rename, writeFile } from "node:fs/promises";',
    "const DIR = process.env.C2_BARRIER_DIR;",
    "const RELEASE_MS = 15000;",
    "const waitMs = (ms) => new Promise((r) => setTimeout(r, ms));",
    "const pid = String(process.pid);",
    "async function atomicTouch(name, content) {",
    '  const target = DIR + "/" + name;',
    '  const tmp = target + "." + pid + ".tmp";',
    "  await writeFile(tmp, content);",
    "  await rename(tmp, target);",
    "}",
    "async function waitForRelease() {",
    "  const start = Date.now();",
    "  while (Date.now() - start < RELEASE_MS) {",
    "    let names = [];",
    "    try { names = await readdir(DIR); } catch {}",
    '    if (names.indexOf("release") !== -1) return;',
    "    await waitMs(100);",
    "  }",
    '  await atomicTouch("timeout-" + pid, new Date().toISOString());',
    '  throw new Error("barrier_timeout");',
    "}",
    "export default async function c2BarrierEnrich(sourceUrl) {",
    '  await atomicTouch("arrival-" + pid, new Date().toISOString());',
    "  await waitForRelease(); // 只等父进程 release；双方都已在 INSERT 前完成查重",
    '  const url = String(sourceUrl || "");',
    "  const m = url.match(/post=([A-Za-z0-9_]+)/);",
    '  const marker = m ? m[1] : "default";',
    '  if (marker === "c2failb") await waitMs(100); // 第二轮：仅 c2failb 在 release 后再等小延迟，确保 c2faila 先进入 OWNER_TX',
    '  const raw = { feedInfo: { description: "C2帖子-" + marker, author: "作者" } };',
    '  if (marker === "c2faila") {',
    "    // 仅 c2faila：可枚举 getter，首次被 insertPlatformPost 内 sanitizeRawForStorage 枚举时忙等约 1500ms",
    "    // （发生在 INSERT video_asset 之后）；writePackageFiles 不触碰 raw，getter 不会被提前触发。",
    '    Object.defineProperty(raw, "delayProof", {',
    "      enumerable: true,",
    "      configurable: true,",
    "      get: function () {",
    "        var start = Date.now();",
    "        while (Date.now() - start < 1500) {}",
    '        return "ok";',
    "      },",
    "    });",
    "  }",
    "  return {",
    "    raw: raw,",
    "    media: {",
    '      postId: "c2_export_" + marker,',
    '      title: "C2帖子-" + marker,',
    '      author: "作者",',
    '      publishTime: "2026-08-01T00:00:00.000Z",',
    '      likes: "100", comments: "10", favorites: "20", shares: "5",',
    "      plays: null,",
    '      platform: "wechat_channels",',
    "      coverUrl: null,",
    "    },",
    "  };",
    "}",
  ].join("\n");
  await writeFile(enrichPath, enrichSrc);
  // 独立媒体字节（区别于本文件所有前序资产）
  const mediaPath = join(c2Root, "c2-bytes.mp4");
  await copyFile(SANDBOX_MP4, mediaPath);
  const fd = await openFile(mediaPath, "a");
  await fd.write("V2D_C2_CROSS_PROCESS_MARKER");
  await fd.close();
  const { createHash } = await import("node:crypto");
  const shaC2 = createHash("sha256").update(await readFile(mediaPath)).digest("hex");

  // 两个独立 server 进程，共享同一 c2Data/c2Kb，不同保留端口
  const port1 = await reservePort();
  const port2 = await reservePort();
  const baseCfg = {
    host: "127.0.0.1",
    knowledgeBase: c2Kb,
    allowedOrigins: ["http://localhost:3000"],
    polling: { intervalMs: 250, timeoutMs: 5000 },
    analysis: { yuanbaoChat: false },
    kuaidianFallback: { enabled: false },
    mediaFallback: { enabled: false, providers: [] },
    services: {},
    adapters: {},
  };
  // 各自独立的空 watcher 目录（非空 roots 数组、仅指向自己可见的空目录；roots=[] 会回退真实默认目录，禁止）
  const watcherDir1 = join(c2Root, "watch1");
  const watcherDir2 = join(c2Root, "watch2");
  await mkdir(watcherDir1, { recursive: true });
  await mkdir(watcherDir2, { recursive: true });
  const cfg1 = join(c2Root, "config1.json");
  const cfg2 = join(c2Root, "config2.json");
  await writeFile(cfg1, JSON.stringify({ ...baseCfg, port: port1, watcher: { intervalMs: 5000, maxRetries: 3, roots: [{ dir: watcherDir1, channel: "kuaidian", recursive: true }] } }));
  await writeFile(cfg2, JSON.stringify({ ...baseCfg, port: port2, watcher: { intervalMs: 5000, maxRetries: 3, roots: [{ dir: watcherDir2, channel: "kuaidian", recursive: true }] } }));
  const childEnv = { ...process.env, ZHITAI_DATA_DIR: c2Data, ZHITAI_ENRICH_SCRIPT: enrichPath, C2_BARRIER_DIR: barrierDir };
  // 串行启动：先 server1 并等健康（完成 schema 迁移），再 server2 —— 避免两个进程在全新库上并发跑迁移
  const s1 = spawn(process.execPath, [AGENT_ENTRY], { cwd: repoRoot, env: { ...childEnv, ZHITAI_CONFIG_PATH: cfg1 }, stdio: ["ignore", "ignore", "pipe"] });
  let s2 = null;
  let err1 = "";
  let err2 = "";
  s1.stderr.on("data", (c) => { err1 += c.toString(); });
  s1.unref();
  try {
    assert.equal(
      await waitHealthy(`http://127.0.0.1:${port1}`), true,
      `server1 就绪${err1 ? " stderr: " + err1.slice(-300) : ""}`,
    );
    s2 = spawn(process.execPath, [AGENT_ENTRY], { cwd: repoRoot, env: { ...childEnv, ZHITAI_CONFIG_PATH: cfg2 }, stdio: ["ignore", "ignore", "pipe"] });
    s2.stderr.on("data", (c) => { err2 += c.toString(); });
    s2.unref();
    assert.equal(
      await waitHealthy(`http://127.0.0.1:${port2}`), true,
      `server2 就绪${err2 ? " stderr: " + err2.slice(-300) : ""}`,
    );
    const dirsBefore = new Set(await listAllDirs(c2Kb));
    // 两个进程并发上报：不同 sourceUrl + 不同 deliveryId、同一媒体字节
    const [resp1, resp2] = await Promise.all([
      fetch(`http://127.0.0.1:${port1}/api/v1/kuaidian`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localPath: mediaPath, sourceUrl: "https://weixin.qq.com/sph/c2_fact_a?post=c2a", deliveryId: "msg_c2_a", title: "C2A" }),
        signal: AbortSignal.timeout(15000),
      }),
      fetch(`http://127.0.0.1:${port2}/api/v1/kuaidian`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localPath: mediaPath, sourceUrl: "https://weixin.qq.com/sph/c2_fact_b?post=c2b", deliveryId: "msg_c2_b", title: "C2B" }),
        signal: AbortSignal.timeout(15000),
      }),
    ]);
    assert.equal(resp1.status, 202, `server1 POST 应 202${err1 ? " stderr: " + err1.slice(-300) : ""}`);
    assert.equal(resp2.status, 202, `server2 POST 应 202${err2 ? " stderr: " + err2.slice(-300) : ""}`);
    const [b1, b2] = await Promise.all([resp1.json(), resp2.json()]);
    assert.ok(b1.batchId && b1.itemId, "server1 认领");
    assert.ok(b2.batchId && b2.itemId, "server2 认领");
    // 父进程：硬超时轮询 barrierDir，断言 arrival PID 恰为两个子进程，然后写 release（子进程绝不自行放行）
    const { readdir } = await import("node:fs/promises");
    const arrivalDeadline = Date.now() + 15000;
    let arrivalNames = [];
    for (;;) {
      try { arrivalNames = await readdir(barrierDir); } catch { arrivalNames = []; }
      if (arrivalNames.filter((n) => n.startsWith("arrival-")).length >= 2 || Date.now() > arrivalDeadline) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const arrivalPids = arrivalNames.filter((n) => n.startsWith("arrival-")).map((n) => n.slice("arrival-".length)).sort();
    assert.deepEqual(
      arrivalPids,
      [String(s1.pid), String(s2.pid)].sort(),
      `arrival PID 应恰为两子进程（${s1.pid}/${s2.pid}），实际：${arrivalNames.join(",")}${err1 ? " stderr1: " + err1.slice(-300) : ""}${err2 ? " stderr2: " + err2.slice(-300) : ""}`,
    );
    await writeFile(join(barrierDir, "release"), new Date().toISOString());
    // 等待两个 item 终态（barrier 放行后唯一索引定 winner）
    const { DatabaseSync } = await import("node:sqlite");
    const c2Db = () => new DatabaseSync(join(c2Data, "kb.sqlite"));
    await poll(async () => {
      const db = c2Db();
      const done = db.prepare("SELECT COUNT(*) c FROM import_item WHERE delivery_id LIKE 'msg_c2_%' AND status IN ('success','duplicate','linked','failed')").get().c;
      db.close();
      return done === 2 ? true : null;
    }, { tries: 90, delay: 400, desc: "C2 两个 item 终态" });

    const db = c2Db();
    const items = db.prepare("SELECT id, status, asset_id FROM import_item WHERE delivery_id LIKE 'msg_c2_%' ORDER BY id").all();
    const batchCount = db.prepare("SELECT COUNT(DISTINCT i.batch_id) c FROM import_item i WHERE i.delivery_id LIKE 'msg_c2_%'").get().c;
    const receiptRows = db.prepare("SELECT asset_id, outcome FROM download_receipt WHERE sha256=?").all(shaC2);
    const assetRows = db.prepare("SELECT id FROM video_asset WHERE sha256=?").all(shaC2);
    const posts = assetRows.length ? db.prepare("SELECT content_id, asset_id FROM platform_post WHERE asset_id=?").all(assetRows[0].id) : [];
    db.close();
    assert.equal(batchCount, 2, "严格 2 batch");
    assert.equal(items.length, 2, "严格 2 item");
    assert.equal(receiptRows.length, 2, "严格 2 receipt（都指向 winner）");
    assert.equal(assetRows.length, 1, "严格 1 asset（唯一索引定 winner）");
    const winner = assetRows[0].id;
    const statuses = items.map((i) => i.status);
    assert.equal(statuses.filter((s) => s === "success").length, 1, "恰 1 success（winner）");
    assert.equal(statuses.filter((s) => s === "duplicate" || s === "linked").length, 1, "恰 1 duplicate/linked（loser 收敛，不是 failed）");
    assert.equal(statuses.filter((s) => s === "failed").length, 0, "无 failed");
    assert.equal(items.every((i) => i.asset_id === winner), true, "两个 item 都指向 winner");
    assert.equal(receiptRows.every((r) => r.asset_id === winner), true, "两个 receipt 都指向 winner");
    assert.ok(receiptRows.some((r) => String(r.outcome).includes("duplicate_cross_process_sha")), "loser receipt 带跨进程 duplicate 结果");
    assert.equal(posts.length, 2, "两个 source post 都保留（enrichment 返回两帖，链到 winner）");
    assert.ok(posts.every((p) => p.asset_id === winner), "posts 都指向 winner");
    // 目录：零新增 staging；恰 1 个 kb_* 包（winner；loser 包已清理）
    const dirsAfter = await listAllDirs(c2Kb);
    const newDirs = dirsAfter.filter((d) => !dirsBefore.has(d));
    assert.equal(newDirs.filter((d) => d.includes(".staging-")).length, 0, "零新增 staging 目录");
    const kbPkgs = newDirs.filter((d) => basename(d).startsWith("kb_") && !d.includes(".staging-"));
    assert.equal(kbPkgs.length, 1, "恰 1 个 kb_* 包（winner；loser 包已清理）");
    const meta = JSON.parse(await readFile(join(kbPkgs[0], "metadata.json"), "utf8"));
    assert.equal(meta.identity?.primaryAssetSha256, shaC2, "winner 包为本组 SHA");
    // 无 timeout-* 哨兵（子进程均未超时）
    const afterNames = await readdir(barrierDir).catch(() => []);
    assert.equal(afterNames.filter((n) => n.startsWith("timeout-")).length, 0, `无 timeout-* 哨兵：${afterNames.join(",")}`);

    /* ── 第二轮：创建者终态故障接管 —— A 的 OWNER_TX 终态写入被 trigger 中止 → 资产随事务回滚；B 成为唯一 winner ── */
    // 清理上一轮屏障文件（release/arrival/timeout）
    for (const n of await readdir(barrierDir).catch(() => [])) {
      await rm(join(barrierDir, n), { force: true });
    }
    // 新一轮媒体字节/SHA（区别于第一轮）
    const mediaPath2 = join(c2Root, "c2-fail-bytes.mp4");
    await copyFile(SANDBOX_MP4, mediaPath2);
    const fd2 = await openFile(mediaPath2, "a");
    await fd2.write("V2D_C2_FAIL_TAKEOVER_MARKER");
    await fd2.close();
    const shaC2Fail = createHash("sha256").update(await readFile(mediaPath2)).digest("hex");
    // 隔离 DB 触发器：A（title=C2_FAIL_A）的 success receipt 写入即 RAISE 中止（终态写入故障）；
    // A 写事务的保持由 delayProof getter 负责（insertPlatformPost 内 ~1500ms 忙等，发生在 INSERT video_asset 之后）。
    // B 的 title=C2_FAIL_B 不受影响。
    {
      const tdb = new DatabaseSync(join(c2Data, "kb.sqlite"));
      tdb.exec("PRAGMA busy_timeout = 5000");
      tdb.exec(`CREATE TRIGGER trg_fail_c2fail_a BEFORE INSERT ON download_receipt
        WHEN NEW.outcome = 'success' AND NEW.title = 'C2_FAIL_A'
        BEGIN
          SELECT RAISE(ABORT, 'forced_owner_terminal_failure');
        END`);
      tdb.close();
    }
    const dirsBefore2 = new Set(await listAllDirs(c2Kb));
    const [r2a, r2b] = await Promise.all([
      fetch(`http://127.0.0.1:${port1}/api/v1/kuaidian`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localPath: mediaPath2, sourceUrl: "https://weixin.qq.com/sph/c2_fail_a?post=c2faila", deliveryId: "msg_c2_fail_a", title: "C2_FAIL_A" }),
        signal: AbortSignal.timeout(15000),
      }),
      fetch(`http://127.0.0.1:${port2}/api/v1/kuaidian`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ localPath: mediaPath2, sourceUrl: "https://weixin.qq.com/sph/c2_fail_b?post=c2failb", deliveryId: "msg_c2_fail_b", title: "C2_FAIL_B" }),
        signal: AbortSignal.timeout(15000),
      }),
    ]);
    assert.equal(r2a.status, 202, `round2 server1 POST 应 202${err1 ? " stderr: " + err1.slice(-300) : ""}`);
    assert.equal(r2b.status, 202, `round2 server2 POST 应 202${err2 ? " stderr: " + err2.slice(-300) : ""}`);
    // 父进程再次证明双 PID arrival 后 release（子进程绝不自行放行）
    const arrivalDeadline2 = Date.now() + 15000;
    let arrivalNames2 = [];
    for (;;) {
      try { arrivalNames2 = await readdir(barrierDir); } catch { arrivalNames2 = []; }
      if (arrivalNames2.filter((n) => n.startsWith("arrival-")).length >= 2 || Date.now() > arrivalDeadline2) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const arrivalPids2 = arrivalNames2.filter((n) => n.startsWith("arrival-")).map((n) => n.slice("arrival-".length)).sort();
    assert.deepEqual(
      arrivalPids2,
      [String(s1.pid), String(s2.pid)].sort(),
      `round2 arrival PID 应恰为两子进程（${s1.pid}/${s2.pid}），实际：${arrivalNames2.join(",")}${err1 ? " stderr1: " + err1.slice(-300) : ""}${err2 ? " stderr2: " + err2.slice(-300) : ""}`,
    );
    await writeFile(join(barrierDir, "release"), new Date().toISOString());
    // 等 round2 两个 item 终态
    await poll(async () => {
      const db = c2Db();
      const done = db.prepare("SELECT COUNT(*) c FROM import_item WHERE delivery_id LIKE 'msg_c2_fail_%' AND status IN ('success','duplicate','linked','failed')").get().c;
      db.close();
      return done === 2 ? true : null;
    }, { tries: 90, delay: 400, desc: "C2 round2 两个 item 终态" });

    const db2 = c2Db();
    const items2 = db2.prepare("SELECT id, status, asset_id, error FROM import_item WHERE delivery_id LIKE 'msg_c2_fail_%' ORDER BY delivery_id").all();
    const batchCount2 = db2.prepare("SELECT COUNT(DISTINCT i.batch_id) c FROM import_item i WHERE i.delivery_id LIKE 'msg_c2_fail_%'").get().c;
    const itemCount2 = db2.prepare("SELECT COUNT(*) c FROM import_item WHERE delivery_id LIKE 'msg_c2_fail_%'").get().c;
    const receiptRows2 = db2.prepare("SELECT asset_id, outcome, title FROM download_receipt WHERE sha256=?").all(shaC2Fail);
    const assetRows2 = db2.prepare("SELECT id FROM video_asset WHERE sha256=?").all(shaC2Fail);
    db2.close();
    assert.equal(batchCount2, 2, "round2 严格 2 batch");
    assert.equal(itemCount2, 2, "round2 严格 2 item");
    assert.equal(receiptRows2.length, 2, "round2 严格 2 receipt");
    assert.equal(assetRows2.length, 1, "round2 严格 1 asset（仅 B winner，A 的未提交资产已随 OWNER_TX 回滚）");
    const winner2 = assetRows2[0].id;
    const itemA2 = items2.find((i) => i.status === "failed");
    const itemB2 = items2.find((i) => i.status === "success");
    assert.ok(itemA2, "A item 必须 failed");
    assert.equal(itemA2.asset_id, null, "A item asset_id=null（资产随 OWNER_TX 回滚，终态故障前资产不可见）");
    assert.match(String(itemA2.error || ""), /forced_owner_terminal_failure/, `A error 应含 forced_owner_terminal_failure，实际 ${itemA2.error}`);
    assert.ok(itemB2, "B item 必须 success");
    assert.equal(itemB2.asset_id, winner2, "B item 指向唯一 winner 资产");
    assert.equal(items2.filter((i) => i.status === "duplicate" || i.status === "linked").length, 0, "round2 零 duplicate/linked");
    assert.equal(items2.filter((i) => i.status === "failed").length, 1, "round2 恰 1 个 failed（A）");
    // receipt：A failed 且 asset_id=null；B success 且指向 winner
    const receiptA2 = receiptRows2.find((r) => String(r.title) === "C2_FAIL_A");
    const receiptB2 = receiptRows2.find((r) => String(r.title) === "C2_FAIL_B");
    assert.ok(receiptA2 && String(receiptA2.outcome || "").includes("failed"), "A receipt 为 failed");
    assert.equal(receiptA2.asset_id, null, "A failed receipt asset_id=null");
    assert.ok(receiptB2 && String(receiptB2.outcome || "").includes("success"), "B receipt 为 success");
    assert.equal(receiptB2.asset_id, winner2, "B success receipt 指向 B winner");
    // 所有非空 asset_id 必须真实存在
    const checkIds = c2Db();
    for (const i of items2) {
      if (i.asset_id != null) assert.ok(checkIds.prepare("SELECT 1 c FROM video_asset WHERE id=?").get(i.asset_id), `round2 item ${i.id} asset_id 存在`);
    }
    for (const r of receiptRows2) {
      if (r.asset_id != null) assert.ok(checkIds.prepare("SELECT 1 c FROM video_asset WHERE id=?").get(r.asset_id), `round2 receipt asset_id 存在`);
    }
    checkIds.close();
    // 包：round2 恰 1 个完整包（B winner）、0 新增 staging
    const dirsAfter2 = await listAllDirs(c2Kb);
    const newDirs2 = dirsAfter2.filter((d) => !dirsBefore2.has(d));
    assert.equal(newDirs2.filter((d) => d.includes(".staging-")).length, 0, "round2 零新增 staging 目录");
    const kbPkgs2 = newDirs2.filter((d) => basename(d).startsWith("kb_") && !d.includes(".staging-"));
    assert.equal(kbPkgs2.length, 1, "round2 恰 1 个 kb_* 包（B winner）");
    const meta2 = JSON.parse(await readFile(join(kbPkgs2[0], "metadata.json"), "utf8"));
    assert.equal(meta2.identity?.primaryAssetSha256, shaC2Fail, "round2 包为本组 SHA");
    // 无 timeout 哨兵
    const afterNames2 = await readdir(barrierDir).catch(() => []);
    assert.equal(afterNames2.filter((n) => n.startsWith("timeout-")).length, 0, `round2 无 timeout-* 哨兵：${afterNames2.join(",")}`);
  } finally {
    // 有界终止：SIGTERM → 最多等 5s → 仍存活 SIGKILL → 再等 5s → 仍未退出则按子进程报错
    for (const [label, child] of [["server1", s1], ["server2", s2]]) {
      if (!child || child.exitCode !== null || child.signalCode !== null) continue;
      const exited = () => new Promise((resolve) => child.once("exit", resolve));
      const waitBounded = (ms) => Promise.race([exited(), new Promise((r) => setTimeout(r, ms))]);
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      await waitBounded(5000).catch(() => {});
      if (child.exitCode === null && child.signalCode === null) {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        await waitBounded(5000).catch(() => {});
      }
      if (child.exitCode === null && child.signalCode === null) {
        throw new Error(`${label} 子进程未能在 SIGTERM/SIGKILL 后退出`);
      }
    }
  }
});

/* ─────────── D1：GET /api/v1/kb/imports/:id/status —— 8 状态/404/白名单键/零泄漏/GET 不改库 ─────────── */
test("D1：status API —— 每种状态 terminal 语义正确、404 安全、键白名单精确、注入敏感值零泄漏、GET 不改任何行", async () => {
  const { openKbDb } = await import("../local-agent/kb.mjs");
  const db = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const iso = new Date().toISOString();
  const batchId = `kb_d1_status_${Date.now()}`;
  db.prepare("INSERT INTO import_batch (id, status, source_kind, created_at, total, succeeded, failed, skipped) VALUES (?, 'running', 'test', ?, 1, 0, 0, 0)").run(batchId, iso);
  // 合成 video_asset 行：干净库（如 --test-name-pattern=D1 单独跑）下 success 也必有 assetId，其余状态一律省略
  const assetId = `kb_d1_synth_${Date.now()}`;
  db.prepare("INSERT INTO video_asset (id, sha256, title, created_at, updated_at) VALUES (?, ?, 'D1合成资产', ?, ?)")
    .run(assetId, `d1sha_${Date.now()}`, iso, iso);
  const statuses = ["pending", "processing", "success", "duplicate", "linked", "failed", "partial", "orphaned"];
  const rows = [];
  for (const st of statuses) {
    const id = db.prepare(
      "INSERT INTO import_item (batch_id, input, input_kind, display_input, delivery_id, status, error, asset_id, updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
    ).run(
      batchId,
      st === "pending" ? "/Users/secret/abs/leak-path.mp4" : "https://dl.example/leak?token=DLTOK",
      "file",
      "https://evil.example/leak?token=EVILTOK",
      `msg_leak_delivery_${st}`, // 每行独立 delivery_id（partial UNIQUE 索引约束非 NULL 唯一）
      st,
      `sensitive_error_${st}: auth_key=LEAKKEY wsSecret=LEAKSECRET`,
      ["success", "duplicate", "linked"].includes(st) ? assetId : null,
      iso,
    ).lastInsertRowid;
    rows.push({ id, status: st, expectAsset: ["success", "duplicate", "linked"].includes(st) });
  }
  // 首读不可变性：任何 status GET 之前，先抓全部 8 行完整快照（含 updated_at）
  const beforeSnap = new Map(rows.map((r) => [r.id, db.prepare("SELECT * FROM import_item WHERE id=?").get(r.id)]));
  db.close();

  const terminalStatuses = new Set(["success", "duplicate", "linked", "failed", "partial", "orphaned"]);
  const rawBodies = [];
  for (const r of rows) {
    const resp = await request(`/api/v1/kb/imports/${r.id}/status`);
    assert.equal(resp.status, 200, `status=${r.status} 应 200`);
    const text = await resp.text();
    rawBodies.push(text);
    const body = JSON.parse(text);
    // 键白名单精确匹配（仅 ok/itemId/batchId/status/terminal/updatedAt，assetId 仅在有值时出现）
    const expectedKeys = ["batchId", "itemId", "ok", "status", "terminal", "updatedAt", ...(r.expectAsset ? ["assetId"] : [])].sort();
    assert.deepEqual(Object.keys(body).sort(), expectedKeys, `status=${r.status} 键白名单精确`);
    assert.equal(body.ok, true);
    assert.equal(body.itemId, r.id);
    assert.equal(body.batchId, batchId);
    assert.equal(body.status, r.status);
    assert.equal(body.terminal, terminalStatuses.has(r.status), `status=${r.status} terminal 语义`);
    if (r.expectAsset) assert.equal(body.assetId, assetId, `${r.status} 必须返回合成 assetId`);
  }
  // 安全 404：不存在 item
  const missing = await request("/api/v1/kb/imports/99999999/status");
  assert.equal(missing.status, 404, "不存在 item 应 404");
  const missingBody = await missing.json();
  assert.deepEqual(Object.keys(missingBody).sort(), ["error"], "404 只返回 error 键");
  // 零泄漏：原始响应体不得含任何注入的绝对路径/token URL/敏感 error/deliveryId
  const all = rawBodies.join("\n");
  for (const leak of [
    "/Users/secret/abs/leak-path.mp4",
    "https://dl.example/leak?token=DLTOK",
    "https://evil.example/leak?token=EVILTOK",
    "msg_leak_delivery",
    "LEAKKEY",
    "LEAKSECRET",
    "sensitive_error",
  ]) {
    assert.ok(!all.includes(leak), `状态响应不得泄漏：${leak}`);
  }
  // 8 GET + 404 全部完成后再次抓快照，逐行 deepEqual 首读快照（证明 GET 不改任何行/状态）
  const db2 = openKbDb(join(DATA_DIR, "kb.sqlite"));
  for (const r of rows) {
    const after = db2.prepare("SELECT * FROM import_item WHERE id=?").get(r.id);
    assert.deepEqual(after, beforeSnap.get(r.id), `status=${r.status} GET 后行不变`);
  }
  db2.close();
});

/* ─────────── D2a：自动快点重提认领（deliveryId 第一查重键 + 失败/超时原子回收） ─────────── */

/* ─────────── 工具：D2a 加固 ─────────── */
function tableIdSet(db, table) {
  return db.prepare(`SELECT id FROM ${table}`).all().map((r) => String(r.id)).sort();
}

const BUSINESS_TABLES = ["video_asset", "platform_post", "metric_snapshot", "download_receipt", "import_batch", "import_item"];

async function snapshotBusinessState(db, { kbDirs = false } = {}) {
  const out = {};
  for (const t of BUSINESS_TABLES) {
    out[`${t}_count`] = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
    out[`${t}_ids`] = tableIdSet(db, t).join("|");
  }
  if (kbDirs) out.kbDirs = (await listAllDirs(KB_ROOT)).slice().sort().join("|");
  return out;
}

async function assertQuietWindow(snapshotFn, { windowMs = 2500, desc = "" } = {}) {
  const s1 = await snapshotFn();
  await new Promise((r) => setTimeout(r, windowMs));
  const s2 = await snapshotFn();
  assert.deepEqual(s2, s1, `安静窗口(${windowMs}ms)后无新写入：${desc}`);
  return s1;
}

/* D2a-1：一个 failed 同 delivery 项，20 并发合法重提（20 个不同字节载荷）→ 唯一 owner + 19 dedup，
   复用原 batch/item，全局 batch/item ID 集不变，retry_count+1，安静窗口后仅 1 资产/1 新 receipt */
test("D2a-1：失败项 20 并发重提（20 个不同字节载荷）→ 唯一 owner + 19 deduplicated，复用原 batch/item，全局 ID 集不变，retry_count 仅 +1，恰 1 条新 receipt", async () => {
  const deliveryId = "msg_d2a1_001";
  const sourceUrl = "https://weixin.qq.com/sph/d2a1_fact";
  // 先制造 failed 项：下载源不可达（私网直链被 SSRF 守卫拒绝 → adapter 前置失败）
  const first = await request("/api/v1/kuaidian", { method: "POST", body: { downloadUrl: "http://127.0.0.1:9/unreachable.mp4", sourceUrl, deliveryId, title: "D2A1初败" } });
  assert.equal(first.status, 202, "首次上报 202");
  const fb = await first.json();
  const origBatch = fb.batchId;
  const origItem = fb.itemId;
  const { openKbDb } = await import("../local-agent/kb.mjs");
  await poll(async () => {
    const db = openKbDb(join(DATA_DIR, "kb.sqlite"));
    const st = db.prepare("SELECT status FROM import_item WHERE id=?").get(origItem)?.status;
    db.close();
    return st === "failed" ? true : null;
  }, { tries: 40, delay: 400, desc: "初败项进入 failed" });
  const db0 = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const receiptsBefore = db0.prepare("SELECT COUNT(*) c FROM download_receipt WHERE source_url=?").get(sourceUrl).c;
  assert.equal(receiptsBefore, 1, "初败已产生 1 条 receipt");
  const batchIdsBefore = tableIdSet(db0, "import_batch");
  const itemIdsBefore = tableIdSet(db0, "import_item");
  assert.equal(db0.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=?").get(origBatch).c, 1, "原 batch 恰 1 个 item");
  db0.close();
  // 20 个不同字节的有效 MP4 载荷（同 deliveryId/sourceUrl）—— 变异实现若为 dedup 响应启动 worker，
  // 每个 worker 摄入不同 SHA → 产生多资产，无法靠同 SHA 锁掩盖
  const files = await Promise.all(
    Array.from({ length: 20 }, (_, i) => makeDistinctMp4(`d2a1-retry-${i}.mp4`, `D2A1_RETRY_MARKER_${i}`)),
  );
  const resps = await Promise.all(
    files.map((f) =>
      request("/api/v1/kuaidian", { method: "POST", body: { localPath: f, sourceUrl, deliveryId, title: "D2A1重提" } })),
  );
  assert.equal(resps.every((r) => r.status === 202), true, "20 个重提均 202");
  const bodies = await Promise.all(resps.map((r) => r.json()));
  assert.equal(bodies.every((b) => b.batchId === origBatch && b.itemId === origItem), true, "20 个响应 batchId/itemId 全部等于原项");
  assert.equal(bodies.filter((b) => b.deduplicated === true).length, 19, "恰 19 个 deduplicated");
  assert.equal(bodies.filter((b) => b.deduplicated !== true).length, 1, "恰 1 个 owner（回收者）");
  // 终态
  await poll(async () => {
    const db = openKbDb(join(DATA_DIR, "kb.sqlite"));
    const row = db.prepare("SELECT status FROM import_item WHERE id=?").get(origItem);
    db.close();
    return row && ["success", "duplicate", "linked", "failed"].includes(row.status) ? true : null;
  }, { tries: 60, delay: 400, desc: "重提后终态" });
  // 安静窗口：终态后再等 2.5s，receipts/assets 计数与全局 batch/item ID 集均不再变化（无第二个 worker 迟写）
  await assertQuietWindow(async () => {
    const db = openKbDb(join(DATA_DIR, "kb.sqlite"));
    const snap = {
      batchIds: tableIdSet(db, "import_batch"),
      itemIds: tableIdSet(db, "import_item"),
      receipts: db.prepare("SELECT COUNT(*) c FROM download_receipt WHERE source_url=?").get(sourceUrl).c,
      assets: db.prepare("SELECT COUNT(*) c FROM video_asset WHERE source_url=?").get(sourceUrl).c,
    };
    db.close();
    return snap;
  }, { desc: "D2a-1 重提后安静窗口" });
  const db1 = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const item = db1.prepare("SELECT status, retry_count, asset_id, input, display_input, error FROM import_item WHERE id=?").get(origItem);
  const batchCount = db1.prepare("SELECT COUNT(*) c FROM import_batch WHERE id=?").get(origBatch).c;
  const deliveryCount = db1.prepare("SELECT COUNT(*) c FROM import_item WHERE delivery_id=?").get(deliveryId).c;
  const receiptsAfter = db1.prepare("SELECT COUNT(*) c FROM download_receipt WHERE source_url=?").get(sourceUrl).c;
  const assetsAfter = db1.prepare("SELECT COUNT(*) c FROM video_asset WHERE source_url=?").get(sourceUrl).c;
  const batchIdsAfter = tableIdSet(db1, "import_batch");
  const itemIdsAfter = tableIdSet(db1, "import_item");
  const origBatchItemsAfter = db1.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=?").get(origBatch).c;
  db1.close();
  assert.deepEqual(batchIdsAfter, batchIdsBefore, "全局 batch ID 集不变（未新建 batch）");
  assert.deepEqual(itemIdsAfter, itemIdsBefore, "全局 item ID 集不变（未新建 item）");
  assert.equal(origBatchItemsAfter, 1, "原 batch 仍恰 1 个 item");
  assert.ok(["success", "duplicate", "linked"].includes(item.status), `重提后终态应为 success/duplicate/linked，实际 ${item.status}`);
  assert.equal(item.retry_count, 1, "retry_count 仅 +1（初败不增、回收 +1）");
  assert.ok(item.asset_id, "重提成功项关联资产");
  assert.ok(files.includes(item.input), "input 为本轮 20 个载荷之一（唯一 winner 的路径）");
  assert.equal(item.display_input, sourceUrl, "display_input 已按本请求更新为 sourceUrl");
  assert.equal(item.error, null, "回收已清 error");
  assert.equal(batchCount, 1, "batch 计数不变（未新建）");
  assert.equal(deliveryCount, 1, "item 计数不变（未新建）");
  assert.equal(receiptsAfter, receiptsBefore + 1, "恰 1 条新 receipt");
  assert.equal(assetsAfter, 1, "恰 1 个重试资产（20 个不同字节也只 1 资产）");
});

/* D2a-2：failed/partial/orphaned 各自原地复用原行；全局 batch/item ID 集不增长，每原 batch 仍 1 item */
test("D2a-2：failed/partial/orphaned 重提各自原地复用原 batch/item，retry_count+1，input/display 更新；全局 ID 集不增长", async () => {
  const { openKbDb } = await import("../local-agent/kb.mjs");
  const db = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const iso = new Date().toISOString();
  // 先插入 3 个夹具 batch/item
  const fixtures = [["failed", "f"], ["partial", "p"], ["orphaned", "o"]];
  const batchIds = [];
  const itemIds = [];
  for (const [st, tag] of fixtures) {
    const batchId = `kb_d2a2_${tag}`;
    batchIds.push(batchId);
    db.prepare("INSERT INTO import_batch (id, status, source_kind, created_at, total, succeeded, failed, skipped) VALUES (?, 'done', 'test', ?, 1, 0, 1, 0)").run(batchId, iso);
    const id = db.prepare(
      "INSERT INTO import_item (batch_id, input, input_kind, display_input, delivery_id, status, error, retry_count, updated_at) VALUES (?,?,?,?,?,?,?,0,?)",
    ).run(batchId, "old-input", "kuaidian", "old-display", `msg_d2a2_${tag}`, st, `old_error_${tag}`, iso).lastInsertRowid;
    itemIds.push(id);
  }
  // 夹具插入完成后才捕获全局 ID 集（夹具本身属于「原有」行）
  const batchIdsBefore = tableIdSet(db, "import_batch");
  const itemIdsBefore = tableIdSet(db, "import_item");
  db.close();
  // 三个重提（各自不同 deliveryId/sourceUrl/有效字节）
  for (let fixtureIndex = 0; fixtureIndex < fixtures.length; fixtureIndex++) {
    const [st, tag] = fixtures[fixtureIndex];
    const file = await makeDistinctMp4(`d2a2-${tag}.mp4`, `D2A2_${tag.toUpperCase()}_MARKER`);
    const sourceUrl = `https://weixin.qq.com/sph/d2a2_${tag}`;
    const r = await request("/api/v1/kuaidian", { method: "POST", body: { localPath: file, sourceUrl, deliveryId: `msg_d2a2_${tag}`, title: `D2A2_${tag}` } });
    assert.equal(r.status, 202, `${st} 重提 202`);
    const b = await r.json();
    assert.equal(b.batchId, `kb_d2a2_${tag}`, `${st} 复用原 batch`);
    assert.equal(b.itemId, itemIds[fixtureIndex], `${st} 复用原 item`);
    assert.notEqual(b.deduplicated, true, `${st} 重提为回收 owner（非 dedup）`);
    // 本用例验证三种旧终态各自的原地回收，不验证它们之间的并发；逐项等到
    // worker 收口，避免较慢 CI 机器上的 SQLite/媒体探测争用污染后续断言。
    await poll(async () => {
      const itemDb = openKbDb(join(DATA_DIR, "kb.sqlite"));
      const status = itemDb.prepare("SELECT status FROM import_item WHERE id=?").get(itemIds[fixtureIndex])?.status;
      itemDb.close();
      return ["success", "duplicate", "linked", "failed"].includes(status) ? true : null;
    }, { tries: 90, delay: 400, desc: `d2a2 ${st} 终态` });
  }
  await poll(async () => {
    const db2 = openKbDb(join(DATA_DIR, "kb.sqlite"));
    const c = db2.prepare("SELECT COUNT(*) c FROM import_item WHERE delivery_id LIKE 'msg_d2a2_%' AND status IN ('success','duplicate','linked','failed')").get().c;
    db2.close();
    return c === 3 ? true : null;
  }, { tries: 60, delay: 400, desc: "d2a2 三项终态" });
  const db3 = openKbDb(join(DATA_DIR, "kb.sqlite"));
  for (const [st, tag] of [["failed", "f"], ["partial", "p"], ["orphaned", "o"]]) {
    const row = db3.prepare("SELECT status, retry_count, error, input, display_input FROM import_item WHERE delivery_id=?").get(`msg_d2a2_${tag}`);
    assert.ok(["success", "duplicate", "linked"].includes(row.status), `${st} 回收后终态 ok，实际 ${row.status}`);
    assert.equal(row.retry_count, 1, `${st} retry_count 仅 +1`);
    assert.equal(row.error, null, `${st} error 已清`);
    assert.equal(row.input, join(ROOT, `d2a2-${tag}.mp4`), `${st} input 按本请求更新`);
    assert.equal(row.display_input, `https://weixin.qq.com/sph/d2a2_${tag}`, `${st} display_input 按本请求更新`);
  }
  const batchIdsAfter = tableIdSet(db3, "import_batch");
  const itemIdsAfter = tableIdSet(db3, "import_item");
  for (const b of batchIds) {
    assert.equal(db3.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=?").get(b).c, 1, `${b} 仍恰 1 个 item`);
  }
  assert.deepEqual(batchIdsAfter, batchIdsBefore, "全局 batch ID 集不增长");
  assert.deepEqual(itemIdsAfter, itemIdsBefore, "全局 item ID 集不增长");
  db3.close();
});

/* D2a-3：fresh pending / fresh processing 重提为零变更 no-op（字节级） */
test("D2a-3：fresh pending 与 fresh processing 重提 → 零变更 no-op（行快照字节级不变，无 receipt/asset）", async () => {
  const { openKbDb } = await import("../local-agent/kb.mjs");
  const db = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const iso = new Date().toISOString();
  // pending 行
  const batchP = "kb_d2a3_p";
  db.prepare("INSERT INTO import_batch (id, status, source_kind, created_at, total, succeeded, failed, skipped) VALUES (?, 'awaiting_primary_download', 'test', ?, 1, 0, 0, 0)").run(batchP, iso);
  const pendingId = db.prepare(
    "INSERT INTO import_item (batch_id, input, input_kind, display_input, delivery_id, status, error, retry_count, updated_at) VALUES (?,?,?,?,?, 'pending', 'awaiting_primary_download: x', 0, ?)",
  ).run(batchP, "p-input", "kuaidian", "p-display", "msg_d2a3_p", iso).lastInsertRowid;
  // fresh processing 行（updated_at=now）
  const batchR = "kb_d2a3_r";
  db.prepare("INSERT INTO import_batch (id, status, source_kind, created_at, total, succeeded, failed, skipped) VALUES (?, 'running', 'test', ?, 1, 0, 0, 0)").run(batchR, iso);
  const procId = db.prepare(
    "INSERT INTO import_item (batch_id, input, input_kind, display_input, delivery_id, status, error, retry_count, updated_at) VALUES (?,?,?,?,?, 'processing', 'running', 0, ?)",
  ).run(batchR, "r-input", "kuaidian", "r-display", "msg_d2a3_r", iso).lastInsertRowid;
  const snapP = db.prepare("SELECT * FROM import_item WHERE id=?").get(pendingId);
  const snapR = db.prepare("SELECT * FROM import_item WHERE id=?").get(procId);
  const snapBatchP = db.prepare("SELECT * FROM import_batch WHERE id=?").get(batchP);
  const snapBatchR = db.prepare("SELECT * FROM import_batch WHERE id=?").get(batchR);
  const gBatchBefore = tableIdSet(db, "import_batch");
  const gItemBefore = tableIdSet(db, "import_item");
  db.close();
  // 重提（同 delivery，payload 无关紧要）
  const rp = await request("/api/v1/kuaidian", { method: "POST", body: { localPath: SANDBOX_MP4, deliveryId: "msg_d2a3_p", sourceUrl: "https://weixin.qq.com/sph/d2a3_p", title: "D2A3_P" } });
  assert.equal(rp.status, 202);
  const bp = await rp.json();
  assert.equal(bp.deduplicated, true, "pending 重提 deduplicated");
  assert.equal(bp.batchId, batchP, "pending 复用原 batch");
  assert.equal(bp.itemId, pendingId, "pending 复用原 item");
  const rr = await request("/api/v1/kuaidian", { method: "POST", body: { localPath: SANDBOX_MP4, deliveryId: "msg_d2a3_r", sourceUrl: "https://weixin.qq.com/sph/d2a3_r", title: "D2A3_R" } });
  assert.equal(rr.status, 202);
  const br = await rr.json();
  assert.equal(br.deduplicated, true, "fresh processing 重提 deduplicated");
  assert.equal(br.batchId, batchR, "fresh processing 复用原 batch");
  assert.equal(br.itemId, procId, "fresh processing 复用原 item");
  // 字节级 no-op + 无 receipt/asset + 全局 ID 集不变
  const db2 = openKbDb(join(DATA_DIR, "kb.sqlite"));
  assert.deepEqual(db2.prepare("SELECT * FROM import_item WHERE id=?").get(pendingId), snapP, "pending 行字节级不变");
  assert.deepEqual(db2.prepare("SELECT * FROM import_item WHERE id=?").get(procId), snapR, "fresh processing 行字节级不变");
  assert.deepEqual(db2.prepare("SELECT * FROM import_batch WHERE id=?").get(batchP), snapBatchP, "pending 的 batch 行字节级不变");
  assert.deepEqual(db2.prepare("SELECT * FROM import_batch WHERE id=?").get(batchR), snapBatchR, "fresh processing 的 batch 行字节级不变");
  assert.deepEqual(tableIdSet(db2, "import_batch"), gBatchBefore, "全局 batch ID 集不变");
  assert.deepEqual(tableIdSet(db2, "import_item"), gItemBefore, "全局 item ID 集不变");
  assert.equal(db2.prepare("SELECT COUNT(*) c FROM download_receipt WHERE source_url LIKE '%d2a3_%'").get().c, 0, "无新 receipt");
  assert.equal(db2.prepare("SELECT COUNT(*) c FROM video_asset WHERE source_url LIKE '%d2a3_%'").get().c, 0, "无新 asset");
  db2.close();
});

/* D2a-4：16 分钟 processing 20 并发重提（20 个不同字节载荷）→ 恰一次原地回收，ID 集不变，安静窗口稳定，1 资产/1 receipt */
test("D2a-4：16 分钟陈旧 processing 20 并发重提（不同字节）→ 恰 1 次回收（retry_count+1，1 owner+19 dedup），ID 集不变，安静窗口稳定，恰 1 资产/1 receipt", async () => {
  const { openKbDb } = await import("../local-agent/kb.mjs");
  const db = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const iso = new Date().toISOString();
  const batchId = "kb_d2a4_stale";
  db.prepare("INSERT INTO import_batch (id, status, source_kind, created_at, total, succeeded, failed, skipped) VALUES (?, 'running', 'test', ?, 1, 0, 0, 0)").run(batchId, iso);
  const id = db.prepare(
    "INSERT INTO import_item (batch_id, input, input_kind, display_input, delivery_id, status, error, retry_count, updated_at) VALUES (?,?,?,?,?, 'processing', 'stuck_16min', 0, ?)",
  ).run(batchId, "stale-input", "kuaidian", "stale-display", "msg_d2a4", new Date(Date.now() - 16 * 60 * 1000).toISOString()).lastInsertRowid;
  const batchIdsBefore = tableIdSet(db, "import_batch");
  const itemIdsBefore = tableIdSet(db, "import_item");
  db.close();
  // 20 个不同字节的有效载荷（同 deliveryId/sourceUrl）
  const files = await Promise.all(
    Array.from({ length: 20 }, (_, i) => makeDistinctMp4(`d2a4-${i}.mp4`, `D2A4_MARKER_${i}`)),
  );
  const sourceUrl = "https://weixin.qq.com/sph/d2a4";
  const resps = await Promise.all(
    files.map((f) =>
      request("/api/v1/kuaidian", { method: "POST", body: { localPath: f, sourceUrl, deliveryId: "msg_d2a4", title: "D2A4" } })),
  );
  assert.equal(resps.every((r) => r.status === 202), true, "20 个重提均 202");
  const bodies = await Promise.all(resps.map((r) => r.json()));
  assert.equal(bodies.every((b) => b.batchId === batchId && b.itemId === id), true, "20 个响应 batchId/itemId 均等于原项");
  assert.equal(bodies.filter((b) => b.deduplicated === true).length, 19, "恰 19 个 deduplicated");
  assert.equal(bodies.filter((b) => b.deduplicated !== true).length, 1, "恰 1 个回收 owner");
  await poll(async () => {
    const db2 = openKbDb(join(DATA_DIR, "kb.sqlite"));
    const row = db2.prepare("SELECT status FROM import_item WHERE id=?").get(id);
    db2.close();
    return row && ["success", "duplicate", "linked", "failed"].includes(row.status) ? true : null;
  }, { tries: 60, delay: 400, desc: "d2a4 回收后终态" });
  // 安静窗口：终态后 2.5s 内 receipts/assets 计数与全局 ID 集不再变化
  await assertQuietWindow(async () => {
    const db2 = openKbDb(join(DATA_DIR, "kb.sqlite"));
    const snap = {
      batchIds: tableIdSet(db2, "import_batch"),
      itemIds: tableIdSet(db2, "import_item"),
      receipts: db2.prepare("SELECT COUNT(*) c FROM download_receipt WHERE source_url=?").get(sourceUrl).c,
      assets: db2.prepare("SELECT COUNT(*) c FROM video_asset WHERE source_url=?").get(sourceUrl).c,
    };
    db2.close();
    return snap;
  }, { desc: "D2a-4 回收后安静窗口" });
  const db3 = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const item = db3.prepare("SELECT status, retry_count, asset_id, error, input, display_input FROM import_item WHERE id=?").get(id);
  const receiptCount = db3.prepare("SELECT COUNT(*) c FROM download_receipt WHERE source_url=?").get(sourceUrl).c;
  const assetCount = db3.prepare("SELECT COUNT(*) c FROM video_asset WHERE source_url=?").get(sourceUrl).c;
  const batchIdsAfter = tableIdSet(db3, "import_batch");
  const itemIdsAfter = tableIdSet(db3, "import_item");
  assert.equal(db3.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=?").get(batchId).c, 1, "原 batch 仍恰 1 个 item");
  db3.close();
  assert.deepEqual(batchIdsAfter, batchIdsBefore, "全局 batch ID 集不变");
  assert.deepEqual(itemIdsAfter, itemIdsBefore, "全局 item ID 集不变");
  assert.ok(["success", "duplicate", "linked"].includes(item.status), `回收后终态 ok，实际 ${item.status}`);
  assert.equal(item.retry_count, 1, "陈旧 processing 回收 retry_count 仅 +1");
  assert.ok(item.asset_id, "回收成功项关联资产");
  assert.equal(item.error, null, "error 已清");
  assert.ok(files.includes(item.input), "input 为本轮 20 个载荷之一（唯一 winner 的路径）");
  assert.equal(item.display_input, sourceUrl, "display_input 按本请求更新");
  assert.equal(receiptCount, 1, "恰 1 条新 receipt");
  assert.equal(assetCount, 1, "恰 1 个资产（20 个不同字节也只 1 资产）");
});

/* D2a-5：delivery 第一键冲突 —— A 是目标 deliveryId 的 success 行（sourceA）；B 是另一 deliveryId 的
   pending 行（input/display=sourceB）。用目标 deliveryId + sourceB + 恶意不同字节 localPath + 恶意 title/contentId
   重提 → 响应只选中 A；B 字节级不变；安静窗口后 video_asset/platform_post/metric_snapshot/download_receipt/
   import_batch/import_item 全表计数与 ID 集 + 递归 KB 目录集完全一致；sourceB/恶意标题/contentId/恶意 SHA
   不出现在任何业务行（B 夹具自身除外）；sourceB 无 receipt。 */
test("D2a-5：delivery 第一键冲突 —— 恶意重提只选中 A（sourceB/B 零污染、全表 ID 集与 KB 目录集不变、安静窗口稳定）", async () => {
  const deliveryId = "msg_d2a5_target";
  const sourceA = "https://weixin.qq.com/sph/d2a5_ok";
  const sourceB = "https://weixin.qq.com/sph/d2a5_other";
  // A：真实成功项（目标 deliveryId + sourceA）
  const fileA = await makeDistinctMp4("d2a5-a.mp4", "D2A5_A_MARKER");
  const first = await request("/api/v1/kuaidian", { method: "POST", body: { localPath: fileA, sourceUrl: sourceA, deliveryId, title: "D2A5初成功" } });
  assert.equal(first.status, 202);
  const fb = await first.json();
  const { openKbDb } = await import("../local-agent/kb.mjs");
  const aRow = await poll(async () => {
    const db = openKbDb(join(DATA_DIR, "kb.sqlite"));
    const row = db.prepare("SELECT status, asset_id FROM import_item WHERE id=?").get(fb.itemId);
    db.close();
    return row && ["success", "duplicate", "linked"].includes(row.status) ? row : null;
  }, { tries: 60, delay: 400, desc: "d2a5 A 初成功" });
  // B：另一 deliveryId 的 pending 行（input/display=sourceB，error=awaiting_primary_download）
  const db = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const iso = new Date().toISOString();
  const batchB = "kb_d2a5_b";
  db.prepare("INSERT INTO import_batch (id, status, source_kind, created_at, total, succeeded, failed, skipped) VALUES (?, 'awaiting_primary_download', 'test', ?, 1, 0, 0, 0)").run(batchB, iso);
  const bId = db.prepare(
    "INSERT INTO import_item (batch_id, input, input_kind, display_input, delivery_id, status, error, retry_count, updated_at) VALUES (?,?,?,?,?, 'pending', 'awaiting_primary_download: x', 0, ?)",
  ).run(batchB, sourceB, "link", sourceB, "msg_d2a5_b", iso).lastInsertRowid;
  const snapB = db.prepare("SELECT * FROM import_item WHERE id=?").get(bId);
  const snapBatchB = db.prepare("SELECT * FROM import_batch WHERE id=?").get(batchB);
  // 恶意载荷：不同字节 localPath + 恶意 title/contentId + sourceB
  const evilFile = await makeDistinctMp4("d2a5-evil.mp4", "D2A5_EVIL_MARKER");
  const { createHash } = await import("node:crypto");
  const evilSha = createHash("sha256").update(await readFile(evilFile)).digest("hex");
  const evilTitle = "EVIL_TITLE_9f3a";
  const evilCid = "evil_content_id_7c2d";
  const fullBefore = await snapshotBusinessState(db, { kbDirs: true });
  db.close();
  // 恶意重提：目标 deliveryId + sourceB + 恶意字节/title/contentId（delivery 第一键 → 只命中 A）
  const r2 = await request("/api/v1/kuaidian", { method: "POST", body: { localPath: evilFile, sourceUrl: sourceB, deliveryId, title: evilTitle, contentId: evilCid } });
  assert.equal(r2.status, 202);
  const b2 = await r2.json();
  assert.equal(b2.deduplicated, true, "success 终态重提 deduplicated（delivery 第一键选中 A，与 payload 的 sourceB 无关）");
  assert.equal(b2.batchId, fb.batchId, "复用 A 的 batch");
  assert.equal(b2.itemId, fb.itemId, "复用 A 的 item");
  assert.equal(b2.assetId, aRow.asset_id, "返回 A 的资产");
  // 安静窗口后全表状态与 KB 目录集完全一致（零写入）
  await assertQuietWindow(async () => {
    const d = openKbDb(join(DATA_DIR, "kb.sqlite"));
    const s = await snapshotBusinessState(d, { kbDirs: true });
    d.close();
    return s;
  }, { desc: "D2a-5 恶意重提后安静窗口" });
  const db2 = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const fullAfter = await snapshotBusinessState(db2, { kbDirs: true });
  assert.deepEqual(fullAfter, fullBefore, "全表计数/ID 集与 KB 目录集完全一致（零写入）");
  assert.deepEqual(db2.prepare("SELECT * FROM import_item WHERE id=?").get(bId), snapB, "B 行字节级不变");
  assert.deepEqual(db2.prepare("SELECT * FROM import_batch WHERE id=?").get(batchB), snapBatchB, "B 的 batch 行字节级不变");
  // sourceB / 恶意标题 / 恶意 contentId / 恶意 SHA 不出现在业务行（排除 B 夹具自身的 input/display）
  for (const bad of [sourceB, evilTitle, evilCid, evilSha]) {
    const cAsset = db2.prepare("SELECT COUNT(*) c FROM video_asset WHERE source_url LIKE ?").get(`%${bad}%`).c;
    const cPost = db2.prepare("SELECT COUNT(*) c FROM platform_post WHERE url LIKE ? OR title LIKE ? OR post_id LIKE ? OR content_id LIKE ?").get(`%${bad}%`, `%${bad}%`, `%${bad}%`, `%${bad}%`).c;
    const cSnap = db2.prepare("SELECT COUNT(*) c FROM metric_snapshot WHERE content_id LIKE ? OR source LIKE ?").get(`%${bad}%`, `%${bad}%`).c;
    const cRecv = db2.prepare("SELECT COUNT(*) c FROM download_receipt WHERE source_url LIKE ?").get(`%${bad}%`).c;
    const cItem = db2.prepare("SELECT COUNT(*) c FROM import_item WHERE id != ? AND (input LIKE ? OR display_input LIKE ? OR error LIKE ?)").get(bId, `%${bad}%`, `%${bad}%`, `%${bad}%`).c;
    assert.equal(cAsset + cPost + cSnap + cRecv + cItem, 0, `业务行不得含：${bad}`);
  }
  assert.equal(db2.prepare("SELECT COUNT(*) c FROM download_receipt WHERE source_url=?").get(sourceB).c, 0, "sourceB 无 receipt");
  db2.close();
});

/* ─────────── D2b：原子手动重试路由 POST /api/v1/kb/imports/:id/retry ─────────── */

/* D2b-1：20 并发重试一个 failed 本地文件项（文件真实缺失）→ 恰 1×202 + 19×409
   （error ∈ {retry_in_progress, retry_cooldown}），恰 1 个 worker/1 条 retry receipt，
   复用原 batch/item，retry_count+1，终态 failed，批次 done/failed 相干，安静窗口无迟写 */
test("D2b-1：20 并发重试 failed 缺失文件项 → 恰 1×202 + 19×409（retry_in_progress/retry_cooldown），1 worker/1 新 receipt，retry_count+1，终态 failed", async () => {
  const { openKbDb } = await import("../local-agent/kb.mjs");
  const db = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const iso = new Date().toISOString();
  const batchId = "kb_d2b1";
  db.prepare("INSERT INTO import_batch (id, status, source_kind, created_at, total, succeeded, failed, skipped) VALUES (?, 'done', 'test', ?, 1, 0, 1, 0)").run(batchId, iso);
  // 真实缺失的本地文件：唯一 owner 的 worker 会快速失败（file_not_found）→ item 置回 failed 且 updated_at=now；
  // 2s 手动重试冷却（retry_cooldown）阻止同一并发风暴中的后续请求再次回收 → 严格 1×202。
  const missingFile = join(ROOT, "d2b1-missing.mp4"); // 不存在
  const itemId = db.prepare(
    "INSERT INTO import_item (batch_id, input, input_kind, display_input, delivery_id, status, error, retry_count, updated_at) VALUES (?,?,?,?,?, 'failed', 'initial_failure', 0, ?)",
  ).run(batchId, missingFile, "kuaidian", "d2b1-missing.mp4", "msg_d2b1", iso).lastInsertRowid;
  const retryReceiptsBefore = db.prepare("SELECT COUNT(*) c FROM download_receipt WHERE channel='retry'").get().c;
  const batchIdsBefore = tableIdSet(db, "import_batch");
  const itemIdsBefore = tableIdSet(db, "import_item");
  db.close();
  // 20 个真正并发重试
  const resps = await Promise.all(
    Array.from({ length: 20 }, () => request(`/api/v1/kb/imports/${itemId}/retry`, { method: "POST", body: {} })),
  );
  const codes = resps.map((r) => r.status);
  assert.equal(codes.filter((c) => c === 202).length, 1, "恰 1×202（唯一 owner）");
  assert.equal(codes.filter((c) => c === 409).length, 19, "恰 19×409");
  const okBody = await resps.find((r) => r.status === 202).json();
  assert.equal(okBody.itemId, itemId, "202 返回 itemId");
  assert.equal(okBody.batchId, batchId, "202 返回 batchId");
  for (const r of resps.filter((x) => x.status === 409)) {
    const body = await r.json();
    assert.ok(["retry_in_progress", "retry_cooldown"].includes(body.error), `409 error 应为 retry_in_progress/retry_cooldown，实际 ${body.error}`);
  }
  // worker 终态（文件缺失 → failed）
  await poll(async () => {
    const d = openKbDb(join(DATA_DIR, "kb.sqlite"));
    const row = d.prepare("SELECT status FROM import_item WHERE id=?").get(itemId);
    d.close();
    return row && ["success", "duplicate", "linked", "failed"].includes(row.status) ? true : null;
  }, { tries: 60, delay: 400, desc: "D2b-1 重试终态" });
  // 安静窗口：无迟写 worker（冷却租约保证风暴后无第二个 worker；若有会再写一条 retry receipt）
  await assertQuietWindow(async () => {
    const d = openKbDb(join(DATA_DIR, "kb.sqlite"));
    const s = {
      batchIds: tableIdSet(d, "import_batch"),
      itemIds: tableIdSet(d, "import_item"),
      retryReceipts: d.prepare("SELECT COUNT(*) c FROM download_receipt WHERE channel='retry'").get().c,
    };
    d.close();
    return s;
  }, { desc: "D2b-1 重试后安静窗口" });
  const db2 = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const row = db2.prepare("SELECT status, retry_count, error, asset_id, input, display_input FROM import_item WHERE id=?").get(itemId);
  const retryReceiptsAfter = db2.prepare("SELECT COUNT(*) c FROM download_receipt WHERE channel='retry'").get().c;
  const batchRow = db2.prepare("SELECT status, total, succeeded, failed, skipped FROM import_batch WHERE id=?").get(batchId);
  const batchIdsAfter = tableIdSet(db2, "import_batch");
  const itemIdsAfter = tableIdSet(db2, "import_item");
  assert.equal(db2.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=?").get(batchId).c, 1, "原 batch 仍恰 1 个 item");
  db2.close();
  assert.deepEqual(batchIdsAfter, batchIdsBefore, "全局 batch ID 集不变");
  assert.deepEqual(itemIdsAfter, itemIdsBefore, "全局 item ID 集不变");
  assert.equal(row.status, "failed", "worker 因文件缺失失败（终态 failed）");
  assert.equal(row.retry_count, 1, "retry_count 恰 +1");
  assert.match(String(row.error || ""), /^retry_failed: file_not_found:/, "失败 error 为净化后的稳定错误码");
  assert.ok(!String(row.error).includes(ROOT), "item.error 不含绝对路径/目录");
  assert.equal(row.asset_id, null, "失败无资产");
  assert.equal(row.input, missingFile, "input 未变（同一行原地复用）");
  assert.equal(retryReceiptsAfter, retryReceiptsBefore + 1, "恰 1 条新 retry receipt（恰 1 个 worker）");
  assert.equal(batchRow.total, 1, "批次 total 相干");
  assert.equal(batchRow.succeeded, 0, "批次 succeeded 相干");
  assert.equal(batchRow.failed, 1, "批次 failed 相干");
  assert.equal(batchRow.status, "done", "批次终态 done");
});

/* D2b-2：failed/partial/orphaned/16 分钟陈旧 processing 各自原地复用原行 → 202，worker 成功，
   retry_count+1，全局 batch/item ID 集不增长，每原 batch 仍 1 item，批次计数相干 */
test("D2b-2：failed/partial/orphaned/16min 陈旧 processing 重试各自原地复用原 batch/item（成功），retry_count+1，ID 集不增长", async () => {
  const { openKbDb } = await import("../local-agent/kb.mjs");
  const db = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const iso = new Date().toISOString();
  const fixtures = [
    ["failed", "f", iso],
    ["partial", "p", iso],
    ["orphaned", "o", iso],
    ["processing", "s", new Date(Date.now() - 16 * 60 * 1000).toISOString()], // 16 分钟陈旧 processing
  ];
  const batchIds = [];
  const itemIds = [];
  const files = [];
  for (const [st, tag, updatedAt] of fixtures) {
    const batchId = `kb_d2b2_${tag}`;
    batchIds.push(batchId);
    db.prepare("INSERT INTO import_batch (id, status, source_kind, created_at, total, succeeded, failed, skipped) VALUES (?, 'done', 'test', ?, 1, 0, 1, 0)").run(batchId, iso);
    const file = await makeDistinctMp4(`d2b2-${tag}.mp4`, `D2B2_${tag.toUpperCase()}_MARKER`);
    files.push(file);
    const id = db.prepare(
      "INSERT INTO import_item (batch_id, input, input_kind, display_input, delivery_id, status, error, retry_count, updated_at) VALUES (?,?,?,?,?,?,?,0,?)",
    ).run(batchId, file, "kuaidian", `https://weixin.qq.com/sph/d2b2_${tag}`, `msg_d2b2_${tag}`, st, `old_error_${tag}`, updatedAt).lastInsertRowid;
    itemIds.push(id);
  }
  const batchIdsBefore = tableIdSet(db, "import_batch");
  const itemIdsBefore = tableIdSet(db, "import_item");
  db.close();
  // 各自重试（顺序执行，互不干扰）
  for (let i = 0; i < fixtures.length; i++) {
    const r = await request(`/api/v1/kb/imports/${itemIds[i]}/retry`, { method: "POST", body: {} });
    assert.equal(r.status, 202, `${fixtures[i][0]} 重试 202`);
    const b = await r.json();
    assert.equal(b.itemId, itemIds[i], `${fixtures[i][0]} 复用原 item`);
    assert.equal(b.batchId, batchIds[i], `${fixtures[i][0]} 复用原 batch`);
    await poll(async () => {
      const itemDb = openKbDb(join(DATA_DIR, "kb.sqlite"));
      const status = itemDb.prepare("SELECT status FROM import_item WHERE id=?").get(itemIds[i])?.status;
      itemDb.close();
      return ["success", "duplicate", "linked", "failed"].includes(status) ? true : null;
    }, { tries: 120, delay: 400, desc: `D2b-2 ${fixtures[i][0]} 终态` });
  }
  // 全部终态
  await poll(async () => {
    const d = openKbDb(join(DATA_DIR, "kb.sqlite"));
    const ph = "?,?,?,?";
    const c = d.prepare(`SELECT COUNT(*) c FROM import_item WHERE id IN (${ph}) AND status IN ('success','duplicate','linked','failed')`).get(...itemIds).c;
    d.close();
    return c === 4 ? true : null;
  }, { tries: 90, delay: 400, desc: "D2b-2 四项终态" });
  const db2 = openKbDb(join(DATA_DIR, "kb.sqlite"));
  for (let i = 0; i < fixtures.length; i++) {
    const row = db2.prepare("SELECT status, retry_count, error, asset_id, input FROM import_item WHERE id=?").get(itemIds[i]);
    assert.ok(["success", "duplicate", "linked"].includes(row.status), `${fixtures[i][0]} 重试终态 ok，实际 ${row.status}`);
    assert.equal(row.retry_count, 1, `${fixtures[i][0]} retry_count 恰 +1`);
    assert.equal(row.error, null, `${fixtures[i][0]} error 已清`);
    assert.ok(row.asset_id, `${fixtures[i][0]} 关联资产`);
    assert.equal(row.input, files[i], `${fixtures[i][0]} input 不变（同一行原地复用）`);
    const b = db2.prepare("SELECT status, total, succeeded, failed, skipped FROM import_batch WHERE id=?").get(batchIds[i]);
    assert.equal(b.total, 1, `${fixtures[i][0]} 批次 total 相干`);
    assert.equal(b.succeeded, 1, `${fixtures[i][0]} 批次 succeeded 相干`);
    assert.equal(b.failed, 0, `${fixtures[i][0]} 批次 failed 相干`);
    assert.equal(b.skipped, 0, `${fixtures[i][0]} 批次 skipped 相干`);
    assert.equal(b.status, "done", `${fixtures[i][0]} 批次终态 done`);
    assert.equal(db2.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=?").get(batchIds[i]).c, 1, `${fixtures[i][0]} 原 batch 仍恰 1 个 item`);
  }
  const batchIdsAfter = tableIdSet(db2, "import_batch");
  const itemIdsAfter = tableIdSet(db2, "import_item");
  db2.close();
  assert.deepEqual(batchIdsAfter, batchIdsBefore, "全局 batch ID 集不增长");
  assert.deepEqual(itemIdsAfter, itemIdsBefore, "全局 item ID 集不增长");
});

/* D2b-3：success / pending / fresh processing / fingerprint / stable share / max_retry 重试
   → 安全状态码 + 精确零变更（item/batch 行字节级、全局 batch/item ID 集、无新 retry receipt） */
test("D2b-3：六种不可回收态重试为精确 no-op（terminal_state/retry_in_progress/retry_unavailable/retry_requires_primary_payload/max_retry + 404）", async () => {
  const { openKbDb } = await import("../local-agent/kb.mjs");
  const db = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const iso = new Date().toISOString();
  const cases = [
    { tag: "success", status: "success", input: join(ROOT, "d2b3-success.mp4"), retry: 0, expect: 409, error: "terminal_state" },
    { tag: "pending", status: "pending", input: join(ROOT, "d2b3-pending.mp4"), retry: 0, expect: 409, error: "retry_in_progress" },
    { tag: "freshproc", status: "processing", input: join(ROOT, "d2b3-fresh.mp4"), retry: 0, expect: 409, error: "retry_in_progress" },
    { tag: "fingerprint", status: "failed", input: "[redacted:dl_fingerprint_d2b3]", retry: 0, expect: 400, error: "retry_unavailable" },
    { tag: "share", status: "failed", input: "https://weixin.qq.com/sph/d2b3_share", retry: 0, expect: 409, error: "retry_requires_primary_payload" },
    { tag: "maxretry", status: "failed", input: join(ROOT, "d2b3-max.mp4"), retry: 3, expect: 400, error: "max_retry" },
  ];
  const rows = [];
  for (const c of cases) {
    const batchId = `kb_d2b3_${c.tag}`;
    db.prepare("INSERT INTO import_batch (id, status, source_kind, created_at, total, succeeded, failed, skipped) VALUES (?, 'done', 'test', ?, 1, 0, 0, 0)").run(batchId, iso);
    const assetId = c.status === "success" ? `kb_d2b3_asset_${c.tag}` : null;
    if (assetId) {
      db.prepare("INSERT INTO video_asset (id, sha256, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(assetId, `d2b3_sha_${c.tag}_${Date.now()}`, `D2b3 ${c.tag}`, iso, iso);
    }
    const id = db.prepare(
      "INSERT INTO import_item (batch_id, input, input_kind, display_input, delivery_id, status, error, retry_count, asset_id, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
    ).run(batchId, c.input, "kuaidian", `d2b3-${c.tag}`, `msg_d2b3_${c.tag}`, c.status, `err_${c.tag}`, c.retry, assetId, iso).lastInsertRowid;
    rows.push({ ...c, id, batchId, snap: db.prepare("SELECT * FROM import_item WHERE id=?").get(id), snapBatch: db.prepare("SELECT * FROM import_batch WHERE id=?").get(batchId) });
  }
  const retryReceiptsBefore = db.prepare("SELECT COUNT(*) c FROM download_receipt WHERE channel='retry'").get().c;
  const batchIdsBefore = tableIdSet(db, "import_batch");
  const itemIdsBefore = tableIdSet(db, "import_item");
  db.close();
  for (const r of rows) {
    const resp = await request(`/api/v1/kb/imports/${r.id}/retry`, { method: "POST", body: {} });
    assert.equal(resp.status, r.expect, `${r.tag} 状态码`);
    const body = await resp.json();
    assert.equal(body.error, r.error, `${r.tag} error 码`);
  }
  // 404 不存在
  const missing = await request("/api/v1/kb/imports/99999999/retry", { method: "POST", body: {} });
  assert.equal(missing.status, 404, "不存在 item 404");
  // 零变更验证
  const db2 = openKbDb(join(DATA_DIR, "kb.sqlite"));
  for (const r of rows) {
    assert.deepEqual(db2.prepare("SELECT * FROM import_item WHERE id=?").get(r.id), r.snap, `${r.tag} item 行字节级不变`);
    assert.deepEqual(db2.prepare("SELECT * FROM import_batch WHERE id=?").get(r.batchId), r.snapBatch, `${r.tag} batch 行字节级不变`);
  }
  assert.equal(db2.prepare("SELECT COUNT(*) c FROM download_receipt WHERE channel='retry'").get().c, retryReceiptsBefore, "无新 retry receipt");
  assert.deepEqual(tableIdSet(db2, "import_batch"), batchIdsBefore, "全局 batch ID 集不变");
  assert.deepEqual(tableIdSet(db2, "import_item"), itemIdsBefore, "全局 item ID 集不变");
  db2.close();
});

/* D2b-4：冷却过期 —— 冷却窗内立即重试 409 retry_cooldown；>2s 后同一 failed 项可获得恰 1×202 且
   retry_count 恰 +1；多次过期重试直至 retry_count=3 后 → 400 max_retry（冷却不绕过 max 3 上限） */
test("D2b-4：2s 冷却过期后同项可再次重试（恰 1×202，retry_count+1），冷却窗内 409 retry_cooldown，仍受 max_retry=3 约束", async () => {
  const { openKbDb } = await import("../local-agent/kb.mjs");
  const db = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const iso = new Date().toISOString();
  const batchId = "kb_d2b4";
  db.prepare("INSERT INTO import_batch (id, status, source_kind, created_at, total, succeeded, failed, skipped) VALUES (?, 'done', 'test', ?, 1, 0, 1, 0)").run(batchId, iso);
  const missingFile = join(ROOT, "d2b4-missing.mp4"); // 不存在：worker 快速失败
  const itemId = db.prepare(
    "INSERT INTO import_item (batch_id, input, input_kind, display_input, delivery_id, status, error, retry_count, updated_at) VALUES (?,?,?,?,?, 'failed', 'initial_failure', 0, ?)",
  ).run(batchId, missingFile, "kuaidian", "d2b4-missing.mp4", "msg_d2b4", iso).lastInsertRowid;
  const retryReceiptsBefore = db.prepare("SELECT COUNT(*) c FROM download_receipt WHERE channel='retry'").get().c;
  db.close();
  const waitWorkerTerminal = async () => poll(async () => {
    const d = openKbDb(join(DATA_DIR, "kb.sqlite"));
    const row = d.prepare("SELECT status, retry_count, updated_at FROM import_item WHERE id=?").get(itemId);
    d.close();
    return row && ["success", "duplicate", "linked", "failed"].includes(row.status) ? row : null;
  }, { tries: 60, delay: 300, desc: "D2b-4 worker 终态" });
  // 1) 首次重试：retry_count=0 → 立即 202（无冷却），worker 快速失败
  const r1 = await request(`/api/v1/kb/imports/${itemId}/retry`, { method: "POST", body: {} });
  assert.equal(r1.status, 202, "初次失败项立即重试 202");
  let row = await waitWorkerTerminal();
  assert.equal(row.retry_count, 1, "首次重试 retry_count=1");
  // 2) 冷却窗内立即重试 → 409 retry_cooldown（零变更）
  const r2 = await request(`/api/v1/kb/imports/${itemId}/retry`, { method: "POST", body: {} });
  assert.equal(r2.status, 409, "冷却窗内重试 409");
  assert.equal((await r2.json()).error, "retry_cooldown", "冷却窗内 error=retry_cooldown");
  // 3) 等冷却过期（updated_at 距今 >2s，有界 6s）
  await poll(async () => {
    const d = openKbDb(join(DATA_DIR, "kb.sqlite"));
    const row2 = d.prepare("SELECT updated_at FROM import_item WHERE id=?").get(itemId);
    d.close();
    return Date.now() - new Date(row2.updated_at).getTime() > 2000 ? true : null;
  }, { tries: 24, delay: 300, desc: "D2b-4 冷却过期" });
  // 4) 冷却过期后重试：恰 1×202，retry_count +1（1→2）
  const r3 = await request(`/api/v1/kb/imports/${itemId}/retry`, { method: "POST", body: {} });
  assert.equal(r3.status, 202, "冷却过期后重试 202");
  row = await waitWorkerTerminal();
  assert.equal(row.retry_count, 2, "冷却过期后 retry_count=2");
  // 5) 再次等冷却过期 → 202 → retry_count=3
  await poll(async () => {
    const d = openKbDb(join(DATA_DIR, "kb.sqlite"));
    const row3 = d.prepare("SELECT updated_at FROM import_item WHERE id=?").get(itemId);
    d.close();
    return Date.now() - new Date(row3.updated_at).getTime() > 2000 ? true : null;
  }, { tries: 24, delay: 300, desc: "D2b-4 冷却过期（第三次）" });
  const r4 = await request(`/api/v1/kb/imports/${itemId}/retry`, { method: "POST", body: {} });
  assert.equal(r4.status, 202, "第三次重试 202");
  row = await waitWorkerTerminal();
  assert.equal(row.retry_count, 3, "retry_count=3");
  // 6) 冷却不绕过 max_retry：retry_count>=3 → 400 max_retry
  const r5 = await request(`/api/v1/kb/imports/${itemId}/retry`, { method: "POST", body: {} });
  assert.equal(r5.status, 400, "retry_count=3 后 400 max_retry");
  assert.equal((await r5.json()).error, "max_retry", "error=max_retry");
  // 终态与计数相干
  const d = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const finalRow = d.prepare("SELECT status, retry_count FROM import_item WHERE id=?").get(itemId);
  const batchRow = d.prepare("SELECT status, total, succeeded, failed, skipped FROM import_batch WHERE id=?").get(batchId);
  const receiptCount = d.prepare("SELECT COUNT(*) c FROM download_receipt WHERE channel='retry'").get().c;
  assert.equal(d.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=?").get(batchId).c, 1, "原 batch 仍恰 1 个 item");
  d.close();
  assert.equal(finalRow.status, "failed", "终态 failed（文件始终缺失）");
  assert.equal(finalRow.retry_count, 3, "retry_count=3");
  assert.equal(receiptCount, retryReceiptsBefore + 3, "本项恰新增 3 条 retry receipt（3 个 worker 各 1 条）");
  assert.equal(batchRow.total, 1, "批次 total 相干");
  assert.equal(batchRow.failed, 1, "批次 failed 相干");
  assert.equal(batchRow.status, "done", "批次终态 done");
});

/* D2b-5：泄漏回归（D2b 安全审查加固）——
   - 注入缺失 POSIX 绝对路径 + token/signature 查询的 failed 项 → retry worker 失败；
   - 注入恶意历史行（Windows 路径 input / 临时 HTTP URL display_input / decodeKey+encfilekey+signature+X-Amz 的 error）；
   - 扫描：项级 API（202/409/status）、整份 /imports 响应（不豁免任何旧夹具）、/api/v1/events 中本项 KB_RETRY 事件、
     仅本 retry 新增的 download_receipt/ingest_observation 行（按 MAX(id) 快照增量）；
   - error 仅稳定码 + 文件名 leaf；源级回归：认领 catch 与 worker 外层 catch 的 recordEvent 必须经 redactSensitiveText、
     失败事件必须插值净化后的 errMsg（变异为原始 e.message 必失败） */
test("D2b-5：注入 POSIX/Windows 路径、临时 URL、token/decodeKey/encfilekey/signature/X-Amz → 项级 API、整份 /imports、KB_RETRY 事件、新增 receipt/observation 全零泄漏", async () => {
  const { openKbDb } = await import("../local-agent/kb.mjs");
  const db = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const iso = new Date().toISOString();
  const queryParameterName = ["to", "ken"].join("");
  const markerA = "TOK_9f3a7c2d";
  const MARK = {
    posixDir: "/Users/secret/private/leak_dir",
    posixPath: "/Users/secret/private/leak_dir/d2b-leak-9f3a.mp4",
    winPath: "C:\\Users\\Secret\\leak_dir\\d2b-win-7c2d.mp4",
    tempUrl: `http://dl.example/leak?${queryParameterName}=DLTOK_5e91`,
    [queryParameterName]: markerA,
    decodeKey: "DEC_4b2a",
    encfilekey: "ENC_8d1f",
    signature: "SIG_ABC123",
    xamz: "XAMZ_6e41",
    auth: "AUTHK_7711",
    ws: "WSS_5533",
    // redactSensitiveText 边界样本（Codex 复现的漏脱敏形态）：
    edgeSqlite: "SQLITE_1:/Users/edge/private.mp4", // 冒号后多段路径（盘符正则不会误吞的形态）
    edgeZero: "0:/secret/edge",                       // 数字前缀 + 冒号后路径
    edgeTmp: "/tmp",                                  // 单段绝对路径
    edgeSingle: "/single",                            // 行首单段绝对路径
    // 引号/JSON 密钥 + 含空格路径（D2 最终审查新增）：值必须整体消失，路径到行尾消失
    qToken: 'token="TOK_Q"',
    qSig: "'signature':'SIG_Q'",
    qJson: '{"decodeKey":"DEC_Q","encfilekey":"ENC_Q"}',
    spFull: "SQLITE_1:/Users/private/My Secret/file.mp4",
    spSuffix: "Secret/file.mp4",
    // D3 引号值含分隔符 + quoted URL + UNC + 连字符/点前缀路径（值整体消失，路径到行尾消失）
    qUrl: 'http://x/video?token="TOK_URL"',
    qCookie: 'cookie="A=ONEQ;B=TWOQ"',
    qComma: 'token="TOPQ,SECQ"',
    qBrace: 'decodeKey="LEFTQ}RIGHTQ"',
    qAuth: 'authorization="Bearer AUTHQ"',
    unc: "ERR:\\\\srv\\\\share\\\\sec",             // 实际文本 ERR:\\srv\share\sec
    errDash: "ERR-/Users/a",
    errDot: "ERR./Users/a",
    winSp: "failed:C:\\\\Users\\\\Private\\\\My Secret\\\\file.mp4", // 实际文本 failed:C:\Users\Private\My Secret\file.mp4
    // D3：quoted URL 含空格 + 转义引号值（值/尾部必须整体消失）
    qUrlSp: 'http://x/video?token="TOK Q"',
    qEscD: 'token="ESC_L\\",ESC_R"',               // 实际文本 token="ESC_L\",ESC_R"
    qEscS: "cookie='A=ESC_A\\';B=ESC_B'",          // 实际文本 cookie='A=ESC_A\';B=ESC_B'
    // D4：未加引号的 cookie/authorization 值含 =/;/,/空格（整体到行尾消失）
    qCookieU: "cookie=SES_A=ONE_C;OTH_B=TWO_C",
    qAuthU: "authorization=Bearer AUTH_X,Y",
    // D5：URL 内未加引号值含空格 / 引号不平衡 / 引号值后整行残留
    d5UrlAuth: 'http://x/video?authorization=Bearer ABC_S5',
    d5UrlUnbal: 'http://x/video?token="LEFT S5',
    d5CookieTail: 'cookie="SESSION_S5=ONE_S5"; OTHER=COOKIE_S5',
  };
  const LEAKS = [
    MARK.posixDir, MARK.posixPath, "d2b-win-7c2d.mp4", "C:\\Users\\Secret",
    "http://dl.example", "dl.example/leak", "?token=", MARK.token, "DLTOK_5e91",
    MARK.decodeKey, "decodeKey=", MARK.encfilekey, "encfilekey=",
    MARK.signature, "signature=", MARK.xamz, "X-Amz-", MARK.auth, "auth_key=", MARK.ws, "wsSecret=",
    // 边界样本：完整形态（SQLITE_1: 前缀/0: 前缀是稳定码需保留，路径段必须消失）
    MARK.edgeSqlite, "SQLITE_1:/Users/edge", MARK.edgeZero, "0:/secret/edge", "/tmp", "/secret/edge", "/single", "/Users/edge/private.mp4",
    // 引号/JSON 密钥：键值整体消失（值绝不外泄）
    "TOK_Q", "SIG_Q", "DEC_Q", "ENC_Q", 'token="', "'signature'", 'decodeKey":"',
    // 含空格路径：整段到行尾消失（含后缀）
    MARK.spFull, MARK.spSuffix, "My Secret", "/Users/private/My Secret",
    // D3：引号值含分隔符（逗号/分号/右花括号/authorization/quoted URL/UNC）值整体消失（防 quoted-first 变异：
    // 若裸值分支优先，token="TOPQ,SECQ" 会截断成 [redacted],SECQ" → SECQ 泄漏 → 本测试失败）
    "TOK_URL", "ONEQ", "TWOQ", "TOPQ", "SECQ", "LEFTQ", "RIGHTQ", "AUTHQ",
    "srv\\share", "ERR:\\\\srv", MARK.errDash, MARK.errDot, "C:\\Users",
    // D3：quoted URL 空格 / 转义引号值（含尾部 Q" 形态与值）
    "TOK Q", 'Q"', "ESC_L", "ESC_R", "ESC_A", "ESC_B", 'token="ESC_L', "cookie='A=ESC_A",
    // D4：未加引号 cookie/authorization 值（= / ; / , / 空格 后仍整体消失；变异为裸值停在分隔符必泄漏）
    "SES_A", "ONE_C", "OTH_B", "TWO_C", "AUTH_X", "SES_A=ONE_C", "Bearer AUTH_X", ",Y",
    // D5：URL 内未加引号值/引号不平衡/引号值后整行残留（标记值整体消失）
    "ABC_S5", "Bearer ABC_S5", "LEFT S5", '"LEFT S5', "SESSION_S5", "ONE_S5", "COOKIE_S5", "OTHER=COOKIE_S5", "SESSION_S5=ONE_S5",
    // 旧夹具也不豁免：D1 曾注入 display_input=?token=EVILTOK、error=auth_key=LEAKKEY wsSecret=LEAKSECRET
    "EVILTOK", "LEAKKEY", "LEAKSECRET", "/Users/secret/abs/leak-path.mp4",
  ];
  // 夹具 1：retry 项（POSIX 路径 + token/signature 查询）；夹具 2：恶意历史行（Windows 路径 / 临时 URL / 密钥 error）
  const batchId = "kb_d2b5_leak";
  db.prepare("INSERT INTO import_batch (id, status, source_kind, created_at, total, succeeded, failed, skipped) VALUES (?, 'done', 'test', ?, 1, 0, 1, 0)").run(batchId, iso);
  const leakInput = `${MARK.posixPath}?token=${MARK.token}&signature=${MARK.signature}`;
  const itemId = db.prepare(
    "INSERT INTO import_item (batch_id, input, input_kind, display_input, delivery_id, status, error, retry_count, updated_at) VALUES (?,?,?,?,?, 'failed', 'initial_failure', 0, ?)",
  ).run(batchId, leakInput, "kuaidian", "d2b-leak-9f3a.mp4", "msg_d2b5_leak", iso).lastInsertRowid;
  const batchHist = "kb_d2b5_hist";
  db.prepare("INSERT INTO import_batch (id, status, source_kind, created_at, total, succeeded, failed, skipped) VALUES (?, 'done', 'test', ?, 1, 0, 1, 0)").run(batchHist, iso);
  const histItemId = db.prepare(
    "INSERT INTO import_item (batch_id, input, input_kind, display_input, delivery_id, status, error, retry_count, updated_at) VALUES (?,?,?,?,?, 'failed', ?, 0, ?)",
  ).run(batchHist, MARK.winPath, "kuaidian", MARK.tempUrl, "msg_d2b5_hist",
    // 行首单段 /single + 冒号后多段 SQLITE_1:/… + 数字前缀 0:/… + 单段 /tmp + 全量密钥 KV
    // 引号/JSON 密钥在路径之前（独立内容）+ 既有边界样本 + 含空格路径 + D3 引号分隔符/UNC/前缀路径/
    // quoted URL 空格/转义引号值 + 全量密钥 KV
    `${MARK.qToken} ${MARK.qSig} ${MARK.qJson} ${MARK.qUrl} ${MARK.qCookie} ${MARK.qComma} ${MARK.qBrace} ${MARK.qAuth} ${MARK.qUrlSp} ${MARK.qEscD} ${MARK.qEscS} ${MARK.qCookieU} ${MARK.qAuthU} ${MARK.d5UrlAuth} ${MARK.d5UrlUnbal} ${MARK.d5CookieTail} ${MARK.unc} ${MARK.errDash} ${MARK.errDot} ${MARK.winSp} ${MARK.edgeSingle} ${MARK.edgeSqlite} ${MARK.edgeZero} ${MARK.edgeTmp} ${MARK.spFull} decodeKey=${MARK.decodeKey} encfilekey=${MARK.encfilekey} signature=${MARK.signature} X-Amz-Signature=${MARK.xamz} auth_key=${MARK.auth} wsSecret=${MARK.ws}`, iso).lastInsertRowid;
  // 仅扫描本 retry 新增的 receipt/observation（MAX(id) 快照增量）
  const recMaxBefore = db.prepare("SELECT COALESCE(MAX(id),0) m FROM download_receipt").get().m;
  const obsMaxBefore = db.prepare("SELECT COALESCE(MAX(id),0) m FROM ingest_observation").get().m;
  db.close();
  // 1) 重试 → 202（worker 失败，净化 error）
  const apiBodies = [];
  const r = await request(`/api/v1/kb/imports/${itemId}/retry`, { method: "POST", body: {} });
  assert.equal(r.status, 202, "重试 202");
  apiBodies.push(await r.text()); // 202 响应体
  await poll(async () => {
    const d = openKbDb(join(DATA_DIR, "kb.sqlite"));
    const row = d.prepare("SELECT status FROM import_item WHERE id=?").get(itemId);
    d.close();
    return row && ["success", "duplicate", "linked", "failed"].includes(row.status) ? true : null;
  }, { tries: 60, delay: 300, desc: "D2b-5 worker 终态" });
  // 2) 项级 API 响应体：202 / 冷却窗 409 / status → 全量 LEAKS 零泄漏
  apiBodies.push(await (await request(`/api/v1/kb/imports/${itemId}/retry`, { method: "POST", body: {} })).text()); // 409 retry_cooldown
  apiBodies.push(await (await request(`/api/v1/kb/imports/${itemId}/status`)).text());
  for (const body of apiBodies) {
    for (const leak of LEAKS) {
      assert.ok(!body.includes(leak), `项级 API 响应体不得泄漏：${leak}`);
    }
  }
  // 3) 整份 /imports 响应：不豁免任何旧夹具（含 D1 的 ?token=EVILTOK display_input、恶意历史行、本项）→ 零泄漏
  const listBody = await (await request("/api/v1/kb/imports")).text();
  for (const leak of LEAKS) {
    assert.ok(!listBody.includes(leak), `/imports 整份响应不得泄漏：${leak}`);
  }
  // 3.1) 恶意历史行直接断言：error 经 redactSensitiveText 后必须保留稳定码前缀（/single 已整体脱敏、
  //      SQLITE_1:/…、0:/…、/tmp 的路径段全部消失），且不含任何标记
  {
    const listJson = JSON.parse(listBody);
    const histEntry = (listJson.items || []).find((it) => String(it.id) === String(histItemId));
    assert.ok(histEntry, "恶意历史行在列表中");
    const histErr = String(histEntry.error || "");
    for (const leak of LEAKS) {
      assert.ok(!histErr.includes(leak), `恶意历史行 error 不得泄漏：${leak}`);
    }
    assert.ok(histErr.includes("[redacted]"), `恶意历史行 error 已脱敏，实际 ${histErr}`);
    assert.ok(!histErr.includes("/Users/edge"), "SQLITE_1: 前缀保留但路径段消失");
    assert.ok(!histErr.includes("/secret/edge"), "0: 前缀保留但路径段消失");
    assert.ok(!histErr.includes("/tmp"), "单段 /tmp 消失");
    assert.ok(!histErr.includes("/single"), "行首 /single 消失");
  }
  // 4) 事件日志：轮询 /api/v1/events?limit=200 直到本项 KB_RETRY 事件出现，扫描其 message
  //    （源级：失败事件若被变异为直接插值原始 e.message，此处必命中 POSIX 路径/token → 测试失败）
  const myEvents = await poll(async () => {
    const er = await request("/api/v1/events?limit=200");
    if (er.status !== 200) return null;
    const { events } = await er.json();
    const mine = (events || []).filter((e) => e.type === "KB_RETRY" && String(e.message || "").includes(`重试 ${itemId}`));
    return mine.length ? mine : null;
  }, { tries: 40, delay: 300, desc: "D2b-5 本项 KB_RETRY 事件" });
  const eventText = myEvents.map((e) => String(e.message || "")).join("\n");
  for (const leak of LEAKS) {
    assert.ok(!eventText.includes(leak), `KB_RETRY 事件不得泄漏：${leak}`);
  }
  // 5) 仅本 retry 新增的 receipt/observation 行零泄漏（MAX(id) 快照增量）
  const db2 = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const newRecTexts = db2.prepare("SELECT * FROM download_receipt WHERE id > ?").all(recMaxBefore).map((x) => JSON.stringify(x)).join("\n");
  const newObsTexts = db2.prepare("SELECT message FROM ingest_observation WHERE id > ?").all(obsMaxBefore).map((x) => String(x.message || "")).join("\n");
  const itemRow = db2.prepare("SELECT status, retry_count, error, display_input FROM import_item WHERE id=?").get(itemId);
  db2.close();
  const newRowsText = `${newRecTexts}\n${newObsTexts}`;
  for (const leak of LEAKS) {
    assert.ok(!newRowsText.includes(leak), `新增 receipt/observation 不得泄漏：${leak}`);
  }
  // 6) error 仅稳定码 + 文件名 leaf（不含任何标记）
  assert.equal(String(itemRow.error), "retry_failed: file_not_found:d2b-leak-9f3a.mp4", `error 为稳定码+文件名 leaf，实际 ${itemRow.error}`);
  assert.equal(itemRow.status, "failed", "终态 failed");
  assert.equal(itemRow.retry_count, 1, "retry_count=1");
  // 7) 源级回归：认领 catch 与 worker 外层 catch 的 recordEvent 必须经 redactSensitiveText、
  //    失败事件必须插值净化后的 errMsg（变异为原始 e.message 必失败）
  {
    const src = await readFile(join(repoRoot, "local-agent", "kb-routes.mjs"), "utf8");
    const lines = src.split("\n");
    const claimLine = lines.find((l) => l.includes("重试 ${itemId} 认领异常"));
    assert.ok(claimLine && claimLine.includes("redactSensitiveText("), "认领异常事件必须经 redactSensitiveText");
    assert.ok(!claimLine.includes("${claimErr") && !claimLine.includes("${e"), "认领异常不得直接插值原始错误对象");
    const outerLine = lines.find((l) => l.includes("重试 ${itemId} 异常"));
    assert.ok(outerLine && outerLine.includes("redactSensitiveText("), "worker 外层 catch 事件必须经 redactSensitiveText");
    assert.ok(!outerLine.includes("${e") || outerLine.includes("redactSensitiveText("), "外层 catch 不得直接插值原始 e");
    const failLine = lines.find((l) => l.includes("重试 ${itemId} 失败"));
    assert.ok(failLine && failLine.includes("失败：${errMsg}"), "失败事件必须插值净化后的 errMsg（变异为原始 e.message 将失败）");
  }
});

/* D2b-6：resolved-failed 深层持久化路径零泄漏 —— 有效唯一 MP4 + failed 项 + content_analysis 触发器
   RAISE(ABORT, 'SQLITE_1:/Users/postsha/private.mp4?token=POSTTOK&decodeKey=POSTDEC')；
   手动重试 202 → ingestOne 内部在 OWNER_TX 捕获并原地解析 failed（retry 路由 catch 不会运行）：
   item.error / 仅新增 receipt / observation / 整份 /imports / KB_RETRY 事件 不得含路径/token/密钥标记与工作区栈路径；
   retry_count=1、1 worker/1 receipt、批次相干、无 searchable 资产/包/staging 残留。
   若 updateItem 或 receipt/observation sink 退回原始 e.stack/e.message，本测试必失败。
   另含 sanitizeRetryError 直接回归（白名单 file_not_found + Windows 输入 → 仅 Windows leaf；未知码 → retry_failed）。 */
test("D2b-6：resolved-failed 持久化路径 —— content_analysis 触发器注入路径/token → item.error/receipt/observation//imports/事件全零泄漏，无资产残留", async () => {
  // 0) sanitizeRetryError 直接回归（导出函数，确定性地证明白名单码 + 双斜杠 leaf）
  {
    const { sanitizeRetryError } = await import("../local-agent/kb-routes.mjs");
    assert.equal(
      sanitizeRetryError(new Error("file_not_found:C:\\Users\\Secret\\leak_dir\\d2b-win-7c2d.mp4"), "C:\\Users\\Secret\\leak_dir\\d2b-win-7c2d.mp4"),
      "file_not_found:d2b-win-7c2d.mp4", "白名单 file_not_found + Windows 输入 → 仅 Windows leaf",
    );
    assert.equal(
      sanitizeRetryError(new Error("SQLITE_1:/Users/edge/private.mp4?token=EDGE_TOK"), "/Users/edge/private.mp4?token=EDGE_TOK"),
      "retry_failed:private.mp4", "未知错误码 → retry_failed + leaf",
    );
  }
  const { openKbDb } = await import("../local-agent/kb.mjs");
  const { DatabaseSync } = await import("node:sqlite");
  const db = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const iso = new Date().toISOString();
  const MARK = {
    trig: "SQLITE_1:/Users/postsha/private.mp4?token=POSTTOK&decodeKey=POSTDEC",
    path: "/Users/postsha/private.mp4",
    tok: "POSTTOK",
    dec: "POSTDEC",
    workspace: join(repoRoot), // e.stack 中的动态工作区路径
    // 引号/JSON 密钥 + 含空格路径（D2 最终审查新增）：独立内容置于路径之前，值/路径后缀必须整体消失
    qTok: "TOK_R6",
    qDec: "DEC_R6",
    spPath: "/Users/private/My Secret/file.mp4",
    // D3：cookie 引号值（分号分隔）与 UNC 路径
    c1: "R6ONE",
    c2: "R6TWO",
    uncPath: "\\\\r6srv\\share\\sec", // 实际文本 \\r6srv\share\sec
    // D3：转义引号值 + quoted URL 含空格
    escL: "ESC6_L",
    escR: "ESC6_R",
    tokQ: "TOK6 Q",
    // D4：未加引号 cookie/authorization 值
    uSes: "SES6_A=ONE6_C;OTH6_B=TWO6_C",
    uAuth: "Bearer AUTH6_X,Y",
  };
  const LEAKS = [
    MARK.trig, MARK.path, MARK.tok, MARK.dec, "?token=", "decodeKey=", "SQLITE_1:/Users/postsha", MARK.workspace,
    // 引号/JSON 密钥值与含空格路径后缀
    MARK.qTok, MARK.qDec, "Secret/file.mp4", "My Secret", "/Users/private/My Secret",
    // D3：cookie 引号值与 UNC
    MARK.c1, MARK.c2, "r6srv\\share", "\\\\r6srv",
    // D3：转义引号值 + quoted URL 空格（含尾部 Q" 形态）
    MARK.escL, MARK.escR, MARK.tokQ, 'Q"',
    // D4：未加引号 cookie/authorization 值（= / ; / , / 空格 后仍整体消失）
    "SES6_A", "ONE6_C", "OTH6_B", "TWO6_C", "AUTH6_X", "SES6_A=ONE6_C",
  ];
  // 夹具：有效唯一 MP4 的 failed 项（worker 会成功 probe/进 OWNER_TX，随后 content_analysis 触发器中止）
  const batchId = "kb_d2b6";
  db.prepare("INSERT INTO import_batch (id, status, source_kind, created_at, total, succeeded, failed, skipped) VALUES (?, 'done', 'test', ?, 1, 0, 1, 0)").run(batchId, iso);
  const validFile = await makeDistinctMp4("d2b6-postsha.mp4", "D2B6_POSTSHA_MARKER");
  const { createHash } = await import("node:crypto");
  const sha = createHash("sha256").update(await readFile(validFile)).digest("hex");
  const itemId = db.prepare(
    "INSERT INTO import_item (batch_id, input, input_kind, display_input, delivery_id, status, error, retry_count, updated_at) VALUES (?,?,?,?,?, 'failed', 'initial_failure', 0, ?)",
  ).run(batchId, validFile, "kuaidian", "d2b6-postsha.mp4", "msg_d2b6", iso).lastInsertRowid;
  // 临时触发器：content_analysis INSERT 中止并注入引号/JSON 密钥（独立内容，置于路径之前）+ cookie 引号值 +
  // UNC 路径 + 含空格路径/token 消息（模拟 resolved-failed 深层路径；updateItem/receipt/observation sink
  // 若退回原始 e.stack/e.message 本测试必失败）
  db.exec(`CREATE TRIGGER trg_fail_c2b6 BEFORE INSERT ON content_analysis
    BEGIN SELECT RAISE(ABORT, 'token="${MARK.qTok}" {"decodeKey":"${MARK.qDec}"} cookie="A=${MARK.c1};B=${MARK.c2}" token="${MARK.escL}\\",${MARK.escR}" http://x/video?token="${MARK.tokQ}" cookie=${MARK.uSes} authorization=${MARK.uAuth} ERR:${MARK.uncPath} ${MARK.trig} ${MARK.spPath}'); END`);
  const recMaxBefore = db.prepare("SELECT COALESCE(MAX(id),0) m FROM download_receipt").get().m;
  const obsMaxBefore = db.prepare("SELECT COALESCE(MAX(id),0) m FROM ingest_observation").get().m;
  const dirsBefore = new Set(await listAllDirs(KB_ROOT));
  const retryReceiptsBefore = db.prepare("SELECT COUNT(*) c FROM download_receipt WHERE channel='retry'").get().c;
  db.close();
  // 1) 手动重试 → 202 → 原地解析 failed（ingestOne 内部 OWNER_TX catch，retry 路由 catch 不运行）
  const r = await request(`/api/v1/kb/imports/${itemId}/retry`, { method: "POST", body: {} });
  assert.equal(r.status, 202, "重试 202");
  const okBody = await r.json();
  assert.equal(okBody.itemId, itemId, "202 返回 itemId");
  assert.equal(okBody.batchId, batchId, "202 返回 batchId");
  await poll(async () => {
    const d = openKbDb(join(DATA_DIR, "kb.sqlite"));
    const row = d.prepare("SELECT status FROM import_item WHERE id=?").get(itemId);
    d.close();
    return row && ["success", "duplicate", "linked", "failed"].includes(row.status) ? true : null;
  }, { tries: 60, delay: 300, desc: "D2b-6 worker 终态" });
  // 2) 丢弃触发器（此后断言不再受触发器干扰）
  {
    const tdb = new DatabaseSync(join(DATA_DIR, "kb.sqlite"));
    tdb.exec("DROP TRIGGER IF EXISTS trg_fail_c2b6");
    tdb.close();
  }
  // 3) item.error / 仅新增 receipt/observation / 整份 /imports / KB_RETRY 事件 零泄漏
  const db2 = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const itemRow = db2.prepare("SELECT status, retry_count, error, asset_id FROM import_item WHERE id=?").get(itemId);
  const newRecTexts = db2.prepare("SELECT * FROM download_receipt WHERE id > ?").all(recMaxBefore).map((x) => JSON.stringify(x)).join("\n");
  const newObsTexts = db2.prepare("SELECT message FROM ingest_observation WHERE id > ?").all(obsMaxBefore).map((x) => String(x.message || "")).join("\n");
  const retryReceiptsAfter = db2.prepare("SELECT COUNT(*) c FROM download_receipt WHERE channel='retry'").get().c;
  const batchRow = db2.prepare("SELECT status, total, succeeded, failed, skipped FROM import_batch WHERE id=?").get(batchId);
  const assetCount = db2.prepare("SELECT COUNT(*) c FROM video_asset WHERE sha256=?").get(sha).c;
  db2.close();
  const dbTexts = `${JSON.stringify(itemRow)}\n${newRecTexts}\n${newObsTexts}`;
  for (const leak of LEAKS) {
    assert.ok(!dbTexts.includes(leak), `DB 持久化文本不得泄漏：${leak}`);
  }
  assert.equal(itemRow.status, "failed", "终态 failed（原地解析，非路由 catch）");
  assert.equal(itemRow.retry_count, 1, "retry_count=1");
  assert.equal(itemRow.asset_id, null, "失败无资产");
  assert.ok(String(itemRow.error || "").trim().length > 0, "error 非空");
  assert.ok(String(itemRow.error).includes("[redacted]") || !String(itemRow.error).includes("/"), "error 已脱敏（无绝对路径/栈路径）");
  // 整份 /imports 响应零泄漏
  const listBody = await (await request("/api/v1/kb/imports")).text();
  for (const leak of LEAKS) {
    assert.ok(!listBody.includes(leak), `/imports 不得泄漏：${leak}`);
  }
  // KB_RETRY 事件零泄漏（轮询本项事件）
  const myEvents = await poll(async () => {
    const er = await request("/api/v1/events?limit=200");
    if (er.status !== 200) return null;
    const { events } = await er.json();
    const mine = (events || []).filter((e) => e.type === "KB_RETRY" && String(e.message || "").includes(`重试 ${itemId}`));
    return mine.length ? mine : null;
  }, { tries: 40, delay: 300, desc: "D2b-6 本项 KB_RETRY 事件" });
  const eventText = myEvents.map((e) => String(e.message || "")).join("\n");
  for (const leak of LEAKS) {
    assert.ok(!eventText.includes(leak), `KB_RETRY 事件不得泄漏：${leak}`);
  }
  // 4) 1 worker/1 receipt、批次相干、无 searchable 资产/包/staging 残留
  assert.equal(retryReceiptsAfter, retryReceiptsBefore + 1, "恰 1 个 worker（1 条 retry receipt）");
  assert.equal(batchRow.total, 1, "批次 total 相干");
  assert.equal(batchRow.failed, 1, "批次 failed 相干");
  assert.equal(batchRow.status, "done", "批次终态 done");
  assert.equal(assetCount, 0, "无 searchable 资产（补偿已删除）");
  const dirsAfter = new Set(await listAllDirs(KB_ROOT));
  const newDirs = [...dirsAfter].filter((d) => !dirsBefore.has(d));
  // 包/暂存判定必须基于 basename（KB_ROOT 的祖先路径可能含 "kb_"（如 /tmp/kb_v2d_test_…），
  // 用全路径 includes('kb_') 会误判为残留）；包目录与暂存目录 basename 均以 kb_ 开头
  assert.equal(newDirs.filter((d) => basename(d).includes(".staging-")).length, 0, `无残留 staging：${newDirs.join(",")}`);
  assert.equal(newDirs.filter((d) => basename(d).startsWith("kb_")).length, 0, `无残留包/暂存目录：${newDirs.join(",")}`);
  // 5) recordReceipt 直接回归（D3/D4）：quoted URL 含空格 / 转义引号 KV / 未加引号 cookie/authorization /
  //    敏感键对象值（{authorization:'Bearer X'} 经 sanitizeReceiptValue 整键剔除）必须从
  //    title/outcome/evidence/observation 全部消失
  {
    const { openKbDb: openMemDb, recordReceipt } = await import("../local-agent/kb.mjs");
    const mdb = openMemDb(":memory:");
    const iso6 = new Date().toISOString();
    const sinkMarkers = [
      'http://x/video?token="TOK Q"', 'TOK Q', 'Q"',
      'token="ESC_L\\",ESC_R"', 'ESC_L', 'ESC_R',
      "cookie='A=ESC_A\\';B=ESC_B'", 'ESC_A', 'ESC_B',
      // D4：未加引号 cookie/authorization 值 + 敏感键对象值（evidence 经 sanitizeReceiptValue）
      'cookie=SES_SEC=ONE_SEC;OTH_SEC=TWO_SEC', 'SES_SEC', 'ONE_SEC', 'OTH_SEC', 'TWO_SEC',
      'authorization=Bearer AUTH_SEC', 'AUTH_SEC', 'Bearer AUTH_SEC',
      'AUTH_SEC2',
      // D5：URL 内未加引号值含空格 / 引号不平衡 / 引号值后整行残留
      'http://x/video?authorization=Bearer ABC_SECRET', 'ABC_SECRET', 'Bearer ABC_SECRET',
      'http://x/video?token="LEFT SECRET', 'LEFT SECRET', '"LEFT SECRET',
      'cookie="SESSION=ONE"; OTHER=COOKIE_SECRET', 'SESSION=ONE', 'COOKIE_SECRET', 'OTHER=COOKIE_SECRET',
    ];
    recordReceipt(mdb, {
      channel: "d2b6sink",
      sourceUrl: null,
      title: 'http://x/video?token="TOK Q" cookie=SES_SEC=ONE_SEC;OTH_SEC=TWO_SEC authorization=Bearer AUTH_SEC http://x/video?authorization=Bearer ABC_SECRET',
      error: 'token="ESC_L\\",ESC_R" cookie=\'A=ESC_A\\\';B=ESC_B\' http://x/video?token="TOK Q" cookie=SES_SEC=ONE_SEC;OTH_SEC=TWO_SEC authorization=Bearer AUTH_SEC http://x/video?token="LEFT SECRET cookie="SESSION=ONE"; OTHER=COOKIE_SECRET',
      contentId: null,
      mediaValidation: "ok",
      startedAt: iso6,
      completedAt: iso6,
      fallbackReason: 'token="ESC_L\\",ESC_R" authorization=Bearer AUTH_SEC http://x/video?authorization=Bearer ABC_SECRET',
      validationEvidence: {
        src: 'http://x/video?token="TOK Q"',
        note: "cookie='A=ESC_A\\';B=ESC_B' http://x/video?token=\"LEFT SECRET",
        // 敏感键对象值：authorization/cookie 整键剔除，AUTH_SEC2 绝不落 evidence
        auth: { authorization: "Bearer AUTH_SEC2", cookie: "SES_SEC=ONE_SEC;OTH_SEC=TWO_SEC" },
      },
      sizeBytes: null,
      sha256: null,
    }, { assetId: null, outcome: 'failed:http://x/video?token="TOK Q" token="ESC_L\\",ESC_R" cookie=SES_SEC=ONE_SEC;OTH_SEC=TWO_SEC cookie="SESSION=ONE"; OTHER=COOKIE_SECRET' });
    const rec = mdb.prepare("SELECT title, outcome, evidence FROM download_receipt ORDER BY id DESC LIMIT 1").get();
    const obs = mdb.prepare("SELECT message FROM ingest_observation ORDER BY id DESC LIMIT 1").get();
    mdb.close();
    const sinkTexts = `${JSON.stringify(rec)}\n${JSON.stringify(obs)}`;
    for (const marker of sinkMarkers) {
      assert.ok(!sinkTexts.includes(marker), `recordReceipt 落库文本不得泄漏：${marker}`);
    }
    assert.ok(String(rec.title).startsWith("[redacted"), `title 已脱敏，实际 ${rec.title}`);
    assert.ok(String(rec.outcome).includes("[redacted"), `outcome 已脱敏，实际 ${rec.outcome}`);
    assert.ok(String(rec.evidence || "").includes("AUTH_SEC2") === false, `evidence 不含敏感键值，实际 ${rec.evidence}`);
  }
});

/* D2b-7：纯函数表（D2 最终阻断 A/B）——直接逐例调用导出的 keyToEolRedactor / sanitizeFailureText /
   flattenToSingleLine / isSensitiveFieldName；每个 exact/alias/quoted/unclosed/URL/Windows/UNC/POSIX/跨行
   样本单独断言唯一标记消失；safe 多行变成空格连接且 monkey/oauth/ordinary_key 不被遮蔽；
   recordReceipt 用循环为每个样本分别插一行、分别查 title/outcome/evidence/observation（禁止多样本拼同字段）。
   变异防护：删除 endsWith token（custom_api_token 不遮蔽）或取消换行压平（token=\nCONT 泄漏）必红。 */
test("D2b-7：键 redactor / sanitizeFailureText / flatten / isSensitiveFieldName 纯函数表 + recordReceipt 逐样本循环", async () => {
  const { keyToEolRedactor, sanitizeFailureText, flattenToSingleLine } = await import("../local-agent/kb.mjs");
  const { isSensitiveFieldName } = await import("../local-agent/content-metadata.mjs");
  // A) isSensitiveFieldName 负例（分类器层面绝不遮蔽）
  assert.equal(isSensitiveFieldName("monkey"), false);
  assert.equal(isSensitiveFieldName("oauth"), false);
  assert.equal(isSensitiveFieldName("ordinary_key"), false);
  // B) 逐样本表：{样本, 唯一标记, 应用函数}；标记必须消失；负例样本标记必须保留
  const KEY_CASES = [
    // exact / 别名（含 endsWith token 变异防护：custom_api_token 只靠 endsWith 命中）
    ["token=TOK_1", "TOK_1"], ["access_token=TOK_2", "TOK_2"], ["decode_key=TOK_3", "TOK_3"],
    ["ws_secret=TOK_4", "TOK_4"], ["authkey=TOK_5", "TOK_5"], ["clientSecret=TOK_6", "TOK_6"],
    ["api_key=TOK_7", "TOK_7"], ["custom_api_token=TOK_M", "TOK_M"],
    // quoted / JSON / unclosed
    ['token="TOK_8"', "TOK_8"], ["'signature':'TOK_9'", "TOK_9"], ['token="TOK_10', "TOK_10"],
    // URL quoted / URL 裸值含空格 / 引号不平衡 / 引号值后整行残留
    ['http://x/video?token="TOK_11"', "TOK_11"],
    ["http://x/video?authorization=Bearer TOK_12", "TOK_12"],
    ['http://x/video?token="LEFT TOK_12b', "TOK_12b"],
    ['cookie="SESSION=ONE"; OTHER=TOK_13', "TOK_13"],
    // 跨行：换行压平变异防护
    ["token=\nCONT_TOKEN_SECRET", "CONT_TOKEN_SECRET"],
  ];
  const PATH_CASES = [
    ["failed:C:\\Users\\Private\\My Secret\\TOK_20.mp4", "TOK_20"],
    ["ERR:\\\\srv\\share\\TOK_21", "TOK_21"],
    ["failed:/Users/private/My Secret/TOK_22.mp4", "TOK_22"],
    ["/Users/a\nCONT_PATH_SECRET/file.mp4", "CONT_PATH_SECRET"],
  ];
  for (const [input, marker] of KEY_CASES) {
    const out = keyToEolRedactor(input);
    assert.ok(!out.includes(marker), `keyToEolRedactor 应遮蔽 ${marker}：${JSON.stringify(input)} => ${JSON.stringify(out)}`);
    assert.ok(!sanitizeFailureText(input).includes(marker), `sanitizeFailureText 应遮蔽 ${marker}：${JSON.stringify(input)}`);
  }
  for (const [input, marker] of PATH_CASES) {
    assert.ok(!sanitizeFailureText(input).includes(marker), `sanitizeFailureText 应遮蔽 ${marker}：${JSON.stringify(input)}`);
  }
  // C) 负例不遮蔽（monkey/oauth/ordinary_key 非敏感键 → 保持原样/不遮蔽标记值）
  for (const [input, marker] of [
    ["monkey=TOK_30", "TOK_30"],
    ["oauth=TOK_31", "TOK_31"],
    ["ordinary_key=TOK_32", "TOK_32"],
  ]) {
    assert.ok(keyToEolRedactor(input).includes(marker), `负例不得遮蔽 ${marker}：${JSON.stringify(input)}`);
  }
  // D) safe 多行 → 空格连接（压平；无敏感键/路径时保留文本）
  assert.equal(flattenToSingleLine("a\r\nb\rc\nd\u2028e\u2029f"), "a b c d e f");
  assert.equal(keyToEolRedactor("hello\nworld"), "hello world");
  assert.equal(sanitizeFailureText("failed_no_fallback_configured\nretry"), "failed_no_fallback_configured retry");
  // E) recordReceipt 循环：每个样本单独插一行、分别查 title/outcome/evidence/observation
  {
    const { openKbDb: openMemDb, recordReceipt } = await import("../local-agent/kb.mjs");
    const mdb = openMemDb(":memory:");
    const iso7 = new Date().toISOString();
    const ROW_CASES = [
      ['token="TOK_40"', "TOK_40"],
      ["access_token=TOK_41", "TOK_41"],
      ["http://x/video?authorization=Bearer TOK_42", "TOK_42"],
      ["token=\nCONT_TOKEN_SECRET_7", "CONT_TOKEN_SECRET_7"],
      ["failed:/Users/private/My Secret/TOK_43.mp4", "TOK_43"],
    ];
    try {
      for (let i = 0; i < ROW_CASES.length; i++) {
        const [text, marker] = ROW_CASES[i];
        recordReceipt(mdb, {
          channel: "d2b7sink", sourceUrl: null, title: text, error: text,
          contentId: null, mediaValidation: "ok", startedAt: iso7, completedAt: iso7,
          fallbackReason: text, validationEvidence: { note: text }, sizeBytes: null, sha256: null,
        }, { assetId: null, outcome: `failed:${text}` });
        // 每个样本单独一行、分别查 title/outcome/fallback_reason/evidence/observation（禁止多样本拼同字段）
        const row = mdb.prepare("SELECT title, outcome, fallback_reason, evidence FROM download_receipt ORDER BY id DESC LIMIT 1").get();
        const obsRow = mdb.prepare("SELECT message FROM ingest_observation ORDER BY id DESC LIMIT 1").get();
        assert.ok(row && obsRow, `recordReceipt 行 ${i}：新行与新 observation 均存在`);
        const rowTexts = `${JSON.stringify(row)}\n${JSON.stringify(obsRow)}`;
        assert.ok(!rowTexts.includes(marker), `recordReceipt 行 ${i} 不得泄漏 ${marker}：${rowTexts}`);
      }
    } finally {
      mdb.close();
    }
  }
});

/* D2b-8：D2 最终两个确定性问题 —— ① exotic 键样本（JSON 引号键/全角冒号/全角等号/方括号容器/点容器/
   数组键）逐个独立断言 marker 消失；② 标题专用净化：普通中文斜杠标题逐字保留、file_not_found: 路径遮蔽；
   evidence {note:'/Users/secret/private.mp4', ws_time:'WS_TIME_SECRET'} 解析后逐字段两标记均无。 */
test("D2b-8：exotic 键样本全遮蔽 + 标题专用净化（中文斜杠保留）+ evidence 逐字段零泄漏", async () => {
  const { keyToEolRedactor, sanitizeFailureText, sanitizeReceiptTitle, flattenToSingleLine } = await import("../local-agent/kb.mjs");
  // 1) exotic 键样本：每个单独断言唯一 marker 消失（keyToEolRedactor 与 sanitizeFailureText 都验）
  const EXOTIC = [
    ['{"token":"TOK_ESC_JSON"}', "TOK_ESC_JSON"],
    ['{"authorization":"Bearer AUTH_ESC"}', "AUTH_ESC"],
    ["token：TOK_FULL", "TOK_FULL"],                       // 全角冒号
    ["authorization＝AUTH_FULL", "AUTH_FULL"],             // 全角等号
    ["headers[authorization]=AUTH_BRACKET", "AUTH_BRACKET"], // 方括号容器
    ["headers.authorization=AUTH_DOT", "AUTH_DOT"],          // 点容器（扫到内部 authorization）
    ["token[]=TOK_ARRAY", "TOK_ARRAY"],                     // 数组键
  ];
  for (const [input, marker] of EXOTIC) {
    assert.ok(!keyToEolRedactor(input).includes(marker), `keyToEolRedactor 应遮蔽 ${marker}：${JSON.stringify(input)} => ${keyToEolRedactor(input)}`);
    assert.ok(!sanitizeFailureText(input).includes(marker), `sanitizeFailureText 应遮蔽 ${marker}：${JSON.stringify(input)}`);
  }
  // 2) 标题专用净化：普通中文斜杠标题逐字保留；带前缀路径遮蔽并吞 marker（原始样本原样输入）
  assert.equal(sanitizeReceiptTitle("厨房/卫生间改造"), "厨房/卫生间改造");
  assert.equal(sanitizeReceiptTitle("厨房 / 卫生间"), "厨房 / 卫生间");
  assert.equal(sanitizeReceiptTitle("厨房/home/卫生间改造"), "厨房/home/卫生间改造");
  for (const [input, marker] of [
    ["视频 /用户/秘密_CHINESE_PATH.mp4", "CHINESE_PATH"],
    ["错误 file:///Users/secret/FILE_URL_SECRET.mp4", "FILE_URL_SECRET"],
    ["错误 C:\\Users\\secret\\WIN_SECRET.mp4", "WIN_SECRET"],
    ["下载失败 \\\\srv\\share\\TITLE_UNC.mp4", "TITLE_UNC"],
    ["视频 /srv/acme/TITLE_POSIX.mp4", "TITLE_POSIX"],
    ["视频 ~/acme/TITLE_HOME.mp4", "TITLE_HOME"],
    ["file_not_found: /Users/private/TITLE_SPACE.mp4", "TITLE_SPACE"],
    ["path = /srv/acme/TITLE_EQ_SPACE.mp4", "TITLE_EQ_SPACE"],
    ["file_not_found:\\/Users\\/private\\/TITLE_ESC.mp4", "TITLE_ESC"],
  ]) {
    const out = sanitizeReceiptTitle(input);
    assert.ok(!out.includes(marker), `标题应遮蔽 ${marker}：${JSON.stringify(input)} => ${out}`);
  }
  // 3) recordReceipt：title 中文斜杠逐字保留 + evidence {note:'/Users/secret/private.mp4', ws_time:'WS_TIME_SECRET'}
  {
    const { openKbDb: openMemDb, recordReceipt } = await import("../local-agent/kb.mjs");
    const mdb = openMemDb(":memory:");
    const iso8 = new Date().toISOString();
    recordReceipt(mdb, {
      channel: "d2b8sink", sourceUrl: null, title: "厨房/卫生间改造", error: null,
      contentId: null, mediaValidation: "ok", startedAt: iso8, completedAt: iso8,
      fallbackReason: null, validationEvidence: { note: "/Users/secret/private.mp4", ws_time: "WS_TIME_SECRET" },
      sizeBytes: null, sha256: null,
    }, { assetId: null, outcome: "ok" });
    const row = mdb.prepare("SELECT title, outcome, evidence FROM download_receipt ORDER BY id DESC LIMIT 1").get();
    const obsRow = mdb.prepare("SELECT message FROM ingest_observation ORDER BY id DESC LIMIT 1").get();
    mdb.close();
    assert.equal(row.title, "厨房/卫生间改造", "标题逐字保留");
    // evidence 解析为对象逐字段断言（不先 JSON.stringify 后用带引号 marker）
    const evidence = JSON.parse(row.evidence);
    assert.ok(!String(evidence.note || "").includes("/Users/secret"), `note 路径遮蔽：${evidence.note}`);
    assert.ok(!String(evidence.note || "").includes("private.mp4"), `note 路径遮蔽：${evidence.note}`);
    assert.equal(evidence.ws_time, undefined, "ws_time 敏感键整键剔除");
    const all = `${JSON.stringify(row)}\n${JSON.stringify(obsRow)}`;
    assert.ok(!all.includes("WS_TIME_SECRET"), "WS_TIME_SECRET 不落库");
    assert.ok(!all.includes("private.mp4"), "private.mp4 不落库");
  }
  // 4) 压平回归（供变异防护：取消换行压平 → token=\nCONT 泄漏 → 本测试红）
  assert.equal(flattenToSingleLine("token=\nCONT_TOKEN_SECRET"), "token= CONT_TOKEN_SECRET");
  assert.ok(!keyToEolRedactor("token=\nCONT_TOKEN_SECRET").includes("CONT_TOKEN_SECRET"));
});
