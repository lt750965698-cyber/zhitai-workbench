"use client";

/* 织台 · 发布中心原生页（MatrixMedia V1）
 * 状态/账号/历史/平台/创意声明来自 17890 的 /api/v1/publisher/*；
 * 发布提交 POST /api/v1/publish（videoId + destinations，带 X-Zhitai-Action: confirm），
 * server 从 KB 解析素材后在 MatrixMedia 边界映射为官方契约（file / publishAt 本地时间 / tags 空格串 / 多平台一次请求）。
 * 普通界面不显示引擎端口、CLI 名称、接口路径或绝对路径；账号为空时禁用发布并提示先登录。
 */

import { useCallback, useEffect, useState } from "react";
import { apiErrorText, zapi } from "./zapi";

const LOCAL_AGENT = "http://127.0.0.1:17890";

type PublisherStatus = { enabled: boolean; binaryExists: boolean; guiOnline: boolean };
type Platform = { code: string; name: string; automated?: boolean; hasConfig?: boolean; note?: string | null };
type Statement = { value: string; label: string; onlyPlatforms?: string[] | null };
type AccountRow = { platform: string; phone: string | null; partition: string | null; loginStatus: string | null; error: string | null };
type ImageTextAccount = {
  id: string;
  label: string;
  username: string | null;
  ready: boolean;
  status: string | null;
  reason: string | null;
  isDefault?: boolean;
  legacy?: boolean;
};
type ImageTextStatus = {
  xiaohongshu?: { online?: boolean; loggedIn?: boolean; username?: string | null; reason?: string | null; accounts?: unknown[] };
  wechatOfficial?: { configured?: boolean; reason?: string | null; loginUrl?: string; accounts?: unknown[] };
};
type ProviderFeedback = { phase: "idle" | "loading" | "success" | "error"; message: string };
type PublishLibraryItem = {
  id: string;
  title: string;
  tags?: string[];
  copywriting?: string | null;
  qualityState?: string | null;
  qualityLabel?: string | null;
  qualityReason?: string | null;
};

function defaultPublishTitle(item?: PublishLibraryItem): string {
  const source = String(item?.copywriting || item?.title || "").replace(/\s+/g, " ").trim();
  return source.slice(0, 100);
}

