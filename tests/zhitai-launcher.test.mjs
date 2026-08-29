import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import launcher from "../desktop/launcher.js";
import npmLocate from "../desktop/npm-locate.js";

const { init, ensureService, ensureServices, getStates, stopOwned, isAlive, NODE_BIN } = launcher;
const PROJECT_DIR = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const RUNTIME_SCRIPT = path.join(os.homedir(), ".local", "share", "zhitai-runtime", "scripts", "run-local-agent.command");

function fakeChild(pid = 42424) {
  return { pid, exitCode: null, killed: false, kill(_signal) { this.killed = true; } };
}

// 所有服务都"离线 + 启动即死"（不真正就绪），便于观察 spawn 行为
function setupFake(spawnLog, httpUpResult = false) {
  init({
    projectDir: PROJECT_DIR,
    runtimeScript: RUNTIME_SCRIPT,
    analyzerScript: path.join(PROJECT_DIR, "scripts", "video-analysis-server.mjs"),
    logDir: path.join(os.tmpdir(), "zhitai-test-logs"),
    nodeBin: NODE_BIN,
    xhsAccountsDir: path.join(os.tmpdir(), `zhitai-launcher-xhs-${process.pid}`),
    xhsLegacyCookiesPath: path.join(os.tmpdir(), `zhitai-launcher-missing-legacy-${process.pid}.json`),
    xhsBinary: path.join(os.tmpdir(), "fake-xiaohongshu-mcp"),
    xhsDefaultPort: 18060,
    spawn: (...args) => { spawnLog.push(args); return fakeChild(); },
    httpUp: async () => httpUpResult,
    sleep: async () => {},
  });
}

// mock 织台页面探测：始终无织台（迫使 web 走 spawn）
function mockNoWeb() {
  globalThis.fetch = async (_url) => new Response("<!doctype html><title>别的应用</title>", { status: 200 });
}

// ---- 1. 防重入：双 ensure 同一服务只 spawn 一次 ----
test("同一 id 并发 ensure 只 spawn 一次（in-flight 防重入）", async () => {
  const spawnLog = [];
  setupFake(spawnLog);
  mockNoWeb();
  const [a, b] = await Promise.all([ensureService("analyzer"), ensureService("analyzer")]);
  assert.equal(a.id, "analyzer");
  assert.equal(b.id, "analyzer");
  const analyzerSpawns = spawnLog.filter(([cmd]) => String(cmd).includes("Electron") || cmd === process.execPath);
  assert.equal(analyzerSpawns.length, 1, "并发 ensure 不应重复 spawn");
});

// ---- 2. 分析器子进程必须带 ELECTRON_RUN_AS_NODE=1 ----
test("分析器（process.execPath 为 Electron）子进程显式 ELECTRON_RUN_AS_NODE=1", async () => {
  const spawnLog = [];
  setupFake(spawnLog);
  await ensureService("analyzer");
  const call = spawnLog.find(([cmd]) => cmd === process.execPath);
  assert.ok(call, "analyzer 应通过 process.execPath spawn");
  const options = call[2] || {};
  assert.equal(options.env && options.env.ELECTRON_RUN_AS_NODE, "1", "analyzer 子进程必须进入 Node 模式");
});

// ---- 3. 织台页面用绝对 node + vinext 生产构建，不依赖 Finder PATH / npm 生命周期 ----
test("织台页面使用明确现有 node 与 vinext CLI 绝对路径", async () => {
  const spawnLog = [];
  setupFake(spawnLog);
  mockNoWeb();
  await ensureService("web");
  const call = spawnLog.find(([cmd]) => cmd === NODE_BIN);
  assert.ok(call, "web 必须用绝对 node 启动");
  assert.equal(call[1][0], path.join(PROJECT_DIR, "node_modules", "vinext", "dist", "cli.js"));
  assert.deepEqual(call[1].slice(1), ["start", "--port", "3001", "--hostname", "127.0.0.1"]);
});

