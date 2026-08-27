import assert from "node:assert/strict";
import test from "node:test";

import {
  accountLoggedIn,
  buildRuntimeConditions,
  normalizeCreativeConditionReport,
} from "../local-agent/runtime-conditions.mjs";

const CHECKED_AT = "2026-08-26T10:00:00.000Z";
const DATE_KEY = "2026-08-26";

function readyInputs(overrides = {}) {
  return {
    checkedAt: CHECKED_AT,
    dateKey: DATE_KEY,
    services: [{
      id: "openclaw_weixin",
      business: { ready: false, reason: "ClawBot 未登录" },
    }],
    remote: { paired: false },
    notifications: { clawbot: { operational: false, deliveryState: "unverified" } },
    filehelper: { filehelperPageConnected: true, wechatLoggedIn: true, checkedAt: CHECKED_AT },
    creative: normalizeCreativeConditionReport({
      gpt: { state: "ready", reason: "GPT 已登录" },
      doubao: [{ id: "account-1", label: "豆包账号 1", state: "ready", reason: "可生成" }],
    }, CHECKED_AT, DATE_KEY),
    publisherAccounts: [
      { platform: "抖音", loginStatus: "已登录" },
      { platform: "视频号", loginStatus: "已登录" },
    ],
    xiaohongshu: { loggedIn: true },
    wechatOfficial: { configured: true, ready: true },
    backlog: {},
    ...overrides,
  };
}

function byId(snapshot, id) {
  return snapshot.conditions.find((row) => row.id === id);
}

test("文件传输助手是必需主入口，ClawBot 离线仅影响可选备用与手机控制", () => {
  const snapshot = buildRuntimeConditions(readyInputs());
  assert.equal(byId(snapshot, "filehelper").state, "ready");
  assert.deepEqual(byId(snapshot, "filehelper"), {
    id: "filehelper",
    label: "微信文件传输助手主入口",
    state: "ready",
    reason: "文件传输助手网页与微信登录均在线，可接收手机转发",
    checkedAt: CHECKED_AT,
    actionView: "inbox",
    optional: false,
    ingressRole: "primary",
  });
  assert.deepEqual(byId(snapshot, "clawbot"), {
    id: "clawbot",
    label: "ClawBot 入站遥控与备用通知",
    state: "optional",
    reason: "ClawBot 未登录；不阻断文件传输助手主入口",
    checkedAt: CHECKED_AT,
    actionView: "messages",
    optional: true,
    ingressRole: "fallback",
  });
  assert.deepEqual(snapshot.summary, {
    state: "ready",
    readyCount: 7,
    attentionCount: 0,
    unknownCount: 0,
  });

  const fallbackCannotMaskPrimary = buildRuntimeConditions(readyInputs({
    services: [{ id: "openclaw_weixin", business: { ready: true, reason: "ClawBot 可用" } }],
    remote: { paired: true },
    notifications: { clawbot: { operational: true, deliveryState: "ready" } },
    filehelper: { filehelperPageConnected: false, wechatLoggedIn: false, checkedAt: CHECKED_AT },
  }));
  assert.equal(byId(fallbackCannotMaskPrimary, "clawbot").state, "ready");
  assert.equal(byId(fallbackCannotMaskPrimary, "filehelper").state, "attention");
  assert.equal(fallbackCannotMaskPrimary.summary.state, "attention");
  assert.equal(fallbackCannotMaskPrimary.summary.attentionCount, 1);

  const serviceMap = buildRuntimeConditions(readyInputs({
    services: {
      openclaw_weixin: { id: "openclaw_weixin", business: { ready: true, reason: "备用通道可用" } },
    },
    remote: { paired: true },
    notifications: { clawbot: { operational: true, deliveryState: "ready" } },
  }));
  assert.equal(byId(serviceMap, "clawbot").state, "ready", "兼容本地节点 getServiceStates 的对象映射形态");

  const staleOutbound = buildRuntimeConditions(readyInputs({
    services: [{ id: "openclaw_weixin", business: { ready: true, reason: "ClawBot 可用" } }],
    remote: { paired: true },
    notifications: { clawbot: { operational: false, deliveryState: "session_refresh_required" } },
  }));
  assert.equal(byId(staleOutbound, "clawbot").state, "optional");
  assert.match(byId(staleOutbound, "clawbot").reason, /主动通知会话需由用户发一条新消息刷新/);
});

