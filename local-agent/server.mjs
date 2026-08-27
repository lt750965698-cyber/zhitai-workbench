import { spawn } from "node:child_process";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  access,
  cp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHANNELS_PROXY_PAC } from "./channels-proxy-pac.mjs";
import { DEFAULT_KEYCHAIN_SERVICE, readKeychainSecret } from "./keychain-secret.mjs";
import { decideInboxAuthentication } from "./inbox-auth.mjs";
import { downloadChannelsVideo, loadYuanbaoCookie, parseChannelsVideo } from "./channels-yuanbao.mjs";
import { parseChannelsCard } from "./channels-card.mjs";
import { analyzeVideo } from "./analyze.mjs";
import { initKb, handleKbRequest } from "./kb-routes.mjs";
import { assessMediaQuality, ingestOne as kbIngestOne, openKbDb, sanitizeFailureText } from "./kb.mjs";
import { isStableShareUrl, canonicalizeSourceUrl, probeLocalMedia, redactUrlForStorage } from "./downloader-adapter.mjs";
import { downloadSafeImage } from "./safe-image-download.mjs";
import * as matrix from "./matrixmedia-adapter.mjs";
import * as xhsPublisher from "./xiaohongshu-publisher.mjs";
import * as wechatOfficial from "./wechat-official-publisher.mjs";
import { CreativeQueue } from "./creative-queue.mjs";
import { AnalysisQueue } from "./analysis-queue.mjs";
import { buildRuntimeConditions, normalizeCreativeConditionReport } from "./runtime-conditions.mjs";
import { assessGenerationReadiness } from "./seedance-workflow.mjs";
import { ensureXBookmarkSchema, getXBookmark, importXBookmarks, queryXBookmarks, xBookmarkStatus } from "./x-bookmarks.mjs";
import { RemoteController } from "./remote-controller.mjs";
import { NotificationCenter } from "./notification-center.mjs";
import { ClawBotNotifier } from "./clawbot-notifier.mjs";
import { installModuleUpdate, moduleUpdateBlocker } from "./module-updater.mjs";
import { validateAudioQualityReport } from "./audio-quality.mjs";
import { publishContentForPlan, publishSourceUrlForPlan, publishTitleForPlan, remediateToOriginalWorkflow } from "./originality-remediation.mjs";
import { persistOriginalityRemediation } from "./originality-remediation-store.mjs";
import { publicDisplayPath } from "./public-path.mjs";
import {
  assertPublishScheduleBinding,
  deterministicPublishScheduleId,
  PublishScheduler,
  PublishSchedulerConflictError,
  normalizeMatrixHistoryRecord,
} from "./publish-scheduler.mjs";

import { migrateLibraryToKb } from "./kb-migrate.mjs";

const agentRoot = dirname(fileURLToPath(import.meta.url));
const runtimeRoot = resolve(process.env.ZHITAI_RUNTIME_ROOT
  || join(homedir(), ".local", "share", "zhitai-runtime"));
const applicationsRoot = resolve(process.env.ZHITAI_APPLICATIONS_DIR
  || join(homedir(), "Applications"));
const xianyuRoot = resolve(process.env.ZHITAI_XIANYU_ROOT
  || join(applicationsRoot, "xianyu-auto-reply-fix"));
const configPath = process.env.ZHITAI_CONFIG_PATH || join(agentRoot, "config.local.json");
const exampleConfigPath = join(agentRoot, "config.example.json");
const config = await loadConfig();
assertLoopback(config.host);

const dataDir = resolve(process.env.ZHITAI_DATA_DIR || config.dataDir || join(agentRoot, "data"));
const tasksPath = join(dataDir, "tasks.json");
const eventsPath = join(dataDir, "events.json");
const webhookNoncesPath = join(dataDir, "webhook-nonces.json");
const publishDir = join(dataDir, "publish-jobs");
const creativeJobsPath = join(dataDir, "creative-jobs.json");
const creativeReviewsPath = join(dataDir, "creative-reviews.json");
const analysisJobsPath = join(dataDir, "analysis-jobs.json");
const runtimeConditionsPath = join(dataDir, "runtime-conditions.json");
const publisherReceiptsPath = join(dataDir, "publisher-receipts.json");
const publisherSchedulePath = join(dataDir, "publisher-schedule.json");
const publisherReceiptStore = matrix.createPublishReceiptStore({ path: publisherReceiptsPath });
const knowledgeBase = expandHome(config.knowledgeBase);
const publicKnowledgeBase = publicDisplayPath(knowledgeBase);
// ── 快点控制台 V1：伴生桥心跳（内存，TTL 默认 15s；测试可用 ZHITAI_KUAIDIAN_TTL_MS 缩短） ──
const KUAIDIAN_HEARTBEAT_TTL_MS = Math.max(200, Number(process.env.ZHITAI_KUAIDIAN_TTL_MS) || 90_000);
const kuaidianHeartbeat = {
  online: false,
  lastSeen: null,
  version: null,
  pageKind: null,
  wechatLoggedIn: false,
  originalKuaidianDetected: false,
  pendingReportCount: 0,
  lastResult: null,
};
// 重供命令队列（仅 itemId + 内部 deliveryId；绝不含下载 URL/签名），持久化 dataDir/kuaidian-commands.json
const kuaidianCommandsPath = join(dataDir, "kuaidian-commands.json");
// 可测试性注入：ZHITAI_ENRICH_SCRIPT=<path> 时用脚本默认导出替代真实元宝补元数据（测试用，生产不设置）
let enrichOverride = null;
if (process.env.ZHITAI_ENRICH_SCRIPT) {
  try {
    const mod = await import(resolve(process.env.ZHITAI_ENRICH_SCRIPT));
    if (typeof mod.default === "function") enrichOverride = mod.default;
  } catch { /* 注入失败则用真实元宝 */ }
}
await initKb(dataDir, { allowedOrigins: config.allowedOrigins, yuanbaoEnrich: enrichOverride });
// 所有 schema 写入都在开始监听前完成；GET /library 始终只读，避免入库事务期间锁升级。
{
  const schemaDb = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
  try { ensureXBookmarkSchema(schemaDb); }
  finally { schemaDb.close(); }
}
const { setKbRoot } = await import("./kb.mjs");
setKbRoot(knowledgeBase);
const kbPrivDir = join(dataDir, "private", "raw");

const managedProcesses = new Map();
let taskMutation = Promise.resolve();
let eventMutation = Promise.resolve();
let serviceMutation = Promise.resolve();
let webhookNonceMutation = Promise.resolve();
let moduleUpdateCache = { at: 0, modules: [] };
let moduleUpdateMutation = Promise.resolve();
let libraryMigrationMutation = Promise.resolve();
let creativeQueue = null;
let analysisQueue = null;
let analysisExecution = Promise.resolve();
let remoteController = null;
let notificationCenter = null;
let publisherSchedulerInit = null;
let downloadWatchdogTimer = null;
let credentialReminderTimer = null;
let runtimeConditionsTimer = null;
let creativeReviewMutation = Promise.resolve();
let runtimeConditionsMutation = Promise.resolve();
let runtimeConditionsCache = { at: 0, snapshot: null };
let runtimeConditionsRefreshInFlight = null;
let runtimeConditionsLastRefreshAt = 0;
let runtimeConditionsLastRefreshSnapshot = null;
const RUNTIME_CONDITIONS_REFRESH_COOLDOWN_MS = 15_000;

async function readCreativeReviews() {
  try {
    const rows = JSON.parse(await readFile(creativeReviewsPath, "utf8"));
    return Array.isArray(rows) ? rows : [];
  } catch { return []; }
}

async function mutateCreativeReviews(mutator) {
  const operation = creativeReviewMutation.catch(() => {}).then(async () => {
    const rows = await readCreativeReviews();
    const result = await mutator(rows);
    await writeJsonAtomic(creativeReviewsPath, rows.slice(0, 500));
    return result;
  });
  creativeReviewMutation = operation.then(() => undefined, () => undefined);
  return operation;
}

