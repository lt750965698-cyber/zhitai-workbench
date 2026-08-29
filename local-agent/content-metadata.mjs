import { spawn } from "node:child_process";
import { createHash } from "node:crypto";

const COUNT_MULTIPLIERS = new Map([
  ["千", 1_000],
  ["万", 10_000],
  ["亿", 100_000_000],
  ["k", 1_000],
  ["m", 1_000_000],
  ["b", 1_000_000_000],
]);

const SENSITIVE_QUERY_NAMES = new Set([
  "access_token",
  "authorization",
  "authkey",
  "auth_key",
  "credential",
  "credentials",
  "decode_key",
  "decodekey",
  "decrypt_key",
  "encfilekey",
  "expires",
  "key",
  "pass_ticket",
  "session",
  "session_id",
  "sessionid",
  "signature",
  "sig",
  "token",
  "ws_secret",
  "wssecret",
  "ws_time",
  "wstime",
  "x-cos-security-token",
  "x-oss-security-token",
  "x-oss-signature",
]);
/** AWS 风格签名参数前缀（X-Amz-* 等），大小写不敏感前缀匹配 */
const SENSITIVE_QUERY_PREFIXES = ["x-amz-", "x-cos-", "x-oss-"];

/** 敏感字段名精确集（统一分类器用）：复用 SENSITIVE_QUERY_NAMES，并补齐
 *  decodeKey/decryptKey/wsSecret/wsTime/cookie/api_key/apikey/secret/password/videoUrl/playableUrl/downloadUrl
 *  以及 auth/uskey/x-uskey（x-uskey 为元宝 live-browser 实际签名参数，恢复旧 D2 契约） */
const SENSITIVE_FIELD_EXACT = new Set([
  ...SENSITIVE_QUERY_NAMES,
  "decodekey", "decryptkey", "wssecret", "wstime", "cookie",
  "api_key", "apikey", "secret", "password",
  "videourl", "playableurl", "downloadurl",
  "auth", "uskey", "x-uskey",
]);

const URL_VALUE_CREDENTIAL_RE = /(?:^|[\s?&;,/])(?:bearer(?:\s+|[A-Za-z0-9._~+/-])|(?:access[_-]?token|auth(?:orization)?|cookie|credential|password|pass[_-]?ticket|secret|session(?:_?id)?|signature|sig|token|uskey|x-uskey|x-amz-signature|x-cos-signature|x-oss-security-token)\s*[=:])/i;
const URL_VALUE_PHONE_RE = /(?:\+?86[ -]?)?1[3-9]\d{9}/;
const URL_VALUE_PATH_RE = /(?:file:\/\/\/|(?:^|[\s=:])\/(?:Users|home|private|var|tmp|opt|srv)\/|[A-Za-z]:\\(?:Users|Documents|Desktop)\\|~\/)/i;
const URL_PATH_PRIVATE_SEGMENT_RE = /(?:^|\/)(?:Users|home|private|var|tmp|opt|srv)(?:\/|$)/i;
const URL_VALUE_HTML_RE = /<(?:html|body|script|style|div|span|p|a|img|video|article|section)\b/i;

