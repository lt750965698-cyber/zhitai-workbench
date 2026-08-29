import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  classifyMatrixPublishResult,
  cliPublish,
  createMatrixAuthStateStore,
  createPublishReceiptStore,
  publishAccountFingerprint,
  publishModeFor,
  publishReceiptDedupeKey,
  publishWithReceipts,
} from "../local-agent/matrixmedia-adapter.mjs";
import { normalizeMatrixHistoryRecord } from "../local-agent/publish-scheduler.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(resolve(here, "../local-agent/server.mjs"), "utf8");

test("MatrixMedia 回执不会把普通退出码 0 当成已经公开", () => {
  assert.equal(publishModeFor({ draft: true, scheduledAt: "2026-08-27T11:40:00.000Z" }), "scheduled");
  assert.equal(publishModeFor({ draft: false, scheduledAt: "2026-08-27T11:40:00.000Z" }), "scheduled");
  assert.equal(publishModeFor({ draft: false }), "public");

  const accepted = classifyMatrixPublishResult({
    code: 0,
    out: JSON.stringify({ status: "success", message: "accepted" }),
    err: "",
  }, { mode: "public" });
  assert.equal(accepted.state, "submitted");
  assert.equal(accepted.platformMessage, "accepted");

  const published = classifyMatrixPublishResult({
    code: 0,
    out: JSON.stringify({ status: "published", postId: "note-1", url: "https://example.com/note-1" }),
    err: "",
  }, { mode: "public" });
  assert.equal(published.state, "public");
  assert.equal(published.postId, "note-1");
  assert.equal(published.resultUrl, "https://example.com/note-1");

  const nestedPublished = classifyMatrixPublishResult({
    code: 0,
    out: JSON.stringify({ status: "success", data: { publishStatus: "published", id: "post-task-2" } }),
    err: "",
  }, { mode: "public" });
  assert.equal(nestedPublished.state, "public");
  assert.equal(nestedPublished.taskId, "post-task-2");

  const scheduled = classifyMatrixPublishResult({
    code: 0,
    out: JSON.stringify({ status: "success", taskId: "schedule-1" }),
    err: "",
  }, { mode: "scheduled" });
  assert.equal(scheduled.state, "scheduled");
  assert.equal(scheduled.taskId, "schedule-1");

  assert.equal(classifyMatrixPublishResult({ code: 0, out: "ok", err: "" }, { mode: "draft" }).state, "draft");
  const publicFallback = classifyMatrixPublishResult({ code: 4, out: "saved", err: "" }, { mode: "public" });
  assert.equal(publicFallback.state, "draft");
  assert.equal(publicFallback.accepted, false, "正式发布降级到草稿不能算成功");
  assert.equal(classifyMatrixPublishResult({ code: 4, out: "saved", err: "" }, { mode: "draft" }).accepted, true);
  assert.equal(classifyMatrixPublishResult({ code: 3, out: "", err: "not logged in" }, { mode: "public" }).state, "failed");
  assert.equal(classifyMatrixPublishResult({ code: null, out: "process ended", err: "" }, { mode: "public" }).state, "failed");
  assert.equal(
    classifyMatrixPublishResult({ code: 3, out: "", err: "account 13800138000 expired" }, { mode: "public" }).platformMessage,
    "account [account] expired",
  );
});

test("真实发布接受会持久验证账号，视频号登录页重定向会立即使账号失效", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "zhitai-matrix-publish-auth-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const authStore = createMatrixAuthStateStore({ path: join(sandbox, "auth.json") });
  const target = {
    platform: "sph",
    phone: "13800138000",
    partition: "persist:13800138000视频号",
  };
  const payload = {
    platforms: [target],
    file: "/private/fixture.mp4",
    title: "小户型卫生间四区动线",
    draft: true,
  };

  const accepted = await cliPublish(payload, {
    authStateStore: authStore,
    run: async () => ({ code: 0, out: JSON.stringify({ status: "saved_draft", message: "草稿已保存" }), err: "" }),
  });
  assert.equal(accepted.results[0].state, "draft");
  assert.equal((await authStore.get("sph", target)).authState, "verified");

  const rejected = await cliPublish(payload, {
    authStateStore: authStore,
    run: async () => ({
      code: 3,
      out: "",
      err: "[auth] 视频号登录状态已失效，请重新登录后再试: https://channels.weixin.qq.com/login.html\n登录态异常或未登录",
    }),
  });
  assert.equal(rejected.results[0].state, "failed");
  const invalid = await authStore.get("sph", target);
  assert.equal(invalid.authState, "invalid");
  assert.equal(invalid.reasonCode, "sph_login_redirect");

  const disk = await readFile(join(sandbox, "auth.json"), "utf8");
  assert.equal(disk.includes("13800138000"), false);
  assert.equal(disk.includes("channels.weixin.qq.com"), false, "平台原始失败消息不得进入认证账本");
});

