import { test } from "node:test";
import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loginQrcode,
  publishImageText,
  XHS_AI_DECLARATION_BLOCKED,
} from "../local-agent/xiaohongshu-publisher.mjs";
import {
  __configureXhsAccountsForTests,
  __resetXhsAccountsForTests,
} from "../local-agent/xiaohongshu-accounts.mjs";

const serverSrc = fs.readFileSync(new URL("../local-agent/server.mjs", import.meta.url), "utf8");
const pageSrc = fs.readFileSync(new URL("../app/PublishNative.tsx", import.meta.url), "utf8");

function extractedFunction(name) {
  const start = serverSrc.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `应存在 ${name}`);
  const brace = serverSrc.indexOf(") {", start) + 2;
  let depth = 0;
  for (let index = brace; index < serverSrc.length; index += 1) {
    if (serverSrc[index] === "{") depth += 1;
    if (serverSrc[index] === "}") depth -= 1;
    if (depth === 0) return Function(`return (${serverSrc.slice(start, index + 1)})`)();
  }
  throw new Error(`无法提取 ${name}`);
}

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

test("小红书 AI 图文发布显式传声明并要求引擎回读后才记为 published", async () => {
  const savedAccountsDir = process.env.ZHITAI_XHS_ACCOUNTS_DIR;
  const savedLegacyCookies = process.env.ZHITAI_XHS_LEGACY_COOKIES_PATH;
  const root = mkdtempSync(join(tmpdir(), "zhitai-xhs-ai-publish-"));
  process.env.ZHITAI_XHS_ACCOUNTS_DIR = join(root, "accounts");
  process.env.ZHITAI_XHS_LEGACY_COOKIES_PATH = join(root, "missing-legacy-cookies.json");
  let publishBody = null;
  __configureXhsAccountsForTests({
    fetch: async (url, options = {}) => {
      if (String(url).endsWith("/health")) {
        return new Response(JSON.stringify({ success: true, data: { service: "xiaohongshu-mcp", status: "healthy" } }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      publishBody = JSON.parse(options.body);
      return new Response(JSON.stringify({
        success: true,
        data: { status: "发布完成", ai_content_declared: true },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    },
  });
  try {
    const result = await publishImageText({
      title: "AI 声明测试",
      content: "正文",
      images: ["/tmp/storyboard.png"],
      creativeStatement: "ai_generated",
    });
    assert.equal(publishBody.contains_ai, true);
    assert.equal(publishBody.is_original, false);
    assert.equal(result.aiDeclarationVerified, true);
    assert.equal(result.status, "published");
  } finally {
    __resetXhsAccountsForTests();
    if (savedAccountsDir === undefined) delete process.env.ZHITAI_XHS_ACCOUNTS_DIR;
    else process.env.ZHITAI_XHS_ACCOUNTS_DIR = savedAccountsDir;
    if (savedLegacyCookies === undefined) delete process.env.ZHITAI_XHS_LEGACY_COOKIES_PATH;
    else process.env.ZHITAI_XHS_LEGACY_COOKIES_PATH = savedLegacyCookies;
    rmSync(root, { recursive: true, force: true });
  }
});

test("小红书引擎没有 AI 声明回执时失败关闭，结构化发布前错误允许安全重试", async () => {
  const savedAccountsDir = process.env.ZHITAI_XHS_ACCOUNTS_DIR;
  const savedLegacyCookies = process.env.ZHITAI_XHS_LEGACY_COOKIES_PATH;
  const root = mkdtempSync(join(tmpdir(), "zhitai-xhs-ai-fail-"));
  process.env.ZHITAI_XHS_ACCOUNTS_DIR = join(root, "accounts");
  process.env.ZHITAI_XHS_LEGACY_COOKIES_PATH = join(root, "missing-legacy-cookies.json");
  let mode = "missing_receipt";
  __configureXhsAccountsForTests({
    fetch: async (url) => {
      if (String(url).endsWith("/health")) {
        return new Response(JSON.stringify({ success: true, data: { service: "xiaohongshu-mcp", status: "healthy" } }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      if (mode === "missing_receipt") {
        return new Response(JSON.stringify({ success: true, data: { status: "发布完成" } }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({
        success: false,
        code: "BLOCKED_AI_DECLARATION",
        error: "发布失败",
        details: {
          message: "AI 声明控件未找到",
          status: "blocked_ai_declaration",
          reason: "blocked_ai_declaration",
          before_external_call: true,
        },
      }), { status: 500, headers: { "Content-Type": "application/json" } });
    },
  });
  const request = {
    title: "AI 声明测试",
    content: "正文",
    images: ["/tmp/storyboard.png"],
    creativeStatement: "ai_generated",
  };
  try {
    await assert.rejects(() => publishImageText(request), (error) => {
      assert.match(error.message, /未回执 AI 合成内容声明/);
      assert.equal(error.code, XHS_AI_DECLARATION_BLOCKED);
      assert.equal(error.status, XHS_AI_DECLARATION_BLOCKED);
      assert.equal(error.beforeExternalCall, false);
      assert.equal(error.retryableBeforeExternalCall, false);
      assert.equal(error.externalCallStarted, true);
      return true;
    });
    mode = "pre_publish_error";
    await assert.rejects(() => publishImageText(request), (error) => {
      assert.equal(error.code, XHS_AI_DECLARATION_BLOCKED);
      assert.equal(error.status, XHS_AI_DECLARATION_BLOCKED);
      assert.equal(error.beforeExternalCall, true);
      assert.equal(error.retryableBeforeExternalCall, true);
      assert.equal(error.externalCallStarted, false);
      return true;
    });
  } finally {
    __resetXhsAccountsForTests();
    if (savedAccountsDir === undefined) delete process.env.ZHITAI_XHS_ACCOUNTS_DIR;
    else process.env.ZHITAI_XHS_ACCOUNTS_DIR = savedAccountsDir;
    if (savedLegacyCookies === undefined) delete process.env.ZHITAI_XHS_LEGACY_COOKIES_PATH;
    else process.env.ZHITAI_XHS_LEGACY_COOKIES_PATH = savedLegacyCookies;
    rmSync(root, { recursive: true, force: true });
  }
});

test("小红书 AI 声明补丁只用 go-rod 元素点击并在发布按钮前失败关闭", () => {
  const patchSrc = fs.readFileSync(new URL("../patches/xiaohongshu-mcp-ai-declaration.patch", import.meta.url), "utf8");
  assert.match(patchSrc, /func setAIContentDeclaration\(page \*rod\.Page\) error/);
  assert.match(patchSrc, /declarationControl\.Click\(proto\.InputMouseButtonLeft, 1\)/);
  assert.match(patchSrc, /aiOption\.Click\(proto\.InputMouseButtonLeft, 1\)/);
  assert.match(patchSrc, /selectedAIContentDeclaration\(page, extra\)/);
  assert.match(patchSrc, /BLOCKED_AI_DECLARATION/);
  assert.match(patchSrc, /AIContentDeclarationBlocked = "blocked_ai_declaration"/);
  assert.match(patchSrc, /failureDetails\["status"\] = reason/);
  assert.ok(patchSrc.indexOf("setAIContentDeclaration(page)") < patchSrc.indexOf("bindProducts(ctx, page, products)"));
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

test("运行条件以任一已登录小红书账号为 ready，不被未登录 default 误拦截", () => {
  const summarize = extractedFunction("summarizeXhsRuntimeAccounts");
  const result = summarize([
    { accountId: "default", label: "默认账号", isDefault: true, online: true, loggedIn: false, reason: "需扫码" },
    { accountId: "xhs_second", label: "第二账号", isDefault: false, online: true, loggedIn: true },
  ]);
  assert.equal(result.loggedIn, true);
  assert.equal(result.accountId, "xhs_second");
  assert.deepEqual(result.usableAccountIds, ["xhs_second"]);
  assert.match(serverSrc, /xhsPublisher\.listAccounts\(\{ includeStatus: true \}\)/);
  assert.match(serverSrc, /xhsCondition\.usableAccountIds/);
});
