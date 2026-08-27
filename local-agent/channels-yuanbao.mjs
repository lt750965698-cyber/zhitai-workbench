#!/usr/bin/env node
/**
 * 织台 · 视频号原生解析下载模块（元宝通道）
 *
 * 从 x554960766/wechat-mp-tools 的 backend/channels.py 中提取核心协议，
 * 用 Node 原生重写，不再依赖那个 GUI 程序在后台运行。
 *
 * 协议两步：
 *   1) POST https://yuanbao.tencent.com/api/weixin/get_parse_result
 *      带元宝 Cookie，拿到 data.playable_url，从中解出 token / eid
 *   2) POST https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info
 *      带上 token / eid，拿到 data.feedInfo.videoUrl 等真实媒体信息
 *
 * 说明：finder-preview 预览接口返回的通常是明文直链（无 decodeKey），
 * 但部分场景会带 key，因此保留 ISAAC64 解密（前 128KB）兜底。
 */

import { readFile, writeFile, mkdir, rename, stat, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const AGENT_ROOT = dirname(fileURLToPath(import.meta.url));
const COOKIE_FILE = join(AGENT_ROOT, "yuanbao-cookie");
const GUI_SETTINGS_CANDIDATES = [
  join(homedir(), ".local/share/zhitai-runtime/engines/wechat-mp-tools/data/app_settings.json"),
  join(homedir(), "Library/Application Support/WeChat MP Tools/data/app_settings.json"),
];

const UA_DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const UA_DOWNLOAD =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const MASK = (1n << 64n) - 1n;

/* ────────────── ISAAC64（视频号加密视频前 128KB 解密） ────────────── */

class Isaac64 {
  constructor(keyUint64) {
    this.randCnt = 255;
    this.aa = 0n;
    this.bb = 0n;
    this.cc = 0n;
    this.seed = new Array(256).fill(0n);
    this.mm = new Array(256).fill(0n);
    this.seed[0] = BigInt(keyUint64) & MASK;
    this.init();
  }

  static mix(a, b, c, d, e, f, g, h) {
    a = (a - e) & MASK;
    f = (f ^ (h >> 9n)) & MASK;
    h = (h + a) & MASK;
    b = (b - f) & MASK;
    g = (g ^ ((a << 9n) & MASK)) & MASK;
    a = (a + b) & MASK;
    c = (c - g) & MASK;
    h = (h ^ (b >> 23n)) & MASK;
    b = (b + c) & MASK;
    d = (d - h) & MASK;
    a = (a ^ ((c << 15n) & MASK)) & MASK;
    c = (c + d) & MASK;
    e = (e - a) & MASK;
    b = (b ^ (d >> 14n)) & MASK;
    d = (d + e) & MASK;
    f = (f - b) & MASK;
    c = (c ^ ((e << 20n) & MASK)) & MASK;
    e = (e + f) & MASK;
    g = (g - c) & MASK;
    d = (d ^ (f >> 17n)) & MASK;
    f = (f + g) & MASK;
    h = (h - d) & MASK;
    e = (e ^ ((g << 14n) & MASK)) & MASK;
    g = (g + h) & MASK;
    return [a, b, c, d, e, f, g, h];
  }

  init() {
    const golden = 0x9e3779b97f4a7c13n;
    let v = [golden, golden, golden, golden, golden, golden, golden, golden];
    for (let i = 0; i < 4; i += 1) v = Isaac64.mix(...v);
    for (let i = 0; i < 256; i += 8) {
      for (let j = 0; j < 8; j += 1) v[j] = (v[j] + this.seed[i + j]) & MASK;
      v = Isaac64.mix(...v);
      for (let j = 0; j < 8; j += 1) this.mm[i + j] = v[j];
    }
    for (let i = 0; i < 256; i += 8) {
      for (let j = 0; j < 8; j += 1) v[j] = (v[j] + this.mm[i + j]) & MASK;
      v = Isaac64.mix(...v);
      for (let j = 0; j < 8; j += 1) this.mm[i + j] = v[j];
    }
    this.generate();
  }

  generate() {
    this.cc = (this.cc + 1n) & MASK;
    this.bb = (this.bb + this.cc) & MASK;
    for (let i = 0; i < 256; i += 1) {
      const rem = i % 4;
      if (rem === 0) this.aa = ~(this.aa ^ ((this.aa << 21n) & MASK)) & MASK;
      else if (rem === 1) this.aa = (this.aa ^ (this.aa >> 5n)) & MASK;
      else if (rem === 2) this.aa = (this.aa ^ ((this.aa << 12n) & MASK)) & MASK;
      else this.aa = (this.aa ^ (this.aa >> 33n)) & MASK;
      this.aa = (this.aa + this.mm[(i + 128) % 256]) & MASK;
      const x = this.mm[i];
      const y = (this.mm[Number((x >> 3n) % 256n)] + this.aa + this.bb) & MASK;
      this.mm[i] = y;
      this.bb = (this.mm[Number((y >> 11n) % 256n)] + x) & MASK;
      this.seed[i] = this.bb;
    }
  }

  next() {
    const result = this.seed[this.randCnt];
    if (this.randCnt === 0) {
      this.generate();
      this.randCnt = 255;
    } else {
      this.randCnt -= 1;
    }
    return result;
  }
}

export function decryptChannelsBuffer(buffer, key, encLen = 131072) {
  if (!buffer.length) return buffer;
  const limit = Math.min(buffer.length, encLen);
  const rng = new Isaac64(key);
  const chunk = Buffer.alloc(8);
  for (let i = 0; i < limit; i += 8) {
    chunk.writeBigUInt64BE(rng.next());
    for (let j = 0; j < 8; j += 1) {
      const idx = i + j;
      if (idx >= limit) return buffer;
      buffer[idx] ^= chunk[j];
    }
  }
  return buffer;
}

/* ────────────── 元宝 Cookie 读取 ────────────── */

export async function loadYuanbaoCookie() {
  try {
    const raw = (await readFile(COOKIE_FILE, "utf8")).trim();
    if (raw) return raw;
  } catch {
    /* 落到 GUI 配置回退 */
  }
  const guiCookie = await readGuiCookie();
  if (guiCookie) return guiCookie;
  throw new Error("yuanbao_cookie_missing");
}

export async function saveYuanbaoCookie(cookie) {
  const value = String(cookie || "").trim();
  if (!value) throw new Error("yuanbao_cookie_empty");
  await writeFile(COOKIE_FILE, `${value}\n`, { mode: 0o600 });
  return COOKIE_FILE;
}

/* ────────────── 解析 ────────────── */

export function extractShareUrl(input) {
  const text = String(input || "").trim();
  const sph = text.match(/https?:\/\/weixin\.qq\.com\/sph\/[A-Za-z0-9]+/);
  if (sph) return sph[0];
  const sf = text.match(/https?:\/\/channels\.weixin\.qq\.com\/mobile\/sf\/[A-Za-z0-9_]+/);
  if (sf) return sf[0];
  const any = text.match(/https?:\/\/\S+/);
  return any ? any[0] : text;
}

function generateRid() {
  const ts = Math.floor(Date.now() / 1000).toString(16);
  let rnd = "";
  for (let i = 0; i < 8; i += 1) rnd += "0123456789abcdef"[Math.floor(Math.random() * 16)];
  return `${ts}-${rnd}`;
}

async function postJson(url, { headers, body, timeoutMs = 20000 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* 非 JSON 返回 */
    }
    return { status: response.status, json, text };
  } finally {
    clearTimeout(timer);
  }
}

