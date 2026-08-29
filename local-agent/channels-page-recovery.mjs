const DEFAULT_MONITOR_INTERVAL_MS = 5_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_RECOVERY_TIMEOUT_MS = 20_000;
const DEFAULT_COOLDOWN_MS = 60_000;

function positiveMilliseconds(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`channels_page_recovery_${name}_invalid`);
  }
  return Math.floor(value);
}

function clockMilliseconds(value) {
  const candidate = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(candidate)) throw new Error("channels_page_recovery_clock_invalid");
  return candidate;
}

function publicState(value) {
  return {
    online: value?.online === true,
    available: value?.online === true && value?.available === true,
  };
}

function result(ok, outcome, state, extra = {}) {
  return {
    ok,
    outcome,
    state: publicState(state),
    ...extra,
  };
}

/**
 * Validate the deliberately small status contract returned by `probe`.
 * `available` implies that the engine is online; contradictory input is rejected
 * instead of allowing a green status that cannot be true.
 */
export function normalizeChannelsPageProbe(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.online !== "boolean" || typeof value.available !== "boolean"
    || (value.available && !value.online)) {
    throw new Error("channels_page_recovery_probe_invalid");
  }
  return { online: value.online, available: value.available };
}

/**
 * Supervise the browser-backed WeChat Channels page connection.
 *
 * Injection contract:
 * - probe({ signal }) -> { online, available }
 * - requestRecovery({ signal, reason, state }) asks the host to perform its safe,
 *   non-coordinate recovery action. Its return value is never success evidence.
 *
 * This module intentionally contains no GUI coordinates and no guessed deep
 * link. A recovery is reported only after a later probe observes `available`.
 */
export class ChannelsPageRecoverySupervisor {
  constructor({
    probe,
    requestRecovery,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    monitorIntervalMs = DEFAULT_MONITOR_INTERVAL_MS,
    pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
    recoveryTimeoutMs = DEFAULT_RECOVERY_TIMEOUT_MS,
    cooldownMs = DEFAULT_COOLDOWN_MS,
  } = {}) {
    for (const [name, callback] of Object.entries({ probe, requestRecovery, now, setTimer, clearTimer })) {
      if (typeof callback !== "function") throw new Error(`channels_page_recovery_${name}_required`);
    }

    this.probe = probe;
    this.requestRecovery = requestRecovery;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.monitorIntervalMs = positiveMilliseconds(monitorIntervalMs, "monitorIntervalMs");
    this.pollIntervalMs = positiveMilliseconds(pollIntervalMs, "pollIntervalMs");
    this.recoveryTimeoutMs = positiveMilliseconds(recoveryTimeoutMs, "recoveryTimeoutMs");
    this.cooldownMs = positiveMilliseconds(cooldownMs, "cooldownMs");

    this.running = false;
    this.closed = false;
    this.monitorTimer = null;
    this.waits = new Set();
    this.tickPromise = null;
    this.stopPromise = null;
    this.abortController = new AbortController();

    this.lastOnline = null;
    this.lastState = { online: false, available: false };
    this.lastOutcome = "idle";
    this.lastCheckedAt = null;
    this.lastRecoveryAt = null;
    this.lastRecoveredAt = null;
    this.cooldownUntilMs = 0;

    this.stopSignal = new Promise((resolve) => {
      this.resolveStopSignal = resolve;
    });
  }

  _nowMs() {
    return clockMilliseconds(this.now());
  }

  _iso(milliseconds) {
    return new Date(milliseconds).toISOString();
  }

  async _interruptible(operation) {
    const task = Promise.resolve()
      .then(operation)
      .then(
        (value) => ({ stopped: false, value }),
        (error) => ({ stopped: false, error }),
      );
    return Promise.race([
      task,
      this.stopSignal.then(() => ({ stopped: true })),
    ]);
  }

  async _readProbe() {
    const settled = await this._interruptible(() => this.probe({ signal: this.abortController.signal }));
    if (settled.stopped) return { stopped: true };

    const checkedAt = this._nowMs();
    let state;
    let valid = true;
    if (settled.error) {
      valid = false;
      state = { online: false, available: false };
    } else {
      try {
        state = normalizeChannelsPageProbe(settled.value);
      } catch {
        valid = false;
        state = { online: false, available: false };
      }
    }

    const onlineEdge = valid && state.online && this.lastOnline === false;
    this.lastOnline = valid ? state.online : false;
    this.lastState = state;
    this.lastCheckedAt = this._iso(checkedAt);
    return { stopped: false, valid, onlineEdge, state, checkedAt };
  }

  _sleep(milliseconds) {
    if (this.closed) return Promise.resolve(false);
    return new Promise((resolve) => {
      const entry = {
        handle: null,
        done: false,
        finish: (completed) => {
          if (entry.done) return;
          entry.done = true;
          this.waits.delete(entry);
          resolve(completed);
        },
      };
      this.waits.add(entry);
      entry.handle = this.setTimer(() => entry.finish(true), milliseconds);
      entry.handle?.unref?.();
      if (this.closed) {
        if (entry.handle !== null && entry.handle !== undefined) this.clearTimer(entry.handle);
        entry.finish(false);
      }
    });
  }