function decodedQueryValue(value) {
  let decoded = String(value ?? "");
  for (let index = 0; index < 2; index += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  return decoded;
}

function queryValueHasSensitiveMaterial(value) {
  const decoded = decodedQueryValue(value);
  return URL_VALUE_CREDENTIAL_RE.test(decoded)
    || URL_VALUE_PHONE_RE.test(decoded)
    || URL_VALUE_PATH_RE.test(decoded)
    || URL_VALUE_HTML_RE.test(decoded);
}

/** 语义非凭据负例白名单（D2 终审）：cookiePolicy/tokenizer/monkey/oauth/ordinary_key/author/title
 *  即使含 cookie/token/key 子串也绝不判敏感（有界识别，不用无边界 contains） */
const SENSITIVE_FIELD_NEGATIVES = new Set([
  "monkey", "oauth", "ordinary_key", "author", "title", "cookiepolicy", "tokenizer",
]);

/** 完整语义段敏感词（下划线/短横/点/方括号 + camelCase 边界拆分后整段匹配）：
 *  authorizationHeader/cookieHeader/token_value/client_secret_value/my_auth/x_uskey 等命中 */
const SENSITIVE_SEGMENT_WORDS = new Set([
  "authorization", "cookie", "token", "secret", "password", "signature", "auth", "uskey",
]);

/**
 * 敏感字段名统一分类器（D2 安全，导出共享）：kb.mjs 的键到文本末尾脱敏器（assignment scanner）、
 * sanitizeReceiptValue 对象键、metadata/query 敏感名规则共用同一实现（isSensitiveMetadataKey /
 * isSensitiveQueryName 均委托本函数，不留多套策略）。覆盖：
 *   - 精确/别名：access_token/authkey/auth_key/decode_key/decodeKey/decrypt_key/decryptKey/encfilekey/
 *     ws_secret/wsSecret/ws_time/wsTime/cookie/authorization/signature/sig/key/api_key/apikey/token/
 *     secret/password/expires/videoUrl/playableUrl/downloadUrl/x-cos-security-token/x-oss-security-token/
 *     auth/uskey/x-uskey
 *   - 归一化（去非字母数字）后 endsWith token/secret/password/signature（clientSecret/my_api_token/user_signature 命中）
 *   - 归一化后 includes encfilekey/decodekey/decryptkey（原 query 规则保留）
 *   - 前缀 X-Amz-/x-cos-/x-oss-（大小写不敏感）
 *   - 完整语义段（_ - . [ ] 与 camelCase 边界）整段命中 authorization/cookie/token/secret/password/signature/auth/uskey
 *   - 负例白名单：monkey/oauth/ordinary_key/author/title/cookiePolicy/tokenizer → false（key 只精确匹配）
 */
export function isSensitiveFieldName(name) {
  const raw = String(name ?? "");
  if (!raw) return false;
  const lower = raw.toLowerCase();
  if (SENSITIVE_FIELD_NEGATIVES.has(lower)) return false;
  if (SENSITIVE_FIELD_EXACT.has(lower)) return true;
  if (SENSITIVE_QUERY_PREFIXES.some((p) => lower.startsWith(p))) return true;
  const normalized = raw.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (normalized.endsWith("token")
    || normalized.endsWith("secret")
    || normalized.endsWith("password")
    || normalized.endsWith("signature")) return true;
  if (normalized.includes("encfilekey") || normalized.includes("decodekey") || normalized.includes("decryptkey")) return true;
  // 完整语义段：先按标点（_ - . [ ]）分段；每段再按**真实 camel/acronym 边界**拆分
  // （lower/digit→Upper、acronym→CapitalizedWord），ALL_CAPS 段保持整体后 lower。
  // AUTH_HEADER→[auth,header]、X_USKEY→[x,uskey]、AUTHHeader→[auth,header]、
  // authorizationHeader→[authorization,header]；monkey/oauth/ordinary_key/cookiePolicy/tokenizer 不误伤。
  const segments = raw.split(/(?:_|-|\.|\[|\])+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)
      .map((seg) => seg.toLowerCase()));
  return segments.some((seg) => SENSITIVE_SEGMENT_WORDS.has(seg));
}

const MDLS_KEYS = [
  "kMDItemDurationSeconds",
  "kMDItemPixelWidth",
  "kMDItemPixelHeight",
  "kMDItemCodecs",
  "kMDItemAudioBitRate",
  "kMDItemVideoBitRate",
  "kMDItemTotalBitRate",
  "kMDItemAudioChannelCount",
  "kMDItemSampleRate",
  "kMDItemContentType",
  "kMDItemKind",
  "kMDItemMediaTypes",
];

export function parseFormattedCount(input) {
  if (input === null || input === undefined || input === "") {
    return { value: null, raw: null, approximate: false };
  }
  if (typeof input === "number") {
    return Number.isFinite(input) && input >= 0
      ? { value: Math.round(input), raw: String(input), approximate: false }
      : { value: null, raw: String(input), approximate: false };
  }

  const raw = String(input).trim();
  if (!raw || /^(?:--?|n\/?a|null|undefined)$/i.test(raw)) {
    return { value: null, raw: raw || null, approximate: false };
  }
  const normalized = raw.replace(/[\s,，]/g, "").replace(/\+$/, "");
  const match = normalized.match(/^(\d+(?:\.\d+)?)(千|万|亿|[kKmMbB])?$/);
  if (!match) return { value: null, raw, approximate: false };
  const multiplier = COUNT_MULTIPLIERS.get((match[2] || "").toLowerCase()) || 1;
  const value = Number(match[1]) * multiplier;
  if (!Number.isFinite(value)) return { value: null, raw, approximate: false };
  return {
    value: Math.round(value),
    raw,
    approximate: multiplier !== 1 || /\+$/.test(raw),
  };
}

