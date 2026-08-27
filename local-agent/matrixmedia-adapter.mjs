/* 织台 · MatrixMedia 受管外置引擎适配层
 * 只调用用户自行取得并安装到本机私有运行目录的官方 CLI，不启动独立 GUI、不监听 30088、Dock 不出现。
 * 账号、历史、登录会话仍沿用 MatrixMedia 官方数据格式和自动化引擎。
 */
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";

export const MATRIX_BINARY = process.env.ZHITAI_MATRIX_BINARY
  || join(homedir(), ".local", "share", "zhitai-runtime", "engines", "matrixmedia.app", "Contents", "MacOS", "matrixmedia");
const CLI_TIMEOUT_MS = 120_000;
const PTY_WRAPPER = "/usr/bin/script";
const loginSessions = new Map();
const receiptMutationQueues = new Map();
const MATRIX_PARTITIONS = join(homedir(), "Library", "Application Support", "matrix-video", "Partitions");
const SESSION_PLATFORMS = [
  { suffix: "抖音", code: "dy", platform: "抖音", cookie: "passport_assist_user" },
  { suffix: "视频号", code: "sph", platform: "视频号", cookie: "sessionid" },
];

export const PLATFORMS = [
  { code: "dy", name: "抖音", automated: true },
  { code: "tt", name: "今日头条", automated: true },
  { code: "ks", name: "快手", automated: true },
  { code: "blbl", name: "哔哩哔哩", automated: true },
  { code: "bjh", name: "百家号", automated: true },
  { code: "sph", name: "视频号", automated: true },
  { code: "xhs", name: "小红书", automated: true },
  { code: "fqsp", name: "番茄视频", automated: false, note: "官方引擎暂不支持自动化" },
];

export const CREATIVE_STATEMENTS = [
  { value: "none", label: "无" },
  { value: "ai_generated", label: "AI 生成" },
  { value: "fiction", label: "虚构内容" },
  { value: "marketing", label: "营销内容" },
  { value: "personal_opinion", label: "个人观点" },
  { value: "repost", label: "转载" },
  { value: "self_made_no_repost", label: "自制且禁止转载", onlyPlatforms: ["blbl"] },
];

// CLI 输出可能是日志 + JSON 混合；提取 JSON（数组或对象）
export function extractJson(out) {
  const trimmed = String(out || "").trim();
  if (!trimmed) return null;
  try { return JSON.parse(trimmed); } catch { /* fallthrough */ }
  // pretty JSON 数组可能跨多行，且 MatrixMedia 会在数组后继续打印
  // `[startup] ...`。不能用 lastIndexOf("]")，否则会把日志的右括号当成
  // JSON 结尾。只接受与顶层 `[` 缩进相同、独占一行的 `]`。
  const lines = trimmed.split(/\r?\n/);
  const arrayStart = lines.findIndex((line) => /^\s*\[$/.test(line));
  if (arrayStart >= 0) {
    const indent = /^\s*/.exec(lines[arrayStart])?.[0] || "";
    const arrayEnd = lines.findIndex((line, index) => index > arrayStart && line === `${indent}]`);
    if (arrayEnd > arrayStart) {
      try { return JSON.parse(lines.slice(arrayStart, arrayEnd + 1).join("\n")); } catch { /* continue */ }
    }
  }
  // 逐行：cli 的 JSON 是独立行（日志行如 [startup] ... 无法 parse）
  for (const line of trimmed.split(/\r?\n/)) {
    const l = line.trim();
    if (!l) continue;
    if (l.startsWith("[") || l.startsWith("{")) {
      try { return JSON.parse(l); } catch { /* try next line */ }
    }
  }
  return null;
}

export const PUBLISH_RECEIPT_STATES = Object.freeze([
  "submitted",
  "scheduled",
  "draft",
  "public",
  "failed",
  "unknown",
]);

const PUBLISH_RECEIPT_MODES = new Set(["public", "draft", "scheduled"]);
const PUBLISH_RECEIPT_STATE_SET = new Set(PUBLISH_RECEIPT_STATES);

/**
 * 发布模式是调用意图，不等于平台终态。草稿优先于排期；公开调用只有拿到
 * 平台明确的 published/public 回执后，状态才允许升级为 public。
 */
export function publishModeFor({ draft = false, scheduledAt = null, publishAt = null } = {}) {
  if (scheduledAt || publishAt) return "scheduled";
  if (draft === true) return "draft";
  return "public";
}

function canonicalAccountIdentifier(value) {
  if (value && typeof value === "object") {
    if (value.partition) return canonicalAccountIdentifier(value.partition);
    if (value.phone) return canonicalAccountIdentifier(value.phone);
  }
  const raw = String(value || "").trim();
  if (/^acct_[a-f0-9]{24}$/.test(raw)) return raw;
  return raw;
}

/** 账本/API 只保存不可逆账号指纹；真实账号标识仅留在瞬时 CLI 参数中。 */
export function publishAccountFingerprint(platform, value) {
  const canonical = canonicalAccountIdentifier(value);
  if (/^acct_[a-f0-9]{24}$/.test(canonical)) return canonical;
  if (!canonical) throw new Error("publisher_receipt_account_required");
  return `acct_${createHash("sha256").update(`${String(platform || "").trim()}\0${canonical}`).digest("hex").slice(0, 24)}`;
}

function normalizeScheduledAt(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Date.parse(String(value));
  if (Number.isNaN(parsed)) throw new Error("publisher_receipt_scheduled_at_invalid");
  return new Date(parsed).toISOString();
}

function cleanReceiptText(value, maxLength = 1_000) {
  const clean = String(value ?? "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\b1\d{10}\b/g, "[account]")
    .trim();
  return clean ? clean.slice(0, maxLength) : null;
}

function validResultUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value));
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function resultObjects(parsed) {
  const rows = [];
  const queue = parsed && typeof parsed === "object" ? [parsed] : [];
  const seen = new Set();
  while (queue.length && rows.length < 20) {
    const current = queue.shift();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    if (!Array.isArray(current)) rows.push(current);
    for (const key of ["result", "data", "detail", "response", "receipt"]) {
      const nested = current[key];
      if (nested && typeof nested === "object") queue.push(nested);
    }
  }
  return rows;
}