/** 第一步：元宝解析分享链接，拿 token / eid */
export async function yuanbaoResolve(shareUrl, cookie) {
  const { status, json, text } = await postJson("https://yuanbao.tencent.com/api/weixin/get_parse_result", {
    headers: {
      accept: "application/json, text/plain, */*",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      origin: "https://yuanbao.tencent.com",
      referer: "https://yuanbao.tencent.com/chat",
      "user-agent": UA_DESKTOP,
      cookie,
      "x-source": "web",
    },
    body: { type: "video_channel_url", url: shareUrl, scene: 1 },
  });

  if (status !== 200) throw new Error(`yuanbao_http_${status}`);
  if (!json) throw new Error(`yuanbao_bad_response:${text.slice(0, 120)}`);
  const playable = json?.data?.playable_url;
  if (!playable) {
    const reason = json.msg || json.error || "cookie 可能已失效";
    throw new Error(`yuanbao_parse_failed:${reason}`);
  }

  const params = new URL(playable).searchParams;
  const token = params.get("token") || "";
  const exportId = params.get("eid") || "";
  if (!token || !exportId) throw new Error("yuanbao_token_missing");

  return {
    token,
    exportId,
    hint: {
      author: json.data.author || "",
      authorIcon: json.data.author_icon || "",
      authorCertificationIcon: json.data.author_certification_icon || "",
      desc: json.data.desc || "",
      coverUrl: json.data.cover_url || "",
      wxExportId: json.data.wx_export_id || exportId,
    },
  };
}