test("发布回执按平台、账号、媒体 SHA、模式和排期时间持久幂等", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "zhitai-publish-receipts-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const ledgerPath = join(sandbox, "publisher-receipts.json");
  let tick = 0;
  const now = () => new Date(Date.UTC(2026, 7, 27, 8, 0, tick++)).toISOString();
  const store = createPublishReceiptStore({ path: ledgerPath, now });
  const base = {
    platform: "dy",
    account: "persist:account-a",
    content: { id: "asset-1", title: "儿童房布局", mediaSha256: "a".repeat(64) },
    jobId: "job-1",
    mode: "public",
    scheduledAt: null,
  };

  const first = await store.reserve(base);
  const duplicate = await store.reserve({ ...base, jobId: "job-2" });
  assert.equal(first.created, true);
  assert.match(first.receipt.account, /^acct_[a-f0-9]{24}$/);
  assert.notEqual(first.receipt.account, base.account);
  assert.equal("resultUrl" in first.receipt, false);
  assert.equal("postId" in first.receipt, false);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.receipt.id, first.receipt.id);
  assert.equal(duplicate.receipt.jobId, "job-1", "幂等命中必须保留第一次提交的作业归属");

  const updated = await store.update(first.receipt.id, {
    state: "submitted",
    platformMessage: "platform accepted",
    taskId: "platform-task-1",
  });
  assert.equal(updated.state, "submitted");
  assert.equal(updated.taskId, "platform-task-1");

  const scheduled = await store.reserve({
    ...base,
    jobId: "job-3",
    mode: "scheduled",
    scheduledAt: "2026-08-28T11:40:00.000Z",
  });
  assert.equal(scheduled.created, true, "模式或排期不同不是重复任务");

  const reopened = createPublishReceiptStore({ path: ledgerPath });
  const rows = await reopened.list();
  assert.equal(rows.length, 2);
  assert.equal(rows.find((row) => row.id === first.receipt.id)?.state, "submitted");
  assert.equal(rows.find((row) => row.id === first.receipt.id)?.content.mediaSha256, "a".repeat(64));
  assert.equal(rows.find((row) => row.id === first.receipt.id)?.mode, "public");
  assert.equal(rows.find((row) => row.id === first.receipt.id)?.scheduledAt, null);
  assert.match(rows.find((row) => row.id === first.receipt.id)?.createdAt || "", /^2026-08-27T/);

  const disk = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.equal(disk.version, 1);
  assert.equal(disk.receipts.length, 2);
});

test("发布回执幂等键覆盖所有约定维度", () => {
  const base = {
    platform: "sph",
    account: "persist:account-a",
    mediaSha256: "b".repeat(64),
    mode: "scheduled",
    scheduledAt: "2026-08-27T11:40:00.000Z",
  };
  const key = publishReceiptDedupeKey(base);
  for (const changed of [
    { platform: "dy" },
    { account: "persist:account-b" },
    { mediaSha256: "c".repeat(64) },
    { mode: "public" },
    { scheduledAt: "2026-08-28T11:40:00.000Z" },
  ]) {
    assert.notEqual(publishReceiptDedupeKey({ ...base, ...changed }), key);
  }
});