function firstResultField(objects, keys) {
  for (const object of objects) {
    for (const key of keys) {
      if (object[key] !== null && object[key] !== undefined && object[key] !== "") return object[key];
    }
  }
  return null;
}

function structuredReceiptState(objects) {
  if (objects.some((object) => object.scheduled === true)) return "scheduled";
  const tokens = [];
  for (const object of objects) {
    for (const key of ["state", "resultState", "result_status", "resultStatus", "publishStatus", "publish_status", "status"]) {
      if (typeof object[key] === "string") tokens.push(object[key].trim().toLowerCase().replace(/[\s-]+/g, "_"));
    }
  }
  const includes = (values) => tokens.some((token) => values.includes(token));
  if (includes(["failed", "failure", "error", "rejected", "失败"])) return "failed";
  if (includes(["public", "published", "posted", "live", "已公开", "已发布"])) return "public";
  if (includes(["scheduled", "waiting_schedule", "waiting_scheduled_publish", "等待定时发布"])) return "scheduled";
  if (includes(["draft", "saved_draft", "platform_draft", "草稿", "已存草稿"])) return "draft";
  if (includes(["submitted", "accepted", "processing", "queued", "success", "ok"])) return "submitted";
  return includes(["unknown"]) ? "unknown" : null;
}

/**
 * MatrixMedia 的退出码 0 只能证明 CLI 成功完成，不能证明平台内容已经公开。
 * 只有结构化状态明确写出 published/public 才返回 public。
 */
