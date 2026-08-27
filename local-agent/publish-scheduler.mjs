import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

export const PUBLISH_TASK_STATUSES = Object.freeze([
  "scheduled",
  "queued",
  "preflighting",
  "submitting",
  "public",
  "platform_draft",
  "submitted_unverified",
  "needs_attention",
  "needs_reconciliation",
  "cancelled",
]);

const STORE_VERSION = 1;
const MAX_TIMER_DELAY_MS = 2_147_000_000;
const EXTERNAL_TARGET_STATUSES = new Set(["public", "draft", "submitted", "unknown"]);
const TERMINAL_TASK_STATUSES = new Set([
  "public",
  "platform_draft",
  "submitted_unverified",
  "needs_attention",
  "needs_reconciliation",
  "cancelled",
]);

/**
 * Build a stable opaque task id for one logical future-publish request.
 * Callers must put only fingerprints (never raw account credentials) in identity.
 */
export function deterministicPublishScheduleId(kind, scheduledAt, identity) {
  const canonicalTime = new Date(parseTime(scheduledAt, "scheduled_at")).toISOString();
  const digest = createHash("sha256")
    .update(JSON.stringify({ kind: String(kind || "publish"), scheduledAt: canonicalTime, identity }))
    .digest("hex")
    .slice(0, 32);
  return `publish_${digest}`;
}

function historyTimestamp(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" || /^\d+$/.test(String(value))) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    const milliseconds = numeric < 10_000_000_000 ? numeric * 1_000 : numeric;
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function cleanHistoryText(value, limit = 1_000) {
  return String(value ?? "")
    .replace(/\b1\d{10}\b/g, "[account]")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, limit);
}

/** Normalize the real Matrix 0.11 history shape without claiming publication. */
export function normalizeMatrixHistoryRecord(row = {}) {
  const platform = String(row?.platform || row?.pt || "unknown");
  const rawStatus = String(row?.publishStatus || row?.status || "").trim().toLowerCase();
  const platformMessage = cleanHistoryText(
    row?.lastMessage ?? row?.lastPublishMessage ?? row?.message ?? "",
  );
  const combined = `${rawStatus} ${platformMessage}`.toLowerCase();
  let state;
  if (/waiting[_\s-]*schedule|scheduled|等待定时发布/.test(combined)) state = "scheduled";
  else if (/保存草稿成功|saved?[_\s-]*draft|platform[_\s-]*draft|草稿/.test(combined) || row?.publishToDraft === true) state = "draft";
  else if (/fail|error|rejected|失败/.test(combined)) state = "failed";
  else if (/\bpublic\b|\bpublished\b|已公开|发布完成/.test(combined)) state = "public";
  else if (/success|processing|submit|accepted|queued|ok/.test(combined)) state = "submitted";
  else state = "unknown";
  const createdAt = historyTimestamp(row?.lastAt ?? row?.createTime ?? row?.lastPublishAt);
  const scheduledAt = historyTimestamp(row?.scheduledPublishAt);
  const id = String(row?.id || row?.taskId || "");
  return {
    source: "matrix_history",
    id,
    taskId: id,
    platform,
    rawAccount: row?.partition || row?.phone || row?.account || null,
    title: cleanHistoryText(row?.title || row?.bookName || row?.name || "", 500),
    mode: state === "draft" ? "draft" : state === "scheduled" ? "scheduled" : "public",
    state,
    status: state,
    publishStatus: rawStatus || "unknown",
    scheduledAt,
    platformMessage,
    time: createdAt,
    createdAt,
    created_at: createdAt,
    ...(state === "scheduled" ? { schedulerState: "scheduler_inactive" } : {}),
  };
}

export class PublishSchedulerConflictError extends Error {
  constructor(code, taskId) {
    super(code);
    this.name = "PublishSchedulerConflictError";
    this.code = code;
    this.statusCode = 409;
    this.taskId = taskId;
  }
}

