import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const { isYuanbaoStudioUrl } = require("../desktop/yuanbao-runner.js");
const { isXBookmarksUrl } = require("../desktop/x-bookmark-runner.js");
const companionUrl = new URL("../local-agent/zhitai-kuaidian-companion.user.js", import.meta.url);
const workbenchUrl = new URL("../app/ContentWorkbench.tsx", import.meta.url);

class TextOnlyDomParser {
  parseFromString(input) {
    const source = String(input || "");
    return {
      getElementsByTagName(tag) {
        if (tag === "parsererror") return [];
        const expression = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "gi");
        const nodes = [];
        let match;
        while ((match = expression.exec(source)) !== null) {
          let text = "";
          let insideTag = false;
          for (const character of match[1]) {
            if (character === "<") { insideTag = true; continue; }
            if (insideTag && character === ">") { insideTag = false; continue; }
            if (!insideTag) text += character;
          }
          nodes.push({ textContent: text });
        }
        return nodes;
      },
    };
  }
}

async function loadCompanion(DOMParserImpl = TextOnlyDomParser) {
  const source = await readFile(companionUrl, "utf8");
  const body = source.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/m, "");
  const windowObj = {};
  const store = {};
  const localStorage = { getItem: (key) => store[key] ?? null, setItem: (key, value) => { store[key] = value; } };
  const run = new Function(
    "window", "document", "localStorage", "GM_getValue", "GM_setValue", "GM_xmlhttpRequest", "DOMParser", "setTimeout", "setInterval",
    body,
  );
  run(
    windowObj,
    { querySelector: () => null, createElement: () => ({}), documentElement: {} },
    localStorage,
    (key, fallback) => store[key] ?? fallback,
    (key, value) => { store[key] = value; },
    () => {},
    DOMParserImpl,
    () => 0,
    () => 0,
  );
  return { companion: windowObj.__zhitaiCompanion, source };
}

async function loadWorkbenchUrlHelpers() {
  const source = await readFile(workbenchUrl, "utf8");
  const start = source.indexOf("function webUrlFromValue");
  const end = source.indexOf("function displayStatus", start);
  assert.ok(start >= 0 && end > start, "workbench URL helpers should remain extractable");
  const javascript = source.slice(start, end)
    .replace(/\(value: string\)/g, "(value)")
    .replace(/\): URL \| null/g, ")")
    .replace(/\): string \| null/g, ")")
    .replace(/\): Platform \| null/g, ")")
    .replace(/\): Platform/g, ")");
  return new Function(`${javascript}\nreturn { hostnameFromUrl, inferPlatform };`)();
}

test("元宝窗口只信任 HTTPS 精确 origin 与实际工作台路径", () => {
  for (const value of [
    "https://yuanbao.tencent.com/",
    "https://yuanbao.tencent.com/chat",
    "https://yuanbao.tencent.com/chat/naQivTmsDa?from=workbench",
  ]) assert.equal(isYuanbaoStudioUrl(value), true, value);

  for (const value of [
    "http://yuanbao.tencent.com/chat/naQivTmsDa",
    "https://yuanbao.tencent.com.evil.test/chat/naQivTmsDa",
    "https://yuanbao.tencent.com@evil.test/chat/naQivTmsDa",
    "https://evil.test@yuanbao.tencent.com/chat/naQivTmsDa",
    "https://yuanbao.tencent.com:444/chat/naQivTmsDa",
    "https://yuanbao.tencent.com/chatty/naQivTmsDa",
    "https://yuanbao.tencent.com/chat/../api/user",
  ]) assert.equal(isYuanbaoStudioUrl(value), false, value);
});

test("X 收藏页只接受精确官方 origin 与锚定 bookmarks 路径", () => {
  for (const value of [
    "https://x.com/i/bookmarks",
    "https://x.com/i/bookmarks/?sort=recent",
    "https://www.x.com/i/bookmarks",
  ]) assert.equal(isXBookmarksUrl(value), true, value);

  for (const value of [
    "http://x.com/i/bookmarks",
    "https://x.com.evil.test/i/bookmarks",
    "https://x.com@evil.test/i/bookmarks",
    "https://evil.test@x.com/i/bookmarks",
    "https://x.com:444/i/bookmarks",
    "https://x.com/home?next=/i/bookmarks",
    "https://x.com/i/bookmarks/archive",
    "https://notx.com/i/bookmarks",
  ]) assert.equal(isXBookmarksUrl(value), false, value);
});

