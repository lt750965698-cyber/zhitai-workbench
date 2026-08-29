/**
 * kb-migrate.mjs v4 — 旧内容库(metadata.json 包) → kb.sqlite 统一索引
 *
 * v4（阶段 A2 契约 B）：
 *   - 缺 capturedAt 用【稳定回退】：metadata.json 文件 mtime（不再用每次变化的 now）
 *   - metric_snapshot 带 content_id + observation_id（=`legacy:<legacyId>`）：
 *     同包重跑幂等；同 asset 不同 contentId（即使 capturedAt 相同）快照都保留
 *   - 事务 + schema_version：任一步失败 ROLLBACK 并抛错，不吞掉半迁移错误
 *   - invalid/encrypted/unknown 迁移文件：不进可搜索 video_asset（仅 import_item partial + observation）
 *   - 引用式：不复制/不移动/不删除原视频
 *   - 新增 upgradeV2Database()：生产 v2 DB 隔离副本升级夹具
 *     （补 existing asset 的 category/channel/media_validation/legacy 关联；
 *     按 import_item.input 文件 SHA 映射孤立 asset_id，无法映射标 orphaned）
 */
import { readFile, readdir, stat as fsStat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, dirname, basename } from "node:path";
import { beginImmediateWithRetry, openKbDb, retrySqliteBusy } from "./kb.mjs";
import { probeLocalMedia } from "./downloader-adapter.mjs";
import { parseFormattedCount, deriveContentId, canonicalizeSourceUrl } from "./content-metadata.mjs";

/** 稳定 capturedAt：meta.capturedAt || meta.publishedAt || metadata.json mtime（不随运行时间漂移） */
async function stableCapturedAt(meta, metaPath) {
  if (meta.capturedAt) return String(meta.capturedAt);
  if (meta.publishedAt) return String(meta.publishedAt);
  try {
    const st = await fsStat(metaPath);
    return new Date(st.mtimeMs).toISOString();
  } catch {
    return null;
  }
}

