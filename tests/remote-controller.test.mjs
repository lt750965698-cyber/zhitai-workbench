import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { RemoteController } from "../local-agent/remote-controller.mjs";

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