async function recordCreativeReview({ job, persistedOutput }) {
  const today = localDateKey();
  return mutateCreativeReviews((rows) => {
    const existing = rows.find((row) => row.jobId === job.id);
    if (existing) return existing;
    // `createdAt` 是 UTC ISO 字符串；北京时间凌晨 0–8 点直接按其日期前缀
    // 会落到“昨天”，导致同一天的 ClawBot 审核编号从 1 重新开始。
    // 记录入队时已经固化了本地 `date`，每日顺序必须只以它为准。
    const sequence = Math.max(0, ...rows.filter((row) => row.date === today).map((row) => Number(row.sequence) || 0)) + 1;
    const item = {
      id: "review_" + randomUUID(),
      date: today,
      sequence,
      jobId: job.id,
      assetId: job.assetId,
      generationId: persistedOutput.id,
      title: String(job.title || "未命名成片").slice(0, 180),
      filePath: persistedOutput.filePath,
      mediaUrl: persistedOutput.mediaUrl,
      status: "pending_review",
      feedback: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    rows.unshift(item);
    return item;
  });
}

async function approveCreativeReview(sequence) {
  const item = (await readCreativeReviews()).find((candidate) =>
    candidate.date === localDateKey() && Number(candidate.sequence) === Number(sequence));
  if (!item) return "今日没有第 " + sequence + " 条成片，请按收到的编号选择。";
  const draftTask = await createPublishTask({
    assetPath: item.filePath,
    title: item.title,
    targets: ["douyin", "wechat_channels", "xiaohongshu"],
    mode: "platform_draft",
    idempotencyKey: `creative-review:${item.id}`,
  }, null);
  await mutateCreativeReviews((rows) => {
    const row = rows.find((candidate) => candidate.id === item.id);
    if (!row) return null;
    row.status = "approved_for_drafts";
    row.draftTaskId = draftTask.id;
    row.draftTargets = ["douyin", "wechat_channels", "xiaohongshu"];
    row.updatedAt = new Date().toISOString();
    return row;
  });
  await recordEvent("info", "CREATIVE_REVIEW", "已批准今日第 " + sequence + " 条成片创建多平台草稿：" + item.title, draftTask.id);
  return "已选择今日第 " + sequence + " 条：" + item.title
    + "\n已创建抖音、视频号、小红书的平台草稿任务（" + draftTask.id + "）。"
    + "\n只会进入草稿，不会自动公开发布；登录未就绪时任务会保留并提醒你处理。";
}

async function reviseCreativeReview(sequence, feedback) {
  let target = null;
  await mutateCreativeReviews((rows) => {
    const row = rows.find((candidate) => candidate.date === localDateKey() && Number(candidate.sequence) === Number(sequence));
    if (!row) return null;
    row.status = "needs_revision";
    row.feedback = [...(Array.isArray(row.feedback) ? row.feedback : []), { text: feedback, createdAt: new Date().toISOString() }].slice(-10);
    row.updatedAt = new Date().toISOString();
    target = row;
    return row;
  });
  if (!target) return "今日没有第 " + sequence + " 条成片。";
  // 人工意见进入复刻方案，下一次 GPT/Seedance 会把它作为全部分镜的强制约束。
  const db = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
  try {
    const row = db.prepare("SELECT plan_json FROM remake_plan WHERE asset_id=?").get(target.assetId);
    if (row?.plan_json) {
      const plan = JSON.parse(row.plan_json);
      plan.userRevisionRequest = feedback;
      db.prepare("UPDATE remake_plan SET plan_json=? WHERE asset_id=?").run(JSON.stringify(plan), target.assetId);
    }
  } finally { db.close(); }
  const created = await creativeQueue.create({ assetId: target.assetId, title: target.title, autoCreated: false });
  await recordEvent("info", "CREATIVE_REVIEW", "第 " + sequence + " 条已按意见返工：" + feedback.slice(0, 120), created.job.id);
  return "已保存第 " + sequence + " 条的改进意见：" + feedback + "\n已创建返工任务 " + created.job.id + "，新版完成后会再发给你审核。";
}

function canonicalAnalysisAsset(db, assetId) {
  return db.prepare(`SELECT id, title, category FROM video_asset
    WHERE id=? OR legacy_id=? ORDER BY CASE WHEN id=? THEN 0 ELSE 1 END LIMIT 1`).get(assetId, assetId, assetId) || null;
}

function parseSavedWorkflow(row) {
  try {
    const plan = row?.plan_json ? JSON.parse(row.plan_json) : null;
    const workflow = plan?.seedanceWorkflow;
    const schemaVersion = Number(workflow?.schemaVersion || 0);
    const readiness = workflow?.generationReadiness;
    const currentReadiness = workflow ? assessGenerationReadiness(workflow) : null;
    if (workflow && currentReadiness) workflow.generationReadiness = currentReadiness;
    return {
      plan,
      complete: Boolean(plan && workflow && schemaVersion >= 3 && readiness && typeof readiness.ready === "boolean"),
      generationReady: Boolean(schemaVersion >= 3 && currentReadiness?.ready === true),
      readinessChanged: Boolean(currentReadiness && JSON.stringify(readiness) !== JSON.stringify(currentReadiness)),
    };
  } catch {
    return { plan: null, complete: false, generationReady: false, readinessChanged: false };
  }
}

async function inspectCreativePreparation(job) {
  const db = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
  try {
    const asset = canonicalAnalysisAsset(db, job?.assetId);
    if (!asset) return { assetId: null, ready: false };
    const saved = db.prepare("SELECT plan_json FROM remake_plan WHERE asset_id=?").get(asset.id);
    const workflow = parseSavedWorkflow(saved);
    const recovery = workflow?.plan?.seedanceWorkflow
      ? remediateToOriginalWorkflow(workflow.plan.seedanceWorkflow, { title: asset.title })
      : null;
    if (recovery?.changed) {
      await persistOriginalityRemediation(db, asset.id, recovery.workflow);
      return { assetId: asset.id, ready: assessGenerationReadiness(recovery.workflow).ready };
    }
    if (workflow.complete && workflow.readinessChanged) {
      db.prepare("UPDATE remake_plan SET plan_json=? WHERE asset_id=?").run(JSON.stringify(workflow.plan), asset.id);
    }
    return { assetId: asset.id, ready: workflow.generationReady };
  } finally { db.close(); }
}

async function analyzeAssetNow(assetId, { signal } = {}) {
  let canonical;
  {
    const db = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
    try {
      canonical = canonicalAnalysisAsset(db, assetId);
      if (!canonical) throw httpError(404, "creative_asset_not_found");
      const saved = parseSavedWorkflow(db.prepare("SELECT plan_json FROM remake_plan WHERE asset_id=?").get(canonical.id));
      if (saved.complete) {
        return { ok: true, canonicalAssetId: canonical.id, remakePlan: saved.plan, persisted: { ok: true }, reused: true };
      }
    } finally { db.close(); }
  }

  // 最长历史素材接近 8 分钟，完整 ASR/视觉/运镜链路可能超过 15 分钟。
  // 外层给足恢复窗口，底层分析器仍有独立子进程超时和持久队列重试。
  const timeout = AbortSignal.timeout(45 * 60_000);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch("http://127.0.0.1:17900/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ videoId: canonical.id }),
    signal: combined,
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.error || `视频分析服务返回 HTTP ${response.status}`);
  // 分析成功不等于知识库落盘成功。persistWarning 或缺失 persisted.ok 都必须
  // 作为失败重试，不能把创作任务提前推进到“待 GPT 生图”。
  if (payload.persistWarning || payload?.persisted?.ok !== true) {
    throw new Error(payload.persistWarning || payload?.persisted?.error || "analysis_result_not_persisted");
  }

  const verifyDb = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
  try {
    const saved = parseSavedWorkflow(verifyDb.prepare("SELECT plan_json FROM remake_plan WHERE asset_id=?").get(canonical.id));
    if (!saved.complete) throw new Error("analysis_workflow_v3_not_persisted");
    return { ...payload, ok: true, canonicalAssetId: canonical.id, remakePlan: saved.plan, persisted: payload.persisted };
  } finally { verifyDb.close(); }
}

async function analyzeCreativeAsset(assetId, options = {}) {
  const operation = analysisExecution.catch(() => {}).then(() => analyzeAssetNow(assetId, options));
  analysisExecution = operation.then(() => undefined, () => undefined);
  return operation;
}

function scheduleCreativePreparation(assetId, title = null) {
  if (!creativeQueue && !analysisQueue) return;
  void (async () => {
    const { openKbDb } = await import("./kb.mjs");
    const db = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
    let asset;
    try { asset = db.prepare("SELECT id, title, category FROM video_asset WHERE id=?").get(assetId); }
    finally { db.close(); }
    if (!asset) return;
    // 所有视频都进入完整分析持久队列；只有“素材”再进入 GPT/豆包生成队列。
    // 两个队列共享串行分析锁，不会并发占用本机模型。
    if (analysisQueue) await analysisQueue.enqueueMany([{
      assetId: asset.id,
      title: asset.title || title,
      category: asset.category,
      priority: asset.category === "素材" ? 50 : asset.category === "技能" ? 10 : 0,
    }]);
    if (asset.category !== "素材" || !creativeQueue) return;
    await creativeQueue.create({ assetId: asset.id, title: asset.title || title, autoCreated: true });
  })().catch(async (error) => {
    await recordEvent("error", "CREATIVE_PREPARE", `生成队列入队失败：${safeMessage(error?.message || error)}`);
  });
}

const allowedHosts = new Set([
  "mp.weixin.qq.com",
  "weixin.qq.com",
  "channels.weixin.qq.com",
  "finder.video.qq.com",
  "v.douyin.com",
  "www.douyin.com",
  "douyin.com",
  "m.douyin.com",
  "xhslink.com",
  "www.xiaohongshu.com",
  "xiaohongshu.com",
]);

const platformTargets = {
  douyin: "dy",
  xiaohongshu: "xhs",
  wechat_channels: "sph",
};

await Promise.all([
  mkdir(dataDir, { recursive: true }),
  mkdir(publishDir, { recursive: true }),
  mkdir(knowledgeBase, { recursive: true }),
]);

const publisherScheduler = new PublishScheduler({
  filePath: publisherSchedulePath,
  gracePeriodMs: Math.max(60_000, Number(config.adapters?.publisher?.scheduleGraceMs) || 20 * 60_000),
  preflight: preflightScheduledPublish,
  executeTarget: executeScheduledPublishTarget,
});

async function ensurePublisherSchedulerReady() {
  if (!publisherSchedulerInit) throw httpError(503, "publisher_scheduler_starting");
  try { await publisherSchedulerInit; }
  catch { throw httpError(503, "publisher_scheduler_unavailable"); }
  return publisherScheduler;
}

creativeQueue = new CreativeQueue({
  filePath: creativeJobsPath,
  analyze: analyzeCreativeAsset,
  persistRemediatedWorkflow: async (assetId, workflow, { signal } = {}) => {
    signal?.throwIfAborted?.();
    const db = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
    try { return await persistOriginalityRemediation(db, assetId, workflow); }
    finally { db.close(); }
  },
  onEvent: async (kind, assetId, jobId, error) => {
    if (kind === "ready") await recordEvent("info", "CREATIVE_READY", `生成任务已完成本机准备：${assetId}`, jobId);
    else await recordEvent("error", "CREATIVE_PREPARE", `生成任务准备失败：${safeMessage(error?.message || error)}`, jobId);
  },
});
await creativeQueue.init();
const creativeRepair = await creativeQueue.reconcile(inspectCreativePreparation);
if (creativeRepair.repaired || creativeRepair.remapped) {
  await recordEvent("warning", "CREATIVE_RECOVER", `生成队列恢复：重置 ${creativeRepair.repaired} 条假就绪任务，重映射 ${creativeRepair.remapped} 条旧资产`);
}

analysisQueue = new AnalysisQueue({
  filePath: analysisJobsPath,
  analyze: (assetId) => analyzeCreativeAsset(assetId),
  onEvent: async (kind, assetId, jobId, error) => {
    if (kind === "completed") {
      await recordEvent("info", "ANALYSIS_BACKLOG", `完整分析已写回：${assetId}`, jobId);
      await creativeQueue.reconcile(inspectCreativePreparation);
      return;
    }
    if (kind === "retry") {
      await recordEvent("warning", "ANALYSIS_BACKLOG", `完整分析暂时失败，已持久排队重试：${assetId}`, jobId);
      return;
    }
    await recordEvent("error", "ANALYSIS_BACKLOG", `完整分析多次失败，等待人工处理：${assetId}（${safeMessage(error?.message || error)}）`, jobId);
  },
});
await analysisQueue.init();
{
  const activeCreative = new Set((await creativeQueue.list())
    .filter((job) => !["completed", "cancelled"].includes(job.status))
    .map((job) => job.assetId));
  const db = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
  let missing = [];
  try {
    missing = db.prepare(`SELECT v.id AS assetId, v.title, v.category, rp.plan_json AS planJson
      FROM video_asset v LEFT JOIN remake_plan rp ON rp.asset_id=v.id ORDER BY v.created_at ASC`).all()
      .filter((row) => !parseSavedWorkflow({ plan_json: row.planJson }).complete)
      .map((row) => ({
        assetId: row.assetId,
        title: row.title,
        category: row.category,
        priority: activeCreative.has(row.assetId) ? 100 : row.category === "素材" ? 50 : row.category === "技能" ? 10 : 0,
      }));
  } finally { db.close(); }
  const seeded = await analysisQueue.enqueueMany(missing);
  if (seeded.created.length) {
    await recordEvent("info", "ANALYSIS_BACKLOG", `已把 ${seeded.created.length} 条缺完整分析的视频加入可恢复队列`);
  }
}

function localDateKey(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

async function controllerLibrarySnapshot() {
  const db = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
  try {
    const { items: videos } = (await import("./kb.mjs")).queryVideos(db, { limit: 500 });
    return [...videos, ...queryXBookmarks(db, { limit: 500 })]
      .sort((left, right) => String(right.created_at || "").localeCompare(String(left.created_at || "")));
  } finally {
    db.close();
  }
}

async function buildControllerDigest(kind) {
  const items = await controllerLibrarySnapshot();
  const today = localDateKey();
  const todayItems = items.filter((item) => localDateKey(item.created_at) === today);
  if (kind === "learning") {
    const eligible = items.filter((item) => item.category !== "素材");
    const pageSize = 3;
    const pages = Math.max(1, Math.ceil(eligible.length / pageSize));
    const dayNumber = Math.floor(new Date(`${today}T00:00:00`).getTime() / 86_400_000);
    const page = dayNumber % pages;
    const learning = eligible.slice(page * pageSize, page * pageSize + pageSize);
    if (!learning.length) return `织台每日学习 ${today}\n今天还没有技能或其他分类内容。`;
    const details = await learningDigestDetails(learning);
    return [
      `织台每日学习 ${today}（第 ${page + 1}/${pages} 批，共 ${eligible.length} 条轮流学习）`,
      ...details.map((item, index) => [
        `${index + 1}. [${item.category}] ${item.title}`,
        `内容总结：${item.summary}`,
        item.keyPoints.length ? `关键要点：${item.keyPoints.join("；")}` : "",
        item.userNote ? `你的备注：${item.userNote}` : "",
        item.action ? `建议怎么用：${item.action}` : "",
        item.sourceUrl ? `原链接：${item.sourceUrl}` : "原链接：来源未提供",
      ].filter(Boolean).join("\n")),
    ].join("\n\n");
  }
  const videos = todayItems.filter((item) => item.contentKind !== "x_bookmark");
  const xItems = todayItems.filter((item) => item.contentKind === "x_bookmark");
  const counts = ["素材", "技能", "其他", "未分类"].map((category) => `${category} ${videos.filter((item) => (item.category || "其他") === category).length}`).join("、");
  const titles = todayItems.slice(0, 5).map((item, index) => `${index + 1}. ${String(item.title || "未命名").slice(0, 48)}`);
  return [
    `织台入库摘要 ${today}`,
    `新入库 ${videos.length} 条视频、${xItems.length} 条 X 收藏；${counts}。`,
    ...(titles.length ? titles : ["今天尚无新入库内容。"]),
    todayItems.length > 5 ? `另有 ${todayItems.length - 5} 条，请在知识库查看。` : "",
  ].filter(Boolean).join("\n");
}

async function learningDigestDetails(items) {
  const db = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
  try {
    const { getVideoDetail } = await import("./kb.mjs");
    return items.map((item) => {
      if (item.contentKind === "x_bookmark") {
        const content = String(item.content || item.description || item.overview || item.title || "未提供正文").replace(/\s+/g, " ").trim();
        return {
          category: item.category || "其他",
          title: String(item.title || "X 收藏").slice(0, 80),
          summary: content.slice(0, 700),
          keyPoints: [],
          action: "结合原帖上下文判断是否纳入织台流程；需要评论内容时打开原帖补看。",
          userNote: "",
          sourceUrl: item.source_url || "",
        };
      }
      const detail = getVideoDetail(db, item.id);
      const analysis = detail?.content_analysis || {};
      const keyPoints = Array.isArray(analysis.key_points)
        ? analysis.key_points.map((value) => String(value).replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 5)
        : [];
      const userNote = (detail?.ingest_observations || []).find((entry) => entry.kind === "user_note")?.message || "";
      const summary = String(analysis.summary || detail?.latest_post?.title || item.title || "尚未生成内容总结").replace(/\s+/g, " ").trim().slice(0, 900);
      const reusable = Array.isArray(analysis.reusable_pattern) ? analysis.reusable_pattern.join("；") : String(analysis.reusable_pattern || "");
      return {
        category: item.category || "其他",
        title: String(item.title || "未命名").replace(/\s+/g, " ").slice(0, 80),
        summary,
        keyPoints,
        action: reusable.slice(0, 420) || "先看总结和原链接，再决定是否变成工作流、提示词或待办。",
        userNote: String(userNote).slice(0, 500),
        sourceUrl: detail?.latest_post?.url || item.source_url || "",
      };
    });
  } finally { db.close(); }
}

async function controllerMaterials() {
  const items = await controllerLibrarySnapshot();
  return items.filter((item) => item.category === "素材" && item.contentKind !== "x_bookmark").slice(0, 20)
    .map((item) => ({ id: item.id, title: item.title || "未命名素材" }));
}

async function controllerQueueText() {
  const [tasks, creativeJobs] = await Promise.all([readTasks(), creativeQueue.list()]);
  const count = (items, states) => items.filter((item) => states.includes(String(item.status || ""))).length;
  return [
    "织台任务队列",
    `下载：进行中 ${count(tasks.filter((item) => item.type !== "publish"), ["queued", "running", "scheduled", "pending"])}，失败 ${count(tasks.filter((item) => item.type !== "publish"), ["failed", "needs_attention", "needs_setup"])}`,
    `生成：进行中 ${count(creativeJobs, ["queued", "preparing"])}，待网页生成 ${count(creativeJobs, ["ready_for_images", "ready_for_seedance", "ready_for_assembly"])}，暂停 ${count(creativeJobs, ["paused"])}`,
    `发布：排期/队列 ${count(tasks.filter((item) => item.type === "publish"), ["queued", "running", "scheduled"])}，需处理 ${count(tasks.filter((item) => item.type === "publish"), ["failed", "needs_attention", "needs_setup"])}`,
  ].join("\n");
}

async function controllerFailuresText() {
  const [tasks, creativeJobs] = await Promise.all([readTasks(), creativeQueue.list()]);
  const failedTasks = tasks.filter((item) => ["failed", "needs_attention", "needs_setup"].includes(String(item.status || ""))).slice(0, 5);
  const failedCreative = creativeJobs.filter((item) => item.status === "failed").slice(0, 3);
  const lines = [
    ...failedTasks.map((item) => `• ${String(item.title || item.type || "任务").replace(/ · 卡片解析排队$/, "").slice(0, 46)}：${downloadFailureZh(item.errorCode || item.error || item.status)}`),
    ...failedCreative.map((item) => `• 生成 ${String(item.title).slice(0, 38)}：${String(item.error || "失败").slice(0, 70)}`),
  ];
  return lines.length ? ["最近需处理：", ...lines].join("\n") : "目前没有失败或需人工处理的任务。";
}

async function controllerStatusText() {
  const services = await getServiceStates();
  const serviceLine = (fragment, label) => {
    const item = services.find((candidate) => String(candidate.id).includes(fragment));
    const ready = item?.business?.ready ?? item?.healthy ?? item?.running ?? false;
    return `${label}：${ready ? "可用" : item?.runtime?.state === "running" ? "运行中但需登录" : "未就绪"}`;
  };
  return [
    "织台状态：本地节点在线",
    serviceLine("openclaw_weixin", "ClawBot"),
    serviceLine("wechat_mp_tools", "补充下载"),
    serviceLine("matrix", "多平台发布"),
    serviceLine("xianyu_auto_reply", "闲鱼多账号"),
  ].join("\n");
}

const clawbotNotifier = new ClawBotNotifier({ dataDir });
notificationCenter = new NotificationCenter({ dataDir, buildDigest: buildControllerDigest, clawbot: clawbotNotifier });
await notificationCenter.init();

// 下载入口看门狗：不猜测“某条未被网页看见的转发”，只提醒可验证的两类异常：
// 1) 网页/微信登录连续未就绪；2) 已接收的文件传输助手任务长时间未完成。
const DOWNLOAD_ENTRY_GRACE_MS = Math.max(30_000, Number(process.env.ZHITAI_DOWNLOAD_ENTRY_GRACE_MS) || 60_000);
const DOWNLOAD_STUCK_MS = Math.max(60_000, Number(process.env.ZHITAI_DOWNLOAD_STUCK_MS) || 3 * 60_000);
const downloadEntryMonitor = {
  ready: null,
  unreadySince: Date.now(),
  notified: false,
  critical: false,
  lastAutoOpenAt: 0,
};
const downloadTimeoutNotified = new Set();

async function checkDownloadNotifications() {
  const now = Date.now();
  const companionOnline = Boolean(
    kuaidianHeartbeat.online && kuaidianHeartbeat.lastSeen
    && now - new Date(kuaidianHeartbeat.lastSeen).getTime() <= KUAIDIAN_HEARTBEAT_TTL_MS,
  );
  const ready = companionOnline && kuaidianHeartbeat.pageKind === "filehelper" && kuaidianHeartbeat.wechatLoggedIn;
  if (ready) {
    if (downloadEntryMonitor.notified) {
      await recordEvent("info", "FILEHELPER_RECOVERED", "文件传输助手主收件入口已恢复");
    }
    downloadEntryMonitor.ready = true;
    downloadEntryMonitor.unreadySince = null;
    downloadEntryMonitor.notified = false;
    downloadEntryMonitor.critical = false;
    downloadEntryMonitor.lastAutoOpenAt = 0;
  } else {
    if (downloadEntryMonitor.ready !== false || !downloadEntryMonitor.unreadySince) downloadEntryMonitor.unreadySince = now;
    downloadEntryMonitor.ready = false;
    // 文件传输助手是确认过的主收件入口。页面脚本掉线后先自动用 Edge
    // 恢复，而不是因 ClawBot 可用就把故障降级成“备用离线”。
    if (!companionOnline
      && now - downloadEntryMonitor.unreadySince >= DOWNLOAD_ENTRY_GRACE_MS
      && now - downloadEntryMonitor.lastAutoOpenAt >= 10 * 60_000) {
      downloadEntryMonitor.lastAutoOpenAt = now;
      const opened = await openFilehelperWithEdge();
      await recordEvent(opened ? "info" : "warning", "FILEHELPER_AUTO_RECOVERY",
        opened ? "检测到主收件入口掉线，已自动用 Microsoft Edge 恢复文件传输助手"
          : "检测到主收件入口掉线，但未能自动打开 Microsoft Edge");
    }
    if (!downloadEntryMonitor.notified && now - downloadEntryMonitor.unreadySince >= DOWNLOAD_ENTRY_GRACE_MS) {
      downloadEntryMonitor.notified = true;
      downloadEntryMonitor.critical = true;
      const reason = companionOnline ? "网页在线，但微信账号未登录" : "文件传输助手网页脚本离线";
      await recordEvent("warning", "FILEHELPER_LOGIN",
        `${reason}；这是主收件入口，织台已尝试自动恢复。ClawBot 直链仅作备用收件和手机遥控`);
    }
  }

  const tasks = await readTasks();
  for (const task of tasks) {
    const filehelperTask = task?.type === "ingest" && (task?.cardObjectId || /^filehelper_/.test(String(task?.source || "")));
    if (!filehelperTask || !["queued", "running"].includes(String(task?.status || ""))) continue;
    const updated = Date.parse(String(task?.updatedAt || task?.createdAt || ""));
    if (!Number.isFinite(updated) || now - updated < DOWNLOAD_STUCK_MS || downloadTimeoutNotified.has(task.id)) continue;
    downloadTimeoutNotified.add(task.id);
    await recordEvent("warning", "DOWNLOAD_TIMEOUT", `视频“${String(task.title || "未命名").slice(0, 80)}”已处理超过 3 分钟仍未入库，请在织台下载页查看任务详情`, task.id);
  }
}

downloadWatchdogTimer = setInterval(() => void checkDownloadNotifications().catch(() => {}), 15_000);
downloadWatchdogTimer.unref?.();
setTimeout(() => void checkDownloadNotifications().catch(() => {}), 2_000).unref?.();

async function supplementalCredentialStates() {
  let weread = { ready: false, reason: "补充采集引擎未连接" };
  try {
    const response = await fetch("http://127.0.0.1:5200/api/auth/check-credentials", { signal: AbortSignal.timeout(5_000) });
    const state = await response.json().catch(() => ({}));
    weread = { ready: response.ok && state?.valid === true, reason: state?.valid === true ? "登录有效" : String(state?.message || "登录已过期") };
  } catch { /* 保持离线说明 */ }
  let yuanbao = { ready: false, reason: "尚未保存元宝登录" };
  try {
    await loadYuanbaoCookie();
    yuanbao = { ready: true, reason: "已保存登录；实际有效性会在下一条视频号解析时校验" };
  } catch { /* 保持未配置说明 */ }
  return { weread, yuanbao };
}

async function checkCredentialNotifications() {
  const today = localDateKey();
  const deliveries = await notificationCenter.deliveries(500);
  const alreadySent = (kind) => deliveries.some((item) => item.kind === kind && localDateKey(item.createdAt) === today);
  const states = await supplementalCredentialStates();
  if (!states.weread.ready && !alreadySent("credential_weread")) {
    await notificationCenter.send("织台 · 微信读书登录已过期", "公众号文章检索、订阅和正文补全会暂停。请打开织台 → 下载 → 登录管理，点击“登录微信读书”。", "credential_weread");
  }
  if (!states.yuanbao.ready && !alreadySent("credential_yuanbao")) {
    await notificationCenter.send("织台 · 元宝登录未就绪", "视频号链接解析和元数据补全可能失败。请打开织台 → 下载 → 登录管理，点击“登录腾讯元宝”。", "credential_yuanbao");
  }
}

async function readRuntimeConditionsState() {
  try {
    const parsed = JSON.parse(await readFile(runtimeConditionsPath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

async function mutateRuntimeConditionsState(mutator) {
  const operation = runtimeConditionsMutation.catch(() => {}).then(async () => {
    const state = await readRuntimeConditionsState();
    const result = await mutator(state);
    await writeJsonAtomic(runtimeConditionsPath, state);
    runtimeConditionsCache = { at: 0, snapshot: null };
    return result;
  });
  runtimeConditionsMutation = operation.then(() => undefined, () => undefined);
  return operation;
}

async function saveCreativeConditionReport(input) {
  const checkedAt = new Date().toISOString();
  const report = normalizeCreativeConditionReport(input, checkedAt, localDateKey(checkedAt));
  await mutateRuntimeConditionsState((state) => { state.creative = report; });
  return report;
}

function kuaidianConditionState() {
  const checkedAt = kuaidianHeartbeat.lastSeen || null;
  const fresh = Boolean(kuaidianHeartbeat.online && checkedAt
    && Date.now() - Date.parse(checkedAt) <= KUAIDIAN_HEARTBEAT_TTL_MS);
  return {
    filehelperPageConnected: fresh && kuaidianHeartbeat.pageKind === "filehelper",
    wechatLoggedIn: fresh && kuaidianHeartbeat.pageKind === "filehelper" && kuaidianHeartbeat.wechatLoggedIn === true,
    checkedAt,
  };
}

async function runtimeBacklogSnapshot() {
  const db = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
  let total = 0;
  let remaining = 0;
  try {
    const rows = db.prepare(`SELECT v.id, rp.plan_json AS planJson FROM video_asset v
      LEFT JOIN remake_plan rp ON rp.asset_id=v.id`).all();
    total = rows.length;
    remaining = rows.filter((row) => !parseSavedWorkflow({ plan_json: row.planJson }).complete).length;
  } finally { db.close(); }
  const [analysisCounts, creativeJobs] = await Promise.all([analysisQueue.counts(), creativeQueue.list()]);
  return {
    analysis: {
      total,
      queued: analysisCounts.queued,
      running: analysisCounts.running,
      retryWait: analysisCounts.retryWait,
      completed: Math.max(0, total - remaining),
      needsAttention: analysisCounts.needsAttention,
      remaining,
    },
    creative: {
      waiting: creativeJobs.filter((job) => ["queued", "preparing", "ready_for_images", "ready_for_seedance", "ready_for_assembly", "paused", "failed"].includes(job.status)).length,
      waitingForImages: creativeJobs.filter((job) => job.status === "ready_for_images").length,
      waitingForSeedance: creativeJobs.filter((job) => job.status === "ready_for_seedance").length,
      waitingForAssembly: creativeJobs.filter((job) => job.status === "ready_for_assembly").length,
      preparing: creativeJobs.filter((job) => ["queued", "preparing"].includes(job.status)).length,
      paused: creativeJobs.filter((job) => job.status === "paused").length,
      failed: creativeJobs.filter((job) => job.status === "failed").length,
      completed: creativeJobs.filter((job) => job.status === "completed").length,
    },
  };
}

async function notifyRuntimeConditionChange(snapshot) {
  const blockers = snapshot.conditions.filter((row) => !row.optional && row.state === "attention");
  const fingerprint = blockers.map((row) => row.id).sort().join("|");
  const today = localDateKey();
  await mutateRuntimeConditionsState(async (state) => {
    state.alerts ??= { date: today, fingerprints: [], blockingFingerprint: "" };
    if (state.alerts.date !== today) state.alerts = { date: today, fingerprints: [], blockingFingerprint: state.alerts.blockingFingerprint || "" };
    const previous = String(state.alerts.blockingFingerprint || "");
    if (fingerprint && !state.alerts.fingerprints.includes(fingerprint)) {
      state.alerts.fingerprints.push(fingerprint);
      const lines = blockers.map((row) => `• ${row.label}：${row.reason}`).join("\n");
      await notificationCenter.send("织台 · 今日运行条件需处理", `${lines}\n\n文件传输助手是主收件入口；ClawBot 直链只作备用收件和手机遥控。`, "runtime_conditions");
    } else if (!fingerprint && previous) {
      await notificationCenter.send("织台 · 今日运行条件已恢复", "当前必需入口和账号条件均已通过，可以继续生成与创建草稿。", "runtime_conditions_recovered");
    }
    state.alerts.blockingFingerprint = fingerprint;
    state.alerts.fingerprints = state.alerts.fingerprints.slice(-20);
  });
}

async function collectRuntimeConditions({ refresh = false, notify = false } = {}) {
  if (!refresh && runtimeConditionsCache.snapshot && Date.now() - runtimeConditionsCache.at < 60_000) {
    return runtimeConditionsCache.snapshot;
  }
  let state = await readRuntimeConditionsState();
  if (refresh) {
    const checkedAt = new Date().toISOString();
    const [accountResult, xhs, official] = await Promise.all([
      matrix.cliAccounts().then((accounts) => ({ ok: true, accounts })).catch((error) => ({ ok: false, error: safeMessage(error?.message || error) })),
      xhsPublisher.status().catch((error) => ({ online: false, loggedIn: false, reason: safeMessage(error?.message || error) })),
      wechatOfficial.verifyStatus().catch(() => ({
        configured: wechatOfficial.status().configured,
        credentialReady: false,
        draftReady: false,
        ready: false,
        needsAttention: false,
        reason: "公众号状态暂时无法校验，请稍后重试",
      })),
    ]);
    const platform = {
      checkedAt,
      accounts: accountResult.ok ? accountResult.accounts.map((row) => ({
        platform: String(row?.platform || "").slice(0, 40),
        code: String(row?.code || "").slice(0, 20),
        loginStatus: String(row?.loginStatus || row?.status || "").slice(0, 40),
      })) : null,
      publisherError: accountResult.ok ? null : accountResult.error,
      xiaohongshu: { online: xhs?.online === true, loggedIn: xhs?.loggedIn === true, reason: safeMessage(xhs?.reason || (xhs?.loggedIn ? "登录有效" : "需登录")) },
      wechatOfficial: {
        configured: official?.configured === true,
        credentialReady: official?.credentialReady === true,
        draftReady: official?.draftReady === true,
        ready: official?.ready === true,
        needsAttention: official?.needsAttention === true,
        reason: safeMessage(official?.reason || (official?.ready ? "接口有效" : "需配置")),
      },
    };
    await mutateRuntimeConditionsState((next) => { next.platform = platform; });
    state = await readRuntimeConditionsState();
  }

  const checkedAt = state.platform?.checkedAt || state.creative?.checkedAt || new Date().toISOString();
  const remoteStatus = remoteController && typeof remoteController.status === "function"
    ? remoteController.status().catch(() => ({ paired: false }))
    : Promise.resolve({ paired: false });
  const [services, remote, backlog, notificationState] = await Promise.all([
    getServiceStates(),
    remoteStatus,
    runtimeBacklogSnapshot(),
    notificationCenter.publicState().catch(() => ({ clawbot: { operational: false, deliveryState: "unverified" } })),
  ]);
  const snapshot = buildRuntimeConditions({
    checkedAt,
    dateKey: localDateKey(),
    services,
    remote,
    notifications: { clawbot: notificationState.clawbot || null },
    filehelper: kuaidianConditionState(),
    creative: state.creative || null,
    publisherAccounts: state.platform?.accounts ?? null,
    publisherError: state.platform?.publisherError || null,
    xiaohongshu: state.platform?.xiaohongshu || {},
    wechatOfficial: state.platform?.wechatOfficial || wechatOfficial.status(),
    backlog,
  });
  runtimeConditionsCache = { at: Date.now(), snapshot };
  await mutateRuntimeConditionsState((next) => { next.snapshot = snapshot; });
  runtimeConditionsCache = { at: Date.now(), snapshot };
  if (notify) await notifyRuntimeConditionChange(snapshot);
  return snapshot;
}

async function refreshRuntimeConditions() {
  if (runtimeConditionsRefreshInFlight) return runtimeConditionsRefreshInFlight;
  if (runtimeConditionsLastRefreshSnapshot
    && Date.now() - runtimeConditionsLastRefreshAt < RUNTIME_CONDITIONS_REFRESH_COOLDOWN_MS) {
    return runtimeConditionsLastRefreshSnapshot;
  }
  runtimeConditionsRefreshInFlight = collectRuntimeConditions({ refresh: true, notify: true })
    .then((snapshot) => {
      runtimeConditionsLastRefreshAt = Date.now();
      runtimeConditionsLastRefreshSnapshot = snapshot;
      return snapshot;
    })
    .finally(() => { runtimeConditionsRefreshInFlight = null; });
  return runtimeConditionsRefreshInFlight;
}

credentialReminderTimer = setInterval(() => void checkCredentialNotifications().catch(() => {}), 15 * 60_000);
credentialReminderTimer.unref?.();
setTimeout(() => void checkCredentialNotifications().catch(() => {}), 5_000).unref?.();

remoteController = new RemoteController({
  dataDir,
  getSummary: buildControllerDigest,
  getMaterials: controllerMaterials,
  getQueue: controllerQueueText,
  getFailures: controllerFailuresText,
  getStatus: controllerStatusText,
  ingestLink: async ({ url, text, userNote }) => createIngestTask({ url, text, userNote }, "openclaw_weixin_remote"),
  enqueueCreative: async (assetId) => (await creativeQueue.create({ assetId, title: (await controllerMaterials()).find((item) => item.id === assetId)?.title || assetId, autoCreated: false })).job,
  approveCreative: approveCreativeReview,
  reviseCreative: reviseCreativeReview,
  pauseCreative: async () => {
    const jobs = (await creativeQueue.list()).filter((job) => ["queued", "preparing"].includes(job.status));
    for (const job of jobs) await creativeQueue.pause(job.id);
    return jobs.length ? `已暂停 ${jobs.length} 个生成准备任务。` : "当前没有可暂停的生成准备任务。";
  },
  resumeCreative: async () => {
    const jobs = (await creativeQueue.list()).filter((job) => job.status === "paused");
    for (const job of jobs) await creativeQueue.resume(job.id);
    return jobs.length ? `已继续 ${jobs.length} 个生成准备任务。` : "当前没有已暂停的生成准备任务。";
  },
});
await remoteController.init();

// 桌面端会额外上报 GPT/豆包真实页面状态；本地节点每 6 小时低频深检
// 发布账号与公众号权限，并由 ClawBot/ntfy 聚合提醒一次。
runtimeConditionsTimer = setInterval(() => void refreshRuntimeConditions().catch(() => {}), 6 * 60 * 60_000);
runtimeConditionsTimer.unref?.();
setTimeout(() => void refreshRuntimeConditions().catch(() => {}), 60_000).unref?.();

const server = createServer(async (request, response) => {
  const requestUrl = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);

  if (request.method === "OPTIONS") {
    response.writeHead(204, corsHeaders(request));
    response.end();
    return;
  }

  try {
    if (request.method === "GET" && requestUrl.pathname === "/channels-proxy.pac") {
      const body = Buffer.from(CHANNELS_PROXY_PAC, "utf8");
      response.writeHead(200, {
        "Content-Type": "application/x-ns-proxy-autoconfig",
        "Content-Length": String(body.length),
        "Cache-Control": "no-store, max-age=0",
        "X-Content-Type-Options": "nosniff",
      });
      response.end(body);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/health") {
      const [tasks, services] = await Promise.all([readTasks(), getServiceStates()]);
      sendJson(response, 200, {
        ok: true,
        service: "zhitai-local-companion",
        version: 2,
        uptimeSeconds: Math.floor(process.uptime()),
        queue: tasks.filter((task) => ["queued", "running", "scheduled"].includes(task.status)).length,
        knowledgeBase: publicKnowledgeBase,
        webhookEnabled: true,
        inboxMode: config.webhookSecret ? "signature_required" : "origin_or_loopback",
        webhookSecretSource: config.webhookSecretSource,
        adapters: publicAdapterState(),
        services,
      }, request);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/v1/runtime-conditions") {
      const snapshot = await collectRuntimeConditions();
      sendJson(response, 200, snapshot, request);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/v1/runtime-conditions/refresh") {
      if (!guardJsonWrite(request, response)) return;
      await readJsonBody(request, 1_000);
      const snapshot = await refreshRuntimeConditions();
      sendJson(response, 200, snapshot, request);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/v1/runtime-conditions/creative") {
      if (!guardJsonWrite(request, response)) return;
      const { json } = await readJsonBody(request, 20_000);
      const report = await saveCreativeConditionReport(json);
      const snapshot = await collectRuntimeConditions();
      sendJson(response, 200, { ok: true, report, snapshot }, request);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/v1/config") {
      sendJson(response, 200, {
        knowledgeBase: publicKnowledgeBase,
        webhookEnabled: true,
        inboxMode: config.webhookSecret ? "signature_required" : "origin_or_loopback",
        webhookSecretSource: config.webhookSecretSource,
        adapters: publicAdapterState(),
        services: await getServiceStates(),
      }, request);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/v1/tasks") {
      sendJson(response, 200, { tasks: await readTasks() }, request);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/v1/creative/jobs") {
      const jobs = await creativeQueue.list();
      sendJson(response, 200, {
        jobs,
        counts: {
          active: jobs.filter((job) => ["queued", "preparing"].includes(job.status)).length,
          waiting: jobs.filter((job) => ["ready_for_images", "ready_for_seedance", "ready_for_assembly", "paused"].includes(job.status)).length,
          completed: jobs.filter((job) => job.status === "completed").length,
          failed: jobs.filter((job) => job.status === "failed").length,
        },
      }, request);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/v1/analysis/jobs") {
      sendJson(response, 200, { ok: true, jobs: await analysisQueue.list(), counts: await analysisQueue.counts() }, request);
      return;
    }

    const analysisAction = requestUrl.pathname.match(/^\/api\/v1\/analysis\/jobs\/([^/]+)\/(pause|resume|retry|cancel)$/);
    if (request.method === "POST" && analysisAction) {
      if (!guardJsonWrite(request, response)) return;
      await readJsonBody(request, 1_000);
      const [, jobId, action] = analysisAction;
      const job = action === "pause" ? await analysisQueue.pause(jobId)
        : action === "cancel" ? await analysisQueue.cancel(jobId)
          : action === "retry" ? await analysisQueue.retry(jobId)
            : await analysisQueue.resume(jobId);
      sendJson(response, 200, { ok: true, job, counts: await analysisQueue.counts() }, request);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/v1/creative/reviews") {
      const reviews = await readCreativeReviews();
      sendJson(response, 200, {
        ok: true,
        reviews: reviews.map(({ filePath: _privatePath, ...review }) => review),
        counts: {
          pending: reviews.filter((row) => row.status === "pending_review").length,
          approved: reviews.filter((row) => ["approved_for_drafts", "approved_for_publish"].includes(row.status)).length,
          revision: reviews.filter((row) => row.status === "needs_revision").length,
        },
      }, request);
      return;
    }

    const creativeReviewAction = requestUrl.pathname.match(/^\/api\/v1\/creative\/reviews\/(\d+)\/revise$/);
    if (request.method === "POST" && creativeReviewAction) {
      if (!guardJsonWrite(request, response)) return;
      const { json } = await readJsonBody(request, 4_000);
      const feedback = String(json?.feedback || "").replace(/\s+/g, " ").trim().slice(0, 800);
      if (feedback.length < 4) throw httpError(400, "creative_revision_feedback_required");
      const message = await reviseCreativeReview(Number(creativeReviewAction[1]), feedback);
      if (/^今日没有第/.test(message)) throw httpError(404, "creative_review_not_found");
      sendJson(response, 202, { ok: true, message }, request);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/v1/creative/jobs") {
      if (!guardJsonWrite(request, response)) return;
      const { json } = await readJsonBody(request);
      const assetId = String(json?.assetId || "").trim();
      if (!/^[A-Za-z0-9._-]{1,160}$/.test(assetId)) throw httpError(400, "invalid_asset_id");
      const { openKbDb } = await import("./kb.mjs");
      const db = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
      let asset;
      try { asset = db.prepare("SELECT id, title, category FROM video_asset WHERE id=?").get(assetId); }
      finally { db.close(); }
      if (!asset) throw httpError(404, "creative_asset_not_found");
      if (asset.category !== "素材") throw httpError(409, "only_material_assets_can_be_remade");
      const result = await creativeQueue.create({ assetId, title: asset.title, autoCreated: false });
      sendJson(response, result.deduplicated ? 200 : 201, { ok: true, ...result }, request);
      return;
    }

    const creativeAction = requestUrl.pathname.match(/^\/api\/v1\/creative\/jobs\/([^/]+)\/(pause|resume|retry|cancel|advance|attention)$/);
    if (request.method === "POST" && creativeAction) {
      if (!guardJsonWrite(request, response)) return;
      const [, jobId, action] = creativeAction;
      const { json } = await readJsonBody(request);
      if (action === "attention") {
        const current = (await creativeQueue.list()).find((item) => item.id === jobId);
        if (!current) throw httpError(404, "creative_job_not_found");
        const detail = safeMessage(String(json?.error || "网页生成暂时无法继续")).slice(0, 300);
        await recordEvent("error", "CREATIVE_PREPARE", `网页生成需处理：${detail}`, jobId);
        sendJson(response, 202, { ok: true, jobId, recorded: true }, request);
        return;
      }
      let persistedOutput = null;
      if (action === "advance" && String(json?.step || "") === "complete") {
        const current = (await creativeQueue.list()).find((item) => item.id === jobId);
        if (!current) throw httpError(404, "creative_job_not_found");
        const { persistZhitaiGeneration } = await import("./kb.mjs");
        const db = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
        try { persistedOutput = await persistZhitaiGeneration(db, current.assetId, { jobId, subject: current.title }); }
        finally { db.close(); }
        if (!persistedOutput?.ok) throw httpError(persistedOutput?.status || 400, `creative_output_persist_failed：${persistedOutput?.error || "unknown"}`);
      }
      const job = action === "pause" ? await creativeQueue.pause(jobId)
        : action === "cancel" ? await creativeQueue.cancel(jobId)
          : action === "advance" ? await creativeQueue.advance(jobId, String(json?.step || ""), persistedOutput ? { generationId: persistedOutput.id, mediaUrl: persistedOutput.mediaUrl } : null)
            : await creativeQueue.resume(jobId);
      if (persistedOutput && job?.status === "completed") {
        const review = await recordCreativeReview({ job, persistedOutput });
        const message = [
          "今日第 " + review.sequence + " 条备用成片",
          review.title,
          "回复“选择 " + review.sequence + "”创建抖音、视频号、小红书草稿。",
          "如需修改，回复“改进 " + review.sequence + " 你的具体意见”。",
          "没有你的选择，织台不会创建草稿；任何情况下都不会自动公开发布。",
        ].join("\n");
        // 视频上传可能超过桌面生成器的 30 秒接口超时；先完成登记，再在后台发送。
        setTimeout(() => void notificationCenter.sendMedia("织台 · 待审核成片 " + review.sequence, message, persistedOutput.filePath, "creative_review")
          .then((sent) => {
            if (!sent.ok) return notificationCenter.send("织台 · 成片已生成但视频发送失败", message + "\n请在织台 → 豆包创作中预览。", "creative_review_fallback");
            return null;
          }).catch(() => {}), 0).unref?.();
      }
      sendJson(response, 200, { ok: true, job }, request);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/v1/x-bookmarks/status") {
      const db = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
      try { sendJson(response, 200, { ok: true, ...xBookmarkStatus(db) }, request); }
      finally { db.close(); }
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/v1/x-bookmarks/import") {
      if (!guardJsonWrite(request, response)) return;
      const { json } = await readJsonBody(request, 2_000_000);
      const db = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
      try {
        const result = await importXBookmarks(db, json, { knowledgeBase });
        await recordEvent("info", "X_BOOKMARKS", `X 收藏同步：读取 ${result.fetched} 条，新入库 ${result.imported} 条`);
        sendJson(response, 200, result, request);
      } finally { db.close(); }
      return;
    }

    const xBookmarkDetail = requestUrl.pathname.match(/^\/api\/v1\/x-bookmarks\/(x_\d+)$/);
    if (request.method === "GET" && xBookmarkDetail) {
      const db = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
      try {
        const item = getXBookmark(db, xBookmarkDetail[1]);
        sendJson(response, item ? 200 : 404, item ?? { error: "not_found" }, request);
      } finally { db.close(); }
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/v1/library") {
      // 与 /api/v1/kb 共享同一数据源（kb.sqlite），不再双孤岛；
      // 只有手动刷新才扫描 metadata.json。页面 3s 轮询不重复跑 schema/迁移，
      // 否则会和分析/入库事务争用 SQLite 锁。
      if (requestUrl.searchParams.get("refresh") === "1") {
        try {
          libraryMigrationMutation = libraryMigrationMutation.catch(() => {}).then(() =>
            migrateLibraryToKb({ kbRoot: knowledgeBase, dataDir, privDir: kbPrivDir }));
          await libraryMigrationMutation;
        } catch { /* 迁移失败不影响查询 */ }
      }
      const { queryVideos } = await import("./kb.mjs");
      const db = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
      const { items: videos } = queryVideos(db, { limit: 500 });
      const items = [...videos, ...queryXBookmarks(db, { limit: 500 })]
        .sort((left, right) => String(right.created_at || "").localeCompare(String(left.created_at || "")));
      db.close();
      sendJson(response, 200, { items, source: "kb_unified" }, request);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/v1/library/open-folder") {
      requireConfirmedAction(request);
      await access(knowledgeBase, fsConstants.R_OK);
      const child = spawn("/usr/bin/open", [knowledgeBase], {
        shell: false,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      sendJson(response, 200, { ok: true }, request);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/v1/events") {
      const limit = Math.min(200, Math.max(1, Number(requestUrl.searchParams.get("limit") || 100)));
      sendJson(response, 200, { events: (await readEvents()).slice(0, limit) }, request);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/v1/remote/status") {
      sendJson(response, 200, { ok: true, ...(await remoteController.status()) }, request);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/v1/remote/audit") {
      const limit = Math.min(200, Math.max(1, Number(requestUrl.searchParams.get("limit") || 50)));
      sendJson(response, 200, { ok: true, items: await remoteController.audit(limit) }, request);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/v1/remote/command") {
      const body = await readJsonBody(request, 64_000);
      await guardInbox(request, body.raw);
      const result = await remoteController.route({
        text: body.json?.text,
        senderId: body.json?.senderId,
        accountId: body.json?.accountId,
        isGroup: body.json?.isGroup === true,
      });
      const rejectedSender = result.authorizedSender !== true;
      // 只有经过签名校验且命中已配对白名单的私聊，才算用户已回复。
      // 这会停止“等你回复”的重复提醒并允许下一次 ClawBot 实投重新验证会话；
      // 未授权发送者不能借此关闭任何运营阻塞。
      if (result.authorizedSender === true) {
        await notificationCenter.acknowledgeFromUserReply();
      }
      sendJson(response, rejectedSender ? 403 : 200, result, request);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/v1/remote/unpair") {
      requireConfirmedAction(request);
      sendJson(response, 200, { ok: true, ...(await remoteController.unpair()) }, request);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/v1/notifications") {
      sendJson(response, 200, { ok: true, ...(await notificationCenter.publicState()) }, request);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/v1/notifications/settings") {
      if (!guardJsonWrite(request, response)) return;
      const { json } = await readJsonBody(request, 64_000);
      sendJson(response, 200, { ok: true, ...(await notificationCenter.update(json)) }, request);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/v1/notifications/subscription") {
      if (!guardJsonWrite(request, response)) return;
      await readJsonBody(request, 1_000);
      sendJson(response, 201, { ok: true, ...(await notificationCenter.createSubscription()) }, request);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/v1/notifications/test") {
      requireConfirmedAction(request);
      await readJsonBody(request, 1_000);
      const result = await notificationCenter.test();
      sendJson(response, result.ok ? 200 : 409, result, request);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/v1/notifications/report") {
      if (!guardJsonWrite(request, response)) return;
      const { json } = await readJsonBody(request, 16_000);
      if (typeof json?.title !== "string") throw httpError(400, "notification_report_title_required");
      if (typeof json?.message !== "string") throw httpError(400, "notification_report_message_required");
      const title = json.title.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
      const message = json.message.replace(/\r\n?/g, "\n").replace(/\t/g, " ")
        .replace(/[\u0000\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
      if (title.length < 2) throw httpError(400, "notification_report_title_required");
      if (message.length < 4) throw httpError(400, "notification_report_message_required");
      if (title.length > 120) throw httpError(400, "notification_report_title_too_long");
      if (message.length > 3_000) throw httpError(400, "notification_report_message_too_long");
      // 这是自动化日报的纯文字出口：复用正在运行的通知中心，避免第二个
      // Node 进程同时写通知 WAL；固定 kind 且不建立业务 blocker。
      const result = await notificationCenter.send(title, message, "daily_operations_report", { trackBlocker: false });
      // 已进入持久 outbox 也表示请求被可靠接收；不能返回 409 诱使调用方
      // 立即重复提交。正文中的 ok/queued 继续区分“已投递”和“待重试”。
      sendJson(response, result.ok || result.queued ? 202 : 409, result, request);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/v1/services") {
      sendJson(response, 200, { services: await getServiceStates() }, request);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/v1/credentials/status") {
      sendJson(response, 200, { ok: true, ...(await supplementalCredentialStates()), loginUrls: { weread: "http://127.0.0.1:5200/#login", yuanbao: "http://127.0.0.1:5200/#channels_login" } }, request);
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/v1/updates") {
      const refresh = requestUrl.searchParams.get("refresh") === "1";
      sendJson(response, 200, { modules: await getModuleUpdates(refresh), checkedAt: new Date().toISOString() }, request);
      return;
    }

    const moduleInstallMatch = requestUrl.pathname.match(/^\/api\/v1\/updates\/([a-z0-9_-]+)\/install$/);
    if (request.method === "POST" && moduleInstallMatch) {
      requireConfirmedAction(request);
      const { json } = await readJsonBody(request, 8_000);
      const moduleId = moduleInstallMatch[1];
      const install = () => installModuleUpdate({ moduleId, expectedVersion: String(json?.expectedVersion || "") || null });
      const operation = moduleUpdateMutation.then(install, install);
      moduleUpdateMutation = operation.catch(() => null);
      try {
        const result = await operation;
        moduleUpdateCache = { at: 0, modules: [] };
        await recordEvent("info", "MODULE_UPDATE", `${moduleId} 已更新到 ${result.version}`);
        sendJson(response, 200, result, request);
      } catch (error) {
        await recordEvent("warning", "MODULE_UPDATE", `${moduleId} 更新失败：${safeMessage(error?.message)}`);
        throw httpError(409, safeMessage(error?.message || "module_update_failed"));
      }
      return;
    }

    const serviceAction = requestUrl.pathname.match(/^\/api\/v1\/services\/([a-z0-9_-]+)\/(start|stop|setup)$/);
    if (request.method === "POST" && serviceAction) {
      requireConfirmedAction(request);
      const [, serviceId, action] = serviceAction;
      const result = await runServiceAction(() => action === "start"
        ? startService(serviceId)
        : action === "stop"
          ? stopService(serviceId)
          : setupService(serviceId));
      sendJson(response, 200, result, request);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/v1/ingest") {
      if (!guardJsonWrite(request, response)) return;
      const { json } = await readJsonBody(request);
      const task = await createIngestTask(json, "manual");
      sendJson(response, 202, { task }, request);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/v1/inbox") {
      const body = await readJsonBody(request, 256_000);
      await guardInbox(request, body.raw);
      const task = await createIngestTask(body.json, sanitizeSource(body.json.source || "wechat_webhook"));
      sendJson(response, 202, { task }, request);
      return;
    }

    // 文件传输助手直接转发的视频号卡片：浏览器桥只上报卡片身份，
    // 本地 wx_channels_download 引擎用已连接的微信视频号页面换取媒体信息。
    if (request.method === "POST" && requestUrl.pathname === "/api/v1/channels/card") {
      const body = await readJsonBody(request, 32_000);
      await guardInbox(request, body.raw);
      const task = await createChannelsCardTask(body.json, sanitizeSource(body.json.source || "filehelper_web"));
      sendJson(response, 202, { task }, request);
      return;
    }

    // 视频卡片后紧跟的一句用户理解/要求：只按本机 deliveryId/objectId 关联，
    // 不把它当新链接，不触发第二次下载。
    if (request.method === "POST" && requestUrl.pathname === "/api/v1/channels/note") {
      const body = await readJsonBody(request, 16_000);
      await guardInbox(request, body.raw);
      const deliveryId = validateDeliveryId(body.json?.deliveryId).value;
      const objectId = String(body.json?.objectId || "").trim();
      const note = sanitizeUserNote(body.json?.note);
      if (!note || (!deliveryId && !/^[0-9]{6,32}$/.test(objectId))) throw httpError(400, "invalid_card_note");
      const task = (await readTasks()).find((item) => item.type === "ingest"
        && ((deliveryId && item.deliveryId === deliveryId) || (objectId && item.cardObjectId === objectId)));
      if (!task) throw httpError(404, "card_task_not_found");
      const updated = await attachTaskNote(task, note);
      await recordEvent("info", "INGEST_NOTE", `已保存你对“${String(task.title || "视频号内容").replace(/ · 卡片解析排队$/, "").slice(0, 60)}”的备注`, task.id);
      sendJson(response, 200, { ok: true, task: { id: updated.id, userNote: note } }, request);
      return;
    }

    // 诊断通道:桥接脚本把 webwxsync 等原始响应转发过来存盘,
    // 用于排查"网页版到底收到了什么消息结构"(视频号卡片提取)。
    if (request.method === "POST" && requestUrl.pathname === "/api/v1/diag") {
      if (!guardJsonWrite(request, response)) return;
      const { json } = await readJsonBody(request, 300_000);
      const diagDir = join(dataDir, "diag");
      await mkdir(diagDir, { recursive: true });
      const fname = `sync-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.json`;
      await writeFile(
        join(diagDir, fname),
        JSON.stringify({
          at: new Date().toISOString(),
          url: String(json?.url || "").slice(0, 500),
          text: String(json?.text || "").slice(0, 60_000),
        }, null, 2),
      );
      sendJson(response, 202, { ok: true }, request);
      return;
    }

    // 快点工具下载引擎上报（主力通道）：
    // {downloadUrl|localPath, sourceUrl?, deliveryId?, title?} —— 向后兼容 url
    // downloadUrl=临时媒体直链（永不落库/出 API/日志；落库前 fingerprint）；
    // sourceUrl=稳定分享链接（sph/sf），只有真实稳定分享 URL 才调元宝补元数据；
    // deliveryId=本机投递 ID（原版快点 okd[].m = 微信 MsgId），仅作投递溯源/查重，
    // 绝不进入平台 contentId/标题/sourceUrl。
    if (request.method === "POST" && requestUrl.pathname === "/api/v1/kuaidian") {
      if (!guardJsonWrite(request, response)) return;
      const { json } = await readJsonBody(request, 100_000);
      const downloadUrl = String(json?.downloadUrl || json?.url || "").trim();
      const localPath = String(json?.localPath || "").trim() || (downloadUrl && !/^https?:\/\//i.test(downloadUrl) ? downloadUrl : "");
      const title = String(json?.title || "视频号内容").trim().slice(0, 200);
      const content = String(json?.content || "").trim().slice(0, 2000);
      const rawSourceUrl = String(json?.sourceUrl || "").trim().slice(0, 500) || null;
      // A4.3-B：原版快点 okd[].m 是微信 MsgId（投递 ID），不是平台 contentId。
      // deliveryId（限定长度/字符）只作本机投递溯源，绝不复制进 contentId/标题/sourceUrl；
      // contentId 是独立字段：显式提供的真实平台 contentId 仍向后兼容接收（合法客户端可用），
      // 两者绝不互拷、绝不互相回退；平台 contentId 也可来自真实平台字段/稳定分享 URL 推导/元宝 exportId。
      // 非空但非法的 deliveryId → 400 invalid_delivery_id（绝不静默置 null 落入非原子路径）。
      const deliveryValidation = validateDeliveryId(json?.deliveryId);
      if (deliveryValidation.has && !deliveryValidation.valid) {
        sendJson(response, 400, { error: "invalid_delivery_id" }, request);
        return;
      }
      const deliveryId = deliveryValidation.value;
      const contentId = String(json?.contentId || "").trim().slice(0, 200) || null;
      if (!downloadUrl && !localPath) { sendJson(response, 400, { error: "bad_input" }, request); return; }
      // P0-5：sourceUrl 只有稳定分享 URL 才 canonical 保留；否则一律 null（downloadUrl/签名 query 绝不落库/API/日志）
      const sourceUrl = rawSourceUrl && isStableShareUrl(rawSourceUrl) ? canonicalizeSourceUrl(rawSourceUrl) : null;
      const { openKbDb, recordReceipt } = await import("./kb.mjs");
      const { resolveEnrich } = await import("./kb-routes.mjs");
      const { makeFailReceipt, adapterKuaidian } = await import("./downloader-adapter.mjs");
      const enrichFn = resolveEnrich();
      const isDl = Boolean(downloadUrl && /^https?:\/\//i.test(downloadUrl));
      // downloadUrl 永不落库：fingerprint；displayInput 用稳定 sourceUrl 或 basename/[redacted]
      const inputForDb = isDl ? redactUrlForStorage(downloadUrl) : (localPath || null);
      const displayInput = sourceUrl || (localPath ? localPath.split("/").pop() : "[redacted:kuaidian_download_url]");
      const db = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
      // 同进程另一个异步入库事务可能暂时持锁；同步等待不可超过一个事件循环片段。
      db.exec("PRAGMA busy_timeout = 250");
      // A4.2 B + A4.3-B + A4.3-D2a：BEGIN IMMEDIATE 原子认领（无 await）。
      // 查重键优先级：① 合法 deliveryId（第一键）→ ② canonical sourceUrl → ③ 无键时事务外 fallback（保持原状）
      // D2a：命中 deliveryId 行后按状态分流 ——
      //   终态(success/duplicate/linked)/fresh processing/pending → 零变更 deduplicated 复用同 batchId/itemId/assetId；
      //   failed/partial/orphaned 或超过 15 分钟的 processing → 原地原子回收复用同一 batch/item：
      //   清 error/asset_id、按本请求更新安全 input/display、retry_count+1，仅 changes===1 的请求启动 worker。
      let itemId = null;
      let batchId = null;
      let deduplicated = false;
      let dedupAssetId = null;
      if (sourceUrl || deliveryId) {
        db.exec("BEGIN IMMEDIATE");
        try {
          const nowIso = new Date().toISOString();
          // A4.2.1：崩溃恢复阈值 —— 超过 15 分钟仍 processing 视为陈旧，可被原地回收
          const staleCutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
          // ① deliveryId 第一查重键
          let deliveryRow = null;
          if (deliveryId) {
            deliveryRow = db.prepare(
              "SELECT id, batch_id, status, asset_id, updated_at, delivery_id FROM import_item WHERE delivery_id=? ORDER BY id ASC LIMIT 1",
            ).get(deliveryId);
          }
          if (deliveryRow) {
            const rowStatus = String(deliveryRow.status || "");
            const staleProcessing = rowStatus === "processing" && deliveryRow.updated_at < staleCutoff;
            const reclaimable = ["failed", "partial", "orphaned"].includes(rowStatus) || staleProcessing;
            if (reclaimable) {
              // 原地原子回收：条件 UPDATE 保证并发下仅一个请求 changes===1
              const reclaimed = db.prepare(
                `UPDATE import_item SET status='processing', error=NULL, asset_id=NULL, input=?, input_kind=?, display_input=?, retry_count=COALESCE(retry_count,0)+1, updated_at=? WHERE id=? AND (status IN ('failed','partial','orphaned') OR (status='processing' AND updated_at < ?))`,
              ).run(inputForDb, "kuaidian", displayInput, nowIso, deliveryRow.id, staleCutoff);
              itemId = deliveryRow.id;
              batchId = deliveryRow.batch_id;
              if (reclaimed.changes === 1) {
                // 唯一 worker：同一事务内把原批次同步为 running 并按 item 当前行重算计数
                // （item 刚变为 processing → 不再计入任何终态桶），防止 worker 打开连接前崩溃
                // 留下 batch=done 而 item=processing 的不一致。
                const bTotal = db.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=?").get(batchId).c;
                const bSucceeded = db.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=? AND status IN ('success','linked')").get(batchId).c;
                const bFailed = db.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=? AND status IN ('failed','partial','orphaned')").get(batchId).c;
                const bSkipped = db.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=? AND status='duplicate'").get(batchId).c;
                db.prepare("UPDATE import_batch SET status='running', total=?, succeeded=?, failed=?, skipped=? WHERE id=?").run(bTotal, bSucceeded, bFailed, bSkipped, batchId);
              } else {
                deduplicated = true; // 已被并发请求回收 → 复用同 IDs
              }
            } else {
              // 终态成功类 / fresh processing / pending：零变更 dedup 复用同 batchId/itemId/assetId
              itemId = deliveryRow.id;
              batchId = deliveryRow.batch_id;
              deduplicated = true;
              if (["success", "duplicate", "linked"].includes(rowStatus) && deliveryRow.asset_id) {
                dedupAssetId = deliveryRow.asset_id;
              }
            }
          } else if (sourceUrl) {
            // 无 deliveryId 行：保留既有 sourceUrl 认领 + deliveryId 绑定语义（A4.2/A4.3-B）
            // A4.2.1 崩溃恢复：进程崩溃会留下 processing 永久阻塞同 source。
            // 认领前先把超过 15 分钟仍 processing 的快点 item 恢复为 pending（保留 error 追加说明）。
            db.prepare(
              "UPDATE import_item SET status='pending', error=CASE WHEN error IS NULL OR error='' THEN 'recovered_stale_processing' ELSE error || '; recovered_stale_processing' END, updated_at=? WHERE status='processing' AND (input=? OR display_input=?) AND updated_at < ?",
            ).run(nowIso, sourceUrl, sourceUrl, staleCutoff);
            const processing = db.prepare(
              "SELECT id, batch_id, delivery_id FROM import_item WHERE status='processing' AND (input=? OR display_input=?) ORDER BY id ASC LIMIT 1",
            ).get(sourceUrl, sourceUrl);
            if (processing) {
              itemId = processing.id;
              batchId = processing.batch_id;
              deduplicated = true;
              // A4.3-B：复用同 item 时若带 deliveryId 且该 item 未绑定 → 事务内绑定（if NULL）
              if (deliveryId && !processing.delivery_id) {
                db.prepare("UPDATE import_item SET delivery_id=?, updated_at=? WHERE id=? AND delivery_id IS NULL").run(deliveryId, nowIso, processing.id);
              }
            } else {
              // ② 条件 UPDATE 原子认领 awaiting_primary_download pending（changes=1 才算成功）
              const claimed = db.prepare(
                "UPDATE import_item SET status='processing', updated_at=? WHERE id=(SELECT id FROM import_item WHERE status='pending' AND (input=? OR display_input=?) AND error LIKE 'awaiting_primary_download%' ORDER BY id ASC LIMIT 1)",
              ).run(nowIso, sourceUrl, sourceUrl);
              if (claimed.changes === 1) {
                const row = db.prepare(
                  "SELECT id, batch_id, delivery_id FROM import_item WHERE status='processing' AND (input=? OR display_input=?) ORDER BY id ASC LIMIT 1",
                ).get(sourceUrl, sourceUrl);
                itemId = row.id;
                batchId = row.batch_id;
                // A4.3-B：认领的 pending item 若未绑定 deliveryId 且请求带 deliveryId → 事务内绑定（if NULL）
                if (deliveryId && !row.delivery_id) {
                  db.prepare("UPDATE import_item SET delivery_id=?, updated_at=? WHERE id=? AND delivery_id IS NULL").run(deliveryId, nowIso, row.id);
                }
              } else {
                // ③ 终态复用：sourceUrl 已有资产 → 幂等去重；deliveryId 已有成功 item（带 asset）→ 幂等去重。
                let terminal = null;
                const existing = db.prepare("SELECT id FROM video_asset WHERE source_url=? LIMIT 1").get(sourceUrl);
                if (existing) {
                  const b = db.prepare(
                    "SELECT id, batch_id FROM import_item WHERE (input=? OR display_input=?) AND asset_id IS NOT NULL ORDER BY id DESC LIMIT 1",
                  ).get(sourceUrl, sourceUrl);
                  terminal = { assetId: existing.id, itemId: b?.id || null, batchId: b?.batch_id || null };
                }
                if (!terminal && deliveryId) {
                  const d = db.prepare(
                    "SELECT id, batch_id, asset_id FROM import_item WHERE delivery_id=? AND asset_id IS NOT NULL AND status IN ('success','duplicate','linked') ORDER BY id DESC LIMIT 1",
                  ).get(deliveryId);
                  if (d) terminal = { assetId: d.asset_id, itemId: d.id, batchId: d.batch_id };
                }
                if (terminal) {
                  deduplicated = true;
                  dedupAssetId = terminal.assetId;
                  itemId = terminal.itemId;
                  batchId = terminal.batchId;
                } else {
                  // ④ 原子创建 batch + status='processing' 的 item（含 delivery_id 绑定）
                  batchId = `kb_kuaidian_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`;
                  db.prepare("INSERT INTO import_batch (id, status, source_kind, created_at, total, succeeded, failed, skipped) VALUES (?, 'running', 'kuaidian', ?, 1, 0, 0, 0)").run(batchId, nowIso);
                  itemId = db.prepare("INSERT INTO import_item (batch_id, input, input_kind, display_input, delivery_id, status, updated_at) VALUES (?,?,?,?,?, 'processing', ?)")
                    .run(batchId, inputForDb, "kuaidian", displayInput, deliveryId, nowIso).lastInsertRowid;
                }
              }
            }
          } else {
            // 有 deliveryId 但无行、无 sourceUrl：原子创建并绑定 delivery_id（保持 B2 语义）
            batchId = `kb_kuaidian_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`;
            db.prepare("INSERT INTO import_batch (id, status, source_kind, created_at, total, succeeded, failed, skipped) VALUES (?, 'running', 'kuaidian', ?, 1, 0, 0, 0)").run(batchId, nowIso);
            itemId = db.prepare("INSERT INTO import_item (batch_id, input, input_kind, display_input, delivery_id, status, updated_at) VALUES (?,?,?,?,?, 'processing', ?)")
              .run(batchId, inputForDb, "kuaidian", displayInput, deliveryId, nowIso).lastInsertRowid;
          }
          db.exec("COMMIT");
        } catch (claimErr) {
          try { db.exec("ROLLBACK"); } catch { /* ignore */ }
          db.close();
          throw claimErr;
        }
      }
      // 去重命中：不启动任何异步 adapter/enrich/ingest，直接 202 deduplicated（复用同 batchId）
      if (deduplicated) {
        db.close();
        recordEvent("info", "KUAIDIAN_INGEST",
          `快点回报已去重（deduplicated${dedupAssetId ? `，复用资产 ${dedupAssetId}` : "，同 source 处理中"}）：${(title || "").slice(0, 40)}`);
        sendJson(response, 202, {
          ok: true, channel: "kuaidian", batchId, itemId, deduplicated: true,
          ...(dedupAssetId ? { assetId: dedupAssetId } : {}),
        }, request);
        return;
      }
      if (!itemId) {
        batchId = `kb_kuaidian_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`;
        db.prepare("INSERT INTO import_batch (id, status, source_kind, created_at, total, succeeded, failed, skipped) VALUES (?, 'running', 'kuaidian', ?, 1, 0, 0, 0)").run(batchId, new Date().toISOString());
        itemId = db.prepare("INSERT INTO import_item (batch_id, input, input_kind, display_input, status, updated_at) VALUES (?,?,?,?, 'pending', ?)")
          .run(batchId, inputForDb, "kuaidian", displayInput, new Date().toISOString()).lastInsertRowid;
      }
      db.close();
      (async () => {
        // A4.3-D2a：worker 连接在自身 try 内打开，finally 仅当打开成功才关闭；
        // 认领事务已 COMMIT 且认领连接已关闭（上方 db.close()），此处不持有任何跨 await 事务。
        let workerDb = null;
        try {
          workerDb = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
          // 只有真实稳定分享 URL 才允许元宝补元数据；downloadUrl 不得喂给元宝
          const enrich = sourceUrl ? enrichFn : null;
          // P0-3：复用 pending 时 input 用稳定 sourceUrl（不能用 downloadUrl fingerprint 覆盖）
          const inputForIngest = sourceUrl || inputForDb;
          // A4.3-D2a：始终把复用/新建的 itemId 作为 ctx.itemId 传给 ingestOne
          const ctx = { privDir: kbPrivDir, yuanbaoEnrich: enrich, displayInput: sourceUrl || displayInput, itemId };
          const startedAt = new Date().toISOString();
          try {
            const receipt = await adapterKuaidian({ downloadUrl: isDl ? downloadUrl : null, localPath, sourceUrl, title: title || content });
            // A4.3-B：显式提供的真实平台 contentId 优先于 adapter 推导值（覆盖）；deliveryId 绝不复制进 contentId
            if (contentId) receipt.contentId = contentId;
            const r = await kbIngestOne(workerDb, { receipt, input: inputForIngest, input_kind: "kuaidian", batchId, ctx });
            recountBatch(workerDb, batchId);
            if (sourceUrl) await updateAwaitingTask(sourceUrl, r, workerDb);
            if (r?.assetId && ["success", "duplicate", "linked"].includes(String(r.status))) {
              scheduleCreativePreparation(r.assetId, receipt.title || title || content);
            }
            recordEvent(r.status === "success" ? "info" : "error", "KUAIDIAN_INGEST",
              `快点通道[${receipt.mediaValidation}]${r.status === "partial" ? "（加密流/探测失败）" : ""}${enrich ? " 元数据已补" : " 无sourceUrl(元数据unavailable)"}：${(title || "").slice(0, 40)}`);
          } catch (e) {
            const errMsg = String((e && e.message) || e).slice(0, 300);
            const failReceipt = makeFailReceipt({ channel: "kuaidian", sourceUrl, title: title || null, error: errMsg, startedAt });
            // P0-6：元宝仅补元数据（metadata_enrichment），不做媒体回退；
            // 快点失败明确 failed_primary；有未来媒体回退配置（慢点/TikHub）才登记 awaiting_fallback_media
            const mediaFallbackEnabled = config.mediaFallback?.enabled === true;
            if (mediaFallbackEnabled && sourceUrl) {
              workerDb.prepare("UPDATE import_item SET status='pending', error=?, updated_at=? WHERE id=?").run(
                "awaiting_fallback_media: 慢点/TikHub 媒体回退未接入；元宝仅补元数据不负责下载", new Date().toISOString(), itemId);
              recordReceipt(workerDb, failReceipt, { assetId: null, outcome: "failed_primary_awaiting_fallback_media" });
              recountBatch(workerDb, batchId);
              recordEvent("error", "KUAIDIAN_INGEST", `快点主通道失败，等待媒体回退：${safeMessage(errMsg)}`);
              // C：task 状态与 item 一致（awaiting_fallback_media，不是 failed）
              if (sourceUrl) await updateAwaitingTask(sourceUrl, { status: "awaiting_fallback_media", reason: "failed_primary_awaiting_fallback_media" }, workerDb);
            } else {
              workerDb.prepare("UPDATE import_item SET status='failed', error=?, updated_at=? WHERE id=?").run(
                `failed_primary: failed_no_fallback_configured: ${errMsg}`, new Date().toISOString(), itemId);
              recordReceipt(workerDb, failReceipt, { assetId: null, outcome: "failed_primary_no_fallback" });
              recountBatch(workerDb, batchId);
              recordEvent("error", "KUAIDIAN_INGEST", `快点主通道失败：${safeMessage(errMsg)}`);
              if (sourceUrl) await updateAwaitingTask(sourceUrl, { status: "failed", reason: "failed_primary" }, workerDb);
            }
          }
        } finally {
          if (workerDb) workerDb.close(); // 仅当打开成功才关闭
        }
      })().catch((e) => recordEvent("error", "KUAIDIAN", safeMessage(e.message)));
      sendJson(response, 202, { ok: true, channel: "kuaidian", batchId, itemId }, request);
      return;
    }

    // ── 快点控制台 V1：伴生桥心跳（仅安全字段；TTL 15s；绝不接收 cookie/下载 URL） ──
    if (request.method === "POST" && requestUrl.pathname === "/api/v1/kuaidian/heartbeat") {
      if (!guardJsonWrite(request, response)) return;
      const { json } = await readJsonBody(request, 8_000);
      // 白名单安全字段：version/pageKind/wechatLoggedIn/originalKuaidianDetected/pendingReportCount/lastResult
      kuaidianHeartbeat.version = String(json?.version ?? kuaidianHeartbeat.version ?? "").slice(0, 32) || null;
      kuaidianHeartbeat.pageKind = String(json?.pageKind ?? "").slice(0, 32) || null;
      kuaidianHeartbeat.wechatLoggedIn = Boolean(json?.wechatLoggedIn);
      kuaidianHeartbeat.originalKuaidianDetected = Boolean(json?.originalKuaidianDetected);
      kuaidianHeartbeat.pendingReportCount = Math.max(0, Number(json?.pendingReportCount) || 0);
      kuaidianHeartbeat.lastResult = String(json?.lastResult ?? "").slice(0, 200) || null;
      kuaidianHeartbeat.online = true;
      kuaidianHeartbeat.lastSeen = new Date().toISOString();
      sendJson(response, 202, { ok: true }, request);
      return;
    }

    // 五个诚实状态：localNode（本服务运行）/ filehelperPageConnected（网页脚本在线）/
    // wechatLoggedIn（聊天发送区存在，微信账号已登录）/ originalKuaidianDetected（伴生桥实测
    // okd/spD 或已知标记）/ companionOnline（心跳 TTL 内）+ lastSeen；页面在线绝不等于已登录。
    if (request.method === "GET" && requestUrl.pathname === "/api/v1/kuaidian/status") {
      const companionOnline = Boolean(
        kuaidianHeartbeat.online && kuaidianHeartbeat.lastSeen
        && Date.now() - new Date(kuaidianHeartbeat.lastSeen).getTime() <= KUAIDIAN_HEARTBEAT_TTL_MS,
      );
      const filehelperPageConnected = companionOnline && kuaidianHeartbeat.pageKind === "filehelper";
      const wechatLoggedIn = filehelperPageConnected && kuaidianHeartbeat.wechatLoggedIn;
      const originalKuaidianDetected = companionOnline && kuaidianHeartbeat.originalKuaidianDetected;
      sendJson(response, 200, {
        ok: true,
        states: {
          localNode: true,
          filehelperPageConnected,
          wechatLoggedIn,
          originalKuaidianDetected,
          companionOnline,
        },
        lastSeen: companionOnline ? kuaidianHeartbeat.lastSeen : null,
        companion: {
          version: kuaidianHeartbeat.version,
          pageKind: kuaidianHeartbeat.pageKind,
          pendingReportCount: kuaidianHeartbeat.pendingReportCount,
          lastResult: kuaidianHeartbeat.lastResult,
        },
      }, request);
      return;
    }

    // 任务聚合：真实 import_item/import_batch + legacy tasks 历史，去重相关条目
    if (request.method === "GET" && requestUrl.pathname === "/api/v1/kuaidian/jobs") {
      const jobs = await buildKuaidianJobs();
      sendJson(response, 200, { ok: true, jobs, counts: countKuaidianJobs(jobs) }, request);
      return;
    }

    // legacy 卡片任务没有 import_item，但仍必须可原地重试。只接受受控的
    // ing_* 任务 ID，复用原 objectId/nonceId，不接收客户端传入的媒体 URL。
    const legacyRetryMatch = requestUrl.pathname.match(/^\/api\/v1\/kuaidian\/legacy\/(ing_[A-Za-z0-9-]+)\/retry$/);
    if (request.method === "POST" && legacyRetryMatch) {
      if (!guardJsonWrite(request, response)) return;
      const taskId = legacyRetryMatch[1];
      const nowIso = new Date().toISOString();
      const task = await mutateTasks((tasks) => {
        const existing = tasks.find((item) => item.id === taskId && item.type === "ingest");
        if (!existing) return null;
        if (!["failed", "needs_attention", "needs_setup"].includes(String(existing.status || ""))) {
          return { ...existing, terminal: true };
        }
        if (!existing.cardObjectId || !existing.cardNonceId) return { ...existing, unsupported: true };
        Object.assign(existing, {
          status: "queued",
          progress: 0,
          errorCode: null,
          retryCount: Number(existing.retryCount || 0) + 1,
          updatedAt: nowIso,
        });
        return { ...existing };
      });
      if (!task) { sendJson(response, 404, { error: "not_found" }, request); return; }
      if (task.terminal) {
        sendJson(response, 409, { error: "terminal_state", reasonZh: "该任务已在处理或已完成，无需重试" }, request);
        return;
      }
      if (task.unsupported) {
        sendJson(response, 409, { error: "legacy_retry_unavailable", reasonZh: "该历史任务没有保留卡片身份，请重新转发到文件传输助手" }, request);
        return;
      }
      await recordEvent("info", "INGEST_RETRY", `手动重试文件传输助手卡片任务 ${task.id}`, task.id);
      void runIngestTask(task);
      sendJson(response, 202, { ok: true, retryMode: "legacy_retry", taskId: task.id }, request);
      return;
    }

    // 诚实重试：local_retry 走既有 import retry 端点；临时 URL/稳定分享失败 → companion_resupply
    const jobRetryMatch = requestUrl.pathname.match(/^\/api\/v1\/kuaidian\/jobs\/(\d+)\/retry$/);
    if (request.method === "POST" && jobRetryMatch) {
      if (!guardJsonWrite(request, response)) return;
      const jobId = Number(jobRetryMatch[1]);
      const { openKbDb } = await import("./kb.mjs");
      const db = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
      const item = db.prepare("SELECT * FROM import_item WHERE id=?").get(jobId);
      db.close();
      if (!item) { sendJson(response, 404, { error: "not_found" }, request); return; }
      const mode = kuaidianRetryModeFor(item);
      if (mode === "none") {
        sendJson(response, 409, { error: "terminal_state", reasonZh: "该任务已处于终态，无需重试" }, request);
        return;
      }
      if (mode === "local_retry") {
        // 复用既有 import retry 端点（POST /api/v1/kb/imports/:id/retry）
        const retryUrl = `http://${config.host}:${config.port}/api/v1/kb/imports/${jobId}/retry`;
        let upstream;
        try {
          upstream = await fetch(retryUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: "{}",
          });
        } catch {
          sendJson(response, 502, { error: "local_retry_unreachable", reasonZh: "本地重试通道不可达" }, request);
          return;
        }
        let body = {};
        try { body = await upstream.json(); } catch { /* ignore */ }
        sendJson(response, upstream.status, { ...body, retryMode: "local_retry" }, request);
        return;
      }
      // companion_resupply：网页、微信登录、伴生桥与原版快点全部在线才排队命令
      const companionOnline = Boolean(
        kuaidianHeartbeat.online && kuaidianHeartbeat.lastSeen
        && Date.now() - new Date(kuaidianHeartbeat.lastSeen).getTime() <= KUAIDIAN_HEARTBEAT_TTL_MS,
      );
      if (!companionOnline || !kuaidianHeartbeat.wechatLoggedIn || !kuaidianHeartbeat.originalKuaidianDetected) {
        sendJson(response, 409, {
          error: "resupply_offline",
          reasonZh: "无法重供：文件传输助手网页、微信登录、伴生桥或原版快点未就绪，请先打开网页版并扫码登录",
        }, request);
        return;
      }
      // 重供依赖 deliveryId 让伴生桥按 okd 消息找回；缺失 → 诚实拒绝并给中文原因，绝不排队成幽灵命令
      if (!item.delivery_id) {
        sendJson(response, 409, {
          error: "resupply_unavailable",
          reasonZh: "无法重供：该任务缺少投递标识（deliveryId），伴生桥无法按消息找回，请重新转发后重试",
        }, request);
        return;
      }
      const command = await appendKuaidianCommand({
        itemId: jobId,
        deliveryId: item.delivery_id || null,
      });
      sendJson(response, 202, {
        ok: true, retryMode: "companion_resupply", queued: true,
        commandId: command.id,
        reasonZh: "已排队：等待伴生桥用原版快点重新解析并重报",
      }, request);
      return;
    }

    // 伴生桥轮询重供命令（只含 id/itemId/deliveryId，无敏感媒体材料）
    if (request.method === "GET" && requestUrl.pathname === "/api/v1/kuaidian/commands") {
      const commands = await readKuaidianCommands();
      sendJson(response, 200, {
        ok: true,
        commands: commands.filter((c) => c.status === "queued").map((c) => ({
          id: c.id, itemId: c.itemId, deliveryId: c.deliveryId || null, createdAt: c.createdAt,
        })),
      }, request);
      return;
    }

    // 伴生桥 ack 重供结果：仅记录诚实结果，绝不伪造成功
    const commandAckMatch = requestUrl.pathname.match(/^\/api\/v1\/kuaidian\/commands\/([A-Za-z0-9_-]+)\/ack$/);
    if (request.method === "POST" && commandAckMatch) {
      if (!guardJsonWrite(request, response)) return;
      const { json } = await readJsonBody(request, 4_000);
      const outcome = ["success", "failed", "not_found"].includes(String(json?.outcome)) ? String(json.outcome) : "failed";
      const reasonZh = String(json?.reasonZh ?? "").slice(0, 300) || null;
      const updated = await updateKuaidianCommand(commandAckMatch[1], {
        status: outcome === "success" ? "done" : outcome === "not_found" ? "not_found" : "failed",
        outcome,
        reasonZh,
        ackedAt: new Date().toISOString(),
      });
      if (!updated) { sendJson(response, 404, { error: "not_found" }, request); return; }
      sendJson(response, 200, { ok: true }, request);
      return;
    }

    // 打开/恢复文件传输助手网页版：显式 Microsoft Edge（不用默认浏览器）
    if (request.method === "POST" && requestUrl.pathname === "/api/v1/kuaidian/open-filehelper") {
      if (!guardJsonWrite(request, response)) return;
      const opened = await openFilehelperWithEdge();
      sendJson(response, opened ? 200 : 502, {
        ok: Boolean(opened),
        ...(opened ? {} : { error: "edge_unavailable", reasonZh: "未找到 Microsoft Edge，请手动打开文件传输助手网页版" }),
      }, request);
      return;
    }

    // 发布中心：本机私有 runtime 中的可选 MatrixMedia CLI（不启动独立 GUI）
    if (request.method === "GET" && requestUrl.pathname === "/api/v1/publisher/status") {
      const binaryExists = await fileExists(matrix.MATRIX_BINARY);
      sendJson(response, 200, {
        ok: true,
        enabled: Boolean(config.adapters?.publisher?.enabled),
        binaryExists,
        guiOnline: binaryExists,
        embedded: true,
      }, request);
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/v1/publisher/accounts") {
      try {
        const [raw, xiaohongshuAccounts, wechatOfficialAccounts] = await Promise.all([
          matrix.cliAccounts(),
          xhsPublisher.listAccounts().catch(() => []),
          Promise.resolve().then(() => wechatOfficial.listAccounts()).catch(() => []),
        ]);
        sendJson(response, 200, {
          ok: true,
          accounts: matrix.normalizeAccounts(raw),
          xiaohongshu: { accounts: xiaohongshuAccounts },
          wechatOfficial: { accounts: wechatOfficialAccounts },
        }, request);
      } catch (e) {
        throw httpError(502, "matrixmedia_cli_accounts_unavailable：" + safeMessage(e.message));
      }
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/v1/publisher/schedules") {
      const scheduler = await ensurePublisherSchedulerReady();
      sendJson(response, 200, { ok: true, tasks: (await scheduler.list()).map(publicPublisherSchedule) }, request);
      return;
    }
    const publisherScheduleMatch = requestUrl.pathname.match(/^\/api\/v1\/publisher\/schedules\/([^/]+)$/);
    if (request.method === "GET" && publisherScheduleMatch) {
      const scheduler = await ensurePublisherSchedulerReady();
      const task = await scheduler.get(decodeURIComponent(publisherScheduleMatch[1]));
      if (!task) throw httpError(404, "publish_task_not_found");
      sendJson(response, 200, { ok: true, task: publicPublisherSchedule(task) }, request);
      return;
    }
    const publisherScheduleAction = requestUrl.pathname.match(/^\/api\/v1\/publisher\/schedules\/([^/]+)\/(cancel|retry)$/);
    if (request.method === "POST" && publisherScheduleAction) {
      if (!guardJsonWrite(request, response)) return;
      requireConfirmedAction(request);
      const { json } = await readJsonBody(request, 4_000);
      const scheduler = await ensurePublisherSchedulerReady();
      const taskId = decodeURIComponent(publisherScheduleAction[1]);
      if (!(await scheduler.get(taskId))) throw httpError(404, "publish_task_not_found");
      try {
        const task = publisherScheduleAction[2] === "cancel"
          ? await scheduler.cancel(taskId)
          : await scheduler.retry(taskId, { expiresAt: json?.expiresAt || null });
        sendJson(response, 200, { ok: true, task: publicPublisherSchedule(task) }, request);
      } catch (error) {
        if (error instanceof PublishSchedulerConflictError) throw httpError(409, error.code);
        throw error;
      }
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/v1/publisher/history") {
      // 本地回执是织台的权威账本；MatrixMedia 原 history 为空或暂时不可读时也必须返回。
      const scheduler = await ensurePublisherSchedulerReady();
      const schedulerTasks = await scheduler.list();
      const persistedHistory = await publisherReceiptStore.list();
      let upstreamHistory = [];
      let upstreamError = null;
      try {
        const rawUpstreamHistory = await matrix.cliHistory();
        upstreamHistory = rawUpstreamHistory.map((row) => {
          const normalized = normalizeMatrixHistoryRecord(row);
          const { rawAccount, ...safe } = normalized;
          if (!rawAccount) return safe;
          try { return { ...safe, account: matrix.publishAccountFingerprint(safe.platform, rawAccount) }; }
          catch { return safe; }
        });
      }
      catch (error) { upstreamError = safeMessage(error?.message || error); }
      const localHistory = persistedHistory.map((receipt) => ({
        ...receipt,
        title: receipt.content?.title || "",
        status: receipt.state,
        time: receipt.updatedAt || receipt.createdAt,
        created_at: receipt.createdAt,
        source: "zhitai_receipt",
        ...(receipt.state === "scheduled" ? { schedulerState: "scheduler_inactive" } : {}),
      }));
      const normalizedUpstream = upstreamHistory.map((row) => row.state === "scheduled"
        // 新调度器到点只执行“立即发布”，因此所有 Matrix scheduled 行都是旧引擎遗留，绝不自动认领。
        ? { ...row, schedulerState: "scheduler_inactive" }
        : row);
      const scheduleHistory = schedulerTasks.map((task) => ({
        ...publicPublisherSchedule(task),
        source: "zhitai_scheduler",
        state: task.status,
        time: task.updatedAt || task.createdAt,
        created_at: task.createdAt,
      }));
      sendJson(response, 200, {
        ok: true,
        history: [...scheduleHistory, ...localHistory, ...normalizedUpstream],
        scheduleHistory,
        localHistory,
        upstreamHistory: normalizedUpstream,
        matrixScheduler: {
          state: [...localHistory, ...normalizedUpstream].some((row) => row?.schedulerState === "scheduler_inactive")
            ? "scheduler_inactive"
            : "no_unowned_schedule",
          message: "旧 Matrix 排期不会自动执行；只有织台本地持久排期由常驻调度器负责。",
        },
        localScheduler: { state: "active", taskCount: schedulerTasks.length },
        ...(upstreamError ? { upstreamError } : {}),
      }, request);
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/v1/publisher/platforms") {
      sendJson(response, 200, { ok: true, platforms: matrix.PLATFORMS }, request);
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/v1/publisher/creative-statements") {
      sendJson(response, 200, { ok: true, batchOptions: matrix.CREATIVE_STATEMENTS }, request);
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/v1/publisher/image-text/status") {
      const [xiaohongshuAccounts, wechatOfficialAccounts] = await Promise.all([
        xhsPublisher.listAccounts({ includeStatus: true }),
        Promise.all(wechatOfficial.listAccounts().map((account) =>
          wechatOfficial.verifyStatus({
            accountId: account.accountId,
            fetchImpl: (url, options = {}) => fetch(url, {
              ...options,
              signal: AbortSignal.timeout(12_000),
            }),
          }))),
      ]);
      const xhs = xiaohongshuAccounts.find((account) => account.isDefault)
        || xiaohongshuAccounts[0]
        || await xhsPublisher.status();
      const mp = wechatOfficialAccounts.find((account) => account.isDefault)
        || wechatOfficialAccounts[0]
        || wechatOfficial.status();
      sendJson(response, 200, {
        ok: true,
        xiaohongshu: { ...xhs, accounts: xiaohongshuAccounts },
        wechatOfficial: { ...mp, accounts: wechatOfficialAccounts },
      }, request);
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/v1/publisher/xhs/accounts") {
      if (!guardJsonWrite(request, response)) return;
      const { json } = await readJsonBody(request);
      try {
        const account = await xhsPublisher.createAccount({ label: json?.label });
        await recordEvent("info", "XHS_ACCOUNT", `已创建独立小红书账号槽位：${safeMessage(account.label)}`);
        sendJson(response, 201, { ok: true, accountId: account.accountId, account }, request);
      } catch (error) {
        throw httpError(400, safeMessage(error?.message || "小红书账号创建失败"));
      }
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/v1/publisher/wechat-official/accounts/default") {
      if (!guardJsonWrite(request, response)) return;
      requireConfirmedAction(request);
      const { json } = await readJsonBody(request);
      try {
        const account = wechatOfficial.setDefaultAccount(json?.accountId);
        try {
          const official = await wechatOfficial.verifyStatus({
            accountId: account.accountId,
            fetchImpl: (url, options = {}) => fetch(url, {
              ...options,
              signal: AbortSignal.timeout(12_000),
            }),
          });
          const checkedAt = new Date().toISOString();
          await mutateRuntimeConditionsState((state) => {
            state.platform ??= {};
            state.platform.checkedAt = checkedAt;
            state.platform.wechatOfficial = {
              configured: official?.configured === true,
              credentialReady: official?.credentialReady === true,
              draftReady: official?.draftReady === true,
              ready: official?.ready === true,
              needsAttention: official?.needsAttention === true,
              reason: safeMessage(official?.reason || (official?.ready ? "接口有效" : "需配置")),
            };
          });
        } catch {
          // 默认路由已经原子持久化；运行面板刷新失败不应把成功切换误报成失败。
        }
        runtimeConditionsCache = { at: 0, snapshot: null };
        await recordEvent("info", "WECHAT_OFFICIAL_ACCOUNT", `微信公众号默认草稿账号已切换：${safeMessage(account.label)}`).catch(() => {});
        sendJson(response, 200, {
          ok: true,
          accountId: account.accountId,
          account,
          wechatOfficial: account,
        }, request);
      } catch (error) {
        throw httpError(400, safeMessage(error?.message || "公众号默认账号设置失败"));
      }
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/v1/publisher/wechat-official/accounts/credentials") {
      if (!guardJsonWrite(request, response)) return;
      const { json } = await readJsonBody(request);
      try {
        const payload = {
          label: json?.label,
          appId: json?.appId,
          appSecret: json?.appSecret,
        };
        const hasExplicitAccountId = Object.prototype.hasOwnProperty.call(json || {}, "accountId");
        const account = hasExplicitAccountId
          ? wechatOfficial.updateAccount(json.accountId, payload)
          : wechatOfficial.createAccount(payload);
        await recordEvent("info", "WECHAT_OFFICIAL_ACCOUNT", `微信公众号账号凭据已安全保存：${safeMessage(account.label)}`);
        sendJson(response, 200, {
          ok: true,
          accountId: account.accountId,
          account,
          wechatOfficial: account,
        }, request);
      } catch (error) {
        throw httpError(400, safeMessage(error?.message || "公众号凭证保存失败"));
      }
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/v1/publisher/wechat-official/credentials") {
      if (!guardJsonWrite(request, response)) return;
      const { json } = await readJsonBody(request);
      try {
        const state = wechatOfficial.saveCredentials({
          accountId: wechatOfficial.DEFAULT_WECHAT_OFFICIAL_ACCOUNT_ID,
          appId: json?.appId,
          appSecret: json?.appSecret,
        });
        await recordEvent("info", "WECHAT_OFFICIAL_CONFIG", "微信公众号接口凭证已保存到 macOS 钥匙串");
        sendJson(response, 200, { ok: true, wechatOfficial: state }, request);
      } catch (error) {
        throw httpError(400, safeMessage(error?.message || "公众号凭证保存失败"));
      }
      return;
    }
    if (request.method === "GET" && requestUrl.pathname === "/api/v1/publisher/wechat-official/drafts") {
      if (!guardAllowedOrigin(request, response)) return;
      const accountId = requestUrl.searchParams.get("accountId");
      const includeContent = requestUrl.searchParams.get("includeContent") === "1";
      const drafts = await wechatOfficial.listDrafts({
        accountId,
        offset: requestUrl.searchParams.get("offset") || 0,
        count: requestUrl.searchParams.get("count") || 20,
        includeContent,
        fetchImpl: (url, options = {}) => fetch(url, {
          ...options,
          signal: AbortSignal.timeout(20_000),
        }),
      });
      sendJson(response, 200, { ok: true, drafts }, request);
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/v1/publisher/wechat-official/publish-draft") {
      if (!guardJsonWrite(request, response)) return;
      requireConfirmedAction(request);
      const { json } = await readJsonBody(request, 4_000);
      const verified = await wechatOfficial.verifyStatus({
        accountId: json?.accountId,
        fetchImpl: (url, options = {}) => fetch(url, {
          ...options,
          signal: AbortSignal.timeout(12_000),
        }),
      });
      if (verified.draftReady !== true) throw httpError(409, verified.reason || "公众号草稿接口未就绪");
      if (verified.publishReady === false) throw httpError(409, "公众号明确账号正式发布权限不可用");
      const result = await wechatOfficial.submitDraft({
        accountId: json?.accountId,
        mediaId: json?.mediaId,
        fetchImpl: (url, options = {}) => fetch(url, {
          ...options,
          signal: AbortSignal.timeout(60_000),
        }),
      });
      await recordEvent("info", "PUBLISH", "微信公众号已有草稿正式发布提交成功");
      sendJson(response, 200, {
        ok: true,
        result: {
          status: result.status,
          publishId: result.publishId,
        },
      }, request);
      return;
    }
    if (["GET", "POST"].includes(request.method) && requestUrl.pathname === "/api/v1/publisher/xhs/login-qrcode") {
      // 二维码没有请求体。GET 是当前页面使用的语义；保留 POST 兼容旧版织台，
      // 但不再强迫空请求携带 application/json（旧桌面桥因此会误报 HTTP 415）。
      if (!guardAllowedOrigin(request, response)) return;
      const accountId = requestUrl.searchParams.has("accountId")
        ? requestUrl.searchParams.get("accountId")
        : undefined;
      sendJson(response, 200, { ok: true, login: await xhsPublisher.loginQrcode(accountId) }, request);
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/v1/publish/image-text") {
      requireConfirmedAction(request);
      const { json } = await readJsonBody(request);
      const scheduledAt = requestedPublishTime(json);
      if (scheduledAt && Date.parse(scheduledAt) > Date.now() + 1_000) {
        const task = await scheduleImageTextPublish(json, scheduledAt);
        const projected = publicPublisherSchedule(task);
        sendJson(response, 202, {
          ok: true,
          scheduled: true,
          task: projected,
          results: projected.targets.map((target) => ({ destination: target.destination, success: true, status: "scheduled" })),
        }, request);
        return;
      }
      const results = await executeImageTextPublish(json);
      const success = results.every((row) => row.success);
      await recordEvent(success ? "info" : "warning", "PUBLISH", "图文发布处理：" + results.map((row) => row.destination + "=" + row.status).join("，"));
      sendJson(response, success ? 200 : 207, { ok: success, results }, request);
      return;
    }
    if (request.method === "POST" && requestUrl.pathname === "/api/v1/publisher/login") {
      const { json } = await readJsonBody(request);
      try {
        const login = await matrix.startCliLogin({ platform: String(json?.platform || ""), phone: String(json?.phone || ""), dataDir });
        sendJson(response, 202, { ok: true, login }, request);
      } catch (error) {
        throw httpError(400, safeMessage(error?.message || "login_start_failed"));
      }
      return;
    }
    const publisherLoginMatch = requestUrl.pathname.match(/^\/api\/v1\/publisher\/login\/([^/]+)$/);
    if (request.method === "GET" && publisherLoginMatch) {
      const login = await matrix.getCliLogin(decodeURIComponent(publisherLoginMatch[1]));
      if (!login) throw httpError(404, "login_session_not_found");
      sendJson(response, 200, { ok: true, login }, request);
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/v1/publish") {
      const { json } = await readJsonBody(request);
      if (json && Array.isArray(json.destinations) && json.destinations.length) {
        // videoId + destinations → 本机私有 runtime 中的可选 MatrixMedia CLI
        requireConfirmedAction(request);
        const scheduledAt = requestedPublishTime(json);
        if (scheduledAt && Date.parse(scheduledAt) > Date.now() + 1_000) {
          const task = await scheduleMatrixVideoPublish(json, scheduledAt);
          sendJson(response, 202, {
            ok: true,
            scheduled: true,
            task: publicPublisherSchedule(task),
            results: { total: task.targets.length, detail: { status: "scheduled" } },
          }, request);
          return;
        }
        const results = await executeMatrixPublish(withoutPublishTime(json));
        sendJson(response, results.submitted === false ? 207 : 200, { ok: results.submitted !== false, results }, request);
        return;
      }
      const task = await createPublishTask(json, request);
      sendJson(response, 202, { task }, request);
      return;
    }

    // 知识库 MVP 路由（kb-routes.mjs）
    if (await handleKbRequest({ request, requestUrl, response, sendJson, readJsonBody, recordEvent })) {
      return;
    }

    sendJson(response, 404, { error: "not_found" }, request);
  } catch (error) {
    // 头已发送时（如流式响应中途异常）不得再 writeHead，直接断开避免进程崩溃
    if (response.headersSent) {
      response.destroy();
      return;
    }
    const status = Number(error?.statusCode || 500);
    const message = error instanceof Error ? error.message : "unknown_error";
    await recordEvent("error", "REQUEST", safeMessage(message));
    sendJson(response, status, {
      error: status >= 500 ? "request_failed" : message,
    }, request);
  }
});

server.listen(config.port, config.host, async () => {
  // Publish timers start only after this process has won the listening socket;
  // a second EADDRINUSE process must never race a due external submission.
  publisherSchedulerInit = publisherScheduler.init();
  // 只有成功占用监听端口的实例才启动通知轮询，避免双启动并发投递同一 outbox。
  notificationCenter.start();
  console.log(`织台本地节点已启动：http://${config.host}:${config.port}`);
  console.log(`知识库目录：${publicKnowledgeBase}`);
  await recordEvent("info", "READY", `本地节点已启动，知识库 ${publicKnowledgeBase}`);
  try {
    await publisherSchedulerInit;
    await deactivateLegacyScheduledTasks();
  } catch (error) {
    await recordEvent("error", "PUBLISH_SCHEDULER", `持久发布调度器启动失败：${safeMessage(error?.message || error)}`);
  }
  await startWatcher();
  // 给视频号解析引擎和文件传输助手页面留出恢复时间，然后自动
  // 重跑近期可恢复的签名失败任务。这使修复部署后无需用户再次转发。
  setTimeout(() => void recoverRetryableCardTasks()
    .then((count) => count && recordEvent("info", "INGEST_RECOVERY", `已自动恢复 ${count} 条视频号卡片任务`))
    .catch((error) => recordEvent("warning", "INGEST_RECOVERY", safeMessage(error?.message || error))), 8_000).unref?.();
  for (const [serviceId, service] of Object.entries(config.services)) {
    if (service?.autoStart !== true) continue;
    void startService(serviceId).catch((error) =>
      recordEvent("error", "SERVICE", `${serviceId} 自动启动失败：${safeErrorCode(error)}`));
  }
  // 旧内容库 → kb.sqlite 统一索引（幂等可回滚，不动原视频）
  migrateLibraryToKb({ kbRoot: knowledgeBase, dataDir, privDir: kbPrivDir })
    .then((r) => recordEvent("info", "KB_MIGRATE", `旧库迁移完成：索引 ${r.indexed} / 跳过 ${r.skipped} / 补帖 ${r.linked} / 失败 ${r.failed}`))
    .catch((e) => recordEvent("error", "KB_MIGRATE", safeMessage(e.message)));
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, async () => {
    publisherScheduler.stop();
    if (downloadWatchdogTimer) clearInterval(downloadWatchdogTimer);
    if (credentialReminderTimer) clearInterval(credentialReminderTimer);
    if (runtimeConditionsTimer) clearInterval(runtimeConditionsTimer);
    await notificationCenter?.stop();
    for (const child of managedProcesses.values()) child.kill("SIGTERM");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3_000).unref();
  });
}

async function loadConfig() {
  let raw;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    raw = await readFile(exampleConfigPath, "utf8");
    console.warn("未找到 config.local.json，当前使用安全的未配置模式。");
  }
  const parsed = JSON.parse(raw);
  const webhookKeychainService = parsed.webhookKeychainService || DEFAULT_KEYCHAIN_SERVICE;
  const environmentSecret = process.env.ZHITAI_WEBHOOK_SECRET || "";
  const configuredSecret = parsed.webhookSecret || "";
  const configuredSecretFile = process.env.ZHITAI_WEBHOOK_SECRET_FILE || parsed.webhookSecretFile || join(dirname(configPath), "inbox-secret");
  const webhookSecretFile = isAbsolute(configuredSecretFile)
    ? configuredSecretFile
    : resolve(dirname(configPath), configuredSecretFile);
  let fileSecret = "";
  if (!environmentSecret && !configuredSecret) {
    try {
      const candidate = (await readFile(webhookSecretFile, "utf8")).trim();
      if (candidate.length >= 32 && candidate.length <= 256) fileSecret = candidate;
    } catch {
      // The installer creates the protected secret file on macOS.
    }
  }
  const keychainSecret = environmentSecret || configuredSecret || fileSecret ? "" : readKeychainSecret(webhookKeychainService);
  return {
    host: parsed.host ?? process.env.ZHITAI_HOST ?? "127.0.0.1",
    port: Number(process.env.ZHITAI_PORT ?? parsed.port ?? 17890),
    dataDir: parsed.dataDir,
    knowledgeBase: parsed.knowledgeBase ?? "~/KnowledgeHub/内容库",
    allowedOrigins: Array.isArray(parsed.allowedOrigins) ? parsed.allowedOrigins : ["http://localhost:3000"],
    webhookSecret: environmentSecret || configuredSecret || fileSecret || keychainSecret,
    webhookSecretFile,
    webhookKeychainService,
    webhookSecretSource: environmentSecret ? "environment" : configuredSecret ? "config" : fileSecret ? "protected_file" : keychainSecret ? "keychain" : "disabled",
    adapters: parsed.adapters ?? {},
    services: parsed.services ?? {},
    polling: {
      intervalMs: Math.max(250, Number(parsed.polling?.intervalMs ?? 1_000)),
      timeoutMs: Math.max(5_000, Number(parsed.polling?.timeoutMs ?? 30 * 60_000)),
    },
    // 显式返回 watcher / analysis / 媒体回退配置（此前缺失导致 config.watcher 等永远 undefined）
    watcher: {
      intervalMs: Math.max(5_000, Number(parsed.watcher?.intervalMs ?? 20_000)),
      maxRetries: Math.max(1, Number(parsed.watcher?.maxRetries ?? 8)),
      // roots 缺失时才使用兼容默认；显式 [] 表示禁用目录监听，适合公开安全配置。
      roots: Array.isArray(parsed.watcher?.roots) ? parsed.watcher.roots : null,
    },
    analysis: {
      yuanbaoChat: parsed.analysis?.yuanbaoChat !== false,
    },
    kuaidianFallback: {
      enabled: parsed.kuaidianFallback?.enabled === true,
    },
    mediaFallback: {
      // 未来媒体回退（慢点/TikHub 等）：仅记录配置，本轮不作为可用下载通道（元宝仅补元数据）
      enabled: parsed.mediaFallback?.enabled === true,
      providers: Array.isArray(parsed.mediaFallback?.providers) ? parsed.mediaFallback.providers : [],
    },
  };
}

function assertLoopback(host) {
  if (!["127.0.0.1", "::1", "localhost"].includes(host)) {
    throw new Error("本地节点只允许绑定回环地址");
  }
}

function assertLoopbackUrl(value) {
  const parsed = new URL(value);
  if (!["127.0.0.1", "::1", "localhost"].includes(parsed.hostname.replace(/^\[|\]$/g, ""))) {
    throw new Error("upstream_must_use_loopback");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("unsupported_upstream_protocol");
  return parsed;
}

function expandHome(value) {
  if (typeof value !== "string") return value;
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return resolve(value);
}

function corsHeaders(request) {
  const origin = request.headers.origin;
  const headers = {
    "Access-Control-Allow-Headers": "Content-Type, X-Zhitai-Action, X-Zhitai-Signature, X-Zhitai-Timestamp, X-Zhitai-Nonce",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
    "Access-Control-Allow-Private-Network": "true",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff",
  };
  if (origin && config.allowedOrigins.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers.Vary = "Origin";
  }
  return headers;
}

/** 写接口统一守卫：有 Origin 必须白名单；要求 application/json；无 Origin（本机 CLI/GM）放行 */
function guardAllowedOrigin(request, response) {
  const origin = request.headers.origin;
  if (origin && !config.allowedOrigins.includes(origin)) {
    sendJson(response, 403, { error: "origin_not_allowed" }, request);
    return false;
  }
  return true;
}

function guardJsonWrite(request, response) {
  if (!guardAllowedOrigin(request, response)) return false;
  // 兼容旧桌面代理曾产生的重复 JSON Content-Type；只允许每一项都为
  // application/json，混入 text/plain 等其它类型仍然拒绝。
  const contentTypes = String(request.headers["content-type"] || "")
    .split(",")
    .map((value) => value.split(";")[0].trim().toLowerCase())
    .filter(Boolean);
  if (!contentTypes.length || !contentTypes.every((value) => value === "application/json")) {
    sendJson(response, 415, { error: "content_type_must_be_json" }, request);
    return false;
  }
  return true;
}

function sendJson(response, status, data, request) {
  response.writeHead(status, corsHeaders(request));
  response.end(JSON.stringify(data));
}

async function readJsonBody(request, maxBytes = 1_000_000) {
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > maxBytes) throw httpError(413, "request_body_too_large");
    chunks.push(buffer);
  }
  const raw = Buffer.concat(chunks, totalBytes).toString("utf8");
  if (!raw) return { raw: "", json: {} };
  try {
    return { raw, json: JSON.parse(raw) };
  } catch {
    throw httpError(400, "invalid_json");
  }
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function requireConfirmedAction(request) {
  // 服务启停属于高权限操作，必须来自已登记的前端（合规 Origin）。
  // 无 Origin 或 Origin 不在白名单的本地进程，即便携带 X-Zhitai-Action: confirm
  // 也会被拒绝，防止本机其它进程越权控制服务。
  const origin = request.headers.origin;
  if (!origin || !config.allowedOrigins.includes(origin)) {
    throw httpError(403, "origin_not_allowed");
  }
  if (request.headers["x-zhitai-action"] !== "confirm") throw httpError(409, "confirmation_required");
}

async function guardInbox(request, raw) {
  // 配置共享密钥后，所有收件/遥控入口都必须验签；不能通过省略签名头
  // 降级到 Origin 信任。只有明确未配置密钥时，才允许精确白名单 Origin，
  // 或无 Origin 且真实 socket 来自回环地址的零配置本机桥。
  const authentication = decideInboxAuthentication({
    hasSecret: Boolean(config.webhookSecret),
    allowedOrigins: config.allowedOrigins,
    origin: request.headers.origin,
    remoteAddress: request.socket?.remoteAddress,
  });
  if (authentication === "deny") throw httpError(403, "origin_not_allowed");
  if (authentication === "signature") {
    await verifyWebhook(request, raw);
  }
}

async function verifyWebhook(request, raw) {
  const signature = String(request.headers["x-zhitai-signature"] || "");
  const timestamp = String(request.headers["x-zhitai-timestamp"] || "");
  const nonce = String(request.headers["x-zhitai-nonce"] || "");
  if (!/^\d{10,13}$/.test(timestamp) || !/^[a-zA-Z0-9_-]{16,128}$/.test(nonce)) {
    throw httpError(401, "invalid_webhook_headers");
  }
  const timestampMs = timestamp.length === 10 ? Number(timestamp) * 1_000 : Number(timestamp);
  if (Math.abs(Date.now() - timestampMs) > 300_000) throw httpError(401, "webhook_timestamp_expired");
  const expected = `v1=${createHmac("sha256", config.webhookSecret).update(`${timestamp}.${nonce}.${raw}`).digest("hex")}`;
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !timingSafeEqual(left, right)) throw httpError(401, "invalid_signature");
  await claimWebhookNonce(nonce);
}

async function claimWebhookNonce(nonce) {
  const claim = webhookNonceMutation.then(async () => {
    const now = Date.now();
    let nonces = [];
    try {
      const parsed = JSON.parse(await readFile(webhookNoncesPath, "utf8"));
      if (Array.isArray(parsed)) nonces = parsed.filter((item) => Number(item.expiresAt) > now);
    } catch {
      // The nonce ledger is created on first signed request.
    }
    if (nonces.some((item) => item.nonce === nonce)) throw httpError(409, "webhook_replay_detected");
    nonces.push({ nonce, expiresAt: now + 600_000 });
    await writeJsonAtomic(webhookNoncesPath, nonces.slice(-2_000));
  });
  webhookNonceMutation = claim.catch(() => {});
  return claim;
}

function extractSupportedUrl(value) {
  if (typeof value !== "string") return null;
  const match = value.match(/https?:\/\/[^\s<>"']+/i);
  if (!match) return null;
  const cleaned = match[0].replace(/[，。；、）》】\])}]+$/u, "");
  try {
    const parsed = new URL(cleaned);
    if (!["https:", "http:"].includes(parsed.protocol)) return null;
    return allowedHosts.has(parsed.hostname.toLowerCase()) ? parsed.toString() : null;
  } catch {
    return null;
  }
}

function sanitizeUserNote(value) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1_000);
}

function noteAfterUrl(text, url) {
  if (typeof text !== "string" || !url) return "";
  return sanitizeUserNote(text.replace(url, ""));
}

const DOWNLOAD_FAILURE_ZH = {
  channels_card_object_missing: "视频号页面暂时没有返回这条卡片对象，自动重试后仍未取得",
  channels_card_profile_jsapi_jsonparse_failed: "微信视频号页面没有正确返回这条卡片数据（JSAPI 解析异常）",
  channels_card_profile_: "微信视频号页面没有正确返回这条卡片数据",
  channels_card_wechat_page_not_connected: "视频号解析页尚未连接，请在织台下载页恢复微信入口",
  channels_card_engine_offline: "视频号卡片解析引擎暂时离线",
  channels_card_media_missing: "卡片已识别，但没有取得可下载的视频媒体",
  channels_card_media_url_missing: "卡片已识别，但媒体地址缺失",
  yuanbao_cookie_missing: "元宝登录已过期或尚未登录",
  kb_index_failed: "视频已下载，但知识库索引尚未更新",
  upstream_task_timeout: "上游下载超过等待时间",
  failed_primary: "主下载通道失败",
};

function downloadFailureZh(value) {
  const code = String(value || "下载失败");
  for (const [key, message] of Object.entries(DOWNLOAD_FAILURE_ZH)) {
    if (code.includes(key)) return message;
  }
  if (/^[a-z0-9_.:-]+$/i.test(code)) return `下载引擎返回错误（${code.slice(0, 80)}）`;
  return sanitizeFailureText(code).slice(0, 120) || "下载失败，原因未返回";
}

async function attachTaskNote(task, noteValue) {
  const note = sanitizeUserNote(noteValue);
  if (!task?.id || !note) return task;
  await updateTask(task.id, { userNote: note });
  const packagePath = typeof task.packagePath === "string" ? task.packagePath : null;
  if (packagePath && pathIsInside(packagePath, knowledgeBase)) {
    const metadataPath = join(packagePath, "metadata.json");
    try {
      const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
      metadata.source = { ...(metadata.source || {}), userNote: note };
      await writeJsonAtomic(metadataPath, metadata);
    } catch { /* 任务尚未完成时由 buildPackageMetadata 合并 */ }
    const db = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
    try {
      const asset = db.prepare("SELECT id FROM video_asset WHERE package_path=? OR legacy_id=? LIMIT 1").get(packagePath, task.id);
      if (asset?.id) {
        const exists = db.prepare("SELECT 1 c FROM ingest_observation WHERE asset_id=? AND kind='user_note' AND message=? LIMIT 1").get(asset.id, note);
        if (!exists) db.prepare("INSERT INTO ingest_observation (asset_id, kind, message, observed_at) VALUES (?,?,?,?)").run(asset.id, "user_note", note, new Date().toISOString());
      }
    } finally { db.close(); }
  }
  return { ...task, userNote: note };
}

function sourceDescriptor(value) {
  const hostname = new URL(value).hostname.toLowerCase();
  if (hostname.includes("douyin")) return { adapter: "douyin", platform: "抖音", kind: "video" };
  if (hostname.includes("xiaohongshu") || hostname.includes("xhslink")) {
    return { adapter: "xiaohongshu", platform: "小红书", kind: "post" };
  }
  if (hostname === "mp.weixin.qq.com") return { adapter: "wechat", platform: "公众号", kind: "article" };
  return { adapter: "wechat", platform: "视频号", kind: "video" };
}

function adapterReady(name) {
  const adapter = config.adapters?.[name];
  if (!adapter || adapter.enabled === false) return false;
  const type = adapter.type || (adapter.command ? "command" : "");
  if (type === "matrix-media") return true;
  if (type === "douyin-rest" || type === "wechat-mp-tools") {
    try {
      assertLoopbackUrl(adapter.baseUrl);
      return true;
    } catch {
      return false;
    }
  }
  return type === "command" && typeof adapter.command === "string";
}

function publicAdapterState() {
  return Object.fromEntries(["wechat", "douyin", "xiaohongshu", "publisher"].map((name) => {
    const adapter = config.adapters?.[name] || {};
    return [name, {
      configured: adapterReady(name),
      enabled: adapter.enabled !== false && Boolean(adapter.type || adapter.command),
      type: adapter.type || (adapter.command ? "command" : "unconfigured"),
      service: adapter.service || null,
    }];
  }));
}

async function createIngestTask(body, source) {
  const sourceUrlRaw = extractSupportedUrl(body.url ?? body.text ?? "");
  if (!sourceUrlRaw) throw httpError(400, "unsupported_or_missing_url");
  const descriptor = sourceDescriptor(sourceUrlRaw);
  const now = new Date().toISOString();
  const userNote = sanitizeUserNote(body?.userNote || noteAfterUrl(body?.text, sourceUrlRaw));

  // 所有链接入口统一幂等：同一 canonical URL 已经存在时复用原任务。
  // 失败任务也不因浏览器/ClawBot 重复投递而新建；重试只能通过明确的“重试”操作触发。
  const canonicalTaskUrl = isStableShareUrl(sourceUrlRaw) ? canonicalizeSourceUrl(sourceUrlRaw) : sourceUrlRaw;
  const existingTask = (await readTasks()).find((item) => item.type === "ingest" && item.sourceUrl === canonicalTaskUrl);
  if (existingTask) {
    if (userNote && userNote !== existingTask.userNote) await attachTaskNote(existingTask, userNote);
    await recordEvent("info", "INGEST", `重复链接已去重，不会再次下载：${String(existingTask.title || descriptor.platform + "内容").slice(0, 80)}`, existingTask.id);
    return { ...existingTask, ...(userNote ? { userNote } : {}), deduplicated: true };
  }

  // P0-4：视频号稳定分享链接只登记 awaiting_primary_download 队列（等待原版快点+伴生桥），
  // 不得调用 runChannelsYuanbao 直接下载（元宝仅补发布元数据，不再作为默认视频下载路径）
  if (descriptor.platform === "视频号" && isStableShareUrl(sourceUrlRaw) && source !== "openclaw_weixin_remote") {
    const canonicalSource = canonicalizeSourceUrl(sourceUrlRaw);
    // A4.2 A：查重 + 建 task/batch/item + 写 tasks.json 整体放进 mutateTasks 临界区串行化。
    // 之前先在外面 readTasks() 再 appendTask 存在竞态：真正并发相同 URL 会读到同一空列表
    // 而各建 20 个 task/batch/item。现在唯一临界区内完成「查现有 awaiting → 复用 / 新建」，
    // 并发 Promise.all 相同 URL 只产生 1 task / 1 batch / 1 item，其余返回 deduplicated。
    const { task, deduplicated } = await mutateTasks(async (tasks) => {
      const existing = tasks.find((t) => t.type === "ingest"
        && ["awaiting_primary_download", "awaiting_fallback_media"].includes(t.status)
        && t.sourceUrl === canonicalSource);
      if (existing) return { task: existing, deduplicated: true };
      const { openKbDb } = await import("./kb.mjs");
      const db = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
      const batchId = `kb_ingest_${Date.now()}_${Math.random().toString(16).slice(2, 6)}`;
      db.prepare("INSERT INTO import_batch (id, status, source_kind, created_at, total, succeeded, failed, skipped) VALUES (?, 'awaiting_primary_download', 'ingest', ?, 1, 0, 0, 0)").run(batchId, now);
      db.prepare("INSERT INTO import_item (batch_id, input, input_kind, display_input, status, error, updated_at) VALUES (?,?,?,?, 'pending', ?, ?)")
        .run(batchId, canonicalSource, "link", canonicalSource, "awaiting_primary_download: 分享链接等待原版快点产出直链；元宝仅补元数据", now);
      db.close();
      const task = {
        id: `ing_${randomUUID()}`,
        type: "ingest",
        sourceUrl: canonicalSource,
        source,
        adapter: descriptor.adapter,
        platform: descriptor.platform,
        contentKind: descriptor.kind,
        title: `${descriptor.platform}内容 · 等待快点产出`,
        status: "awaiting_primary_download",
        progress: 0,
        batchId,
        createdAt: now,
        updatedAt: now,
        ...(userNote ? { userNote } : {}),
      };
      tasks.unshift(task);
      return { task, deduplicated: false };
    });
    if (deduplicated) {
      await recordEvent("info", "INGEST", `视频号链接重复入队（deduplicated），复用任务 ${task.id}`, task.id);
      return { ...task, deduplicated: true };
    }
    await recordEvent("info", "INGEST", `视频号链接已入等待快点队列（batch ${task.batchId}），等待原版快点+伴生桥产出`, task.id);
    return task;
  }

  const task = {
    id: `ing_${randomUUID()}`,
    type: "ingest",
    sourceUrl: sourceUrlRaw,
    source,
    adapter: descriptor.adapter,
    platform: descriptor.platform,
    contentKind: descriptor.kind,
    title: `${descriptor.platform}内容 · 等待解析`,
    status: adapterReady(descriptor.adapter) ? "queued" : "needs_setup",
    progress: 0,
    createdAt: now,
    updatedAt: now,
    ...(userNote ? { userNote } : {}),
  };
  await appendTask(task);
  await recordEvent("info", "INGEST", `收到${descriptor.platform}链接，创建任务 ${task.id}`, task.id);
  if (task.status === "queued") void runIngestTask(task);
  return task;
}

async function createChannelsCardTask(body, source) {
  const objectId = String(body?.objectId || "").trim();
  const nonceId = String(body?.nonceId || body?.objectNonceId || "").trim();
  if (!/^[0-9]{6,32}$/.test(objectId)) throw httpError(400, "invalid_channels_object_id");
  if (!/^[A-Za-z0-9_-]{1,240}$/.test(nonceId)) throw httpError(400, "invalid_channels_nonce_id");
  const deliveryValidation = validateDeliveryId(body?.deliveryId);
  if (deliveryValidation.has && !deliveryValidation.valid) throw httpError(400, "invalid_delivery_id");
  const title = sanitizeTitle(String(body?.title || "视频号内容").slice(0, 200));
  const sourceUrl = `https://channels.weixin.qq.com/web/pages/feed?oid=${encodeURIComponent(objectId)}&nid=${encodeURIComponent(nonceId)}`;
  const now = new Date().toISOString();

  const { task, deduplicated, reclaimed = false } = await mutateTasks(async (tasks) => {
    const existing = tasks.find((item) => item.type === "ingest"
      && ((deliveryValidation.value && item.deliveryId === deliveryValidation.value) || item.cardObjectId === objectId));
    if (existing) {
      // 202 只表示已入队，浏览器桥随后会记住该卡片。若任务最终失败，
      // 再次投递必须能原地回收，否则会永久复用 failed 任务且无法恢复。
      const retryCount = Number(existing.retryCount || 0);
      const reclaimable = ["failed", "needs_attention", "needs_setup"].includes(String(existing.status || ""))
        && retryCount < 3;
      if (reclaimable) {
        Object.assign(existing, {
          sourceUrl,
          source,
          title: `${title} · 卡片解析排队`,
          status: "queued",
          progress: 0,
          errorCode: null,
          cardObjectId: objectId,
          cardNonceId: nonceId,
          deliveryId: deliveryValidation.value || existing.deliveryId || null,
          retryCount: retryCount + 1,
          updatedAt: now,
        });
        return { task: { ...existing }, deduplicated: false, reclaimed: true };
      }
      return { task: existing, deduplicated: true, reclaimed: false };
    }
    const created = {
      id: `ing_${randomUUID()}`,
      type: "ingest",
      sourceUrl,
      source,
      adapter: "wechat",
      platform: "视频号",
      contentKind: "video",
      title: `${title} · 卡片解析排队`,
      status: "queued",
      progress: 0,
      cardObjectId: objectId,
      cardNonceId: nonceId,
      deliveryId: deliveryValidation.value,
      createdAt: now,
      updatedAt: now,
    };
    tasks.unshift(created);
    return { task: created, deduplicated: false, reclaimed: false };
  });

  if (deduplicated) {
    await recordEvent("info", "INGEST", `视频号卡片重复投递，复用任务 ${task.id}`, task.id);
    return { ...task, deduplicated: true };
  }
  await recordEvent("info", "INGEST", reclaimed
    ? "已原地回收上次失败的视频号卡片任务并重试"
    : "收到视频号转发卡片，已进入本机解析队列", task.id);
  void runIngestTask(task);
  return reclaimed ? { ...task, retried: true } : task;
}

/**
 * 版本升级后自动恢复近期因临时 CDN 签名错误失败的 legacy 卡片。
 * 仅回收可明确重试的 HTTP 错误、最多 2 次，不会循环重试其他历史失败。
 */
async function recoverRetryableCardTasks() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60_000;
  const recovered = await mutateTasks((tasks) => {
    const selected = [];
    for (const task of tasks) {
      if (selected.length >= 5) break;
      const updated = Date.parse(String(task.updatedAt || task.createdAt || ""));
      const retryCount = Number(task.retryCount || 0);
      if (task.type !== "ingest" || task.status !== "failed" || !task.cardObjectId || !task.cardNonceId) continue;
      if (!/^download_http_(?:400|401|403|404)$/.test(String(task.errorCode || ""))) continue;
      if (!Number.isFinite(updated) || updated < cutoff || retryCount >= 2) continue;
      Object.assign(task, {
        status: "queued",
        progress: 0,
        errorCode: null,
        retryCount: retryCount + 1,
        recoveryReason: "signed_url_refresh",
        updatedAt: new Date().toISOString(),
      });
      selected.push({ ...task });
    }
    return selected;
  });
  for (const task of recovered) {
    await recordEvent("info", "INGEST_RECOVERY", `自动恢复卡片下载任务 ${task.id}`, task.id);
    void runIngestTask(task);
  }
  return recovered.length;
}

/** 重算 import_batch 计数与状态：pending>0 → awaiting_primary_download；全部终态才 done */
function recountBatch(db, batchId) {
  const total = db.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=?").get(batchId).c;
  const succeeded = db.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=? AND status IN ('success','linked')").get(batchId).c;
  const failed = db.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=? AND status IN ('failed','partial','orphaned')").get(batchId).c;
  const skipped = db.prepare("SELECT COUNT(*) c FROM import_item WHERE batch_id=? AND status='duplicate'").get(batchId).c;
  const pending = Math.max(0, total - succeeded - failed - skipped);
  const status = pending > 0 ? "awaiting_primary_download" : "done";
  db.prepare("UPDATE import_batch SET status=?, total=?, succeeded=?, failed=?, skipped=? WHERE id=?").run(status, total, succeeded, failed, skipped, batchId);
  return { total, succeeded, failed, skipped, pending, status };
}

/** /kuaidian 结果按 canonical sourceUrl 认领对应 awaiting_primary_download 任务并落终态 */
async function updateAwaitingTask(canonicalSource, result, db) {
  const tasks = await readTasks();
  // A4.2 D：同时认领 awaiting_primary_download 与 awaiting_fallback_media 的任务，
  // 保证未来慢点/TikHub 回退成功后也能把 fallback 任务完成
  const task = tasks.find((t) => t.type === "ingest"
    && ["awaiting_primary_download", "awaiting_fallback_media"].includes(t.status)
    && t.sourceUrl === canonicalSource);
  if (!task) return;
  // B：success/duplicate/linked 且已有 assetId 都视为 completed（快点幂等命中不是失败），
  // 并从已有资产补 packagePath/title
  const terminalOk = ["success", "duplicate", "linked"].includes(result.status);
  if (terminalOk && result.assetId) {
    let title = task.title;
    let packagePath = null;
    if (db) {
      const row = db.prepare("SELECT package_path, title FROM video_asset WHERE id=?").get(result.assetId);
      if (row) { title = row.title || title; packagePath = row.package_path || null; }
    }
    await updateTask(task.id, { status: "completed", progress: 100, assetId: result.assetId, packagePath, title });
    await recordEvent("info", "INGEST", `视频号任务完成（快点产出）：${title}`, task.id);
    return;
  }
  // C：主通道失败但有未来媒体回退配置 → task 也保持 awaiting_fallback_media（与 item 状态一致），
  // 仅无回退或回退最终失败才 failed
  if (result.status === "awaiting_fallback_media") {
    await updateTask(task.id, { status: "awaiting_fallback_media", progress: 0, errorCode: "failed_primary_awaiting_fallback_media" });
    await recordEvent("warn", "INGEST", `视频号任务等待媒体回退（快点主通道失败）`, task.id);
    return;
  }
  await updateTask(task.id, { status: "failed", errorCode: String(result.reason || result.status || "failed"), progress: 0 });
  await recordEvent("error", "INGEST", `视频号任务失败（快点主通道）：${String(result.reason || result.status || "failed")}`, task.id);
}

async function runIngestTask(task) {
  const adapter = config.adapters[task.adapter];
  const packageDir = packagePathFor(task);
  try {
    await mkdir(packageDir, { recursive: true });
    await writeFile(join(packageDir, "source.url"), `${task.sourceUrl}\n`, "utf8");
    await updateTask(task.id, { status: "running", progress: 5, packagePath: packageDir });
    await recordEvent("info", "RESOLVE", `${task.platform}适配器开始解析`, task.id);
    const result = await executeIngestAdapter(task, adapter, packageDir);
    await updateTask(task.id, { progress: 88 });
    const imported = await importOutputs(result.outputPaths || [], packageDir, adapter.importMode || "copy");
    for (const stale of result.cleanupPaths || []) {
      if (typeof stale === "string" && stale.startsWith(packageDir)) {
        await rm(stale, { recursive: true, force: true }).catch(() => {});
      }
    }
    if (result.analysis) {
      await writeFile(join(packageDir, "analysis.md"), result.analysis, "utf8");
    }
    const metadata = await buildPackageMetadata(task, result, imported, packageDir);
    await writeJsonAtomic(join(packageDir, "metadata.json"), metadata);

    // 按分类归档：视频号等内容在解析后已确定 category，移动到 知识库/<类别>/ 下
    let finalDir = packageDir;
    if (result.category) {
      finalDir = packagePathFor(task, result.category);
      if (finalDir !== packageDir) {
        await mkdir(dirname(finalDir), { recursive: true });
        await rename(packageDir, finalDir);
        metadata.packagePath = finalDir;
        metadata.category = result.category;
        await writeJsonAtomic(join(finalDir, "metadata.json"), metadata);
      }
    }

    await updateTask(task.id, {
      status: "running",
      progress: 95,
      title: metadata.title,
      sizeBytes: metadata.sizeBytes,
      packagePath: finalDir,
      files: metadata.files,
    });
    await recordEvent("info", "ARCHIVE", `内容包已归档[${result.category || "未分类"}]：${metadata.title}`, task.id);

    // 内容包落盘后立即补进统一知识库索引。此前这里只写 metadata.json，
    // 页面要等用户手动“刷新知识库”才看得到，容易误以为没有自动下载。
    // 迁移串行执行，并与下载结果隔离：索引失败不能把已成功下载的任务改成失败。
    try {
      libraryMigrationMutation = libraryMigrationMutation.catch(() => {}).then(() =>
        migrateLibraryToKb({ kbRoot: knowledgeBase, dataDir, privDir: kbPrivDir }));
      await libraryMigrationMutation;
      await recordEvent("info", "KB_INDEX", `已自动加入知识库：${metadata.title}`, task.id);
      const videoFile = (Array.isArray(metadata.files) ? metadata.files : []).find((file) => /\.(mp4|mov|m4v|webm|mkv)$/i.test(String(file?.path || "")));
      if (videoFile?.sha256) {
        const { openKbDb } = await import("./kb.mjs");
        const queueDb = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
        try {
          const asset = queueDb.prepare("SELECT id, title FROM video_asset WHERE sha256=? LIMIT 1").get(videoFile.sha256);
          if (asset?.id) scheduleCreativePreparation(asset.id, asset.title || metadata.title);
        } finally { queueDb.close(); }
      }
      // “已完成”现在严格表示：文件已归档且统一知识库索引已经可查询。
      // 这样 UI/自动化看到 completed 后不会再撞上迁移写锁，也不会出现“显示完成但库里没有”。
      await updateTask(task.id, { status: "completed", progress: 100, errorCode: null });
    } catch {
      await updateTask(task.id, { status: "needs_attention", progress: 95, errorCode: "kb_index_failed" });
      await recordEvent("warn", "KB_INDEX", "视频已下载，但知识库索引暂未更新；打开知识库后可手动刷新", task.id);
    }
  } catch (error) {
    const code = safeErrorCode(error);
    await updateTask(task.id, { status: "failed", errorCode: code, progress: 0 });
    await recordEvent("error", "INGEST", `视频“${String(task.title || "未命名").replace(/ · 卡片解析排队$/, "").slice(0, 80)}”下载失败：${downloadFailureZh(code)}`, task.id);
  }
}

async function executeIngestAdapter(task, adapter, packageDir) {
  const type = adapter.type || (adapter.command ? "command" : "");
  if (type === "douyin-rest") return runDouyinRest(task, adapter);
  if (type === "wechat-mp-tools") return runWechatMpTools(task, adapter, packageDir);
  if (type === "command") return runCommandAdapter(task, adapter, packageDir);
  throw new Error("unsupported_adapter_type");
}

async function runDouyinRest(task, adapter) {
  const startedAt = Date.now();
  const created = await upstreamJson(adapter.baseUrl, "/api/v1/download", {
    method: "POST",
    body: { url: task.sourceUrl },
  });
  if (!created.job_id) throw new Error("upstream_job_missing");
  const result = await pollUpstream(adapter.baseUrl, `/api/v1/jobs/${encodeURIComponent(created.job_id)}`, {
    success: ["success"],
    failed: ["failed"],
    onProgress: async (body) => {
      const total = Number(body.total || 0);
      const done = Number(body.success || 0) + Number(body.skipped || 0) + Number(body.failed || 0);
      await updateTask(task.id, { progress: total ? Math.min(82, 10 + Math.round((done / total) * 72)) : 18 });
    },
  });
  const outputPaths = adapter.outputRoot ? await filesChangedSince(expandHome(adapter.outputRoot), startedAt) : [];
  return {
    title: "抖音内容",
    outputPaths,
    upstream: { jobId: created.job_id, total: result.total, success: result.success, skipped: result.skipped },
  };
}

async function runWechatMpTools(task, adapter, packageDir) {
  if (task.platform === "视频号" && task.cardObjectId && task.cardNonceId) {
    return runChannelsCard(task, packageDir);
  }
  if (task.platform === "抖音") {
    const downloaded = await upstreamJson(adapter.baseUrl, "/api/douyin/download-single", {
      method: "POST",
      timeoutMs: Number(adapter.timeoutMs || 180_000),
      body: { url: task.sourceUrl },
    });
    const history = await upstreamJson(adapter.baseUrl, "/api/douyin/history");
    const historyItems = Array.isArray(history) ? history : [];
    const match = historyItems.find((item) => item?.title === downloaded.title) || historyItems[0];
    return {
      title: downloaded.title || downloaded.data?.title || "抖音内容",
      outputPaths: [match?.path].filter(Boolean),
      upstream: { itemId: downloaded.data?.id || null, type: downloaded.data?.type || null },
    };
  }

  if (task.platform === "公众号") {
    const created = await upstreamJson(adapter.baseUrl, "/api/articles/download-url", {
      method: "POST",
      body: { urls: [task.sourceUrl] },
    });
    const result = await pollUpstream(adapter.baseUrl, `/api/articles/download-status/${encodeURIComponent(created.task_id)}`, {
      success: ["completed"],
      failed: ["failed", "cancelled"],
      onProgress: (body) => updateTask(task.id, {
        progress: body.total ? Math.min(82, 10 + Math.round((Number(body.completed || 0) / body.total) * 72)) : 18,
      }),
    });
    const successful = (result.results || []).filter((item) => item.success);
    return {
      title: successful[0]?.title || "公众号文章",
      outputPaths: successful.map((item) => item.path).filter(Boolean),
      upstream: { taskId: created.task_id, completed: result.completed, failed: result.failed },
    };
  }

  if (task.platform === "小红书") {
    const created = await upstreamJson(adapter.baseUrl, "/api/xhs/download", {
      method: "POST",
      body: { urls: [task.sourceUrl] },
    });
    const result = await pollUpstream(adapter.baseUrl, `/api/xhs/download-status/${encodeURIComponent(created.task_id)}`, {
      success: ["completed"],
      failed: ["failed", "cancelled"],
      onProgress: (body) => updateTask(task.id, {
        progress: body.total ? Math.min(82, 10 + Math.round((Number(body.completed || 0) / body.total) * 72)) : 18,
      }),
    });
    const successful = (result.results || []).filter((item) => item.success && !item.skipped);
    return {
      title: successful[0]?.title || "小红书内容",
      outputPaths: successful.map((item) => item.path).filter(Boolean),
      upstream: { taskId: created.task_id, completed: result.completed, skipped: result.skipped },
    };
  }

  // 视频号：本地节点内置元宝解析通道，不依赖 wechat_mp_tools 图形程序常驻。
  return runChannelsYuanbao(task, packageDir);
}

/**
 * 视频号原生采集：元宝解析 → 视频号 finder-preview 取直链 → 直接下载入包。
 * 协议提取自 x554960766/wechat-mp-tools（backend/channels.py），已用 Node 重写。
 */
async function runChannelsYuanbao(task, packageDir) {
  const media = await parseChannelsVideo(task.sourceUrl);
  return downloadResolvedChannels(task, packageDir, media, "yuanbao-local");
}

/** 视频号卡片采集：objectId/nonceId → 本机微信视频号页面 → 媒体信息。 */
async function runChannelsCard(task, packageDir) {
  let media = await parseChannelsCard({
    objectId: task.cardObjectId,
    nonceId: task.cardNonceId,
  });
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await downloadResolvedChannels(task, packageDir, media, "wx-channels-card");
    } catch (error) {
      lastError = error;
      const code = String(error?.message || error || "");
      const transientDownload = /^download_http_(?:400|401|403|404)$/.test(code);
      if (!transientDownload || attempt >= 3) throw error;
      await rm(join(packageDir, "_staging"), { recursive: true, force: true }).catch(() => {});
      await updateTask(task.id, { progress: 5 + attempt * 3 });
      await recordEvent("warning", "DOWNLOAD_RETRY", `视频号卡片下载暂时失败，正在刷新签名并自动重试（${attempt}/2）`, task.id);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, attempt * 1_500));
      // 只有媒体下载已经返回瞬态 HTTP 错误时才重新解析，刷新过期的签名 URL。
      // 卡片对象或 profile 解析失败由 parseChannelsCard 自身的轮询负责，避免 3×3 重试放大。
      media = await parseChannelsCard({
        objectId: task.cardObjectId,
        nonceId: task.cardNonceId,
      });
    }
  }
  throw lastError || new Error("channels_card_download_failed");
}

