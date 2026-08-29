import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const nativeRequire = createRequire(import.meta.url);
const mainUrl = new URL("../desktop/main.js", import.meta.url);

async function loadDailyCreativePolicy() {
  const source = await readFile(mainUrl, "utf8");
  const module = { exports: {} };
  const fakeApp = {
    setName() {},
    setAppUserModelId() {},
    setPath() {},
    getPath() { return "/tmp/zhitai-policy-test"; },
    requestSingleInstanceLock() { return false; },
    whenReady() { return new Promise(() => {}); },
    quit() {},
    on() {},
  };
  const sandbox = {
    module,
    exports: module.exports,
    __dirname: dirname(fileURLToPath(mainUrl)),
    __filename: fileURLToPath(mainUrl),
    require(specifier) {
      if (specifier === "electron") {
        return { app: fakeApp, BrowserWindow: class {}, ipcMain: {}, nativeImage: {} };
      }
      if (specifier === "./creative-runner.js") {
        return {
          createCreativeRunner: () => ({ run: async () => ({ ok: true }), probeAccounts: async () => ({}) }),
          localMotionFallbackEnabled: (value) => !/^(?:0|false|off|disabled)$/i.test(String(value ?? "1").trim()),
        };
      }
      if (specifier === "./x-bookmark-runner.js") {
        return { createXBookmarkRunner: () => ({ sync: async () => ({}) }) };
      }
      if (specifier === "./yuanbao-runner.js") {
        return { createYuanbaoRunner: () => ({ startBridge() {}, stopBridge() {}, attach() {} }) };
      }
      if (specifier === "./launcher.js") return {};
      if (specifier === "./adapter.js") return {};
      return nativeRequire(specifier);
    },
    process: { env: {}, defaultApp: false, platform: process.platform },
    console,
    URL,
    Intl,
    Date,
    Set,
    Map,
    WeakSet,
    Object,
    Array,
    String,
    Number,
    RegExp,
    JSON,
    AbortSignal,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    encodeURIComponent,
  };
  const expose = `\nmodule.exports.__dailyCreativePolicy = {
    qualifiedCreativeReviewCount,
    isDailyCreativeWindowOpen,
    activeJobRetryAfter,
    revisionAssetIdsFromReviews,
    selectDailyCreativeJob,
    isClearlyJobSpecificCreativeError,
    classifyCreativeFailure,
    nextTransientCreativeRetryAt,
    previousTransientCreativeRetry,
    preferredCreativeRetryDisposition,
    dailyContentPackageIdForDate,
    legacyQuotaOnlyAccountIds,
    legacyQuotaDailyMigrationDecision,
    resolveDailyCreativeBinding,
    dailyCreativeState,
    maxAttempts: DAILY_CREATIVE_MAX_ATTEMPTS,
    maxRevisionStreak: MAX_CONSECUTIVE_REVISION_ATTEMPTS,
    maxTransientRetries: MAX_CONSECUTIVE_TRANSIENT_RETRIES,
    transientRetryMs: TRANSIENT_CREATIVE_RETRY_MS,
    providerRetryMs: CREATIVE_RETRY_BACKOFF_MS,
  };`;
  vm.runInNewContext(source + expose, sandbox, { filename: fileURLToPath(mainUrl) });
  return { policy: module.exports.__dailyCreativePolicy, source };
}

test("每日内容包 ID 同日幂等且跨日唯一", async () => {
  const { policy } = await loadDailyCreativePolicy();
  assert.equal(policy.dailyContentPackageIdForDate("2026-08-29"), "daily_content_20260829");
  assert.equal(policy.dailyContentPackageIdForDate("2026-08-29"), policy.dailyContentPackageIdForDate("2026-08-29"));
  assert.notEqual(policy.dailyContentPackageIdForDate("2026-08-29"), policy.dailyContentPackageIdForDate("2026-08-30"));
  assert.throws(() => policy.dailyContentPackageIdForDate("2026/08/29"), /daily_content_package_date_invalid/);
});

function quotaMigrationFixture() {
  const today = "2026-08-29";
  const error = "没有可用的豆包账号：account-1 今日额度已用完；studio.secondary 今日额度已用完";
  return {
    today,
    previous: {
      date: today,
      dailyContentPackageId: "daily_content_20260829",
      jobId: "creative-current",
      lockedAssetId: "asset-current",
      lastError: error,
      lastErrorScope: "provider",
      providerRetryAfter: "2026-08-29T10:20:49.420Z",
    },
    job: {
      id: "creative-current",
      assetId: "asset-current",
      status: "needs_attention",
      resumeStatus: "ready_for_seedance",
      error,
    },
  };
}

