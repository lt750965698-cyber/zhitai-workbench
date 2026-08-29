import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("../app/ContentWorkbench.tsx", import.meta.url), "utf8");

function loadCreativeUiHelpers() {
  const start = source.indexOf("const CREATIVE_RUNNABLE_STATUSES");
  const end = source.indexOf("\nconst LOCAL_AGENT_URL", start);
  assert.ok(start >= 0 && end > start, "应能定位生成队列 UI 状态函数");
  const compiled = ts.transpileModule(source.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return Function(
    `"use strict"; ${compiled}; return { creativeJobStatusText, creativeJobRetryText, creativeJobResumeText, creativeJobErrorLabel, isCreativeRunnableStatus, isCreativeBatchStartableStatus, isCreativePreparingStatus, isCreativeActiveStatus, isCreativePollStopStatus, isCreativeManualAttentionStatus, isCreativeNoDuplicateStartStatus, isCreativeOperationWindowOpen };`,
  )();
}

test("生成队列将网页短等待和真实阻塞显示为明确中文状态", () => {
  const helpers = loadCreativeUiHelpers();
  const waiting = {
    status: "transient_wait",
    nextRetryAt: "2026-08-28T10:56:01.000Z",
    resumeStatus: "ready_for_images",
  };
  assert.equal(helpers.creativeJobStatusText(waiting), "短暂等待，自动重试");
  assert.equal(helpers.creativeJobRetryText(waiting), "下一次自动重试：北京时间 2026-08-28 18:56:01");
  assert.equal(helpers.creativeJobResumeText(waiting), "恢复后从GPT 生图原断点继续，不会新建任务");
  assert.equal(helpers.creativeJobErrorLabel(waiting.status), "等待原因");

  const attention = { status: "needs_attention", resumeStatus: "ready_for_seedance" };
  assert.equal(helpers.creativeJobStatusText(attention), "需处理");
  assert.equal(helpers.creativeJobRetryText(attention), null);
  assert.equal(helpers.creativeJobResumeText(attention), "恢复后从豆包生成原断点继续，不会新建任务");
  assert.equal(helpers.creativeJobErrorLabel(attention.status), "处理原因");
});

test("短暂等待不会成为手动执行候选，轮询会及时识别两种中断态", () => {
  const helpers = loadCreativeUiHelpers();
  for (const status of ["transient_wait", "needs_attention"]) {
    assert.equal(helpers.isCreativeRunnableStatus(status), false, `${status} 不得直接驱动网页生成`);
    assert.equal(helpers.isCreativeBatchStartableStatus(status), false, `${status} 不得启用批量启动按钮`);
    assert.equal(helpers.isCreativePollStopStatus(status), true, `${status} 应结束前台准备轮询`);
  }
  assert.equal(helpers.isCreativeActiveStatus("transient_wait"), true, "自动等待仍应显示为活跃任务");
  assert.equal(helpers.isCreativePreparingStatus("transient_wait"), false, "自动等待不应让批量流程重复手动启动");
  assert.equal(helpers.isCreativeManualAttentionStatus("needs_attention"), true, "真实阻塞计入需处理");
});

test("界面恢复操作复用原任务 ID，不通过创建接口生成替代任务", () => {
  const button = source.match(/job\.status === "needs_attention"[^\n]+重试原断点/)?.[0] || "";
  assert.match(button, /retryOriginalJob\(job\)/);
  assert.match(button, /重试原断点/);

  const retryStart = source.indexOf("async function retryOriginalJob(");
  const retryEnd = source.indexOf("\n  async function advanceAndOpen", retryStart);
  const retrySource = source.slice(retryStart, retryEnd);
  assert.match(retrySource, /creative\/jobs\/\$\{encodeURIComponent\(job\.id\)\}\/\$\{action\}/);
  assert.match(retrySource, /await runUnattended\(resumed, false\)/, "白天恢复后应立即续跑原任务");
  assert.match(retrySource, /当前不在 08:00–19:00 创作窗口/);
  assert.doesNotMatch(retrySource, /JSON\.stringify\(\{ assetId:/, "恢复原断点不得创建新任务");
});

test("单条和批量入口都对 transient_wait 做去重保护", () => {
  const startStart = source.indexOf("async function startSelectedUnattended(");
  const startEnd = source.indexOf("\n  async function updateJob", startStart);
  const startSource = source.slice(startStart, startEnd);
  assert.ok(startSource.indexOf('selectedJob?.status === "transient_wait"') < startSource.indexOf("setPreparing(true)"), "发起 POST 前应先拦截自动等待任务");
  assert.match(startSource, /无需再次点击生成/);
  assert.match(source, /const deferredJobIds = new Set\(visibleJobs\.filter\(\(job\) => job\.status === "transient_wait"\)/);
  assert.match(source, /isCreativeRunnableStatus\(job\.status\) && !deferredJobIds\.has\(job\.id\)/);
  assert.match(source, /while \(!isCreativePollStopStatus\(job\.status\)/);
});

test("失败任务不会从顶部入口新建替代任务，且创作窗口按北京时间判断", () => {
  const helpers = loadCreativeUiHelpers();
  for (const status of ["transient_wait", "needs_attention", "failed"]) {
    assert.equal(helpers.isCreativeNoDuplicateStartStatus(status), true);
  }
  assert.equal(helpers.isCreativeOperationWindowOpen("2026-08-28T00:00:00Z"), true); // 北京 08:00
  assert.equal(helpers.isCreativeOperationWindowOpen("2026-08-28T11:00:00Z"), false); // 北京 19:00

  const startStart = source.indexOf("async function startSelectedUnattended(");
  const startEnd = source.indexOf("\n  async function updateJob", startStart);
  const startSource = source.slice(startStart, startEnd);
  assert.ok(startSource.indexOf('selectedJob?.status === "failed"') < startSource.indexOf("setPreparing(true)"));
  assert.match(startSource, /请在任务卡点击“重试原任务”/);
});
