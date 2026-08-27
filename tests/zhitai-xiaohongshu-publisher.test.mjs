import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loginQrcode } from "../local-agent/xiaohongshu-publisher.mjs";

const serverSrc = fs.readFileSync(new URL("../local-agent/server.mjs", import.meta.url), "utf8");
const pageSrc = fs.readFileSync(new URL("../app/PublishNative.tsx", import.meta.url), "utf8");

test("小红书二维码适配器按上游 v2.5.0 的 GET 契约取码", async () => {
  const savedFetch = globalThis.fetch;
  const savedAccountsDir = process.env.ZHITAI_XHS_ACCOUNTS_DIR;
  const savedLegacyCookies = process.env.ZHITAI_XHS_LEGACY_COOKIES_PATH;
  const root = mkdtempSync(join(tmpdir(), "zhitai-xhs-publisher-"));
  process.env.ZHITAI_XHS_ACCOUNTS_DIR = join(root, "accounts");
  process.env.ZHITAI_XHS_LEGACY_COOKIES_PATH = join(root, "missing-legacy-cookies.json");
  let seen = null;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith("/health")) {
      return new Response(JSON.stringify({ success: true, data: { service: "xiaohongshu-mcp", status: "healthy" } }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    }
    seen = { url: String(url), options };
    return new Response(JSON.stringify({
      success: true,
      data: { is_logged_in: false, timeout: "4m0s", img: "data:image/png;base64,AAAA" },
    }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const result = await loginQrcode();
    assert.equal(seen.url, "http://127.0.0.1:18060/api/v1/login/qrcode");
    assert.equal(seen.options.method, "GET");
    assert.equal(seen.options.body, undefined);
    assert.equal(result.qrData, "data:image/png;base64,AAAA");
  } finally {
    globalThis.fetch = savedFetch;
    if (savedAccountsDir === undefined) delete process.env.ZHITAI_XHS_ACCOUNTS_DIR;
    else process.env.ZHITAI_XHS_ACCOUNTS_DIR = savedAccountsDir;
    if (savedLegacyCookies === undefined) delete process.env.ZHITAI_XHS_LEGACY_COOKIES_PATH;
    else process.env.ZHITAI_XHS_LEGACY_COOKIES_PATH = savedLegacyCookies;
    rmSync(root, { recursive: true, force: true });
  }
});

test("织台二维码入口兼容 GET 与旧版空 POST，不再用 JSON 媒体类型拦截", () => {
  assert.match(serverSrc, /\["GET", "POST"\]\.includes\(request\.method\).*\/api\/v1\/publisher\/xhs\/login-qrcode/);
  assert.match(serverSrc, /guardAllowedOrigin\(request, response\)/);
});

test("发布页把小红书错误和重试留在账号卡片内", () => {
  assert.match(pageSrc, /setXhsFeedback/);
  assert.match(pageSrc, /检查登录结果/);
  assert.match(pageSrc, /provider-feedback/);
  assert.match(pageSrc, /publisher\/xhs\/login-qrcode", "GET"/);
  assert.ok(!pageSrc.includes('setMsg("小红书登录二维码生成失败'));
});

test("发布页顶部运行条件有真实本地接口，不再裸露 404", () => {
  assert.match(serverSrc, /requestUrl\.pathname === "\/api\/v1\/runtime-conditions"/);
  assert.match(serverSrc, /requestUrl\.pathname === "\/api\/v1\/runtime-conditions\/refresh"/);
  assert.match(serverSrc, /const snapshot = await refreshRuntimeConditions\(\)/);
  assert.doesNotMatch(serverSrc, /searchParams\.get\("refresh"\).*collectRuntimeConditions/);
});