/** 第二步：拿视频号 feed 真实媒体信息 */
export async function fetchFeedInfo(token, exportId) {
  const api =
    `https://channels.weixin.qq.com/finder-preview/api/feed/get_feed_info` +
    `?_rid=${generateRid()}&_pageUrl=https%3A%2F%2Fchannels.weixin.qq.com%2Ffinder-preview%2Fpages%2Ffeed`;
  const referer =
    `https://channels.weixin.qq.com/finder-preview/pages/feed` +
    `?entry_card_type=48&comment_scene=39&appid=0` +
    `&token=${encodeURIComponent(token)}&entry_scene=0&eid=${encodeURIComponent(exportId)}`;

  const { status, json, text } = await postJson(api, {
    headers: {
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      Origin: "https://channels.weixin.qq.com",
      Referer: referer,
      "User-Agent": UA_DESKTOP,
    },
    body: { baseReq: { generalToken: token }, exportId },
  });

  if (![200, 201].includes(status)) throw new Error(`channels_http_${status}`);
  if (!json) throw new Error(`channels_bad_response:${text.slice(0, 120)}`);
  return json;
}

/** 从 feed 响应中抽取媒体信息（兼容元宝本地格式与云端 Worker 平铺格式） */
export function extractMedia(feed, hint = {}) {
  const data = feed?.data || {};
  const info = data.feedInfo || {};
  const author = data.authorInfo || {};

  const videoUrl =
    info.h264VideoInfo?.videoUrl ||
    info.videoUrl ||
    info.h265VideoInfo?.videoUrl ||
    // 云端 Worker 回退格式
    feed?.video_url_h264 ||
    feed?.video_url_h265 ||
    feed?.url ||
    "";

  const decodeKey =
    info.h264VideoInfo?.decodeKey ||
    info.decodeKey ||
    feed?.decode_key ||
    feed?.decrypt_key ||
    null;

  return {
    videoUrl,
    decodeKey: decodeKey ? String(decodeKey) : null,
    description: info.description || feed?.description || hint.desc || "",
    author: author.nickname || feed?.username || feed?.author || hint.author || "",
    creator: {
      nickname: author.nickname || feed?.username || feed?.author || hint.author || "",
      avatarUrl: author.headImgUrl || feed?.author_icon || hint.authorIcon || "",
      certificationIconUrl: author.authIconUrl || feed?.author_certification_icon || hint.authorCertificationIcon || "",
    },
    coverUrl: info.coverUrl || feed?.cover_url || hint.coverUrl || "",
    createtime: info.createtime || feed?.createtime || "",
    mediaType: info.mediaType ?? feed?.mediaType ?? null,
    isHardAd: info.isHardAd ?? feed?.isHardAd ?? null,
    sourceFields: {
      description: info.description != null ? "feedInfo.description" : hint.desc ? "yuanbao.desc" : null,
      creator: author.nickname != null ? "authorInfo.nickname" : hint.author ? "yuanbao.author" : null,
      cover: info.coverUrl != null ? "feedInfo.coverUrl" : hint.coverUrl ? "yuanbao.cover_url" : null,
      stats: "feedInfo.*CountFmt",
    },
    stats: {
      like: info.likeCountFmt ?? "",
      fav: info.favCountFmt ?? "",
      forward: info.forwardCountFmt ?? "",
      comment: info.commentCountFmt ?? "",
    },
  };
}

