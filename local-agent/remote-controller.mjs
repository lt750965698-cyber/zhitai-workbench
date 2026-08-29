import { createHash, randomInt, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const HELP = [
  "织台 ClawBot 备用直链收件与遥控（私聊固定命令，不调用 AI）",
  "今日 / 每日学习：今天的学习清单",
  "入库 / 入库摘要：今天入库统计",
  "素材：最近可复刻素材",
  "队列：下载、生成和发布队列",
  "失败：最近失败任务",
  "备用直接发送链接：自动识别并下载入知识库；链接后文字会保存为你的备注/要求",
  "状态：织台与各后台状态",
  "生成 1：准备第 1 条素材（需二次确认）",
  "选择 2：查询今日第 2 条成片的织台自审、返工或发布准备状态（兼容“发布 2”）",
  "改进 2 镜头太快：可选补充意见；织台会保存意见并创建返工任务",
  "暂停生成 / 继续生成：控制生成队列",
  "帮助：再次显示本说明",
].join("\n");

// 电脑微信只发送这一句固定纯文字来刷新 ClawBot 会话。它不承载业务语义，
// 也不包含账号、令牌或其它认证信息；必须保持精确匹配，避免普通消息被误判。
const AUTOMATED_KEEPALIVE_TEXT = "织台连接保活";
// Android ADB 在未安装第三方中文输入法时只能可靠注入 ASCII。这个唯一别名
// 与中文保活词完全等价，不接受参数，也不扩展为任意消息发送能力。
const AUTOMATED_KEEPALIVE_ASCII = "ZT_KEEPALIVE";
const AUTOMATED_KEEPALIVE_ACK_TEXT = "已保活";

function isAutomatedKeepalive(value) {
  return value === AUTOMATED_KEEPALIVE_TEXT || value === AUTOMATED_KEEPALIVE_ASCII;
}

function cleanText(value, limit = 500) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, limit);
}

function senderHash(value) {
  return createHash("sha256").update(String(value || "unknown")).digest("hex").slice(0, 12);
}

async function readJson(path, fallback) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

export class RemoteController {
  constructor({ dataDir, getSummary, getMaterials, getQueue, getFailures, getStatus, ingestLink, enqueueCreative, approveCreative, reviseCreative, pauseCreative, resumeCreative }) {
    this.settingsPath = `${dataDir}/remote-control-settings.json`;
    this.auditPath = `${dataDir}/remote-control-audit.json`;
    this.pendingPath = `${dataDir}/remote-control-pending.json`;
    this.getSummary = getSummary;
    this.getMaterials = getMaterials;
    this.getQueue = getQueue;
    this.getFailures = getFailures;
    this.getStatusText = getStatus;
    this.ingestLink = ingestLink;
    this.enqueueCreative = enqueueCreative;
    this.approveCreative = approveCreative;
    this.reviseCreative = reviseCreative;
    this.pauseCreative = pauseCreative;
    this.resumeCreative = resumeCreative;
    this.settings = { enabled: true, autoPair: true, allowedSenders: [] };
  }

  async init() {
    const saved = await readJson(this.settingsPath, {});
    this.settings = {
      enabled: saved.enabled !== false,
      autoPair: saved.autoPair !== false,
      allowedSenders: Array.isArray(saved.allowedSenders) ? saved.allowedSenders.map(String).filter(Boolean).slice(0, 8) : [],
    };
  }

  async status() {
    const audit = await this.audit(1);
    return {
      enabled: this.settings.enabled,
      paired: this.settings.allowedSenders.length > 0,
      pairedCount: this.settings.allowedSenders.length,
      autoPair: this.settings.autoPair,
      lastCommandAt: audit[0]?.createdAt ?? null,
      mode: "deterministic_only",
      ingestDisabled: false,
      modelDispatch: false,
    };
  }

  async audit(limit = 50) {
    const items = await readJson(this.auditPath, []);
    return Array.isArray(items) ? items.slice(0, Math.max(1, Math.min(200, Number(limit) || 50))) : [];
  }

  async unpair() {
    this.settings.allowedSenders = [];
    await writeJsonAtomic(this.settingsPath, this.settings);
    await writeJsonAtomic(this.pendingPath, []);
    return this.status();
  }