export function buildStatsSnapshot(rawStats = {}, options = {}) {
  const observedAt = validIso(options.observedAt) || new Date().toISOString();
  const source = cleanString(options.source) || "not_provided";
  const provenance = objectValue(options.provenance) || {};
  const raw = objectValue(rawStats) || {};
  return {
    schemaVersion: 1,
    observedAt,
    source,
    provenance,
    counts: {
      like: metric(raw.like ?? raw.likes),
      favorite: metric(raw.fav ?? raw.favorite ?? raw.favorites),
      share: metric(raw.forward ?? raw.share ?? raw.shares),
      comment: metric(raw.comment ?? raw.comments),
      view: metric(raw.play ?? raw.playCount ?? raw.view ?? raw.views, "source_did_not_return_view_count"),
    },
  };
}

export function canonicalizeSourceUrl(input) {
  const raw = cleanString(input);
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return raw;
    url.hash = "";
    url.username = "";
    url.password = "";
    url.hostname = url.hostname.toLowerCase();
    const decodedPath = decodedQueryValue(url.pathname);
    if (queryValueHasSensitiveMaterial(decodedPath) || URL_PATH_PRIVATE_SEGMENT_RE.test(decodedPath)) {
      url.pathname = "/";
    }
    // 受支持的分享 URL 以路径中的平台 ID 作为稳定身份。查询参数不是身份所需，
    // 且任意看似普通的 key 都可被滥用为正文/凭据隐蔽通道，因此一律丢弃。
    if (hasStableSharePath(url)) {
      url.search = "";
      return url.toString();
    }
    const safeEntries = [...url.searchParams.entries()]
      .filter(([key, value]) => !isSensitiveQueryName(key) && !queryValueHasSensitiveMaterial(value));
    const sorted = safeEntries.sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue));
    url.search = "";
    for (const [key, value] of sorted) url.searchParams.append(key, value);
    return url.toString();
  } catch {
    return raw;
  }
}

export function containsSensitiveUrlMaterial(input) {
  const raw = cleanString(input);
  if (!raw) return false;
  try {
    const url = new URL(raw);
    if (url.username || url.password) return true;
    const decodedPath = decodedQueryValue(url.pathname);
    const decodedHash = decodedQueryValue(url.hash);
    if (queryValueHasSensitiveMaterial(decodedPath)
      || URL_PATH_PRIVATE_SEGMENT_RE.test(decodedPath)
      || queryValueHasSensitiveMaterial(decodedHash)
      || URL_PATH_PRIVATE_SEGMENT_RE.test(decodedHash)) return true;
    return [...url.searchParams.entries()]
      .some(([key, value]) => isSensitiveQueryName(key) || queryValueHasSensitiveMaterial(value));
  } catch {
    return /(?:^|[?&])(token|encfilekey|decode_?key|decrypt_?key|signature|authorization|access_token|credential|session(?:_?id)?|pass_ticket)=/i.test(raw)
      || queryValueHasSensitiveMaterial(raw);
  }
}

export function deriveContentId(sourceUrl, platform = "", upstream = {}) {
  const explicit = cleanString(upstream.contentId)
    || cleanString(upstream.feedId)
    || cleanString(upstream.itemId)
    || cleanString(upstream.exportId);
  if (explicit) return explicit;
  try {
    const url = new URL(sourceUrl);
    const path = url.pathname.replace(/\/+$/, "");
    const rules = [
      [/^\/sph\/([A-Za-z0-9_-]+)$/i, "sph"],
      [/^\/mobile\/sf\/([A-Za-z0-9_-]+)$/i, "sf"],
      [/\/video\/([A-Za-z0-9_-]+)$/i, "video"],
      [/\/(?:explore|discovery\/item)\/([A-Za-z0-9_-]+)$/i, "item"],
    ];
    for (const [pattern, prefix] of rules) {
      const match = path.match(pattern);
      if (match) return `${cleanString(platform) || url.hostname}:${prefix}:${match[1]}`;
    }
  } catch {
    // Non-URL sources intentionally have no derived platform content id.
  }
  return null;
}

