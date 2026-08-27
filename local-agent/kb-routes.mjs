/**
 * kb-routes.mjs v4 — 织台知识库 HTTP 路由
 * v4（阶段 A2 契约 D）：
 *   - media/export 的 Content-Type 不被 CORS 头覆盖（先 corsHeaders 再媒体类型）
 *   - export CSV 显式映射嵌套字段（analysis.confidence/virality）+ 防公式注入（= + - @ → 前缀 '）
 *   - /imports 只返回安全字段（displayInput，本地路径仅 basename；不 SELECT i.*）
 *   - retry 幂等：POST application/json；对 fingerprint input 明确无法恢复下载源
 *   - analyze 幂等（不覆盖 available transcript/ocr）
 */
import { openKbDb, ingestOne, queryVideos, getVideoDetail, editField, stats, refreshAssetMetadata, recordReceipt, sanitizeFailureText, persistMediaAnalysis, importPerformanceEvidence, persistRemakeGeneration, persistExternalVideoPrompt } from "./kb.mjs";
import { parseChannelsVideo } from "./channels-yuanbao.mjs";
import { adapterKuaidian, adapterLocalFile, redactUrlForStorage, isStableShareUrl, canonicalizeSourceUrl, makeFailReceipt } from "./downloader-adapter.mjs";
import { mkdir, stat as fsStat } from "node:fs/promises";
import { join, basename } from "node:path";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";

let kbDb = null;
let kbDbPath = null; // P0 共享连接修复：后台异步任务各自 openKbDb(kbDbPath) 开独立连接，绝不复用全局 kbDb
let kbPrivDir = null;
let allowedOrigins = ["http://localhost:3000"];
let enrichOverride = null; // 测试注入（ZHITAI_ENRICH_SCRIPT），生产为 null → 真实元宝

export async function initKb(dataDir, { allowedOrigins: origins, yuanbaoEnrich } = {}) {
  kbPrivDir = join(dataDir, "private", "raw");
  await mkdir(kbPrivDir, { recursive: true });
  kbDbPath = join(dataDir, "kb.sqlite");
  kbDb = openKbDb(kbDbPath);
  if (Array.isArray(origins) && origins.length) allowedOrigins = origins;
  if (typeof yuanbaoEnrich === "function") enrichOverride = yuanbaoEnrich;
  return kbDb;
}

/** 解析元宝补元数据函数：优先测试注入，否则真实实现 */
export function resolveEnrich() {
  return enrichOverride || _yuanbaoEnrich;
}

/** 批次计数重算（与 server.mjs recountBatch 语义一致）：pending>0 → awaiting_primary_download，否则 done */
function recountBatch(db, batchId) {
  const total = db.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=?").get(batchId).c;
  const succeeded = db.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=? AND status IN ('success','linked')").get(batchId).c;
  const failed = db.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=? AND status IN ('failed','partial','orphaned')").get(batchId).c;
  const skipped = db.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=? AND status='duplicate'").get(batchId).c;
  const pending = Math.max(0, total - succeeded - failed - skipped);
  const status = pending > 0 ? "awaiting_primary_download" : "done";
  db.prepare("UPDATE import_batch SET status=?, total=?, succeeded=?, failed=?, skipped=? WHERE id=?").run(status, total, succeeded, failed, skipped, batchId);
  return { total, succeeded, failed, skipped, pending, status };
}

/** 稳定错误码白名单（adapter/ingest 域）：白名单外的未知错误码一律归为 retry_failed */
const RETRY_ERROR_CODES = new Set([
  "file_not_found", "unsupported_file_type", "no_download_source", "probe_failed",
  "yuanbao_parse_unavailable", "failed_primary", "failed_no_fallback_configured",
  "media_validation", "compensation_failed", "sha_unique_conflict_without_visible_winner",
  "package_path_collision", "winner_disappeared_before_link", "loser_item_update_failed",
  "creator_item_update_failed", "owner_tx_rollback_failed", "retry_failed", "failed",
]);

/** 失败消息净化（D2b 安全）：只保留白名单稳定错误码 + 输入文件名（leaf，双斜杠类型取末段、剥 query/fragment）；
 *  目录（POSIX/Windows）、绝对路径、临时 URL、token/auth/key/secret/decodeKey/encfilekey/signature/
 *  sig/wsTime/Expires/X-Amz 材料绝不外泄；输出有界。
 *  用于 worker 失败的每一次持久化与日志（import_item.error / receipt / ingest_observation / recordEvent）。 */
