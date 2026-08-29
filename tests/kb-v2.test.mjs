/**
 * kb-v2.test.mjs — 织台知识库 v3 集成测试（全部隔离 temp config/dataDir/kbRoot）
 * 契约 E：启动真实 server、请求真实路由；断言真实模块/路由，不复制实现、不手工 SQL 假装管线工作。
 * 元宝补元数据通过 ZHITAI_ENRICH_SCRIPT 注入 mock（生产不启用）。
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile, copyFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { writeSyntheticMp4 } from "./fixtures/synthetic-mp4.mjs";

const testsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(testsDir);
const AGENT_ENTRY = join(repoRoot, "local-agent", "server.mjs");
const BASE_MOCK_ENRICH = join(testsDir, "fixtures", "mock-enrich.mjs");

const ROOT = await mkdtemp(join(tmpdir(), "kb_v3_test_"));
const MOCK_ENRICH = join(ROOT, "mock-enrich-pathname.mjs");
const DATA_DIR = join(ROOT, "data");
const KB_ROOT = join(ROOT, "kbroot");
const SANDBOX_MP4 = join(ROOT, "real.mp4");
const TEMP_HOME = join(ROOT, "home");
const TEMP_APPDATA = join(TEMP_HOME, "AppData", "Roaming");
const TEMP_LOCALAPPDATA = join(TEMP_HOME, "AppData", "Local");
const WATCH_DIR = join(ROOT, "watch");

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

async function waitHealthy(url, tries = 40) {
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

before(async () => {
  await mkdir(KB_ROOT, { recursive: true });
  await mkdir(DATA_DIR, { recursive: true });
  await Promise.all([
    mkdir(TEMP_APPDATA, { recursive: true }),
    mkdir(TEMP_LOCALAPPDATA, { recursive: true }),
    mkdir(WATCH_DIR, { recursive: true }),
  ]);
  await writeSyntheticMp4(SANDBOX_MP4, { marker: "kb-v2-base" });
  // 分享链接的查询参数会在隐私边界被全部移除；测试桩改从稳定 pathname 读取帖子标记。
  await writeFile(MOCK_ENRICH, [
    `import baseEnrich from ${JSON.stringify(pathToFileURL(BASE_MOCK_ENRICH).href)};`,
    "export default function pathnameEnrich(sourceUrl) {",
    "  const url = new URL(String(sourceUrl || 'https://invalid.local/'));",
    "  const marker = url.pathname.match(/\\/mock-([A-Za-z0-9_]+)\\/?$/)?.[1];",
    "  return baseEnrich(marker ? `${url.origin}${url.pathname}?post=${encodeURIComponent(marker)}` : sourceUrl);",
    "}",
  ].join("\n"));
  port = await reservePort();
  const config = {
    host: "127.0.0.1",
    port,
    knowledgeBase: KB_ROOT,
    allowedOrigins: ["http://localhost:3000"],
    polling: { intervalMs: 250, timeoutMs: 5000 },
    watcher: { intervalMs: 5000, maxRetries: 3, roots: [{ dir: WATCH_DIR, channel: "kuaidian", recursive: true }] },
    services: {},
    adapters: {},
  };
  const configPath = join(ROOT, "config.json");
  await writeFile(configPath, JSON.stringify(config));
  server = spawn(process.execPath, [AGENT_ENTRY], {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: TEMP_HOME,
      USERPROFILE: TEMP_HOME,
      APPDATA: TEMP_APPDATA,
      LOCALAPPDATA: TEMP_LOCALAPPDATA,
      ZHITAI_CONFIG_PATH: configPath,
      ZHITAI_DATA_DIR: DATA_DIR,
      ZHITAI_ENRICH_SCRIPT: MOCK_ENRICH,
      ZHITAI_DISABLE_PUBLISHER_LOGIN_RECOVERY: "1",
      ZHITAI_MATRIX_PARTITIONS_DIR: join(DATA_DIR, "matrix-partitions"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", () => {});
  server.stderr.on("data", (c) => { serverErr += c.toString(); });
  baseUrl = `http://127.0.0.1:${port}`;
  assert.equal(await waitHealthy(baseUrl), true, "server 应就绪");
});

after(async () => {
  if (serverErr.trim()) console.log("SERVER_STDERR:", serverErr.slice(-800));
  try { server.kill(); } catch { /* ignore */ }
  await rm(ROOT, { recursive: true, force: true });
});

