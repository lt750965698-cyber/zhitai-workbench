import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import ts from "typescript";

const pageSrc = fs.readFileSync(new URL("../app/PublishNative.tsx", import.meta.url), "utf8");

function loadPublishHistoryHelpers() {
  const start = pageSrc.indexOf("function recordOf");
  const end = pageSrc.indexOf("\nexport function PublishNative", start);
  assert.ok(start >= 0 && end > start, "应能定位发布历史格式化函数");
  const compiled = ts.transpileModule(pageSrc.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  return Function(
    `"use strict"; ${compiled}; return { publishStatusText, historyStatusText, historyPlatformText, historyRecordTimeText };`,
  )();
}

test("发布中心为小红书和公众号提供明确的多账号添加入口", () => {
  assert.match(pageSrc, /添加小红书账号/);
  assert.match(pageSrc, /\/api\/v1\/publisher\/xhs\/accounts", "POST", \{ label \}/);
  assert.match(pageSrc, /login-qrcode" \+ query/);
  assert.match(pageSrc, /accountId=\$\{encodeURIComponent\(explicitAccountId\)\}/);

  assert.match(pageSrc, /添加公众号/);
  assert.match(pageSrc, /\/api\/v1\/publisher\/wechat-official\/accounts\/credentials/);
  assert.match(pageSrc, /accountId: explicitAccountId/);
  assert.match(pageSrc, /label: wechatLabel\.trim\(\)/);
});

test("图文发布按平台传递明确账号，同时兼容旧版单账号", () => {
  assert.match(pageSrc, /accountIdByDestination/);
  assert.match(pageSrc, /accountIds: accountIdByDestination/);
  assert.match(pageSrc, /legacy-xiaohongshu/);
  assert.match(pageSrc, /legacy-wechat-official/);
  assert.match(pageSrc, /选择小红书发布账号/);
  assert.match(pageSrc, /选择公众号发布账号/);
  assert.match(pageSrc, /请为每个图文平台选择一个已就绪的明确账号/);
  assert.match(pageSrc, /account\.isDefault && account\.ready/);
  assert.match(pageSrc, /默认草稿/);
});

test("公众号密钥只在本机密码表单录入，成功或取消后清空且不回显", () => {
  assert.match(pageSrc, /type="password" autoComplete="new-password"/);
  assert.match(pageSrc, /旧值不会回显/);
  assert.match(pageSrc, /setWechatAppId\(""\)/);
  assert.match(pageSrc, /setWechatAppSecret\(""\)/);
  assert.ok(!pageSrc.includes("wechatAppSecret: imageTextStatus"));
});

test("发布中心不包含自动播放或媒体播放器", () => {
  assert.ok(!/<(?:video|audio)\b/i.test(pageSrc));
  assert.ok(!/\bautoPlay\b|\bautoplay\b|\.play\s*\(/.test(pageSrc));
});

test("图文账号先独立加载，不等待视频账号 CLI", () => {
  assert.match(pageSrc, /const imageText = await zapi\(LOCAL_AGENT \+ "\/api\/v1\/publisher\/image-text\/status"/);
  assert.match(pageSrc, /const immediateImageAccounts = imageTextAccountsFrom\(null, nextImageTextStatus\)/);
  assert.match(pageSrc, /const \[a, h\] = await Promise\.all\(\[accountsPromise, historyPromise\]\)/);
  assert.match(pageSrc, /const statusResult = await zapi\(LOCAL_AGENT \+ "\/api\/v1\/publisher\/image-text\/status"/);
});

test("发布历史不直出引擎英文状态，并保守区分上传与公开", () => {
  const { publishStatusText, historyStatusText } = loadPublishHistoryHelpers();
  assert.equal(publishStatusText("cancelled"), "已取消，未执行");
  assert.equal(publishStatusText("submitted"), "已上传，公开状态待核实");
  assert.equal(publishStatusText("submitted_unverified"), "已上传，公开状态待核实");
  assert.equal(publishStatusText("public"), "已公开发布");
  assert.equal(publishStatusText("platform_draft"), "已保存到平台草稿");
  assert.equal(publishStatusText("needs_reconciliation"), "已提交，平台结果待核对");
  assert.equal(
    publishStatusText("retry_wait", { nextAttemptAt: "2026-08-28T11:35:15.000Z" }),
    "临时故障，等待自动重试：北京时间 2026-08-28 19:35",
  );
  assert.equal(historyStatusText({ state: "made_up_engine_state" }), "平台状态待核实");

  for (const status of [
    "scheduled", "queued", "pending", "preflighting", "submitting", "public",
    "platform_draft", "submitted_unverified", "needs_attention", "needs_reconciliation",
    "cancelled", "draft", "submitted", "failed", "unknown",
  ]) {
    const rendered = publishStatusText(status);
    assert.notEqual(rendered, status, `${status} 不得直出`);
    assert.match(rendered, /[\u3400-\u9fff]/, `${status} 应显示中文结论`);
  }
  assert.doesNotMatch(pageSrc, /<span>\{st\}<\/span>/);
  assert.doesNotMatch(pageSrc, /MatrixMedia 状态/);
});

test("已排期状态使用 scheduledAt 换算北京时间，不冒用记录时间", () => {
  const { publishStatusText, historyRecordTimeText } = loadPublishHistoryHelpers();
  assert.equal(
    publishStatusText("scheduled", { scheduledAt: "2026-08-28T11:35:00.000Z", time: "2026-08-27T21:21:46.898Z" }),
    "已排期：北京时间 2026-08-28 19:35",
  );
  assert.equal(
    publishStatusText("scheduled", { scheduledAt: "2026-08-28T11:42:00.000Z", schedulerState: "scheduler_inactive" }),
    "旧排期未被织台接管，不会自动执行：北京时间 2026-08-28 19:42",
  );
  assert.equal(publishStatusText("scheduled", { time: "2026-08-28T11:35:00.000Z" }), "已排期（发布时间未返回）");
  assert.equal(historyRecordTimeText({ time: "2026-08-28T09:13:30.327Z" }), "记录时间：北京时间 2026-08-28 17:13");
});

test("发布历史从顶层 platform 或 targets destination 推导中文平台名", () => {
  const { historyPlatformText } = loadPublishHistoryHelpers();
  assert.equal(historyPlatformText({ platform: "xhs" }), "小红书");
  assert.equal(historyPlatformText({ targets: [{ destination: "dy" }, { destination: "sph" }] }), "抖音、视频号");
  assert.equal(historyPlatformText({ platform: "unknown", targets: [{ destination: "wechat_official" }] }), "微信公众号");
  assert.equal(historyPlatformText({ targets: ["ks:acct_opaque"] }), "快手");
  assert.equal(historyPlatformText({}), "平台未返回");
});