function cloneJson(value, label = "value") {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) return null;
    return JSON.parse(encoded);
  } catch {
    throw new Error(`publish_scheduler_${label}_not_json`);
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Fail closed when the files/workflow found at execution differ from approval time. */
export function assertPublishScheduleBinding(expected, actual) {
  if (!expected || typeof expected !== "object" || Array.isArray(expected)) {
    throw new Error("publish_schedule_binding_missing");
  }
  if (!actual || typeof actual !== "object" || Array.isArray(actual)
    || canonicalJson(expected) !== canonicalJson(actual)) {
    throw new Error("publish_schedule_binding_mismatch");
  }
  return true;
}

function cloneResult(value) {
  try { return cloneJson(value, "result"); }
  catch { return { unpersistable: true }; }
}

function stripScheduledAt(value) {
  if (Array.isArray(value)) return value.map(stripScheduledAt);
  if (!value || typeof value !== "object") return value;
  const clean = {};
  for (const [key, child] of Object.entries(value)) {
    // Due-time execution must publish immediately. Never leak either the
    // scheduler's canonical field or MatrixMedia's CLI-facing alias back into
    // the executor, otherwise it can create another short-lived app-local job.
    if (key === "scheduledAt" || key === "publishAt") continue;
    clean[key] = stripScheduledAt(child);
  }
  return clean;
}

function parseTime(value, label) {
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(parsed)) throw new Error(`invalid_${label}`);
  return parsed;
}

function safeError(error, fallback = "publish_target_failed") {
  return String(error?.message || error || fallback)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .slice(0, 500);
}

function targetHasExternalReceipt(target) {
  return Boolean(target?.externalReceiptAt) || EXTERNAL_TARGET_STATUSES.has(String(target?.status || ""));
}

function taskHasExternalReceipt(task) {
  return Array.isArray(task?.targets) && task.targets.some(targetHasExternalReceipt);
}

function normalizeTargetResult(result) {
  const explicit = typeof result === "string" ? result : result?.status;
  const status = String(explicit || "").trim().toLowerCase();
  let normalized;
  if (["public", "published"].includes(status) || result?.published === true || result?.public === true) {
    normalized = "public";
  } else if (["draft", "platform_draft"].includes(status) || result?.draft === true) {
    normalized = "draft";
  } else if (["submitted", "accepted", "queued"].includes(status) || result?.submitted === true) {
    normalized = "submitted";
  } else if (["unknown", "unverified", "submitted_unverified"].includes(status)) {
    normalized = "unknown";
  } else if (["needs_reconciliation", "reconcile"].includes(status)) {
    normalized = "needs_reconciliation";
  } else if (["failed", "failure", "error", "rejected"].includes(status) || result?.ok === false) {
    normalized = "failed";
  } else if (result?.ok === true) {
    // “接口接收成功”不等于平台公开成功；保守记录为待核实提交。
    normalized = "submitted";
  } else {
    normalized = "unknown";
  }
  return {
    status: normalized,
    receipt: cloneResult(result),
    error: normalized === "failed" ? safeError(result?.error || result?.message) : null,
    externalReceipt: result?.externalReceipt === true || Boolean(result?.observedState),
  };
}

function aggregateTaskStatus(task) {
  const statuses = task.targets.map((target) => target.status);
  if (statuses.some((status) => status === "submitting" || status === "needs_reconciliation")) {
    return "needs_reconciliation";
  }
  if (statuses.some((status) => status === "failed" || status === "pending")) return "needs_attention";
  if (statuses.some((status) => status === "unknown" || status === "submitted")) return "submitted_unverified";
  // A platform draft is a durable external receipt, but it is not a successful
  // outcome for a target that was explicitly requested as public. Keep the
  // receipt protected from retries while surfacing the task for review.
  if (task.targets.some((target) => target.status === "draft" && target.definition?.expectedMode === "public")) {
    return "needs_attention";
  }
  if (statuses.every((status) => status === "draft")) return "platform_draft";
  if (statuses.every((status) => status === "public" || status === "draft")) return "public";
  return "needs_attention";
}

function normalizeStore(value) {
  if (Array.isArray(value)) return { version: STORE_VERSION, revision: 0, tasks: value };
  if (!value || typeof value !== "object" || !Array.isArray(value.tasks)) {
    throw new Error("publish_scheduler_store_invalid");
  }
  return {
    version: STORE_VERSION,
    revision: Number.isSafeInteger(value.revision) ? value.revision : 0,
    tasks: value.tasks,
  };
}