test("旧版纯额度状态只授权一次原 job 结构化重探测，不直接批准 fallback", async () => {
  const { policy } = await loadDailyCreativePolicy();
  const fixture = quotaMigrationFixture();
  const decision = policy.legacyQuotaDailyMigrationDecision({
    ...fixture,
    localMotionEnabled: true,
  });
  assert.equal(decision.action, "resume_once");
  assert.equal(decision.reason, "legacy_quota_state_requires_structured_reprobe");
  assert.equal(decision.jobId, fixture.previous.jobId);
  assert.equal(decision.assetId, fixture.previous.lockedAssetId);
  assert.equal(Array.from(decision.accountIds).join(","), "account-1,studio.secondary");
  assert.equal(policy.legacyQuotaOnlyAccountIds(fixture.previous.lastError).length, 2);
});

test("混合未登录、授权或任意文本的旧豆包错误绝不自动恢复", async () => {
  const { policy } = await loadDailyCreativePolicy();
  const fixture = quotaMigrationFixture();
  for (const error of [
    "没有可用的豆包账号：account-1 今日额度已用完；account-2 未登录",
    "没有可用的豆包账号：account-1 今日额度已用完；account-2 需要授权",
    "没有可用的豆包账号：account-1 今日额度已用完；稍后再试",
    "没有可用的豆包账号：account-1 今日额度已用完 ",
  ]) {
    const decision = policy.legacyQuotaDailyMigrationDecision({
      today: fixture.today,
      previous: { ...fixture.previous, lastError: error },
      job: { ...fixture.job, error },
      localMotionEnabled: true,
    });
    assert.equal(decision.action, "blocked");
    assert.equal(decision.reason, "legacy_error_not_quota_only");
    assert.equal(policy.legacyQuotaOnlyAccountIds(error), null);
  }
});

test("旧额度状态跨北京自然日不恢复", async () => {
  const { policy } = await loadDailyCreativePolicy();
  const fixture = quotaMigrationFixture();
  const decision = policy.legacyQuotaDailyMigrationDecision({
    previous: fixture.previous,
    today: "2026-08-30",
    job: fixture.job,
    localMotionEnabled: true,
  });
  assert.equal(decision.action, "blocked");
  assert.equal(decision.reason, "daily_package_mismatch");
});

test("旧额度状态不能恢复 asset 错配或不同断点的 job", async () => {
  const { policy } = await loadDailyCreativePolicy();
  const fixture = quotaMigrationFixture();
  const wrongAsset = policy.legacyQuotaDailyMigrationDecision({
    ...fixture,
    job: { ...fixture.job, assetId: "asset-other" },
    localMotionEnabled: true,
  });
  assert.equal(wrongAsset.action, "blocked");
  assert.equal(wrongAsset.reason, "job_binding_mismatch");
  for (const job of [
    { ...fixture.job, status: "paused" },
    { ...fixture.job, resumeStatus: "ready_for_images" },
  ]) {
    const wrongState = policy.legacyQuotaDailyMigrationDecision({
      today: fixture.today,
      previous: fixture.previous,
      job,
      localMotionEnabled: true,
    });
    assert.equal(wrongState.action, "blocked");
    assert.equal(wrongState.reason, "job_state_not_migratable");
  }
});

test("LocalMotion kill switch 关闭时旧额度状态保持 needs_attention", async () => {
  const { policy } = await loadDailyCreativePolicy();
  const fixture = quotaMigrationFixture();
  const decision = policy.legacyQuotaDailyMigrationDecision({
    ...fixture,
    localMotionEnabled: false,
  });
  assert.equal(decision.action, "blocked");
  assert.equal(decision.reason, "local_motion_disabled");
});

test("旧额度迁移 marker 使重复执行失败关闭", async () => {
  const { policy } = await loadDailyCreativePolicy();
  const fixture = quotaMigrationFixture();
  const decision = policy.legacyQuotaDailyMigrationDecision({
    today: fixture.today,
    previous: {
      ...fixture.previous,
      quotaRecoveryMigration: {
        version: 1,
        status: "attempted",
        dailyContentPackageId: fixture.previous.dailyContentPackageId,
        jobId: fixture.previous.jobId,
        assetId: fixture.previous.lockedAssetId,
      },
    },
    job: fixture.job,
    localMotionEnabled: true,
  });
  assert.equal(decision.action, "blocked");
  assert.equal(decision.reason, "already_attempted");
});

