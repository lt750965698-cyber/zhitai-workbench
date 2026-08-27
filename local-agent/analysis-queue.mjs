import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const ACTIVE = new Set(["queued", "running", "retry_wait", "paused"]);
const TERMINAL = new Set(["completed", "needs_attention", "cancelled"]);

function isoNow(clock) {
  return new Date(clock()).toISOString();
}

function publicJob(job) {
  return {
    id: job.id,
    assetId: job.assetId,
    title: job.title,
    category: job.category ?? null,
    priority: Number(job.priority) || 0,
    status: job.status,
    progress: Number(job.progress) || 0,
    attempts: Number(job.attempts) || 0,
    maxAttempts: Number(job.maxAttempts) || 4,
    nextAttemptAt: job.nextAttemptAt ?? null,
    error: job.error ?? null,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt ?? null,
  };
}

function cleanAsset(input) {
  const assetId = String(input?.assetId || input?.id || "").trim();
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(assetId)) return null;
  return {
    assetId,
    title: String(input?.title || "未命名视频").replace(/\s+/g, " ").trim().slice(0, 240) || "未命名视频",
    category: String(input?.category || "其他").replace(/\s+/g, " ").trim().slice(0, 40) || "其他",
    priority: Math.max(-100, Math.min(100, Number(input?.priority) || 0)),
  };
}

export class AnalysisQueue {
  constructor({
    filePath,
    analyze,
    onEvent = async () => {},
    retryDelaysMs = [30_000, 2 * 60_000, 10 * 60_000],
    maxAttempts = 4,
    clock = () => Date.now(),
  }) {
    this.filePath = filePath;
    this.analyze = analyze;
    this.onEvent = onEvent;
    this.retryDelaysMs = retryDelaysMs.map((value) => Math.max(0, Number(value) || 0));
    this.maxAttempts = Math.max(1, Math.min(10, Number(maxAttempts) || 4));
    this.clock = clock;
    this.mutation = Promise.resolve();
    this.draining = false;
    this.timer = null;
    this.activeJobId = null;
  }

