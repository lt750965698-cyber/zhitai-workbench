/* 织台 · 小红书图文发布适配层
 * 复用 xpzouying/xiaohongshu-mcp 的本地 HTTP API；账号隔离、按需进程与
 * Bearer 鉴权由 xiaohongshu-accounts.mjs 统一负责。
 */
import {
  DEFAULT_XHS_ACCOUNT_ID,
  createAccountRecord,
  ensureAccountEngine,
  listAccountRecords,
  requestAccount,
  resolveAccount,
  xhsAccountRuntimeSummary,
} from "./xiaohongshu-accounts.mjs";

export const XHS_PUBLISHER_URL = `http://127.0.0.1:${Number(process.env.ZHITAI_XHS_DEFAULT_PORT || 18_060)}`;
export const XHS_AI_DECLARATION_BLOCKED = "blocked_ai_declaration";
const publishTails = new Map();

function safeMessage(value) {
  return String(value || "未知错误").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
}

function blockedAIContentDeclaration(message, {
  beforeExternalCall = false,
  externalCallStarted = !beforeExternalCall,
} = {}) {
  const error = new Error(safeMessage(message || "小红书 AI 合成内容声明未通过平台控件回读"));
  error.code = XHS_AI_DECLARATION_BLOCKED;
  error.status = XHS_AI_DECLARATION_BLOCKED;
  error.beforeExternalCall = beforeExternalCall === true;
  error.retryableBeforeExternalCall = beforeExternalCall === true;
  error.externalCallStarted = externalCallStarted === true;
  return error;
}

async function request(accountId, path, { method = "GET", body, timeoutMs = 30_000 } = {}) {
  let response;
  try {
    response = await requestAccount(accountId, path, {
      method,
      headers: body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new Error("小红书图文引擎未连接：" + safeMessage(error?.message || error));
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success === false) {
    const detailMessage = payload?.details && typeof payload.details === "object"
      ? payload.details.message
      : null;
    const blockedAI = payload?.code === "BLOCKED_AI_DECLARATION"
      || payload?.details?.status === XHS_AI_DECLARATION_BLOCKED
      || payload?.details?.reason === XHS_AI_DECLARATION_BLOCKED;
    const beforeExternalCall = payload?.details?.before_external_call === true;
    const error = blockedAI
      ? blockedAIContentDeclaration(
        detailMessage || payload?.error || payload?.message || `HTTP ${response.status}`,
        { beforeExternalCall, externalCallStarted: !beforeExternalCall },
      )
      : new Error(safeMessage(detailMessage || payload?.error || payload?.message || `HTTP ${response.status}`));
    if (beforeExternalCall) {
      error.beforeExternalCall = true;
      error.retryableBeforeExternalCall = true;
      error.externalCallStarted = false;
    }
    throw error;
  }
  return payload;
}

async function serializeAccountPublish(accountId, operation) {
  const previous = publishTails.get(accountId) || Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  publishTails.set(accountId, current);
  try {
    return await current;
  } finally {
    if (publishTails.get(accountId) === current) publishTails.delete(accountId);
  }
}

/** 返回非敏感账号元数据；includeStatus=true 时逐账号探测各自实例。 */
export async function listAccounts({ includeStatus = false } = {}) {
  const accounts = listAccountRecords();
  if (!includeStatus) return accounts;
  return Promise.all(accounts.map(async (account) => ({
    ...account,
    ...(await status(account.accountId)),
  })));
}

/** 新建隔离账号并按需启动其引擎；失败时账号记录保留，可重试扫码。 */
export async function createAccount({ accountId, label } = {}) {
  const account = createAccountRecord({ accountId, label });
  const engine = await ensureAccountEngine(account.accountId);
  return { ...account, online: engine.online, version: engine.version || null };
}

/**
 * 兼容旧调用：status() 指向 default。
 * 显式传入空值/未知 accountId 时 resolveAccount 会报错，绝不回退到其它账号。
 */
export async function status(accountId = DEFAULT_XHS_ACCOUNT_ID) {
  const account = resolveAccount(accountId);
  try {
    const payload = await request(account.accountId, "/api/v1/login/status", { timeoutMs: 30_000 });
    const loggedIn = payload?.data?.is_logged_in === true;
    return {
      accountId: account.accountId,
      label: account.label,
      online: true,
      loggedIn,
      username: payload?.data?.username || null,
      userId: payload?.data?.user_id || null,
      reason: loggedIn ? null : "需扫码登录小红书",
    };
  } catch (error) {
    return {
      accountId: account.accountId,
      label: account.label,
      online: false,
      loggedIn: false,
      username: null,
      userId: null,
      reason: safeMessage(error?.message || error),
    };
  }
}

/** 兼容旧调用：loginQrcode() 指向 default。 */
export async function loginQrcode(accountId = DEFAULT_XHS_ACCOUNT_ID) {
  const account = resolveAccount(accountId);
  const payload = await request(account.accountId, "/api/v1/login/qrcode", { timeoutMs: 60_000 });
  const data = payload?.data || {};
  return {
    accountId: account.accountId,
    label: account.label,
    loggedIn: data.is_logged_in === true,
    timeout: data.timeout || null,
    qrData: data.img ? (String(data.img).startsWith("data:") ? String(data.img) : `data:image/png;base64,${data.img}`) : null,
  };
}

/** 兼容旧调用：缺省 accountId 时仅指向 default；null/空串不会回退。 */
export async function publishImageText({
  accountId = DEFAULT_XHS_ACCOUNT_ID,
  title,
  content,
  images,
  tags = [],
  scheduleAt = null,
  isOriginal = false,
  creativeStatement = null,
}) {
  const account = resolveAccount(accountId);
  if (!Array.isArray(images) || !images.length) throw new Error("小红书图文至少需要 1 张图片");
  if (![null, "ai_generated"].includes(creativeStatement)) {
    throw new Error("小红书图文内容声明不受支持");
  }
  const containsAI = creativeStatement === "ai_generated";
  const payload = await serializeAccountPublish(account.accountId, () => request(account.accountId, "/api/v1/publish", {
    method: "POST",
    timeoutMs: 8 * 60_000,
    body: {
      title: String(title || "").trim().slice(0, 20),
      content: String(content || "").trim().slice(0, 1_000),
      images: images.map(String),
      tags: tags.map(String).slice(0, 10),
      ...(scheduleAt ? { schedule_at: new Date(scheduleAt).toISOString() } : {}),
      is_original: isOriginal === true,
      contains_ai: containsAI,
    },
  }));
  if (containsAI && payload?.data?.ai_content_declared !== true) {
    // 引擎声称发布完成却没有声明回执时，不能把它当成可安全重试的发布前
    // 失败：平台可能已经收到内容，自动重试会造成重复公开笔记。
    throw blockedAIContentDeclaration("小红书未回执 AI 合成内容声明，已停止认定发布成功", {
      beforeExternalCall: false,
      externalCallStarted: true,
    });
  }
  return {
    ...payload,
    accountId: account.accountId,
    creativeStatement,
    aiDeclarationVerified: containsAI ? true : null,
    status: payload?.data?.status === "发布完成" ? "published" : "submitted",
  };
}

export { DEFAULT_XHS_ACCOUNT_ID, ensureAccountEngine, xhsAccountRuntimeSummary };
