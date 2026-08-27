import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import test from "node:test";

import { CHANNELS_PROXY_HOSTS, CHANNELS_PROXY_PAC } from "../local-agent/channels-proxy-pac.mjs";
import { disableWxCardSystemProxy } from "../local-agent/wx-card-config.mjs";

function decisionFor(host) {
  return runInNewContext(`${CHANNELS_PROXY_PAC}\nFindProxyForURL("https://${host}/", "${host}");`);
}

test("PAC only proxies the five required WeChat hosts", () => {
  assert.deepEqual(CHANNELS_PROXY_HOSTS, [
    "channels.weixin.qq.com",
    "mp.weixin.qq.com",
    "res.wx.qq.com",
    "kf.qq.com",
    "weixin110.qq.com",
  ]);
  for (const host of CHANNELS_PROXY_HOSTS) {
    assert.equal(decisionFor(host), "PROXY 127.0.0.1:2023; DIRECT");
  }
  for (const host of ["chatgpt.com", "api.openai.com", "example.qq.com", "www.qq.com"]) {
    assert.equal(decisionFor(host), "DIRECT");
  }
  assert.doesNotMatch(CHANNELS_PROXY_PAC, /\*\.qq\.com/);
});

test("wx-video-card config disables only the top-level proxy.system flag", () => {
  const input = [
    "app:",
    "  proxy: \"\"",
    "proxy:",
    "  enabled: true",
    "  system: true",
    "  hostname: \"127.0.0.1\"",
    "  port: 2023",
    "download:",
    "  system: true",
    "",
  ].join("\n");
  const first = disableWxCardSystemProxy(input);
  assert.equal(first.changed, true);
  assert.match(first.text, /proxy:\n {2}enabled: true\n {2}system: false/);
  assert.match(first.text, /download:\n {2}system: true/);

  const second = disableWxCardSystemProxy(first.text);
  assert.equal(second.changed, false);
  assert.equal(second.text, first.text);
});

test("wx-video-card config rejects ambiguous or missing proxy blocks", () => {
  assert.throws(() => disableWxCardSystemProxy("proxy:\n  enabled: true\n"), /proxy\.system/);
  assert.throws(() => disableWxCardSystemProxy("proxy:\n  system: true\nproxy:\n  system: false\n"), /top-level proxy block/);
});
