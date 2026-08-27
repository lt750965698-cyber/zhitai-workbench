import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ClawBotNotifier } from "../local-agent/clawbot-notifier.mjs";

test("ClawBot notifier reuses paired official session without exposing credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-clawbot-notify-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const stateDir = join(root, "state");
  const accountDir = join(stateDir, "openclaw-weixin", "accounts");
  await mkdir(dataDir, { recursive: true });
  await mkdir(accountDir, { recursive: true });
  const sender = "paired-user@im.wechat";
  const accountId = "account-im-bot";
  await writeFile(join(dataDir, "remote-control-settings.json"), JSON.stringify({ allowedSenders: [sender] }));
  await writeFile(join(stateDir, "openclaw-weixin", "accounts.json"), JSON.stringify([accountId]));
  await writeFile(join(accountDir, `${accountId}.json`), JSON.stringify({ token: "secret-token", baseUrl: "https://example.invalid" }));
  await writeFile(join(accountDir, `${accountId}.context-tokens.json`), JSON.stringify({ [sender]: "secret-context" }));
  const sendModule = join(root, "send.js");
  await writeFile(sendModule, "export const unused = true;\n");
  const calls = [];
  const notifier = new ClawBotNotifier({
    dataDir,
    stateDir,
    sendModule,
    sendImpl: async (payload) => { calls.push(payload); return { messageId: "m1" }; },
  });
  const state = await notifier.status();
  assert.equal(state.ready, true);
  assert.equal(state.paired, true);
  assert.equal(state.pairedCount, 1);
  assert.equal(state.reason, null);
  assert.match(state.contextUpdatedAt, /^\d{4}-\d{2}-\d{2}T/);
  const result = await notifier.send("织台提醒", "下载失败");
  assert.deepEqual(result, { ok: true, accepted: 1 });
  assert.equal(calls[0].to, sender);
  assert.equal(calls[0].text, "织台提醒\n下载失败");
  assert.equal(JSON.stringify(result).includes("secret"), false);
  notifier.sendImpl = async () => { throw new Error("context token expired: secret-context"); };
  const expired = await notifier.send("织台提醒", "再次测试");
  assert.deepEqual(expired, { ok: false, error: "clawbot_session_refresh_required" });
  assert.equal(JSON.stringify(expired).includes("secret-context"), false);
});