  _stoppedResult() {
    this.lastOutcome = "stopped";
    return result(false, "stopped", this.lastState, { code: "stopped" });
  }

  async _tick({ force = false, reason = "monitor" } = {}) {
    if (this.closed) return this._stoppedResult();

    const first = await this._readProbe();
    if (first.stopped || this.closed) return this._stoppedResult();
    if (!first.valid) {
      this.lastOutcome = "probe_failed";
      return result(false, "probe_failed", first.state, {
        code: "channels_page_probe_failed",
      });
    }
    if (!first.state.online) {
      this.lastOutcome = "offline";
      return result(false, "offline", first.state, {
        code: "channels_engine_offline",
      });
    }
    if (first.state.available) {
      this.cooldownUntilMs = 0;
      this.lastOutcome = "connected";
      return result(true, "connected", first.state, {
        code: "channels_page_available",
      });
    }

    const bypassCooldown = force === true || first.onlineEdge;
    if (!bypassCooldown && first.checkedAt < this.cooldownUntilMs) {
      this.lastOutcome = "cooldown";
      return result(false, "cooldown", first.state, {
        code: "channels_page_recovery_cooldown",
        retryAt: this._iso(this.cooldownUntilMs),
      });
    }

    const startedAt = first.checkedAt;
    this.lastRecoveryAt = this._iso(startedAt);
    this.cooldownUntilMs = startedAt + this.cooldownMs;
    this.lastOutcome = "recovering";

    const requestedReason = typeof reason === "string" && reason.trim()
      ? reason.trim().slice(0, 120)
      : first.onlineEdge
        ? "engine_online"
        : "page_unavailable";
    const action = await this._interruptible(() => this.requestRecovery({
      signal: this.abortController.signal,
      reason: requestedReason,
      state: publicState(first.state),
    }));
    if (action.stopped || this.closed) return this._stoppedResult();
    const actionFailed = Boolean(action.error);

    const deadlineAt = startedAt + this.recoveryTimeoutMs;
    let current = first;
    while (!this.closed && this._nowMs() < deadlineAt) {
      const waitMs = Math.min(this.pollIntervalMs, deadlineAt - this._nowMs());
      if (!await this._sleep(waitMs)) return this._stoppedResult();

      current = await this._readProbe();
      if (current.stopped || this.closed) return this._stoppedResult();
      if (current.valid && current.state.available) {
        this.cooldownUntilMs = 0;
        this.lastOutcome = "recovered";
        this.lastRecoveredAt = this._iso(current.checkedAt);
        return result(true, "recovered", current.state, {
          code: "channels_page_recovered",
        });
      }
    }

    this.lastOutcome = "timeout";
    return result(false, "timeout", current.state, {
      code: "channels_page_recovery_timeout",
      action: actionFailed ? "failed" : "requested",
    });
  }

  tick(options = {}) {
    if (this.tickPromise) return this.tickPromise;
    const operation = this._tick(options).finally(() => {
      if (this.tickPromise === operation) this.tickPromise = null;
    });
    this.tickPromise = operation;
    return operation;
  }

  _scheduleMonitor(delayMs) {
    if (!this.running || this.closed) return;
    if (this.monitorTimer !== null) this.clearTimer(this.monitorTimer);
    this.monitorTimer = this.setTimer(() => {
      this.monitorTimer = null;
      this.tick({ reason: "monitor" }).catch(() => {}).finally(() => {
        if (this.running && !this.closed) this._scheduleMonitor(this.monitorIntervalMs);
      });
    }, Math.max(0, Math.floor(delayMs)));
    this.monitorTimer?.unref?.();
  }

  start() {
    if (this.closed || this.running) return false;
    this.running = true;
    this._scheduleMonitor(0);
    return true;
  }

  stop() {
    if (this.stopPromise) return this.stopPromise;
    this.stopPromise = (async () => {
      this.running = false;
      this.closed = true;
      this.abortController.abort();
      this.resolveStopSignal();
      if (this.monitorTimer !== null) {
        this.clearTimer(this.monitorTimer);
        this.monitorTimer = null;
      }
      for (const entry of [...this.waits]) {
        if (entry.handle !== null && entry.handle !== undefined) this.clearTimer(entry.handle);
        entry.finish(false);
      }
      await this.tickPromise?.catch(() => {});
    })();
    return this.stopPromise;
  }

  status() {
    const nowMs = this._nowMs();
    return {
      ok: this.lastState.online && this.lastState.available,
      outcome: this.lastOutcome,
      state: publicState(this.lastState),
      running: this.running,
      stopped: this.closed,
      inFlight: Boolean(this.tickPromise),
      cooldownUntil: this.cooldownUntilMs > nowMs ? this._iso(this.cooldownUntilMs) : null,
      lastCheckedAt: this.lastCheckedAt,
      lastRecoveryAt: this.lastRecoveryAt,
      lastRecoveredAt: this.lastRecoveredAt,
    };
  }
}

export function createChannelsPageRecoverySupervisor(options) {
  return new ChannelsPageRecoverySupervisor(options);
}
