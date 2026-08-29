"use client";


import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DesktopStatus } from "./DesktopStatus";
import { XianyuNative } from "./XianyuNative";
import { PublishNative } from "./PublishNative";
import {
  checkRuntimeConditions,
  openCreativeStudio,
  runCreativeJob,
  syncXBookmarks,
  zapi,
  type RuntimeCondition,
  type RuntimeConditionsResponse,
} from "./zapi";

type View =
  | "inbox"
  | "library"
  | "analysis"
  | "learning"
  | "messages"
  | "creative"
  | "publish"
  | "xianyu"
  | "updates";

type AgentState = "checking" | "online" | "offline";
type Platform = "视频号" | "公众号" | "抖音" | "小红书" | "X" | "未知来源";
type ServiceKey = "monitor" | "support" | "accounts" | "fileTransfer";
type PublishMode = "workbench_draft" | "platform_draft" | "publish";
type LibraryCategory = "素材" | "技能" | "其他" | "未分类";
type MetricValue = number | string | null;

type InteractionMetrics = {
  views: MetricValue;
  likes: MetricValue;
  favorites: MetricValue;
  comments: MetricValue;
  shares: MetricValue;
  capturedAt: string | null;
};

type RetentionPoint = { second: number; percent: number };
type ImportedComment = {
  id: string;
  author: string | null;
  content: string;
  likes: MetricValue;
  publishedAt: string | null;
  source: string | null;
};

type PerformanceEvidence = {
  avgWatchSeconds: number | null;
  completionRate: number | null;
  retention: RetentionPoint[];
  trafficSource: string | null;
  source: string | null;
  comments: ImportedComment[];
};

type TimedText = {
  id: string;
  startMs: number | null;
  endMs: number | null;
  text: string;
  speaker: string | null;
};

type ShotAnalysis = {
  id: string;
  time: string | null;
  framing: string | null;
  angle: string | null;
  movement: string | null;
  description: string | null;
  evidence: string | null;
};

type PropagationFactor = {
  id: string;
  title: string;
  evidence: string | null;
  confidence: string | null;
};

type EvidenceItem = {
  label: string;
  value: string;
  href: string | null;
};

type WorkbenchTask = {
  id: string;
  type: "ingest" | "publish" | string;
  platform: Platform;
  title: string;
  source: string;
  time: string;
  size: string;
  status: string;
  rawStatus: string;
  progress: number | null;
  createdAt: string | null;
  scheduledAt: string | null;
  targets: string[];
  mode: PublishMode | string | null;
  assetPath: string | null;
};

type LibraryItem = {
  id: string;
  platform: Platform;
  title: string;
  author: string | null;
  category: LibraryCategory;
  contentKind: string | null;
  meta: string;
  tags: string[];
  tone: string;
  packagePath: string | null;
  assetPath: string | null;
  coverUrl: string | null;
  previewUrl: string | null;
  sourceUrl: string | null;
  sizeBytes: number | null;
  createdAt: string | null;
  publishedAt: string | null;
  overview: string | null;
  overviewSource: "analysis" | "source" | null;
  metrics: InteractionMetrics;
  performance: PerformanceEvidence;
  transcript: TimedText[];
  transcriptText: string | null;
  transcriptStatus: string | null;
  transcriptNote: string | null;
  voiceover: string | null;
  copywriting: string | null;
  ocr: TimedText[];
  ocrStatus: string | null;
  ocrNote: string | null;
  shots: ShotAnalysis[];
  propagationFactors: PropagationFactor[];
  evidence: EvidenceItem[];
  analysisText: string;
  searchText: string;
  qualityState: string | null;
  qualityLabel: string | null;
  qualityReason: string | null;
  analysisReady: boolean;
  analysisCompletedAt: string | null;
  yuanbaoInsightAvailable: boolean;
};

type LocalService = {
  id: string;
  name: string;
  status: string;
  running: boolean;
  healthy: boolean;
  configured: boolean;
  setupAvailable: boolean;
  manageable: boolean;
  authenticationState: string | null;
  businessState: string | null;
  businessReady: boolean | null;
  detail: string;
  panelUrl: string | null;
};

type LocalEvent = {
  id: string;
  time: string;
  type: string;
  message: string;
  severity: string;
  source: string;
  occurredAt: string | null;
};

type HealthInfo = {
  knowledgeBase: string;
  queue: number;
  uptimeSeconds: number | null;
  webhookEnabled: boolean;
  adapters: Record<string, { enabled?: boolean; status?: string }>;
};

type AgentSnapshot = {
  health: HealthInfo;
  tasks: WorkbenchTask[];
  library: LibraryItem[];
  services: LocalService[];
  events: LocalEvent[];
  kuaidianCount: number;
};

type UpdateModule = {
  id: string;
  name: string;
  current: string;
  latest: string;
  updateAvailable: boolean;
  canInstall: boolean;
  blockedReason: string | null;
  policy: "manual" | "frozen" | string;
  note: string;
  homepage: string | null;
  publishedAt: string | null;
};

type CreativeJobStatus =
  | "queued"
  | "preparing"
  | "retry_wait"
  | "transient_wait"
  | "paused"
  | "needs_attention"
  | "ready_for_images"
  | "ready_for_seedance"
  | "ready_for_assembly"
  | "completed"
  | "failed"
  | "cancelled";

type CreativeResumeStatus = "queued" | "ready_for_images" | "ready_for_seedance" | "ready_for_assembly";

type CreativeJob = {
  id: string;
  assetId: string;
  title: string;
  status: CreativeJobStatus;
  stage: string;
  progress: number;
  targetDurationSeconds: number | null;
  shotCount: number | null;
  error: string | null;
  retryAt?: string | null;
  nextRetryAt?: string | null;
  resumeStatus?: CreativeResumeStatus | null;
  attentionAt?: string | null;
  attentionTransient?: boolean;
  transientRetryCount?: number;
  autoCreated: boolean;
  generationId?: string | null;
  outputMediaUrl?: string | null;
  qualityWarnings?: string[];
  createdAt: string;
  updatedAt: string;
};

const CREATIVE_RUNNABLE_STATUSES = new Set<CreativeJobStatus>(["ready_for_images", "ready_for_seedance"]);
const CREATIVE_BATCH_STARTABLE_STATUSES = new Set<CreativeJobStatus>(["queued", "preparing", "retry_wait", ...CREATIVE_RUNNABLE_STATUSES]);
const CREATIVE_PREPARING_STATUSES = new Set<CreativeJobStatus>(["queued", "preparing", "retry_wait"]);
const CREATIVE_ACTIVE_STATUSES = new Set<CreativeJobStatus>([...CREATIVE_PREPARING_STATUSES, "transient_wait"]);
const CREATIVE_POLL_STOP_STATUSES = new Set<CreativeJobStatus>([
  "transient_wait", "needs_attention", "paused", "failed", "cancelled", "completed",
  "ready_for_images", "ready_for_seedance", "ready_for_assembly",
]);
const CREATIVE_MANUAL_ATTENTION_STATUSES = new Set<CreativeJobStatus>(["failed", "paused", "ready_for_assembly", "needs_attention"]);
const CREATIVE_NO_DUPLICATE_START_STATUSES = new Set<CreativeJobStatus>(["transient_wait", "needs_attention", "failed"]);

function creativeJobStatusText(job: Pick<CreativeJob, "status">): string {
  return ({
    queued: "排队中",
    preparing: "本机准备中",
    retry_wait: "分析短暂等待，自动重试",
    transient_wait: "短暂等待，自动重试",
    paused: "已暂停",
    needs_attention: "需处理",
    ready_for_images: "待 GPT 生图",
    ready_for_seedance: "待豆包生成",
    ready_for_assembly: "待拼接验收",
    completed: "已完成",
    failed: "需重试",
    cancelled: "已取消",
  } satisfies Record<CreativeJobStatus, string>)[job.status] || "状态待核实";
}

function formatCreativeBeijingTime(value: string | null | undefined): string | null {
  const timestamp = Date.parse(String(value || ""));
  if (!Number.isFinite(timestamp)) return null;
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(timestamp));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")} ${part("hour")}:${part("minute")}:${part("second")}`;
}

function creativeJobRetryText(job: Pick<CreativeJob, "status" | "nextRetryAt">): string | null {
  if (job.status !== "transient_wait") return null;
  const retryAt = formatCreativeBeijingTime(job.nextRetryAt);
  return retryAt
    ? `下一次自动重试：北京时间 ${retryAt}`
    : "下一次自动重试：等待本地节点回传时间";
}

function creativeJobResumeText(job: Pick<CreativeJob, "status" | "resumeStatus">): string | null {
  if (!["transient_wait", "needs_attention"].includes(job.status)) return null;
  const stage = ({
    queued: "素材分析",
    ready_for_images: "GPT 生图",
    ready_for_seedance: "豆包生成",
    ready_for_assembly: "本机拼接",
  } satisfies Record<CreativeResumeStatus, string>)[job.resumeStatus || "queued"];
  return `恢复后从${stage}原断点继续，不会新建任务`;
}

function creativeJobErrorLabel(status: CreativeJobStatus): string {
  if (status === "transient_wait") return "等待原因";
  if (status === "needs_attention") return "处理原因";
  return status === "failed" ? "失败原因" : "提示";
}

function isCreativeRunnableStatus(status: CreativeJobStatus): boolean { return CREATIVE_RUNNABLE_STATUSES.has(status); }
function isCreativeBatchStartableStatus(status: CreativeJobStatus): boolean { return CREATIVE_BATCH_STARTABLE_STATUSES.has(status); }
function isCreativePreparingStatus(status: CreativeJobStatus): boolean { return CREATIVE_PREPARING_STATUSES.has(status); }
function isCreativeActiveStatus(status: CreativeJobStatus): boolean { return CREATIVE_ACTIVE_STATUSES.has(status); }
function isCreativePollStopStatus(status: CreativeJobStatus): boolean { return CREATIVE_POLL_STOP_STATUSES.has(status); }
function isCreativeManualAttentionStatus(status: CreativeJobStatus): boolean { return CREATIVE_MANUAL_ATTENTION_STATUSES.has(status); }
function isCreativeNoDuplicateStartStatus(status: CreativeJobStatus): boolean { return CREATIVE_NO_DUPLICATE_START_STATUSES.has(status); }
function isCreativeOperationWindowOpen(value: Date | string | number = new Date()): boolean {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  const hour = Number(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    hourCycle: "h23",
  }).format(date));
  return hour >= 8 && hour < 19;
}

const LOCAL_AGENT_URL = "http://127.0.0.1:17890";

const serviceAliases: Record<ServiceKey, string[]> = {
  monitor: ["ai_goofish_monitor", "ai-goofish-monitor", "goofish-monitor", "monitor"],
  support: ["xianyu_auto_agent", "xianyu-auto-agent", "xianyuautoagent", "support"],
  accounts: ["xianyu_auto_reply_fix", "xianyu-auto-reply-fix", "accounts", "multi-account"],
  fileTransfer: ["filehelper_web", "pywechat_file_transfer", "windows-file-transfer", "file-transfer-assistant", "file-transfer"],
};

const defaultServiceIds: Record<ServiceKey, string> = {
  monitor: "ai_goofish_monitor",
  support: "xianyu_auto_agent",
  accounts: "xianyu_auto_reply_fix",
  fileTransfer: "filehelper_web",
};

const platformCodes: Record<string, string> = {
  抖音: "douyin",
  小红书: "xiaohongshu",
  视频号: "wechat_channels",
  公众号: "wechat_official_account",
};

const navItems: Array<{ id: View; label: string; icon: string }> = [
  { id: "inbox", label: "下载", icon: "↓" },
  { id: "library", label: "知识库", icon: "▦" },
  { id: "analysis", label: "视频分析", icon: "◎" },
  { id: "learning", label: "每日学习", icon: "✓" },
  { id: "messages", label: "消息中心", icon: "◌" },
  { id: "creative", label: "豆包创作", icon: "✦" },
  { id: "publish", label: "发布中心", icon: "↗" },
  { id: "xianyu", label: "闲鱼", icon: "◇" },
  { id: "updates", label: "模块更新", icon: "↻" },
];

const viewMeta: Record<View, { eyebrow: string; title: string; description: string }> = {
  inbox: {
    eyebrow: "内容采集",
    title: "下载",
    description: "主入口：微信文件传输助手；ClawBot 保留备用直链采集与手机控制。",
  },
  library: {
    eyebrow: "本地知识库",
    title: "知识库",
    description: "视频、封面、字幕、元数据与原始链接统一归档。",
  },
  analysis: {
    eyebrow: "本地视频分析",
    title: "视频分析",
    description: "复用 mcp-video-analyzer：转写、关键帧、OCR 与媒体元数据。",
  },
  learning: {
    eyebrow: "知识整理",
    title: "每日学习",
    description: "技能与其他内容自动整理成当天清单；素材保留给一键复刻。",
  },
  messages: {
    eyebrow: "手机控制与通知",
    title: "消息中心",
    description: "ClawBot 遥控织台；每日学习、入库摘要和异常可靠推送到手机。",
  },
  creative: {
    eyebrow: "AI 视频制作",
    title: "豆包创作",
    description: "GPT 生成分镜图，再用豆包 Seedance 2.0 逐镜生成视频。",
  },
  publish: {
    eyebrow: "内容分发",
    title: "发布中心",
    description: "在织台内扫码登录；从内容包创建草稿与发布任务。",
  },
  xianyu: {
    eyebrow: "交易自动化",
    title: "闲鱼",
    description: "监控与多账号引擎分栏管理；XianyuAutoAgent 仅备选。",
  },
  updates: {
    eyebrow: "本地模块管理",
    title: "模块更新",
    description: "只检查官方稳定版；不静默更新，不再启动外部 GUI。",
  },
};

const connectorProjects = [
  {
    name: "openclaw-weixin",
    role: "备用直链收件与手机遥控",
    description: "腾讯官方 iLink 长轮询通道。文件传输助手是必需主入口；ClawBot 可备用提交直链、执行固定遥控命令与审核，不调用 AI。",
    href: "https://github.com/Tencent/openclaw-weixin",
    status: "建议",
    tag: "备用收件",
  },
  {
    name: "wechat-mp-tools",
    role: "微信与抖音内容采集",
    description: "覆盖公众号、视频号分享链接与抖音。功能完整但项目较新，适合作为可替换适配器。",
    href: "https://github.com/x554960766/wechat-mp-tools",
    status: "候选",
    tag: "采集",
  },
  {
    name: "douyin-downloader",
    role: "抖音下载服务",
    description: "本地 REST 下载器，支持视频、图文、合集与主页，带去重和验证码人工降级。",
    href: "https://github.com/jiji262/douyin-downloader",
    status: "首选",
    tag: "采集",
  },
  {
    name: "ai-goofish-monitor",
    role: "闲鱼商品监控",
    description: "关键词、价格、地区与 AI 筛选均较完整；仓库已归档，需固定安全修复提交自行构建。",
    href: "https://github.com/Usagi-org/ai-goofish-monitor",
    status: "已归档",
    tag: "闲鱼",
  },
  {
    name: "xianyu-auto-reply-fix",
    role: "闲鱼客服与多账号",
    description: "三款工具中功能最全、维护最活跃；接入前必须修复认证、日志与公网端口风险。",
    href: "https://github.com/GuDong2003/xianyu-auto-reply-fix",
    status: "需加固",
    tag: "闲鱼",
  },
  {
    name: "XianyuAutoAgent",
    role: "闲鱼智能客服原型",
    description: "单账号对话与阶梯议价原型。不要和多账号客服在同一账号上并行运行。",
    href: "https://github.com/shaxiu/XianyuAutoAgent",
    status: "原型",
    tag: "闲鱼",
  },
  {
    name: "MatrixMedia",
    role: "多平台发布",
    description: "覆盖抖音、小红书、视频号等，具备 GUI、CLI、MCP 与多平台发布接口。仅通过本地进程隔离接入。",
    href: "https://github.com/hanliang97/MatrixMedia",
    status: "首选",
    tag: "发布",
  },
];

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function collectionFrom(payload: unknown, key: string): Record<string, unknown>[] {
  if (Array.isArray(payload)) return payload.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item));
  const root = asRecord(payload);
  if (!root) return [];
  const nested = root[key];
  if (Array.isArray(nested)) return nested.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item));
  const nestedRecord = asRecord(nested);
  if (!nestedRecord) return [];
  return Object.entries(nestedRecord).map(([id, value]) => ({ id, ...(asRecord(value) ?? {}) }));
}

