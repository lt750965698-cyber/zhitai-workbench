import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { remediateToOriginalWorkflow } from "./originality-remediation.mjs";
import { assessGenerationReadiness } from "./seedance-workflow.mjs";

const READY_STATUSES = new Set(["ready_for_images", "ready_for_seedance", "ready_for_assembly"]);
const RESUMABLE_STATUSES = new Set(["queued", ...READY_STATUSES]);
// needs_attention 仍然是同一个未完成任务；继续对同一素材 create 必须去重，
// 否则会丢掉网页生成断点并重复生图。
const ACTIVE = new Set([
  "queued", "preparing", "retry_wait", "transient_wait", "paused", "failed", "needs_attention",
  ...READY_STATUSES,
]);
const ACTIONS = new Set(["images_ready", "seedance_ready", "complete"]);
// 网页端偶发 busy 只做有界断点重试。连续三次仍未恢复时，继续自动
// 唤醒通常只会重复填充同一个输入框，因此升级为 needs_attention。
const MAX_CONSECUTIVE_TRANSIENT_RETRIES = 3;

function isoNow() { return new Date().toISOString(); }

function isTransientSqliteBusy(error) {
  return error?.errcode === 5
    || error?.errcode === 517
    || /(?:database is locked|SQLITE_BUSY)/i.test(String(error?.message || error || ""));
}

function sqliteRetryDelayMs(retryCount) {
  return Math.min(30_000, 500 * (2 ** Math.min(Math.max(0, retryCount - 1), 6)));
}

function inferredResumeStatus(job) {
  if (RESUMABLE_STATUSES.has(job?.resumeStatus)) return job.resumeStatus;
  if (READY_STATUSES.has(job?.status)) return job.status;
  if (job?.stage === "gpt_images") return "ready_for_images";
  if (job?.stage === "seedance") return "ready_for_seedance";
  if (job?.stage === "assembly") return "ready_for_assembly";
  return "queued";
}

function clearAttentionState(row) {
  row.error = null;
  row.attentionAt = null;
  row.attentionTransient = false;
  row.nextRetryAt = null;
  row.resumeStatus = null;
}

function restoreInterruptedState(row, { resetTransientRetryCount = false } = {}) {
  const target = inferredResumeStatus(row);
  row.status = target;
  if (target === "queued") {
    row.stage = "analysis";
    row.progress = 0;
    row.retryAt = null;
  } else if (target === "ready_for_images") {
    row.stage = "gpt_images";
    row.progress = Math.max(40, Number(row.progress) || 0);
  } else if (target === "ready_for_seedance") {
    row.stage = "seedance";
    row.progress = Math.max(65, Number(row.progress) || 0);
  } else if (target === "ready_for_assembly") {
    row.stage = "assembly";
    row.progress = Math.max(90, Number(row.progress) || 0);
  }
  clearAttentionState(row);
  // 只有用户显式 resume/retry 才开始新的一组短重试；计时器自动恢复
  // 必须保留连续次数，否则 queued 断点会永远在 0/1 之间循环。
  if (resetTransientRetryCount) row.transientRetryCount = 0;
}

function retryTimestamp(value, fallbackDelayMs = 30_000) {
  const parsed = Date.parse(String(value || ""));
  if (Number.isFinite(parsed) && parsed > Date.now()) return new Date(parsed).toISOString();
  return new Date(Date.now() + fallbackDelayMs).toISOString();
}

