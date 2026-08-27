import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  __configureXhsAccountsForTests,
  __resetXhsAccountsForTests,
  createAccountRecord,
  ensureAccountEngine,
  listAccountRecords,
  resolveAccount,
} from "../local-agent/xiaohongshu-accounts.mjs";
import { publishImageText, status } from "../local-agent/xiaohongshu-publisher.mjs";

const ENV_KEYS = [
  "ZHITAI_XHS_ACCOUNTS_DIR",
  "ZHITAI_XHS_ENGINE_BINARY",
  "ZHITAI_XHS_LEGACY_COOKIES_PATH",
  "ZHITAI_XHS_DEFAULT_PORT",
  "ZHITAI_XHS_ACCOUNT_PORT_BASE",
  "ZHITAI_XHS_ACCOUNT_PORT_MAX",
];
const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const temporaryRoots = [];

function setupRuntime() {
  const root = mkdtempSync(join(tmpdir(), "zhitai-xhs-accounts-"));
  temporaryRoots.push(root);
  const accountsDir = join(root, "accounts");
  const engineDir = join(root, "engine");
  const engineBinary = join(engineDir, "xiaohongshu-mcp");
  const legacyCookiesPath = join(engineDir, "cookies.json");
  mkdirSync(engineDir, { recursive: true });
  writeFileSync(engineBinary, "#!/bin/sh\n", { mode: 0o755 });
  chmodSync(engineBinary, 0o755);
  process.env.ZHITAI_XHS_ACCOUNTS_DIR = accountsDir;
  process.env.ZHITAI_XHS_ENGINE_BINARY = engineBinary;
  process.env.ZHITAI_XHS_LEGACY_COOKIES_PATH = legacyCookiesPath;
  process.env.ZHITAI_XHS_DEFAULT_PORT = "19160";
  process.env.ZHITAI_XHS_ACCOUNT_PORT_BASE = "19260";
  process.env.ZHITAI_XHS_ACCOUNT_PORT_MAX = "19269";
  __resetXhsAccountsForTests();
  return { root, accountsDir, engineBinary, legacyCookiesPath };
}

function mode(path) {
  return statSync(path).mode & 0o777;
}

