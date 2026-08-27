/* 织台 · 微信公众号官方 API 多账号适配层
 *
 * 每次状态检查与发布都解析明确的 accountId；调用完全省略 accountId 时
 * 映射到注册表持久保存的默认账号。未知、空白或已删除的显式 accountId 会直接失败，
 * 绝不回退到其他账号。AppSecret 只在账号独立的 macOS Keychain 项中读取。
 */
import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import {
  createWechatOfficialAccountStore,
  DEFAULT_WECHAT_OFFICIAL_ACCOUNT_ID,
  LEGACY_APP_ID_SERVICE,
  LEGACY_APP_SECRET_SERVICE,
} from "./wechat-official-accounts.mjs";

const API = "https://api.weixin.qq.com";
const LOGIN_URL = "https://mp.weixin.qq.com/";

// 保留旧导出，供现有契约测试和迁移工具识别；新账号不再共用它们。
const APP_ID_SERVICE = LEGACY_APP_ID_SERVICE;
const APP_SECRET_SERVICE = LEGACY_APP_SECRET_SERVICE;

function safeError(payload, fallback) {
  const code = payload?.errcode;
  const message = String(payload?.errmsg || fallback || "微信公众号接口失败")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 240);
  return code ? `${message}（${code}）` : message;
}

class WechatApiError extends Error {
  constructor(payload, fallback, httpStatus = null) {
    super(safeError(payload, fallback));
    this.name = "WechatApiError";
    this.code = Number.isFinite(Number(payload?.errcode)) ? Number(payload.errcode) : null;
    this.httpStatus = Number.isFinite(Number(httpStatus)) ? Number(httpStatus) : null;
  }
}