export class PublishScheduler {
  constructor({
    filePath,
    now = () => new Date(),
    setTimeout: setTimer = globalThis.setTimeout,
    clearTimeout: clearTimer = globalThis.clearTimeout,
    preflight = async () => ({ ok: true }),
    executeTarget,
    gracePeriodMs = 20 * 60_000,
    lockStaleMs = 30_000,
  }) {
    if (!filePath) throw new Error("publish_scheduler_file_path_required");
    if (typeof executeTarget !== "function") throw new Error("publish_scheduler_execute_target_required");
    this.filePath = filePath;
    this.lockPath = `${filePath}.lock`;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.preflight = preflight;
    this.executeTarget = executeTarget;
    this.gracePeriodMs = Math.max(1, Number(gracePeriodMs) || 1);
    this.lockStaleMs = Math.max(1_000, Number(lockStaleMs) || 30_000);
    this.ownerId = `scheduler_${randomUUID()}`;
    this.timers = new Map();
    this.running = new Map();
    this.initialized = false;
    this.stopped = false;
  }

  #nowMs() {
    const value = this.now();
    const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
    if (!Number.isFinite(parsed)) throw new Error("publish_scheduler_now_invalid");
    return parsed;
  }

  #nowIso() {
    return new Date(this.#nowMs()).toISOString();
  }

  async init() {
    if (this.initialized) return this.list();
    this.stopped = false;
    await mkdir(dirname(this.filePath), { recursive: true });
    const tasks = await this.#mutate((store) => {
      const nowMs = this.#nowMs();
      const nowIso = new Date(nowMs).toISOString();
      for (const task of store.tasks) {
        const interruptedTarget = task.targets?.some((target) => target.status === "submitting");
        if (task.status === "submitting" || interruptedTarget) {
          for (const target of task.targets || []) {
            if (target.status === "submitting") {
              target.status = "needs_reconciliation";
              target.error = "submission_interrupted_before_receipt";
              target.updatedAt = nowIso;
            }
          }
          task.status = "needs_reconciliation";
          task.error = "submission_interrupted_before_receipt";
          task.claim = null;
          task.updatedAt = nowIso;
          continue;
        }
        if (task.status === "preflighting" || task.status === "queued") {
          // Preflight has no external side effect, so it is safe to recover after restart.
          task.status = "queued";
          task.claim = null;
          task.updatedAt = nowIso;
        }
        if (["scheduled", "queued"].includes(task.status) && nowMs > Date.parse(task.expiresAt)) {
          task.status = "needs_attention";
          task.error = "schedule_expired";
          task.claim = null;
          task.updatedAt = nowIso;
        }
      }
      return cloneJson(store.tasks);
    });
    this.initialized = true;
    for (const task of tasks) {
      if (["scheduled", "queued"].includes(task.status)) await this.#arm(task.id);
    }
    return tasks;
  }

  async schedule({ id = `publish_${randomUUID()}`, scheduledAt, expiresAt = null, payload = null, targets }) {
    const cleanId = String(id || "").trim();
    if (!/^[A-Za-z0-9._:-]{1,200}$/.test(cleanId)) throw new Error("invalid_publish_task_id");
    const scheduledMs = parseTime(scheduledAt, "scheduled_at");
    const expiresMs = expiresAt == null ? scheduledMs + this.gracePeriodMs : parseTime(expiresAt, "expires_at");
    if (expiresMs < scheduledMs) throw new Error("invalid_expires_at");
    if (!Array.isArray(targets) || targets.length === 0) throw new Error("publish_targets_required");
    const ids = new Set();
    const persistedTargets = targets.map((definition, index) => {
      const cloned = cloneJson(definition, "target");
      const targetId = String(cloned?.id || cloned?.platform || `target_${index + 1}`).trim();
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(targetId)) throw new Error("invalid_publish_target_id");
      if (ids.has(targetId)) throw new Error("duplicate_publish_target_id");
      ids.add(targetId);
      return {
        id: targetId,
        definition: cloned,
        status: "pending",
        attempts: 0,
        receipt: null,
        error: null,
        externalReceiptAt: null,
        updatedAt: null,
      };
    });
    const nowIso = this.#nowIso();
    const task = {
      id: cleanId,
      status: "scheduled",
      scheduledAt: new Date(scheduledMs).toISOString(),
      expiresAt: new Date(expiresMs).toISOString(),
      payload: cloneJson(payload, "payload"),
      targets: persistedTargets,
      preflight: null,
      claim: null,
      error: null,
      createdAt: nowIso,
      updatedAt: nowIso,
      finishedAt: null,
      cancelledAt: null,
    };
    const saved = await this.#mutate((store) => {
      if (store.tasks.some((candidate) => candidate.id === cleanId)) {
        throw new PublishSchedulerConflictError("publish_task_id_conflict", cleanId);
      }
      store.tasks.push(task);
      return cloneJson(task);
    });
    if (!this.stopped) await this.#arm(cleanId);
    return saved;
  }

  /**
   * Idempotent scheduling for callers that supply a deterministic task id.
   * A duplicate request returns the already persisted task and never arms a
   * second independent task.
   */
  async scheduleIdempotent(input) {
    try {
      return await this.schedule(input);
    } catch (error) {
      if (!(error instanceof PublishSchedulerConflictError) || error.code !== "publish_task_id_conflict") {
        throw error;
      }
      const existing = await this.get(input?.id);
      if (!existing) throw error;
      return { ...existing, deduplicated: true };
    }
  }

  async list() {
    const store = await this.#readStore();
    return cloneJson(store.tasks).sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)));
  }

  async get(taskId) {
    const store = await this.#readStore();
    const task = store.tasks.find((candidate) => candidate.id === String(taskId));
    return task ? cloneJson(task) : null;
  }

  async cancel(taskId) {
    const id = String(taskId);
    const result = await this.#mutate((store) => {
      const task = store.tasks.find((candidate) => candidate.id === id);
      if (!task) throw new Error("publish_task_not_found");
      if (task.status === "cancelled") return cloneJson(task);
      if (task.status === "submitting") {
        throw new PublishSchedulerConflictError("publish_task_submitting_conflict", id);
      }
      if (task.status === "needs_reconciliation" || task.targets.some((target) => target.status === "needs_reconciliation")) {
        throw new PublishSchedulerConflictError("publish_task_reconciliation_conflict", id);
      }
      if (taskHasExternalReceipt(task)) {
        throw new PublishSchedulerConflictError("publish_task_external_receipt_conflict", id);
      }
      const nowIso = this.#nowIso();
      task.status = "cancelled";
      task.claim = null;
      task.error = null;
      task.cancelledAt = nowIso;
      task.finishedAt = nowIso;
      task.updatedAt = nowIso;
      return cloneJson(task);
    });
    this.#clearTaskTimer(id);
    return result;
  }

  async retry(taskId, { expiresAt = null } = {}) {
    const id = String(taskId);
    const result = await this.#mutate((store) => {
      const task = store.tasks.find((candidate) => candidate.id === id);
      if (!task) throw new Error("publish_task_not_found");
      if (task.status !== "needs_attention") {
        throw new PublishSchedulerConflictError("publish_task_not_retryable", id);
      }
      let retryable = task.targets.filter((target) => target.status === "failed" && !target.externalReceiptAt);
      if (!retryable.length && !taskHasExternalReceipt(task)) {
        // Expiry and preflight failures happen before any platform side effect;
        // their pending targets are safe to re-queue after an explicit retry.
        retryable = task.targets.filter((target) => target.status === "pending");
      }
      if (!retryable.length) throw new PublishSchedulerConflictError("publish_task_no_retryable_targets", id);
      const nowMs = this.#nowMs();
      const expiresMs = expiresAt == null ? nowMs + this.gracePeriodMs : parseTime(expiresAt, "expires_at");
      if (expiresMs < nowMs) throw new Error("invalid_expires_at");
      for (const target of retryable) {
        target.status = "pending";
        target.receipt = null;
        target.error = null;
        target.externalReceiptAt = null;
        target.updatedAt = new Date(nowMs).toISOString();
      }
      task.status = "queued";
      task.scheduledAt = new Date(nowMs).toISOString();
      task.expiresAt = new Date(expiresMs).toISOString();
      task.claim = null;
      task.error = null;
      task.finishedAt = null;
      task.updatedAt = new Date(nowMs).toISOString();
      return cloneJson(task);
    });
    if (!this.stopped) await this.#arm(id);
    return result;
  }

  run(taskId) {
    const id = String(taskId);
    if (this.running.has(id)) return this.running.get(id);
    const promise = this.#runClaimed(id).finally(() => {
      if (this.running.get(id) === promise) this.running.delete(id);
    });
    this.running.set(id, promise);
    return promise;
  }

  async waitForIdle(taskId = null) {
    while (true) {
      const pending = taskId == null
        ? [...this.running.values()]
        : [this.running.get(String(taskId))].filter(Boolean);
      if (!pending.length) return;
      await Promise.allSettled(pending);
    }
  }

  stop() {
    this.stopped = true;
    for (const handle of this.timers.values()) this.clearTimer(handle);
    this.timers.clear();
  }

  async #runClaimed(taskId) {
    const claimToken = `claim_${randomUUID()}`;
    const claimed = await this.#mutate((store) => {
      const task = store.tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error("publish_task_not_found");
      if (!["scheduled", "queued"].includes(task.status) || task.claim) {
        return { action: "skip", task: cloneJson(task) };
      }
      const nowMs = this.#nowMs();
      const scheduledMs = Date.parse(task.scheduledAt);
      if (nowMs < scheduledMs) return { action: "future", task: cloneJson(task) };
      if (nowMs > Date.parse(task.expiresAt)) {
        const nowIso = new Date(nowMs).toISOString();
        task.status = "needs_attention";
        task.error = "schedule_expired";
        task.finishedAt = nowIso;
        task.updatedAt = nowIso;
        return { action: "expired", task: cloneJson(task) };
      }
      const nowIso = new Date(nowMs).toISOString();
      task.status = "queued";
      task.claim = { token: claimToken, ownerId: this.ownerId, claimedAt: nowIso };
      task.updatedAt = nowIso;
      return { action: "claimed", task: cloneJson(task) };
    });
    if (claimed.action === "future") {
      await this.#arm(taskId);
      return claimed.task;
    }
    if (claimed.action !== "claimed") {
      if (TERMINAL_TASK_STATUSES.has(claimed.task.status)) this.#clearTaskTimer(taskId);
      return claimed.task;
    }

    const preflighting = await this.#mutate((store) => {
      const task = store.tasks.find((candidate) => candidate.id === taskId);
      if (!task || task.status !== "queued" || task.claim?.token !== claimToken) return null;
      task.status = "preflighting";
      task.updatedAt = this.#nowIso();
      return cloneJson(task);
    });
    if (!preflighting) return this.get(taskId);

    let preflightResult;
    try {
      preflightResult = await this.preflight(this.#preflightInvocation(preflighting));
    } catch (error) {
      return this.#failPreflight(taskId, claimToken, error);
    }
    const accepted = preflightResult !== false && preflightResult?.ok !== false;
    if (!accepted) {
      return this.#failPreflight(taskId, claimToken, preflightResult?.error || preflightResult?.reason || "preflight_failed", preflightResult);
    }

    const ready = await this.#mutate((store) => {
      const task = store.tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error("publish_task_not_found");
      if (task.status === "cancelled") return { action: "cancelled", task: cloneJson(task) };
      if (task.status !== "preflighting" || task.claim?.token !== claimToken) {
        return { action: "lost", task: cloneJson(task) };
      }
      const nowMs = this.#nowMs();
      if (nowMs > Date.parse(task.expiresAt)) {
        const nowIso = new Date(nowMs).toISOString();
        task.status = "needs_attention";
        task.error = "schedule_expired_after_preflight";
        task.claim = null;
        task.preflight = { ok: true, result: cloneResult(preflightResult), checkedAt: nowIso };
        task.finishedAt = nowIso;
        task.updatedAt = nowIso;
        return { action: "expired", task: cloneJson(task) };
      }
      const targetIds = task.targets.filter((target) => target.status === "pending").map((target) => target.id);
      const nowIso = new Date(nowMs).toISOString();
      task.preflight = { ok: true, result: cloneResult(preflightResult), checkedAt: nowIso };
      task.status = targetIds.length ? "submitting" : aggregateTaskStatus(task);
      task.error = null;
      task.updatedAt = nowIso;
      if (!targetIds.length) {
        task.claim = null;
        task.finishedAt = nowIso;
      }
      return { action: targetIds.length ? "submit" : "complete", targetIds, task: cloneJson(task) };
    });
    if (ready.action !== "submit") return ready.task;

    for (const targetId of ready.targetIds) {
      const prepared = await this.#mutate((store) => {
        const task = store.tasks.find((candidate) => candidate.id === taskId);
        if (!task) throw new Error("publish_task_not_found");
        if (task.status === "cancelled") return { action: "cancelled", task: cloneJson(task) };
        if (task.status !== "submitting" || task.claim?.token !== claimToken) {
          return { action: "lost", task: cloneJson(task) };
        }
        const target = task.targets.find((candidate) => candidate.id === targetId);
        if (!target || target.status !== "pending") return { action: "skip", task: cloneJson(task) };
        target.status = "submitting";
        target.attempts = (Number(target.attempts) || 0) + 1;
        target.error = null;
        target.updatedAt = this.#nowIso();
        task.updatedAt = target.updatedAt;
        return { action: "execute", task: cloneJson(task), target: cloneJson(target) };
      });
      if (prepared.action === "cancelled") return prepared.task;
      if (prepared.action !== "execute") continue;

      // Re-read after persisting the target claim. A stale timer never carries a task snapshot
      // into an external executor, and a cancellation cannot be missed between preflight and submit.
      const beforeSubmit = await this.get(taskId);
      if (!beforeSubmit || beforeSubmit.status === "cancelled") return beforeSubmit;

      let outcome;
      try {
        const raw = await this.executeTarget(this.#targetInvocation(beforeSubmit, targetId));
        outcome = normalizeTargetResult(raw);
      } catch (error) {
        outcome = { status: "failed", receipt: null, error: safeError(error) };
      }
      const persisted = await this.#persistTargetOutcome(taskId, targetId, claimToken, outcome);
      // The post-submit read is intentional: if an external actor changed the task to cancelled,
      // preserve the receipt and stop before touching another platform.
      const afterSubmit = await this.get(taskId);
      if (!afterSubmit || afterSubmit.status === "cancelled" || persisted?.stop === true) return afterSubmit;
    }

    return this.#mutate((store) => {
      const task = store.tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error("publish_task_not_found");
      if (task.status === "cancelled") return cloneJson(task);
      if (task.claim?.token !== claimToken && task.status !== "needs_reconciliation") return cloneJson(task);
      const nowIso = this.#nowIso();
      task.status = aggregateTaskStatus(task);
      task.claim = null;
      task.error = task.status === "needs_attention" ? "one_or_more_targets_failed" : null;
      task.finishedAt = nowIso;
      task.updatedAt = nowIso;
      return cloneJson(task);
    });
  }

  async #failPreflight(taskId, claimToken, error, result = null) {
    return this.#mutate((store) => {
      const task = store.tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error("publish_task_not_found");
      if (task.status === "cancelled") return cloneJson(task);
      if (task.status !== "preflighting" || task.claim?.token !== claimToken) return cloneJson(task);
      const nowIso = this.#nowIso();
      task.status = "needs_attention";
      task.claim = null;
      task.preflight = { ok: false, result: cloneResult(result), checkedAt: nowIso };
      task.error = safeError(error, "preflight_failed");
      task.finishedAt = nowIso;
      task.updatedAt = nowIso;
      return cloneJson(task);
    });
  }

  async #persistTargetOutcome(taskId, targetId, claimToken, outcome) {
    return this.#mutate((store) => {
      const task = store.tasks.find((candidate) => candidate.id === taskId);
      if (!task) throw new Error("publish_task_not_found");
      const target = task.targets.find((candidate) => candidate.id === targetId);
      if (!target) throw new Error("publish_target_not_found");
      const nowIso = this.#nowIso();
      target.status = outcome.status;
      target.receipt = outcome.receipt;
      target.error = outcome.error;
      target.externalReceiptAt = outcome.externalReceipt === true || EXTERNAL_TARGET_STATUSES.has(outcome.status) ? nowIso : null;
      target.updatedAt = nowIso;
      task.updatedAt = nowIso;
      if (outcome.status === "needs_reconciliation") {
        task.status = "needs_reconciliation";
        task.error = outcome.error || "platform_requested_reconciliation";
        task.claim = null;
        return { stop: true, task: cloneJson(task) };
      }
      if (task.status === "cancelled") {
        task.status = "needs_reconciliation";
        task.error = "receipt_arrived_after_cancellation";
        task.claim = null;
        return { stop: true, task: cloneJson(task) };
      }
      if (task.claim?.token !== claimToken || task.status !== "submitting") {
        task.status = "needs_reconciliation";
        task.error = "receipt_arrived_after_claim_lost";
        task.claim = null;
        return { stop: true, task: cloneJson(task) };
      }
      return { stop: outcome.status === "needs_reconciliation", task: cloneJson(task) };
    });
  }

  #preflightInvocation(task) {
    return stripScheduledAt({
      taskId: task.id,
      payload: task.payload,
      targets: task.targets.map((target) => ({ id: target.id, ...target.definition })),
    });
  }

  #targetInvocation(task, targetId) {
    const target = task.targets.find((candidate) => candidate.id === targetId);
    return stripScheduledAt({
      taskId: task.id,
      targetId,
      target: target?.definition || null,
      payload: task.payload,
      attempt: target?.attempts || 1,
      preflight: task.preflight?.result ?? null,
    });
  }

  async #arm(taskId) {
    if (this.stopped) return;
    const task = await this.get(taskId);
    if (!task || !["scheduled", "queued"].includes(task.status)) {
      this.#clearTaskTimer(taskId);
      return;
    }
    this.#clearTaskTimer(taskId);
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(0, Date.parse(task.scheduledAt) - this.#nowMs()));
    const handle = this.setTimer(() => {
      this.timers.delete(taskId);
      if (!this.stopped) void this.run(taskId);
    }, delay);
    handle?.unref?.();
    this.timers.set(taskId, handle);
  }

  #clearTaskTimer(taskId) {
    const handle = this.timers.get(taskId);
    if (handle !== undefined) this.clearTimer(handle);
    this.timers.delete(taskId);
  }

  async #readStore() {
    try {
      return normalizeStore(JSON.parse(await readFile(this.filePath, "utf8")));
    } catch (error) {
      if (error?.code === "ENOENT") return { version: STORE_VERSION, revision: 0, tasks: [] };
      throw error;
    }
  }

  async #writeStore(store) {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      await rename(tempPath, this.filePath);
      await chmod(this.filePath, 0o600).catch(() => {});
    } finally {
      await unlink(tempPath).catch(() => {});
    }
  }

  async #mutate(updater) {
    const release = await this.#acquireLock();
    try {
      const store = await this.#readStore();
      const result = await updater(store);
      store.revision = (Number(store.revision) || 0) + 1;
      await this.#writeStore(store);
      return result;
    } finally {
      await release();
    }
  }

  async #acquireLock() {
    await mkdir(dirname(this.filePath), { recursive: true });
    const startedAt = Date.now();
    while (true) {
      try {
        await mkdir(this.lockPath);
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          await rmdir(this.lockPath).catch(() => {});
        };
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        try {
          const info = await stat(this.lockPath);
          if (Date.now() - info.mtimeMs > this.lockStaleMs) {
            await rmdir(this.lockPath).catch(() => {});
            continue;
          }
        } catch (statError) {
          if (statError?.code === "ENOENT") continue;
          throw statError;
        }
        if (Date.now() - startedAt > this.lockStaleMs * 2) throw new Error("publish_scheduler_lock_timeout");
        await sleep(5);
      }
    }
  }
}