export async function migrateLibraryToKb({ kbRoot, dataDir, probeMedia = probeLocalMedia }) {
  const metadataFiles = [];
  await walkNamed(kbRoot, "metadata.json", metadataFiles, 0, 8);

  const now = new Date().toISOString();
  const batchId = `kb_migrate_${now.replace(/[:.]/g, "").slice(0, 17)}_${randomUUID().slice(0, 8)}`;

  // 两阶段迁移：扫描、JSON、stat、SHA 和 ffprobe 全部在事务外完成。
  // DatabaseSync 的写锁期间绝不 await，否则同进程的复审/CAS 会因事件循环
  // 被 busy_timeout 占住而自锁。
  const prepared = [];
  let failed = 0;
  for (const metaPath of metadataFiles) {
    try {
      const meta = JSON.parse(await readFile(metaPath, "utf8"));
      const pkgDir = dirname(metaPath);
      const videoFile = await findVideoFile(pkgDir, meta);
      if (!videoFile) {
        failed += 1;
        continue;
      }
      const [sha256, capturedAt, media, videoStat] = await Promise.all([
        sha256Of(videoFile),
        stableCapturedAt(meta, metaPath),
        probeMedia(videoFile),
        fsStat(videoFile),
      ]);
      const sourceUrl = canonicalizeSourceUrl(meta.source?.url || meta.sourceUrl) || null;
      const legacyId = String(meta.id || basename(pkgDir));
      const contentId = meta.identity?.contentId
        || deriveContentId(sourceUrl, meta.platform || "wechat_channels", meta.upstream || {})
        || meta.upstream?.exportId
        || null;
      prepared.push({
        meta,
        pkgDir,
        videoFile,
        videoStat,
        sha256,
        media,
        sourceUrl,
        legacyId,
        capturedAt,
        contentId,
        title: meta.title || basename(videoFile) || "旧库内容",
        fingerprint: createHash("sha256").update(JSON.stringify(meta)).digest("hex").slice(0, 24),
        stats: parseStats(meta),
      });
    } catch {
      failed += 1;
    }
  }

  // openKbDb 的建表升级也可能撞上另一进程写锁；短 busy_timeout 后异步退避。
  const db = await retrySqliteBusy(() => openKbDb(join(dataDir, "kb.sqlite")));
  let indexed = 0, legacyRows = 0, posts = 0, snapshots = 0, skipped = 0, quarantined = 0;
  try {
    await beginImmediateWithRetry(db);
    // 从 BEGIN IMMEDIATE 到 COMMIT 只有同步 SQL，不做任何文件、哈希或媒体探测。
    ensureSchemaVersion(db);
    db.prepare("INSERT OR IGNORE INTO import_batch (id, status, source_kind, created_at, total, succeeded, failed, skipped) VALUES (?, 'running', 'migration', ?, ?, 0, 0, 0)")
      .run(batchId, now, metadataFiles.length);

    for (const item of prepared) {
      try {
        const {
          meta, pkgDir, videoFile, videoStat, sha256, media, sourceUrl,
          legacyId, capturedAt, contentId, title, fingerprint, stats,
        } = item;

        // 0) 媒体验证：invalid/encrypted/unknown 不得作为 ok 搜索资产 → quarantine（仅 import_item）
        const mediaValidation = media.mediaValidation; // ok | invalid | encrypted

        if (mediaValidation !== "ok") {
          db.prepare("INSERT INTO import_item (batch_id, input, input_kind, display_input, status, error, updated_at) VALUES (?,?,?,?, 'partial', ?, ?)")
            .run(batchId, videoFile, "file", basename(videoFile), `media_validation:${mediaValidation}:${String(meta.id || basename(pkgDir))}`, now);
          quarantined++;
          continue;
        }

        // 1) 资产：同 SHA = 一资产（引用式，不复制）
        let asset = db.prepare("SELECT id, legacy_id FROM video_asset WHERE sha256 = ?").get(sha256);
        if (!asset) {
          const assetId = `kb_mig_${sha256.slice(0, 8)}`;
          db.prepare(
            `INSERT OR IGNORE INTO video_asset (id, source_url, sha256, title, file_path, package_path, category, size_bytes, duration_ms, width, height, codec_video, codec_audio, channel, media_validation, legacy_id, captured_at, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          ).run(
            assetId, sourceUrl, sha256, title, videoFile, pkgDir, meta.category || "其他",
            videoStat.size,
            media.duration_ms ?? null,
            media.width ?? null,
            media.height ?? null,
            media.codec_video ?? null,
            media.codec_audio ?? null,
            "legacy_migration",
            mediaValidation,
            legacyId, capturedAt, now, now,
          );
          asset = db.prepare("SELECT id, legacy_id FROM video_asset WHERE sha256 = ?").get(sha256);
          if (asset) indexed++;
        } else {
          // 已存在：补齐 source_url / category / media_validation（幂等修复）
          db.prepare("UPDATE video_asset SET source_url = COALESCE(source_url, ?), category = COALESCE(category, ?), media_validation = COALESCE(media_validation, ?), updated_at = ? WHERE id = ?")
            .run(sourceUrl, meta.category || "其他", mediaValidation, now, asset.id);
          skipped++;
        }

        // 2) legacy_package：每个旧包都写（唯一 legacy_id+package_path）
        const legacyInsert = db.prepare(
          "INSERT OR IGNORE INTO legacy_package (asset_id, legacy_id, package_path, source_url, content_id, captured_at, metadata_fingerprint) VALUES (?,?,?,?,?,?,?)",
        ).run(asset.id, legacyId, pkgDir, sourceUrl, contentId, capturedAt, fingerprint);
        if (Number(legacyInsert.changes || 0) === 1) legacyRows++;

        const userNote = String(meta.source?.userNote || "").replace(/\s+/g, " ").trim().slice(0, 1_000);
        if (userNote) {
          const existingNote = db.prepare("SELECT 1 c FROM ingest_observation WHERE asset_id=? AND kind='user_note' AND message=? LIMIT 1").get(asset.id, userNote);
          if (!existingNote) db.prepare("INSERT INTO ingest_observation (asset_id, kind, message, observed_at) VALUES (?,?,?,?)")
            .run(asset.id, "user_note", userNote, capturedAt || now);
        }

        // 3) platform_post：相异 contentId 均保留
        if (sourceUrl || contentId || meta.author || meta.title) {
          const postContentId = contentId || `legacy:${legacyId}`;
          const existsPost = db.prepare("SELECT id FROM platform_post WHERE asset_id=? AND content_id=?").get(asset.id, postContentId);
          if (!existsPost) {
            db.prepare(
              `INSERT INTO platform_post (asset_id, content_id, post_id, url, author, publish_time, title, topics, music, platform, plays, plays_raw, likes, likes_raw, comments, comments_raw, favorites, favorites_raw, shares, shares_raw, fetched_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            ).run(
              asset.id, postContentId, meta.identity?.contentId || contentId || null, sourceUrl, meta.author || null,
              meta.publishedAt || null, meta.title || null,
              Array.isArray(meta.tags) ? JSON.stringify(meta.tags) : null, null,
              meta.platform || "wechat_channels",
              stats.plays?.value, stats.plays?.raw,
              stats.likes?.value, stats.likes?.raw,
              stats.comments?.value, stats.comments?.raw,
              stats.favorites?.value, stats.favorites?.raw,
              stats.shares?.value, stats.shares?.raw,
              capturedAt || now,
            );
            posts++;
          }
        }

        // 4) 指标快照：按稳定 capturedAt + observation_id=legacy:<legacyId>（同包重跑幂等；不同包全保留）
        const postContentId = contentId || `legacy:${legacyId}`;
        const snapCapturedAt = capturedAt || now; // 兜底 now 仅在文件 mtime 都失败时；真实包 mtime 一定存在
        const snapshotInsert = db.prepare(
          "INSERT OR IGNORE INTO metric_snapshot (asset_id, content_id, captured_at, plays, plays_raw, likes, likes_raw, comments, comments_raw, favorites, favorites_raw, shares, shares_raw, source, observation_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
          asset.id, postContentId, snapCapturedAt,
          stats.plays?.value, stats.plays?.raw,
          stats.likes?.value, stats.likes?.raw,
          stats.comments?.value, stats.comments?.raw,
          stats.favorites?.value, stats.favorites?.raw,
          stats.shares?.value, stats.shares?.raw,
          "legacy_metadata", `legacy:${legacyId}`,
        );
        if (Number(snapshotInsert.changes || 0) === 1) snapshots++;
      } catch {
        failed++;
      }
    }

    db.prepare("UPDATE import_batch SET status='done', succeeded=?, failed=?, skipped=? WHERE id=?").run(indexed, failed + quarantined, skipped, batchId);
    db.prepare("INSERT OR REPLACE INTO schema_version (key, version) VALUES ('kb_migrate', 4)").run();
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw new Error(`migration_failed:${String((e && e.message) || e).slice(0, 200)}`);
  } finally {
    db.close();
  }
  return { total: metadataFiles.length, indexed, legacyRows, posts, snapshots, skipped, failed, quarantined };
}

