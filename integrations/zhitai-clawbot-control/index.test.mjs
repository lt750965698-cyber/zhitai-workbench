import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { buildOutboundReportArgs, createPlugin } from "./index.mjs";

test("ClawBot bridge derives local paths instead of embedding a developer home", async () => {
  const source = await readFile(new URL("./index.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\/Users\/[A-Za-z0-9._-]+\//);
  assert.match(source, /homedir\(\)/);
  assert.match(source, /ZHITAI_RUNTIME_ROOT/);
  assert.match(source, /ZHITAI_SUBMITTER_PATH/);
});

test("outbound receipts use the signed submitter with a sanitized two-field payload", () => {
  const args = buildOutboundReportArgs({
    success: false,
    errorCode: "session_refresh_required",
    senderId: "private-sender",
    content: "private-content",
    token: "private-token",
  }, {
    resolvedSubmitterPath: "/safe/inbox-submit.mjs",
    resolvedEndpoint: "http://127.0.0.1:17890/api/v1/notifications/clawbot/outbound-result",
  });
  assert.deepEqual(args, [
    "/safe/inbox-submit.mjs",
    "--endpoint",
    "http://127.0.0.1:17890/api/v1/notifications/clawbot/outbound-result",
    "--text",
    JSON.stringify({ success: false, errorCode: "session_refresh_required" }),
    "--source",
    "openclaw_weixin_outbound_result",
  ]);
  assert.doesNotMatch(JSON.stringify(args), /private-sender|private-content|private-token/);
});

test("plugin registers both deterministic inbound and outbound receipt hooks", async () => {
  const hooks = new Map();
  const reports = [];
  const plugin = createPlugin({
    executeCommand: async () => ({ text: "ok" }),
    reportOutbound: async (value) => { reports.push(value); },
  });
  plugin.register({
    on: (name, handler, options) => { hooks.set(name, { handler, options }); },
  });
  assert.deepEqual([...hooks.keys()], ["before_dispatch", "message_sent"]);
  assert.equal(hooks.get("message_sent").options.timeoutMs, 15_000);
  await hooks.get("message_sent").handler(
    { success: true, to: "private-sender", content: "private-content" },
    { channelId: "openclaw-weixin", accountId: "private-account" },
  );
  assert.deepEqual(reports, [{ success: true, errorCode: null }]);
});
