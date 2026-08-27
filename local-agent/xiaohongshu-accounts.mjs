/* 织台 · 小红书图文多账号运行时
 *
 * 上游 xiaohongshu-mcp 的 HTTP API 是“一进程、一 COOKIES_PATH”。织台因此用
 * 独立回环端口、独立私有目录和独立 Bearer token 托管每个账号，绝不在请求时
 * 替换共享 cookie，也绝不把未知 accountId 回退到 default。
 */
import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export const DEFAULT_XHS_ACCOUNT_ID = "default";

const REGISTRY_VERSION = 1;
const ENGINE_SERVICE = "xiaohongshu-mcp";
const START_TIMEOUT_MS = 30_000;
const ACCOUNT_ID_RE = /^[a-z0-9][a-z0-9_-]{0,47}$/;
const startsInFlight = new Map();
const startLockDbs = new Map();

let dependencies = {
  fetch: (...args) => globalThis.fetch(...args),
  spawn: nodeSpawn,
  sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
};

function integerEnv(name, fallback, min = 1024, max = 65_535) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name}_invalid`);
  }
  return value;
}

function runtimeConfig() {
  const accountsDir = resolve(process.env.ZHITAI_XHS_ACCOUNTS_DIR
    || join(homedir(), ".local", "share", "zhitai-runtime", "accounts", "xiaohongshu"));
  const engineBinary = resolve(process.env.ZHITAI_XHS_ENGINE_BINARY
    || join(homedir(), ".local", "share", "zhitai-runtime", "engines", "xiaohongshu-mcp-current", "xiaohongshu-mcp"));
  const legacyCookiesPath = resolve(process.env.ZHITAI_XHS_LEGACY_COOKIES_PATH
    || join(homedir(), ".local", "share", "zhitai-runtime", "engines", "xiaohongshu-mcp-current", "cookies.json"));
  const defaultPort = integerEnv("ZHITAI_XHS_DEFAULT_PORT", 18_060);
  const accountPortBase = integerEnv("ZHITAI_XHS_ACCOUNT_PORT_BASE", 18_160);
  const accountPortMax = integerEnv("ZHITAI_XHS_ACCOUNT_PORT_MAX", 18_259);
  if (accountPortMax < accountPortBase) throw new Error("ZHITAI_XHS_ACCOUNT_PORT_RANGE_invalid");
  return {
    accountsDir,
    engineBinary,
    legacyCookiesPath,
    defaultPort,
    accountPortBase,
    accountPortMax,
    registryPath: join(accountsDir, "accounts.json"),
  };
}

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  chmodSync(path, 0o700);
}

function writePrivateFile(path, content, { exclusive = false } = {}) {
  writeFileSync(path, content, { encoding: "utf8", mode: 0o600, flag: exclusive ? "wx" : "w" });
  chmodSync(path, 0o600);
}

function ensureAuthToken(tokenPath) {
  if (!existsSync(tokenPath)) {
    try {
      writePrivateFile(tokenPath, randomBytes(32).toString("base64url") + "\n", { exclusive: true });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  chmodSync(tokenPath, 0o600);
  const token = readFileSync(tokenPath, "utf8").trim();
  if (!/^[A-Za-z0-9_-]{32,}$/.test(token)) throw new Error("xhs_account_auth_token_invalid");
  return token;
}

function accountPrivatePaths(config, accountId) {
  const accountDir = join(config.accountsDir, accountId);
  return {
    accountDir,
    cookiePath: join(accountDir, "cookies.json"),
    tokenPath: join(accountDir, "auth-token"),
    logPath: join(accountDir, "engine.log"),
    lockPath: join(accountDir, "engine-start.lock"),
  };
}

function ensureAccountPrivateState(config, accountId, { migrateLegacy = false } = {}) {
  ensurePrivateDirectory(config.accountsDir);
  const paths = accountPrivatePaths(config, accountId);
  ensurePrivateDirectory(paths.accountDir);
  if (!existsSync(paths.cookiePath)) {
    try {
      if (migrateLegacy && config.legacyCookiesPath !== paths.cookiePath && existsSync(config.legacyCookiesPath)) {
        copyFileSync(config.legacyCookiesPath, paths.cookiePath, constants.COPYFILE_EXCL);
      } else {
        writePrivateFile(paths.cookiePath, "[]\n", { exclusive: true });
      }
    } catch (error) {
      // launcher 与 local-agent 首次并发迁移时只允许一个创建者；另一方复用胜出文件。
      if (error?.code !== "EEXIST") throw error;
    }
  }
  // 上游以 0644 创建新文件；织台预创建为 0600，后续 O_TRUNC 写入会保留 inode mode。
  chmodSync(paths.cookiePath, 0o600);
  ensureAuthToken(paths.tokenPath);
  if (existsSync(paths.logPath)) chmodSync(paths.logPath, 0o600);
  if (existsSync(`${paths.lockPath}.sqlite`)) chmodSync(`${paths.lockPath}.sqlite`, 0o600);
  return paths;
}

function registryTemplate(config) {
  const now = new Date().toISOString();
  return {
    schemaVersion: REGISTRY_VERSION,
    accounts: [{ accountId: DEFAULT_XHS_ACCOUNT_ID, label: "默认账号", port: config.defaultPort, createdAt: now }],
  };
}

function validateRegistry(value, config) {
  if (!value || value.schemaVersion !== REGISTRY_VERSION || !Array.isArray(value.accounts)) {
    throw new Error("xhs_accounts_registry_invalid");
  }
  const ids = new Set();
  const ports = new Set();
  const accounts = value.accounts.map((row) => {
    const accountId = String(row?.accountId || "");
    const label = String(row?.label || "").trim();
    const port = Number(row?.port);
    if (!ACCOUNT_ID_RE.test(accountId) || !label || label.length > 64 || !Number.isInteger(port) || port < 1024 || port > 65_535) {
      throw new Error("xhs_accounts_registry_invalid");
    }
    if (ids.has(accountId) || ports.has(port)) throw new Error("xhs_accounts_registry_duplicate");
    ids.add(accountId);
    ports.add(port);
    return { accountId, label, port, createdAt: String(row?.createdAt || "") || new Date().toISOString() };
  });
  const defaultRow = accounts.find((row) => row.accountId === DEFAULT_XHS_ACCOUNT_ID);
  if (!defaultRow || defaultRow.port !== config.defaultPort) throw new Error("xhs_default_account_invalid");
  return { schemaVersion: REGISTRY_VERSION, accounts };
}

function writeRegistry(config, registry) {
  ensurePrivateDirectory(config.accountsDir);
  const tempPath = join(config.accountsDir, `.accounts.${process.pid}.${randomUUID()}.tmp`);
  try {
    writePrivateFile(tempPath, JSON.stringify(registry, null, 2) + "\n", { exclusive: true });
    renameSync(tempPath, config.registryPath);
    chmodSync(config.registryPath, 0o600);
  } catch (error) {
    try { if (existsSync(tempPath)) unlinkSync(tempPath); } catch { /* 只清理由本次创建的临时文件 */ }
    throw error;
  }
}

function readRegistry() {
  const config = runtimeConfig();
  ensureAccountPrivateState(config, DEFAULT_XHS_ACCOUNT_ID, { migrateLegacy: true });
  if (!existsSync(config.registryPath)) writeRegistry(config, registryTemplate(config));
  chmodSync(config.registryPath, 0o600);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(config.registryPath, "utf8"));
  } catch (error) {
    throw new Error(`xhs_accounts_registry_unreadable:${error?.message || error}`);
  }
  return { config, registry: validateRegistry(parsed, config) };
}

function publicAccount(row) {
  return {
    accountId: row.accountId,
    label: row.label,
    isDefault: row.accountId === DEFAULT_XHS_ACCOUNT_ID,
    createdAt: row.createdAt,
  };
}

export function listAccountRecords() {
  const { config, registry } = readRegistry();
  return registry.accounts.map((row) => {
    ensureAccountPrivateState(config, row.accountId, { migrateLegacy: row.accountId === DEFAULT_XHS_ACCOUNT_ID });
    return publicAccount(row);
  });
}

export function createAccountRecord({ accountId, label } = {}) {
  const { config, registry } = readRegistry();
  const requested = accountId === undefined
    ? `xhs_${randomUUID().replace(/-/g, "").slice(0, 12)}`
    : String(accountId);
  if (!ACCOUNT_ID_RE.test(requested) || requested === DEFAULT_XHS_ACCOUNT_ID) {
    throw new Error("xhs_account_id_invalid");
  }
  if (registry.accounts.some((row) => row.accountId === requested)) throw new Error("xhs_account_already_exists");
  const cleanLabel = String(label || requested).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (!cleanLabel || cleanLabel.length > 64) throw new Error("xhs_account_label_invalid");
  const usedPorts = new Set(registry.accounts.map((row) => row.port));
  let port = null;
  for (let candidate = config.accountPortBase; candidate <= config.accountPortMax; candidate += 1) {
    if (!usedPorts.has(candidate)) { port = candidate; break; }
  }
  if (!port) throw new Error("xhs_account_port_pool_exhausted");
  const row = { accountId: requested, label: cleanLabel, port, createdAt: new Date().toISOString() };
  ensureAccountPrivateState(config, requested);
  writeRegistry(config, { ...registry, accounts: [...registry.accounts, row] });
  return publicAccount(row);
}

export function resolveAccount(accountId = DEFAULT_XHS_ACCOUNT_ID) {
  // 只有“参数缺省”兼容旧调用；空串、null、未知 id 都是显式错误，不能串号。
  if (accountId === null || accountId === "" || typeof accountId !== "string") {
    throw new Error("xhs_account_id_required");
  }
  const { config, registry } = readRegistry();
  const row = registry.accounts.find((candidate) => candidate.accountId === accountId);
  if (!row) throw new Error("xhs_account_not_found");
  const paths = ensureAccountPrivateState(config, row.accountId, { migrateLegacy: row.accountId === DEFAULT_XHS_ACCOUNT_ID });
  return {
    ...publicAccount(row),
    port: row.port,
    baseUrl: `http://127.0.0.1:${row.port}`,
    engineBinary: config.engineBinary,
    ...paths,
  };
}