test("每日目标只计算当日包绑定的已批准 job + asset", async () => {
  const { policy } = await loadDailyCreativePolicy();
  const today = "2026-08-27";
  const reviews = [
    { date: today, jobId: "job-today", assetId: "asset-today", status: "needs_revision" },
    { date: today, jobId: "job-today", assetId: "asset-today", status: "pending_review" },
    { date: today, jobId: "job-other", assetId: "asset-other", status: "approved_for_publish" },
    { date: today, jobId: "job-today", assetId: "asset-other", status: "approved_for_publish" },
    { date: today, jobId: "job-today", assetId: "asset-today", status: "approved_for_publish" },
    { date: "2026-08-26", jobId: "job-today", assetId: "asset-today", status: "approved_for_publish" },
  ];
  assert.equal(policy.qualifiedCreativeReviewCount(reviews, today), 0, "无绑定时失败关闭");
  assert.equal(policy.qualifiedCreativeReviewCount(reviews, today, {
    jobId: "job-today",
    assetId: "asset-today",
  }), 1);
  assert.equal(policy.qualifiedCreativeReviewCount(reviews, today, {
    jobId: "job-other",
    assetId: "asset-today",
  }), 0);
});

test("启动历史复审不能污染当日包，可从唯一当日返工链恢复真实任务", async () => {
  const { policy } = await loadDailyCreativePolicy();
  const today = "2026-08-29";
  const staleJobId = "creative_22222222-2222-4222-8222-222222222222";
  const currentJobId = "creative_33333333-3333-4333-8333-333333333333";
  const jobs = [
    {
      id: staleJobId,
      assetId: "asset-stale-fixture",
      status: "completed",
      createdAt: "2026-08-23T12:46:00.753Z",
    },
    {
      id: currentJobId,
      assetId: "asset-current-fixture",
      status: "paused",
      createdAt: "2026-08-29T04:27:21.771Z",
    },
  ];
  const reviews = [
    {
      date: today,
      jobId: staleJobId,
      assetId: "asset-stale-fixture",
      status: "approved_for_publish",
    },
    {
      date: today,
      jobId: "creative-old-needs-revision",
      assetId: "asset-current-fixture",
      status: "needs_revision",
      revisionTaskId: currentJobId,
    },
  ];
  const binding = policy.resolveDailyCreativeBinding({
    date: today,
    dailyContentPackageId: "daily_content_20260829",
    jobId: staleJobId,
    qualifiedToday: 1,
  }, today, jobs, reviews);
  assert.equal(binding.source, "unique_today_revision_recovery");
  assert.equal(binding.jobId, currentJobId);
  assert.equal(binding.lockedAssetId, "asset-current-fixture");
  assert.equal(policy.qualifiedCreativeReviewCount(reviews, today, {
    jobId: binding.jobId,
    assetId: binding.lockedAssetId,
  }), 0, "历史 completed 今日复审的批准不得使当日提前达标");
});

test("旧版当日状态只有活跃 jobId 时可一次性迁移出 asset 锁", async () => {
  const { policy } = await loadDailyCreativePolicy();
  const binding = policy.resolveDailyCreativeBinding({
    date: "2026-08-29",
    jobId: "creative-current",
  }, "2026-08-29", [{
    id: "creative-current",
    assetId: "asset-current",
    status: "ready_for_seedance",
    createdAt: "2026-08-28T20:00:00Z",
  }], []);
  assert.equal(binding.source, "legacy_job_migration");
  assert.equal(binding.jobId, "creative-current");
  assert.equal(binding.lockedAssetId, "asset-current");
});

test("已持久化的 asset 锁权威且会继续落盘，job 错配时不切换主题", async () => {
  const { policy } = await loadDailyCreativePolicy();
  const today = "2026-08-29";
  const binding = policy.resolveDailyCreativeBinding({
    date: today,
    dailyContentPackageId: "daily_content_20260829",
    jobId: "job-wrong-asset",
    lockedAssetId: "asset-locked",
  }, today, [{
    id: "job-wrong-asset",
    assetId: "asset-other",
    status: "ready_for_seedance",
    createdAt: "2026-08-29T01:00:00Z",
  }], []);
  assert.equal(binding.source, "persisted_asset_lock");
  assert.equal(binding.jobId, null);
  assert.equal(binding.lockedAssetId, "asset-locked");

  const state = policy.dailyCreativeState({
    today,
    jobId: "job-current",
    lockedAssetId: "asset-locked",
    qualifiedToday: 1,
  });
  assert.equal(state.dailyContentPackageId, "daily_content_20260829");
  assert.equal(state.jobId, "job-current");
  assert.equal(state.lockedAssetId, "asset-locked");
  assert.equal(state.qualifiedToday, 1);
});

