import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const companionUrl = new URL("../local-agent/zhitai-kuaidian-companion.user.js", import.meta.url);
const exampleConfigUrl = new URL("../local-agent/config.example.json", import.meta.url);

test("公开版只提供窄权限的织台原创快点伴生桥", async () => {
  const source = await readFile(companionUrl, "utf8");
  assert.equal((source.match(/\/\/ ==UserScript==/g) || []).length, 1);
  assert.match(source, /@name\s+织台·快点伴生桥/);
  assert.match(source, /@match\s+https:\/\/filehelper\.weixin\.qq\.com\/\*/);
  assert.match(source, /@match\s+https:\/\/szfilehelper\.weixin\.qq\.com\/\*/);
  assert.doesNotMatch(source, /@match\s+\*:\/\/\*\/\*/);
  assert.doesNotMatch(source, /@require\s+https:\/\/update\.greasyfork\.org\/scripts\/492152/);
  assert.doesNotMatch(source, /okd\.push\(\{d:a\.d,m:a\.(?:m\|\|)?a?MsgId/,
    "织台桥不得复制或修改上游下载引擎源码");
});

test("文件助手配置要求上游原脚本与织台桥分开安装", async () => {
  const config = JSON.parse(await readFile(exampleConfigUrl, "utf8"));
  const service = config.services.filehelper_web;
  assert.deepEqual(service.installChecks, ["local-agent/zhitai-kuaidian-companion.user.js"]);
  assert.match(service.notes, /分别安装上游发布的原版快点脚本/);
  assert.match(service.notes, /保持原样/);
  assert.match(service.notes, /不再分发、下载、修改或打包上游源码/);
  assert.doesNotMatch(JSON.stringify(service), /edge-all-in-one|kuaidian-bridge\.user\.js/i);
});