async function downloadResolvedChannels(task, packageDir, media, channel) {
  await updateTask(task.id, { progress: 20, title: media.description || "视频号内容" });
  await recordEvent("info", "RESOLVE", `视频号${channel === "wx-channels-card" ? "卡片" : "链接"}解析成功：${media.author || "未知作者"}`, task.id);

  const stagingDir = join(packageDir, "_staging");
  const saved = await downloadChannelsVideo(media, stagingDir, {
    onProgress: (ratio) => {
      const progress = Math.min(82, 20 + Math.round(ratio * 62));
      void updateTask(task.id, { progress });
    },
  });

  let coverPath = null;
  if (media.coverUrl) {
    try {
      const cover = await downloadSafeImage(media.coverUrl, stagingDir);
      coverPath = cover.path;
    } catch {
      /* 封面失败不影响主流程 */
    }
  }

  const { category, analysisMarkdown } = await analyzeVideo(media, {
    yuanbaoEnabled: config.analysis?.yuanbaoChat !== false,
  }).catch(() => ({ category: "", analysisMarkdown: "" }));

  return {
    title: media.description || saved.filename || "视频号内容",
    author: media.author || "",
    outputPaths: [saved.path, coverPath].filter(Boolean),
    cleanupPaths: [stagingDir],
    category: category || "",
    analysis: analysisMarkdown || "",
    upstream: {
      channel,
      exportId: media.exportId,
      objectId: media.objectId || null,
      objectNonceId: media.objectNonceId || null,
      createtime: media.createtime,
      stats: media.stats,
      sizeBytes: saved.size,
      provenance: media.provenance || null,
    },
  };
}

