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
        return { createCreativeRunner: () => ({ run: async () => ({ ok: true }), probeAccounts: async () => ({}) }) };
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
    maxAttempts: DAILY_CREATIVE_MAX_ATTEMPTS,
    maxRevisionStreak: MAX_CONSECUTIVE_REVISION_ATTEMPTS,
  };`;
  vm.runInNewContext(source + expose, sandbox, { filename: fileURLToPath(mainUrl) });
  return { policy: module.exports.__dailyCreativePolicy, source };
}

test("每日目标只计算待审核合格件和已批准件，needs_revision 不占额度", async () => {
  const { policy } = await loadDailyCreativePolicy();
  const today = "2026-08-27";
  const reviews = [
    { date: today, status: "needs_revision" },
    { date: today, status: "needs_revision" },
    { date: today, status: "pending_review" },
    { date: today, status: "approved_for_drafts" },
    { date: today, status: "approved_for_publish" },
    { date: "2026-08-26", status: "pending_review" },
  ];
  assert.equal(policy.qualifiedCreativeReviewCount(reviews, today), 3);
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
  assert.equal(policy.maxAttempts, 12);
  assert.equal(policy.isClearlyJobSpecificCreativeError("旁白重复且主题错配"), true);
  assert.equal(policy.isClearlyJobSpecificCreativeError("豆包账号未登录"), false);
  assert.equal(policy.isDailyCreativeWindowOpen("2026-08-27T00:00:00Z"), true); // 北京 08:00
  assert.equal(policy.isDailyCreativeWindowOpen("2026-08-27T11:00:00Z"), false); // 北京 19:00
  assert.match(source, /while \(qualifiedToday < DAILY_CREATIVE_TARGET && attempts < DAILY_CREATIVE_MAX_ATTEMPTS\)/);
  assert.match(source, /if \(!isDailyCreativeWindowOpen\(\)\) break/);
  assert.match(source, /lastErrorScope: jobSpecific \? "job" : "provider"/);
});
