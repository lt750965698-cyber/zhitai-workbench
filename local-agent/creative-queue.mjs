import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { remediateToOriginalWorkflow } from "./originality-remediation.mjs";
import { assessGenerationReadiness } from "./seedance-workflow.mjs";

const ACTIVE = new Set(["queued", "preparing", "paused", "ready_for_images", "ready_for_seedance", "ready_for_assembly"]);
const ACTIONS = new Set(["images_ready", "seedance_ready", "complete"]);

function isoNow() { return new Date().toISOString(); }

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
  }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    await this.#mutate((jobs) => {
      for (const job of jobs) {
        if (job.status === "preparing") {
          job.status = "queued";
          job.stage = "analysis";
          job.progress = 0;
          job.error = null;
          job.updatedAt = isoNow();
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
        if (!["queued", "preparing", "paused", "ready_for_images", "ready_for_seedance", "ready_for_assembly", "failed"].includes(job.status)) continue;
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
          job.updatedAt = isoNow();
          repaired += 1;
        } else if (job.status === "failed" && state?.ready === true) {
          job.status = "ready_for_images";
          job.stage = "gpt_images";
          job.progress = 40;
          job.error = null;
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
      if (!["queued", "preparing"].includes(row.status)) return;
      row.status = "paused";
      row.progress = Math.min(95, Number(row.progress) || 0);
      row.updatedAt = isoNow();
    });
    if (this.activeJobId === id) this.controller?.abort();
    return job;
  }

  async resume(id) {
    const job = await this.#change(id, (row) => {
      if (!["paused", "failed"].includes(row.status)) return;
      row.status = "queued";
      row.stage = "analysis";
      row.progress = 0;
      row.error = null;
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
      row.error = null;
      row.updatedAt = isoNow();
    });
    if (this.activeJobId === id) this.controller?.abort();
    return job;
  }

  async advance(id, action, output = null) {
    if (!ACTIONS.has(action)) throw new Error("invalid_creative_action");
    return this.#change(id, (row) => {
      if (action === "images_ready" && row.status === "ready_for_images") {
        row.status = "ready_for_seedance";
        row.stage = "seedance";
        row.progress = 65;
      } else if (action === "seedance_ready" && row.status === "ready_for_seedance") {
        row.status = "ready_for_assembly";
        row.stage = "assembly";
        row.progress = 90;
      } else if (action === "complete" && row.status === "ready_for_assembly") {
        row.status = "completed";
        row.stage = "completed";
        row.progress = 100;
        row.generationId = output?.generationId ?? row.generationId ?? null;
        row.outputMediaUrl = output?.mediaUrl ?? row.outputMediaUrl ?? null;
      } else if (action === "complete" && row.status === "completed" && output) {
        // 兼容升级前已经完成、但尚未登记回知识库的任务。
        row.generationId = output.generationId ?? row.generationId ?? null;
        row.outputMediaUrl = output.mediaUrl ?? row.outputMediaUrl ?? null;
      }
      row.updatedAt = isoNow();
    });
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

  #scheduleDrain() {
    queueMicrotask(() => { void this.#drain(); });
  }

  async #drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (true) {
        const queued = (await this.#read()).filter((job) => job.status === "queued").sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
        if (!queued) break;
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
            row.updatedAt = isoNow();
          });
          await this.onEvent("ready", canonicalAssetId, queued.id);
        } catch (error) {
          const aborted = controller.signal.aborted || error?.name === "AbortError";
          await this.#change(queued.id, (row) => {
            if (row.status !== "preparing") return;
            row.status = aborted ? "paused" : "failed";
            row.progress = aborted ? row.progress : 0;
            row.error = aborted ? null : String(error?.message || error || "分析失败").slice(0, 300);
            row.updatedAt = isoNow();
          });
          if (!aborted) await this.onEvent("failed", queued.assetId, queued.id, error);
        } finally {
          if (this.activeJobId === queued.id) {
            this.activeJobId = null;
            this.controller = null;
          }
        }
      }
    } finally {
      this.draining = false;
      if ((await this.#read()).some((job) => job.status === "queued")) this.#scheduleDrain();
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