async function runCommandAdapter(task, adapter, packageDir) {
  const resultFile = join(packageDir, "adapter-result.json");
  const replacements = { url: task.sourceUrl, packageDir, resultFile, knowledgeBase };
  const args = (Array.isArray(adapter.args) ? adapter.args : []).map((value) =>
    String(value).replace(/\{(url|packageDir|resultFile|knowledgeBase)\}/g, (_, key) => replacements[key]),
  );
  await spawnAndWait(adapter.command, args, {
    cwd: adapter.cwd ? expandHome(adapter.cwd) : agentRoot,
    env: safeChildEnv({ ZHITAI_KNOWLEDGE_BASE: knowledgeBase, ZHITAI_RESULT_FILE: resultFile }, adapter.env),
    timeoutMs: config.polling.timeoutMs,
  });
  try {
    const parsed = JSON.parse(await readFile(resultFile, "utf8"));
    return {
      title: typeof parsed.title === "string" ? parsed.title : `${task.platform}内容`,
      author: typeof parsed.author === "string" ? parsed.author : "",
      outputPaths: Array.isArray(parsed.outputPaths) ? parsed.outputPaths : [],
      upstream: { command: basename(adapter.command) },
    };
  } catch {
    throw new Error("adapter_result_missing");
  }
}

async function upstreamJson(baseUrl, path, options = {}) {
  const base = assertLoopbackUrl(baseUrl);
  const target = new URL(path, `${base.toString().replace(/\/$/, "")}/`);
  assertLoopbackUrl(target.toString());
  const response = await fetch(target, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(Number(options.timeoutMs || 10_000)),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`upstream_invalid_json_${response.status}`);
  }
  if (!response.ok || body?.error) throw new Error(`upstream_${response.status}_${safeErrorCode(body?.error || "error")}`);
  return body;
}

