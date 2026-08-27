/**
 * 视频号转发卡片解析适配器。
 *
 * 复用 wx_channels_download 在本机提供的 HTTP API。该引擎通过微信视频号
 * 页面拿到登录态，本模块只向回环地址提交 objectId/objectNonceId，不接触
 * 微信 Cookie，也不把临时媒体 URL 写入任务或日志。
 */

const DEFAULT_BASE_URL = "http://127.0.0.1:2022";

function assertCardId(value, name, pattern, maxLength) {
  const text = String(value || "").trim();
  if (!text || text.length > maxLength || !pattern.test(text)) {
    throw new Error(`channels_card_invalid_${name}`);
  }
  return text;
}

function loopbackBase(value) {
  const parsed = new URL(value || DEFAULT_BASE_URL);
  if (!["127.0.0.1", "localhost", "::1"].includes(parsed.hostname.replace(/^\[|\]$/g, ""))) {
    throw new Error("channels_card_upstream_must_be_loopback");
  }
  if (parsed.protocol !== "http:") throw new Error("channels_card_upstream_must_be_http");
  return parsed.toString().replace(/\/$/, "");
}

async function getJson(url, timeoutMs) {
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    throw new Error("channels_card_engine_offline");
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`channels_card_invalid_response_${response.status}`);
  }
  if (!response.ok || Number(body?.code) !== 0) {
    throw new Error(`channels_card_profile_failed_${response.status}`);
  }
  return body;
}

function assertProfileResponse(body) {
  const rawCode = body?.data?.errCode;
  if (rawCode == null || String(rawCode).trim() === "") return;
  const codeText = String(rawCode).trim();
  if (!/^-?\d+$/.test(codeText)) {
    throw new Error("channels_card_profile_upstream_error");
  }
  const code = Number(codeText);
  if (!Number.isSafeInteger(code)) {
    throw new Error("channels_card_profile_upstream_error");
  }
  if (code === 0) return;
  if (code === -70003) {
    throw new Error("channels_card_profile_jsapi_jsonparse_failed");
  }
  // 上游 errMsg 可能含页面内容或临时鉴权信息。错误只保留数值码，
  // 禁止把 errMsg、媒体 URL 或 token 拼进任务日志。
  throw new Error(`channels_card_profile_upstream_${code}`);
}