async function probeEngine(record, timeoutMs = 1_500) {
  let response;
  try {
    response = await dependencies.fetch(`${record.baseUrl}/health`, { signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return { online: false, conflict: false };
  }
  if (!response.ok) return { online: false, conflict: false };
  const payload = await response.json().catch(() => null);
  if (payload?.data?.service !== ENGINE_SERVICE) return { online: false, conflict: true };
  return { online: true, conflict: false, version: payload?.data?.version || null };
}

function acquireStartLock(record) {
  if (startLockDbs.has(record.lockPath)) return false;
  const lockDbPath = `${record.lockPath}.sqlite`;
  let lockDb = null;
  try {
    lockDb = new DatabaseSync(lockDbPath);
    chmodSync(lockDbPath, 0o600);
    lockDb.exec("PRAGMA busy_timeout = 0; BEGIN IMMEDIATE;");
    startLockDbs.set(record.lockPath, lockDb);
    return true;
  } catch (error) {
    try { lockDb?.close(); } catch { /* 未取得锁时只关闭自己的句柄 */ }
    if (/SQLITE_BUSY|database is locked/i.test(String(error?.code || error?.message || ""))) return false;
    throw error;
  }
}

function releaseStartLock(record) {
  const lockDb = startLockDbs.get(record.lockPath);
  if (!lockDb) return;
  startLockDbs.delete(record.lockPath);
  try { lockDb.exec("COMMIT;"); } catch { /* close 仍会释放 OS 锁 */ }
  try { lockDb.close(); } catch { /* 后续健康探测仍能防止双启动 */ }
}

async function waitForEngine(record, timeoutMs = START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const probe = await probeEngine(record);
    if (probe.conflict) throw new Error("xhs_account_port_conflict");
    if (probe.online) return probe;
    await dependencies.sleep(250);
  }
  throw new Error("xhs_account_engine_start_timeout");
}

async function startAccountEngine(record) {
  const firstProbe = await probeEngine(record);
  if (firstProbe.conflict) throw new Error("xhs_account_port_conflict");
  if (firstProbe.online) return firstProbe;

  const ownsLock = acquireStartLock(record);
  if (!ownsLock) return waitForEngine(record);
  let logFd = null;
  try {
    // 取锁后再次探测：另一个监管器可能刚好完成启动。
    const lockedProbe = await probeEngine(record);
    if (lockedProbe.conflict) throw new Error("xhs_account_port_conflict");
    if (lockedProbe.online) return lockedProbe;
    accessSync(record.engineBinary, constants.X_OK);
    const token = ensureAuthToken(record.tokenPath);
    logFd = openSync(record.logPath, "a", 0o600);
    chmodSync(record.logPath, 0o600);
    const child = dependencies.spawn(record.engineBinary, [
      "-headless=true",
      `-port=127.0.0.1:${record.port}`,
    ], {
      cwd: record.accountDir,
      env: {
        ...process.env,
        AUTH_TOKEN: token,
        COOKIES_PATH: record.cookiePath,
        NO_PROXY: "localhost,127.0.0.1,::1",
      },
      detached: true,
      shell: false,
      stdio: ["ignore", logFd, logFd],
    });
    if (!child || typeof child.pid !== "number") throw new Error("xhs_account_engine_spawn_failed");
    child.unref?.();
    return await waitForEngine(record);
  } finally {
    if (logFd !== null) try { closeSync(logFd); } catch { /* child 已继承 fd */ }
    releaseStartLock(record);
  }
}

export async function ensureAccountEngine(accountId = DEFAULT_XHS_ACCOUNT_ID) {
  const record = resolveAccount(accountId);
  if (startsInFlight.has(record.accountId)) return startsInFlight.get(record.accountId);
  const promise = startAccountEngine(record).then((probe) => ({
    ...publicAccount(record),
    online: true,
    version: probe.version || null,
  }));
  startsInFlight.set(record.accountId, promise);
  try {
    return await promise;
  } finally {
    startsInFlight.delete(record.accountId);
  }
}

export async function requestAccount(accountId, path, options = {}) {
  const record = resolveAccount(accountId);
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("..")) {
    throw new Error("xhs_account_request_path_invalid");
  }
  await ensureAccountEngine(record.accountId);
  const token = ensureAuthToken(record.tokenPath);
  try {
    return await dependencies.fetch(record.baseUrl + path, {
      ...options,
      headers: { ...(options.headers || {}), Authorization: `Bearer ${token}` },
    });
  } finally {
    // 扫码成功后上游会异步重写 cookie；状态/发布请求后再次收紧权限。
    if (existsSync(record.cookiePath)) chmodSync(record.cookiePath, 0o600);
  }
}

// 仅供无副作用的契约测试注入。生产调用方不得改变运行依赖。
export function __configureXhsAccountsForTests(overrides = {}) {
  dependencies = { ...dependencies, ...overrides };
  startsInFlight.clear();
  for (const record of [...startLockDbs.keys()]) releaseStartLock({ lockPath: record });
}

export function __resetXhsAccountsForTests() {
  dependencies = {
    fetch: (...args) => globalThis.fetch(...args),
    spawn: nodeSpawn,
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  };
  startsInFlight.clear();
  for (const record of [...startLockDbs.keys()]) releaseStartLock({ lockPath: record });
}

export function xhsAccountRuntimeSummary(accountId = DEFAULT_XHS_ACCOUNT_ID) {
  const record = resolveAccount(accountId);
  return {
    ...publicAccount(record),
    host: "127.0.0.1",
    port: record.port,
    cookieFile: basename(record.cookiePath),
  };
}
