import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { NotificationCenter } from "../local-agent/notification-center.mjs";
import {
  RemoteController,
  REMOTE_KEEPALIVE_ACK_TEXT,
  REMOTE_KEEPALIVE_ASCII,
  REMOTE_KEEPALIVE_TEXT,
  shouldAcknowledgeRemoteUserReply,
} from "../local-agent/remote-controller.mjs";

test("ClawBot fixed commands pair once, ingests links with notes, and confirms generation", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "zhitai-remote-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const enqueued = [];
  const ingested = [];
  const controller = new RemoteController({
    dataDir,
    getSummary: async (kind) => kind === "learning" ? "学习摘要" : "入库摘要",
    getMaterials: async () => [{ id: "kb_1", title: "第一条素材" }],
    getQueue: async () => "队列摘要",
    getFailures: async () => "没有失败",
    getStatus: async () => "织台在线",
    ingestLink: async (payload) => { ingested.push(payload); return { id: "ing_1", title: "测试视频", status: "queued" }; },
    enqueueCreative: async (assetId) => { enqueued.push(assetId); return { id: "creative_1" }; },
    pauseCreative: async () => "已暂停",
    resumeCreative: async () => "已继续",
  });
  await controller.init();

  const status = await controller.route({ text: "状态", senderId: "owner", accountId: "bot" });
  assert.equal(status.text, "织台在线");
  assert.equal(status.authorizedSender, true);
  assert.equal((await controller.status()).paired, true);

  const rejected = await controller.route({ text: "状态", senderId: "other", accountId: "bot" });
  assert.equal(rejected.code, "sender_not_allowed");
  assert.equal(rejected.authorizedSender, false);

  const group = await controller.route({ text: "状态", senderId: "owner", accountId: "bot", isGroup: true });
  assert.equal(group.code, "group_not_allowed");
  assert.equal(group.authorizedSender, false);

  controller.settings.enabled = false;
  const disabledOwner = await controller.route({ text: "已收到", senderId: "owner", accountId: "bot" });
  assert.equal(disabledOwner.code, "remote_disabled");
  assert.equal(disabledOwner.authorizedSender, true);
  const disabledOther = await controller.route({ text: "已收到", senderId: "other", accountId: "bot" });
  assert.equal(disabledOther.authorizedSender, false);
  controller.settings.enabled = true;

  const link = await controller.route({ text: "https://weixin.qq.com/sph/abc 参考它的厨房动线", senderId: "owner", accountId: "bot" });
  assert.match(link.text, /下载与入库队列/);
  assert.equal(ingested[0].userNote, "参考它的厨房动线");

  const prepared = await controller.route({ text: "生成 1", senderId: "owner", accountId: "bot" });
  const code = prepared.text.match(/确认 (\d{4})/)?.[1];
  assert.ok(code);
  assert.deepEqual(enqueued, []);
  const confirmed = await controller.route({ text: `确认 ${code}`, senderId: "owner", accountId: "bot" });
  assert.match(confirmed.text, /已加入生成队列/);
  assert.deepEqual(enqueued, ["kb_1"]);
});

