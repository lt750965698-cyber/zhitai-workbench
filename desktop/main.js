#!/usr/bin/env node
/* 织台桌面版 · 主进程：窗口 + 服务监管 + 窄 IPC（外置引擎托管） */
"use strict";

const { app, BrowserWindow, ipcMain, nativeImage } = require("electron");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");
const launcher = require("./launcher.js");
const adapter = require("./adapter.js");
const { createCreativeRunner, localMotionFallbackEnabled } = require("./creative-runner.js");
const { createXBookmarkRunner } = require("./x-bookmark-runner.js");
const { createYuanbaoRunner } = require("./yuanbao-runner.js");

const WEB_TITLE = "织台";
const RUNTIME_ROOT = process.env.ZHITAI_RUNTIME_ROOT
  || path.join(os.homedir(), ".local", "share", "zhitai-runtime");
const PROJECT_DIR = process.env.ZHITAI_PROJECT_DIR
  || (process.defaultApp ? path.dirname(__dirname) : path.join(RUNTIME_ROOT, "web"));

// 未打包 Electron 默认都叫 “Electron”，并共享默认 userData/单实例锁语义。
// 织台必须在申请单实例锁前拥有独立身份，避免 MatrixMedia 退出或重启时互相影响。
// Chromium 会把应用名写入 User-Agent；这里必须使用 ASCII，中文会形成非法 HTTP header。
// 用户可见窗口标题仍是“织台”，Dock 显示自定义品牌图。
app.setName("Zhitai");
app.setAppUserModelId("com.zhitai.desktop");
app.setPath("userData", path.join(app.getPath("appData"), "织台"));

let mainWindow = null;
let yuanbaoRunner = null;
let runtimeConditionsInFlight = null;
let runtimeConditionsTimer = null;
const creativeWindows = new Map();
const quietCreativeWindows = new WeakSet();
const backgroundQuietWindows = new WeakSet();

const CREATIVE_STUDIOS = {
  gpt: { title: "织台 · GPT 生图", url: "https://chatgpt.com/" },
  seedance: { title: "织台 · 豆包 Seedance 2.0", url: "https://www.doubao.com/chat/" },
  x: { title: "织台 · X 收藏", url: "https://x.com/i/bookmarks" },
  yuanbao: { title: "织台 · 元宝分析", url: "https://yuanbao.tencent.com/chat/naQivTmsDa" },
};

function keepCreativeStudioQuiet(child) {
  // GPT、豆包、X、元宝都是后台持久网页窗口，第三方页面随时可能新增
  // 自动播放。所有创作窗口一律在 Chromium 输出层静音，并在每次导航后
  // 清掉媒体元素的 autoplay / loop，避免后台任务在夜间突然出声。
  child.webContents.setAudioMuted(true);
  if (quietCreativeWindows.has(child)) return;
  quietCreativeWindows.add(child);
  const quietMedia = () => child.webContents.executeJavaScript(`(() => {
    const quiet = (root = document) => root.querySelectorAll?.('video,audio').forEach((media) => {
      media.autoplay = false;
      media.loop = false;
      media.muted = true;
      media.removeAttribute('autoplay');
      media.removeAttribute('loop');
    });
    quiet();
    if (!window.__zhitaiQuietMediaObserver) {
      window.__zhitaiQuietMediaObserver = new MutationObserver((records) => {
        for (const record of records) for (const node of record.addedNodes) {
          if (node instanceof Element) {
            if (node.matches('video,audio')) quiet(node.parentElement || document);
            else quiet(node);
          }
        }
      });
      window.__zhitaiQuietMediaObserver.observe(document.documentElement, { childList: true, subtree: true });
    }
  })()`, true).catch(() => {});
  child.webContents.on("did-finish-load", quietMedia);
}

function stopWindowMediaWhenBackgrounded(child) {
  if (backgroundQuietWindows.has(child)) return;
  backgroundQuietWindows.add(child);
  const pauseMedia = () => {
    if (!child || child.isDestroyed()) return;
    // 输出层先静音，避免页面脚本与 pause() 之间的竞态漏出一小段声音；
    // 随后暂停所有本地预览，回到前台也不会自行续播。
    child.webContents.setAudioMuted(true);
    child.webContents.executeJavaScript(`(() => {
      document.querySelectorAll('video,audio').forEach((media) => {
        try { media.pause(); } catch (_) {}
        media.autoplay = false;
        media.removeAttribute('autoplay');
      });
    })()`, true).catch(() => {});
  };
  const restoreOutput = () => {
    if (!child || child.isDestroyed()) return;
    child.webContents.setAudioMuted(false);
  };
  child.on("blur", pauseMedia);
  child.on("hide", pauseMedia);
  child.on("minimize", pauseMedia);
  child.on("focus", restoreOutput);
  child.on("show", restoreOutput);
  child.on("restore", restoreOutput);
}

function safeAccountId(value) {
  const clean = String(value || "account-1").trim().replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
  return clean || "account-1";
}

function openCreativeStudio(provider, { show = true, accountId = "account-1" } = {}) {
  const studio = CREATIVE_STUDIOS[provider];
  if (!studio) return { ok: false, error: "不支持的创作工具" };
  const cleanAccountId = provider === "seedance" ? safeAccountId(accountId) : "default";
  const windowKey = `${provider}:${cleanAccountId}`;
  const existing = creativeWindows.get(windowKey);
  if (existing && !existing.isDestroyed()) {
    keepCreativeStudioQuiet(existing);
    if (show) {
      if (existing.isMinimized()) existing.restore();
      existing.show();
      existing.focus();
    }
    return { ok: true, reused: true, window: existing };
  }
  const child = new BrowserWindow({
    show,
    width: 1180,
    height: 820,
    minWidth: 900,
    minHeight: 620,
    parent: mainWindow || undefined,
    title: studio.title,
    backgroundColor: "#f6f5f0",
    webPreferences: {
      // account-1 沿用旧分区，保留用户已经登录的豆包；新增账号各自持久化 Cookie。
      partition: provider === "seedance" && cleanAccountId !== "account-1"
        ? `persist:zhitai-seedance-${cleanAccountId}`
        : "persist:zhitai-creative-studio",
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: provider === "x" ? false : true,
    },
  });
  keepCreativeStudioQuiet(child);
  if (provider === "yuanbao" && yuanbaoRunner) yuanbaoRunner.attach(child);
  creativeWindows.set(windowKey, child);
  child.loadURL(studio.url).catch((error) => {
    // 元宝窗口在写入持久登录 Cookie 后会主动刷新一次。Electron 会把被刷新
    // 取代的旧导航报告为 ERR_ABORTED；这是正常导航切换，不能覆盖成错误页。
    if (String(error?.message || error).includes("ERR_ABORTED") || child.isDestroyed()) return;
    child.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(
      `<!doctype html><meta charset="utf-8"><title>${studio.title}</title><body style="font-family:-apple-system,'PingFang SC',sans-serif;padding:40px"><h2>创作窗口未能打开</h2><p>${String(error?.message || error).replace(/</g, "&lt;")}</p></body>`,
    )).catch(() => {});
  });
  child.on("closed", () => creativeWindows.delete(windowKey));
  return { ok: true, reused: false, window: child, accountId: cleanAccountId };
}

const creativeRunner = createCreativeRunner({ openStudio: openCreativeStudio });
const xBookmarkRunner = createXBookmarkRunner({ openStudio: openCreativeStudio });
yuanbaoRunner = createYuanbaoRunner({ openStudio: openCreativeStudio, runtimeRoot: RUNTIME_ROOT });

const DAILY_CREATIVE_TARGET = 1;
const DAILY_CREATIVE_MAX_ATTEMPTS = DAILY_CREATIVE_TARGET * 4;
const MAX_CONSECUTIVE_REVISION_ATTEMPTS = 2;
const CREATIVE_RETRY_BACKOFF_MS = 4 * 60 * 60_000;
const TRANSIENT_CREATIVE_RETRY_MS = 60_000;
const MAX_CONSECUTIVE_TRANSIENT_RETRIES = 3;
const LEGACY_QUOTA_RECOVERY_MIGRATION_VERSION = 1;
const SAFE_CREATIVE_BINDING_ID = /^[A-Za-z0-9._-]{1,160}$/;
const SAFE_DOUBAO_ACCOUNT_ID = /^[A-Za-z0-9._-]{1,64}$/;
const QUALIFIED_CREATIVE_REVIEW_STATUSES = new Set([
  "approved_for_drafts",
  "approved_for_publish",
]);
const DAILY_CREATIVE_STATE = path.join(RUNTIME_ROOT, "state", "daily-creative.json");
let dailyCreativeBusy = false;
let dailyCreativeRetryTimer = null;

