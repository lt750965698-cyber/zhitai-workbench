import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const DEFAULT_RETRY_DELAYS_MS = [30_000, 2 * 60_000, 10 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000];
const SESSION_RETRY_DELAYS_MS = [2 * 60 * 60_000, 8 * 60 * 60_000, 24 * 60 * 60_000];
const DEFAULT_BLOCKER_REMINDER_DELAYS_MS = [2 * 60 * 60_000, 8 * 60 * 60_000, 24 * 60 * 60_000];
const OUTBOX_DRAIN_LIMIT = 5;
const CRITICAL_STORAGE_SCOPES = new Set([
  "settings_read",
  "settings_write",
  "ingress_read",
  "ingress_shape",
  "ingress_write",
  "outbox_read",
  "outbox_shape",
  "outbox_write",
  "blockers_read",
  "blockers_shape",
  "blockers_write",
  "deliveries_read",
  "deliveries_shape",
  "deliveries_write",
]);
const BLOCKER_KINDS = new Set([
  "credential_weread",
  "credential_yuanbao",
  "runtime_conditions",
  "creative_failed",
  "publish_failed",
  "filehelper_offline",
  "download_failed",
  "notification_channel",
]);
const RECOVERY_KIND_MAP = new Map([
  ["runtime_conditions_recovered", ["runtime_conditions"]],
  ["filehelper_recovered", ["filehelper_offline"]],
]);

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600).catch(() => {});
}

function safeDeliveryError(error, fallback = "notification_delivery_failed") {
  const text = String(error?.message || error || fallback);
  if (/token|context|credential|cookie|authorization|secret/i.test(text)) return "notification_session_unavailable";
  return text
    .replace(/https?:\/\/\S+/gi, "<redacted-url>")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 180);
}

function deliveryErrorCode(error) {
  const text = String(error?.message || error || "");
  if (/ret\s*=\s*-2|prepare failed|session_refresh_required/i.test(text)) return "session_refresh_required";
  if (/\b429\b|rate.?limit|频率|限流/i.test(text)) return "rate_limited";
  if (/timeout|timed out|AbortError|ETIMEDOUT/i.test(text)) return "timeout";
  if (/ENOTFOUND|ECONNREFUSED|network|fetch failed/i.test(text)) return "network_unavailable";
  if (/target_unavailable|sender_unavailable|session_unavailable/i.test(text)) return "session_unavailable";
  if (/HTTP\s+4\d\d/i.test(text)) return "client_error";
  return "delivery_failed";
}

function blockerKey(kind) {
  return `blocker:${String(kind || "notification").slice(0, 100)}`;
}

function requiresSlowRetry(errorCode) {
  return ["session_refresh_required", "session_unavailable", "not_configured", "client_error"].includes(String(errorCode || ""));
}

function preferredFailureCode(failures, fallback = "delivery_failed") {
  for (const code of ["session_refresh_required", "session_unavailable", "client_error"]) {
    if (failures.some((failure) => failure.errorCode === code)) return code;
  }
  const configuredFailure = failures.find((failure) => failure.errorCode !== "not_configured");
  if (configuredFailure) return configuredFailure.errorCode;
  return failures.at(-1)?.errorCode || fallback;
}

function notificationKey(kind, title, message) {
  return createHash("sha256")
    .update(`${String(kind || "notification")}\u0000${String(title || "")}\u0000${String(message || "")}`)
    .digest("hex")
    .slice(0, 32);
}

function asDate(value, fallback = new Date()) {
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : fallback;
}

function validTime(value, fallback) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(value || "")) ? String(value) : fallback;
}

function cleanServer(value) {
  const parsed = new URL(String(value || "https://ntfy.sh"));
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error("notification_server_invalid");
  return parsed.toString().replace(/\/$/, "");
}

function cleanTopic(value) {
  const topic = String(value || "").trim();
  if (topic && !/^[A-Za-z0-9_-]{8,120}$/.test(topic)) throw new Error("notification_topic_invalid");
  return topic;
}

