import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const SUPPORTED_PLATFORMS = new Set(["dy", "sph"]);
const RECOVERABLE_AUTH_STATES = new Set(["invalid", "unverified"]);
const TERMINAL_SESSION_STATES = new Set(["success", "expired", "failed"]);
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MAX_PNG_BYTES = 5 * 1024 * 1024;
const STATE_VERSION = 1;

function platformCode(value) {
  const normalized = String(value || "").trim().toLowerCase();
  if (["dy", "douyin", "抖音"].includes(normalized)) return "dy";
  if (["sph", "channels", "wechat_channels", "视频号"].includes(normalized)) return "sph";
  return normalized;
}

function validPhone(value) {
  const phone = String(value || "").trim();
  return /^1\d{10}$/.test(phone) ? phone : null;
}

export function publisherLoginAccountFingerprint(platform, phone) {
  const code = platformCode(platform);
  const normalizedPhone = validPhone(phone);
  if (!SUPPORTED_PLATFORMS.has(code)) throw new Error("publisher_login_platform_unsupported");
  if (!normalizedPhone) throw new Error("publisher_login_account_invalid");
  return `login_${createHash("sha256")
    .update(`zhitai-publisher-login-v1\0${code}\0${normalizedPhone}`)
    .digest("hex")
    .slice(0, 32)}`;
}

function normalizeDate(now) {
  const raw = typeof now === "function" ? now() : now;
  const date = raw instanceof Date ? new Date(raw.getTime()) : new Date(raw);
  if (Number.isNaN(date.getTime())) throw new Error("publisher_login_clock_invalid");
  return date;
}

function localDay(date, offsetMinutes) {
  return new Date(date.getTime() + offsetMinutes * 60_000).toISOString().slice(0, 10);
}

function millisecondsUntilNextDay(date, offsetMinutes) {
  const shifted = date.getTime() + offsetMinutes * 60_000;
  const next = new Date(shifted);
  next.setUTCHours(24, 0, 0, 0);
  return Math.max(1_000, next.getTime() - shifted);
}

function defaultState() {
  return { version: STATE_VERSION, records: [], deliveredQrHashes: [] };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function normalizeSessionStatus(value) {
  const status = String(value || "").trim().toLowerCase();
  if (["waiting_qr", "waiting_scan", "success", "expired", "failed"].includes(status)) return status;
  return "waiting_qr";
}

function sanitizeState(parsed) {
  if (!parsed || parsed.version !== STATE_VERSION || !Array.isArray(parsed.records)
    || !Array.isArray(parsed.deliveredQrHashes)) {
    throw new Error("publisher_login_recovery_state_invalid");
  }
  for (const record of parsed.records) {
    if (!record || !SUPPORTED_PLATFORMS.has(record.platform)
      || !/^login_[a-f0-9]{32}$/.test(String(record.accountFingerprint || ""))
      || !/^\d{4}-\d{2}-\d{2}$/.test(String(record.attemptDay || ""))
      || !Number.isInteger(record.attemptCount) || record.attemptCount < 0
      || typeof record.sessionStatus !== "string") {
      throw new Error("publisher_login_recovery_state_invalid");
    }
  }
  if (parsed.deliveredQrHashes.some((hash) => !/^[a-f0-9]{64}$/.test(String(hash || "")))) {
    throw new Error("publisher_login_recovery_state_invalid");
  }
  return parsed;
}

function pngFromAsset(value) {
  let candidate = value;
  if (candidate && typeof candidate === "object" && !Buffer.isBuffer(candidate)
    && !(candidate instanceof Uint8Array)) {
    candidate = candidate.png ?? candidate.qrData ?? candidate.data ?? candidate.buffer ?? null;
  }
  let buffer = null;
  if (Buffer.isBuffer(candidate) || candidate instanceof Uint8Array) {
    buffer = Buffer.from(candidate);
  } else if (typeof candidate === "string") {
    const match = /^data:image\/png;base64,([a-z0-9+/=]+)$/i.exec(candidate.trim());
    if (!match) return null;
    try { buffer = Buffer.from(match[1], "base64"); } catch { return null; }
  }
  if (!buffer || buffer.length < 24 || buffer.length > MAX_PNG_BYTES) return null;
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return null;
  if (buffer.toString("ascii", 12, 16) !== "IHDR") return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width < 96 || height < 96 || width > 1024 || height > 1024) return null;
  if (Math.abs(width - height) > Math.max(width, height) * 0.2) return null;
  return buffer;
}

async function writeStateAtomic(path, value) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle = null;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
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