test("最新审核为 needs_revision 且有反馈时识别对应返工资产", async () => {
  const { policy } = await loadDailyCreativePolicy();
  const ids = policy.revisionAssetIdsFromReviews([
    { assetId: "asset-a", status: "needs_revision", feedback: [{ text: "修正文案" }], updatedAt: "2026-08-27T08:00:00Z" },
    { assetId: "asset-b", status: "needs_revision", feedback: [], updatedAt: "2026-08-27T08:00:00Z" },
    { assetId: "asset-c", status: "needs_revision", feedback: [{ text: "旧反馈" }], updatedAt: "2026-08-27T07:00:00Z" },
    { assetId: "asset-c", status: "pending_review", feedback: [], updatedAt: "2026-08-27T09:00:00Z" },
  ]);
  assert.equal(ids.has("asset-a"), true);
  assert.equal(ids.has("asset-b"), false);
  assert.equal(ids.has("asset-c"), false);
});

test("返工任务优先、同层按创建时间确定排序，并每两条放行一条普通 backlog", async () => {
  const { policy } = await loadDailyCreativePolicy();
  const jobs = [
    { id: "backlog-old", assetId: "asset-old", status: "ready_for_images", createdAt: "2026-08-20T00:00:00Z" },
    { id: "revision-new", assetId: "asset-r2", status: "ready_for_images", createdAt: "2026-08-27T02:00:00Z" },
    { id: "revision-old", assetId: "asset-r1", status: "ready_for_images", createdAt: "2026-08-27T01:00:00Z" },
  ];
  const revisions = new Set(["asset-r1", "asset-r2"]);
  const first = policy.selectDailyCreativeJob(jobs, new Set(), {}, revisions, 0, Date.parse("2026-08-27T03:00:00Z"));
  assert.equal(first.id, "revision-old");
  const fairness = policy.selectDailyCreativeJob(jobs, new Set(), {}, revisions, policy.maxRevisionStreak, Date.parse("2026-08-27T03:00:00Z"));
  assert.equal(fairness.id, "backlog-old");
});

test("同一自然日锁定首个内容资产，返工可继续但不能切换主题", async () => {
  const { policy } = await loadDailyCreativePolicy();
  const jobs = [
    { id: "other-old", assetId: "asset-other", status: "ready_for_images", createdAt: "2026-08-20T00:00:00Z" },
    { id: "same-revision", assetId: "asset-today", status: "ready_for_images", createdAt: "2026-08-29T01:00:00Z" },
  ];
  const selected = policy.selectDailyCreativeJob(
    jobs,
    new Set(),
    {},
    new Set(["asset-today"]),
    0,
    Date.parse("2026-08-29T03:00:00Z"),
    null,
    "asset-today",
  );
  assert.equal(selected.id, "same-revision");
  jobs[1].status = "needs_attention";
  assert.equal(policy.selectDailyCreativeJob(
    jobs,
    new Set(),
    {},
    new Set(["asset-today"]),
    0,
    Date.parse("2026-08-29T03:00:00Z"),
    null,
    "asset-today",
  ), null);
});

test("单条退避不挡后续任务，同一轮有上限且每条开始前复核北京时间窗口", async () => {
  const { policy, source } = await loadDailyCreativePolicy();
  const retryUntil = "2026-08-27T08:00:00Z";
  const jobs = [
    { id: "job-retrying", assetId: "asset-a", status: "ready_for_images", createdAt: "2026-08-20T00:00:00Z" },
    { id: "job-next", assetId: "asset-b", status: "ready_for_images", createdAt: "2026-08-21T00:00:00Z" },
  ];
  const selected = policy.selectDailyCreativeJob(
    jobs,
    new Set(),
    { "job-retrying": retryUntil },
    new Set(),
    0,
    Date.parse("2026-08-27T07:00:00Z"),
  );
  assert.equal(selected.id, "job-next");
  assert.equal(policy.maxAttempts, 4);
  assert.equal(policy.isClearlyJobSpecificCreativeError("旁白重复且主题错配"), true);
  assert.equal(policy.isClearlyJobSpecificCreativeError("豆包账号未登录"), false);
  assert.equal(policy.isDailyCreativeWindowOpen("2026-08-27T00:00:00Z"), true); // 北京 08:00
  assert.equal(policy.isDailyCreativeWindowOpen("2026-08-27T11:00:00Z"), false); // 北京 19:00
  assert.match(source, /while \(qualifiedToday < DAILY_CREATIVE_TARGET && attempts < DAILY_CREATIVE_MAX_ATTEMPTS\)/);
  assert.match(source, /if \(!isDailyCreativeWindowOpen\(\)\) break/);
  assert.match(source, /lastErrorScope: jobSpecific \? "job" : "provider"/);
});