test("账号指纹不会暴露手机号，并优先使用精确 partition 路由", () => {
  const byPhone = publishAccountFingerprint("dy", { phone: "13800138000" });
  const byPartition = publishAccountFingerprint("dy", { partition: "persist:13800138000抖音" });
  const exact = publishAccountFingerprint("dy", { phone: "13800138000", partition: "persist:13800138000抖音" });
  assert.notEqual(byPhone, byPartition);
  assert.equal(exact, byPartition);
  assert.match(byPhone, /^acct_[a-f0-9]{24}$/);
  assert.equal(byPhone.includes("13800138000"), false);
});

test("回执占位发生在外部发布前，重复请求不会再次调用平台", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "zhitai-publish-dedupe-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const store = createPublishReceiptStore({ path: join(sandbox, "receipts.json") });
  let calls = 0;
  const publish = async (payload) => {
    calls += 1;
    assert.equal(payload.platforms.length, 1);
    return {
      success: true,
      total: 1,
      results: [{
        platform: "dy",
        account: "persist:account-a",
        success: true,
        state: "submitted",
        platformMessage: "accepted",
        taskId: "platform-task-1",
      }],
    };
  };
  const request = {
    payload: {
      file: "/private/fixture.mp4",
      title: "儿童房布局",
      draft: false,
      platforms: [{ platform: "dy", partition: "persist:account-a" }],
    },
    receiptStore: store,
    content: { id: "asset-1", title: "儿童房布局", mediaSha256: "d".repeat(64) },
    jobId: "job-1",
    scheduledAt: null,
    publish,
  };
  const first = await publishWithReceipts(request);
  const second = await publishWithReceipts({ ...request, jobId: "job-2" });
  assert.equal(calls, 1);
  assert.equal(first.results[0].state, "submitted");
  assert.equal(second.results[0].deduplicated, true);
  assert.equal(second.results[0].receiptId, first.results[0].receiptId);
});

test("平台遗漏单项结果时保守记录 unknown，不虚报成功", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "zhitai-publish-missing-result-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const store = createPublishReceiptStore({ path: join(sandbox, "receipts.json") });
  const result = await publishWithReceipts({
    payload: {
      file: "/private/fixture.mp4",
      title: "儿童房布局",
      draft: false,
      platforms: [{ platform: "dy", phone: "13800138000" }],
    },
    receiptStore: store,
    content: { id: "asset-1", title: "儿童房布局", mediaSha256: "e".repeat(64) },
    jobId: "job-missing-result",
    publish: async () => ({ success: true, total: 1, results: [] }),
  });
  assert.equal(result.success, false);
  assert.equal(result.results[0].state, "unknown");
  assert.equal(result.results[0].success, false);
});

test("failed 只有显式 retryFailed 才重试，unknown 等状态仍保持幂等", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "zhitai-publish-explicit-retry-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const store = createPublishReceiptStore({ path: join(sandbox, "receipts.json") });
  let calls = 0;
  const request = {
    payload: {
      file: "/private/fixture.mp4",
      title: "儿童房布局",
      draft: false,
      platforms: [{ platform: "dy", phone: "13800138000" }],
    },
    receiptStore: store,
    content: { id: "asset-retry", title: "儿童房布局", mediaSha256: "f".repeat(64) },
    jobId: "job-retry",
    publish: async () => {
      calls += 1;
      return calls === 1
        ? { success: false, total: 1, results: [{ platform: "dy", success: false, state: "failed", platformMessage: "upload failed" }] }
        : { success: true, total: 1, results: [{ platform: "dy", success: true, state: "submitted", platformMessage: "accepted" }] };
    },
  };
  assert.equal((await publishWithReceipts(request)).results[0].state, "failed");
  assert.equal((await publishWithReceipts(request)).results[0].deduplicated, true);
  assert.equal(calls, 1);
  const retried = await publishWithReceipts({ ...request, retryFailed: true });
  assert.equal(calls, 2);
  assert.equal(retried.results[0].state, "submitted");
});

