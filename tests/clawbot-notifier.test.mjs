import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

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

test("ClawBot context-token watcher debounces refreshes and its disposer stops callbacks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-clawbot-watch-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const stateDir = join(root, "state");
  const accountDir = join(stateDir, "openclaw-weixin", "accounts");
  await mkdir(dataDir, { recursive: true });
  await mkdir(accountDir, { recursive: true });
  const sender = "watch-user@im.wechat";
  const accountId = "watch-account";
  const contextPath = join(accountDir, `${accountId}.context-tokens.json`);
  await writeFile(join(dataDir, "remote-control-settings.json"), JSON.stringify({ allowedSenders: [sender] }));
  await writeFile(join(stateDir, "openclaw-weixin", "accounts.json"), JSON.stringify([accountId]));
  await writeFile(join(accountDir, `${accountId}.json`), JSON.stringify({ token: "watch-secret" }));
  await writeFile(contextPath, JSON.stringify({ [sender]: "watch-context" }));
  const fixedMtime = new Date("2026-08-29T09:00:00.000Z");
  await utimes(contextPath, fixedMtime, fixedMtime);
  let fsEvent = null;
  let watchedPath = null;
  let watchedOptions = null;
  let closeCalls = 0;
  const fakeWatcher = {
    on: () => fakeWatcher,
    close: () => { closeCalls += 1; },
  };
  const notifier = new ClawBotNotifier({
    dataDir,
    stateDir,
    watchImpl: (path, options, listener) => {
      watchedPath = path;
      watchedOptions = options;
      fsEvent = listener;
      return fakeWatcher;
    },
  });
  const refreshes = [];
  const dispose = notifier.watchContextTokens((event) => { refreshes.push(event); }, { debounceMs: 10 });

  for (let attempt = 0; attempt < 20 && !fsEvent; attempt += 1) await delay(5);
  assert.equal(typeof fsEvent, "function");
  assert.match(watchedPath, /openclaw-weixin\/accounts$/);
  assert.equal(watchedOptions.persistent, false);
  // A shared-file write with the same configured sender/session is not valid
  // recovery evidence.
  fsEvent("change", "account.context-tokens.json");
  await delay(25);
  assert.deepEqual(refreshes, []);

  await writeFile(contextPath, JSON.stringify({ [sender]: "watch-context-refreshed" }));
  const refreshedMtime = new Date("2026-08-29T09:00:05.000Z");
  await utimes(contextPath, refreshedMtime, refreshedMtime);
  fsEvent("change", "account.context-tokens.json");
  fsEvent("rename", "account.context-tokens.json");
  fsEvent("change", "account.context-tokens.json");
  fsEvent("change", "account.json");
  await delay(35);
  assert.deepEqual(refreshes, [{ contextUpdatedAt: "2026-08-29T09:00:05.000Z" }]);

  dispose();
  dispose();
  fsEvent("change", "account.context-tokens.json");
  await delay(25);
  assert.equal(refreshes.length, 1);
  assert.equal(closeCalls, 1);
});