export function buildMetadataV2(input = {}) {
  const capturedAt = validIso(input.capturedAt) || new Date().toISOString();
  const sourceUrl = canonicalizeSourceUrl(input.sourceUrl);
  const upstream = sanitizeMetadataValue(input.upstream) || {};
  const contentId = cleanString(input.contentId)
    || deriveContentId(sourceUrl, input.platform, upstream);
  const files = Array.isArray(input.files) ? input.files.map(normalizeFile).filter(Boolean) : [];
  const reportPath = cleanString(input.reportPath);
  const analysis = objectValue(input.analysis)
    || buildAnalysisCapabilities({ reportPath, reportMode: input.reportMode || "metadata_only" });
  const rawStats = objectValue(input.rawStats) || objectValue(upstream.stats) || {};
  const stats = objectValue(input.stats) || buildStatsSnapshot(rawStats, {
    observedAt: input.statsObservedAt || capturedAt,
    source: input.statsSource || "not_provided",
    provenance: input.statsProvenance || {},
  });
  const tags = uniqueStrings(input.tags, 40, 80);
  const author = cleanString(input.author) || cleanString(input.creator?.nickname) || "";
  const creator = {
    nickname: author || null,
    avatarUrl: safePublicUrl(input.creator?.avatarUrl),
    certificationIconUrl: safePublicUrl(input.creator?.certificationIconUrl),
  };
  const sourceKey = sourceUrl ? sha256Text(sourceUrl) : null;
  return {
    schemaVersion: 2,
    id: cleanString(input.id),
    identity: {
      contentId,
      sourceKey: sourceKey ? `sha256:${sourceKey}` : null,
      primaryAssetSha256: primaryAssetSha256(files),
    },
    title: cleanString(input.title) || "未命名内容",
    author,
    creator,
    platform: cleanString(input.platform) || "未知",
    contentKind: cleanString(input.contentKind) || "unknown",
    category: cleanString(input.category) || "其他",
    tags,
    source: {
      url: sourceUrl,
      receivedVia: cleanString(input.receivedVia) || "unknown",
    },
    publishedAt: validIso(input.publishedAt),
    capturedAt,
    authorization: cleanString(input.authorization) || "user_asserted",
    packagePath: cleanString(input.packagePath),
    sizeBytes: files.reduce((total, file) => total + Number(file.sizeBytes || 0), 0),
    files,
    stats,
    media: objectValue(input.media) || unavailableMedia("media_not_probed"),
    analysis,
    upstream,
    deduplication: objectValue(input.deduplication) || {
      status: "unique",
      checkedAt: capturedAt,
      matches: [],
    },
  };
}

export function sanitizeMetadataValue(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return null;
  if (["string", "number", "boolean"].includes(typeof value)) {
    if (typeof value !== "string") return value;
    return /^https?:\/\//i.test(value) ? canonicalizeSourceUrl(value) : value.slice(0, 10_000);
  }
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitizeMetadataValue(item, depth + 1));
  if (typeof value !== "object") return null;
  const sanitized = {};
  for (const [key, item] of Object.entries(value).slice(0, 300)) {
    if (isSensitiveMetadataKey(key)) continue;
    sanitized[key] = sanitizeMetadataValue(item, depth + 1);
  }
  return sanitized;
}

export function buildAnalysisCapabilities({ reportPath = null, reportMode = null } = {}) {
  return {
    schemaVersion: 1,
    report: reportPath
      ? {
          status: reportMode === "multimodal" ? "available" : "metadata_only",
          mode: reportMode || "metadata_only",
          path: reportPath,
        }
      : unavailable("analysis_report_not_generated", "analysis_pipeline"),
    transcript: {
      ...unavailable("asr_not_configured", "asr_engine"),
      language: null,
      text: null,
      segments: [],
    },
    ocr: {
      ...unavailable("ocr_not_configured", "ocr_engine"),
      cues: [],
    },
    shots: {
      ...unavailable("shot_analysis_not_configured", "shot_boundary_and_vision_model"),
      segments: [],
    },
    virality: {
      ...unavailable("multimodal_evidence_not_available", "multimodal_analysis_model"),
      hypotheses: [],
    },
  };
}

