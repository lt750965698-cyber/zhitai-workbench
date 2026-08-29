/**
 * downloader-adapter.mjs v4 — 织台统一下载通道适配器
 *
 * 通道分层：
 *   Primary   kuaidian          —— 原版快点去水印（downloadUrl 临时媒体直链 / 本地已下载 MP4）
 *   Watcher   mandian_fallback  —— 慢点知识库目录（回退产物）
 *   Watcher   local_unattributed—— Downloads 等不明来源
 *   Fallback  yuanbao_fallback  —— 仅快点失败/超时/无产物时启用，记录 fallbackReason
 *
 * v4（阶段 A2 契约）：
 *   - downloadUrl（临时媒体直链）与 sourceUrl（稳定 sph/sf 分享链接）严格分离；
 *     downloadUrl 永不落库/出 API；sourceUrl 必须 isStableShareUrl 白名单。
 *   - SSRF：lookup all:true，任一私网/保留地址拒绝；redirect:'manual' 每跳重校验 URL+DNS，
 *     限制跳数（≤5），拒绝跨协议。
 *   - 下载流式落临时文件：大小上限 + 超时 + 失败清理；所有临时产物（含 probe 异常）finally 清理。
 *   - 容器扫描按【真实文件偏移】遍历顶层 atoms（不拼接 head+tail），允许 mdat 在 moov 前；
 *     优先 ffprobe（可用时），否则 mvhd/mdls 兜底。
 *   - 新增 makeFailReceipt：adapter 前失败也生成收据，供 import_item/download_receipt/observation 记录。
 */
import { createHash } from "node:crypto";
import { chmod, stat, writeFile, mkdir, mkdtemp, rm, open } from "node:fs/promises";
import { constants as fsConstants, createReadStream } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lookup as dnsLookup } from "node:dns/promises";
import {
  parseFormattedCount,
  canonicalizeSourceUrl,
  containsSensitiveUrlMaterial,
  sanitizeMetadataValue,
  deriveContentId,
  isStableShareUrl,
} from "./content-metadata.mjs";

// re-export：测试与外部使用方统一从 adapter 导入
export { isStableShareUrl, canonicalizeSourceUrl, containsSensitiveUrlMaterial, deriveContentId };

const execFileP = promisify(execFile);
const MDLS = "/usr/bin/mdls";
const UA_DOWNLOAD = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const FFPROBE_CANDIDATES = [
  join(homedir(), ".local", "share", "zhitai-runtime", "engines", "ffmpeg", "ffprobe"),
  "/opt/homebrew/bin/ffprobe",
  "/usr/local/bin/ffprobe",
  "ffprobe",
];
const MAX_REDIRECTS = 5;

/* ─────────── DownloadReceipt ─────────── */
export function makeReceipt({ channel, sourceUrl = null, contentId = null, localPath = null, sha256 = null, mediaValidation = "unknown", startedAt, fallbackReason = null, rawRef = null, media = null, sizeBytes = null, title = null, temporary = false, temporaryRoot = null, validationEvidence = null, downloadUrl = null, error = null }) {
  return {
    channel,
    sourceUrl,          // 稳定分享链接（sph/sf），可为 null；绝不含 downloadUrl
    downloadUrl,        // 仅内部临时字段，绝不入库/返回 API（落库前剥除）
    contentId,
    localPath,
    sha256,
    mediaValidation,
    startedAt,
    completedAt: new Date().toISOString(),
    fallbackReason,
    rawRef,
    media,
    sizeBytes,
    title,
    temporary,          // localPath 是否临时文件（链接下载产物）
    temporaryRoot,      // 仅用于当前进程清理 mkdtemp 私有目录；绝不落库或返回 API
    validationEvidence, // { ftyp, moov, mdat, durationMs, source }
    error,              // adapter 前失败原因（仅用于 import_item/receipt 记录）
  };
}

/** adapter 前失败也生成收据（不携带 downloadUrl） */
export function makeFailReceipt({ channel, sourceUrl = null, title = null, error = null, fallbackReason = null, startedAt = new Date().toISOString() }) {
  return makeReceipt({ channel, sourceUrl, title, mediaValidation: "failed", error, fallbackReason, startedAt });
}