test("fixed keepalive target is unique, opaque, and reread against the exact same target", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-clawbot-binding-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const stateDir = join(root, "state");
  const accountDir = join(stateDir, "openclaw-weixin", "accounts");
  await mkdir(dataDir, { recursive: true });
  await mkdir(accountDir, { recursive: true });
  const sender = "binding-user@im.wechat";
  const accountId = "binding-account";
  const token = "binding-secret-token";
  const firstContext = "binding-secret-context-one";
  const secondContext = "binding-secret-context-two";
  const contextPath = join(accountDir, `${accountId}.context-tokens.json`);
  await writeFile(join(dataDir, "remote-control-settings.json"), JSON.stringify({ allowedSenders: [sender] }));
  await writeFile(join(stateDir, "openclaw-weixin", "accounts.json"), JSON.stringify([accountId]));
  await writeFile(join(accountDir, `${accountId}.json`), JSON.stringify({ token }));
  await writeFile(contextPath, JSON.stringify({ [sender]: firstContext }));
  const firstMtime = new Date("2026-08-29T09:00:00.000Z");
  await utimes(contextPath, firstMtime, firstMtime);

  const notifier = new ClawBotNotifier({
    dataDir,
    stateDir,
    fingerprintKey: Buffer.alloc(32, 7),
  });
  const selected = await notifier.selectUniqueKeepaliveTarget();
  assert.equal(selected.ok, true);
  assert.match(selected.targetFingerprint, /^[a-f0-9]{64}$/);
  assert.match(selected.contextFingerprint, /^[a-f0-9]{64}$/);
  assert.equal(selected.contextUpdatedAt, firstMtime.toISOString());
  const serialized = JSON.stringify(selected);
  for (const secret of [sender, accountId, token, firstContext]) assert.equal(serialized.includes(secret), false);

  await writeFile(contextPath, JSON.stringify({ [sender]: secondContext }));
  const secondMtime = new Date("2026-08-29T09:00:05.000Z");
  await utimes(contextPath, secondMtime, secondMtime);
  const refreshed = await notifier.readKeepaliveTargetFreshness(selected.targetFingerprint);
  assert.equal(refreshed.ok, true);
  assert.equal(refreshed.targetFingerprint, selected.targetFingerprint);
  assert.notEqual(refreshed.contextFingerprint, selected.contextFingerprint);
  assert.equal(refreshed.contextUpdatedAt, secondMtime.toISOString());
  for (const secret of [sender, accountId, token, secondContext]) {
    assert.equal(JSON.stringify(refreshed).includes(secret), false);
  }
});

test("fixed keepalive selection and reread fail closed on ambiguous or changed targets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-clawbot-binding-closed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dataDir = join(root, "data");
  const stateDir = join(root, "state");
  const accountDir = join(stateDir, "openclaw-weixin", "accounts");
  await mkdir(dataDir, { recursive: true });
  await mkdir(accountDir, { recursive: true });
  const firstSender = "first-user@im.wechat";
  const secondSender = "second-user@im.wechat";
  const accountId = "one-account";
  const contextPath = join(accountDir, `${accountId}.context-tokens.json`);
  await writeFile(join(stateDir, "openclaw-weixin", "accounts.json"), JSON.stringify([accountId]));
  await writeFile(join(accountDir, `${accountId}.json`), JSON.stringify({ token: "secret-token" }));
  await writeFile(join(dataDir, "remote-control-settings.json"), JSON.stringify({ allowedSenders: [firstSender] }));
  await writeFile(contextPath, JSON.stringify({ [firstSender]: "first-context", [secondSender]: "second-context" }));
  const notifier = new ClawBotNotifier({ dataDir, stateDir, fingerprintKey: Buffer.alloc(32, 9) });
  const selected = await notifier.selectUniqueKeepaliveTarget();
  assert.equal(selected.ok, true);

  await writeFile(join(dataDir, "remote-control-settings.json"), JSON.stringify({
    allowedSenders: [firstSender, secondSender],
  }));
  assert.deepEqual(
    await notifier.selectUniqueKeepaliveTarget(),
    { ok: false, error: "clawbot_target_ambiguous" },
  );
  assert.deepEqual(
    await notifier.readKeepaliveTargetFreshness(selected.targetFingerprint),
    { ok: false, error: "clawbot_target_ambiguous" },
  );

  await writeFile(join(dataDir, "remote-control-settings.json"), JSON.stringify({ allowedSenders: [secondSender] }));
  assert.deepEqual(
    await notifier.readKeepaliveTargetFreshness(selected.targetFingerprint),
    { ok: false, error: "clawbot_target_changed" },
  );
  assert.deepEqual(
    await notifier.readKeepaliveTargetFreshness("not-a-fingerprint"),
    { ok: false, error: "clawbot_target_changed" },
  );
});