test("GPT 页面忙或无额度证据的生图超时都归为 60 秒短重试", async () => {
  const { policy } = await loadDailyCreativePolicy();
  for (const failure of [
    { code: "GPT_PAGE_BUSY_RETRYABLE", status: "transient_ui_busy", error: "GPT 页面仍忙，发送按钮尚未恢复" },
    { code: "GPT_UI_BUSY" },
    { code: "GPT_IMAGE_TIMEOUT_RETRYABLE", error: "GPT 生图等待超时，未发现登录或额度异常" },
    "GPT_PAGE_BUSY_RETRYABLE: GPT 页面仍忙，发送按钮尚未恢复",
    "GPT_IMAGE_TIMEOUT_RETRYABLE: GPT 生图等待超时，未发现登录或额度异常",
    "找不到明确的发送按钮；为避免误触语音已停止",
  ]) {
    const classified = policy.classifyCreativeFailure(failure);
    assert.equal(classified.kind, "transient");
    assert.equal(classified.scope, "provider_transient");
    assert.equal(classified.retryAfterMs, policy.transientRetryMs);
  }
  assert.equal(policy.transientRetryMs, 60_000);
});

test("旧 provider/22:55 状态会从原失败时间迁移为一分钟重试", async () => {
  const { policy } = await loadDailyCreativePolicy();
  const previous = {
    date: "2026-08-28",
    jobId: "creative-old",
    lastAttemptAt: "2026-08-28T10:55:01.000Z", // 北京 18:55:01
    lastError: "找不到明确的发送按钮；为避免误触语音已停止",
    lastErrorScope: "provider",
    providerRetryAfter: "2026-08-28T14:55:01.000Z", // 旧版错误的北京 22:55
  };
  const waiting = policy.previousTransientCreativeRetry(
    previous,
    "2026-08-28",
    Date.parse("2026-08-28T10:55:30.000Z"),
  );
  assert.equal(waiting.isTransient, true);
  assert.equal(waiting.retryAtIso, "2026-08-28T10:56:01.000Z");
  assert.equal(waiting.ready, false);
  const ready = policy.previousTransientCreativeRetry(
    previous,
    "2026-08-28",
    Date.parse("2026-08-28T10:56:02.000Z"),
  );
  assert.equal(ready.ready, true);
  assert.notEqual(ready.retryAtIso, previous.providerRetryAfter);
});

test("达到短重试阈值的落盘错误不再被正文重新识别为可自动恢复", async () => {
  const { policy } = await loadDailyCreativePolicy();
  const exhausted = policy.previousTransientCreativeRetry({
    date: "2026-08-28",
    jobId: "creative-exhausted",
    lastError: "GPT_PAGE_BUSY_RETRYABLE: GPT 页面仍忙，发送按钮尚未恢复",
    lastErrorScope: "transient_exhausted",
    retryOnceAfter: "2026-08-28T01:01:00.000Z",
  }, "2026-08-28", Date.parse("2026-08-28T01:02:00.000Z"));
  assert.equal(exhausted.isTransient, false);
  assert.equal(exhausted.ready, false);
  assert.equal(policy.maxTransientRetries, 3);
});

test("明确的旧 GPT busy 错误跨日仍可恢复，且恢复不被白天窗口早退截断", async () => {
  const { policy, source } = await loadDailyCreativePolicy();
  const previous = {
    date: "2026-08-27",
    jobId: "creative-cross-date",
    lastAttemptAt: "2026-08-27T10:55:01.000Z",
    lastError: "找不到明确的发送按钮；为避免误触语音已停止",
    lastErrorScope: "provider",
    providerRetryAfter: "2026-08-27T14:55:01.000Z",
  };
  const crossDate = policy.previousTransientCreativeRetry(
    previous,
    "2026-08-28",
    Date.parse("2026-08-28T00:30:00.000Z"), // 北京次日 08:30
  );
  assert.equal(crossDate.isTransient, true);
  assert.equal(crossDate.crossDate, true);
  assert.equal(crossDate.ready, true);
  assert.notEqual(crossDate.retryAtIso, previous.providerRetryAfter);

  const migrationIndex = source.indexOf("if (legacyTransientScope)");
  const windowReturnIndex = source.indexOf("if (!creativeWindowOpen) return");
  assert.ok(migrationIndex >= 0);
  assert.ok(windowReturnIndex > migrationIndex);
});