/* ─────────── SSRF 守卫（lookup all:true，任一私网拒绝） ─────────── */
export function isPrivateIp(ip) {
  if (!ip) return true;
  // 仅当是纯 IPv4 字面量（四段全数字 0-255）才走 IPv4 检查；否则落到 IPv6 分支
  const parts = ip.split(".").map(Number);
  if (parts.length === 4 && parts.every((p) => Number.isInteger(p) && p >= 0 && p <= 255)) {
    return parts[0] === 0 || parts[0] === 10 || parts[0] === 127
      || (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127)
      || (parts[0] === 169 && parts[1] === 254)
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 192 && parts[1] === 0 && parts[2] === 0)
      || (parts[0] === 198 && parts[1] === 18)
      || (parts[0] === 198 && parts[1] === 51 && parts[2] === 100)
      || (parts[0] === 203 && parts[1] === 0 && parts[2] === 113)
      || parts[0] >= 224;
  }
  if (ip.includes(":")) {
    // IPv6：unspecified(::)、环回、链路本地、唯一本地、multicast(ff00::/8)、文档保留、映射 IPv4 私网
    return /^::$/.test(ip)
      || /^::1$/.test(ip)
      || /^fe80:/i.test(ip)
      || /^fc[0-9a-f]{2}:/i.test(ip) || /^fd[0-9a-f]{2}:/i.test(ip)
      || /^ff[0-9a-f]{2}:/i.test(ip)
      || /^2001:db8:/i.test(ip)
      || /^::ffff:127\./.test(ip) || /^::ffff:10\./.test(ip) || /^::ffff:172\.(1[6-9]|2\d|3[01])\./.test(ip)
      || /^::ffff:192\.168\./.test(ip) || /^::ffff:(?:0|169\.254)\./.test(ip);
  }
  return false;
}

/** P1-9 可测纯函数：拒绝 HTTPS→HTTP（或任何 https 源到非 https）协议降级跳转 */
export function assertNoProtocolDowngrade(fromUrl, toUrl) {
  let from, to;
  try { from = new URL(fromUrl); to = new URL(toUrl, from); } catch { throw new Error("invalid_url"); }
  if (from.protocol === "https:" && to.protocol !== "https:") throw new Error("ssrf_protocol_downgrade");
  return to;
}

/**
 * 校验 URL 安全：协议 + host 黑名单 + DNS 全地址私网检查。
 * 返回规范化 URL 对象；不安全抛 Error("ssrf_blocked_*" / "dns_lookup_failed" / ...)。
 */
export async function assertSafeUrl(url) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error("invalid_url"); }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("unsupported_protocol");
  const host = parsed.hostname.toLowerCase();
  if (!host) throw new Error("no_host");
  if (/^localhost$|\.local$|\.internal$|\.lan$/.test(host)) throw new Error("ssrf_blocked_host");
  let addrs;
  try {
    addrs = await dnsLookup(host, { verbatim: true, all: true });
  } catch {
    // host 本身可能是 IP 字面量（dnsLookup 对 IP 直接返回）
    if (isPrivateIp(host)) throw new Error("ssrf_blocked_private_ip");
    throw new Error("dns_lookup_failed");
  }
  if (!Array.isArray(addrs) || !addrs.length) throw new Error("dns_lookup_failed");
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error("ssrf_blocked_private_ip");
  }
  return parsed;
}

/* ─────────── 文件工具 ─────────── */
export async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const s = createReadStream(filePath);
    s.on("data", (c) => hash.update(c));
    s.on("end", () => resolve(hash.digest("hex")));
    s.on("error", reject);
  });
}

async function mdlsValue(file, name) {
  try {
    const { stdout } = await execFileP(MDLS, ["-name", name, "-raw", file], { timeout: 10000 });
    const v = stdout.trim();
    return !v || v === "(null)" ? null : v;
  } catch {
    return null;
  }
}

/* ─────────── ffprobe（优先） ─────────── */
let ffprobePath = null;
async function findFfprobe() {
  for (const c of FFPROBE_CANDIDATES) {
    try { await execFileP(c, ["-version"], { timeout: 3000 }); return c; } catch { /* next */ }
  }
  return null;
}