test("两个 store 实例并发占位仍只有一个创建成功", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "zhitai-publish-cross-process-lock-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const ledgerPath = join(sandbox, "receipts.json");
  const firstStore = createPublishReceiptStore({ path: ledgerPath });
  const secondStore = createPublishReceiptStore({ path: ledgerPath });
  const input = {
    platform: "dy",
    account: "persist:13800138000抖音",
    content: { id: "asset-lock", title: "儿童房布局", mediaSha256: "1".repeat(64) },
    jobId: "job-lock",
    mode: "public",
    scheduledAt: null,
  };
  const reservations = await Promise.all([firstStore.reserve(input), secondStore.reserve(input)]);
  assert.deepEqual(reservations.map((row) => row.created).sort(), [false, true]);
  assert.equal((await firstStore.list()).length, 1);
});

test("升级后忽略旧版陈旧锁文件，改由 SQLite 的进程级锁自动恢复", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "zhitai-publish-stale-lock-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const ledgerPath = join(sandbox, "receipts.json");
  await writeFile(`${ledgerPath}.lock`, JSON.stringify({
    pid: "invalid",
    createdAt: new Date(Date.now() - 180_000).toISOString(),
  }));
  const store = createPublishReceiptStore({ path: ledgerPath });
  const result = await store.reserve({
    platform: "dy",
    account: "persist:13800138000抖音",
    content: { id: "asset-stale", title: "儿童房布局", mediaSha256: "2".repeat(64) },
    jobId: "job-stale",
    mode: "public",
    scheduledAt: null,
  });
  assert.equal(result.created, true);
  const lockMode = (await stat(`${ledgerPath}.lock.sqlite`)).mode & 0o777;
  assert.equal(lockMode, 0o600);
});

test("持锁进程崩溃后由操作系统释放发布回执锁", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "zhitai-publish-crash-lock-"));
  t.after(() => rm(sandbox, { recursive: true, force: true }));
  const ledgerPath = join(sandbox, "receipts.json");
  const lockPath = `${ledgerPath}.lock.sqlite`;
  const childScript = `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(${JSON.stringify(lockPath)});
    db.exec("BEGIN IMMEDIATE;");
    process.stdout.write("locked\\n");
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "--eval", childScript], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const [ready] = await once(child.stdout, "data");
  assert.equal(String(ready).trim(), "locked");
  child.kill("SIGKILL");
  await once(child, "exit");

  const store = createPublishReceiptStore({ path: ledgerPath });
  const result = await store.reserve({
    platform: "dy",
    account: "persist:13800138000抖音",
    content: { id: "asset-crash", title: "儿童房布局", mediaSha256: "3".repeat(64) },
    jobId: "job-crash",
    mode: "public",
    scheduledAt: null,
  });
  assert.equal(result.created, true);
});

test("server 历史接口以本地回执为主，并为 Matrix 排期暴露调度器状态", () => {
  assert.match(serverSource, /publisher-receipts\.json/);
  assert.match(serverSource, /publisherReceiptStore\.list\(\)/);
  assert.match(serverSource, /publishWithReceipts/);
  assert.match(serverSource, /scheduler_inactive/);
  assert.match(serverSource, /ambiguous_account/);
  assert.match(serverSource, /history: \[\.\.\.scheduleHistory, \.\.\.localHistory, \.\.\.normalizedUpstream\]/);
  assert.match(serverSource, /status: receipt\.state/);
});

test("Matrix 实机 history 字段保持草稿和旧排期真值", () => {
  const draft = normalizeMatrixHistoryRecord({
    id: "draft-1",
    pt: "xhs",
    status: "success",
    lastMessage: "保存草稿成功",
    lastAt: 1787788800000,
  });
  assert.equal(draft.platform, "xhs");
  assert.equal(draft.state, "draft");
  assert.equal(draft.platformMessage, "保存草稿成功");
  assert.equal(draft.time, "2026-08-27T00:00:00.000Z");

  const scheduled = normalizeMatrixHistoryRecord({
    id: "legacy-schedule-1",
    pt: "sph",
    status: "scheduled",
    lastMessage: "等待定时发布",
    lastAt: "2026-08-27T01:00:00.000Z",
  });
  assert.equal(scheduled.state, "scheduled");
  assert.equal(scheduled.schedulerState, "scheduler_inactive");
});
