/* 织台 · MatrixMedia 受管外置引擎适配层
 * 只调用用户自行取得并安装到本机私有运行目录的官方 CLI，不启动独立 GUI、不监听 30088、Dock 不出现。
 * 账号、历史、登录会话仍沿用 MatrixMedia 官方数据格式和自动化引擎。
 */
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { canonicalPublicResultUrl } from "./content-lifecycle.mjs";
import { sanitizeFailureText } from "./kb.mjs";

export const MATRIX_BINARY = process.env.ZHITAI_MATRIX_BINARY
  || join(homedir(), ".local", "share", "zhitai-runtime", "engines", "matrixmedia.app", "Contents", "MacOS", "matrixmedia");
const CLI_TIMEOUT_MS = 120_000;
const PTY_WRAPPER = "/usr/bin/script";
const loginSessions = new Map();
const receiptMutationQueues = new Map();
const MAX_LOGIN_QR_BYTES = 2 * 1024 * 1024;
const LOGIN_TERMINATE_GRACE_MS = 400;
export const MATRIX_PARTITIONS_DIR = resolve(process.env.ZHITAI_MATRIX_PARTITIONS_DIR
  || join(homedir(), "Library", "Application Support", "matrix-video", "Partitions"));
const MATRIX_RUNTIME_DATA_DIR = resolve(process.env.ZHITAI_DATA_DIR
  || join(dirname(fileURLToPath(import.meta.url)), "data"));
export const MATRIX_AUTH_STATE_PATH = resolve(process.env.ZHITAI_MATRIX_AUTH_STATE_PATH
  || join(MATRIX_RUNTIME_DATA_DIR, "matrixmedia-auth-state.json"));
const SESSION_PLATFORMS = [
  { suffix: "抖音", code: "dy", platform: "抖音", cookie: "passport_assist_user" },
  { suffix: "视频号", code: "sph", platform: "视频号", cookie: "sessionid" },
];

const MATRIX_AUTH_STATES = new Set(["verified", "unverified", "invalid"]);
const MATRIX_PLATFORM_ALIASES = Object.freeze({
  dy: ["dy", "douyin", "抖音"],
  sph: ["sph", "channels", "wechat_channels", "视频号"],
});

export const PLATFORMS = [
  { code: "dy", name: "抖音", automated: true },
  { code: "tt", name: "今日头条", automated: true },
  { code: "ks", name: "快手", automated: true },
  { code: "blbl", name: "哔哩哔哩", automated: true },
  { code: "bjh", name: "百家号", automated: true },
  { code: "sph", name: "视频号", automated: true },
  { code: "xhs", name: "小红书", automated: true },
  { code: "fqsp", name: "番茄视频", automated: false, note: "官方引擎暂不支持自动化" },
];

export const CREATIVE_STATEMENTS = [
  { value: "none", label: "无" },
  { value: "ai_generated", label: "AI 生成" },
  { value: "fiction", label: "虚构内容" },
  { value: "marketing", label: "营销内容" },
  { value: "personal_opinion", label: "个人观点" },
  { value: "repost", label: "转载" },
  { value: "self_made_no_repost", label: "自制且禁止转载", onlyPlatforms: ["blbl"] },
];

// CLI 输出可能是日志 + JSON 混合；提取 JSON（数组或对象）
export function extractJson(out) {
  const trimmed = String(out || "").trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { /* fallthrough */ }
  // pretty JSON 数组可能跨多行，且 MatrixMedia 会在数组后继续打印
  // `[startup] ...`。不能用 lastIndexOf("]")，否则会把日志的右括号当成
  // JSON 结尾。只接受与顶层 `[` 缩进相同、独占一行的 `]`。
  const lines = trimmed.split(/\r?\n/);
  const arrayStart = lines.findIndex((line) => /^\s*\[$/.test(line));
  if (arrayStart >= 0) {
    const indent = /^\s*/.exec(lines[arrayStart])?.[0] || "";
    const arrayEnd = lines.findIndex((line, index) => index > arrayStart && line === `${indent}]`);
    if (arrayEnd > arrayStart) {
      try { return JSON.parse(lines.slice(arrayStart, arrayEnd + 1).join("\n")); } catch { /* continue */ }
    }
  }
  // 逐行：cli 的 JSON 是独立行（日志行如 [startup] ... 无法 parse）
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    if (l.startsWith("[") || l.startsWith("{")) {
      try { return JSON.parse(l); } catch { /* try next line */ }
    }
  }
  return null;
}

export const PUBLISH_RECEIPT_STATES = Object.freeze([
  "submitted",
  "scheduled",
  "draft",
  "public",
  "failed",
  "unknown",
]);

const PUBLISH_RECEIPT_MODES = new Set(["public", "draft", "scheduled"]);
const PUBLISH_RECEIPT_STATE_SET = new Set(PUBLISH_RECEIPT_STATES);

/**
 * 发布模式是调用意图，不等于平台终态。草稿优先于排期；公开调用只有拿到
 * 平台明确的 published/public 回执后，状态才允许升级为 public。
 */
export function publishModeFor({ draft = false, scheduledAt = null, publishAt = null } = {}) {
  if (scheduledAt || publishAt) return "scheduled";
  if (draft === true) return "draft";
  return "public";
}

function canonicalAccountIdentifier(value) {
  if (value && typeof value === "object") {
    if (value.accountFingerprint) return canonicalAccountIdentifier(value.accountFingerprint);
    if (value.partition) return canonicalAccountIdentifier(value.partition);
    if (value.phone) return canonicalAccountIdentifier(value.phone);
  }
  const raw = String(value || "").trim();
  if (/^acct_[a-f0-9]{24}$/.test(raw)) return raw;
  return raw;
}

/** 账本/API 只保存不可逆账号指纹；真实账号标识仅留在瞬时 CLI 参数中。 */
export function publishAccountFingerprint(platform, value) {
  const canonical = canonicalAccountIdentifier(value);
  if (/^acct_[a-f0-9]{24}$/.test(canonical)) return canonical;
  if (!canonical) throw new Error("publisher_receipt_account_required");
  return `acct_${createHash("sha256").update(`${String(platform || "").trim()}\0${canonical}`).digest("hex").slice(0, 24)}`;
}

function matrixPlatformCode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  for (const [code, aliases] of Object.entries(MATRIX_PLATFORM_ALIASES)) {
    if (aliases.some((alias) => normalized === alias || normalized.includes(alias))) return code;
  }
  return normalized;
}

function accountPhoneFromPartition(value) {
  const raw = String(value || "").replace(/^persist:/, "");
  for (const definition of SESSION_PLATFORMS) {
    if (!raw.endsWith(definition.suffix)) continue;
    const phone = raw.slice(0, -definition.suffix.length);
    if (/^1\d{10}$/.test(phone)) return phone;
  }
  return null;
}