function defaultPublishTags(item?: PublishLibraryItem): string {
  return Array.isArray(item?.tags) ? item.tags.filter(Boolean).slice(0, 4).join(", ") : "";
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstText(record: Record<string, unknown> | null, keys: string[]): string | null {
  for (const key of keys) {
    const value = record?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function normalizeImageTextAccounts(value: unknown, platform: "xiaohongshu" | "wechat_official"): ImageTextAccount[] {
  if (!Array.isArray(value)) return [];
  const rows: ImageTextAccount[] = [];
  for (const raw of value) {
    const record = recordOf(raw);
    if (!record) continue;
    const id = firstText(record, ["id", "accountId", "account_id"]);
    if (!id) continue;
    const username = firstText(record, ["username", "nickname", "name"]);
    const label = firstText(record, ["label", "displayName", "display_name"]) || username || (platform === "xiaohongshu" ? "小红书账号" : "公众号");
    const status = firstText(record, ["status", "loginStatus", "login_status"]);
    const reason = firstText(record, ["reason", "error", "message"]);
    const normalizedStatus = status?.toLowerCase().replace(/[\s-]+/g, "_") || "";
    const explicitLoggedIn = typeof record.loggedIn === "boolean" ? record.loggedIn
      : typeof record.logged_in === "boolean" ? record.logged_in
        : typeof record.isLoggedIn === "boolean" ? record.isLoggedIn
          : null;
    const explicitlyPublishBlocked = record.ready === false || record.draftReady === false || record.credentialReady === false;
    const ready = platform === "xiaohongshu"
      ? explicitLoggedIn === false ? false : explicitLoggedIn === true || ["online", "ready", "logged_in", "active"].includes(normalizedStatus)
      : !explicitlyPublishBlocked && (record.configured === true || record.ready === true || record.draftReady === true || record.credentialsConfigured === true || ["configured", "ready", "active"].includes(normalizedStatus));
    const next = { id, label, username, ready, status, reason, isDefault: record.isDefault === true };
    const existingIndex = rows.findIndex((row) => row.id === id);
    // 轻量账号元数据在前，登录/权限实况在后；同一账号必须以后者覆盖。
    if (existingIndex >= 0) rows[existingIndex] = next;
    else rows.push(next);
  }
  return rows;
}

function nestedAccounts(payload: unknown, key: "xiaohongshu" | "wechatOfficial"): unknown[] {
  const root = recordOf(payload);
  const direct = recordOf(root?.[key]);
  const imageText = recordOf(root?.imageText);
  const nested = recordOf(imageText?.[key]);
  const value = direct?.accounts ?? nested?.accounts;
  return Array.isArray(value) ? value : [];
}

function imageTextAccountsFrom(
  accountsPayload: unknown,
  statusPayload: ImageTextStatus | null,
): { xiaohongshu: ImageTextAccount[]; wechatOfficial: ImageTextAccount[] } {
  const xhsRaw = [
    ...nestedAccounts(accountsPayload, "xiaohongshu"),
    ...(Array.isArray(statusPayload?.xiaohongshu?.accounts) ? statusPayload.xiaohongshu.accounts : []),
  ];
  const wechatRaw = [
    ...nestedAccounts(accountsPayload, "wechatOfficial"),
    ...(Array.isArray(statusPayload?.wechatOfficial?.accounts) ? statusPayload.wechatOfficial.accounts : []),
  ];
  const xiaohongshu = normalizeImageTextAccounts(xhsRaw, "xiaohongshu");
  const wechatOfficial = normalizeImageTextAccounts(wechatRaw, "wechat_official");
  if (!xiaohongshu.length && statusPayload?.xiaohongshu?.loggedIn) {
    xiaohongshu.push({
      id: "legacy-xiaohongshu",
      label: statusPayload.xiaohongshu.username || "当前小红书账号",
      username: statusPayload.xiaohongshu.username || null,
      ready: true,
      status: "online",
      reason: null,
      legacy: true,
    });
  }
  if (!wechatOfficial.length && statusPayload?.wechatOfficial?.configured) {
    wechatOfficial.push({
      id: "legacy-wechat-official",
      label: "当前公众号",
      username: null,
      ready: true,
      status: "configured",
      reason: statusPayload.wechatOfficial.reason || null,
      legacy: true,
    });
  }
  return { xiaohongshu, wechatOfficial };
}

function responseAccountId(payload: unknown): string | null {
  const root = recordOf(payload);
  return firstText(root, ["accountId", "account_id", "id"])
    || firstText(recordOf(root?.account), ["accountId", "account_id", "id"]);
}

function reconcileImageTextAccountChoice(
  current: Record<string, string>,
  pools: { xiaohongshu: ImageTextAccount[]; wechatOfficial: ImageTextAccount[] },
): Record<string, string> {
  const next = { ...current };
  for (const [destination, accounts] of [
    ["xiaohongshu", pools.xiaohongshu],
    ["wechat_official", pools.wechatOfficial],
  ] as const) {
    if (accounts.some((account) => account.id === next[destination])) continue;
    const defaultAccount = accounts.find((account) => account.isDefault && account.ready);
    if (defaultAccount) next[destination] = defaultAccount.id;
    else if (accounts.length === 1) next[destination] = accounts[0].id;
    else delete next[destination];
  }
  return next;
}

const PUBLISH_PLATFORM_LABELS: Record<string, string> = {
  dy: "抖音",
  douyin: "抖音",
  tt: "今日头条",
  toutiao: "今日头条",
  jinritoutiao: "今日头条",
  ks: "快手",
  kuaishou: "快手",
  blbl: "哔哩哔哩",
  bilibili: "哔哩哔哩",
  bjh: "百家号",
  baijiahao: "百家号",
  sph: "视频号",
  channels: "视频号",
  wechat_channels: "视频号",
  xhs: "小红书",
  xiaohongshu: "小红书",
  fqsp: "番茄视频",
  fanqie: "番茄视频",
  wechat_official: "微信公众号",
  wechat_official_account: "微信公众号",
  wechatofficial: "微信公众号",
};

// 这里覆盖本地调度器、本地回执和 Matrix 历史三类状态。
// 未识别值只显示中文保守结论，不把引擎英文直出给用户。
const PUBLISH_STATUS_LABELS: Record<string, string> = {
  scheduled: "已排期",
  queued: "等待执行",
  pending: "等待执行",
  preflighting: "发布前检查中",
  preparing: "准备发布中",
  submitting: "正在上传",
  processing: "平台处理中",
  public: "已公开发布",
  published: "已公开发布",
  draft: "已保存到平台草稿",
  platform_draft: "已保存到平台草稿",
  submitted: "已上传，公开状态待核实",
  accepted: "已上传，公开状态待核实",
  submitted_unverified: "已上传，公开状态待核实",
  success: "平台已接收，公开状态待核实",
  completed: "任务已完成",
  failed: "发布失败，未完成",
  failure: "发布失败，未完成",
  error: "发布失败，未完成",
  rejected: "平台拒绝，未完成",
  needs_attention: "未完成，需要处理",
  needs_reconciliation: "已提交，平台结果待核对",
  retry_wait: "临时故障，等待自动重试",
  expired: "排期已过期，未执行",
  cancelled: "已取消，未执行",
  canceled: "已取消，未执行",
  unknown: "平台状态待核实",
  unverified: "平台状态待核实",
};

function normalizedPublishToken(value: unknown): string {
  return String(value || "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[\s-]+/g, "_");
}

function formatBeijingDateTime(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  const date = new Date(value as string | number | Date);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function publishStatusText(value: unknown, record: Record<string, unknown> | null = null): string {
  const status = normalizedPublishToken(value) || "unknown";
  if (status === "scheduled") {
    const scheduledAt = formatBeijingDateTime(record?.scheduledAt);
    const prefix = normalizedPublishToken(record?.schedulerState) === "scheduler_inactive"
      ? "旧排期未被织台接管，不会自动执行"
      : PUBLISH_STATUS_LABELS.scheduled;
    return scheduledAt ? `${prefix}：北京时间 ${scheduledAt}` : `${prefix}（发布时间未返回）`;
  }
  if (status === "retry_wait") {
    const nextAttemptAt = formatBeijingDateTime(record?.nextAttemptAt);
    return nextAttemptAt
      ? `${PUBLISH_STATUS_LABELS.retry_wait}：北京时间 ${nextAttemptAt}`
      : PUBLISH_STATUS_LABELS.retry_wait;
  }
  return PUBLISH_STATUS_LABELS[status] || "平台状态待核实";
}

function historyStatusText(record: Record<string, unknown>): string {
  const state = firstText(record, ["state", "status", "publishStatus"]) || "unknown";
  return publishStatusText(state, record);
}

function publishPlatformLabel(value: unknown): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const token = normalizedPublishToken(raw.split(":", 1)[0]);
  if (!token || token === "unknown") return null;
  if (PUBLISH_PLATFORM_LABELS[token]) return PUBLISH_PLATFORM_LABELS[token];
  // 平台若已返回中文名称则保留；其他未知代码不直出英文。
  return /[\u3400-\u9fff]/.test(raw) ? raw : "其他平台";
}

function historyPlatformText(record: Record<string, unknown>): string {
  const values: unknown[] = [];
  if (record.platform) values.push(record.platform);
  if (record.destination) values.push(record.destination);
  if (Array.isArray(record.targets)) {
    for (const rawTarget of record.targets) {
      if (typeof rawTarget === "string") {
        values.push(rawTarget);
        continue;
      }
      const target = recordOf(rawTarget);
      values.push(target?.destination ?? target?.platform ?? target?.id ?? null);
    }
  }
  const labels = values.map(publishPlatformLabel).filter((label): label is string => Boolean(label));
  return [...new Set(labels)].join("、") || "平台未返回";
}

function historyRecordTimeText(record: Record<string, unknown>): string {
  const time = [record.time, record.updatedAt, record.created_at, record.createdAt]
    .map(formatBeijingDateTime)
    .find(Boolean);
  return time ? `记录时间：北京时间 ${time}` : "记录时间未返回";
}

function publishFailureText(value: unknown): string {
  const raw = String(value || "").trim();
  if (/48001/.test(raw)) return "账号没有正式发布权限，任务未完成";
  if (/ai.{0,20}(statement|declaration)|statement.{0,20}ai/i.test(raw)) return "无法确认 AI 生成声明，任务未完成";
  if (/login|auth|credential|unauthorized|forbidden|cookie/i.test(raw)) return "需要重新登录或检查账号权限，任务未完成";
  if (/timeout|timed out/i.test(raw)) return "平台响应超时，任务未完成";
  if (/[\u3400-\u9fff]/.test(raw)) return raw.slice(0, 160);
  return "发布服务未返回可读原因，任务未完成";
}

export function PublishNative({
  libraryItems,
  initialVideoId,
  preferGenerated = false,
}: {
  libraryItems: PublishLibraryItem[];
  initialVideoId?: string;
  preferGenerated?: boolean;
}) {
  const [status, setStatus] = useState<PublisherStatus | null>(null);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [history, setHistory] = useState<unknown[]>([]);
  const [platforms, setPlatforms] = useState<Platform[]>([]);
  const [statements, setStatements] = useState<Statement[]>([]);
  const initialItem = libraryItems.find((item) => item.id === initialVideoId);
  const [msg, setMsg] = useState(initialItem && preferGenerated ? "已带入最新一键生成成片；请选择账号、平台与发布时间。" : "");

  const [videoId, setVideoId] = useState(initialItem?.id ?? "");
  const [title, setTitle] = useState(defaultPublishTitle(initialItem));
  const [tags, setTags] = useState(defaultPublishTags(initialItem));
  const [bt2, setBt2] = useState("");
  const [mode, setMode] = useState<"platform_draft" | "publish">("platform_draft");
  const [scheduledAt, setScheduledAt] = useState("");
  const [useLatestRemake, setUseLatestRemake] = useState(Boolean(initialItem && preferGenerated));
  const [qualityApproved, setQualityApproved] = useState(false);
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);
  const [accountChoice, setAccountChoice] = useState<Record<string, { phone?: string; partition?: string }>>({});
  const [statementMap, setStatementMap] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [loginPlatform, setLoginPlatform] = useState<"dy" | "sph">("dy");
  const [loginPhone, setLoginPhone] = useState("");
  const [login, setLogin] = useState<{ id: string; status: string; message: string; interactionMode?: "inline_qr" | "window"; qrAvailable?: boolean } | null>(null);
  const [imageTextStatus, setImageTextStatus] = useState<ImageTextStatus | null>(null);
  const [xhsAccounts, setXhsAccounts] = useState<ImageTextAccount[]>([]);
  const [wechatAccounts, setWechatAccounts] = useState<ImageTextAccount[]>([]);
  const [imageTextAccountChoice, setImageTextAccountChoice] = useState<Record<string, string>>({});
  const [xhsQr, setXhsQr] = useState<string | null>(null);
  const [xhsQrAccountId, setXhsQrAccountId] = useState<string | null>(null);
  const [xhsFeedback, setXhsFeedback] = useState<ProviderFeedback>({ phase: "idle", message: "" });
  const [xhsAdding, setXhsAdding] = useState(false);
  const [xhsAddOpen, setXhsAddOpen] = useState(false);
  const [xhsLabel, setXhsLabel] = useState("");
  const [wechatFeedback, setWechatFeedback] = useState<ProviderFeedback>({ phase: "idle", message: "" });
  const [wechatSaving, setWechatSaving] = useState(false);
  const [wechatFormOpen, setWechatFormOpen] = useState(false);
  const [wechatAccountId, setWechatAccountId] = useState<string | null>(null);
  const [wechatLabel, setWechatLabel] = useState("");
  const [imageTextDestinations, setImageTextDestinations] = useState<string[]>([]);
  const [imageTextMode, setImageTextMode] = useState<"platform_draft" | "publish">("platform_draft");
  const [wechatAppId, setWechatAppId] = useState("");
  const [wechatAppSecret, setWechatAppSecret] = useState("");

  const loadAll = useCallback(async (deep = true) => {
    const [s, p, c] = await Promise.all([
      zapi(`${LOCAL_AGENT}/api/v1/publisher/status`, "GET", undefined, { timeoutMs: 6000 }),
      zapi(`${LOCAL_AGENT}/api/v1/publisher/platforms`, "GET", undefined, { timeoutMs: 6000 }),
      zapi(`${LOCAL_AGENT}/api/v1/publisher/creative-statements`, "GET", undefined, { timeoutMs: 6000 }),
    ]);
    if (s.ok && s.body) setStatus(s.body as PublisherStatus);
    if (p.ok && (p.body as { platforms?: unknown[] })?.platforms) setPlatforms((p.body as { platforms: Platform[] }).platforms);
    if (c.ok && (c.body as { batchOptions?: unknown[] })?.batchOptions) setStatements((c.body as { batchOptions: Statement[] }).batchOptions);
    // accounts/history 会调用 Electron CLI。只在首次、手动刷新和登录完成时读取，
    // 不再每 15 秒启停 MatrixMedia，因此 Dock 不会反复跳图标。
    if (deep) {
      // 图文账号由轻量本地接口独立返回，不能被较慢的 MatrixMedia CLI 查询卡住。
      const accountsPromise = zapi(`${LOCAL_AGENT}/api/v1/publisher/accounts`, "GET", undefined, { timeoutMs: 120000 });
      const historyPromise = zapi(`${LOCAL_AGENT}/api/v1/publisher/history`, "GET", undefined, { timeoutMs: 120000 });
      const imageText = await zapi(LOCAL_AGENT + "/api/v1/publisher/image-text/status", "GET", undefined, { timeoutMs: 30000 });
      const nextImageTextStatus = imageText.ok && imageText.body ? imageText.body as ImageTextStatus : null;
      if (nextImageTextStatus) {
        setImageTextStatus(nextImageTextStatus);
        const immediateImageAccounts = imageTextAccountsFrom(null, nextImageTextStatus);
        setXhsAccounts(immediateImageAccounts.xiaohongshu);
        setWechatAccounts(immediateImageAccounts.wechatOfficial);
        setImageTextAccountChoice((current) => reconcileImageTextAccountChoice(current, immediateImageAccounts));
      }
      const [a, h] = await Promise.all([accountsPromise, historyPromise]);
      if (a.ok && (a.body as { accounts?: unknown[] })?.accounts) setAccounts((a.body as { accounts: AccountRow[] }).accounts);
      if (h.ok && (h.body as { history?: unknown[] })?.history) setHistory((h.body as { history: unknown[] }).history);
      const nextImageAccounts = imageTextAccountsFrom(a.ok ? a.body : null, nextImageTextStatus);
      setXhsAccounts(nextImageAccounts.xiaohongshu);
      setWechatAccounts(nextImageAccounts.wechatOfficial);
      setImageTextAccountChoice((current) => reconcileImageTextAccountChoice(current, nextImageAccounts));
    }
  }, []);

  useEffect(() => {
    const initial = window.setTimeout(() => void loadAll(true), 0);
    const t = setInterval(() => void loadAll(false), 15000);
    return () => { window.clearTimeout(initial); clearInterval(t); };
  }, [loadAll]);

  useEffect(() => {
    if (!login?.id || ["success", "failed", "expired"].includes(login.status)) return;
    const timer = setInterval(async () => {
      const result = await zapi(`${LOCAL_AGENT}/api/v1/publisher/login/${encodeURIComponent(login.id)}`, "GET", undefined, { timeoutMs: 6000 });
      const next = (result.body as { login?: typeof login } | null)?.login;
      if (result.ok && next) {
        setLogin(next);
        if (next.status === "success") void loadAll(true);
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [login?.id, login?.status, loadAll]);

  async function startLogin() {
    if (!/^1\d{10}$/.test(loginPhone.trim())) { setMsg("请输入当前账号绑定的 11 位手机号，不能填账号名称"); return; }
    setMsg("");
    const result = await zapi(`${LOCAL_AGENT}/api/v1/publisher/login`, "POST", { platform: loginPlatform, phone: loginPhone.trim() }, { timeoutMs: 6000 });
    const next = (result.body as { login?: typeof login; message?: string } | null)?.login;
    if (!result.ok || !next) { setMsg("登录启动失败：" + String((result.body as { message?: string } | null)?.message || result.error || "未知错误")); return; }
    setLogin(next);
  }

  async function loadXhsQr(accountId?: string | null) {
    const explicitAccountId = accountId && !accountId.startsWith("legacy-") ? accountId : null;
    setXhsQrAccountId(accountId || null);
    setXhsFeedback({ phase: "loading", message: "正在向小红书申请登录二维码…" });
    const query = explicitAccountId ? `?accountId=${encodeURIComponent(explicitAccountId)}` : "";
    const result = explicitAccountId
      ? await zapi(LOCAL_AGENT + "/api/v1/publisher/xhs/login-qrcode" + query, "GET", undefined, { timeoutMs: 120000 })
      : await zapi(LOCAL_AGENT + "/api/v1/publisher/xhs/login-qrcode", "GET", undefined, { timeoutMs: 120000 });
    const nextLogin = (result.body as { login?: { loggedIn?: boolean; qrData?: string | null } } | null)?.login;
    if (!result.ok || !nextLogin) {
      setXhsFeedback({ phase: "error", message: "二维码生成失败：" + (apiErrorText(result) || "小红书引擎未就绪") });
      return;
    }
    if (nextLogin.loggedIn) {
      setXhsFeedback({ phase: "success", message: "小红书已经登录，无需重复扫码。" });
      setXhsQr(null);
      void loadAll(true);
      return;
    }
    setXhsQr(nextLogin.qrData || null);
    setXhsFeedback(nextLogin.qrData
      ? { phase: "success", message: "请用小红书 App 扫码；完成后点“检查登录结果”。" }
      : { phase: "error", message: "小红书引擎没有返回二维码，请重试。" });
  }

  async function addXhsAccount() {
    const label = xhsLabel.trim();
    if (!label) {
      setXhsFeedback({ phase: "error", message: "请先给新账号填写一个本机识别名称。" });
      return;
    }
    setXhsAdding(true);
    setXhsFeedback({ phase: "loading", message: "正在创建独立的小红书登录会话…" });
    try {
      const result = await zapi(LOCAL_AGENT + "/api/v1/publisher/xhs/accounts", "POST", { label }, { timeoutMs: 15000 });
      const accountId = responseAccountId(result.body);
      if (!result.ok || !accountId) {
        setXhsFeedback({ phase: "error", message: "新增账号失败：" + (apiErrorText(result) || "服务没有返回账号 ID") });
        return;
      }
      setXhsLabel("");
      setXhsAddOpen(false);
      setImageTextAccountChoice((current) => ({ ...current, xiaohongshu: accountId }));
      setXhsAccounts((current) => current.some((account) => account.id === accountId) ? current : [
        ...current,
        { id: accountId, label, username: null, ready: false, status: "pending_login", reason: "等待扫码" },
      ]);
      await loadXhsQr(accountId);
      void loadAll(true);
    } finally {
      setXhsAdding(false);
    }
  }

  async function refreshImageTextAccounts() {
    setXhsFeedback({ phase: "loading", message: "正在检查小红书登录状态…" });
    const statusResult = await zapi(LOCAL_AGENT + "/api/v1/publisher/image-text/status", "GET", undefined, { timeoutMs: 30000 });
    if (!statusResult.ok || !statusResult.body) {
      setXhsFeedback({ phase: "error", message: "状态检查失败：" + (apiErrorText(statusResult) || "图文引擎未就绪") });
      return;
    }
    const next = statusResult.body as ImageTextStatus;
    setImageTextStatus(next);
    const nextAccounts = imageTextAccountsFrom(null, next);
    setXhsAccounts(nextAccounts.xiaohongshu);
    setWechatAccounts(nextAccounts.wechatOfficial);
    setImageTextAccountChoice((current) => reconcileImageTextAccountChoice(current, nextAccounts));
    const checkedAccount = xhsQrAccountId
      ? nextAccounts.xiaohongshu.find((account) => account.id === xhsQrAccountId)
      : null;
    if (checkedAccount?.ready || (!xhsQrAccountId && next.xiaohongshu?.loggedIn)) {
      setXhsQr(null);
      setXhsFeedback({ phase: "success", message: `${checkedAccount?.label || "小红书账号"}登录成功，已可用于图文发布。` });
    } else {
      setXhsFeedback({ phase: "error", message: checkedAccount?.reason || next.xiaohongshu?.reason || "扫码尚未完成；请扫码后再检查。" });
    }
  }

  async function saveWechatOfficialCredentials() {
    if (!wechatAppId.trim() || !wechatAppSecret.trim()) {
      setWechatFeedback({ phase: "error", message: "请填写公众号 AppID 和 AppSecret。" });
      return;
    }
    setWechatSaving(true);
    setWechatFeedback({ phase: "loading", message: "正在验证并保存公众号凭证…" });
    try {
      const explicitAccountId = wechatAccountId && !wechatAccountId.startsWith("legacy-") ? wechatAccountId : undefined;
      const payload = {
        accountId: explicitAccountId,
        label: wechatLabel.trim() || "公众号",
        appId: wechatAppId.trim(),
        appSecret: wechatAppSecret.trim(),
      };
      let result = await zapi(LOCAL_AGENT + "/api/v1/publisher/wechat-official/accounts/credentials", "POST", payload, { timeoutMs: 15000, confirmedAction: true });
      // 旧安装只有单账号端点；未指定账号时保留兼容，不影响升级后的多账号契约。
      if (result.status === 404 && !explicitAccountId) {
        result = await zapi(LOCAL_AGENT + "/api/v1/publisher/wechat-official/credentials", "POST", {
          appId: payload.appId,
          appSecret: payload.appSecret,
        }, { timeoutMs: 15000, confirmedAction: true });
      }
      if (!result.ok) {
        setWechatFeedback({ phase: "error", message: "公众号配置失败：" + (apiErrorText(result) || "未知错误") });
        return;
      }
      const savedAccountId = responseAccountId(result.body) || explicitAccountId || null;
      if (savedAccountId) setImageTextAccountChoice((current) => ({ ...current, wechat_official: savedAccountId }));
      setWechatAppId("");
      setWechatAppSecret("");
      setWechatLabel("");
      setWechatAccountId(null);
      setWechatFormOpen(false);
      setWechatFeedback({ phase: "success", message: "凭证已保存到 macOS 钥匙串，织台不会回显 AppSecret。" });
      await loadAll(true);
    } finally { setWechatSaving(false); }
  }

  function toggleImageTextDestination(destination: string) {
    setImageTextDestinations((current) => current.includes(destination) ? current.filter((item) => item !== destination) : [...current, destination]);
    if (destination === "xiaohongshu") setImageTextMode("publish");
  }

  const online = Boolean(status?.guiOnline);
  const noAccounts = accounts.length === 0;
  const imageTextAccountPools: Record<string, ImageTextAccount[]> = {
    xiaohongshu: xhsAccounts,
    wechat_official: wechatAccounts,
  };
  const platformName = (code: string) => platforms.find((p) => p.code === code)?.name || code;
  const accountLabel = (acc: AccountRow) => (acc.phone ? "手机号 " + acc.phone : acc.partition ? "分区 " + acc.partition : acc.platform);

  // 平台是否可选：automated=false 禁用
  const isPlatformEnabled = (p: Platform) => p.automated !== false;

  function togglePlatform(code: string) {
    if (noAccounts) return;
    const p = platforms.find((x) => x.code === code);
    if (p && !isPlatformEnabled(p)) return;
    setSelectedPlatforms((prev) => (prev.includes(code) ? prev.filter((c) => c !== code) : [...prev, code]));
  }

  function chooseAccount(code: string, acc: AccountRow | null) {
    setAccountChoice((prev) => ({ ...prev, [code]: acc ? { phone: acc.phone || undefined, partition: acc.partition || undefined } : {} }));
  }

  // 提交启用条件：视频 + ≥1 平台 + 每个选中平台有有效账号（phone 或 partition）
  const missingAccountPlatforms = selectedPlatforms.filter((code) => {
    const c = accountChoice[code];
    return !c || (!c.phone && !c.partition);
  });
  const selectedItem = libraryItems.find((item) => item.id === videoId) ?? null;
  const sourceNeedsQualityReview = !useLatestRemake && selectedItem?.qualityState === "review";
  const sourceBlocked = !useLatestRemake && selectedItem?.qualityState === "blocked";
  const qualityGateSatisfied = mode !== "publish" || !sourceNeedsQualityReview || qualityApproved;
  const canSubmit = Boolean(videoId) && selectedPlatforms.length > 0 && missingAccountPlatforms.length === 0 && !noAccounts && !submitting && online && !sourceBlocked && qualityGateSatisfied;
  const missingImageTextAccountDestinations = imageTextDestinations.filter((destination) => {
    const selectedId = imageTextAccountChoice[destination];
    return !selectedId || !imageTextAccountPools[destination]?.some((account) => account.id === selectedId && account.ready);
  });
  const canSubmitImageText = Boolean(videoId)
    && imageTextDestinations.length > 0
    && missingImageTextAccountDestinations.length === 0
    && !submitting;

  async function submitImageText() {
    if (!videoId || !imageTextDestinations.length) { setMsg("请先选择内容包和至少一个图文平台"); return; }
    if (missingImageTextAccountDestinations.length) {
      setMsg("请为每个图文平台选择一个已就绪的明确账号");
      return;
    }
    const action = imageTextMode === "publish" ? "正式发布" : "创建公众号草稿";
    if (!window.confirm("确认" + action + "？小红书没有平台草稿接口，只有选择正式发布时才会发送。")) return;
    setSubmitting(true);
    try {
      const accountIdByDestination = Object.fromEntries(imageTextDestinations.flatMap((destination) => {
        const account = imageTextAccountPools[destination]?.find((item) => item.id === imageTextAccountChoice[destination]);
        return account && !account.legacy ? [[destination, account.id]] : [];
      }));
      const result = await zapi(LOCAL_AGENT + "/api/v1/publish/image-text", "POST", {
        videoId,
        title: title.trim(),
        content: selectedItem?.copywriting || selectedItem?.title || "",
        tags: tags.split(/[,，\s]+/).map((item) => item.trim()).filter(Boolean),
        destinations: imageTextDestinations,
        accountIdByDestination,
        accountIds: accountIdByDestination,
        mode: imageTextMode,
        scheduledAt: scheduledAt || undefined,
      }, { timeoutMs: 10 * 60_000, confirmedAction: true });
      const resultRecord = recordOf(result.body);
      const taskRecord = recordOf(resultRecord?.task);
      const rows = (result.body as { results?: Array<{ destination: string; success: boolean; status: string; error?: string }> } | null)?.results || [];
      const resultScheduledAt = taskRecord?.scheduledAt || scheduledAt || null;
      setMsg(rows.length ? rows.map((row) => {
        const platform = publishPlatformLabel(row.destination) || "平台";
        const detail = row.success
          ? publishStatusText(row.status, { scheduledAt: resultScheduledAt })
          : publishFailureText(row.error || row.status);
        return `${platform}：${detail}`;
      }).join("；") : "图文任务未返回结果");
    } finally { setSubmitting(false); }
  }

  async function submit() {
    if (!canSubmit) return;
    if (!window.confirm(mode === "publish" ? "确认提交正式发布？织台将把内容送入真实平台。" : "确认创建平台草稿？不会直接公开发布。")) return;
    setSubmitting(true);
    setMsg("");
    const tagList = tags.split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean).slice(0, 4);
    try {
      const res = await fetch(`${LOCAL_AGENT}/api/v1/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Zhitai-Action": "confirm" },
        body: JSON.stringify({
          videoId,
          title: title.trim() || (libraryItems.find((v) => v.id === videoId)?.title ?? ""),
          tags: tagList,
          bt2: bt2.trim() || undefined,
          mode,
          scheduledAt: scheduledAt || undefined,
          draft: mode !== "publish",
          allowQualityReview: qualityApproved,
          useLatestRemake,
          destinations: selectedPlatforms.map((code) => ({
            platform: code,
            phone: accountChoice[code]?.phone || undefined,
            partition: accountChoice[code]?.partition || undefined,
            creativeStatement: statementMap[code] || undefined,
          })),
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { setMsg("提交失败：" + publishFailureText(data && (data.error || data.message))); return; }
      const responseTask = recordOf(data?.task);
      const responseResults = recordOf(data?.results);
      const responseDetail = recordOf(responseResults?.detail);
      const responseStatus = firstText(responseDetail, ["status"])
        || firstText(responseTask, ["status"])
        || (data?.scheduled === true ? "scheduled" : "submitted");
      const responseScheduledAt = responseTask?.scheduledAt || scheduledAt || null;
      const responseTotal = typeof responseResults?.total === "number" ? responseResults.total : selectedPlatforms.length;
      setMsg(`已受理 ${responseTotal} 个平台：${publishStatusText(responseStatus, { scheduledAt: responseScheduledAt })}`);
      void loadAll();
    } catch (e) {
      setMsg("提交失败：" + publishFailureText(e instanceof Error ? e.message : e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <section className="publish-hero publish-hero-compact">
        <div>
          <span className="eyebrow-pill light"><i /> {online ? "发布引擎在线" : "发布引擎未运行"}</span>
          <h2>账号、内容、平台，<br />在一个页面完成。</h2>
          <p>先确认账号，再选择一个内容包，同时生成视频平台草稿和相关图文。正式公开仍需你最后确认。</p>
          <div className="publish-hero-actions">
            <button className="secondary-button" type="button" onClick={() => void loadAll(true)}>刷新状态</button>
          </div>
        </div>
        <div className="publish-summary-chips" aria-label="发布中心状态摘要">
          <div><small>引擎</small><strong>{status ? (status.binaryExists ? (online ? "在线" : "未运行") : "未安装") : "读取中"}</strong></div>
          <div><small>视频账号</small><strong>{accounts.length}</strong></div>
          <div><small>发布记录</small><strong>{history.length}</strong></div>
          <div><small>可用平台</small><strong>{platforms.length}</strong></div>
        </div>
      </section>

      {msg && <p className="xianyu-msg">{msg}</p>}

      {/* 视频账号：登录入口始终保留，已有账号时也可继续添加。 */}
      <section className="panel table-panel">
        <div className="panel-heading table-heading">
          <div><span>账号与渠道</span><h3>抖音 · 视频号</h3></div>
          <div className="filter-pills"><button type="button" className="active">{accounts.length} 个已识别</button></div>
        </div>
        <div className="publisher-login-strip">
          <div>
            <strong>扫码添加视频账号</strong>
            <span>{loginPlatform === "sph" ? "视频号会临时打开官方登录窗口；完成后自动关闭并保存。" : "手机号只用作本机会话分区；扫码成功后自动保存登录态。"}</span>
          </div>
          <select value={loginPlatform} onChange={(e) => setLoginPlatform(e.target.value as "dy" | "sph")}><option value="dy">抖音</option><option value="sph">视频号</option></select>
          <input value={loginPhone} inputMode="numeric" onChange={(e) => setLoginPhone(e.target.value.replace(/\D/g, "").slice(0, 11))} placeholder="11 位手机号" />
          <button className="lime-button" type="button" onClick={() => void startLogin()}>{loginPlatform === "sph" ? "打开登录窗口" : "生成二维码"}</button>
        </div>
        {login && <div className="publisher-login-result">
          <div><strong>{login.status === "success" ? "账号已连接" : login.status === "failed" ? "登录需要处理" : login.qrAvailable ? "二维码已安全发送到手机" : login.interactionMode === "window" ? "正在准备官方登录" : "正在生成二维码"}</strong><p>{login.message}</p></div>
        </div>}
        {noAccounts ? <div className="publisher-empty-line"><strong>还没有可用的视频账号</strong><span>在上方生成二维码并扫码；完成后账号会自动出现在这里。</span></div> : (
          <div className="data-table task-table">
            <div className="table-row table-header"><span>平台</span><span>账号</span><span>登录态</span><span /></div>
            {accounts.map((acc, i) => (
              <div className="table-row" key={i}>
                <div className="table-content-cell"><p><strong>{acc.platform || "—"}</strong></p></div>
                <span>{acc.phone ? "手机号 " + acc.phone : acc.partition ? "分区 " + acc.partition : "—"}</span>
                <span>{acc.error ? acc.error : acc.loginStatus ? String(acc.loginStatus) : "已配置"}</span>
                <span />
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="panel table-panel">
        <div className="panel-heading table-heading">
          <div><span>图文账号</span><h3>小红书图文 · 微信公众号</h3></div>
          <div className="filter-pills"><button type="button" className="active">成熟引擎 / 官方接口</button></div>
        </div>
        <div className="image-text-publisher-grid">
          <article>
            <div className="provider-card-heading">
              <div><strong>小红书图文</strong><span>{xhsAccounts.length} 个账号</span></div>
              <button className="secondary-button" type="button" onClick={() => { setXhsAddOpen((open) => !open); setXhsFeedback({ phase: "idle", message: "" }); }}>添加小红书账号</button>
            </div>
            {xhsAddOpen && <div className="publisher-account-form compact">
              <label><span>本机识别名称</span><input value={xhsLabel} onChange={(event) => setXhsLabel(event.target.value.slice(0, 40))} placeholder="例如：装修案例主号" autoComplete="off" /></label>
              <button className="secondary-button" type="button" disabled={xhsAdding} onClick={() => void addXhsAccount()}>{xhsAdding ? "正在创建…" : "创建并生成二维码"}</button>
            </div>}
            <div className="publisher-account-list">
              {xhsAccounts.map((account) => <div key={account.id} className="publisher-account-row">
                <div><strong>{account.label}</strong><small>{account.username && account.username !== account.label ? account.username + " · " : ""}{account.ready ? "已登录" : account.reason || account.status || "等待登录"}</small></div>
                <span data-ready={account.ready}>{account.ready ? "就绪" : "需扫码"}</span>
                <button className="secondary-button" type="button" disabled={xhsFeedback.phase === "loading"} onClick={() => void loadXhsQr(account.id)}>{account.ready ? "重新登录" : "生成登录二维码"}</button>
              </div>)}
              {!xhsAccounts.length && <p className="publisher-account-empty">{imageTextStatus?.xiaohongshu?.reason || "还没有小红书账号；添加后每个账号使用独立登录会话。"}</p>}
            </div>
            {!xhsAccounts.length && <button className="provider-legacy-login" type="button" disabled={xhsFeedback.phase === "loading"} onClick={() => void loadXhsQr(null)}>登录旧版默认账号</button>}
            {xhsQrAccountId && <p className="provider-login-target">当前登录：{xhsAccounts.find((account) => account.id === xhsQrAccountId)?.label || "新小红书账号"}</p>}
            {xhsFeedback.message && <p className="provider-feedback" data-tone={xhsFeedback.phase}>{xhsFeedback.message}</p>}
            {xhsQr && <div className="provider-qr-block"><img src={xhsQr} alt="小红书登录二维码" /> {/* eslint-disable-line @next/next/no-img-element -- 本地临时二维码不经过图片优化 */}<button className="secondary-button" type="button" disabled={xhsFeedback.phase === "loading"} onClick={() => void refreshImageTextAccounts()}>扫码后检查登录结果</button></div>}
          </article>
          <article>
            <div className="provider-card-heading">
              <div><strong>微信公众号图文</strong><span>{wechatAccounts.length} 个账号</span></div>
              <button className="secondary-button" type="button" onClick={() => { setWechatAccountId(null); setWechatLabel(""); setWechatAppId(""); setWechatAppSecret(""); setWechatFormOpen(true); setWechatFeedback({ phase: "idle", message: "" }); }}>添加公众号</button>
            </div>
            <div className="publisher-account-list">
              {wechatAccounts.map((account) => <div key={account.id} className="publisher-account-row">
                <div><strong>{account.label}{account.isDefault ? " · 默认草稿" : ""}</strong><small>{account.ready ? "凭据已配置" : account.reason || account.status || "等待配置"}</small></div>
                <span data-ready={account.ready}>{account.ready ? "就绪" : "需配置"}</span>
                <button className="secondary-button" type="button" onClick={() => { setWechatAccountId(account.id); setWechatLabel(account.label); setWechatAppId(""); setWechatAppSecret(""); setWechatFormOpen(true); }}>更新凭据</button>
              </div>)}
              {!wechatAccounts.length && <p className="publisher-account-empty">{imageTextStatus?.wechatOfficial?.reason || "还没有公众号；添加时仅在本机录入开发凭据。"}</p>}
            </div>
            {wechatFormOpen && <div className="publisher-account-form">
              <p>{wechatAccountId ? "重新录入该公众号的凭据；旧值不会回显。" : "新公众号使用独立凭据；AppSecret 提交后立即从表单清除。"}</p>
              <label><span>本机识别名称</span><input value={wechatLabel} onChange={(event) => setWechatLabel(event.target.value.slice(0, 40))} placeholder="例如：品牌服务号" autoComplete="off" /></label>
              <label><span>公众号 AppID</span><input value={wechatAppId} onChange={(event) => setWechatAppId(event.target.value.trim())} placeholder="wx 开头" autoComplete="off" spellCheck={false} /></label>
              <label><span>公众号 AppSecret</span><input value={wechatAppSecret} onChange={(event) => setWechatAppSecret(event.target.value.trim())} placeholder="只在本机录入，不会回显" type="password" autoComplete="new-password" spellCheck={false} /></label>
              <div><button className="secondary-button" type="button" onClick={() => { setWechatFormOpen(false); setWechatAppId(""); setWechatAppSecret(""); }}>取消</button><button className="secondary-button" type="button" disabled={wechatSaving} onClick={() => void saveWechatOfficialCredentials()}>{wechatSaving ? "正在保存…" : "安全保存到本机"}</button></div>
            </div>}
            <button className="provider-external-link" type="button" onClick={() => window.open(imageTextStatus?.wechatOfficial?.loginUrl || "https://mp.weixin.qq.com/", "_blank", "noopener,noreferrer")}>打开微信公众平台 ↗</button>
            {wechatFeedback.message && <p className="provider-feedback" data-tone={wechatFeedback.phase}>{wechatFeedback.message}</p>}
          </article>
        </div>
      </section>

      {/* 新建发布 */}
      <section className="panel table-panel">
        <div className="panel-heading table-heading"><div><span>新建发布</span><h3>从内容包发起</h3></div><div className="filter-pills"><button type="button" className="active">草稿优先</button></div></div>
        <div style={{ padding: 14, display: "grid", gap: 10 }}>
          <div className="inline-capture">
            <select value={videoId} onChange={(e) => { setVideoId(e.target.value); setQualityApproved(false); const v = libraryItems.find((x) => x.id === e.target.value); if (v) { setTitle(defaultPublishTitle(v)); setTags(defaultPublishTags(v)); } }} style={{ minWidth: 0, flex: 1, height: 36, border: "1px solid #dadbd3", borderRadius: 8, padding: "0 10px", background: "#f7f6f2", fontSize: 13 }}>
              <option value="">{libraryItems.length ? "选择知识库中的视频（共 " + libraryItems.length + " 条）…" : "知识库暂无视频"}</option>
              {libraryItems.map((v) => <option key={v.id} value={v.id}>{v.title.slice(0, 48)}</option>)}
            </select>
            <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="发布标题（默认用内容包标题）" style={{ flex: 2, height: 36, border: "1px solid #dadbd3", borderRadius: 8, padding: "0 10px", fontSize: 13, background: "#f7f6f2" }} />
          </div>
          <div className="inline-capture">
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="标签（最多 4 个，逗号分隔）" style={{ flex: 2, height: 36, border: "1px solid #dadbd3", borderRadius: 8, padding: "0 10px", fontSize: 13, background: "#f7f6f2" }} />
            <input value={bt2} onChange={(e) => setBt2(e.target.value)} placeholder="短标题 bt2（可选）" style={{ flex: 1, height: 36, border: "1px solid #dadbd3", borderRadius: 8, padding: "0 10px", fontSize: 13, background: "#f7f6f2" }} />
          </div>
          <div className="inline-capture">
            <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 4 }}><input type="checkbox" checked={mode === "platform_draft"} onChange={(e) => setMode(e.target.checked ? "platform_draft" : "publish")} /> 保存为平台草稿（不直接发布）</label>
            <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 4 }}><input type="checkbox" checked={useLatestRemake} onChange={(e) => { setUseLatestRemake(e.target.checked); setQualityApproved(false); }} /> 使用这条素材最新的一键生成成片</label>
            <input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} style={{ height: 36, border: "1px solid #dadbd3", borderRadius: 8, padding: "0 10px", fontSize: 13, background: "#f7f6f2" }} />
          </div>
          {useLatestRemake && <p style={{ margin: 0, color: "#68755d", fontSize: 14 }}>已自动带入最新生成成片、分析文案和最多 4 个标签；若成片尚未登记成功会明确停止，不会误发原视频。</p>}
          {!useLatestRemake && selectedItem && <p className={`publish-quality-note quality-${selectedItem.qualityState ?? "unknown"}`}><b>原片画质：{selectedItem.qualityLabel ?? "待检测"}</b><span>{selectedItem.qualityReason ?? "提交时将重新检测媒体"}</span></p>}
          {mode === "publish" && sourceNeedsQualityReview && <label className="publish-quality-approval"><input type="checkbox" checked={qualityApproved} onChange={(event) => setQualityApproved(event.target.checked)} /> 我已检查清晰度，确认仍正式发布该原片</label>}
          {sourceBlocked && <p className="publish-quality-blocked">该文件媒体校验异常，已禁止提交；请重新下载或生成后再发布。</p>}
          <div className="image-text-submit embedded">
            <div><strong>相关图文</strong><p>使用同一内容包的文案和 GPT 分镜图；小红书没有草稿接口，正式发送前仍会二次确认。</p></div>
            <div className="image-text-account-choice">
              <label><input type="checkbox" checked={imageTextDestinations.includes("xiaohongshu")} disabled={!xhsAccounts.some((account) => account.ready)} onChange={() => toggleImageTextDestination("xiaohongshu")} /> 小红书图文</label>
              <select aria-label="选择小红书发布账号" value={imageTextAccountChoice.xiaohongshu || ""} disabled={!imageTextDestinations.includes("xiaohongshu")} onChange={(event) => setImageTextAccountChoice((current) => ({ ...current, xiaohongshu: event.target.value }))}>
                <option value="">选择明确账号…</option>
                {xhsAccounts.map((account) => <option key={account.id} value={account.id} disabled={!account.ready}>{account.label}{account.ready ? "" : " · 未登录"}</option>)}
              </select>
            </div>
            <div className="image-text-account-choice">
              <label><input type="checkbox" checked={imageTextDestinations.includes("wechat_official")} disabled={!wechatAccounts.some((account) => account.ready)} onChange={() => toggleImageTextDestination("wechat_official")} /> 微信公众号</label>
              <select aria-label="选择公众号发布账号" value={imageTextAccountChoice.wechat_official || ""} disabled={!imageTextDestinations.includes("wechat_official")} onChange={(event) => setImageTextAccountChoice((current) => ({ ...current, wechat_official: event.target.value }))}>
                <option value="">选择明确账号…</option>
                {wechatAccounts.map((account) => <option key={account.id} value={account.id} disabled={!account.ready}>{account.label}{account.ready ? "" : " · 未配置"}</option>)}
              </select>
            </div>
            <select value={imageTextMode} onChange={(event) => setImageTextMode(event.target.value as "platform_draft" | "publish")}>
              <option value="platform_draft">公众号草稿</option>
              <option value="publish">终审后正式发布</option>
            </select>
            <button className="secondary-button" type="button" disabled={!canSubmitImageText} title={missingImageTextAccountDestinations.length ? "请为每个平台选择一个已就绪账号" : undefined} onClick={() => void submitImageText()}>
              {submitting ? "处理中…" : imageTextMode === "publish" ? "确认并发送图文" : "创建图文草稿"}
            </button>
          </div>
          <div>
            <p style={{ fontSize: 13, color: "#767b72", margin: "0 0 6px" }}>视频平台{noAccounts ? "（需先配置账号）" : ""}：</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {platforms.map((p) => {
                const disabled = noAccounts || !isPlatformEnabled(p);
                const checked = selectedPlatforms.includes(p.code);
                return (
                  <label key={p.code} style={{ display: "flex", alignItems: "center", gap: 6, border: "1px solid #dad9d2", borderRadius: 10, padding: "6px 10px", fontSize: 13, background: checked ? "#eef5e4" : "#fffefa", opacity: disabled ? 0.5 : 1 }}>
                    <input type="checkbox" checked={checked} disabled={disabled} onChange={() => togglePlatform(p.code)} />
                    {p.name}（{p.code}）{p.automated === false ? " · 需人工" : ""}
                  </label>
                );
              })}
              {!platforms.length && <span style={{ fontSize: 13, color: "#8a8f86" }}>平台列表读取中（发布引擎需运行）…</span>}
            </div>
          </div>
          {selectedPlatforms.length > 0 && (
            <div style={{ display: "grid", gap: 8 }}>
              <p style={{ fontSize: 13, color: "#767b72", margin: 0 }}>账号与创意声明（每平台至少一个有效账号）：</p>
              {selectedPlatforms.map((code) => {
                const pool = accounts.filter((a) => a.platform === platformName(code) || a.platform === code || !a.platform);
                return (
                  <div key={code} className="inline-capture">
                    <span style={{ fontSize: 13, flex: 1 }}>{platformName(code)}：</span>
                    <select value={accountChoice[code]?.phone || accountChoice[code]?.partition || ""} onChange={(e) => { const acc = pool.find((a) => (a.phone || a.partition) === e.target.value) || null; chooseAccount(code, acc); }} style={{ flex: 2, height: 32, border: "1px solid #dadbd3", borderRadius: 8, padding: "0 8px", fontSize: 13, background: "#f7f6f2" }}>
                      <option value="">{pool.length ? "选择账号…" : "该平台暂无账号"}</option>
                      {pool.map((a, i) => <option key={i} value={a.phone || a.partition || ""}>{accountLabel(a)}{a.loginStatus ? " · " + String(a.loginStatus) : ""}</option>)}
                    </select>
                    <input value={accountChoice[code]?.partition || ""} onChange={(e) => setAccountChoice((prev) => ({ ...prev, [code]: { phone: prev[code]?.phone, partition: e.target.value } }))} placeholder="或手动输入分区 partition" style={{ flex: 2, height: 32, border: "1px solid #dadbd3", borderRadius: 8, padding: "0 10px", fontSize: 13, background: "#f7f6f2" }} />
                    <select value={statementMap[code] || ""} onChange={(e) => setStatementMap((prev) => ({ ...prev, [code]: e.target.value }))} style={{ flex: 1, height: 32, border: "1px solid #dadbd3", borderRadius: 8, padding: "0 8px", fontSize: 13, background: "#f7f6f2" }}>
                      <option value="">创意声明：无</option>
                      {statements.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                    </select>
                  </div>
                );
              })}
            </div>
          )}
          <div>
            <button className="lime-button" type="button" onClick={() => void submit()} disabled={!canSubmit} title={!canSubmit ? (sourceBlocked ? "媒体校验异常，不能发布" : !qualityGateSatisfied ? "请先确认低画质原片" : noAccounts ? "请先配置发布账号" : missingAccountPlatforms.length ? "请为所有目标平台选择有效账号" : "请选择视频与平台") : undefined}>
              {submitting ? "提交中…" : mode === "publish" ? "确认并提交发布" : "创建平台草稿"}
            </button>
            {noAccounts && <p style={{ fontSize: 13, color: "#a05b3c", margin: "6px 0 0" }}>账号为空，已禁用平台选择与提交；请先在上方扫码登录。</p>}
          </div>
        </div>
      </section>

      <section className="panel table-panel">
        <div className="panel-heading table-heading"><div><span>发布历史</span><h3>发布记录</h3></div><span>{history.length} 条</span></div>
        <div className="data-table task-table">
          <div className="table-row table-header"><span>内容</span><span>状态</span><span /></div>
          {history.map((item, i) => {
            const rec = item as Record<string, unknown>;
            const t = String(rec.title || rec.name || "未命名内容").slice(0, 60);
            return <div className="table-row" key={i}><div className="table-content-cell"><p><strong>{t}</strong><small>{historyPlatformText(rec)} · {historyRecordTimeText(rec)}</small></p></div><span>{historyStatusText(rec)}</span><span /></div>;
          })}
          {!history.length && <div className="empty-state"><span>↗</span><strong>暂无发布记录</strong><p>发布引擎尚无发布记录。</p></div>}
        </div>
      </section>
    </>
  );
}