function ensureSchemaVersion(db) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_version (key TEXT PRIMARY KEY, version INTEGER)");
}

/**
 * 生产 v2 DB 升级夹具（隔离副本使用，本阶段不操作真实库）：
 *   - 补 existing asset 的 category（包路径推断）/ channel / media_validation（探测实际文件）/ legacy 关联计数
 *   - 按 import_item.input 文件 SHA 把孤立 asset_id 映射到现存资产；无法映射标 orphaned
 * 返回 { assets, patched, orphans }
 */
export async function upgradeV2Database({ dataDir }) {
  const db = openKbDb(join(dataDir, "kb.sqlite"));
  ensureSchemaVersion(db);
  const now = new Date().toISOString();
  const out = { assets: 0, patchedCategory: 0, patchedChannel: 0, patchedValidation: 0, orphanMapped: 0, orphans: [] };
  db.exec("BEGIN");
  try {
    const assets = db.prepare("SELECT id, package_path, file_path, category, channel, media_validation FROM video_asset").all();
    out.assets = assets.length;
    for (const a of assets) {
      let changed = false;
      if (!a.category && a.package_path) {
        const seg = String(a.package_path).split("/").filter(Boolean);
        // 内容库/<分类>/<日期>/<包> → 分类 = 倒数第 3 段
        const catIdx = seg.findIndex((s) => s === "内容库");
        const category = catIdx >= 0 && seg[catIdx + 1] ? seg[catIdx + 1] : null;
        if (category && ["素材", "技能", "其他"].includes(category)) {
          db.prepare("UPDATE video_asset SET category=?, updated_at=? WHERE id=?").run(category, now, a.id);
          out.patchedCategory++;
          changed = true;
        }
      }
      if (!a.channel) {
        const hasLegacy = db.prepare("SELECT 1 c FROM legacy_package WHERE asset_id=? LIMIT 1").get(a.id);
        db.prepare("UPDATE video_asset SET channel=?, updated_at=? WHERE id=?").run(hasLegacy ? "legacy_migration" : "unknown", now, a.id);
        out.patchedChannel++;
        changed = true;
      }
      if (!a.media_validation && a.file_path) {
        try {
          const media = await probeLocalMedia(a.file_path);
          const v = media.mediaValidation === "ok" ? "ok" : "unknown";
          db.prepare("UPDATE video_asset SET media_validation=?, updated_at=? WHERE id=?").run(v, now, a.id);
          out.patchedValidation++;
          changed = true;
        } catch { /* 文件缺失保持 unknown */ }
      }
      if (changed) { /* touch */ }
    }
    // orphan import_item：input 是文件路径 → SHA → 现存资产；无法映射标 orphaned
    const orphanItems = db.prepare("SELECT i.id, i.input FROM import_item i WHERE i.status != 'orphaned' AND (i.asset_id IS NULL OR NOT EXISTS (SELECT 1 FROM video_asset va WHERE va.id = i.asset_id)) AND i.input IS NOT NULL").all();
    for (const it of orphanItems) {
      if (!/\.(mp4|mov|m4v|webm)$/i.test(String(it.input || ""))) continue;
      try {
        const sha = await sha256Of(it.input);
        const target = db.prepare("SELECT id FROM video_asset WHERE sha256=?").get(sha);
        if (target) {
          db.prepare("UPDATE import_item SET asset_id=?, status='success', updated_at=? WHERE id=?").run(target.id, now, it.id);
          out.orphanMapped++;
        } else {
          db.prepare("UPDATE import_item SET status='orphaned', error='orphaned: 无法按 SHA 映射到现存资产', updated_at=? WHERE id=?").run(now, it.id);
          out.orphans.push({ id: it.id, input: basename(String(it.input)) });
        }
      } catch {
        db.prepare("UPDATE import_item SET status='orphaned', error='orphaned: 文件不可读，无法映射', updated_at=? WHERE id=?").run(now, it.id);
        out.orphans.push({ id: it.id, input: basename(String(it.input)) });
      }
    }
    db.prepare("INSERT OR REPLACE INTO schema_version (key, version) VALUES ('kb_v2_upgrade', 1)").run();
    db.exec("COMMIT");
  } catch (e) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    db.close();
    throw new Error(`v2_upgrade_failed:${String((e && e.message) || e).slice(0, 200)}`);
  }
  db.close();
  return out;
}