async function pollUpstream(baseUrl, path, options) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < config.polling.timeoutMs) {
    const body = await upstreamJson(baseUrl, path);
    const status = String(body.status || "").toLowerCase();
    if (options.success.includes(status)) return body;
    if (options.failed.includes(status)) throw new Error(`upstream_task_${status}`);
    if (options.onProgress) await options.onProgress(body);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, config.polling.intervalMs));
  }
  throw new Error("upstream_task_timeout");
}

async function importOutputs(paths, packageDir, mode) {
  const unique = [...new Set(paths.filter((value) => typeof value === "string" && value))].slice(0, 200);
  const imported = [];
  const assetsDir = join(packageDir, "assets");
  if (mode === "copy" && unique.length) await mkdir(assetsDir, { recursive: true });
  for (let index = 0; index < unique.length; index += 1) {
    const sourcePath = expandHome(unique[index]);
    let info;
    try {
      info = await stat(sourcePath);
    } catch {
      continue;
    }
    if (mode === "reference") {
      imported.push({ path: sourcePath, external: true, sizeBytes: info.isFile() ? info.size : await pathSize(sourcePath) });
      continue;
    }
    const safeName = `${String(index + 1).padStart(2, "0")}-${sanitizeFilename(basename(sourcePath))}`;
    const destination = join(assetsDir, safeName);
    await cp(sourcePath, destination, { recursive: info.isDirectory(), errorOnExist: false, force: false });
    if (info.isDirectory()) {
      const files = await listFiles(destination);
      for (const file of files) imported.push(await describeFile(file, packageDir));
    } else {
      imported.push(await describeFile(destination, packageDir));
    }
  }
  return imported;
}