test("真实登录和额度故障仍是 provider 四小时退避，素材错误仍是 job 范围", async () => {
  const { policy } = await loadDailyCreativePolicy();
  for (const failure of [
    { status: "waiting_gpt_login", error: "GPT 登录已失效，请重新登录" },
    "GPT 生图等待超时，可能已达到次数限制",
    "ChatGPT quota exhausted",
  ]) {
    const classified = policy.classifyCreativeFailure(failure);
    assert.equal(classified.kind, "provider");
    assert.equal(classified.scope, "provider");
    assert.equal(classified.retryAfterMs, policy.providerRetryMs);
  }
  assert.equal(policy.previousTransientCreativeRetry({
    date: "2026-08-27",
    lastError: "GPT 登录已失效，请重新登录",
    lastErrorScope: "provider",
  }, "2026-08-28", Date.parse("2026-08-28T00:30:00Z")).isTransient, false);
  assert.equal(policy.classifyCreativeFailure("旁白重复且主题错配").kind, "job");
});

test("短重试不越过北京 19 点，且到期时优先续跑原任务", async () => {
  const { policy } = await loadDailyCreativePolicy();
  assert.equal(
    policy.nextTransientCreativeRetryAt(Date.parse("2026-08-27T10:58:30Z")),
    "2026-08-27T10:59:30.000Z",
  );
  assert.equal(policy.nextTransientCreativeRetryAt(Date.parse("2026-08-27T10:59:30Z")), null);

  const jobs = [
    { id: "older", assetId: "asset-a", status: "ready_for_images", createdAt: "2026-08-20T00:00:00Z" },
    { id: "retry-me", assetId: "asset-b", status: "ready_for_images", createdAt: "2026-08-21T00:00:00Z" },
  ];
  const selected = policy.selectDailyCreativeJob(
    jobs,
    new Set(),
    {},
    new Set(),
    0,
    Date.parse("2026-08-27T03:00:00Z"),
    "retry-me",
  );
  assert.equal(selected.id, "retry-me");
  assert.equal(policy.selectDailyCreativeJob(
    jobs,
    new Set(),
    {},
    new Set(),
    0,
    Date.parse("2026-08-27T03:00:00Z"),
    "already-finished",
  ), null);

  const transientJobs = [{
    id: "retry-me",
    assetId: "asset-b",
    status: "transient_wait",
    nextRetryAt: "2026-08-27T02:59:59Z",
    createdAt: "2026-08-21T00:00:00Z",
  }];
  assert.equal(policy.selectDailyCreativeJob(
    transientJobs,
    new Set(),
    {},
    new Set(),
    0,
    Date.parse("2026-08-27T03:00:00Z"),
    "retry-me",
  ), null);
  assert.equal(policy.selectDailyCreativeJob(
    transientJobs,
    new Set(),
    {},
    new Set(),
    0,
    Date.parse("2026-08-27T03:00:00Z"),
    "another-job",
  ), null);

  assert.equal(policy.preferredCreativeRetryDisposition(
    transientJobs,
    "retry-me",
    Date.parse("2026-08-27T03:00:00Z"),
  ).action, "wait_restore");
  assert.equal(policy.preferredCreativeRetryDisposition(
    [{ ...transientJobs[0], nextRetryAt: "2026-08-27T03:01:00Z" }],
    "retry-me",
    Date.parse("2026-08-27T03:00:00Z"),
  ).action, "wait");
  assert.equal(policy.preferredCreativeRetryDisposition(
    [{ id: "retry-me", status: "needs_attention" }],
    "retry-me",
    Date.parse("2026-08-27T03:00:00Z"),
  ).action, "blocked");
  assert.equal(policy.preferredCreativeRetryDisposition(
    [{ id: "retry-me", status: "completed" }],
    "retry-me",
    Date.parse("2026-08-27T03:00:00Z"),
  ).action, "stale");
  assert.equal(policy.preferredCreativeRetryDisposition(
    [],
    "retry-me",
    Date.parse("2026-08-27T03:00:00Z"),
  ).action, "stale");
});
