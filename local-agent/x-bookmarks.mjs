import { mkdir, rename, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const MAX_ITEMS_PER_IMPORT = 500;

function text(value, max = 20_000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.round(number) : null;
}

function iso(value, fallback = null) {
  if (!value) return fallback;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? fallback : date.toISOString();
}

function localDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function json(value, fallback) {
  try { return JSON.parse(value); } catch { return fallback; }
}

function safeTweetId(value) {
  const id = text(value, 40);
  return /^\d{5,30}$/.test(id) ? id : null;
}

function escapeMarkdown(value) {
  return String(value || "").replace(/\r/g, "").replace(/^#/gm, "\\#").trim();
}

function threadCaptureOf(content) {
  const mentionsMissingReply = /(?:提示词|prompt|链接|教程|工具|源码).{0,18}(?:评论区|回复区|评论里|置顶评论|thread|below)|(?:评论区|回复区|评论里|置顶评论).{0,18}(?:提示词|prompt|链接|教程|工具|源码)/i.test(String(content || ""));
  return {
    status: mentionsMissingReply ? "main_post_only_needs_replies" : "main_post_only",
    needsReplies: mentionsMissingReply,
    note: mentionsMissingReply
      ? "主帖明确指向评论/回复，但当前 X 收藏同步只取得主帖；反推或学习前请打开原帖补充评论内容。"
      : "当前同步范围为收藏主帖；没有声称已抓取评论线程。",
  };
}

export function ensureXBookmarkSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS x_bookmark (
      id TEXT PRIMARY KEY,
      tweet_id TEXT NOT NULL UNIQUE,
      source_url TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      author TEXT,
      author_username TEXT,
      content_text TEXT NOT NULL,
      tags_json TEXT,
      media_json TEXT,
      cover_url TEXT,
      metrics_json TEXT,
      published_at TEXT,
      captured_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS ix_x_bookmark_captured_at ON x_bookmark(captured_at DESC);
    CREATE TABLE IF NOT EXISTS x_bookmark_sync (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      state TEXT NOT NULL,
      last_attempt_at TEXT,
      last_success_at TEXT,
      fetched INTEGER NOT NULL DEFAULT 0,
      imported INTEGER NOT NULL DEFAULT 0,
      error TEXT
    );
    INSERT OR IGNORE INTO x_bookmark_sync(singleton, state, fetched, imported)
      VALUES (1, 'waiting_login', 0, 0);
  `);
}

function normalizeBookmark(raw, capturedAt) {
  const tweetId = safeTweetId(raw?.tweetId ?? raw?.tweet_id ?? raw?.id);
  if (!tweetId) return null;
  const content = text(raw?.text ?? raw?.fullText ?? raw?.full_text, 20_000);
  if (!content) return null;
  const username = text(raw?.authorUsername ?? raw?.author_username ?? raw?.screenName, 80).replace(/^@/, "");
  const author = text(raw?.author ?? raw?.authorName ?? raw?.author_name, 200) || (username ? `@${username}` : "X 用户");
  const sourceUrl = `https://x.com/${username || "i"}/status/${tweetId}`;
  const title = content.replace(/\s+/g, " ").slice(0, 100) || `X 收藏 ${tweetId}`;
  const tags = Array.isArray(raw?.tags) ? raw.tags.map((item) => text(item, 80)).filter(Boolean).slice(0, 30) : [];
  const media = Array.isArray(raw?.media) ? raw.media.slice(0, 20) : [];
  const coverUrl = text(raw?.coverUrl ?? media.find((item) => item?.url)?.url, 2_000) || null;
  const metrics = {
    views: finite(raw?.metrics?.views ?? raw?.views),
    likes: finite(raw?.metrics?.likes ?? raw?.likes),
    comments: finite(raw?.metrics?.comments ?? raw?.metrics?.replies ?? raw?.comments),
    shares: finite(raw?.metrics?.shares ?? raw?.metrics?.retweets ?? raw?.shares),
    favorites: finite(raw?.metrics?.bookmarks ?? raw?.favorites),
  };
  return {
    id: `x_${tweetId}`,
    tweetId,
    sourceUrl,
    title,
    author,
    username: username || null,
    content,
    tags,
    media,
    coverUrl,
    metrics,
    publishedAt: iso(raw?.publishedAt ?? raw?.createdAt ?? raw?.created_at),
    capturedAt,
  };
}

async function writeDailyDigest(knowledgeBase, dateKey, rows) {
  if (!knowledgeBase || !rows.length) return null;
  const [year, month, day] = dateKey.split("-");
  const directory = join(knowledgeBase, "其他", year, month, day, "X 收藏");
  await mkdir(directory, { recursive: true });
  const target = join(directory, `${dateKey}-X收藏.md`);
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  const body = [
    `# ${dateKey} · X 收藏`,
    "",
    `当天同步 ${rows.length} 条收藏。此清单由织台本地生成，不消耗 Codex 或模型额度。`,
    "",
    ...rows.flatMap((row, index) => [
      `## ${index + 1}. ${escapeMarkdown(row.title)}`,
      "",
      `- 作者：${escapeMarkdown(row.author || "X 用户")}`,
      `- 原帖：${row.source_url}`,
      `- 收藏入库：${row.captured_at}`,
      `- 线程完整性：${threadCaptureOf(row.content_text).note}`,
      "",
      escapeMarkdown(row.content_text),
      "",
    ]),
  ].join("\n");
  await writeFile(temp, `${body}\n`, "utf8");
  await rename(temp, target);
  return target;
}

export async function importXBookmarks(db, input, { knowledgeBase } = {}) {
  ensureXBookmarkSchema(db);
  const capturedAt = iso(input?.capturedAt, new Date().toISOString());
  const items = (Array.isArray(input?.items) ? input.items : [])
    .slice(0, MAX_ITEMS_PER_IMPORT)
    .map((item) => normalizeBookmark(item, capturedAt))
    .filter(Boolean);
  if (!items.length) {
    db.prepare("UPDATE x_bookmark_sync SET state='empty', last_attempt_at=?, fetched=0, imported=0, error=NULL WHERE singleton=1").run(capturedAt);
    return { ok: true, fetched: 0, imported: 0, total: db.prepare("SELECT COUNT(*) total FROM x_bookmark").get().total };
  }

  const existing = db.prepare("SELECT 1 found FROM x_bookmark WHERE tweet_id=?");
  const upsert = db.prepare(`INSERT INTO x_bookmark
    (id, tweet_id, source_url, title, author, author_username, content_text, tags_json, media_json, cover_url,
     metrics_json, published_at, captured_at, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(tweet_id) DO UPDATE SET
      source_url=excluded.source_url, title=excluded.title, author=excluded.author,
      author_username=excluded.author_username, content_text=excluded.content_text,
      tags_json=excluded.tags_json, media_json=excluded.media_json, cover_url=excluded.cover_url,
      metrics_json=excluded.metrics_json, published_at=COALESCE(excluded.published_at, x_bookmark.published_at),
      updated_at=excluded.updated_at`);
  let imported = 0;
  db.exec("BEGIN");
  try {
    for (const item of items) {
      if (!existing.get(item.tweetId)) imported += 1;
      upsert.run(
        item.id, item.tweetId, item.sourceUrl, item.title, item.author, item.username, item.content,
        JSON.stringify(item.tags), JSON.stringify(item.media), item.coverUrl, JSON.stringify(item.metrics),
        item.publishedAt, item.capturedAt, item.capturedAt, item.capturedAt,
      );
    }
    db.prepare(`UPDATE x_bookmark_sync SET state='ready', last_attempt_at=?, last_success_at=?,
      fetched=?, imported=?, error=NULL WHERE singleton=1`).run(capturedAt, capturedAt, items.length, imported);
    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    throw error;
  }

  const dateKey = localDateKey(capturedAt);
  const rows = db.prepare("SELECT * FROM x_bookmark ORDER BY created_at DESC, tweet_id DESC").all()
    .filter((row) => localDateKey(row.created_at) === dateKey);
  const digestPath = await writeDailyDigest(knowledgeBase, dateKey, rows);
  return { ok: true, fetched: items.length, imported, total: db.prepare("SELECT COUNT(*) total FROM x_bookmark").get().total, digestPath };
}

export function markXBookmarkSyncError(db, error) {
  ensureXBookmarkSchema(db);
  const now = new Date().toISOString();
  const message = text(error, 300) || "同步失败";
  db.prepare("UPDATE x_bookmark_sync SET state='needs_login', last_attempt_at=?, error=? WHERE singleton=1").run(now, message);
}

export function xBookmarkStatus(db) {
  ensureXBookmarkSchema(db);
  const state = db.prepare("SELECT * FROM x_bookmark_sync WHERE singleton=1").get();
  const total = db.prepare("SELECT COUNT(*) total FROM x_bookmark").get().total;
  return { ...state, total };
}

function rowToLibrary(row) {
  const metrics = json(row.metrics_json, {});
  const tags = json(row.tags_json, []);
  const threadCapture = threadCaptureOf(row.content_text);
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    author_username: row.author_username,
    description: row.content_text,
    content: row.content_text,
    source_url: row.source_url,
    platform: "x",
    contentKind: "x_bookmark",
    category: "其他",
    tags: ["X收藏", ...(threadCapture.needsReplies ? ["待补评论"] : []), ...tags],
    coverUrl: row.cover_url,
    previewUrl: null,
    created_at: row.created_at,
    published_at: row.published_at,
    metrics,
    overview: row.content_text,
    analysis: { summary: row.content_text },
    thread_capture: threadCapture,
    sha256: createHash("sha256").update(row.source_url).digest("hex"),
  };
}

export function queryXBookmarks(db, { limit = 500 } = {}) {
  // 查询接口必须保持只读。过去这里每次都会执行 CREATE/INSERT，恰逢视频入库事务时
  // 会把本可并行的 WAL 读取升级成写锁竞争，最终让 /api/v1/library 偶发 500。
  // schema 由服务启动和写入入口统一创建；旧/空数据库则按空集合兼容。
  if (!db.prepare("SELECT 1 found FROM sqlite_master WHERE type='table' AND name='x_bookmark'").get()) return [];
  const safeLimit = Math.max(1, Math.min(5_000, Number(limit) || 500));
  return db.prepare("SELECT * FROM x_bookmark ORDER BY created_at DESC, tweet_id DESC LIMIT ?").all(safeLimit).map(rowToLibrary);
}

export function getXBookmark(db, id) {
  if (!db.prepare("SELECT 1 found FROM sqlite_master WHERE type='table' AND name='x_bookmark'").get()) return null;
  const row = db.prepare("SELECT * FROM x_bookmark WHERE id=?").get(String(id || ""));
  return row ? rowToLibrary(row) : null;
}