/**
 * 自动恢复 MatrixMedia 发布账号登录态。
 *
 * 注入契约：
 * - startLogin({ platform, phone }) -> { id, status? }
 * - getLogin(sessionId) -> { status, qrData|png|data|buffer? }
 * - deliverQr({ platform, accountFingerprint, sessionId, qrHash, png })
 * - recovered({ platform, accountFingerprint, sessionId })
 *
 * 手机号与 PNG 只存在于当前进程内存，不出现在返回值或状态文件中。deliverQr
 * 必须自行决定临时路径与手机发送方式，并应把 qrHash 当作外部发送幂等键。
 */
export class PublisherLoginRecovery {
  constructor({
    statePath,
    startLogin,
    getLogin,
    deliverQr,
    recovered = async () => {},
    now = () => new Date(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    pollIntervalMs = 2_000,
    sessionTimeoutMs = 20 * 60_000,
    retryBaseMs = 60_000,
    retryMaxMs = 30 * 60_000,
    deliveryRetryMs = 2 * 60_000,
    maxAttemptsPerDay = 3,
    dayOffsetMinutes = 8 * 60,
    maxRememberedQrHashes = 256,
  } = {}) {
    if (!statePath || typeof statePath !== "string") throw new Error("publisher_login_recovery_state_path_required");
    for (const [name, callback] of Object.entries({ startLogin, getLogin, deliverQr, recovered })) {
      if (typeof callback !== "function") throw new Error(`publisher_login_recovery_${name}_required`);
    }
    for (const [name, value] of Object.entries({ pollIntervalMs, sessionTimeoutMs, retryBaseMs, retryMaxMs, deliveryRetryMs, maxAttemptsPerDay })) {
      if (!Number.isFinite(value) || value <= 0) throw new Error(`publisher_login_recovery_${name}_invalid`);
    }
    this.statePath = resolve(statePath);
    this.startLogin = startLogin;
    this.getLogin = getLogin;
    this.deliverQr = deliverQr;
    this.recovered = recovered;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.pollIntervalMs = Math.floor(pollIntervalMs);
    this.sessionTimeoutMs = Math.floor(sessionTimeoutMs);
    this.retryBaseMs = Math.floor(retryBaseMs);
    this.retryMaxMs = Math.floor(retryMaxMs);
    this.deliveryRetryMs = Math.floor(deliveryRetryMs);
    this.maxAttemptsPerDay = Math.floor(maxAttemptsPerDay);
    this.dayOffsetMinutes = dayOffsetMinutes;
    this.maxRememberedQrHashes = Math.max(1, Math.floor(maxRememberedQrHashes));
    this.active = new Map();
    this.stopped = false;
    this.state = null;
    this.stateLoad = null;
    this.mutation = Promise.resolve();
    this.inFlight = new Set();
  }

  async _loadState() {
    if (this.state) return this.state;
    if (!this.stateLoad) {
      this.stateLoad = (async () => {
        let raw;
        try { raw = await readFile(this.statePath, "utf8"); }
        catch (error) {
          if (error?.code === "ENOENT") return defaultState();
          throw error;
        }
        try { return sanitizeState(JSON.parse(raw)); }
        catch (error) {
          if (error?.message === "publisher_login_recovery_state_invalid") throw error;
          throw new Error("publisher_login_recovery_state_invalid");
        }
      })();
    }
    this.state = await this.stateLoad;
    return this.state;
  }

  _mutate(mutator) {
    const operation = this.mutation.catch(() => {}).then(async () => {
      const state = await this._loadState();
      const result = await mutator(state);
      await writeStateAtomic(this.statePath, state);
      return result;
    });
    this.mutation = operation.then(() => undefined, () => undefined);
    return operation;
  }

  _record(state, platform, accountFingerprint, date) {
    let record = state.records.find((item) => item.platform === platform
      && item.accountFingerprint === accountFingerprint);
    const day = localDay(date, this.dayOffsetMinutes);
    if (!record) {
      record = {
        platform,
        accountFingerprint,
        sessionStatus: "idle",
        attemptDay: day,
        attemptCount: 0,
        updatedAt: date.toISOString(),
      };
      state.records.push(record);
    }
    if (record.attemptDay !== day) {
      record.attemptDay = day;
      record.attemptCount = 0;
    }
    return record;
  }

  async _reserveAttempt(account) {
    const date = normalizeDate(this.now);
    return this._mutate((state) => {
      const record = this._record(state, account.platform, account.accountFingerprint, date);
      if (record.attemptCount >= this.maxAttemptsPerDay) {
        record.sessionStatus = "daily_limit";
        record.updatedAt = date.toISOString();
        return { allowed: false, count: record.attemptCount, nextDelayMs: millisecondsUntilNextDay(date, this.dayOffsetMinutes) };
      }
      record.attemptCount += 1;
      record.sessionStatus = "starting";
      record.lastAttemptAt = date.toISOString();
      record.updatedAt = date.toISOString();
      return { allowed: true, count: record.attemptCount };
    });
  }

  async _persistStatus(account, status, extra = {}) {
    const date = normalizeDate(this.now);
    return this._mutate((state) => {
      const record = this._record(state, account.platform, account.accountFingerprint, date);
      record.sessionStatus = status;
      record.updatedAt = date.toISOString();
      if (extra.qrHash) record.lastQrHash = extra.qrHash;
      if (status === "recovered") record.recoveredAt = date.toISOString();
      return clone(record);
    });
  }

  async _wasQrDelivered(qrHash) {
    const state = await this._loadState();
    return state.deliveredQrHashes.includes(qrHash);
  }

  async _markQrDelivered(account, qrHash) {
    const date = normalizeDate(this.now);
    return this._mutate((state) => {
      if (state.deliveredQrHashes.includes(qrHash)) return false;
      state.deliveredQrHashes.push(qrHash);
      if (state.deliveredQrHashes.length > this.maxRememberedQrHashes) {
        state.deliveredQrHashes.splice(0, state.deliveredQrHashes.length - this.maxRememberedQrHashes);
      }
      const record = this._record(state, account.platform, account.accountFingerprint, date);
      record.lastQrHash = qrHash;
      record.qrDeliveredAt = date.toISOString();
      record.updatedAt = date.toISOString();
      return true;
    });
  }

  _clearEntry(accountFingerprint) {
    const entry = this.active.get(accountFingerprint);
    if (entry?.timer) this.clearTimer(entry.timer);
    this.active.delete(accountFingerprint);
  }

  _schedule(entry, callback, delayMs) {
    if (this.stopped) return;
    if (entry.timer) this.clearTimer(entry.timer);
    entry.timer = this.setTimer(() => {
      entry.timer = null;
      this._run(callback);
    }, Math.max(0, Math.floor(delayMs)));
    entry.timer?.unref?.();
  }

  _run(callback) {
    const task = Promise.resolve()
      .then(callback)
      .catch(() => {})
      .finally(() => this.inFlight.delete(task));
    this.inFlight.add(task);
    return task;
  }

  async _scheduleRetry(entry, attemptCount) {
    if (this.stopped) return;
    const date = normalizeDate(this.now);
    const delayMs = attemptCount >= this.maxAttemptsPerDay
      ? millisecondsUntilNextDay(date, this.dayOffsetMinutes)
      : Math.min(this.retryMaxMs, this.retryBaseMs * (2 ** Math.max(0, attemptCount - 1)));
    entry.phase = "backoff";
    this._schedule(entry, async () => {
      if (this.stopped) return;
      this.active.delete(entry.account.accountFingerprint);
      await this._ensure(entry.account);
    }, delayMs);
  }

  async _terminalFailure(entry, status) {
    let record = await this._persistStatus(entry.account, status);
    if (record.attemptCount >= this.maxAttemptsPerDay) {
      record = await this._persistStatus(entry.account, "daily_limit");
    }
    await this._scheduleRetry(entry, record.attemptCount);
  }

  async _poll(entry) {
    if (this.stopped || this.active.get(entry.account.accountFingerprint) !== entry) return;
    if (normalizeDate(this.now).getTime() - entry.startedAt >= this.sessionTimeoutMs) {
      await this._terminalFailure(entry, "failed");
      return;
    }
    let session;
    try { session = await this.getLogin(entry.sessionId); }
    catch { session = { status: "failed" }; }
    if (!session || typeof session !== "object") session = { status: "failed" };
    const status = normalizeSessionStatus(session.status);
    await this._persistStatus(entry.account, status);

    const png = pngFromAsset(session);
    if (png) {
      const qrHash = createHash("sha256").update(png).digest("hex");
      const alreadyDelivered = await this._wasQrDelivered(qrHash);
      const nowMs = normalizeDate(this.now).getTime();
      const deliveryDue = entry.lastDeliveryHash !== qrHash
        || nowMs - Number(entry.lastDeliveryAt || 0) >= this.deliveryRetryMs;
      if (!alreadyDelivered && deliveryDue) {
        entry.lastDeliveryHash = qrHash;
        entry.lastDeliveryAt = nowMs;
        try {
          const delivery = await this.deliverQr({
            platform: entry.account.platform,
            accountFingerprint: entry.account.accountFingerprint,
            sessionId: entry.sessionId,
            qrHash,
            png,
          });
          if (delivery === true || delivery?.ok === true) {
            await this._markQrDelivered(entry.account, qrHash);
          }
        } catch { /* 安全通道恢复后会对仍有效的同一二维码做有界重试 */ }
        finally { png.fill(0); }
      } else {
        png.fill(0);
      }
    }

    if (status === "success") {
      await this._persistStatus(entry.account, "recovered");
      this._clearEntry(entry.account.accountFingerprint);
      try {
        await this.recovered({
          platform: entry.account.platform,
          accountFingerprint: entry.account.accountFingerprint,
          sessionId: entry.sessionId,
        });
      } catch { /* 恢复回调失败不能重新触发平台登录 */ }
      return;
    }
    if (TERMINAL_SESSION_STATES.has(status)) {
      await this._terminalFailure(entry, status);
      return;
    }
    this._schedule(entry, () => this._poll(entry), this.pollIntervalMs);
  }

  async _ensure(account) {
    if (this.stopped || this.active.has(account.accountFingerprint)) return false;
    const entry = {
      account,
      phase: "reserving",
      timer: null,
      sessionId: null,
      startedAt: 0,
      lastDeliveryHash: null,
      lastDeliveryAt: 0,
    };
    this.active.set(account.accountFingerprint, entry);
    let reservation;
    try { reservation = await this._reserveAttempt(account); }
    catch (error) {
      this.active.delete(account.accountFingerprint);
      throw error;
    }
    if (!reservation.allowed) {
      entry.phase = "daily_limit";
      this._schedule(entry, async () => {
        if (this.stopped) return;
        this.active.delete(account.accountFingerprint);
        await this._ensure(account);
      }, reservation.nextDelayMs);
      return false;
    }
    let started;
    try { started = await this.startLogin({ platform: account.platform, phone: account.phone }); }
    catch { started = null; }
    const sessionId = String(started?.id || "").trim();
    if (!sessionId) {
      await this._terminalFailure(entry, "failed");
      return false;
    }
    entry.sessionId = sessionId;
    entry.startedAt = normalizeDate(this.now).getTime();
    entry.phase = "polling";
    await this._persistStatus(account, normalizeSessionStatus(started?.status));
    this._schedule(entry, () => this._poll(entry), 0);
    return true;
  }

  /**
   * 对当前账号快照执行一次协调。返回值只有计数，不包含手机号、session 或二维码。
   */
  async reconcileAccounts(rows) {
    if (this.stopped) return { candidates: 0, started: 0, active: 0 };
    await this._loadState();
    const candidates = new Map();
    const verifiedFingerprints = new Set();
    for (const row of Array.isArray(rows) ? rows : []) {
      const platform = platformCode(row?.platform);
      const phone = validPhone(row?.phone);
      if (!SUPPORTED_PLATFORMS.has(platform) || !phone) continue;
      const accountFingerprint = publisherLoginAccountFingerprint(platform, phone);
      const authState = String(row?.authState || "").trim().toLowerCase();
      if (RECOVERABLE_AUTH_STATES.has(authState)) {
        candidates.set(accountFingerprint, { platform, phone, accountFingerprint });
      } else if (authState === "verified") {
        verifiedFingerprints.add(accountFingerprint);
      }
    }
    for (const fingerprint of verifiedFingerprints) this._clearEntry(fingerprint);
    let started = 0;
    for (const account of candidates.values()) {
      if (await this._ensure(account)) started += 1;
    }
    return { candidates: candidates.size, started, active: this.active.size };
  }

  async status() {
    const state = await this._loadState();
    return {
      active: this.active.size,
      records: state.records.map((record) => ({
        platform: record.platform,
        accountFingerprint: record.accountFingerprint,
        sessionStatus: record.sessionStatus,
        attemptDay: record.attemptDay,
        attemptCount: record.attemptCount,
        updatedAt: record.updatedAt,
      })),
    };
  }

  async stop() {
    if (!this.stopped) {
      this.stopped = true;
      for (const fingerprint of [...this.active.keys()]) this._clearEntry(fingerprint);
    }
    await Promise.allSettled([...this.inFlight]);
    await this.mutation.catch(() => {});
  }
}

export function createPublisherLoginRecovery(options) {
  return new PublisherLoginRecovery(options);
}