export function classifyMatrixPublishResult({ code, out = "", err = "" } = {}, { mode = "public" } = {}) {
  const parsed = extractJson(out) || extractJson(err);
  const objects = resultObjects(parsed);
  const explicitState = structuredReceiptState(objects);
  const succeeded = code === 0 || code === "0";
  const savedDraftFallback = code === 4 || code === "4";
  let state;
  if (savedDraftFallback) state = "draft";
  else if (!succeeded) state = "failed";
  else if (explicitState === "public") state = "public";
  else if (explicitState === "failed") state = "failed";
  else if (explicitState === "draft" || mode === "draft") state = "draft";
  else if (explicitState === "scheduled" || mode === "scheduled") state = "scheduled";
  else state = "submitted";

  const taskId = cleanReceiptText(firstResultField(objects, ["taskId", "task_id", "scheduleId", "schedule_id", "platformTaskId", "id"]), 240);
  const postId = cleanReceiptText(firstResultField(objects, ["postId", "post_id", "noteId", "note_id", "itemId", "item_id", "awemeId", "aweme_id"]), 240);
  const resultUrl = validResultUrl(firstResultField(objects, ["resultUrl", "result_url", "postUrl", "post_url", "noteUrl", "note_url", "shareUrl", "share_url", "url"]));
  const parsedMessage = firstResultField(objects, ["platformMessage", "platform_message", "message", "msg"]);
  const platformMessage = cleanReceiptText(parsedMessage ?? err ?? out);
  const accepted = state === "draft"
    ? mode === "draft" && (succeeded || savedDraftFallback)
    : succeeded && !["failed", "unknown"].includes(state);
  return {
    state,
    accepted,
    platformMessage,
    ...(taskId ? { taskId } : {}),
    ...(postId ? { postId } : {}),
    ...(resultUrl ? { resultUrl } : {}),
  };
}