/* ─────────── 用例 1：nested enrich 映射 + 6 文件 + 无敏感键 ─────────── */
test("enrich 映射：作者=作者、likes=12000、contentId=media.postId；6 文件齐全且无敏感键", async () => {
  const r = await request("/api/v1/kuaidian", {
    method: "POST",
    body: { localPath: SANDBOX_MP4, sourceUrl: "https://weixin.qq.com/sph/mock", title: "enrich映射测试" },
  });
  assert.equal(r.status, 202);

  // 等资产出现
  let items = [];
  for (let i = 0; i < 20; i++) {
    const j = await (await request("/api/v1/kb/videos")).json();
    items = j.items;
    if (items.some((it) => it.title.includes("enrich映射测试") || it.channel === "kuaidian")) break;
    await new Promise((r) => setTimeout(r, 300));
  }
  const asset = items.find((it) => it.channel === "kuaidian");
  assert.ok(asset, "应有 kuaidian 资产");

  const detail = await (await request(`/api/v1/kb/videos/${asset.id}`)).json();
  assert.equal(detail.platform_posts.length, 1);
  const post = detail.platform_posts[0];
  assert.equal(post.author, "作者");
  assert.equal(post.likes, 12000);           // 1.2万 → 12000
  assert.equal(post.likes_raw, "1.2万");
  assert.equal(post.content_id, "mock_export_1"); // contentId = media.postId
  assert.equal(post.platform, "wechat_channels");
  assert.ok(post.cover_url);

  // 6 个标准文件齐全（API 不暴露 package_path → 扫描 KB_ROOT 定位包）
  const { findPackageDir } = await import("./helpers.mjs");
  const pkgDir = await findPackageDir(KB_ROOT, asset.id);
  assert.ok(pkgDir, "应在 KB_ROOT 找到资产包");
  for (const f of ["metadata.json", "analysis.md", "transcript.json", "ocr.json", "shots.json", "source.url"]) {
    await stat(join(pkgDir, f));
  }
  // 无敏感键
  const metaText = await readFile(join(pkgDir, "metadata.json"), "utf8");
  assert.ok(!/videoUrl|decodeKey|encfilekey|token|cookie/i.test(metaText));
  const sanitizedRaw = await readFile(join(pkgDir, "raw-yuanbao.sanitized.json"), "utf8");
  assert.ok(!/videoUrl|decodeKey|encfilekey|token|cookie/i.test(sanitizedRaw), "脱敏文件不得含敏感键");
  // metadata.json schema v2
  const meta = JSON.parse(metaText);
  assert.equal(meta.schemaVersion, 2);
  // transcript.json 等 status=unavailable
  const tr = JSON.parse(await readFile(join(pkgDir, "transcript.json"), "utf8"));
  assert.equal(tr.status, "unavailable");
});

/* ─────────── 用例 2：一资产两帖子 ─────────── */
test("一资产两帖子：list 1 条；platform 筛选 200；detail 两帖子", async () => {
  // 同 localPath（同 sha），第二个 sourceUrl 用稳定 pathname 标记不同帖子。
  const r2 = await request("/api/v1/kuaidian", {
    method: "POST",
    body: { localPath: SANDBOX_MP4, sourceUrl: "https://weixin.qq.com/sph/mock-2", title: "第二帖子" },
  });
  assert.equal(r2.status, 202);
  await new Promise((r) => setTimeout(r, 1200));

  const list = await (await request("/api/v1/kb/videos")).json();
  const kuaidianItems = list.items.filter((it) => it.channel === "kuaidian");
  assert.equal(kuaidianItems.length, 1, "一资产应只出一行");

  const plat = await (await request("/api/v1/kb/videos?platform=wechat_channels")).json();
  assert.equal(plat.response ?? 200, 200, "platform 筛选应 200");
  assert.ok(plat.items.some((it) => it.channel === "kuaidian"));

  const detail = await (await request(`/api/v1/kb/videos/${kuaidianItems[0].id}`)).json();
  assert.ok(detail.platform_posts.length >= 2, `detail 应有两帖子，实际 ${detail.platform_posts.length}`);
  const ids = detail.platform_posts.map((p) => p.content_id);
  assert.ok(ids.includes("mock_export_1") && ids.includes("mock_export_2"));
  assert.ok(detail.latest_post);
});