/** 读取 GUI 程序里的元宝 Cookie（用户重新扫码登录后会更新到这里） */
async function readGuiCookie() {
  for (const path of GUI_SETTINGS_CANDIDATES) {
    try {
      const settings = JSON.parse(await readFile(path, "utf8"));
      const cookie = String(settings.yuanbao_cookie || "").trim();
      if (cookie) return cookie;
    } catch {
      /* 继续尝试另一种安装路径 */
    }
  }
  return null;
}

/**
 * 完整解析：短链 → 媒体信息
 * Cookie 过期时自动回退到 GUI 程序中的最新 Cookie，成功后回写本地，
 * 这样你在那个程序里重新扫码登录一次即可，无需手动同步。
 */
export async function parseChannelsVideo(input, cookie) {
  const shareUrl = extractShareUrl(input);
  const primary = cookie || (await loadYuanbaoCookie());

  let resolved;
  try {
    resolved = await yuanbaoResolve(shareUrl, primary);
  } catch (error) {
    const recoverable = /yuanbao_parse_failed|yuanbao_http_(401|403)|yuanbao_token_missing/.test(error.message);
    const fresh = recoverable ? await readGuiCookie() : null;
    if (!fresh || fresh === primary) throw error;
    resolved = await yuanbaoResolve(shareUrl, fresh);
    await saveYuanbaoCookie(fresh).catch(() => {});
  }

  const feed = await fetchFeedInfo(resolved.token, resolved.exportId);
  const media = extractMedia(feed, resolved.hint);
  if (!media.videoUrl) throw new Error("channels_media_url_missing");
  return {
    shareUrl,
    exportId: resolved.hint.wxExportId || resolved.exportId,
    observedAt: new Date().toISOString(),
    ...media,
  };
}

/* ────────────── 下载 ────────────── */