function matrixLoginTarget(platform, phone) {
  const code = matrixPlatformCode(platform);
  const definition = SESSION_PLATFORMS.find((entry) => entry.code === code);
  const normalizedPhone = String(phone || "").trim();
  return {
    platform: code,
    phone: normalizedPhone,
    ...(definition ? { partition: `persist:${normalizedPhone}${definition.suffix}` } : {}),
  };
}

/**
 * 登录真值使用独立于发布回执的不可逆账号指纹。手机号只参与内存中的哈希，
 * 状态文件永远不会保存手机号、partition 或 Cookie 名称/值。
 */
export function matrixAuthAccountFingerprint(platform, account) {
  const code = matrixPlatformCode(platform || account?.platform);
  if (!code) throw new Error("matrix_auth_platform_required");
  let canonical = account;
  if (account && typeof account === "object") {
    const phone = String(account.phone || "").trim() || accountPhoneFromPartition(account.partition);
    canonical = phone || account.partition || account.account || account.accountFingerprint || "";
  }
  const raw = String(canonical || "").trim();
  if (/^auth_[a-f0-9]{32}$/.test(raw)) return raw;
  if (!raw) throw new Error("matrix_auth_account_required");
  return `auth_${createHash("sha256").update(`matrix-auth-v1\0${code}\0${raw}`).digest("hex").slice(0, 32)}`;
}

function cloneAuthValue(value) {
  return JSON.parse(JSON.stringify(value));
}

function safeAuthReasonCode(value, fallback) {
  const normalized = String(value || "").trim().toLowerCase();
  return /^[a-z][a-z0-9_:-]{0,63}$/.test(normalized) ? normalized : fallback;
}

/**
 * MatrixMedia 登录真值账本。只持久化平台代码、不可逆账号指纹、状态、固定原因码
 * 和时间戳；任何平台输出、手机号、partition、Cookie 元数据都不会落盘。
 */
export function createMatrixAuthStateStore({
  path = MATRIX_AUTH_STATE_PATH,
  now = () => new Date().toISOString(),
} = {}) {
  if (!path || typeof path !== "string") throw new Error("matrix_auth_state_path_required");
  let mutation = Promise.resolve();

  const timestamp = () => {
    const raw = typeof now === "function" ? now() : now;
    const parsed = raw instanceof Date ? raw : new Date(raw);
    if (Number.isNaN(parsed.getTime())) throw new Error("matrix_auth_state_clock_invalid");
    return parsed.toISOString();
  };

  const readState = async () => {
    let raw;
    try { raw = await readFile(path, "utf8"); }
    catch (error) {
      if (error?.code === "ENOENT") return { version: 1, accounts: [] };
      throw error;
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { throw new Error("matrix_auth_state_invalid_json"); }
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.accounts)) {
      throw new Error("matrix_auth_state_invalid_schema");
    }
    for (const record of parsed.accounts) {
      if (!record || !/^auth_[a-f0-9]{32}$/.test(String(record.account || ""))
        || !MATRIX_AUTH_STATES.has(record.authState)
        || !String(record.platform || "").trim()) {
        throw new Error("matrix_auth_state_invalid_record");
      }
    }
    return parsed;
  };

  const writeState = async (state) => {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, path);
  };

  const update = (platform, account, authState, reasonCode) => {
    if (!MATRIX_AUTH_STATES.has(authState)) throw new Error("matrix_auth_state_invalid");
    const code = matrixPlatformCode(platform || account?.platform);
    const fingerprint = matrixAuthAccountFingerprint(code, account);
    const safeReasonCode = safeAuthReasonCode(reasonCode, authState === "verified" ? "verified_operation" : "auth_failed");
    const operation = mutation.catch(() => {}).then(async () => {
      const state = await readState();
      const at = timestamp();
      let record = state.accounts.find((entry) => entry.platform === code && entry.account === fingerprint);
      if (!record) {
        record = { platform: code, account: fingerprint, authState, reasonCode: safeReasonCode, updatedAt: at };
        state.accounts.push(record);
      } else {
        record.authState = authState;
        record.reasonCode = safeReasonCode;
        record.updatedAt = at;
      }
      if (authState === "verified") {
        record.verifiedAt = at;
        delete record.invalidatedAt;
      } else if (authState === "invalid") {
        record.invalidatedAt = at;
      }
      await writeState(state);
      return cloneAuthValue(record);
    });
    mutation = operation.then(() => undefined, () => undefined);
    return operation;
  };

  return {
    path,
    async list() {
      await mutation.catch(() => {});
      return cloneAuthValue((await readState()).accounts);
    },
    async get(platform, account) {
      await mutation.catch(() => {});
      const code = matrixPlatformCode(platform || account?.platform);
      const fingerprint = matrixAuthAccountFingerprint(code, account);
      const record = (await readState()).accounts.find((entry) => entry.platform === code && entry.account === fingerprint);
      return record ? cloneAuthValue(record) : null;
    },
    markVerified(platform, account, reasonCode = "verified_operation") {
      return update(platform, account, "verified", String(reasonCode || "verified_operation"));
    },
    invalidate(platform, account, reasonCode = "auth_failed") {
      return update(platform, account, "invalid", String(reasonCode || "auth_failed"));
    },
  };
}

export const matrixAuthStateStore = createMatrixAuthStateStore();

function normalizedAuthPresentation(authState, reason = null) {
  if (authState === "verified") {
    return {
      authState,
      loginStatus: "已登录",
      loggedIn: true,
      readyForPublish: true,
      publishReady: true,
      reason: reason || "登录态已通过实际登录或发布验证",
    };
  }
  if (authState === "invalid") {
    return {
      authState,
      loginStatus: "登录失效",
      loggedIn: false,
      readyForPublish: false,
      publishReady: false,
      reason: reason || "平台已明确返回登录失效，需要重新登录",
    };
  }
  return {
    authState: "unverified",
    loginStatus: "待验证",
    loggedIn: false,
    readyForPublish: false,
    publishReady: false,
    reason: reason || "仅检测到账号或会话元数据，尚未通过实际登录或发布验证",
  };
}

/** 只有明确 verified 才允许进入发布链路；缺字段、旧状态和 Cookie 推断都关闭。 */
export function isMatrixAccountUsable(account) {
  return account?.authState === "verified"
    && account?.loggedIn === true
    && account?.readyForPublish === true
    && account?.publishReady === true
    && Boolean(account?.phone || account?.partition);
}