function publicJob(job) {
  return {
    id: job.id,
    assetId: job.assetId,
    title: job.title,
    status: job.status,
    stage: job.stage,
    progress: job.progress,
    targetDurationSeconds: job.targetDurationSeconds ?? null,
    shotCount: job.shotCount ?? null,
    error: job.error ?? null,
    autoCreated: job.autoCreated === true,
    generationId: job.generationId ?? null,
    outputMediaUrl: job.outputMediaUrl ?? null,
    qualityWarnings: Array.isArray(job.qualityWarnings) ? job.qualityWarnings : [],
    originalityMode: job.originalityMode ?? null,
    remediationReasons: Array.isArray(job.remediationReasons) ? job.remediationReasons : [],
    retryAt: job.retryAt ?? null,
    nextRetryAt: job.nextRetryAt ?? null,
    resumeStatus: RESUMABLE_STATUSES.has(job.resumeStatus) ? job.resumeStatus : null,
    attentionAt: job.attentionAt ?? null,
    attentionTransient: job.attentionTransient === true,
    transientRetryCount: Number(job.transientRetryCount) || 0,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

export class CreativeQueue {
  constructor({ filePath, analyze, persistRemediatedWorkflow = null, onEvent = async () => {} }) {
    this.filePath = filePath;
    this.analyze = analyze;
    this.persistRemediatedWorkflow = persistRemediatedWorkflow;
    this.onEvent = onEvent;
    this.mutation = Promise.resolve();
    this.draining = false;
    this.controller = null;
    this.activeJobId = null;
    this.retryTimer = null;
    this.retryTimerAt = 0;
  }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    await this.#mutate((jobs) => {
      for (const job of jobs) {
        if (job.status === "preparing" || job.status === "retry_wait"
          || (job.status === "failed" && isTransientSqliteBusy(job.error))) {
          job.status = "queued";
          job.stage = "analysis";
          job.progress = 0;
          job.error = null;
          job.retryAt = null;
          job.updatedAt = isoNow();
        }
        if (["needs_attention", "transient_wait"].includes(job.status)) {
          job.resumeStatus = inferredResumeStatus(job);
          job.attentionAt = job.attentionAt || job.updatedAt || isoNow();
          job.attentionTransient = job.status === "transient_wait";
          if (job.status === "transient_wait") job.nextRetryAt = retryTimestamp(job.nextRetryAt, 1_000);
        }
      }
      return null;
    });
    this.#scheduleDrain();
  }

  async list() {
    const jobs = await this.#read();
    return jobs.map(publicJob);
  }

  // 旧队列可能早于知识库迁移：assetId 已换成 kb_mig_*，或任务已经走到
  // ready_for_images 但复刻方案没有真正写回。启动时回读数据库并把这类任务
  // 安全地退回分析阶段；绝不在缺少持久结果时继续驱动 GPT。
  async reconcile(inspect) {
    if (typeof inspect !== "function") return { repaired: 0, remapped: 0 };
    let repaired = 0;
    let remapped = 0;
    await this.#mutate(async (jobs) => {
      for (const job of jobs) {
        if (!["queued", "preparing", "retry_wait", "paused", "ready_for_images", "ready_for_seedance", "ready_for_assembly", "failed"].includes(job.status)) continue;
        const state = await inspect(publicJob(job));
        if (state?.assetId && state.assetId !== job.assetId) {
          job.assetId = state.assetId;
          remapped += 1;
        }
        if (["ready_for_images", "ready_for_seedance", "ready_for_assembly"].includes(job.status) && state?.ready !== true) {
          job.status = "queued";
          job.stage = "analysis";
          job.progress = 0;
          job.error = null;
          job.retryAt = null;
          job.updatedAt = isoNow();
          repaired += 1;
        } else if (job.status === "failed" && state?.ready === true) {
          job.status = "ready_for_images";
          job.stage = "gpt_images";
          job.progress = 40;
          job.error = null;
          job.retryAt = null;
          job.transientRetryCount = 0;
          job.updatedAt = isoNow();
          repaired += 1;
        }
      }
      return null;
    });
    this.#scheduleDrain();
    return { repaired, remapped };
  }

  async create({ assetId, title, autoCreated = false }) {
    const cleanId = String(assetId || "").trim();
    if (!/^[A-Za-z0-9._-]{1,160}$/.test(cleanId)) throw new Error("invalid_asset_id");
    const result = await this.#mutate((jobs) => {
      const existing = jobs.find((job) => job.assetId === cleanId && ACTIVE.has(job.status));
      if (existing) return { job: publicJob(existing), deduplicated: true };
      const now = isoNow();
      const job = {
        id: `creative_${randomUUID()}`,
        assetId: cleanId,
        title: String(title || "未命名视频").trim().slice(0, 240) || "未命名视频",
        status: "queued",
        stage: "analysis",
        progress: 0,
        error: null,
        autoCreated: autoCreated === true,
        createdAt: now,
        updatedAt: now,
      };
      jobs.unshift(job);
      return { job: publicJob(job), deduplicated: false };
    });
    this.#scheduleDrain();
    return result;
  }

  async pause(id) {
    const job = await this.#change(id, (row) => {
      if (!["queued", "preparing", "retry_wait", "transient_wait"].includes(row.status)) return;
      row.resumeStatus = inferredResumeStatus(row);
      row.status = "paused";
      row.progress = Math.min(95, Number(row.progress) || 0);
      row.nextRetryAt = null;
      row.attentionTransient = false;
      row.updatedAt = isoNow();
    });
    if (this.activeJobId === id) this.controller?.abort();
    return job;
  }

  async resume(id) {
    const job = await this.#change(id, (row) => {
      if (!["paused", "failed", "needs_attention", "transient_wait"].includes(row.status)) return;
      restoreInterruptedState(row, { resetTransientRetryCount: true });
      row.updatedAt = isoNow();
    });
    this.#scheduleDrain();
    return job;
  }

  async cancel(id) {
    const job = await this.#change(id, (row) => {
      if (["completed", "cancelled"].includes(row.status)) return;
      row.status = "cancelled";
      row.progress = 0;
      clearAttentionState(row);
      row.retryAt = null;
      row.updatedAt = isoNow();
    });
    if (this.activeJobId === id) this.controller?.abort();
    return job;
  }

  async advance(id, action, output = null) {
    if (!ACTIONS.has(action)) throw new Error("invalid_creative_action");
    return this.#change(id, (row) => {
      // transient_wait 表示桌面执行器仍在对同一断点做短重试。如果它在
      // nextRetryAt 之前已成功，advance 就是权威成功回执，可直接推进而不必等计时器。
      const effectiveStatus = row.status === "transient_wait" ? inferredResumeStatus(row) : row.status;
      let advanced = false;
      if (action === "images_ready" && effectiveStatus === "ready_for_images") {
        row.status = "ready_for_seedance";
        row.stage = "seedance";
        row.progress = 65;
        advanced = true;
      } else if (action === "seedance_ready" && effectiveStatus === "ready_for_seedance") {
        row.status = "ready_for_assembly";
        row.stage = "assembly";
        row.progress = 90;
        advanced = true;
      } else if (action === "complete" && effectiveStatus === "ready_for_assembly") {
        row.status = "completed";
        row.stage = "completed";
        row.progress = 100;
        row.generationId = output?.generationId ?? row.generationId ?? null;
        row.outputMediaUrl = output?.mediaUrl ?? row.outputMediaUrl ?? null;
        advanced = true;
      } else if (action === "complete" && row.status === "completed" && output) {
        // 兼容升级前已经完成、但尚未登记回知识库的任务。
        row.generationId = output.generationId ?? row.generationId ?? null;
        row.outputMediaUrl = output.mediaUrl ?? row.outputMediaUrl ?? null;
      }
      if (advanced) {
        clearAttentionState(row);
        row.transientRetryCount = 0;
      }
      row.updatedAt = isoNow();
    });
  }

  async attention(id, { error = "网页生成暂时无法继续", transient = false, nextRetryAt = null } = {}) {
    const message = String(error || "网页生成暂时无法继续").replace(/\s+/g, " ").trim().slice(0, 300)
      || "网页生成暂时无法继续";
    let wakeAt = null;
    const job = await this.#change(id, (row) => {
      if (["completed", "cancelled"].includes(row.status)) return;
      const resumeStatus = inferredResumeStatus(row);
      row.resumeStatus = resumeStatus;
      row.error = message;
      row.attentionAt = isoNow();
      row.updatedAt = row.attentionAt;
      if (transient) {
        row.transientRetryCount = (Number(row.transientRetryCount) || 0) + 1;
        if (row.transientRetryCount >= MAX_CONSECUTIVE_TRANSIENT_RETRIES) {
          row.status = "needs_attention";
          row.attentionTransient = false;
          row.nextRetryAt = null;
          row.error = `${message}（连续 ${MAX_CONSECUTIVE_TRANSIENT_RETRIES} 次短重试未恢复，已停止自动重试）`.slice(0, 300);
        } else {
          row.status = "transient_wait";
          row.attentionTransient = true;
          row.nextRetryAt = retryTimestamp(nextRetryAt);
          wakeAt = row.nextRetryAt;
        }
      } else {
        row.status = "needs_attention";
        row.attentionTransient = false;
        row.nextRetryAt = null;
      }
    });
    if (this.activeJobId === id) this.controller?.abort();
    if (wakeAt) this.#scheduleDrain(Math.max(0, Date.parse(wakeAt) - Date.now()));
    return job;
  }

  async #change(id, updater) {
    const result = await this.#mutate((jobs) => {
      const row = jobs.find((job) => job.id === id);
      if (!row) throw new Error("creative_job_not_found");
      updater(row);
      return publicJob(row);
    });
    return result;
  }

  #scheduleDrain(delayMs = 0) {
    if (delayMs <= 0) {
      queueMicrotask(() => { void this.#drain(); });
      return;
    }
    const targetAt = Date.now() + delayMs;
    if (this.retryTimer && this.retryTimerAt <= targetAt) return;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimerAt = targetAt;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.retryTimerAt = 0;
      void this.#drain();
    }, delayMs);
    this.retryTimer.unref?.();
  }

  async #drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (true) {
        const jobs = await this.#read();
        let queued = jobs.filter((job) => job.status === "queued").sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        if (!queued) {
          const wakeups = [
            ...jobs.filter((job) => job.status === "retry_wait").map((job) => ({
              job,
              kind: "analysis_retry",
              at: Number.isFinite(Date.parse(String(job.retryAt || ""))) ? Date.parse(String(job.retryAt)) : 0,
            })),
            ...jobs.filter((job) => job.status === "transient_wait").map((job) => ({
              job,
              kind: "creative_retry",
              at: Number.isFinite(Date.parse(String(job.nextRetryAt || ""))) ? Date.parse(String(job.nextRetryAt)) : 0,
            })),
          ].sort((a, b) => a.at - b.at);
          const wakeup = wakeups[0];
          if (!wakeup) break;
          const waitMs = Math.max(0, wakeup.at - Date.now());
          if (waitMs > 0) {
            this.#scheduleDrain(waitMs);
            break;
          }
          await this.#change(wakeup.job.id, (row) => {
            if (wakeup.kind === "creative_retry") {
              if (row.status !== "transient_wait") return;
              restoreInterruptedState(row);
            } else {
              if (row.status !== "retry_wait") return;
              row.status = "queued";
              row.stage = "analysis";
              row.retryAt = null;
            }
            row.updatedAt = isoNow();
          });
          // 网页阶段恢复后不由本队列重新生图，只把原断点重新暴露给
          // 桌面执行器；分析阶段的 retry_wait 则仍由本队列继续。
          if (wakeup.kind === "creative_retry") continue;
          queued = (await this.#read()).find((job) => job.id === wakeup.job.id);
          if (!queued || queued.status !== "queued") continue;
        }
        await this.#change(queued.id, (row) => {
          row.status = "preparing";
          row.stage = "analysis";
          row.progress = 15;
          row.error = null;
          row.updatedAt = isoNow();
        });
        const controller = new AbortController();
        this.controller = controller;
        this.activeJobId = queued.id;
        try {
          const result = await this.analyze(queued.assetId, { signal: controller.signal });
          const canonicalAssetId = /^[A-Za-z0-9._-]{1,160}$/.test(String(result?.canonicalAssetId || ""))
            ? String(result.canonicalAssetId)
            : queued.assetId;
          let workflow = result?.remakePlan?.seedanceWorkflow || result?.seedanceWorkflow || {};
          const recovery = remediateToOriginalWorkflow(workflow, { title: queued.title });
          if (recovery.changed) {
            if (typeof this.persistRemediatedWorkflow !== "function") {
              throw new Error("原创补救已生成，但缺少持久化接口；为避免继续使用旧配音/旧提示词，本任务未推进");
            }
            recovery.workflow.generationReadiness = assessGenerationReadiness(recovery.workflow);
            const saved = await this.persistRemediatedWorkflow(canonicalAssetId, recovery.workflow, {
              jobId: queued.id,
              result,
              signal: controller.signal,
            });
            if (saved?.ok === false) throw new Error(saved.error || "原创补救方案持久化失败");
            workflow = saved?.workflow || recovery.workflow;
          }
          const readiness = workflow?.generationReadiness?.ready === false || workflow?.generationReadiness?.ready === true
            ? (recovery.changed ? assessGenerationReadiness(workflow) : workflow.generationReadiness)
            : assessGenerationReadiness(workflow);
          if (!readiness.ready) {
            throw new Error(`生成前质量门未通过：${readiness.blockers.join("；") || "提示词需要重新分析"}`);
          }
          await this.#change(queued.id, (row) => {
            if (row.status !== "preparing") return;
            row.assetId = canonicalAssetId;
            row.status = "ready_for_images";
            row.stage = "gpt_images";
            row.progress = 40;
            row.targetDurationSeconds = Number(workflow.targetDurationSeconds) || null;
            row.shotCount = Number(workflow.shotCount) || (Array.isArray(workflow.shots) ? workflow.shots.length : null);
            row.qualityWarnings = [
              ...(Array.isArray(readiness.warnings) ? readiness.warnings : []),
              ...(workflow?.originality?.status === "remediated"
                ? [`已自动转入完全原创补救：${(workflow.originality.reasonLabels || []).join("、") || "严格原创策略"}`]
                : []),
            ].slice(0, 12);
            row.originalityMode = workflow?.mode ?? null;
            row.remediationReasons = Array.isArray(workflow?.originality?.reasons) ? workflow.originality.reasons.slice(0, 12) : [];
            row.error = null;
            row.retryAt = null;
            row.transientRetryCount = 0;
            row.updatedAt = isoNow();
          });
          await this.onEvent("ready", canonicalAssetId, queued.id);
        } catch (error) {
          const aborted = controller.signal.aborted || error?.name === "AbortError";
          const sqliteBusy = !aborted && isTransientSqliteBusy(error);
          let retryDelay = 0;
          await this.#change(queued.id, (row) => {
            if (row.status !== "preparing") return;
            row.status = aborted ? "paused" : sqliteBusy ? "retry_wait" : "failed";
            row.progress = aborted ? row.progress : sqliteBusy ? 10 : 0;
            if (sqliteBusy) {
              row.transientRetryCount = (Number(row.transientRetryCount) || 0) + 1;
              retryDelay = sqliteRetryDelayMs(row.transientRetryCount);
              row.retryAt = new Date(Date.now() + retryDelay).toISOString();
              row.error = `SQLITE_BUSY 写锁竞争，已安排自动重试：${String(error?.message || error || "database is locked").slice(0, 220)}`;
            } else {
              row.retryAt = null;
              row.error = aborted ? null : String(error?.message || error || "分析失败").slice(0, 300);
            }
            row.updatedAt = isoNow();
          });
          if (sqliteBusy) {
            this.#scheduleDrain(retryDelay);
            await this.onEvent("retry", queued.assetId, queued.id, error);
          } else if (!aborted) {
            await this.onEvent("failed", queued.assetId, queued.id, error);
          }
        } finally {
          if (this.activeJobId === queued.id) {
            this.activeJobId = null;
            this.controller = null;
          }
        }
      }
    } finally {
      this.draining = false;
      const jobs = await this.#read();
      if (jobs.some((job) => job.status === "queued")) {
        this.#scheduleDrain();
      } else {
        const wakeAt = jobs.flatMap((job) => job.status === "retry_wait" ? [Date.parse(String(job.retryAt || ""))]
          : job.status === "transient_wait" ? [Date.parse(String(job.nextRetryAt || ""))] : [])
          .filter(Number.isFinite)
          .sort((a, b) => a - b)[0];
        if (Number.isFinite(wakeAt)) this.#scheduleDrain(Math.max(0, wakeAt - Date.now()));
      }
    }
  }

  async #read() {
    try {
      const value = JSON.parse(await readFile(this.filePath, "utf8"));
      return Array.isArray(value) ? value : [];
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }

  async #write(jobs) {
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temp, `${JSON.stringify(jobs, null, 2)}\n`, "utf8");
    await rename(temp, this.filePath);
  }

  async #mutate(fn) {
    const task = this.mutation.catch(() => {}).then(async () => {
      const jobs = await this.#read();
      const result = await fn(jobs);
      await this.#write(jobs);
      return result;
    });
    this.mutation = task.then(() => undefined, () => undefined);
    return task;
  }
}