async function buildPackageMetadata(task, result, imported, packageDir) {
  const currentTask = (await readTasks()).find((item) => item.id === task.id) || task;
  const files = imported.map((item) => ({
    path: item.external ? item.path : item.relativePath,
    external: Boolean(item.external),
    sizeBytes: item.sizeBytes,
    sha256: item.sha256 || null,
  }));
  return {
    schemaVersion: 1,
    id: task.id,
    title: sanitizeTitle(result.title || `${task.platform}内容`),
    author: sanitizeTitle(result.author || ""),
    platform: task.platform,
    contentKind: task.contentKind,
    source: { url: task.sourceUrl, receivedVia: task.source, ...(currentTask.userNote ? { userNote: sanitizeUserNote(currentTask.userNote) } : {}) },
    capturedAt: new Date().toISOString(),
    authorization: "user_asserted",
    packagePath: packageDir,
    sizeBytes: files.reduce((total, file) => total + Number(file.sizeBytes || 0), 0),
    files,
    upstream: result.upstream || {},
  };
}

function packagePathFor(task, category) {
  const date = new Date(task.createdAt);
  const datePart = [
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ];
  if (category) return join(knowledgeBase, category, ...datePart, task.id);
  return join(knowledgeBase, ...datePart, task.id);
}

async function fileExists(p) {
  try { await access(p); return true; } catch { return false; }
}

function assertPublishWorkflowReady(plan, title) {
  const workflow = plan?.seedanceWorkflow;
  if (!workflow) throw httpError(409, "publish_generation_readiness_missing");
  const readiness = assessGenerationReadiness(workflow);
  if (!readiness.ready) throw httpError(409, `publish_generation_readiness_failed：${readiness.blockers.join("；")}`);
  const recovery = remediateToOriginalWorkflow(workflow, { title });
  if (recovery.changed) {
    throw httpError(409, `publish_originality_or_rights_failed：${(recovery.reasons || []).join("、") || "需完成原创补救"}`);
  }
  return {
    readiness,
    originality: workflow.originality || null,
    workflowSha256: createHash("sha256").update(JSON.stringify(workflow)).digest("hex"),
  };
}

// 发布中心共同预检。这里只解析与验证，绝不调用任何平台。
async function prepareMatrixPublish(json, {
  skipDestinations = false,
  requireStrictGenerated = false,
  requireExpectedBinding = false,
  expectedBinding = null,
} = {}) {
  if (requireStrictGenerated && json.useLatestRemake !== true) {
    throw httpError(409, "persistent_schedule_requires_strict_generated_media");
  }
  const db = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
  let row = null;
  let generation = null;
  let plan = null;
  try {
    row = db.prepare("SELECT file_path, package_path FROM video_asset WHERE id = ?").get(String(json.videoId || ""));
    const savedPlan = db.prepare("SELECT plan_json FROM remake_plan WHERE asset_id=?").get(String(json.videoId || ""));
    if (savedPlan?.plan_json) plan = JSON.parse(savedPlan.plan_json);
    if (json.useLatestRemake === true) {
      generation = db.prepare(`SELECT id, file_name, engine, engine_task_id, size_bytes, sha256, completed_at
        FROM remake_generation WHERE asset_id=? AND status='completed' AND file_name IS NOT NULL
        ORDER BY completed_at DESC, created_at DESC LIMIT 1`).get(String(json.videoId || ""));
    }
  } finally {
    db.close();
  }
  if (!row) {
    throw httpError(400, "video_not_found_or_no_asset：" + (json.videoId || ""));
  }
  let assetPath = row.file_path;
  if (json.useLatestRemake === true) {
    if (!generation?.file_name || !row.package_path) throw httpError(409, "generated_video_not_ready：请先完成一键生成");
    if (requireStrictGenerated && generation.engine !== "ZhitaiSeedance") {
      throw httpError(409, "persistent_schedule_requires_zhitai_seedance_generation");
    }
    if (requireStrictGenerated && !String(generation.engine_task_id || "").trim()) {
      throw httpError(409, "persistent_schedule_generation_task_binding_missing");
    }
    assetPath = join(row.package_path, "remake-output", basename(generation.file_name));
  }
  if (typeof assetPath !== "string" || !assetPath || !(await fileExists(assetPath))) {
    throw httpError(400, json.useLatestRemake === true ? "generated_video_file_missing" : "video_not_found_or_no_asset：" + (json.videoId || ""));
  }
  const title = sanitizeTitle(typeof json.title === "string" ? json.title : basename(assetPath, extname(assetPath)));
  const workflowGate = assertPublishWorkflowReady(plan, title);
  const tags = Array.isArray(json.tags) ? json.tags.slice(0, 4).map(String) : [];
  const bt2 = typeof json.bt2 === "string" ? json.bt2 : null;
  const draft = json.draft !== false;
  let publishMedia;
  try { publishMedia = await probeLocalMedia(assetPath); }
  catch { throw httpError(409, "publish_media_probe_failed：无法确认成片可播放"); }
  if (publishMedia.mediaValidation !== "ok") {
    throw httpError(409, `publish_media_invalid：${publishMedia.mediaValidation || "invalid"}`);
  }
  // ffprobe returns `aac`; macOS mdls fallback commonly returns
  // `MPEG-4 AAC` or `AAC LC`. They describe the same AAC family and must not
  // make a valid, decodable track fail solely because of display spelling.
  if (!/\baac\b/i.test(String(publishMedia.codec_audio || ""))) {
    throw httpError(409, "publish_audio_track_not_aac");
  }
  let audioQualitySha256 = null;
  if (json.useLatestRemake === true && generation?.engine === "ZhitaiSeedance") {
    const assetDir = join(
      dirname(assetPath),
      `${basename(generation.file_name, extname(generation.file_name))}-assets`,
    );
    let audioQuality;
    try {
      const audioQualityRaw = await readFile(join(assetDir, "audio-quality.json"), "utf8");
      audioQuality = JSON.parse(audioQualityRaw);
      audioQualitySha256 = createHash("sha256").update(audioQualityRaw).digest("hex");
    }
    catch { throw httpError(409, "publish_audio_quality_missing"); }
    const audioGate = validateAudioQualityReport(audioQuality, {
      sizeBytes: publishMedia.size_bytes,
      sha256: publishMedia.sha256,
      expectedSizeBytes: generation.size_bytes,
      expectedSha256: generation.sha256,
      expectedJobId: generation.engine_task_id,
    });
    if (!audioGate.ok) {
      throw httpError(409, audioGate.reason === "integrity"
        ? "publish_generated_integrity_failed"
        : "publish_audio_quality_failed");
    }
  }
  if (requireStrictGenerated && !audioQualitySha256) {
    throw httpError(409, "persistent_schedule_audio_quality_binding_missing");
  }
  const publishQuality = assessMediaQuality({ ...publishMedia, media_validation: publishMedia.mediaValidation });
  if (!draft && publishQuality.state === "review" && json.allowQualityReview !== true) {
    throw httpError(409, `publish_quality_review_required：${publishQuality.reason}`);
  }

  // 每个目标必须提供 phone 或 partition
  const platforms = [];
  for (const dest of skipDestinations ? [] : json.destinations) {
    const platform = typeof dest.platform === "string" ? dest.platform : null;
    if (!platform) throw httpError(400, "destination_platform_required");
    const phone = typeof dest.phone === "string" && dest.phone.trim() ? dest.phone.trim() : null;
    const partition = typeof dest.partition === "string" && dest.partition.trim() ? dest.partition.trim() : null;
    if (!phone && !partition) throw httpError(400, "account_required_for_platform：" + platform);
    platforms.push({
      platform,
      ...(phone ? { phone } : {}),
      ...(partition ? { partition } : {}),
      ...(typeof dest.creativeStatement === "string" && dest.creativeStatement ? { creativeStatement: dest.creativeStatement } : {}),
    });
  }

  const payload = {
    file: assetPath,
    title,
    ...(tags.length ? { tags } : {}), // 内部数组；adapter 边界 join 为空格分隔串
    ...(bt2 ? { bt2 } : {}),
    draft,
    platforms,
  };

  const scheduleBinding = {
    generationEngine: String(generation?.engine || ""),
    generationTaskId: String(generation?.engine_task_id || ""),
    mediaSha256: String(publishMedia.sha256 || "").toLowerCase(),
    mediaSizeBytes: Number(publishMedia.size_bytes || 0),
    audioQualitySha256: String(audioQualitySha256 || ""),
    workflowSha256: workflowGate.workflowSha256,
  };
  if (requireExpectedBinding || expectedBinding) {
    assertPublishScheduleBinding(expectedBinding, scheduleBinding);
  }

  return {
    payload,
    content: {
      id: String(json.videoId || ""),
      title,
      mediaSha256: publishMedia.sha256,
    },
    generation,
    publishQuality,
    scheduleBinding,
  };
}

// 到点与立即发布都只走这一条“立即提交”路径；排期字段不会进入 adapter。
async function executeMatrixPublish(json, preparationOptions = {}) {
  const immediate = withoutPublishTime(json);
  const prepared = await prepareMatrixPublish(immediate, preparationOptions);
  try {
    const body = await matrix.publishWithReceipts({
      payload: prepared.payload,
      receiptStore: publisherReceiptStore,
      content: prepared.content,
      jobId: String(immediate.jobId || prepared.generation?.engine_task_id || immediate.videoId || ""),
      retryFailed: immediate.retryFailed === true,
    });
    const results = Array.isArray(body?.results) ? body.results.map((r) => ({ ...r })) : [];
    await recordEvent("info", "PUBLISH", `MatrixMedia 立即发布提交：${prepared.payload.platforms.length} 平台（${immediate.videoId}${immediate.useLatestRemake === true ? "，生成成片" : "，原素材"}）`);
    return {
      submitted: body?.success !== false,
      results,
      total: typeof body?.total === "number" ? body.total : prepared.payload.platforms.length,
      detail: { status: body?.success === false ? "partial_failed" : "submitted", message: body?.message, quality: prepared.publishQuality },
    };
  } catch (e) {
    await recordEvent("warning", "PUBLISH", `MatrixMedia 发布失败：${safeMessage(e.message)}`);
    throw httpError(502, "matrixmedia_publish_failed：" + safeMessage(e.message));
  }
}

function requestedPublishTime(body = {}) {
  const value = body?.scheduledAt ?? body?.publishAt ?? null;
  if (value === null || value === undefined || value === "") return null;
  const parsed = Date.parse(String(value));
  if (Number.isNaN(parsed)) throw httpError(400, "publish_schedule_time_invalid");
  return new Date(parsed).toISOString();
}

function withoutPublishTime(value) {
  if (Array.isArray(value)) return value.map(withoutPublishTime);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["scheduledAt", "publishAt", "--publish-at", "expiresAt"].includes(key))
    .map(([key, child]) => [key, withoutPublishTime(child)]));
}

function opaquePublisherAccount(destination, accountId) {
  return `acct_${createHash("sha256").update(`${String(destination)}\0${String(accountId)}`).digest("hex").slice(0, 24)}`;
}

async function persistPublishSchedule(input) {
  const scheduler = await ensurePublisherSchedulerReady();
  return scheduler.scheduleIdempotent(input);
}

function redactPublicPublishValue(value) {
  if (Array.isArray(value)) return value.map(redactPublicPublishValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["accountId", "phone", "partition", "rawAccount"].includes(key))
    .map(([key, child]) => [key, redactPublicPublishValue(child)]));
}

function publicPublisherSchedule(task) {
  return {
    id: task.id,
    type: "publish",
    kind: task.payload?.kind || "publish",
    title: String(task.payload?.request?.title || task.payload?.task?.title || "").slice(0, 240),
    status: task.status,
    scheduledAt: task.scheduledAt,
    expiresAt: task.expiresAt,
    error: task.error || null,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    finishedAt: task.finishedAt || null,
    cancelledAt: task.cancelledAt || null,
    deduplicated: task.deduplicated === true,
    targets: (task.targets || []).map((target) => {
      const destination = target.definition?.destination || target.definition?.platform || "unknown";
      const account = target.definition?.accountFingerprint
        || (target.definition?.accountId ? opaquePublisherAccount(destination, target.definition.accountId) : null);
      return {
        id: account ? `${destination}:${account}` : String(target.id || destination).replace(/\b1\d{10}\b/g, "[account]"),
        destination,
        platform: target.definition?.platform || null,
        account,
        expectedMode: target.definition?.expectedMode || null,
        status: target.status,
        attempts: target.attempts,
        error: target.error || null,
        receipt: redactPublicPublishValue(target.receipt || null),
        externalReceiptAt: target.externalReceiptAt || null,
      };
    }),
  };
}

function matrixAccountMatchesPlatform(row, platform) {
  const value = String(row?.platform || row?.code || "").toLowerCase();
  const aliases = {
    dy: ["dy", "douyin", "抖音"],
    sph: ["sph", "channels", "视频号"],
    xhs: ["xhs", "xiaohongshu", "小红书"],
    tt: ["tt", "toutiao", "头条"],
    ks: ["ks", "kuaishou", "快手"],
    blbl: ["blbl", "bilibili", "哔哩"],
    bjh: ["bjh", "百家号"],
  };
  return (aliases[platform] || [String(platform).toLowerCase()]).some((alias) => value.includes(alias));
}

function matrixAccountUsable(row) {
  const state = `${row?.loginStatus || ""} ${row?.status || ""} ${row?.error || ""}`.toLowerCase();
  return Boolean(row?.phone || row?.partition)
    && !/未登录|offline|expired|invalid|failed|失败|过期|退出/.test(state);
}

function resolveMatrixAccountFromRows(target, rows) {
  const matches = rows.filter((row) => {
    if (!matrixAccountMatchesPlatform(row, target.platform) || !matrixAccountUsable(row)) return false;
    try {
      return matrix.publishAccountFingerprint(target.platform, row) === target.accountFingerprint;
    } catch { return false; }
  });
  if (matches.length !== 1) {
    throw httpError(409, matches.length
      ? `publisher_account_ambiguous：${target.platform}`
      : `publisher_account_unavailable：${target.platform}`);
  }
  const account = matches[0];
  return {
    platform: target.platform,
    ...(account.phone ? { phone: account.phone } : {}),
    ...(account.partition ? { partition: account.partition } : {}),
    ...(target.creativeStatement ? { creativeStatement: target.creativeStatement } : {}),
  };
}

async function resolveScheduledMatrixAccount(target) {
  return resolveMatrixAccountFromRows(target, await matrix.cliAccounts());
}

function matrixScheduleTarget(destination, expectedMode) {
  const platform = String(destination?.platform || "").trim();
  if (!platform) throw httpError(400, "destination_platform_required");
  if (!destination?.phone && !destination?.partition) throw httpError(400, `account_required_for_platform：${platform}`);
  const accountFingerprint = matrix.publishAccountFingerprint(platform, destination);
  return {
    id: `${platform}:${accountFingerprint}`,
    kind: "matrix_video",
    platform,
    accountFingerprint,
    expectedMode,
    ...(typeof destination.creativeStatement === "string" && destination.creativeStatement
      ? { creativeStatement: destination.creativeStatement }
      : {}),
  };
}

async function scheduleMatrixVideoPublish(body, scheduledAt) {
  const immediate = withoutPublishTime(body);
  const prepared = await prepareMatrixPublish(immediate, { requireStrictGenerated: true });
  const expectedMode = prepared.payload.draft ? "draft" : "public";
  const targets = prepared.payload.platforms.map((destination) => matrixScheduleTarget(destination, expectedMode));
  const accounts = await matrix.cliAccounts();
  for (const target of targets) resolveMatrixAccountFromRows(target, accounts);
  const taskId = deterministicPublishScheduleId("matrix_video", scheduledAt, {
    binding: prepared.scheduleBinding,
    title: prepared.content.title,
    expectedMode,
    targets: targets.map((target) => target.id).sort(),
  });
  const task = await persistPublishSchedule({
    id: taskId,
    scheduledAt,
    expiresAt: body?.expiresAt || null,
    payload: {
      kind: "matrix_video",
      binding: prepared.scheduleBinding,
      request: withoutPublishTime({
        ...immediate,
        binding: undefined,
        destinations: undefined,
        retryFailed: undefined,
        jobId: undefined,
      }),
    },
    targets,
  });
  await recordEvent("info", "PUBLISH", task.deduplicated
    ? `重复排期已去重：${targets.length} 个平台`
    : `织台已持久排期：${targets.length} 个平台，到点执行立即发布`, task.id);
  return task;
}

async function prepareImageTextPublish(body, {
  verifyAccounts = true,
  requireAccounts = true,
  requireExpectedBinding = false,
  expectedBinding = null,
} = {}) {
  const destinations = Array.isArray(body?.destinations) ? [...new Set(body.destinations.map(String))] : [];
  if (!destinations.length) throw httpError(400, "image_text_destinations_required");
  if (destinations.some((destination) => !["xiaohongshu", "wechat_official"].includes(destination))) {
    throw httpError(400, "image_text_destination_unsupported");
  }
  const bundle = await resolveImageTextBundle(body?.videoId);
  const accountIds = body?.accountIdByDestination && typeof body.accountIdByDestination === "object"
    ? body.accountIdByDestination
    : (body?.accountIds && typeof body.accountIds === "object" ? body.accountIds : {});
  const mode = body?.mode === "publish" ? "publish" : "draft";
  if (destinations.includes("xiaohongshu") && mode !== "publish") {
    throw httpError(409, "小红书图文没有平台草稿接口；请选择正式发布，或先保留在织台待办");
  }
  if (requireAccounts) {
    for (const destination of destinations) {
      if (!String(accountIds[destination] || "").trim()) throw httpError(400, `image_text_account_required：${destination}`);
    }
  }
  if (verifyAccounts && requireAccounts) {
    const [xhsAccounts, officialAccounts] = await Promise.all([
      destinations.includes("xiaohongshu") ? xhsPublisher.listAccounts() : [],
      Promise.resolve(destinations.includes("wechat_official") ? wechatOfficial.listAccounts() : []),
    ]);
    if (destinations.includes("xiaohongshu") && !xhsAccounts.some((account) => account.accountId === accountIds.xiaohongshu)) {
      throw httpError(409, "image_text_account_unavailable：xiaohongshu");
    }
    if (destinations.includes("wechat_official") && !officialAccounts.some((account) => account.accountId === accountIds.wechat_official)) {
      throw httpError(409, "image_text_account_unavailable：wechat_official");
    }
  }
  const title = String(body?.title || bundle.title).trim();
  const content = String(body?.content || bundle.content).trim();
  const scheduleBinding = {
    ...bundle.assetBinding,
    publishTextSha256: createHash("sha256").update(JSON.stringify({
      title,
      content,
      sourceUrl: bundle.sourceUrl,
    })).digest("hex"),
  };
  if (requireExpectedBinding || expectedBinding) {
    assertPublishScheduleBinding(expectedBinding, scheduleBinding);
  }
  return {
    bundle,
    destinations,
    accountIds,
    mode,
    title,
    content,
    tags: Array.isArray(body?.tags) ? body.tags.map(String).slice(0, 4) : [],
    scheduleBinding,
  };
}

async function executeImageTextTarget(body, destination, preparationOptions = {}) {
  const prepared = await prepareImageTextPublish(
    { ...body, destinations: [destination] },
    preparationOptions,
  );
  const accountId = prepared.accountIds[destination];
  if (destination === "xiaohongshu") {
    const status = await xhsPublisher.status(accountId);
    if (status.loggedIn !== true) throw new Error("小红书明确账号未登录");
    const result = await xhsPublisher.publishImageText({
      accountId,
      title: prepared.title,
      content: prepared.content,
      images: prepared.bundle.images,
      tags: prepared.tags,
      isOriginal: true,
    });
    return {
      destination,
      accountId: result.accountId,
      success: result?.success !== false,
      status: result?.data?.status || (result?.success === false ? "failed" : "submitted"),
    };
  }
  const verified = await wechatOfficial.verifyStatus({
    accountId,
    fetchImpl: (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(12_000) }),
  });
  if (verified.draftReady !== true) throw new Error(verified.reason || "公众号明确账号草稿接口未就绪");
  // `publishReady=null` means this account has never made a real
  // freepublish/submit request. Requiring `true` here creates a deadlock:
  // publishReady is only marked true after that first request succeeds.
  // A proven denial (`false`) still fails closed; an unverified account may
  // make one controlled attempt and the publisher persists the API result.
  if (prepared.mode === "publish" && verified.publishReady === false) {
    throw new Error("公众号明确账号正式发布权限不可用");
  }
  const result = await wechatOfficial.publishArticle({
    accountId,
    title: prepared.title,
    content: prepared.content,
    images: prepared.bundle.images,
    sourceUrl: prepared.bundle.sourceUrl,
    draft: prepared.mode !== "publish",
  });
  return { destination, accountId: result.accountId, success: result?.success !== false, status: result.status || "submitted" };
}

async function executeImageTextPublish(body) {
  const prepared = await prepareImageTextPublish(withoutPublishTime(body));
  const results = [];
  for (const destination of prepared.destinations) {
    try { results.push(await executeImageTextTarget(withoutPublishTime(body), destination)); }
    catch (error) {
      results.push({ destination, success: false, status: "failed", error: safeMessage(error?.message || error) });
    }
  }
  return results;
}

async function scheduleImageTextPublish(body, scheduledAt) {
  const immediate = withoutPublishTime(body);
  const prepared = await prepareImageTextPublish(immediate);
  const targets = prepared.destinations.map((destination) => {
    const accountFingerprint = opaquePublisherAccount(destination, prepared.accountIds[destination]);
    return {
    id: `${destination}:${accountFingerprint}`,
    kind: "image_text",
    destination,
    accountFingerprint,
    expectedMode: prepared.mode === "publish" ? "public" : "draft",
    };
  });
  const taskId = deterministicPublishScheduleId("image_text", scheduledAt, {
    videoId: String(immediate.videoId || ""),
    binding: prepared.scheduleBinding,
    title: prepared.title,
    mode: prepared.mode,
    targets: targets.map((target) => target.id).sort(),
  });
  const task = await persistPublishSchedule({
    id: taskId,
    scheduledAt,
    expiresAt: body?.expiresAt || null,
    payload: {
      kind: "image_text",
      binding: prepared.scheduleBinding,
      request: withoutPublishTime({
        ...immediate,
        binding: undefined,
        destinations: undefined,
        accountIdByDestination: undefined,
        accountIds: undefined,
      }),
    },
    targets,
  });
  await recordEvent("info", "PUBLISH", `织台已持久排期图文：${targets.length} 个平台`, task.id);
  return task;
}

async function preflightLegacyScheduledAsset() {
  throw new Error("legacy_scheduler_inactive：缺少精确账号与完整媒体来源证明");
}

async function executeLegacyScheduledTarget() {
  throw new Error("legacy_scheduler_inactive");
}

async function preflightScheduledPublish({ payload, targets }) {
  if (payload?.kind === "matrix_video") {
    await prepareMatrixPublish(
      { ...payload.request, destinations: [] },
      {
        skipDestinations: true,
        requireStrictGenerated: true,
        requireExpectedBinding: true,
        expectedBinding: payload.binding,
      },
    );
    return { ok: true, kind: payload.kind, targets: targets.length };
  }
  if (payload?.kind === "image_text") {
    await prepareImageTextPublish(
      { ...payload.request, destinations: targets.map((target) => target.destination) },
      {
        verifyAccounts: false,
        requireAccounts: false,
        requireExpectedBinding: true,
        expectedBinding: payload.binding,
      },
    );
    return { ok: true, kind: payload.kind, targets: targets.length };
  }
  if (payload?.kind === "legacy_asset") {
    await preflightLegacyScheduledAsset(payload.task);
    return { ok: true, kind: payload.kind, targets: targets.length };
  }
  throw new Error("publish_schedule_kind_unknown");
}