function healthResponse() {
  return new Response(JSON.stringify({
    success: true,
    data: { service: "xiaohongshu-mcp", status: "healthy", version: "test" },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
}

afterEach(() => {
  __resetXhsAccountsForTests();
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
  while (temporaryRoots.length) {
    const root = temporaryRoots.pop();
    if (root?.startsWith(tmpdir())) rmSync(root, { recursive: true, force: true });
  }
});

test("现有 cookies 自动迁移到 default，账号目录和敏感文件保持私有权限", () => {
  const runtime = setupRuntime();
  const legacy = JSON.stringify([{ name: "web_session", value: "existing-session" }]);
  writeFileSync(runtime.legacyCookiesPath, legacy, { mode: 0o644 });

  assert.deepEqual(listAccountRecords().map((row) => row.accountId), ["default"]);
  const defaultAccount = resolveAccount("default");
  assert.equal(readFileSync(defaultAccount.cookiePath, "utf8"), legacy);
  assert.equal(mode(runtime.accountsDir), 0o700);
  assert.equal(mode(defaultAccount.accountDir), 0o700);
  assert.equal(mode(defaultAccount.cookiePath), 0o600);
  assert.equal(mode(defaultAccount.tokenPath), 0o600);
  assert.equal(mode(join(runtime.accountsDir, "accounts.json")), 0o600);
  const registryText = readFileSync(join(runtime.accountsDir, "accounts.json"), "utf8");
  assert.ok(!registryText.includes(readFileSync(defaultAccount.tokenPath, "utf8").trim()), "注册表不得包含 Bearer token");

  const second = createAccountRecord({ accountId: "room_two", label: "儿童房二号" });
  assert.equal(second.accountId, "room_two");
  const secondRuntime = resolveAccount("room_two");
  assert.equal(secondRuntime.port, 19260);
  assert.equal(readFileSync(secondRuntime.cookiePath, "utf8"), "[]\n");
  assert.equal(mode(secondRuntime.accountDir), 0o700);
  assert.equal(mode(secondRuntime.cookiePath), 0o600);
  assert.equal(mode(secondRuntime.tokenPath), 0o600);

  assert.throws(() => resolveAccount("missing"), /xhs_account_not_found/);
  assert.throws(() => resolveAccount(""), /xhs_account_id_required/);
  assert.throws(() => resolveAccount(null), /xhs_account_id_required/);
  assert.throws(() => createAccountRecord({ accountId: "../escape" }), /xhs_account_id_invalid/);
});

test("新增账号按需启动独立回环进程，携带独立 COOKIES_PATH 和内存 Bearer token", async () => {
  setupRuntime();
  createAccountRecord({ accountId: "account_a", label: "账号 A" });
  let online = false;
  const spawnCalls = [];
  __configureXhsAccountsForTests({
    fetch: async (url) => {
      if (!String(url).endsWith("/health")) throw new Error("unexpected request");
      if (!online) throw new Error("offline");
      return healthResponse();
    },
    spawn: (command, args, options) => {
      spawnCalls.push({ command, args, options });
      online = true;
      return { pid: 4242, unref() {} };
    },
    sleep: async () => {},
  });

  const [first, second] = await Promise.all([
    ensureAccountEngine("account_a"),
    ensureAccountEngine("account_a"),
  ]);
  assert.equal(first.accountId, "account_a");
  assert.equal(second.accountId, "account_a");
  assert.equal(spawnCalls.length, 1, "同一账号并发探测不得双启动");
  const call = spawnCalls[0];
  const runtime = resolveAccount("account_a");
  assert.equal(call.command, runtime.engineBinary);
  assert.deepEqual(call.args, ["-headless=true", "-port=127.0.0.1:19260"]);
  assert.equal(call.options.cwd, runtime.accountDir);
  assert.equal(call.options.env.COOKIES_PATH, runtime.cookiePath);
  assert.equal(call.options.env.AUTH_TOKEN, readFileSync(runtime.tokenPath, "utf8").trim());
  assert.equal(call.options.detached, true);
  assert.equal(call.options.shell, false);
  assert.ok(!call.args.join(" ").includes(call.options.env.AUTH_TOKEN), "token 不得进入进程命令行");
  assert.equal(existsSync(runtime.lockPath), false, "启动完成必须释放互斥锁");
});

test("API 请求按 accountId 路由并强制 Bearer；未知账号不触发任何请求", async () => {
  setupRuntime();
  createAccountRecord({ accountId: "account_a", label: "账号 A" });
  const calls = [];
  __configureXhsAccountsForTests({
    fetch: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).endsWith("/health")) return healthResponse();
      if (String(url).endsWith("/api/v1/login/status")) {
        return new Response(JSON.stringify({ success: true, data: { is_logged_in: true, username: "A" } }), {
          status: 200, headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error("unexpected request");
    },
  });

  const result = await status("account_a");
  assert.equal(result.accountId, "account_a");
  assert.equal(result.loggedIn, true);
  const apiCall = calls.find((call) => call.url.endsWith("/api/v1/login/status"));
  assert.equal(apiCall.url, "http://127.0.0.1:19260/api/v1/login/status");
  assert.equal(apiCall.options.headers.Authorization, `Bearer ${readFileSync(resolveAccount("account_a").tokenPath, "utf8").trim()}`);
  const before = calls.length;
  await assert.rejects(() => status("not_registered"), /xhs_account_not_found/);
  assert.equal(calls.length, before, "未知账号不得静默请求 default");
});

test("同账号发布串行、不同账号可并行，失败后锁会释放", async () => {
  setupRuntime();
  createAccountRecord({ accountId: "account_a", label: "账号 A" });
  createAccountRecord({ accountId: "account_b", label: "账号 B" });
  const active = new Map();
  const maximum = new Map();
  let globalActive = 0;
  let globalMaximum = 0;
  let failNextA = true;
  __configureXhsAccountsForTests({
    fetch: async (url) => {
      const text = String(url);
      if (text.endsWith("/health")) return healthResponse();
      if (!text.endsWith("/api/v1/publish")) throw new Error("unexpected request");
      const accountId = text.includes(":19260/") ? "account_a" : "account_b";
      const count = (active.get(accountId) || 0) + 1;
      active.set(accountId, count);
      maximum.set(accountId, Math.max(maximum.get(accountId) || 0, count));
      globalActive += 1;
      globalMaximum = Math.max(globalMaximum, globalActive);
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
      active.set(accountId, count - 1);
      globalActive -= 1;
      if (accountId === "account_a" && failNextA) {
        failNextA = false;
        return new Response(JSON.stringify({ success: false, message: "first failed" }), {
          status: 500, headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true, data: { status: "submitted" } }), {
        status: 200, headers: { "Content-Type": "application/json" },
      });
    },
  });

  const input = (accountId, title) => ({ accountId, title, content: "正文", images: ["/tmp/a.jpg"] });
  const firstA = publishImageText(input("account_a", "A1"));
  const secondA = publishImageText(input("account_a", "A2"));
  const firstB = publishImageText(input("account_b", "B1"));
  const results = await Promise.allSettled([firstA, secondA, firstB]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "fulfilled", "前一任务失败后同账号队列必须继续");
  assert.equal(results[2].status, "fulfilled");
  assert.equal(maximum.get("account_a"), 1);
  assert.equal(maximum.get("account_b"), 1);
  assert.ok(globalMaximum >= 2, "不同账号应能并行发布");
});
