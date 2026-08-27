/**
 * kb.mjs v4 — 织台知识库核心
 *
 * v4（阶段 A2 契约 B/D）：
 *   - import_item 增加 display_input；input 对临时直链存 fingerprint（downloadUrl 永不落库）
 *   - metric_snapshot 关联 platform_post/contentId + observation_id（同一次观测幂等；
 *     同 post 不同时间观测写新快照；不同 contentId 同 capturedAt 快照互不覆盖）
 *   - 临时文件统一 finally 清理（duplicate / partial / 异常全覆盖）
 *   - 新包 staging 目录原子写（视频+6 文件校验后 rename），任一步失败不留 searchable asset/半包
 *   - metadata.files 使用实际 videoName/ext（磁盘可重建）
 *   - metadata.json 含 platform_posts 摘要 + corrections（磁盘可重建）
 *   - duplicate 分支：sourceUrl 相同也补数（同 post 二次补数写新快照）
 *   - channel 非单一事实：download_receipt 记录全部尝试；列表/detail 显示 observed/latest 渠道
 *   - runContentAnalysis 不覆盖 available transcript/ocr；shot 幂等 upsert
 *   - editField 同步磁盘 metadata.json/analysis.md（correction log）
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { writeFile, mkdir, stat, copyFile, rm, rename, readFile, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, basename, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { probeLocalMedia, platformPostFrom, sanitizeRawForStorage, redactUrlForStorage, containsSensitiveUrlMaterial, canonicalizeSourceUrl, isStableShareUrl } from "./downloader-adapter.mjs";
import { deriveContentId, isSensitiveFieldName, parseFormattedCount } from "./content-metadata.mjs";
import { classifyCategory } from "./analyze.mjs";
import { validateAudioQualityReport } from "./audio-quality.mjs";

/* A4.3-C1：进程内 SHA-keyed 异步互斥。
 * 同 SHA 的 ingestOne 从「video_asset 查重」到「duplicate 处理 / staging → 包提交 → 资产插入 →
 * receipt → item 终态更新」全程串行，保证同一媒体字节并发导入只产生一个 video_asset；
 * 不同 SHA 互不阻塞；锁在 finally 释放（任何错误 / return 都释放）。
 * 仅进程内兜底；DB partial UNIQUE index 属 C1b，本阶段不建索引。 */
const shaIngestLocks = new Map();

async function withShaLock(sha, task) {
  const prev = (shaIngestLocks.get(sha) || Promise.resolve()).catch(() => {});
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const chain = prev.then(() => gate);
  shaIngestLocks.set(sha, chain);
  await prev;
  try {
    return await task();
  } finally {
    release();
    if (shaIngestLocks.get(sha) === chain) shaIngestLocks.delete(sha);
  }
}

function isSqliteBusy(error) {
  return error?.errcode === 5
    || error?.errcode === 517
    || /(?:database is locked|SQLITE_BUSY)/i.test(String(error?.message || error || ""));
}

/**
 * DatabaseSync 的 busy_timeout 会同步阻塞当前 Node 进程；同进程另一条异步任务持锁时，
 * 把 timeout 拉长反而会自锁。这里用短 busy_timeout + 异步退避，让持锁任务有机会继续，
 * 同时覆盖两个本地节点进程并发写同一 WAL 的情况。
 */
async function beginImmediateWithRetry(db, { timeoutMs = 6_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    try {
      db.exec("BEGIN IMMEDIATE");
      return;
    } catch (error) {
      if (!isSqliteBusy(error) || Date.now() >= deadline) throw error;
      attempt += 1;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(150, 20 + attempt * 10)));
    }
  }
}

async function withImmediateTransactionRetry(db, task, options) {
  await beginImmediateWithRetry(db, options);
  try {
    const result = await task();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    if (db.isTransaction) {
      try { db.exec("ROLLBACK"); } catch { /* 调用方会收到原始失败 */ }
    }
    throw error;
  }
}


const RUNTIME_ROOT = resolve(process.env.ZHITAI_RUNTIME_ROOT
  || join(homedir(), ".local", "share", "zhitai-runtime"));
let KB_ROOT = resolve(process.env.ZHITAI_KB_ROOT
  || join(homedir(), "KnowledgeHub", "内容库"));

export function setKbRoot(path) {
  if (path) KB_ROOT = path;
}

export function openKbDb(dbPath, { migrateSchema = true } = {}) {
  const db = new DatabaseSync(dbPath);
  try {
    // journal_mode 是写操作，若另一个同进程连接正处于异步入库事务，
    // 新的只读/工作连接在这里同步等待会阻塞整个 Node 事件循环，形成自锁。
    // 模式只由启动时的主迁移连接设置一次；后续连接直接复用现有 WAL。
    if (migrateSchema) db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    // DatabaseSync 的 busy wait 会阻塞 Node 唯一事件循环；若锁持有者正等待异步文件/网络
    // 回调，长达 15 秒的等待会自锁。短等待后交给现有任务重试/错误收敛逻辑处理。
    db.exec("PRAGMA busy_timeout = 250;");
    if (migrateSchema) migrate(db);
    return db;
  } catch (error) {
    // 迁移失败时必须释放 FD/锁；否则 3s 轮询会不断累积连接，
    // 最终让同一进程自己锁死 kb.sqlite。
    try { db.close(); } catch { /* best effort */ }
    throw error;
  }
}

function migrate(db) {
  db.exec(`
  CREATE TABLE IF NOT EXISTS video_asset (
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
  );
  CREATE TABLE IF NOT EXISTS platform_post (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id TEXT NOT NULL REFERENCES video_asset(id) ON DELETE CASCADE,
    content_id TEXT,
    post_id TEXT, url TEXT,
    author TEXT, author_avatar_url TEXT, author_cert_icon_url TEXT,
    publish_time TEXT, title TEXT, topics TEXT, music TEXT,
    cover_url TEXT, platform TEXT,
    plays INTEGER, plays_raw TEXT,
    likes INTEGER, likes_raw TEXT,
    comments INTEGER, comments_raw TEXT,
    favorites INTEGER, favorites_raw TEXT,
    shares INTEGER, shares_raw TEXT,
    scaling_info TEXT,
    raw_json_path TEXT, fetched_at TEXT,
    UNIQUE(asset_id, content_id)
  );
  CREATE TABLE IF NOT EXISTS legacy_package (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id TEXT NOT NULL REFERENCES video_asset(id) ON DELETE CASCADE,
    legacy_id TEXT NOT NULL,
    package_path TEXT,
    source_url TEXT,
    content_id TEXT,
    captured_at TEXT,
    metadata_fingerprint TEXT,
    UNIQUE(legacy_id, package_path)
  );
  CREATE TABLE IF NOT EXISTS download_receipt (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id TEXT,
    channel TEXT,
    source_url TEXT,
    content_id TEXT,
    sha256 TEXT,
    media_validation TEXT,
    fallback_reason TEXT,
    started_at TEXT,
    completed_at TEXT,
    title TEXT,
    size_bytes INTEGER,
    evidence TEXT,
    input_kind TEXT,
    outcome TEXT
  );
  CREATE TABLE IF NOT EXISTS ingest_observation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id TEXT,
    kind TEXT,
    message TEXT,
    observed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS metric_snapshot (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id TEXT NOT NULL REFERENCES video_asset(id) ON DELETE CASCADE,
    content_id TEXT,
    captured_at TEXT,
    plays INTEGER, plays_raw TEXT,
    likes INTEGER, likes_raw TEXT,
    comments INTEGER, comments_raw TEXT,
    favorites INTEGER, favorites_raw TEXT,
    shares INTEGER, shares_raw TEXT,
    avg_watch_seconds REAL,
    completion_rate REAL,
    retention_json TEXT,
    traffic_source TEXT,
    source TEXT,
    observation_id TEXT,
    UNIQUE(asset_id, content_id, source, observation_id)
  );
  CREATE TABLE IF NOT EXISTS comment_item (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id TEXT NOT NULL REFERENCES video_asset(id) ON DELETE CASCADE,
    source TEXT NOT NULL,
    external_id TEXT,
    author TEXT,
    content TEXT NOT NULL,
    likes INTEGER,
    published_at TEXT,
    captured_at TEXT,
    fingerprint TEXT NOT NULL,
    UNIQUE(asset_id, source, fingerprint)
  );
  CREATE TABLE IF NOT EXISTS transcript (
    asset_id TEXT PRIMARY KEY REFERENCES video_asset(id) ON DELETE CASCADE,
    status TEXT, language TEXT, text TEXT, segments TEXT, provider TEXT, note TEXT, captured_at TEXT
  );
  CREATE TABLE IF NOT EXISTS ocr (
    asset_id TEXT PRIMARY KEY REFERENCES video_asset(id) ON DELETE CASCADE,
    status TEXT, items TEXT, provider TEXT, note TEXT, captured_at TEXT
  );
  CREATE TABLE IF NOT EXISTS shot (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id TEXT NOT NULL REFERENCES video_asset(id) ON DELETE CASCADE,
    idx INTEGER, start_ms INTEGER, end_ms INTEGER,
    shot_size TEXT, camera_angle TEXT, camera_movement TEXT, scene TEXT, composition TEXT, notes TEXT, source TEXT,
    UNIQUE(asset_id, idx)
  );
  CREATE TABLE IF NOT EXISTS content_analysis (
    asset_id TEXT PRIMARY KEY REFERENCES video_asset(id) ON DELETE CASCADE,
    summary TEXT, key_points TEXT, hook_3s TEXT, structure TEXT, cta TEXT,
    audience TEXT, editing_rhythm TEXT, reusable_pattern TEXT,
    confidence TEXT, source TEXT, limitation TEXT, analyzed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS virality_analysis (
    asset_id TEXT PRIMARY KEY REFERENCES video_asset(id) ON DELETE CASCADE,
    verdict_label TEXT, hypotheses TEXT, is_causal INTEGER DEFAULT 0, note TEXT, analyzed_at TEXT
  );
  CREATE TABLE IF NOT EXISTS remake_plan (
    asset_id TEXT PRIMARY KEY REFERENCES video_asset(id) ON DELETE CASCADE,
    plan_json TEXT NOT NULL, provider TEXT, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS remake_generation (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL REFERENCES video_asset(id) ON DELETE CASCADE,
    engine TEXT NOT NULL,
    engine_task_id TEXT,
    status TEXT,
    file_name TEXT,
    size_bytes INTEGER,
    sha256 TEXT,
    subject TEXT,
    created_at TEXT,
    completed_at TEXT,
    UNIQUE(asset_id, engine, engine_task_id)
  );
  CREATE TABLE IF NOT EXISTS knowledge_chunk (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id TEXT NOT NULL REFERENCES video_asset(id) ON DELETE CASCADE,
    kind TEXT, start_ms INTEGER, end_ms INTEGER, content TEXT, tags TEXT, created_at TEXT
  );
  CREATE TABLE IF NOT EXISTS field_provenance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id TEXT NOT NULL REFERENCES video_asset(id) ON DELETE CASCADE,
    field TEXT, source TEXT, available INTEGER, confidence TEXT, limitation TEXT, captured_at TEXT,
    UNIQUE(asset_id, field)
  );
  CREATE TABLE IF NOT EXISTS import_batch (
    id TEXT PRIMARY KEY,
    status TEXT, source_kind TEXT, created_at TEXT,
    total INTEGER, succeeded INTEGER, failed INTEGER, skipped INTEGER
  );
  CREATE TABLE IF NOT EXISTS import_item (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL REFERENCES import_batch(id) ON DELETE CASCADE,
    input TEXT, input_kind TEXT, display_input TEXT,
    status TEXT, error TEXT, retry_count INTEGER DEFAULT 0, asset_id TEXT, updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS correction (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    asset_id TEXT NOT NULL REFERENCES video_asset(id) ON DELETE CASCADE,
    field TEXT, old_value TEXT, new_value TEXT, reason TEXT, corrected_at TEXT
  );
  `);

  // ── v3 幂等 ALTER：video_asset.category / platform_post 扩展列 ──
  const vaCols = db.prepare("PRAGMA table_info(video_asset)").all().map((c) => c.name);
  if (!vaCols.includes("category")) {
    db.exec("ALTER TABLE video_asset ADD COLUMN category TEXT");
  }
  const ppCols = db.prepare("PRAGMA table_info(platform_post)").all().map((c) => c.name);
  for (const [col, ddl] of [
    ["platform", "TEXT"],
    ["author_avatar_url", "TEXT"],
    ["author_cert_icon_url", "TEXT"],
    ["cover_url", "TEXT"],
    ["scaling_info", "TEXT"],
  ]) {
    if (!ppCols.includes(col)) {
      db.exec(`ALTER TABLE platform_post ADD COLUMN ${col} ${ddl}`);
    }
  }
  // v4：import_item.display_input
  const iiCols = db.prepare("PRAGMA table_info(import_item)").all().map((c) => c.name);
  if (!iiCols.includes("display_input")) {
    db.exec("ALTER TABLE import_item ADD COLUMN display_input TEXT");
  }
  // A4.3-B：import_item.delivery_id（幂等迁移）+ 非 NULL partial UNIQUE index。
  // delivery_id 只承载本机投递溯源（原版快点 okd[].m = 微信 MsgId），绝不进入
  // video_asset.content_id / platform_post.content_id / download_receipt.content_id / metadata contentId。
  // partial unique index 是并发/多标签页重复上报的兜底：同 deliveryId 全库至多 1 行。
  if (!iiCols.includes("delivery_id")) {
    db.exec("ALTER TABLE import_item ADD COLUMN delivery_id TEXT");
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_import_item_delivery_id ON import_item(delivery_id) WHERE delivery_id IS NOT NULL");
  // A4.3-C1b：video_asset.sha256 非空 partial UNIQUE index（幂等）。
  // 仅当「非空 SHA 无历史重复组」时创建；若已存在重复组 → 跳过创建（索引保持缺席），
  // 绝不更新/删除/合并任何行、不触碰任何包/文件、开库迁移绝不因重复组抛错
  // （历史重复组归 A5 合并，本任务不处理）。
  const dupShaGroup = db.prepare(
    "SELECT sha256, COUNT(*) c FROM video_asset WHERE sha256 IS NOT NULL AND sha256 <> '' GROUP BY sha256 HAVING c > 1 LIMIT 1",
  ).get();
  if (!dupShaGroup) {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS ux_video_asset_sha256 ON video_asset(sha256) WHERE sha256 IS NOT NULL AND sha256 <> ''");
  }

  // ── v4 schema 升级（事务化，任何失败 ROLLBACK+抛错，绝不吞；备份表暂留供核验）──
  db.exec("BEGIN");
  try {
    // metric_snapshot：重建为 content_id + observation_id + UNIQUE(asset_id,content_id,source,observation_id)
    const msSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='metric_snapshot'").get()?.sql || "";
    const msHasNew = msSql.includes("UNIQUE(asset_id, content_id, source, observation_id)");
    if (!msHasNew) {
      db.exec("ALTER TABLE metric_snapshot RENAME TO metric_snapshot_v3_backup");
      db.exec(`CREATE TABLE metric_snapshot (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id TEXT NOT NULL REFERENCES video_asset(id) ON DELETE CASCADE,
        content_id TEXT,
        captured_at TEXT,
        plays INTEGER, plays_raw TEXT,
        likes INTEGER, likes_raw TEXT,
        comments INTEGER, comments_raw TEXT,
        favorites INTEGER, favorites_raw TEXT,
        shares INTEGER, shares_raw TEXT,
        source TEXT,
        observation_id TEXT,
        UNIQUE(asset_id, content_id, source, observation_id)
      );`);
    } else {
      // 已有新结构：补列（若缺）
      const msCols = db.prepare("PRAGMA table_info(metric_snapshot)").all().map((c) => c.name);
      if (!msCols.includes("content_id")) db.exec("ALTER TABLE metric_snapshot ADD COLUMN content_id TEXT");
      if (!msCols.includes("observation_id")) db.exec("ALTER TABLE metric_snapshot ADD COLUMN observation_id TEXT");
    }
    // 半迁移/历史 backup 残留：按旧表实际列动态兼容合并（缺失列用 NULL），observation_id 稳定 = 'v3:'||旧 id
    const backupExists = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='metric_snapshot_v3_backup'").get();
    if (backupExists) {
      const bCols = db.prepare("PRAGMA table_info(metric_snapshot_v3_backup)").all().map((c) => c.name);
      const pick = (col, dflt) => (bCols.includes(col) ? `b.${col}` : dflt);
      // content_id：优先旧行自有列 → 其次该资产 video_asset.content_id → 稳定 legacy 兜底
      const contentIdExpr = bCols.includes("content_id")
        ? `COALESCE(b.content_id, (SELECT v.content_id FROM video_asset v WHERE v.id = b.asset_id), 'legacy')`
        : `COALESCE((SELECT v.content_id FROM video_asset v WHERE v.id = b.asset_id), 'legacy')`;
      const obsExpr = bCols.includes("observation_id")
        ? `COALESCE(b.observation_id, 'v3:' || b.id)`
        : `'v3:' || b.id`;
      // A：NULL/空 source 规范成稳定非空 'legacy'（SQLite UNIQUE 遇 NULL 不去重，会导致重开增长）
      const sourceExpr = bCols.includes("source") ? `COALESCE(NULLIF(b.source, ''), 'legacy')` : `'legacy'`;
      db.exec(`INSERT OR IGNORE INTO metric_snapshot (asset_id, content_id, captured_at, plays, plays_raw, likes, likes_raw, comments, comments_raw, favorites, favorites_raw, shares, shares_raw, source, observation_id)
        SELECT b.asset_id, ${contentIdExpr}, b.captured_at,
          b.plays, ${pick("plays_raw", "NULL")}, b.likes, ${pick("likes_raw", "NULL")},
          b.comments, ${pick("comments_raw", "NULL")}, b.favorites, ${pick("favorites_raw", "NULL")},
          b.shares, ${pick("shares_raw", "NULL")}, ${sourceExpr}, ${obsExpr}
        FROM metric_snapshot_v3_backup b`);
    }

    // shot：唯一键（幂等 upsert）；重建不吞异常
    const shotHasUnique = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='shot'").get()?.sql?.includes("UNIQUE(asset_id, idx)");
    if (!shotHasUnique) {
      db.exec("ALTER TABLE shot RENAME TO shot_v3_backup");
      db.exec(`CREATE TABLE shot (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id TEXT NOT NULL REFERENCES video_asset(id) ON DELETE CASCADE,
        idx INTEGER, start_ms INTEGER, end_ms INTEGER,
        shot_size TEXT, camera_angle TEXT, camera_movement TEXT, scene TEXT, composition TEXT, notes TEXT, source TEXT,
        UNIQUE(asset_id, idx)
      );`);
    }
    // H：半迁移时 shot backup 残留也幂等合并（主表已是新结构也执行）
    const shotBackupExists = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='shot_v3_backup'").get();
    if (shotBackupExists) {
      db.exec("INSERT OR IGNORE INTO shot (asset_id, idx, start_ms, end_ms, shot_size, camera_angle, camera_movement, scene, composition, notes, source) SELECT asset_id, idx, start_ms, end_ms, shot_size, camera_angle, camera_movement, scene, composition, notes, source FROM shot_v3_backup;");
    }

    // field_provenance：唯一键（可重复 upsert）；重建不吞异常
    const fpHasUnique = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='field_provenance'").get()?.sql?.includes("UNIQUE(asset_id, field)");
    if (!fpHasUnique) {
      db.exec("ALTER TABLE field_provenance RENAME TO field_provenance_v2_backup");
      db.exec(`CREATE TABLE field_provenance (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id TEXT NOT NULL REFERENCES video_asset(id) ON DELETE CASCADE,
        field TEXT, source TEXT, available INTEGER, confidence TEXT, limitation TEXT, captured_at TEXT,
        UNIQUE(asset_id, field)
      );`);
    }
    // H：半迁移时 field_provenance backup 残留也幂等合并
    const fpBackupExists = !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='field_provenance_v2_backup'").get();
    if (fpBackupExists) {
      db.exec(`INSERT OR IGNORE INTO field_provenance (asset_id, field, source, available, confidence, limitation, captured_at)
        SELECT asset_id, field, source, available, confidence, limitation, captured_at FROM field_provenance_v2_backup;`);
    }

    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw new Error(`schema_upgrade_failed:${String((e && e.message) || e).slice(0, 300)}`);
  }

  // v5：创作者后台数据导入。旧库只补列；不重建既有快照。
  const metricCols = db.prepare("PRAGMA table_info(metric_snapshot)").all().map((c) => c.name);
  for (const [col, ddl] of [
    ["avg_watch_seconds", "REAL"],
    ["completion_rate", "REAL"],
    ["retention_json", "TEXT"],
    ["traffic_source", "TEXT"],
  ]) {
    if (!metricCols.includes(col)) db.exec(`ALTER TABLE metric_snapshot ADD COLUMN ${col} ${ddl}`);
  }
  db.exec("CREATE INDEX IF NOT EXISTS ix_comment_item_asset ON comment_item(asset_id, captured_at)");
  repairDanglingImportItems(db);
}

/**
 * 历史版本曾允许 import_item 先写“成功”再落资产，异常中断后会留下
 * “看似完成、实际无媒体”的孤儿记录。开库时幂等修复为 orphaned，并同步重算批次。
 * 这里只修索引状态，不删文件、不伪造资产。
 */
export function repairDanglingImportItems(db) {
  const rows = db.prepare(`SELECT i.id, i.batch_id
    FROM import_item i
    LEFT JOIN video_asset v ON v.id = i.asset_id
    WHERE i.status IN ('success','linked','duplicate')
      AND (i.asset_id IS NULL OR v.id IS NULL)`).all();
  if (!rows.length) return { repaired: 0, batches: 0 };

  const now = new Date().toISOString();
  const batchIds = [...new Set(rows.map((row) => String(row.batch_id || "")).filter(Boolean))];
  db.exec("BEGIN IMMEDIATE");
  try {
    const updateItem = db.prepare(`UPDATE import_item
      SET status='orphaned', asset_id=NULL, error='orphaned: 关联资产不存在', updated_at=?
      WHERE id=? AND status IN ('success','linked','duplicate')`);
    for (const row of rows) updateItem.run(now, row.id);

    const counts = db.prepare(`SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status IN ('success','linked') THEN 1 ELSE 0 END) AS succeeded,
      SUM(CASE WHEN status IN ('failed','partial','orphaned') THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status='duplicate' THEN 1 ELSE 0 END) AS skipped
      FROM import_item WHERE batch_id=?`);
    const updateBatch = db.prepare("UPDATE import_batch SET status=?, total=?, succeeded=?, failed=?, skipped=? WHERE id=?");
    for (const batchId of batchIds) {
      const row = counts.get(batchId);
      const total = Number(row?.total || 0);
      const succeeded = Number(row?.succeeded || 0);
      const failed = Number(row?.failed || 0);
      const skipped = Number(row?.skipped || 0);
      const pending = Math.max(0, total - succeeded - failed - skipped);
      updateBatch.run(pending > 0 ? "awaiting_primary_download" : "done", total, succeeded, failed, skipped, batchId);
    }
    db.exec("COMMIT");
    return { repaired: rows.length, batches: batchIds.length };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* best effort */ }
    throw error;
  }
}