test("GPT 与多豆包只接受当天上报；账号池任一可用即可继续并逐账号披露", () => {
  const creative = normalizeCreativeConditionReport({
    gpt: { state: "ready", reason: "GPT 会话有效" },
    doubao: [
      { id: "primary", label: "豆包主账号", state: "ready", reason: "额度可用" },
      { id: "backup 2", label: "豆包备用 2", state: "attention", reason: "需要重新登录" },
      { id: "backup-3", label: "豆包备用 3", state: "unknown", reason: "页面检查失败" },
    ],
  }, CHECKED_AT, DATE_KEY);
  const fresh = buildRuntimeConditions(readyInputs({ creative }));

  assert.equal(byId(fresh, "gpt").state, "ready");
  assert.equal(byId(fresh, "doubao").state, "ready");
  assert.equal(byId(fresh, "doubao").label, "豆包账号池（1/3 可用）");
  assert.equal(byId(fresh, "doubao:primary").state, "ready");
  assert.equal(byId(fresh, "doubao:backup-2").state, "attention");
  assert.equal(byId(fresh, "doubao:backup-3").state, "unknown");
  assert.ok(fresh.conditions.filter((row) => row.id.startsWith("doubao:")).every((row) => row.optional));

  const stale = buildRuntimeConditions(readyInputs({
    creative: { ...creative, date: "2026-08-25" },
  }));
  assert.equal(byId(stale, "gpt").state, "unknown");
  assert.match(byId(stale, "gpt").reason, /今天尚未检查/);
  assert.equal(byId(stale, "doubao").state, "unknown");
  assert.equal(stale.conditions.some((row) => row.id.startsWith("doubao:")), false);
  assert.equal(stale.summary.state, "unknown");
  assert.equal(stale.summary.unknownCount, 2);
});

test("发布账号按真实登录态汇总，且积压统计原样进入统一快照", () => {
  const backlog = {
    analysis: {
      total: 29,
      queued: 21,
      running: 1,
      retryWait: 3,
      completed: 0,
      needsAttention: 4,
      remaining: 29,
    },
    creative: {
      waiting: 8,
      waitingForImages: 3,
      waitingForSeedance: 0,
      waitingForAssembly: 0,
      preparing: 0,
      paused: 0,
      failed: 5,
      completed: 1,
    },
  };
  const snapshot = buildRuntimeConditions(readyInputs({
    publisherAccounts: [
      { platform: "抖音", loginStatus: "expired", phone: "13800138000" },
      { platform: "视频号", loginStatus: "已登录", phone: "13900139000" },
      { platform: "小红书", loginStatus: "offline" },
    ],
    xiaohongshu: { loggedIn: false, reason: "需扫码登录小红书" },
    wechatOfficial: { configured: true, credentialReady: true, draftReady: false, ready: false, needsAttention: true, reason: "草稿接口权限待验证" },
    backlog,
  }));

  assert.equal(accountLoggedIn({ loginStatus: "已登录" }), true);
  assert.equal(accountLoggedIn({ status: "online" }), true);
  assert.equal(accountLoggedIn({ loginStatus: "expired" }), false);
  assert.equal(accountLoggedIn({ status: "offline" }), false);
  assert.equal(byId(snapshot, "douyin").state, "attention");
  assert.equal(byId(snapshot, "wechat_channels").state, "ready");
  assert.equal(byId(snapshot, "xiaohongshu").state, "attention");
  assert.equal(byId(snapshot, "wechat_official").state, "attention");
  assert.deepEqual(snapshot.backlog, backlog);
  assert.deepEqual(snapshot.summary, {
    state: "attention",
    readyCount: 4,
    attentionCount: 3,
    unknownCount: 0,
  });
  assert.doesNotMatch(JSON.stringify(snapshot), /13800138000|13900139000/, "统一状态不得泄露完整手机号");
});

test("公众号明确权限失败标为 attention，暂时校验失败仍为 unknown", () => {
  const permissionDenied = buildRuntimeConditions(readyInputs({
    wechatOfficial: {
      configured: true,
      credentialReady: true,
      draftReady: false,
      ready: false,
      needsAttention: true,
      reason: "公众号凭证有效，但当前账号未获得草稿箱接口权限（48001）",
    },
  }));
  assert.equal(byId(permissionDenied, "wechat_official").state, "attention");
  assert.match(byId(permissionDenied, "wechat_official").reason, /48001/);

  const transientFailure = buildRuntimeConditions(readyInputs({
    wechatOfficial: {
      configured: true,
      credentialReady: true,
      draftReady: false,
      ready: false,
      needsAttention: false,
      reason: "草稿箱接口暂时无法校验",
    },
  }));
  assert.equal(byId(transientFailure, "wechat_official").state, "unknown");
});

test("发布账号探针失败返回 unknown，而不是把引擎不可达误报为未登录", () => {
  const snapshot = buildRuntimeConditions(readyInputs({
    publisherAccounts: null,
    publisherError: "publisher_probe_unavailable",
    xiaohongshu: {},
  }));
  assert.equal(byId(snapshot, "douyin").state, "unknown");
  assert.equal(byId(snapshot, "wechat_channels").state, "unknown");
  assert.equal(byId(snapshot, "xiaohongshu").state, "unknown");
  assert.match(byId(snapshot, "douyin").reason, /publisher_probe_unavailable/);
});
