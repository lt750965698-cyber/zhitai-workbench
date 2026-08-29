import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const STATE_VERSION = 1;
const SUCCESS_CODE = "keepalive_sent";

const RUN_FAILURE_CODES = new Set([
  "driver_unavailable",
  "permission_denied",
  "auth_required",
  "target_not_ready",
  "target_ambiguous",
  "ax_incomplete",
  "state_changed",
  "send_uncertain",
  "device_offline",
  "device_locked",
  "target_not_found",
  "target_not_unique",
  "wechat_unavailable",
  "ui_not_ready",
  "input_unavailable",
  "send_unconfirmed",
  "timeout",
]);

const FAILURE_CODES = new Set([
  ...RUN_FAILURE_CODES,
  "attempt_limit",
  "command_failed",
  "context_not_refreshed",
  "invalid_response",
  "notification_state_unavailable",
  "state_unavailable",
]);

// 这些结果在 runner 契约中保证没有点击“发送”。它们仍进入冷却避免频繁
// 读取 AX，但不消耗“可能已经外发”的次数上限；因此用户晚些完成扫码后，
// 监督器仍会继续恢复，而不是三次只读探测后沉默到下一个 6 小时窗口。
const NON_SENDING_FAILURE_CODES = new Set([
  "driver_unavailable",
  "permission_denied",
  "auth_required",
  "target_not_ready",
  "target_ambiguous",
  "ax_incomplete",
  "state_changed",
  "device_offline",
  "device_locked",
  "target_not_found",
  "target_not_unique",
  "wechat_unavailable",
  "ui_not_ready",
  "input_unavailable",
]);

const TRANSIENT_CONTROL_FAILURE_CODES = new Set([
  "driver_unavailable",
  "ax_incomplete",
  "auth_required",
  "state_changed",
  "target_not_ready",
  "ui_not_ready",
]);

// These outcomes may follow an AX send action that actually reached WeChat.
// Retrying them on a timer can duplicate an external message, so the incident
// stays frozen until a separately verified inbound/context refresh clears the
// notification state. A human does not need to acknowledge it, but the
// supervisor must never infer that a cooldown makes another send safe.
const UNCERTAIN_EXTERNAL_SEND_CODES = new Set([
  "send_uncertain",
  "context_not_refreshed",
]);

// Runner 只允许这些低基数 reason 跨越进程边界。任何未知 reason
// 都收敛为 needs_user，避免将 AX 文本、联系人或原始异常写入磁盘/API。
const TERMINAL_REASONS = new Set([
  "draft_present",
  "draft_cleanup_unconfirmed",
  "send_uncertain",
  "context_not_refreshed",
  "needs_user",
]);

const OUTCOMES = new Set([
  "idle",
  "attempting",
  "cooldown",
  "attempt_limit",
  "failed",
  "needs_user",
  "recovered",
]);

const STATE_KEYS = new Set([
  "version",
  "incidentActive",
  "windowStartedAt",
  "attemptCount",
  "cooldownUntil",
  "notifiedFailureCodes",
  "lastOutcome",
  "lastAttemptAt",
  "lastSuccessAt",
  "lastFailureAt",
  "lastFailureCode",
  "terminal",
  "needsUser",
  "terminalReason",
  "lastContextUpdatedAt",
  "updatedAt",
]);