  async route({ text, senderId, accountId, isGroup = false }) {
    const command = cleanText(text);
    const sender = cleanText(senderId, 240);
    if (isGroup) return { ok: false, text: "织台遥控命令只接受私聊，不在群聊执行。", code: "group_not_allowed", authorizedSender: false };
    if (!sender) return { ok: false, text: "无法识别微信发送者，本次命令未执行。", code: "sender_missing", authorizedSender: false };

    if (this.settings.enabled && !this.settings.allowedSenders.length && this.settings.autoPair) {
      this.settings.allowedSenders = [sender];
      await writeJsonAtomic(this.settingsPath, this.settings);
      await this.record(sender, accountId, "PAIR", "success", "首次私聊发送者已绑定");
    }
    const authorizedSender = this.settings.allowedSenders.includes(sender);
    // 遥控命令即使被关闭，已配对白名单用户的私聊回复仍能确认“我已看到”，
    // 从而停止运营阻塞提醒；未配对发送者始终不能关闭提醒。
    if (!authorizedSender) {
      await this.record(sender, accountId, command || "EMPTY", "rejected", "发送者不在白名单");
      return { ok: false, text: "这个微信账号未与织台绑定，命令未执行。", code: "sender_not_allowed", authorizedSender: false };
    }
    // 保活不是业务遥控命令；即使业务遥控被停用，白名单私聊也必须能刷新会话。
    // 其它普通白名单回复仍按旧行为返回 remote_disabled，并由服务端确认 blocker。
    if (!this.settings.enabled && !isAutomatedKeepalive(command)) {
      return { ok: false, text: "织台手机遥控器当前已停用。", code: "remote_disabled", authorizedSender: true };
    }

    let result;
    try {
      result = await this.execute(command, sender);
      await this.record(sender, accountId, command || "EMPTY", result.ok === false ? "rejected" : "success", result.audit || result.code || "handled");
      return { ...result, authorizedSender: true };
    } catch (error) {
      await this.record(sender, accountId, command || "EMPTY", "failed", cleanText(error?.message || error, 160));
      return {
        ok: false,
        text: "织台执行命令失败，请打开织台消息中心查看记录。",
        code: "command_failed",
        authorizedSender: true,
        ...(isAutomatedKeepalive(command) ? { automatedKeepalive: true } : {}),
      };
    }
  }