async function jsonRequest(url, options = {}, fetchImpl = globalThis.fetch) {
  const response = await fetchImpl(url, {
    ...options,
    signal: options.signal || AbortSignal.timeout(60_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.errcode) {
    throw new WechatApiError(payload, `HTTP ${response.status}`, response.status);
  }
  return payload;
}

function requestedAccountId(value) {
  if (typeof value === "string") return value;
  if (value && Object.prototype.hasOwnProperty.call(value, "accountId")) return value.accountId;
  return undefined;
}

function verificationFailure(error, stage) {
  const code = Number.isFinite(Number(error?.code)) ? Number(error.code) : null;
  if (stage === "draft" && code === 48001) {
    return {
      needsAttention: true,
      reason: "公众号凭证有效，但当前账号未获得草稿箱接口权限（48001）；请登录微信公众平台检查草稿箱/发布接口权限",
    };
  }
  if (stage === "draft" && code === 48004) {
    return {
      needsAttention: true,
      reason: "公众号凭证有效，但草稿箱接口已被封禁（48004）；请登录微信公众平台查看详情",
    };
  }
  const credentialReasons = new Map([
    [40013, "公众号 AppID 无效（40013）；请检查当前配置"],
    [40125, "公众号 AppSecret 无效（40125）；请在微信公众平台重置后更新配置"],
    [40164, "当前公网 IP 未加入微信公众平台 IP 白名单（40164）"],
  ]);
  if (stage === "credential" && credentialReasons.has(code)) {
    return { needsAttention: true, reason: credentialReasons.get(code) };
  }
  return {
    needsAttention: false,
    reason: stage === "credential"
      ? "公众号凭证暂时无法校验，请稍后重试"
      : "公众号凭证有效，但草稿箱接口暂时无法校验，请稍后重试",
  };
}

function mimeFor(path) {
  const ext = extname(path).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  return "image/jpeg";
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function createWechatOfficialPublisher({
  accountStore = createWechatOfficialAccountStore(),
  defaultFetchImpl = globalThis.fetch,
} = {}) {
  const publishQueues = new Map();

  async function withAccountPublishLock(accountId, operation) {
    const previous = publishQueues.get(accountId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    publishQueues.set(accountId, current);
    await previous.catch(() => {});
    try {
      return await operation();
    } finally {
      release();
      if (publishQueues.get(accountId) === current) publishQueues.delete(accountId);
    }
  }

  async function accessToken(accountId, fetchImpl = defaultFetchImpl) {
    const credential = accountStore.credentialsFor(accountId);
    if (!credential.appId || !credential.appSecret) {
      throw new Error(`公众号账号 ${credential.accountId} 的 AppID/AppSecret 尚未配置`);
    }
    const query = new URLSearchParams({
      grant_type: "client_credential",
      appid: credential.appId,
      secret: credential.appSecret,
    });
    const payload = await jsonRequest(`${API}/cgi-bin/token?${query}`, {}, fetchImpl);
    if (!payload?.access_token) throw new Error("公众号 access_token 未返回");
    return { accountId: credential.accountId, token: String(payload.access_token) };
  }

  async function diagnoseDraftUnauthorized(token, fetchImpl) {
    try {
      // 只读诊断。响应中的主体名等字段不会进入状态对象。
      const payload = await jsonRequest(
        `${API}/cgi-bin/account/getaccountbasicinfo?access_token=${encodeURIComponent(token)}`,
        {},
        fetchImpl,
      );
      const accountType = Number(payload?.account_type);
      const qualificationVerified = payload?.wx_verify_info?.qualification_verify;
      if (accountType === 2 && qualificationVerified === false) {
        return {
          needsAttention: true,
          reason: "公众号凭证有效，但该服务号尚未完成微信资质认证，因此草稿/素材接口实际无调用额度（48001）",
          accountType,
          qualificationVerified,
        };
      }
    } catch {
      // 诊断接口失败不覆盖原始 48001。
    }
    return null;
  }

  async function uploadForm(endpoint, token, path, fetchImpl) {
    const bytes = await readFile(path);
    const form = new FormData();
    form.append("media", new Blob([bytes], { type: mimeFor(path) }), basename(path));
    return jsonRequest(
      `${API}${endpoint}${endpoint.includes("?") ? "&" : "?"}access_token=${encodeURIComponent(token)}`,
      { method: "POST", body: form, signal: AbortSignal.timeout(120_000) },
      fetchImpl,
    );
  }

  function listAccounts() {
    return accountStore.listAccounts().map((account) => ({ ...account, loginUrl: LOGIN_URL }));
  }

  function status(accountIdOrOptions) {
    const account = accountStore.getAccount(requestedAccountId(accountIdOrOptions));
    return {
      ...account,
      loginUrl: LOGIN_URL,
      credentialReady: account.configured ? null : false,
      draftReady: account.configured ? null : false,
      // 只有正式提交成功后才会记为 true；不根据账号类型冒充已验证。
      publishReady: account.publishReady,
      ready: false,
      needsAttention: !account.configured,
      reason: account.configured
        ? null
        : "需在微信公众平台获取 AppID/AppSecret，并开通草稿/发布接口权限",
    };
  }

  async function verifyStatus(options = {}) {
    const accountId = requestedAccountId(options);
    const fetchImpl = options?.fetchImpl || defaultFetchImpl;
    // 用对象保留“显式 null/空串”与“完全省略”的区别。
    const configured = status({ accountId });
    const base = {
      ...configured,
      credentialReady: false,
      draftReady: false,
      publishReady: configured.publishReady,
      ready: false,
      needsAttention: !configured.configured,
    };
    if (!configured.configured) return base;

    let token;
    try {
      ({ token } = await accessToken(configured.accountId, fetchImpl));
    } catch (error) {
      return {
        ...base,
        publishReady: false,
        ...verificationFailure(error, "credential"),
      };
    }

    try {
      // draft/count 是只读接口，同时验证 token 和草稿箱权限。
      await jsonRequest(
        `${API}/cgi-bin/draft/count?access_token=${encodeURIComponent(token)}`,
        {},
        fetchImpl,
      );
      return {
        ...base,
        credentialReady: true,
        draftReady: true,
        ready: true,
        needsAttention: false,
        reason: configured.publishReady === true
          ? "接口凭证、草稿箱与正式发布权限有效"
          : "接口凭证与草稿箱权限有效；正式发布权限尚未通过实际提交验证",
      };
    } catch (error) {
      const diagnosis = Number(error?.code) === 48001
        ? await diagnoseDraftUnauthorized(token, fetchImpl)
        : null;
      if ([48001, 48004].includes(Number(error?.code))) {
        accountStore.markPublishReady(configured.accountId, false);
      }
      return {
        ...base,
        credentialReady: true,
        publishReady: false,
        ...(diagnosis || verificationFailure(error, "draft")),
      };
    }
  }

  async function listDrafts({
    accountId,
    offset = 0,
    count = 20,
    includeContent = false,
    fetchImpl = defaultFetchImpl,
  } = {}) {
    const resolvedAccount = accountStore.getAccount(accountId);
    const access = await accessToken(resolvedAccount.accountId, fetchImpl);
    const safeOffset = Math.max(0, Math.floor(Number(offset) || 0));
    const safeCount = Math.min(20, Math.max(1, Math.floor(Number(count) || 20)));
    const payload = await jsonRequest(
      `${API}/cgi-bin/draft/batchget?access_token=${encodeURIComponent(access.token)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({
          offset: safeOffset,
          count: safeCount,
          no_content: includeContent ? 0 : 1,
        }),
      },
      fetchImpl,
    );
    const items = Array.isArray(payload?.item) ? payload.item : [];
    return {
      accountId: access.accountId,
      totalCount: Math.max(0, Number(payload?.total_count) || 0),
      itemCount: Math.max(0, Number(payload?.item_count) || items.length),
      items: items.map((item) => {
        const article = Array.isArray(item?.content?.news_item) ? item.content.news_item[0] : null;
        return {
          mediaId: String(item?.media_id || ""),
          updateTime: Number(item?.update_time) || null,
          title: String(article?.title || "").slice(0, 160),
          author: String(article?.author || "").slice(0, 80),
          digest: String(article?.digest || "").slice(0, 500),
          ...(includeContent ? { contentHtml: String(article?.content || "").slice(0, 200_000) } : {}),
        };
      }).filter((item) => item.mediaId),
    };
  }

  async function submitDraft({ accountId, mediaId, fetchImpl = defaultFetchImpl } = {}) {
    const resolvedAccount = accountStore.getAccount(accountId);
    const cleanMediaId = String(mediaId || "").trim();
    if (!cleanMediaId || cleanMediaId.length > 512) throw new Error("公众号草稿 media_id 无效");
    return withAccountPublishLock(resolvedAccount.accountId, async () => {
      const access = await accessToken(resolvedAccount.accountId, fetchImpl);
      try {
        const published = await jsonRequest(
          `${API}/cgi-bin/freepublish/submit?access_token=${encodeURIComponent(access.token)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ media_id: cleanMediaId }),
          },
          fetchImpl,
        );
        accountStore.markPublishReady(access.accountId, true);
        return {
          success: true,
          status: "submitted",
          accountId: access.accountId,
          publishId: published?.publish_id || null,
          mediaId: cleanMediaId,
        };
      } catch (error) {
        if ([48001, 48004].includes(Number(error?.code))) {
          accountStore.markPublishReady(resolvedAccount.accountId, false);
        }
        throw error;
      }
    });
  }

  function saveCredentials(accountIdOrCredentials, maybeCredentials) {
    const payload = typeof accountIdOrCredentials === "string"
      ? { ...(maybeCredentials || {}), accountId: accountIdOrCredentials }
      : (accountIdOrCredentials || {});
    return { ...accountStore.saveCredentials(payload), loginUrl: LOGIN_URL };
  }

  function createAccount(payload = {}) {
    return { ...accountStore.createAccount(payload), loginUrl: LOGIN_URL };
  }

  function updateAccount(accountId, payload = {}) {
    return { ...accountStore.updateAccount(accountId, payload), loginUrl: LOGIN_URL };
  }

  function setDefaultAccount(accountId) {
    return { ...accountStore.setDefaultAccount(accountId), loginUrl: LOGIN_URL };
  }

  async function publishArticle({
    accountId,
    title,
    content,
    images,
    sourceUrl = "",
    draft = true,
    author = "",
    fetchImpl = defaultFetchImpl,
  } = {}) {
    // 先解析账号。显式未知/null/空 accountId 会在任何素材读取或网络调用前失败。
    const resolvedAccount = accountStore.getAccount(accountId);
    if (!Array.isArray(images) || !images.length) {
      throw new Error("公众号图文至少需要 1 张图片");
    }

    // 微信素材与草稿接口对同一账号串行；不同 accountId 使用不同队列，可并行。
    return withAccountPublishLock(resolvedAccount.accountId, async () => {
      const access = await accessToken(resolvedAccount.accountId, fetchImpl);
      const cover = await uploadForm(
        "/cgi-bin/material/add_material?type=image",
        access.token,
        images[0],
        fetchImpl,
      );
      if (!cover?.media_id) throw new Error("公众号封面素材上传失败");

      const imageUrls = [];
      for (const image of images) {
        const uploaded = await uploadForm("/cgi-bin/media/uploadimg", access.token, image, fetchImpl);
        if (!uploaded?.url) throw new Error("公众号正文图片上传失败");
        imageUrls.push(String(uploaded.url));
      }

      const paragraphs = String(content || "")
        .split(/\n+/)
        .filter(Boolean)
        .map((line) => `<p>${escapeHtml(line)}</p>`)
        .join("");
      const inlineImages = imageUrls
        .map((url) => `<p><img src="${escapeHtml(url)}" /></p>`)
        .join("");
      const created = await jsonRequest(
        `${API}/cgi-bin/draft/add?access_token=${encodeURIComponent(access.token)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8" },
          body: JSON.stringify({ articles: [{
            title: String(title || "").slice(0, 64),
            author: String(author || "").slice(0, 16),
            digest: String(content || "").replace(/\s+/g, " ").slice(0, 120),
            content: paragraphs + inlineImages,
            content_source_url: String(sourceUrl || "").slice(0, 500),
            thumb_media_id: cover.media_id,
            need_open_comment: 0,
            only_fans_can_comment: 0,
          }] }),
        },
        fetchImpl,
      );
      if (!created?.media_id) throw new Error("公众号草稿未创建");
      if (draft) {
        return { success: true, status: "draft", accountId: access.accountId, mediaId: created.media_id };
      }

      try {
        const published = await jsonRequest(
          `${API}/cgi-bin/freepublish/submit?access_token=${encodeURIComponent(access.token)}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ media_id: created.media_id }),
          },
          fetchImpl,
        );
        accountStore.markPublishReady(access.accountId, true);
        return {
          success: true,
          status: "submitted",
          accountId: access.accountId,
          publishId: published?.publish_id || null,
          mediaId: created.media_id,
        };
      } catch (error) {
        if ([48001, 48004].includes(Number(error?.code))) {
          accountStore.markPublishReady(access.accountId, false);
        }
        throw error;
      }
    });
  }

  return {
    listAccounts,
    listDrafts,
    status,
    verifyStatus,
    saveCredentials,
    createAccount,
    updateAccount,
    setDefaultAccount,
    submitDraft,
    publishArticle,
  };
}

const defaultPublisher = createWechatOfficialPublisher();

export const listAccounts = (...args) => defaultPublisher.listAccounts(...args);
export const listDrafts = (...args) => defaultPublisher.listDrafts(...args);
export const status = (...args) => defaultPublisher.status(...args);
export const verifyStatus = (...args) => defaultPublisher.verifyStatus(...args);
export const saveCredentials = (...args) => defaultPublisher.saveCredentials(...args);
export const createAccount = (...args) => defaultPublisher.createAccount(...args);
export const updateAccount = (...args) => defaultPublisher.updateAccount(...args);
export const setDefaultAccount = (...args) => defaultPublisher.setDefaultAccount(...args);
export const submitDraft = (...args) => defaultPublisher.submitDraft(...args);
export const publishArticle = (...args) => defaultPublisher.publishArticle(...args);

export {
  API as WECHAT_OFFICIAL_API,
  APP_ID_SERVICE,
  APP_SECRET_SERVICE,
  DEFAULT_WECHAT_OFFICIAL_ACCOUNT_ID,
};