export function sanitizeFilename(desc, createtime) {
  const clean = String(desc || "")
    .replace(/[\\/:*?"<>|\r\n]/g, "")
    .trim();
  if (clean) return `${clean.slice(0, 100)}.mp4`;
  if (createtime) {
    const d = new Date(Number(createtime) * 1000);
    if (!Number.isNaN(d.getTime())) {
      const p = (n) => String(n).padStart(2, "0");
      return `video_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.mp4`;
    }
  }
  return `video_${Date.now()}.mp4`;
}

async function uniquePath(dir, filename) {
  let candidate = join(dir, filename);
  const dot = filename.lastIndexOf(".");
  const base = dot > 0 ? filename.slice(0, dot) : filename;
  const ext = dot > 0 ? filename.slice(dot) : "";
  let n = 1;
  for (;;) {
    try {
      await stat(candidate);
      candidate = join(dir, `${base}_${n}${ext}`);
      n += 1;
    } catch {
      return candidate;
    }
  }
}

/** 下载视频到目标目录，必要时执行前 128KB 解密 */
export async function downloadChannelsVideo(media, targetDir, { onProgress } = {}) {
  await mkdir(targetDir, { recursive: true });
  const filename = sanitizeFilename(media.description, media.createtime);
  const finalPath = await uniquePath(targetDir, filename);
  const tempPath = `${finalPath}.part`;
  let total = 0;
  const candidates = [media.videoUrl, ...(Array.isArray(media.fallbackVideoUrls) ? media.fallbackVideoUrls : [])]
    .map((value) => String(value || "").trim())
    .filter((value, index, values) => /^https?:\/\//i.test(value) && values.indexOf(value) === index);
  if (!candidates.length) throw new Error("channels_media_url_missing");

  let lastError = null;
  for (const candidate of candidates) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 300000);
    try {
      await rm(tempPath, { force: true }).catch(() => {});
      const response = await fetch(candidate, {
        headers: { "User-Agent": UA_DOWNLOAD, Referer: "https://channels.weixin.qq.com/" },
        signal: controller.signal,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new Error(`download_http_${response.status}`);
      }
      total = Number(response.headers.get("content-length") || 0);

      let received = 0;
      const source = Readable.fromWeb(response.body);
      source.on("data", (chunk) => {
        received += chunk.length;
        if (typeof onProgress === "function" && total) {
          onProgress(Math.min(1, received / total));
        }
      });
      await pipeline(source, createWriteStream(tempPath));
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      await rm(tempPath, { force: true }).catch(() => {});
    } finally {
      clearTimeout(timer);
    }
  }
  if (lastError) throw lastError;

  if (media.decodeKey && /^\d+$/.test(media.decodeKey) && BigInt(media.decodeKey) > 0n) {
    const fs = await import("node:fs/promises");
    const handle = await fs.open(tempPath, "r+");
    try {
      const size = (await handle.stat()).size;
      const len = Math.min(size, 131072);
      const buffer = Buffer.alloc(len);
      await handle.read(buffer, 0, len, 0);
      decryptChannelsBuffer(buffer, BigInt(media.decodeKey));
      await handle.write(buffer, 0, len, 0);
    } finally {
      await handle.close();
    }
  }

  await rename(tempPath, finalPath);
  const finalSize = (await stat(finalPath)).size;
  return { path: finalPath, filename: finalPath.split("/").pop(), size: finalSize, expected: total };
}

/** 一步到位：链接 → 落地文件 */
export async function ingestChannelsVideo(input, targetDir, options = {}) {
  const media = await parseChannelsVideo(input, options.cookie);
  const saved = await downloadChannelsVideo(media, targetDir, options);
  return { media, saved };
}

/* ────────────── CLI ────────────── */

if (process.argv[1] && process.argv[1].endsWith("channels-yuanbao.mjs")) {
  const [, , command, ...rest] = process.argv;
  const run = async () => {
    if (command === "set-cookie") {
      const path = await saveYuanbaoCookie(rest.join(" "));
      console.log(JSON.stringify({ ok: true, saved: path }));
      return;
    }
    if (command === "sync-cookie") {
      const cookie = await readGuiCookie();
      if (!cookie) throw new Error("yuanbao_gui_cookie_missing");
      const path = await saveYuanbaoCookie(cookie);
      console.log(JSON.stringify({ ok: true, saved: path, length: cookie.length }));
      return;
    }
    if (command === "parse") {
      const media = await parseChannelsVideo(rest[0]);
      console.log(JSON.stringify(media, null, 2));
      return;
    }
    if (command === "download") {
      const dir = rest[1] || process.env.ZHITAI_KB_ROOT || join(homedir(), "KnowledgeHub", "内容库");
      const result = await ingestChannelsVideo(rest[0], dir);
      console.log(JSON.stringify({ ok: true, ...result }, null, 2));
      return;
    }
    console.log("用法: channels-yuanbao.mjs <sync-cookie|set-cookie <cookie>|parse <url>|download <url> [目录]>");
    process.exitCode = 1;
  };
  run().catch((error) => {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  });
}