export async function probeMediaFile(filePath, options = {}) {
  if (!cleanString(filePath)) return unavailableMedia("media_file_missing");
  const ffprobe = await probeWithFfprobe(filePath, options);
  if (ffprobe.status === "available") return ffprobe;

  const mdls = await probeWithMdls(filePath, options);
  if (mdls.status === "available") {
    return {
      ...mdls,
      fallbackFrom: {
        source: "ffprobe",
        reason: ffprobe.reason || "ffprobe_unavailable",
      },
    };
  }
  return {
    ...unavailableMedia("media_probe_unavailable"),
    attempts: [
      { source: "ffprobe", reason: ffprobe.reason || "unavailable" },
      { source: "mdls", reason: mdls.reason || "unavailable" },
    ],
  };
}

export function parseFfprobePayload(payload) {
  const root = objectValue(payload);
  if (!root) return null;
  const streams = Array.isArray(root.streams) ? root.streams.map(objectValue).filter(Boolean) : [];
  const format = objectValue(root.format) || {};
  const video = streams.filter((stream) => stream.codec_type === "video").map((stream) => ({
    index: finiteNumber(stream.index),
    codec: cleanString(stream.codec_name),
    profile: cleanString(stream.profile),
    width: finiteNumber(stream.width),
    height: finiteNumber(stream.height),
    pixelFormat: cleanString(stream.pix_fmt),
    frameRate: rationalNumber(stream.avg_frame_rate || stream.r_frame_rate),
    durationSeconds: finiteNumber(stream.duration),
    bitRateBps: finiteNumber(stream.bit_rate),
  }));
  const audio = streams.filter((stream) => stream.codec_type === "audio").map((stream) => ({
    index: finiteNumber(stream.index),
    codec: cleanString(stream.codec_name),
    profile: cleanString(stream.profile),
    sampleRate: finiteNumber(stream.sample_rate),
    channels: finiteNumber(stream.channels),
    channelLayout: cleanString(stream.channel_layout),
    durationSeconds: finiteNumber(stream.duration),
    bitRateBps: finiteNumber(stream.bit_rate),
  }));
  if (!video.length && !audio.length && !cleanString(format.format_name)) return null;
  return {
    status: "available",
    source: "ffprobe",
    completeness: "full",
    observedAt: new Date().toISOString(),
    container: {
      format: cleanString(format.format_name),
      longName: cleanString(format.format_long_name),
      durationSeconds: finiteNumber(format.duration),
      sizeBytes: finiteNumber(format.size),
      bitRateBps: finiteNumber(format.bit_rate),
    },
    video,
    audio,
    raw: {
      format,
      streams,
    },
  };
}