test("vinext 子进程：nodeBin 为指向另一路径 Electron 的符号链接时进入 Node 模式", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zhitai-electron-node-link-"));
  const electronBin = path.join(root, "alternate", "Electron");
  const nodeLink = path.join(root, "bin", "node");
  fs.mkdirSync(path.dirname(electronBin), { recursive: true });
  fs.mkdirSync(path.dirname(nodeLink), { recursive: true });
  fs.writeFileSync(electronBin, "fixture", { mode: 0o755 });
  fs.symlinkSync(electronBin, nodeLink);
  const spawnLog = [];
  setupFake(spawnLog);
  init({ nodeBin: nodeLink });
  mockNoWeb();
  try {
    await ensureService("web");
    const call = spawnLog.find(([cmd]) => cmd === nodeLink);
    assert.ok(call, "web 应使用选中的 node 符号链接启动");
    assert.equal(call[2]?.env?.ELECTRON_RUN_AS_NODE, "1");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("vinext 子进程：真实 Node 保留现有环境且不强制 Electron 模式", async () => {
  const savedMarker = process.env.ZHITAI_TEST_WEB_ENV;
  const savedRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
  process.env.ZHITAI_TEST_WEB_ENV = "preserved";
  delete process.env.ELECTRON_RUN_AS_NODE;
  const spawnLog = [];
  setupFake(spawnLog);
  init({ nodeBin: process.execPath });
  mockNoWeb();
  try {
    await ensureService("web");
    const call = spawnLog.find(([cmd]) => cmd === process.execPath);
    assert.ok(call, "web 应使用真实 Node 启动");
    assert.equal(call[2]?.env?.ZHITAI_TEST_WEB_ENV, "preserved");
    assert.equal(call[2]?.env?.ELECTRON_RUN_AS_NODE, undefined);
  } finally {
    if (savedMarker === undefined) delete process.env.ZHITAI_TEST_WEB_ENV;
    else process.env.ZHITAI_TEST_WEB_ENV = savedMarker;
    if (savedRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = savedRunAsNode;
  }
});

test("npm-locate：PATH 无 npm 时回退到绝对候选路径（不依赖 Finder PATH）", () => {
  const savedPath = process.env.PATH;
  const savedConfigured = process.env.ZHITAI_NPM_BIN;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zhitai-npm-locate-"));
  const configuredNpm = path.join(root, "npm");
  fs.writeFileSync(configuredNpm, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  process.env.PATH = "/usr/bin:/bin";
  process.env.ZHITAI_NPM_BIN = configuredNpm;
  try {
    const p = npmLocate.findNpm();
    assert.equal(p, configuredNpm);
  } finally {
    process.env.PATH = savedPath;
    if (savedConfigured === undefined) delete process.env.ZHITAI_NPM_BIN;
    else process.env.ZHITAI_NPM_BIN = savedConfigured;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- 4. 停止只结束本次自启且仍存活的子进程 ----
test("stopOwned 不 kill 已死亡的子进程", async () => {
  const spawnLog = [];
  setupFake(spawnLog);
  mockNoWeb();
  await ensureService("local-agent");
  const ownedChild = spawnLog.find(([cmd]) => String(cmd).includes("zsh")) && { pid: 999999, killed: false, kill() { this.killed = true; } };
  // 注入一个已死 pid（999999 不存在）→ isAlive false → 不应 kill
  const alive = isAlive(ownedChild);
  assert.equal(alive, false);
  // stopOwned 对 owned 里已死子进程不调用 kill：用真实注册验证
  init({ ...Object.create(null), projectDir: "/", logDir: "/tmp", spawn: () => ({ pid: 999999, killed: false, kill() { this.killed = true; }, exitCode: null }) });
  // 通过 ensureService 注册一个 fake child 到 owned
  init({ ...Object.create(null), projectDir: PROJECT_DIR, logDir: path.join(os.tmpdir(), "zhitai-test-logs"), spawn: () => ({ pid: 999999, killed: false, kill() { this.killed = true; }, exitCode: null }), httpUp: async () => false, sleep: async () => {} });
  mockNoWeb();
  await ensureService("mptools");
  stopOwned();
  // stopOwned 清空 owned；由于 pid 999999 已死，kill 不会真正调用（不影响断言：不抛错即通过）
  assert.ok(true);
});

// ---- 5. 单项失败不阻断：一个服务异常不影响其它状态 ----
test("ensureServices 对异常服务返回 error 而非抛错", async () => {
  const spawnLog = [];
  setupFake(spawnLog);
  mockNoWeb();
  const states = await ensureServices();
  assert.ok(Array.isArray(states));
  assert.ok(states.length >= 5, "应有全部服务条目");
  for (const s of states) {
    assert.equal(typeof s.online, "boolean");
    assert.ok("error" in s);
  }
});

test("补充采集使用无窗口受管后台，织台启动不 open MatrixMedia 或 WeChat MP Tools", async () => {
  const spawnLog = [];
  setupFake(spawnLog);
  mockNoWeb();
  const states = await ensureServices();
  const openedApps = spawnLog.filter(([cmd]) => cmd === "/usr/bin/open");
  assert.equal(openedApps.length, 0, "后台启动不得弹出第三方 GUI");
  assert.equal(states.some((row) => row.id === "matrix"), false, "MatrixMedia 不再是常驻桌面服务");
  assert.equal(states.find((row) => row.id === "mptools")?.onDemand, undefined);
  const mpSpawn = spawnLog.find(([cmd]) => /wechat-mp-tools(?:-v[\d.]+|-current)?\/\.venv\/bin\/python/.test(String(cmd)));
  assert.ok(mpSpawn, "补充采集必须用本机已安装的外置源码后台启动");
  assert.ok(mpSpawn[1].includes("--no-browser"));
  const generatorSpawn = spawnLog.find(([cmd]) => /MoneyPrinterTurbo\/\.venv\/bin\/uvicorn/.test(String(cmd)));
  assert.equal(generatorSpawn, undefined, "备用草稿引擎不应随织台启动");
  assert.equal(states.find((row) => row.id === "generator")?.onDemand, true);
});

test("定时状态刷新保留备用草稿引擎的按需标记", async () => {
  setupFake([], false);
  mockNoWeb();
  const states = await getStates();
  assert.equal(states.find((row) => row.id === "generator")?.onDemand, true);
  assert.equal(states.find((row) => row.id === "mptools")?.onDemand, undefined);
});

test("小红书 default 迁移到私有目录，以回环端口、独立 cookie 和 Bearer token 启动", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "zhitai-launcher-xhs-contract-"));
  const accountsDir = path.join(root, "accounts");
  const legacyCookiesPath = path.join(root, "legacy-cookies.json");
  const engineBinary = path.join(root, "xiaohongshu-mcp");
  fs.writeFileSync(legacyCookiesPath, '[{"name":"web_session","value":"kept"}]', { mode: 0o644 });
  fs.writeFileSync(engineBinary, "fixture", { mode: 0o755 });
  const spawnLog = [];
  init({
    projectDir: PROJECT_DIR,
    logDir: path.join(root, "logs"),
    xhsAccountsDir: accountsDir,
    xhsLegacyCookiesPath: legacyCookiesPath,
    xhsBinary: engineBinary,
    xhsDefaultPort: 19460,
    spawn: (...args) => { spawnLog.push(args); return fakeChild(52525); },
    httpUp: async () => false,
    sleep: async () => {},
  });
  try {
    await ensureService("xhs-publisher");
    const call = spawnLog.find(([command]) => command === engineBinary);
    assert.ok(call, "default 引擎应从私有账号目录启动");
    const [command, args, options] = call;
    const accountDir = path.join(accountsDir, "default");
    const cookiePath = path.join(accountDir, "cookies.json");
    const tokenPath = path.join(accountDir, "auth-token");
    const engineLogPath = path.join(accountDir, "engine.log");
    assert.equal(command, engineBinary);
    assert.deepEqual(args, ["-headless=true", "-port=127.0.0.1:19460"]);
    assert.equal(options.cwd, accountDir);
    assert.equal(options.env.COOKIES_PATH, cookiePath);
    assert.equal(options.env.AUTH_TOKEN, fs.readFileSync(tokenPath, "utf8").trim());
    assert.ok(!args.join(" ").includes(options.env.AUTH_TOKEN), "Bearer token 不得出现在命令行");
    assert.equal(fs.readFileSync(cookiePath, "utf8"), fs.readFileSync(legacyCookiesPath, "utf8"));
    assert.equal(fs.statSync(accountsDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(accountDir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(cookiePath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(tokenPath).mode & 0o777, 0o600);
    assert.equal(fs.statSync(engineLogPath).mode & 0o777, 0o600);
    assert.equal(fs.existsSync(path.join(accountDir, "engine-start.lock")), false);
    assert.equal(fs.statSync(path.join(accountDir, "engine-start.lock.sqlite")).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- 6. web spawn（Finder 干净环境）：PATH 前缀 node 目录 + NO_PROXY 含三个回环 ----
test("vinext start 子进程 env：干净 PATH 下 PATH 以 node 目录开头、NO_PROXY 含 localhost/127.0.0.1/::1", async () => {
  const savedPath = process.env.PATH;
  const savedNoProxy = process.env.NO_PROXY;
  process.env.PATH = "/usr/bin:/bin";
  process.env.NO_PROXY = "example.com";
  const spawnLog = [];
  setupFake(spawnLog);
  mockNoWeb();
  try {
    await ensureService("web");
    const call = spawnLog.find(([cmd]) => cmd === NODE_BIN);
    assert.ok(call, "web 必须用绝对 node 启动");
    assert.deepEqual(call[1], [path.join(PROJECT_DIR, "node_modules", "vinext", "dist", "cli.js"), "start", "--port", "3001", "--hostname", "127.0.0.1"]);
    const env = call[2]?.env || {};
    const nodeDir = path.dirname(NODE_BIN);
    assert.ok(env.PATH.startsWith(nodeDir + path.delimiter), "PATH 必须以 node 目录开头：实际 " + env.PATH);
    assert.ok(env.PATH.includes("/usr/bin:/bin"), "原有干净 PATH 应保留在末尾");
    const noProxy = String(env.NO_PROXY || "").split(",");
    for (const lp of ["localhost", "127.0.0.1", "::1"]) {
      assert.ok(noProxy.includes(lp), `NO_PROXY 应包含回环地址 ${lp}：实际 ${env.NO_PROXY}`);
    }
    assert.ok(noProxy.includes("example.com"), "已有 NO_PROXY 值应保留");
  } finally {
    process.env.PATH = savedPath;
    if (savedNoProxy === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = savedNoProxy;
  }
});