function localDateKey(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export class NotificationCenter {
  constructor({
    dataDir,
    buildDigest,
    clawbot = null,
    now = () => new Date(),
    retryDelaysMs = DEFAULT_RETRY_DELAYS_MS,
    sessionRetryDelaysMs = SESSION_RETRY_DELAYS_MS,
    blockerReminderDelaysMs = DEFAULT_BLOCKER_REMINDER_DELAYS_MS,
    dedupeWindowMs = 5 * 60_000,
  }) {
    this.settingsPath = `${dataDir}/notification-settings.json`;
    this.deliveryPath = `${dataDir}/notification-deliveries.json`;
    this.ingressPath = `${dataDir}/notification-ingress.json`;
    this.outboxPath = `${dataDir}/notification-outbox.json`;
    this.blockerPath = `${dataDir}/notification-blockers.json`;
    this.deliveryHealthPath = `${dataDir}/notification-delivery-health.json`;
    this.buildDigest = buildDigest;
    this.clawbot = clawbot;
    this.now = now;
    this.retryDelaysMs = Array.isArray(retryDelaysMs) && retryDelaysMs.length
      ? retryDelaysMs.map((value) => Math.max(1, Number(value) || 1))
      : DEFAULT_RETRY_DELAYS_MS;
    this.sessionRetryDelaysMs = Array.isArray(sessionRetryDelaysMs) && sessionRetryDelaysMs.length
      ? sessionRetryDelaysMs.map((value) => Math.max(1, Number(value) || 1))
      : SESSION_RETRY_DELAYS_MS;
    this.blockerReminderDelaysMs = Array.isArray(blockerReminderDelaysMs) && blockerReminderDelaysMs.length
      ? blockerReminderDelaysMs.map((value) => Math.max(1, Number(value) || 1))
      : DEFAULT_BLOCKER_REMINDER_DELAYS_MS;
    this.dedupeWindowMs = Math.max(0, Number(dedupeWindowMs) || 0);
    this.timer = null;
    this.tickPromise = null;
    this.sendMutation = Promise.resolve();
    this.ingressMutation = Promise.resolve();
    this.deliveryMutation = Promise.resolve();
    this.storageIssues = [];
    this.deliveryHealthWritable = true;
    this.schedulerHealth = { state: "unverified", lastSuccessAt: null, lastFailureAt: null, lastError: null };
    this.deliveryHealth = {
      clawbot: {
        deliveryState: "unverified",
        sessionFailureStage: 0,
        lastSuccessAt: null,
        lastFailureAt: null,
        lastError: null,
        cooldownUntil: null,
        contextUpdatedAt: null,
      },
      ntfy: {
        deliveryState: "unverified",
        lastSuccessAt: null,
        lastFailureAt: null,
        lastError: null,
      },
    };
    this.settings = {
      ntfy: { enabled: false, server: "https://ntfy.sh", topic: "", accessToken: "" },
      schedules: {
        learning: { enabled: true, time: "21:30", lastRunDate: null },
        ingest: { enabled: true, time: "22:00", lastRunDate: null },
      },
      events: { creative: true, publishFailure: true, downloadFailure: true, filehelperOffline: true },
    };
  }

  recordStorageIssue(scope, error) {
    const code = String(error?.code || error?.name || "storage_error").slice(0, 80);
    const item = { scope: String(scope).slice(0, 80), code, at: asDate(this.now()).toISOString() };
    this.storageIssues = [item, ...this.storageIssues.filter((existing) => existing.scope !== item.scope)].slice(0, 20);
  }

  clearStorageIssues(...scopes) {
    const resolved = new Set(scopes.map(String));
    this.storageIssues = this.storageIssues.filter((item) => !resolved.has(item.scope));
  }

  async init() {
    let saved = {};
    let settingsReadable = true;
    try { saved = await readJson(this.settingsPath, {}); }
    catch (error) {
      settingsReadable = false;
      this.recordStorageIssue("settings_read", error);
    }
    let savedServer = "https://ntfy.sh";
    let savedTopic = "";
    try { savedServer = cleanServer(saved?.ntfy?.server || "https://ntfy.sh"); }
    catch (error) { this.recordStorageIssue("settings_ntfy_server", error); }
    try { savedTopic = cleanTopic(saved?.ntfy?.topic || ""); }
    catch (error) { this.recordStorageIssue("settings_ntfy_topic", error); }
    this.settings = {
      ntfy: {
        enabled: saved?.ntfy?.enabled === true,
        server: savedServer,
        topic: savedTopic,
        accessToken: String(saved?.ntfy?.accessToken || "").trim().slice(0, 500),
      },
      schedules: {
        learning: { enabled: saved?.schedules?.learning?.enabled !== false, time: validTime(saved?.schedules?.learning?.time, "21:30"), lastRunDate: saved?.schedules?.learning?.lastRunDate || null },
        ingest: { enabled: saved?.schedules?.ingest?.enabled !== false, time: validTime(saved?.schedules?.ingest?.time, "22:00"), lastRunDate: saved?.schedules?.ingest?.lastRunDate || null },
      },
      events: {
        creative: saved?.events?.creative !== false,
        publishFailure: saved?.events?.publishFailure !== false,
        downloadFailure: saved?.events?.downloadFailure !== false,
        filehelperOffline: saved?.events?.filehelperOffline !== false,
      },
    };
    if (!this.settings.ntfy.topic) this.settings.ntfy.enabled = false;
    if (settingsReadable) await this.persist().catch((error) => this.recordStorageIssue("settings_write", error));

    try {
      const savedIngress = await this.ingress();
      await this.writeIngress(savedIngress);
    } catch (error) {
      if (!this.storageIssues.some((item) => item.scope.startsWith("ingress_"))) {
        this.recordStorageIssue("ingress_read", error);
      }
    }

    try {
      const savedOutbox = await readJson(this.outboxPath, []);
      if (!Array.isArray(savedOutbox)) this.recordStorageIssue("outbox_shape", { code: "invalid_shape" });
      else await this.writeOutbox(savedOutbox);
    } catch (error) {
      if (!this.storageIssues.some((item) => item.scope.startsWith("outbox_"))) this.recordStorageIssue("outbox_read", error);
    }
    try {
      const savedBlockers = await readJson(this.blockerPath, []);
      if (!Array.isArray(savedBlockers)) this.recordStorageIssue("blockers_shape", { code: "invalid_shape" });
      else await this.writeBlockers(savedBlockers);
    } catch (error) {
      if (!this.storageIssues.some((item) => item.scope.startsWith("blockers_"))) this.recordStorageIssue("blockers_read", error);
    }

    let savedHealth = {};
    try {
      savedHealth = await readJson(this.deliveryHealthPath, {});
      if (!savedHealth || typeof savedHealth !== "object" || Array.isArray(savedHealth)) throw Object.assign(new Error("invalid_shape"), { code: "invalid_shape" });
    } catch (error) {
      this.deliveryHealthWritable = false;
      this.recordStorageIssue("delivery_health_read", error);
      savedHealth = {};
    }
    const savedClawbotHealth = savedHealth?.clawbot && typeof savedHealth.clawbot === "object" ? savedHealth.clawbot : {};
    const savedNtfyHealth = savedHealth?.ntfy && typeof savedHealth.ntfy === "object" ? savedHealth.ntfy : {};
    this.deliveryHealth = {
      clawbot: {
        ...this.deliveryHealth.clawbot,
        ...savedClawbotHealth,
      },
      ntfy: {
        ...this.deliveryHealth.ntfy,
        ...savedNtfyHealth,
      },
    };
    let savedDeliveries = [];
    try { savedDeliveries = await this.deliveries(200); }
    catch (error) { this.recordStorageIssue("deliveries_read", error); }
    if (!this.deliveryHealth.clawbot.lastSuccessAt && !this.deliveryHealth.clawbot.lastFailureAt) {
      const lastClawbotDelivery = savedDeliveries.find((item) => item?.channel === "clawbot" || item?.channel === "clawbot_media");
      if (lastClawbotDelivery?.status === "accepted") {
        this.deliveryHealth.clawbot.deliveryState = "ready";
        this.deliveryHealth.clawbot.lastSuccessAt = lastClawbotDelivery.createdAt || null;
      } else if (lastClawbotDelivery) {
        const errorCode = lastClawbotDelivery.errorCode || deliveryErrorCode(lastClawbotDelivery.error);
        this.deliveryHealth.clawbot.deliveryState = errorCode;
        this.deliveryHealth.clawbot.lastFailureAt = lastClawbotDelivery.createdAt || null;
        this.deliveryHealth.clawbot.lastError = safeDeliveryError(lastClawbotDelivery.error);
        if (errorCode === "session_refresh_required" && lastClawbotDelivery.createdAt) {
          this.deliveryHealth.clawbot.cooldownUntil = new Date(asDate(lastClawbotDelivery.createdAt).getTime() + this.sessionRetryDelaysMs[0]).toISOString();
          this.deliveryHealth.clawbot.sessionFailureStage = 1;
        }
      }
    }
    if (!this.deliveryHealth.ntfy.lastSuccessAt && !this.deliveryHealth.ntfy.lastFailureAt) {
      const lastNtfyDelivery = savedDeliveries.find((item) => item?.channel === "ntfy");
      if (lastNtfyDelivery?.status === "accepted") {
        this.deliveryHealth.ntfy.deliveryState = "ready";
        this.deliveryHealth.ntfy.lastSuccessAt = lastNtfyDelivery.createdAt || null;
      } else if (lastNtfyDelivery && lastNtfyDelivery.status !== "not_configured") {
        this.deliveryHealth.ntfy.deliveryState = lastNtfyDelivery.errorCode || deliveryErrorCode(lastNtfyDelivery.error);
        this.deliveryHealth.ntfy.lastFailureAt = lastNtfyDelivery.createdAt || null;
        this.deliveryHealth.ntfy.lastError = safeDeliveryError(lastNtfyDelivery.error);
      }
    }
    await this.persistDeliveryHealth().catch((error) => this.recordStorageIssue("delivery_health_write", error));
  }

  start() {
    if (this.timer) return;
    const run = () => {
      void this.tick().then(() => {
        this.schedulerHealth = { state: "ready", lastSuccessAt: asDate(this.now()).toISOString(), lastFailureAt: this.schedulerHealth.lastFailureAt, lastError: null };
      }).catch((error) => {
        this.schedulerHealth = { state: "failed", lastSuccessAt: this.schedulerHealth.lastSuccessAt, lastFailureAt: asDate(this.now()).toISOString(), lastError: safeDeliveryError(error) };
      });
    };
    this.timer = setInterval(run, 30_000);
    this.timer.unref?.();
    run();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    return this.flush();
  }

  async flush() {
    // Capture work added by promise continuations while an earlier snapshot is
    // settling. A crash is still covered by the ingress WAL; this loop makes a
    // normal shutdown wait for all work that was already accepted in memory.
    while (true) {
      const ingress = this.ingressMutation;
      const send = this.sendMutation;
      const delivery = this.deliveryMutation;
      await Promise.all([ingress, send, delivery]);
      if (ingress === this.ingressMutation && send === this.sendMutation && delivery === this.deliveryMutation) return;
    }
  }

  async publicState() {
    let deliveries = [];
    let ingressItems = [];
    let outbox = [];
    let blockerItems = [];
    try { deliveries = await this.deliveries(50); }
    catch (error) { this.recordStorageIssue("deliveries_read", error); }
    try { ingressItems = await this.ingress(); }
    catch (error) { this.recordStorageIssue("ingress_read", error); }
    try { outbox = await this.outbox(); }
    catch (error) { this.recordStorageIssue("outbox_read", error); }
    try { blockerItems = await this.blockers(); }
    catch (error) { this.recordStorageIssue("blockers_read", error); }
    const clawbot = this.clawbot ? await this.clawbot.status().catch(() => ({ ready: false, pairedCount: 0, reason: "ClawBot 状态不可读" })) : { ready: false, pairedCount: 0, reason: "未配置" };
    const lastClawbotDelivery = deliveries.find((item) => item?.channel === "clawbot" || item?.channel === "clawbot_media") || null;
    const paired = clawbot.paired === true || Number(clawbot.pairedCount) > 0;
    const contextRefreshed = clawbot.contextUpdatedAt
      && this.deliveryHealth.clawbot.lastFailureAt
      && asDate(clawbot.contextUpdatedAt).getTime() > asDate(this.deliveryHealth.clawbot.lastFailureAt).getTime();
    let deliveryState = contextRefreshed && this.deliveryHealth.clawbot.deliveryState === "session_refresh_required"
      ? "unverified"
      : this.deliveryHealth.clawbot.deliveryState;
    if (clawbot.ready !== true) deliveryState = paired ? "transport_unavailable" : "unpaired";
    const clawbotOperational = clawbot.ready && deliveryState === "ready";
    const ntfyConfigured = this.settings.ntfy.enabled && Boolean(this.settings.ntfy.topic);
    const ntfyDeliveryState = ntfyConfigured ? this.deliveryHealth.ntfy.deliveryState : "not_configured";
    const ntfyOperational = ntfyConfigured && ntfyDeliveryState === "ready";
    const criticalStorageIssues = this.storageIssues.filter((item) => CRITICAL_STORAGE_SCOPES.has(item.scope));
    const acceptingNotifications = criticalStorageIssues.length === 0;
    const channelOperational = clawbotOperational || ntfyOperational;
    return {
      settings: {
        ntfy: {
          enabled: this.settings.ntfy.enabled,
          server: this.settings.ntfy.server,
          topic: this.settings.ntfy.topic,
          hasAccessToken: Boolean(this.settings.ntfy.accessToken),
          subscriptionUrl: this.settings.ntfy.topic ? `${this.settings.ntfy.server}/${this.settings.ntfy.topic}` : null,
          configured: ntfyConfigured,
          operational: ntfyOperational,
          deliveryState: ntfyDeliveryState,
          lastSuccessAt: this.deliveryHealth.ntfy.lastSuccessAt || null,
          lastFailureAt: this.deliveryHealth.ntfy.lastFailureAt || null,
          lastError: this.deliveryHealth.ntfy.lastError || null,
        },
        schedules: this.settings.schedules,
        events: this.settings.events,
      },
      clawbot: {
        ...clawbot,
        paired,
        transportReady: clawbot.ready === true,
        ready: clawbotOperational,
        operational: clawbotOperational,
        deliveryState,
        cooldownUntil: this.deliveryHealth.clawbot.cooldownUntil || null,
        reason: deliveryState === "session_refresh_required"
          ? "配对仍在，但微信会话需由用户发一条新消息刷新后才能主动推送"
          : deliveryState === "unverified" && paired
            ? "配对资料存在，最近真实投递尚未验证"
            : clawbot.reason,
        lastDelivery: lastClawbotDelivery ? {
          channel: lastClawbotDelivery.channel,
          status: lastClawbotDelivery.status,
          createdAt: lastClawbotDelivery.createdAt,
          error: lastClawbotDelivery.error || null,
          errorCode: lastClawbotDelivery.errorCode || (lastClawbotDelivery.error ? deliveryErrorCode(lastClawbotDelivery.error) : null),
        } : null,
      },
      ready: channelOperational && acceptingNotifications,
      operational: channelOperational && acceptingNotifications,
      channelOperational,
      acceptingNotifications,
      outbox: {
        pendingCount: outbox.length,
        ingressPendingCount: ingressItems.length,
        nextAttemptAt: outbox.map((item) => item?.nextAttemptAt).filter(Boolean).sort()[0] || null,
      },
      blockers: {
        openCount: blockerItems.filter((item) => item.status === "open").length,
        acknowledgedCount: blockerItems.filter((item) => item.status === "acknowledged").length,
        items: blockerItems
          .filter((item) => item.status !== "resolved")
          .slice(0, 50)
          .map((item) => ({
            id: item.id,
            key: item.key,
            kind: item.kind,
            title: item.title,
            status: item.status,
            acceptedCount: item.acceptedCount || 0,
            lastAcceptedAt: item.lastAcceptedAt || null,
            nextReminderAt: item.nextReminderAt || null,
            acknowledgedAt: item.acknowledgedAt || null,
            createdAt: item.createdAt,
            updatedAt: item.updatedAt,
          })),
      },
      scheduler: this.schedulerHealth,
      storage: {
        degraded: this.storageIssues.length > 0,
        criticalDegraded: criticalStorageIssues.length > 0,
        acceptingNotifications,
        issues: this.storageIssues,
      },
      deliveries,
    };
  }

  async update(patch = {}) {
    const previousNtfyFingerprint = `${this.settings.ntfy.server}\u0000${this.settings.ntfy.topic}\u0000${this.settings.ntfy.accessToken}`;
    const incomingNtfy = patch.ntfy || {};
    this.settings.ntfy = {
      enabled: incomingNtfy.enabled === undefined ? this.settings.ntfy.enabled : incomingNtfy.enabled === true,
      server: incomingNtfy.server === undefined ? this.settings.ntfy.server : cleanServer(incomingNtfy.server),
      topic: incomingNtfy.topic === undefined ? this.settings.ntfy.topic : cleanTopic(incomingNtfy.topic),
      accessToken: incomingNtfy.accessToken === undefined || incomingNtfy.accessToken === "" ? this.settings.ntfy.accessToken : String(incomingNtfy.accessToken).trim().slice(0, 500),
    };
    for (const kind of ["learning", "ingest"]) {
      const incoming = patch.schedules?.[kind];
      if (!incoming) continue;
      this.settings.schedules[kind] = {
        ...this.settings.schedules[kind],
        enabled: incoming.enabled === undefined ? this.settings.schedules[kind].enabled : incoming.enabled === true,
        time: validTime(incoming.time, this.settings.schedules[kind].time),
      };
    }
    if (patch.events) {
      if (patch.events.creative !== undefined) this.settings.events.creative = patch.events.creative === true;
      if (patch.events.publishFailure !== undefined) this.settings.events.publishFailure = patch.events.publishFailure === true;
      if (patch.events.downloadFailure !== undefined) this.settings.events.downloadFailure = patch.events.downloadFailure === true;
      if (patch.events.filehelperOffline !== undefined) this.settings.events.filehelperOffline = patch.events.filehelperOffline === true;
    }
    if (!this.settings.ntfy.topic) this.settings.ntfy.enabled = false;
    await this.persist();
    const nextNtfyFingerprint = `${this.settings.ntfy.server}\u0000${this.settings.ntfy.topic}\u0000${this.settings.ntfy.accessToken}`;
    if (previousNtfyFingerprint !== nextNtfyFingerprint) {
      this.deliveryHealth.ntfy = { deliveryState: "unverified", lastSuccessAt: null, lastFailureAt: null, lastError: null };
      await this.persistDeliveryHealth().catch((error) => this.recordStorageIssue("delivery_health_write", error));
    }
    const disabledKinds = [];
    if (patch.events?.creative === false) disabledKinds.push("creative_failed");
    if (patch.events?.publishFailure === false) disabledKinds.push("publish_failed");
    if (patch.events?.downloadFailure === false) disabledKinds.push("download_failed");
    if (patch.events?.filehelperOffline === false) disabledKinds.push("filehelper_offline");
    if (disabledKinds.length) await this.acknowledgeBlockers({ kinds: disabledKinds, reason: "notifications_disabled" });
    return this.publicState();
  }

  async createSubscription() {
    this.settings.ntfy.topic = `zhitai-${randomBytes(18).toString("base64url")}`;
    this.settings.ntfy.enabled = true;
    await this.persist();
    this.deliveryHealth.ntfy = { deliveryState: "unverified", lastSuccessAt: null, lastFailureAt: null, lastError: null };
    await this.persistDeliveryHealth().catch((error) => this.recordStorageIssue("delivery_health_write", error));
    return this.publicState();
  }

  async test() {
    return this.send("织台手机通知测试", "测试成功：以后每日学习、入库摘要和重要失败会从这里提醒。", "test");
  }

  async notifyEvent(type, message) {
    if (type === "CREATIVE_READY" && this.settings.events.creative) return this.send("织台 · 生成准备完成", message, "creative");
    if (type === "CREATIVE_PREPARE" && this.settings.events.creative) return this.send("织台 · 生成任务异常", message, "creative_failed");
    if (type === "PUBLISH" && this.settings.events.publishFailure) {
      if (/失败|需处理|异常/.test(message)) return this.send("织台 · 发布需处理", message, "publish_failed");
      return null;
    }
    if (type === "FILEHELPER_LOGIN" && this.settings.events.filehelperOffline) return this.send("织台 · 文件传输助手需处理", message, "filehelper_offline");
    if (type === "FILEHELPER_RECOVERED") {
      await this.resolveBlockersByKind(["filehelper_offline"], "filehelper_recovered");
      return this.settings.events.filehelperOffline
        ? this.send("织台 · 下载入口已恢复", message, "filehelper_recovered")
        : null;
    }
    if (["INGEST", "KUAIDIAN", "KUAIDIAN_INGEST", "KB_INDEX", "DOWNLOAD_TIMEOUT"].includes(type)
      && this.settings.events.downloadFailure && /失败|超时|未更新|需处理|等待媒体回退/.test(message)) {
      return this.send("织台 · 视频下载需处理", message, "download_failed");
    }
    return null;
  }

  async tick(now = this.now()) {
    if (this.tickPromise) return this.tickPromise;
    const operation = this.runTick(asDate(now)).finally(() => {
      if (this.tickPromise === operation) this.tickPromise = null;
    });
    this.tickPromise = operation;
    return operation;
  }

  async runTick(now) {
    await this.drainIngress();
    const retried = await this.drainOutbox(now);
    let settingsChanged = false;
    for (const result of retried) {
      if (!result.ok || !result.scheduleDate) continue;
      const kind = String(result.kind || "").replace(/^daily_/, "");
      if (!this.settings.schedules[kind]) continue;
      this.settings.schedules[kind].lastRunDate = result.scheduleDate;
      settingsChanged = true;
    }
    if (settingsChanged) await this.persist();

    const clawbotReady = this.clawbot ? (await this.clawbot.status().catch(() => ({ ready: false }))).ready : false;
    if (!clawbotReady && (!this.settings.ntfy.enabled || !this.settings.ntfy.topic)) return retried;
    const date = localDateKey(now);
    const currentTime = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
    for (const kind of ["learning", "ingest"]) {
      const schedule = this.settings.schedules[kind];
      if (!schedule.enabled || schedule.lastRunDate === date || currentTime < schedule.time) continue;
      const dailyDedupeKey = `daily:${kind}:${date}`;
      if ((await this.outbox()).some((item) => item?.dedupeKey === dailyDedupeKey)) continue;
      const text = await this.buildDigest(kind);
      const result = await this.send(
        kind === "learning" ? "织台 · 每日学习" : "织台 · 入库摘要",
        text,
        `daily_${kind}`,
        { dedupeKey: dailyDedupeKey, scheduleDate: date },
      );
      if (result.ok) {
        schedule.lastRunDate = date;
        await this.persist();
      }
    }
    return retried;
  }

  async send(title, message, kind = "notification", options = {}) {
    // Persist the caller's intent before waiting behind a slow external
    // delivery. This small ingress WAL closes the crash window where a second
    // fire-and-forget event used to exist only in the in-memory send chain.
    const ingress = await this.appendIngress(title, message, kind, options);
    const operation = this.sendMutation.then(() => this.processIngress(ingress.id));
    this.sendMutation = operation.catch(() => {});
    return operation;
  }

  async appendIngress(title, message, kind, options = {}) {
    const item = {
      id: `in_${randomUUID()}`,
      title: String(title || "织台通知").slice(0, 180),
      message: String(message || "").slice(0, 3_000),
      kind: String(kind || "notification").slice(0, 100),
      options: {
        dedupeKey: options?.dedupeKey == null ? null : String(options.dedupeKey).slice(0, 160),
        scheduleDate: options?.scheduleDate == null ? null : String(options.scheduleDate).slice(0, 40),
        blockerId: options?.blockerId == null ? null : String(options.blockerId).slice(0, 160),
        blockerKey: options?.blockerKey == null ? null : String(options.blockerKey).slice(0, 160),
        blockerReminderStage: options?.blockerReminderStage == null ? null : Math.max(0, Number(options.blockerReminderStage) || 0),
        trackBlocker: options?.trackBlocker === false ? false : true,
      },
      createdAt: asDate(this.now()).toISOString(),
    };
    const operation = this.ingressMutation.then(async () => {
      const items = await this.ingress();
      items.push(item);
      await this.writeIngress(items);
      return item;
    });
    this.ingressMutation = operation.catch(() => {});
    return operation;
  }

  async removeIngress(id) {
    const operation = this.ingressMutation.then(async () => {
      const items = await this.ingress();
      const remaining = items.filter((item) => item?.id !== id);
      if (remaining.length !== items.length) await this.writeIngress(remaining);
    });
    this.ingressMutation = operation.catch(() => {});
    return operation;
  }

  async processIngress(id) {
    const item = (await this.ingress()).find((candidate) => candidate?.id === id);
    if (!item) return { ok: true, deduplicated: true, ingressId: id };
    // If a crash happened after the delivery ledger was committed but before
    // this WAL row was removed, reconcile by the durable ingress id. Unlike the
    // ordinary content dedupe window, this identity never expires.
    const accepted = (await this.deliveries(500)).find((delivery) => delivery?.ingressId === id && delivery?.status === "accepted");
    if (accepted) {
      await this.removeIngress(id);
      return {
        ok: true,
        accepted: false,
        previouslyAccepted: true,
        reconciled: true,
        ingressId: id,
        channel: accepted.channel,
        lastAcceptedAt: accepted.createdAt || null,
      };
    }
    let released = false;
    const releaseIngress = async () => {
      if (released) return;
      await this.removeIngress(id);
      released = true;
    };
    const result = await this.enqueueAndAttempt(item.title, item.message, item.kind, {
      ...(item.options || {}),
      ingressId: id,
      onDurable: releaseIngress,
    });
    await releaseIngress();
    return { ...result, ingressId: id };
  }

  async drainIngress() {
    const operation = this.sendMutation.then(async () => {
      const items = await this.ingress();
      const results = [];
      for (const item of items) results.push(await this.processIngress(item.id));
      return results;
    });
    this.sendMutation = operation.catch(() => {});
    return operation;
  }

  async enqueueAndAttempt(title, message, kind, options) {
    const recoveryKinds = RECOVERY_KIND_MAP.get(String(kind || ""));
    if (recoveryKinds?.length) await this.closeBlockersNow({ kinds: recoveryKinds, status: "resolved", reason: String(kind) });
    if (BLOCKER_KINDS.has(String(kind || "")) && options?.trackBlocker !== false) {
      return this.enqueueBlockerAndAttempt(title, message, kind, options);
    }
    return this.enqueueTechnicalAndAttempt(title, message, kind, options);
  }

  async enqueueTechnicalAndAttempt(title, message, kind, options = {}) {
    const now = asDate(this.now());
    const createdAt = now.toISOString();
    const dedupeKey = String(options?.dedupeKey || notificationKey(kind, title, message)).slice(0, 160);
    const recent = await this.deliveries(200);
    const accepted = this.dedupeWindowMs > 0 ? recent.find((item) => {
      const ageMs = now.getTime() - asDate(item?.createdAt, new Date(0)).getTime();
      return item?.status === "accepted" && item?.dedupeKey === dedupeKey && ageMs >= 0 && ageMs <= this.dedupeWindowMs;
    }) : null;
    if (accepted) {
      await options?.onDurable?.();
      return { ok: true, accepted: false, previouslyAccepted: true, lastAcceptedAt: accepted.createdAt, deduplicated: true, kind, channel: accepted.channel, status: "suppressed" };
    }

    const outbox = await this.outbox();
    const existing = outbox.find((item) => item?.dedupeKey === dedupeKey);
    if (existing) {
      await options?.onDurable?.();
      if (asDate(existing.nextAttemptAt, now).getTime() <= now.getTime()) return this.attemptEnvelope(existing.id, now);
      return {
        ok: false,
        queued: true,
        deduplicated: true,
        kind: existing.kind,
        outboxId: existing.id,
        attempts: existing.attempts || 0,
        retryAt: existing.nextAttemptAt,
        error: existing.lastError || "notification_pending_retry",
        errorCode: existing.lastErrorCode || null,
        blockerId: existing.blockerId || null,
        accepted: false,
        acknowledged: false,
        resolved: false,
      };
    }

    const envelope = {
      id: `out_${randomUUID()}`,
      dedupeKey,
      kind: String(kind || "notification").slice(0, 100),
      title: String(title || "织台通知").slice(0, 180),
      message: String(message || "").slice(0, 3_000),
      createdAt,
      updatedAt: createdAt,
      attempts: 0,
      nextAttemptAt: createdAt,
      lastError: null,
      lastErrorCode: null,
      scheduleDate: options?.scheduleDate || null,
      blockerId: options?.blockerId || null,
      blockerReminderStage: options?.blockerReminderStage ?? null,
      ingressId: options?.ingressId || null,
    };
    outbox.push(envelope);
    await this.writeOutbox(outbox);
    await options?.onDurable?.();
    return this.attemptEnvelope(envelope.id, now);
  }

  async enqueueBlockerAndAttempt(title, message, kind, options = {}) {
    const now = asDate(this.now());
    const key = String(options?.blockerKey || blockerKey(kind)).slice(0, 160);
    const blockers = await this.blockers();
    let blocker = blockers.find((item) => item?.key === key && item?.status !== "resolved");
    if (blocker) {
      blocker.title = String(title || blocker.title || "织台通知").slice(0, 180);
      blocker.message = String(message || blocker.message || "").slice(0, 3_000);
      blocker.updatedAt = now.toISOString();
      await this.writeBlockers(blockers);
      if (blocker.status === "acknowledged") {
        await options?.onDurable?.();
        return {
          ok: Boolean(blocker.lastAcceptedAt),
          accepted: false,
          previouslyAccepted: Boolean(blocker.lastAcceptedAt),
          lastAcceptedAt: blocker.lastAcceptedAt || null,
          acknowledged: true,
          resolved: false,
          suppressed: true,
          blockerId: blocker.id,
          kind: blocker.kind,
        };
      }
      const pending = (await this.outbox()).find((item) => item?.blockerId === blocker.id);
      if (pending) {
        await options?.onDurable?.();
        if (asDate(pending.nextAttemptAt, now).getTime() <= now.getTime()) return this.attemptEnvelope(pending.id, now);
        return {
          ok: false,
          accepted: false,
          acknowledged: false,
          resolved: false,
          queued: true,
          suppressed: true,
          blockerId: blocker.id,
          outboxId: pending.id,
          retryAt: pending.nextAttemptAt,
          errorCode: pending.lastErrorCode || null,
        };
      }
      if (blocker.nextReminderAt && asDate(blocker.nextReminderAt, now).getTime() > now.getTime()) {
        await options?.onDurable?.();
        return {
          ok: Boolean(blocker.lastAcceptedAt),
          accepted: false,
          previouslyAccepted: Boolean(blocker.lastAcceptedAt),
          lastAcceptedAt: blocker.lastAcceptedAt || null,
          acknowledged: false,
          resolved: false,
          suppressed: true,
          blockerId: blocker.id,
          nextReminderAt: blocker.nextReminderAt,
        };
      }
    } else {
      const timestamp = now.toISOString();
      blocker = {
        id: `blk_${randomUUID()}`,
        key,
        kind: String(kind || "notification").slice(0, 100),
        title: String(title || "织台通知").slice(0, 180),
        message: String(message || "").slice(0, 3_000),
        status: "open",
        acceptedCount: 0,
        lastAcceptedAt: null,
        lastAcceptedChannel: null,
        reminderStage: 0,
        nextReminderAt: null,
        acknowledgedAt: null,
        resolvedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      blockers.push(blocker);
      await this.writeBlockers(blockers);
    }

    const stage = Math.max(0, Number(blocker.reminderStage) || 0);
    return this.enqueueTechnicalAndAttempt(blocker.title, blocker.message, blocker.kind, {
      ...options,
      trackBlocker: false,
      blockerId: blocker.id,
      blockerReminderStage: stage,
      dedupeKey: `${blocker.key}:${blocker.id}:${stage}`,
    });
  }

  async materializeDueBlockers(now) {
    const blockers = await this.blockers();
    const outbox = await this.outbox();
    let changed = false;
    for (const blocker of blockers) {
      if (blocker?.status !== "open" || !blocker?.nextReminderAt) continue;
      if (blocker.kind === "creative_failed" && !this.settings.events.creative) continue;
      if (blocker.kind === "publish_failed" && !this.settings.events.publishFailure) continue;
      if (blocker.kind === "download_failed" && !this.settings.events.downloadFailure) continue;
      if (blocker.kind === "filehelper_offline" && !this.settings.events.filehelperOffline) continue;
      if (asDate(blocker.nextReminderAt, new Date(0)).getTime() > now.getTime()) continue;
      if (outbox.some((item) => item?.blockerId === blocker.id)) continue;
      const stage = Math.max(0, Number(blocker.reminderStage) || 0);
      const createdAt = now.toISOString();
      outbox.push({
        id: `out_${randomUUID()}`,
        dedupeKey: `${blocker.key}:${blocker.id}:${stage}`,
        kind: blocker.kind,
        title: blocker.title,
        message: blocker.message,
        createdAt,
        updatedAt: createdAt,
        attempts: 0,
        nextAttemptAt: createdAt,
        lastError: null,
        lastErrorCode: null,
        scheduleDate: null,
        blockerId: blocker.id,
        blockerReminderStage: stage,
      });
      changed = true;
    }
    if (changed) await this.writeOutbox(outbox);
  }

  async updateBlockerAccepted(envelope, result, now) {
    if (!envelope?.blockerId) return null;
    const blockers = await this.blockers();
    const index = blockers.findIndex((item) => item?.id === envelope.blockerId);
    if (index < 0) return null;
    const blocker = blockers[index];
    if (blocker.status !== "open") return blocker;
    const stage = Math.max(0, Number(envelope.blockerReminderStage) || 0);
    const delay = this.blockerReminderDelaysMs[Math.min(stage, this.blockerReminderDelaysMs.length - 1)];
    blockers[index] = {
      ...blocker,
      acceptedCount: Math.max(0, Number(blocker.acceptedCount) || 0) + 1,
      lastAcceptedAt: now.toISOString(),
      lastAcceptedChannel: result.channel || null,
      reminderStage: stage + 1,
      nextReminderAt: new Date(now.getTime() + delay).toISOString(),
      updatedAt: now.toISOString(),
    };
    await this.writeBlockers(blockers);
    return blockers[index];
  }

  async acknowledgeBlockers({ blockerId = null, kinds = null, allOpen = false, reason = "user_reply" } = {}) {
    const operation = this.sendMutation.then(() => this.closeBlockersNow({ blockerId, kinds, allOpen, status: "acknowledged", reason }));
    this.sendMutation = operation.catch(() => {});
    return operation;
  }

  async acknowledgeFromUserReply() {
    const operation = this.sendMutation.then(async () => {
      const result = await this.closeBlockersNow({ allOpen: true, status: "acknowledged", reason: "user_reply" });
      this.deliveryHealth.clawbot = {
        ...this.deliveryHealth.clawbot,
        deliveryState: "unverified",
        sessionFailureStage: 0,
        cooldownUntil: null,
        lastError: null,
      };
      await this.persistDeliveryHealth();
      return result;
    });
    this.sendMutation = operation.catch(() => {});
    return operation;
  }

  async resolveBlockersByKind(kinds, reason = "state_recovered") {
    const operation = this.sendMutation.then(() => this.closeBlockersNow({ kinds, status: "resolved", reason }));
    this.sendMutation = operation.catch(() => {});
    return operation;
  }

  async closeBlockersNow({ blockerId = null, blockerKeys = null, kinds = null, allOpen = false, status, reason }) {
    const kindSet = Array.isArray(kinds) ? new Set(kinds.map(String)) : null;
    const blockerKeySet = Array.isArray(blockerKeys) ? new Set(blockerKeys.map(String)) : null;
    const blockers = await this.blockers();
    const closedIds = new Set();
    const now = asDate(this.now()).toISOString();
    for (let index = 0; index < blockers.length; index += 1) {
      const item = blockers[index];
      if (item?.status === "resolved") continue;
      const matches = (blockerId && item.id === blockerId)
        || (blockerKeySet && blockerKeySet.has(String(item.key)))
        || (kindSet && kindSet.has(String(item.kind)))
        || (allOpen && item.status === "open");
      if (!matches) continue;
      blockers[index] = {
        ...item,
        status,
        nextReminderAt: null,
        acknowledgedAt: status === "acknowledged" ? now : item.acknowledgedAt || null,
        resolvedAt: status === "resolved" ? now : item.resolvedAt || null,
        closeReason: String(reason || status).slice(0, 120),
        updatedAt: now,
      };
      closedIds.add(item.id);
    }
    if (!closedIds.size) return { changed: 0, status };
    const outbox = (await this.outbox()).filter((item) => !closedIds.has(item?.blockerId));
    await this.writeBlockers(blockers);
    await this.writeOutbox(outbox);
    return { changed: closedIds.size, status };
  }

  async drainOutbox(now = this.now()) {
    const operation = this.sendMutation.then(() => this.runOutboxDrain(asDate(now)));
    this.sendMutation = operation.catch(() => {});
    return operation;
  }

  async runOutboxDrain(now) {
    await this.materializeDueBlockers(now);
    const due = (await this.outbox())
      .filter((item) => asDate(item?.nextAttemptAt, new Date(0)).getTime() <= now.getTime())
      .sort((left, right) => asDate(left.nextAttemptAt, new Date(0)) - asDate(right.nextAttemptAt, new Date(0)))
      .slice(0, OUTBOX_DRAIN_LIMIT);
    const results = [];
    for (const envelope of due) results.push(await this.attemptEnvelope(envelope.id, now));
    return results;
  }

  async attemptEnvelope(outboxId, now = asDate(this.now())) {
    const outbox = await this.outbox();
    const index = outbox.findIndex((item) => item?.id === outboxId);
    if (index < 0) return { ok: true, deduplicated: true, outboxId };
    const envelope = outbox[index];
    if (envelope.blockerId) {
      const blocker = (await this.blockers()).find((item) => item?.id === envelope.blockerId);
      const envelopeStage = Math.max(0, Number(envelope.blockerReminderStage) || 0);
      const stale = !blocker || blocker.status !== "open" || Math.max(0, Number(blocker.reminderStage) || 0) > envelopeStage;
      if (stale) {
        outbox.splice(index, 1);
        await this.writeOutbox(outbox);
        return {
          ok: true,
          skipped: true,
          outboxId,
          blockerId: envelope.blockerId,
          accepted: false,
          previouslyAccepted: Boolean(blocker?.lastAcceptedAt),
          lastAcceptedAt: blocker?.lastAcceptedAt || null,
          acknowledged: blocker?.status === "acknowledged",
          resolved: blocker?.status === "resolved",
        };
      }
    }
    const acceptedDelivery = (await this.deliveries(200)).find((item) => item?.outboxId === outboxId && item?.status === "accepted");
    if (acceptedDelivery) {
      const blocker = await this.updateBlockerAccepted(envelope, acceptedDelivery, asDate(acceptedDelivery.createdAt, now));
      outbox.splice(index, 1);
      await this.writeOutbox(outbox);
      return {
        ok: true,
        accepted: false,
        previouslyAccepted: true,
        reconciled: true,
        outboxId,
        kind: envelope.kind,
        channel: acceptedDelivery.channel,
        lastAcceptedAt: acceptedDelivery.createdAt,
        scheduleDate: envelope.scheduleDate || null,
        blockerId: blocker?.id || envelope.blockerId || null,
        acknowledged: blocker?.status === "acknowledged",
        resolved: blocker?.status === "resolved",
        nextReminderAt: blocker?.nextReminderAt || null,
      };
    }
    const attempt = Math.max(0, Number(envelope.attempts) || 0) + 1;
    const result = await this.deliverNow(envelope, attempt, now);
    if (result.ok) {
      const blocker = await this.updateBlockerAccepted(envelope, result, now);
      outbox.splice(index, 1);
      await this.writeOutbox(outbox);
      return {
        ...result,
        queued: false,
        outboxId,
        scheduleDate: envelope.scheduleDate || null,
        blockerId: blocker?.id || envelope.blockerId || null,
        accepted: true,
        acknowledged: blocker?.status === "acknowledged",
        resolved: blocker?.status === "resolved",
        nextReminderAt: blocker?.nextReminderAt || null,
      };
    }

    const errorCode = result.errorCode || deliveryErrorCode(result.error);
    const delays = requiresSlowRetry(errorCode) ? this.sessionRetryDelaysMs : this.retryDelaysMs;
    const retryDelay = delays[Math.min(attempt - 1, delays.length - 1)];
    const retryAt = new Date(now.getTime() + retryDelay).toISOString();
    outbox[index] = {
      ...envelope,
      attempts: attempt,
      updatedAt: now.toISOString(),
      nextAttemptAt: retryAt,
      lastError: safeDeliveryError(result.error),
      lastErrorCode: errorCode,
    };
    await this.writeOutbox(outbox);
    return {
      ...result,
      errorCode,
      queued: true,
      outboxId,
      attempts: attempt,
      retryAt,
      scheduleDate: envelope.scheduleDate || null,
      blockerId: envelope.blockerId || null,
      accepted: false,
      acknowledged: false,
      resolved: false,
    };
  }

  async deliverNow(envelope, attempt, now) {
    const createdAt = now.toISOString();
    const shared = {
      kind: envelope.kind,
      title: envelope.title,
      message: envelope.message,
      outboxId: envelope.id,
      dedupeKey: envelope.dedupeKey,
      attempt,
      createdAt,
      requiresAcknowledgement: Boolean(envelope.blockerId),
      blockerId: envelope.blockerId || null,
      ingressId: envelope.ingressId || null,
      acknowledged: false,
      resolved: false,
    };
    const failures = [];
    if (this.clawbot) {
      let item;
      const availability = await this.clawbotAttemptAvailability(now);
      if (!availability.allowed) {
        item = {
          id: `ntf_${randomUUID()}`,
          ...shared,
          channel: "clawbot",
          status: "cooldown",
          accepted: false,
          error: "session_refresh_required",
          errorCode: "session_refresh_required",
        };
      } else {
        try {
          const result = await this.clawbot.send(envelope.title, envelope.message);
          const error = result.ok ? null : safeDeliveryError(result.error, "ClawBot 发送失败");
          item = {
            id: `ntf_${randomUUID()}`,
            ...shared,
            channel: "clawbot",
            status: result.ok ? "accepted" : "failed",
            accepted: result.ok === true,
            error,
            errorCode: error ? deliveryErrorCode(error) : null,
          };
        } catch (error) {
          const safeError = safeDeliveryError(error);
          item = { id: `ntf_${randomUUID()}`, ...shared, channel: "clawbot", status: "failed", accepted: false, error: safeError, errorCode: deliveryErrorCode(safeError) };
        }
        await this.updateClawbotDeliveryHealth(item, availability.contextUpdatedAt, now);
      }
      await this.record(item);
      if (item.status === "accepted") return { ok: true, ...item };
      failures.push({ channel: "clawbot", error: item.error, errorCode: item.errorCode || deliveryErrorCode(item.error) });
    }

    if (!this.settings.ntfy.enabled || !this.settings.ntfy.topic) {
      const item = { id: `ntf_${randomUUID()}`, ...shared, channel: "ntfy", status: "not_configured", accepted: false, error: "手机推送尚未绑定", errorCode: "not_configured" };
      await this.record(item);
      failures.push({ channel: "ntfy", error: item.error, errorCode: item.errorCode });
      const errorCode = preferredFailureCode(failures, item.errorCode);
      return { ok: false, ...item, error: failures.map((failure) => `${failure.channel}:${failure.error}`).join("; ").slice(0, 180), errorCode };
    }

    const endpoint = `${this.settings.ntfy.server}/${encodeURIComponent(this.settings.ntfy.topic)}`;
    // Fetch request headers must be ByteString. ntfy accepts URL-encoded UTF-8
    // values, so Chinese notification titles need encoding before assignment.
    const headers = {
      "Content-Type": "text/plain; charset=utf-8",
      Title: encodeURIComponent(envelope.title),
      Tags: "memo",
    };
    if (this.settings.ntfy.accessToken) headers.Authorization = `Bearer ${this.settings.ntfy.accessToken}`;
    let item;
    try {
      const response = await fetch(endpoint, { method: "POST", headers, body: envelope.message, signal: AbortSignal.timeout(10_000) });
      item = {
        id: `ntf_${randomUUID()}`,
        ...shared,
        channel: "ntfy",
        status: response.ok ? "accepted" : "failed",
        accepted: response.ok,
        error: response.ok ? null : `HTTP ${response.status}`,
        errorCode: response.ok ? null : deliveryErrorCode(`HTTP ${response.status}`),
      };
    } catch (error) {
      const safeError = safeDeliveryError(error);
      item = { id: `ntf_${randomUUID()}`, ...shared, channel: "ntfy", status: "failed", accepted: false, error: safeError, errorCode: deliveryErrorCode(safeError) };
    }
    await this.updateNtfyDeliveryHealth(item, now);
    await this.record(item);
    if (item.status === "accepted") return { ok: true, ...item };
    failures.push({ channel: "ntfy", error: item.error, errorCode: item.errorCode });
    const errorCode = preferredFailureCode(failures, item.errorCode);
    return { ok: false, ...item, error: failures.map((failure) => `${failure.channel}:${failure.error}`).join("; ").slice(0, 180), errorCode };
  }

  async sendMedia(title, message, filePath, kind = "creative_review") {
    const operation = this.sendMutation.then(() => this.deliverMediaNow(title, message, filePath, kind));
    this.sendMutation = operation.catch(() => {});
    return operation;
  }

  async deliverMediaNow(title, message, filePath, kind) {
    const now = asDate(this.now());
    const createdAt = now.toISOString();
    if (!this.clawbot || typeof this.clawbot.sendMedia !== "function") return { ok: false, error: "clawbot_media_unavailable" };
    const availability = await this.clawbotAttemptAvailability(now);
    if (!availability.allowed) {
      const item = { id: `ntf_${randomUUID()}`, kind, title, message, channel: "clawbot_media", status: "cooldown", accepted: false, createdAt, error: "session_refresh_required", errorCode: "session_refresh_required" };
      await this.record(item);
      return { ok: false, ...item };
    }
    try {
      const result = await this.clawbot.sendMedia(title, message, filePath);
      const error = result.ok ? null : safeDeliveryError(result.error, "ClawBot 视频发送失败");
      const item = { id: `ntf_${randomUUID()}`, kind, title, message, channel: "clawbot_media", status: result.ok ? "accepted" : "failed", accepted: result.ok === true, createdAt, error, errorCode: error ? deliveryErrorCode(error) : null };
      await this.updateClawbotDeliveryHealth(item, availability.contextUpdatedAt, now);
      await this.record(item);
      return { ok: result.ok === true, ...item };
    } catch (error) {
      const safeError = safeDeliveryError(error);
      const item = { id: `ntf_${randomUUID()}`, kind, title, message, channel: "clawbot_media", status: "failed", accepted: false, createdAt, error: safeError, errorCode: deliveryErrorCode(safeError) };
      await this.updateClawbotDeliveryHealth(item, availability.contextUpdatedAt, now);
      await this.record(item);
      return { ok: false, ...item };
    }
  }

  async deliveries(limit = 50) {
    try {
      const items = await readJson(this.deliveryPath, []);
      if (!Array.isArray(items)) {
        this.recordStorageIssue("deliveries_shape", { code: "invalid_shape" });
        throw Object.assign(new Error("notification_deliveries_invalid_shape"), { code: "invalid_shape" });
      }
      this.clearStorageIssues("deliveries_read", "deliveries_shape");
      return items.slice(0, Math.max(1, Math.min(500, Number(limit) || 50)));
    } catch (error) {
      if (!this.storageIssues.some((item) => item.scope === "deliveries_shape")) this.recordStorageIssue("deliveries_read", error);
      throw error;
    }
  }

  async ingress() {
    try {
      const items = await readJson(this.ingressPath, []);
      if (!Array.isArray(items)) {
        this.recordStorageIssue("ingress_shape", { code: "invalid_shape" });
        throw Object.assign(new Error("notification_ingress_invalid_shape"), { code: "invalid_shape" });
      }
      this.clearStorageIssues("ingress_read", "ingress_shape");
      return items;
    } catch (error) {
      if (!this.storageIssues.some((item) => item.scope === "ingress_shape")) this.recordStorageIssue("ingress_read", error);
      throw error;
    }
  }

  async outbox() {
    try {
      const items = await readJson(this.outboxPath, []);
      if (!Array.isArray(items)) {
        this.recordStorageIssue("outbox_shape", { code: "invalid_shape" });
        throw Object.assign(new Error("notification_outbox_invalid_shape"), { code: "invalid_shape" });
      }
      this.clearStorageIssues("outbox_read", "outbox_shape");
      return items;
    } catch (error) {
      if (!this.storageIssues.some((item) => item.scope === "outbox_shape")) this.recordStorageIssue("outbox_read", error);
      throw error;
    }
  }

  async blockers() {
    try {
      const items = await readJson(this.blockerPath, []);
      if (!Array.isArray(items)) {
        this.recordStorageIssue("blockers_shape", { code: "invalid_shape" });
        throw Object.assign(new Error("notification_blockers_invalid_shape"), { code: "invalid_shape" });
      }
      this.clearStorageIssues("blockers_read", "blockers_shape");
      return items;
    } catch (error) {
      if (!this.storageIssues.some((item) => item.scope === "blockers_shape")) this.recordStorageIssue("blockers_read", error);
      throw error;
    }
  }

  async writeIngress(items) {
    try {
      await writeJsonAtomic(this.ingressPath, items);
      this.clearStorageIssues("ingress_write");
    } catch (error) {
      this.recordStorageIssue("ingress_write", error);
      throw error;
    }
  }

  async writeOutbox(items) {
    try {
      await writeJsonAtomic(this.outboxPath, items);
      this.clearStorageIssues("outbox_write");
    } catch (error) {
      this.recordStorageIssue("outbox_write", error);
      throw error;
    }
  }

  async writeBlockers(items) {
    try {
      await writeJsonAtomic(this.blockerPath, items);
      this.clearStorageIssues("blockers_write");
    } catch (error) {
      this.recordStorageIssue("blockers_write", error);
      throw error;
    }
  }

  async writeDeliveries(items) {
    try {
      await writeJsonAtomic(this.deliveryPath, items);
      this.clearStorageIssues("deliveries_write");
    } catch (error) {
      this.recordStorageIssue("deliveries_write", error);
      throw error;
    }
  }

  async clawbotAttemptAvailability(now) {
    const status = await this.clawbot.status().catch(() => ({ ready: false, contextUpdatedAt: null }));
    const contextUpdatedAt = status?.contextUpdatedAt || null;
    const lastFailureAt = this.deliveryHealth.clawbot.lastFailureAt;
    if (contextUpdatedAt && lastFailureAt && asDate(contextUpdatedAt).getTime() > asDate(lastFailureAt).getTime()) {
      this.deliveryHealth.clawbot = {
        ...this.deliveryHealth.clawbot,
        deliveryState: "unverified",
        sessionFailureStage: 0,
        cooldownUntil: null,
        lastError: null,
        contextUpdatedAt,
      };
      await this.persistDeliveryHealth();
    }
    const cooldownUntil = this.deliveryHealth.clawbot.cooldownUntil;
    const blocked = this.deliveryHealth.clawbot.deliveryState === "session_refresh_required"
      && cooldownUntil
      && asDate(cooldownUntil).getTime() > now.getTime();
    return { allowed: !blocked, contextUpdatedAt };
  }

  async updateClawbotDeliveryHealth(item, contextUpdatedAt, now) {
    if (item.status === "accepted") {
      this.deliveryHealth.clawbot = {
        ...this.deliveryHealth.clawbot,
        deliveryState: "ready",
        sessionFailureStage: 0,
        lastSuccessAt: now.toISOString(),
        lastError: null,
        cooldownUntil: null,
        contextUpdatedAt: contextUpdatedAt || this.deliveryHealth.clawbot.contextUpdatedAt || null,
      };
    } else {
      const errorCode = item.errorCode || deliveryErrorCode(item.error);
      const sessionFailureStage = Math.max(0, Number(this.deliveryHealth.clawbot.sessionFailureStage) || 0);
      const sessionDelay = this.sessionRetryDelaysMs[Math.min(sessionFailureStage, this.sessionRetryDelaysMs.length - 1)];
      this.deliveryHealth.clawbot = {
        ...this.deliveryHealth.clawbot,
        deliveryState: errorCode,
        sessionFailureStage: errorCode === "session_refresh_required" ? sessionFailureStage + 1 : sessionFailureStage,
        lastFailureAt: now.toISOString(),
        lastError: safeDeliveryError(item.error),
        cooldownUntil: errorCode === "session_refresh_required"
          ? new Date(now.getTime() + sessionDelay).toISOString()
          : null,
        contextUpdatedAt: contextUpdatedAt || this.deliveryHealth.clawbot.contextUpdatedAt || null,
      };
    }
    await this.persistDeliveryHealth();
    // 这条 blocker 只代表 ClawBot 主动会话失效。一次新的真实 accepted 已经
    // 证明会话恢复，应自动闭环；不能继续按 2h/8h/每日误提醒用户刷新。
    // 其它业务 blocker 仍保留，必须等待用户确认或各自的状态恢复条件。
    if (item.status === "accepted") {
      await this.closeBlockersNow({
        blockerKeys: ["blocker:clawbot-session-refresh"],
        status: "resolved",
        reason: "clawbot_delivery_recovered",
      });
    }
  }

  async updateNtfyDeliveryHealth(item, now) {
    this.deliveryHealth.ntfy = item.status === "accepted"
      ? { deliveryState: "ready", lastSuccessAt: now.toISOString(), lastFailureAt: this.deliveryHealth.ntfy.lastFailureAt, lastError: null }
      : { deliveryState: item.errorCode || deliveryErrorCode(item.error), lastSuccessAt: this.deliveryHealth.ntfy.lastSuccessAt, lastFailureAt: now.toISOString(), lastError: safeDeliveryError(item.error) };
    await this.persistDeliveryHealth();
  }

  async persistDeliveryHealth() {
    if (!this.deliveryHealthWritable) return;
    try { await writeJsonAtomic(this.deliveryHealthPath, this.deliveryHealth); }
    catch (error) {
      this.deliveryHealthWritable = false;
      this.recordStorageIssue("delivery_health_write", error);
    }
  }

  async record(item) {
    const operation = this.deliveryMutation.then(async () => {
      const items = await this.deliveries(500);
      items.unshift(item);
      await this.writeDeliveries(items.slice(0, 500));
    });
    this.deliveryMutation = operation.catch(() => {});
    return operation;
  }

  async persist() {
    try {
      await writeJsonAtomic(this.settingsPath, this.settings);
      this.clearStorageIssues("settings_read", "settings_write");
    } catch (error) {
      this.recordStorageIssue("settings_write", error);
      throw error;
    }
  }
}