export function parseMdlsValue(rawValue) {
  const raw = String(rawValue ?? "").trim();
  if (!raw || raw === "(null)") return null;
  if (raw.startsWith("(") && raw.endsWith(")")) {
    const quoted = [...raw.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((match) => match[1].replace(/\\"/g, '"'));
    if (quoted.length) return quoted;
    return raw.slice(1, -1).split(",").map((value) => value.trim()).filter(Boolean);
  }
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1).replace(/\\"/g, '"');
  if (/^-?\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
  return raw;
}

export function isoFromUnixSeconds(input) {
  const seconds = finiteNumber(input);
  if (seconds === null || seconds <= 0) return null;
  const date = new Date(seconds * 1_000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function probeWithFfprobe(filePath, options) {
  const command = cleanString(options.ffprobeCommand) || "ffprobe";
  const argsPrefix = Array.isArray(options.ffprobeArgsPrefix) ? options.ffprobeArgsPrefix.map(String) : [];
  const result = await runCapture(command, [
    ...argsPrefix,
    "-v", "error",
    "-print_format", "json",
    "-show_format",
    "-show_streams",
    filePath,
  ], Number(options.timeoutMs || 12_000));
  if (!result.ok) return unavailableMedia(result.reason === "command_missing" ? "ffprobe_not_installed" : "ffprobe_failed", "ffprobe");
  try {
    return parseFfprobePayload(JSON.parse(result.stdout)) || unavailableMedia("ffprobe_returned_no_media", "ffprobe");
  } catch {
    return unavailableMedia("ffprobe_invalid_json", "ffprobe");
  }
}

async function probeWithMdls(filePath, options) {
  if (process.platform !== "darwin" && !options.mdlsCommand) return unavailableMedia("mdls_not_supported", "mdls");
  const command = cleanString(options.mdlsCommand) || "/usr/bin/mdls";
  const values = await Promise.all(MDLS_KEYS.map(async (key) => {
    const result = await runCapture(command, ["-raw", "-name", key, filePath], Number(options.timeoutMs || 12_000));
    return [key, result.ok ? parseMdlsValue(result.stdout) : null];
  }));
  const metadata = Object.fromEntries(values);
  const durationSeconds = finiteNumber(metadata.kMDItemDurationSeconds);
  const width = finiteNumber(metadata.kMDItemPixelWidth);
  const height = finiteNumber(metadata.kMDItemPixelHeight);
  const codecs = Array.isArray(metadata.kMDItemCodecs)
    ? metadata.kMDItemCodecs.map(cleanString).filter(Boolean)
    : cleanString(metadata.kMDItemCodecs) ? [cleanString(metadata.kMDItemCodecs)] : [];
  if (durationSeconds === null && width === null && height === null && !codecs.length) {
    return unavailableMedia("mdls_returned_no_media", "mdls");
  }
  return {
    status: "available",
    source: "mdls",
    completeness: "partial",
    observedAt: new Date().toISOString(),
    limitations: ["mdls_does_not_expose_timed_frames_or_transcript"],
    container: {
      contentType: cleanString(metadata.kMDItemContentType),
      kind: cleanString(metadata.kMDItemKind),
      durationSeconds,
      bitRateBps: kiloBitsPerSecondToBitsPerSecond(metadata.kMDItemTotalBitRate),
      mediaTypes: Array.isArray(metadata.kMDItemMediaTypes) ? metadata.kMDItemMediaTypes.map(cleanString).filter(Boolean) : [],
    },
    video: width !== null || height !== null || codecs.length
      ? [{
          width,
          height,
          codecs,
          bitRateBps: kiloBitsPerSecondToBitsPerSecond(metadata.kMDItemVideoBitRate),
        }]
      : [],
    audio: metadata.kMDItemAudioBitRate !== null || metadata.kMDItemAudioChannelCount !== null || metadata.kMDItemSampleRate !== null
      ? [{
          bitRateBps: kiloBitsPerSecondToBitsPerSecond(metadata.kMDItemAudioBitRate),
          channels: finiteNumber(metadata.kMDItemAudioChannelCount),
          sampleRate: finiteNumber(metadata.kMDItemSampleRate),
        }]
      : [],
    raw: metadata,
  };
}

function metric(input, unavailableReason = "source_did_not_return_metric") {
  const parsed = parseFormattedCount(input);
  if (parsed.value === null) {
    return {
      status: "unavailable",
      value: null,
      raw: parsed.raw,
      approximate: false,
      reason: unavailableReason,
    };
  }
  return { status: "available", ...parsed };
}

function unavailable(reason, missingCapability) {
  return {
    status: "unavailable",
    reason,
    missingCapability,
    generatedAt: null,
    source: null,
  };
}

function unavailableMedia(reason, source = null) {
  return {
    status: "unavailable",
    source,
    completeness: "none",
    observedAt: new Date().toISOString(),
    reason,
    container: null,
    video: [],
    audio: [],
  };
}

function runCapture(command, args, timeoutMs) {
  return new Promise((resolvePromise) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    let child;
    try {
      child = spawn(command, args, {
        env: process.env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      finish({ ok: false, stdout: "", reason: "command_missing" });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, stdout, reason: "timeout" });
    }, Math.max(1_000, timeoutMs));
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > 2_000_000) child.kill("SIGKILL");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 64_000) child.kill("SIGKILL");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      finish({ ok: false, stdout, reason: error?.code === "ENOENT" ? "command_missing" : "spawn_failed" });
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      finish({ ok: code === 0 && stdout.length <= 2_000_000, stdout, reason: code === 0 ? null : "nonzero_exit" });
    });
  });
}