function intentAwareScheduledResult(result, target) {
  const observedState = String(result?.state || result?.status || "unknown").toLowerCase();
  if (target?.expectedMode === "public" && ["draft", "platform_draft"].includes(observedState)) {
    return {
      ...result,
      status: "failed",
      observedState: "draft",
      intentSatisfied: false,
      externalReceipt: true,
      success: false,
      error: result?.platformMessage || result?.message || "public_publish_fell_back_to_draft",
    };
  }
  return {
    ...result,
    status: observedState,
    externalReceipt: ["public", "published", "draft", "platform_draft", "submitted", "accepted", "unknown"].includes(observedState),
  };
}

async function resolveScheduledImageAccount(target) {
  const accounts = target.destination === "xiaohongshu"
    ? await xhsPublisher.listAccounts()
    : wechatOfficial.listAccounts();
  const matches = accounts.filter((account) =>
    opaquePublisherAccount(target.destination, account.accountId) === target.accountFingerprint);
  if (matches.length !== 1) throw new Error(`image_text_account_unavailable：${target.destination}`);
  return matches[0].accountId;
}

async function executeScheduledPublishTarget({ taskId, target, payload, attempt }) {
  if (payload?.kind === "matrix_video" && target?.kind === "matrix_video") {
    const destination = await resolveScheduledMatrixAccount(target);
    const result = await executeMatrixPublish({
      ...payload.request,
      destinations: [destination],
      jobId: taskId,
      retryFailed: Number(attempt) > 1,
    }, {
      requireStrictGenerated: true,
      requireExpectedBinding: true,
      expectedBinding: payload.binding,
    });
    const receipt = result.results[0] || { state: "unknown", success: false, platformMessage: "matrixmedia_result_missing" };
    return intentAwareScheduledResult(receipt, target);
  }
  if (payload?.kind === "image_text" && target?.kind === "image_text") {
    const accountId = await resolveScheduledImageAccount(target);
    const result = await executeImageTextTarget({
      ...payload.request,
      destinations: [target.destination],
      accountIdByDestination: { [target.destination]: accountId },
      accountIds: { [target.destination]: accountId },
    }, target.destination, {
      requireExpectedBinding: true,
      expectedBinding: payload.binding,
    });
    const safeResult = { ...result };
    delete safeResult.accountId;
    return intentAwareScheduledResult({
      ...safeResult,
      account: target.accountFingerprint,
      status: result.status || (result.success ? "submitted" : "failed"),
    }, target);
  }
  if (payload?.kind === "legacy_asset" && target?.kind === "legacy_asset") {
    return executeLegacyScheduledTarget(taskId, payload.task, target, attempt);
  }
  throw new Error("publish_schedule_target_kind_mismatch");
}

async function resolveImageTextBundle(videoId) {
  const db = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
  let asset;
  let generation;
  let plan = {};
  try {
    asset = db.prepare("SELECT id, title, package_path, source_url FROM video_asset WHERE id=?").get(String(videoId || ""));
    generation = db.prepare("SELECT id, engine, engine_task_id, file_name, size_bytes, sha256 FROM remake_generation WHERE asset_id=? AND engine='ZhitaiSeedance' AND status='completed' ORDER BY completed_at DESC LIMIT 1").get(String(videoId || ""));
    const saved = db.prepare("SELECT plan_json FROM remake_plan WHERE asset_id=?").get(String(videoId || ""));
    if (saved?.plan_json) plan = JSON.parse(saved.plan_json);
  } finally { db.close(); }
  if (!asset?.package_path) throw httpError(404, "image_text_asset_not_found");
  if (!generation?.engine_task_id) throw httpError(409, "image_text_storyboards_not_ready：请先完成 GPT 生图和豆包成片");
  const match = String(generation.engine_task_id).match(/^creative_([0-9a-f-]+)$/i);
  if (!match) throw httpError(409, "image_text_storyboards_not_ready");
  const artifactDir = join(asset.package_path, "remake-output", "zhitai-" + match[1] + "-assets");
  let images = [];
  try {
    images = (await readdir(artifactDir))
      .filter((name) => /^storyboard-\d+\.png$/i.test(name))
      .sort()
      .map((name) => join(artifactDir, name));
  } catch { /* missing bundle handled below */ }
  if (!images.length) throw httpError(409, "image_text_storyboards_not_ready：生成包里没有 GPT 分镜图");
  const publishTitle = publishTitleForPlan(plan, asset.title || "未命名内容");
  const workflowGate = assertPublishWorkflowReady(plan, publishTitle);
  const storyboards = await Promise.all(images.map(async (imagePath) => {
    const info = await stat(imagePath);
    if (!info.isFile() || info.size <= 0) throw httpError(409, "image_text_storyboard_invalid");
    return {
      name: basename(imagePath),
      sizeBytes: info.size,
      sha256: await sha256File(imagePath),
    };
  }));
  const storyboardFingerprint = createHash("sha256")
    .update(JSON.stringify(storyboards))
    .digest("hex");
  return {
    assetId: asset.id,
    title: publishTitle,
    content: publishContentForPlan(plan, asset.title || ""),
    sourceUrl: publishSourceUrlForPlan(plan, asset.source_url || ""),
    images,
    assetBinding: {
      generationEngine: String(generation.engine || ""),
      generationTaskId: String(generation.engine_task_id || ""),
      storyboards,
      storyboardFingerprint,
      workflowSha256: workflowGate.workflowSha256,
    },
  };
}

async function createPublishTask(body, request) {
  const targets = Array.isArray(body.targets)
    ? [...new Set(body.targets.filter((target) => typeof target === "string" && platformTargets[target]))]
    : [];
  if (!body.assetPath || typeof body.assetPath !== "string" || !targets.length) {
    throw httpError(400, "asset_path_and_supported_targets_required");
  }
  const requestedAssetPath = expandHome(body.assetPath);
  if (!isAbsolute(requestedAssetPath)) throw httpError(400, "asset_path_must_be_absolute");
  let assetPath;
  let assetInfo;
  try {
    assetPath = await realpath(requestedAssetPath);
    assetInfo = await stat(assetPath);
    if (!assetInfo.isFile()) throw new Error("not_file");
  } catch {
    throw httpError(400, "asset_file_not_found");
  }
  if (!new Set([".mp4", ".mov", ".m4v", ".webm"]).has(extname(assetPath).toLowerCase())) {
    throw httpError(400, "unsupported_publish_asset_type");
  }
  const maxAssetBytes = Number(config.adapters?.publisher?.maxAssetBytes || 20 * 1024 * 1024 * 1024);
  if (assetInfo.size <= 0 || assetInfo.size > maxAssetBytes) throw httpError(400, "publish_asset_size_out_of_range");
  const requestedRoots = [knowledgeBase, ...(config.adapters?.publisher?.allowedAssetRoots || []).map(expandHome)];
  const allowedRoots = [];
  for (const root of requestedRoots) {
    try {
      allowedRoots.push(await realpath(root));
    } catch {
      // A missing allowlisted root cannot authorize a file.
    }
  }
  if (!allowedRoots.some((root) => pathIsInside(assetPath, root))) throw httpError(403, "asset_path_not_allowed");

  const mode = ["workbench_draft", "platform_draft", "publish"].includes(body.mode)
    ? body.mode
    : "platform_draft";
  if (mode === "publish") {
    if (body.approved !== true) throw httpError(409, "publish_approval_required");
    requireConfirmedAction(request);
  }
  const scheduledAt = typeof body.scheduledAt === "string" && !Number.isNaN(Date.parse(body.scheduledAt))
    ? new Date(body.scheduledAt).toISOString()
    : null;
  const now = new Date().toISOString();
  const idempotencyKey = typeof body.idempotencyKey === "string"
    ? body.idempotencyKey.replace(/[^a-zA-Z0-9_.:-]/g, "_").slice(0, 160)
    : "";
  if (idempotencyKey) {
    const existing = (await readTasks()).find((candidate) =>
      candidate.type === "publish" && candidate.idempotencyKey === idempotencyKey && candidate.status !== "failed",
    );
    if (existing) return existing;
  }
  const canRun = adapterReady("publisher") && mode !== "workbench_draft";
  const future = scheduledAt && Date.parse(scheduledAt) > Date.now() + 1_000;
  if (future && mode !== "workbench_draft") {
    // This compatibility route has only logical platform names and no exact
    // account identity or generated-audio provenance. Never arm the old weak
    // timer; callers must use the native videoId+destinations route.
    throw httpError(409, "persistent_schedule_requires_video_id_and_exact_accounts");
  }
  const task = {
    id: `pub_${randomUUID()}`,
    type: "publish",
    assetPath,
    assetSizeBytes: assetInfo.size,
    assetSha256: await sha256File(assetPath),
    title: sanitizeTitle(typeof body.title === "string" ? body.title : basename(assetPath, extname(assetPath))),
    targets,
    mode,
    approved: mode === "publish" ? true : false,
    idempotencyKey: idempotencyKey || null,
    scheduledAt,
    status: mode === "workbench_draft" ? "draft" : canRun ? "queued" : "needs_setup",
    progress: 0,
    createdAt: now,
    updatedAt: now,
  };
  await writeJsonAtomic(join(publishDir, `${task.id}.json`), task);
  await appendTask(task);
  await recordEvent("info", "PUBLISH", `创建${mode === "publish" ? "正式发布" : "平台草稿"}任务 ${task.id}`, task.id);
  if (task.status === "queued") void runPublishTask(task);
  return task;
}

/* ════════════════════════════════════════════════════════════════
   目录统一 watcher（快点/慢点/本地不明来源）— 可配置 + 持久化
   ════════════════════════════════════════════════════════════════ */

/* 可配置 watcher：
 *   config.watcher.roots[] —— 目录 → 渠道映射（快点目录→kuaidian、慢点目录→mandian_fallback、
 *                              Downloads 不明来源→local_unattributed）
 *   config.watcher.maxRetries / intervalMs —— 失败退避上限与扫描间隔
 * 持久化 watcher-state.json：processed 终态集合 + 每个文件的 attempts/nextRetryAt/稳定指纹。
 * 不按 mtime 年龄丢弃文件（服务停机期间产生的文件重启后仍会处理）；
 * success/duplicate/linked 均为终态写 processed；失败指数退避，达到 maxRetries 后
 * 标记 needs_attention（不再每 20s 无限重试灌表）。
 */
const watcherConfig = config.watcher || {};
const watcherRoots = Array.isArray(watcherConfig.roots)
  ? watcherConfig.roots.map((r) => ({ dir: expandHome(r.dir), channel: r.channel, requireCjk: Boolean(r.requireCjk), recursive: r.recursive !== false }))
  : [
      { dir: join(homedir(), "Downloads", "快点下载"), channel: "kuaidian", requireCjk: false, recursive: true },
      { dir: join(homedir(), "Downloads", "慢点知识库"), channel: "mandian_fallback", requireCjk: false, recursive: true },
      { dir: join(homedir(), "Downloads"), channel: "local_unattributed", requireCjk: true, recursive: false },
    ];
const WATCHER_MAX_RETRIES = Math.max(1, Number(watcherConfig.maxRetries) || 8);
const WATCHER_INTERVAL = Math.max(5000, Number(watcherConfig.intervalMs) || 20000);
const watcherStatePath = join(dataDir, "watcher-state.json");
let watcherState = { processed: [], files: {} }; // files: { "channel:path": { stableKey, seenAt, attempts, nextRetryAt, status } }

async function loadWatcherState() {
  try {
    const j = JSON.parse(await readFile(watcherStatePath, "utf8"));
    if (j && Array.isArray(j.processed)) watcherState = { processed: j.processed, files: j.files || {} };
  } catch { /* 首次运行 */ }
}
async function saveWatcherState() {
  try {
    await writeFile(watcherStatePath, JSON.stringify({ processed: watcherState.processed.slice(-10000), files: watcherState.files }));
  } catch { /* ignore */ }
}

async function walkWatcherMp4(dir, out, requireCjk, recursive, depth = 0) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name === ".DS_Store") continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (recursive && depth < 3) await walkWatcherMp4(p, out, requireCjk, recursive, depth + 1);
    } else if (/\.mp4$/i.test(e.name)) {
      if (requireCjk && !/[\u4e00-\u9fff]/.test(e.name)) continue; // 不明来源仅收中文名
      out.push(p);
    }
  }
}

async function ingestWatcherFile(filePath, channel) {
  try {
    const title = basename(filePath).replace(/\.mp4$/i, "").trim() || "视频号内容";
    const { adapterLocalFile } = await import("./downloader-adapter.mjs");
    const receipt = await adapterLocalFile(filePath, { channel, title });
    const { openKbDb } = await import("./kb.mjs");
    const db = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
    const batchId = `kb_watch_${Date.now()}_${Math.random().toString(16).slice(2, 5)}`;
    db.prepare("INSERT INTO import_batch (id, status, source_kind, created_at, total, succeeded, failed, skipped) VALUES (?, 'running', 'watcher', ?, 1, 0, 0, 0)").run(batchId, new Date().toISOString());
    const r = await kbIngestOne(db, {
      receipt, input: filePath, input_kind: "file", batchId,
      ctx: { privDir: kbPrivDir, yuanbaoEnrich: null, displayInput: basename(filePath) },
    });
    db.prepare("UPDATE import_batch SET status='done', succeeded=?, failed=?, skipped=? WHERE id=?").run(r.status === "success" ? 1 : 0, r.status === "failed" || r.status === "partial" ? 1 : 0, r.status === "duplicate" || r.status === "linked" ? 1 : 0, batchId);
    db.close();
    await recordEvent(r.status === "success" ? "info" : "error", "WATCHER_INGEST",
      `${channel}[${receipt.mediaValidation}]${r.status === "partial" ? "（加密/探测失败）" : ""}：${title.slice(0, 40)}`);
    return r.status;
  } catch (e) {
    await recordEvent("error", "WATCHER_INGEST", `${channel} ${safeMessage(e.message)}`);
    return "failed";
  }
}

/** 处理单个文件：终态（success/duplicate/linked）写 processed；失败退避；超限 needs_attention */
async function handleWatcherFile(filePath, channel, key, entry) {
  const status = await ingestWatcherFile(filePath, channel);
  if (status === "success" || status === "duplicate" || status === "linked") {
    watcherState.processed.push(key);
    delete watcherState.files[key];
  } else {
    const attempts = (entry.attempts || 0) + 1;
    if (attempts >= WATCHER_MAX_RETRIES) {
      watcherState.processed.push(`needs_attention:${key}`);
      delete watcherState.files[key];
      await recordEvent("warn", "WATCHER_QUARANTINE", `${channel} 多次失败已标记 needs_attention：${basename(filePath)}`);
    } else {
      watcherState.files[key] = { ...entry, attempts, nextRetryAt: Date.now() + Math.min(60_000 * (2 ** Math.min(attempts, 6)), 1_800_000) };
    }
  }
  await saveWatcherState();
}

async function scanWatcherLibs() {
  const now = Date.now();
  for (const root of watcherRoots) {
    const files = [];
    await walkWatcherMp4(root.dir, files, root.requireCjk, root.recursive);
    for (const f of files) {
      const key = `${root.channel}:${f}`;
      if (watcherState.processed.includes(key)) continue;
      let st;
      try { st = await stat(f); } catch { continue; }
      if (st.size < 100_000) continue;
      const stableKey = `${st.mtimeMs}:${st.size}`;
      const entry = watcherState.files[key];
      if (entry && entry.nextRetryAt && now >= entry.nextRetryAt) {
        // 退避到期重试
        delete watcherState.files[key].nextRetryAt;
        await handleWatcherFile(f, root.channel, key, { ...entry, attempts: entry.attempts || 0 });
      } else if (entry && entry.stableKey === stableKey && !entry.nextRetryAt && now - entry.seenAt > 10_000) {
        // 文件已稳定 ≥10s：处理
        await handleWatcherFile(f, root.channel, key, entry);
      } else if (entry && entry.stableKey !== stableKey) {
        // 文件仍在写入/变化：重置稳定期
        watcherState.files[key] = { ...entry, stableKey, seenAt: now, nextRetryAt: null };
      } else if (!entry) {
        watcherState.files[key] = { stableKey, seenAt: now, attempts: 0, status: "pending" };
      }
    }
  }
  if (Object.keys(watcherState.files).length > 3000) {
    watcherState.files = Object.fromEntries(Object.entries(watcherState.files).slice(-2000));
  }
  await saveWatcherState();
}

async function startWatcher() {
  await loadWatcherState();
  setInterval(() => scanWatcherLibs().catch(() => {}), WATCHER_INTERVAL);
  scanWatcherLibs().catch(() => {});
  console.log(`目录 watcher 已启动：${watcherRoots.map((r) => `${r.dir}→${r.channel}`).join(" / ")}`);
}

async function deactivateLegacyScheduledTasks() {
  const changed = await mutateTasks((tasks) => {
    let count = 0;
    for (const task of tasks) {
      if (task.type !== "publish" || task.status !== "scheduled") continue;
      task.status = "needs_attention";
      task.errorCode = "legacy_scheduler_inactive";
      task.updatedAt = new Date().toISOString();
      count += 1;
    }
    return count;
  });
  if (changed) {
    await recordEvent("warning", "PUBLISH", `${changed} 条旧排期缺少精确账号与完整预检，已停止自动执行`);
  }
}

async function runPublishTask(task) {
  const adapter = config.adapters.publisher;
  try {
    await updateTask(task.id, { status: "running", progress: 10 });
    const currentAssetPath = await realpath(task.assetPath);
    const currentAssetInfo = await stat(currentAssetPath);
    if (currentAssetPath !== task.assetPath || currentAssetInfo.size !== task.assetSizeBytes || await sha256File(currentAssetPath) !== task.assetSha256) {
      throw new Error("asset_changed_since_approval");
    }
    const type = adapter.type || (adapter.command ? "command" : "");
    let result;
    if (type === "matrix-media") {
      const aliases = {
        douyin: ["dy", "douyin", "抖音"],
        wechat_channels: ["sph", "channels", "视频号"],
        xiaohongshu: ["xhs", "xiaohongshu", "小红书"],
      };
      const accounts = await matrix.cliAccounts();
      const platforms = [];
      const missingTargets = [];
      for (const target of task.targets) {
        const matchingAccounts = accounts.filter((row) => {
          const value = String(row?.platform || "").toLowerCase();
          const state = `${row?.loginStatus || ""} ${row?.error || ""}`.toLowerCase();
          return aliases[target]?.some((alias) => value.includes(alias))
            && Boolean(row?.phone || row?.partition)
            && !/未登录|offline|expired|invalid|failed|失败|过期/.test(state);
        });
        if (matchingAccounts.length !== 1) {
          missingTargets.push(matchingAccounts.length > 1 ? `${target}_ambiguous_account` : target);
          continue;
        }
        const account = matchingAccounts[0];
        platforms.push({
          platform: platformTargets[target],
          ...(account.phone ? { phone: account.phone } : {}),
          ...(account.partition ? { partition: account.partition } : {}),
        });
      }
      result = platforms.length
        ? await matrix.publishWithReceipts({
          payload: {
            platforms,
            file: task.assetPath,
            title: task.title,
            draft: task.mode !== "publish",
          },
          receiptStore: publisherReceiptStore,
          content: {
            id: String(task.assetId || task.id || ""),
            title: task.title,
            mediaSha256: task.assetSha256,
          },
          jobId: task.id,
        })
        : { success: false, total: 0, results: [] };
      const failedTargets = (Array.isArray(result?.results) ? result.results : [])
        .filter((row) => row?.success !== true)
        .map((row) => String(row?.platform || "unknown"));
      if (missingTargets.length || result?.success === false || failedTargets.length) {
        const completed = (Array.isArray(result?.results) ? result.results : []).filter((row) => row?.success === true).length;
        await updateTask(task.id, {
          status: "needs_attention",
          progress: platforms.length ? Math.round((completed / Math.max(1, task.targets.length)) * 100) : 0,
          result: sanitizeResult({ ...result, missingTargets, failedTargets }),
          errorCode: missingTargets.length ? `publisher_accounts_missing_${missingTargets.join("_")}` : "platform_draft_partial_failed",
        });
        await recordEvent("warning", "PUBLISH", `多平台草稿部分待处理：缺少或失效账号 ${missingTargets.join("、") || failedTargets.join("、")}`, task.id);
        return;
      }
    } else if (type === "command") {
      const jobFile = join(publishDir, `${task.id}.json`);
      const args = (adapter.args || []).map((value) => String(value).replace(/\{jobFile\}/g, jobFile));
      await spawnAndWait(adapter.command, args, {
        cwd: adapter.cwd ? expandHome(adapter.cwd) : agentRoot,
        env: safeChildEnv({ ZHITAI_KNOWLEDGE_BASE: knowledgeBase }, adapter.env),
        timeoutMs: Number(adapter.timeoutMs || config.polling.timeoutMs),
      });
      result = { accepted: true };
    } else {
      throw new Error("unsupported_publisher_type");
    }
    const status = task.mode === "publish" ? "submitted" : "platform_draft";
    await updateTask(task.id, { status, progress: 100, result: sanitizeResult(result) });
    await recordEvent("info", "PUBLISH", `发布器已接收任务，状态 ${status}`, task.id);
  } catch (error) {
    const code = safeErrorCode(error);
    const status = code === "adapter_exit_4" || /account|login|cookie|session/i.test(code)
      ? "needs_attention"
      : "failed";
    await updateTask(task.id, { status, progress: 0, errorCode: code });
    await recordEvent(status === "needs_attention" ? "warning" : "error", "PUBLISH", `发布失败：${code}`, task.id);
  }
}

async function getServiceStates() {
  const entries = await Promise.all(Object.entries(config.services).map(async ([id, service]) => {
    const managed = managedProcesses.get(id);
    const onDemand = service.onDemand === true;
    const configured = Boolean(onDemand || service.healthUrl || service.start?.command || service.probe?.command || service.businessProbe?.command || service.setup?.command);
    const install = await inspectServiceInstall(service, configured);
    const installed = ["ready", "source_ready"].includes(install.state);
    let healthy = false;
    if (service.healthUrl) {
      try {
        const target = assertLoopbackUrl(service.healthUrl);
        const response = await fetch(target, { signal: AbortSignal.timeout(1_200) });
        healthy = response.ok || (response.status >= 300 && response.status < 400);
        if (healthy && Array.isArray(service.healthJsonKeys) && service.healthJsonKeys.length) {
          const body = await response.json();
          healthy = Boolean(body && typeof body === "object" && service.healthJsonKeys.every((key) => key in body));
        }
      } catch {
        healthy = false;
      }
    } else {
      healthy = false;
    }
    let probedRunning = false;
    if (service.probe?.command) {
      const executable = await resolveExecutable(service.probe.command);
      if (executable) {
        try {
          await spawnAndWait(executable, Array.isArray(service.probe.args) ? service.probe.args.map(expandArgument) : [], {
            cwd: service.probe.cwd ? expandHome(service.probe.cwd) : agentRoot,
            env: safeChildEnv(service.probe.env),
            timeoutMs: Math.max(500, Number(service.probe.timeoutMs || 2_000)),
          });
          probedRunning = true;
        } catch {
          probedRunning = false;
        }
      }
    }
    let business = null;
    if (service.businessProbe?.command) {
      const executable = await resolveExecutable(service.businessProbe.command);
      if (executable) {
        try {
          const payload = await spawnAndCaptureJson(executable, Array.isArray(service.businessProbe.args) ? service.businessProbe.args.map(expandArgument) : [], {
            cwd: service.businessProbe.cwd ? expandHome(service.businessProbe.cwd) : agentRoot,
            env: safeChildEnv(service.businessProbe.env),
            timeoutMs: Math.max(500, Number(service.businessProbe.timeoutMs || 3_000)),
          });
          const authentication = payload?.authentication && typeof payload.authentication === "object" ? payload.authentication : {};
          const businessRaw = payload?.business && typeof payload.business === "object" ? payload.business : {};
          const bridge = payload?.bridge && typeof payload.bridge === "object" ? payload.bridge : {};
          business = {
            authentication: {
              state: String(authentication.state || "unknown").replace(/[^a-z0-9_-]/gi, "_").slice(0, 40),
              valid: authentication.valid === true,
              savedAt: typeof authentication.savedAt === "string" ? authentication.savedAt.slice(0, 40) : null,
            },
            state: String(businessRaw.state || "unknown").replace(/[^a-z0-9_-]/gi, "_").slice(0, 40),
            ready: businessRaw.ready === true,
            reason: safeMessage(businessRaw.reason || "业务状态探针未返回原因"),
            lastMonitorAt: typeof businessRaw.lastMonitorAt === "string" ? businessRaw.lastMonitorAt.slice(0, 40) : null,
            lastInboundAt: typeof businessRaw.lastInboundAt === "string" ? businessRaw.lastInboundAt.slice(0, 40) : null,
            lastErrorAt: typeof businessRaw.lastErrorAt === "string" ? businessRaw.lastErrorAt.slice(0, 40) : null,
            bridgeReady: bridge.ready === true,
          };
        } catch {
          business = {
            authentication: { state: "unknown", valid: false, savedAt: null },
            state: "probe_unavailable",
            ready: false,
            reason: "业务状态探针不可用",
            lastMonitorAt: null,
            lastInboundAt: null,
            lastErrorAt: null,
            bridgeReady: false,
          };
        }
      }
    }
    const running = Boolean(managed && managed.exitCode === null && !managed.killed) || healthy || probedRunning;
    if (business) healthy = business.ready;
    const readyOnDemand = onDemand && installed;
    const status = healthy || readyOnDemand
      ? "healthy"
      : running && business?.state === "needs_login"
        ? "needs_login"
        : running && business
          ? "degraded"
      : running
        ? "running"
        : install.state === "drifted" || install.state === "invalid"
          ? install.state
          : !installed
            ? "not_installed"
            : service.setup?.command && !service.start?.command
              ? "needs_setup"
              : !configured
              ? "source_ready"
              : "stopped";
    return [id, {
      id,
      label: service.label || id,
      role: service.role || "service",
      project: service.project || id,
      configured,
      installed,
      install,
      setupAvailable: Boolean(service.setup?.command),
      manageable: Boolean(service.start?.command),
      running,
      healthy: healthy || readyOnDemand,
      onDemand,
      process: { running, managed: Boolean(managed), probed: probedRunning },
      authentication: business?.authentication || null,
      business: business ? {
        state: business.state,
        ready: business.ready,
        reason: business.reason,
        lastMonitorAt: business.lastMonitorAt,
        lastInboundAt: business.lastInboundAt,
        lastErrorAt: business.lastErrorAt,
        bridgeReady: business.bridgeReady,
      } : null,
      runtime: { state: status, reason: business?.reason || (readyOnDemand ? "内置引擎按需启动，当前已就绪" : healthy ? "健康检查通过" : running ? "进程正在运行" : install.reason) },
      managed: Boolean(managed),
      status,
      mutualExclusionGroup: service.mutualExclusionGroup || null,
      notes: service.notes || "",
      projectUrl: service.projectUrl || null,
    }];
  }));
  return Object.fromEntries(entries);
}

async function inspectServiceInstall(service, configured) {
  const checks = Array.isArray(service.installChecks) ? service.installChecks : [];
  if (checks.length) {
    const results = await Promise.all(checks.map(async (path) => {
      try {
        await access(expandHome(path));
        return true;
      } catch {
        return false;
      }
    }));
    if (!results.every(Boolean)) {
      return { state: "missing", reason: "缺少必需文件或安装目录" };
    }
  }
  const requiredExecutables = Array.isArray(service.requiredExecutables) ? service.requiredExecutables : [];
  for (const executable of requiredExecutables) {
    if (!await resolveExecutable(executable)) {
      return { state: "invalid", reason: `缺少运行时：${basename(executable)}` };
    }
  }
  let revision = null;
  if (service.repositoryRoot || service.expectedRevision) {
    if (!service.repositoryRoot) return { state: "invalid", reason: "未配置源码根目录" };
    revision = await readGitRevision(expandHome(service.repositoryRoot));
    if (!revision) return { state: "invalid", reason: "无法验证源码提交" };
    if (service.expectedRevision && revision !== String(service.expectedRevision).toLowerCase()) {
      return {
        state: "drifted",
        revision,
        expectedRevision: service.expectedRevision,
        reason: "源码提交与固定版本不一致",
      };
    }
    if (service.requireCleanRevision !== false) {
      const dirtyPaths = await readGitDirtyPaths(expandHome(service.repositoryRoot));
      if (dirtyPaths === null) return { state: "invalid", revision, reason: "无法验证源码工作区" };
      const allowedDirtyPaths = Array.isArray(service.allowedDirtyPaths) ? service.allowedDirtyPaths.map(String) : [];
      const unexpected = dirtyPaths.filter((path) => !allowedDirtyPaths.some((allowed) =>
        path === allowed || (allowed.endsWith("/") && path.startsWith(allowed)),
      ));
      if (unexpected.length) {
        return {
          state: "drifted",
          revision,
          expectedRevision: service.expectedRevision || revision,
          reason: `检测到 ${unexpected.length} 个未经批准的源码改动`,
        };
      }
    }
  }
  if (!checks.length && !requiredExecutables.length && !service.start?.command && !service.healthUrl) {
    return { state: "missing", reason: "未配置安装检测" };
  }
  if (service.start?.command && !await resolveExecutable(service.start.command)) {
    return { state: "invalid", revision, reason: "启动命令不可执行" };
  }
  return {
    state: configured ? "ready" : "source_ready",
    ...(revision ? { revision } : {}),
    ...(service.expectedRevision ? { expectedRevision: service.expectedRevision } : {}),
    reason: configured ? "安装与启动配置已验证" : "固定源码已就绪，尚未配置账号或安全启动命令",
  };
}