test("automated ClawBot keepalive is isolated from commands and never acknowledges business blockers", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "zhitai-remote-keepalive-"));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const businessCalls = [];
  const controller = new RemoteController({
    dataDir,
    getSummary: async (kind) => { businessCalls.push(`summary:${kind}`); return "摘要"; },
    getMaterials: async () => { businessCalls.push("materials"); return []; },
    getQueue: async () => { businessCalls.push("queue"); return "队列"; },
    getFailures: async () => { businessCalls.push("failures"); return "失败"; },
    getStatus: async () => { businessCalls.push("status"); return "在线"; },
    ingestLink: async () => { businessCalls.push("ingest"); return { id: "unexpected" }; },
    enqueueCreative: async () => { businessCalls.push("creative"); return { id: "unexpected" }; },
    approveCreative: async () => { businessCalls.push("approve"); return "unexpected"; },
    reviseCreative: async () => { businessCalls.push("revise"); return "unexpected"; },
    pauseCreative: async () => { businessCalls.push("pause"); return "unexpected"; },
    resumeCreative: async () => { businessCalls.push("resume"); return "unexpected"; },
  });
  await controller.init();

  // 先用普通白名单私聊完成配对；保活协议本身不承担配对或业务命令语义。
  await controller.route({ text: "状态", senderId: "owner", accountId: "bot" });
  businessCalls.length = 0;

  const notificationCenter = new NotificationCenter({
    dataDir,
    buildDigest: async () => "摘要",
    clawbot: {
      status: async () => ({ ready: true, paired: true, pairedCount: 1 }),
      send: async () => ({ ok: true, accepted: 1 }),
    },
  });
  await notificationCenter.init();
  await notificationCenter.send("发布需处理", "视频号登录已失效", "publish_failed");
  assert.equal((await notificationCenter.publicState()).blockers.openCount, 1);

  const routeLikeServer = async (text) => {
    const result = await controller.route({ text, senderId: "owner", accountId: "bot" });
    if (shouldAcknowledgeRemoteUserReply(result)) {
      await notificationCenter.acknowledgeFromUserReply();
    }
    return result;
  };

  const keepalive = await routeLikeServer(REMOTE_KEEPALIVE_TEXT);
  assert.equal(keepalive.ok, true);
  assert.equal(keepalive.text, REMOTE_KEEPALIVE_ACK_TEXT);
  assert.equal(keepalive.code, "automated_keepalive");
  assert.equal(keepalive.automatedKeepalive, true);
  assert.equal(keepalive.authorizedSender, true);
  assert.deepEqual(businessCalls, [], "保活不得调用摘要、入库、生成或其它业务处理器");
  let state = await notificationCenter.publicState();
  assert.equal(state.blockers.openCount, 1, "自动保活不得关闭业务 blocker");
  assert.equal(state.blockers.items[0].status, "open");

  const asciiKeepalive = await routeLikeServer(REMOTE_KEEPALIVE_ASCII);
  assert.equal(asciiKeepalive.ok, true);
  assert.equal(asciiKeepalive.text, REMOTE_KEEPALIVE_ACK_TEXT);
  assert.equal(asciiKeepalive.code, "automated_keepalive");
  assert.deepEqual(businessCalls, [], "ASCII 保活别名也不得进入业务命令处理");

  const unauthorized = await controller.route({ text: REMOTE_KEEPALIVE_TEXT, senderId: "other", accountId: "bot" });
  assert.equal(unauthorized.code, "sender_not_allowed");
  assert.equal(unauthorized.authorizedSender, false);
  assert.equal(unauthorized.automatedKeepalive, undefined);

  const group = await controller.route({ text: REMOTE_KEEPALIVE_TEXT, senderId: "owner", accountId: "bot", isGroup: true });
  assert.equal(group.code, "group_not_allowed");
  assert.equal(group.automatedKeepalive, undefined);

  controller.settings.enabled = false;
  const disabledKeepalive = await routeLikeServer(REMOTE_KEEPALIVE_TEXT);
  assert.equal(disabledKeepalive.text, REMOTE_KEEPALIVE_ACK_TEXT);
  assert.equal(disabledKeepalive.automatedKeepalive, true);
  assert.equal((await notificationCenter.publicState()).blockers.openCount, 1, "遥控停用时的保活仍不得关闭业务 blocker");
  controller.settings.enabled = true;

  const ordinaryReply = await routeLikeServer("收到");
  assert.equal(ordinaryReply.authorizedSender, true);
  assert.equal(ordinaryReply.automatedKeepalive, undefined);
  state = await notificationCenter.publicState();
  assert.equal(state.blockers.openCount, 0, "普通白名单私聊仍应确认业务 blocker");
  assert.equal(state.blockers.acknowledgedCount, 1);
});