export function applyMatrixAuthRecord(account, record = null) {
  const current = account && typeof account === "object" ? account : {};
  const recordState = MATRIX_AUTH_STATES.has(record?.authState) ? record.authState : null;
  const currentState = MATRIX_AUTH_STATES.has(current.authState) ? current.authState : "unverified";
  // 持久记录来自成功 CLI 登录/平台接受发布或真实认证失败，优先级高于 Matrix
  // 账号树中的兼容状态文本；这样一次成功重新登录可以明确清除旧 invalid。
  const authState = recordState || currentState;
  const reason = recordState === "invalid"
    ? "平台已明确返回登录失效，需要重新登录"
    : recordState === "verified"
      ? "登录态已通过实际登录或发布验证"
      : current.reason;
  return {
    ...current,
    ...(recordState ? { authSource: "persistent_auth_state" } : {}),
    ...normalizedAuthPresentation(authState, reason),
    authReasonCode: record?.reasonCode || current.authReasonCode || null,
  };
}

/**
 * 只识别平台失败输出中的强登录证据。尤其是视频号实际会返回登录页重定向和
 * `[auth] 视频号登录状态已失效`；普通上传错误或内容中偶然出现“登录”不会误伤。
 */
export function classifyMatrixAuthFailure({ platform, code, out = "", err = "", state = null } = {}) {
  const platformCode = matrixPlatformCode(platform);
  const failed = !(code === 0 || code === "0") || state === "failed";
  if (!failed) return null;
  const text = String(`${err}\n${out}`)
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .slice(0, 40_000);
  if (platformCode === "sph") {
    if (/\[auth\][^\n]*(?:视频号)?登录状态已失效/i.test(text)
      || /登录态异常或未登录/i.test(text)
      || (/channels\.weixin\.qq\.com\/login(?:\.html)?/i.test(text)
        && /(?:重新登录|未登录|登录状态已失效|\[auth\])/i.test(text))) {
      return { invalid: true, reasonCode: "sph_login_redirect" };
    }
  }
  if (/^(?:not logged in|login expired|session expired|authentication required)\s*$/im.test(text)
    || /^\[auth\][^\n]*(?:重新登录|未登录|登录失效|登录状态已失效)/im.test(text)) {
    return { invalid: true, reasonCode: "platform_auth_failed" };
  }
  return null;
}

function normalizeScheduledAt(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Date.parse(String(value));
  if (Number.isNaN(parsed)) throw new Error("publisher_receipt_scheduled_at_invalid");
  return new Date(parsed).toISOString();
}