/* ─────────── 用例 3：analyze 幂等 + PATCH author/category ─────────── */
test("analyze 两次均 200；PATCH author/category 后详情与筛选都改变", async () => {
  const list = await (await request("/api/v1/kb/videos")).json();
  const asset = list.items.find((it) => it.channel === "kuaidian");
  assert.ok(asset);

  const a1 = await request(`/api/v1/kb/analyze/${asset.id}`, { method: "POST", body: {} });
  const a2 = await request(`/api/v1/kb/analyze/${asset.id}`, { method: "POST", body: {} });
  assert.equal(a1.status, 200, "第一次 analyze 应 200");
  assert.equal(a2.status, 200, "第二次 analyze 应 200（幂等 upsert）");

  // PATCH author → 改 platform_post
  const patchAuthor = await request(`/api/v1/kb/videos/${asset.id}`, { method: "PATCH", body: { field: "author", value: "修正作者" } });
  assert.equal(patchAuthor.status, 200);
  let detail = await (await request(`/api/v1/kb/videos/${asset.id}`)).json();
  assert.equal(detail.latest_post.author, "修正作者");

  // PATCH category → video_asset.category 真实更新 + 可筛选
  const patchCat = await request(`/api/v1/kb/videos/${asset.id}`, { method: "PATCH", body: { field: "category", value: "技能" } });
  assert.equal(patchCat.status, 200);
  detail = await (await request(`/api/v1/kb/videos/${asset.id}`)).json();
  assert.equal(detail.asset.category, "技能");
  const filtered = await (await request("/api/v1/kb/videos?category=技能")).json();
  assert.ok(filtered.items.some((it) => it.id === asset.id), "按新分类应能筛选到");
  // 修正历史
  assert.ok(detail.corrections.length >= 2);
});

/* ─────────── 用例 4：真实 Range 206/416 + 真实 export ─────────── */
test("真实 media 路由 Range 206/416；真实 export CSV/JSON", async () => {
  const list = await (await request("/api/v1/kb/videos")).json();
  const asset = list.items.find((it) => it.channel === "kuaidian");
  assert.ok(asset);

  const rangeOk = await request(`/api/v1/kb/videos/${asset.id}/media`, { headers: { Range: "bytes=0-99" } });
  assert.equal(rangeOk.status, 206);
  assert.equal(rangeOk.headers.get("content-range"), `bytes 0-99/${asset.size_bytes}`);
  const rangeBad = await request(`/api/v1/kb/videos/${asset.id}/media`, { headers: { Range: "bytes=99999999-" } });
  assert.equal(rangeBad.status, 416);

  const csv = await request("/api/v1/kb/export?format=csv");
  assert.equal(csv.status, 200);
  assert.ok(csv.headers.get("content-type").includes("text/csv"));
  const json = await request("/api/v1/kb/export?format=json");
  assert.equal(json.status, 200);
  const exported = await json.json();
  assert.ok(Array.isArray(exported) && exported.some((it) => it.channel === "kuaidian"));
});

/* ─────────── 用例 5：evil Origin 不回 ACAO；evil text/plain 被拒 ─────────── */
test("evil Origin export/media 不回 ACAO；evil text/plain POST/PATCH 403/415", async () => {
  const evil = "https://evil.example";
  const list = await (await request("/api/v1/kb/videos")).json();
  const asset = list.items[0];

  const exp = await request("/api/v1/kb/export?format=json", { headers: { Origin: evil } });
  assert.equal(exp.headers.get("access-control-allow-origin"), null, "evil Origin 不得回 ACAO");
  const med = await request(`/api/v1/kb/videos/${asset.id}/media`, { headers: { Origin: evil } });
  assert.equal(med.headers.get("access-control-allow-origin"), null);

  const badImport = await fetch(`${baseUrl}/api/v1/kb/import`, { method: "POST", headers: { "Content-Type": "text/plain", Origin: "http://localhost:3000" }, body: "links=...", signal: AbortSignal.timeout(5000) });
  assert.equal(badImport.status, 415, "text/plain 应 415");
  const evilPatch = await fetch(`${baseUrl}/api/v1/kb/videos/${asset.id}`, { method: "PATCH", headers: { "Content-Type": "application/json", Origin: evil }, body: "{}", signal: AbortSignal.timeout(5000) });
  assert.equal(evilPatch.status, 403, "evil Origin PATCH 应 403");
});

/* ─────────── 用例 6：假 ftyp 垃圾不能 ok；encrypted/invalid 不进可搜索资产 ─────────── */
test("假 ftyp 垃圾 → 不进可搜索资产（partial + receipt）", async () => {
  const fake = join(ROOT, "fake.mp4");
  const buf = Buffer.alloc(20000);
  buf.write("ftyp", 4, "latin1"); // 只有 ftyp，无 moov/mdat
  await writeFile(fake, buf);
  const r = await request("/api/v1/kuaidian", { method: "POST", body: { localPath: fake, title: "伪造ftyp垃圾" } });
  assert.equal(r.status, 202);
  await new Promise((r) => setTimeout(r, 1200));

  const list = await (await request("/api/v1/kb/videos")).json();
  assert.ok(!list.items.some((it) => it.title.includes("伪造ftyp")), "伪造 ftyp 不得进入可搜索资产");

  const imports = await (await request("/api/v1/kb/imports?status=partial")).json();
  assert.ok(imports.items.some((it) => String(it.displayInput || it.input).includes("fake.mp4")), "应为 partial 记录");
});