function defaultState() {
  return {
    version: STATE_VERSION,
    incidentActive: false,
    windowStartedAt: null,
    attemptCount: 0,
    cooldownUntil: null,
    notifiedFailureCodes: [],
    lastOutcome: "idle",
    lastAttemptAt: null,
    lastSuccessAt: null,
    lastFailureAt: null,
    lastFailureCode: null,
    terminal: false,
    needsUser: false,
    terminalReason: null,
    lastContextUpdatedAt: null,
    updatedAt: null,
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function dateFrom(value, errorCode = "clawbot_keepalive_clock_invalid") {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(errorCode);
  return date;
}

function optionalIso(value) {
  if (value === null) return true;
  if (typeof value !== "string" || !value) return false;
  return !Number.isNaN(new Date(value).getTime());
}

function sanitizeState(parsed) {
  const state = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? {
        ...parsed,
        // 兼容未含终态字段的 v1 持久状态；一经下次写入即补齐。
        terminal: parsed.terminal ?? false,
        needsUser: parsed.needsUser ?? false,
        terminalReason: parsed.terminalReason ?? null,
      }
    : parsed;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
    || Object.keys(parsed).some((key) => !STATE_KEYS.has(key))
    || state.version !== STATE_VERSION
    || typeof state.incidentActive !== "boolean"
    || !Number.isInteger(state.attemptCount) || state.attemptCount < 0
    || !Array.isArray(state.notifiedFailureCodes)
    || state.notifiedFailureCodes.some((code) => !FAILURE_CODES.has(code))
    || new Set(state.notifiedFailureCodes).size !== state.notifiedFailureCodes.length
    || !OUTCOMES.has(state.lastOutcome)
    || !optionalIso(state.windowStartedAt)
    || !optionalIso(state.cooldownUntil)
    || !optionalIso(state.lastAttemptAt)
    || !optionalIso(state.lastSuccessAt)
    || !optionalIso(state.lastFailureAt)
    || !optionalIso(state.lastContextUpdatedAt)
    || !optionalIso(state.updatedAt)
    || typeof state.terminal !== "boolean"
    || typeof state.needsUser !== "boolean"
    || state.terminal !== state.needsUser
    || (state.terminalReason !== null && !TERMINAL_REASONS.has(state.terminalReason))
    || (state.terminal && (state.terminalReason === null
      || state.lastOutcome !== "needs_user"
      || !state.incidentActive
      || state.lastFailureCode === null))
    || (!state.terminal && (state.terminalReason !== null || state.lastOutcome === "needs_user"))
    || (state.lastOutcome === "attempting" && state.lastAttemptAt === null)
    || (state.lastFailureCode !== null && !FAILURE_CODES.has(state.lastFailureCode))) {
    throw new Error("clawbot_keepalive_state_invalid");
  }
  return state;
}

function safeTerminalReason(reason, code) {
  if (typeof reason === "string" && TERMINAL_REASONS.has(reason)) return reason;
  if (TERMINAL_REASONS.has(code)) return code;
  return "needs_user";
}

async function secureStateDirectory(path) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new Error("clawbot_keepalive_state_directory_unsafe");
  }
  await chmod(directory, 0o700);
  return directory;
}

async function writeStateAtomic(path, state) {
  await secureStateDirectory(path);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle = null;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(state, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    try { await handle?.close(); } catch { /* noop */ }
    try { await unlink(temporary); } catch { /* noop */ }
    throw error;
  }
}

function parseRunResult(value) {
  let parsed = value;
  if (Buffer.isBuffer(parsed) || parsed instanceof Uint8Array) {
    parsed = Buffer.from(parsed).toString("utf8");
  }
  if (typeof parsed === "string") {
    try { parsed = JSON.parse(parsed); }
    catch {
      return {
        success: false,
        code: "invalid_response",
        terminal: true,
        needsUser: true,
        reason: "send_uncertain",
      };
    }
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      success: false,
      code: "invalid_response",
      terminal: true,
      needsUser: true,
      reason: "send_uncertain",
    };
  }
  if (parsed.ok === true && parsed.code === SUCCESS_CODE) {
    if (parsed.terminal === true || parsed.needs_user === true) {
      return {
        success: false,
        code: "invalid_response",
        terminal: true,
        needsUser: true,
        reason: "send_uncertain",
      };
    }
    return { success: true, code: SUCCESS_CODE };
  }
  if (parsed.ok === false && RUN_FAILURE_CODES.has(parsed.code)) {
    const hasTerminalMetadata = Object.hasOwn(parsed, "terminal")
      || Object.hasOwn(parsed, "needs_user")
      || Object.hasOwn(parsed, "reason");
    if (hasTerminalMetadata && (parsed.terminal !== true || parsed.needs_user !== true)) {
      return {
        success: false,
        code: "invalid_response",
        terminal: true,
        needsUser: true,
        reason: "send_uncertain",
      };
    }
    const terminal = parsed.code === "send_uncertain" || hasTerminalMetadata;
    return {
      success: false,
      code: parsed.code,
      terminal,
      needsUser: terminal,
      reason: terminal ? safeTerminalReason(parsed.reason, parsed.code) : null,
    };
  }
  return {
    success: false,
    code: "invalid_response",
    terminal: true,
    needsUser: true,
    reason: "send_uncertain",
  };
}