/**
 * 只评估源文件的技术质量；不重新编码、不修改比特率、不拒绝可播放的低清源。
 */
export function assessMediaQuality(asset = {}) {
  const validation = String(asset?.media_validation || "").trim().toLowerCase();
  if (validation && validation !== "ok") {
    return { state: "blocked", label: "媒体异常", reason: `媒体校验未通过：${validation}`, sourcePreserved: true };
  }
  const width = Number(asset?.width);
  const height = Number(asset?.height);
  const bitrate = Number(asset?.bitrate_kbps);
  const sizeBytes = Number(asset?.size_bytes);
  const durationMs = Number(asset?.duration_ms);
  const maxDimension = Math.max(Number.isFinite(width) ? width : 0, Number.isFinite(height) ? height : 0);
  // ffprobe 不在时，可从文件大小/时长得到可复核的平均码率（bytes*8/ms = kbps）。
  const derivedBitrate = Number.isFinite(sizeBytes) && sizeBytes > 0 && Number.isFinite(durationMs) && durationMs > 0
    ? (sizeBytes * 8) / durationMs
    : null;
  const usableBitrate = Number.isFinite(bitrate) && bitrate > 0 ? bitrate : derivedBitrate;
  if (!validation || (!maxDimension && usableBitrate === null)) {
    return { state: "unknown", label: "待检测", reason: "技术元数据不足，暂不判定清晰度", sourcePreserved: true };
  }
  const reasons = [];
  if (usableBitrate !== null && usableBitrate < 500) reasons.push(`码率约 ${Math.round(usableBitrate)} kbps`);
  if (maxDimension && maxDimension < 720) reasons.push(`最长边 ${Math.round(maxDimension)} px`);
  if (reasons.length) {
    return { state: "review", label: "画质需复核", reason: `${reasons.join("，")}；保留原文件，未转码`, sourcePreserved: true };
  }
  if (maxDimension >= 1920 && usableBitrate !== null && usableBitrate >= 1500) {
    return { state: "high", label: "高清源", reason: `${Math.round(width)}×${Math.round(height)} · ${Math.round(usableBitrate)} kbps`, sourcePreserved: true };
  }
  return {
    state: "standard",
    label: "标准源",
    reason: `${maxDimension ? `${Math.round(width)}×${Math.round(height)}` : "分辨率未取得"}${usableBitrate !== null ? ` · ${Math.round(usableBitrate)} kbps` : ""}；保留原文件`,
    sourcePreserved: true,
  };
}

/* ─────────── 分类 ─────────── */
export async function categorize(title) {
  return classifyCategory(String(title || ""));
}

/** staging 包：写完全部文件校验后原子 rename 到最终目录（失败不留半包） */
async function makePackageStaging(category) {
  const now = new Date();
  const datePart = [String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, "0"), String(now.getDate()).padStart(2, "0")];
  const assetId = `kb_${randomUUID().slice(0, 8)}`;
  const pkgDir = join(KB_ROOT, category, ...datePart, assetId);
  const stagingDir = `${pkgDir}.staging-${randomUUID().slice(0, 6)}`;
  const assetsDir = join(stagingDir, "assets");
  await mkdir(assetsDir, { recursive: true });
  return { assetId, pkgDir, stagingDir, assetsDir };
}

async function commitStaging(stagingDir, pkgDir) {
  // 校验 staging 存在且非空，然后原子 rename
  const assetsDir = join(stagingDir, "assets");
  const entries = await readdirSafe(assetsDir);
  if (!entries.some((e) => /\.(mp4|mov|m4v|webm)$/i.test(e))) throw new Error("staging_missing_video");
  await mkdir(join(pkgDir, ".."), { recursive: true }).catch(() => {});
  await rename(stagingDir, pkgDir);
}

async function readdirSafe(dir) {
  const { readdir } = await import("node:fs/promises");
  try { return await readdir(dir); } catch { return []; }
}

/** 唯一文件名（禁 .mp4.mp4 与重名） */
function uniqueFileName(base, ext, existing = new Set()) {
  const clean = String(base).replace(/\.(mp4|mov|m4v|webm)$/i, "").replace(/[\\/:*?"<>|\r\n]/g, "").slice(0, 80) || "video";
  let name = `01-${clean}.${ext}`;
  let n = 1;
  while (existing.has(name)) {
    n += 1;
    name = `01-${clean}-${n}.${ext}`;
  }
  existing.add(name);
  return name;
}

/* ─────────── 记录收据/观察 ─────────── */
/** 收据落库前的防御性净化：非稳定分享 URL 一律不留；签名/临时直链 URL 与孤立敏感键值片段一律 redact */
function sanitizeReceiptUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw) && isStableShareUrl(raw)) return canonicalizeSourceUrl(raw);
  return null; // downloadUrl / 签名直链 / 任意非稳定 URL 绝不落库
}
/** 敏感键值片段（URL query / 任意文本中孤立出现）：token=xxx、decodeKey=xxx、encfilekey=…、X-Amz-* 等 */
/** 换行压平（D2 安全）：CRLF/CR/LF/U+2028/U+2029 → 单个空格；安全文本输出恒为单行，杜绝跨行泄漏。 */
export function flattenToSingleLine(value) {
  return String(value ?? "").replace(/\r\n|\r|\n|\u2028|\u2029/g, " ");
}

/** 敏感键到文本末尾脱敏（D2 安全，导出共享）：先把换行压平成单个空格（单行安全输出），再用通用
 *  assignment scanner 扫描**不含点**的候选键 [A-Za-z][A-Za-z0-9_-]{0,127}（dot/bracket 容器
 *  headers.authorization / headers[authorization] / headers[token][0] 会继续扫到内部键）；
 *  每个候选**先**用 isSensitiveFieldName 分类，**再**检查其后**有界** suffix 是否构成赋值：
 *  允许普通或反斜杠转义的单双引号、最多有限个 ]、[]、[index] 组合（每组内容 ≤32 字符、至多 4 组，
 *  无灾难回溯）、再允许 ASCII/全角 :=：＝；命中即从候选键遮蔽到文本末尾（prefix+[redacted]）；
 *  无敏感键则返回压平后的文本。键名分类统一由 content-metadata.mjs 的 isSensitiveFieldName 决定
 *  （access_token/authkey/decode_key/ws_secret/clientSecret/api_key/auth/uskey/x-uskey +
 *  语义段 authorization/cookie/token/secret/password/signature/auth/uskey + endsWith token/secret/
 *  password/signature + X-Amz-/x-cos-/x-oss-；monkey/oauth/ordinary_key/cookiePolicy/tokenizer 不遮蔽）。
 *  quoted/unquoted/URL/JSON/引号不平衡/全角分隔符/嵌套索引/跨行全场景一次覆盖；
 *  变异为「删除 auth/uskey/x-uskey」「候选含点吞掉容器内键」「取消换行压平」必泄漏 → 测试拦截。 */