function formatBytes(value: number | null): string {
  if (value === null || value < 0) return "—";
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && size >= 1024; index += 1) {
    size /= 1024;
    unit = units[index];
  }
  return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${unit}`;
}

function formatDuration(milliseconds: number | null): string | null {
  if (milliseconds === null || milliseconds < 0) return null;
  const totalSeconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatClock(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function localDateKey(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function formatSchedule(value: string | null): { date: string; time: string } {
  if (!value) return { date: "未排期", time: "" };
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return { date: value, time: "" };
  return {
    date: date.toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" }),
    time: date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
  };
}

function webUrlFromValue(value: string): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function hostnameFromUrl(value: string): string | null {
  const url = webUrlFromValue(value);
  if (!url || url.username || url.password) return null;
  return url.hostname.toLowerCase();
}

function platformFromWebUrl(value: string): Platform | null {
  const hostname = hostnameFromUrl(value);
  if (!hostname) return null;
  if (["x.com", "www.x.com", "twitter.com", "www.twitter.com"].includes(hostname)) return "X";
  if (["douyin.com", "www.douyin.com", "v.douyin.com"].includes(hostname)) return "抖音";
  if (["xiaohongshu.com", "www.xiaohongshu.com", "xhslink.com"].includes(hostname)) return "小红书";
  if (hostname === "mp.weixin.qq.com") return "公众号";
  if (hostname === "weixin.qq.com" || hostname === "channels.weixin.qq.com") return "视频号";
  return null;
}

function inferPlatform(value: string): Platform {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  for (const part of parts) {
    const urlPlatform = platformFromWebUrl(part);
    if (urlPlatform) return urlPlatform;
  }

  // URL 已在上方按精确 hostname 处理；其 query/path 不参与平台标签推断。
  const labels = parts.filter((part) => !webUrlFromValue(part)).map((part) => part.toLowerCase());
  const labelText = labels.join(" ");
  const exactLabels = new Set(labels);
  const identifiers = new Set(labels.flatMap((label) => label.split(/[^a-z0-9]+/).filter(Boolean)));
  if (exactLabels.has("x") || exactLabels.has("twitter") || exactLabels.has("x-bookmarks") || exactLabels.has("x_bookmarks")) return "X";
  if (labelText.includes("抖音") || identifiers.has("douyin")) return "抖音";
  if (labelText.includes("小红书") || identifiers.has("xiaohongshu") || identifiers.has("xhslink")) return "小红书";
  if (labelText.includes("公众号") || exactLabels.has("mp.weixin") || exactLabels.has("official_account")
    || exactLabels.has("wechat_official") || exactLabels.has("wechat_official_account")) return "公众号";
  if (labelText.includes("视频号") || identifiers.has("channel") || identifiers.has("channels")
    || identifiers.has("finder") || identifiers.has("weixin") || identifiers.has("wechat")) return "视频号";
  return "未知来源";
}

function displayStatus(rawStatus: string, hasPackage = false): string {
  const status = rawStatus.toLowerCase();
  if (status === "completed" || status === "success" || status === "succeeded") return hasPackage ? "已入库" : "已完成";
  if (status === "queued" || status === "accepted" || status === "pending") return "排队中";
  if (status === "running" || status === "downloading") return "处理中";
  if (status === "processing") return "处理中";
  if (status === "needs_setup" || status === "missing") return "待配置";
  if (status === "needs_login") return "需重新登录";
  if (status === "not_installed") return "未安装";
  if (status === "source_ready") return "源码就绪";
  if (status === "unconfigured") return "待配置";
  if (status === "drifted" || status === "invalid") return "需校验";
  if (status === "awaiting_approval" || status === "needs_approval") return "待确认";
  if (status === "scheduled") return "已排期";
  if (status === "platform_draft") return "平台草稿";
  if (status === "workbench_draft" || status === "draft") return "草稿";
  if (status === "failed" || status === "crashed" || status === "error") return "失败";
  if (status === "needs_attention" || status === "degraded") return "需处理";
  return rawStatus || "未知";
}

function normalizeTask(raw: Record<string, unknown>): WorkbenchTask {
  const metadata = asRecord(raw.metadata);
  const output = asRecord(raw.output) ?? asRecord(raw.result);
  const sourceUrl = asString(raw.sourceUrl) ?? asString(raw.url) ?? "";
  const adapter = asString(raw.adapter) ?? "";
  const type = asString(raw.type) ?? "ingest";
  const packagePath = asString(raw.packagePath) ?? asString(output?.packagePath);
  const assetPath = asString(raw.assetPath) ?? asString(output?.assetPath) ?? asString(output?.original);
  const rawStatus = asString(raw.status) ?? "unknown";
  const title = asString(raw.title) ?? asString(metadata?.title) ?? (sourceUrl ? sourceUrl : `${type} 任务`);
  const sizeBytes = asNumber(raw.sizeBytes) ?? asNumber(output?.sizeBytes);
  const createdAt = asString(raw.createdAt);
  const rawTargets = Array.isArray(raw.targets) ? raw.targets : [];
  const targets = rawTargets
    .map((target) => asString(asRecord(target)?.platform) ?? asString(target))
    .filter((target): target is string => Boolean(target));
  const rawProgress = asNumber(raw.progress) ?? asNumber(output?.progress);
  const progress = rawProgress === null
    ? (["completed", "success", "succeeded"].includes(rawStatus.toLowerCase()) ? 100 : null)
    : Math.max(0, Math.min(100, rawProgress));

  return {
    id: asString(raw.id) ?? `${type}-${createdAt ?? sourceUrl}`,
    type,
    platform: inferPlatform(`${asString(raw.platform) ?? ""} ${adapter} ${sourceUrl} ${targets.join(" ")}`),
    title,
    source: asString(raw.source) ?? asString(raw.ingress) ?? hostnameFromUrl(sourceUrl) ?? "本地节点",
    time: formatClock(createdAt),
    size: asString(raw.size) ?? formatBytes(sizeBytes),
    status: displayStatus(rawStatus, Boolean(packagePath)),
    rawStatus,
    progress,
    createdAt,
    scheduledAt: asString(raw.scheduledAt),
    targets,
    mode: asString(raw.mode),
    assetPath,
  };
}

function firstValue(records: Array<Record<string, unknown> | null>, keys: string[]): unknown {
  for (const record of records) {
    if (!record) continue;
    for (const key of keys) {
      const value = record[key];
      if (value !== null && value !== undefined && value !== "") return value;
    }
  }
  return null;
}

function firstString(records: Array<Record<string, unknown> | null>, keys: string[]): string | null {
  return asString(firstValue(records, keys));
}

function stringList(value: unknown): string[] {
  if (typeof value === "string") {
    return value
      .split(/[,，、\n]/)
      .map((item) => item.replace(/^#/, "").trim())
      .filter(Boolean);
  }
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => asString(item) ?? asString(asRecord(item)?.name) ?? asString(asRecord(item)?.label))
    .filter((item): item is string => Boolean(item))
    .map((item) => item.replace(/^#/, "").trim())
    .filter(Boolean);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeDateValue(value: unknown): string | null {
  const numeric = asNumber(value);
  if (numeric !== null && (typeof value === "number" || /^\d+(?:\.\d+)?$/.test(String(value)))) {
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return asString(value);
}

function normalizeMetric(value: unknown): MetricValue {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const text = asString(value);
  if (!text || ["null", "undefined", "—", "-"].includes(text.toLowerCase())) return null;
  const parsed = Number(text.replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : text;
}

function normalizeMediaUrl(value: unknown, allowImageData = false): string | null {
  const candidate = asString(value);
  if (!candidate) return null;
  if (candidate.startsWith("/")) return `${LOCAL_AGENT_URL}${candidate}`;
  if (/^api\//i.test(candidate)) return `${LOCAL_AGENT_URL}/${candidate}`;
  if (/^https?:\/\//i.test(candidate) || /^blob:/i.test(candidate)) return candidate;
  if (allowImageData && /^data:image\//i.test(candidate)) return candidate;
  return null;
}

function inferLibraryCategory(rawCategory: string | null, packagePath: string | null): LibraryCategory {
  const explicit = rawCategory?.trim();
  if (explicit === "素材" || explicit === "技能" || explicit === "其他") return explicit;
  if (explicit === "未分类") return "未分类";
  const pathMatch = packagePath?.match(/[\\/]内容库[\\/](素材|技能|其他)(?:[\\/]|$)/);
  if (pathMatch?.[1] === "素材" || pathMatch?.[1] === "技能" || pathMatch?.[1] === "其他") return pathMatch[1];
  return explicit ? "其他" : "未分类";
}

function flattenText(value: unknown, depth = 0): string {
  if (depth > 4 || value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map((item) => flattenText(item, depth + 1)).filter(Boolean).join(" ");
  const record = asRecord(value);
  if (!record) return "";
  return Object.values(record).map((item) => flattenText(item, depth + 1)).filter(Boolean).join(" ");
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const text = value.trim();
  if (!text || (!text.startsWith("[") && !text.startsWith("{"))) return value;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return value;
  }
}

function timestampToMilliseconds(value: unknown): number | null {
  const numeric = asNumber(value);
  if (numeric !== null) return numeric < 10_000 ? numeric * 1000 : numeric;
  const text = asString(value);
  if (!text) return null;
  const parts = text.split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 2) return Math.round((parts[0] * 60 + parts[1]) * 1000);
  if (parts.length === 3) return Math.round((parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000);
  return null;
}

function normalizeTimedText(value: unknown, prefix: string): TimedText[] {
  const root = asRecord(value);
  const parsedSegments = parseJsonValue(root?.segments);
  const parsedItems = parseJsonValue(root?.items);
  const items = Array.isArray(parseJsonValue(value))
    ? (parseJsonValue(value) as unknown[])
    : Array.isArray(parsedSegments)
      ? parsedSegments
      : Array.isArray(parsedItems)
        ? parsedItems
        : [];
  return items.flatMap((item, index) => {
    if (typeof item === "string") {
      const text = asString(item);
      return text ? [{ id: `${prefix}-${index}`, startMs: null, endMs: null, text, speaker: null }] : [];
    }
    const record = asRecord(item);
    if (!record) return [];
    const text = firstString([record], ["text", "content", "words", "caption", "transcript"]);
    if (!text) return [];
    return [{
      id: asString(record.id) ?? `${prefix}-${index}`,
      startMs: timestampToMilliseconds(firstValue([record], ["startMs", "start_ms", "start", "from", "timestamp"])),
      endMs: timestampToMilliseconds(firstValue([record], ["endMs", "end_ms", "end", "to"])),
      text,
      speaker: firstString([record], ["speaker", "role", "voice"]),
    }];
  });
}

function normalizeShots(value: unknown): ShotAnalysis[] {
  const root = asRecord(value);
  const items = Array.isArray(value)
    ? value
    : Array.isArray(root?.shots)
      ? root.shots
      : Array.isArray(root?.items)
        ? root.items
        : [];
  return items.flatMap((item, index) => {
    if (typeof item === "string") {
      const description = asString(item);
      return description ? [{ id: `shot-${index}`, time: null, framing: null, angle: null, movement: null, description, evidence: null }] : [];
    }
    const record = asRecord(item);
    if (!record) return [];
    const start = timestampToMilliseconds(firstValue([record], ["startMs", "start_ms", "start", "timestamp"]));
    const end = timestampToMilliseconds(firstValue([record], ["endMs", "end_ms", "end"]));
    const explicitTime = firstString([record], ["time", "timecode", "range"]);
    const time = explicitTime ?? (start !== null ? `${formatTimecode(start)}${end !== null ? `–${formatTimecode(end)}` : ""}` : null);
    const description = firstString([record], ["description", "summary", "content", "action", "scene"]);
    const framing = firstString([record], ["framing", "shotSize", "shot_size", "composition", "景别"]);
    const angle = firstString([record], ["angle", "cameraAngle", "camera_angle", "拍摄角度"]);
    const movement = firstString([record], ["movement", "cameraMovement", "camera_movement", "运镜"]);
    const evidence = firstString([record], ["evidence", "basis", "observation", "依据"]);
    if (!description && !framing && !angle && !movement && !evidence) return [];
    return [{ id: asString(record.id) ?? `shot-${index}`, time, framing, angle, movement, description, evidence }];
  });
}

function normalizeFactors(value: unknown): PropagationFactor[] {
  const root = asRecord(value);
  const parsedFactors = parseJsonValue(root?.factors ?? root?.hypotheses);
  const parsedItems = parseJsonValue(root?.items);
  const parsedValue = parseJsonValue(value);
  const items = Array.isArray(parsedValue)
    ? parsedValue
    : Array.isArray(parsedFactors)
      ? parsedFactors
      : Array.isArray(parsedItems)
        ? parsedItems
        : [];
  return items.flatMap((item, index) => {
    if (typeof item === "string") {
      const title = asString(item);
      return title ? [{ id: `factor-${index}`, title, evidence: null, confidence: null }] : [];
    }
    const record = asRecord(item);
    if (!record) return [];
    const title = firstString([record], ["title", "factor", "name", "reason", "label", "claim"]);
    if (!title) return [];
    return [{
      id: asString(record.id) ?? `factor-${index}`,
      title,
      evidence: firstString([record], ["evidence", "basis", "explanation", "detail", "依据"]),
      confidence: firstString([record], ["confidence", "certainty", "置信度"]),
    }];
  });
}

function formatTimecode(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function normalizeLibraryItem(raw: Record<string, unknown>, index: number): LibraryItem {
  const kbAsset = asRecord(raw.asset);
  // backend 详情以 platform_posts 数组 + latest_post 为准（不再只读旧的 platform_post 单数）
  const platformPosts = Array.isArray(raw.platform_posts)
    ? raw.platform_posts.map(asRecord).filter((snapshot): snapshot is Record<string, unknown> => Boolean(snapshot))
    : [];
  const platformPost = asRecord(raw.latest_post) ?? platformPosts[0] ?? asRecord(raw.platform_post);
  const contentAnalysis = asRecord(raw.content_analysis);
  const viralityAnalysis = asRecord(raw.virality_analysis);
  const transcriptRecord = asRecord(raw.transcript);
  const ocrRecord = asRecord(raw.ocr);
  const remakePlanEnvelope = asRecord(raw.remake_plan);
  const remakePlan = asRecord(remakePlanEnvelope?.plan);
  const remakeCopy = asRecord(remakePlan?.copywriting);
  const seedanceWorkflow = asRecord(remakePlan?.seedanceWorkflow);
  const yuanbaoInsight = asRecord(remakePlan?.yuanbaoInsight);
  const assets = asRecord(raw.assets);
  const metadata = asRecord(raw.metadata);
  const upstream = platformPost ?? asRecord(raw.upstream) ?? asRecord(raw.sourceMetadata);
  const analysis = contentAnalysis ?? asRecord(raw.analysis) ?? asRecord(raw.enrichment) ?? asRecord(raw.insights);
  const metricSnapshots = Array.isArray(raw.metric_snapshots)
    ? raw.metric_snapshots.map(asRecord).filter((snapshot): snapshot is Record<string, unknown> => Boolean(snapshot))
    : [];
  const latestMetricSnapshot = metricSnapshots.at(-1) ?? null;
  const quality = asRecord(raw.quality) ?? asRecord(kbAsset?.quality);
  const stats = latestMetricSnapshot ?? asRecord(raw.metrics) ?? asRecord(raw.stats) ?? asRecord(upstream?.stats) ?? asRecord(metadata?.stats);
  const files = Array.isArray(raw.files)
    ? raw.files.map(asRecord).filter((file): file is Record<string, unknown> => Boolean(file))
    : [];
  const originalFile = files.find((file) => {
    const role = `${asString(file.role) ?? ""} ${asString(file.kind) ?? ""} ${asString(file.type) ?? ""}`.toLowerCase();
    return role.includes("original") || role.includes("video") || role.includes("media");
  }) ?? files.find((file) => /\.(mp4|mov|m4v|webm)$/i.test(asString(file.path) ?? "")) ?? files[0];
  const coverFile = files.find((file) => {
    const role = `${asString(file.role) ?? ""} ${asString(file.kind) ?? ""} ${asString(file.type) ?? ""} ${asString(file.path) ?? ""}`.toLowerCase();
    return role.includes("cover") || role.includes("thumbnail") || /\.(jpe?g|png|webp|avif)$/i.test(role);
  });
  const sizeBytes = asNumber(raw.sizeBytes) ?? asNumber(raw.size_bytes) ?? asNumber(kbAsset?.size_bytes) ?? asNumber(assets?.sizeBytes);
  const durationMs = asNumber(raw.durationMs) ?? asNumber(raw.duration_ms) ?? asNumber(kbAsset?.duration_ms) ?? asNumber(assets?.durationMs) ?? asNumber(metadata?.durationMs);
  const packagePath = asString(raw.packagePath) ?? asString(raw.package_path) ?? asString(kbAsset?.package_path) ?? asString(raw.path);
  const filePath = asString(originalFile?.path);
  const fileIsExternal = asBoolean(originalFile?.external) ?? false;
  const resolvedFilePath = filePath && packagePath && !fileIsExternal && !filePath.startsWith("/")
    ? `${packagePath.replace(/\/$/, "")}/${filePath}`
    : filePath;
  const assetPath = asString(raw.assetPath) ?? asString(kbAsset?.file_path) ?? asString(assets?.original) ?? asString(assets?.video) ?? resolvedFilePath;
  const sourceUrl = firstString([raw, kbAsset, upstream, metadata], ["sourceUrl", "source_url", "url", "shareUrl", "share_url"]);
  const platform = inferPlatform(`${asString(raw.platform) ?? ""} ${sourceUrl}`);
  const title = firstString([raw, kbAsset, upstream, metadata], ["title", "caption"]) ?? packagePath?.split("/").filter(Boolean).at(-1) ?? "未命名内容包";
  const sourceDescription = firstString([raw, metadata, asRecord(raw.source)], ["description", "caption", "content", "text"]);
  const analysisOverview = firstString([analysis], ["summary", "overview", "abstract", "synopsis"]);
  const author = firstString([raw, upstream, metadata], ["author", "authorName", "author_name", "nickname", "creator", "owner"]);
  const rawTags = [
    ...stringList(raw.tags),
    ...stringList(parseJsonValue(upstream?.topics)),
    ...stringList(metadata?.tags),
    ...stringList(analysis?.tags),
    ...stringList(analysis?.keywords ?? analysis?.key_points),
    ...[...`${title} ${sourceDescription ?? ""}`.matchAll(/#([^#\s，。！？,.!?:：；;]+)/g)].map((match) => match[1]),
  ];
  const tags = uniqueStrings(rawTags);
  const category = inferLibraryCategory(firstString([raw, kbAsset, metadata, analysis], ["category", "classification", "bucket"]), packagePath);
  const coverUrl = normalizeMediaUrl(
    firstValue([raw, platformPost, assets], ["coverUrl", "cover_url", "thumbnailUrl", "thumbnail_url"])
      ?? firstValue([coverFile ?? null], ["previewUrl", "url", "downloadUrl"]),
    true,
  );
  const previewUrl = normalizeMediaUrl(
    firstValue([raw, assets], ["previewUrl", "preview_url", "videoUrl", "video_url", "mediaUrl", "media_url", "streamUrl"])
      ?? firstValue([originalFile ?? null], ["previewUrl", "url", "downloadUrl"]),
  );
  const publishedAt = normalizeDateValue(firstValue([raw, upstream, metadata], ["publishedAt", "published_at", "publishTime", "publish_time", "createTime", "createtime"]));
  const createdAt = normalizeDateValue(firstValue([raw, kbAsset], ["createdAt", "created_at", "ingestedAt", "capturedAt", "captured_at"]));
  const metrics: InteractionMetrics = {
    views: normalizeMetric(firstValue([stats, raw, upstream], ["views", "viewCount", "view_count", "plays", "playCount", "play_count", "readCount"])),
    likes: normalizeMetric(firstValue([stats, raw, upstream], ["likes", "likeCount", "like_count", "likedCount"])),
    favorites: normalizeMetric(firstValue([stats, raw, upstream], ["favorites", "favoriteCount", "favorite_count", "collectCount", "collect_count", "favCount"])),
    comments: normalizeMetric(firstValue([stats, raw, upstream], ["comments", "commentCount", "comment_count"])),
    shares: normalizeMetric(firstValue([stats, raw, upstream], ["shares", "shareCount", "share_count", "forwards", "forwardCount", "forward_count"])),
    capturedAt: normalizeDateValue(firstValue([stats, raw], ["capturedAt", "captured_at", "snapshotAt", "snapshot_at", "metricsCapturedAt"])),
  };
  const retentionRaw = parseJsonValue(firstValue([latestMetricSnapshot], ["retention", "retention_json"]));
  const retention: RetentionPoint[] = Array.isArray(retentionRaw)
    ? retentionRaw.flatMap((entry) => {
      const row = asRecord(entry);
      const second = asNumber(row?.second ?? row?.seconds ?? row?.time);
      const percent = asNumber(row?.percent ?? row?.retention ?? row?.rate);
      return second === null || percent === null ? [] : [{ second, percent }];
    })
    : [];
  const importedComments: ImportedComment[] = Array.isArray(raw.comment_items)
    ? raw.comment_items.flatMap((entry, commentIndex) => {
      const row = asRecord(entry);
      const content = asString(row?.content ?? row?.text);
      if (!content) return [];
      return [{
        id: asString(row?.id) ?? `comment-${commentIndex}`,
        author: asString(row?.author),
        content,
        likes: normalizeMetric(row?.likes),
        publishedAt: normalizeDateValue(row?.published_at ?? row?.publishedAt),
        source: asString(row?.source),
      }];
    })
    : [];
  const performance: PerformanceEvidence = {
    avgWatchSeconds: asNumber(latestMetricSnapshot?.avg_watch_seconds ?? latestMetricSnapshot?.avgWatchSeconds),
    completionRate: asNumber(latestMetricSnapshot?.completion_rate ?? latestMetricSnapshot?.completionRate),
    retention,
    trafficSource: asString(latestMetricSnapshot?.traffic_source ?? latestMetricSnapshot?.trafficSource),
    source: asString(latestMetricSnapshot?.source),
    comments: importedComments,
  };
  const transcriptSource = transcriptRecord ?? firstValue([analysis, raw, metadata], ["transcript", "transcription", "asr", "speechToText", "speech_to_text"]);
  const transcript = normalizeTimedText(transcriptSource, "transcript");
  const transcriptText = typeof transcriptSource === "string"
    ? asString(transcriptSource)
    : firstString([asRecord(transcriptSource), analysis, raw], ["text", "fullText", "full_text", "transcriptText"])
      ?? (transcript.length ? transcript.map((segment) => segment.text).join("\n") : null);
  const voiceover = firstString([analysis, raw, metadata], ["voiceover", "voiceOver", "narration", "dub", "配音"])
    ?? firstString([remakeCopy], ["voiceoverDraft", "voiceover", "narration"]);
  const copywriting = firstString([analysis, raw, metadata], ["copywriting", "copy", "script", "captionText", "文案"])
    ?? firstString([remakeCopy], ["publishCopy", "subtitleDraft", "caption"]);
  const ocrSource = ocrRecord
    ? { ...ocrRecord, items: parseJsonValue(ocrRecord.items) }
    : firstValue([analysis, raw], ["ocr", "onscreenText", "on_screen_text", "screenText"]);
  const ocr = normalizeTimedText(ocrSource, "ocr");
  const shotsSource = Array.isArray(raw.shots) ? raw.shots : firstValue([analysis, raw], ["shots", "shotAnalysis", "shot_analysis", "cameraAnalysis", "camera_analysis", "scenes"]);
  const shots = normalizeShots(shotsSource);
  const factorsSource = viralityAnalysis ?? firstValue([analysis, raw], ["propagationFactors", "propagation_factors", "viralFactors", "viral_factors", "whyItWorks", "whyPopular", "爆款因素"]);
  const propagationFactors = normalizeFactors(factorsSource);
  const meta = [formatDuration(durationMs), formatBytes(sizeBytes), packagePath]
    .filter((value): value is string => Boolean(value) && value !== "—")
    .join(" · ");
  const tones = ["mint", "sand", "coral", "lavender", "blue", "lime"];
  const evidence: EvidenceItem[] = [];
  if (sourceUrl) evidence.push({ label: "原始链接", value: sourceUrl, href: /^https?:\/\//i.test(sourceUrl) ? sourceUrl : null });
  if (createdAt) evidence.push({ label: "采集时间", value: createdAt, href: null });
  if (metrics.capturedAt) evidence.push({ label: "互动数据快照", value: metrics.capturedAt, href: null });
  if (packagePath) evidence.push({ label: "内容包目录", value: packagePath, href: null });
  const assetSha256 = firstString([raw, kbAsset], ["sha256", "checksum"]);
  if (assetSha256) evidence.push({ label: "视频文件 SHA-256", value: assetSha256, href: null });
  files.forEach((file, fileIndex) => {
    const sha256 = firstString([file], ["sha256", "checksum"]);
    const path = firstString([file], ["path", "name"]);
    if (sha256) evidence.push({ label: path ? `文件校验 · ${path}` : `文件校验 ${fileIndex + 1}`, value: sha256, href: null });
  });
  const provenance = Array.isArray(raw.field_provenance)
    ? raw.field_provenance.map(asRecord).filter((entry): entry is Record<string, unknown> => Boolean(entry))
    : [];
  provenance.forEach((entry) => {
    const field = firstString([entry], ["field", "name"]);
    const source = firstString([entry], ["source", "provider"]);
    const limitation = firstString([entry], ["limitation", "note"]);
    if (field && source) evidence.push({ label: `字段来源 · ${field}`, value: `${source}${limitation ? ` · ${limitation}` : ""}`, href: null });
  });
  const analysisText = [flattenText(analysis), flattenText(viralityAnalysis), flattenText(raw.knowledge_chunks)].filter(Boolean).join(" ");
  const searchText = [title, author, platform, category, ...tags, analysisText, transcriptText, voiceover, copywriting, flattenText(ocr), flattenText(shots), flattenText(propagationFactors)]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return {
    id: asString(raw.id) ?? packagePath ?? `library-${index}`,
    platform,
    title,
    author,
    category,
    contentKind: firstString([raw, kbAsset, metadata], ["contentKind", "content_kind", "kind", "type"]) ?? (kbAsset ? "video" : null),
    meta: meta || "内容包已入库",
    tags,
    tone: tones[index % tones.length],
    packagePath,
    assetPath,
    coverUrl,
    previewUrl,
    sourceUrl,
    sizeBytes,
    createdAt,
    publishedAt,
    overview: analysisOverview ?? sourceDescription,
    overviewSource: analysisOverview ? "analysis" : sourceDescription ? "source" : null,
    metrics,
    performance,
    transcript,
    transcriptText,
    transcriptStatus: asString(transcriptRecord?.status),
    transcriptNote: asString(transcriptRecord?.note),
    voiceover,
    copywriting,
    ocr,
    ocrStatus: asString(ocrRecord?.status),
    ocrNote: asString(ocrRecord?.note),
    shots,
    propagationFactors,
    evidence,
    analysisText,
    searchText,
    qualityState: asString(quality?.state),
    qualityLabel: asString(quality?.label),
    qualityReason: asString(quality?.reason),
    analysisReady: Boolean(remakePlan && seedanceWorkflow && Array.isArray(seedanceWorkflow.shots)),
    analysisCompletedAt: firstString([contentAnalysis, remakePlanEnvelope], ["analyzed_at", "created_at", "generatedAt"]),
    yuanbaoInsightAvailable: Boolean(yuanbaoInsight),
  };
}

function normalizeService(raw: Record<string, unknown>): LocalService {
  const runtime = asRecord(raw.runtime);
  const install = asRecord(raw.install);
  const authentication = asRecord(raw.authentication);
  const business = asRecord(raw.business);
  const id = asString(raw.id) ?? asString(raw.name) ?? "unknown-service";
  const status = asString(runtime?.state) ?? asString(raw.status) ?? asString(raw.state) ?? "unknown";
  const explicitRunning = asBoolean(raw.running) ?? asBoolean(raw.enabled);
  const running = explicitRunning ?? ["running", "healthy", "starting", "online"].includes(status.toLowerCase());
  const installState = asString(install?.state);
  const configured = asBoolean(raw.configured) ?? (installState ? installState === "ready" : status !== "missing" && status !== "needs_setup");
  return {
    id,
    name: asString(raw.displayName) ?? asString(raw.label) ?? asString(raw.name) ?? id,
    status,
    running,
    healthy: asBoolean(raw.healthy) ?? status.toLowerCase() === "healthy",
    configured,
    setupAvailable: asBoolean(raw.setupAvailable) ?? false,
    manageable: asBoolean(raw.manageable) ?? false,
    authenticationState: asString(authentication?.state),
    businessState: asString(business?.state),
    businessReady: asBoolean(business?.ready),
    detail: asString(runtime?.reason) ?? asString(install?.reason) ?? asString(raw.detail) ?? asString(raw.notes) ?? displayStatus(status),
    panelUrl: asString(raw.panelUrl),
  };
}

function normalizeEvent(raw: Record<string, unknown>, index: number): LocalEvent {
  const occurredAt = asString(raw.occurredAt) ?? asString(raw.createdAt) ?? asString(raw.timestamp);
  const type = (asString(raw.type) ?? "EVENT").toUpperCase();
  return {
    id: asString(raw.id) ?? `${occurredAt ?? "event"}-${index}`,
    time: formatClock(occurredAt),
    type,
    message: asString(raw.message) ?? asString(raw.summary) ?? asString(raw.detail) ?? `${type} 事件`,
    severity: asString(raw.severity) ?? asString(raw.level) ?? "info",
    source: asString(raw.source) ?? "local-agent",
    occurredAt,
  };
}

function normalizeHealth(payload: unknown): HealthInfo {
  const root = asRecord(payload) ?? {};
  const rawAdapters = asRecord(root.adapters) ?? {};
  const adapters = Object.fromEntries(
    Object.entries(rawAdapters).map(([id, value]) => [id, asRecord(value) ?? {}]),
  ) as HealthInfo["adapters"];
  return {
    knowledgeBase: asString(root.knowledgeBase) ?? "未配置",
    queue: asNumber(root.queue) ?? 0,
    uptimeSeconds: asNumber(root.uptimeSeconds) ?? asNumber(root.uptime),
    webhookEnabled: asBoolean(root.webhookEnabled) ?? false,
    adapters,
  };
}

async function fetchJson(path: string, required = false): Promise<unknown> {
  // 桌面版统一走 preload 的白名单代理，避免 Electron 页面与 17890 之间
  // 因 Origin / Private Network Access 差异被误判为“节点离线”；普通浏览器
  // 仍由 zapi 回退为同一 URL 的 fetch。
  const response = await zapi(`${LOCAL_AGENT_URL}${path}`, "GET", undefined, { timeoutMs: 2400 });
  if (!response.ok) {
    if (!required && response.status === 404) return null;
    throw new Error(response.error || `HTTP ${response.status}`);
  }
  return response.body;
}

async function fetchLibraryItems(refresh = false): Promise<LibraryItem[]> {
  try {
    // /library 会先幂等迁移新落盘的 metadata.json，然后从同一
    // kb.sqlite 返回列表。避免直接读 /kb/videos 时新下载暂时不可见。
    const payload = await fetchJson(`/api/v1/library${refresh ? "?refresh=1" : ""}`, true);
    const items = collectionFrom(payload, "items");
    return items.map((item, index) => {
      const contentKind = asString(item.contentKind) ?? "video";
      return normalizeLibraryItem({
        ...item,
        contentKind,
        previewUrl: contentKind === "x_bookmark" ? null : (asString(item.previewUrl) ?? `/api/v1/kb/videos/${encodeURIComponent(asString(item.id) ?? "")}/media`),
      }, index);
    });
  } catch {
    const kbPayload = await fetchJson("/api/v1/kb/videos?limit=200").catch(() => null);
    return collectionFrom(kbPayload, "items").map((item, index) => normalizeLibraryItem({
      ...item,
      contentKind: asString(item.contentKind) ?? "video",
      previewUrl: `/api/v1/kb/videos/${encodeURIComponent(asString(item.id) ?? "")}/media`,
    }, index));
  }
}

async function fetchLibraryDetail(id: string): Promise<LibraryItem> {
  const isXBookmark = /^x_\d+$/.test(id);
  const payload = await fetchJson(isXBookmark ? `/api/v1/x-bookmarks/${encodeURIComponent(id)}` : `/api/v1/kb/videos/${encodeURIComponent(id)}`, true);
  const root = asRecord(payload);
  if (!root) throw new Error("invalid_detail");
  return normalizeLibraryItem({
    ...root,
    id,
    contentKind: isXBookmark ? "x_bookmark" : "video",
    previewUrl: isXBookmark ? null : `/api/v1/kb/videos/${encodeURIComponent(id)}/media`,
  }, 0);
}

async function fetchAgentSnapshot(refreshLibrary = false): Promise<AgentSnapshot> {
  const healthPayload = await fetchJson("/health", true);
  const [tasksPayload, library, servicesPayload, eventsPayload, kuaidianPayload] = await Promise.all([
    fetchJson("/api/v1/tasks").catch(() => null),
    fetchLibraryItems(refreshLibrary),
    fetchJson("/api/v1/services").catch(() => null),
    fetchJson("/api/v1/events").catch(() => null),
    fetchJson("/api/v1/kuaidian/jobs").catch(() => null),
  ]);
  const kuaidianRoot = asRecord(kuaidianPayload);
  const kuaidianCounts = asRecord(kuaidianRoot?.counts);
  return {
    health: normalizeHealth(healthPayload),
    tasks: collectionFrom(tasksPayload, "tasks").map(normalizeTask),
    library,
    services: collectionFrom(servicesPayload, "services").map(normalizeService),
    events: collectionFrom(eventsPayload, "events").map(normalizeEvent),
    kuaidianCount: asNumber(kuaidianCounts?.all) ?? 0,
  };
}

function serviceFor(services: LocalService[], key: ServiceKey): LocalService | null {
  const aliases = serviceAliases[key];
  return services.find((service) => {
    const haystack = `${service.id} ${service.name}`.toLowerCase();
    return aliases.some((alias) => haystack.includes(alias.toLowerCase()));
  }) ?? null;
}

function platformLabel(code: string): Platform {
  return inferPlatform(code);
}

function compactId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function PlatformMark({ name }: { name: string }) {
  const mark =
    name === "视频号"
      ? "视"
      : name === "公众号"
        ? "公"
        : name === "抖音"
          ? "抖"
          : name === "小红书"
            ? "红"
            : name.slice(0, 1);
  return <span className={`platform-mark platform-${name}`}>{mark}</span>;
}

function StatusPill({ status }: { status: string }) {
  return <span className={`status-pill status-${status}`}>{status}</span>;
}

function Toggle({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean;
  onChange: () => void;
  label: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={`toggle ${checked ? "is-on" : ""}`}
      onClick={onChange}
      aria-label={label}
      aria-pressed={checked}
      disabled={disabled}
    >
      <span />
    </button>
  );
}

function EmptyRing({ value, label }: { value: string; label: string }) {
  return (
    <div className="ring-stat" aria-label={`${label} ${value}`}>
      <div className="ring-stat-inner">
        <strong>{value}</strong>
        <span>{label}</span>
      </div>
    </div>
  );
}

function readDoubaoAccountIds(): string[] {
  try {
    const saved = JSON.parse(window.localStorage.getItem("zhitai-doubao-accounts-v1") || "[]") as unknown;
    if (!Array.isArray(saved)) return ["account-1"];
    const accountIds = Array.from(new Set(saved.map((account) => {
      if (typeof account === "string") return account.trim();
      return asString(asRecord(account)?.id)?.trim() ?? "";
    }).filter(Boolean))).slice(0, 8);
    return accountIds.length ? accountIds : ["account-1"];
  } catch {
    return ["account-1"];
  }
}

function runtimeActionTarget(actionView?: string | null): View | null {
  if (!actionView) return null;
  const normalized = actionView.trim().toLowerCase().replace(/^\?view=/, "");
  const aliases: Record<string, View> = {
    download: "inbox",
    downloads: "inbox",
    capture: "inbox",
    knowledge: "library",
    knowledgebase: "library",
    notification: "messages",
    notifications: "messages",
    message: "messages",
    gpt: "creative",
    doubao: "creative",
    seedance: "creative",
    publisher: "publish",
  };
  const candidate = aliases[normalized] ?? normalized;
  return navItems.some((item) => item.id === candidate) ? candidate as View : null;
}

function runtimeConditionRole(condition: RuntimeCondition): "primary" | "backup" | "standard" {
  if (condition.ingressRole === "primary") return "primary";
  if (condition.ingressRole === "fallback") return "backup";
  return "standard";
}

function runtimeConditionStateLabel(condition: RuntimeCondition): string {
  if (condition.optional || condition.state === "optional") return "备用 · 不阻断";
  if (condition.state === "ready") return "就绪";
  if (condition.state === "attention") return "需处理";
  return "未确认";
}

function RuntimeConditionsPanel({
  data,
  loading,
  error,
  expanded,
  doubaoAccountCount,
  onToggle,
  onRefresh,
  onNavigate,
}: {
  data: RuntimeConditionsResponse | null;
  loading: boolean;
  error: string | null;
  expanded: boolean;
  doubaoAccountCount: number;
  onToggle: () => void;
  onRefresh: () => void;
  onNavigate: (view: View) => void;
}) {
  const summary = data?.summary;
  const summaryState = summary?.state ?? "unknown";
  const checkedAt = data?.checkedAt ? formatClock(data.checkedAt) : "尚未检查";
  const summaryText = loading && !data
    ? "正在读取已缓存的运行状态"
    : summaryState === "ready"
      ? "今日可运行"
      : summaryState === "attention"
        ? `${summary?.attentionCount ?? 0} 项需要处理`
        : "仍有条件未确认";
  const analysisBacklog = data?.backlog?.analysis;
  const creativeBacklog = data?.backlog?.creative;

  return (
    <section className={`runtime-conditions state-${summaryState}`} aria-label="今日运行条件">
      <header className="runtime-conditions-header">
        <button
          className="runtime-conditions-toggle"
          type="button"
          aria-expanded={expanded}
          aria-controls="runtime-conditions-body"
          onClick={onToggle}
        >
          <span className={`runtime-summary-signal state-${summaryState}`} aria-hidden="true" />
          <span className="runtime-summary-copy" aria-live="polite">
            <strong>今日运行条件</strong>
            <small>{summaryText} · {checkedAt}</small>
          </span>
          {summary && (
            <span className="runtime-summary-counts" aria-label={`就绪 ${summary.readyCount}，需处理 ${summary.attentionCount}，未确认 ${summary.unknownCount}`}>
              <i className="ready">{summary.readyCount} 就绪</i>
              {summary.attentionCount > 0 && <i className="attention">{summary.attentionCount} 需处理</i>}
              {summary.unknownCount > 0 && <i className="unknown">{summary.unknownCount} 未确认</i>}
            </span>
          )}
          <span className="runtime-chevron" aria-hidden="true">⌄</span>
        </button>
        <button className="runtime-refresh-button" type="button" onClick={onRefresh} disabled={loading}>
          <span aria-hidden="true">↻</span>{loading ? "检查中…" : "立即检查"}
        </button>
      </header>

      {expanded && (
        <div className="runtime-conditions-body" id="runtime-conditions-body">
          {error && <p className="runtime-error" role="status">{error}{data ? "；下方保留上次检查结果。" : ""}</p>}

          <div className="runtime-ingress-route" aria-label="微信收件入口优先级">
            <div className="runtime-route-node primary">
              <span>必需主入口</span>
              <strong>微信文件传输助手</strong>
              <small>手机转发后由网页脚本解析并自动入库</small>
            </div>
            <span className="runtime-route-arrow" aria-hidden="true">→</span>
            <div className="runtime-route-node backup">
              <span>备用入口 · 不阻断</span>
              <strong>ClawBot 直链 + 手机控制</strong>
              <small>可直发链接、查询状态与执行固定命令</small>
            </div>
          </div>

          <div className="runtime-scope-row">
            <strong>一次检查</strong>
            <span>微信收件 · 视频号解析页 · GPT · 豆包 {doubaoAccountCount} 个账号 · 抖音 · 视频号草稿 · 小红书 · 公众号</span>
          </div>

          {data ? (
            <div className="runtime-condition-grid">
              {data.conditions.map((condition) => {
                const role = runtimeConditionRole(condition);
                const actionTarget = runtimeActionTarget(condition.actionView);
                const displayState = condition.optional || condition.state === "optional" ? "optional" : condition.state;
                return (
                  <article className={`runtime-condition-card state-${displayState} role-${role}`} key={condition.id}>
                    <div className="runtime-condition-title">
                      <span className={`runtime-condition-dot state-${displayState}`} aria-hidden="true" />
                      <strong>{condition.label}</strong>
                      {role === "primary" && <em className="runtime-role-badge primary">主入口</em>}
                      {role === "backup" && <em className="runtime-role-badge backup">备用</em>}
                      <em className={`runtime-state-badge state-${displayState}`}>{runtimeConditionStateLabel(condition)}</em>
                    </div>
                    <p>{condition.reason || "尚无检查说明"}</p>
                    <footer>
                      <small>{condition.checkedAt ? `${formatClock(condition.checkedAt)} 检查` : "等待首次检查"}</small>
                      {actionTarget && (
                        <button type="button" onClick={() => onNavigate(actionTarget)}>
                          {role === "backup" ? "打开备用与控制" : "去处理"}<span aria-hidden="true">›</span>
                        </button>
                      )}
                    </footer>
                  </article>
                );
              })}
              {!data.conditions.length && <div className="runtime-no-conditions">接口已连接，但还没有返回可展示的运行条件。</div>}
            </div>
          ) : !error ? (
            <div className="runtime-loading" role="status"><span />正在读取今日运行条件…</div>
          ) : null}

          <div className="runtime-backlog-grid" aria-label="当前积压">
            <article className={analysisBacklog?.remaining ? "has-backlog" : ""}>
              <div><span>知识库积压</span><strong>{analysisBacklog?.remaining ?? "—"}</strong><small>条视频待完整分析</small></div>
              <p>{analysisBacklog ? `排队 ${analysisBacklog.queued} · 运行 ${analysisBacklog.running} · 重试等待 ${analysisBacklog.retryWait} · 需处理 ${analysisBacklog.needsAttention}` : "等待检查结果"}</p>
              <button type="button" onClick={() => onNavigate("analysis")}>查看视频分析 <span aria-hidden="true">›</span></button>
            </article>
            <article className={creativeBacklog?.waiting ? "has-backlog" : ""}>
              <div><span>创作积压</span><strong>{creativeBacklog?.waiting ?? "—"}</strong><small>个创作任务待继续处理</small></div>
              <p>{creativeBacklog
                ? `待 GPT 生图 ${creativeBacklog.waitingForImages ?? 0} · 待豆包 ${creativeBacklog.waitingForSeedance ?? 0} · 待拼接 ${creativeBacklog.waitingForAssembly ?? 0} · 需恢复 ${creativeBacklog.failed ?? 0} · 已完成 ${creativeBacklog.completed}`
                : "等待检查结果"}</p>
              <button type="button" onClick={() => onNavigate("creative")}>查看豆包创作 <span aria-hidden="true">›</span></button>
            </article>
          </div>
        </div>
      )}
    </section>
  );
}

export function ContentWorkbench() {
  // 启动页固定为收件箱；只有显式 ?view= 才切页。不再从 localStorage
  // 恢复上次视图，避免 App 启动时先闪收件箱、再突然跳到旧页面。
  const [activeView, setActiveView] = useState<View>("inbox");
  // mvp=1 时在内容库顶部显示真实使用条（不伪装任何服务在线）
  const [mvpMode, setMvpMode] = useState<boolean>(false);
  const [agentState, setAgentState] = useState<AgentState>("checking");
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [tasks, setTasks] = useState<WorkbenchTask[]>([]);
  const [libraryItems, setLibraryItems] = useState<LibraryItem[]>([]);
  const [services, setServices] = useState<LocalService[]>([]);
  const [events, setEvents] = useState<LocalEvent[]>([]);
  const [kuaidianCount, setKuaidianCount] = useState(0);
  const [linkValue, setLinkValue] = useState("");
  const [searchValue, setSearchValue] = useState("");
  const [libraryCategory, setLibraryCategory] = useState<"全部" | LibraryCategory>("全部");
  const [libraryDate, setLibraryDate] = useState("");
  const [libraryDetailId, setLibraryDetailId] = useState<string | null>(null);
  const [libraryDetail, setLibraryDetail] = useState<LibraryItem | null>(null);
  const [libraryDetailLoading, setLibraryDetailLoading] = useState(false);
  const [libraryDetailError, setLibraryDetailError] = useState<string | null>(null);
  const [showCapture, setShowCapture] = useState(false);
  const [showPublish, setShowPublish] = useState(false);
  const [toast, setToast] = useState("");
  const [selectedPlatforms, setSelectedPlatforms] = useState<string[]>([]);
  const [publishPreset, setPublishPreset] = useState<{ videoId: string; preferGenerated: boolean; key: number } | null>(null);
  const [creativePreset, setCreativePreset] = useState<{ videoId: string; key: number } | null>(null);
  const [selectedLibraryId, setSelectedLibraryId] = useState("");
  const [publishTitle, setPublishTitle] = useState("");
  const [publishMode, setPublishMode] = useState<PublishMode>("platform_draft");
  const [publishDate, setPublishDate] = useState("");
  const [publishTime, setPublishTime] = useState("");
  const [publishApproved, setPublishApproved] = useState(false);
  const [ingestSubmitting, setIngestSubmitting] = useState(false);
  const [publishSubmitting, setPublishSubmitting] = useState(false);
  const [pendingServices, setPendingServices] = useState<string[]>([]);
  const [themeMode, setThemeMode] = useState<"auto" | "light" | "dark">("auto");
  const [runtimeConditions, setRuntimeConditions] = useState<RuntimeConditionsResponse | null>(null);
  const [runtimeConditionsLoading, setRuntimeConditionsLoading] = useState(false);
  const [runtimeConditionsError, setRuntimeConditionsError] = useState<string | null>(null);
  const [runtimeConditionsExpanded, setRuntimeConditionsExpanded] = useState(true);
  const [runtimeDoubaoAccountCount, setRuntimeDoubaoAccountCount] = useState(0);

  const meta = viewMeta[activeView];
  void tasks;
  const publishTasks = useMemo(() => tasks.filter((task) => task.type === "publish"), [tasks]);

  const filteredLibrary = useMemo(() => {
    const query = searchValue.trim().toLowerCase();
    return libraryItems.filter((item) => {
      if (libraryCategory !== "全部" && item.category !== libraryCategory) return false;
      if (libraryDate && localDateKey(item.createdAt) !== libraryDate) return false;
      return !query || item.searchText.includes(query);
    });
  }, [libraryCategory, libraryDate, libraryItems, searchValue]);

  const selectedLibraryItem = useMemo(() => {
    if (libraryDetail?.id === libraryDetailId) return libraryDetail;
    return libraryItems.find((item) => item.id === libraryDetailId) ?? null;
  }, [libraryDetail, libraryDetailId, libraryItems]);

  const notify = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  const agentFailureCountRef = useRef(0);
  const runtimeCheckRequestRef = useRef(0);

  const loadRuntimeConditions = useCallback(async (refresh = false, withNotice = false) => {
    const requestId = runtimeCheckRequestRef.current + 1;
    runtimeCheckRequestRef.current = requestId;
    const accountIds = readDoubaoAccountIds();
    setRuntimeDoubaoAccountCount(accountIds.length);
    setRuntimeConditionsLoading(true);
    setRuntimeConditionsError(null);
    if (refresh) setRuntimeConditionsExpanded(true);
    try {
      const result = await checkRuntimeConditions(accountIds, refresh);
      if (runtimeCheckRequestRef.current !== requestId) return;
      setRuntimeConditions(result);
      if (result.summary.attentionCount > 0 || result.summary.unknownCount > 0) {
        setRuntimeConditionsExpanded(true);
      }
      if (withNotice) {
        const fullyReady = result.summary.attentionCount === 0 && result.summary.unknownCount === 0;
        notify(fullyReady
          ? "今日运行条件已全部确认"
          : `检查完成：${result.summary.attentionCount} 项需处理，${result.summary.unknownCount} 项未确认`);
      }
    } catch (error) {
      if (runtimeCheckRequestRef.current !== requestId) return;
      const message = error instanceof Error ? error.message : "运行条件接口暂不可达";
      setRuntimeConditionsError(message);
      setRuntimeConditionsExpanded(true);
      if (withNotice) notify(`运行条件检查失败：${message}`);
    } finally {
      if (runtimeCheckRequestRef.current === requestId) setRuntimeConditionsLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    // 首次与后台轮询只读轻量缓存；跨账号登录深检查只由用户明确点击触发。
    const initial = window.setTimeout(() => void loadRuntimeConditions(false, false), 650);
    const interval = window.setInterval(() => void loadRuntimeConditions(false, false), 10 * 60 * 1000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [loadRuntimeConditions]);

  useEffect(() => {
    const saved = window.localStorage.getItem("zhitai_theme");
    const initial = saved === "light" || saved === "dark" ? saved : "auto";
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setThemeMode(initial);
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved = initial === "auto" ? (media.matches ? "dark" : "light") : initial;
      document.documentElement.dataset.theme = resolved;
      document.documentElement.dataset.themeMode = initial;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, []);

  const cycleTheme = useCallback(() => {
    setThemeMode((current) => {
      const next = current === "auto" ? "light" : current === "light" ? "dark" : "auto";
      window.localStorage.setItem("zhitai_theme", next);
      const dark = next === "dark" || (next === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      document.documentElement.dataset.theme = dark ? "dark" : "light";
      document.documentElement.dataset.themeMode = next;
      return next;
    });
  }, []);

  const applySnapshot = useCallback((snapshot: AgentSnapshot) => {
    setHealth(snapshot.health);
    setTasks(snapshot.tasks);
    setLibraryItems(snapshot.library);
    setServices(snapshot.services);
    setEvents(snapshot.events);
    setKuaidianCount(snapshot.kuaidianCount);
    setAgentState("online");
  }, []);

  const clearSnapshot = useCallback(() => {
    setHealth(null);
    setTasks([]);
    setLibraryItems([]);
    setServices([]);
    setEvents([]);
    setKuaidianCount(0);
  }, []);

  const checkLocalAgent = useCallback(async (withNotice = true, showChecking = true) => {
    if (showChecking) setAgentState("checking");
    try {
      const snapshot = await fetchAgentSnapshot(withNotice);
      agentFailureCountRef.current = 0;
      applySnapshot(snapshot);
      if (withNotice) notify("本地节点连接成功，数据已同步");
      return true;
    } catch {
      agentFailureCountRef.current += 1;
      // 桌面窗口经常比登录自启节点早 1—3 秒出现。保留上一份真实数据，
      // 连续三轮（约 9 秒）失败后才判离线，避免启动时闪成空知识库。
      if (agentFailureCountRef.current >= 3) {
        clearSnapshot();
        setAgentState("offline");
      } else {
        setAgentState("checking");
      }
      if (withNotice) notify(agentFailureCountRef.current >= 3 ? "本地节点暂不可达，正在由系统自动重启" : "本地节点正在启动，请稍候");
      return false;
    }
  }, [applySnapshot, clearSnapshot, notify]);

  useEffect(() => {
    const initial = window.setTimeout(() => void checkLocalAgent(false, true), 0);
    const interval = window.setInterval(() => void checkLocalAgent(false, false), 3000);
    return () => {
      window.clearTimeout(initial);
      window.clearInterval(interval);
    };
  }, [checkLocalAgent]);

  // 仅挂载后执行（客户端）：只接受显式、合法的 view 参数。
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const urlView = params.get("view");
    if (urlView && navItems.some((item) => item.id === urlView)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveView(urlView as View);
    }
    if (params.get("mvp") === "1") {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMvpMode(true);
    }
  }, []);

  useEffect(() => {
    if (!libraryDetailId) {
      // 初始化重置（非级联渲染）
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setLibraryDetail(null);
      setLibraryDetailError(null);
      setLibraryDetailLoading(false);
      return;
    }
    let cancelled = false;
    let retryTimer: number | null = null;
    let attempts = 0;
    setLibraryDetail(null);
    setLibraryDetailError(null);
    setLibraryDetailLoading(true);
    const loadDetail = async (initial: boolean) => {
      attempts += 1;
      try {
        const detail = await fetchLibraryDetail(libraryDetailId);
        if (cancelled) return;
        setLibraryDetail(detail);
        setLibraryDetailError(null);
        // 新入库视频的深度分析通常稍后写回。详情保持打开时静默轮询，
        // 直到复刻计划和 Seedance 分镜真正就绪，避免一直显示旧空值。
        if (!detail.analysisReady && attempts < 36) {
          retryTimer = window.setTimeout(() => void loadDetail(false), 5000);
        }
      } catch {
        if (!cancelled) setLibraryDetailError("详细分析接口暂不可用，当前显示列表已同步字段。");
      } finally {
        if (initial && !cancelled) setLibraryDetailLoading(false);
      }
    };
    void loadDetail(true);
    return () => {
      cancelled = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
    };
  }, [libraryDetailId]);

  useEffect(() => {
    if (!selectedLibraryItem) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLibraryDetailId(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedLibraryItem]);

  function switchView(view: View) {
    setActiveView(view);
    const url = new URL(window.location.href);
    url.searchParams.set("view", view);
    window.history.replaceState(window.history.state, "", url);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  async function createIngestTask(value = linkValue) {
    const clean = value.trim();
    if (!clean) {
      notify("先粘贴一个分享链接");
      return;
    }
    if (agentState !== "online") {
      notify("本地节点未连接；启动后再提交链接");
      return;
    }
    setIngestSubmitting(true);
    try {
      const response = await fetch(`${LOCAL_AGENT_URL}/api/v1/ingest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: clean, source: "manual" }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const error = asString(asRecord(payload)?.message) ?? asString(asRecord(payload)?.error) ?? `HTTP ${response.status}`;
        throw new Error(error);
      }
      setLinkValue("");
      setShowCapture(false);
      const acceptedTask = asRecord(asRecord(payload)?.task);
      notify(acceptedTask && asString(acceptedTask.status) === "needs_setup" ? "任务已创建，但对应下载器尚未配置" : "采集任务已由本地节点接收");
      await checkLocalAgent(false, false);
    } catch (error) {
      notify(`提交失败：${error instanceof Error ? error.message : "本地节点无响应"}`);
    } finally {
      setIngestSubmitting(false);
    }
  }

  async function toggleServiceById(current: LocalService | null, fallbackId: string) {
    if (agentState !== "online") {
      notify("本地节点未连接，无法切换服务");
      return;
    }
    const serviceId = current?.id ?? fallbackId;
    const action = current?.running ? "stop" : "start";
    setPendingServices((items) => [...items, serviceId]);
    try {
      const response = await fetch(`${LOCAL_AGENT_URL}/api/v1/services/${encodeURIComponent(serviceId)}/${action}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Zhitai-Action": "confirm",
        },
        body: JSON.stringify({ approved: true }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const error = asString(asRecord(payload)?.message) ?? asString(asRecord(payload)?.error) ?? `HTTP ${response.status}`;
        throw new Error(error);
      }
      notify(`${current?.name ?? serviceId}${action === "start" ? "启动请求已确认" : "停止请求已确认"}`);
      await checkLocalAgent(false, false);
    } catch (error) {
      notify(`服务操作失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setPendingServices((items) => items.filter((id) => id !== serviceId));
    }
  }

  async function toggleService(key: ServiceKey) {
    await toggleServiceById(serviceFor(services, key), defaultServiceIds[key]);
  }

  // 只请求启动（用于 GUI 类工具：MatrixMedia / WeChat MP Tools / 闲鱼 Web UI）
  async function openServiceById(serviceId: string) {
    if (agentState !== "online") {
      notify("本地节点未连接，无法打开原工具");
      return;
    }
    setPendingServices((items) => [...items, serviceId]);
    try {
      const response = await fetch(`${LOCAL_AGENT_URL}/api/v1/services/${encodeURIComponent(serviceId)}/start`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Zhitai-Action": "confirm",
        },
        body: JSON.stringify({ approved: true }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const error = asString(asRecord(payload)?.message) ?? asString(asRecord(payload)?.error) ?? `HTTP ${response.status}`;
        throw new Error(error);
      }
      notify("已请求打开原工具");
      await checkLocalAgent(false, false);
    } catch (error) {
      notify(`打开失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setPendingServices((items) => items.filter((id) => id !== serviceId));
    }
  }

  async function setupServiceById(current: LocalService | null, fallbackId: string) {
    if (agentState !== "online") {
      notify("本地节点未连接，无法打开配置流程");
      return;
    }
    const serviceId = current?.id ?? fallbackId;
    setPendingServices((items) => [...items, serviceId]);
    try {
      const response = await fetch(`${LOCAL_AGENT_URL}/api/v1/services/${encodeURIComponent(serviceId)}/setup`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Zhitai-Action": "confirm" },
        body: JSON.stringify({ approved: true }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const error = asString(asRecord(payload)?.message) ?? asString(asRecord(payload)?.error) ?? `HTTP ${response.status}`;
        throw new Error(error);
      }
      notify("已打开扫码配置终端；请在手机上确认登录");
      await checkLocalAgent(false, false);
    } catch (error) {
      notify(`打开配置失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setPendingServices((items) => items.filter((id) => id !== serviceId));
    }
  }

  function togglePlatform(platform: string) {
    setSelectedPlatforms((current) =>
      current.includes(platform)
        ? current.filter((item) => item !== platform)
        : [...current, platform],
    );
  }

  function openPublishComposer() {
    const first = libraryItems[0];
    setSelectedLibraryId((current) => current || first?.id || "");
    setPublishTitle((current) => current || first?.title || "");
    setShowPublish(true);
  }

  async function schedulePublish() {
    if (!selectedPlatforms.length) {
      notify("至少选择一个发布平台");
      return;
    }
    if (agentState !== "online") {
      notify("本地节点未连接，无法创建发布任务");
      return;
    }
    const item = libraryItems.find((entry) => entry.id === selectedLibraryId);
    if (!item) {
      notify("请先选择一个真实内容包");
      return;
    }
    if (!item.assetPath) {
      notify("该内容包没有可发布的原始素材路径");
      return;
    }
    if (publishMode === "publish" && !publishApproved) {
      notify("直接发布前必须勾选人工确认");
      return;
    }
    if ((publishDate && !publishTime) || (!publishDate && publishTime)) {
      notify("发布日期和时间需要同时填写");
      return;
    }
    const scheduledAt = publishDate && publishTime
      ? new Date(`${publishDate}T${publishTime}:00`).toISOString()
      : undefined;
    setPublishSubmitting(true);
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (publishMode === "publish") headers["X-Zhitai-Action"] = "confirm";
      const response = await fetch(`${LOCAL_AGENT_URL}/api/v1/publish`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          assetPath: item.assetPath,
          title: publishTitle.trim() || item.title,
          targets: selectedPlatforms.map((platform) => platformCodes[platform]).filter(Boolean),
          mode: publishMode,
          scheduledAt,
          ...(publishMode === "publish" ? { approved: true } : {}),
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const error = asString(asRecord(payload)?.message) ?? asString(asRecord(payload)?.error) ?? `HTTP ${response.status}`;
        throw new Error(error);
      }
      setShowPublish(false);
      setPublishApproved(false);
      notify(publishMode === "publish" ? "直接发布任务已确认并提交" : "平台草稿任务已提交");
      await checkLocalAgent(false, false);
    } catch (error) {
      notify(`发布任务创建失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setPublishSubmitting(false);
    }
  }

  return (
    <div className="workbench-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => switchView("inbox")} type="button">
          <span className="brand-mark">织</span>
          <span className="brand-copy">
            <strong>织台</strong>
            <small>CONTENT OS</small>
          </span>
        </button>

        <nav className="side-nav" aria-label="工作台导航">
          <p>工作区</p>
          {navItems.map((item) => (
            <button
              key={item.id}
              type="button"
              className={activeView === item.id ? "active" : ""}
              onClick={() => switchView(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
              <span>{item.label}</span>
              {item.id === "inbox" && kuaidianCount > 0 && <em>{kuaidianCount}</em>}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <DesktopStatus />
          <button className="node-card" type="button" onClick={() => void checkLocalAgent()}>
            <span className={`node-signal ${agentState}`} />
            <span>
              <strong>
                {agentState === "online"
                  ? "本地节点在线"
                  : agentState === "checking"
                    ? "正在连接节点"
                    : "本地节点未连接"}
              </strong>
              <small>{agentState === "online" ? `队列 ${health?.queue ?? 0} · 每 3 秒同步` : "点击重新检测"}</small>
            </span>
            <b>›</b>
          </button>
          <div className="profile-chip">
            <span className="avatar">LC</span>
            <span>
              <strong>内容工作室</strong>
              <small>本地优先模式</small>
            </span>
            <button type="button" aria-label="更多账户设置">•••</button>
          </div>
        </div>
      </aside>

      <main className="main-panel">
        <header className="topbar">
          <div>
            <p>{meta.eyebrow}</p>
            <h1>{meta.title}</h1>
            <span>{meta.description}</span>
          </div>
          <div className="topbar-actions">
            <label className="global-search">
              <span>⌕</span>
              <input
                aria-label="搜索内容"
                value={searchValue}
                onChange={(event) => setSearchValue(event.target.value)}
                placeholder="搜索内容、标签或任务"
              />
              <kbd>⌘ K</kbd>
            </label>
            <button className="quiet-button theme-toggle" type="button" onClick={cycleTheme} aria-label="切换浅色深色主题" title={themeMode === "auto" ? "跟随系统" : themeMode === "dark" ? "深色" : "浅色"}>
              {themeMode === "auto" ? "◐" : themeMode === "dark" ? "☾" : "☀"}
            </button>
            <button className="quiet-button notification" type="button" aria-label="打开消息中心" onClick={() => switchView("messages")}>
              ·
              <span />
            </button>
            <button className="primary-button" type="button" onClick={() => setShowCapture(true)}>
              <span>＋</span> 添加内容
            </button>
          </div>
        </header>

        <nav className="mobile-nav" aria-label="移动端导航">
          {navItems.map((item) => (
            <button
              type="button"
              key={item.id}
              className={activeView === item.id ? "active" : ""}
              onClick={() => switchView(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>

        <div className="page-content">
          <RuntimeConditionsPanel
            data={runtimeConditions}
            loading={runtimeConditionsLoading}
            error={runtimeConditionsError}
            expanded={runtimeConditionsExpanded}
            doubaoAccountCount={runtimeDoubaoAccountCount}
            onToggle={() => setRuntimeConditionsExpanded((current) => !current)}
            onRefresh={() => void loadRuntimeConditions(true, true)}
            onNavigate={switchView}
          />
          {activeView === "inbox" && (
            <Inbox
              agentState={agentState}
              services={services}
              linkValue={linkValue}
              setLinkValue={setLinkValue}
              onCreate={createIngestTask}
            />
          )}
          {activeView === "library" && (
            <>
              {mvpMode && <MvpUsageBar />}
              <Library
                agentState={agentState}
                health={health}
                items={filteredLibrary}
                totalItems={libraryItems}
                searchValue={searchValue}
                setSearchValue={setSearchValue}
                category={libraryCategory}
                setCategory={setLibraryCategory}
                selectedDate={libraryDate}
                setSelectedDate={setLibraryDate}
                onRefresh={() => void checkLocalAgent(true, true)}
                onOpenFolder={async () => {
                  try {
                    const response = await fetch(`${LOCAL_AGENT_URL}/api/v1/library/open-folder`, {
                      method: "POST",
                      headers: { "Content-Type": "application/json", "X-Zhitai-Action": "confirm" },
                      body: JSON.stringify({ approved: true }),
                    });
                    if (!response.ok) throw new Error(`HTTP ${response.status}`);
                    notify("已在 Finder 打开知识库目录");
                  } catch {
                    notify("打开目录失败，请先确认本地节点在线");
                  }
                }}
                onOpen={(item) => setLibraryDetailId(item.id)}
              />
            </>
          )}
          {activeView === "analysis" && (
            <Analysis libraryItems={libraryItems} agentState={agentState} onCreate={(videoId) => {
              setCreativePreset({ videoId, key: Date.now() });
              switchView("creative");
            }} />
          )}
          {activeView === "learning" && <DailyLearning items={libraryItems} />}
          {activeView === "messages" && (
            <MessageCenter
              agentState={agentState}
              services={services}
              notify={notify}
              onSetupClawBot={() => void setupServiceById(services.find((service) => service.id === "openclaw_weixin") ?? null, "openclaw_weixin")}
            />
          )}
          {activeView === "creative" && <CreativeStudio key={creativePreset?.key ?? "creative"} libraryItems={libraryItems} agentState={agentState} initialVideoId={creativePreset?.videoId} onPublish={(videoId) => {
            setPublishPreset({ videoId, preferGenerated: true, key: Date.now() });
            switchView("publish");
          }} />}
          {activeView === "publish" && (
            <PublishNative key={publishPreset?.key ?? "publish"}
              libraryItems={libraryItems.filter((item) => item.contentKind !== "x_bookmark")}
              initialVideoId={publishPreset?.videoId}
              preferGenerated={publishPreset?.preferGenerated}
            />
          )}
          {activeView === "xianyu" && (
            <XianyuNative />
          )}
          {activeView === "updates" && <Updates agentState={agentState} />}
        </div>
      </main>

      {showCapture && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setShowCapture(false)}>
          <section
            className="modal-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="capture-title"
          >
            <button className="modal-close" type="button" onClick={() => setShowCapture(false)} aria-label="关闭">
              ×
            </button>
            <span className="modal-kicker">新建内容包</span>
            <h2 id="capture-title">粘贴一个分享链接</h2>
            <p>支持视频号、微信公众号、抖音和小红书。登录态与文件只经过本地节点。</p>
            <div className="modal-platforms">
              {["视频号", "公众号", "抖音", "小红书"].map((platform) => (
                <span key={platform}><PlatformMark name={platform} />{platform}</span>
              ))}
            </div>
            <label className="modal-input">
              <span>分享链接</span>
              <textarea
                value={linkValue}
                onChange={(event) => setLinkValue(event.target.value)}
                placeholder="粘贴平台分享链接或包含链接的整段文本…"
              />
            </label>
            <div className="modal-note"><span>i</span> 只采集你有权保存的内容；平台登录信息不会离开本机。</div>
            <div className="modal-actions">
              <button className="secondary-button" type="button" onClick={() => setShowCapture(false)}>取消</button>
              <button className="primary-button" type="button" onClick={() => createIngestTask()} disabled={ingestSubmitting || agentState !== "online"}>{ingestSubmitting ? "提交中…" : "创建并解析"}</button>
            </div>
          </section>
        </div>
      )}

      {showPublish && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setShowPublish(false)}>
          <section
            className="modal-card publish-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="publish-title"
          >
            <button className="modal-close" type="button" onClick={() => setShowPublish(false)} aria-label="关闭">×</button>
            <span className="modal-kicker">新建发布任务</span>
            <h2 id="publish-title">一份内容，多端分发</h2>
            <p>先选择内容包，再为每个平台单独检查标题、封面与发布时间。</p>
            <label className="select-row">
              <span>内容包</span>
              <select
                value={selectedLibraryId}
                onChange={(event) => {
                  const id = event.target.value;
                  setSelectedLibraryId(id);
                  const item = libraryItems.find((entry) => entry.id === id);
                  if (item) setPublishTitle(item.title);
                }}
                disabled={!libraryItems.length}
              >
                {!libraryItems.length && <option value="">本地内容库暂无可发布素材</option>}
                {libraryItems.map((item) => <option key={item.id} value={item.id}>{item.id} · {item.title}</option>)}
              </select>
            </label>
            <label className="select-row">
              <span>发布标题</span>
              <input value={publishTitle} onChange={(event) => setPublishTitle(event.target.value)} placeholder="使用内容包标题" />
            </label>
            <label className="select-row">
              <span>发布方式</span>
              <select value={publishMode} onChange={(event) => { setPublishMode(event.target.value as PublishMode); setPublishApproved(false); }}>
                <option value="platform_draft">保存到平台草稿（默认）</option>
                <option value="publish">人工确认后直接发布</option>
              </select>
            </label>
            <fieldset className="platform-picker">
              <legend>发布平台</legend>
              {["抖音", "小红书", "视频号"].map((platform) => (
                <button
                  key={platform}
                  type="button"
                  className={selectedPlatforms.includes(platform) ? "selected" : ""}
                  onClick={() => togglePlatform(platform)}
                  aria-pressed={selectedPlatforms.includes(platform)}
                >
                  <PlatformMark name={platform} />
                  <span>{platform}</span>
                  <b>{selectedPlatforms.includes(platform) ? "✓" : "+"}</b>
                </button>
              ))}
            </fieldset>
            <div className="schedule-grid">
              <label><span>发布日期（可选）</span><input type="date" value={publishDate} onChange={(event) => setPublishDate(event.target.value)} /></label>
              <label><span>发布时间（可选）</span><input type="time" value={publishTime} onChange={(event) => setPublishTime(event.target.value)} /></label>
            </div>
            <label className="modal-note">
              <span>i</span>
              {publishMode === "publish" ? <><input type="checkbox" checked={publishApproved} onChange={(event) => setPublishApproved(event.target.checked)} /> 我已检查内容并确认直接发布</> : "默认只送入平台草稿，不会直接公开发布。"}
            </label>
            <div className="modal-actions">
              <button className="secondary-button" type="button" onClick={() => setShowPublish(false)}>取消</button>
              <button className="primary-button" type="button" onClick={schedulePublish} disabled={publishSubmitting || !libraryItems.length || agentState !== "online"}>{publishSubmitting ? "提交中…" : publishMode === "publish" ? "确认并直接发布" : "创建平台草稿"}</button>
            </div>
          </section>
        </div>
      )}

      {selectedLibraryItem && (
        <LibraryDetail
          item={selectedLibraryItem}
          loading={libraryDetailLoading}
          loadError={libraryDetailError}
          onClose={() => setLibraryDetailId(null)}
          onUpdated={(detail) => {
            setLibraryDetail(detail);
            setLibraryItems((current) => current.map((entry) => entry.id === detail.id ? { ...entry, metrics: detail.metrics, performance: detail.performance, propagationFactors: detail.propagationFactors } : entry));
          }}
        />
      )}

      {toast && <div className="toast" role="status"><span>✓</span>{toast}</div>}
    </div>
  );
}

function Overview({
  agentState,
  health,
  tasks,
  libraryItems,
  publishTasks,
  linkValue,
  setLinkValue,
  onCreate,
  services,
  pendingServices,
  toggleService,
  openPublish,
  goTo,
}: {
  agentState: AgentState;
  health: HealthInfo | null;
  tasks: WorkbenchTask[];
  libraryItems: LibraryItem[];
  publishTasks: WorkbenchTask[];
  linkValue: string;
  setLinkValue: (value: string) => void;
  onCreate: () => void;
  services: LocalService[];
  pendingServices: string[];
  toggleService: (key: ServiceKey) => void;
  openPublish: () => void;
  goTo: (view: View) => void;
}) {
  const fileTransfer = serviceFor(services, "fileTransfer");
  const xianyuServices = (["monitor", "support", "accounts"] as ServiceKey[]).map((key) => ({
    key,
    service: serviceFor(services, key),
  }));
  const runningServices = xianyuServices.filter(({ service }) => service?.running).length;
  const today = new Date().toLocaleDateString("zh-CN");
  const todayItems = libraryItems.filter((item) => item.createdAt && new Date(item.createdAt).toLocaleDateString("zh-CN") === today);
  const totalBytes = libraryItems.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);
  const pendingPublish = publishTasks.filter((task) => !["completed", "success", "succeeded", "failed"].includes(task.rawStatus.toLowerCase()));
  const nextPublish = [...pendingPublish].sort((left, right) => (left.scheduledAt ?? "9999").localeCompare(right.scheduledAt ?? "9999"))[0] ?? null;
  const nextSchedule = formatSchedule(nextPublish?.scheduledAt ?? null);

  return (
    <>
      <section className="quick-capture hero-panel">
        <div className="quick-copy">
          <span className="eyebrow-pill"><i /> {
            agentState !== "online"
              ? "本地节点未连接"
              : fileTransfer?.businessReady
                ? `${fileTransfer.name} · 主入口正常`
                : fileTransfer?.status === "needs_login"
                  ? "文件传输助手主入口需重新扫码"
                  : fileTransfer?.running
                    ? "文件传输助手页面在线，但主入口未就绪"
                    : "文件传输助手主入口未启动"
          }</span>
          <h2>把灵感丢进来，<br />自动变成内容包。</h2>
          <p>识别分享链接，调用已配置的本地下载器，校验文件并生成带 SHA-256 的内容包。</p>
          <div className="capture-input">
            <span>⌁</span>
            <input
              value={linkValue}
              onChange={(event) => setLinkValue(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && onCreate()}
              placeholder="也可以直接粘贴视频号、公众号、抖音或小红书链接"
              aria-label="分享链接"
            />
            <button type="button" onClick={onCreate} disabled={agentState !== "online"}>开始采集 <b>↗</b></button>
          </div>
          <div className="supported-row">
            <span>支持</span>
            {["视频号", "公众号", "抖音", "小红书"].map((platform) => (
              <span className="supported-platform" key={platform}><PlatformMark name={platform} />{platform}</span>
            ))}
          </div>
        </div>
        <div className="flow-visual" aria-label="自动采集流程">
          <div className="flow-orbit orbit-one" />
          <div className="flow-orbit orbit-two" />
          <div className="flow-center">
            <span className="brand-mark">织</span>
            <strong>本地知识库</strong>
            <small>{agentState === "online" ? `${libraryItems.length} 个内容包` : "等待本地节点"}</small>
          </div>
          <div className="orbit-node node-wechat"><PlatformMark name="视频号" /><span>微信收件</span></div>
          <div className="orbit-node node-douyin"><PlatformMark name="抖音" /><span>抖音</span></div>
          <div className="orbit-node node-xhs"><PlatformMark name="小红书" /><span>小红书</span></div>
          <div className="orbit-node node-meta"><span className="file-mark">JSON</span><span>元数据</span></div>
        </div>
      </section>

      <section className="metric-grid">
        <article className="metric-card">
          <span className="metric-icon mint">↓</span>
          <div><small>今日入库</small><strong>{todayItems.length}</strong></div>
          <em>{agentState === "online" ? "实时" : "离线"}</em>
          <p>{agentState === "online" ? formatBytes(todayItems.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0)) : "启动本地节点后同步"}</p>
        </article>
        <article className="metric-card">
          <span className="metric-icon violet">▦</span>
          <div><small>内容资产</small><strong>{libraryItems.length}</strong></div>
          <em>{formatBytes(totalBytes)}</em>
          <p>{health?.knowledgeBase ?? "知识库尚未连接"}</p>
        </article>
        <article className="metric-card">
          <span className="metric-icon coral">↗</span>
          <div><small>待发布</small><strong>{pendingPublish.length}</strong></div>
          <em>{publishTasks.length} 条任务</em>
          <p>{nextPublish ? `${nextSchedule.date} ${nextSchedule.time}` : "暂无发布任务"}</p>
        </article>
        <article className="metric-card">
          <span className="metric-icon amber">◇</span>
          <div><small>闲鱼服务</small><strong>{runningServices}/{xianyuServices.length}</strong></div>
          <em>{services.length ? "本机状态" : "未接入"}</em>
          <p>{services.length ? "来自服务管理接口" : "请先配置开源工具"}</p>
        </article>
      </section>

      <section className="dashboard-grid">
        <article className="panel recent-panel">
          <div className="panel-heading">
            <div><span>实时队列</span><h3>最近内容</h3></div>
            <button type="button" onClick={() => goTo("inbox")}>查看全部 <b>›</b></button>
          </div>
          <div className="task-list">
            {tasks.slice(0, 4).map((task) => (
              <div className="task-row" key={task.id}>
                <PlatformMark name={task.platform} />
                <div className="task-copy"><strong>{task.title}</strong><span>{task.id} · {task.source} · {task.time}</span></div>
                <div className="task-progress"><span><i style={{ width: `${task.progress ?? 0}%` }} /></span><small>{task.progress === null ? "—" : `${task.progress}%`}</small></div>
                <StatusPill status={task.status} />
                <button type="button" aria-label={`查看 ${task.title}`}>•••</button>
              </div>
            ))}
            {!tasks.length && <div className="empty-state"><span>↓</span><strong>{agentState === "online" ? "还没有采集任务" : "本地节点未连接"}</strong><p>{agentState === "online" ? "在上方粘贴一个已授权的分享链接开始。" : "运行 npm run agent 后，真实任务会在这里出现。"}</p></div>}
          </div>
        </article>

        <article className="panel automation-panel">
          <div className="panel-heading">
            <div><span>自动化</span><h3>闲鱼助手</h3></div>
            <button type="button" onClick={() => goTo("xianyu")}>管理 <b>›</b></button>
          </div>
          <div className="assistant-score">
            <EmptyRing value={`${runningServices}/${xianyuServices.length}`} label="运行中" />
            <div><strong>{runningServices ? "服务状态来自本地节点" : "尚无运行中的闲鱼服务"}</strong><span><i /> 每 3 秒同步一次</span><p>{services.length ? "开关操作需要显式确认" : "请在连接器中完成安装与配置"}</p></div>
          </div>
          <div className="service-list">
            {xianyuServices.map(({ key, service }, index) => (
              <div key={key}>
                <span className="service-icon">{["眼", "答", "号"][index]}</span>
                <p><strong>{["商品监控", "智能客服", "多账号值守"][index]}</strong><small>{service ? `${displayStatus(service.status)} · ${service.detail}` : "未接入本地服务"}</small></p>
                <Toggle checked={Boolean(service?.running)} onChange={() => toggleService(key)} disabled={agentState !== "online" || pendingServices.includes(service?.id ?? defaultServiceIds[key])} label={`切换${service?.name ?? ["商品监控", "智能客服", "多账号值守"][index]}`} />
              </div>
            ))}
          </div>
        </article>

        <article className="panel pipeline-panel">
          <div className="panel-heading">
            <div><span>标准流程</span><h3>入库流水线</h3></div>
            <span className="live-label"><i /> {agentState === "online" ? `节点在线 · 队列 ${health?.queue ?? 0}` : "等待本地节点"}</span>
          </div>
          <div className="pipeline-flow">
            {[
              ["01", "收到链接", "微信 / 剪贴板"],
              ["02", "原片下载", "保留来源信息"],
              ["03", "文件校验", "大小 / SHA-256"],
              ["04", "本地归档", "素材 + metadata.json"],
            ].map(([index, title, detail], idx) => (
              <div className="pipeline-step" key={index}>
                <span>{index}</span><strong>{title}</strong><small>{detail}</small>
                {idx < 3 && <b>›</b>}
              </div>
            ))}
          </div>
        </article>

        <article className="panel publish-card">
          <div className="publish-card-top">
            <span>{nextPublish ? `${nextSchedule.date} ${nextSchedule.time}` : "暂无排期"}</span>
            <div className="platform-stack">{nextPublish?.targets.map((target) => <PlatformMark key={target} name={platformLabel(target)} />)}</div>
          </div>
          <h3>{nextPublish?.title ?? "还没有发布任务"}</h3>
          <p>{nextPublish ? `${nextPublish.status} · ${nextPublish.mode ?? "未指定模式"}` : "从真实内容包创建平台草稿；直接发布需要再次人工确认。"}</p>
          <div className="publish-readiness"><span><i /></span><strong>{nextPublish ? nextPublish.status : `${libraryItems.length} 个可选内容包`}</strong></div>
          <button className="dark-button" type="button" onClick={openPublish}>新建发布任务 <b>↗</b></button>
        </article>
      </section>
    </>
  );
}

type KuaidianJob = {
  id: string;
  itemId: number | null;
  legacyTaskId: string | null;
  title: string;
  status: string;
  displayStatus: string;
  updatedAt: string | null;
  retryCount: number;
  assetId: string | null;
  errorDisplay: string | null;
  retryMode: string;
  source: string;
};

type KuaidianStatus = {
  states: { localNode: boolean; filehelperPageConnected: boolean; wechatLoggedIn: boolean; originalKuaidianDetected: boolean; companionOnline: boolean };
  lastSeen: string | null;
  companion: { version: string | null; pageKind: string | null; pendingReportCount: number; lastResult: string | null };
};

type SupplementalCredentials = {
  weread: { ready: boolean; reason: string };
  yuanbao: { ready: boolean; reason: string };
};

function normalizeKuaidianJob(item: unknown): KuaidianJob {
  const root = asRecord(item) ?? {};
  return {
    id: asString(root.id) ?? "unknown",
    itemId: asNumber(root.itemId),
    legacyTaskId: asString(root.legacyTaskId) ?? null,
    title: asString(root.title) ?? asString(root.displayName) ?? "视频号内容",
    status: asString(root.status) ?? "unknown",
    displayStatus: asString(root.displayStatus) ?? asString(root.status) ?? "未知",
    updatedAt: asString(root.updatedAt) ?? null,
    retryCount: asNumber(root.retryCount) ?? 0,
    assetId: asString(root.assetId) ?? null,
    errorDisplay: asString(root.errorDisplay) ?? null,
    retryMode: asString(root.retryMode) ?? "none",
    source: asString(root.source) ?? "kb",
  };
}

function kuaidianFilterMatch(job: KuaidianJob, filter: "all" | "processing" | "completed" | "attention"): boolean {
  if (filter === "all") return true;
  if (filter === "processing") return ["processing", "pending", "awaiting_primary_download", "awaiting_fallback_media", "running", "queued"].includes(job.status);
  if (filter === "completed") return ["success", "duplicate", "linked", "completed"].includes(job.status);
  return ["failed", "partial", "orphaned", "needs_attention", "recovered_stale_processing"].includes(job.status);
}

function formatJobTime(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function Inbox({
  agentState,
  services,
  linkValue,
  setLinkValue,
  onCreate,
}: {
  agentState: AgentState;
  services: LocalService[];
  linkValue: string;
  setLinkValue: (value: string) => void;
  onCreate: () => void;
}) {
  const [kStatus, setKStatus] = useState<KuaidianStatus | null>(null);
  const [jobs, setJobs] = useState<KuaidianJob[]>([]);
  const [counts, setCounts] = useState({ all: 0, processing: 0, completed: 0, needsAttention: 0 });
  const [filter, setFilter] = useState<"all" | "processing" | "completed" | "attention">("all");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [credentials, setCredentials] = useState<SupplementalCredentials | null>(null);
  const [credentialView, setCredentialView] = useState<"weread" | "yuanbao" | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      const [s, j, c] = await Promise.all([
        fetchJson("/api/v1/kuaidian/status").catch(() => null),
        fetchJson("/api/v1/kuaidian/jobs").catch(() => null),
        fetchJson("/api/v1/credentials/status").catch(() => null),
      ]);
      if (!alive) return;
      setKStatus(asRecord(s) as KuaidianStatus | null);
      const jobsPayload = asRecord(j);
      setJobs(collectionFrom(jobsPayload, "jobs").map(normalizeKuaidianJob));
      const credentialPayload = asRecord(c);
      if (credentialPayload?.weread && credentialPayload?.yuanbao) setCredentials(credentialPayload as unknown as SupplementalCredentials);
      const jobCounts = asRecord(jobsPayload?.counts);
      setCounts({
        all: asNumber(jobCounts?.all) ?? 0,
        processing: asNumber(jobCounts?.processing) ?? 0,
        completed: asNumber(jobCounts?.completed) ?? 0,
        needsAttention: asNumber(jobCounts?.needsAttention) ?? 0,
      });
    };
    void load();
    const timer = setInterval(load, 5000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const states = kStatus?.states ?? null;
  const mpTools = services.find((service) => service.id === "wechat_mp_tools") ?? null;
  const filteredJobs = jobs.filter((job) => kuaidianFilterMatch(job, filter));

  const retryJob = async (job: KuaidianJob) => {
    const retryPath = job.itemId != null
      ? `/api/v1/kuaidian/jobs/${job.itemId}/retry`
      : job.retryMode === "legacy_retry" && job.legacyTaskId
        ? `/api/v1/kuaidian/legacy/${encodeURIComponent(job.legacyTaskId)}/retry`
        : null;
    if (!retryPath) {
      setNotice("这条任务缺少可重试的标识，请重新转发到文件传输助手");
      return;
    }
    setRetrying(job.id);
    setNotice(null);
    try {
      const response = await fetch(`${LOCAL_AGENT_URL}${retryPath}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(15000),
      });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (response.status === 202) {
        setNotice(body?.retryMode === "companion_resupply"
          ? "已排队重试：等待伴生桥用原版快点重新解析并重报"
          : body?.retryMode === "legacy_retry"
            ? "已提交历史卡片重试，会重新解析并下载"
            : "已提交本地重试");
      } else {
        setNotice(asString(body?.reasonZh) ?? `重试失败（HTTP ${response.status}）`);
      }
    } catch {
      setNotice("重试请求失败：本地节点不可达");
    }
    setRetrying(null);
  };

  const openFilehelper = async () => {
    setNotice(null);
    try {
      const response = await fetch(`${LOCAL_AGENT_URL}/api/v1/kuaidian/open-filehelper`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.timeout(8000),
      });
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      setNotice(response.ok
        ? "已用 Microsoft Edge 打开文件传输助手网页版"
        : (asString(body?.reasonZh) ?? "未能打开 Microsoft Edge"));
    } catch {
      setNotice("打开请求失败：本地节点不可达");
    }
  };

  const companionOnline = Boolean(states?.companionOnline);
  const filehelperConnected = Boolean(states?.filehelperPageConnected);
  const wechatLoggedIn = Boolean(states?.wechatLoggedIn);
  const originalKuaidian = Boolean(states?.originalKuaidianDetected);

  return (
    <>
      <section className="inbox-banner">
        <div className="inbox-banner-copy">
          <span className="eyebrow-pill"><i /> {agentState === "online" ? "本地节点在线" : "本地节点未连接"}</span>
          <h2>微信文件传输助手主采集</h2>
          <p>主入口是微信文件传输助手：手机转发后，原版快点与织台伴生桥自动解析入库。ClawBot 仅作备用直链入口和手机控制。</p>
          <div className="inline-capture">
            <input value={linkValue} onChange={(event) => setLinkValue(event.target.value)} placeholder="补充入口：粘贴分享链接" />
            <button className="primary-button" type="button" onClick={onCreate} disabled={agentState !== "online"}>立即采集</button>
          </div>
        </div>
        <div className="listener-card">
          <div>
            <span className={`node-signal ${wechatLoggedIn ? "online" : "offline"}`} />
            <p><strong>主入口 → 微信文件传输助手</strong><small>{!companionOnline ? "主入口网页未连接，需要打开并登录" : wechatLoggedIn ? "主入口在线，可接收手机转发" : "主入口网页在线，但微信未登录"}</small></p>
          </div>
          <ul>
            <li><span>原版快点脚本</span><strong>{originalKuaidian ? "已检测到解析结果" : "未检测到（未转发或脚本未运行）"}</strong></li>
            <li><span>伴生桥版本</span><strong>{kStatus?.companion?.version ?? "—"}</strong></li>
            <li><span>待报数</span><strong>{asNumber(kStatus?.companion?.pendingReportCount) ?? 0}</strong></li>
            <li><span>补充下载</span><strong>织台内置多平台采集（次选）</strong></li>
          </ul>
          {(!companionOnline || !wechatLoggedIn) && (
            <button className="listener-setup-button" type="button" style={{ marginTop: 10, width: "100%" }} onClick={openFilehelper} disabled={agentState !== "online"}>打开/恢复文件传输助手（Microsoft Edge）</button>
          )}
          {companionOnline && wechatLoggedIn && <p className="listener-ready-note">主入口已就绪：手机发到微信文件传输助手的内容会自动入库</p>}
          {companionOnline && !wechatLoggedIn && <p className="inline-notice">文件传输助手网页已经打开，但微信账号未登录。请扫码；登录成功后脚本会自动保存可恢复的本地会话。</p>}
        </div>
      </section>

      <section className="panel kuaidian-status-cards">
        <div className="kuaidian-card"><span className={`node-signal ${agentState === "online" ? "online" : "offline"}`} /><p><strong>本地节点</strong><small>{agentState === "online" ? "运行中" : "未连接"}</small></p></div>
        <div className="kuaidian-card"><span className={`node-signal ${filehelperConnected ? "online" : "checking"}`} /><p><strong>文件传输助手网页</strong><small>{filehelperConnected ? "主入口页面脚本在线" : "需打开（主入口）"}</small></p></div>
        <div className="kuaidian-card"><span className={`node-signal ${wechatLoggedIn ? "online" : "checking"}`} /><p><strong>微信账号登录</strong><small>{wechatLoggedIn ? "已登录，主入口可用" : filehelperConnected ? "需扫码登录主入口" : "打开文件传输助手后登录"}</small></p></div>
        <div className="kuaidian-card"><span className={`node-signal ${originalKuaidian ? "online" : "checking"}`} /><p><strong>原版快点</strong><small>{originalKuaidian ? "已检测" : "收到新卡片时自动检测"}</small></p></div>
        <div className="kuaidian-card"><span className={`node-signal ${companionOnline ? "online" : "checking"}`} /><p><strong>伴生桥</strong><small>{companionOnline ? (kStatus?.lastSeen ? `最近心跳 ${formatJobTime(kStatus.lastSeen)}` : "在线") : "待网页连接（不影响本地节点）"}</small></p></div>
      </section>

      <section className="panel credential-panel">
        <div className="panel-heading table-heading"><div><span>登录管理</span><h3>微信读书与腾讯元宝</h3></div></div>
        <div className="credential-grid">
          <div><p><strong>微信读书</strong><small>用于公众号检索、订阅、文章列表与正文补全。</small></p><StatusPill status={credentials?.weread.ready ? "有效" : "需登录"} /><button type="button" className="secondary-button" onClick={() => setCredentialView(credentialView === "weread" ? null : "weread")}>{credentialView === "weread" ? "收起" : "登录微信读书"}</button><small>{credentials?.weread.reason ?? "检测中"}</small></div>
          <div><p><strong>腾讯元宝</strong><small>用于视频号链接解析、标题/作者/互动数据补全和反推分析。</small></p><StatusPill status={credentials?.yuanbao.ready ? "已保存" : "需登录"} /><button type="button" className="secondary-button" onClick={() => setCredentialView(credentialView === "yuanbao" ? null : "yuanbao")}>{credentialView === "yuanbao" ? "收起" : "登录腾讯元宝"}</button><small>{credentials?.yuanbao.reason ?? "检测中"}</small></div>
        </div>
        {credentialView && <iframe title={credentialView === "weread" ? "微信读书登录" : "腾讯元宝登录"} src={credentialView === "weread" ? "http://127.0.0.1:5200/#login" : "http://127.0.0.1:5200/#channels_login"} style={{ width: "100%", height: 720, border: "1px solid var(--line)", borderRadius: 12, background: "white", marginTop: 12 }} />}
      </section>

      {mpTools && (
        <section className="panel" style={{ padding: 14 }}>
          <details>
            <summary style={{ cursor: "pointer", fontWeight: 700 }}>织台内置补充采集（{displayStatus(mpTools.status)}）</summary>
            <p className="mp-tools-secondary">作为链接补充采集使用；公众号、抖音、小红书、快手和 B 站均在织台窗口内操作，不再启动外部应用。</p>
            {mpTools.status === "healthy" || mpTools.status === "running" ? (
              <iframe title="织台补充采集" src="http://127.0.0.1:5200/" style={{ width: "100%", height: 720, border: "1px solid #deded8", borderRadius: 12, background: "white" }} />
            ) : <div className="inline-notice">补充采集引擎正在启动，请稍后刷新。</div>}
          </details>
        </section>
      )}

      {notice && <div className="inline-notice">{notice}</div>}

      <section className="panel table-panel">
        <div className="panel-heading table-heading">
          <div><span>快点任务</span><h3>真实队列（import_item + 历史）</h3></div>
          <div className="filter-pills">
            <button type="button" className={filter === "all" ? "active" : ""} onClick={() => setFilter("all")}>全部 {counts.all}</button>
            <button type="button" className={filter === "processing" ? "active" : ""} onClick={() => setFilter("processing")}>处理中 {counts.processing}</button>
            <button type="button" className={filter === "completed" ? "active" : ""} onClick={() => setFilter("completed")}>已完成 {counts.completed}</button>
            <button type="button" className={filter === "attention" ? "active" : ""} onClick={() => setFilter("attention")}>下载失败 {counts.needsAttention}</button>
          </div>
        </div>
        <div className="data-table task-table">
          <div className="table-row table-header"><span>内容</span><span>状态</span><span>更新时间</span><span>重试</span><span /></div>
          {filteredJobs.map((job) => (
            <div className="kuaidian-job" key={job.id}>
              <div className="table-row" onClick={() => setExpanded(expanded === job.id ? null : job.id)}>
                <div className="table-content-cell"><p><strong>{job.title}</strong><small>{job.id}</small></p></div>
                <span><StatusPill status={job.displayStatus} /></span>
                <span>{formatJobTime(job.updatedAt)}</span>
                <span>{job.retryCount}</span>
                <button type="button" aria-label="详情">{(expanded === job.id ? "收起" : "详情")}</button>
              </div>
              {expanded === job.id && (
                <div className="kuaidian-job-detail">
                  <dl>
                    <div><dt>状态</dt><dd>{job.displayStatus}</dd></div>
                    <div><dt>重试模式</dt><dd>{job.retryMode === "none" ? "无需重试" : job.retryMode === "local_retry" ? "本地重试" : job.retryMode === "legacy_retry" ? "历史卡片重试" : "伴生桥重供"}</dd></div>
                    <div><dt>重试次数</dt><dd>{job.retryCount}</dd></div>
                    <div><dt>资产</dt><dd>{job.assetId ? "已入库" : "无"}</dd></div>
                    {job.errorDisplay && <div><dt>失败原因</dt><dd>{job.errorDisplay}</dd></div>}
                    {job.retryMode !== "none" && job.itemId == null && !job.legacyTaskId && <p className="mp-tools-secondary">这条任务没有保留可重试标识，请重新转发</p>}
                  </dl>
                  {job.retryMode !== "none" && (job.itemId != null || Boolean(job.legacyTaskId)) && (
                    <button className="listener-setup-button" type="button" disabled={retrying === job.id || agentState !== "online"} onClick={() => retryJob(job)}>
                      {retrying === job.id ? "重试中…" : (job.retryMode === "local_retry" ? "本地重试" : job.retryMode === "legacy_retry" ? "重试历史卡片" : "原版快点重供")}
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
          {!filteredJobs.length && <div className="empty-state"><span>↓</span><strong>{jobs.length ? "该筛选下暂无任务" : (agentState === "online" ? "还没有采集任务" : "本地节点未连接")}</strong><p>{agentState === "online" ? "把内容发到微信文件传输助手后会自动出现在这里；ClawBot 直发链接是备用入口。" : "启动本地节点后，这里会显示真实任务。"}</p></div>}
        </div>
      </section>
    </>
  );
}

function formatLibraryDate(value: string | null): string {
  if (!value) return "来源未提供";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatMetric(value: MetricValue, compact = true): string {
  if (value === null) return "未获取";
  if (typeof value === "string") return value;
  return new Intl.NumberFormat("zh-CN", compact
    ? { notation: "compact", maximumFractionDigits: 1 }
    : { maximumFractionDigits: 0 }).format(value);
}

function Updates({ agentState }: { agentState: AgentState }) {
  const [modules, setModules] = useState<UpdateModule[]>([]);
  const [checking, setChecking] = useState(false);
  const [message, setMessage] = useState("");
  const [installingId, setInstallingId] = useState<string | null>(null);

  const load = useCallback(async (refresh = false) => {
    setChecking(true);
    try {
      const response = await fetch(`${LOCAL_AGENT_URL}/api/v1/updates${refresh ? "?refresh=1" : ""}`, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const json = asRecord(await response.json());
      const rows = collectionFrom(json, "modules").map((row) => ({
        id: asString(row.id) ?? "unknown",
        name: asString(row.name) ?? "未知模块",
        current: asString(row.current) ?? "unknown",
        latest: asString(row.latest) ?? "unavailable",
        updateAvailable: asBoolean(row.updateAvailable) ?? false,
        canInstall: asBoolean(row.canInstall) ?? false,
        blockedReason: asString(row.blockedReason),
        policy: asString(row.policy) ?? "manual",
        note: asString(row.note) ?? "",
        homepage: asString(row.homepage),
        publishedAt: asString(row.publishedAt),
      }));
      setModules(rows);
      setMessage(refresh ? "已检查官方稳定版" : "");
    } catch {
      setMessage("检查失败，请确认本地节点和网络正常");
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => { void load(false); }, [load]);

  const install = useCallback(async (module: UpdateModule) => {
    if (!module.canInstall || installingId) return;
    if (!window.confirm(`确认把“${module.name}”从 ${module.current} 更新到 ${module.latest}？\n\n织台会先旁路安装和验证，成功后再切换，并保留旧版本。`)) return;
    setInstallingId(module.id);
    setMessage(`${module.name} 正在下载、旁路验证并切换，请不要退出织台…`);
    try {
      const response = await fetch(`${LOCAL_AGENT_URL}/api/v1/updates/${encodeURIComponent(module.id)}/install`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Zhitai-Action": "confirm" },
        body: JSON.stringify({ expectedVersion: module.latest }),
      });
      const result = asRecord(await response.json().catch(() => null)) ?? {};
      if (!response.ok) throw new Error(asString(result.error) ?? asString(result.message) ?? `HTTP ${response.status}`);
      setMessage(`${module.name} 已更新到 ${asString(result.version) ?? module.latest}。${asBoolean(result.restartRequired) ? "退出并重新打开织台后生效。" : "已立即生效。"}`);
      await load(true);
    } catch (error) {
      setMessage(`${module.name} 更新失败：${error instanceof Error ? error.message : String(error)}。当前版本未切换。`);
    } finally {
      setInstallingId(null);
    }
  }, [installingId, load]);

  return (
    <section style={{ display: "grid", gap: 18 }}>
      <div className="section-head">
        <div><span className="eyebrow-pill"><i /> {agentState === "online" ? "本地版本已读取" : "本地节点未连接"}</span><h2 style={{ marginTop: 12 }}>织台模块更新中心</h2><p>可直接安装官方稳定版：织台会先备份、旁路安装和验证，成功后才切换；检测到本地代码改动的模块不会强行覆盖。</p></div>
        <button className="primary-button" type="button" onClick={() => void load(true)} disabled={checking || agentState !== "online"}>{checking ? "检查中…" : "检查更新"}</button>
      </div>
      {message && <div className="empty-state" style={{ minHeight: 0, padding: 12 }}><p>{message}</p></div>}
      <div className="library-grid">
        {modules.map((module) => (
          <article className="library-card" key={module.id} style={{ minHeight: 0 }}>
            <div className="library-card-body">
              <span><b>{module.policy === "frozen" ? "已冻结" : module.updateAvailable ? "可更新" : "已是稳定版"}</b></span>
              <h3>{module.name}</h3>
              <div className="library-card-facts"><span><b>当前</b>{module.current}</span><span><b>官方稳定版</b>{module.latest}</span></div>
              <p style={{ color: "#62675f", fontSize: 14, lineHeight: 1.6 }}>{module.note}</p>
              {module.blockedReason && <p style={{ color: "#a24d34", fontSize: 13, lineHeight: 1.5 }}>{module.blockedReason}</p>}
              {module.publishedAt && <small>发布时间：{formatLibraryDate(module.publishedAt)}</small>}
              {module.canInstall && <button className="primary-button" type="button" style={{ marginTop: 12, width: "100%" }} disabled={Boolean(installingId)} onClick={() => void install(module)}>{installingId === module.id ? "正在更新…" : `直接更新到 ${module.latest}`}</button>}
              {module.updateAvailable && !module.canInstall && module.homepage && <a href={module.homepage} target="_blank" rel="noreferrer" className="secondary-button" style={{ marginTop: 12, width: "100%", textAlign: "center", display: "block" }}>查看官方更新</a>}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

function MvpUsageBar() {
  const steps = [
    { n: "1", text: "手机转发到微信文件传输助手" },
    { n: "2", text: "ClawBot 可备用直发链接并遥控织台" },
    { n: "3", text: "下载完成后会自动进入内容库" },
  ];
  return (
    <section className="mvp-usage-bar" aria-label="织台 MVP 使用步骤">
      <span className="mvp-usage-tag">织台 MVP</span>
      <ol>
        {steps.map((step) => (
          <li key={step.n} data-step={step.n}>{step.text}</li>
        ))}
      </ol>
    </section>
  );
}

function Library({
  agentState,
  health,
  items,
  totalItems,
  searchValue,
  setSearchValue,
  category,
  setCategory,
  selectedDate,
  setSelectedDate,
  onRefresh,
  onOpenFolder,
  onOpen,
}: {
  agentState: AgentState;
  health: HealthInfo | null;
  items: LibraryItem[];
  totalItems: LibraryItem[];
  searchValue: string;
  setSearchValue: (value: string) => void;
  category: "全部" | LibraryCategory;
  setCategory: (value: "全部" | LibraryCategory) => void;
  selectedDate: string;
  setSelectedDate: (value: string) => void;
  onRefresh: () => void;
  onOpenFolder: () => void;
  onOpen: (item: LibraryItem) => void;
}) {
  const [xSyncing, setXSyncing] = useState(false);
  const [xMessage, setXMessage] = useState<string | null>(null);
  const totalBytes = totalItems.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);
  const categories: Array<"全部" | LibraryCategory> = ["全部", "素材", "技能", "其他", "未分类"];
  const today = localDateKey(new Date().toISOString()) ?? "";
  const summaryDate = selectedDate || today;
  const summaryItems = totalItems.filter((item) => localDateKey(item.createdAt) === summaryDate);
  const xItems = summaryItems.filter((item) => item.contentKind === "x_bookmark");
  const videoItems = summaryItems.filter((item) => item.contentKind !== "x_bookmark");
  const materialCount = videoItems.filter((item) => item.category === "素材").length;
  const skillCount = videoItems.filter((item) => item.category === "技能").length;
  const missingAnalysisCount = videoItems.filter((item) => !item.overview && !item.analysisText).length;
  const engagementScore = (item: LibraryItem) => [item.metrics.views, item.metrics.likes, item.metrics.favorites, item.metrics.comments, item.metrics.shares]
    .reduce<number>((sum, value) => sum + (typeof value === "number" ? value : 0), 0);
  const recommendationEligible = summaryItems.filter((item) => !/ONED-|成人|色情|裸聊|福利|拍片|越狱模型|无审查/i.test(`${item.title} ${item.tags.join(" ")}`));
  const topEngagement = [...recommendationEligible].sort((left, right) => engagementScore(right) - engagementScore(left))[0] ?? null;
  const workflowRules = [
    { pattern: /发布|矩阵|定时|排期|账号|运营/, target: "发布中心 / 排期", reason: "可减少多平台重复操作" },
    { pattern: /字幕|转写|文案|OCR|镜头|视频分析|提示词拆|B-roll|复刻/i, target: "视频分析", reason: "可补强素材拆解和复刻提示词" },
    { pattern: /下载|采集|去水印|解析|文件传输助手/, target: "下载链路", reason: "可提高素材自动入库成功率" },
    { pattern: /(?:内容|视频|剪辑|发布|采集).{0,24}(?:工作流|自动化|Agent|MCP|API|n8n)|(?:工作流|自动化|Agent|MCP|API|n8n).{0,24}(?:内容|视频|剪辑|发布|采集)/i, target: "自动化编排", reason: "适合变成可重复执行的后台步骤" },
    { pattern: /审核|敏感词|风险|合规|违禁/, target: "发布前检查", reason: "可降低发布失败和账号风险" },
    { pattern: /记忆|知识库|搜索|总结|归档/, target: "知识库", reason: "可改善检索与每日学习" },
  ];
  const workflowCandidates = recommendationEligible.flatMap((item) => {
    const source = `${item.title} ${item.overview ?? ""} ${item.analysisText ?? ""} ${item.tags.join(" ")}`;
    const rule = workflowRules.find((candidate) => candidate.pattern.test(source));
    return rule ? [{ item, ...rule }] : [];
  }).filter((candidate, index, all) => all.findIndex((other) => other.target === candidate.target) === index).slice(0, 3);
  const highlights = [
    materialCount ? `${materialCount} 条素材已经可以进入一键复刻队列` : null,
    skillCount ? `${skillCount} 条技能内容已进入每日学习清单` : null,
    xItems.length ? `${xItems.length} 条 X 收藏已和视频放在同一天归档` : null,
    missingAnalysisCount ? `${missingAnalysisCount} 条视频尚缺完整概览，建议优先补分析` : null,
    topEngagement && engagementScore(topEngagement) > 0 ? `互动证据最强：${topEngagement.title}` : null,
  ].filter((item): item is string => Boolean(item));
  const runXSync = async () => {
    setXSyncing(true);
    setXMessage(null);
    try {
      const result = await syncXBookmarks(true);
      if (!result.ok) {
        setXMessage(result.error ?? "X 收藏同步暂不可用");
        return;
      }
      setXMessage(`已读取 ${result.fetched ?? 0} 条，新入库 ${result.imported ?? 0} 条`);
      onRefresh();
    } finally {
      setXSyncing(false);
    }
  };
  return (
    <>
      <section className="library-toolbar">
        <div className="library-count"><strong>{totalItems.length}</strong><span>个内容包<br /><small>{formatBytes(totalBytes)}</small></span></div>
        <label><span>⌕</span><input value={searchValue} onChange={(event) => setSearchValue(event.target.value)} placeholder="搜索标题、作者、标签或分析文本…" /></label>
        <span className={`library-sync ${agentState}`}>{agentState === "online" ? "已同步" : agentState === "checking" ? "同步中" : "离线"}</span>
        <div className="library-date-filter">
          <button type="button" className={!selectedDate ? "active" : ""} onClick={() => setSelectedDate("")}>全部日期</button>
          <button type="button" className={selectedDate === today ? "active" : ""} onClick={() => setSelectedDate(today)}>今天</button>
          <input type="date" value={selectedDate} onChange={(event) => setSelectedDate(event.target.value)} aria-label="按采集日期筛选" />
        </div>
        <button className="secondary-button" type="button" onClick={onRefresh} disabled={agentState === "checking"}>{agentState === "checking" ? "刷新中…" : "刷新"}</button>
        <button className="secondary-button" type="button" onClick={onOpenFolder} disabled={agentState !== "online"} title={health?.knowledgeBase ?? "等待本地节点"}>在 Finder 打开</button>
      </section>
      <section className="library-daily-summary">
        <header>
          <div><span>每日入库摘要</span><h2>{summaryDate || "今天"}</h2></div>
          <div className="library-daily-counts"><strong>{videoItems.length}</strong><span>条转发视频</span><strong>{xItems.length}</strong><span>条 X 收藏</span></div>
          <button className="secondary-button" type="button" onClick={() => void runXSync()} disabled={xSyncing || agentState !== "online"}>{xSyncing ? "正在同步 X…" : xItems.length ? "同步 X 收藏" : "登录 / 同步 X 收藏"}</button>
        </header>
        {xMessage && <p className="library-x-message">{xMessage}</p>}
        <div className="library-daily-columns">
          <div><h3>{summaryDate === today ? "今天收了什么" : "这天收了什么"}</h3>{summaryItems.length ? <ol>{summaryItems.slice(0, 10).map((item) => <li key={item.id}><b>{item.contentKind === "x_bookmark" ? "X" : item.category}</b><span>{item.title}</span></li>)}</ol> : <p>这一天还没有入库内容。</p>}{summaryItems.length > 10 && <small>另外还有 {summaryItems.length - 10} 条，可在下方继续查看。</small>}</div>
          <div><h3>特别注意</h3>{highlights.length ? <ul>{highlights.map((item) => <li key={item}>{item}</li>)}</ul> : <p>已有内容尚无需要特别提醒的异常；互动量和完播率未取得时不会猜测“为什么火”。</p>}</div>
          <div className="library-workflow-advice"><h3>建议接入织台</h3>{workflowCandidates.length ? <ul>{workflowCandidates.map(({ item, target, reason }) => <li key={`${item.id}-${target}`}><b>{target}</b><span><strong>{item.title}</strong><small>{reason}</small></span></li>)}</ul> : <p>今天暂无足够明确的流程改进素材；不会为了凑建议而猜测。</p>}</div>
        </div>
      </section>
      <nav className="library-categories" aria-label="内容库分类">
        {categories.map((value) => {
          const count = value === "全部" ? totalItems.length : totalItems.filter((item) => item.category === value).length;
          return <button key={value} type="button" className={category === value ? "active" : ""} onClick={() => setCategory(value)}>{value}<span>{count}</span></button>;
        })}
      </nav>
      <section className="library-grid">
        {items.map((item, index) => (
          <article className="library-card" key={item.id}>
            <div className={`asset-cover ${item.tone} ${item.coverUrl ? "has-image" : ""}`}>
              {item.coverUrl ? <img className="asset-cover-image" src={item.coverUrl} alt={`${item.title} 封面`} loading="lazy" /> /* eslint-disable-line @next/next/no-img-element -- v1 遗留封面图 */ : <div className="cover-grid" />}
              <PlatformMark name={item.platform} />
              <span className="asset-category">{item.category}</span>
              {!item.coverUrl && <strong>{item.title.slice(0, 12)}</strong>}
              <small>{item.coverUrl ? "真实封面" : "封面来源未提供"} · {String(index + 1).padStart(2, "0")}</small>
              <button type="button" onClick={() => onOpen(item)} aria-label={`预览 ${item.title}`}>▶</button>
            </div>
            <div className="library-card-body">
              <span>{item.id}<button type="button" onClick={() => onOpen(item)} aria-label={`查看 ${item.title} 详情`}>详情</button></span>
              <h3>{item.title}</h3>
              <div className="library-card-facts">
                <span><b>作者</b>{item.author ?? "来源未提供"}</span>
                <span><b>发布</b>{formatLibraryDate(item.publishedAt)}</span>
                <span className={`quality-${item.qualityState ?? "unknown"}`} title={item.qualityReason ?? "技术元数据不足"}><b>原片画质</b>{item.qualityLabel ?? "待检测"}</span>
              </div>
              <div className="library-card-metrics" aria-label="互动数据">
                <span title={item.metrics.views === null ? "播放量未获取" : `播放 ${formatMetric(item.metrics.views, false)}`}><b>播</b>{formatMetric(item.metrics.views)}</span>
                <span><b>赞</b>{formatMetric(item.metrics.likes)}</span>
                <span><b>藏</b>{formatMetric(item.metrics.favorites)}</span>
                <span><b>评</b>{formatMetric(item.metrics.comments)}</span>
                <span><b>转</b>{formatMetric(item.metrics.shares)}</span>
              </div>
              <div className="library-tags">{item.tags.slice(0, 5).map((tag) => <em key={tag}>#{tag}</em>)}{item.tags.length > 5 && <em>+{item.tags.length - 5}</em>}</div>
            </div>
          </article>
        ))}
        {!items.length && <div className="empty-state"><span>⌕</span><strong>{searchValue || category !== "全部" || selectedDate ? "没有找到内容包" : agentState === "online" ? "本地知识库还是空的" : "等待本地节点"}</strong><p>{searchValue || category !== "全部" || selectedDate ? "换一个关键词、分类或日期试试。" : agentState === "online" ? "采集完成后，metadata.json 会出现在这里。" : "启动本地节点后读取真实内容包。"}</p></div>}
      </section>
    </>
  );
}

function LibraryDetail({
  item,
  loading,
  loadError,
  onClose,
  onUpdated,
}: {
  item: LibraryItem;
  loading: boolean;
  loadError: string | null;
  onClose: () => void;
  onUpdated: (item: LibraryItem) => void;
}) {
  const isXBookmark = item.contentKind === "x_bookmark";
  const [mediaFailed, setMediaFailed] = useState(false);
  const [showPerformanceImport, setShowPerformanceImport] = useState(false);
  const [performanceImporting, setPerformanceImporting] = useState(false);
  const [performanceMessage, setPerformanceMessage] = useState<string | null>(null);
  const [performanceDraft, setPerformanceDraft] = useState({
    plays: "", likes: "", favorites: "", comments: "", shares: "",
    avgWatchSeconds: "", completionRate: "", retention: "", trafficSource: "", commentText: "",
  });
  // previewUrl 变化时重置失败态（无级联副作用）
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setMediaFailed(false), [item.previewUrl]);
  useEffect(() => {
    setPerformanceMessage(null);
    setShowPerformanceImport(false);
  }, [item.id]);
  const updatePerformanceDraft = (key: keyof typeof performanceDraft, value: string) => {
    setPerformanceDraft((current) => ({ ...current, [key]: value }));
  };
  const submitPerformance = async () => {
    setPerformanceImporting(true);
    setPerformanceMessage(null);
    try {
      const response = await fetch(`${LOCAL_AGENT_URL}/api/v1/kb/videos/${encodeURIComponent(item.id)}/performance`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Zhitai-Action": "confirm" },
        body: JSON.stringify({ ...performanceDraft, source: "创作者后台手工导入" }),
      });
      const payload = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok || payload.ok !== true) throw new Error(asString(payload.message) ?? asString(payload.error) ?? `HTTP ${response.status}`);
      const detail = await fetchLibraryDetail(item.id);
      onUpdated(detail);
      setPerformanceMessage(`已保存表现快照${asNumber(payload.commentsImported) ? `和 ${asNumber(payload.commentsImported)} 条新评论` : ""}`);
      setPerformanceDraft((current) => ({ ...current, commentText: "" }));
    } catch (error) {
      setPerformanceMessage(`导入失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setPerformanceImporting(false);
    }
  };
  const metricItems: Array<{ label: string; value: MetricValue }> = [
    { label: "播放", value: item.metrics.views },
    { label: "点赞", value: item.metrics.likes },
    { label: "收藏", value: item.metrics.favorites },
    { label: "评论", value: item.metrics.comments },
    { label: "转发", value: item.metrics.shares },
  ];
  const transcriptSegments = item.transcript.length ? item.transcript : [];
  return (
    <div className="modal-backdrop library-detail-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="modal-card library-detail-modal" role="dialog" aria-modal="true" aria-labelledby="library-detail-title">
        <button className="modal-close" type="button" onClick={onClose} aria-label="关闭内容详情">×</button>
        <header className="library-detail-header">
          <div><PlatformMark name={item.platform} /><span>{item.platform}</span><span>{item.category}</span>{loading && <span>正在载入完整分析…</span>}{!loading && !item.analysisReady && <span>后台分析中 · 完成后自动刷新</span>}{loadError && <span title={loadError}>完整分析暂不可用</span>}</div>
          <h2 id="library-detail-title">{item.title}</h2>
          <dl>
            <div><dt>作者</dt><dd>{item.author ?? "来源未提供"}</dd></div>
            <div><dt>发布时间</dt><dd>{formatLibraryDate(item.publishedAt)}</dd></div>
            <div><dt>采集时间</dt><dd>{formatLibraryDate(item.createdAt)}</dd></div>
            <div><dt>原片画质</dt><dd title={item.qualityReason ?? ""}>{item.qualityLabel ?? "待检测"}</dd></div>
          </dl>
        </header>

        <div className="library-detail-layout">
          <aside className="library-preview-panel">
            {isXBookmark ? (
              <div className={`library-post-preview ${item.coverUrl ? "with-cover" : ""}`}>
                {item.coverUrl && <img src={item.coverUrl} alt="X 收藏配图" loading="lazy" /> /* eslint-disable-line @next/next/no-img-element -- 外部帖子预览 */}
                <span>X 收藏</span>
                <p>{item.overview ?? item.title}</p>
                {item.sourceUrl && <a href={item.sourceUrl} target="_blank" rel="noreferrer">打开 X 原帖 ↗</a>}
              </div>
            ) : item.previewUrl && !mediaFailed ? (
              <video controls playsInline preload="metadata" poster={item.coverUrl ?? undefined} src={item.previewUrl} onError={() => setMediaFailed(true)}><track kind="captions" />当前浏览器无法播放这个视频。</video>
            ) : item.coverUrl ? (
              <div className="library-preview-unavailable with-cover" style={{ backgroundImage: `linear-gradient(rgba(20, 23, 19, .42), rgba(20, 23, 19, .72)), url(${JSON.stringify(item.coverUrl).slice(1, -1)})` }}><strong>视频预览不可用</strong><span>{mediaFailed ? "本地媒体地址加载失败" : "本地节点尚未提供可访问的视频地址"}</span></div>
            ) : (
              <div className="library-preview-unavailable"><strong>视频预览尚未提供</strong><span>{mediaFailed ? "本地媒体地址加载失败" : "来源未提供封面或可访问的视频地址"}</span></div>
            )}
            <div className="library-preview-meta"><span>{item.contentKind ?? "内容类型未提供"}</span><span>{item.meta}</span>{item.sourceUrl && <a href={item.sourceUrl} target="_blank" rel="noreferrer">打开原始链接 ↗</a>}</div>
          </aside>

          <div className="library-detail-content">
            <section className="library-detail-section overview-section">
              <header><div><span>01</span><h3>内容概览</h3></div><div>{item.overviewSource && <em>{item.overviewSource === "analysis" ? "分析结果" : "来源简介"}</em>}{item.analysisReady && <em>{item.yuanbaoInsightAvailable ? "元宝 + 本地分析" : "本地分析 · 元宝对话不可用"}</em>}</div></header>
              {item.overview ? <p>{item.overview}</p> : <div className="analysis-empty"><strong>尚未分析</strong><span>来源也未提供可用于概览的简介。</span></div>}
              {item.tags.length > 0 && <div className="detail-tags">{item.tags.map((tag) => <span key={tag}>#{tag}</span>)}</div>}
            </section>

            <section className="library-detail-section">
              <header><div><span>02</span><h3>表现数据与评论</h3></div><div className="performance-header-actions"><em>{item.metrics.capturedAt ? `快照 ${formatLibraryDate(item.metrics.capturedAt)}` : "来源未提供快照时间"}</em><button type="button" onClick={() => setShowPerformanceImport((current) => !current)}>{showPerformanceImport ? "收起导入" : "导入后台数据"}</button></div></header>
              <div className="detail-metric-grid">{metricItems.map((metric) => <div key={metric.label}><span>{metric.label}</span><strong className={metric.value === null ? "missing" : ""}>{formatMetric(metric.value, false)}</strong></div>)}</div>
              <div className="performance-evidence-row">
                <div><span>平均观看</span><strong>{item.performance.avgWatchSeconds === null ? "未获取" : `${item.performance.avgWatchSeconds} 秒`}</strong></div>
                <div><span>完播率</span><strong>{item.performance.completionRate === null ? "未获取" : `${item.performance.completionRate}%`}</strong></div>
                <div><span>留存曲线</span><strong>{item.performance.retention.length ? `${item.performance.retention.length} 个点` : "未获取"}</strong></div>
                <div><span>流量来源</span><strong>{item.performance.trafficSource ?? "未获取"}</strong></div>
              </div>
              {item.performance.retention.length > 0 && <div className="retention-strip">{item.performance.retention.map((point) => <span key={`${point.second}-${point.percent}`} style={{ height: `${Math.max(8, Math.min(100, point.percent))}%` }} title={`${point.second} 秒 · ${point.percent}%`}><i>{point.percent}%</i><b>{point.second}s</b></span>)}</div>}
              <p className="detail-evidence-note">“未获取”不代表 0。只有取得播放量后才计算赞播、藏播、评播和转播率。</p>
              {showPerformanceImport && <div className="performance-import-panel">
                <p>把各平台创作者后台看到的数据填进来；支持 <b>1.2万</b>。评论每行一条，留存示例：<b>0=100, 3=72, 8=41</b>。</p>
                <div className="performance-input-grid">
                  {([[
                    "plays", "播放量"], ["likes", "点赞"], ["favorites", "收藏"], ["comments", "评论数"], ["shares", "转发"],
                    ["avgWatchSeconds", "平均观看秒数"], ["completionRate", "完播率 %"], ["trafficSource", "流量来源"],
                  ] as Array<[keyof typeof performanceDraft, string]>).map(([key, label]) => <label key={key}><span>{label}</span><input value={performanceDraft[key]} onChange={(event) => updatePerformanceDraft(key, event.target.value)} placeholder={label} /></label>)}
                </div>
                <label><span>留存时间点</span><textarea value={performanceDraft.retention} onChange={(event) => updatePerformanceDraft("retention", event.target.value)} placeholder="0=100, 3=72, 8=41" /></label>
                <label><span>评论正文（每行一条）</span><textarea value={performanceDraft.commentText} onChange={(event) => updatePerformanceDraft("commentText", event.target.value)} placeholder="开头很吸引我&#10;想看更详细的教程" /></label>
                <div><button type="button" onClick={() => void submitPerformance()} disabled={performanceImporting}>{performanceImporting ? "正在保存…" : "保存为真实数据快照"}</button>{performanceMessage && <span>{performanceMessage}</span>}</div>
              </div>}
              {item.performance.comments.length > 0 && <div className="imported-comment-list"><h4>已导入评论正文 · {item.performance.comments.length} 条</h4>{item.performance.comments.slice(0, 30).map((comment) => <article key={comment.id}><strong>{comment.author ?? "匿名用户"}</strong><p>{comment.content}</p>{comment.likes !== null && <span>赞 {formatMetric(comment.likes, false)}</span>}</article>)}</div>}
            </section>

            <section className="library-detail-section">
              <header><div><span>03</span><h3>转写、配音与文案</h3></div></header>
              <div className="analysis-column">
                <div><h4>语音转写</h4>{transcriptSegments.length ? <ol className="timed-text-list">{transcriptSegments.map((segment) => <li key={segment.id}><time>{segment.startMs === null ? "时间未提供" : formatTimecode(segment.startMs)}</time><p>{segment.speaker && <b>{segment.speaker}：</b>}{segment.text}</p></li>)}</ol> : item.transcriptText ? <p className="long-analysis-text">{item.transcriptText}</p> : <div className="analysis-empty compact"><strong>{item.transcriptStatus === "unavailable" ? "没有可用语音转写" : item.analysisReady ? "未取得转写" : "正在分析"}</strong><span>{item.transcriptNote ?? (item.analysisReady ? "视频可能没有可识别语音。" : "分析完成后会在这里自动刷新。")}</span></div>}</div>
                <div><h4>配音 / 旁白</h4>{item.voiceover ? <p className="long-analysis-text">{item.voiceover}</p> : <div className="analysis-empty compact"><strong>尚未分析</strong><span>没有配音或旁白说明。</span></div>}</div>
                <div><h4>发布文案</h4>{item.copywriting ? <p className="long-analysis-text">{item.copywriting}</p> : <div className="analysis-empty compact"><strong>尚未分析</strong><span>来源未提供独立文案。</span></div>}</div>
              </div>
            </section>

            <section className="library-detail-section">
              <header><div><span>04</span><h3>画面文字 OCR</h3></div></header>
              {item.ocr.length ? <ol className="timed-text-list">{item.ocr.map((segment) => <li key={segment.id}><time>{segment.startMs === null ? "时间未提供" : formatTimecode(segment.startMs)}</time><p>{segment.text}</p></li>)}</ol> : <div className="analysis-empty"><strong>{item.ocrStatus === "unavailable" ? "未识别到画面文字" : item.analysisReady ? "没有可用 OCR" : "正在分析"}</strong><span>{item.ocrNote ?? (item.analysisReady ? "关键帧中没有达到可信阈值的文字。" : "分析完成后会在这里自动刷新。")}</span></div>}
            </section>

            <section className="library-detail-section">
              <header><div><span>05</span><h3>镜头与拍摄角度</h3></div></header>
              {item.shots.length ? <div className="shot-grid">{item.shots.map((shot) => <article key={shot.id}><span>{shot.time ?? "时间未提供"}</span><h4>{[shot.framing, shot.angle].filter(Boolean).join(" · ") || "镜头描述"}</h4>{shot.movement && <em>运镜：{shot.movement}</em>}{shot.description && <p>{shot.description}</p>}<small>{shot.evidence ? `观察依据：${shot.evidence}` : "观察依据未提供"}</small></article>)}</div> : <div className="analysis-empty"><strong>尚未分析</strong><span>没有景别、角度或运镜分析。</span></div>}
            </section>

            <section className="library-detail-section">
              <header><div><span>06</span><h3>传播因素</h3></div><em>分析推断 · 需复核</em></header>
              {item.propagationFactors.length ? <div className="factor-list">{item.propagationFactors.map((factor) => <article key={factor.id}><span>因素</span><div><h4>{factor.title}</h4><p>{factor.evidence ?? "分析结果未提供可核对依据。"}</p></div>{factor.confidence && <em>{factor.confidence}</em>}</article>)}</div> : <div className="analysis-empty"><strong>尚未分析</strong><span>播放、互动或内容证据不足，不能判断“为什么火”。</span></div>}
            </section>

            <section className="library-detail-section evidence-section">
              <header><div><span>07</span><h3>原始证据</h3></div><em>不展示凭据与登录信息</em></header>
              {item.evidence.length ? <dl>{item.evidence.map((evidence, index) => <div key={`${evidence.label}-${index}`}><dt>{evidence.label}</dt><dd>{evidence.href ? <a href={evidence.href} target="_blank" rel="noreferrer">{evidence.value} ↗</a> : evidence.value}</dd></div>)}</dl> : <div className="analysis-empty"><strong>来源未提供</strong><span>没有可核对的链接、时间或文件校验信息。</span></div>}
            </section>
          </div>
        </div>
      </section>
    </div>
  );
}

function PublishCenter({
  agentState,
  tasks,
  services,
  openComposer,
}: {
  agentState: AgentState;
  tasks: WorkbenchTask[];
  services: LocalService[];
  openComposer: () => void;
}) {
  const publisher = services.find((service) => service.id.includes("matrix") || service.id.includes("publisher")) ?? null;
  const pending = tasks.filter((task) => !["failed", "completed", "success", "submitted", "platform_draft"].includes(task.rawStatus.toLowerCase()));
  const successful = tasks.filter((task) => ["submitted", "platform_draft", "completed", "success"].includes(task.rawStatus.toLowerCase())).length;
  const attention = tasks.filter((task) => ["failed", "needs_attention", "needs_setup"].includes(task.rawStatus.toLowerCase())).length;
  return (
    <>
      <section className="publish-hero">
        <div><span className="eyebrow-pill light"><i /> {publisher?.healthy ? "发布器运行中" : publisher?.configured ? "发布器已安装" : "发布器未就绪"}</span><h2>在织台内登录，<br />直接编排发布。</h2><p>默认创建平台草稿。只有你勾选并确认后，织台才会提交直接发布任务。</p><div className="publish-hero-actions"><button className="lime-button" type="button" onClick={openComposer} disabled={agentState !== "online"}>＋ 新建发布任务</button></div></div>
        <div className="platform-board">
          {["抖音", "小红书", "视频号"].map((platform, index) => <div key={platform} style={{ transform: `translateY(${index % 2 ? 22 : 0}px)` }}><PlatformMark name={platform} /><strong>{platform}</strong><span>{publisher?.healthy ? "发布器可达" : publisher?.running ? "需验证登录" : "待配置"}</span></div>)}
        </div>
      </section>
      <section className="publish-stat-row">
        <div><small>任务总数</small><strong>{tasks.length}</strong><span>本地记录</span></div>
        <div><small>已提交/草稿</small><strong>{successful}</strong><span>不等于平台已公开</span></div>
        <div><small>队列与排期</small><strong>{pending.length}</strong><span>等待处理</span></div>
        <div><small>需处理</small><strong>{attention}</strong><span>需要人工检查</span></div>
      </section>
      <section className="panel table-panel">
        <div className="panel-heading table-heading"><div><span>发布日历</span><h3>即将发布</h3></div><div className="filter-pills"><button className="active" type="button">队列</button><button type="button">日历</button><button type="button">已发布</button></div></div>
        <div className="publish-list">
          {tasks.map((task) => {
            const schedule = formatSchedule(task.scheduledAt);
            return <div key={task.id}>
              <span className="date-block"><strong>{schedule.date}</strong><small>{schedule.time}</small></span>
              <div><strong>{task.title}</strong><span>{task.targets.map((target) => <PlatformMark key={target} name={platformLabel(target)} />)}</span></div>
              <StatusPill status={task.status} />
              <button type="button">{task.mode === "publish" ? "直接发布" : "平台草稿"}</button>
              <button type="button" aria-label={`更多 ${task.title}`}>•••</button>
            </div>
          })}
          {!tasks.length && <div className="empty-state"><span>↗</span><strong>还没有发布任务</strong><p>从本地内容包创建第一条平台草稿。</p></div>}
        </div>
      </section>
    </>
  );
}

function XianyuCenter({
  agentState,
  services,
  events,
  pendingServices,
  toggleService,
  openService,
}: {
  agentState: AgentState;
  services: LocalService[];
  events: LocalEvent[];
  pendingServices: string[];
  toggleService: (key: ServiceKey) => void;
  openService: (serviceId: string) => void;
}) {
  const cards = [
    { key: "monitor" as const, index: "01", name: "商品监控", project: "ai-goofish-monitor", description: "按关键词、价格区间和卖家条件持续发现新商品。", accent: "lime", panelUrl: "http://127.0.0.1:8000", serviceId: "ai_goofish_monitor" },
    { key: "support" as const, index: "02", name: "智能客服", project: "XianyuAutoAgent", description: "本版仅备选、不启动：与多账号回复同账号互斥。", accent: "violet", panelUrl: null, serviceId: "xianyu_auto_agent", standby: true },
    { key: "accounts" as const, index: "03", name: "多账号管理", project: "xianyu-auto-reply-fix", description: "自动回复/发货/多账号值守，本机端口 18090（上游 .env 配置）。", accent: "coral", panelUrl: "http://127.0.0.1:18090", serviceId: "xianyu_auto_reply_fix" },
  ];
  const xianyuServices = cards.map((card) => ({ ...card, service: serviceFor(services, card.key) }));
  const running = xianyuServices.filter((card) => card.service?.running).length;
  const xianyuEvents = events.filter((event) => `${event.source} ${event.message}`.toLowerCase().includes("xianyu") || event.message.includes("闲鱼"));
  return (
    <>
      <section className="xianyu-overview">
        <div><span className="eyebrow-pill"><i /> 本机自动化</span><h2>监控 8000 · 多账号 18090，<br />各管各的原生 Web UI。</h2><p>织台只做状态汇总与「打开原工具」；不复制上游界面。XianyuAutoAgent 与多账号同账号互斥，本版仅备选。</p></div>
        <div className="xianyu-score"><EmptyRing value={`${running}/2`} label="运行中" /><p><strong>{running ? "状态来自本地进程检测" : "闲鱼工具均未启动"}</strong><span>备用 XianyuAutoAgent 不参与运行计数</span></p></div>
      </section>
      <section className="xianyu-tool-grid">
        {xianyuServices.map((card) => (
          <article key={card.key} className={`xianyu-tool ${card.accent}`}>
            <div><span>{card.index}</span>{card.standby ? <em className="xianyu-standby">备选 · 未启动</em> : <Toggle checked={Boolean(card.service?.running)} onChange={() => toggleService(card.key)} disabled={agentState !== "online" || !card.service?.configured || pendingServices.includes(card.service?.id ?? defaultServiceIds[card.key])} label={`切换${card.name}`} />}</div>
            <small>{card.project}</small><h3>{card.name}</h3><p>{card.description}</p>
            <footer><strong>{card.service ? displayStatus(card.service.status) : "未接入"}</strong><span>{card.service?.detail ?? "先完成本地安装与安全配置"}</span>{card.panelUrl ? <a href={card.panelUrl} target="_blank" rel="noreferrer" onClick={() => openService(card.serviceId)}>打开 Web UI ›</a> : <span className="listener-managed-label">仅备选</span>}</footer>
          </article>
        ))}
      </section>
      <section className="panel monitor-panel">
        <div className="panel-heading"><div><span>服务事件</span><h3>闲鱼运行记录</h3></div><span>{xianyuEvents.length} 条</span></div>
        {xianyuEvents.slice(0, 6).map((event) => <div className="monitor-row" key={event.id}><span className="product-thumb">闲</span><div><strong>{event.type}</strong><small>{event.message}</small></div><strong>{event.severity}</strong><span>{event.source}</span><small>{event.time}</small></div>)}
        {!xianyuEvents.length && <div className="empty-state"><span>◇</span><strong>暂无真实闲鱼事件</strong><p>启动经加固的工具后，服务事件会显示在这里。</p></div>}
      </section>
    </>
  );
}

const ANALYSIS_SERVER = "http://127.0.0.1:17900";

type RemoteControlState = {
  enabled: boolean;
  paired: boolean;
  pairedCount: number;
  lastCommandAt: string | null;
  mode: string;
  ingestDisabled: boolean;
  modelDispatch: boolean;
};

type RemoteAuditItem = {
  id: string;
  command: string;
  status: string;
  detail: string;
  createdAt: string;
};

type NotificationSettingsState = {
  ntfy: { enabled: boolean; server: string; topic: string; hasAccessToken: boolean; subscriptionUrl: string | null; operational?: boolean; deliveryState?: string; lastSuccessAt?: string | null };
  schedules: {
    learning: { enabled: boolean; time: string; lastRunDate: string | null };
    ingest: { enabled: boolean; time: string; lastRunDate: string | null };
  };
  events: { creative: boolean; publishFailure: boolean; downloadFailure: boolean; filehelperOffline: boolean };
};

type ClawBotNotificationState = {
  ready: boolean;
  operational?: boolean;
  transportReady?: boolean;
  pairedCount: number;
  deliveryState?: string;
  cooldownUntil?: string | null;
  reason: string | null;
};

type NotificationDelivery = {
  id: string;
  kind: string;
  title: string;
  channel?: string;
  status: string;
  createdAt: string;
  error: string | null;
};

function MessageCenter({
  agentState,
  services,
  notify,
  onSetupClawBot,
}: {
  agentState: AgentState;
  services: LocalService[];
  notify: (message: string) => void;
  onSetupClawBot: () => void;
}) {
  const [remote, setRemote] = useState<RemoteControlState | null>(null);
  const [audit, setAudit] = useState<RemoteAuditItem[]>([]);
  const [notificationSettings, setNotificationSettings] = useState<NotificationSettingsState | null>(null);
  const [clawBotNotifications, setClawBotNotifications] = useState<ClawBotNotificationState | null>(null);
  const [deliveries, setDeliveries] = useState<NotificationDelivery[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [accessToken, setAccessToken] = useState("");
  const clawBot = services.find((service) => service.id === "openclaw_weixin") ?? null;

  const load = useCallback(async () => {
    try {
      const [remoteResponse, auditResponse, notificationResponse] = await Promise.all([
        fetch(`${LOCAL_AGENT_URL}/api/v1/remote/status`, { signal: AbortSignal.timeout(5000) }),
        fetch(`${LOCAL_AGENT_URL}/api/v1/remote/audit?limit=30`, { signal: AbortSignal.timeout(5000) }),
        fetch(`${LOCAL_AGENT_URL}/api/v1/notifications`, { signal: AbortSignal.timeout(5000) }),
      ]);
      if (!remoteResponse.ok || !auditResponse.ok || !notificationResponse.ok) throw new Error("message_center_unavailable");
      const remotePayload = await remoteResponse.json() as RemoteControlState;
      const auditPayload = await auditResponse.json() as { items?: RemoteAuditItem[] };
      const notificationPayload = await notificationResponse.json() as { settings?: NotificationSettingsState; clawbot?: ClawBotNotificationState; deliveries?: NotificationDelivery[] };
      setRemote(remotePayload);
      setAudit(Array.isArray(auditPayload.items) ? auditPayload.items : []);
      setNotificationSettings(notificationPayload.settings ?? null);
      setClawBotNotifications(notificationPayload.clawbot ?? null);
      setDeliveries(Array.isArray(notificationPayload.deliveries) ? notificationPayload.deliveries : []);
    } catch {
      if (agentState === "online") notify("消息中心暂时无法读取，请稍后重试");
    }
  }, [agentState, notify]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 10_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const updateSettings = async () => {
    if (!notificationSettings) return;
    setBusy("save");
    try {
      const response = await fetch(`${LOCAL_AGENT_URL}/api/v1/notifications/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ntfy: {
            enabled: notificationSettings.ntfy.enabled,
            server: notificationSettings.ntfy.server,
            topic: notificationSettings.ntfy.topic,
            ...(accessToken.trim() ? { accessToken: accessToken.trim() } : {}),
          },
          schedules: notificationSettings.schedules,
          events: notificationSettings.events,
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setAccessToken("");
      notify("手机通知设置已保存");
      await load();
    } catch (error) {
      notify(`保存失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setBusy(null);
    }
  };

  const createSubscription = async () => {
    setBusy("subscription");
    try {
      const response = await fetch(`${LOCAL_AGENT_URL}/api/v1/notifications/subscription`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      notify("已生成专属订阅地址；在手机 ntfy 中订阅它即可");
      await load();
    } catch (error) {
      notify(`生成订阅失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setBusy(null);
    }
  };

  const sendTest = async () => {
    setBusy("test");
    try {
      const response = await fetch(`${LOCAL_AGENT_URL}/api/v1/notifications/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Zhitai-Action": "confirm" },
        body: "{}",
      });
      const payload = await response.json().catch(() => ({})) as { error?: string; channel?: string };
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      notify(payload.channel === "clawbot" ? "测试消息已发送到 ClawBot" : "测试通知已被 ntfy 接受，请检查手机");
      await load();
    } catch (error) {
      notify(`测试失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setBusy(null);
    }
  };

  const unpair = async () => {
    setBusy("unpair");
    try {
      const response = await fetch(`${LOCAL_AGENT_URL}/api/v1/remote/unpair`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Zhitai-Action": "confirm" },
        body: "{}",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      notify("已解除绑定；下一位私聊 ClawBot 的发送者会成为新控制账号");
      await load();
    } catch (error) {
      notify(`解除绑定失败：${error instanceof Error ? error.message : "未知错误"}`);
    } finally {
      setBusy(null);
    }
  };

  const setSchedule = (kind: "learning" | "ingest", patch: Partial<NotificationSettingsState["schedules"]["learning"]>) => {
    setNotificationSettings((current) => current ? {
      ...current,
      schedules: { ...current.schedules, [kind]: { ...current.schedules[kind], ...patch } },
    } : current);
  };

  return <>
    <section className="message-hero">
      <div>
        <span className="eyebrow-pill light"><i /> 固定命令 · 不调用 AI</span>
        <h2>手机遥控织台，<br />摘要自动送达。</h2>
        <p>微信文件传输助手是内容采集主入口。ClawBot 负责“状态、学习、入库、素材、队列、生成控制”等固定命令，并保留直发分享链接的备用入库通道。</p>
      </div>
      <div className="message-status-stack">
        <div><span className={`node-signal ${agentState}`} /><p><strong>织台控制节点</strong><small>{agentState === "online" ? "全天候运行" : "正在恢复"}</small></p></div>
        <div><span className={`node-signal ${clawBot?.businessReady ? "online" : clawBot?.running ? "checking" : "offline"}`} /><p><strong>ClawBot 微信通道</strong><small>{clawBot?.businessReady ? "已登录，可接收命令与链接" : clawBot?.running ? "进程在线，等待重新扫码" : "未启动"}</small></p></div>
        <div><span className={`node-signal ${remote?.paired ? "online" : "checking"}`} /><p><strong>控制账号</strong><small>{remote?.paired ? `已绑定 ${remote.pairedCount} 个微信账号` : "首次私聊后自动绑定"}</small></p></div>
      </div>
    </section>

    <section className="message-grid">
      <article className="panel remote-command-panel">
        <div className="panel-heading"><div><span>CLAWBOT</span><h3>手机遥控器</h3></div><strong>{remote?.modelDispatch === false ? "0 次 AI 调用" : "读取中"}</strong></div>
        <div className="command-chip-grid">{["今日", "入库", "素材", "队列", "失败", "状态", "生成 1", "暂停生成", "继续生成", "帮助"].map((command) => <span key={command}>{command}</span>)}</div>
        <p className="message-explain">生成命令会返回四位确认码；未知命令只显示帮助，不会转交 GPT 或 Codex。文件传输助手是主入口；ClawBot 收到分享链接时仍会作为备用通道创建入库任务。</p>
        <div className="message-actions">
          <button className="primary-button" type="button" onClick={onSetupClawBot} disabled={busy !== null || agentState !== "online"}>{clawBot?.businessReady ? "重新绑定 ClawBot" : "扫码绑定 ClawBot"}</button>
          <button className="secondary-button" type="button" onClick={() => void unpair()} disabled={!remote?.paired || busy !== null}>{busy === "unpair" ? "处理中…" : "解除控制账号"}</button>
        </div>
      </article>

      <article className="panel phone-push-panel">
        <div className="panel-heading"><div><span>CLAWBOT 入站 · NTFY 可靠出站</span><h3>可靠手机通知</h3></div><strong>{clawBotNotifications?.ready ? "ClawBot 已验证" : notificationSettings?.ntfy.operational ? "ntfy 已接管" : notificationSettings?.ntfy.enabled && notificationSettings.ntfy.topic ? "ntfy 已配置" : "待绑定"}</strong></div>
        {notificationSettings ? <>
          <p className="message-explain">{clawBotNotifications?.ready ? `ClawBot 主动提醒已通过真实投递验证，可发给已绑定的 ${clawBotNotifications.pairedCount} 个控制账号；失败时自动改走 ntfy。` : `ClawBot 入站遥控与主动出站分开判断：${clawBotNotifications?.reason || "等待绑定"}。${notificationSettings.ntfy.operational ? "当前通知已由 ntfy 可靠承接。" : "请先确认 ntfy 已订阅并通过测试。"}`}</p>
          <label><span>推送服务器</span><input value={notificationSettings.ntfy.server} onChange={(event) => setNotificationSettings({ ...notificationSettings, ntfy: { ...notificationSettings.ntfy, server: event.target.value } })} /></label>
          <label><span>专属主题</span><input value={notificationSettings.ntfy.topic} onChange={(event) => setNotificationSettings({ ...notificationSettings, ntfy: { ...notificationSettings.ntfy, topic: event.target.value } })} placeholder="点击下方自动生成" /></label>
          <label><span>访问令牌（可选）</span><input type="password" value={accessToken} onChange={(event) => setAccessToken(event.target.value)} placeholder={notificationSettings.ntfy.hasAccessToken ? "已保存；留空保持不变" : "自建/账号主题需要时填写"} /></label>
          {notificationSettings.ntfy.subscriptionUrl && <a className="message-subscription" href={notificationSettings.ntfy.subscriptionUrl} target="_blank" rel="noreferrer">打开手机订阅地址 ↗</a>}
          <p className="message-explain">手机安装 ntfy 后订阅上面的完整地址；Mac 与 iPhone 开启通用剪贴板时可直接复制过去。没有完成手机订阅前，织台不会把“服务已接受”误写成“手机已收到”。</p>
          <div className="message-actions">
            <button className="secondary-button" type="button" onClick={() => void createSubscription()} disabled={busy !== null}>{busy === "subscription" ? "生成中…" : "生成专属订阅地址"}</button>
            <button className="secondary-button" type="button" onClick={() => { if (notificationSettings.ntfy.subscriptionUrl) void navigator.clipboard.writeText(notificationSettings.ntfy.subscriptionUrl).then(() => notify("订阅地址已复制")); }} disabled={!notificationSettings.ntfy.subscriptionUrl}>复制订阅地址</button>
            <button className="secondary-button" type="button" onClick={() => void updateSettings()} disabled={busy !== null}>{busy === "save" ? "保存中…" : "保存设置"}</button>
            <button className="primary-button" type="button" onClick={() => void sendTest()} disabled={busy !== null || !notificationSettings.ntfy.topic}>{busy === "test" ? "发送中…" : "发送测试通知"}</button>
          </div>
        </> : <div className="creative-queue-empty"><strong>正在读取通知设置</strong></div>}
      </article>
    </section>

    {notificationSettings && <section className="panel schedule-panel">
      <div className="panel-heading"><div><span>每日自动发送</span><h3>摘要与异常提醒</h3></div><span>调度由织台本地节点执行，不调用模型</span></div>
      <div className="schedule-setting-grid">
        <div><Toggle checked={notificationSettings.schedules.learning.enabled} onChange={() => setSchedule("learning", { enabled: !notificationSettings.schedules.learning.enabled })} label="每日学习通知" /><p><strong>每日学习</strong><small>技能与其他分类的 6 条学习清单</small></p><input type="time" value={notificationSettings.schedules.learning.time} onChange={(event) => setSchedule("learning", { time: event.target.value })} /></div>
        <div><Toggle checked={notificationSettings.schedules.ingest.enabled} onChange={() => setSchedule("ingest", { enabled: !notificationSettings.schedules.ingest.enabled })} label="入库摘要通知" /><p><strong>入库摘要</strong><small>今日视频、X 收藏、分类与重点标题</small></p><input type="time" value={notificationSettings.schedules.ingest.time} onChange={(event) => setSchedule("ingest", { time: event.target.value })} /></div>
        <div><Toggle checked={notificationSettings.events.creative} onChange={() => setNotificationSettings({ ...notificationSettings, events: { ...notificationSettings.events, creative: !notificationSettings.events.creative } })} label="生成结果通知" /><p><strong>生成结果</strong><small>准备完成或失败时立即提醒</small></p></div>
        <div><Toggle checked={notificationSettings.events.publishFailure} onChange={() => setNotificationSettings({ ...notificationSettings, events: { ...notificationSettings.events, publishFailure: !notificationSettings.events.publishFailure } })} label="发布失败通知" /><p><strong>发布失败</strong><small>只提醒异常，不为成功刷屏</small></p></div>
        <div><Toggle checked={notificationSettings.events.filehelperOffline} onChange={() => setNotificationSettings({ ...notificationSettings, events: { ...notificationSettings.events, filehelperOffline: !notificationSettings.events.filehelperOffline } })} label="主收件入口离线提醒" /><p><strong>文件传输助手主入口掉线</strong><small>会阻断主采集通路；恢复后再通知一次。ClawBot 备用直链与手机控制不改变这项判定</small></p></div>
        <div><Toggle checked={notificationSettings.events.downloadFailure} onChange={() => setNotificationSettings({ ...notificationSettings, events: { ...notificationSettings.events, downloadFailure: !notificationSettings.events.downloadFailure } })} label="下载异常提醒" /><p><strong>视频下载异常</strong><small>已接收任务失败、未入库或超过 3 分钟时提醒</small></p></div>
      </div>
      <button className="primary-button" type="button" onClick={() => void updateSettings()} disabled={busy !== null}>保存全部提醒</button>
    </section>}

    <section className="message-grid logs">
      <article className="panel message-log-panel">
        <div className="panel-heading"><div><span>控制审计</span><h3>最近手机命令</h3></div><span>{audit.length} 条</span></div>
        {audit.slice(0, 8).map((item) => <div className="message-log-row" key={item.id}><time>{formatClock(item.createdAt)}</time><strong>{item.command}</strong><span className={`delivery-${item.status}`}>{item.status === "success" ? "已执行" : item.status === "rejected" ? "已拒绝" : "失败"}</span><small>{item.detail}</small></div>)}
        {!audit.length && <div className="creative-queue-empty"><strong>还没有手机命令</strong><span>绑定后在微信私聊 ClawBot 回复“状态”即可验证。</span></div>}
      </article>
      <article className="panel message-log-panel">
        <div className="panel-heading"><div><span>送达记录</span><h3>最近手机通知</h3></div><span>{deliveries.length} 条</span></div>
        {deliveries.slice(0, 8).map((item) => <div className="message-log-row" key={item.id}><time>{formatClock(item.createdAt)}</time><strong>{item.title}</strong><span className={`delivery-${item.status}`}>{item.status === "accepted" ? "服务已接受" : item.status === "failed" ? "失败" : "未配置"}</span><small>{item.error || `${item.channel || "通知"} · ${item.kind}`}</small></div>)}
        {!deliveries.length && <div className="creative-queue-empty"><strong>还没有通知记录</strong><span>生成订阅地址并发送测试通知。</span></div>}
      </article>
    </section>
  </>;
}

function DailyLearning({ items }: { items: LibraryItem[] }) {
  const today = new Date().toLocaleDateString("sv-SE");
  const storageKey = `zhitai-learning-done:${today}`;
  const [doneIds, setDoneIds] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem(storageKey) || "[]");
      if (Array.isArray(saved)) setDoneIds(new Set(saved.map(String)));
    } catch { /* 首次使用 */ }
  }, [storageKey]);
  const dailyItems = useMemo(() => {
    const hash = (value: string) => [...value].reduce((sum, char) => ((sum * 31) + char.charCodeAt(0)) >>> 0, 7);
    return items
      .filter((item) => item.category !== "素材" && Boolean(item.sourceUrl || item.author || item.platform !== "未知来源"))
      .sort((a, b) => hash(`${today}:${a.id}`) - hash(`${today}:${b.id}`))
      .slice(0, 6);
  }, [items, today]);
  const toggleDone = (id: string) => {
    setDoneIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      window.localStorage.setItem(storageKey, JSON.stringify([...next]));
      return next;
    });
  };
  return <>
    <section className="learning-hero">
      <div><span className="eyebrow-pill"><i /> {today}</span><h2>今天学这几条，<br />素材不在这里。</h2><p>技能与其他分类会整理成每日清单；“素材”只进入复刻工作流。清单按日期稳定轮换，勾选进度保存在本机。</p></div>
      <div className="learning-score"><strong>{doneIds.size}</strong><span>/ {dailyItems.length} 已完成</span></div>
    </section>
    <section className="learning-list">
      {dailyItems.map((item, index) => {
        const summary = (item.overview || item.analysisText || item.transcriptText || item.copywriting || "这条内容尚未完成深度分析，可先打开详情查看原始信息。").replace(/\s+/g, " ").trim();
        const points = item.propagationFactors.slice(0, 3).map((factor) => factor.title);
        return <article className={doneIds.has(item.id) ? "done" : ""} key={item.id}>
          <button type="button" onClick={() => toggleDone(item.id)} aria-label={doneIds.has(item.id) ? `取消完成 ${item.title}` : `完成学习 ${item.title}`}>{doneIds.has(item.id) ? "✓" : index + 1}</button>
          <div><header><span>{item.category} · {item.platform}</span><h3>{item.title}</h3></header><p>{summary.slice(0, 360)}</p>{points.length > 0 && <ul>{points.map((point) => <li key={point}>{point}</li>)}</ul>}<small>{item.tags.slice(0, 5).map((tag) => `#${tag}`).join("  ") || "等待补充标签"}</small></div>
        </article>;
      })}
      {!dailyItems.length && <div className="creative-queue-empty"><strong>今天还没有学习内容</strong><span>把技能或其他分类的视频下载入库后会自动出现在这里。</span></div>}
    </section>
  </>;
}

function CreativeStudio({
  libraryItems,
  agentState,
  initialVideoId,
  onPublish,
}: {
  libraryItems: LibraryItem[];
  agentState: AgentState;
  initialVideoId?: string;
  onPublish: (videoId: string) => void;
}) {
  const [message, setMessage] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const [doubaoAccounts, setDoubaoAccounts] = useState<Array<{ id: string; label: string }>>([{ id: "account-1", label: "豆包账号 1" }]);
  const [selectedId, setSelectedId] = useState(initialVideoId ?? "");
  const [preparing, setPreparing] = useState(false);
  const [jobs, setJobs] = useState<CreativeJob[]>([]);
  const [queueLoading, setQueueLoading] = useState(true);
  const [autoRunningId, setAutoRunningId] = useState<string | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [updatingJobId, setUpdatingJobId] = useState<string | null>(null);
  const materialItems = useMemo(() => libraryItems.filter((item) => item.category === "素材"), [libraryItems]);
  const materialIds = useMemo(() => new Set(materialItems.map((item) => item.id)), [materialItems]);
  const visibleJobs = useMemo(() => jobs.filter((job) => materialIds.has(job.assetId) && job.status !== "cancelled"), [jobs, materialIds]);
  const selectedJob = useMemo(() => visibleJobs.find((job) => job.assetId === selectedId) || null, [selectedId, visibleJobs]);

  useEffect(() => {
    try {
      const saved = JSON.parse(window.localStorage.getItem("zhitai-doubao-accounts-v1") || "[]");
      if (Array.isArray(saved) && saved.length) {
        const clean = saved.filter((item) => item && typeof item.id === "string" && typeof item.label === "string").slice(0, 8);
        if (clean.length) setDoubaoAccounts(clean);
      }
    } catch { /* 首次使用账号池 */ }
  }, []);

  function saveDoubaoAccounts(next: Array<{ id: string; label: string }>) {
    setDoubaoAccounts(next);
    window.localStorage.setItem("zhitai-doubao-accounts-v1", JSON.stringify(next));
  }

  function addDoubaoAccount() {
    if (doubaoAccounts.length >= 8) { setMessage("第一版最多管理 8 个豆包账号。"); return; }
    const next = [...doubaoAccounts, { id: `account-${Date.now().toString(36)}`, label: `豆包账号 ${doubaoAccounts.length + 1}` }];
    saveDoubaoAccounts(next);
    setMessage("已新增独立豆包账号窗口；点击它完成一次登录，之后会自动参与额度轮换。");
  }

  const loadJobs = useCallback(async (): Promise<CreativeJob[]> => {
    if (agentState !== "online") {
      setQueueLoading(false);
      return [];
    }
    try {
      const response = await fetch(`${LOCAL_AGENT_URL}/api/v1/creative/jobs`);
      const payload = await response.json().catch(() => null);
      if (response.ok && Array.isArray(payload?.jobs)) {
        const next = payload.jobs as CreativeJob[];
        setJobs(next);
        return next;
      }
      return [];
    } catch {
      return [];
    } finally {
      setQueueLoading(false);
    }
  }, [agentState]);

  useEffect(() => {
    void loadJobs();
    const timer = window.setInterval(() => void loadJobs(), 3000);
    return () => window.clearInterval(timer);
  }, [loadJobs]);

  useEffect(() => {
    if ((!selectedId || !materialItems.some((item) => item.id === selectedId)) && materialItems[0]?.id) setSelectedId(materialItems[0].id);
  }, [materialItems, selectedId]);

  async function openStudio(provider: "gpt" | "seedance", accountId = "account-1") {
    const openingKey = `${provider}:${accountId}`;
    setOpening(openingKey);
    setMessage(null);
    try {
      const opened = await openCreativeStudio(provider, provider === "seedance" ? accountId : undefined);
      if (!opened.ok) setMessage(opened.error || "创作窗口未能打开");
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "创作窗口未能打开");
    } finally {
      setOpening(null);
    }
  }

  async function addToCreativeQueue() {
    if (!selectedId) return;
    if (selectedJob?.status === "transient_wait") {
      setMessage(`${creativeJobStatusText(selectedJob)}。${creativeJobRetryText(selectedJob) || "系统会从原断点继续"}；无需重复加入队列。`);
      return;
    }
    if (selectedJob?.status === "needs_attention") {
      setMessage("这条原任务需要处理；请在任务卡点击“重试原断点”，无需重新加入队列。");
      return;
    }
    if (selectedJob?.status === "failed") {
      setMessage("这条原任务执行失败；请在任务卡点击“重试原任务”，无需创建替代任务。");
      return;
    }
    setPreparing(true);
    setMessage(null);
    try {
      const response = await fetch(`${LOCAL_AGENT_URL}/api/v1/creative/jobs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ assetId: selectedId }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || payload?.message || `HTTP ${response.status}`);
      setMessage(payload.deduplicated ? "这条视频已经在生成队列中。" : "已加入生成队列；织台会在本机自动准备分镜和提示词。");
      await loadJobs();
    } catch (cause) {
      setMessage(`准备失败：${cause instanceof Error ? cause.message : "分析服务无响应"}`);
    } finally {
      setPreparing(false);
    }
  }

  async function runUnattended(job: CreativeJob, openPublishAfter = false): Promise<boolean> {
    setAutoRunningId(job.id);
    setMessage("织台正在依次执行 GPT 生图、豆包视频和本机拼接；窗口可放到后台，但不要退出织台。");
    try {
      const result = await runCreativeJob(job.id, job.assetId, doubaoAccounts.map((account) => account.id));
      const latestJobs = await loadJobs();
      const latestJob = latestJobs.find((item) => item.id === job.id) || job;
      if (!result.ok) {
        if (latestJob.status === "transient_wait" || result.status === "transient_ui_busy") {
          setMessage(`${creativeJobStatusText({ status: "transient_wait" })}。${creativeJobRetryText(latestJob) || "系统会从原断点继续"}；本次不会重复启动任务。`);
          return false;
        }
        if (latestJob.status === "needs_attention" || result.status === "needs_attention") {
          setMessage(`需处理：${latestJob.error || result.error || "网页生成无法继续"}。可在任务卡点击“重试原断点”，不会新建任务。`);
          return false;
        }
        throw new Error(result.error || result.status || "一键生成中断");
      }
      setMessage("一键生成完成：GPT 分镜图、豆包片段和最终成片已登记回该素材内容包。");
      if (openPublishAfter) onPublish(job.assetId);
      return true;
    } catch (cause) {
      setMessage(`一键生成暂停：${cause instanceof Error ? cause.message : "需要检查 GPT/豆包窗口"}`);
      return false;
    } finally {
      setAutoRunningId(null);
    }
  }

  async function runReadyQueue() {
    if (batchRunning || autoRunningId) return;
    setBatchRunning(true);
    setMessage("正在执行素材生成队列：织台会等待本机分析，再串行使用 GPT 和豆包账号池。");
    let completed = 0;
    const deferredJobIds = new Set(visibleJobs.filter((job) => job.status === "transient_wait").map((job) => job.id));
    const waitDeadline = Date.now() + 15 * 60_000;
    try {
      while (true) {
        const latest = (await loadJobs()).filter((job) => materialIds.has(job.assetId) && job.status !== "cancelled");
        latest.filter((job) => job.status === "transient_wait").forEach((job) => deferredJobIds.add(job.id));
        const ready = latest.find((job) => isCreativeRunnableStatus(job.status) && !deferredJobIds.has(job.id));
        if (ready) {
          setAutoRunningId(ready.id);
          const result = await runCreativeJob(ready.id, ready.assetId, doubaoAccounts.map((account) => account.id));
          setAutoRunningId(null);
          if (!result.ok) {
            const refreshed = await loadJobs();
            const interrupted = refreshed.find((job) => job.id === ready.id);
            if (interrupted?.status === "transient_wait" || result.status === "transient_ui_busy") {
              deferredJobIds.add(ready.id);
              continue;
            }
            if (interrupted?.status === "needs_attention" || result.status === "needs_attention") {
              deferredJobIds.add(ready.id);
              continue;
            }
            throw new Error(`${ready.title}：${result.error || result.status || "生成中断"}`);
          }
          completed += 1;
          continue;
        }
        const stillPreparing = latest.some((job) => isCreativePreparingStatus(job.status));
        if (stillPreparing && Date.now() < waitDeadline) {
          await new Promise((resolve) => window.setTimeout(resolve, 2000));
          continue;
        }
        const autoWaiting = latest.filter((job) => job.status === "transient_wait").length;
        const needsManual = latest.filter((job) => isCreativeManualAttentionStatus(job.status)).length;
        setMessage(`队列本轮执行完成：新生成 ${completed} 条${autoWaiting ? `，${autoWaiting} 条短暂等待并将自动从原断点重试` : ""}${needsManual ? `，${needsManual} 条需处理` : ""}。`);
        break;
      }
    } catch (cause) {
      setMessage(`队列已暂停：${cause instanceof Error ? cause.message : "请检查 GPT/豆包登录或免费额度"}`);
    } finally {
      setAutoRunningId(null);
      setBatchRunning(false);
      await loadJobs();
    }
  }

  async function startSelectedUnattended() {
    if (!selectedId) return;
    if (selectedJob?.status === "transient_wait") {
      setMessage(`${creativeJobStatusText(selectedJob)}。${creativeJobRetryText(selectedJob) || "系统会从原断点继续"}；无需再次点击生成。`);
      return;
    }
    if (selectedJob?.status === "needs_attention") {
      setMessage("这条原任务需要处理；请在任务卡点击“重试原断点”，不会新建任务。");
      return;
    }
    if (selectedJob?.status === "failed") {
      setMessage("这条原任务执行失败；请在任务卡点击“重试原任务”，不会新建任务。");
      return;
    }
    setPreparing(true);
    setMessage(null);
    try {
      const response = await fetch(`${LOCAL_AGENT_URL}/api/v1/creative/jobs`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ assetId: selectedId }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok || !payload?.job) throw new Error(payload?.error || payload?.message || `HTTP ${response.status}`);
      let job = payload.job as CreativeJob;
      const started = Date.now();
      while (!isCreativePollStopStatus(job.status) && Date.now() - started < 15 * 60_000) {
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
        const listResponse = await fetch(`${LOCAL_AGENT_URL}/api/v1/creative/jobs`);
        const listPayload = await listResponse.json().catch(() => null);
        job = (Array.isArray(listPayload?.jobs) ? listPayload.jobs.find((item: CreativeJob) => item.id === job.id) : null) || job;
      }
      await loadJobs();
      if (job.status === "transient_wait") {
        setMessage(`${creativeJobStatusText(job)}。${creativeJobRetryText(job) || "系统会从原断点继续"}；无需再次点击生成。`);
        return;
      }
      if (job.status === "needs_attention") {
        setMessage(`需处理：${job.error || "网页生成无法继续"}。可在任务卡点击“重试原断点”，不会新建任务。`);
        return;
      }
      if (!["ready_for_images", "ready_for_seedance", "ready_for_assembly"].includes(job.status)) throw new Error(job.error || "本机复刻包尚未准备完成");
      await runUnattended(job, false);
    } catch (cause) {
      setMessage(`一键生成暂停：${cause instanceof Error ? cause.message : "本地节点无响应"}`);
    } finally {
      setPreparing(false);
    }
  }

  async function updateJob(job: CreativeJob, action: "pause" | "resume" | "retry" | "cancel" | "advance", step?: string) {
    if (updatingJobId !== null) return;
    setUpdatingJobId(job.id);
    setMessage(null);
    try {
      const response = await fetch(`${LOCAL_AGENT_URL}/api/v1/creative/jobs/${encodeURIComponent(job.id)}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(step ? { step } : {}),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || payload?.message || `HTTP ${response.status}`);
      await loadJobs();
    } catch (cause) {
      setMessage(`队列操作失败：${cause instanceof Error ? cause.message : "本地节点无响应"}`);
    } finally {
      setUpdatingJobId(null);
    }
  }

  async function retryOriginalJob(job: CreativeJob) {
    if (updatingJobId !== null || autoRunningId !== null || batchRunning) return;
    setUpdatingJobId(job.id);
    setMessage(null);
    try {
      const action = job.status === "failed" ? "retry" : "resume";
      const response = await fetch(`${LOCAL_AGENT_URL}/api/v1/creative/jobs/${encodeURIComponent(job.id)}/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok || !payload?.job) throw new Error(payload?.error || payload?.message || `HTTP ${response.status}`);
      const resumed = payload.job as CreativeJob;
      await loadJobs();
      const executable = ["ready_for_images", "ready_for_seedance", "ready_for_assembly"].includes(resumed.status);
      if (!executable) {
        setMessage("已恢复原任务，正在重新准备分析；准备完成后织台会继续同一任务，不会新建任务。");
        return;
      }
      if (resumed.status !== "ready_for_assembly" && !isCreativeOperationWindowOpen()) {
        setMessage(`${creativeJobResumeText(job) || "已恢复原断点"}；当前不在 08:00–19:00 创作窗口，次日白天自动续跑，不会深夜打开 GPT 或豆包。`);
        return;
      }
      setUpdatingJobId(null);
      await runUnattended(resumed, false);
    } catch (cause) {
      setMessage(`原任务重试失败：${cause instanceof Error ? cause.message : "本地节点无响应"}`);
    } finally {
      setUpdatingJobId(null);
    }
  }

  async function advanceAndOpen(job: CreativeJob, step: "images_ready" | "seedance_ready", provider?: "gpt" | "seedance") {
    await updateJob(job, "advance", step);
    if (provider) await openStudio(provider);
  }

  return (
    <>
      <section className="creative-home-hero">
        <div>
          <span className="eyebrow-pill"><i /> 织台内创作窗口</span>
          <h2>豆包 Seedance，<br />现在就在左侧一级菜单。</h2>
          <p>这里只显示“素材”分类。织台会按每条视频自己的主题和镜头反推，不再套装修模板；随后自动驱动已登录的 GPT 与豆包，保存成片并带入发布中心。</p>
          <div className="creative-prepare-row">
            <select value={selectedId} onChange={(event) => setSelectedId(event.target.value)} aria-label="选择要复刻的视频">
              {!materialItems.length && <option value="">素材分类暂无视频</option>}
              {materialItems.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
            </select>
            <div className="creative-start-buttons"><button className="primary-button" type="button" onClick={() => void startSelectedUnattended()} disabled={preparing || !selectedId || agentState !== "online" || isCreativeNoDuplicateStartStatus(selectedJob?.status || "queued")}>{preparing ? "正在执行…" : selectedJob?.status === "transient_wait" ? "等待自动重试" : selectedJob?.status === "needs_attention" ? "请从原断点重试" : selectedJob?.status === "failed" ? "请重试原任务" : "一键生成备用成片"}</button><button className="secondary-button" type="button" onClick={() => void addToCreativeQueue()} disabled={preparing || !selectedId || agentState !== "online" || isCreativeNoDuplicateStartStatus(selectedJob?.status || "queued")}>只加入队列</button></div>
          </div>
          <div className="creative-home-actions">
            <button className="primary-button" type="button" onClick={() => void openStudio("seedance", doubaoAccounts[0]?.id)} disabled={opening !== null}>
              {opening === `seedance:${doubaoAccounts[0]?.id}` ? "正在打开豆包…" : "打开主豆包账号"}
            </button>
            <button className="secondary-button" type="button" onClick={() => void openStudio("gpt")} disabled={opening !== null}>
              {opening === "gpt:account-1" ? "正在打开 GPT…" : "打开 GPT 生图"}
            </button>
          </div>
          <div className="doubao-account-pool">
            <header><strong>豆包额度账号池</strong><span>按镜头轮换；只在明确额度耗尽时切换</span></header>
            <div>{doubaoAccounts.map((account) => <button type="button" key={account.id} onClick={() => void openStudio("seedance", account.id)} disabled={opening !== null}>{opening === `seedance:${account.id}` ? "正在打开…" : `${account.label} · 登录/检查`}</button>)}<button type="button" className="add" onClick={addDoubaoAccount}>＋ 添加豆包账号</button></div>
          </div>
          {message && <p className="creative-home-error">{message}</p>}
        </div>
        <ol className="creative-home-flow">
          <li><b>1</b><span><strong>在视频分析选素材</strong><small>分析镜头、配音、字幕和画面结构</small></span></li>
          <li><b>2</b><span><strong>GPT 生成分镜首帧</strong><small>复制织台准备好的逐镜生图提示词</small></span></li>
          <li><b>3</b><span><strong>豆包 Seedance 生成视频</strong><small>上传首帧，逐镜生成并验收后再拼接</small></span></li>
          <li><b>4</b><span><strong>ClawBot 编号终审</strong><small>你回复选择或改进；选择后只创建多平台草稿</small></span></li>
        </ol>
      </section>
      <section className="panel creative-queue-panel">
        <div className="panel-heading"><div><span>每日生成</span><h3>织台生成队列</h3></div><div className="creative-queue-heading-actions"><em>{visibleJobs.filter((job) => isCreativeActiveStatus(job.status)).length} 个正在准备或自动等待 · {visibleJobs.filter((job) => job.status === "completed").length} 个已完成</em><button type="button" onClick={() => void runReadyQueue()} disabled={batchRunning || autoRunningId !== null || !visibleJobs.some((job) => isCreativeBatchStartableStatus(job.status))}>{batchRunning ? "队列执行中…" : "一键执行已就绪队列"}</button></div></div>
        <p className="creative-queue-intro">只有“素材”会自动排队。技能和其他内容进入每日学习，不消耗 GPT/豆包次数。网页自动执行遇到登录、验证码或免费次数耗尽会暂停并提示，不会假报完成。</p>
        <div className="creative-queue-list">
          {visibleJobs.slice(0, 30).map((job) => <article className={`creative-job status-${job.status}${job.status === "needs_attention" ? " status-failed" : ""}`} key={job.id}>
            <div className="creative-job-progress"><i style={{ width: `${Math.max(0, Math.min(100, job.progress || 0))}%` }} /></div>
            <header><div><span>{job.autoCreated ? "下载后自动加入" : "手动加入"}</span><h4>{job.title}</h4></div><strong>{creativeJobStatusText(job)}</strong></header>
            <p>{job.targetDurationSeconds ? `建议成片 ${job.targetDurationSeconds} 秒` : "成片时长由原视频和完播数据决定"}{job.shotCount ? ` · ${job.shotCount} 个镜头` : ""}</p>
            {job.error && <small>{creativeJobErrorLabel(job.status)}：{job.error}</small>}
            {creativeJobRetryText(job) && <small>{creativeJobRetryText(job)}</small>}
            {creativeJobResumeText(job) && <small>{creativeJobResumeText(job)}</small>}
            {!!job.qualityWarnings?.length && <small>生成提示：{job.qualityWarnings.join("；")}</small>}
            <div className="creative-job-actions">
              {["queued", "preparing"].includes(job.status) && <button type="button" onClick={() => void updateJob(job, "pause")}>暂停</button>}
              {job.status === "paused" && <button type="button" onClick={() => void updateJob(job, "resume")}>继续准备</button>}
              {job.status === "failed" && <button type="button" className="primary" disabled={updatingJobId !== null || autoRunningId !== null || batchRunning} onClick={() => void retryOriginalJob(job)}>{updatingJobId === job.id ? "正在恢复…" : "重试原任务"}</button>}
              {job.status === "needs_attention" && <button type="button" className="primary" disabled={updatingJobId !== null || autoRunningId !== null || batchRunning} onClick={() => void retryOriginalJob(job)}>{updatingJobId === job.id ? "正在恢复…" : "重试原断点"}</button>}
              {job.status === "ready_for_images" && <><button type="button" className="primary" onClick={() => void openStudio("gpt")}>打开 GPT 生图</button><button type="button" onClick={() => void advanceAndOpen(job, "images_ready", "seedance")}>图片已做好 → 豆包</button></>}
              {job.status === "ready_for_images" && <button type="button" className="primary unattended" onClick={() => void runUnattended(job)} disabled={autoRunningId !== null || batchRunning}>{autoRunningId === job.id ? "备用成片生成中…" : "一键生成备用成片"}</button>}
              {job.status === "ready_for_seedance" && <><button type="button" className="primary" onClick={() => void openStudio("seedance")}>打开豆包生成</button><button type="button" className="primary unattended" onClick={() => void runUnattended(job)} disabled={autoRunningId !== null || batchRunning}>{autoRunningId === job.id ? "正在继续生成…" : "继续生成备用成片"}</button><button type="button" onClick={() => void advanceAndOpen(job, "seedance_ready")}>片段已下载 → 待拼接</button></>}
              {job.status === "ready_for_assembly" && <button type="button" className="primary" onClick={() => void updateJob(job, "advance", "complete")}>成片已验收</button>}
              {job.status === "completed" && <button type="button" className="primary" onClick={() => onPublish(job.assetId)}>查看草稿 / 排期（需人工确认）</button>}
              {!['completed', 'cancelled'].includes(job.status) && <button type="button" className="quiet" onClick={() => void updateJob(job, "cancel")}>取消</button>}
            </div>
          </article>)}
          {!visibleJobs.length && <div className="creative-queue-empty"><strong>{queueLoading ? "正在读取生成队列…" : "素材生成队列还是空的"}</strong><span>选择上方素材加入；技能和其他内容只进入每日学习。</span></div>}
        </div>
      </section>
      <section className="panel creative-home-note">
        <div className="panel-heading"><div><span>使用说明</span><h3>登录一次，以后直接打开</h3></div></div>
        <p>豆包和 GPT 使用织台专用的持久登录窗口，不会再额外启动独立 App。豆包窗口默认静音且取消媒体自动循环；需要看画面时再手动播放。一键生成会自动识别并清理豆包在左上/右下跳动的角标，识别不可靠就停止，不会假装交付无水印成片；来源视频自带的作者水印不自动涂抹。准备复刻包走本地分析，不消耗 Codex 对话额度。</p>
      </section>
    </>
  );
}

function Analysis({
  libraryItems,
  agentState,
  onCreate,
}: {
  libraryItems: LibraryItem[];
  agentState: AgentState;
  onCreate: (videoId: string) => void;
}) {
  // 列表数据不暴露本地绝对路径：按 id 列出全部真实视频，分析时提交 {videoId}
  const videos = libraryItems.filter((item) => item.contentKind !== "x_bookmark" && Boolean(item.id) && Boolean(item.previewUrl));
  const [selectedId, setSelectedId] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [analyzerState, setAnalyzerState] = useState<"checking" | "ready" | "missing">("checking");
  const [generation, setGeneration] = useState<Record<string, unknown> | null>(null);
  const [copiedPrompt, setCopiedPrompt] = useState("");
  const [externalRunning, setExternalRunning] = useState(false);
  const analysisRequestRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    fetch(`${ANALYSIS_SERVER}/health`)
      .then((response) => response.json().catch(() => null))
      .then((payload) => {
        if (!cancelled) setAnalyzerState(payload?.ok && payload?.analyzerReady ? "ready" : "missing");
      })
      .catch(() => {
        if (!cancelled) setAnalyzerState("missing");
      });
    return () => { cancelled = true; };
  }, []);

  const selected = videos.find((item) => item.id === selectedId) ?? null;

  useEffect(() => {
    setGeneration(null);
    setCopiedPrompt("");
  }, [selectedId]);

  useEffect(() => {
    const requestId = ++analysisRequestRef.current;
    if (!selectedId || agentState !== "online") {
      setResult(null);
      return;
    }
    fetch(`${LOCAL_AGENT_URL}/api/v1/kb/videos/${encodeURIComponent(selectedId)}`)
      .then((response) => response.ok ? response.json() : null)
      .then((detail) => {
        if (analysisRequestRef.current !== requestId || !detail) return;
        const asset = asRecord(detail.asset);
        const transcriptRecord = asRecord(detail.transcript);
        const ocrRecord = asRecord(detail.ocr);
        const remakeRecord = asRecord(detail.remake_plan);
        const remakePlan = asRecord(remakeRecord?.plan);
        const generations = Array.isArray(detail.remake_generations) ? detail.remake_generations : [];
        const latestGeneration = asRecord(generations[0]);
        if (latestGeneration) setGeneration({ ...latestGeneration, state: "completed" });
        if (!remakePlan && transcriptRecord?.status !== "available" && ocrRecord?.status !== "available") {
          setResult(null);
          return;
        }
        const observed = asRecord(remakePlan?.observed);
        const transcriptSegments = parseJsonValue(transcriptRecord?.segments);
        const ocrItems = parseJsonValue(ocrRecord?.items);
        const savedFrames = Array.isArray(detail.analysis_frames) ? detail.analysis_frames : [];
        const durationMs = asNumber(asset?.duration_ms);
        const sceneCount = asNumber(observed?.sceneCount) ?? 0;
        setResult({
          metadata: {
            duration: durationMs ? durationMs / 1000 : asNumber(observed?.durationSeconds),
            durationFormatted: formatDuration(durationMs),
            width: asNumber(observed?.width) ?? asNumber(asset?.width),
            height: asNumber(observed?.height) ?? asNumber(asset?.height),
            fps: asNumber(observed?.fps),
            videoCodec: observed?.videoCodec ?? asset?.codec_video,
            audioCodec: observed?.audioCodec ?? asset?.codec_audio,
            fileSizeBytes: asNumber(asset?.size_bytes),
          },
          transcript: Array.isArray(transcriptSegments) ? transcriptSegments : [],
          transcriptProvider: transcriptRecord?.provider ?? null,
          audioAnalysis: detail.analysis_audio ?? null,
          ocrResults: Array.isArray(ocrItems) ? ocrItems : [],
          timeline: Array.isArray(remakePlan?.timeline) ? remakePlan.timeline : [],
          frames: savedFrames,
          frameCount: asNumber(observed?.keyframeCount) ?? 0,
          sceneDetection: sceneCount ? { status: "available", provider: observed?.sceneDetector, sceneCount } : { status: "unavailable", sceneCount: 0 },
          yuanbaoInsight: remakePlan?.yuanbaoInsight ?? null,
          yuanbaoInsightStatus: remakePlan?.yuanbaoInsight ? "available" : "unavailable",
          __remakePlan: remakePlan,
          __persisted: { ok: true, loaded: true },
          __persistWarning: null,
        });
      })
      .catch(() => { /* 历史分析读取失败不阻断用户重新分析 */ });
  }, [agentState, selectedId]);

  async function runAnalysis() {
    if (!selected) return;
    analysisRequestRef.current += 1;
    setRunning(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch(`${ANALYSIS_SERVER}/analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: selected.id }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) {
        throw new Error(payload?.error ?? `分析服务返回 HTTP ${response.status}`);
      }
      setResult({
        ...payload.result,
        __remakePlan: payload.remakePlan ?? null,
        __persisted: payload.persisted ?? null,
        __persistWarning: payload.persistWarning ?? null,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "分析失败（服务无响应）");
    } finally {
      setRunning(false);
    }
  }

  async function openRemakePackage() {
    if (!selected) return;
    try {
      const response = await fetch(`${LOCAL_AGENT_URL}/api/v1/kb/videos/${encodeURIComponent(selected.id)}/open-package`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    } catch (cause) {
      setError(`打开复刻内容包失败：${cause instanceof Error ? cause.message : "未知错误"}`);
    }
  }

  async function runExternalAnalysis() {
    if (!selected || !result) return;
    setExternalRunning(true);
    setError(null);
    try {
      const response = await fetch(`${ANALYSIS_SERVER}/external-analyze`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ videoId: selected.id, confirmPublic: true }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.ok) throw new Error(payload?.error || `外站返回 HTTP ${response.status}`);
      setResult((current) => {
        if (!current) return current;
        const currentPlan = asRecord(current.__remakePlan) || {};
        return { ...current, __remakePlan: { ...currentPlan, externalVideoInsight: payload.externalInsight } };
      });
    } catch (cause) {
      setError(`外站增强失败：${cause instanceof Error ? cause.message : "未知错误"}。本地与元宝结果仍保留，可稍后重试。`);
    } finally {
      setExternalRunning(false);
    }
  }

  async function copyPrompt(key: string, value: unknown) {
    const prompt = String(value || "").trim();
    if (!prompt) return;
    try {
      await navigator.clipboard.writeText(prompt);
      setCopiedPrompt(key);
      window.setTimeout(() => setCopiedPrompt((current) => current === key ? "" : current), 1800);
    } catch {
      setError("复制失败，请选中提示词后手动复制");
    }
  }

  async function openStudio(provider: "gpt" | "seedance" | "yuanbao") {
    const opened = await openCreativeStudio(provider);
    if (!opened.ok) setError(opened.error || "创作窗口未能打开");
  }

  const metadata = (result?.metadata ?? null) as Record<string, unknown> | null;
  const transcript = Array.isArray(result?.transcript) ? (result?.transcript as Array<{ time?: string; text?: string; speaker?: string; words?: Array<{ word?: string; start?: number | null; end?: number | null }> }>) : [];
  const frames = Array.isArray(result?.frames) ? (result?.frames as Array<{ time?: string; filePath?: string; mediaUrl?: string }>) : [];
  const ocr = Array.isArray(result?.ocrResults) ? (result?.ocrResults as Array<{ time?: string; ocrText?: string; text?: string }>) : [];
  const timeline = Array.isArray(result?.timeline) ? (result?.timeline as Array<{ time?: string; ocrText?: string }>) : [];
  const warnings = Array.isArray(result?.warnings) ? (result?.warnings as Array<string>) : [];
  const remakePlan = (result?.__remakePlan ?? null) as Record<string, unknown> | null;
  const persisted = (result?.__persisted ?? null) as Record<string, unknown> | null;
  const persistWarning = typeof result?.__persistWarning === "string" ? result.__persistWarning : null;
  const remakeCopy = (remakePlan?.copywriting ?? null) as Record<string, unknown> | null;
  const remakeAudio = (remakePlan?.audioPlan ?? null) as Record<string, unknown> | null;
  const remakeShots = Array.isArray(remakePlan?.shotPlan) ? remakePlan.shotPlan as Array<Record<string, unknown>> : [];
  const seedanceWorkflow = asRecord(remakePlan?.seedanceWorkflow);
  const seedanceShots = Array.isArray(seedanceWorkflow?.shots) ? seedanceWorkflow.shots as Array<Record<string, unknown>> : [];
  const reverseBlueprint = asRecord(remakePlan?.reverseBlueprint);
  const sourceOrigin = asRecord(remakePlan?.sourceOrigin) ?? asRecord(reverseBlueprint?.originAssessment);
  const originEvidence = Array.isArray(sourceOrigin?.evidence) ? sourceOrigin.evidence.map(String) : [];
  const reverseFallbacks = Array.isArray(reverseBlueprint?.externalFallbacks) ? reverseBlueprint.externalFallbacks.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
  const externalVideoInsight = asRecord(remakePlan?.externalVideoInsight);
  const remakeUnavailable = Array.isArray(remakePlan?.unavailable) ? remakePlan.unavailable.map(String) : [];
  const yuanbaoInsight = (result?.yuanbaoInsight ?? null) as Record<string, unknown> | null;
  const sceneDetection = (result?.sceneDetection ?? null) as Record<string, unknown> | null;
  const sceneCount = typeof sceneDetection?.sceneCount === "number" ? sceneDetection.sceneCount : 0;
  const transcriptProvider = typeof result?.transcriptProvider === "string" ? result.transcriptProvider : "mcp-video-analyzer";
  const alignedWordCount = transcript.reduce((count, segment) => count + (Array.isArray(segment.words) ? segment.words.filter((word) => typeof word.start === "number").length : 0), 0);
  const speakerCount = new Set(transcript.map((segment) => segment.speaker).filter(Boolean)).size;
  const audioAnalysis = asRecord(result?.audioAnalysis) ?? asRecord(result?.__audioAnalysis);
  const voiceFeatures = asRecord(audioAnalysis?.voice);
  const backgroundFeatures = asRecord(audioAnalysis?.background);
  const bgmIdentification = asRecord(audioAnalysis?.bgmIdentification);
  const persistedAudio = Array.isArray(persisted?.audio) ? persisted.audio : Array.isArray(audioAnalysis?.items) ? audioAnalysis.items : [];
  const audioItems = persistedAudio.map((item) => asRecord(item)).filter((item): item is Record<string, unknown> => Boolean(item));

  return (
    <>
      <section className="inbox-banner">
        <div className="inbox-banner-copy">
          <span className="eyebrow-pill"><i /> 分析服务 {analyzerState === "ready" ? "已就绪" : analyzerState === "missing" ? "未启动" : "检测中"}</span>
          <h2>选择知识库视频，<br />判断来源并反推复刻。</h2>
          <p>先区分 AI 生成、实拍或混合，再结合转写、OCR、真实切镜、运镜和音频，生成 GPT + 豆包可执行的反推蓝图。</p>
          <div className="inline-capture">
            <select
              value={selectedId}
              onChange={(event) => setSelectedId(event.target.value)}
              style={{ minWidth: 0, flex: 1, height: 40, border: "1px solid #dadbd3", borderRadius: 10, padding: "0 12px", background: "#f7f6f2", fontSize: 13, outline: 0 }}
            >
              <option value="">{videos.length ? "选择知识库中的视频…" : "知识库暂无视频（先下载入库再分析）"}</option>
              {videos.map((item) => <option key={item.id} value={item.id}>{item.title.slice(0, 48)}</option>)}
            </select>
            <button className="primary-button" type="button" onClick={() => void runAnalysis()} disabled={!selected || running || analyzerState !== "ready" || agentState !== "online"}>{running ? "分析中…（可长达数分钟）" : result ? "重新分析" : "开始分析"}</button>
          </div>
          {analyzerState === "missing" && <p style={{ margin: "10px 0 0", color: "#a05b3c", fontSize: 13 }}>分析服务未运行：请双击「启动织台.command」拉起 17900 代理，或确认 mcp-video-analyzer 已安装。</p>}
        </div>
        <div className="listener-card">
          <div><span className={`node-signal ${analyzerState === "ready" ? "online" : "offline"}`} /><p><strong>mcp-video-analyzer</strong><small>{analyzerState === "ready" ? "127.0.0.1:17900 就绪" : "等待服务"}</small></p></div>
          <ul>
            <li><span>转写</span><strong>Whisper / 字幕</strong></li>
            <li><span>关键帧</span><strong>感知哈希去重</strong></li>
            <li><span>真实切镜</span><strong>PySceneDetect</strong></li>
            <li><span>景别/构图/光线</span><strong>Qwen2.5-VL · MLX</strong></li>
            <li><span>运镜</span><strong>OpenCV 光流</strong></li>
            <li><span>OCR</span><strong>tesseract.js</strong></li>
            <li><span>媒体元数据</span><strong>ffprobe</strong></li>
          </ul>
        </div>
      </section>

      {error && <div className="analysis-empty" style={{ border: "1px solid #e2b7a0", background: "#fdf4ef", borderRadius: 14, padding: 18, marginBottom: 14 }}><strong>分析失败</strong><span>{error}</span></div>}

      {result && (
        <section className="panel analysis-result-panel">
          <div className="panel-heading"><div><span>分析结果</span><h3>{Boolean(persisted?.ok) ? "已写回知识库 · 已生成复刻包" : "分析已完成"}</h3></div><div style={{ display: "flex", alignItems: "center", gap: 10 }}><span>{sceneCount ? `${sceneCount} 个真实镜头 · ` : ""}{typeof result.frameCount === "number" ? `${result.frameCount} 帧` : ""}</span>{Boolean(persisted?.ok) && <button className="secondary-button" type="button" onClick={() => void openRemakePackage()}>打开复刻内容包</button>}</div></div>
          {persistWarning && <div className="analysis-empty compact" style={{ marginBottom: 14 }}><strong>知识库写回失败</strong><span>{persistWarning}</span></div>}
          {Boolean(persisted?.loaded) && <p style={{ color: "#4f6b45", fontSize: 13, margin: "0 0 8px" }}>这是已保存的知识库分析；需要更新时再点「重新分析」。</p>}
          <p style={{ color: yuanbaoInsight ? "#4f6b45" : "#8b6a4a", fontSize: 13, margin: "0 0 12px" }}>元宝已登录网页增强：{yuanbaoInsight ? "实时签名可用（处理已提取的 ASR/OCR/本地视觉文字，不上传视频）" : "本次不可用；已使用本地分析，不伪装成功"}</p>
          {reverseBlueprint && (
            <div className="analysis-column" style={{ margin: "0 0 16px" }}>
              <div>
                <h4>素材来源判断</h4>
                <p><b>{String(sourceOrigin?.label ?? "未确认")}</b>{typeof sourceOrigin?.confidence === "number" ? ` · 置信度 ${Math.round(sourceOrigin.confidence * 100)}%` : ""}</p>
                {originEvidence.length ? <ul>{originEvidence.map((line, index) => <li key={index}>{line}</li>)}</ul> : <p>可见证据不足；不要据此猜具体生成模型。</p>}
                <small>{String(sourceOrigin?.limitation ?? "没有生成元数据时只能做画面层面的概率判断。")}</small>
              </div>
              <div>
                <h4>推荐复刻路线</h4>
                <p>{String(asRecord(reverseBlueprint?.productionStrategy)?.primary ?? "按分镜重建 GPT 首帧，再逐镜生成")}</p>
                <small>{String(asRecord(reverseBlueprint?.productionStrategy)?.fallback ?? "豆包能力不足时使用 Seedance 2.0 首帧回退，不伪装参考视频已生效。")}</small>
              </div>
            </div>
          )}
          {reverseBlueprint && (
            <div className="remake-generator" style={{ margin: "0 0 16px" }}>
              <div className="remake-generator-heading"><div><span>AI 视频反推蓝图</span><h4>风格、主体、物理规律与一致性</h4></div><strong>本地优先</strong></div>
              <div className="analysis-column">
                <div><p><b>视觉风格：</b>{String(reverseBlueprint.visualStyle ?? "待确认")}</p><p><b>主体：</b>{String(reverseBlueprint.subjectDesign ?? "待确认")}</p><p><b>环境：</b>{String(reverseBlueprint.environment ?? "待确认")}</p><p><b>材质：</b>{String(reverseBlueprint.materialsTextures ?? "待确认")}</p></div>
                <div><p><b>光线与色彩：</b>{String(reverseBlueprint.lightingColor ?? "待确认")}</p><p><b>镜头语言：</b>{String(reverseBlueprint.cameraGrammar ?? "待确认")}</p><p><b>运动物理：</b>{String(reverseBlueprint.motionPhysics ?? "待确认")}</p><p><b>剪辑节奏：</b>{String(reverseBlueprint.pacingEditing ?? "待确认")}</p></div>
              </div>
              <section className="seedance-prompt-grid"><section><div><b>通用反推提示词</b><button type="button" onClick={() => void copyPrompt("reverse-universal", reverseBlueprint.universalPrompt)}>{copiedPrompt === "reverse-universal" ? "已复制" : "复制"}</button></div><pre>{String(reverseBlueprint.universalPrompt ?? "重新分析后生成")}</pre></section><section><div><b>Seedance 参考视频提示词</b><button type="button" onClick={() => void copyPrompt("reverse-reference", reverseBlueprint.referenceVideoPrompt)}>{copiedPrompt === "reverse-reference" ? "已复制" : "复制"}</button></div><pre>{String(reverseBlueprint.referenceVideoPrompt ?? "重新分析后生成")}</pre></section></section>
              {reverseFallbacks.length ? <div className="creative-studio-actions">
                <p>网络下载的公开素材允许送外站做增强反推；按钮只发送最多 5 张关键帧，不发送账号、Cookie 或整段视频。个人、客户或含隐私的素材不要点击。外站失败不会丢失本地与元宝结果。</p>
                <button className="primary-button" type="button" onClick={() => void runExternalAnalysis()} disabled={externalRunning || !frames.length}>{externalRunning ? "外站反推中…" : externalVideoInsight ? "重新做外站增强" : "外站增强反推（5 张关键帧）"}</button>
                {reverseFallbacks.map((site) => <a key={String(site.url)} className="secondary-button" href={String(site.url)} target="_blank" rel="noreferrer">手动打开 {String(site.name)} ↗</a>)}
              </div> : null}
              {externalVideoInsight?.prompt ? <section className="seedance-prompt-grid" style={{ marginTop: 12 }}><section><div><b>外站增强提示词 · {String(externalVideoInsight.provider || "VideoToPrompt")}</b><button type="button" onClick={() => void copyPrompt("external-reverse", externalVideoInsight.prompt)}>{copiedPrompt === "external-reverse" ? "已复制" : "复制"}</button></div><pre>{String(externalVideoInsight.prompt)}</pre><small>{String(externalVideoInsight.limitation || "需与本地证据合并")}</small></section></section> : null}
            </div>
          )}
          {metadata && (
            <div className="detail-metric-grid" style={{ margin: "0 0 16px" }}>
              <div><span>时长</span><strong>{String(metadata.durationFormatted ?? metadata.duration ?? "—")}</strong></div>
              <div><span>分辨率</span><strong>{metadata.width && metadata.height ? `${metadata.width}×${metadata.height}` : "—"}</strong></div>
              <div><span>帧率</span><strong>{String(metadata.fps ?? "—")}</strong></div>
              <div><span>视频编码</span><strong>{String(metadata.videoCodec ?? "—")}</strong></div>
              <div><span>音频编码</span><strong>{String(metadata.audioCodec ?? "—")}</strong></div>
              <div><span>大小</span><strong>{metadata.fileSizeBytes ? formatBytes(Number(metadata.fileSizeBytes)) : "—"}</strong></div>
            </div>
          )}
          <div className="analysis-column">
            <div>
              <h4>语音转写</h4>
              {transcript.length ? <><p style={{ color: "#65705f", fontSize: 13 }}>{transcriptProvider}{alignedWordCount ? ` · ${alignedWordCount} 个逐词时间码` : " · 句级时间码"}{speakerCount ? ` · ${speakerCount} 位说话人` : " · 说话人区分待授权"}</p><ol className="timed-text-list">{transcript.map((seg, i) => <li key={i}><time>{seg.time ?? ""}</time><p>{seg.speaker ? <b>{seg.speaker}：</b> : null}{seg.text}</p></li>)}</ol></> : <div className="analysis-empty compact"><strong>转写不可用</strong><span>视频没有可识别语音，或转写引擎暂不可用。</span></div>}
            </div>
            <div>
              <h4>画面 OCR（关键帧）</h4>
              {frames.length ? <div className="shot-grid">{frames.map((frame, i) => {
                const frameSrc = frame.mediaUrl
                  ? (frame.mediaUrl.startsWith("http") ? frame.mediaUrl : `${LOCAL_AGENT_URL}${frame.mediaUrl}`)
                  : frame.filePath ? `${ANALYSIS_SERVER}/media?path=${encodeURIComponent(frame.filePath)}` : null;
                return <article key={i}><span>{frame.time ?? "时间未提供"}</span>{frameSrc ? <img src={frameSrc} alt={`关键帧 ${i + 1}`} style={{ width: "100%", borderRadius: 10, display: "block", marginTop: 6 }} loading="lazy" /> : null}<small>帧 {i + 1}</small></article>;
              })}</div> : <div className="analysis-empty compact"><strong>{persisted?.loaded ? "该次历史分析未保存关键帧" : "未提取到帧"}</strong><span>{persisted?.loaded ? "旧分析需要点一次「重新分析」；此后关键帧会永久保存在内容包。" : "跳过帧分析或视频无法解码。"}</span></div>}
            </div>
          </div>
          {(ocr.length || timeline.length) && (
            <div className="analysis-column">
              <div>
                <h4>OCR 文本</h4>
                {timeline.map((seg, i) => seg.ocrText ? <div key={i} className="timed-text-list" style={{ marginBottom: 8 }}><time>{seg.time ?? ""}</time><p style={{ whiteSpace: "pre-wrap" }}>{seg.ocrText}</p></div> : null)}
              </div>
            </div>
          )}
          {warnings.length > 0 && <p style={{ color: "#8b6a4a", fontSize: 13, marginTop: 12 }}>提示：{warnings.join("；")}</p>}
          {audioAnalysis?.status === "available" && (
            <div className="analysis-column" style={{ marginTop: 18 }}>
              <div>
                <h4>配音声学特征</h4>
                <p><b>观察：</b>{String(voiceFeatures?.styleObserved ?? "未取得")}</p>
                <p><b>音高中位数：</b>{voiceFeatures?.pitchMedianHz ? `${String(voiceFeatures.pitchMedianHz)} Hz` : "未取得"}</p>
                <p><b>停顿比例：</b>{typeof voiceFeatures?.silenceRatio === "number" ? `${Math.round(voiceFeatures.silenceRatio * 100)}%` : "未取得"}</p>
                {audioItems.find((item) => item.kind === "voice")?.mediaUrl ? <audio controls preload="none" src={`${LOCAL_AGENT_URL}${String(audioItems.find((item) => item.kind === "voice")?.mediaUrl)}`} style={{ width: "100%" }} /> : null}
              </div>
              <div>
                <h4>伴奏 / 环境声</h4>
                <p><b>检测：</b>{String(backgroundFeatures?.presence ?? "未取得")}</p>
                <p><b>节奏：</b>{backgroundFeatures?.tempoBpm ? `${String(backgroundFeatures.tempoBpm)} BPM` : "未取得"}</p>
                <p><b>BGM 曲名：</b>{String(bgmIdentification?.title ?? "指纹库尚未匹配")}</p>
                {audioItems.find((item) => item.kind === "accompaniment")?.mediaUrl ? <audio controls preload="none" src={`${LOCAL_AGENT_URL}${String(audioItems.find((item) => item.kind === "accompaniment")?.mediaUrl)}`} style={{ width: "100%" }} /> : null}
              </div>
            </div>
          )}
          {remakePlan && (
            <div className="analysis-column" style={{ marginTop: 18 }}>
              <div>
                <h4>复刻文案包</h4>
                <p><b>前三秒钩子：</b>{String(remakeCopy?.hook3s ?? "尚未取得")}</p>
                <p style={{ whiteSpace: "pre-wrap" }}><b>配音/字幕草稿：</b><br />{String(remakeCopy?.voiceoverDraft ?? remakeCopy?.subtitleDraft ?? "尚未取得可用转写")}</p>
                <p><b>配音节奏：</b>{String(remakeAudio?.pace ?? "尚未取得")}{typeof remakeAudio?.charactersPerMinute === "number" ? `（约 ${remakeAudio.charactersPerMinute} 字/分钟）` : ""}</p>
                <p><b>结尾引导：</b>{String(remakeCopy?.cta ?? "尚未观察到")}</p>
                <p><small>内容包同时生成 subtitles.srt、voiceover.txt 和 shot-list.csv，可交给剪映/Premiere 继续制作。</small></p>
              </div>
              <div>
                <h4>复刻分镜表</h4>
                {remakeShots.length ? <ol className="timed-text-list">{remakeShots.map((shot, index) => <li key={index}><time>{String(shot.startSeconds ?? "?")}s–{String(shot.endSeconds ?? "?")}s</time><p>{String(shot.narration ?? shot.onScreenText ?? "关键帧已提取；画面语义待确认")}{shot.narration && shot.onScreenText ? <><br /><small>画面字：{String(shot.onScreenText)}</small></> : null}<br /><small>景别：{String(shot.shotSize ?? "未确认")} · 机位：{String(shot.cameraAngle ?? "未确认")} · 运镜：{String(shot.cameraMovement ?? "未确认")}</small><br /><small>构图：{String(shot.composition ?? "未确认")} · 光线：{String(shot.lighting ?? "未确认")}</small>{shot.evidence ? <><br /><small>证据：{String(shot.evidence)}</small></> : null}</p></li>)}</ol> : <div className="analysis-empty compact"><strong>尚无分镜</strong><span>视频未提取到可用关键帧。</span></div>}
              </div>
            </div>
          )}
          {remakePlan && (
            <div className="remake-generator" style={{ marginTop: 18 }}>
              <div className="remake-generator-heading">
                <div><span>主制作流程</span><h4>{seedanceWorkflow?.mode === "ai_reverse" ? "AI 反推 → GPT 新主体图 → 豆包参考视频 / 2.0 回退" : "GPT 分镜图 → 豆包 Seedance 2.0"}</h4></div>
                <strong>{seedanceShots.length ? `${String(seedanceWorkflow?.targetDurationSeconds ?? "按素材计算")} 秒 · ${seedanceShots.length} 个镜头` : "重新分析后生成"}</strong>
              </div>
              <div className="seedance-quality-gate">
                <b>发布标准</b>
                <span>不再机械固定 30 秒。优先按平均观看时长和完播率，缺数据时按原片信息密度给出较短版本；豆包每镜生成 10 秒，织台裁取稳定片段后拼接。</span>
              </div>
              <div className="creative-studio-actions">
                <button className="primary-button" type="button" onClick={() => selectedId && onCreate(selectedId)} disabled={!selectedId || selected?.category !== "素材" || !seedanceShots.length}>使用这次反推 → 一键生成发布</button>
                <button className="primary-button" type="button" onClick={() => void openStudio("gpt")}>打开 GPT 生图（织台内）</button>
                <button className="secondary-button" type="button" onClick={() => void openStudio("seedance")}>打开豆包 Seedance 2.0（织台内）</button>
                <button className="secondary-button" type="button" onClick={() => void openStudio("yuanbao")}>登录 / 检查元宝分析</button>
                <p>{selected?.category === "素材" ? "第一个按钮会把当前素材带到生成队列：自动 GPT 生图、豆包逐镜生成、拼接并登记成片，然后打开发布中心；正式发布仍需选择账号和平台。" : "只有归类为“素材”的成片/视觉案例进入自动生成；教程和工具内容留在每日学习。"}第一次分别登录一次即可。</p>
              </div>
              {seedanceShots.length ? (
                <div className="seedance-shot-list">
                  {seedanceShots.map((shot, index) => {
                    const gptKey = `gpt-${index}`;
                    const seedanceKey = `seedance-${index}`;
                    return (
                      <article className="seedance-shot-card" key={String(shot.index ?? index)}>
                        <header>
                          <div><span>分镜 {String(shot.index ?? index + 1)}</span><h5>{String(shot.role ?? "内容分镜")}</h5></div>
                          <strong>生成 {String(shot.generationDurationSeconds ?? 10)} 秒 · 成片用 {String(shot.durationSeconds ?? 6)} 秒</strong>
                        </header>
                        {shot.imageUrl ? <img className="seedance-storyboard" src={`${LOCAL_AGENT_URL}${String(shot.imageUrl)}`} alt={`分镜 ${String(shot.index ?? index + 1)} GPT 首帧`} /> : null}
                        <p className="seedance-narration"><b>配音：</b>{String(shot.narration ?? "待确认")}</p>
                        <div className="seedance-prompt-grid">
                          <section>
                            <div><b>① GPT 生图提示词</b><button type="button" onClick={() => void copyPrompt(gptKey, shot.gptImagePrompt)}>{copiedPrompt === gptKey ? "已复制" : "复制"}</button></div>
                            <pre>{String(shot.gptImagePrompt ?? "尚未生成")}</pre>
                          </section>
                          <section>
                            <div><b>② Seedance 2.0 提示词</b><button type="button" onClick={() => void copyPrompt(seedanceKey, shot.seedancePrompt)}>{copiedPrompt === seedanceKey ? "已复制" : "复制"}</button></div>
                            <pre>{String(shot.seedancePrompt ?? "尚未生成")}</pre>
                          </section>
                          {shot.referenceVideoPrompt ? <section><div><b>③ 支持参考视频时使用</b><button type="button" onClick={() => void copyPrompt(`reference-${index}`, shot.referenceVideoPrompt)}>{copiedPrompt === `reference-${index}` ? "已复制" : "复制"}</button></div><pre>{String(shot.referenceVideoPrompt)}</pre></section> : null}
                        </div>
                      </article>
                    );
                  })}
                </div>
              ) : <div className="analysis-empty compact"><strong>旧分析记录还没有 Seedance 工作流</strong><span>点击上方“开始分析”，织台会用真实转写和镜头生成 4–8 个制作分镜。</span></div>}
              {generation?.state === "completed" && generation.mediaUrl ? (
                <details className="legacy-remake-draft">
                  <summary>查看旧的技术冒烟草稿（不建议发布）</summary>
                  <div className="remake-preview">
                    <video controls preload="metadata" src={`${LOCAL_AGENT_URL}${String(generation.mediaUrl)}`} />
                    <a className="secondary-button" href={`${LOCAL_AGENT_URL}${String(generation.mediaUrl)}`} download>下载旧草稿</a>
                  </div>
                </details>
              ) : null}
            </div>
          )}
          {remakeUnavailable.length > 0 && <p style={{ color: "#8b6a4a", fontSize: 13, marginTop: 12 }}>仍需补充：{remakeUnavailable.join("、")}</p>}
        </section>
      )}
    </>
  );
}

function Connectors({
  agentState,
  health,
  services,
  checkAgent,
}: {
  agentState: AgentState;
  health: HealthInfo | null;
  services: LocalService[];
  checkAgent: () => void;
}) {
  return (
    <>
      <section className="connector-banner">
        <div><span className={`node-signal ${agentState}`} /><p><small>LOCAL COMPANION</small><strong>{agentState === "online" ? "本地节点已连接" : agentState === "checking" ? "正在检测本地节点" : "等待本地节点"}</strong><span>127.0.0.1:17890 · {health?.knowledgeBase ?? "登录态和本地文件不离开这台电脑"}</span></p></div>
        <button className="secondary-button" type="button" onClick={checkAgent}>{agentState === "checking" ? "检测中…" : "重新检测"}</button>
      </section>
      <section className="connector-grid">
        {connectorProjects.map((project) => {
          const projectId = compactId(project.name);
          const service = services.find((candidate) => {
            const candidateId = compactId(`${candidate.id}${candidate.name}`);
            return candidateId.includes(projectId) || projectId.includes(compactId(candidate.id));
          });
          return (
          <article className="connector-card" key={project.name}>
            <div><span>{project.tag}</span><StatusPill status={service ? displayStatus(service.status) : project.status} /></div>
            <small>{project.role}</small><h3>{project.name}</h3><p>{project.description}</p>
            <footer><a href={project.href} target="_blank" rel="noreferrer">查看开源项目 ↗</a><span>{service ? service.detail : "按集成文档配置"}</span></footer>
          </article>
          );
        })}
      </section>
      <section className="security-note"><span>锁</span><div><strong>本地优先的安全边界</strong><p>账号 Cookie、微信会话和下载文件仅保存在本地节点。页面只保存任务状态；删除、发布、发送消息等操作默认需要人工确认。</p></div></section>
    </>
  );
}

function Logs({
  agentState,
  health,
  tasks,
  events,
}: {
  agentState: AgentState;
  health: HealthInfo | null;
  tasks: WorkbenchTask[];
  events: LocalEvent[];
}) {
  const completed = tasks.filter((task) => ["completed", "success", "submitted", "platform_draft"].includes(task.rawStatus.toLowerCase())).length;
  const attention = tasks.filter((task) => ["failed", "needs_attention", "needs_setup"].includes(task.rawStatus.toLowerCase())).length;
  return (
    <section className="log-console">
      <header><div><i /><i /><i /></div><span>local-companion / {agentState === "online" ? "live" : "offline"}</span><button type="button" disabled>日志已脱敏</button></header>
      <div className="log-summary"><div><small>运行时长</small><strong>{health?.uptimeSeconds === null || health?.uptimeSeconds === undefined ? "—" : formatDuration(health.uptimeSeconds * 1000)}</strong></div><div><small>本地任务</small><strong>{tasks.length}</strong></div><div><small>已完成/提交</small><strong>{completed}</strong></div><div><small>需处理</small><strong>{attention}</strong></div></div>
      <div className="log-stream">
        {events.map((event) => <div key={event.id}><time>{event.time}</time><span className={`log-type type-${event.type}`}>{event.type}</span><p>{event.message}</p></div>)}
        {!events.length && <div className="log-cursor"><time>—</time><span>{agentState === "online" ? "READY" : "OFFLINE"}</span><p>{agentState === "online" ? "等待下一条真实事件" : "启动本地节点后同步事件"} <i /></p></div>}
      </div>
    </section>
  );
}