async function readGitDirtyPaths(repositoryRoot) {
  return new Promise((resolvePromise) => {
    const child = spawn("/usr/bin/git", ["-C", repositoryRoot, "status", "--porcelain=v1", "--untracked-files=all"], {
      env: safeChildEnv(),
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise(null);
    }, 2_000);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.length > 128_000) child.kill("SIGKILL");
    });
    child.once("error", () => {
      clearTimeout(timer);
      resolvePromise(null);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0 || output.length > 128_000) {
        resolvePromise(null);
        return;
      }
      resolvePromise(output.split("\n").filter(Boolean).map((line) => {
        const rawPath = line.slice(3).trim();
        return rawPath.includes(" -> ") ? rawPath.split(" -> ").at(-1) : rawPath;
      }));
    });
  });
}

async function readGitRevision(repositoryRoot) {
  try {
    let gitDirectory = join(repositoryRoot, ".git");
    try {
      const pointer = (await readFile(gitDirectory, "utf8")).trim().match(/^gitdir:\s*(.+)$/i)?.[1];
      if (!pointer) return null;
      gitDirectory = resolve(repositoryRoot, pointer);
    } catch (error) {
      // Normal repositories expose .git as a directory; linked worktrees expose
      // it as the small gitdir pointer file handled above.
      if (!["EISDIR", "EPERM", "EACCES"].includes(error?.code)) throw error;
    }
    const head = (await readFile(join(gitDirectory, "HEAD"), "utf8")).trim();
    if (/^[a-f0-9]{40}$/i.test(head)) return head.toLowerCase();
    const reference = head.match(/^ref:\s*(.+)$/)?.[1];
    if (!reference || reference.includes("..")) return null;
    try {
      const loose = (await readFile(join(gitDirectory, reference), "utf8")).trim();
      if (/^[a-f0-9]{40}$/i.test(loose)) return loose.toLowerCase();
    } catch {
      // Packed references are checked next.
    }
    const packed = await readFile(join(gitDirectory, "packed-refs"), "utf8");
    const match = packed.split("\n").find((line) => line.endsWith(` ${reference}`));
    const revision = match?.split(" ")[0];
    return revision && /^[a-f0-9]{40}$/i.test(revision) ? revision.toLowerCase() : null;
  } catch {
    return null;
  }
}

async function resolveExecutable(command) {
  if (command.includes("/") || isAbsolute(command)) {
    return executablePath(expandHome(command));
  }
  for (const directory of String(process.env.PATH || "").split(":")) {
    if (!directory) continue;
    const candidate = join(directory, command);
    const executable = await executablePath(candidate);
    if (executable) return executable;
  }
  return null;
}

async function executablePath(path) {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    await access(path, fsConstants.X_OK);
    return path;
  } catch {
    return null;
  }
}

async function startService(id) {
  const service = config.services[id];
  if (!service) throw httpError(404, "service_not_found");
  const currentState = (await getServiceStates())[id];
  if (currentState.running) return { service: currentState, alreadyRunning: true };
  if (!currentState.installed || ["drifted", "invalid", "missing"].includes(currentState.install?.state)) {
    throw httpError(409, "service_install_not_ready");
  }
  const executable = service.start?.command && await resolveExecutable(service.start.command);
  if (!executable) throw httpError(409, "service_not_installed_or_start_command_missing");
  if (service.mutualExclusionGroup) {
    const states = await getServiceStates();
    const conflict = Object.values(states).find((candidate) =>
      candidate.id !== id && candidate.mutualExclusionGroup === service.mutualExclusionGroup && candidate.running,
    );
    if (conflict) throw httpError(409, `mutual_exclusion_conflict_${conflict.id}`);
  }
  const child = spawn(executable, Array.isArray(service.start.args) ? service.start.args.map(expandArgument) : [], {
    cwd: service.start.cwd ? expandHome(service.start.cwd) : agentRoot,
    env: safeChildEnv(service.start.env),
    shell: false,
    stdio: ["ignore", "ignore", "ignore"],
  });
  managedProcesses.set(id, child);
  child.once("error", async () => {
    managedProcesses.delete(id);
    await recordEvent("error", "SERVICE", `${id} 启动失败`);
  });
  child.once("exit", async (code) => {
    managedProcesses.delete(id);
    await recordEvent(code === 0 ? "info" : "error", "SERVICE", `${id} 已退出（${code ?? "signal"}）`);
  });
  await recordEvent("info", "SERVICE", `已启动 ${id}`);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 120));
  return { service: (await getServiceStates())[id] };
}

async function runServiceAction(action) {
  let result;
  let failure;
  serviceMutation = serviceMutation.catch(() => {}).then(async () => {
    try {
      result = await action();
    } catch (error) {
      failure = error;
    }
  });
  await serviceMutation;
  if (failure) throw failure;
  return result;
}

async function stopService(id) {
  if (!config.services[id]) throw httpError(404, "service_not_found");
  const child = managedProcesses.get(id);
  if (!child) throw httpError(409, "service_not_managed_by_zhitai");
  const exited = new Promise((resolvePromise) => child.once("exit", resolvePromise));
  child.kill("SIGTERM");
  const timeoutMs = Math.max(1_000, Number(config.services[id].stopTimeoutMs || 5_000));
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), timeoutMs)),
  ]);
  if (!graceful) {
    child.kill("SIGKILL");
    const forced = await Promise.race([
      exited.then(() => true),
      new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 2_000)),
    ]);
    if (!forced) throw httpError(500, "service_stop_timeout");
  }
  managedProcesses.delete(id);
  await recordEvent("info", "SERVICE", `已停止 ${id}`);
  return { service: (await getServiceStates())[id] };
}

async function setupService(id) {
  const service = config.services[id];
  if (!service) throw httpError(404, "service_not_found");
  const currentState = (await getServiceStates())[id];
  if (!currentState.installed) throw httpError(409, "service_not_installed");
  const executable = service.setup?.command && await resolveExecutable(service.setup.command);
  if (!executable) throw httpError(409, "service_setup_command_missing");
  await spawnAndWait(executable, Array.isArray(service.setup.args) ? service.setup.args.map(expandArgument) : [], {
    cwd: service.setup.cwd ? expandHome(service.setup.cwd) : agentRoot,
    env: safeChildEnv(service.setup.env),
    timeoutMs: Math.max(2_000, Number(service.setup.timeoutMs || 15_000)),
  });
  await recordEvent("info", "SERVICE", `已打开 ${id} 的人工配置流程`);
  return { service: (await getServiceStates())[id], setupLaunched: true };
}

function expandArgument(value) {
  return String(value)
    .replace(/^~(?=\/)/, homedir())
    .replace(/\{knowledgeBase\}/g, knowledgeBase);
}

function safeChildEnv(...overrides) {
  const allowed = ["PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "PYTHONPATH", "VIRTUAL_ENV"];
  const env = Object.fromEntries(allowed.filter((key) => typeof process.env[key] === "string").map((key) => [key, process.env[key]]));
  for (const values of overrides) {
    if (!values || typeof values !== "object") continue;
    for (const [key, value] of Object.entries(values)) {
      if (/^[A-Z][A-Z0-9_]{0,63}$/.test(key) && ["string", "number", "boolean"].includes(typeof value)) {
        env[key] = String(value);
      }
    }
  }
  return env;
}

async function filesChangedSince(root, timestamp) {
  const files = await listFiles(root, 8, 1_000);
  const changed = [];
  for (const file of files) {
    try {
      const info = await stat(file);
      if (info.mtimeMs >= timestamp - 2_000) changed.push(file);
    } catch {
      // Ignore files that disappear during scan.
    }
  }
  return changed.slice(0, 200);
}

async function listFiles(root, maxDepth = 12, maxResults = 2_000) {
  const files = [];
  async function walk(path, depth) {
    if (files.length >= maxResults || depth > maxDepth) return;
    let info;
    try {
      info = await stat(path);
    } catch {
      return;
    }
    if (info.isFile()) {
      files.push(path);
      return;
    }
    if (!info.isDirectory()) return;
    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      await walk(join(path, entry.name), depth + 1);
    }
  }
  await walk(root, 0);
  return files;
}

async function pathSize(path) {
  const files = await listFiles(path);
  let total = 0;
  for (const file of files) {
    try {
      total += (await stat(file)).size;
    } catch {
      // Ignore transient files.
    }
  }
  return total;
}

async function describeFile(path, packageDir) {
  const info = await stat(path);
  return {
    relativePath: path.slice(packageDir.length + 1),
    sizeBytes: info.size,
    sha256: await sha256File(path),
  };
}

async function sha256File(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", rejectPromise);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

async function readTasks() {
  try {
    const parsed = JSON.parse(await readFile(tasksPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/* ─────────── 快点控制台 V1：任务聚合 / 重试模式 / 重供命令队列 / Edge 打开器 ─────────── */

/** 状态 → 中文 displayStatus（覆盖全部快点儿项态与 legacy 任务态） */
const KUAIDIAN_STATUS_ZH = {
  processing: "处理中",
  success: "已完成",
  duplicate: "已存在（重复）",
  linked: "已关联",
  failed: "失败",
  partial: "部分成功（加密/探测失败）",
  orphaned: "孤立",
  pending: "等待快点主下载",
  awaiting_primary_download: "等待快点主下载",
  awaiting_fallback_media: "等待媒体回退",
  recovered_stale_processing: "已恢复陈旧处理",
  queued: "排队中",
  running: "处理中",
  completed: "已完成",
  canceled: "已取消",
  needs_attention: "需处理",
};
function displayStatusZh(status) {
  return KUAIDIAN_STATUS_ZH[String(status || "")] || String(status || "未知");
}

/** displayStatus 按 status + error 前缀细化：pending 区分 awaiting_primary_download/awaiting_fallback_media/已恢复陈旧处理 */
function jobDisplayStatus(status, error) {
  const err = String(error || "");
  if (String(status) === "pending") {
    if (err.startsWith("awaiting_fallback_media")) return KUAIDIAN_STATUS_ZH.awaiting_fallback_media;
    if (err.startsWith("awaiting_primary_download")) return KUAIDIAN_STATUS_ZH.awaiting_primary_download;
    if (err.includes("recovered_stale_processing")) return KUAIDIAN_STATUS_ZH.recovered_stale_processing;
    return KUAIDIAN_STATUS_ZH.pending;
  }
  if (String(status) === "failed" && err.includes("recovered_stale_processing")) return KUAIDIAN_STATUS_ZH.recovered_stale_processing;
  return displayStatusZh(status);
}

/** 诚实 retryMode：终态 none；本地路径 → local_retry（既有 import retry 端点）；
 *  稳定分享 URL / 临时 URL fingerprint / 等待快点 → companion_resupply（需原版快点重供） */
function kuaidianRetryModeFor(item) {
  if (!item) return "none";
  const status = String(item.status || "");
  if (["success", "duplicate", "linked"].includes(status)) return "none";
  const input = String(item.input || "");
  if (input && !/^https?:\/\//i.test(input) && !input.startsWith("[redacted:")) {
    // 本地可恢复路径 → local_retry
    return "local_retry";
  }
  return "companion_resupply";
}

/** 安全任务标题：稳定分享 URL → canonical；basename → basename；fingerprint → 通用名 */
function safeJobTitle(displayInput) {
  const raw = String(displayInput || "").trim();
  if (!raw || raw.startsWith("[redacted:")) return "视频号内容";
  if (isStableShareUrl(raw)) {
    const canonical = canonicalizeSourceUrl(raw);
    return canonical || "分享链接";
  }
  if (/^https?:\/\//i.test(raw)) return "视频号内容";
  const leaf = String(raw).split(/[\\/]/).pop() || raw;
  return leaf.slice(0, 120) || "视频号内容";
}

/** 聚合真实任务：kb import_item/import_batch 为主，legacy tasks 补历史并去重相关条目 */
async function buildKuaidianJobs() {
  const { openKbDb } = await import("./kb.mjs");
  const jobs = [];
  const kbSeen = new Set();
  const kbCanonicalInputs = new Set();
  let db = null;
  try {
    db = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
    const rows = db.prepare(
      `SELECT i.id, i.batch_id, i.input_kind, i.display_input, i.input, i.status, i.error, i.retry_count,
              i.asset_id, i.delivery_id, i.updated_at, b.source_kind
       FROM import_item i LEFT JOIN import_batch b ON b.id = i.batch_id
       WHERE COALESCE(b.source_kind, '') NOT IN ('migration', 'watcher')
       ORDER BY i.id DESC LIMIT 300`,
    ).all();
    for (const row of rows) {
      const status = String(row.status || "");
      const jobId = `kb:${row.id}`;
      kbSeen.add(jobId);
      const canonical = isStableShareUrl(String(row.input || "")) ? canonicalizeSourceUrl(String(row.input)) : null;
      if (canonical) kbCanonicalInputs.add(canonical);
      if (String(row.delivery_id || "") && status === "failed") {
        // 失败的重供机会：交给 resupply；title 仍安全展示
      }
      jobs.push({
        id: jobId,
        itemId: row.id,
        source: "kb",
        title: safeJobTitle(row.display_input),
        displayName: safeJobTitle(row.display_input),
        status,
        displayStatus: jobDisplayStatus(status, row.error),
        updatedAt: row.updated_at || null,
        retryCount: Number(row.retry_count || 0),
        assetId: row.asset_id || null,
        deliveryId: row.delivery_id || null,
        errorDisplay: row.error ? sanitizeFailureText(String(row.error)).slice(0, 300) : null,
        retryMode: kuaidianRetryModeFor(row),
      });
    }
  } catch {
    /* kb.sqlite 不存在时不阻塞 legacy 聚合 */
  } finally {
    if (db) db.close();
  }
  // legacy tasks 历史：仅补 kb 未覆盖的（按 canonical sourceUrl / deliveryId 去重相关条目）
  const legacyTasks = (await readTasks()).filter((t) => String(t.type || "") !== "publish");
  const kbDeliveryIds = new Set();
  // 二次扫描收集 kb deliveryId（避免再次开库）
  try {
    const db2 = openKbDb(join(dataDir, "kb.sqlite"), { migrateSchema: false });
    for (const r of db2.prepare("SELECT delivery_id FROM import_item WHERE delivery_id IS NOT NULL").all()) {
      if (r.delivery_id) kbDeliveryIds.add(String(r.delivery_id));
    }
    db2.close();
  } catch { /* ignore */ }
  const legacySeen = new Set();
  for (const task of legacyTasks) {
    const tId = String(task.id || "");
    const tStatus = String(task.status || "");
    const tSourceUrl = String(task.sourceUrl || task.url || "").trim();
    const canonical = tSourceUrl && isStableShareUrl(tSourceUrl) ? canonicalizeSourceUrl(tSourceUrl) : null;
    const legacyKey = task.deliveryId ? `delivery:${task.deliveryId}` : task.cardObjectId ? `card:${task.cardObjectId}` : canonical ? `url:${canonical}` : `task:${tId}`;
    if (legacySeen.has(legacyKey)) continue;
    legacySeen.add(legacyKey);
    // 去重：kb 已覆盖同 canonical source 或同 deliveryId → 跳过 legacy 条目（避免假实时队列双显示）
    if ((canonical && kbCanonicalInputs.has(canonical)) || (task.deliveryId && kbDeliveryIds.has(String(task.deliveryId)))) {
      continue;
    }
    jobs.push({
      id: `legacy:${tId}`,
      itemId: null,
      legacyTaskId: tId || null,
      source: "legacy",
      title: String(task.title || "采集任务").slice(0, 120),
      displayName: String(task.title || "采集任务").slice(0, 120),
      status: tStatus,
      displayStatus: displayStatusZh(tStatus),
      updatedAt: task.updatedAt || task.createdAt || null,
      retryCount: Number(task.retryCount || 0),
      assetId: null,
      deliveryId: task.deliveryId || null,
      errorDisplay: (task.errorCode || task.reason) ? downloadFailureZh(task.errorCode || task.reason) : null,
      retryMode: ["failed", "needs_attention", "needs_setup"].includes(tStatus) && task.cardObjectId && task.cardNonceId
        ? "legacy_retry"
        : "none",
    });
  }
  return jobs.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")));
}

function countKuaidianJobs(jobs) {
  const processing = jobs.filter((j) => ["processing", "pending", "awaiting_primary_download", "awaiting_fallback_media", "running", "queued"].includes(j.status)).length;
  const needsAttention = jobs.filter((j) => ["failed", "partial", "orphaned", "needs_attention", "recovered_stale_processing"].includes(j.status)).length;
  const completed = jobs.filter((j) => ["success", "duplicate", "linked", "completed"].includes(j.status)).length;
  return { all: jobs.length, processing, completed, needsAttention };
}

async function readKuaidianCommands() {
  try {
    const parsed = JSON.parse(await readFile(kuaidianCommandsPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

let kuaidianCommandMutation = Promise.resolve();
async function writeKuaidianCommands(commands) {
  kuaidianCommandMutation = kuaidianCommandMutation.catch(() => {}).then(async () => {
    await writeJsonAtomic(kuaidianCommandsPath, commands.slice(0, 300));
  });
  await kuaidianCommandMutation;
}

async function appendKuaidianCommand({ itemId, deliveryId }) {
  const command = {
    id: `resupply_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    itemId,
    deliveryId: deliveryId || null,
    status: "queued",
    createdAt: new Date().toISOString(),
    outcome: null,
    reasonZh: null,
    ackedAt: null,
  };
  const commands = await readKuaidianCommands();
  commands.unshift(command);
  await writeKuaidianCommands(commands);
  return command;
}

async function updateKuaidianCommand(commandId, patch) {
  const commands = await readKuaidianCommands();
  const index = commands.findIndex((c) => c.id === commandId);
  if (index < 0) return null;
  commands[index] = { ...commands[index], ...patch };
  await writeKuaidianCommands(commands);
  return commands[index];
}

/** 显式用 Microsoft Edge 打开文件传输助手网页版（不用默认浏览器） */
async function openFilehelperWithEdge() {
  const url = "https://filehelper.weixin.qq.com/";
  const candidates = [
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge",
  ];
  for (const edgeBinary of candidates) {
    if (await fileExists(edgeBinary)) {
      try {
        const { spawn } = await import("node:child_process");
        const child = spawn(edgeBinary, [url], { stdio: "ignore", detached: true });
        child.unref();
        return true;
      } catch {
        /* 尝试下一个候选 */
      }
    }
  }
  // 备用：open -a "Microsoft Edge"（仍是显式 Edge，不用默认浏览器）
  try {
    const { spawn } = await import("node:child_process");
    const child = spawn("/usr/bin/open", ["-a", "Microsoft Edge", url], { stdio: "ignore", detached: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

async function mutateTasks(mutator) {
  let result;
  taskMutation = taskMutation.catch(() => {}).then(async () => {
    const tasks = await readTasks();
    const changed = await mutator(tasks);
    result = changed;
    await writeJsonAtomic(tasksPath, tasks.slice(0, 500));
  });
  await taskMutation;
  return result;
}

async function appendTask(task) {
  return mutateTasks((tasks) => {
    tasks.unshift(task);
    return task;
  });
}

async function updateTask(taskId, patch) {
  return mutateTasks((tasks) => {
    const index = tasks.findIndex((task) => task.id === taskId);
    if (index < 0) return null;
    tasks[index] = { ...tasks[index], ...patch, updatedAt: new Date().toISOString() };
    return tasks[index];
  });
}

async function readEvents() {
  try {
    const parsed = JSON.parse(await readFile(eventsPath, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function recordEvent(level, type, message, taskId = null) {
  const event = {
    id: `evt_${randomUUID()}`,
    level,
    type: String(type).slice(0, 32),
    message: safeMessage(message),
    taskId,
    createdAt: new Date().toISOString(),
  };
  eventMutation = eventMutation.catch(() => {}).then(async () => {
    const events = await readEvents();
    events.unshift(event);
    await writeJsonAtomic(eventsPath, events.slice(0, 1_000));
  });
  await eventMutation;
  if (notificationCenter) {
    void notificationCenter.notifyEvent(event.type, event.message).catch(() => {});
  }
}

async function writeJsonAtomic(path, data) {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

async function spawnAndWait(command, args, options) {
  const executable = await resolveExecutable(command);
  if (!executable) throw new Error("adapter_command_not_found");
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectPromise(new Error("adapter_timeout"));
    }, options.timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(signal ? "adapter_terminated" : `adapter_exit_${code ?? "unknown"}`));
    });
  });
}

async function spawnAndCaptureJson(command, args, options) {
  const executable = await resolveExecutable(command);
  if (!executable) throw new Error("probe_command_not_found");
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let output = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      rejectPromise(new Error("probe_timeout"));
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      if (output.length > 64 * 1024) child.kill("SIGKILL");
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code !== 0) {
        rejectPromise(new Error(signal ? "probe_terminated" : `probe_exit_${code ?? "unknown"}`));
        return;
      }
      try { resolvePromise(JSON.parse(output)); }
      catch { rejectPromise(new Error("probe_invalid_json")); }
    });
  });
}

function pathIsInside(path, root) {
  const absolutePath = resolve(path);
  const absoluteRoot = resolve(root);
  return absolutePath === absoluteRoot || absolutePath.startsWith(`${absoluteRoot}/`);
}

function sanitizeFilename(value) {
  return stripControlCharacters(String(value || "asset")).replace(/[\\/:*?"<>|]/g, "_").slice(0, 120) || "asset";
}

function sanitizeTitle(value) {
  return stripControlCharacters(String(value || "未命名内容"), " ").trim().slice(0, 200) || "未命名内容";
}

function stripControlCharacters(value, replacement = "") {
  return [...value]
    .map((character) => character.charCodeAt(0) <= 31 ? replacement : character)
    .join("");
}

function sanitizeSource(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "webhook";
}

const MODULE_UPDATE_DEFS = [
  {
    id: "mcp-video-analyzer", name: "视频分析", repo: "guimatheus92/mcp-video-analyzer",
    homepage: "https://github.com/guimatheus92/mcp-video-analyzer/releases/latest",
    current: async () => readJsonVersion(join(runtimeRoot, "engines", "mcp-video-analyzer-current", "package.json")),
    policy: "managed", note: "支持一键旁路安装、构建冒烟和版本切换；旧版保留可回退",
  },
  {
    id: "matrixmedia", name: "发布引擎", repo: "hanliang97/MatrixMedia",
    homepage: "https://github.com/hanliang97/MatrixMedia/releases/latest",
    current: async () => readPlistVersion(join(runtimeRoot, "engines", "matrixmedia.app", "Contents", "Info.plist")),
    policy: "managed", note: "支持一键安装官方 macOS 包；账号与登录态保留在用户数据目录",
  },
  {
    id: "xianyu-auto-reply", name: "闲鱼客服", repo: "GuDong2003/xianyu-auto-reply-fix",
    homepage: "https://github.com/GuDong2003/xianyu-auto-reply-fix/releases/latest",
    current: async () => readTextVersion(join(xianyuRoot, "static", "version.txt")),
    policy: "managed", note: "使用官方热更新清单；保留 .env、数据库、登录态和用户配置",
  },
  {
    id: "wechat-mp-tools", name: "补充采集", repo: "x554960766/wechat-mp-tools",
    homepage: "https://github.com/x554960766/wechat-mp-tools/releases/latest",
    current: async () => readPythonVersion(join(runtimeRoot, "engines", "wechat-mp-tools-current", "backend", "config.py"), "APP_VERSION"),
    policy: "managed", note: "支持一键旁路安装；复用现有 Python 环境、登录态和数据目录",
  },
  {
    id: "wx-channels-download", name: "视频号卡片下载", repo: "ltaoo/wx_channels_download",
    homepage: "https://github.com/ltaoo/wx_channels_download/releases/latest",
    current: async () => readTextVersion(join(runtimeRoot, "engines", "wx-video-card", "VERSION")),
    policy: "manual", note: "已启用聊天窗口 JSAPI 修复；只提示高于当前版本的 Release",
  },
  {
    id: "ai-goofish-monitor", name: "闲鱼监控", repo: null,
    homepage: "https://github.com/Usagi-org/ai-goofish-monitor",
    current: async () => "f85d140",
    policy: "frozen", note: "上游已归档，继续固定当前已验证版本",
  },
];

async function readTextVersion(path) {
  try { return String(await readFile(path, "utf8")).trim() || "unknown"; } catch { return "missing"; }
}

async function readJsonVersion(path) {
  try { return String(JSON.parse(await readFile(path, "utf8")).version || "unknown"); } catch { return "missing"; }
}

async function readPlistVersion(path) {
  try {
    const text = await readFile(path, "utf8");
    return /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(text)?.[1] || "unknown";
  } catch { return "missing"; }
}

async function readPythonVersion(path, name) {
  try {
    const text = await readFile(path, "utf8");
    return new RegExp(`^\\s*${name}\\s*=\\s*["']([^"']+)["']`, "m").exec(text)?.[1] || "unknown";
  } catch { return "missing"; }
}

function normalizedVersion(value) {
  return String(value || "").trim().replace(/^v/i, "");
}

function releaseIsNewer(currentValue, latestValue) {
  const current = normalizedVersion(currentValue);
  const latest = normalizedVersion(latestValue);
  if (current === latest) return false;
  if (["", "missing", "unknown", "unavailable"].includes(current)) return true;

  // wx_channels_download 使用日期数字版本（260823），其他模块多为普通 semver。
  // 对纯数字版本逐段比较，防止当前热修复版高于 GitHub 的 latest stable 时
  // 被错误提示“更新”到旧版；无法可靠比较的标签仍沿用“不同即提示”。
  const numeric = /^\d+(?:[._-]\d+)*$/;
  if (!numeric.test(current) || !numeric.test(latest)) return true;
  const currentParts = current.split(/[._-]/).map(Number);
  const latestParts = latest.split(/[._-]/).map(Number);
  const length = Math.max(currentParts.length, latestParts.length);
  for (let index = 0; index < length; index += 1) {
    const left = currentParts[index] || 0;
    const right = latestParts[index] || 0;
    if (right !== left) return right > left;
  }
  return false;
}

async function latestGithubRelease(repo) {
  if (!repo) return null;
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "zhitai-update-check/1" },
      signal: AbortSignal.timeout(6_000),
    });
    if (response.ok) {
      const json = await response.json();
      return { version: String(json?.tag_name || "unknown"), publishedAt: json?.published_at || null };
    }
  } catch { /* GitHub API 限额时回退到官方 latest 重定向 */ }
  try {
    const response = await fetch(`https://github.com/${repo}/releases/latest`, {
      headers: { "User-Agent": "zhitai-update-check/1" },
      redirect: "follow",
      signal: AbortSignal.timeout(8_000),
    });
    const tag = /\/releases\/tag\/([^/?#]+)/.exec(response.url)?.[1];
    try { await response.body?.cancel(); } catch { /* noop */ }
    return tag ? { version: decodeURIComponent(tag), publishedAt: null } : null;
  } catch { return null; }
}

async function getModuleUpdates(force = false) {
  if (!force && moduleUpdateCache.modules.length && Date.now() - moduleUpdateCache.at < 15 * 60_000) {
    return moduleUpdateCache.modules;
  }
  const modules = await Promise.all(MODULE_UPDATE_DEFS.map(async (definition) => {
    const [current, release, blockedReason] = await Promise.all([
      definition.current(),
      latestGithubRelease(definition.repo),
      moduleUpdateBlocker(definition.id),
    ]);
    const latest = release?.version || (definition.policy === "frozen" ? current : "unavailable");
    const updateAvailable = definition.policy !== "frozen"
      && !["missing", "unknown", "unavailable"].includes(normalizedVersion(latest))
      && releaseIsNewer(current, latest);
    return {
      id: definition.id,
      name: definition.name,
      current,
      latest,
      updateAvailable,
      canInstall: updateAvailable && definition.policy === "managed" && !blockedReason,
      blockedReason,
      policy: definition.policy,
      note: definition.note,
      homepage: definition.homepage,
      publishedAt: release?.publishedAt || null,
    };
  }));
  moduleUpdateCache = { at: Date.now(), modules };
  return modules;
}

/**
 * A4.3-B：校验投递 ID（原版快点 okd[].m = 微信 MsgId，本机投递溯源键）。
 * - 缺失 / null / 空串 → { has:false }（等同未提供，不阻断）
 * - 非字符串 / 超长 / 含非法字符 → { has:true, valid:false }（调用方必须回 400 invalid_delivery_id，
 *   绝不静默置 null 落入非原子路径）
 * - 合法 → { has:true, valid:true, value }（只落 import_item.delivery_id，
 *   绝不进入平台 contentId/标题/sourceUrl）
 */
function validateDeliveryId(value) {
  if (value === undefined || value === null) return { has: false, valid: true, value: null };
  if (typeof value !== "string") return { has: true, valid: false, value: null };
  const raw = value.trim();
  if (!raw) return { has: false, valid: true, value: null };
  if (raw.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(raw)) {
    return { has: true, valid: false, value: null };
  }
  return { has: true, valid: true, value: raw };
}

function safeErrorCode(error) {
  return String(error instanceof Error ? error.message : error || "unknown_error")
    .replace(/https?:\/\/[^\s]+/g, "[url]")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(0, 120);
}

function safeMessage(value) {
  return String(value || "")
    .replace(/(cookie|token|authorization|secret|password)\s*[:=]\s*[^\s,;]+/gi, "$1=[redacted]")
    .replace(/https?:\/\/[^\s]+/g, "[url]")
    .slice(0, 500);
}

function sanitizeResult(result) {
  if (!result || typeof result !== "object") return { accepted: true };
  const allowed = ["success", "accepted", "message", "taskId", "job_id", "status"];
  return Object.fromEntries(allowed.filter((key) => key in result).map((key) => [key, result[key]]));
}
