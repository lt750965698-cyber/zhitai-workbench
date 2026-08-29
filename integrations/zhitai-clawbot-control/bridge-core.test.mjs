import assert from "node:assert/strict";
import test from "node:test";

import {
  createBeforeDispatchHandler,
  createMessageSentHandler,
  sanitizedMessageSentResult,
} from "./bridge-core.mjs";

test("routes private Weixin commands to deterministic controller", async () => {
  const calls = [];
  const handler = createBeforeDispatchHandler({ execute: async (value) => { calls.push(value); return { text: "织台状态：在线" }; } });
  const result = await handler({ Body: "状态", From: "user-1", AccountId: "account-1", ChatType: "direct", OriginatingChannel: "openclaw-weixin" }, {});
  assert.equal(result.handled, true);
  assert.equal(result.text, "织台状态：在线");
  assert.deepEqual(calls, [{ text: "状态", senderId: "user-1", accountId: "account-1", isGroup: false }]);
});

test("automated keepalive is handled without an outbound reply or notification sound", async () => {
  const handler = createBeforeDispatchHandler({
    execute: async () => ({ automatedKeepalive: true, text: "已保活" }),
  });
  const result = await handler({
    Body: "ZT_KEEPALIVE",
    From: "user-1",
    AccountId: "account-1",
    ChatType: "direct",
    OriginatingChannel: "openclaw-weixin",
  }, {});
  assert.deepEqual(result, { handled: true });
  assert.equal(Object.hasOwn(result, "text"), false);
});

test("uses a strict direct-Weixin conversation fallback when canonical senderId is absent", async () => {
  const calls = [];
  const handler = createBeforeDispatchHandler({ execute: async (value) => { calls.push(value); return { text: "织台状态：在线" }; } });
  const result = await handler({
    content: "状态",
    body: "状态",
    channel: "openclaw-weixin",
    isGroup: false,
  }, {
    channelId: "openclaw-weixin",
    accountId: "account-1",
    conversationId: "direct_user-1@im.wechat",
  });

  assert.equal(result.handled, true);
  assert.equal(result.text, "织台状态：在线");
  assert.deepEqual(calls, [{
    text: "状态",
    senderId: "direct_user-1@im.wechat",
    accountId: "account-1",
    isGroup: false,
  }]);
});

test("keeps explicit sender precedence over the conversation fallback", async () => {
  const calls = [];
  const handler = createBeforeDispatchHandler({ execute: async (value) => { calls.push(value); return { text: "ok" }; } });
  await handler({ content: "状态", channel: "openclaw-weixin", senderId: "explicit-user" }, {
    channelId: "openclaw-weixin",
    conversationId: "fallback_user@im.wechat",
  });
  assert.equal(calls[0].senderId, "explicit-user");
});

test("fails closed when a missing sender has no valid direct-Weixin conversation", async () => {
  const calls = [];
  const handler = createBeforeDispatchHandler({ execute: async (value) => { calls.push(value); return { text: "should-not-run" }; } });
  for (const conversationId of [
    "",
    "not-a-weixin-user",
    "user@im.wechat.example",
    "user/escape@im.wechat",
    "user@example.com",
  ]) {
    const result = await handler({ content: "状态", channel: "openclaw-weixin" }, {
      channelId: "openclaw-weixin",
      conversationId,
    });
    assert.equal(result.handled, true);
    assert.match(result.text, /无法确认微信发送者/);
  }
  assert.equal(calls.length, 0);
});

test("routes links to the deterministic ingest controller and blocks group control", async () => {
  const calls = [];
  const handler = createBeforeDispatchHandler({ execute: async (value) => { calls.push(value); return { text: "已进入下载与入库队列" }; } });
  const linkResult = await handler({ Body: "https://weixin.qq.com/sph/abc", From: "user-1", OriginatingChannel: "openclaw-weixin" }, {});
  assert.match(linkResult.text, /入库队列/);
  assert.equal(calls.length, 1);
  const groupResult = await handler({ Body: "状态", From: "user-1", ChatType: "group", OriginatingChannel: "openclaw-weixin" }, {});
  assert.match(groupResult.text, /只接受私聊/);
  assert.equal(calls.length, 1);

  const canonicalGroupResult = await handler({ content: "状态", channel: "openclaw-weixin", isGroup: true }, {
    channelId: "openclaw-weixin",
    conversationId: "direct_user-1@im.wechat",
  });
  assert.match(canonicalGroupResult.text, /只接受私聊/);
  assert.equal(calls.length, 1);
});

test("ignores other channels", async () => {
  const handler = createBeforeDispatchHandler({ execute: async () => ({ text: "no" }) });
  assert.equal(await handler({ Body: "状态", OriginatingChannel: "telegram" }, {}), undefined);
});

test("message_sent reports only a sanitized outbound result for Weixin", async () => {
  const reports = [];
  const handler = createMessageSentHandler({ report: async (value) => { reports.push(value); } });
  const event = {
    event: {
      canonical: true,
      context: {
        to: "private-user@im.wechat",
        content: "private message content",
        success: false,
        error: "sendMessage ret=-2 errmsg=prepare failed token=private-token",
      },
    },
  };
  const context = {
    pluginContext: {
      canonical: true,
      context: {
        channelId: "openclaw-weixin",
        accountId: "private-account",
        conversationId: "private-user@im.wechat",
      },
    },
  };

  await handler(event, context);
  assert.deepEqual(reports, [{ success: false, errorCode: "session_refresh_required" }]);
  assert.deepEqual(Object.keys(reports[0]).sort(), ["errorCode", "success"]);
  assert.doesNotMatch(JSON.stringify(reports), /private|token|content|account|conversation/i);
});

test("message_sent ignores other channels and requires explicit boolean success", async () => {
  const reports = [];
  const handler = createMessageSentHandler({ report: async (value) => { reports.push(value); } });
  await handler({ success: true, content: "telegram" }, { channelId: "telegram" });
  await handler({ success: "true", error: "network failed", content: "hidden" }, { channelId: "openclaw-weixin" });
  await handler({ success: true, content: "hidden" }, { channelId: "openclaw-weixin" });
  assert.deepEqual(reports, [
    { success: false, errorCode: "network_unavailable" },
    { success: true, errorCode: null },
  ]);
  assert.deepEqual(sanitizedMessageSentResult({ success: false, error: "unknown private detail" }), {
    success: false,
    errorCode: "delivery_failed",
  });
});