function cleanReceiptText(value, maxLength = 1_000) {
  const clean = sanitizeFailureText(String(value ?? "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/(?:\+?86[\s-]*)?1[3-9]\d(?:[\s-]*\d){8}/g, "[account]"))
    .trim();
  return clean ? clean.slice(0, maxLength) : null;
}

function validResultUrl(value) {
  return canonicalPublicResultUrl(value);
}

function resultObjects(parsed) {
  const rows = [];
  const queue = parsed && typeof parsed === "object" ? [parsed] : [];
  const seen = new Set();
  while (queue.length && rows.length < 20) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (!Array.isArray(current)) rows.push(current);
    for (const key of ["result", "data", "detail", "response", "receipt"]) {
      const nested = current[key];
      if (nested && typeof nested === "object") queue.push(nested);
    }
  }
  return rows;
}

function firstResultField(objects, keys) {
  for (const object of objects) {
    for (const key of keys) {
      if (object[key] !== null && object[key] !== undefined && object[key] !== "") return object[key];
    }
  }
  return null;
}

function structuredReceiptState(objects) {
  if (objects.some((object) => object.scheduled === true)) return "scheduled";
  const tokens = [];
  for (const object of objects) {
    for (const key of ["state", "resultState", "result_status", "resultStatus", "publishStatus", "publish_status", "status"]) {
      if (typeof object[key] === "string") tokens.push(object[key].trim().toLowerCase().replace(/[\s-]+/g, "_"));
    }
  }
  const includes = (values) => tokens.some((token) => values.includes(token));
  if (includes(["failed", "failure", "error", "rejected", "失败"])) return "failed";
  if (includes(["public", "published", "posted", "live", "已公开", "已发布"])) return "public";
  if (includes(["scheduled", "waiting_schedule", "waiting_scheduled_publish", "等待定时发布"])) return "scheduled";
  if (includes(["draft", "saved_draft", "platform_draft", "草稿", "已存草稿"])) return "draft";
  if (includes(["submitted", "accepted", "processing", "queued", "success", "ok"])) return "submitted";
  return includes(["unknown"]) ? "unknown" : null;
}

/**
 * MatrixMedia 的退出码 0 只能证明 CLI 成功完成，不能证明平台内容已经公开。
 * structured public/draft/scheduled 只作为候选证据保留，不能直接成为业务终态。
 */
export function classifyMatrixPublishResult({ code, out = "", err = "" } = {}, { mode = "public" } = {}) {
  const parsed = extractJson(out) || extractJson(err);
  const objects = resultObjects(parsed);
  const explicitState = structuredReceiptState(objects);
  const succeeded = code === 0 || code === "0";
  const savedDraftFallback = code === 4 || code === "4";
  let state;
  if (savedDraftFallback) state = mode === "draft" ? "submitted" : "draft";
  else if (!succeeded) state = "failed";
  else if (explicitState === "failed") state = "failed";
  else if (explicitState === "draft" && mode === "public") state = "draft";
  else state = "submitted";

  const taskId = cleanReceiptText(firstResultField(objects, ["taskId", "task_id", "scheduleId", "schedule_id", "platformTaskId", "id"]), 240);
  const postId = cleanReceiptText(firstResultField(objects, ["postId", "post_id", "noteId", "note_id", "itemId", "item_id", "awemeId", "aweme_id"]), 240);
  const resultUrl = validResultUrl(firstResultField(objects, ["resultUrl", "result_url", "postUrl", "post_url", "noteUrl", "note_url", "shareUrl", "share_url", "url"]));
  const parsedMessage = firstResultField(objects, ["platformMessage", "platform_message", "message", "msg"]);
  const platformMessage = cleanReceiptText(parsedMessage ?? err ?? out);
  const accepted = savedDraftFallback
    ? mode === "draft"
    : succeeded && !["failed", "unknown", "draft"].includes(state);
  return {
    state,
    accepted,
    source: "adapter_submission",
    receivedAt: new Date().toISOString(),
    platformMessage,
    ...(explicitState ? { adapterReportedState: explicitState } : {}),
    ...(taskId ? { taskId } : {}),
    ...(postId ? { postId } : {}),
    ...(resultUrl ? { resultUrl } : {}),
  };
}

export function publishReceiptDedupeKey({ platform, account, accountFingerprint, mediaSha256, mode, scheduledAt = null } = {}) {
  const normalizedMode = String(mode || "").trim();
  if (!PUBLISH_RECEIPT_MODES.has(normalizedMode)) throw new Error("publisher_receipt_mode_invalid");
  const sha = String(mediaSha256 || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error("publisher_receipt_media_sha256_invalid");
  const normalizedPlatform = String(platform || "").trim();
  const identity = [
    normalizedPlatform,
    publishAccountFingerprint(normalizedPlatform, accountFingerprint || account),
    sha,
    normalizedMode,
    normalizeScheduledAt(scheduledAt),
  ];
  if (!identity[0]) throw new Error("publisher_receipt_platform_required");
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function normalizeReceiptInput(input = {}) {
  const content = input.content && typeof input.content === "object" ? input.content : {};
  const mediaSha256 = String(input.mediaSha256 || content.mediaSha256 || "").trim().toLowerCase();
  const mode = String(input.mode || "").trim();
  const scheduledAt = normalizeScheduledAt(input.scheduledAt);
  const platform = String(input.platform || "").trim();
  const account = publishAccountFingerprint(platform, input.account);
  const dedupeKey = publishReceiptDedupeKey({ platform, account, mediaSha256, mode, scheduledAt });
  const state = String(input.state || "unknown").trim();
  if (!PUBLISH_RECEIPT_STATE_SET.has(state)) throw new Error("publisher_receipt_state_invalid");
  const jobId = cleanReceiptText(input.jobId, 240);
  if (!jobId) throw new Error("publisher_receipt_job_required");
  const taskId = cleanReceiptText(input.taskId, 240);
  const platformMessage = cleanReceiptText(input.platformMessage);
  const resultUrl = validResultUrl(input.resultUrl);
  const postId = cleanReceiptText(input.postId, 240);
  return {
    dedupeKey,
    platform,
    account,
    content: {
      id: cleanReceiptText(content.id, 240),
      title: cleanReceiptText(content.title, 500),
      mediaSha256,
    },
    mediaSha256,
    jobId,
    taskId,
    mode,
    scheduledAt,
    state,
    ...(platformMessage ? { platformMessage } : {}),
    ...(resultUrl ? { resultUrl } : {}),
    ...(postId ? { postId } : {}),
  };
}

function cloneReceipt(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeReceiptState(previous, next) {
  if (!next) return previous;
  if (previous === "public" && next !== "public") return previous;
  if (["draft", "scheduled"].includes(previous) && next === "submitted") return previous;
  return next;
}

/**
 * 凭据无关的本地发布回执账本。reserve 会在启动外部 CLI 之前原子占位；进程
 * 异常时留下 unknown，后续同一幂等键不会自动再次触发平台副作用。
 */
export function createPublishReceiptStore({ path, now = () => new Date().toISOString(), idFactory = randomUUID } = {}) {
  if (!path || typeof path !== "string") throw new Error("publisher_receipt_path_required");
  const ledgerPath = resolve(path);
  const lockPath = `${ledgerPath}.lock.sqlite`;

  const nowIso = () => {
    const value = typeof now === "function" ? now() : now;
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new Error("publisher_receipt_clock_invalid");
    return parsed.toISOString();
  };

  const readLedger = async () => {
    let raw;
    try {
      raw = await readFile(ledgerPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { version: 1, receipts: [] };
      throw error;
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { throw new Error("publisher_receipts_invalid_json"); }
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.receipts)) {
      throw new Error("publisher_receipts_invalid_schema");
    }
    return parsed;
  };

  const writeLedger = async (ledger) => {
    await mkdir(dirname(ledgerPath), { recursive: true });
    const temporary = `${ledgerPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, ledgerPath);
  };

  const withLedgerLock = async (operation) => {
    await mkdir(dirname(ledgerPath), { recursive: true });
    let lockDb = null;
    let inTransaction = false;
    try {
      // SQLite 的 OS 级文件锁会在进程退出时自动释放，不需要读取、判断或删除陈旧锁文件。
      // 同进程按 ledgerPath 排队，避免同步 busy wait 阻塞正在执行异步落盘的本进程持锁者。
      lockDb = new DatabaseSync(lockPath);
      await chmod(lockPath, 0o600);
      lockDb.exec("PRAGMA busy_timeout = 2500; BEGIN IMMEDIATE;");
      inTransaction = true;
      const output = await operation();
      lockDb.exec("COMMIT;");
      inTransaction = false;
      return output;
    } catch (error) {
      if (inTransaction) {
        try { lockDb.exec("ROLLBACK;"); } catch { /* close 仍会释放 OS 锁 */ }
      }
      if (/SQLITE_BUSY|database is locked/i.test(String(error?.code || error?.message || ""))) {
        throw new Error("publisher_receipt_store_locked");
      }
      throw error;
    } finally {
      try { lockDb?.close(); } catch { /* 关闭失败也不覆盖原始结果 */ }
    }
  };

  const mutate = (mutator) => {
    const previous = receiptMutationQueues.get(ledgerPath) || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => withLedgerLock(async () => {
        const ledger = await readLedger();
        const output = await mutator(ledger.receipts);
        await writeLedger(ledger);
        return output;
    }));
    const tail = operation.then(() => undefined, () => undefined);
    receiptMutationQueues.set(ledgerPath, tail);
    void tail.then(() => {
      if (receiptMutationQueues.get(ledgerPath) === tail) receiptMutationQueues.delete(ledgerPath);
    });
    return operation;
  };

  return {
    async list() {
      await (receiptMutationQueues.get(ledgerPath) || Promise.resolve());
      const ledger = await readLedger();
      return cloneReceipt(ledger.receipts);
    },

    reserve(input, { retryFailed = false } = {}) {
      const normalized = normalizeReceiptInput(input);
      return mutate((receipts) => {
        const existing = receipts.find((receipt) => receipt.dedupeKey === normalized.dedupeKey);
        if (existing) {
          if (retryFailed === true && existing.state === "failed") {
            existing.state = "unknown";
            existing.attemptCount = Math.max(1, Number(existing.attemptCount || 1)) + 1;
            existing.updatedAt = nowIso();
            return { created: true, retried: true, receipt: cloneReceipt(existing) };
          }
          return { created: false, receipt: cloneReceipt(existing) };
        }
        const timestamp = nowIso();
        const receipt = {
          id: `receipt_${idFactory()}`,
          ...normalized,
          attemptCount: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        receipts.unshift(receipt);
        return { created: true, receipt: cloneReceipt(receipt) };
      });
    },

    update(id, patch = {}) {
      return mutate((receipts) => {
        const receipt = receipts.find((candidate) => candidate.id === String(id || ""));
        if (!receipt) throw new Error("publisher_receipt_not_found");
        if (patch.state !== undefined) {
          const state = String(patch.state || "").trim();
          if (!PUBLISH_RECEIPT_STATE_SET.has(state)) throw new Error("publisher_receipt_state_invalid");
          receipt.state = mergeReceiptState(receipt.state, state);
        }
        if (patch.platformMessage !== undefined) {
          const value = cleanReceiptText(patch.platformMessage);
          if (value) receipt.platformMessage = value;
          else delete receipt.platformMessage;
        }
        if (patch.taskId !== undefined) receipt.taskId = cleanReceiptText(patch.taskId, 240);
        if (patch.postId !== undefined) {
          const value = cleanReceiptText(patch.postId, 240);
          if (value) receipt.postId = value;
          else delete receipt.postId;
        }
        if (patch.resultUrl !== undefined) {
          const value = validResultUrl(patch.resultUrl);
          if (value) receipt.resultUrl = value;
          else delete receipt.resultUrl;
        }
        receipt.updatedAt = nowIso();
        return cloneReceipt(receipt);
      });
    },
  };
}

export function runCli(args, timeoutMs = CLI_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(MATRIX_BINARY, buildMatrixCliArgs(args), {
        env: {
          PATH: process.env.PATH || "",
          HOME: process.env.HOME || "",
          LANG: process.env.LANG || "zh_CN.UTF-8",
          MATRIXMEDIA_DISABLE_TELEMETRY: "1",
          // 不继承 ELECTRON_RUN_AS_NODE：让 matrixmedia 以 Electron 模式跑 CLI
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      reject(new Error("matrixmedia_cli_spawn:" + e.message));
      return;
    }
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* noop */ }
      reject(new Error("matrixmedia_cli_timeout"));
    }, timeoutMs);
    child.once("error", (e) => { clearTimeout(timer); reject(new Error("matrixmedia_cli_spawn:" + e.message)); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

/**
 * MatrixMedia 在 Electron 主进程里通过 argv.indexOf("cli") 定位 CLI 子命令，
 * 因此 Chromium 静音开关必须放在 cli 之前，不能混进 CLI 自己的参数区。
 */
export function buildMatrixCliArgs(args = []) {
  const cliArgs = args[0] === "cli" ? args : ["cli", ...args];
  return ["--mute-audio", ...cliArgs];
}

export function applyMatrixAuthRecords(accounts, records = []) {
  const recordMap = new Map((Array.isArray(records) ? records : []).map((record) => [
    `${matrixPlatformCode(record?.platform)}|${String(record?.account || "")}`,
    record,
  ]));
  return (Array.isArray(accounts) ? accounts : []).map((account) => {
    let record = null;
    try {
      const platform = matrixPlatformCode(account?.platform);
      record = recordMap.get(`${platform}|${matrixAuthAccountFingerprint(platform, account)}`) || null;
    } catch { /* 无账号标识的展示行保持 unverified */ }
    return applyMatrixAuthRecord(account, record);
  });
}

export async function cliAccounts({ authStateStore = matrixAuthStateStore, run = runCli } = {}) {
  const { code, out, err } = await run(["accounts", "--json"]);
  const sessionAccounts = await discoverSessionAccounts();
  // MatrixMedia 的 GUI 账号树仍依赖它自己的数据目录。即使该目录瞬时不可读，
  // Electron 分区里的 Cookie 元数据只能证明本地存在会话材料，不能证明平台
  // 当前仍接受它；它只用于恢复账号候选，状态必须保持待验证。
  if (code !== 0 && sessionAccounts.length === 0) {
    throw new Error("matrixmedia_cli_accounts_failed：" + String(err || out).slice(-200));
  }
  const parsed = code === 0 ? extractJson(out) : [];
  // 官方 `cli login` 以目标 Cookie 落入 persist: 分区并 flush 为成功；
  // `cli accounts` 只遍历 GUI 账号树，纯 CLI 首次登录后可能仍返回 []。
  // 因此补充只读扫描分区 Cookie 元数据（只查名称/有效期，不读取值），让织台
  // 能显示账号候选；只有持久账本中的成功登录/成功发布证据才能把候选升级。
  const records = await authStateStore.list();
  const rows = applyMatrixAuthRecords([
    ...normalizeAccounts(Array.isArray(parsed) ? parsed : []),
    ...normalizeAccounts(sessionAccounts),
  ], records);
  const seen = new Set();
  return rows.filter((row) => {
    let key;
    try { key = `${matrixPlatformCode(row.platform)}|${matrixAuthAccountFingerprint(row.platform, row)}`; }
    catch { key = `${matrixPlatformCode(row.platform)}|${row.phone || row.partition || ""}`; }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function sessionAccountFromPartitionName(encodedName) {
  let decoded = "";
  try { decoded = decodeURIComponent(String(encodedName || "")); } catch { return null; }
  for (const definition of SESSION_PLATFORMS) {
    if (!decoded.endsWith(definition.suffix)) continue;
    const phone = decoded.slice(0, -definition.suffix.length);
    // 只自动恢复明确的手机号分区，忽略历史 fixture/测试/自定义名称。
    if (!/^1\d{10}$/.test(phone)) return null;
    return { ...definition, phone, partition: `persist:${decoded}` };
  }
  return null;
}

async function discoverSessionAccounts() {
  let entries = [];
  try { entries = await readdir(MATRIX_PARTITIONS_DIR, { withFileTypes: true }); } catch { return []; }
  const accounts = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const definition = sessionAccountFromPartitionName(entry.name);
    if (!definition) continue;
    let db = null;
    try {
      db = new DatabaseSync(join(MATRIX_PARTITIONS_DIR, entry.name, "Cookies"), { readOnly: true });
      const valid = db.prepare(`SELECT 1 AS ok FROM cookies
        WHERE name=? AND (length(value)>0 OR length(encrypted_value)>0)
          AND (expires_utc=0 OR expires_utc>((strftime('%s','now')+11644473600)*1000000))
        LIMIT 1`).get(definition.cookie);
      if (valid?.ok) accounts.push({
        platform: definition.platform,
        phone: definition.phone,
        partition: definition.partition,
        authSource: "partition_cookie_metadata",
        authState: "unverified",
        loginStatus: "待验证",
        loggedIn: false,
        readyForPublish: false,
        publishReady: false,
        reason: "仅检测到本地会话元数据，尚未通过实际登录或发布验证",
        error: null,
      });
    } catch { /* 分区正在切换或不是有效 Cookie DB */ }
    finally { try { db?.close(); } catch { /* noop */ } }
  }
  return accounts;
}

export async function cliHistory() {
  // 官方 history 默认只看 7 天；运营审计固定拉 30 天，避免跨周漏掉仍在等待的排期。
  const { code, out, err } = await runCli(["history", "--json", "--days", "30"]);
  if (code !== 0) throw new Error("matrixmedia_cli_history_failed：" + String(err || out).slice(-200));
  const parsed = extractJson(out);
  return Array.isArray(parsed) ? parsed : [];
}

/** 视频号短标题：6～16 个字，只保留文字和数字；无效时不传该可选参数。 */
export function normalizeChannelsShortTitle(value) {
  const clean = Array.from(String(value || "").normalize("NFKC"))
    .filter((character) => /[\p{L}\p{N}]/u.test(character))
    .join("");
  const characters = Array.from(clean);
  if (characters.length < 6) return null;
  return characters.slice(0, 16).join("");
}

export async function cliPublish(payload, { authStateStore = matrixAuthStateStore, run = runCli } = {}) {
  const results = [];
  const mode = publishModeFor({ draft: payload.draft === true, publishAt: payload.publishAt });
  for (const target of payload.platforms) {
    const args = ["publish", "-p", target.platform, "-f", payload.file, "-t", payload.title];
    if (target.phone) args.push("--phone", target.phone);
    if (target.partition) args.push("--partition", target.partition);
    const shortTitle = target.platform === "sph"
      ? normalizeChannelsShortTitle(payload.bt2)
      : payload.bt2;
    if (shortTitle) args.push("--bt2", shortTitle);
    if (Array.isArray(payload.tags) && payload.tags.length) args.push("--tags", payload.tags.join(" "));
    if (payload.publishAt) args.push("--publish-at", payload.publishAt);
    if (payload.draft) args.push("--draft");
    if (target.creativeStatement && target.creativeStatement !== "none") {
      args.push("--creative-statement", target.creativeStatement);
    }
    const { code, out, err } = await run(args, 30 * 60_000);
    const receipt = classifyMatrixPublishResult({ code, out, err }, { mode });
    const authFailure = classifyMatrixAuthFailure({ platform: target.platform, code, out, err, state: receipt.state });
    // 真实平台认证失败会覆盖任何旧的 Cookie/账号树推断；后续账号回读保持
    // fail-closed。反之，只有平台实际接受发布/草稿请求才建立 verified 真值。
    if (authFailure?.invalid) {
      await authStateStore.invalidate(target.platform, target, authFailure.reasonCode);
    } else if (receipt.accepted) {
      await authStateStore.markVerified(target.platform, target, "publish_accepted");
    }
    const account = publishAccountFingerprint(target.platform, target);
    results.push({
      platform: target.platform,
      account,
      success: receipt.accepted,
      status: receipt.state,
      state: receipt.state,
      message: receipt.platformMessage,
      platformMessage: receipt.platformMessage,
      source: receipt.source,
      receivedAt: receipt.receivedAt,
      ...(receipt.adapterReportedState ? { adapterReportedState: receipt.adapterReportedState } : {}),
      ...(receipt.taskId ? { taskId: receipt.taskId } : {}),
      ...(receipt.postId ? { postId: receipt.postId } : {}),
      ...(receipt.resultUrl ? { resultUrl: receipt.resultUrl } : {}),
    });
  }
  return {
    success: results.every((item) => item.success),
    businessSuccess: false,
    requiresReadback: true,
    total: results.length,
    results,
  };
}

function receiptResult(receipt, { deduplicated = false, success = null } = {}) {
  const accepted = success === null
    ? !["failed", "unknown"].includes(receipt.state)
    : Boolean(success) && !["failed", "unknown"].includes(receipt.state);
  return {
    platform: receipt.platform,
    account: receipt.account,
    success: accepted,
    status: receipt.state,
    state: receipt.state,
    receiptId: receipt.id,
    deduplicated,
    message: receipt.platformMessage,
    platformMessage: receipt.platformMessage,
    ...(receipt.taskId ? { taskId: receipt.taskId } : {}),
    ...(receipt.postId ? { postId: receipt.postId } : {}),
    ...(receipt.resultUrl ? { resultUrl: receipt.resultUrl } : {}),
  };
}

/**
 * 为每个平台目标先写 unknown 占位，再调用外部发布器。相同幂等键命中时直接
 * 返回既有回执，绝不会再次调用 publish；超时/异常也保留 unknown 供人工核对。
 */
export async function publishWithReceipts({
  payload,
  receiptStore,
  content,
  jobId = null,
  scheduledAt = null,
  retryFailed = false,
  publish = cliPublish,
} = {}) {
  if (!payload || !Array.isArray(payload.platforms)) throw new Error("publisher_payload_platforms_required");
  if (!receiptStore?.reserve || !receiptStore?.update) throw new Error("publisher_receipt_store_required");
  const normalizedScheduledAt = normalizeScheduledAt(scheduledAt || payload.publishAt || null);
  const mode = publishModeFor({ draft: payload.draft === true, scheduledAt: normalizedScheduledAt });
  const effectiveJobId = cleanReceiptText(jobId, 240) || `publish_${randomUUID()}`;
  const slots = new Array(payload.platforms.length);
  const pending = [];

  for (let index = 0; index < payload.platforms.length; index += 1) {
    const target = payload.platforms[index];
    const account = publishAccountFingerprint(target?.platform, target);
    const reservation = await receiptStore.reserve({
      platform: String(target?.platform || "").trim(),
      account,
      content,
      jobId: effectiveJobId,
      mode,
      scheduledAt: normalizedScheduledAt,
    }, { retryFailed });
    if (reservation.created) pending.push({ index, target, receipt: reservation.receipt });
    else slots[index] = receiptResult(reservation.receipt, { deduplicated: true });
  }

  if (pending.length) {
    let body;
    try {
      body = await publish({ ...payload, platforms: pending.map((entry) => entry.target) });
    } catch (error) {
      const platformMessage = cleanReceiptText(error?.message || error) || "matrixmedia_publish_outcome_unknown";
      for (const entry of pending) {
        const receipt = await receiptStore.update(entry.receipt.id, { state: "unknown", platformMessage });
        slots[entry.index] = receiptResult(receipt, { success: false });
      }
      return { success: false, total: slots.length, results: slots, message: platformMessage };
    }

    const rawResults = Array.isArray(body?.results) ? body.results : [];
    for (let pendingIndex = 0; pendingIndex < pending.length; pendingIndex += 1) {
      const entry = pending[pendingIndex];
      const raw = rawResults[pendingIndex];
      if (!raw || typeof raw !== "object") {
        const receipt = await receiptStore.update(entry.receipt.id, {
          state: "unknown",
          platformMessage: "matrixmedia_result_missing",
        });
        slots[entry.index] = receiptResult(receipt, { success: false });
        continue;
      }
      const rawState = String(raw.state || raw.status || "").trim();
      const state = PUBLISH_RECEIPT_STATE_SET.has(rawState)
        ? rawState
        : raw.success === false
          ? "failed"
          : mode === "draft"
            ? "draft"
            : mode === "scheduled"
              ? "scheduled"
              : "submitted";
      const receipt = await receiptStore.update(entry.receipt.id, {
        state,
        platformMessage: raw.platformMessage ?? raw.message ?? null,
        ...(raw.taskId ? { taskId: raw.taskId } : {}),
        ...(raw.postId ? { postId: raw.postId } : {}),
        ...(raw.resultUrl ? { resultUrl: raw.resultUrl } : {}),
      });
      slots[entry.index] = receiptResult(receipt, { success: raw.success !== false });
    }
  }

  return {
    success: slots.every((result) => result?.success === true),
    total: slots.length,
    results: slots,
  };
}

// MatrixMedia 0.11.x 的登录契约：
// - 抖音与视频号都可使用默认的 Electron/CDP 二维码抓取并把 PNG 写给织台；
// - 视频号不支持 --puppeteer-headless；
// - 关闭终端二维码却又不启用 Puppeteer 会被官方 CLI 直接以退出码 2 拒绝。
// 织台不需要把 ANSI 二维码展示到终端，但必须保留这条默认二维码通道，
// 再通过 --save-qr-png 把同一张二维码嵌入发布中心。
export function buildCliLoginArgs({ platform, phone, qrPath, timeoutSec = 900 }) {
  return [
    "cli", "login", "-p", platform, "--phone", String(phone).trim(),
    platform === "sph" ? "--show" : "--hide",
    "--save-qr-png", qrPath, "--timeout-sec", String(timeoutSec),
  ];
}

// MatrixMedia 在视频号新登录页未找到二维码时会把整页截图写入 --save-qr-png。
// 整页截图不能扫，也不能在织台里点击；只有近似正方形的 PNG 才当作二维码展示。
export function isLikelyQrPng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return false;
  if (buffer.toString("ascii", 1, 4) !== "PNG") return false;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width < 96 || height < 96 || width > 1024 || height > 1024) return false;
  return Math.abs(width - height) <= Math.max(width, height) * 0.2;
}

export function selectReusableLoginSession(sessions, { platform, phone } = {}) {
  const normalizedPlatform = matrixPlatformCode(platform);
  const normalizedPhone = String(phone || "").trim();
  if (!sessions || typeof sessions[Symbol.iterator] !== "function") return null;
  for (const session of sessions) {
    if (matrixPlatformCode(session?.platform) === normalizedPlatform
      && String(session?.phone || "").trim() === normalizedPhone
      && ["waiting_qr", "waiting_scan"].includes(session?.status)) {
      return session;
    }
  }
  return null;
}

export async function startCliLogin({ platform, phone, dataDir, authStateStore = matrixAuthStateStore }) {
  if (!["dy", "sph"].includes(platform)) throw new Error("login_platform_not_supported");
  if (!phone || !String(phone).trim()) throw new Error("login_account_required");
  if (!/^1\d{10}$/.test(String(phone).trim())) throw new Error("请输入11位手机号；MatrixMedia 用手机号作为登录态分区，不能填“测试”等名称");
  const active = selectReusableLoginSession(loginSessions.values(), { platform, phone });
  if (active) {
    return {
      id: active.id,
      platform: active.platform,
      status: active.status,
      message: active.message,
      interactionMode: active.interactionMode,
      reused: true,
    };
  }
  const id = randomUUID();
  const qrDir = resolve(dataDir, "matrix-login");
  await mkdir(qrDir, { recursive: true, mode: 0o700 });
  await chmod(qrDir, 0o700);
  const qrPath = join(qrDir, `${id}.png`);
  // 登录二维码等同短期认证凭证。先用私有权限占位，让外部 CLI 只覆盖
  // 这个 inode，避免生成过程短暂落成 0644。
  await writeFile(qrPath, Buffer.alloc(0), { flag: "wx", mode: 0o600 });
  await chmod(qrPath, 0o600);
  const args = buildMatrixCliArgs(buildCliLoginArgs({ platform, phone, qrPath }));
  const interactionMode = platform === "sph" ? "window" : "inline_qr";
  const session = {
    id, platform, phone: String(phone).trim(), status: "waiting_qr", qrPath, interactionMode,
    message: platform === "sph"
      ? "视频号官方登录窗口已打开；请在窗口内点击“微信快捷登录”，完成后会自动关闭"
      : "正在生成登录二维码…",
    updatedAt: Date.now(),
  };
  loginSessions.set(id, session);
  // MatrixMedia 的默认二维码通道要求 stdout 是 TTY。local-agent 自身没有可见终端，
  // 用 macOS 自带 script(1) 分配隐藏 PTY；二维码仍通过 --save-qr-png 回传织台。
  const child = spawn(PTY_WRAPPER, ["-q", "/dev/null", MATRIX_BINARY, ...args], {
    env: { PATH: process.env.PATH || "", HOME: process.env.HOME || "", LANG: process.env.LANG || "zh_CN.UTF-8", MATRIXMEDIA_DISABLE_TELEMETRY: "1" },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", () => {
    session.status = "waiting_scan";
    session.message = platform === "sph"
      ? "请在已打开的视频号官方窗口点击“微信快捷登录”，再按页面提示确认"
      : "请扫码登录";
    session.updatedAt = Date.now();
  });
  child.stderr.on("data", () => { session.updatedAt = Date.now(); });
  session.child = child;
  child.once("error", () => {
    session.status = "failed";
    session.message = "登录引擎启动失败，请稍后自动重试";
    session.updatedAt = Date.now();
    void unlink(session.qrPath).catch(() => {});
  });
  child.once("exit", async (code) => {
    if (code === 0) {
      // 官方契约：退出码 0 表示目标登录 Cookie 已检测到并 flush 到分区。
      // `cli accounts` 可能因 GUI 账号树尚未建行而返回空；cliAccounts 会从
      // 同一持久分区只读核验 Cookie 元数据，不能再把这种情况误报为失败。
      try {
        await authStateStore.markVerified(platform, matrixLoginTarget(platform, session.phone), "cli_login_success");
      } catch (error) {
        session.status = "failed";
        session.message = "平台登录已完成，但本机未能持久化登录验证状态；已停止发布，请重试登录";
        session.updatedAt = Date.now();
        session.child = null;
        await unlink(session.qrPath).catch(() => {});
        return;
      }
      try {
        await new Promise((resolve) => setTimeout(resolve, 800));
        const accounts = await cliAccounts({ authStateStore });
        const saved = accounts.some((account) => String(account.phone || "").split("-")[0] === session.phone);
        session.status = "success";
        session.message = saved ? "登录成功，账号已保存并可用于发布" : "登录成功，会话已保存；账号列表稍后自动刷新";
      } catch {
        session.status = "success";
        session.message = "登录成功，会话已由发布引擎保存并验证";
      }
    } else {
      session.status = code === 3 ? "expired" : "failed";
      session.message = code === 3 ? "二维码已过期，正在准备自动刷新" : "登录失败，已停止本次尝试并等待安全重试";
    }
    session.child = null;
    session.updatedAt = Date.now();
    await unlink(session.qrPath).catch(() => {});
  });
  return { id, platform, status: session.status, message: session.message, interactionMode };
}

function isPathInside(root, candidate) {
  const rel = relative(root, candidate);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`);
}

/**
 * 仅供本机恢复管理器使用。qrPath、qrBuffer 与 account 都不得进入 HTTP、
 * 日志或持久账本。
 */
export async function getCliLoginAsset(id) {
  const session = loginSessions.get(String(id));
  if (!session) return null;
  const qrRoot = resolve(dirname(session.qrPath));
  let qrPath = null;
  let qrBuffer = null;
  try {
    const info = await lstat(session.qrPath);
    if (!info.isFile() || info.isSymbolicLink() || info.size < 24 || info.size > MAX_LOGIN_QR_BYTES) {
      throw new Error("qr_asset_invalid");
    }
    const resolvedPath = await realpath(session.qrPath);
    if (!isPathInside(qrRoot, resolvedPath)) throw new Error("qr_asset_outside_root");
    await chmod(resolvedPath, 0o600);
    const png = await readFile(resolvedPath);
    if (!isLikelyQrPng(png)) throw new Error("qr_asset_not_scannable");
    qrPath = resolvedPath;
    qrBuffer = png;
  } catch { /* QR 尚未稳定生成，或仍是不可扫描的整页截图 */ }
  return {
    id: session.id,
    platform: session.platform,
    account: session.phone,
    status: session.status, message: session.message, interactionMode: session.interactionMode,
    qrPath,
    qrBuffer,
    qrReady: Boolean(qrPath && qrBuffer),
    updatedAt: new Date(session.updatedAt).toISOString(),
  };
}

/** 面向 HTTP/UI 的无凭证投影：不返回手机号、二维码内容或本机路径。 */
export async function getCliLogin(id) {
  const asset = await getCliLoginAsset(id);
  if (!asset) return null;
  return {
    id: asset.id,
    platform: asset.platform,
    status: asset.status,
    message: asset.qrReady ? "登录二维码已生成，正通过安全手机通道发送" : asset.message,
    interactionMode: asset.interactionMode,
    qrAvailable: asset.qrReady,
    updatedAt: asset.updatedAt,
  };
}

function cliChildRunning(child) {
  return Boolean(child && child.exitCode == null && child.signalCode == null);
}

function waitForCliChildExit(child, timeoutMs) {
  if (!cliChildRunning(child)) return Promise.resolve(true);
  return new Promise((resolveWait) => {
    let settled = false;
    let timer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener?.("exit", finish);
      resolveWait(!cliChildRunning(child));
    };
    child.once?.("exit", finish);
    timer = setTimeout(finish, Math.max(1, Math.floor(timeoutMs)));
  });
}

/** 先礼貌终止；短暂宽限后仍未退出则强杀，避免隐藏 Electron 残留播放。 */
export async function terminateMatrixCliChild(child, {
  graceMs = LOGIN_TERMINATE_GRACE_MS,
  killGraceMs = LOGIN_TERMINATE_GRACE_MS,
} = {}) {
  if (!cliChildRunning(child)) return true;
  try { child.kill("SIGTERM"); } catch { /* 继续检查真实退出状态 */ }
  if (await waitForCliChildExit(child, graceMs)) return true;
  try { child.kill("SIGKILL"); } catch { /* 由最终状态决定返回值 */ }
  await waitForCliChildExit(child, killGraceMs);
  return !cliChildRunning(child);
}

/** 终止并清理一条登录恢复会话；错误不包含本机路径。 */
export async function cleanupCliLogin(id, { terminate = false } = {}) {
  const key = String(id);
  const session = loginSessions.get(key);
  if (!session) return false;
  if (terminate && session.child) {
    await terminateMatrixCliChild(session.child);
    session.child = null;
  }
  await unlink(session.qrPath).catch(() => {});
  loginSessions.delete(key);
  return true;
}

// ISO → 本地 YYYY-MM-DD HH:mm:ss（官方 publishAt 契约）
export function formatPublishAt(iso) {
  if (!iso || Number.isNaN(Date.parse(iso))) return null;
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// cli accounts 原始数据 → 显式登录真值。任何缺省/旧格式均为 unverified；只有
// CLI 的明确正向字段或持久验证记录才能 readyForPublish=true。
export function normalizeAccounts(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    if (typeof entry === "string") {
      return {
        platform: entry,
        phone: null,
        partition: null,
        error: null,
        ...normalizedAuthPresentation("unverified"),
        authReasonCode: null,
      };
    }
    const r = entry && typeof entry === "object" ? entry : {};
    const authSource = String(r.authSource || r.auth_source || "").trim() || null;
    const statusText = `${r.loginStatus || ""} ${r.login_state || ""} ${r.status || ""} ${r.error || ""} ${r.reason || ""}`.toLowerCase();
    const explicitState = MATRIX_AUTH_STATES.has(r.authState) ? r.authState : null;
    const negative = (authSource !== "partition_cookie_metadata" && (
      r.loggedIn === false
      || r.isLoggedIn === false
      || r.readyForPublish === false && (r.loggedIn !== undefined || r.authState !== undefined)
    )) || /未登录|登录失效|offline|logged.?out|expired|invalid|auth(?:entication)? failed|重新登录|过期|退出/.test(statusText);
    const positive = r.loggedIn === true
      || r.isLoggedIn === true
      || r.readyForPublish === true
      || r.publishReady === true
      || /(?:^|\s)(?:online|logged.?in|authenticated|valid|success)(?:\s|$)|已登录/.test(statusText);
    const authState = negative
      ? "invalid"
      : authSource === "partition_cookie_metadata"
        ? "unverified"
        : explicitState || (positive ? "verified" : "unverified");
    const reason = String(r.reason || r.error || r.note || "").trim() || null;
    const normalized = {
      platform: String(r.platform || r.code || r.name || r.platformName || ""),
      phone: r.phone || r.mobile || null,
      partition: r.partition || r.session || null,
      error: r.error || r.note || null,
      ...(authSource ? { authSource } : {}),
      ...normalizedAuthPresentation(authState, reason),
      authReasonCode: r.authReasonCode || r.auth_reason_code || null,
    };
    return normalized;
  });
}
