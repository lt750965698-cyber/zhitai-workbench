import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectOpenclawWeixin } from "../local-agent/openclaw-business-probe.mjs";

async function fixture(t, { savedAt, staleAt } = {}) {
  const root = join(tmpdir(), `zhitai-openclaw-probe-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const state = join(root, "state");
  const logs = join(root, "logs");
  const bridge = join(root, "bridge");
  await mkdir(join(state, "openclaw-weixin", "accounts"), { recursive: true });
  await mkdir(logs, { recursive: true });
  await mkdir(bridge, { recursive: true });
  await writeFile(join(bridge, "openclaw.plugin.json"), "{}\n");
  await writeFile(join(state, "openclaw.json"), JSON.stringify({
    plugins: { load: { paths: [bridge] }, entries: { "zhitai-inbox-bridge": { enabled: true, hooks: { allowConversationAccess: true } } } },
  }));
  if (savedAt) {
    await writeFile(join(state, "openclaw-weixin", "accounts.json"), JSON.stringify(["account-1"]));
    await writeFile(join(state, "openclaw-weixin", "accounts", "account-1.json"), JSON.stringify({ token: "never-return-this", savedAt }));
  }
  if (staleAt) {
    await writeFile(join(logs, "openclaw-2026-08-23.log"), `${JSON.stringify({ 1: "getUpdates: token for account-1 is stale", time: staleAt })}\n`);
  }
  t.after(() => rm(root, { recursive: true, force: true }));
  return { stateDir: state, logDir: logs };
}

test("过期错误晚于账号保存时间时明确返回 needs_login，且不暴露令牌", async (t) => {
  const paths = await fixture(t, { savedAt: "2026-08-20T00:00:00Z", staleAt: "2026-08-23T00:00:00Z" });
  const result = inspectOpenclawWeixin({ ...paths, processRunning: true });
  assert.equal(result.authentication.state, "expired");
  assert.equal(result.business.ready, false);
  assert.match(result.business.reason, /重新扫码/);
  assert.doesNotMatch(JSON.stringify(result), /never-return-this/);
});

test("没有账号时返回 missing，而非把常驻进程误报为可收件", async (t) => {
  const paths = await fixture(t);
  const result = inspectOpenclawWeixin({ ...paths, processRunning: true });
  assert.equal(result.authentication.state, "missing");
  assert.equal(result.business.ready, false);
});