export function publishReceiptDedupeKey({ platform, account, mediaSha256, mode, scheduledAt = null } = {}) {
  const normalizedMode = String(mode || "").trim();
  if (!PUBLISH_RECEIPT_MODES.has(normalizedMode)) throw new Error("publisher_receipt_mode_invalid");
  const sha = String(mediaSha256 || "").trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error("publisher_receipt_media_sha256_invalid");
  const normalizedPlatform = String(platform || "").trim();
  const identity = [
    normalizedPlatform,
    publishAccountFingerprint(normalizedPlatform, account),
    sha,
    normalizedMode,
    normalizeScheduledAt(scheduledAt),
  ];
  if (!identity[0]) throw new Error("publisher_receipt_platform_required");
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function normalizeReceiptInput(input = {}) {
  const content = input.content && typeof input.content === "object" ? input.content : {};
  const mediaSha256 = String(input.mediaSha256 || content.mediaSha256 || "").trim().toLowerCase();
  const mode = String(input.mode || "").trim();
  const scheduledAt = normalizeScheduledAt(input.scheduledAt);
  const platform = String(input.platform || "").trim();
  const account = publishAccountFingerprint(platform, input.account);
  const dedupeKey = publishReceiptDedupeKey({ platform, account, mediaSha256, mode, scheduledAt });
  const state = String(input.state || "unknown").trim();
  if (!PUBLISH_RECEIPT_STATE_SET.has(state)) throw new Error("publisher_receipt_state_invalid");
  const jobId = cleanReceiptText(input.jobId, 240);
  if (!jobId) throw new Error("publisher_receipt_job_required");
  const taskId = cleanReceiptText(input.taskId, 240);
  const platformMessage = cleanReceiptText(input.platformMessage);
  const resultUrl = validResultUrl(input.resultUrl);
  const postId = cleanReceiptText(input.postId, 240);
  return {
    dedupeKey,
    platform,
    account,
    content: {
      id: cleanReceiptText(content.id, 240),
      title: cleanReceiptText(content.title, 500),
      mediaSha256,
    },
    mediaSha256,
    jobId,
    taskId,
    mode,
    scheduledAt,
    state,
    ...(platformMessage ? { platformMessage } : {}),
    ...(resultUrl ? { resultUrl } : {}),
    ...(postId ? { postId } : {}),
  };
}

function cloneReceipt(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeReceiptState(previous, next) {
  if (!next) return previous;
  if (previous === "public" && next !== "public") return previous;
  if (["draft", "scheduled"].includes(previous) && next === "submitted") return previous;
  return next;
}

/**
 * 凭据无关的本地发布回执账本。reserve 会在启动外部 CLI 之前原子占位；进程
 * 异常时留下 unknown，后续同一幂等键不会自动再次触发平台副作用。
 */
export function createPublishReceiptStore({ path, now = () => new Date().toISOString(), idFactory = randomUUID } = {}) {
  if (!path || typeof path !== "string") throw new Error("publisher_receipt_path_required");
  const ledgerPath = resolve(path);
  const lockPath = `${ledgerPath}.lock.sqlite`;

  const nowIso = () => {
    const value = typeof now === "function" ? now() : now;
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) throw new Error("publisher_receipt_clock_invalid");
    return parsed.toISOString();
  };

  const readLedger = async () => {
    let raw;
    try {
      raw = await readFile(ledgerPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") return { version: 1, receipts: [] };
      throw error;
    }
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch { throw new Error("publisher_receipts_invalid_json"); }
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.receipts)) {
      throw new Error("publisher_receipts_invalid_schema");
    }
    return parsed;
  };

  const writeLedger = async (ledger) => {
    await mkdir(dirname(ledgerPath), { recursive: true });
    const temporary = `${ledgerPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(ledger, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, ledgerPath);
  };

  const withLedgerLock = async (operation) => {
    await mkdir(dirname(ledgerPath), { recursive: true });
    let lockDb = null;
    let inTransaction = false;
    try {
      // SQLite 的 OS 级文件锁会在进程退出时自动释放，不需要读取、判断或删除陈旧锁文件。
      // 同进程按 ledgerPath 排队，避免同步 busy wait 阻塞正在执行异步落盘的本进程持锁者。
      lockDb = new DatabaseSync(lockPath);
      await chmod(lockPath, 0o600);
      lockDb.exec("PRAGMA busy_timeout = 2500; BEGIN IMMEDIATE;");
      inTransaction = true;
      const output = await operation();
      lockDb.exec("COMMIT;");
      inTransaction = false;
      return output;
    } catch (error) {
      if (inTransaction) {
        try { lockDb.exec("ROLLBACK;"); } catch { /* close 仍会释放 OS 锁 */ }
      }
      if (/SQLITE_BUSY|database is locked/i.test(String(error?.code || error?.message || ""))) {
        throw new Error("publisher_receipt_store_locked");
      }
      throw error;
    } finally {
      try { lockDb?.close(); } catch { /* 关闭失败也不覆盖原始结果 */ }
    }
  };

  const mutate = (mutator) => {
    const previous = receiptMutationQueues.get(ledgerPath) || Promise.resolve();
    const operation = previous.catch(() => {}).then(() => withLedgerLock(async () => {
        const ledger = await readLedger();
        const output = await mutator(ledger.receipts);
        await writeLedger(ledger);
        return output;
    }));
    const tail = operation.then(() => undefined, () => undefined);
    receiptMutationQueues.set(ledgerPath, tail);
    void tail.then(() => {
      if (receiptMutationQueues.get(ledgerPath) === tail) receiptMutationQueues.delete(ledgerPath);
    });
    return operation;
  };

  return {
    async list() {
      await (receiptMutationQueues.get(ledgerPath) || Promise.resolve());
      const ledger = await readLedger();
      return cloneReceipt(ledger.receipts);
    },

    reserve(input, { retryFailed = false } = {}) {
      const normalized = normalizeReceiptInput(input);
      return mutate((receipts) => {
        const existing = receipts.find((receipt) => receipt.dedupeKey === normalized.dedupeKey);
        if (existing) {
          if (retryFailed === true && existing.state === "failed") {
            existing.state = "unknown";
            existing.attemptCount = Math.max(1, Number(existing.attemptCount || 1)) + 1;
            existing.updatedAt = nowIso();
            return { created: true, retried: true, receipt: cloneReceipt(existing) };
          }
          return { created: false, receipt: cloneReceipt(existing) };
        }
        const timestamp = nowIso();
        const receipt = {
          id: `receipt_${idFactory()}`,
          ...normalized,
          attemptCount: 1,
          createdAt: timestamp,
          updatedAt: timestamp,
        };
        receipts.unshift(receipt);
        return { created: true, receipt: cloneReceipt(receipt) };
      });
    },

    update(id, patch = {}) {
      return mutate((receipts) => {
        const receipt = receipts.find((candidate) => candidate.id === String(id || ""));
        if (!receipt) throw new Error("publisher_receipt_not_found");
        if (patch.state !== undefined) {
          const state = String(patch.state || "").trim();
          if (!PUBLISH_RECEIPT_STATE_SET.has(state)) throw new Error("publisher_receipt_state_invalid");
          receipt.state = mergeReceiptState(receipt.state, state);
        }
        if (patch.platformMessage !== undefined) {
          const value = cleanReceiptText(patch.platformMessage);
          if (value) receipt.platformMessage = value;
          else delete receipt.platformMessage;
        }
        if (patch.taskId !== undefined) receipt.taskId = cleanReceiptText(patch.taskId, 240);
        if (patch.postId !== undefined) {
          const value = cleanReceiptText(patch.postId, 240);
          if (value) receipt.postId = value;
          else delete receipt.postId;
        }
        if (patch.resultUrl !== undefined) {
          const value = validResultUrl(patch.resultUrl);
          if (value) receipt.resultUrl = value;
          else delete receipt.resultUrl;
        }
        receipt.updatedAt = nowIso();
        return cloneReceipt(receipt);
      });
    },
  };
}

export function runCli(args, timeoutMs = CLI_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(MATRIX_BINARY, ["cli", ...args], {
        env: {
          PATH: process.env.PATH || "",
          HOME: process.env.HOME || "",
          LANG: process.env.LANG || "zh_CN.UTF-8",
          MATRIXMEDIA_DISABLE_TELEMETRY: "1",
          // 不继承 ELECTRON_RUN_AS_NODE：让 matrixmedia 以 Electron 模式跑 CLI
        },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      reject(new Error("matrixmedia_cli_spawn:" + e.message));
      return;
    }
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* noop */ }
      reject(new Error("matrixmedia_cli_timeout"));
    }, timeoutMs);
    child.once("error", (e) => { clearTimeout(timer); reject(new Error("matrixmedia_cli_spawn:" + e.message)); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

export async function cliAccounts() {
  const { code, out, err } = await runCli(["accounts", "--json"]);
  if (code !== 0) throw new Error("matrixmedia_cli_accounts_failed：" + String(err || out).slice(-200));
  const parsed = extractJson(out);
  // 官方 `cli login` 以目标 Cookie 落入 persist: 分区并 flush 为成功；
  // `cli accounts` 只遍历 GUI 账号树，纯 CLI 首次登录后可能仍返回 []。
  // 因此补充只读扫描已登录分区的 Cookie 元数据（只查名称/有效期，不读取值），
  // 让织台能显示并使用真实已登录账号，而不是误报“账号未写入”。
  const rows = [...normalizeAccounts(Array.isArray(parsed) ? parsed : []), ...(await discoverSessionAccounts())];
  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.platform}|${row.phone || row.partition || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function sessionAccountFromPartitionName(encodedName) {
  let decoded = "";
  try { decoded = decodeURIComponent(String(encodedName || "")); } catch { return null; }
  for (const definition of SESSION_PLATFORMS) {
    if (!decoded.endsWith(definition.suffix)) continue;
    const phone = decoded.slice(0, -definition.suffix.length);
    // 只自动恢复明确的手机号分区，忽略历史 fixture/测试/自定义名称。
    if (!/^1\d{10}$/.test(phone)) return null;
    return { ...definition, phone, partition: `persist:${decoded}` };
  }
  return null;
}

async function discoverSessionAccounts() {
  let entries = [];
  try { entries = await readdir(MATRIX_PARTITIONS, { withFileTypes: true }); } catch { return []; }
  const accounts = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const definition = sessionAccountFromPartitionName(entry.name);
    if (!definition) continue;
    let db = null;
    try {
      db = new DatabaseSync(join(MATRIX_PARTITIONS, entry.name, "Cookies"), { readOnly: true });
      const valid = db.prepare(`SELECT 1 AS ok FROM cookies
        WHERE name=? AND (length(value)>0 OR length(encrypted_value)>0)
          AND (expires_utc=0 OR expires_utc>((strftime('%s','now')+11644473600)*1000000))
        LIMIT 1`).get(definition.cookie);
      if (valid?.ok) accounts.push({
        platform: definition.platform,
        phone: definition.phone,
        partition: definition.partition,
        loginStatus: "已登录",
        error: null,
      });
    } catch { /* 分区正在切换或不是有效 Cookie DB */ }
    finally { try { db?.close(); } catch { /* noop */ } }
  }
  return accounts;
}

export async function cliHistory() {
  // 官方 history 默认只看 7 天；运营审计固定拉 30 天，避免跨周漏掉仍在等待的排期。
  const { code, out, err } = await runCli(["history", "--json", "--days", "30"]);
  if (code !== 0) throw new Error("matrixmedia_cli_history_failed：" + String(err || out).slice(-200));
  const parsed = extractJson(out);
  return Array.isArray(parsed) ? parsed : [];
}

/** 视频号短标题：6～16 个字，只保留文字和数字；无效时不传该可选参数。 */
export function normalizeChannelsShortTitle(value) {
  const clean = Array.from(String(value || "").normalize("NFKC"))
    .filter((character) => /[\p{L}\p{N}]/u.test(character))
    .join("");
  const characters = Array.from(clean);
  if (characters.length < 6) return null;
  return characters.slice(0, 16).join("");
}

export async function cliPublish(payload) {
  const results = [];
  const mode = publishModeFor({ draft: payload.draft === true, publishAt: payload.publishAt });
  for (const target of payload.platforms) {
    const args = ["publish", "-p", target.platform, "-f", payload.file, "-t", payload.title];
    if (target.phone) args.push("--phone", target.phone);
    if (target.partition) args.push("--partition", target.partition);
    const shortTitle = target.platform === "sph"
      ? normalizeChannelsShortTitle(payload.bt2)
      : payload.bt2;
    if (shortTitle) args.push("--bt2", shortTitle);
    if (Array.isArray(payload.tags) && payload.tags.length) args.push("--tags", payload.tags.join(" "));
    if (payload.publishAt) args.push("--publish-at", payload.publishAt);
    if (payload.draft) args.push("--draft");
    if (target.creativeStatement && target.creativeStatement !== "none") {
      args.push("--creative-statement", target.creativeStatement);
    }
    const { code, out, err } = await runCli(args, 30 * 60_000);
    const receipt = classifyMatrixPublishResult({ code, out, err }, { mode });
    const account = publishAccountFingerprint(target.platform, target);
    results.push({
      platform: target.platform,
      account,
      success: receipt.accepted,
      status: receipt.state,
      state: receipt.state,
      message: receipt.platformMessage,
      platformMessage: receipt.platformMessage,
      ...(receipt.taskId ? { taskId: receipt.taskId } : {}),
      ...(receipt.postId ? { postId: receipt.postId } : {}),
      ...(receipt.resultUrl ? { resultUrl: receipt.resultUrl } : {}),
    });
  }
  return { success: results.every((item) => item.success), total: results.length, results };
}

function receiptResult(receipt, { deduplicated = false, success = null } = {}) {
  const accepted = success === null
    ? !["failed", "unknown"].includes(receipt.state)
    : Boolean(success) && !["failed", "unknown"].includes(receipt.state);
  return {
    platform: receipt.platform,
    account: receipt.account,
    success: accepted,
    status: receipt.state,
    state: receipt.state,
    receiptId: receipt.id,
    deduplicated,
    message: receipt.platformMessage,
    platformMessage: receipt.platformMessage,
    ...(receipt.taskId ? { taskId: receipt.taskId } : {}),
    ...(receipt.postId ? { postId: receipt.postId } : {}),
    ...(receipt.resultUrl ? { resultUrl: receipt.resultUrl } : {}),
  };
}

/**
 * 为每个平台目标先写 unknown 占位，再调用外部发布器。相同幂等键命中时直接
 * 返回既有回执，绝不会再次调用 publish；超时/异常也保留 unknown 供人工核对。
 */
export async function publishWithReceipts({
  payload,
  receiptStore,
  content,
  jobId = null,
  scheduledAt = null,
  retryFailed = false,
  publish = cliPublish,
} = {}) {
  if (!payload || !Array.isArray(payload.platforms)) throw new Error("publisher_payload_platforms_required");
  if (!receiptStore?.reserve || !receiptStore?.update) throw new Error("publisher_receipt_store_required");
  const normalizedScheduledAt = normalizeScheduledAt(scheduledAt || payload.publishAt || null);
  const mode = publishModeFor({ draft: payload.draft === true, scheduledAt: normalizedScheduledAt });
  const effectiveJobId = cleanReceiptText(jobId, 240) || `publish_${randomUUID()}`;
  const slots = new Array(payload.platforms.length);
  const pending = [];

  for (let index = 0; index < payload.platforms.length; index += 1) {
    const target = payload.platforms[index];
    const account = publishAccountFingerprint(target?.platform, target);
    const reservation = await receiptStore.reserve({
      platform: String(target?.platform || "").trim(),
      account,
      content,
      jobId: effectiveJobId,
      mode,
      scheduledAt: normalizedScheduledAt,
    }, { retryFailed });
    if (reservation.created) pending.push({ index, target, receipt: reservation.receipt });
    else slots[index] = receiptResult(reservation.receipt, { deduplicated: true });
  }

  if (pending.length) {
    let body;
    try {
      body = await publish({ ...payload, platforms: pending.map((entry) => entry.target) });
    } catch (error) {
      const platformMessage = cleanReceiptText(error?.message || error) || "matrixmedia_publish_outcome_unknown";
      for (const entry of pending) {
        const receipt = await receiptStore.update(entry.receipt.id, { state: "unknown", platformMessage });
        slots[entry.index] = receiptResult(receipt, { success: false });
      }
      return { success: false, total: slots.length, results: slots, message: platformMessage };
    }

    const rawResults = Array.isArray(body?.results) ? body.results : [];
    for (let pendingIndex = 0; pendingIndex < pending.length; pendingIndex += 1) {
      const entry = pending[pendingIndex];
      const raw = rawResults[pendingIndex];
      if (!raw || typeof raw !== "object") {
        const receipt = await receiptStore.update(entry.receipt.id, {
          state: "unknown",
          platformMessage: "matrixmedia_result_missing",
        });
        slots[entry.index] = receiptResult(receipt, { success: false });
        continue;
      }
      const rawState = String(raw.state || raw.status || "").trim();
      const state = PUBLISH_RECEIPT_STATE_SET.has(rawState)
        ? rawState
        : raw.success === false
          ? "failed"
          : mode === "draft"
            ? "draft"
            : mode === "scheduled"
              ? "scheduled"
              : "submitted";
      const receipt = await receiptStore.update(entry.receipt.id, {
        state,
        platformMessage: raw.platformMessage ?? raw.message ?? null,
        ...(raw.taskId ? { taskId: raw.taskId } : {}),
        ...(raw.postId ? { postId: raw.postId } : {}),
        ...(raw.resultUrl ? { resultUrl: raw.resultUrl } : {}),
      });
      slots[entry.index] = receiptResult(receipt, { success: raw.success !== false });
    }
  }

  return {
    success: slots.every((result) => result?.success === true),
    total: slots.length,
    results: slots,
  };
}

// MatrixMedia 0.11.x 的登录契约：
// - 抖音与视频号都可使用默认的 Electron/CDP 二维码抓取并把 PNG 写给织台；
// - 视频号不支持 --puppeteer-headless；
// - 关闭终端二维码却又不启用 Puppeteer 会被官方 CLI 直接以退出码 2 拒绝。
// 织台不需要把 ANSI 二维码展示到终端，但必须保留这条默认二维码通道，
// 再通过 --save-qr-png 把同一张二维码嵌入发布中心。
export function buildCliLoginArgs({ platform, phone, qrPath, timeoutSec = 900 }) {
  return [
    "cli", "login", "-p", platform, "--phone", String(phone).trim(),
    platform === "sph" ? "--show" : "--hide",
    "--save-qr-png", qrPath, "--timeout-sec", String(timeoutSec),
  ];
}

// MatrixMedia 在视频号新登录页未找到二维码时会把整页截图写入 --save-qr-png。
// 整页截图不能扫，也不能在织台里点击；只有近似正方形的 PNG 才当作二维码展示。
export function isLikelyQrPng(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24) return false;
  if (buffer.toString("ascii", 1, 4) !== "PNG") return false;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width < 96 || height < 96 || width > 1024 || height > 1024) return false;
  return Math.abs(width - height) <= Math.max(width, height) * 0.2;
}

export async function startCliLogin({ platform, phone, dataDir }) {
  if (!["dy", "sph"].includes(platform)) throw new Error("login_platform_not_supported");
  if (!phone || !String(phone).trim()) throw new Error("login_account_required");
  if (!/^1\d{10}$/.test(String(phone).trim())) throw new Error("请输入11位手机号；MatrixMedia 用手机号作为登录态分区，不能填“测试”等名称");
  const id = randomUUID();
  const qrDir = join(dataDir, "matrix-login");
  await mkdir(qrDir, { recursive: true });
  const qrPath = join(qrDir, `${id}.png`);
  const args = buildCliLoginArgs({ platform, phone, qrPath });
  const interactionMode = platform === "sph" ? "window" : "inline_qr";
  const session = {
    id, platform, phone: String(phone).trim(), status: "waiting_qr", qrPath, interactionMode,
    message: platform === "sph"
      ? "视频号官方登录窗口已打开；请在窗口内点击“微信快捷登录”，完成后会自动关闭"
      : "正在生成登录二维码…",
    updatedAt: Date.now(),
  };
  loginSessions.set(id, session);
  // MatrixMedia 的默认二维码通道要求 stdout 是 TTY。local-agent 自身没有可见终端，
  // 用 macOS 自带 script(1) 分配隐藏 PTY；二维码仍通过 --save-qr-png 回传织台。
  const child = spawn(PTY_WRAPPER, ["-q", "/dev/null", MATRIX_BINARY, ...args], {
    env: { PATH: process.env.PATH || "", HOME: process.env.HOME || "", LANG: process.env.LANG || "zh_CN.UTF-8", MATRIXMEDIA_DISABLE_TELEMETRY: "1" },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  const appendOutput = (data) => { output = (output + String(data)).slice(-20_000); };
  child.stdout.on("data", (data) => {
    appendOutput(data);
    session.status = "waiting_scan";
    session.message = platform === "sph"
      ? "请在已打开的视频号官方窗口点击“微信快捷登录”，再按页面提示确认"
      : "请扫码登录";
    session.updatedAt = Date.now();
  });
  child.stderr.on("data", (data) => { appendOutput(data); session.updatedAt = Date.now(); });
  child.once("error", (error) => { session.status = "failed"; session.message = `登录引擎启动失败：${error.message}`; session.updatedAt = Date.now(); });
  child.once("exit", async (code) => {
    if (code === 0) {
      // 官方契约：退出码 0 表示目标登录 Cookie 已检测到并 flush 到分区。
      // `cli accounts` 可能因 GUI 账号树尚未建行而返回空；cliAccounts 会从
      // 同一持久分区只读核验 Cookie 元数据，不能再把这种情况误报为失败。
      try {
        await new Promise((resolve) => setTimeout(resolve, 800));
        const accounts = normalizeAccounts(await cliAccounts());
        const saved = accounts.some((account) => String(account.phone || "").split("-")[0] === session.phone);
        session.status = "success";
        session.message = saved ? "登录成功，账号已保存并可用于发布" : "登录成功，会话已保存；账号列表稍后自动刷新";
      } catch (error) {
        session.status = "success";
        session.message = "登录成功，会话已由发布引擎保存";
      }
    } else {
      session.status = code === 3 ? "expired" : "failed";
      session.message = code === 3 ? "二维码已过期，请重新生成" : `登录失败（${String(output).trim().slice(-160) || `退出码 ${code}`}）`;
    }
    session.updatedAt = Date.now();
  });
  return { id, platform, phone: session.phone, status: session.status, message: session.message, interactionMode };
}

export async function getCliLogin(id) {
  const session = loginSessions.get(String(id));
  if (!session) return null;
  let qrData = null;
  try {
    const png = await readFile(session.qrPath);
    if (session.platform !== "sph" || isLikelyQrPng(png)) {
      qrData = `data:image/png;base64,${png.toString("base64")}`;
    }
  } catch { /* QR 尚未生成 */ }
  return {
    id: session.id, platform: session.platform, phone: session.phone,
    status: session.status, message: session.message, interactionMode: session.interactionMode,
    qrData, updatedAt: new Date(session.updatedAt).toISOString(),
  };
}

// ISO → 本地 YYYY-MM-DD HH:mm:ss（官方 publishAt 契约）
export function formatPublishAt(iso) {
  if (!iso || Number.isNaN(Date.parse(iso))) return null;
  const d = new Date(iso);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// cli accounts 原始数据 → 规范化账号行 {platform, phone, partition, loginStatus, error}
export function normalizeAccounts(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    if (typeof entry === "string") return { platform: entry, phone: null, partition: null, loginStatus: null, error: null };
    const r = entry && typeof entry === "object" ? entry : {};
    return {
      platform: String(r.platform || r.code || r.name || r.platformName || ""),
      phone: r.phone || r.mobile || null,
      partition: r.partition || r.session || null,
      loginStatus: r.loginStatus || r.login_state || r.status || null,
      error: r.error || r.note || null,
    };
  });
}