/** D2 安全：导出 sanitizeRetryError 仅供直接回归（白名单码 + 双斜杠 leaf），生产调用点不变 */
export function sanitizeRetryError(rawError, inputPath) {
  const raw = String((rawError && rawError.message) || rawError || "");
  // 白名单错误码：冒号前第一段；不在白名单 → retry_failed
  let code = String(raw.split(/[:：]/)[0] || "").trim().replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  if (!RETRY_ERROR_CODES.has(code)) code = "retry_failed";
  // 文件名：双斜杠类型取 leaf；先剥 query/fragment；再剥敏感键值/URL 材料，绝不保留目录分隔
  let name = String(inputPath || "").split(/[\\/]/).pop() || "";
  name = name.split(/[?#]/)[0] || "";
  // D2 安全：retry leaf 最终经共享净化器（引号/JSON 密钥、残余 KV/URL/路径一律剥除），仅保留安全文件名
  name = sanitizeFailureText(name).replace(/^_+|_+$/g, "").slice(0, 80);
  return name ? `${code}:${name}`.slice(0, 160) : code;
}

/** 文本级敏感净化（事件/API 边界，D2 安全）：统一委托 kb.mjs 的共享 sanitizeFailureText（唯一实现，
 *  避免规则分叉）；剥 URL/file URL、Windows 盘符、~/、POSIX 绝对路径（到行尾）、引号/JSON 敏感键值。
 *  用于：imports 列表 API 的 error 字段；retry 路由 recordEvent 的异常文本（认领异常 / worker 外层 catch）。 */
function redactSensitiveText(value) {
  return sanitizeFailureText(value);
}

/** imports 列表 displayInput 输出侧防御（D2b 安全）：稳定分享 URL → canonical 保留；其余 → 本地文件名
 *  （双斜杠取 leaf、剥 query/fragment，最终经共享净化器兜底引号/JSON 密钥/残余 KV/URL），
 *  绝不输出目录/临时 URL/token。 */
function safeDisplayInput(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "[redacted]";
  if (isStableShareUrl(raw)) return canonicalizeSourceUrl(raw);
  let leaf = String(raw).split(/[\\/]/).pop() || raw;
  leaf = leaf.split(/[?#]/)[0] || leaf;
  leaf = sanitizeFailureText(leaf).replace(/^_+|_+$/g, "").slice(0, 120);
  return leaf || "[redacted]";
}

/* ─────────── CORS（白名单，不反射任意 Origin；Content-Type 由业务方后置覆盖） ─────────── */
function corsHeadersFor(request) {
  const origin = request.headers.origin;
  const headers = {
    "Access-Control-Allow-Headers": "Content-Type, X-Zhitai-Action, X-Zhitai-Signature",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
    "Access-Control-Allow-Private-Network": "true",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  };
  if (origin && allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }
  return headers;
}

function sendJson(response, status, data, request) {
  response.writeHead(status, corsHeadersFor(request));
  response.end(JSON.stringify(data));
}

/** 写接口守卫：Origin 必须在白名单；Content-Type 必须 application/json；无 Origin（本机 CLI/GM）放行 */
function guardWrite(request, response) {
  const origin = request.headers.origin;
  if (origin && !allowedOrigins.includes(origin)) {
    sendJson(response, 403, { error: "origin_not_allowed" }, request);
    return false;
  }
  const contentType = String(request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    sendJson(response, 415, { error: "content_type_must_be_json" }, request);
    return false;
  }
  return true;
}

/* ─────────── 元宝元数据补全（enriched.media 结构化） ─────────── */
export async function _yuanbaoEnrich(sourceUrl) {
  const feed = await parseChannelsVideo(sourceUrl, null);
  const topics = (feed.description || "").match(/#[^#\s]+/g) || null;
  const creator = feed.creator || {};
  const media = {
    postId: feed.exportId || null,
    title: feed.description || null,
    author: feed.author || creator.nickname || null,
    authorAvatarUrl: creator.avatarUrl || null,
    authorCertIconUrl: creator.certificationIconUrl || null,
    publishTime: feed.createtime ? new Date(Number(feed.createtime) * 1000).toISOString() : null,
    topics,
    music: null,
    plays: null, // 接口无播放量，绝不推断
    likes: feed.stats?.like,
    comments: feed.stats?.comment,
    favorites: feed.stats?.fav,
    shares: feed.stats?.forward,
    platform: "wechat_channels",
    coverUrl: feed.coverUrl || null,
    scalingInfo: feed.scalingInfo || null, // 版式信号（非拍摄角度）
  };
  // rawForStorage 供脱敏落盘；不携带 videoUrl/decodeKey/token
  return { raw: { feedInfo: sanitizeFeed(feed) }, media };
}

function sanitizeFeed(feed) {
  // 剥敏感键：videoUrl/decodeKey/token/encfilekey/cookie/签名参数
  return JSON.parse(JSON.stringify(feed, (key, value) => {
    if (/(videoUrl|playableUrl|decodeKey|decryptKey|encfilekey|cookie|token|signature|authorization)/i.test(key)) return undefined;
    return value;
  }));
}

export async function handleKbRequest({ request, requestUrl, response, sendJson: _sendJson, readJsonBody, recordEvent, allowedOrigins: origins }) {
  if (!kbDb) return false;
  if (Array.isArray(origins) && origins.length) allowedOrigins = origins;
  const p = requestUrl.pathname;
  const m = p.match(/^\/api\/v1\/kb\/([a-z]+)(?:\/([^/]+))?/);
  if (!m) return false;
  const action = m[1];
  const id = m[2] ? decodeURIComponent(m[2]) : null;

  if (request.method === "GET" && action === "stats") {
    sendJson(response, 200, { ok: true, stats: stats(kbDb) }, request);
    return true;
  }

  if (request.method === "GET" && action === "videos" && !id) {
    const q = requestUrl.searchParams.get("q") || "";
    const platform = requestUrl.searchParams.get("platform") || "";
    const category = requestUrl.searchParams.get("category") || "";
    const sort = requestUrl.searchParams.get("sort") || "created_at";
    const limit = Number(requestUrl.searchParams.get("limit") || 50);
    const offset = Number(requestUrl.searchParams.get("offset") || 0);
    sendJson(response, 200, queryVideos(kbDb, { q, platform, category, sort, limit, offset }), request);
    return true;
  }

  // 媒体流：真实 Range（206/416）；Content-Type video/mp4 不被 CORS 头覆盖
  if (request.method === "GET" && action === "videos" && id && p.endsWith("/media")) {
    const assetId = p.split("/").filter(Boolean).slice(-2)[0];
    const assetRow = kbDb.prepare("SELECT file_path, size_bytes FROM video_asset WHERE id = ?").get(assetId);
    if (!assetRow || !assetRow.file_path) { sendJson(response, 404, { error: "not_found" }, request); return true; }
    let size;
    try { size = (await fsStat(assetRow.file_path)).size; }
    catch { sendJson(response, 404, { error: "file_missing" }, request); return true; }

    const rangeHeader = request.headers.range;
    // 顺序：先 CORS/安全头，再媒体 Content-Type（避免被覆盖成 application/json）
    const base = (extra = {}) => ({
      ...corsHeadersFor(request),
      "Accept-Ranges": "bytes",
      "Content-Type": "video/mp4",
      "Cache-Control": "no-cache",
      ...extra,
    });

    if (!rangeHeader) {
      response.writeHead(200, base({ "Content-Length": size }));
      const stream1 = createReadStream(assetRow.file_path);
      stream1.on("error", () => response.destroy());
      stream1.pipe(response);
      return true;
    }
    const match = String(rangeHeader).match(/^bytes=(\d*)-(\d*)$/);
    let start, end;
    if (!match || (match[1] === "" && match[2] === "")) {
      response.writeHead(416, base({ "Content-Range": `bytes */${size}` }));
      response.end();
      return true;
    }
    const [, a, b] = match;
    if (a === "") {
      const suffix = Number(b);
      if (suffix <= 0) { response.writeHead(416, base({ "Content-Range": `bytes */${size}` })); response.end(); return true; }
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number(a);
      end = b === "" ? size - 1 : Number(b);
    }
    if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || end < start || start >= size) {
      response.writeHead(416, base({ "Content-Range": `bytes */${size}` }));
      response.end();
      return true;
    }
    const clampedEnd = Math.min(end, size - 1);
    response.writeHead(206, base({
      "Content-Range": `bytes ${start}-${clampedEnd}/${size}`,
      "Content-Length": clampedEnd - start + 1,
    }));
    const stream2 = createReadStream(assetRow.file_path, { start, end: clampedEnd });
    stream2.on("error", () => response.destroy());
    stream2.pipe(response);
    return true;
  }

  // 内容包内持久化关键帧；只接受 manifest 生成的单层文件名，不暴露绝对路径。
  const analysisFrameMatch = p.match(/^\/api\/v1\/kb\/videos\/[^/]+\/analysis-frames\/([^/]+)$/);
  if (request.method === "GET" && action === "videos" && id && analysisFrameMatch) {
    const fileName = decodeURIComponent(analysisFrameMatch[1]);
    if (!fileName || basename(fileName) !== fileName || !/^frame-\d+\.(?:jpe?g|png|webp)$/i.test(fileName)) {
      sendJson(response, 400, { error: "invalid_frame_name" }, request);
      return true;
    }
    const assetRow = kbDb.prepare("SELECT package_path FROM video_asset WHERE id = ?").get(id);
    if (!assetRow?.package_path) { sendJson(response, 404, { error: "not_found" }, request); return true; }
    const framePath = join(assetRow.package_path, "analysis-frames", fileName);
    try { await fsStat(framePath); }
    catch { sendJson(response, 404, { error: "frame_missing" }, request); return true; }
    const ext = fileName.toLowerCase().split(".").pop();
    const contentType = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    response.writeHead(200, {
      ...corsHeadersFor(request),
      "Content-Type": contentType,
      "Cache-Control": "private, max-age=86400",
    });
    const stream = createReadStream(framePath);
    stream.on("error", () => response.destroy());
    stream.pipe(response);
    return true;
  }

  const analysisAudioMatch = p.match(/^\/api\/v1\/kb\/videos\/[^/]+\/analysis-audio\/(voice|accompaniment)\.m4a$/);
  if (request.method === "GET" && action === "videos" && id && analysisAudioMatch) {
    const fileName = `${analysisAudioMatch[1]}.m4a`;
    const assetRow = kbDb.prepare("SELECT package_path FROM video_asset WHERE id = ?").get(id);
    if (!assetRow?.package_path) { sendJson(response, 404, { error: "not_found" }, request); return true; }
    const audioPath = join(assetRow.package_path, "analysis-audio", fileName);
    let size;
    try { size = (await fsStat(audioPath)).size; }
    catch { sendJson(response, 404, { error: "audio_missing" }, request); return true; }
    response.writeHead(200, {
      ...corsHeadersFor(request),
      "Content-Type": "audio/mp4",
      "Content-Length": size,
      "Cache-Control": "private, max-age=86400",
    });
    const stream = createReadStream(audioPath);
    stream.on("error", () => response.destroy());
    stream.pipe(response);
    return true;
  }

  // GPT 生成的复刻分镜首帧；仅允许固定命名的 PNG，不暴露内容包绝对路径。
  const storyboardMatch = p.match(/^\/api\/v1\/kb\/videos\/[^/]+\/storyboards\/(shot-\d{2}\.png)$/i);
  if (request.method === "GET" && action === "videos" && id && storyboardMatch) {
    const fileName = basename(decodeURIComponent(storyboardMatch[1]));
    const assetRow = kbDb.prepare("SELECT package_path FROM video_asset WHERE id = ?").get(id);
    if (!assetRow?.package_path) { sendJson(response, 404, { error: "not_found" }, request); return true; }
    const imagePath = join(assetRow.package_path, "generated", "gpt-storyboards", fileName);
    let size;
    try { size = (await fsStat(imagePath)).size; }
    catch { sendJson(response, 404, { error: "storyboard_missing" }, request); return true; }
    response.writeHead(200, {
      ...corsHeadersFor(request),
      "Content-Type": "image/png",
      "Content-Length": size,
      "Cache-Control": "private, max-age=86400",
    });
    const stream = createReadStream(imagePath);
    stream.on("error", () => response.destroy());
    stream.pipe(response);
    return true;
  }

  // 创作者后台数据/评论正文手工导入：播放、互动、留存与评论作为独立观察证据保存。
  if (request.method === "POST" && action === "videos" && id && p.endsWith("/performance")) {
    if (!guardWrite(request, response)) return true;
    const { json } = await readJsonBody(request, 2_000_000);
    try {
      const saved = await importPerformanceEvidence(kbDb, id, json || {});
      if (!saved.ok) {
        sendJson(response, saved.status || 400, saved, request);
        return true;
      }
      recordEvent("info", "KB_PERFORMANCE_IMPORT", `表现数据已导入 ${id}`);
      sendJson(response, 200, saved, request);
    } catch (error) {
      recordEvent("error", "KB_PERFORMANCE_IMPORT", `表现数据导入失败 ${id}`);
      sendJson(response, 500, { error: "performance_import_failed", message: sanitizeFailureText(error?.message || error) }, request);
    }
    return true;
  }

  const remakeMediaMatch = p.match(/^\/api\/v1\/kb\/videos\/[^/]+\/remake-output\/((?:moneyprinter|zhitai)-[0-9a-f-]+\.mp4)$/i);
  if (request.method === "GET" && action === "videos" && id && remakeMediaMatch) {
    const fileName = basename(decodeURIComponent(remakeMediaMatch[1]));
    const row = kbDb.prepare("SELECT package_path FROM video_asset WHERE id=?").get(id);
    if (!row?.package_path) { sendJson(response, 404, { error: "not_found" }, request); return true; }
    const filePath = join(row.package_path, "remake-output", fileName);
    let size;
    try { size = (await fsStat(filePath)).size; }
    catch { sendJson(response, 404, { error: "generated_video_missing" }, request); return true; }
    const base = (extra = {}) => ({
      ...corsHeadersFor(request),
      "Content-Type": "video/mp4",
      "Cache-Control": "private, no-cache",
      "Accept-Ranges": "bytes",
      ...extra,
    });
    const rangeHeader = request.headers.range;
    if (!rangeHeader) {
      response.writeHead(200, base({ "Content-Length": size }));
      const stream = createReadStream(filePath);
      stream.on("error", () => response.destroy());
      stream.pipe(response);
      return true;
    }
    const match = String(rangeHeader).match(/^bytes=(\d*)-(\d*)$/);
    let start, end;
    if (!match || (match[1] === "" && match[2] === "")) {
      response.writeHead(416, base({ "Content-Range": `bytes */${size}` })); response.end(); return true;
    }
    if (match[1] === "") {
      const suffix = Number(match[2]);
      if (suffix <= 0) { response.writeHead(416, base({ "Content-Range": `bytes */${size}` })); response.end(); return true; }
      start = Math.max(0, size - suffix); end = size - 1;
    } else {
      start = Number(match[1]); end = match[2] === "" ? size - 1 : Number(match[2]);
    }
    if (Number.isNaN(start) || Number.isNaN(end) || start < 0 || end < start || start >= size) {
      response.writeHead(416, base({ "Content-Range": `bytes */${size}` })); response.end(); return true;
    }
    end = Math.min(end, size - 1);
    response.writeHead(206, base({ "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 }));
    const stream = createReadStream(filePath, { start, end });
    stream.on("error", () => response.destroy());
    stream.pipe(response);
    return true;
  }

  if (request.method === "POST" && action === "videos" && id && p.endsWith("/remake-output")) {
    if (!guardWrite(request, response)) return true;
    const { json } = await readJsonBody(request, 100_000);
    try {
      const saved = await persistRemakeGeneration(kbDb, id, json || {});
      if (!saved.ok) { sendJson(response, saved.status || 400, saved, request); return true; }
      recordEvent("info", "KB_REMAKE_COMPLETE", `复刻成片已写回 ${id}`);
      sendJson(response, 200, saved, request);
    } catch (error) {
      sendJson(response, 500, { error: "remake_persist_failed", message: sanitizeFailureText(error?.message || error) }, request);
    }
    return true;
  }

  if (request.method === "GET" && action === "videos" && id) {
    const detail = getVideoDetail(kbDb, id);
    if (!detail) { sendJson(response, 404, { error: "not_found" }, request); return true; }
    sendJson(response, 200, detail, request);
    return true;
  }

  // 视频分析结果写回：mcp-video-analyzer 的 ASR/OCR/关键帧与织台复刻方案统一入库并落盘。
  if (request.method === "POST" && action === "videos" && id && p.endsWith("/analysis")) {
    if (!guardWrite(request, response)) return true;
    const { json } = await readJsonBody(request, 8_000_000);
    if (!json?.result || typeof json.result !== "object") {
      sendJson(response, 400, { error: "analysis_result_required" }, request);
      return true;
    }
    try {
      const saved = await persistMediaAnalysis(kbDb, id, json.result, json.remakePlan || null);
      if (!saved.ok) {
        sendJson(response, saved.error === "not_found" ? 404 : 400, saved, request);
        return true;
      }
      recordEvent("info", "KB_MEDIA_ANALYSIS", `视频分析已写回 ${id}`);
      sendJson(response, 200, saved, request);
    } catch (error) {
      recordEvent("error", "KB_MEDIA_ANALYSIS", `视频分析写回失败 ${id}`);
      sendJson(response, 500, { error: "analysis_persist_failed", message: sanitizeFailureText(error?.message || error) }, request);
    }
    return true;
  }

  if (request.method === "POST" && action === "videos" && id && p.endsWith("/external-prompt")) {
    if (!guardWrite(request, response)) return true;
    const { json } = await readJsonBody(request, 100_000);
    try {
      const saved = await persistExternalVideoPrompt(kbDb, id, json || {});
      sendJson(response, saved.ok ? 200 : (saved.status || 400), saved, request);
    } catch (error) {
      sendJson(response, 500, { error: "external_prompt_persist_failed", message: sanitizeFailureText(error?.message || error) }, request);
    }
    return true;
  }

  if (request.method === "POST" && action === "videos" && id && p.endsWith("/open-package")) {
    if (!guardWrite(request, response)) return true;
    await readJsonBody(request, 10_000);
    const row = kbDb.prepare("SELECT package_path FROM video_asset WHERE id=?").get(id);
    if (!row?.package_path) { sendJson(response, 404, { error: "package_not_found" }, request); return true; }
    try {
      const child = spawn("/usr/bin/open", [row.package_path], { detached: true, stdio: "ignore" });
      child.unref();
      sendJson(response, 200, { ok: true }, request);
    } catch {
      sendJson(response, 500, { error: "open_package_failed" }, request);
    }
    return true;
  }

  if (request.method === "GET" && action === "export") {
    const format = requestUrl.searchParams.get("format") || "json";
    const { items } = queryVideos(kbDb, { limit: 5000 });
    if (format === "csv") {
      // 显式映射嵌套字段（analysis.confidence / virality），不直接 r[h]
      const columns = [
        ["id", (r) => r.id],
        ["title", (r) => r.title],
        ["category", (r) => r.category],
        ["channel", (r) => r.channel],
        ["observed_channel", (r) => r.observed_channel],
        ["media_validation", (r) => r.media_validation],
        ["metadata_source", (r) => r.metadata_source],
        ["author", (r) => r.author],
        ["publish_time", (r) => r.publish_time],
        ["duration_ms", (r) => r.duration_ms],
        ["likes", (r) => r.likes],
        ["comments", (r) => r.comments],
        ["favorites", (r) => r.favorites],
        ["shares", (r) => r.shares],
        ["source_url", (r) => r.source_url],
        ["analysis_confidence", (r) => r.analysis?.confidence ?? ""],
        ["analysis_source", (r) => r.analysis?.source ?? ""],
        ["virality", (r) => r.virality ?? ""],
        ["created_at", (r) => r.created_at],
      ];
      // CSV 公式注入防护：以 = + - @ 或制表符/回车开头 → 前缀 '
      const esc = (raw) => {
        const s = raw == null ? "" : String(raw);
        const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
        return /[",\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
      };
      const lines = [
        columns.map(([h]) => h).join(","),
        ...items.map((r) => columns.map(([, fn]) => esc(fn(r))).join(",")),
      ];
      response.writeHead(200, { ...corsHeadersFor(request), "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="kb-export.csv"' });
      response.end("\uFEFF" + lines.join("\n"));
      return true;
    }
    response.writeHead(200, { ...corsHeadersFor(request), "Content-Type": "application/json; charset=utf-8", "Content-Disposition": 'attachment; filename="kb-export.json"' });
    response.end(JSON.stringify(items, null, 2));
    return true;
  }

  // ── POST /api/v1/kb/import（guard） ──
  if (request.method === "POST" && action === "import") {
    if (!guardWrite(request, response)) return true;
    const { json } = await readJsonBody(request, 1_000_000);
    const links = Array.isArray(json?.links) ? json.links.filter((x) => typeof x === "string" && /^https?:\/\//i.test(x)).slice(0, 50) : [];
    const files = Array.isArray(json?.files) ? json.files.filter((x) => typeof x === "string").slice(0, 50) : [];
    const channel = String(json?.channel || "kuaidian");
    if (!links.length && !files.length) { sendJson(response, 400, { error: "empty_import" }, request); return true; }
    const batchId = `kb_import_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`;
    kbDb.prepare("INSERT INTO import_batch (id, status, source_kind, created_at, total, succeeded, failed, skipped) VALUES (?, 'running', ?, ?, ?, 0, 0, 0)")
      .run(batchId, links.length && files.length ? "mixed" : (links.length ? "link" : "file"), new Date().toISOString(), links.length + files.length);
    (async () => {
      // P0 共享连接修复：后台导入任务开独立连接（OWNER_TX/LINK_TX 含 await，不能与全局 kbDb 并发），
      // 本任务所有 import_item/batch 语句与 ingestOne 全部用 jobDb；finally 保证关闭。
      const jobDb = openKbDb(kbDbPath, { migrateSchema: false });
      try {
        const ctx = { privDir: kbPrivDir, yuanbaoEnrich: resolveEnrich() };
        const entries = [...links.map((l) => ({ input: l, kind: "link" })), ...files.map((f) => ({ input: f, kind: "file" }))];
        for (const e of entries) {
          let itemId = null;
          try {
            if (e.kind === "file") {
              // E：先安全预建 import_item（本地路径无签名密钥；display 仅 basename），再探测
              itemId = jobDb.prepare("INSERT INTO import_item (batch_id, input, input_kind, display_input, status, updated_at) VALUES (?,?,?,?, 'pending', ?)")
                .run(batchId, e.input, "file", basename(e.input), new Date().toISOString()).lastInsertRowid;
              const receipt = await adapterLocalFile(e.input, { channel });
              await ingestOne(jobDb, { receipt, input: e.input, input_kind: "file", batchId, ctx: { ...ctx, displayInput: basename(e.input), itemId } });
            } else if (isStableShareUrl(e.input)) {
              // 分享链接：等待原版快点产出直链（诚实 pending，不下载 HTML）；canonical 化后安全入队（P0-3）
              const canonical = canonicalizeSourceUrl(e.input);
              jobDb.prepare("INSERT INTO import_item (batch_id, input, input_kind, display_input, status, error, updated_at) VALUES (?,?,?,?, 'pending', ?, ?)")
                .run(batchId, canonical, "link", canonical, "awaiting_primary_download: 分享链接需原版快点解析出直链后才可下载；元宝仅补元数据，不负责下载", new Date().toISOString());
              continue;
            } else {
              // 非分享直链：downloadUrl 落库前 fingerprint（input/display 均不落原始签名 URL）
              const fp = redactUrlForStorage(e.input);
              itemId = jobDb.prepare("INSERT INTO import_item (batch_id, input, input_kind, display_input, status, updated_at) VALUES (?,?,?,?, 'pending', ?)")
                .run(batchId, fp, "link", fp, new Date().toISOString()).lastInsertRowid;
              try {
                const receipt = await adapterKuaidian({ downloadUrl: e.input, title: json?.title });
                await ingestOne(jobDb, { receipt, input: fp, input_kind: "link", batchId, ctx: { ...ctx, displayInput: fp, itemId } });
              } catch (err) {
                // E：adapter 前置失败也要可追踪（预建 item → failed），input/display/error 无签名密钥
                jobDb.prepare("UPDATE import_item SET status='failed', error=?, updated_at=? WHERE id=?").run(
                  `failed_primary: failed_no_fallback_configured: ${String(err.message || err).slice(0, 300)}`, new Date().toISOString(), itemId);
              }
            }
          } catch (err) {
            // ingestOne 已写终态；兜底（仅当 item 仍 pending 才更新）
            if (itemId) {
              jobDb.prepare("UPDATE import_item SET status='failed', error=?, updated_at=? WHERE id=? AND status='pending'").run(
                String(err.message || err).slice(0, 500), new Date().toISOString(), itemId);
            }
          }
        }
        // P0-2：批次计数只计真实终态，pending=total-三者和；有 pending 时 status=awaiting_primary_download，否则 done
        const total = jobDb.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=?").get(batchId).c;
        const succeeded = jobDb.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=? AND status IN ('success','linked')").get(batchId).c;
        const failed = jobDb.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=? AND status IN ('failed','partial','orphaned')").get(batchId).c;
        const skipped = jobDb.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=? AND status='duplicate'").get(batchId).c;
        const pending = Math.max(0, total - succeeded - failed - skipped);
        jobDb.prepare("UPDATE import_batch SET status=?, total=?, succeeded=?, failed=?, skipped=? WHERE id=?")
          .run(pending > 0 ? "awaiting_primary_download" : "done", total, succeeded, failed, skipped, batchId);
        recordEvent("info", "KB_IMPORT", `知识库导入完成：成功 ${succeeded} / 失败 ${failed} / 跳过 ${skipped} / 等待快点 ${pending}`);
      } finally {
        jobDb.close(); // 保证关闭独立连接（成功/异常均执行）
      }
    })().catch((e) => recordEvent("error", "KB_IMPORT", String(e.message || e).slice(0, 200)));
    sendJson(response, 202, { ok: true, batchId }, request);
    return true;
  }

  // A4.3-D1：只读导入项状态（安全白名单字段）。绝不返回 input/displayInput/deliveryId/
  // downloadUrl/绝对路径/error/evidence；terminal 仅对终态为 true。
  const statusMatch = p.match(/^\/api\/v1\/kb\/imports\/(\d+)\/status$/);
  if (request.method === "GET" && statusMatch) {
    const statusItemId = Number(statusMatch[1]);
    const statusRow = kbDb.prepare("SELECT id, batch_id, status, asset_id, updated_at FROM import_item WHERE id = ?").get(statusItemId);
    if (!statusRow) { sendJson(response, 404, { error: "not_found" }, request); return true; }
    const terminal = ["success", "duplicate", "linked", "failed", "partial", "orphaned"].includes(String(statusRow.status || ""));
    sendJson(response, 200, {
      ok: true,
      itemId: statusRow.id,
      batchId: statusRow.batch_id,
      status: statusRow.status,
      terminal,
      ...(statusRow.asset_id ? { assetId: statusRow.asset_id } : {}),
      updatedAt: statusRow.updated_at,
    }, request);
    return true;
  }

  if (request.method === "GET" && action === "imports") {
    const status = requestUrl.searchParams.get("status") || "";
    const w = status ? " WHERE i.status = ?" : "";
    const rows = kbDb.prepare(`SELECT i.id, i.batch_id, i.input_kind, i.display_input, i.status, i.error, i.retry_count, i.asset_id, i.updated_at, b.source_kind FROM import_item i JOIN import_batch b ON b.id = i.batch_id ${w} ORDER BY i.id DESC LIMIT 100`).all(...(status ? [status] : []));
    // API 只返回安全字段：input 一律不返回；display_input 在写入时已由调用方脱敏（basename / 分享 URL / [redacted]）
    const items = rows.map((r) => ({
      id: r.id, batch_id: r.batch_id, input_kind: r.input_kind,
      // D2b 安全审查：displayInput 输出侧防御（稳定分享 URL → canonical；其余 → 本地文件名，
      // 剥 query/fragment/目录/临时 URL/token），任何来源的原始 display_input 都不得带路径/密钥出 API
      displayInput: safeDisplayInput(r.display_input),
      status: r.status,
      // D2b 安全审查：error 在 API 边界统一脱敏（任何来源的原始 error 都不得带绝对路径/URL/密钥出 API；
      // 稳定错误码保留，敏感片段 → [redacted]）
      error: r.error ? redactSensitiveText(r.error) : null,
      retry_count: r.retry_count, asset_id: r.asset_id,
      updated_at: r.updated_at, source_kind: r.source_kind,
    }));
    // pending 项里的 input 需要 sourceUrl 用于 retry —— 由 display_input 承载（分享 URL 本身安全）
    const batches = kbDb.prepare("SELECT * FROM import_batch ORDER BY created_at DESC LIMIT 20").all();
    sendJson(response, 200, { items, batches }, request);
    return true;
  }

  const retryMatch = p.match(/^\/api\/v1\/kb\/imports\/(\d+)\/retry$/);
  if (request.method === "POST" && retryMatch) {
    if (!guardWrite(request, response)) return true;
    const itemId = Number(retryMatch[1]);
    // A4.3-D2b：短同步 BEGIN IMMEDIATE 原子认领（无 await），在既有路由连接（全局 kbDb）上执行。
    //   404 缺失；max_retry(≥3) → 400 零变更；fingerprint input → 400 retry_unavailable 零变更；
    //   稳定分享 input → 409 retry_requires_primary_payload 零变更（媒体必须由原版快点提供，元宝仅补元数据）；
    //   success/duplicate/linked → 409 terminal_state 零变更；pending 或 15 分钟内新 processing → 409 retry_in_progress 零变更；
    //   failed/partial/orphaned 且 retry_count>0 且距上次失败 <2s → 409 retry_cooldown 零变更（手动重试冷却）。
    //   仅 failed/partial/orphaned（retry_count=0 的初次失败立即重试；retry_count>0 须已过 2s 冷却）
    //   或 >15 分钟陈旧 processing 可原地条件回收（冷却/陈旧谓词同时进 UPDATE，原子；changes===1 才是唯一 202 owner）；
    //   同一事务内重算原批次计数并置 status='running'（item 刚变 processing，不计任何终态桶）。
    //   冷却租约（lease）：同一并发「点击风暴」中首个 worker 快速失败会把 item 置回 failed 且 updated_at=now，
    //   若无冷却，风暴中的后续请求会再次命中 failed 回收 → 第二个 202 启动第二个 worker；2s 冷却阻止该情况，
    //   冷却过后仍可再次手动重试，且受 max_retry(≤3) 约束；陈旧 processing 恢复不受冷却影响。
    const staleCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const cooldownCutoff = new Date(Date.now() - 2000).toISOString();
    let owner = false;
    let batchIdResp = null;
    let workerCtx = null; // { input, inputKind, displayInput }
    kbDb.exec("BEGIN IMMEDIATE");
    try {
      const nowIso = new Date().toISOString();
      // 事务内重取 item（与并发认领互斥可见）
      const item = kbDb.prepare("SELECT * FROM import_item WHERE id = ?").get(itemId);
      if (!item) { kbDb.exec("ROLLBACK"); sendJson(response, 404, { error: "not_found" }, request); return true; }
      if (item.retry_count >= 3) { kbDb.exec("ROLLBACK"); sendJson(response, 400, { error: "max_retry" }, request); return true; }
      // fingerprint input（临时直链已脱敏）无法恢复下载源 → 400，零变更
      if (String(item.input || "").startsWith("[redacted:")) { kbDb.exec("ROLLBACK"); sendJson(response, 400, { error: "retry_unavailable" }, request); return true; }
      // 稳定分享链接：媒体必须由原版快点提供，元宝仅补元数据 → 409，零变更
      if (isStableShareUrl(String(item.input || ""))) { kbDb.exec("ROLLBACK"); sendJson(response, 409, { error: "retry_requires_primary_payload" }, request); return true; }
      const rowStatus = String(item.status || "");
      if (["success", "duplicate", "linked"].includes(rowStatus)) { kbDb.exec("ROLLBACK"); sendJson(response, 409, { error: "terminal_state" }, request); return true; }
      // pending 或 15 分钟内的新 processing：重试进行中/不可回收 → 409，零变更
      if (rowStatus === "pending" || (rowStatus === "processing" && item.updated_at >= staleCutoff)) { kbDb.exec("ROLLBACK"); sendJson(response, 409, { error: "retry_in_progress" }, request); return true; }
      // failed/partial/orphaned 且在 2s 冷却窗内（retry_count>0 且 updated_at 新鲜）→ 409 retry_cooldown，零变更
      const retryCountNow = Number(item.retry_count || 0);
      if (["failed", "partial", "orphaned"].includes(rowStatus) && retryCountNow > 0 && item.updated_at >= cooldownCutoff) {
        kbDb.exec("ROLLBACK");
        sendJson(response, 409, { error: "retry_cooldown" }, request);
        return true;
      }
      // 仅 failed/partial/orphaned（retry_count=0 或已过冷却）或 >15min 陈旧 processing 可原地条件回收；
      // 冷却谓词同时进 UPDATE（原子）；changes===1 才是唯一 owner
      const reclaimed = kbDb.prepare(
        `UPDATE import_item SET status='processing', error=NULL, asset_id=NULL, retry_count=COALESCE(retry_count,0)+1, updated_at=? WHERE id=? AND ((status IN ('failed','partial','orphaned') AND (retry_count IS NULL OR retry_count=0 OR updated_at < ?)) OR (status='processing' AND updated_at < ?))`,
      ).run(nowIso, itemId, cooldownCutoff, staleCutoff);
      if (reclaimed.changes !== 1) { kbDb.exec("ROLLBACK"); sendJson(response, 409, { error: "retry_in_progress" }, request); return true; }
      owner = true;
      batchIdResp = item.batch_id;
      workerCtx = { input: item.input, inputKind: item.input_kind, displayInput: item.display_input };
      // 同事务：重算原批次计数并置 running（防止 worker 打开连接前崩溃留下 batch=done 而 item=processing）
      const total = kbDb.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=?").get(item.batch_id).c;
      const succeeded = kbDb.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=? AND status IN ('success','linked')").get(item.batch_id).c;
      const failed = kbDb.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=? AND status IN ('failed','partial','orphaned')").get(item.batch_id).c;
      const skipped = kbDb.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=? AND status='duplicate'").get(item.batch_id).c;
      kbDb.prepare("UPDATE import_batch SET status='running', total=?, succeeded=?, failed=?, skipped=? WHERE id=?").run(total, succeeded, failed, skipped, item.batch_id);
      kbDb.exec("COMMIT");
    } catch (claimErr) {
      try { kbDb.exec("ROLLBACK"); } catch { /* ignore */ }
      // D2b 安全审查：事件日志同样脱敏（异常消息可能携带路径/URL/密钥）
      recordEvent("error", "KB_RETRY", `重试 ${itemId} 认领异常：${redactSensitiveText(String((claimErr && claimErr.message) || claimErr)).slice(0, 200)}`);
      sendJson(response, 500, { error: "request_failed" }, request);
      return true;
    }
    // COMMIT 后：仅 owner 启动恰一个 worker（独立连接，自身 try 内打开，仅打开成功才关闭；
    // 打开失败不产生未处理拒绝，item 保持 processing 交给 15 分钟陈旧回收，只记安全事件）
    if (owner) {
      (async () => {
        let jobDb = null;
        try {
          jobDb = openKbDb(kbDbPath, { migrateSchema: false });
        } catch {
          recordEvent("error", "KB_RETRY", `重试 ${itemId} 打开数据库失败，交由陈旧 processing 回收`);
          return;
        }
        try {
          // 稳定元数据源只来自稳定 display_input；元宝仅补元数据，绝不下载/回退媒体
          const sourceUrl = isStableShareUrl(String(workerCtx.displayInput || "")) ? canonicalizeSourceUrl(String(workerCtx.displayInput)) : null;
          const ctx = { privDir: kbPrivDir, yuanbaoEnrich: sourceUrl ? resolveEnrich() : null, displayInput: workerCtx.displayInput, itemId };
          const startedAt = new Date().toISOString();
          try {
            // 可恢复本地文件路径一律走 adapterLocalFile（即便 input_kind 是 kuaidian）
            const receipt = await adapterLocalFile(workerCtx.input, { channel: "retry", sourceUrl, title: null });
            const r = await ingestOne(jobDb, {
              receipt, input: workerCtx.input, input_kind: workerCtx.inputKind, batchId: batchIdResp, ctx,
            });
            recountBatch(jobDb, batchIdResp);
            recordEvent(r.status === "success" ? "info" : "error", "KB_RETRY", `重试 ${itemId} → ${r.status}`);
          } catch (e) {
            // adapter/ingest 失败：恰 1 条净化 failed receipt + 同一 item failed + 重算同批次。
            // 净化先行：绝对路径/目录/临时 URL/token 绝不进入 error/receipt/observation/日志/API（仅稳定错误码+basename）。
            const errMsg = sanitizeRetryError(e, workerCtx.input);
            const failReceipt = makeFailReceipt({ channel: "retry", sourceUrl, title: null, error: errMsg, startedAt });
            jobDb.prepare("UPDATE import_item SET status='failed', error=?, updated_at=? WHERE id=?").run(`retry_failed: ${errMsg}`, new Date().toISOString(), itemId);
            recordReceipt(jobDb, failReceipt, { assetId: null, outcome: "retry_failed" });
            recountBatch(jobDb, batchIdResp);
            recordEvent("error", "KB_RETRY", `重试 ${itemId} 失败：${errMsg}`);
          }
        } finally {
          if (jobDb) jobDb.close(); // 仅打开成功才关闭
        }
      })().catch((e) => recordEvent("error", "KB_RETRY", `重试 ${itemId} 异常：${redactSensitiveText(String((e && e.message) || e)).slice(0, 200)}`));
    }
    sendJson(response, 202, { ok: true, itemId, batchId: batchIdResp }, request);
    return true;
  }

  // 重跑分析：幂等 upsert（不覆盖 available transcript/ocr；连续两次 200）
  if (request.method === "POST" && action === "analyze" && id) {
    if (!guardWrite(request, response)) return true;
    const detail = getVideoDetail(kbDb, id);
    if (!detail) { sendJson(response, 404, { error: "not_found" }, request); return true; }
    const { runContentAnalysis } = await import("./kb.mjs");
    await runContentAnalysis(kbDb, id, {
      title: detail.asset.title || "",
      media: detail.asset,
    });
    recordEvent("info", "KB_ANALYZE", `重新分析 ${id}`);
    sendJson(response, 200, { ok: true }, request);
    return true;
  }

  // 仅元数据刷新（A4.2.1）：不重新下载/复制/改媒体；只 upsert 平台帖 + 新增一次互动快照。
  // 无稳定来源 / 无可用 enricher / 解析失败 → 诚实 4xx/5xx；播放量拿不到保持 null，不猜。
  if (request.method === "POST" && action === "videos" && id && p.endsWith("/refresh-metadata")) {
    if (!guardWrite(request, response)) return true;
    const { json } = await readJsonBody(request, 100_000);
    const sourceUrl = String(json?.sourceUrl || "").trim().slice(0, 500) || null;
    const r = await refreshAssetMetadata(kbDb, id, sourceUrl, resolveEnrich());
    if (!r.ok) {
      sendJson(response, r.status || 400, r.error ? { error: r.error, ...(r.message ? { message: r.message } : {}) } : { error: "refresh_failed" }, request);
      return true;
    }
    sendJson(response, 200, { ok: true, contentId: r.contentId, snapshotAdded: r.snapshotAdded }, request);
    return true;
  }

  if (request.method === "PATCH" && action === "videos" && id) {
    if (!guardWrite(request, response)) return true;
    const { json } = await readJsonBody(request, 100_000);
    const field = json?.field;
    const value = json?.value;
    const reason = json?.reason || "manual";
    if (!field) { sendJson(response, 400, { error: "field_required" }, request); return true; }
    // editField 为 async（DB 更新后 await 磁盘同步；失败回滚并回明确错误，绝不吞掉）
    const r = await editField(kbDb, id, field, value, reason);
    sendJson(response, r.ok ? 200 : 400, r, request);
    return true;
  }

  return false;
}