  async init() {
    await mkdir(dirname(this.filePath), { recursive: true });
    await this.#mutate((jobs) => {
      for (const job of jobs) {
        if (job.status === "running") {
          job.status = "queued";
          job.progress = 0;
          job.nextAttemptAt = null;
          job.error = null;
          job.updatedAt = isoNow(this.clock);
        }
      }
      return null;
    });
    this.#scheduleDrain();
  }

  async list() {
    return (await this.#read()).map(publicJob);
  }

  async counts() {
    const jobs = await this.list();
    const count = (status) => jobs.filter((job) => job.status === status).length;
    return {
      total: jobs.length,
      queued: count("queued"),
      running: count("running"),
      retryWait: count("retry_wait"),
      paused: count("paused"),
      completed: count("completed"),
      needsAttention: count("needs_attention"),
      remaining: jobs.filter((job) => ACTIVE.has(job.status) || job.status === "needs_attention").length,
    };
  }

  async enqueueMany(inputs, { maxAttempts = this.maxAttempts } = {}) {
    const rows = (Array.isArray(inputs) ? inputs : []).map(cleanAsset).filter(Boolean);
    const result = await this.#mutate((jobs) => {
      const created = [];
      const existing = [];
      for (const input of rows) {
        const duplicate = jobs.find((job) => job.assetId === input.assetId && (ACTIVE.has(job.status) || TERMINAL.has(job.status)));
        if (duplicate) {
          existing.push(publicJob(duplicate));
          continue;
        }
        const now = isoNow(this.clock);
        const job = {
          id: `analysis_${randomUUID()}`,
          ...input,
          status: "queued",
          progress: 0,
          attempts: 0,
          maxAttempts: Math.max(1, Math.min(10, Number(maxAttempts) || this.maxAttempts)),
          nextAttemptAt: null,
          error: null,
          createdAt: now,
          updatedAt: now,
        };
        jobs.push(job);
        created.push(publicJob(job));
      }
      return { created, existing };
    });
    this.#scheduleDrain();
    return result;
  }

  async pause(id) {
    return this.#change(id, (job) => {
      if (!["queued", "retry_wait"].includes(job.status)) return;
      job.status = "paused";
      job.nextAttemptAt = null;
      job.updatedAt = isoNow(this.clock);
    });
  }

  async resume(id) {
    const job = await this.#change(id, (row) => {
      if (!["paused", "needs_attention"].includes(row.status)) return;
      row.status = "queued";
      row.progress = 0;
      row.nextAttemptAt = null;
      row.error = null;
      row.updatedAt = isoNow(this.clock);
    });
    this.#scheduleDrain();
    return job;
  }

  async retry(id) {
    return this.resume(id);
  }

  async cancel(id) {
    return this.#change(id, (job) => {
      if (["completed", "cancelled"].includes(job.status)) return;
      if (job.status === "running") throw new Error("analysis_job_running");
      job.status = "cancelled";
      job.progress = 0;
      job.nextAttemptAt = null;
      job.error = null;
      job.updatedAt = isoNow(this.clock);
    });
  }

  async #change(id, updater) {
    return this.#mutate((jobs) => {
      const row = jobs.find((job) => job.id === id);
      if (!row) throw new Error("analysis_job_not_found");
      updater(row);
      return publicJob(row);
    });
  }

  #scheduleDrain(delayMs = 0) {
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(0, delayMs);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.#drain();
    }, delay);
    // A queued job must keep a short-lived process alive long enough to start
    // its first drain. Only long retry waits are safe to detach: the persisted
    // retry state can be resumed when the local agent starts again.
    if (delay > 0) this.timer.unref?.();
  }

  async #drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      while (true) {
        const jobs = await this.#read();
        const now = this.clock();
        const eligible = jobs
          .filter((job) => job.status === "queued" || (job.status === "retry_wait" && Date.parse(String(job.nextAttemptAt || "")) <= now))
          .sort((left, right) => (Number(right.priority) || 0) - (Number(left.priority) || 0)
            || String(left.createdAt).localeCompare(String(right.createdAt)));
        const queued = eligible[0];
        if (!queued) {
          const next = jobs
            .filter((job) => job.status === "retry_wait")
            .map((job) => Date.parse(String(job.nextAttemptAt || "")))
            .filter((value) => Number.isFinite(value) && value > now)
            .sort((a, b) => a - b)[0];
          if (next) this.#scheduleDrain(Math.min(2_147_000_000, Math.max(50, next - now)));
          break;
        }

        await this.#change(queued.id, (row) => {
          row.status = "running";
          row.progress = 10;
          row.attempts = (Number(row.attempts) || 0) + 1;
          row.nextAttemptAt = null;
          row.error = null;
          row.updatedAt = isoNow(this.clock);
        });
        this.activeJobId = queued.id;
        try {
          const result = await this.analyze(queued.assetId);
          if (!result?.ok) throw new Error(result?.error || "analysis_result_not_persisted");
          await this.#change(queued.id, (row) => {
            if (result.canonicalAssetId) row.assetId = result.canonicalAssetId;
            row.status = "completed";
            row.progress = 100;
            row.nextAttemptAt = null;
            row.error = null;
            row.completedAt = isoNow(this.clock);
            row.updatedAt = row.completedAt;
          });
          await this.onEvent("completed", queued.assetId, queued.id, result);
        } catch (error) {
          const current = (await this.#read()).find((job) => job.id === queued.id) || queued;
          const attempts = Number(current.attempts) || 1;
          const allowed = Number(current.maxAttempts) || this.maxAttempts;
          const message = String(error?.message || error || "分析失败").replace(/\s+/g, " ").slice(0, 300);
          const retry = attempts < allowed;
          const delay = this.retryDelaysMs[Math.min(this.retryDelaysMs.length - 1, Math.max(0, attempts - 1))] || 0;
          await this.#change(queued.id, (row) => {
            row.status = retry ? "retry_wait" : "needs_attention";
            row.progress = 0;
            row.error = message;
            row.nextAttemptAt = retry ? new Date(this.clock() + delay).toISOString() : null;
            row.updatedAt = isoNow(this.clock);
          });
          await this.onEvent(retry ? "retry" : "failed", queued.assetId, queued.id, error);
        } finally {
          if (this.activeJobId === queued.id) this.activeJobId = null;
        }
      }
    } finally {
      this.draining = false;
      const jobs = await this.#read();
      if (jobs.some((job) => job.status === "queued")) this.#scheduleDrain();
    }
  }

  async #read() {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, "utf8"));
      return Array.isArray(parsed) ? parsed : [];
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

export { ACTIVE as ACTIVE_ANALYSIS_STATES };