/* ─────────── 用例 7：10 包/6 SHA 迁移夹具 ─────────── */
test("迁移夹具：6 assets / 10 legacy_package / 原 capturedAt 快照 / 两儿童房 contentId 保留 / 重跑计数不变", async () => {
  const { migrateLibraryToKb } = await import("../local-agent/kb-migrate.mjs");
  const MIGRATE_DATA = join(ROOT, "migrate-data");
  await mkdir(MIGRATE_DATA, { recursive: true });
  // 构造夹具：6 个唯一文件（复制真实 mp4 + 尾部标记 → sha 不同），10 个包
  const fixtureRoot = join(KB_ROOT, "fixture");
  await mkdir(fixtureRoot, { recursive: true });
  const files = [];
  for (let i = 0; i < 6; i++) {
    const f = join(fixtureRoot, `src_${i}.mp4`);
    await writeSyntheticMp4(f, { marker: `kb-v2-migration-${i}` });
    files.push(f);
  }
  const pkgs = [
    { dir: "pkg_001", file: 0, id: "ing_aaa", capturedAt: "2026-08-01T00:00:00.000Z", contentId: "child_room_a", stats: { counts: { like: { value: 100, raw: "100" }, favorite: { value: 200 } } } },
    { dir: "pkg_002", file: 1, id: "ing_bbb", capturedAt: "2026-08-02T00:00:00.000Z", contentId: "ai_skill_1", upstreamStats: "1.2万" },
    { dir: "pkg_003", file: 2, id: "ing_ccc", capturedAt: "2026-08-03T00:00:00.000Z", contentId: "other_1" },
    { dir: "pkg_004", file: 3, id: "ing_ddd", capturedAt: "2026-08-04T00:00:00.000Z", contentId: "other_2" },
    { dir: "pkg_005", file: 4, id: "ing_eee", capturedAt: "2026-08-05T00:00:00.000Z", contentId: "other_3" },
    { dir: "pkg_006", file: 5, id: "ing_fff", capturedAt: "2026-08-06T00:00:00.000Z", contentId: "other_4" },
    { dir: "pkg_007", file: 0, id: "ing_ggg", capturedAt: "2026-08-07T00:00:00.000Z", contentId: "child_room_a_v2", title: "儿童房改造A版", stats: { counts: { like: { value: 300 } } } },
    { dir: "pkg_008", file: 0, id: "ing_hhh", capturedAt: "2026-08-08T00:00:00.000Z", contentId: "child_room_b", title: "儿童房改造B版", stats: { counts: { like: { value: 500 } } } },
    { dir: "pkg_009", file: 1, id: "ing_iii", capturedAt: "2026-08-09T00:00:00.000Z", contentId: "ai_skill_2" },
    { dir: "pkg_010", file: 2, id: "ing_jjj", capturedAt: "2026-08-10T00:00:00.000Z", contentId: "other_5" },
  ];
  for (const p of pkgs) {
    const pkgDir = join(fixtureRoot, p.dir);
    await mkdir(join(pkgDir, "assets"), { recursive: true });
    await copyFile(files[p.file], join(pkgDir, "assets", "01-video.mp4"));
    const meta = {
      schemaVersion: 1, id: p.id, title: p.title || `旧包${p.dir}`,
      platform: "视频号", capturedAt: p.capturedAt, category: "其他",
      source: { url: p.contentId ? `https://weixin.qq.com/sph/${p.contentId}` : null },
      files: [{ path: "assets/01-video.mp4", role: "video" }],
      stats: p.stats || {},
      upstream: p.upstreamStats ? { stats: { like: p.upstreamStats } } : undefined,
    };
    await writeFile(join(pkgDir, "metadata.json"), JSON.stringify(meta, null, 2));
  }

  // 首次迁移（真实模块）
  const r1 = await migrateLibraryToKb({ kbRoot: fixtureRoot, dataDir: MIGRATE_DATA });
  // 用真实 db 检查（fixture 迁移资产为 kb_mig_ 前缀，与前面 kuaidian 资产区分）
  const { openKbDb } = await import("../local-agent/kb.mjs");
  const db = openKbDb(join(MIGRATE_DATA, "kb.sqlite"));
  const assets = db.prepare("SELECT COUNT(*) c FROM video_asset WHERE id LIKE 'kb_mig_%'").get().c;
  const legacy = db.prepare("SELECT COUNT(*) c FROM legacy_package").get().c;
  const postsBefore = db.prepare("SELECT COUNT(*) c FROM platform_post").get().c;
  const snapshotsBefore = db.prepare("SELECT COUNT(*) c FROM metric_snapshot").get().c;
  const childPosts = db.prepare("SELECT content_id FROM platform_post WHERE content_id LIKE '%child_room%'").all().map((r) => r.content_id);
  const like12000 = db.prepare("SELECT COUNT(*) c FROM metric_snapshot WHERE likes = 12000").get().c;
  // 全部原 capturedAt 快照
  const capturedAtSet = db.prepare("SELECT DISTINCT captured_at FROM metric_snapshot").all().map((r) => r.captured_at);
  db.close();
  assert.equal(assets, 6, "6 个唯一 SHA → 6 个迁移资产");
  assert.equal(legacy, 10, "10 个旧包 → 10 legacy_package");
  assert.ok(childPosts.some((v) => v.includes("child_room_a_v2")), "缺 child_room_a_v2, 实际=" + JSON.stringify(childPosts));
  assert.ok(childPosts.some((v) => v.includes("child_room_b")), "缺 child_room_b, 实际=" + JSON.stringify(childPosts));
  assert.equal(like12000, 1, "upstream.stats 纯字符串 1.2万 → 12000");
  assert.ok(capturedAtSet.includes("2026-08-07T00:00:00.000Z") && capturedAtSet.includes("2026-08-08T00:00:00.000Z"), "按原 capturedAt 写快照");

  // 重跑：计数不变（幂等 upsert）
  const r2 = await migrateLibraryToKb({ kbRoot: fixtureRoot, dataDir: MIGRATE_DATA });
  const db2 = openKbDb(join(MIGRATE_DATA, "kb.sqlite"));
  assert.equal(db2.prepare("SELECT COUNT(*) c FROM video_asset WHERE id LIKE 'kb_mig_%'").get().c, assets, "重跑 assets 不变");
  assert.equal(db2.prepare("SELECT COUNT(*) c FROM legacy_package").get().c, legacy, "重跑 legacy_package 不变");
  assert.equal(db2.prepare("SELECT COUNT(*) c FROM platform_post").get().c, postsBefore, "重跑 platform_post 不变");
  assert.equal(db2.prepare("SELECT COUNT(*) c FROM metric_snapshot").get().c, snapshotsBefore, "重跑 metric_snapshot 不变");
  db2.close();
  assert.ok(r1.indexed === 6 && r2.indexed === 0, "首次索引 6、重跑 0");
});