function rationalNumber(value) {
  const raw = cleanString(value);
  if (!raw) return null;
  const match = raw.match(/^(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/);
  if (match) {
    const denominator = Number(match[2]);
    return denominator ? Number(match[1]) / denominator : null;
  }
  return finiteNumber(raw);
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function kiloBitsPerSecondToBitsPerSecond(value) {
  const number = finiteNumber(value);
  return number === null ? null : number * 1_000;
}

function validIso(value) {
  const raw = cleanString(value);
  if (!raw) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function objectValue(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function normalizeFile(value) {
  const file = objectValue(value);
  if (!file) return null;
  const path = cleanString(file.path || file.relativePath);
  if (!path) return null;
  return {
    path,
    external: Boolean(file.external),
    sizeBytes: Math.max(0, finiteNumber(file.sizeBytes) || 0),
    sha256: /^[a-f0-9]{64}$/i.test(String(file.sha256 || "")) ? String(file.sha256).toLowerCase() : null,
    role: cleanString(file.role) || inferFileRole(path),
  };
}

function inferFileRole(path) {
  const normalized = String(path).toLowerCase();
  if (/cover|poster|thumb/.test(normalized) || /\.(jpe?g|png|webp|avif)$/.test(normalized)) return "cover";
  if (/\.(mp4|mov|m4v|webm|mkv)$/.test(normalized)) return "video";
  if (/\.(mp3|m4a|wav|aac|flac)$/.test(normalized)) return "audio";
  return "attachment";
}

function primaryAssetSha256(files) {
  return files.find((file) => ["video", "audio"].includes(file.role) && file.sha256)?.sha256
    || files.find((file) => file.sha256)?.sha256
    || null;
}

function uniqueStrings(values, maxItems, maxLength) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(cleanString).filter(Boolean).map((value) => value.slice(0, maxLength)))].slice(0, maxItems);
}

function safePublicUrl(value) {
  const raw = cleanString(value);
  return raw && /^https?:\/\//i.test(raw) ? canonicalizeSourceUrl(raw) : null;
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isSensitiveMetadataKey(value) {
  // D2 统一：委托 isSensitiveFieldName（不留多套策略）
  return isSensitiveFieldName(value);
}

function isSensitiveQueryName(value) {
  // D2 统一：委托 isSensitiveFieldName（覆盖原 SENSITIVE_QUERY_NAMES/endsWith token|signature/
  // includes encfilekey|decodekey|decryptkey/X-Amz-/x-cos-/x-oss- 前缀，且补 secret/password/endsWith secret 等）
  return isSensitiveFieldName(value);
}

/**
 * 判断是否为"稳定平台分享链接"（可作为 sourceUrl 入库/调元宝）。
 * 只接受明确平台分享 host + path（视频号 sph/sf、公众号、抖音短链、小红书短链等）；
 * 拒绝 CDN 直链 / 带签名参数的临时媒体 URL / 其他来源。
 */
export function isStableShareUrl(input) {
  const raw = cleanString(input);
  if (!raw) return false;
  let url;
  try { url = new URL(raw); } catch { return false; }
  if (!["http:", "https:"].includes(url.protocol)) return false;
  if (containsSensitiveUrlMaterial(raw)) return false;
  return hasStableSharePath(url);
}

function hasStableSharePath(url) {
  const host = url.hostname.toLowerCase();
  const path = url.pathname;
  // 视频号：weixin.qq.com/sph/xxx、channels.weixin.qq.com/mobile/sf/xxx、weixin.qq.com/s/xxx
  const wechatShare = (host === "weixin.qq.com" && /^\/(?:sph|sf|s)\/[A-Za-z0-9_-]+\/?$/i.test(path))
    || (host === "channels.weixin.qq.com" && /^\/mobile\/sf\/[A-Za-z0-9_-]+\/?$/i.test(path))
    || (host === "mp.weixin.qq.com" && /^\/s\/[A-Za-z0-9_-]+\/?$/i.test(path));
  // 抖音短链 / 小红书短链
  const dyShare = (host === "v.douyin.com" && /^\/[A-Za-z0-9_-]+\/?$/i.test(path))
    || (["douyin.com", "www.douyin.com", "m.douyin.com"].includes(host)
      && /^\/video\/[A-Za-z0-9_-]+\/?$/i.test(path));
  const xhsShare = (host === "xhslink.com" && /^\/[A-Za-z0-9_-]+\/?$/i.test(path))
    || (["xiaohongshu.com", "www.xiaohongshu.com"].includes(host)
      && /^\/(?:explore|discovery\/item)\/[A-Za-z0-9_-]+\/?$/i.test(path));
  return Boolean(wechatShare || dyShare || xhsShare);
}
