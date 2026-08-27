import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(resolve(here, "../local-agent/server.mjs"), "utf8");
const runStart = serverSource.indexOf("async function runChannelsCard(");
const runEnd = serverSource.indexOf("\nasync function downloadResolvedChannels(", runStart);
const runChannelsCardSource = serverSource.slice(runStart, runEnd);

test("视频号卡片外层只重试已经进入下载后的瞬态 HTTP 错误", () => {
  assert.ok(runStart >= 0 && runEnd > runStart, "runChannelsCard implementation should be discoverable");

  const firstParse = runChannelsCardSource.indexOf("await parseChannelsCard(");
  const downloadLoop = runChannelsCardSource.indexOf("for (let attempt = 1;");
  assert.ok(firstParse >= 0 && firstParse < downloadLoop, "the initial card parse must happen outside the download retry loop");

  const policySource = runChannelsCardSource.match(/const transientDownload = \/(.*?)\/([a-z]*)\.test\(code\);/);
  assert.ok(policySource, "download retry policy should remain explicit and testable");
  const policy = new RegExp(policySource[1], policySource[2]);
  assert.equal(policy.test("download_http_400"), true);
  assert.equal(policy.test("download_http_403"), true);
  assert.equal(policy.test("channels_card_object_missing"), false);
  assert.equal(policy.test("channels_card_profile_jsapi_jsonparse_failed"), false);
  assert.equal(policy.test("channels_card_profile_upstream_-71042"), false);
});

test("profile 解析错误有安全中文说明且不会回显上游内容", () => {
  assert.match(serverSource, /channels_card_profile_jsapi_jsonparse_failed:\s*"[^"]+"/);
  assert.match(serverSource, /channels_card_profile_:\s*"[^"]+"/);
  assert.doesNotMatch(runChannelsCardSource, /token|errMsg|videoUrl/);
});
