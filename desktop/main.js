#!/usr/bin/env node
/* 织台桌面版 · 主进程：窗口 + 服务监管 + 窄 IPC（外置引擎托管） */
"use strict";

const { app, BrowserWindow, ipcMain, nativeImage } = require("electron");
const path = require("node:path");
const os = require("node:os");
const fsp = require("node:fs/promises");
const launcher = require("./launcher.js");
const adapter = require("./adapter.js");
const { createCreativeRunner } = require("./creative-runner.js");
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

const DAILY_CREATIVE_TARGET = 3;
const DAILY_CREATIVE_MAX_ATTEMPTS = DAILY_CREATIVE_TARGET * 4;
const MAX_CONSECUTIVE_REVISION_ATTEMPTS = 2;
const CREATIVE_RETRY_BACKOFF_MS = 4 * 60 * 60_000;
const QUALIFIED_CREATIVE_REVIEW_STATUSES = new Set([
  "pending_review",
  "approved_for_drafts",
  "approved_for_publish",
]);
const DAILY_CREATIVE_STATE = path.join(RUNTIME_ROOT, "state", "daily-creative.json");
let dailyCreativeBusy = false;

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

function qualifiedCreativeReviewCount(reviews, date) {
  return (Array.isArray(reviews) ? reviews : []).filter((row) =>
    row?.date === date && QUALIFIED_CREATIVE_REVIEW_STATUSES.has(String(row?.status || ""))).length;
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

function activeJobRetryAfter(previous, today, now = Date.now()) {
  if (previous?.date !== today || !previous?.jobRetryAfter || typeof previous.jobRetryAfter !== "object") return {};
  return Object.fromEntries(Object.entries(previous.jobRetryAfter)
    .filter(([jobId, retryAt]) => /^[A-Za-z0-9._-]{1,160}$/.test(jobId)
      && Number.isFinite(Date.parse(String(retryAt || "")))
      && Date.parse(String(retryAt)) > now)
    .slice(-64));
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
) {
  const candidates = (Array.isArray(jobs) ? jobs : []).filter((row) => {
    if (!row || !["ready_for_images", "ready_for_seedance"].includes(row.status)) return false;
    if (attemptedJobIds.has(row.id)) return false;
    const retryAt = Date.parse(String(jobRetryAfter?.[row.id] || ""));
    return !Number.isFinite(retryAt) || retryAt <= now;
  }).sort((left, right) => {
    const leftAt = Date.parse(String(left?.createdAt || ""));
    const rightAt = Date.parse(String(right?.createdAt || ""));
    if (Number.isFinite(leftAt) && Number.isFinite(rightAt) && leftAt !== rightAt) return leftAt - rightAt;
    return String(left?.id || "").localeCompare(String(right?.id || ""));
  });
  const revisions = candidates.filter((row) => revisionAssetIds.has(String(row?.assetId || "")));
  const backlog = candidates.filter((row) => !revisionAssetIds.has(String(row?.assetId || "")));
  // 返工先行，但每连续尝试两条返工就让一个普通 backlog 前进，保证确定性且不饿死。
  if (revisions.length && (revisionPriorityStreak < MAX_CONSECUTIVE_REVISION_ATTEMPTS || !backlog.length)) return revisions[0];
  return backlog[0] || revisions[0] || null;
}

function dailyCreativeState({
  today,
  jobId = null,
  qualifiedToday = 0,
  lastError = null,
  lastErrorScope = null,
  providerRetryAfter = null,
  jobRetryAfter = {},
  revisionPriorityStreak = 0,
  retryOnceAfter = null,
}) {
  return {
    date: today,
    lastAttemptAt: new Date().toISOString(),
    jobId,
    // 保留 completedToday 兼容旧状态读取者，但其含义已收紧为“合格且可进草稿/公开”。
    completedToday: qualifiedToday,
    qualifiedToday,
    lastError,
    lastErrorScope,
    providerRetryAfter,
    jobRetryAfter,
    revisionPriorityStreak,
    retryOnceAfter,
  };
}

async function runDailyCreativeQueue() {
  if (dailyCreativeBusy) return;
  // 白天无人值守，避免深夜突然打开创作会话；错过时次日继续，不追赶轰炸。
  if (!isDailyCreativeWindowOpen()) return;
  dailyCreativeBusy = true;
  try {
    const today = localDateKey();
    const previous = await readDailyCreativeState();
    const now = Date.now();
    const lastAttempt = Date.parse(String(previous.lastAttemptAt || ""));
    const retryOnceAfter = Date.parse(String(previous.retryOnceAfter || ""));
    const verifiedFixRetryReady = Number.isFinite(retryOnceAfter) && now >= retryOnceAfter;
    const providerRetryAfterAt = Date.parse(String(previous.providerRetryAfter || ""));
    const explicitProviderBackoff = previous.date === today
      && Number.isFinite(providerRetryAfterAt) && providerRetryAfterAt > now;
    const legacyProviderBackoff = previous.date === today
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
    let qualifiedToday = qualifiedCreativeReviewCount(initialReviews, today);
    if (qualifiedToday >= DAILY_CREATIVE_TARGET) return;
    const accountIds = await dailyAccountIds();
    const attemptedJobIds = new Set();
    const jobRetryAfter = activeJobRetryAfter(previous, today, now);
    let revisionAssetIds = revisionAssetIdsFromReviews(initialReviews);
    let revisionPriorityStreak = previous.date === today
      ? Math.max(0, Math.min(MAX_CONSECUTIVE_REVISION_ATTEMPTS, Number(previous.revisionPriorityStreak) || 0))
      : 0;
    if (verifiedFixRetryReady && previous.jobId) delete jobRetryAfter[previous.jobId];
    let attempts = 0;
    while (qualifiedToday < DAILY_CREATIVE_TARGET && attempts < DAILY_CREATIVE_MAX_ATTEMPTS) {
      // 一轮生成可能耗时很久；19 点后不再开启下一条，已在执行的单条则安全收尾。
      if (!isDailyCreativeWindowOpen()) break;
      const jobsPayload = await localJson("/api/v1/creative/jobs");
      const jobs = Array.isArray(jobsPayload?.jobs) ? jobsPayload.jobs : [];
      // 老素材优先，保持每日审核编号与队列顺序稳定。
      const job = selectDailyCreativeJob(
        jobs,
        attemptedJobIds,
        jobRetryAfter,
        revisionAssetIds,
        revisionPriorityStreak,
      );
      if (!job) break;
      const isRevisionAttempt = revisionAssetIds.has(String(job.assetId || ""));
      revisionPriorityStreak = isRevisionAttempt ? revisionPriorityStreak + 1 : 0;
      attemptedJobIds.add(job.id);
      attempts += 1;
      await writeDailyCreativeState(dailyCreativeState({
        today,
        jobId: job.id,
        qualifiedToday,
        jobRetryAfter,
        revisionPriorityStreak,
      }));
      const result = await creativeRunner.run(job.id, job.assetId, accountIds);
      if (!result?.ok) {
        const lastError = String(result?.error || result?.status || "生成失败").slice(0, 500);
        // 登录、额度、网页入口等提供方级错误会影响所有任务，本轮停止并进入通知/退避；
        // 单条素材的质量问题只给该任务退避，继续新返工任务，避免 needs_revision/坏素材饿死队列。
        const jobSpecific = isClearlyJobSpecificCreativeError(lastError);
        const retryAt = new Date(Date.now() + CREATIVE_RETRY_BACKOFF_MS).toISOString();
        if (jobSpecific) jobRetryAfter[job.id] = retryAt;
        await writeDailyCreativeState(dailyCreativeState({
          today,
          jobId: job.id,
          qualifiedToday,
          lastError,
          lastErrorScope: jobSpecific ? "job" : "provider",
          providerRetryAfter: jobSpecific ? null : retryAt,
          jobRetryAfter,
          revisionPriorityStreak,
        }));
        if (jobSpecific) continue;
        break;
      }
      delete jobRetryAfter[job.id];
      // run() 的 complete 接口会同步登记审核回执；以回执状态复核，不把仅“生成结束”误算为合格。
      const refreshedReviews = await localJson("/api/v1/creative/reviews");
      const reviews = Array.isArray(refreshedReviews?.reviews) ? refreshedReviews.reviews : [];
      const review = reviews.find((row) => row?.jobId === job.id);
      qualifiedToday = qualifiedCreativeReviewCount(reviews, today);
      revisionAssetIds = revisionAssetIdsFromReviews(reviews);
      if (!review) {
        const lastError = "成片已生成，但没有取得审核回执；已停止本轮避免超额生成";
        const providerRetryAfter = new Date(Date.now() + CREATIVE_RETRY_BACKOFF_MS).toISOString();
        await writeDailyCreativeState(dailyCreativeState({
          today,
          jobId: job.id,
          qualifiedToday,
          lastError,
          lastErrorScope: "provider",
          providerRetryAfter,
          jobRetryAfter,
          revisionPriorityStreak,
        }));
        break;
      }
      const needsRevision = review.status === "needs_revision";
      await writeDailyCreativeState(dailyCreativeState({
        today,
        jobId: job.id,
        qualifiedToday,
        lastError: needsRevision ? "该成片需要返工，不计入今日合格目标" : null,
        lastErrorScope: needsRevision ? "job" : null,
        jobRetryAfter,
        revisionPriorityStreak,
      }));
    }
  } catch (error) {
    const today = localDateKey();
    const previous = await readDailyCreativeState().catch(() => ({}));
    const previousQualified = previous.qualifiedToday === undefined
      ? previous.completedToday
      : previous.qualifiedToday;
    const qualifiedToday = previous.date === today ? Number(previousQualified || 0) : 0;
    const providerRetryAfter = new Date(Date.now() + CREATIVE_RETRY_BACKOFF_MS).toISOString();
    await writeDailyCreativeState(dailyCreativeState({
      today,
      jobId: previous.date === today ? previous.jobId : null,
      qualifiedToday,
      lastError: String(error?.message || error).slice(0, 500),
      lastErrorScope: "provider",
      providerRetryAfter,
      jobRetryAfter: activeJobRetryAfter(previous, today),
      revisionPriorityStreak: previous.date === today ? Number(previous.revisionPriorityStreak) || 0 : 0,
    })).catch(() => {});
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

  // 每日目标是 3 条合格备用成片；needs_revision 不占目标，单轮尝试数仍有硬上限。
  // 只生成、不公开发布。登录失效或额度不足会停止本轮，并按提供方级退避 4 小时。
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
  try { yuanbaoRunner?.stopBridge(); } catch (_) { /* 尽力而为 */ }
  try { launcher.stopOwned(); } catch (_) { /* 尽力而为 */ }
});