function contextTimestamp(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (typeof value.contextUpdatedAt !== "string" && !(value.contextUpdatedAt instanceof Date)) return null;
  const date = new Date(value.contextUpdatedAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

function failureOutcome(failure) {
  if (failure?.available && failure.terminal === true && failure.needsUser === true) {
    return {
      outcome: "needs_user",
      code: failure.code,
      terminal: true,
      needs_user: true,
      reason: safeTerminalReason(failure.reason, failure.code),
      retryAt: null,
    };
  }
  return { outcome: "failed", code: failure?.code || "state_unavailable" };
}

/**
 * ClawBot 会话保活监督器。
 *
 * 注入契约：
 * - getNotificationState() 必须返回
 *   `{ clawbot: { deliveryState, ready, operational, contextUpdatedAt } }`。
 * - runKeepalive() 必须返回 JSON 文本或已解析对象。唯一成功回执是
 *   `{ "ok": true, "code": "keepalive_sent" }`；需要人工恢复的失败必须携带
 *   `{ terminal: true, needs_user: true, reason: <低基数原因> }`。
 * - verifyContextRefresh(startedAt) 接收 ISO 时间，必须返回
 *   `{ contextUpdatedAt }`，且该时间严格晚于 startedAt。
 * - notifyFallback(code, metadata) 只接收本文件定义的低基数错误码
 *   与 `{ terminal, needsUser, reason }` 安全元数据。
 *
 * 设备标识、聊天正文、手机号、命令输出与原始异常均不会写入状态文件。
 */
export class ClawbotKeepaliveSupervisor {
  constructor({
    statePath,
    getNotificationState,
    runKeepalive,
    verifyContextRefresh,
    notifyFallback = async () => {},
    now = () => new Date(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    intervalMs = 15 * 60_000,
    cooldownMs = 30 * 60_000,
    transientCooldownMs = 5 * 60_000,
    successCooldownMs = 30 * 60_000,
    proactiveAfterMs = 6 * 60 * 60_000,
    attemptWindowMs = 6 * 60 * 60_000,
    maxAttempts = 3,
  } = {}) {
    if (!statePath || typeof statePath !== "string") throw new Error("clawbot_keepalive_state_path_required");
    for (const [name, callback] of Object.entries({
      getNotificationState,
      runKeepalive,
      verifyContextRefresh,
      notifyFallback,
    })) {
      if (typeof callback !== "function") throw new Error(`clawbot_keepalive_${name}_required`);
    }
    for (const [name, value] of Object.entries({
      intervalMs,
      cooldownMs,
      transientCooldownMs,
      successCooldownMs,
      proactiveAfterMs,
      attemptWindowMs,
    })) {
      if (!Number.isFinite(value) || value <= 0) throw new Error(`clawbot_keepalive_${name}_invalid`);
    }
    if (!Number.isInteger(maxAttempts) || maxAttempts <= 0) throw new Error("clawbot_keepalive_maxAttempts_invalid");

    this.statePath = resolve(statePath);
    this.getNotificationState = getNotificationState;
    this.runKeepalive = runKeepalive;
    this.verifyContextRefresh = verifyContextRefresh;
    this.notifyFallback = notifyFallback;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.intervalMs = Math.floor(intervalMs);
    this.cooldownMs = Math.floor(cooldownMs);
    this.transientCooldownMs = Math.floor(transientCooldownMs);
    this.successCooldownMs = Math.floor(successCooldownMs);
    this.proactiveAfterMs = Math.floor(proactiveAfterMs);
    this.attemptWindowMs = Math.floor(attemptWindowMs);
    this.maxAttempts = maxAttempts;

    this.state = null;
    this.stateLoad = null;
    this.mutation = Promise.resolve();
    this.tickPromise = null;
    this.timer = null;
    this.running = false;
    this.closed = false;
    this.notificationPromises = new Map();
    this.ephemeralNotifications = new Set();
    this.stateFaulted = false;
  }

  _now() {
    const value = typeof this.now === "function" ? this.now() : this.now;
    return dateFrom(value);
  }

  async _loadState() {
    if (this.state) return this.state;
    if (!this.stateLoad) {
      this.stateLoad = (async () => {
        await secureStateDirectory(this.statePath);
        try {
          const info = await lstat(this.statePath);
          if (!info.isFile() || info.isSymbolicLink()) throw new Error("clawbot_keepalive_state_file_unsafe");
          await chmod(this.statePath, 0o600);
        } catch (error) {
          if (error?.code === "ENOENT") return defaultState();
          throw error;
        }
        let raw;
        try { raw = await readFile(this.statePath, "utf8"); }
        catch { throw new Error("clawbot_keepalive_state_unavailable"); }
        try { return sanitizeState(JSON.parse(raw)); }
        catch (error) {
          if (error?.message === "clawbot_keepalive_state_invalid") throw error;
          throw new Error("clawbot_keepalive_state_invalid");
        }
      })();
    }
    try {
      this.state = await this.stateLoad;
      return this.state;
    } catch (error) {
      this.stateFaulted = true;
      throw error;
    }
  }

  _mutate(mutator) {
    const operation = this.mutation.catch(() => {}).then(async () => {
      const state = await this._loadState();
      const result = await mutator(state);
      await writeStateAtomic(this.statePath, state);
      return result;
    }).catch((error) => {
      // A failed durable transition leaves the on-disk state older than the
      // in-memory/external action. Stop this process from issuing another send;
      // after restart, a persisted `attempting` row is reconciled as uncertain.
      this.stateFaulted = true;
      throw error;
    });
    this.mutation = operation.then(() => undefined, () => undefined);
    return operation;
  }

  async _resetIfNotRequired() {
    const state = await this._loadState();
    const hasInternalNotification = state.notifiedFailureCodes.some((code) => (
      code === "notification_state_unavailable" || code === "state_unavailable"
    ));
    if (!state.incidentActive && state.lastOutcome !== "recovered" && !hasInternalNotification) return;
    const nowIso = this._now().toISOString();
    await this._mutate((current) => {
      current.incidentActive = false;
      current.windowStartedAt = null;
      current.attemptCount = 0;
      current.cooldownUntil = null;
      current.notifiedFailureCodes = [];
      current.lastOutcome = "idle";
      current.lastFailureAt = null;
      current.lastFailureCode = null;
      current.terminal = false;
      current.needsUser = false;
      current.terminalReason = null;
      current.updatedAt = nowIso;
    });
  }

  async _reserveAttempt(startedAt) {
    return this._mutate((state) => {
      const startedMs = startedAt.getTime();
      const windowMs = state.windowStartedAt ? new Date(state.windowStartedAt).getTime() : NaN;
      if (!Number.isFinite(windowMs) || startedMs - windowMs >= this.attemptWindowMs) {
        state.windowStartedAt = startedAt.toISOString();
        state.attemptCount = 0;
      }
      if (!state.incidentActive) {
        state.incidentActive = true;
        state.notifiedFailureCodes = [];
      }
      let cooldownUntilMs = state.cooldownUntil ? new Date(state.cooldownUntil).getTime() : NaN;
      if (TRANSIENT_CONTROL_FAILURE_CODES.has(state.lastFailureCode) && state.lastFailureAt) {
        const transientUntil = new Date(state.lastFailureAt).getTime() + this.transientCooldownMs;
        if (Number.isFinite(transientUntil) && (!Number.isFinite(cooldownUntilMs) || transientUntil < cooldownUntilMs)) {
          cooldownUntilMs = transientUntil;
          state.cooldownUntil = new Date(transientUntil).toISOString();
        }
      }
      if (Number.isFinite(cooldownUntilMs) && cooldownUntilMs > startedMs) {
        state.lastOutcome = "cooldown";
        state.updatedAt = startedAt.toISOString();
        return { allowed: false, reason: "cooldown", retryAt: state.cooldownUntil };
      }
      if (state.attemptCount >= this.maxAttempts) {
        state.lastOutcome = "attempt_limit";
        state.updatedAt = startedAt.toISOString();
        return { allowed: false, reason: "attempt_limit", retryAt: null };
      }
      state.attemptCount += 1;
      state.lastAttemptAt = startedAt.toISOString();
      state.lastOutcome = "attempting";
      state.updatedAt = startedAt.toISOString();
      return { allowed: true, attemptCount: state.attemptCount };
    });
  }

  async _recordFailure(code, {
    terminal = false,
    needsUser = false,
    reason = null,
  } = {}) {
    const safeCode = FAILURE_CODES.has(code) ? code : "invalid_response";
    const safeTerminal = terminal === true && needsUser === true;
    const safeReason = safeTerminal ? safeTerminalReason(reason, safeCode) : null;
    const now = this._now();
    await this._mutate((state) => {
      const terminalNotificationChanged = safeTerminal
        && (!state.terminal || state.terminalReason !== safeReason);
      state.incidentActive = true;
      state.lastOutcome = safeTerminal
        ? "needs_user"
        : (safeCode === "attempt_limit" ? "attempt_limit" : "failed");
      state.lastFailureAt = now.toISOString();
      state.lastFailureCode = safeCode;
      state.terminal = safeTerminal;
      state.needsUser = safeTerminal;
      state.terminalReason = safeReason;
      if (terminalNotificationChanged) {
        state.notifiedFailureCodes = state.notifiedFailureCodes.filter((item) => item !== safeCode);
      }
      if (!safeTerminal && NON_SENDING_FAILURE_CODES.has(safeCode) && state.attemptCount > 0) {
        state.attemptCount -= 1;
      }
      const failureCooldownMs = TRANSIENT_CONTROL_FAILURE_CODES.has(safeCode)
        ? this.transientCooldownMs
        : this.cooldownMs;
      state.cooldownUntil = safeTerminal
        ? null
        : (safeCode === "attempt_limit"
        ? state.cooldownUntil
        : new Date(now.getTime() + failureCooldownMs).toISOString());
      state.updatedAt = now.toISOString();
    });
    const metadata = {
      terminal: safeTerminal,
      needsUser: safeTerminal,
      reason: safeReason,
    };
    await this._notifyOnce(safeCode, metadata);
    return { code: safeCode, ...metadata };
  }

  async _recordFailureResult(code, metadata = {}) {
    try {
      return { available: true, ...await this._recordFailure(code, metadata) };
    } catch {
      await this._notifyInternalFailure("state_unavailable");
      return {
        available: false,
        code: "state_unavailable",
        terminal: true,
        needsUser: true,
        reason: "needs_user",
      };
    }
  }

  async _notifyOnce(code, metadata = {}) {
    if (this.notificationPromises.has(code)) return this.notificationPromises.get(code);
    const operation = this._notifyOnceInner(code, metadata).finally(() => {
      if (this.notificationPromises.get(code) === operation) this.notificationPromises.delete(code);
    });
    this.notificationPromises.set(code, operation);
    return operation;
  }

  async _notifyOnceInner(code, metadata) {
    const state = await this._loadState();
    if (state.notifiedFailureCodes.includes(code)) return false;
    try {
      await this.notifyFallback(code, metadata);
    } catch {
      return false;
    }
    // 先完成外部通知，再持久“已通知”。进程如在两步之间退出，
    // 下次会重试（至少一次语义），不会因预先落盘而永久漏通知。
    try {
      await this._mutate((current) => {
        if (!current.notifiedFailureCodes.includes(code)) current.notifiedFailureCodes.push(code);
        current.updatedAt = this._now().toISOString();
      });
    } catch {
      // fallback 已成功；落盘失败时至少在当前进程去重，不再发第二次。
      this.ephemeralNotifications.add(code);
    }
    return true;
  }

  async _notifyInternalFailure(code) {
    try {
      return await this._notifyOnce(code);
    } catch {
      // 状态文件本身不可用时，通知不能再依赖该文件。
      // 进程内仍做单飞和去重；只在 fallback 真正成功后才标记。
      if (this.ephemeralNotifications.has(code)) return false;
      if (this.notificationPromises.has(`ephemeral:${code}`)) {
        return this.notificationPromises.get(`ephemeral:${code}`);
      }
      const key = `ephemeral:${code}`;
      const operation = (async () => {
        try {
          await this.notifyFallback(code);
          this.ephemeralNotifications.add(code);
          return true;
        } catch {
          return false;
        }
      })().finally(() => {
        if (this.notificationPromises.get(key) === operation) this.notificationPromises.delete(key);
      });
      this.notificationPromises.set(key, operation);
      return operation;
    }
  }

  async _recordRecovered(contextUpdatedAt) {
    const now = this._now();
    await this._mutate((state) => {
      state.incidentActive = false;
      state.notifiedFailureCodes = [];
      state.lastOutcome = "recovered";
      state.lastSuccessAt = now.toISOString();
      state.lastContextUpdatedAt = contextUpdatedAt.toISOString();
      state.lastFailureAt = null;
      state.lastFailureCode = null;
      state.terminal = false;
      state.needsUser = false;
      state.terminalReason = null;
      state.cooldownUntil = new Date(now.getTime() + this.successCooldownMs).toISOString();
      state.updatedAt = now.toISOString();
    });
  }

  async _verifyRefreshAfter(startedAt) {
    let verification;
    try { verification = await this.verifyContextRefresh(startedAt.toISOString()); }
    catch { verification = null; }
    const refreshedAt = contextTimestamp(verification);
    return refreshedAt && refreshedAt.getTime() > startedAt.getTime() ? refreshedAt : null;
  }

  async _reconcileInterruptedAttempt() {
    let state;
    try { state = await this._loadState(); }
    catch {
      await this._notifyInternalFailure("state_unavailable");
      return { outcome: "not_triggered", code: "state_unavailable" };
    }
    if (state.lastOutcome !== "attempting") return null;

    // `attempting` 只可能是上一进程在外部发送途中退出留下的状态。
    // 先回读会话时间，不得直接再发，否则会造成重复消息。
    const attemptedAt = dateFrom(state.lastAttemptAt, "clawbot_keepalive_state_invalid");
    const refreshedAt = await this._verifyRefreshAfter(attemptedAt);
    if (refreshedAt) {
      try { await this._recordRecovered(refreshedAt); }
      catch {
        await this._notifyInternalFailure("state_unavailable");
        return { outcome: "failed", code: "state_unavailable" };
      }
      return { outcome: "recovered", code: "context_refreshed" };
    }
    const failure = await this._recordFailureResult("send_uncertain", {
      terminal: true,
      needsUser: true,
      reason: "send_uncertain",
    });
    return failureOutcome(failure);
  }

  async _pendingTerminalFailure() {
    let state;
    try { state = await this._loadState(); }
    catch {
      await this._notifyInternalFailure("state_unavailable");
      return { outcome: "failed", code: "state_unavailable" };
    }
    const legacyUncertain = UNCERTAIN_EXTERNAL_SEND_CODES.has(state.lastFailureCode);
    if (!state.incidentActive || (!state.terminal && !legacyUncertain)) return null;
    const metadata = {
      terminal: true,
      needsUser: true,
      reason: state.terminalReason || safeTerminalReason(null, state.lastFailureCode),
    };
    await this._notifyOnce(state.lastFailureCode, metadata);
    return {
      outcome: "needs_user",
      code: state.lastFailureCode,
      terminal: true,
      needs_user: true,
      reason: metadata.reason,
      retryAt: null,
    };
  }

  _triggerReason(notificationState, now) {
    const clawbot = notificationState?.clawbot;
    if (!clawbot || typeof clawbot !== "object" || Array.isArray(clawbot)) return null;
    if (clawbot.deliveryState === "session_refresh_required") return "session_refresh_required";
    const operational = clawbot.deliveryState === "ready"
      && (clawbot.ready === true || clawbot.operational === true);
    if (!operational) return null;
    const updatedAt = contextTimestamp(clawbot);
    if (!updatedAt) return null;
    return now.getTime() - updatedAt.getTime() > this.proactiveAfterMs
      ? "proactive_context_stale"
      : "context_recent";
  }

  async _tick() {
    if (this.closed) return { outcome: "stopped", code: "stopped" };
    if (this.stateFaulted) {
      await this._notifyInternalFailure("state_unavailable");
      return { outcome: "not_triggered", code: "state_unavailable" };
    }

    const interrupted = await this._reconcileInterruptedAttempt();
    if (interrupted) return interrupted;
    this.ephemeralNotifications.delete("state_unavailable");

    let notificationState;
    try { notificationState = await this.getNotificationState(); }
    catch {
      await this._notifyInternalFailure("notification_state_unavailable");
      return { outcome: "not_triggered", code: "notification_state_unavailable" };
    }
    this.ephemeralNotifications.delete("notification_state_unavailable");

    const startedAt = this._now();
    const triggerReason = this._triggerReason(notificationState, startedAt);
    if (triggerReason !== "session_refresh_required" && triggerReason !== "proactive_context_stale") {
      try { await this._resetIfNotRequired(); }
      catch {
        await this._notifyInternalFailure("state_unavailable");
        return { outcome: "not_triggered", code: "state_unavailable" };
      }
      return {
        outcome: "not_triggered",
        code: triggerReason === "context_recent" ? "context_recent" : "session_refresh_not_required",
      };
    }

    const terminal = await this._pendingTerminalFailure();
    if (terminal) return terminal;

    let reservation;
    try { reservation = await this._reserveAttempt(startedAt); }
    catch {
      await this._notifyInternalFailure("state_unavailable");
      return { outcome: "not_triggered", code: "state_unavailable" };
    }
    if (!reservation.allowed) {
      if (reservation.reason === "attempt_limit") {
        const failure = await this._recordFailureResult("attempt_limit");
        if (!failure.available) return { outcome: "failed", code: failure.code };
      }
      return {
        outcome: reservation.reason,
        code: reservation.reason,
        retryAt: reservation.retryAt,
      };
    }

    let rawResult;
    try { rawResult = await this.runKeepalive(); }
    catch { rawResult = null; }
    const result = rawResult === null
      ? {
          success: false,
          code: "command_failed",
          terminal: true,
          needsUser: true,
          reason: "send_uncertain",
        }
      : parseRunResult(rawResult);
    if (!result.success) {
      if (result.code === "send_uncertain") {
        const refreshedAt = await this._verifyRefreshAfter(startedAt);
        if (refreshedAt) {
          try { await this._recordRecovered(refreshedAt); }
          catch {
            await this._notifyInternalFailure("state_unavailable");
            return { outcome: "failed", code: "state_unavailable" };
          }
          return { outcome: "recovered", code: "context_refreshed" };
        }
      }
      const failure = await this._recordFailureResult(result.code, result);
      return failureOutcome(failure);
    }

    const refreshedAt = await this._verifyRefreshAfter(startedAt);
    if (!refreshedAt) {
      const failure = await this._recordFailureResult("context_not_refreshed", {
        terminal: true,
        needsUser: true,
        reason: "context_not_refreshed",
      });
      return failureOutcome(failure);
    }
    try { await this._recordRecovered(refreshedAt); }
    catch {
      await this._notifyInternalFailure("state_unavailable");
      return { outcome: "failed", code: "state_unavailable" };
    }
    return { outcome: "recovered", code: "context_refreshed" };
  }

  tick() {
    if (this.tickPromise) return this.tickPromise;
    const operation = this._tick().finally(() => {
      if (this.tickPromise === operation) this.tickPromise = null;
    });
    this.tickPromise = operation;
    return operation;
  }

  _schedule(delayMs) {
    if (!this.running || this.closed) return;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => {
      this.timer = null;
      this.tick().catch(() => {}).finally(() => {
        if (this.running && !this.closed) this._schedule(this.intervalMs);
      });
    }, Math.max(0, Math.floor(delayMs)));
    this.timer?.unref?.();
  }

  start() {
    if (this.closed || this.running) return false;
    this.running = true;
    this._schedule(0);
    return true;
  }

  async stop() {
    this.running = false;
    this.closed = true;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
    await this.tickPromise?.catch(() => {});
    await this.mutation.catch(() => {});
  }

  async status() {
    let state;
    try { state = clone(await this._loadState()); }
    catch {
      return {
        running: this.running,
        inFlight: Boolean(this.tickPromise),
        stateAvailable: false,
      };
    }
    return {
      running: this.running,
      inFlight: Boolean(this.tickPromise),
      stateAvailable: true,
      incidentActive: state.incidentActive,
      attemptCount: state.attemptCount,
      windowStartedAt: state.windowStartedAt,
      cooldownUntil: state.cooldownUntil,
      notifiedFailureCodes: [...state.notifiedFailureCodes],
      lastOutcome: state.lastOutcome,
      lastAttemptAt: state.lastAttemptAt,
      lastSuccessAt: state.lastSuccessAt,
      lastFailureAt: state.lastFailureAt,
      lastFailureCode: state.lastFailureCode,
      terminal: state.terminal,
      needsUser: state.needsUser,
      terminalReason: state.terminalReason,
      lastContextUpdatedAt: state.lastContextUpdatedAt,
    };
  }
}

export function createClawbotKeepaliveSupervisor(options) {
  return new ClawbotKeepaliveSupervisor(options);
}

export const clawbotKeepaliveSuccessCode = SUCCESS_CODE;
export const clawbotKeepaliveFailureCodes = Object.freeze([...FAILURE_CODES]);