async function probeWithFfprobe(filePath) {
  try {
    const { stdout } = await execFileP(ffprobePath, ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", filePath], { timeout: 20000 });
    const j = JSON.parse(stdout);
    const format = j.format || {};
    const video = (j.streams || []).find((s) => s.codec_type === "video");
    const audio = (j.streams || []).find((s) => s.codec_type === "audio");
    const durationMs = format.duration ? Math.round(Number(format.duration) * 1000) : null;
    const st = await stat(filePath);
    if (!format.format_name || !(durationMs > 0)) return null; // 非有效媒体 → 回退容器扫描
    return {
      sha256: await sha256File(filePath),
      size_bytes: st.size,
      duration_ms: durationMs,
      width: video?.width ?? null,
      height: video?.height ?? null,
      codec_video: video?.codec_name ?? null,
      codec_audio: audio?.codec_name ?? null,
      bitrate_kbps: format.bit_rate ? Math.round(Number(format.bit_rate) / 1000) : null,
      mediaValidation: "ok",
      hasFtyp: true,
      container: { ftyp: true, moov: true, mdat: true, durationMs, source: "ffprobe" },
    };
  } catch {
    return null;
  }
}

/* ─────────── 容器验证（真实文件偏移遍历顶层 atoms，允许 mdat 在 moov 前） ─────────── */
async function inspectContainer(filePath) {
  const fd = await open(filePath, "r");
  try {
    const { size } = await fd.stat();
    if (size < 32) return { ftyp: false, moov: false, mdat: false, durationMs: null, reason: "too_small" };
    const head = Buffer.alloc(8);
    await fd.read(head, 0, 8, 0);
    const ftyp = head.length >= 8 && head.subarray(4, 8).toString("latin1") === "ftyp";

    let offset = 0;
    let moov = false, mdat = false;
    let moovOffset = null, moovSize = null;
    const hdr = Buffer.alloc(16);
    for (let i = 0; i < 300 && offset + 8 <= size; i++) {
      await fd.read(hdr, 0, 16, offset);
      let atomSize = hdr.readUInt32BE(0);
      const type = hdr.toString("latin1", 4, 8);
      let headerLen = 8;
      if (atomSize === 1) {
        atomSize = Number(hdr.readBigUInt64BE(8));
        headerLen = 16;
      } else if (atomSize === 0) {
        atomSize = size - offset;
      }
      if (atomSize < headerLen || offset + atomSize > size) break;
      if (type === "moov") { moov = true; moovOffset = offset; moovSize = atomSize; }
      else if (type === "mdat") mdat = true;
      if (moov && mdat && moovOffset != null) break; // 已确认 moov+mdat，可提前退出
      offset += atomSize;
    }

    let durationMs = null;
    if (moovOffset != null) durationMs = await scanMvhdDurationAt(fd, moovOffset, moovSize);
    return { ftyp, moov, mdat, durationMs, reason: null };
  } finally {
    await fd.close();
  }
}

async function scanMvhdDurationAt(fd, moovStart, moovSize) {
  let off = moovStart + 8;
  const end = moovStart + moovSize;
  const hdr = Buffer.alloc(16);
  while (off + 8 <= end) {
    await fd.read(hdr, 0, 16, off);
    let size = hdr.readUInt32BE(0);
    const type = hdr.toString("latin1", 4, 8);
    let headerLen = 8;
    if (size === 1) { size = Number(hdr.readBigUInt64BE(8)); headerLen = 16; }
    else if (size === 0) size = end - off;
    if (size < headerLen || off + size > end) return null;
    if (type === "mvhd" && size >= 32) {
      const ver = Buffer.alloc(1);
      await fd.read(ver, 0, 1, off + 8);
      if (ver[0] === 0 && size >= 32) {
        const body = Buffer.alloc(24);
        await fd.read(body, 0, 24, off + 12);
        // mvhd v0：+20 timescale(4)，+24 duration(4)（相对 atom 起始）
        const timescale = body.readUInt32BE(8);
        const duration = body.readUInt32BE(12);
        if (timescale > 0 && duration > 0) return Math.round((duration / timescale) * 1000);
        return null;
      }
      if (ver[0] === 1 && size >= 40) {
        const body = Buffer.alloc(20);
        await fd.read(body, 0, 20, off + 28);
        // mvhd v1：+28 timescale(4)，+32 duration(8)
        const timescale = body.readUInt32BE(0);
        const duration = Number(body.readBigUInt64BE(4));
        if (timescale > 0 && duration > 0) return Math.round((duration / timescale) * 1000);
        return null;
      }
      return null;
    }
    off += size;
  }
  return null;
}

/**
 * 媒体探测 + 容器验证。
 * mediaValidation:
 *   ok        —— ffprobe 通过 或 ftyp + moov + mdat + 有效 duration（或 mdls duration）
 *   encrypted —— 无 ftyp（stodownload 加密流）
 *   invalid   —— 有 ftyp 但结构不完整/无有效 duration（伪造/损坏）
 */
export async function probeLocalMedia(filePath) {
  const st = await stat(filePath).catch(() => null);
  if (!st) throw new Error(`file_not_found:${filePath}`);
  const size = st.size;

  // 优先 ffprobe（真实解码层验证，非仅 4 字节 ftyp）
  if (!ffprobePath) ffprobePath = await findFfprobe();
  if (ffprobePath) {
    const r = await probeWithFfprobe(filePath);
    if (r) return r;
  }

  const sha256 = await sha256File(filePath);
  const container = await inspectContainer(filePath);

  let durationMs = null;
  let width = null, height = null, codecVideo = null, codecAudio = null, bitrate = null;
  // 仅容器结构通过后才读 mdls（避免对垃圾文件浪费时间）
  if (container.ftyp && container.moov) {
    const [dur, w, h, codecsRaw, br] = await Promise.all([
      mdlsValue(filePath, "kMDItemDurationSeconds"),
      mdlsValue(filePath, "kMDItemPixelWidth"),
      mdlsValue(filePath, "kMDItemPixelHeight"),
      mdlsValue(filePath, "kMDItemCodecs"),
      mdlsValue(filePath, "kMDItemTotalBitRate"),
    ]);
    durationMs = dur ? Math.round(Number(dur) * 1000) : container.durationMs;
    width = w ? Number(w) : null;
    height = h ? Number(h) : null;
    bitrate = br ? Number(br) : null;
    const codecs = [];
    if (codecsRaw) {
      for (const m of String(codecsRaw).matchAll(/"([^"]+)"/g)) codecs.push(m[1]);
      if (!codecs.length) codecs.push(...String(codecsRaw).split(",").map((s) => s.trim()).filter(Boolean));
    }
    codecVideo = codecs[0] || null;
    codecAudio = codecs[1] || null;
  }

  let mediaValidation;
  if (!container.ftyp) {
    mediaValidation = "encrypted"; // stodownload 加密流
  } else if (!container.moov || !container.mdat || !(durationMs > 0)) {
    mediaValidation = "invalid";   // 伪造 ftyp / 损坏
  } else {
    mediaValidation = "ok";
  }

  return {
    sha256,
    size_bytes: size,
    duration_ms: durationMs,
    width,
    height,
    codec_video: codecVideo,
    codec_audio: codecAudio,
    bitrate_kbps: bitrate,
    mediaValidation,
    hasFtyp: container.ftyp,
    container: { ftyp: container.ftyp, moov: container.moov, mdat: container.mdat, durationMs: container.durationMs, source: "container" },
  };
}

/* ─────────── 流式下载（大小上限 + 超时 + manual redirect 每跳校验 + 清理） ─────────── */
export async function downloadToTemp(url, { timeoutMs = 60000, maxBytes = 512 * 1024 * 1024, dir = tmpdir() } = {}) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporaryRoot = await mkdtemp(join(dir, "zhitai-kb-download-"));
  await chmod(temporaryRoot, 0o700);
  const tmpPath = join(temporaryRoot, "media.mp4");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let received = 0;
  try {
    let current = url;
    let redirects = 0;
    let resp = null;
    // 每跳都重新校验 URL + DNS（防重定向到私网）
    for (;;) {
      const safe = await assertSafeUrl(current);
      resp = await fetch(safe.toString(), {
        headers: { "User-Agent": UA_DOWNLOAD, Referer: "https://channels.weixin.qq.com/" },
        redirect: "manual",
        signal: controller.signal,
      });
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get("location");
        if (resp.body) await resp.body.cancel().catch(() => {});
        if (!loc) throw new Error("redirect_no_location");
        if (++redirects > MAX_REDIRECTS) throw new Error("too_many_redirects");
        // P1-9：拒绝 HTTPS→HTTP 协议降级跳转（可测纯函数）
        current = assertNoProtocolDowngrade(safe.toString(), loc).toString();
        continue;
      }
      break;
    }
    if (!resp.ok) throw new Error(`download_http_${resp.status}`);
    const declared = Number(resp.headers.get("content-length") || 0);
    if (declared > maxBytes) throw new Error("download_too_large");
    if (!resp.body) throw new Error("download_body_missing");
    const out = await open(tmpPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    const reader = resp.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > maxBytes) throw new Error("download_too_large");
        const chunk = Buffer.from(value);
        let offset = 0;
        while (offset < chunk.length) {
          const { bytesWritten } = await out.write(chunk, offset, chunk.length - offset);
          if (bytesWritten <= 0) throw new Error("download_write_failed");
          offset += bytesWritten;
        }
      }
    } finally {
      reader.releaseLock();
      await out.close().catch(() => {});
    }
    if (received < 10_000) throw new Error("download_too_small");
    return { path: tmpPath, sizeBytes: received, temporaryRoot };
  } catch (e) {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ─────────── 通道适配器 ─────────── */
/**
 * 快点通道：downloadUrl=临时媒体直链（永不当来源入库）；localPath=已下载 MP4；sourceUrl=稳定分享链接（可空）。
 * 返回 DownloadReceipt；mediaValidation 明确 ok/encrypted/invalid。
 * 任何异常（含 probe 失败）都会清理 temporary 文件。
 */
export async function adapterKuaidian({ downloadUrl = null, localPath = null, sourceUrl = null, title = null, content = null } = {}) {
  const startedAt = new Date().toISOString();
  let path = null;
  let temporary = false;
  let temporaryRoot = null;
  // 只有稳定平台分享链接才可作为 sourceUrl；CDN 直链/签名 URL 拒绝（元数据 unavailable）
  let safeSource = null;
  if (sourceUrl && isStableShareUrl(sourceUrl)) safeSource = canonicalizeSourceUrl(sourceUrl);
  try {
    if (localPath) {
      const st = await stat(localPath).catch(() => null);
      if (!st) throw new Error(`file_not_found:${localPath}`);
      if (!/\.(mp4|mov|m4v|webm)$/i.test(localPath)) throw new Error(`unsupported_file_type:${localPath}`);
      path = localPath;
    } else if (downloadUrl && /^https?:\/\//i.test(downloadUrl)) {
      const r = await downloadToTemp(downloadUrl);
      path = r.path;
      temporary = true;
      temporaryRoot = r.temporaryRoot;
    } else {
      throw new Error("no_download_source");
    }

    const media = await probeLocalMedia(path);
    const contentId = media.postId || deriveContentId(safeSource, "wechat_channels", {}) || null;
    return makeReceipt({
      channel: "kuaidian",
      sourceUrl: safeSource,
      downloadUrl: temporary ? downloadUrl : null, // 仅内部临时字段，落库前剥除
      contentId,
      localPath: path,
      sha256: media.sha256,
      mediaValidation: media.mediaValidation,
      startedAt,
      title: title || content || null,
      media,
      sizeBytes: media.size_bytes,
      temporary,
      temporaryRoot,
      validationEvidence: media.container || null,
    });
  } catch (e) {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
    else if (temporary && path) await rm(path, { force: true }).catch(() => {});
    throw e;
  }
}

/** 本地文件通道（watcher / 手动 / 迁移） */
export async function adapterLocalFile(localPath, { channel = "local", title = null, sourceUrl = null } = {}) {
  const startedAt = new Date().toISOString();
  const st = await stat(localPath).catch(() => null);
  if (!st) throw new Error(`file_not_found:${localPath}`);
  const media = await probeLocalMedia(localPath);
  return makeReceipt({
    channel,
    sourceUrl: sourceUrl && isStableShareUrl(sourceUrl) ? canonicalizeSourceUrl(sourceUrl) : null,
    contentId: deriveContentId(sourceUrl, "wechat_channels", {}) || null,
    localPath,
    sha256: media.sha256,
    mediaValidation: media.mediaValidation,
    startedAt,
    title,
    media,
    sizeBytes: media.size_bytes,
    temporary: false,
    validationEvidence: media.container || null,
  });
}

/** 回退通道：元宝解析（仅 fallback）；下载的加密流标 encrypted，不视为成功 */
export async function adapterFallbackYuanbao(sourceUrl, { yuanbaoParse, download = false } = {}) {
  const startedAt = new Date().toISOString();
  if (!yuanbaoParse) throw new Error("yuanbao_parse_unavailable");
  const parsed = await yuanbaoParse(sourceUrl);
  const media = parsed?.media || {};
  const videoUrl = media.videoUrl || null;
  let path = null;
  let temporary = false;
  let temporaryRoot = null;
  let mediaValidation = "unknown";
  let mediaInfo = null;
  if (videoUrl && download) {
    try {
      const r = await downloadToTemp(videoUrl);
      path = r.path;
      temporary = true;
      temporaryRoot = r.temporaryRoot;
      mediaInfo = await probeLocalMedia(path);
      mediaValidation = mediaInfo.mediaValidation; // 大概率 encrypted
    } catch {
      if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
      else if (temporary && path) await rm(path, { force: true }).catch(() => {});
      path = null;
      temporary = false;
      temporaryRoot = null;
      mediaValidation = "missing";
    }
  }
  return makeReceipt({
    channel: "yuanbao_fallback",
    sourceUrl: canonicalizeSourceUrl(sourceUrl) || null,
    downloadUrl: null, // 敏感直链不保留在 receipt 对外字段
    contentId: media.postId || deriveContentId(sourceUrl, "wechat_channels", parsed?.raw || {}) || null,
    localPath: path,
    sha256: mediaInfo?.sha256 || null,
    mediaValidation,
    startedAt,
    fallbackReason: "kuaidian_failed_or_no_output",
    rawRef: parsed?.raw || null,
    media: mediaInfo,
    sizeBytes: mediaInfo?.size_bytes || null,
    title: media.title || null,
    temporary,
    temporaryRoot,
  });
}

/* ─────────── 归一化 / 平台字段 ─────────── */
export function normalizeCount(input) {
  const p = parseFormattedCount(input);
  return { value: p.value, raw: p.raw, approximate: p.approximate };
}

/**
 * 平台字段适配（供 platform_post）：传入 enriched.media（元宝补元数据后的结构化字段），
 * 而非整个 enriched 对象。缺失一律 null。
 */
export function platformPostFrom(media, sourceUrl, titleFallback = "") {
  const like = normalizeCount(media?.likes);
  const fav = normalizeCount(media?.favorites ?? media?.fav);
  const comment = normalizeCount(media?.comments);
  const share = normalizeCount(media?.shares ?? media?.forward);
  const play = normalizeCount(media?.plays);
  return {
    postId: media?.postId || null,
    url: sourceUrl ? canonicalizeSourceUrl(sourceUrl) : null,
    author: media?.author || null,
    authorAvatarUrl: media?.authorAvatarUrl || media?.creator?.avatarUrl || null,
    authorCertIconUrl: media?.authorCertIconUrl || media?.creator?.certificationIconUrl || null,
    publishTime: media?.publishTime || null,
    title: media?.title || titleFallback,
    topics: Array.isArray(media?.topics) ? media.topics : null,
    music: media?.music || null,
    coverUrl: media?.coverUrl || null,
    platform: media?.platform || "wechat_channels",
    plays: play.value,
    plays_raw: play.raw,
    likes: like.value,
    likes_raw: like.raw,
    comments: comment.value,
    comments_raw: comment.raw,
    favorites: fav.value,
    favorites_raw: fav.raw,
    shares: share.value,
    shares_raw: share.raw,
    scalingInfo: media?.scalingInfo || null, // 版式信号，非拍摄角度
    fetchedAt: new Date().toISOString(),
  };
}

/** 脱敏原始响应：去除 videoUrl/decodeKey/token/encfilekey/cookie 等 */
export function sanitizeRawForStorage(raw) {
  const sanitized = sanitizeMetadataValue(raw);
  if (sanitized && typeof sanitized === "object") {
    return stripSensitiveUrlsDeep(sanitized, 0);
  }
  return sanitized;
}

function stripSensitiveUrlsDeep(value, depth) {
  if (depth > 6 || value === null || value === undefined) return value;
  if (typeof value === "string") {
    if (/^https?:\/\//i.test(value)) {
      return containsSensitiveUrlMaterial(value) ? canonicalizeSourceUrl(value) : value;
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => stripSensitiveUrlsDeep(v, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (/(videoUrl|playableUrl|decodeKey|decryptKey|encfilekey|cookie|token|signature)/i.test(k)) continue;
      out[k] = stripSensitiveUrlsDeep(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** 敏感原始数据落盘到非 Web 私有目录（0600），返回路径 */
export async function writePrivateRaw(privDir, assetId, raw) {
  if (!raw) return null;
  await mkdir(privDir, { recursive: true });
  const file = join(privDir, `${assetId}.json`);
  await writeFile(file, JSON.stringify(raw, null, 2), { mode: 0o600 });
  return file;
}

/** 不可逆 fingerprint（downloadUrl 落库前使用） */
export function redactUrlForStorage(input) {
  const raw = String(input || "");
  if (!raw) return null;
  return `[redacted:${createHash("sha256").update(raw).digest("hex").slice(0, 16)}]`;
}