export function keyToEolRedactor(value) {
  const flat = flattenToSingleLine(value);
  const re = /[A-Za-z][A-Za-z0-9_-]{0,127}/g;
  const assignmentAfter = /^(?:\\?["'])?(?:\[[^\]\r\n]{0,32}\]|\]){0,4}\s*[:=：＝]/;
  let m;
  while ((m = re.exec(flat)) !== null) {
    const keyName = m[0];
    if (!isSensitiveFieldName(keyName)) continue;
    const after = flat.slice(m.index + m[0].length);
    if (assignmentAfter.test(after)) {
      return flat.slice(0, m.index) + "[redacted]";
    }
  }
  return flat;
}
/** 标题专用净化（D2 安全）：先 sanitizeReceiptText（压平 + 键到文本末尾 + URL，稳定分享保留）；
 *  路径门控用**真实左边界后的明确有界 alternatives**（file://、[A-Za-z]:[\\/] 盘符、UNC 双反斜杠、~/、
 *  普通或转义 POSIX slash），slash/home/UNC 起始后用 (?=\S)（非空白，**不用 ASCII 白名单**；
 *  /用户/秘密.mp4 与 /srv/acme/… 均命中，而 / 后为空格或行尾时不误伤中文标题）——
 *  带前缀原始样本 视频 /用户/秘密_CHINESE_PATH.mp4、错误 file:///Users/…、错误 C:\Users\…、
 *  下载失败 \\srv\share\…、视频 /srv/acme/…、视频 ~/acme/…、file_not_found: /Users/…、
 *  path = /srv/acme/…、file_not_found:\/Users\/… 全部门控命中并吞 marker；
 *  普通中文斜杠标题（厨房/卫生间改造、厨房 / 卫生间、厨房/home/卫生间改造）逐字保留。
 *  mutation-kill：把 (?=\S) 改回 ASCII 白名单或删 file:// alternative → /用户 或内嵌 file:// 样本必红。 */
export function sanitizeReceiptTitle(value) {
  const raw = String(value ?? "");
  const pre = sanitizeReceiptText(raw);
  const trimmed = raw.trim();
  const pathLike = /(^|[\s:=：＝,;([{>])(?:file:\/\/|[A-Za-z]:[\\/]|\\\\(?=\S)|~[\\/](?=\S)|\\?\/(?=\S))/i.test(trimmed);
  return pathLike ? sanitizeFailureText(pre) : pre;
}
function sanitizeReceiptText(value) {
  let s = flattenToSingleLine(String(value ?? ""));
  // 1) 压平 + 敏感键到文本末尾（源级，先于 URL）：URL/JSON/引号/转义/裸值/引号不平衡/跨行全场景一次覆盖，
  //    http://x/video?authorization=Bearer ABC_SECRET、http://x/video?token="LEFT SECRET、
  //    cookie="SESSION=ONE"; OTHER=COOKIE_SECRET、token=\nCONT_TOKEN_SECRET 的值段/全文残留全部消失
  s = keyToEolRedactor(s);
  // 2) 完整 URL：稳定分享 URL 保留；签名/临时直链 URL redact（含引号段与空格）
  s = s.replace(/https?:\/\/[^\s<>"']*(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'[^\s<>"']*)*/gi, (m) => {
    if (containsSensitiveUrlMaterial(m)) return redactUrlForStorage(m);
    if (/^https?:\/\//i.test(m) && !isStableShareUrl(m)) return redactUrlForStorage(m);
    return m;
  });
  return s;
}
/** 失败文本深度净化（D2 安全，唯一实现）：从同一「换行压平 + 敏感键到文本末尾」结果开始（键命中即遮蔽全文），
 *  再做 URL/file URL、Windows 盘符（真实左边界，保留前导错误码）、UNC、~/ 或 ~\、每个 POSIX 绝对路径
 *  （行首/冒号/等号/标点/连字符/点后/单段）——路径命中后吞到文本末尾（文本已压平为单行，[^\r\n]* 即全文）。
 *  保留前导分隔符与稳定错误码前缀；输出有界。
 *  用于所有持久化 sink：ingestOne updateItem error、recordReceipt error/outcome/fallbackReason、
 *  observeIngest message、补偿/错误分支的失败返回值；kb-routes 的 redaction 边界复用本实现。 */
export function sanitizeFailureText(value) {
  // 同一压平/键净化结果开始（keyToEolRedactor 内部先压平）
  let s = keyToEolRedactor(value);
  // 转义绝对路径归一化：\/ → /（JSON 转义斜杠），使 file_not_found:\/Users\/private\/… 可被路径规则吞到文本末尾
  s = s.replace(/\\(?=\/)/g, "");
  // 1) URL / file URL（含签名 query、引号、空格，吞到文本末尾）
  s = s.replace(/(?:https?|file):\/\/[^\r\n]*/gi, "[redacted]");
  // 2) Windows 盘符路径：真实左边界（前一字符非字母数字，绝不把 failed:d:/ 误读为盘符），吞到文本末尾
  s = s.replace(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\r\n]*/g, "[redacted]");
  // 3) UNC 路径（\\server\share\…），吞到文本末尾；保留前导分隔符/错误码
  s = s.replace(/(^|[^A-Za-z0-9_/\\])(\\\\[^\r\n]*)/g, (_match, pre) => `${pre}[redacted]`);
  // 4) ~/ 或 ~\ 相对路径，吞到文本末尾
  s = s.replace(/~[\\/][^\r\n]*/g, "[redacted]");
  // 5) 每个 POSIX 绝对路径：行首、冒号/等号/标点/空白/连字符/点后、单段（/tmp），吞到文本末尾
  s = s.replace(/(^|[^A-Za-z0-9_/\\])(\/[^\r\n]*)/g, (_match, pre) => `${pre}[redacted]`);
  return s.slice(0, 1200);
}
/** 深度净化任意值（对象/数组/字符串），用于 evidence 落库 */
function sanitizeReceiptValue(value, depth = 0) {
  if (value === null || value === undefined) return value;
  if (depth > 6) return "[depth]";
  if (typeof value === "string") return sanitizeFailureText(sanitizeReceiptText(value));
  if (Array.isArray(value)) return value.map((v) => sanitizeReceiptValue(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // 敏感键整键剔除（统一分类器 isSensitiveFieldName：authorization/cookie/password/access_token/
      // clientSecret/X-Amz-/x-cos-/x-oss- 等；{authorization:'Bearer X'} 值绝不落库）
      if (isSensitiveFieldName(k)) continue;
      out[k] = sanitizeReceiptValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function recordReceipt(db, receipt, { assetId = null, outcome = null }) {
  // 防御性净化：不信任调用方，任何 downloadUrl/签名 query 在此被剥除
  const safeSource = sanitizeReceiptUrl(receipt.sourceUrl);
  // title 用专用净化：普通中文斜杠标题逐字保留；仅明确路径形态（/、~/、盘符、UNC、file://、
  // 冒号/等号后路径、根路径）才叠加路径到文本末尾
  const safeTitle = sanitizeReceiptTitle(receipt.title);
  const safeError = sanitizeFailureText(sanitizeReceiptText(receipt.error));
  const safeOutcome = sanitizeFailureText(sanitizeReceiptText(outcome));
  // G：evidence 只编码一次（深度净化对象后 JSON.stringify），读取后是对象而非双重 JSON 字符串
  const evidenceJson = receipt.validationEvidence ? JSON.stringify(sanitizeReceiptValue(receipt.validationEvidence)) : null;
  db.prepare(
    `INSERT INTO download_receipt (asset_id, channel, source_url, content_id, sha256, media_validation, fallback_reason, started_at, completed_at, title, size_bytes, evidence, input_kind, outcome)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    assetId, receipt.channel, safeSource, sanitizeReceiptTitle(receipt.contentId) || null,
    receipt.sha256 || null, receipt.mediaValidation, sanitizeFailureText(sanitizeReceiptText(receipt.fallbackReason)) || null,
    receipt.startedAt, receipt.completedAt, safeTitle || null,
    receipt.sizeBytes ?? null, evidenceJson,
    "auto", safeOutcome,
  );
  // 每次尝试同步写 ingest_observation（安全的通道尝试历史）
  const message = `${receipt.channel}[${receipt.mediaValidation}]${safeOutcome ? `:${safeOutcome}` : ""}${safeError ? ` ${safeError.slice(0, 120)}` : ""}`;
  observeIngest(db, { assetId, kind: "receipt", message });
}

export function observeIngest(db, { assetId = null, kind, message }) {
  db.prepare("INSERT INTO ingest_observation (asset_id, kind, message, observed_at) VALUES (?,?,?,?)")
    .run(assetId, kind, String(sanitizeFailureText(message)).slice(0, 500), new Date().toISOString());
}

/** input 落库前脱敏：签名 URL → fingerprint；分享 URL → canonical；本地路径保留（API 层仅回 basename） */
function safeInputForStorage(input) {
  const raw = String(input || "");
  if (/^https?:\/\//i.test(raw)) {
    if (containsSensitiveUrlMaterial(raw)) return redactUrlForStorage(raw);
    if (isStableShareUrl(raw)) return canonicalizeSourceUrl(raw);
    return redactUrlForStorage(raw); // 非分享的临时/签名直链一律 fingerprint
  }
  return raw || null;
}

/* ─────────── 单条导入 ─────────── */
export async function ingestOne(db, { receipt, input, input_kind, batchId, ctx = {} }) {
  const { yuanbaoEnrich } = ctx;
  const record = (sql, ...args) => db.prepare(sql).run(...args);
  const row = (sql, ...args) => db.prepare(sql).get(...args);
  const now = new Date();

  const updateItem = (status, error, assetId) =>
    record(
      "UPDATE import_item SET status=?, error=?, asset_id=?, updated_at=? WHERE id=?",
      // D2 安全：所有持久化到 import_item.error 的文本（含内部 catch 的 e.stack/e.message）一律先经
      // sanitizeFailureText（稳定错误码保留，路径/URL/密钥 → [redacted]），杜绝 resolved-failed 路径外泄。
      status, error ? sanitizeFailureText(String(error)).slice(0, 1200) : null, assetId || null, now.toISOString(), itemId,
    );

  const persistTerminal = async (status, error, assetId, outcome) =>
    withImmediateTransactionRetry(db, async () => {
      recordReceipt(db, receipt, { assetId, outcome });
      const changed = updateItem(status, error, assetId);
      if (changed.changes !== 1) throw new Error("terminal_item_update_failed");
    });

  // 支持预建 item（kuaidian handler 先行创建 import_item，adapter 前失败也能追踪同一 item）
  let itemId = ctx.itemId;
  if (!itemId) {
    itemId = record(
      "INSERT INTO import_item (batch_id, input, input_kind, display_input, status, updated_at) VALUES (?,?,?,?, 'pending', ?)",
      batchId, safeInputForStorage(input), input_kind ?? "unknown",
      ctx.displayInput || null, now.toISOString(),
    ).lastInsertRowid;
  } else {
    // 预建 item：更新输入字段；F：不无条件改回 pending（已认领为 processing 的 item 保持 processing，
    // 防止并发第二个回报重复启动同 item；仅仍为 pending 的才保留 pending 语义）
    record("UPDATE import_item SET input=?, input_kind=?, display_input=COALESCE(display_input, ?), error=NULL, updated_at=? WHERE id=? AND status='pending'",
      safeInputForStorage(input, input_kind), input_kind ?? "unknown", ctx.displayInput || null, now.toISOString(), itemId);
  }

  let localPath = null;
  try {
    localPath = receipt?.localPath || (input_kind === "file" ? input : null);
    if (!localPath) {
      if (input_kind === "file") {
        const st = await stat(input).catch(() => null);
        if (!st) throw new Error(`file_not_found:${input}`);
        localPath = input;
      } else {
        throw new Error("no_local_path");
      }
    }
    const st = await stat(localPath).catch(() => null);
    if (!st) throw new Error(`file_not_found:${localPath}`);

    const media = receipt?.media || await probeLocalMedia(localPath);
    const mediaValidation = receipt?.mediaValidation || media.mediaValidation || "unknown";
    const sha256 = receipt?.sha256 || media.sha256;
    const channel = receipt?.channel || (input_kind === "file" ? "local" : "unknown");
    const fallbackReason = receipt?.fallbackReason || null;
    const sourceUrl = receipt?.sourceUrl || null;
    const contentId = receipt?.contentId || deriveContentId(sourceUrl, "wechat_channels", {}) || null;

    // A4.3-C1：获取 sha256 后，从「查重」到「duplicate 处理 / staging → 包提交 → 资产插入 → receipt → item 终态更新」
    // 全程进入进程内 SHA-keyed 临界区（同 SHA 串行、不同 SHA 互不阻塞；锁在 finally 释放，任何错误/return 都释放）。
    // 所有 post-SHA 路径（含补偿失败）都在锁内写 receipt + item 终态；锁外 catch 只处理 probe/文件缺失等 pre-SHA 失败。
    return await withShaLock(sha256, async () => {
      try {
        // ── 幂等：sha256 已存在 ──
        const dup = row("SELECT id, title, source_url, channel, media_validation, package_path FROM video_asset WHERE sha256 = ?", sha256);
        if (dup) {
          // 补渠道/验证（仅空时；不覆盖已有 channel —— channel 历史由 download_receipt 保留）
          if (mediaValidation && (!dup.media_validation || dup.media_validation === "unknown")) {
            db.prepare("UPDATE video_asset SET media_validation=?, updated_at=? WHERE id=?").run(mediaValidation, now.toISOString(), dup.id);
          }
          if (channel && !dup.channel) {
            db.prepare("UPDATE video_asset SET channel=?, updated_at=? WHERE id=?").run(channel, now.toISOString(), dup.id);
          }
          recordReceipt(db, receipt, { assetId: dup.id, outcome: "duplicate_linked" });
          // 补元数据：只要 sourceUrl 稳定且有 enrich，同 sourceUrl 也补数（同 post 二次观测写新快照）
          let linked = false;
          if (sourceUrl && yuanbaoEnrich) {
            try {
              const enriched = await yuanbaoEnrich(sourceUrl);
              if (enriched?.media) {
                const { inserted } = await insertPlatformPost(db, dup.id, enriched.media, sourceUrl, enriched.raw);
                linked = inserted;
              }
            } catch { /* 补元数据失败不阻断 */ }
          }
          updateItem(linked ? "linked" : "duplicate", linked ? `linked_new_post_to:${dup.id}` : `duplicate_of:${dup.id}`, dup.id);
          return { status: linked ? "linked" : "duplicate", assetId: dup.id };
        }

        // ── encrypted/invalid 不进可搜索资产（仅收据 + import_item） ──
        if (mediaValidation !== "ok") {
          recordReceipt(db, receipt, { assetId: null, outcome: `media_validation:${mediaValidation}` });
          updateItem("partial", `media_validation:${mediaValidation}`, null);
          return { status: "partial", assetId: null, mediaValidation };
        }

        // ── staging 建包（视频+6 文件写完校验后原子 rename；失败不留 searchable asset） ──
        const titleGuess = receipt?.title || (input_kind === "file" ? (input.split("/").pop() || "未命名视频") : "未命名视频");
        const category = await categorize(titleGuess);
        const { assetId, pkgDir, stagingDir, assetsDir } = await makePackageStaging(category);

        let assetIdFinal = assetId;
        // A4.3-C2：enriched 提升到 staging try 之外，供 UNIQUE 冲突收敛分支复用已取到的 enrichment
        let enriched = null;
        // C2a-1：OWNER_TX 是否开启（创建者资产插入与其全部终态在同一 BEGIN IMMEDIATE 事务内原子可见）
        let ownerTxOpen = false;
        // C2a-2：仅由 INSERT video_asset 局部 try/catch 在精确谓词命中时置位；外 catch 凭此进入 winner 收敛
        let shaInsertConflict = false;
        try {
          const ext = (localPath.split(".").pop() || "mp4").toLowerCase();
          const videoName = uniqueFileName(titleGuess, ext);
          const destFile = join(assetsDir, videoName);
          await copyFile(localPath, destFile);

          // 元宝补元数据（在包提交前完成，metadata 摘要包含帖子信息）
          if (sourceUrl && yuanbaoEnrich) {
            try {
              enriched = await yuanbaoEnrich(sourceUrl);
            } catch { /* 补元数据失败不阻断 */ }
          }

          // 6 文件原子写进 staging
          await writePackageFiles(stagingDir, assetId, {
            title: titleGuess, category, sourceUrl, contentId, media, channel, mediaValidation, fallbackReason, sha256,
            videoName, enriched,
          });

          // 校验 + rename staging → 最终包
          await commitStaging(stagingDir, pkgDir);

          // C2a-1：OWNER_TX —— commitStaging 之后、INSERT 之前开启 BEGIN IMMEDIATE；
          // 资产插入 + 平台帖/快照 + 内容分析 + 溯源 + success receipt + 创建者 item 终态全部同事务原子可见。
          await beginImmediateWithRetry(db);
          ownerTxOpen = true;

          // DB 提交（包完成后才可搜索）
          // C2a-2：仅当 INSERT video_asset 本身上抛出精确 SHA UNIQUE 冲突才置位 shaInsertConflict；
          // 后续 platform/analysis/receipt/item 步骤的错误绝不误判为 SHA 冲突。
          try {
            record(
              `INSERT INTO video_asset (id, source_url, sha256, title, file_path, package_path, category, size_bytes, duration_ms, width, height, codec_video, codec_audio, bitrate_kbps, channel, content_id, fallback_reason, media_validation, downloaded_at, legacy_id, captured_at, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              assetIdFinal, sourceUrl, sha256, titleGuess, join(pkgDir, "assets", videoName), pkgDir, category,
              media.size_bytes, media.duration_ms, media.width, media.height,
              media.codec_video, media.codec_audio, media.bitrate_kbps,
              channel, contentId, fallbackReason, mediaValidation, now.toISOString(),
              ctx.legacyId || null, now.toISOString(), now.toISOString(), now.toISOString(),
            );
          } catch (insertErr) {
            if (insertErr?.code === "ERR_SQLITE_ERROR" && insertErr?.errcode === 2067 && insertErr?.message === "UNIQUE constraint failed: video_asset.sha256") {
              shaInsertConflict = true;
            }
            throw insertErr;
          }

          let platformInserted = false;
          if (enriched?.media) {
            const r = await insertPlatformPost(db, assetIdFinal, enriched.media, sourceUrl, enriched.raw);
            platformInserted = r.inserted;
          }

          // 分析（可重复 upsert）+ 溯源
          await runContentAnalysis(db, assetIdFinal, { title: titleGuess, media });
          await writeProvenance(db, assetIdFinal, media, platformInserted, sourceUrl, mediaValidation, channel);

          recordReceipt(db, receipt, { assetId: assetIdFinal, outcome: "success" });
          // 创建者 item 终态：直接 UPDATE，必须 changes===1，否则抛错回滚（绝不假装成功）
          const creatorUpdate = db.prepare(
            "UPDATE import_item SET status='success', error=NULL, asset_id=?, updated_at=? WHERE id=?",
          ).run(assetIdFinal, now.toISOString(), itemId);
          if (creatorUpdate.changes !== 1) throw new Error("creator_item_update_failed");
          db.exec("COMMIT");
          ownerTxOpen = false;
          return { status: "success", assetId: assetIdFinal };
        } catch (e) {
          // A4.3-C2：仅捕获 video_asset.sha256 的精确 UNIQUE 冲突（跨进程同字节同时导入，
          // 双方均在查重后通过、由唯一索引定 winner）。找到已提交 winner 后才收敛：
          // 只删 loser 自己的 staging/包路径（绝不碰 winner 路径）、复用已取到的 enrichment
          // 把 loser source post 链到 winner、写指向 winner 的跨进程 duplicate receipt、
          // 更新 loser item 为 duplicate/linked（asset_id=winner）并返回该终态。
          // 其他 INSERT 错误保持现有补偿行为。
          // C2a-1：OWNER_TX 未提交前任何失败（UNIQUE 冲突或其他错误）都必须先 ROLLBACK，
          // 再执行 UNIQUE 收敛查询或现有补偿（绝不带着未提交事务查询/清理）。
          // C2a-2：回滚失败不可吞 —— 捕获回滚错误；回滚后检查 db.isTransaction：
          // 仍处于事务中则立即失败返回（不查 winner/不删路径/不走补偿/不声称终态）；
          // 已不在事务中则复位 ownerTxOpen 并继续原逻辑。
          let rollbackError = null;
          if (ownerTxOpen) {
            try {
              db.exec("ROLLBACK");
            } catch (rbErr) {
              rollbackError = rbErr;
            }
            ownerTxOpen = false;
          }
          if (db.isTransaction) {
            return {
              status: "failed",
              error: `owner_tx_rollback_failed:${sanitizeFailureText(String((rollbackError && rollbackError.message) || rollbackError || "still_in_transaction"))}`.slice(0, 500),
              assetId: assetIdFinal,
              needsAttention: true,
            };
          }
          // C2a-2：仅 INSERT video_asset 本身上抛的精确 SHA UNIQUE 冲突（shaInsertConflict=true）才进入 winner 收敛
          // C2a-3：winner 查询（含 sha256/package_path）；首查为空 → 有界重试 20×50ms → 仍无则抛错，
          // 交由正常 failed 补偿清理本候选，绝不猜测。
          const isShaUniqueConflict = shaInsertConflict;
          if (isShaUniqueConflict) {
            let winnerRow = row("SELECT id, title, source_url, channel, media_validation, sha256, package_path FROM video_asset WHERE sha256 = ?", sha256);
            for (let attempt = 0; !winnerRow && attempt < 20; attempt += 1) {
              await new Promise((r) => setTimeout(r, 50));
              winnerRow = row("SELECT id, title, source_url, channel, media_validation, sha256, package_path FROM video_asset WHERE sha256 = ?", sha256);
            }
            if (!winnerRow) {
              throw new Error("sha_unique_conflict_without_visible_winner");
            }
            // 路径守卫：全部通过才允许删除 loser 路径；任一失败 → 不 rm，写 path_guard_failed 终态
            const kbRootResolved = resolve(KB_ROOT);
            const winnerPkgResolved = resolve(String(winnerRow.package_path || ""));
            const loserPkgResolved = resolve(pkgDir);
            const stagingResolved = resolve(stagingDir);
            const guardOk = winnerRow.id !== assetIdFinal
              && winnerRow.sha256 === sha256
              && Boolean(winnerRow.package_path)
              && winnerPkgResolved !== loserPkgResolved
              && loserPkgResolved.startsWith(`${kbRootResolved}${sep}`)
              && stagingResolved.startsWith(`${kbRootResolved}${sep}`)
              && basename(pkgDir) === assetIdFinal
              && basename(stagingDir).startsWith(`${assetIdFinal}.staging-`);
            if (!guardOk) {
              recordReceipt(db, receipt, { assetId: winnerRow.id, outcome: "duplicate_cross_process_path_guard_failed" });
              updateItem("failed", `duplicate_cross_process_path_guard_failed:winner=${winnerRow.id}; path guard mismatch`, winnerRow.id);
              return { status: "failed", error: `duplicate_cross_process_path_guard_failed:winner=${winnerRow.id}`, assetId: winnerRow.id, needsAttention: true };
            }
            // 只删 staging + 未提交的 pkgDir（winner 包绝不触碰）；任一 rm 失败 → cleanup_failed 终态，不继续
            try {
              await rm(stagingDir, { recursive: true, force: true });
              await rm(pkgDir, { recursive: true, force: true });
            } catch (rmErr) {
              recordReceipt(db, receipt, { assetId: winnerRow.id, outcome: "duplicate_cross_process_cleanup_failed" });
              updateItem("failed", `duplicate_cross_process_cleanup_failed:winner=${winnerRow.id}; ${String((rmErr && rmErr.message) || rmErr).slice(0, 200)}`, winnerRow.id);
              return { status: "failed", error: `duplicate_cross_process_cleanup_failed:winner=${winnerRow.id}`, assetId: winnerRow.id, needsAttention: true };
            }
            // LINK_TX：重新精确查询 winner id+sha → 补帖（enrichment 已取到，无空 catch）→
            // duplicate_cross_process_sha receipt → loser item 直接 UPDATE linked/duplicate（winner id, changes===1）→ COMMIT 立即返回。
            let linkTxOpen = false;
            try {
              await beginImmediateWithRetry(db);
              linkTxOpen = true;
              const winnerNow = row("SELECT id, sha256 FROM video_asset WHERE id = ? AND sha256 = ?", winnerRow.id, sha256);
              if (!winnerNow) throw new Error("winner_disappeared_before_link");
              let linked = false;
              if (enriched?.media) {
                const { inserted } = await insertPlatformPost(db, winnerRow.id, enriched.media, sourceUrl, enriched.raw);
                linked = inserted;
              }
              recordReceipt(db, receipt, { assetId: winnerRow.id, outcome: "duplicate_cross_process_sha" });
              const linkUpdate = db.prepare(
                "UPDATE import_item SET status=?, error=?, asset_id=?, updated_at=? WHERE id=?",
              ).run(linked ? "linked" : "duplicate", linked ? `linked_new_post_to:${winnerRow.id}` : `duplicate_of:${winnerRow.id}`, winnerRow.id, now.toISOString(), itemId);
              if (linkUpdate.changes !== 1) throw new Error("loser_item_update_failed");
              db.exec("COMMIT");
              linkTxOpen = false;
              return { status: linked ? "linked" : "duplicate", assetId: winnerRow.id };
            } catch (linkErr) {
              // LINK_TX 任何错误：绝不声称 duplicate/linked；先回滚再检查事务状态
              let linkRollbackError = null;
              if (linkTxOpen) {
                try { db.exec("ROLLBACK"); } catch (rbErr) { linkRollbackError = rbErr; }
                linkTxOpen = false;
              }
              if (db.isTransaction) {
                // 回滚失败仍处事务中：立即失败返回，不做更多 DB/文件动作
                return {
                  status: "failed",
              error: `duplicate_cross_process_link_failed:owner_tx_rollback_failed:${sanitizeFailureText(String((linkRollbackError && linkRollbackError.message) || linkRollbackError || "still_in_transaction"))}`.slice(0, 500),
                  assetId: winnerRow.id,
                  needsAttention: true,
                };
              }
              recordReceipt(db, receipt, { assetId: winnerRow.id, outcome: "duplicate_cross_process_link_failed" });
              updateItem("failed", `duplicate_cross_process_link_failed:winner=${winnerRow.id}; ${String((linkErr && linkErr.message) || linkErr).slice(0, 200)}`, winnerRow.id);
              return { status: "failed", error: `duplicate_cross_process_link_failed:winner=${winnerRow.id}`, assetId: winnerRow.id, needsAttention: true };
            }
          }
          // D：补偿 DB 优先、文件后删。同一事务里把 receipt/observation 的 asset_id 置 NULL（保留证据）再删资产；
          // 事务成功并确认 video_asset 不存在后才删包目录。DB 清理失败则整体回滚，保留完整包与文件，
          // item 保留 asset_id 并明确 compensation_failed/needs_attention；绝不允许 DB 行存在而文件消失。
          const origMsg = String((e && e.message) || e).slice(0, 500);
          let compensated = false;
          let compensationError = null;
          try {
            await withImmediateTransactionRetry(db, async () => {
              db.prepare("UPDATE download_receipt SET asset_id=NULL WHERE asset_id=?").run(assetIdFinal);
              db.prepare("UPDATE ingest_observation SET asset_id=NULL WHERE asset_id=?").run(assetIdFinal);
              db.prepare("DELETE FROM video_asset WHERE id=?").run(assetIdFinal); // 级联清子表
            });
            compensated = true;
          } catch (ce) {
            compensationError = String((ce && ce.message) || ce).slice(0, 200);
          }
          if (compensated) {
            // DB 清理成功 → 才删包/文件（不留悬空资产）
            await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
            await rm(pkgDir, { recursive: true, force: true }).catch(() => {});
            // A4.3-C1 修正：补偿成功后的 failed 终态也必须在锁内写（receipt + item），
            // 绝不 throw 逃出锁再让锁外 catch 补写（那会先释放 SHA 锁）。
            const failMsg = String((e && e.message) || e).slice(0, 120);
            await persistTerminal(
              "failed",
              String((e && e.stack) || e || "unknown").slice(0, 1200),
              null,
              `failed:${failMsg}`,
            );
            return { status: "failed", error: sanitizeFailureText(String((e && e.message) || e)).slice(0, 500) };
          }
          // 补偿失败：保留资产与完整包；item 保留 asset_id 并明确 compensation_failed/needs_attention
          recordReceipt(db, receipt, { assetId: assetIdFinal, outcome: `compensation_failed:${compensationError}` });
          observeIngest(db, { assetId: assetIdFinal, kind: "compensation_failed", message: `${compensationError}:${origMsg}` });
          updateItem("failed", `compensation_failed:${compensationError}:${origMsg}`, assetIdFinal);
          return { status: "failed", error: sanitizeFailureText(`compensation_failed:${compensationError}`), assetId: assetIdFinal, needsAttention: true };
        }
      } catch (e) {
        // A4.3-C1 修正：任何其他 post-SHA 错误（如 staging 建包/查重异常）也都在锁内写 failed 终态，
        // 不外溢给锁外 catch；锁外 catch 只负责 probe/文件缺失等尚未取得 sha 的 pre-SHA 失败。
        await persistTerminal(
          "failed",
          String((e && e.stack) || e || "unknown").slice(0, 1200),
          null,
          `failed:${String((e && e.message) || e).slice(0, 120)}`,
        );
        return { status: "failed", error: sanitizeFailureText(String((e && e.message) || e)).slice(0, 500) };
      }
    });
  } catch (e) {
    await persistTerminal(
      "failed",
      String((e && e.stack) || e || "unknown").slice(0, 1200),
      null,
      `failed:${String((e && e.message) || e).slice(0, 120)}`,
    );
    return { status: "failed", error: sanitizeFailureText(String((e && e.message) || e)).slice(0, 500) };
  } finally {
    // 临时文件统一清理（success 已复制 / duplicate / partial / 异常）
    if (receipt?.temporary && localPath) {
      await rm(localPath, { force: true }).catch(() => {});
    }
  }
}

/** 插入/更新 platform_post + metric_snapshot；同 (asset_id, content_id) 更新而非跳过；快照每次观测都写 */
async function insertPlatformPost(db, assetId, media, sourceUrl, rawForStorage) {
  const now = new Date().toISOString();
  const post = platformPostFrom(media, sourceUrl, "");
  const contentId = media?.postId || deriveContentId(sourceUrl, "wechat_channels", media || {}) || null;
  // 每次成功元数据观测 = 一次 observation（同一次观测幂等；同 post 不同时间补数写新快照）
  const observationId = `obs:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;

  const exists = contentId
    ? db.prepare("SELECT id FROM platform_post WHERE asset_id = ? AND content_id = ?").get(assetId, contentId)
    : null;
  if (exists) {
    db.prepare(
      `UPDATE platform_post SET author=?, author_avatar_url=?, author_cert_icon_url=?, publish_time=?, title=?, topics=?, music=?, cover_url=?, platform=?, plays=?, plays_raw=?, likes=?, likes_raw=?, comments=?, comments_raw=?, favorites=?, favorites_raw=?, shares=?, shares_raw=?, scaling_info=?, fetched_at=? WHERE asset_id=? AND content_id=?`,
    ).run(
      post.author, post.authorAvatarUrl, post.authorCertIconUrl, post.publishTime, post.title,
      post.topics ? JSON.stringify(post.topics) : null, post.music, post.coverUrl, post.platform,
      post.plays, post.plays_raw, post.likes, post.likes_raw, post.comments, post.comments_raw,
      post.favorites, post.favorites_raw, post.shares, post.shares_raw,
      post.scalingInfo ? JSON.stringify(post.scalingInfo) : null, now, assetId, contentId,
    );
    writeSnapshot(db, assetId, contentId, post, now, observationId);
    return { inserted: false };
  }

  // 脱敏原始数据：包内只留脱敏版
  let sanitizedPath = null;
  if (rawForStorage) {
    const sanitized = sanitizeRawForStorage(rawForStorage);
    const pkgDir = db.prepare("SELECT package_path FROM video_asset WHERE id = ?").get(assetId)?.package_path;
    if (pkgDir) {
      sanitizedPath = join(pkgDir, "raw-yuanbao.sanitized.json");
      await mkdir(pkgDir, { recursive: true }).catch(() => {});
      await writeFile(sanitizedPath, JSON.stringify(sanitized, null, 2)).catch(() => {});
    }
  }

  db.prepare(
    `INSERT INTO platform_post (asset_id, content_id, post_id, url, author, author_avatar_url, author_cert_icon_url, publish_time, title, topics, music, cover_url, platform, plays, plays_raw, likes, likes_raw, comments, comments_raw, favorites, favorites_raw, shares, shares_raw, scaling_info, raw_json_path, fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    assetId, contentId, post.postId, post.url, post.author, post.authorAvatarUrl, post.authorCertIconUrl,
    post.publishTime, post.title, post.topics ? JSON.stringify(post.topics) : null, post.music,
    post.coverUrl, post.platform,
    post.plays, post.plays_raw, post.likes, post.likes_raw, post.comments, post.comments_raw,
    post.favorites, post.favorites_raw, post.shares, post.shares_raw,
    post.scalingInfo ? JSON.stringify(post.scalingInfo) : null,
    sanitizedPath, now,
  );
  writeSnapshot(db, assetId, contentId, post, now, observationId);
  return { inserted: true };
}

/** 指标快照：UNIQUE(asset_id, content_id, source, observation_id) 幂等；不同观测同 post 都保留 */
function writeSnapshot(db, assetId, contentId, post, capturedAt, observationId) {
  db.prepare(
    "INSERT OR IGNORE INTO metric_snapshot (asset_id, content_id, captured_at, plays, plays_raw, likes, likes_raw, comments, comments_raw, favorites, favorites_raw, shares, shares_raw, source, observation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
  ).run(
    assetId, contentId || null, capturedAt,
    post.plays, post.plays_raw, post.likes, post.likes_raw, post.comments, post.comments_raw,
    post.favorites, post.favorites_raw, post.shares, post.shares_raw,
    "yuanbao_enrich", observationId,
  );
}

/**
 * 仅元数据刷新（A4.2.1）：用稳定 source URL 调元宝 enrich，复用平台帖 upsert + metric snapshot
 * 逻辑（insertPlatformPost），只新增一次互动快照 / 更新帖子元数据。
 * 绝不重新下载、复制或修改媒体资产；asset/import_item/download_receipt 均不增加。
 * 返回 { ok:true, contentId, snapshotAdded } 或 { ok:false, status, error[, message] }。
 */
export async function refreshAssetMetadata(db, assetId, sourceUrl, yuanbaoEnrich) {
  const asset = db.prepare("SELECT * FROM video_asset WHERE id = ?").get(assetId);
  if (!asset) return { ok: false, status: 404, error: "not_found" };
  const rawSource = String(sourceUrl || asset.source_url || "").trim();
  const stableSource = rawSource && isStableShareUrl(rawSource) ? canonicalizeSourceUrl(rawSource) : null;
  if (!stableSource) return { ok: false, status: 400, error: "no_stable_source_url" };
  if (typeof yuanbaoEnrich !== "function") return { ok: false, status: 400, error: "no_enricher_available" };
  let enriched;
  try {
    enriched = await yuanbaoEnrich(stableSource);
  } catch (e) {
    return { ok: false, status: 502, error: "enrich_failed", message: String((e && e.message) || e).slice(0, 300) };
  }
  if (!enriched || !enriched.media) return { ok: false, status: 502, error: "enrich_empty_result" };
  const before = db.prepare("SELECT COUNT(*) c FROM metric_snapshot WHERE asset_id = ?").get(assetId).c;
  await insertPlatformPost(db, assetId, enriched.media, stableSource, enriched.raw || null);
  const after = db.prepare("SELECT COUNT(*) c FROM metric_snapshot WHERE asset_id = ?").get(assetId).c;
  const contentId = enriched.media?.postId || deriveContentId(stableSource, "wechat_channels", enriched.media || {}) || null;
  return { ok: true, contentId, snapshotAdded: after - before >= 1 };
}

/* ─────────── 6 文件原子写（staging 内） ─────────── */
async function writePackageFiles(pkgDir, assetId, { title, category, sourceUrl, contentId, media, channel, mediaValidation, fallbackReason, sha256, videoName, enriched }) {
  const nowIso = new Date().toISOString();
  const platformPosts = enriched?.media
    ? [{ postId: enriched.media.postId || null, author: enriched.media.author || null, publishTime: enriched.media.publishTime || null, title: enriched.media.title || null, likes: enriched.media.likes ?? null, coverUrl: enriched.media.coverUrl || null, platform: "wechat_channels" }]
    : [];
  const metadata = {
    schemaVersion: 2,
    id: assetId,
    identity: {
      contentId,
      sourceKey: sourceUrl ? `sha256:${sha256Text(sourceUrl)}` : null,
      primaryAssetSha256: sha256,
    },
    title,
    category,
    platform: "wechat_channels",
    source: { url: sourceUrl, receivedVia: channel },
    capturedAt: nowIso,
    channel,
    mediaValidation,
    fallbackReason,
    media: {
      durationMs: media?.duration_ms ?? null,
      width: media?.width ?? null,
      height: media?.height ?? null,
      codecVideo: media?.codec_video ?? null,
      codecAudio: media?.codec_audio ?? null,
      bitrateKbps: media?.bitrate_kbps ?? null,
      sizeBytes: media?.size_bytes ?? null,
      sha256,
    },
    files: [
      { path: `assets/${videoName}`, role: "video", sizeBytes: media?.size_bytes ?? null, sha256 },
    ],
    platform_posts: platformPosts,
    corrections: [],
  };
  const unavailable = (kind, reason) => ({ status: "unavailable", reason, generatedAt: null, source: null, kind });
  const analysisMd = `# 内容分析 · ${title}\n\n> 分类：**${category}** ｜ 下载渠道：**${channel || "unknown"}** ｜ 媒体验证：**${mediaValidation}**${fallbackReason ? ` ｜ 回退原因：${fallbackReason}` : ""}\n\n## 媒体信息\n- 验证状态：${mediaValidation === "ok" ? "可播放（ftyp+moov+mdat+duration 通过）" : mediaValidation}\n- 时长：${media?.duration_ms ? (media.duration_ms / 1000).toFixed(1) + "s" : "null"}\n- 分辨率：${media?.width && media?.height ? `${media.width}×${media.height}` : "null"}\n- 编码：${media?.codec_video || "null"} / ${media?.codec_audio || "null"}\n- SHA256：${sha256 ? sha256.slice(0, 16) + "…" : "null"}\n${enriched?.media?.author ? `- 平台作者：${enriched.media.author}\n` : ""}${enriched?.media?.title ? `- 平台标题：${enriched.media.title}\n` : ""}\n\n## 内容分析（规则推断 · 低置信）\nASR/OCR/镜头切分当前接口不可用，接入后可重跑。\n\n## 病毒性（证据型假设 · 非因果）\n无参与度基准/留存/流量来源 → 仅「潜在传播因素」假设。\n\n---\n_由织台知识库管线生成（id: ${assetId}）_\n`;

  const writes = [
    ["metadata.json", JSON.stringify(metadata, null, 2)],
    ["analysis.md", analysisMd],
    ["transcript.json", JSON.stringify(unavailable("transcript", "asr_not_configured"), null, 2)],
    ["ocr.json", JSON.stringify(unavailable("ocr", "ocr_not_configured"), null, 2)],
    ["shots.json", JSON.stringify({ status: "unavailable", reason: "shot_analysis_not_configured", segments: [] }, null, 2)],
    ["source.url", `${sourceUrl || ""}\n`],
  ];
  for (const [name, content] of writes) {
    const tmp = join(pkgDir, `.${name}.tmp`);
    await writeFile(tmp, content);
    await rename(tmp, join(pkgDir, name));
  }
}

function sha256Text(s) {
  return createHash("sha256").update(String(s)).digest("hex");
}


/* ─────────── 深度内容分析（可重复 upsert；不覆盖 available transcript/ocr） ─────────── */
export async function runContentAnalysis(db, assetId, { title, media }) {
  const now = new Date().toISOString();
  const t = String(title || "");
  const duration = media?.duration_ms;
  const durSec = duration ? Math.round(duration / 1000) : null;

  const structure = {
    hasNumber: /[0-9]{2,}/.test(t),
    hasBeforeAfter: /(改造|前后|对比|2居改3居|旧房)/.test(t),
    hasSaving: /(省钱|不花冤枉钱|超多收纳|技巧|方法)/.test(t),
    hasList: /(清单|步骤|攻略|教程)/.test(t),
  };
  const audience = [];
  if (/(装修|改造|户型|收纳|卧室|儿童房)/.test(t)) audience.push("装修需求用户（尤其小户型/旧房业主）");
  if (/(适老化|老人|父母)/.test(t)) audience.push("适老化改造关注者");
  if (/(AI|大模型|DeepSeek|技能)/.test(t)) audience.push("AI 工具学习者");
  if (!audience.length) audience.push("泛内容消费者");
  const cta = /(关注|点赞|收藏|转发|评论区|私信|找我|看主页)/.test(t) ? "标题/描述含行动号召词" : "未见明确 CTA（需看视频内容确认）";
  const reusable = [];
  if (structure.hasBeforeAfter) reusable.push("「改造前后对比」叙事模板");
  if (structure.hasSaving) reusable.push("「省钱/实用干货」结构");
  if (/#[^#]+#/.test(t)) reusable.push("话题标签结构");
  const hook = durSec && durSec <= 30 ? "短视频（≤30s）需 0-3s 强钩子" : durSec ? "中长视频，钩子后可展开结构" : "时长未知";

  db.prepare(
    `INSERT OR REPLACE INTO content_analysis (asset_id, summary, key_points, hook_3s, structure, cta, audience, editing_rhythm, reusable_pattern, confidence, source, limitation, analyzed_at)
     VALUES (?,?,?,?,?,?,?,?,?,'low','rule_inference',?,?)`,
  ).run(
    assetId,
    `基于标题/描述的推断摘要：${t.slice(0, 60) || "（无标题信息）"}`,
    JSON.stringify([`时长 ${durSec ?? "未知"} 秒`, structure.hasBeforeAfter ? "含改造/对比主题线索" : "未见改造对比主题线索", /#[^#]+#/.test(t) ? "带话题标签" : "无话题标签"]),
    hook, JSON.stringify(structure), cta, JSON.stringify(audience), "未知（需看视频内容）",
    JSON.stringify(reusable),
    "规则引擎基于标题/描述/时长推断，未分析视频画面与音频内容；ASR/OCR/镜头分析当前接口不可用",
    now,
  );

  const hyp = [];
  db.prepare(
    "INSERT OR REPLACE INTO virality_analysis (asset_id, verdict_label, hypotheses, is_causal, note, analyzed_at) VALUES (?,?,?,0,?,?)",
  ).run(
    assetId,
    hyp.length ? "potential_distribution_factors" : "unavailable",
    JSON.stringify(hyp),
    "无参与度基准、留存、流量来源数据 → 仅列「潜在传播因素」假设，不构成因果结论",
    now,
  );

  // transcript/ocr：不覆盖已 available 的结果（真实 ASR/OCR 接入后重跑不会被抹掉）
  const unavailNote = "接口不可用：元宝对话需 live-browser 签名，本地无 ffmpeg/whisper；接入后可重跑";
  const tr = db.prepare("SELECT status FROM transcript WHERE asset_id = ?").get(assetId);
  if (!tr || tr.status !== "available") {
    db.prepare("INSERT OR REPLACE INTO transcript (asset_id, status, language, text, segments, provider, note, captured_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(assetId, "unavailable", null, null, null, "unavailable", unavailNote, now);
  }
  const oc = db.prepare("SELECT status FROM ocr WHERE asset_id = ?").get(assetId);
  if (!oc || oc.status !== "available") {
    db.prepare("INSERT OR REPLACE INTO ocr (asset_id, status, items, provider, note, captured_at) VALUES (?,?,?,?,?,?)")
      .run(assetId, "unavailable", null, "unavailable", unavailNote, now);
  }
}

/** 镜头切分真实结果幂等 upsert（UNIQUE(asset_id, idx)）；available 后重跑只更新，不删除 */
export function upsertShots(db, assetId, shots) {
  if (!Array.isArray(shots) || !shots.length) return 0;
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO shot (asset_id, idx, start_ms, end_ms, shot_size, camera_angle, camera_movement, scene, composition, notes, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  );
  let n = 0;
  for (const s of shots) {
    if (s.idx == null) continue;
    stmt.run(assetId, s.idx, s.start_ms ?? null, s.end_ms ?? null, s.shot_size ?? null, s.camera_angle ?? null, s.camera_movement ?? null, s.scene ?? null, s.composition ?? null, s.notes ?? null, s.source || "analysis");
    n++;
  }
  return n;
}

function analysisTimeMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, Math.round(value * 1000));
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parts = raw.split(":").map(Number);
  if (!parts.length || parts.some((n) => !Number.isFinite(n))) return null;
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + part;
  return Math.max(0, Math.round(seconds * 1000));
}

function srtTime(milliseconds) {
  const value = Math.max(0, Math.round(Number(milliseconds) || 0));
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1000);
  const millis = value % 1000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")},${String(millis).padStart(3, "0")}`;
}

function buildSrt(transcript, durationSeconds) {
  return transcript.map((item, index) => {
    const start = analysisTimeMs(item?.start ?? item?.time) ?? 0;
    const next = analysisTimeMs(transcript[index + 1]?.start ?? transcript[index + 1]?.time);
    const explicitEnd = analysisTimeMs(item?.end);
    const durationEnd = Number.isFinite(durationSeconds) ? Math.round(durationSeconds * 1000) : start + 3000;
    const end = Math.max(start + 200, explicitEnd ?? (next == null ? durationEnd : next - 1));
    const speaker = item?.speaker ? `[${String(item.speaker)}] ` : "";
    return `${index + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${speaker}${String(item?.text || "").trim()}`;
  }).filter((block) => !block.endsWith("\n")).join("\n\n");
}

function csvCell(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

async function writeAnalysisPackage(asset, files) {
  if (!asset?.package_path) return;
  for (const [name, value] of files) {
    const tmp = join(asset.package_path, `.${name}.tmp-${Math.random().toString(16).slice(2, 8)}`);
    await writeFile(tmp, typeof value === "string" ? value : JSON.stringify(value, null, 2));
    await rename(tmp, join(asset.package_path, name));
  }
}

/** 把分析器临时目录中的关键帧复制进内容包，避免系统清理临时目录后历史分析丢图。 */
async function persistAnalysisFrames(asset, frames) {
  if (!asset?.package_path) return [];
  const targetDir = join(asset.package_path, "analysis-frames");
  const stagingDir = join(asset.package_path, `.analysis-frames.tmp-${randomUUID()}`);
  await mkdir(stagingDir, { recursive: true });
  const saved = [];
  try {
    for (const [index, frame] of frames.entries()) {
      const sourcePath = typeof frame?.filePath === "string" ? frame.filePath : "";
      if (!sourcePath) continue;
      let sourceStat;
      try { sourceStat = await stat(sourcePath); } catch { continue; }
      if (!sourceStat.isFile() || sourceStat.size < 1) continue;
      const sourceExt = String(sourcePath).toLowerCase().match(/\.(?:jpe?g|png|webp)$/)?.[0] || ".jpg";
      const fileName = `frame-${String(index + 1).padStart(3, "0")}${sourceExt}`;
      await copyFile(sourcePath, join(stagingDir, fileName));
      saved.push({
        index: index + 1,
        time: frame?.time ?? null,
        fileName,
        relativePath: `analysis-frames/${fileName}`,
      });
    }
    await rm(targetDir, { recursive: true, force: true });
    await rename(stagingDir, targetDir);
    return saved;
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

/** 把 Demucs 生成的压缩 stem 写入内容包，便于复刻时直接试听和使用。 */
async function persistAnalysisAudio(asset, audioAnalysis) {
  if (!asset?.package_path || audioAnalysis?.status !== "available") return [];
  const sourceFiles = audioAnalysis?.stemFiles && typeof audioAnalysis.stemFiles === "object" ? audioAnalysis.stemFiles : {};
  const targetDir = join(asset.package_path, "analysis-audio");
  const stagingDir = join(asset.package_path, `.analysis-audio.tmp-${randomUUID()}`);
  await mkdir(stagingDir, { recursive: true });
  const saved = [];
  try {
    for (const [kind, fileName] of [["voice", "voice.m4a"], ["accompaniment", "accompaniment.m4a"]]) {
      const sourcePath = typeof sourceFiles[kind] === "string" ? sourceFiles[kind] : "";
      if (!sourcePath) continue;
      let sourceStat;
      try { sourceStat = await stat(sourcePath); } catch { continue; }
      if (!sourceStat.isFile() || sourceStat.size < 1) continue;
      await copyFile(sourcePath, join(stagingDir, fileName));
      saved.push({ kind, fileName, relativePath: `analysis-audio/${fileName}`, sizeBytes: sourceStat.size });
    }
    await rm(targetDir, { recursive: true, force: true });
    await rename(stagingDir, targetDir);
    return saved;
  } catch (error) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function mergeExternalInsightIntoPlan(inputPlan, externalInsight) {
  const plan = inputPlan && typeof inputPlan === "object" ? { ...inputPlan } : {};
  if (!externalInsight?.prompt) return plan;
  plan.externalVideoInsight = externalInsight;
  plan.reverseBlueprint = {
    ...(plan.reverseBlueprint && typeof plan.reverseBlueprint === "object" ? plan.reverseBlueprint : {}),
    externalEnhancedPrompt: externalInsight.prompt,
    externalEnhancedProvider: externalInsight.provider,
  };
  const externalMarker = "【外站关键帧增强】";
  const mergeExternal = (value) => {
    const base = String(value || "").split(`\n\n${externalMarker}`)[0].trim();
    return `${base}\n\n${externalMarker}\n以下内容只补充关键帧中可见的主体、空间、材质、灯光与色彩；运镜、对白和节奏仍以织台本地光流/ASR证据为准：\n${externalInsight.prompt}`.trim();
  };
  if (plan.seedanceWorkflow && Array.isArray(plan.seedanceWorkflow.shots)) {
    plan.seedanceWorkflow = {
      ...plan.seedanceWorkflow,
      shots: plan.seedanceWorkflow.shots.map((shot) => ({
        ...shot,
        externalVisualPrompt: externalInsight.prompt,
        gptImagePrompt: mergeExternal(shot?.gptImagePrompt),
        seedancePrompt: mergeExternal(shot?.seedancePrompt),
        referenceVideoPrompt: mergeExternal(shot?.referenceVideoPrompt),
      })),
    };
  }
  return plan;
}

/** 持久化 mcp-video-analyzer 的真实结果与复刻方案；所有缺失能力明确 unavailable，不补造镜头角度/BGM。 */
export async function persistMediaAnalysis(db, assetId, result, remakePlan = null) {
  const asset = db.prepare("SELECT * FROM video_asset WHERE id = ?").get(assetId);
  if (!asset) return { ok: false, error: "not_found" };
  const now = new Date().toISOString();
  const transcript = Array.isArray(result?.transcript) ? result.transcript : [];
  const ocrItems = Array.isArray(result?.ocrResults) ? result.ocrResults : [];
  const usableOcrItems = ocrItems.filter((item) => {
    const text = String(item?.text || item?.ocrText || "").trim();
    const confidence = Number(item?.confidence);
    if (!text || (Number.isFinite(confidence) && confidence < 65)) return false;
    const meaningful = (text.match(/[\p{L}\p{N}\u3400-\u9fff]/gu) || []).length;
    return meaningful >= 2 && meaningful / Math.max(1, text.length) >= 0.25;
  });
  const frames = Array.isArray(result?.frames) ? result.frames : [];
  const visionFrames = Array.isArray(result?.visionFrames) ? result.visionFrames : [];
  const warnings = Array.isArray(result?.warnings) ? result.warnings.map(String) : [];
  const wordTranscript = Array.isArray(result?.wordTranscript) ? result.wordTranscript : [];
  const transcriptProvider = String(result?.transcriptProvider || "mcp-video-analyzer");
  const audioAnalysis = result?.audioAnalysis && typeof result.audioAnalysis === "object" ? result.audioAnalysis : null;
  const transcriptText = transcript.map((item) => String(item?.text || "").trim()).filter(Boolean).join("\n");
  let plan = remakePlan && typeof remakePlan === "object" ? { ...remakePlan } : null;
  if (plan && !plan.externalVideoInsight) {
    const existingPlanRow = db.prepare("SELECT plan_json FROM remake_plan WHERE asset_id=?").get(assetId);
    try {
      const existingPlan = existingPlanRow?.plan_json ? JSON.parse(existingPlanRow.plan_json) : null;
      if (existingPlan?.externalVideoInsight) plan = mergeExternalInsightIntoPlan(plan, existingPlan.externalVideoInsight);
    } catch { /* 旧计划损坏不阻断新的本地分析 */ }
  }
  const unavailableItems = Array.isArray(plan?.unavailable) ? plan.unavailable : [];
  const savedFrames = await persistAnalysisFrames(asset, frames);
  const savedAudio = await persistAnalysisAudio(asset, audioAnalysis);
  const safeAudioAnalysis = audioAnalysis ? {
    status: audioAnalysis.status,
    provider: audioAnalysis.provider,
    voice: audioAnalysis.voice ?? null,
    background: audioAnalysis.background ?? null,
    bgmIdentification: audioAnalysis.bgmIdentification ?? null,
    note: audioAnalysis.note ?? null,
    items: savedAudio,
  } : { status: "unavailable", provider: "Demucs", items: [] };

  db.prepare("INSERT OR REPLACE INTO transcript (asset_id, status, language, text, segments, provider, note, captured_at) VALUES (?,?,?,?,?,?,?,?)")
    .run(assetId, transcript.length ? "available" : "unavailable", null, transcriptText || null,
      JSON.stringify(transcript), transcriptProvider, transcript.length ? (result?.whisperX?.note || null) : (warnings.join("；") || "视频无可用转写"), now);
  db.prepare("INSERT OR REPLACE INTO ocr (asset_id, status, items, provider, note, captured_at) VALUES (?,?,?,?,?,?)")
    .run(assetId, ocrItems.length ? "available" : "unavailable", JSON.stringify(ocrItems),
      "mcp-video-analyzer", ocrItems.length ? null : "关键帧未识别到可用文字", now);

  db.prepare("DELETE FROM shot WHERE asset_id=? AND source IN ('mcp-video-analyzer','PySceneDetect')").run(assetId);
  const detectedPlanShots = Number(plan?.observed?.sceneCount || 0) > 0 && Array.isArray(plan?.shotPlan) ? plan.shotPlan : [];
  const normalizedShots = detectedPlanShots.length ? detectedPlanShots.map((shot, index) => ({
    idx: index,
    start_ms: analysisTimeMs(shot?.startSeconds),
    end_ms: analysisTimeMs(shot?.endSeconds),
    shot_size: shot?.shotSize ?? null,
    camera_angle: shot?.cameraAngle ?? null,
    camera_movement: shot?.cameraMovement ?? null,
    scene: shot?.narration || shot?.onScreenText || null,
    composition: shot?.composition ?? null,
    notes: shot?.evidence || "PySceneDetect 切镜边界；镜头语义待补充",
    source: "PySceneDetect",
  })) : frames.map((frame, index) => {
    const start = analysisTimeMs(frame?.time);
    const next = analysisTimeMs(frames[index + 1]?.time);
    const matchedOcr = usableOcrItems.find((item) => String(item?.time || "") === String(frame?.time || ""));
    const vision = visionFrames.find((item) => String(item?.path || "") === String(frame?.filePath || ""));
    return {
      idx: index,
      start_ms: start,
      end_ms: next == null ? null : Math.max(start ?? 0, next - 1),
      shot_size: vision?.shotSize ?? null,
      camera_angle: vision?.cameraAngle ?? null,
      camera_movement: vision?.cameraMovement ?? null,
      scene: matchedOcr?.text || matchedOcr?.ocrText || null,
      composition: Array.isArray(vision?.faces) && vision.faces.length ? "face_placement_detected" : null,
      notes: vision?.status === "available" ? `Apple Vision：${JSON.stringify(vision?.sceneLabels || []).slice(0, 300)}；单帧无法可靠判断运镜` : "自动关键帧；景别、机位、运镜尚未确认",
      source: "mcp-video-analyzer",
    };
  });
  upsertShots(db, assetId, normalizedShots);

  const observedText = transcriptText || usableOcrItems.map((item) => String(item?.text || item?.ocrText || "").trim()).filter(Boolean).join("；");
  const keyPoints = observedText.split(/[。！？!?\n；]/).map((s) => s.trim()).filter(Boolean).slice(0, 6);
  const duration = Number(result?.metadata?.duration || 0) || (asset.duration_ms ? asset.duration_ms / 1000 : null);
  const hook3s = plan?.copywriting?.hook3s || keyPoints[0] || "前三秒内容未取得，需人工确认";
  const reusable = Array.isArray(plan?.reusableElements) ? plan.reusableElements : [];
  const confidence = transcript.length || usableOcrItems.length ? "medium" : "low";
  db.prepare(
    `INSERT OR REPLACE INTO content_analysis (asset_id, summary, key_points, hook_3s, structure, cta, audience, editing_rhythm, reusable_pattern, confidence, source, limitation, analyzed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(
    assetId,
    observedText ? observedText.slice(0, 500) : `已分析视频技术信息，但未取得可用语音或画面文字：${asset.title || assetId}`,
    JSON.stringify(keyPoints), hook3s,
    JSON.stringify(plan?.structure || { durationSeconds: duration, keyframeCount: frames.length }),
    plan?.copywriting?.cta || "未观察到明确 CTA",
    JSON.stringify(plan?.audience || []),
    detectedPlanShots.length
      ? `PySceneDetect 检测 ${detectedPlanShots.length} 个真实镜头；另提取 ${frames.length} 个关键帧`
      : `提取 ${frames.length} 个去重关键帧；关键帧不等同完整镜头切分`,
    JSON.stringify(reusable), confidence, "zhitai-multimodal-analysis",
    unavailableItems.length
      ? `仍未取得：${unavailableItems.join("；")}`
      : "已取得媒体、关键帧、OCR/ASR、视觉语义与运镜结果；所有推断仍需结合证据和置信度使用",
    now,
  );

  const hypotheses = Array.isArray(plan?.propagationHypotheses) ? plan.propagationHypotheses : [];
  db.prepare("INSERT OR REPLACE INTO virality_analysis (asset_id, verdict_label, hypotheses, is_causal, note, analyzed_at) VALUES (?,?,?,0,?,?)")
    .run(assetId, hypotheses.length ? "content_potential_inferred" : "unavailable", JSON.stringify(hypotheses),
      "仅为内容潜力推测；没有播放量、留存、流量来源时不得写成爆火原因", now);
  if (plan) {
    db.prepare("INSERT OR REPLACE INTO remake_plan (asset_id, plan_json, provider, created_at) VALUES (?,?,?,?)")
      .run(assetId, JSON.stringify(plan), "zhitai-v1", now);
  }

  db.prepare("DELETE FROM knowledge_chunk WHERE asset_id=? AND kind IN ('transcript','ocr')").run(assetId);
  const chunk = db.prepare("INSERT INTO knowledge_chunk (asset_id, kind, start_ms, end_ms, content, tags, created_at) VALUES (?,?,?,?,?,?,?)");
  for (const item of transcript) chunk.run(assetId, "transcript", analysisTimeMs(item?.time), null, String(item?.text || ""), "[]", now);
  for (const item of ocrItems) chunk.run(assetId, "ocr", analysisTimeMs(item?.time), null, String(item?.text || item?.ocrText || ""), "[]", now);

  const analysisMd = `# 内容分析 · ${asset.title || assetId}\n\n## 已观察\n- 时长：${duration ?? "未取得"} 秒\n- 分辨率：${result?.metadata?.width || asset.width || "?"}×${result?.metadata?.height || asset.height || "?"}\n- 关键帧：${frames.length}\n- 转写片段：${transcript.length}\n- 逐词时间码：${wordTranscript.length}\n- OCR 片段：${ocrItems.length}\n- 视觉语义：${result?.visualSemantics?.status === "available" ? result.visualSemantics.provider : "不可用"}\n- 运镜分析：${result?.cameraMotion?.status === "available" ? result.cameraMotion.provider : "不可用"}\n- 音频分离：${audioAnalysis?.status === "available" ? audioAnalysis.provider : "不可用"}\n\n## 内容摘要\n${observedText || "没有取得可用语音或画面文字。"}\n\n## 仍未取得\n${unavailableItems.length ? unavailableItems.map((item) => `- ${item}`).join("\n") : "- 无"}\n\n所有模型推断均保留证据和置信度；不得把推测写成观察事实。\n`;
  const planShots = Array.isArray(plan?.shotPlan) ? plan.shotPlan : [];
  const seedanceWorkflow = plan?.seedanceWorkflow && typeof plan.seedanceWorkflow === "object" ? plan.seedanceWorkflow : { status: "unavailable", shots: [] };
  const seedanceShots = Array.isArray(seedanceWorkflow?.shots) ? seedanceWorkflow.shots : [];
  const gptPromptsMd = `# GPT 分镜图提示词 · ${asset.title || assetId}\n\n目标：先逐镜生成一致的 9:16 首帧参考图，再交给豆包 Seedance 2.0。\n\n${seedanceShots.length ? seedanceShots.map((shot) => `## 分镜 ${shot.index} · ${shot.role} · ${shot.durationSeconds} 秒\n\n${shot.gptImagePrompt}\n`).join("\n") : "尚未生成工作流，请在织台重新分析该视频。\n"}`;
  const seedancePromptsMd = `# 豆包 Seedance 2.0 提示词 · ${asset.title || assetId}\n\n豆包每镜统一生成 10 秒；织台逐镜验收并裁取稳定片段，再拼成 ${seedanceWorkflow?.targetDurationSeconds || "按素材计算"} 秒成片。\n\n${seedanceShots.length ? seedanceShots.map((shot) => `## 分镜 ${shot.index} · ${shot.role}\n\n配图：使用 GPT 生成的第 ${shot.index} 张首帧图，作为 @图片1。\n\n${shot.seedancePrompt}\n\n负面约束：${shot.negativePrompt}\n`).join("\n") : "尚未生成工作流，请在织台重新分析该视频。\n"}`;
  const reproductionMd = `# 复刻内容包 · ${asset.title || assetId}\n\n## 主制作流程\nGPT 分镜图 → 豆包 Seedance 2.0 逐镜生成 → 配音/字幕/音乐统一后期 → 人工质检。MoneyPrinterTurbo 只保留为技术冒烟与备用草稿，不再作为可发布成片。\n\n## 目标成片规格\n- 目标时长：${seedanceWorkflow?.targetDurationSeconds ?? 30} 秒（原片 ${plan?.observed?.durationSeconds ?? "未取得"} 秒）\n- 目标画幅：${seedanceWorkflow?.aspectRatio || "9:16"}\n- 生成镜头：${seedanceWorkflow?.shotCount ?? seedanceShots.length ?? "未取得"} 个；每镜 ${Array.isArray(seedanceWorkflow?.shotDurationRangeSeconds) ? seedanceWorkflow.shotDurationRangeSeconds.join("–") : "4–8"} 秒\n- 原片分辨率：${plan?.observed?.width ?? "?"}×${plan?.observed?.height ?? "?"}\n- 原片帧率：${plan?.observed?.fps ?? "未取得"}\n- 真实切镜：${plan?.observed?.sceneCount ?? "未取得"}\n\n## 前三秒钩子\n${plan?.copywriting?.hook3s || "未取得，需人工确认"}\n\n## 配音/字幕稿\n${plan?.copywriting?.voiceoverDraft || plan?.copywriting?.subtitleDraft || "未取得可用转写"}\n\n## Seedance 制作分镜\n${seedanceShots.length ? seedanceShots.map((shot) => `${shot.index}. ${shot.role}｜${shot.durationSeconds} 秒｜原片参考 ${shot.sourceStartSeconds ?? "?"}s–${shot.sourceEndSeconds ?? "?"}s\n   配音：${shot.narration || "待确认"}\n   GPT 与 Seedance 完整提示词见 gpt-image-prompts.md / seedance-prompts.md`).join("\n") : "尚未生成；请在织台重新分析视频"}\n\n## 原片观察分镜\n${planShots.length ? planShots.map((shot, index) => `${index + 1}. ${shot.startSeconds ?? "?"}s–${shot.endSeconds ?? "?"}s｜景别 ${shot.shotSize || "未确认"}｜机位 ${shot.cameraAngle || "未确认"}｜运镜 ${shot.cameraMovement || "未确认"}｜构图 ${shot.composition || "未确认"}｜光线 ${shot.lighting || "未确认"}｜${shot.narration || shot.onScreenText || "画面语义待确认"}\n   证据：${shot.evidence || "未提供"}`).join("\n") : "未提取到分镜"}\n\n## 音频\n- 配音风格：${plan?.audioPlan?.voiceStyle || "未确认"}\n- 语速：${plan?.audioPlan?.pace || "未取得"}${plan?.audioPlan?.charactersPerMinute ? `（约 ${plan.audioPlan.charactersPerMinute} 字/分钟）` : ""}\n- BGM：${plan?.audioPlan?.bgm || "未确认"}\n- 伴奏节奏：${plan?.audioPlan?.bgmTempoBpm ? `${plan.audioPlan.bgmTempoBpm} BPM` : "未取得"}\n- 说明：${plan?.audioPlan?.note || "无"}\n\n## 传播因素（推测，非因果）\n${Array.isArray(plan?.propagationHypotheses) && plan.propagationHypotheses.length ? plan.propagationHypotheses.map((item) => `- ${item}`).join("\n") : "- 数据不足，暂不推测"}\n\n## 仍需人工确认\n${Array.isArray(plan?.unavailable) && plan.unavailable.length ? plan.unavailable.map((item) => `- ${item}`).join("\n") : "- 无"}\n`;
  const subtitlesSrt = buildSrt(transcript, duration);
  const shotListCsv = [
    ["序号", "开始秒", "结束秒", "景别", "机位", "运镜", "构图", "光线", "主体/场景", "配音/画面", "证据", "置信度"].map(csvCell).join(","),
    ...planShots.map((shot, index) => [
      index + 1,
      shot.startSeconds,
      shot.endSeconds,
      shot.shotSize,
      shot.cameraAngle,
      shot.cameraMovement,
      shot.composition,
      shot.lighting,
      [shot.subject, shot.setting].filter(Boolean).join(" / "),
      shot.narration || shot.onScreenText,
      shot.evidence,
      shot.confidence,
    ].map(csvCell).join(",")),
  ].join("\n");
  await writeAnalysisPackage(asset, [
    ["transcript.json", { status: transcript.length ? "available" : "unavailable", provider: transcriptProvider, alignment: result?.whisperX?.alignment || "segment", diarization: result?.whisperX?.diarization || "unavailable", segments: transcript, words: wordTranscript, warnings }],
    ["transcript-words.json", { status: wordTranscript.length ? "available" : "unavailable", provider: transcriptProvider, words: wordTranscript }],
    ["ocr.json", { status: ocrItems.length ? "available" : "unavailable", provider: "mcp-video-analyzer", items: ocrItems }],
    ["frames.json", { status: savedFrames.length ? "available" : "unavailable", provider: "mcp-video-analyzer", items: savedFrames }],
    ["audio.json", safeAudioAnalysis],
    ["visual-analysis.json", result?.visualSemantics || { status: "unavailable", provider: "Qwen2.5-VL" }],
    ["camera-motion.json", result?.cameraMotion || { status: "unavailable", provider: "OpenCV global optical flow" }],
    ["shots.json", { status: normalizedShots.length ? (detectedPlanShots.length ? "available" : "partial") : "unavailable", provider: detectedPlanShots.length ? "PySceneDetect" : "mcp-video-analyzer", segments: normalizedShots }],
    ["analysis.md", analysisMd],
    ["reproduction.json", plan || { status: "unavailable" }],
    ["reproduction.md", reproductionMd],
    ["seedance-workflow.json", seedanceWorkflow],
    ["gpt-image-prompts.md", gptPromptsMd],
    ["seedance-prompts.md", seedancePromptsMd],
    ["subtitles.srt", subtitlesSrt],
    ["voiceover.txt", plan?.copywriting?.voiceoverDraft || transcriptText || ""],
    ["shot-list.csv", shotListCsv],
  ]);
  return {
    ok: true,
    assetId,
    transcript: transcript.length,
    words: wordTranscript.length,
    ocr: ocrItems.length,
    frames: savedFrames.map((frame) => ({
      index: frame.index,
      time: frame.time,
      fileName: frame.fileName,
      mediaUrl: `/api/v1/kb/videos/${encodeURIComponent(assetId)}/analysis-frames/${encodeURIComponent(frame.fileName)}`,
    })),
    audio: savedAudio.map((item) => ({
      kind: item.kind,
      fileName: item.fileName,
      sizeBytes: item.sizeBytes,
      mediaUrl: `/api/v1/kb/videos/${encodeURIComponent(assetId)}/analysis-audio/${encodeURIComponent(item.fileName)}`,
    })),
    shots: normalizedShots.length,
    remake: Boolean(plan),
    analyzedAt: now,
  };
}

/** 把用户明确触发的外站关键帧反推结果并入既有复刻计划，并落盘到内容包。 */
export async function persistExternalVideoPrompt(db, assetId, input = {}) {
  const asset = db.prepare("SELECT * FROM video_asset WHERE id=?").get(assetId);
  if (!asset) return { ok: false, status: 404, error: "not_found" };
  const prompt = String(input?.prompt || "").trim();
  if (!prompt) return { ok: false, status: 400, error: "external_prompt_required" };
  const row = db.prepare("SELECT plan_json FROM remake_plan WHERE asset_id=?").get(assetId);
  let plan = {};
  try { plan = row?.plan_json ? JSON.parse(row.plan_json) : {}; } catch { plan = {}; }
  const externalInsight = {
    provider: String(input?.provider || "VideoToPrompt").slice(0, 80),
    mode: String(input?.mode || "explicit_public_keyframes").slice(0, 80),
    endpoint: String(input?.endpoint || "https://videotoprompt.com/").slice(0, 300),
    frameCount: Math.max(1, Math.min(5, Number(input?.frameCount) || 1)),
    prompt: prompt.slice(0, 20_000),
    limitation: String(input?.limitation || "外站结果需与本地证据合并").slice(0, 1000),
    analyzedAt: String(input?.analyzedAt || new Date().toISOString()),
  };
  plan = mergeExternalInsightIntoPlan(plan, externalInsight);
  const now = new Date().toISOString();
  db.prepare("INSERT OR REPLACE INTO remake_plan (asset_id, plan_json, provider, created_at) VALUES (?,?,?,?)")
    .run(assetId, JSON.stringify(plan), "zhitai-v1+external", now);
  await writeAnalysisPackage(asset, [
    ["external-video-prompt.json", externalInsight],
    ["external-video-prompt.md", `# 外站视频反推提示词 · ${asset.title || assetId}\n\n来源：${externalInsight.provider}（用户明确触发，发送 ${externalInsight.frameCount} 张公开视频关键帧）\n\n${externalInsight.prompt}\n\n## 限制\n${externalInsight.limitation}\n`],
    ["reproduction.json", plan],
    ["seedance-workflow.json", plan.seedanceWorkflow || { status: "unavailable", shots: [] }],
    ["gpt-image-prompts.md", `# GPT 分镜图提示词 · ${asset.title || assetId}\n\n${Array.isArray(plan?.seedanceWorkflow?.shots) ? plan.seedanceWorkflow.shots.map((shot) => `## 分镜 ${shot.index}\n\n${shot.gptImagePrompt || "待生成"}\n`).join("\n") : "待生成\n"}`],
    ["seedance-prompts.md", `# 豆包 Seedance 提示词 · ${asset.title || assetId}\n\n${Array.isArray(plan?.seedanceWorkflow?.shots) ? plan.seedanceWorkflow.shots.map((shot) => `## 分镜 ${shot.index}\n\n${shot.seedancePrompt || "待生成"}\n\n### 参考视频模式\n${shot.referenceVideoPrompt || "待生成"}\n`).join("\n") : "待生成\n"}`],
  ]);
  return { ok: true, assetId, externalInsight };
}

/* ─────────── 字段溯源（可重复 upsert） ─────────── */
async function writeProvenance(db, assetId, media, platformInserted, sourceUrl, mediaValidation, channel) {
  const now = new Date().toISOString();
  const rows = [
    ["sha256", "local_media", media.sha256 ? 1 : 0, "high", "crypto sha256"],
    ["duration_ms", "local_media", media.duration_ms != null ? 1 : 0, "high", mediaValidation === "ok" ? "容器 mvhd / ffprobe" : "结构无效 → null"],
    ["width", "local_media", media.width != null ? 1 : 0, "high", "ffprobe/mdls"],
    ["height", "local_media", media.height != null ? 1 : 0, "high", "ffprobe/mdls"],
    ["codec", "local_media", media.codec_video ? 1 : 0, "high", "ffprobe/mdls"],
    ["media_validation", "local_media", 1, "high", `容器验证：${mediaValidation}（ftyp+moov+mdat+duration）`],
    ["channel", "downloader_adapter", 1, "high", channel || "unknown"],
    ["author", "yuanbao_enrich", platformInserted ? 1 : 0, "high", "get_parse_result / get_feed_info（无则 null）"],
    ["publish_time", "yuanbao_enrich", platformInserted ? 1 : 0, "high", "get_feed_info createtime（无则 null）"],
    ["title", "yuanbao_enrich", platformInserted ? 1 : 0, "high", "get_feed_info description（无则 null）"],
    ["likes", "yuanbao_enrich", platformInserted ? 1 : 0, "high", "归一化；缺失 → null 绝非 0"],
    ["favorites", "yuanbao_enrich", platformInserted ? 1 : 0, "high", "归一化；缺失 → null"],
    ["comments", "yuanbao_enrich", platformInserted ? 1 : 0, "high", "归一化；缺失 → null"],
    ["shares", "yuanbao_enrich", platformInserted ? 1 : 0, "high", "归一化；缺失 → null"],
    ["plays", "yuanbao_enrich", 0, "low", "接口未返回播放量，不推断 → null"],
    ["transcript", "unavailable", 0, "low", "ASR 未配置 → null"],
    ["ocr", "unavailable", 0, "low", "OCR 未配置 → null"],
    ["shots", "unavailable", 0, "low", "无镜头分析 → null"],
    ["content_analysis", "rule_inference", 1, "low", "标题/描述规则推断"],
  ];
  for (const [field, source, avail, conf, lim] of rows) {
    db.prepare("INSERT OR REPLACE INTO field_provenance (asset_id, field, source, available, confidence, limitation, captured_at) VALUES (?,?,?,?,?,?,?)")
      .run(assetId, field, source, avail, conf, lim, now);
  }
}

/* ─────────── 查询（每资产一行） ─────────── */
function likeValue(s) {
  return `%${String(s).replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function parsePercent(value) {
  if (value === null || value === undefined || value === "") return null;
  const raw = String(value).trim().replace(/%$/, "");
  const number = Number(raw);
  if (!Number.isFinite(number) || number < 0) return null;
  const percent = number <= 1 && !String(value).includes("%") ? number * 100 : number;
  return Math.min(100, Math.round(percent * 100) / 100);
}

function parseRetention(value) {
  let rows = value;
  if (typeof rows === "string") {
    const raw = rows.trim();
    if (!raw) return [];
    try { rows = JSON.parse(raw); }
    catch {
      rows = raw.split(/[\n,，;；]+/).map((part) => {
        const match = part.trim().match(/^(\d+(?:\.\d+)?)\s*(?:s|秒)?\s*[:=：]\s*(\d+(?:\.\d+)?)\s*%?$/i);
        return match ? { second: Number(match[1]), percent: Number(match[2]) } : null;
      }).filter(Boolean);
    }
  }
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 500).map((row) => {
    if (!row || typeof row !== "object") return null;
    const second = finiteNonNegative(row.second ?? row.seconds ?? row.time ?? row.time_seconds);
    const percent = parsePercent(row.percent ?? row.retention ?? row.rate ?? row.retention_percent);
    return second === null || percent === null ? null : { second, percent };
  }).filter(Boolean).sort((a, b) => a.second - b.second);
}

function importedComment(row) {
  if (typeof row === "string") return { content: row.trim(), author: null, externalId: null, likes: null, publishedAt: null };
  if (!row || typeof row !== "object") return null;
  return {
    content: String(row.content ?? row.text ?? row.comment ?? "").trim(),
    author: String(row.author ?? row.nickname ?? "").trim() || null,
    externalId: String(row.id ?? row.commentId ?? "").trim() || null,
    likes: parseFormattedCount(row.likes ?? row.likeCount).value,
    publishedAt: String(row.publishedAt ?? row.createdAt ?? "").trim() || null,
  };
}

/** 导入创作者后台/导出表中的真实表现数据。只接收用户提供的数值与评论，不抓取登录态。 */
export async function importPerformanceEvidence(db, assetId, input = {}) {
  const asset = db.prepare("SELECT id, content_id, package_path, title FROM video_asset WHERE id=?").get(assetId);
  if (!asset) return { ok: false, status: 404, error: "not_found" };
  const latestPost = db.prepare("SELECT content_id FROM platform_post WHERE asset_id=? ORDER BY fetched_at DESC LIMIT 1").get(assetId);
  const capturedAt = Number.isFinite(Date.parse(String(input.capturedAt || "")))
    ? new Date(input.capturedAt).toISOString()
    : new Date().toISOString();
  const source = String(input.source || "creator_dashboard_manual").replace(/[^\p{L}\p{N}_\- .]/gu, "").trim().slice(0, 80) || "creator_dashboard_manual";
  const contentId = String(input.contentId || latestPost?.content_id || asset.content_id || "manual").slice(0, 200);
  const counts = {};
  for (const key of ["plays", "likes", "comments", "favorites", "shares"]) counts[key] = parseFormattedCount(input[key]);
  const avgWatchSeconds = finiteNonNegative(input.avgWatchSeconds);
  const completionRate = parsePercent(input.completionRate);
  const retention = parseRetention(input.retention);
  const trafficSource = String(input.trafficSource || "").trim().slice(0, 500) || null;
  const comments = (Array.isArray(input.commentItems) ? input.commentItems : String(input.commentText || "").split(/\r?\n/))
    .map(importedComment).filter((row) => row?.content).slice(0, 1000);
  const hasMetrics = Object.values(counts).some((item) => item.value !== null)
    || avgWatchSeconds !== null || completionRate !== null || retention.length || trafficSource;
  if (!hasMetrics && !comments.length) return { ok: false, status: 400, error: "performance_data_required" };

  const observationId = `manual:${randomUUID()}`;
  db.exec("BEGIN");
  try {
    if (hasMetrics) {
      db.prepare(`INSERT INTO metric_snapshot
        (asset_id, content_id, captured_at, plays, plays_raw, likes, likes_raw, comments, comments_raw,
         favorites, favorites_raw, shares, shares_raw, avg_watch_seconds, completion_rate, retention_json,
         traffic_source, source, observation_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        assetId, contentId, capturedAt,
        counts.plays.value, counts.plays.raw, counts.likes.value, counts.likes.raw,
        counts.comments.value, counts.comments.raw, counts.favorites.value, counts.favorites.raw,
        counts.shares.value, counts.shares.raw, avgWatchSeconds, completionRate,
        retention.length ? JSON.stringify(retention) : null, trafficSource, source, observationId,
      );
    }
    const insertComment = db.prepare(`INSERT OR IGNORE INTO comment_item
      (asset_id, source, external_id, author, content, likes, published_at, captured_at, fingerprint)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    let insertedComments = 0;
    for (const comment of comments) {
      const content = comment.content.slice(0, 4000);
      const fingerprint = createHash("sha256").update(`${comment.externalId || ""}\n${comment.author || ""}\n${content}`).digest("hex");
      const result = insertComment.run(assetId, source, comment.externalId, comment.author, content, comment.likes, comment.publishedAt, capturedAt, fingerprint);
      insertedComments += Number(result.changes || 0);
    }

    const plays = counts.plays.value;
    const rate = (value) => plays && value !== null ? `${(value / plays * 100).toFixed(2)}%` : null;
    const hypotheses = [];
    if (rate(counts.likes.value)) hypotheses.push(`点赞率 ${rate(counts.likes.value)}（${counts.likes.value}/${plays}）`);
    if (rate(counts.favorites.value)) hypotheses.push(`收藏率 ${rate(counts.favorites.value)}（${counts.favorites.value}/${plays}）`);
    if (rate(counts.comments.value)) hypotheses.push(`评论率 ${rate(counts.comments.value)}（${counts.comments.value}/${plays}）`);
    if (rate(counts.shares.value)) hypotheses.push(`转发率 ${rate(counts.shares.value)}（${counts.shares.value}/${plays}）`);
    if (completionRate !== null) hypotheses.push(`完播率 ${completionRate}%`);
    if (avgWatchSeconds !== null) hypotheses.push(`平均观看 ${avgWatchSeconds} 秒`);
    if (retention.length) hypotheses.push(`已导入 ${retention.length} 个留存时间点`);
    if (comments.length) hypotheses.push(`已导入 ${comments.length} 条评论正文，可用于受众反馈归纳`);
    db.prepare("INSERT OR REPLACE INTO virality_analysis (asset_id, verdict_label, hypotheses, is_causal, note, analyzed_at) VALUES (?,?,?,0,?,?)")
      .run(assetId, plays !== null ? "performance_evidence_available" : "partial_performance_evidence", JSON.stringify(hypotheses),
        `基于 ${source} 的用户导入快照；比率为观察证据，不等于爆火因果`, capturedAt);
    db.exec("COMMIT");

    let packageWarning = null;
    if (asset.package_path) {
      try {
        const payload = { schemaVersion: 1, assetId, source, capturedAt, contentId, counts, avgWatchSeconds, completionRate, retention, trafficSource };
        await writeFile(join(asset.package_path, "performance.json"), JSON.stringify(payload, null, 2));
        const commentRows = db.prepare("SELECT external_id, author, content, likes, published_at, captured_at, source FROM comment_item WHERE asset_id=? ORDER BY id").all(assetId);
        await writeFile(join(asset.package_path, "comments.json"), JSON.stringify({ schemaVersion: 1, assetId, items: commentRows }, null, 2));
      } catch (error) { packageWarning = `内容包同步失败：${String(error?.message || error).slice(0, 160)}`; }
    }
    return { ok: true, assetId, snapshotAdded: hasMetrics, commentsImported: insertedComments, capturedAt, source, packageWarning };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  }
}

/** 把 MoneyPrinterTurbo 的已完成成片收回原内容包；taskId 严格 UUID，来源只能位于托管引擎任务目录。 */
export async function persistRemakeGeneration(db, assetId, input = {}) {
  const asset = db.prepare("SELECT id, package_path FROM video_asset WHERE id=?").get(assetId);
  if (!asset) return { ok: false, status: 404, error: "not_found" };
  if (!asset.package_path) return { ok: false, status: 400, error: "package_path_unavailable" };
  const taskId = String(input.taskId || "").trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(taskId)) {
    return { ok: false, status: 400, error: "invalid_task_id" };
  }
  const engineRoot = resolve(process.env.ZHITAI_MPT_ROOT
    || join(RUNTIME_ROOT, "engines", "MoneyPrinterTurbo"));
  const sourcePath = resolve(engineRoot, "storage", "tasks", taskId, "final-1.mp4");
  if (!sourcePath.startsWith(`${engineRoot}${sep}`)) return { ok: false, status: 400, error: "invalid_generation_path" };
  let sourceStat;
  try { sourceStat = await stat(sourcePath); }
  catch { return { ok: false, status: 404, error: "generated_video_missing" }; }
  if (!sourceStat.isFile() || sourceStat.size < 1024) return { ok: false, status: 400, error: "generated_video_invalid" };
  let media;
  try { media = await probeLocalMedia(sourcePath); }
  catch { return { ok: false, status: 400, error: "generated_video_probe_failed" }; }
  if (media.mediaValidation !== "ok") {
    return { ok: false, status: 400, error: `generated_video_${media.mediaValidation || "invalid"}` };
  }
  const quality = assessMediaQuality({ ...media, media_validation: media.mediaValidation });
  const outputDir = join(asset.package_path, "remake-output");
  await mkdir(outputDir, { recursive: true });
  const fileName = `moneyprinter-${taskId}.mp4`;
  const target = join(outputDir, fileName);
  const staging = `${target}.tmp-${randomUUID()}`;
  await copyFile(sourcePath, staging);
  const buffer = await readFile(staging);
  const sha256 = createHash("sha256").update(buffer).digest("hex");
  await rename(staging, target);
  const now = new Date().toISOString();
  const id = `remake_${taskId}`;
  db.prepare(`INSERT OR REPLACE INTO remake_generation
    (id, asset_id, engine, engine_task_id, status, file_name, size_bytes, sha256, subject, created_at, completed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, assetId, "MoneyPrinterTurbo", taskId, "completed", fileName, sourceStat.size, sha256,
    String(input.subject || "").trim().slice(0, 500) || null, now, now,
  );
  return {
    ok: true,
    id,
    assetId,
    taskId,
    fileName,
    sizeBytes: sourceStat.size,
    sha256,
    quality,
    mediaUrl: `/api/v1/kb/videos/${encodeURIComponent(assetId)}/remake-output/${encodeURIComponent(fileName)}`,
  };
}

/** 把织台 GPT → Seedance 无人值守成片登记回原素材内容包，供预览和 MatrixMedia 发布。 */
export async function persistZhitaiGeneration(db, assetId, input = {}) {
  const asset = db.prepare("SELECT id, package_path FROM video_asset WHERE id=?").get(assetId);
  if (!asset) return { ok: false, status: 404, error: "not_found" };
  if (!asset.package_path) return { ok: false, status: 400, error: "package_path_unavailable" };
  const jobId = String(input.jobId || "").trim();
  const match = jobId.match(/^creative_([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i);
  if (!match) return { ok: false, status: 400, error: "invalid_creative_job_id" };
  const generationRoot = resolve(process.env.ZHITAI_GENERATION_ROOT
    || join(RUNTIME_ROOT, "generation"));
  const sourcePath = resolve(generationRoot, jobId, "final.mp4");
  if (!sourcePath.startsWith(`${generationRoot}${sep}`)) return { ok: false, status: 400, error: "invalid_generation_path" };
  let sourceStat;
  try { sourceStat = await stat(sourcePath); }
  catch { return { ok: false, status: 404, error: "generated_video_missing" }; }
  if (!sourceStat.isFile() || sourceStat.size < 1024) return { ok: false, status: 400, error: "generated_video_invalid" };
  const sourceBuffer = await readFile(sourcePath);
  const sourceSha256 = createHash("sha256").update(sourceBuffer).digest("hex");
  let media;
  try { media = await probeLocalMedia(sourcePath); }
  catch { return { ok: false, status: 400, error: "generated_video_probe_failed" }; }
  if (media.mediaValidation !== "ok") {
    return { ok: false, status: 400, error: `generated_video_${media.mediaValidation || "invalid"}` };
  }
  let audioQuality;
  try { audioQuality = JSON.parse(await readFile(resolve(generationRoot, jobId, "audio-quality.json"), "utf8")); }
  catch { return { ok: false, status: 400, error: "generated_video_audio_quality_missing" }; }
  const audioGate = validateAudioQualityReport(audioQuality, {
    sizeBytes: sourceStat.size,
    sha256: sourceSha256,
    expectedJobId: jobId,
  });
  if (!audioGate.ok) {
    return {
      ok: false,
      status: 400,
      error: audioGate.reason === "integrity"
        ? "generated_video_integrity_failed"
        : "generated_video_audio_quality_failed",
    };
  }
  const quality = assessMediaQuality({ ...media, media_validation: media.mediaValidation });
  const outputDir = join(asset.package_path, "remake-output");
  await mkdir(outputDir, { recursive: true });
  const fileName = `zhitai-${match[1]}.mp4`;
  const target = join(outputDir, fileName);
  const staging = `${target}.tmp-${randomUUID()}`;
  await copyFile(sourcePath, staging);
  const sha256 = sourceSha256;
  await rename(staging, target);
  const now = new Date().toISOString();
  const id = `remake_zhitai_${match[1]}`;
  // 把一键生成真正使用过的 GPT 分镜图、豆包片段、配音/字幕、音频质检和运行记录一起归档，
  // 避免只剩 final.mp4，导致发布时无法追溯这条成片是怎样生成的。
  const artifactDirName = `zhitai-${match[1]}-assets`;
  const artifactDir = join(outputDir, artifactDirName);
  const artifactStaging = `${artifactDir}.tmp-${randomUUID()}`;
  await mkdir(artifactStaging, { recursive: true });
  const archivedArtifacts = [];
  for (const entry of await readdir(join(generationRoot, jobId), { withFileTypes: true })) {
    if (!entry.isFile() || !/^(?:storyboard-\d+\.png|clip-\d+\.mp4|run-state\.json|audio-quality\.json|narration\.mp3|subtitles\.srt)$/i.test(entry.name)) continue;
    await copyFile(join(generationRoot, jobId, entry.name), join(artifactStaging, entry.name));
    archivedArtifacts.push(entry.name);
  }
  await writeFile(join(artifactStaging, "generation-manifest.json"), `${JSON.stringify({
    schemaVersion: 2,
    jobId,
    assetId,
    finalVideo: fileName,
    artifacts: archivedArtifacts,
    promptFiles: ["gpt-image-prompts.md", "seedance-prompts.md", "seedance-workflow.json", "reproduction.json"],
    completedAt: now,
  }, null, 2)}\n`, "utf8");
  await rm(artifactDir, { recursive: true, force: true });
  await rename(artifactStaging, artifactDir);
  db.prepare(`INSERT OR REPLACE INTO remake_generation
    (id, asset_id, engine, engine_task_id, status, file_name, size_bytes, sha256, subject, created_at, completed_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, assetId, "ZhitaiSeedance", jobId, "completed", fileName, sourceStat.size, sha256,
    String(input.subject || "").trim().slice(0, 500) || null, now, now,
  );
  return {
    ok: true, id, assetId, jobId, fileName, sizeBytes: sourceStat.size, sha256,
    quality,
    filePath: target,
    artifactDir: join("remake-output", artifactDirName),
    artifacts: archivedArtifacts,
    mediaUrl: `/api/v1/kb/videos/${encodeURIComponent(assetId)}/remake-output/${encodeURIComponent(fileName)}`,
  };
}

export function queryVideos(db, { q = "", platform = "", category = "", sort = "created_at", limit = 50, offset = 0 } = {}) {
  const where = [];
  const params = {};
  if (q) {
    where.push("(v.title LIKE :q ESCAPE '\\' OR v.source_url LIKE :q ESCAPE '\\' OR EXISTS (SELECT 1 FROM platform_post pp WHERE pp.asset_id=v.id AND pp.title LIKE :q ESCAPE '\\'))");
    params[":q"] = likeValue(q);
  }
  if (category) { where.push("v.category = :cat"); params[":cat"] = String(category); }
  if (platform) {
    where.push("EXISTS (SELECT 1 FROM platform_post pp WHERE pp.asset_id=v.id AND pp.platform = :plat)");
    params[":plat"] = String(platform);
  }
  const w = where.length ? "WHERE " + where.join(" AND ") : "";
  const sortMap = { created_at: "v.created_at", duration: "v.duration_ms", likes: "COALESCE((SELECT likes FROM platform_post WHERE asset_id=v.id ORDER BY fetched_at DESC LIMIT 1), -1)" };
  const order = (sortMap[sort] || "v.created_at") + " DESC";
  const lim = Math.max(1, Math.min(5000, Number(limit) || 50));
  const off = Math.max(0, Number(offset) || 0);

  const total = db.prepare(`SELECT COUNT(*) c FROM video_asset v ${w}`).get(params).c;
  const rows = db.prepare(
    `SELECT v.*,
            (SELECT author FROM platform_post WHERE asset_id=v.id ORDER BY fetched_at DESC LIMIT 1) AS author,
            (SELECT publish_time FROM platform_post WHERE asset_id=v.id ORDER BY fetched_at DESC LIMIT 1) AS publish_time,
            (SELECT cover_url FROM platform_post WHERE asset_id=v.id ORDER BY fetched_at DESC LIMIT 1) AS cover_url,
            COALESCE((SELECT plays FROM metric_snapshot WHERE asset_id=v.id AND plays IS NOT NULL ORDER BY captured_at DESC, id DESC LIMIT 1), (SELECT plays FROM platform_post WHERE asset_id=v.id ORDER BY fetched_at DESC LIMIT 1)) AS plays,
            COALESCE((SELECT likes FROM metric_snapshot WHERE asset_id=v.id AND likes IS NOT NULL ORDER BY captured_at DESC, id DESC LIMIT 1), (SELECT likes FROM platform_post WHERE asset_id=v.id ORDER BY fetched_at DESC LIMIT 1)) AS likes,
            COALESCE((SELECT comments FROM metric_snapshot WHERE asset_id=v.id AND comments IS NOT NULL ORDER BY captured_at DESC, id DESC LIMIT 1), (SELECT comments FROM platform_post WHERE asset_id=v.id ORDER BY fetched_at DESC LIMIT 1)) AS comments,
            COALESCE((SELECT favorites FROM metric_snapshot WHERE asset_id=v.id AND favorites IS NOT NULL ORDER BY captured_at DESC, id DESC LIMIT 1), (SELECT favorites FROM platform_post WHERE asset_id=v.id ORDER BY fetched_at DESC LIMIT 1)) AS favorites,
            COALESCE((SELECT shares FROM metric_snapshot WHERE asset_id=v.id AND shares IS NOT NULL ORDER BY captured_at DESC, id DESC LIMIT 1), (SELECT shares FROM platform_post WHERE asset_id=v.id ORDER BY fetched_at DESC LIMIT 1)) AS shares,
            (SELECT channel FROM download_receipt WHERE asset_id=v.id ORDER BY id DESC LIMIT 1) AS observed_channel,
            ca.confidence AS analysis_confidence, ca.source AS analysis_source,
            va.verdict_label AS virality_label
     FROM video_asset v
     LEFT JOIN content_analysis ca ON ca.asset_id = v.id
     LEFT JOIN virality_analysis va ON va.asset_id = v.id
     ${w} ORDER BY ${order} LIMIT ${lim} OFFSET ${off}`,
  ).all(params);
  const items = rows.map((r) => {
    const metadataSource = metadataSourceOf(db, r.id);
    return {
      id: r.id, legacy_id: r.legacy_id, title: r.title, source_url: r.source_url,
      previewUrl: `/api/v1/kb/videos/${r.id}/media`,
      coverUrl: r.cover_url || null,
      metadata_source: metadataSource,
      category: r.category || "其他",
      duration_ms: r.duration_ms, width: r.width, height: r.height,
      size_bytes: r.size_bytes, created_at: r.created_at, sha256: r.sha256,
      channel: r.channel, observed_channel: r.observed_channel || r.channel,
      content_id: r.content_id, fallback_reason: r.fallback_reason, media_validation: r.media_validation,
      quality: assessMediaQuality(r),
      author: r.author, publish_time: r.publish_time,
      plays: r.plays, likes: r.likes, comments: r.comments, favorites: r.favorites, shares: r.shares,
      analysis: { confidence: r.analysis_confidence, source: r.analysis_source },
      virality: r.virality_label,
    };
  });
  return { total, items };
}

/** 元数据来源：platform_post → yuanbao_enrich；legacy_package → legacy_metadata；否则 local_only */
function metadataSourceOf(db, assetId) {
  if (db.prepare("SELECT 1 c FROM platform_post WHERE asset_id = ? LIMIT 1").get(assetId)) return "yuanbao_enrich";
  if (db.prepare("SELECT 1 c FROM legacy_package WHERE asset_id = ? LIMIT 1").get(assetId)) return "legacy_metadata";
  return "local_only";
}

export function getVideoDetail(db, assetId) {
  const v = db.prepare("SELECT * FROM video_asset WHERE id = ?").get(assetId);
  if (!v) return null;
  const posts = db.prepare("SELECT * FROM platform_post WHERE asset_id = ? ORDER BY fetched_at DESC").all(assetId);
  const ca = db.prepare("SELECT * FROM content_analysis WHERE asset_id = ?").get(assetId);
  const va = db.prepare("SELECT * FROM virality_analysis WHERE asset_id = ?").get(assetId);
  const rp = db.prepare("SELECT * FROM remake_plan WHERE asset_id = ?").get(assetId);
  const generations = db.prepare("SELECT * FROM remake_generation WHERE asset_id = ? ORDER BY completed_at DESC").all(assetId);
  const tr = db.prepare("SELECT * FROM transcript WHERE asset_id = ?").get(assetId);
  const oc = db.prepare("SELECT * FROM ocr WHERE asset_id = ?").get(assetId);
  const shots = db.prepare("SELECT * FROM shot WHERE asset_id = ? ORDER BY idx").all(assetId);
  const snapshots = db.prepare("SELECT * FROM metric_snapshot WHERE asset_id = ? ORDER BY captured_at").all(assetId);
  const commentItems = db.prepare("SELECT id, source, external_id, author, content, likes, published_at, captured_at FROM comment_item WHERE asset_id = ? ORDER BY id DESC LIMIT 1000").all(assetId);
  const prov = db.prepare("SELECT * FROM field_provenance WHERE asset_id = ? ORDER BY field").all(assetId);
  const chunks = db.prepare("SELECT * FROM knowledge_chunk WHERE asset_id = ? ORDER BY start_ms").all(assetId);
  const corrections = db.prepare("SELECT * FROM correction WHERE asset_id = ? ORDER BY corrected_at").all(assetId);
  const legacy = db.prepare("SELECT * FROM legacy_package WHERE asset_id = ? ORDER BY captured_at").all(assetId);
  const receipts = db.prepare("SELECT id, channel, source_url, content_id, sha256, media_validation, fallback_reason, started_at, completed_at, title, size_bytes, outcome FROM download_receipt WHERE asset_id = ? ORDER BY id DESC LIMIT 50").all(assetId);
  const observations = db.prepare("SELECT id, asset_id, kind, message, observed_at FROM ingest_observation WHERE asset_id = ? ORDER BY id DESC LIMIT 50").all(assetId);
  const parseJson = (s) => { try { return s ? JSON.parse(s) : null; } catch { return null; } };
  let analysisFrames = [];
  let analysisAudio = null;
  if (v.package_path) {
    try {
      const manifest = JSON.parse(readFileSync(join(v.package_path, "frames.json"), "utf8"));
      analysisFrames = (Array.isArray(manifest?.items) ? manifest.items : []).map((frame) => ({
        index: frame?.index ?? null,
        time: frame?.time ?? null,
        fileName: basename(String(frame?.fileName || "")),
      })).filter((frame) => frame.fileName).map((frame) => ({
        ...frame,
        mediaUrl: `/api/v1/kb/videos/${encodeURIComponent(assetId)}/analysis-frames/${encodeURIComponent(frame.fileName)}`,
      }));
    } catch { analysisFrames = []; }
  }
  if (v.package_path) {
    try {
      const manifest = JSON.parse(readFileSync(join(v.package_path, "audio.json"), "utf8"));
      const items = (Array.isArray(manifest?.items) ? manifest.items : []).map((item) => ({
        kind: item?.kind === "voice" ? "voice" : item?.kind === "accompaniment" ? "accompaniment" : null,
        fileName: basename(String(item?.fileName || "")),
        sizeBytes: Number(item?.sizeBytes) || null,
      })).filter((item) => item.kind && item.fileName).map((item) => ({
        ...item,
        mediaUrl: `/api/v1/kb/videos/${encodeURIComponent(assetId)}/analysis-audio/${encodeURIComponent(item.fileName)}`,
      }));
      analysisAudio = { ...manifest, items };
    } catch { analysisAudio = null; }
  }
  const postsSafe = posts.map((p) => ({
    id: p.id, content_id: p.content_id, post_id: p.post_id, url: p.url,
    author: p.author, author_avatar_url: p.author_avatar_url, author_cert_icon_url: p.author_cert_icon_url,
    publish_time: p.publish_time, title: p.title, topics: parseJson(p.topics), music: p.music,
    cover_url: p.cover_url, platform: p.platform,
    plays: p.plays, plays_raw: p.plays_raw, likes: p.likes, likes_raw: p.likes_raw,
    comments: p.comments, comments_raw: p.comments_raw,
    favorites: p.favorites, favorites_raw: p.favorites_raw,
    shares: p.shares, shares_raw: p.shares_raw,
    scaling_info: parseJson(p.scaling_info), fetched_at: p.fetched_at,
  }));
  return {
    // 不返回 file_path/package_path/raw_json_path 私有绝对路径（API 不暴露）；提供 previewUrl
    asset: { ...v, file_path: undefined, package_path: undefined, raw_json_path: undefined, previewUrl: `/api/v1/kb/videos/${assetId}/media`, quality: assessMediaQuality(v) },
    metadata_source: metadataSourceOf(db, assetId),
    platform_posts: postsSafe,
    latest_post: postsSafe[0] || null,
    legacy_packages: legacy.map((l) => ({ ...l, package_path: undefined })),
    content_analysis: ca ? { ...ca, key_points: parseJson(ca.key_points), structure: parseJson(ca.structure), audience: parseJson(ca.audience), reusable_pattern: parseJson(ca.reusable_pattern) } : null,
    virality_analysis: va ? { ...va, hypotheses: parseJson(va.hypotheses) } : null,
    remake_plan: rp ? { ...rp, plan: parseJson(rp.plan_json), plan_json: undefined } : null,
    remake_generations: generations.map((row) => ({
      ...row,
      mediaUrl: row.file_name ? `/api/v1/kb/videos/${encodeURIComponent(assetId)}/remake-output/${encodeURIComponent(row.file_name)}` : null,
    })),
    transcript: tr, ocr: oc,
    analysis_frames: analysisFrames,
    analysis_audio: analysisAudio,
    shots,
    metric_snapshots: snapshots.map((s) => ({ ...s, retention: parseJson(s.retention_json), retention_json: undefined })),
    comment_items: commentItems,
    field_provenance: prov,
    knowledge_chunks: chunks,
    corrections,
    download_receipts: receipts.map((r) => ({ ...r, source_url: undefined })), // source_url 可能含签名 → 剥除
    ingest_observations: observations,
  };
}

/** 同步磁盘 metadata.json / analysis.md（correction log，磁盘可重建） */
/**
 * 同步磁盘 metadata.json（correction log）：同目录临时文件写入后原子 rename，
 * 读者不会看到半 JSON。失败抛错（由 editField 回滚 DB 并回明确错误，不吞掉）。
 */
async function syncDiskCorrection(asset, field, oldValue, newValue, at) {
  if (!asset?.package_path) return; // 无包目录（理论不应发生）→ 无盘可同步，视为不适用
  const metaPath = join(asset.package_path, "metadata.json");
  const meta = JSON.parse(await readFile(metaPath, "utf8"));
  if (!Array.isArray(meta.corrections)) meta.corrections = [];
  meta.corrections.push({ field, oldValue: oldValue ?? null, newValue: String(newValue ?? ""), reason: "manual", correctedAt: at });
  if (field === "category") meta.category = String(newValue);
  // 原子替换：先写同目录临时文件，再 rename 覆盖
  const tmpPath = join(asset.package_path, `.metadata.json.tmp-${Math.random().toString(16).slice(2, 6)}`);
  await writeFile(tmpPath, JSON.stringify(meta, null, 2));
  await rename(tmpPath, metaPath);
}

/**
 * 编辑资产字段：DB 与磁盘 metadata.json 一致性。
 * DB 先提交（含 correction 记录），随后同步磁盘；磁盘同步失败时回滚 DB 恢复旧值并删除 correction，
 * 返回明确错误（绝不吞掉失败假装成功）。
 */
export async function editField(db, assetId, field, value, reason) {
  const now = new Date().toISOString();
  const v = db.prepare("SELECT * FROM video_asset WHERE id = ?").get(assetId);
  if (!v) return { ok: false, error: "not_found" };

  const rollback = () => {
    // 回滚 DB（恢复旧值 + 删除本次 correction 记录），保持 DB 与磁盘一致（磁盘未变）
    if (field === "category") {
      db.prepare("UPDATE video_asset SET category=?, updated_at=? WHERE id=?").run(old, now, assetId);
    } else if (field === "author") {
      db.prepare("UPDATE platform_post SET author=?, fetched_at=? WHERE id=?").run(old, now, latestId);
    } else if (field === "title") {
      db.prepare("UPDATE video_asset SET title=?, updated_at=? WHERE id=?").run(old, now, assetId);
      db.prepare("UPDATE platform_post SET title=? WHERE asset_id=?").run(old, assetId);
    }
    db.prepare("DELETE FROM correction WHERE asset_id=? AND field=? AND corrected_at=?").run(assetId, field, now);
  };
  let latestId = null;
  let old = null;

  try {
    if (field === "category") {
      const allowedCat = new Set(["素材", "技能", "其他"]);
      if (!allowedCat.has(String(value))) return { ok: false, error: "invalid_category" };
      old = v.category || "其他";
      db.prepare("UPDATE video_asset SET category=?, updated_at=? WHERE id=?").run(String(value), now, assetId);
      db.prepare("INSERT INTO correction (asset_id, field, old_value, new_value, reason, corrected_at) VALUES (?,?,?,?,?,?)")
        .run(assetId, field, old, String(value), reason || "manual", now);
      await syncDiskCorrection(v, field, old, value, now);
      return { ok: true };
    }
    if (field === "author") {
      const latest = db.prepare("SELECT id, author FROM platform_post WHERE asset_id = ? ORDER BY fetched_at DESC LIMIT 1").get(assetId);
      if (!latest) return { ok: false, error: "no_platform_post" };
      latestId = latest.id;
      old = latest.author || "";
      db.prepare("UPDATE platform_post SET author=?, fetched_at=? WHERE id=?").run(String(value), now, latest.id);
      db.prepare("INSERT INTO correction (asset_id, field, old_value, new_value, reason, corrected_at) VALUES (?,?,?,?,?,?)")
        .run(assetId, field, old, String(value), reason || "manual", now);
      await syncDiskCorrection(v, field, old, value, now);
      return { ok: true };
    }
    if (field === "title") {
      db.prepare("UPDATE video_asset SET title=?, updated_at=? WHERE id=?").run(String(value), now, assetId);
      db.prepare("UPDATE platform_post SET title=? WHERE asset_id=?").run(String(value), assetId);
      old = v.title || "";
      db.prepare("INSERT INTO correction (asset_id, field, old_value, new_value, reason, corrected_at) VALUES (?,?,?,?,?,?)")
        .run(assetId, field, old, String(value), reason || "manual", now);
      await syncDiskCorrection(v, field, v.title || "", value, now);
      return { ok: true };
    }
    return { ok: false, error: `field_not_editable:${field}` };
  } catch (e) {
    // 磁盘同步失败（或读不到 metadata.json）：回滚 DB，保持 DB 与磁盘一致，回明确错误
    try { rollback(); } catch { /* 回滚失败也如实报错 */ }
    return { ok: false, error: "disk_sync_failed", message: String((e && e.message) || e).slice(0, 300) };
  }
}

export function stats(db) {
  const total = db.prepare("SELECT COUNT(*) c FROM video_asset").get().c;
  const withPlatform = db.prepare("SELECT COUNT(DISTINCT asset_id) c FROM platform_post").get().c;
  const withAnalysis = db.prepare("SELECT COUNT(*) c FROM content_analysis WHERE confidence IS NOT NULL").get().c;
  const failed = db.prepare("SELECT COUNT(*) c FROM import_item WHERE status = 'failed'").get().c;
  const pending = db.prepare("SELECT COUNT(*) c FROM import_item WHERE status = 'pending'").get().c;
  const byCategory = db.prepare("SELECT category, COUNT(*) c FROM video_asset GROUP BY category").all()
    .reduce((acc, r) => { acc[r.category || "其他"] = r.c; return acc; }, {});
  const byChannel = db.prepare("SELECT channel, COUNT(*) c FROM video_asset GROUP BY channel").all()
    .reduce((acc, r) => { acc[r.channel || "unknown"] = r.c; return acc; }, {});
  const byValidation = db.prepare("SELECT media_validation, COUNT(*) c FROM video_asset GROUP BY media_validation").all()
    .reduce((acc, r) => { acc[r.media_validation || "unknown"] = r.c; return acc; }, {});
  const durationSum = db.prepare("SELECT SUM(duration_ms) s FROM video_asset WHERE media_validation = 'ok'").get().s;
  const receipts = db.prepare("SELECT COUNT(*) c FROM download_receipt").get().c;
  // mediaCoverage = 真实媒体探测（media_validation='ok'）覆盖率；withPlatform 独立保留（平台元数据覆盖率）
  const mediaOk = db.prepare("SELECT COUNT(*) c FROM video_asset WHERE media_validation = 'ok'").get().c;
  return {
    total, withPlatform, withAnalysis, failed, pending, byCategory, byChannel, byValidation, receipts,
    totalDurationSec: durationSum ? Math.round(durationSum / 1000) : 0,
    mediaCoverage: total ? Math.round((mediaOk / total) * 100) : 0,
  };
}