function localDateKey() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
}

async function localJson(pathname, { method = "GET", body, timeoutMs = 10_000 } = {}) {
  const response = await fetch(`http://127.0.0.1:17890${pathname}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`织台节点 HTTP ${response.status}`);
  return response.json();
}

async function dailyAccountIds() {
  if (!mainWindow || mainWindow.isDestroyed()) return ["account-1"];
  const ids = await mainWindow.webContents.executeJavaScript(`(() => {
    try {
      const rows = JSON.parse(localStorage.getItem('zhitai-doubao-accounts-v1') || '[]');
      return Array.isArray(rows) ? rows.map((row) => row && row.id).filter((id) => typeof id === 'string') : [];
    } catch { return []; }
  })()`, true).catch(() => []);
  return Array.isArray(ids) && ids.length ? ids.slice(0, 8) : ["account-1"];
}

async function checkRuntimeConditions(accountIds = [], refresh = false) {
  if (!refresh) return localJson("/api/v1/runtime-conditions");
  if (runtimeConditionsInFlight) return runtimeConditionsInFlight;
  runtimeConditionsInFlight = (async () => {
    const requested = Array.isArray(accountIds) && accountIds.length ? accountIds : await dailyAccountIds();
    const creative = await creativeRunner.probeAccounts(requested);
    await localJson("/api/v1/runtime-conditions/creative", {
      method: "POST",
      body: creative,
      timeoutMs: 30_000,
    });
    return localJson("/api/v1/runtime-conditions/refresh", {
      method: "POST",
      body: {},
      timeoutMs: 120_000,
    });
  })();
  try { return await runtimeConditionsInFlight; }
  finally { runtimeConditionsInFlight = null; }
}

async function readDailyCreativeState() {
  try { return JSON.parse(await fsp.readFile(DAILY_CREATIVE_STATE, "utf8")); }
  catch { return {}; }
}

async function writeDailyCreativeState(state) {
  await fsp.mkdir(path.dirname(DAILY_CREATIVE_STATE), { recursive: true });
  await fsp.writeFile(DAILY_CREATIVE_STATE, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function isClearlyJobSpecificCreativeError(value) {
  return /只有“素材”|旧的行业模板提示词|旧分析记录|生成前质量门|缺少 GPT 分镜图|没有完整的 GPT\/Seedance 分镜提示词|音频质检|(?:配音|旁白).{0,30}(?:过长|不完整|重复|术语|错配|主题|口语|占位)|(?:素材|来源).{0,24}(?:权利|版权|未确认|无法确认)|没有可拼接的视频片段/i
    .test(String(value || ""));
}

/**
 * 把创作失败分成三种范围。这是纯函数，既用于当次结果，也用于迁移
 * 旧 daily-creative.json 里被误记为 provider 的 GPT 页面忙错误。
 */
function classifyCreativeFailure(value) {
  const fields = value && typeof value === "object"
    ? [value.code, value.status, value.error, value.message, value.reason]
    : [value];
  const text = fields.filter((field) => field !== undefined && field !== null).join("\n");

  // runner 的稳定 retryable code 比错误正文更权威；正文会说明“未发现额度异常”，
  // 不能仅因出现“额度”二字被下方旧兼容正则误分为四小时 provider 故障。
  if (/GPT_PAGE_BUSY_RETRYABLE|GPT_IMAGE_TIMEOUT_RETRYABLE|GPT_UI_BUSY|transient[_ -]?ui[_ -]?busy/i.test(text)) {
    return { kind: "transient", scope: "provider_transient", retryAfterMs: TRANSIENT_CREATIVE_RETRY_MS };
  }

  // 真正的认证和额度故障不会因为等待发送按钮而自愈，仍使用提供方长退避。
  if (/(?:waiting[_ -]?gpt[_ -]?login|login[_ -]?required|auth[_ -]?required)|(?:GPT|ChatGPT|账号|登录).{0,24}(?:未登录|登录失效|需要登录|请重新登录|请先.{0,8}登录)|(?:quota|usage limit|rate limit|额度|次数限制|达到次数限制).{0,24}(?:exhausted|reached|不足|用完|耗尽|已满|上限)?/i.test(text)) {
    return { kind: "provider", scope: "provider", retryAfterMs: CREATIVE_RETRY_BACKOFF_MS };
  }

  // 新 runner 使用稳定 code/status；后两项用于兼容已落盘的旧错误。
  if (/GPT 页面仍忙.{0,30}发送按钮尚未恢复/i.test(text)
    || /GPT 生图等待超时.{0,40}未发现登录或额度异常/i.test(text)
    || /找不到明确的发送按钮；?为避免误触语音已停止/i.test(text)) {
    return { kind: "transient", scope: "provider_transient", retryAfterMs: TRANSIENT_CREATIVE_RETRY_MS };
  }

  if (isClearlyJobSpecificCreativeError(text)) {
    return { kind: "job", scope: "job", retryAfterMs: CREATIVE_RETRY_BACKOFF_MS };
  }
  return { kind: "provider", scope: "provider", retryAfterMs: CREATIVE_RETRY_BACKOFF_MS };
}

function qualifiedCreativeReviewCount(reviews, date, { jobId = null, assetId = null } = {}) {
  const boundJobId = String(jobId || "").trim();
  const boundAssetId = String(assetId || "").trim();
  // `date` 是审核落盘日，不是“当日内容包”归属证据。启动时的历史复审
  // 也会生成今日 date，所以没有同时绑定 job + asset 时必须失败关闭为 0。
  if (!boundJobId || !boundAssetId) return 0;
  return (Array.isArray(reviews) ? reviews : []).some((row) =>
    row?.date === date
      && String(row?.jobId || "") === boundJobId
      && String(row?.assetId || "") === boundAssetId
      && !row?.revisionTaskId
      && !row?.supersededByReviewId
      && QUALIFIED_CREATIVE_REVIEW_STATUSES.has(String(row?.status || ""))) ? 1 : 0;
}

function isDailyCreativeWindowOpen(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const hour = Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(date));
  return hour >= 8 && hour < 19;
}

function nextTransientCreativeRetryAt(now = Date.now()) {
  const nowAt = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(nowAt) || !isDailyCreativeWindowOpen(new Date(nowAt))) return null;
  const retryAt = nowAt + TRANSIENT_CREATIVE_RETRY_MS;
  // 18:59 后的短故障不得被换算成 22:xx 长退避；窗口外留给次日正常队列。
  return isDailyCreativeWindowOpen(new Date(retryAt)) ? new Date(retryAt).toISOString() : null;
}

function previousTransientCreativeRetry(previous, today, now = Date.now()) {
  const nowAt = now instanceof Date ? now.getTime() : Number(now);
  // 队列达到有界重试阈值后会明确落为 needs_attention。即使错误正文仍
  // 包含 GPT_PAGE_BUSY_RETRYABLE，也不能再被旧错误迁移逻辑重新激活。
  if (previous?.lastErrorScope === "transient_exhausted") {
    return { isTransient: false, crossDate: false, retryAt: null, retryAtIso: null, ready: false };
  }
  const failure = classifyCreativeFailure({
    status: previous?.lastErrorScope,
    error: previous?.lastError,
  });
  // 旧版 busy 可能在 19 点后一直没机会迁移，因此不能以 daily state
  // 的日期作为是否可恢复的条件。错误标识本身才是权威依据。
  const isTransient = Boolean(previous?.lastError)
    && failure.kind === "transient";
  if (!isTransient || !Number.isFinite(nowAt)) {
    return { isTransient: false, crossDate: false, retryAt: null, retryAtIso: null, ready: false };
  }
  const savedRetryAt = Date.parse(String(previous?.retryOnceAfter || ""));
  const lastAttemptAt = Date.parse(String(previous?.lastAttemptAt || ""));
  const retryAt = Number.isFinite(savedRetryAt)
    ? savedRetryAt
    : (Number.isFinite(lastAttemptAt) ? lastAttemptAt : nowAt) + TRANSIENT_CREATIVE_RETRY_MS;
  return {
    isTransient: true,
    crossDate: previous?.date !== today,
    retryAt,
    retryAtIso: isDailyCreativeWindowOpen(new Date(retryAt)) ? new Date(retryAt).toISOString() : null,
    ready: retryAt <= nowAt,
  };
}

function scheduleDailyCreativeRetry(retryAt) {
  const retryAtMs = Date.parse(String(retryAt || ""));
  if (!Number.isFinite(retryAtMs) || !isDailyCreativeWindowOpen(new Date(retryAtMs))) return false;
  if (dailyCreativeRetryTimer) clearTimeout(dailyCreativeRetryTimer);
  dailyCreativeRetryTimer = setTimeout(() => {
    dailyCreativeRetryTimer = null;
    void runDailyCreativeQueue();
  }, Math.max(0, retryAtMs - Date.now()));
  return true;
}

function activeJobRetryAfter(previous, today, now = Date.now()) {
  if (previous?.date !== today || !previous?.jobRetryAfter || typeof previous.jobRetryAfter !== "object") return {};
  return Object.fromEntries(Object.entries(previous.jobRetryAfter)
    .filter(([jobId, retryAt]) => /^[A-Za-z0-9._-]{1,160}$/.test(jobId)
      && Number.isFinite(Date.parse(String(retryAt || "")))
      && Date.parse(String(retryAt)) > now)
    .slice(-64));
}

function preferredCreativeRetryDisposition(jobs, preferredJobId, now = Date.now()) {
  if (!preferredJobId) return { action: "normal", job: null, retryAt: null };
  const rows = Array.isArray(jobs) ? jobs : [];
  const job = rows.find((row) => row?.id === preferredJobId) || null;
  if (!job || ["completed", "cancelled"].includes(job.status)) {
    return { action: "stale", job, retryAt: null };
  }
  if (["ready_for_images", "ready_for_seedance"].includes(job.status)) {
    return { action: "ready", job, retryAt: null };
  }
  if (job.status === "transient_wait") {
    const retryAt = Date.parse(String(job.nextRetryAt || ""));
    if (Number.isFinite(retryAt) && retryAt > now) {
      return { action: "wait", job, retryAt: new Date(retryAt).toISOString() };
    }
    // 本地队列自己的计时器负责恢复原断点。桌面端不得调用 /resume，
    // 因为该接口属于用户显式重试，会重置连续 busy 次数。
    return { action: "wait_restore", job, retryAt: new Date(now + 1_000).toISOString() };
  }
  // needs_attention 是有界自动重试的通用硬边界；除上方严格绑定且带
  // 一次性 marker 的旧纯额度迁移外，只有用户显式点击 resume/retry
  // 才能重置计数，桌面定时器绝不能替用户恢复。
  if (job.status === "needs_attention") return { action: "blocked", job, retryAt: null };
  return { action: "stale", job, retryAt: null };
}

function revisionAssetIdsFromReviews(reviews) {
  const latestByAsset = new Map();
  for (const row of Array.isArray(reviews) ? reviews : []) {
    const assetId = String(row?.assetId || "");
    if (!assetId) continue;
    const updatedAt = Date.parse(String(row?.updatedAt || row?.createdAt || ""));
    const known = latestByAsset.get(assetId);
    const knownAt = Date.parse(String(known?.updatedAt || known?.createdAt || ""));
    if (!known || (Number.isFinite(updatedAt) && (!Number.isFinite(knownAt) || updatedAt > knownAt))) {
      latestByAsset.set(assetId, row);
    }
  }
  return new Set([...latestByAsset.entries()]
    .filter(([, row]) => row?.status === "needs_revision" && Array.isArray(row?.feedback) && row.feedback.length)
    .map(([assetId]) => assetId));
}

function selectDailyCreativeJob(
  jobs,
  attemptedJobIds,
  jobRetryAfter,
  revisionAssetIds = new Set(),
  revisionPriorityStreak = 0,
  now = Date.now(),
  preferredJobId = null,
  lockedAssetId = null,
) {
  const candidates = (Array.isArray(jobs) ? jobs : []).filter((row) => {
    if (!row) return false;
    if (!["ready_for_images", "ready_for_seedance"].includes(row.status)) return false;
    if (lockedAssetId && String(row.assetId || "") !== String(lockedAssetId)) return false;
    if (attemptedJobIds.has(row.id)) return false;
    const retryAt = Date.parse(String(jobRetryAfter?.[row.id] || ""));
    return !Number.isFinite(retryAt) || retryAt <= now;
  }).sort((left, right) => {
    const leftAt = Date.parse(String(left?.createdAt || ""));
    const rightAt = Date.parse(String(right?.createdAt || ""));
    if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) return leftAt - rightAt;
    return String(left?.id || "").localeCompare(String(right?.id || ""));
  });
  // 短重试是原任务的断点续跑；原 job 已被完成/取消时宁可结束这次计时器，
  // 也不借“重试”名义启动另一条内容。
  if (preferredJobId) return candidates.find((row) => row.id === preferredJobId) || null;
  const revisions = candidates.filter((row) => revisionAssetIds.has(String(row?.assetId || "")));
  const backlog = candidates.filter((row) => !revisionAssetIds.has(String(row?.assetId || "")));
  // 返工先行，但每连续尝试两条返工就让一个普通 backlog 前进，保证确定性且不饿死。
  if (revisions.length && (revisionPriorityStreak < MAX_CONSECUTIVE_REVISION_ATTEMPTS || !backlog.length)) return revisions[0];
  return backlog[0] || revisions[0] || null;
}

function dailyContentPackageIdForDate(today) {
  const date = String(today || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("daily_content_package_date_invalid");
  // 日期本身就是自然日幂等键：同一天所有平台和所有 6 小时运行必须复用
  // 同一内容包，跨天则必然得到不同 ID，避免重启后误生成第二个主体。
  return `daily_content_${date.replaceAll("-", "")}`;
}

function legacyQuotaOnlyAccountIds(value) {
  if (typeof value !== "string" || value !== value.trim()) return null;
  const prefix = "没有可用的豆包账号：";
  if (!value.startsWith(prefix)) return null;
  const entries = value.slice(prefix.length).split("；");
  if (!entries.length || entries.some((entry) => !entry)) return null;
  const accountIds = [];
  for (const entry of entries) {
    const suffix = " 今日额度已用完";
    if (!entry.endsWith(suffix)) return null;
    const accountId = entry.slice(0, -suffix.length);
    if (!SAFE_DOUBAO_ACCOUNT_ID.test(accountId) || accountIds.includes(accountId)) return null;
    accountIds.push(accountId);
  }
  return accountIds;
}

function legacyQuotaDailyMigrationDecision({
  previous,
  today,
  job,
  localMotionEnabled = localMotionFallbackEnabled(),
} = {}) {
  const expectedPackageId = dailyContentPackageIdForDate(today);
  if (!localMotionEnabled) return { action: "blocked", reason: "local_motion_disabled" };
  if (previous?.date !== today || previous?.dailyContentPackageId !== expectedPackageId) {
    return { action: "blocked", reason: "daily_package_mismatch" };
  }
  const jobId = String(previous?.jobId || "");
  const assetId = String(previous?.lockedAssetId || "");
  if (!SAFE_CREATIVE_BINDING_ID.test(jobId) || !SAFE_CREATIVE_BINDING_ID.test(assetId)) {
    return { action: "blocked", reason: "daily_binding_invalid" };
  }
  // 任意已落盘 marker 都代表本自然日/内容包已经消费过这次兼容恢复。
  // 无论上一次 resume 的进程在哪个时点退出，都不能再次调用恢复接口。
  if (previous?.quotaRecoveryMigration !== undefined && previous?.quotaRecoveryMigration !== null) {
    return { action: "blocked", reason: "already_attempted" };
  }
  const dailyAccounts = legacyQuotaOnlyAccountIds(previous?.lastError);
  const jobAccounts = legacyQuotaOnlyAccountIds(job?.error);
  if (!dailyAccounts || !jobAccounts || previous.lastError !== job?.error) {
    return { action: "blocked", reason: "legacy_error_not_quota_only" };
  }
  if (job?.id !== jobId || String(job?.assetId || "") !== assetId) {
    return { action: "blocked", reason: "job_binding_mismatch" };
  }
  if (job?.status !== "needs_attention" || job?.resumeStatus !== "ready_for_seedance") {
    return { action: "blocked", reason: "job_state_not_migratable" };
  }
  return {
    action: "resume_once",
    reason: "legacy_quota_state_requires_structured_reprobe",
    dailyContentPackageId: expectedPackageId,
    jobId,
    assetId,
    accountIds: dailyAccounts,
  };
}

function retainedQuotaRecoveryMigration(previous, today) {
  if (previous?.date !== today
    || previous?.dailyContentPackageId !== dailyContentPackageIdForDate(today)
    || previous?.quotaRecoveryMigration === undefined
    || previous?.quotaRecoveryMigration === null) return null;
  return previous.quotaRecoveryMigration;
}

function isBoundAttemptedQuotaRecoveryMigration(previous, today, marker) {
  const expectedPackageId = dailyContentPackageIdForDate(today);
  return marker && typeof marker === "object"
    && marker.version === LEGACY_QUOTA_RECOVERY_MIGRATION_VERSION
    && marker.status === "attempted"
    && previous?.date === today
    && previous?.dailyContentPackageId === expectedPackageId
    && marker.dailyContentPackageId === expectedPackageId
    && SAFE_CREATIVE_BINDING_ID.test(String(previous?.jobId || ""))
    && SAFE_CREATIVE_BINDING_ID.test(String(previous?.lockedAssetId || ""))
    && marker.jobId === previous.jobId
    && marker.assetId === previous.lockedAssetId;
}

function localDateKeyForTimestamp(value) {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(parsed);
}

function resolveDailyCreativeBinding(previous, today, jobs, reviews) {
  const rows = Array.isArray(jobs) ? jobs : [];
  const reviewRows = Array.isArray(reviews) ? reviews : [];
  const expectedPackageId = dailyContentPackageIdForDate(today);
  const samePackage = previous?.date === today
    && (!previous?.dailyContentPackageId || previous.dailyContentPackageId === expectedPackageId);
  const storedJobId = samePackage && /^[A-Za-z0-9._-]{1,160}$/.test(String(previous?.jobId || ""))
    ? String(previous.jobId)
    : null;
  const storedAssetId = samePackage && /^[A-Za-z0-9._-]{1,160}$/.test(String(previous?.lockedAssetId || ""))
    ? String(previous.lockedAssetId)
    : null;
  const storedJob = storedJobId ? rows.find((row) => row?.id === storedJobId) || null : null;

  // 新状态里的 lockedAssetId 是当日主体的权威锁。即使最后一个返工 job
  // 已终态或丢失，也只能继续同素材，不能悄然切换主题。
  if (storedAssetId) {
    const jobMatchesLock = storedJob
      && String(storedJob.assetId || "") === storedAssetId;
    return {
      dailyContentPackageId: expectedPackageId,
      jobId: jobMatchesLock ? storedJobId : null,
      lockedAssetId: storedAssetId,
      source: jobMatchesLock ? "persisted_lock" : "persisted_asset_lock",
    };
  }

  if (storedJob) {
    const assetId = String(storedJob.assetId || "").trim();
    const historicalTerminal = ["completed", "cancelled"].includes(String(storedJob.status || ""))
      && localDateKeyForTimestamp(storedJob.createdAt) !== today;
    // 旧版只落了 jobId：非终态任务或当天真正新建的终态任务可以一次性
    // 迁移出 asset 锁。历史 completed 任务在今天复审时不能借 date 反向占额。
    if (assetId && !historicalTerminal) {
      return {
        dailyContentPackageId: expectedPackageId,
        jobId: storedJobId,
        lockedAssetId: assetId,
        source: "legacy_job_migration",
      };
    }
  }

  // 兼容旧状态已被一次历史复审覆盖的情况：只有“今日 needs_revision
  // 明确指向的、今日新建且尚未终态的唯一返工任务”才可恢复。多个候选
  // 时失败关闭，绝不猜测主题。
  const recoveryCandidates = reviewRows
    .filter((row) => row?.date === today
      && row?.status === "needs_revision"
      && /^[A-Za-z0-9._-]{1,160}$/.test(String(row?.revisionTaskId || "")))
    .map((row) => {
      const job = rows.find((candidate) => candidate?.id === row.revisionTaskId) || null;
      return job && String(job.assetId || "") === String(row.assetId || "") ? job : null;
    })
    .filter((job) => job
      && !["completed", "cancelled"].includes(String(job.status || ""))
      && localDateKeyForTimestamp(job.createdAt) === today);
  const uniqueRecoveryJobs = [...new Map(recoveryCandidates.map((job) => [job.id, job])).values()];
  if (uniqueRecoveryJobs.length === 1) {
    const job = uniqueRecoveryJobs[0];
    const assetId = String(job.assetId || "").trim();
    if (assetId) {
      return {
        dailyContentPackageId: expectedPackageId,
        jobId: String(job.id),
        lockedAssetId: assetId,
        source: "unique_today_revision_recovery",
      };
    }
  }
  return {
    dailyContentPackageId: expectedPackageId,
    jobId: null,
    lockedAssetId: null,
    source: uniqueRecoveryJobs.length > 1 ? "ambiguous" : "unbound",
  };
}

function dailyCreativeState({
  today,
  jobId = null,
  lockedAssetId = null,
  qualifiedToday = 0,
  lastError = null,
  lastErrorScope = null,
  providerRetryAfter = null,
  jobRetryAfter = {},
  revisionPriorityStreak = 0,
  retryOnceAfter = null,
  quotaRecoveryMigration = null,
}) {
  return {
    date: today,
    dailyContentPackageId: dailyContentPackageIdForDate(today),
    lastAttemptAt: new Date().toISOString(),
    jobId,
    lockedAssetId,
    // 保留 completedToday 兼容旧状态读取者，但其含义已收紧为“合格且可进草稿/公开”。
    completedToday: qualifiedToday,
    qualifiedToday,
    lastError,
    lastErrorScope,
    providerRetryAfter,
    jobRetryAfter,
    revisionPriorityStreak,
    retryOnceAfter,
    quotaRecoveryMigration,
  };
}

async function migrateLegacyQuotaDailyState(previous, today, now = Date.now()) {
  let quotaRecoveryMigration = retainedQuotaRecoveryMigration(previous, today);
  let jobsPayload = null;
  let jobs = [];
  // 若进程在 resume 成功回执与第二次状态落盘之间退出，attempt marker
  // 禁止再次调用 resume；这里只读回队列，确认原 job 已在目标断点后收口。
  if (isBoundAttemptedQuotaRecoveryMigration(previous, today, quotaRecoveryMigration)) {
    jobsPayload = await localJson("/api/v1/creative/jobs").catch(() => null);
    jobs = Array.isArray(jobsPayload?.jobs) ? jobsPayload.jobs : [];
    const resumed = jobs.find((row) => row?.id === previous.jobId) || null;
    if (resumed?.status === "ready_for_seedance"
      && String(resumed?.assetId || "") === previous.lockedAssetId) {
      quotaRecoveryMigration = {
        ...quotaRecoveryMigration,
        status: "completed",
        finishedAt: new Date().toISOString(),
      };
      const jobRetryAfter = activeJobRetryAfter(previous, today, now);
      delete jobRetryAfter[previous.jobId];
      const nextState = dailyCreativeState({
        today,
        jobId: previous.jobId,
        lockedAssetId: previous.lockedAssetId,
        qualifiedToday: 0,
        lastError: null,
        lastErrorScope: null,
        providerRetryAfter: null,
        jobRetryAfter,
        revisionPriorityStreak: Number(previous.revisionPriorityStreak) || 0,
        retryOnceAfter: null,
        quotaRecoveryMigration,
      });
      await writeDailyCreativeState(nextState);
      return {
        previous: nextState,
        quotaRecoveryMigration,
        resumedJobId: previous.jobId,
        stop: false,
      };
    }
    return { previous, quotaRecoveryMigration, resumedJobId: null, stop: false };
  }
  const mayNeedMigration = quotaRecoveryMigration === null
    && legacyQuotaOnlyAccountIds(previous?.lastError)
    && localMotionFallbackEnabled(process.env.ZHITAI_LOCAL_MOTION_FALLBACK);
  if (!mayNeedMigration) {
    return { previous, quotaRecoveryMigration, resumedJobId: null, stop: false };
  }

  jobsPayload = await localJson("/api/v1/creative/jobs").catch(() => null);
  jobs = Array.isArray(jobsPayload?.jobs) ? jobsPayload.jobs : [];
  const job = jobs.find((row) => row?.id === previous?.jobId) || null;
  const decision = legacyQuotaDailyMigrationDecision({
    previous,
    today,
    job,
    localMotionEnabled: localMotionFallbackEnabled(process.env.ZHITAI_LOCAL_MOTION_FALLBACK),
  });
  if (decision.action !== "resume_once") {
    return { previous, quotaRecoveryMigration, resumedJobId: null, stop: false };
  }

  // 先写 attempt marker，再调用 resume：即便进程恰好在请求后退出，下一次
  // 定时运行也不会再次消费这条兼容迁移。旧错误只授权一次结构化重探测，
  // 绝不直接成为 LocalMotion fallback 的批准证据。
  const attemptedAt = new Date(now).toISOString();
  quotaRecoveryMigration = {
    version: LEGACY_QUOTA_RECOVERY_MIGRATION_VERSION,
    status: "attempted",
    dailyContentPackageId: decision.dailyContentPackageId,
    jobId: decision.jobId,
    assetId: decision.assetId,
    attemptedAt,
  };
  const jobRetryAfter = activeJobRetryAfter(previous, today, now);
  delete jobRetryAfter[decision.jobId];
  let nextState = dailyCreativeState({
    today,
    jobId: decision.jobId,
    lockedAssetId: decision.assetId,
    qualifiedToday: 0,
    lastError: previous.lastError,
    lastErrorScope: previous.lastErrorScope || null,
    providerRetryAfter: previous.providerRetryAfter || null,
    jobRetryAfter,
    revisionPriorityStreak: Number(previous.revisionPriorityStreak) || 0,
    retryOnceAfter: previous.retryOnceAfter || null,
    quotaRecoveryMigration,
  });
  await writeDailyCreativeState(nextState);

  let response;
  try {
    response = await localJson(`/api/v1/creative/jobs/${encodeURIComponent(decision.jobId)}/resume`, {
      method: "POST",
      body: {},
    });
  } catch {
    // attempted marker 已持久化；网络或节点失败也不自动发第二个 resume。
    return { previous: nextState, quotaRecoveryMigration, resumedJobId: null, stop: true };
  }
  const resumed = response?.job;
  if (!response?.ok
    || resumed?.id !== decision.jobId
    || String(resumed?.assetId || "") !== decision.assetId
    || resumed?.status !== "ready_for_seedance") {
    quotaRecoveryMigration = {
      ...quotaRecoveryMigration,
      status: "resume_rejected",
      finishedAt: new Date().toISOString(),
    };
    nextState = { ...nextState, quotaRecoveryMigration };
    await writeDailyCreativeState(nextState);
    return { previous: nextState, quotaRecoveryMigration, resumedJobId: null, stop: true };
  }

  quotaRecoveryMigration = {
    ...quotaRecoveryMigration,
    status: "completed",
    finishedAt: new Date().toISOString(),
  };
  nextState = dailyCreativeState({
    today,
    jobId: decision.jobId,
    lockedAssetId: decision.assetId,
    qualifiedToday: 0,
    lastError: null,
    lastErrorScope: null,
    providerRetryAfter: null,
    jobRetryAfter,
    revisionPriorityStreak: Number(previous.revisionPriorityStreak) || 0,
    retryOnceAfter: null,
    quotaRecoveryMigration,
  });
  await writeDailyCreativeState(nextState);
  return {
    previous: nextState,
    quotaRecoveryMigration,
    resumedJobId: decision.jobId,
    stop: false,
  };
}

async function runDailyCreativeQueue() {
  if (dailyCreativeBusy || creativeRunner?.isBusy?.()) return;
  const creativeWindowOpen = isDailyCreativeWindowOpen();
  if (creativeWindowOpen && dailyCreativeRetryTimer) {
    clearTimeout(dailyCreativeRetryTimer);
    dailyCreativeRetryTimer = null;
  }
  dailyCreativeBusy = true;
  try {
    const today = localDateKey();
    let previous = await readDailyCreativeState();
    const now = Date.now();
    const quotaMigration = await migrateLegacyQuotaDailyState(previous, today, now);
    previous = quotaMigration.previous;
    let quotaRecoveryMigration = quotaMigration.quotaRecoveryMigration;
    if (quotaMigration.stop) return;
    const quotaMigrationResumedJobId = quotaMigration.resumedJobId;
    const previousPackageMatches = previous.date === today
      && (!previous.dailyContentPackageId
        || previous.dailyContentPackageId === dailyContentPackageIdForDate(today));
    const previousLockedAssetId = previousPackageMatches
      && /^[A-Za-z0-9._-]{1,160}$/.test(String(previous.lockedAssetId || ""))
      ? String(previous.lockedAssetId)
      : null;
    const lastAttempt = Date.parse(String(previous.lastAttemptAt || ""));
    const transientPrevious = previousTransientCreativeRetry(previous, today, now);
    let previousWasTransient = transientPrevious.isTransient;
    let clearedStaleTransient = false;
    let retryOnceAfter = Date.parse(String(previous.retryOnceAfter || ""));
    // 兼容旧版已写入的 provider/22:55 状态：从原 lastAttemptAt 计算一次 60 秒短重试，
    // 不再继承 4 小时的 providerRetryAfter。
    if (previousWasTransient) retryOnceAfter = transientPrevious.retryAt;
    const legacyTransientScope = previousWasTransient
      && previous.lastErrorScope !== "provider_transient"
      && /^[A-Za-z0-9._-]{1,160}$/.test(String(previous.jobId || ""));
    if (legacyTransientScope) {
      // 旧 runner 已把同一错误写成 needs_attention。单改 daily state 不足以续跑，
      // 还需将队列项迁移为 transient_wait，并保留原分镜断点。
      const queueSnapshot = await localJson("/api/v1/creative/jobs").catch(() => null);
      const queuedRows = Array.isArray(queueSnapshot?.jobs) ? queueSnapshot.jobs : null;
      const queuedJob = queuedRows?.find((row) => row?.id === previous.jobId) || null;
      if (queuedRows && (!queuedJob || ["completed", "cancelled"].includes(queuedJob.status))) {
        // 旧 daily state 指向的 job 已终态/不存在：这是一次性恢复记录，
        // 清理后允许正常队列继续，不会每天固定偏好一个消失的 id。
        await writeDailyCreativeState(dailyCreativeState({
          today,
          lockedAssetId: previousLockedAssetId,
          quotaRecoveryMigration,
        }));
        previousWasTransient = false;
        clearedStaleTransient = true;
        retryOnceAfter = Number.NaN;
      } else {
        const retryOnceAfterIso = transientPrevious.ready
          ? nextTransientCreativeRetryAt(now)
          : transientPrevious.retryAtIso;
        const queueRetryAt = retryOnceAfterIso || new Date(now + TRANSIENT_CREATIVE_RETRY_MS).toISOString();
        const migration = await localJson(`/api/v1/creative/jobs/${encodeURIComponent(previous.jobId)}/attention`, {
          method: "POST",
          body: {
            error: String(previous.lastError).slice(0, 500),
            transient: true,
            retryAfterMs: TRANSIENT_CREATIVE_RETRY_MS,
            nextRetryAt: queueRetryAt,
          },
        }).catch(() => null);
        await writeDailyCreativeState(dailyCreativeState({
          today,
          jobId: previous.jobId || null,
          lockedAssetId: previousLockedAssetId || String(queuedJob?.assetId || "") || null,
          // 这里尚未读回与 job + asset 精确绑定的审核，缓存计数不可信。
          qualifiedToday: 0,
          lastError: String(previous.lastError).slice(0, 500),
          // 本地节点短暂不可用时保留可识别的迁移中状态，下次短试重做
          // attention(transient)；绝不覆盖成 provider/4h 而再次丢失原 busy 证据。
          lastErrorScope: migration?.ok ? "provider_transient" : "provider_transient_migration",
          providerRetryAfter: null,
          jobRetryAfter: activeJobRetryAfter(previous, today, now),
          revisionPriorityStreak: previous.date === today ? Number(previous.revisionPriorityStreak) || 0 : 0,
          retryOnceAfter: retryOnceAfterIso,
          quotaRecoveryMigration,
        }));
        if (retryOnceAfterIso) scheduleDailyCreativeRetry(retryOnceAfterIso);
        return;
      }
    }
    // 窗口外可做上面的纯状态恢复，但绝不打开 GPT/豆包或生成新内容。
    // transient_wait 的本地队列会自行回到原断点，次日在正常窗口内定向续跑。
    if (!creativeWindowOpen) return;
    if (previousWasTransient && Number.isFinite(retryOnceAfter) && retryOnceAfter > now) {
      const retryOnceAfterIso = transientPrevious.retryAtIso;
      await writeDailyCreativeState(dailyCreativeState({
        today,
        jobId: previous.jobId || null,
        lockedAssetId: previousLockedAssetId,
        // 短等待不触发审核读回；不延用可能被历史复审污染的旧计数。
        qualifiedToday: 0,
        lastError: String(previous.lastError || "GPT 页面暂时忙").slice(0, 500),
        lastErrorScope: "provider_transient",
        providerRetryAfter: null,
        jobRetryAfter: activeJobRetryAfter(previous, today, now),
        revisionPriorityStreak: Number(previous.revisionPriorityStreak) || 0,
        retryOnceAfter: retryOnceAfterIso,
        quotaRecoveryMigration,
      }));
      if (retryOnceAfterIso) scheduleDailyCreativeRetry(retryOnceAfterIso);
      return;
    }
    const verifiedFixRetryReady = Number.isFinite(retryOnceAfter) && now >= retryOnceAfter;
    const providerRetryAfterAt = Date.parse(String(previous.providerRetryAfter || ""));
    const explicitProviderBackoff = previous.date === today
      && !previousWasTransient
      && !clearedStaleTransient
      && Number.isFinite(providerRetryAfterAt) && providerRetryAfterAt > now;
    const legacyProviderBackoff = previous.date === today
      && !previousWasTransient
      && !clearedStaleTransient
      && !previous.lastErrorScope && previous.lastError
      && Number.isFinite(lastAttempt) && now - lastAttempt < CREATIVE_RETRY_BACKOFF_MS;
    if (!verifiedFixRetryReady && explicitProviderBackoff) return;
    if (!verifiedFixRetryReady && legacyProviderBackoff) {
      // 素材 ID 在知识库补全后可能已由启动恢复流程纠正；若原任务现在明确可继续，
      // 不让旧的 not_found 记录再阻塞当天的备用成片名额。
      // 旧状态没有错误范围；其余网页/UI/登录错误仍按提供方级 4 小时退避。
      const repairedLegacyReference = /(?:creative_asset_not_found|remake_plan_not_found|\bnot[_ -]?found\b|素材.{0,12}(?:不存在|未找到))/i
        .test(String(previous.lastError || ""));
      if (!repairedLegacyReference) return;
      const jobsPayload = await localJson("/api/v1/creative/jobs").catch(() => null);
      const repairedJob = (Array.isArray(jobsPayload?.jobs) ? jobsPayload.jobs : [])
        .find((row) => row.id === previous.jobId && ["ready_for_images", "ready_for_seedance"].includes(row.status));
      if (!repairedJob) return;
    }
    const reviewsPayload = await localJson("/api/v1/creative/reviews");
    const initialReviews = Array.isArray(reviewsPayload?.reviews) ? reviewsPayload.reviews : [];
    // GET reviews 可能在启动过程中触发历史任务复审，因此先从已落盘状态/
    // 唯一返工链恢复当日绑定，再统计严格匹配该 job + asset 的审核。
    const initialJobsPayload = await localJson("/api/v1/creative/jobs");
    const initialJobs = Array.isArray(initialJobsPayload?.jobs) ? initialJobsPayload.jobs : [];
    const binding = resolveDailyCreativeBinding(previous, today, initialJobs, initialReviews);
    let lockedAssetId = binding.lockedAssetId;
    let boundJobId = binding.jobId;
    let qualifiedToday = qualifiedCreativeReviewCount(initialReviews, today, {
      jobId: boundJobId,
      assetId: lockedAssetId,
    });
    if (lockedAssetId && (previous.dailyContentPackageId !== binding.dailyContentPackageId
      || previous.lockedAssetId !== lockedAssetId || previous.jobId !== boundJobId
      || Number(previous.qualifiedToday ?? previous.completedToday ?? 0) !== qualifiedToday)) {
      const sameBoundJob = previous.jobId === boundJobId;
      await writeDailyCreativeState(dailyCreativeState({
        today,
        jobId: boundJobId,
        lockedAssetId,
        qualifiedToday,
        lastError: sameBoundJob ? previous.lastError || null : null,
        lastErrorScope: sameBoundJob ? previous.lastErrorScope || null : null,
        providerRetryAfter: sameBoundJob ? previous.providerRetryAfter || null : null,
        jobRetryAfter: activeJobRetryAfter(previous, today, now),
        revisionPriorityStreak: previous.date === today ? Number(previous.revisionPriorityStreak) || 0 : 0,
        retryOnceAfter: sameBoundJob ? previous.retryOnceAfter || null : null,
        quotaRecoveryMigration,
      }));
    }
    if (qualifiedToday >= DAILY_CREATIVE_TARGET) return;
    const accountIds = await dailyAccountIds();
    const attemptedJobIds = new Set();
    const jobRetryAfter = activeJobRetryAfter(previous, today, now);
    let revisionAssetIds = revisionAssetIdsFromReviews(initialReviews);
    let revisionPriorityStreak = previous.date === today
      ? Math.max(0, Math.min(MAX_CONSECUTIVE_REVISION_ATTEMPTS, Number(previous.revisionPriorityStreak) || 0))
      : 0;
    if (verifiedFixRetryReady && boundJobId) delete jobRetryAfter[boundJobId];
    let preferredRetryJobId = (previousWasTransient || verifiedFixRetryReady
      || quotaMigrationResumedJobId === boundJobId) && boundJobId
      ? String(boundJobId)
      : null;
    // 同一自然日只能运营一个内容主体。旧 job 即使进入返工/完成，仍可用其
    // assetId 锁住当天主题；后续只允许选择同素材的新返工任务。
    let attempts = 0;
    while (qualifiedToday < DAILY_CREATIVE_TARGET && attempts < DAILY_CREATIVE_MAX_ATTEMPTS) {
      // 一轮生成可能耗时很久；19 点后不再开启下一条，已在执行的单条则安全收尾。
      if (!isDailyCreativeWindowOpen()) break;
      const jobsPayload = await localJson("/api/v1/creative/jobs");
      let jobs = Array.isArray(jobsPayload?.jobs) ? jobsPayload.jobs : [];
      if (preferredRetryJobId) {
        let disposition = preferredCreativeRetryDisposition(jobs, preferredRetryJobId, Date.now());
        if (["wait", "wait_restore"].includes(disposition.action)) {
          scheduleDailyCreativeRetry(disposition.retryAt);
          break;
        }
        if (disposition.action === "blocked") {
          // 该任务连续短重试已达阈值。解除一次性优先锁定，让当天其他任务
          // 和次日队列继续；原任务保留 needs_attention 等待用户显式 resume。
          preferredRetryJobId = null;
          await writeDailyCreativeState(dailyCreativeState({
            today,
            jobId: disposition.job?.id || boundJobId,
            lockedAssetId,
            qualifiedToday,
            lastError: String(disposition.job?.error || "网页连续短重试未恢复，已停止自动重试").slice(0, 500),
            lastErrorScope: "transient_exhausted",
            jobRetryAfter,
            revisionPriorityStreak,
            quotaRecoveryMigration,
          }));
        } else if (disposition.action === "stale") {
          // 原任务已终态/不存在时清掉一次性偏好，不得让一条过期 daily state
          // 永久挡住当天的其他合法候选。
          preferredRetryJobId = null;
          await writeDailyCreativeState(dailyCreativeState({
            today,
            jobId: null,
            lockedAssetId,
            qualifiedToday,
            jobRetryAfter,
            revisionPriorityStreak,
            quotaRecoveryMigration,
          }));
        } else if (disposition.action !== "ready") {
          break;
        }
      }
      // 老素材优先，保持每日审核编号与队列顺序稳定。
      const job = selectDailyCreativeJob(
        jobs,
        attemptedJobIds,
        jobRetryAfter,
        revisionAssetIds,
        revisionPriorityStreak,
        Date.now(),
        preferredRetryJobId,
        lockedAssetId,
      );
      preferredRetryJobId = null;
      if (!job) break;
      if (!lockedAssetId) lockedAssetId = String(job.assetId || "") || null;
      const isRevisionAttempt = revisionAssetIds.has(String(job.assetId || ""));
      revisionPriorityStreak = isRevisionAttempt ? revisionPriorityStreak + 1 : 0;
      attemptedJobIds.add(job.id);
      attempts += 1;
      await writeDailyCreativeState(dailyCreativeState({
        today,
        jobId: job.id,
        lockedAssetId,
        qualifiedToday,
        jobRetryAfter,
        revisionPriorityStreak,
        quotaRecoveryMigration,
      }));
      const result = await creativeRunner.run(job.id, job.assetId, accountIds);
      if (!result?.ok) {
        const lastError = String(result?.error || result?.status || "生成失败").slice(0, 500);
        // 登录、额度、网页入口等提供方级错误会影响所有任务，本轮停止并进入通知/退避；
        // 单条素材的质量问题只给该任务退避，继续新返工任务，避免 needs_revision/坏素材饿死队列。
        const failure = classifyCreativeFailure(result);
        if (failure.kind === "transient") {
          // runner 已先把 transient 结果写回本地队列；回读权威状态，避免
          // 第三次 busy 已升级 needs_attention 后仍继续安排第四次定时器。
          const afterFailurePayload = await localJson("/api/v1/creative/jobs").catch(() => null);
          const afterFailureJob = (Array.isArray(afterFailurePayload?.jobs) ? afterFailurePayload.jobs : [])
            .find((row) => row?.id === job.id);
          if (afterFailureJob?.status === "needs_attention"
            && Number(afterFailureJob.transientRetryCount) >= MAX_CONSECUTIVE_TRANSIENT_RETRIES) {
            await writeDailyCreativeState(dailyCreativeState({
              today,
              jobId: job.id,
              lockedAssetId,
              qualifiedToday,
              lastError: String(afterFailureJob.error || lastError).slice(0, 500),
              lastErrorScope: "transient_exhausted",
              providerRetryAfter: null,
              jobRetryAfter,
              revisionPriorityStreak,
              retryOnceAfter: null,
              quotaRecoveryMigration,
            }));
            // attemptedJobIds 已包含该任务；继续本轮只会选择其他合法候选。
            continue;
          }
          const retryOnceAfterIso = nextTransientCreativeRetryAt();
          await writeDailyCreativeState(dailyCreativeState({
            today,
            jobId: job.id,
            lockedAssetId,
            qualifiedToday,
            lastError,
            lastErrorScope: failure.scope,
            providerRetryAfter: null,
            jobRetryAfter,
            revisionPriorityStreak,
            retryOnceAfter: retryOnceAfterIso,
            quotaRecoveryMigration,
          }));
          if (retryOnceAfterIso) scheduleDailyCreativeRetry(retryOnceAfterIso);
          break;
        }
        const jobSpecific = failure.kind === "job";
        const retryAt = new Date(Date.now() + CREATIVE_RETRY_BACKOFF_MS).toISOString();
        if (jobSpecific) jobRetryAfter[job.id] = retryAt;
        await writeDailyCreativeState(dailyCreativeState({
          today,
          jobId: job.id,
          lockedAssetId,
          qualifiedToday,
          lastError,
          lastErrorScope: jobSpecific ? "job" : "provider",
          providerRetryAfter: jobSpecific ? null : retryAt,
          jobRetryAfter,
          revisionPriorityStreak,
          quotaRecoveryMigration,
        }));
        if (jobSpecific) continue;
        break;
      }
      delete jobRetryAfter[job.id];
      // run() 的 complete 接口会同步登记审核回执；以回执状态复核，不把仅“生成结束”误算为合格。
      const refreshedReviews = await localJson("/api/v1/creative/reviews");
      const reviews = Array.isArray(refreshedReviews?.reviews) ? refreshedReviews.reviews : [];
      const review = reviews.find((row) => row?.jobId === job.id);
      boundJobId = job.id;
      qualifiedToday = qualifiedCreativeReviewCount(reviews, today, {
        jobId: boundJobId,
        assetId: lockedAssetId,
      });
      revisionAssetIds = revisionAssetIdsFromReviews(reviews);
      if (!review) {
        const lastError = "成片已生成，但没有取得审核回执；已停止本轮避免超额生成";
        const providerRetryAfter = new Date(Date.now() + CREATIVE_RETRY_BACKOFF_MS).toISOString();
        await writeDailyCreativeState(dailyCreativeState({
          today,
          jobId: job.id,
          lockedAssetId,
          qualifiedToday,
          lastError,
          lastErrorScope: "provider",
          providerRetryAfter,
          jobRetryAfter,
          revisionPriorityStreak,
          quotaRecoveryMigration,
        }));
        break;
      }
      const needsRevision = review.status === "needs_revision";
      await writeDailyCreativeState(dailyCreativeState({
        today,
        jobId: job.id,
        lockedAssetId,
        qualifiedToday,
        lastError: needsRevision ? "该成片需要返工，不计入今日合格目标" : null,
        lastErrorScope: needsRevision ? "job" : null,
        jobRetryAfter,
        revisionPriorityStreak,
        quotaRecoveryMigration,
      }));
    }
  } catch (error) {
    const today = localDateKey();
    const previous = await readDailyCreativeState().catch(() => ({}));
    const quotaRecoveryMigration = retainedQuotaRecoveryMigration(previous, today);
    const previousQualified = previous.qualifiedToday === undefined
      ? previous.completedToday
      : previous.qualifiedToday;
    const packageMatches = previous.date === today
      && (!previous.dailyContentPackageId
        || previous.dailyContentPackageId === dailyContentPackageIdForDate(today));
    const lockedAssetId = packageMatches
      && /^[A-Za-z0-9._-]{1,160}$/.test(String(previous.lockedAssetId || ""))
      ? String(previous.lockedAssetId)
      : null;
    const boundJobId = packageMatches && lockedAssetId
      && /^[A-Za-z0-9._-]{1,160}$/.test(String(previous.jobId || ""))
      ? String(previous.jobId)
      : null;
    // 异常分支不能读回审核；只保留新格式已绑定状态的缓存值。
    const qualifiedToday = boundJobId ? Math.min(1, Math.max(0, Number(previousQualified) || 0)) : 0;
    const failure = classifyCreativeFailure(error);
    const retryOnceAfter = failure.kind === "transient" ? nextTransientCreativeRetryAt() : null;
    const providerRetryAfter = failure.kind === "provider"
      ? new Date(Date.now() + CREATIVE_RETRY_BACKOFF_MS).toISOString()
      : null;
    const jobRetryAfter = activeJobRetryAfter(previous, today);
    if (failure.kind === "job" && previous.date === today && previous.jobId) {
      jobRetryAfter[previous.jobId] = new Date(Date.now() + CREATIVE_RETRY_BACKOFF_MS).toISOString();
    }
    await writeDailyCreativeState(dailyCreativeState({
      today,
      jobId: boundJobId,
      lockedAssetId,
      qualifiedToday,
      lastError: String(error?.message || error).slice(0, 500),
      lastErrorScope: failure.scope,
      providerRetryAfter,
      jobRetryAfter,
      revisionPriorityStreak: previous.date === today ? Number(previous.revisionPriorityStreak) || 0 : 0,
      retryOnceAfter,
      quotaRecoveryMigration,
    })).catch(() => {});
    if (retryOnceAfter) scheduleDailyCreativeRetry(retryOnceAfter);
  } finally {
    dailyCreativeBusy = false;
  }
}

function createWindow(url) {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1080,
    minHeight: 700,
    title: WEB_TITLE,
    backgroundColor: "#f6f5f0",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true, // 保持上下文隔离
      nodeIntegration: false, // 远程页面不启用 Node
      sandbox: true,
    },
  });
  stopWindowMediaWhenBackgrounded(mainWindow);
  // 每次启动都重新获取入口 HTML，避免安装新版后 Electron 仍复用旧页面；
  // 页面引用的 CSS/JS 自带内容哈希，仍会正常使用浏览器缓存。
  let launchUrl = url;
  if (/^https?:\/\//i.test(url)) {
    const parsed = new URL(url);
    parsed.searchParams.set("_zhitai_launch", String(Date.now()));
    launchUrl = parsed.toString();
  }
  mainWindow.loadURL(launchUrl).catch((err) => {
    // 织台页面不可达：显示中文可读错误页（不显示 localhost/端口）
    const html = `<!doctype html><meta charset="utf-8"><title>${WEB_TITLE}</title>
      <body style="font-family:-apple-system,'PingFang SC',sans-serif;background:#f6f5f0;display:grid;place-items:center;height:100vh;margin:0">
      <div style="text-align:center;color:#565c54"><h2>织台页面未能打开</h2>
      <p>${String((err && err.message) || err).replace(/</g, "&lt;")}</p>
      <p>请稍后重新启动「织台桌面版」，或查看主进程日志。</p></div></body>`;
    mainWindow.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(html));
  });
  mainWindow.on("closed", () => { mainWindow = null; });
}

// 单实例：第二次双击只聚焦已有窗口，不再起第二套监管
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

app.whenReady().then(async () => {
  if (app.dock) {
    const iconPath = app.isPackaged
      ? path.join(process.resourcesPath, "zhitai-icon.png")
      : path.join(__dirname, "..", "public", "og.png");
    const icon = nativeImage.createFromPath(iconPath);
    if (!icon.isEmpty()) app.dock.setIcon(icon);
  }
  launcher.init({
    projectDir: PROJECT_DIR,
    runtimeScript: path.join(RUNTIME_ROOT, "scripts", "run-local-agent.command"),
    analyzerScript: path.join(RUNTIME_ROOT, "scripts", "video-analysis-server.mjs"),
    logDir: path.join(process.env.HOME, "Library", "Logs"),
  });
  yuanbaoRunner.startBridge();

  // 窄 IPC（先注册，窗口加载即可用）
  ipcMain.handle("zhitai:services:list", () => launcher.getStates());
  ipcMain.handle("zhitai:api", (_event, req) => adapter.proxyRequest(req));
  ipcMain.handle("zhitai:creative-studio:open", (_event, provider, accountId) => {
    const result = openCreativeStudio(provider, { accountId });
    return { ok: result.ok, reused: result.reused, error: result.error };
  });
  ipcMain.handle("zhitai:creative:run", (_event, jobId, assetId, accountIds) => creativeRunner.run(jobId, assetId, accountIds));
  ipcMain.handle("zhitai:x-bookmarks:sync", (_event, interactive = true) => xBookmarkRunner.sync({ interactive: interactive !== false }));
  ipcMain.handle("zhitai:runtime-conditions:check", (_event, accountIds, refresh = false) => checkRuntimeConditions(accountIds, refresh === true));

  // 1) 服务监管只执行一次：web 优先（窗口尽快就绪），其余服务后台逐项；
  //    ensureService 自带 in-flight/owned 防重入，不会并发重复启动同一服务。
  let webUrl = null;
  try {
    webUrl = await launcher.ensureService("web");
    webUrl = webUrl && webUrl.url ? webUrl.url : null;
  } catch (_) { webUrl = null; }
  if (!webUrl) webUrl = await launcher.waitWebReady(45);

  createWindow(webUrl || "data:text/html;charset=utf-8," + encodeURIComponent(
    '<!doctype html><meta charset="utf-8"><title>织台</title><body style="font-family:-apple-system,sans-serif;background:#f6f5f0;display:grid;place-items:center;height:100vh"><div style="text-align:center;color:#8a5a3c"><h2>织台页面未就绪</h2><p>请确认已在本项目目录执行过 npm install，再重启桌面版。</p></div></body>'));

  // 其余服务后台逐项监管（web 已在线会直接跳过，不重复启动）
  launcher.ensureServices().then(pushStates).catch((err) => {
    pushStates([{ id: "main", label: "主进程", error: String((err && err.message) || err) }]);
  });

  // X 收藏使用织台自己的持久登录窗口。启动后静默同步一次，此后每 6 小时检查；
  // 未登录时保持静默，用户从知识库点“登录 X”即可完成一次性登录。
  setTimeout(() => { void xBookmarkRunner.sync({ interactive: false }); }, 20_000);
  setInterval(() => { void xBookmarkRunner.sync({ interactive: false }); }, 6 * 60 * 60_000);

  // 创作账号需在持久登录的真实网页中检查；启动后错峰深检一次，此后每 6 小时低频检查。
  const scheduledRuntimeCheck = async () => {
    const ids = await dailyAccountIds();
    await checkRuntimeConditions(ids, true);
  };
  setTimeout(() => { void scheduledRuntimeCheck().catch(() => {}); }, 2 * 60_000);
  runtimeConditionsTimer = setInterval(() => { void scheduledRuntimeCheck().catch(() => {}); }, 6 * 60 * 60_000);

  // 每日目标是 1 条已通过自主审核的同主题内容包；pending_review 和 needs_revision
  // 都不占目标，避免把“还没有结论”误当成可创建草稿或公开发布的内容。
  // 只生成、不公开发布。登录失效或额度不足按提供方退避 4 小时；
  // GPT 只是暂时忙则在当日窗口内 60 秒后续跑同一条。
  setTimeout(() => { void runDailyCreativeQueue(); }, 90_000);
  setInterval(() => { void runDailyCreativeQueue(); }, 30 * 60_000);

  // 状态中心推送（每 5 秒刷新一次）
  setInterval(() => {
    launcher.getStates().then(pushStates).catch(() => {});
  }, 5000);
});

function pushStates(states) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("zhitai:services:changed", states);
  }
}

app.on("window-all-closed", () => {
  // macOS 按应用习惯常驻：关闭主窗口不等于退出。这样 ClawBot、每日生成调度
  // 和本地服务监管仍能工作；用户可从 Dock 重新打开，⌘Q 才真正退出。
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", async () => {
  if (mainWindow && !mainWindow.isDestroyed()) return;
  let webUrl = null;
  try {
    const state = await launcher.ensureService("web");
    webUrl = state?.url || null;
  } catch { /* 下方错误页兜底 */ }
  createWindow(webUrl || "data:text/html;charset=utf-8," + encodeURIComponent(
    '<!doctype html><meta charset="utf-8"><title>织台</title><body style="font-family:-apple-system,sans-serif;background:#f6f5f0;display:grid;place-items:center;height:100vh"><div style="text-align:center;color:#8a5a3c"><h2>织台页面未就绪</h2><p>本地服务正在恢复，请稍后重新点击 Dock 图标。</p></div></body>'));
});

// 退出时只结束本次织台自启的子进程，不动用户原有服务
app.on("before-quit", () => {
  if (runtimeConditionsTimer) clearInterval(runtimeConditionsTimer);
  if (dailyCreativeRetryTimer) clearTimeout(dailyCreativeRetryTimer);
  try { yuanbaoRunner?.stopBridge(); } catch (_) { /* 尽力而为 */ }
  try { launcher.stopOwned(); } catch (_) { /* 尽力而为 */ }
});