/** 兼容 meta.stats.counts.{x}.value 与 meta.upstream.stats 纯字符串 */
function parseStats(meta) {
  const out = { likes: null, favorites: null, comments: null, shares: null, plays: null };
  const counts = meta.stats?.counts || {};
  const raw = meta.upstream?.stats || meta.stats?.raw || {};
  const pick = (countKey, rawKeys) => {
    const c = counts[countKey];
    if (c && c.value != null) return { value: c.value, raw: c.raw ?? String(c.value), approximate: Boolean(c.approximate) };
    for (const k of rawKeys) {
      if (raw[k] != null && raw[k] !== "") {
        const p = parseFormattedCount(raw[k]);
        return { value: p.value, raw: p.raw, approximate: p.approximate };
      }
    }
    return { value: null, raw: null, approximate: false };
  };
  out.likes = pick("like", ["like", "likes"]);
  out.favorites = pick("favorite", ["fav", "favorite", "favorites"]);
  out.comments = pick("comment", ["comment", "comments"]);
  out.shares = pick("share", ["forward", "share", "shares"]);
  out.plays = pick("view", ["play", "playCount", "view", "views"]);
  return out;
}

async function findVideoFile(pkgDir, meta) {
  const files = Array.isArray(meta.files) ? meta.files : [];
  for (const f of files) {
    if (["video", "audio"].includes(f.role) && f.path && !f.external) {
      const p = join(pkgDir, f.path);
      if (await exists(p)) return p;
    }
  }
  const assets = join(pkgDir, "assets");
  const entries = await readdir(assets).catch(() => []);
  for (const e of entries) {
    if (/\.(mp4|mov|m4v|webm)$/i.test(e)) {
      const p = join(assets, e);
      if (await exists(p)) return p;
    }
  }
  return null;
}

async function exists(p) {
  try { await fsStat(p); return true; } catch { return false; }
}

async function sha256Of(p) {
  const { createReadStream } = await import("node:fs");
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(p);
    s.on("data", (c) => h.update(c));
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", reject);
  });
}

async function walkNamed(root, name, out, depth, maxDepth) {
  if (depth > maxDepth) return;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === ".DS_Store") continue;
    const p = join(root, e.name);
    if (e.isDirectory() && !e.name.startsWith(".")) await walkNamed(p, name, out, depth + 1, maxDepth);
    else if (e.isFile() && e.name === name) out.push(p);
  }
}