/* ─────────── 用例 8：同 SHA kuaidian 再导入 → receipt 新增 + 资产补 channel/validation ─────────── */
test("同 SHA 再经 kuaidian 导入：不复制文件，但 download_receipt 新增且资产显示快点验证", async () => {
  const { openKbDb } = await import("../local-agent/kb.mjs");
  const before = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const receiptsBefore = before.prepare("SELECT COUNT(*) c FROM download_receipt").get().c;
  const shaBefore = before.prepare("SELECT sha256 FROM video_asset WHERE channel='kuaidian' LIMIT 1").get()?.sha256;
  before.close();

  const r = await request("/api/v1/kuaidian", { method: "POST", body: { localPath: SANDBOX_MP4, sourceUrl: "https://weixin.qq.com/sph/mock-repeat", title: "重复导入" } });
  assert.equal(r.status, 202);
  await new Promise((r) => setTimeout(r, 1200));

  const db = openKbDb(join(DATA_DIR, "kb.sqlite"));
  const receiptsAfter = db.prepare("SELECT COUNT(*) c FROM download_receipt").get().c;
  assert.ok(receiptsAfter > receiptsBefore, "download_receipt 应新增");
  const asset = db.prepare("SELECT channel, media_validation FROM video_asset WHERE sha256 = ?").get(shaBefore);
  assert.ok(asset, "资产存在");
  assert.equal(asset.channel, "kuaidian", "资产 channel 应为 kuaidian");
  assert.equal(asset.media_validation, "ok", "验证应 ok");
  // 不复制文件：同一 file_path 仍指向原资产
  const fileCount = db.prepare("SELECT COUNT(*) c FROM video_asset WHERE sha256 = ?").get(shaBefore).c;
  assert.equal(fileCount, 1, "不重复存资产文件");
  db.close();
});