test("伴生桥稳定分享 URL 使用精确 hostname 与锚定 path", async () => {
  const { companion } = await loadCompanion();
  for (const value of [
    "https://weixin.qq.com/sph/item-1",
    "https://weixin.qq.com/s/item-2",
    "https://weixin.qq.com/sf/item-3?from=chat",
    "https://channels.weixin.qq.com/mobile/sf/item-4",
    "https://v.douyin.com/AbCdEf/",
    "https://xhslink.com/a1b2c3",
    "http://weixin.qq.com/sph/legacy-http",
  ]) assert.equal(companion.isStableShareHost(value), true, value);

  for (const value of [
    "ftp://weixin.qq.com/sph/item",
    "javascript:https://weixin.qq.com/sph/item",
    "https://notweixin.qq.com/sph/item",
    "https://weixin.qq.com.evil.test/sph/item",
    "https://weixin.qq.com@evil.test/sph/item",
    "https://evil.test@weixin.qq.com/sph/item",
    "https://weixin.qq.com:444/sph/item",
    "https://weixin.qq.com/path/sph/item",
    "https://weixin.qq.com/sphish/item",
    "https://channels.weixin.qq.com/path/mobile/sf/item",
    "https://channels.weixin.qq.com/mobile/sf/",
    "https://prefix-v.douyin.com/item",
    "https://v.douyin.com.evil.test/item",
    "https://prefix-xhslink.com/item",
    "https://xhslink.com.evil.test/item",
  ]) assert.equal(companion.isStableShareHost(value), false, value);
});

test("伴生桥 XML 值通过 DOM textContent 读取，解析失败时也只做文本扫描", async () => {
  const xml = "<msg><desc>安全<script>not-executed()</script>文本</desc></msg>";
  const primary = await loadCompanion();
  assert.deepEqual(primary.companion.readXmlValues(xml, "desc"), ["安全not-executed()文本"]);
  assert.match(primary.source, /new DOMParser\(\)\.parseFromString/);
  assert.match(primary.source, /nodes\[i\]\.textContent/);
  assert.doesNotMatch(primary.source, /replace\(\/<\[\^>\]/);

  class FailingDomParser { parseFromString() { throw new Error("parser unavailable"); } }
  const fallback = await loadCompanion(FailingDomParser);
  assert.deepEqual(fallback.companion.readXmlValues(xml, "desc"), ["安全not-executed()文本"]);
  assert.deepEqual(fallback.companion.readXmlValues(xml, "desc><script"), []);
});

test("工作台平台标签只从精确 URL hostname 或显式平台标识推断", async () => {
  const { hostnameFromUrl, inferPlatform } = await loadWorkbenchUrlHelpers();
  assert.equal(hostnameFromUrl("https://x.com/i/bookmarks"), "x.com");
  assert.equal(hostnameFromUrl("https://evil.test@x.com/i/bookmarks"), null);
  assert.equal(inferPlatform("https://x.com/i/bookmarks"), "X");
  assert.equal(inferPlatform("https://www.twitter.com/user/status/1"), "X");
  assert.equal(inferPlatform("https://www.douyin.com/video/1"), "抖音");
  assert.equal(inferPlatform("https://mp.weixin.qq.com/s/article"), "公众号");
  assert.equal(inferPlatform("wechat_channels"), "视频号");
  assert.equal(inferPlatform("x"), "X");

  for (const value of [
    "https://x.com.evil.test/i/bookmarks",
    "https://x.com@evil.test/i/bookmarks",
    "https://evil.test@x.com/i/bookmarks",
    "https://evil.test/?next=https://x.com/i/bookmarks",
    "https://twitter.com.evil.test/user/status/1",
  ]) assert.equal(inferPlatform(value), "未知来源", value);
});