  async execute(command, sender) {
    if (isAutomatedKeepalive(command)) {
      return {
        ok: true,
        text: AUTOMATED_KEEPALIVE_ACK_TEXT,
        code: "automated_keepalive",
        audit: "automated_keepalive",
        automatedKeepalive: true,
      };
    }
    if (/https?:\/\//i.test(command)) {
      if (typeof this.ingestLink !== "function") return { ok: false, text: "织台链接收件功能尚未就绪。", code: "ingest_unavailable" };
      const url = command.match(/https?:\/\/[^\s<>"']+/i)?.[0]?.replace(/[，。；、）》】\])}]+$/u, "") || "";
      const note = cleanText(command.replace(url, ""), 1_000);
      const task = await this.ingestLink({ url, text: command, userNote: note, sender });
      const repeated = task?.deduplicated === true;
      const title = cleanText(task?.title || "链接内容", 58);
      const state = task?.status === "needs_setup" ? "已识别，但对应登录或下载引擎需要处理" : "已进入下载与入库队列";
      return {
        ok: true,
        text: `${repeated ? "这条内容已经收过，不会重复下载" : state}：${title}${note ? `\n已保存你的备注：${note}` : ""}${task?.id ? `\n任务：${task.id}` : ""}`,
        audit: repeated ? "ingest_deduplicated" : "ingest_queued",
      };
    }
    if (!command || /^(帮助|help|菜单|命令)$/i.test(command)) return { ok: true, text: HELP, audit: "help" };
    if (/^(今日|每日学习|学习)$/i.test(command)) return { ok: true, text: await this.getSummary("learning"), audit: "learning_digest" };
    if (/^(入库|入库摘要|今日入库)$/i.test(command)) return { ok: true, text: await this.getSummary("ingest"), audit: "ingest_digest" };
    if (/^(素材|复刻素材)$/i.test(command)) return { ok: true, text: await this.materialText(), audit: "materials" };
    if (/^(队列|任务|任务队列)$/i.test(command)) return { ok: true, text: await this.getQueue(), audit: "queue" };
    if (/^(失败|异常|失败任务)$/i.test(command)) return { ok: true, text: await this.getFailures(), audit: "failures" };
    if (/^(状态|在线|服务状态)$/i.test(command)) return { ok: true, text: await this.getStatusText(), audit: "status" };
    if (/^暂停生成$/i.test(command)) return { ok: true, text: await this.pauseCreative(), audit: "creative_paused" };
    if (/^继续生成$/i.test(command)) return { ok: true, text: await this.resumeCreative(), audit: "creative_resumed" };

    const approve = command.match(/^(?:发布|选择)\s*(\d+)$/i);
    if (approve) {
      if (typeof this.approveCreative !== "function") return { ok: false, text: "成片审核队列尚未就绪。", code: "creative_review_unavailable" };
      const review = String(await this.approveCreative(Number(approve[1])) ?? "");
      const text = /^今日没有第/.test(review)
        ? review
        : `${review}\n本次只创建多平台草稿待办，不会公开发布。`;
      return { ok: true, text, audit: "creative_approved" };
    }

    const revise = command.match(/^(?:改进|修改|返工)\s*(\d+)\s+(.+)$/i);
    if (revise) {
      if (typeof this.reviseCreative !== "function") return { ok: false, text: "成片返工队列尚未就绪。", code: "creative_review_unavailable" };
      return { ok: true, text: await this.reviseCreative(Number(revise[1]), cleanText(revise[2], 800)), audit: "creative_revision_requested" };
    }

    const generate = command.match(/^生成\s+(.+)$/i);
    if (generate) {
      const materials = await this.getMaterials();
      const requested = cleanText(generate[1], 160);
      const byIndex = /^\d+$/.test(requested) ? materials[Number(requested) - 1] : null;
      const asset = byIndex || materials.find((item) => item.id === requested);
      if (!asset) return { ok: false, text: "没有找到这条素材。先回复“素材”查看编号。", code: "material_not_found" };
      const code = String(randomInt(1000, 10_000));
      const pending = (await readJson(this.pendingPath, [])).filter((item) => Date.parse(item.expiresAt) > Date.now() && item.sender === sender);
      pending.unshift({ id: randomUUID(), sender, code, action: "enqueue_creative", assetId: asset.id, title: cleanText(asset.title, 120), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString() });
      await writeJsonAtomic(this.pendingPath, pending.slice(0, 10));
      return { ok: true, text: `准备把“${cleanText(asset.title, 42)}”加入生成队列。\n回复“确认 ${code}”在 10 分钟内执行。`, audit: "creative_confirmation_created" };
    }

    const confirmation = command.match(/^确认\s+(\d{4})$/);
    if (confirmation) {
      const pending = await readJson(this.pendingPath, []);
      const item = pending.find((candidate) => candidate.sender === sender && candidate.code === confirmation[1] && Date.parse(candidate.expiresAt) > Date.now());
      if (!item) return { ok: false, text: "确认码无效或已过期，请重新发送“生成 编号”。", code: "confirmation_invalid" };
      const remaining = pending.filter((candidate) => candidate.id !== item.id && Date.parse(candidate.expiresAt) > Date.now());
      await writeJsonAtomic(this.pendingPath, remaining);
      if (item.action === "enqueue_creative") {
        const created = await this.enqueueCreative(item.assetId);
        return { ok: true, text: `已加入生成队列：${item.title}\n任务 ${created.id || "已创建"}`, audit: "creative_enqueued" };
      }
    }

    if (/\.(mp4|mov|m4v)$/i.test(command)) return { ok: false, text: "内容采集主入口是微信文件传输助手。ClawBot 作为备用通道只接受可访问的分享链接；本地文件请从织台下载页导入。", code: "local_file_not_supported" };
    return { ok: false, text: `未识别这个命令，且没有调用 AI。\n\n${HELP}`, code: "unknown_command" };
  }

  async materialText() {
    const materials = await this.getMaterials();
    if (!materials.length) return "目前没有可复刻的“素材”分类内容。";
    return ["最近可复刻素材：", ...materials.slice(0, 8).map((item, index) => `${index + 1}. ${cleanText(item.title, 46)}`), "回复“生成 编号”准备任务。"].join("\n");
  }

  async record(sender, accountId, command, status, detail) {
    const items = await readJson(this.auditPath, []);
    items.unshift({
      id: `rc_${randomUUID()}`,
      sender: senderHash(sender),
      account: accountId ? senderHash(accountId) : null,
      command: cleanText(command, 120),
      status,
      detail: cleanText(detail, 180),
      createdAt: new Date().toISOString(),
    });
    await writeJsonAtomic(this.auditPath, items.slice(0, 500));
  }
}

export function shouldAcknowledgeRemoteUserReply(result) {
  return result?.authorizedSender === true && result?.automatedKeepalive !== true;
}

export {
  HELP as REMOTE_HELP_TEXT,
  AUTOMATED_KEEPALIVE_TEXT as REMOTE_KEEPALIVE_TEXT,
  AUTOMATED_KEEPALIVE_ASCII as REMOTE_KEEPALIVE_ASCII,
  AUTOMATED_KEEPALIVE_ACK_TEXT as REMOTE_KEEPALIVE_ACK_TEXT,
};