function findFeedObject(value, depth = 0) {
  if (!value || typeof value !== "object" || depth > 7) return null;
  if (value.objectDesc && Array.isArray(value.objectDesc.media)) return value;
  for (const child of Object.values(value)) {
    const found = findFeedObject(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function findNumericField(value, names, depth = 0) {
  if (!value || typeof value !== "object" || depth > 6) return null;
  for (const name of names) {
    if (value[name] != null && Number.isFinite(Number(value[name]))) return Number(value[name]);
  }
  for (const child of Object.values(value)) {
    const found = findNumericField(child, names, depth + 1);
    if (found != null) return found;
  }
  return null;
}

function withUrlToken(url, token) {
  const base = String(url || "").trim();
  const suffix = String(token || "").trim();
  if (!base || !suffix || /[?&](?:token|svrnonce)=/i.test(base)) return base;
  if (suffix.startsWith("&") || suffix.startsWith("?")) return `${base}${suffix}`;
  return `${base}${base.includes("?") ? "&" : "?"}${suffix}`;
}

/**
 * 生成上游 wx_channels_download 的可选“原始视频” URL。
 *
 * 这个地址不能作为默认下载地址：腾讯 CDN 自 2026-08 起有部分视频
 * 强制校验 basedata/sign/svrnonce 等完整签名参数，裁剪后会直接返回 400。
 * 稳定路径始终优先使用完整签名 URL，本函数只作兼容候选。
 */
export function originalChannelsVideoUrl(url) {
  const parsed = new URL(String(url || ""));
  const encfilekey = parsed.searchParams.get("encfilekey");
  const token = parsed.searchParams.get("token");
  if (!encfilekey || !token) return parsed.toString();
  const original = new URL(`${parsed.origin}${parsed.pathname}`);
  original.searchParams.set("encfilekey", encfilekey);
  original.searchParams.set("token", token);
  return original.toString();
}

export async function getChannelsCardEngineStatus(options = {}) {
  const baseUrl = loopbackBase(options.baseUrl || process.env.ZHITAI_CHANNELS_CARD_URL || DEFAULT_BASE_URL);
  const body = await getJson(`${baseUrl}/api/channels/status`, Number(options.timeoutMs || 3_000));
  return { online: true, available: body?.data?.available === true };
}

export async function parseChannelsCard({ objectId, nonceId }, options = {}) {
  const oid = assertCardId(objectId, "object_id", /^[0-9]{6,32}$/, 32);
  const nid = assertCardId(nonceId, "nonce_id", /^[A-Za-z0-9_-]{1,240}$/, 240);
  const baseUrl = loopbackBase(options.baseUrl || process.env.ZHITAI_CHANNELS_CARD_URL || DEFAULT_BASE_URL);
  const status = await getChannelsCardEngineStatus({ baseUrl, timeoutMs: options.statusTimeoutMs });
  if (!status.available) throw new Error("channels_card_wechat_page_not_connected");

  const query = new URLSearchParams({ oid, nid });
  let body = null;
  let object = null;
  const attempts = Math.max(1, Math.min(4, Number(options.attempts || 3)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    body = await getJson(
      `${baseUrl}/api/channels/feed/profile?${query}`,
      Number(options.timeoutMs || 15_000),
    );
    assertProfileResponse(body);
    object = findFeedObject(body);
    if (object) break;
    if (attempt + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  if (!object) throw new Error("channels_card_object_missing");
  const mediaList = object.objectDesc.media.filter((item) => item && typeof item === "object");
  const video = mediaList.find((item) => Number(item.mediaType) === 4 && item.url)
    || mediaList.find((item) => item.url);
  if (!video) throw new Error("channels_card_media_missing");
  // urlToken 包含腾讯 CDN 当次请求所需的完整签名。默认地址必须保留全部
  // 参数；只剩 encfilekey+token 的“原始画质”地址在新 CDN 规则下可能 400。
  const videoUrl = withUrlToken(video.url, video.urlToken);
  const originalVideoUrl = originalChannelsVideoUrl(videoUrl);
  if (!/^https?:\/\//i.test(videoUrl)) throw new Error("channels_card_media_url_missing");

  return {
    shareUrl: `https://channels.weixin.qq.com/web/pages/feed?oid=${encodeURIComponent(oid)}&nid=${encodeURIComponent(nid)}`,
    exportId: oid,
    objectId: oid,
    objectNonceId: nid,
    observedAt: new Date().toISOString(),
    description: String(object.objectDesc.description || "").trim(),
    author: String(object.contact?.nickname || "").trim(),
    authorAvatar: String(object.contact?.headUrl || "").trim(),
    videoUrl,
    fallbackVideoUrls: originalVideoUrl === videoUrl ? [] : [originalVideoUrl],
    coverUrl: String(video.coverUrl || object.objectDesc.coverUrl || "").trim(),
    decodeKey: video.decodeKey == null ? "" : String(video.decodeKey),
    createtime: object.createtime ?? null,
    width: Number(video.width) || null,
    height: Number(video.height) || null,
    durationSeconds: Number(video.videoPlayLen) || null,
    sizeBytes: Number(video.fileSize) || null,
    stats: {
      like: findNumericField(body, ["likeCount", "like_count"]),
      fav: findNumericField(body, ["favCount", "favoriteCount", "fav_count"]),
      forward: findNumericField(body, ["forwardCount", "forward_count"]),
      comment: findNumericField(body, ["commentCount", "comment_count"]),
    },
    provenance: {
      resolver: "wx_channels_download",
      identity: "webwxsync.objectId+objectNonceId",
      media: "channels.feed.profile.objectDesc.media.original",
    },
  };
}
