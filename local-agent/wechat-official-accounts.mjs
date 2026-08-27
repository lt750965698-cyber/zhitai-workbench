/* 织台 · 微信公众号多账号凭证注册表
 *
 * 注册表只保存账号 ID、显示名和验证状态等非敏感元数据。AppID/AppSecret
 * 作为一个原子凭证包写入该账号独立的 macOS Keychain service；AppSecret
 * 永不写入磁盘，也不会由任何公开方法返回。
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { readKeychainSecret, writeKeychainSecret } from "./keychain-secret.mjs";

export const DEFAULT_WECHAT_OFFICIAL_ACCOUNT_ID = "default";
export const LEGACY_APP_ID_SERVICE = "com.zhitai.wechat-official.appid";
export const LEGACY_APP_SECRET_SERVICE = "com.zhitai.wechat-official.appsecret";
export const ACCOUNT_CREDENTIAL_SERVICE_PREFIX = "com.zhitai.wechat-official.account";

const REGISTRY_SCHEMA_VERSION = 2;
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

function defaultRegistryPath(environment = process.env) {
  if (environment.ZHITAI_WECHAT_OFFICIAL_ACCOUNTS_PATH) {
    return environment.ZHITAI_WECHAT_OFFICIAL_ACCOUNTS_PATH;
  }
  const directory = environment.ZHITAI_WECHAT_OFFICIAL_ACCOUNTS_DIR
    || join(homedir(), ".local/share/zhitai-runtime/accounts/wechat-official");
  return join(directory, "accounts.json");
}

function cleanText(value, fallback = "") {
  return String(value || fallback)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function validateAccountId(value) {
  const accountId = String(value || "").trim();
  if (!ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error("公众号 accountId 格式不正确");
  }
  return accountId;
}

function normalizeAccountId(value, {
  legacyDefault = true,
  defaultAccountId = DEFAULT_WECHAT_OFFICIAL_ACCOUNT_ID,
} = {}) {
  if (value === undefined && legacyDefault) {
    return validateAccountId(defaultAccountId);
  }
  return validateAccountId(value);
}

export function credentialServiceForAccount(accountId) {
  return `${ACCOUNT_CREDENTIAL_SERVICE_PREFIX}.${validateAccountId(accountId)}.credentials`;
}

function emptyRegistry() {
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    defaultAccountId: DEFAULT_WECHAT_OFFICIAL_ACCOUNT_ID,
    accounts: [],
  };
}

function sanitizeRecord(record = {}) {
  const id = validateAccountId(record.id);
  return {
    id,
    label: cleanText(record.label, id === DEFAULT_WECHAT_OFFICIAL_ACCOUNT_ID ? "默认公众号" : "微信公众号"),
    appIdHint: cleanText(record.appIdHint).slice(0, 16) || null,
    createdAt: cleanText(record.createdAt) || null,
    updatedAt: cleanText(record.updatedAt) || null,
    publishReady: typeof record.publishReady === "boolean" ? record.publishReady : null,
    lastPublishVerifiedAt: cleanText(record.lastPublishVerifiedAt) || null,
  };
}

function appIdHint(appId) {
  const value = String(appId || "").trim();
  return value ? `wx…${value.slice(-4)}` : null;
}

function parseCredentialBundle(raw) {
  if (!raw) return { appId: "", appSecret: "" };
  try {
    const parsed = JSON.parse(String(raw));
    return {
      appId: String(parsed?.appId || "").trim(),
      appSecret: String(parsed?.appSecret || "").trim(),
    };
  } catch {
    return { appId: "", appSecret: "" };
  }
}

function publicAccount(record, credential, defaultAccountId = DEFAULT_WECHAT_OFFICIAL_ACCOUNT_ID) {
  const hasAppId = Boolean(credential.appId);
  const hasAppSecret = Boolean(credential.appSecret);
  return {
    accountId: record.id,
    label: record.label,
    isDefault: record.id === defaultAccountId,
    configured: hasAppId && hasAppSecret,
    hasAppId,
    hasAppSecret,
    appIdHint: record.appIdHint || appIdHint(credential.appId),
    publishReady: record.publishReady,
    lastPublishVerifiedAt: record.lastPublishVerifiedAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function createWechatOfficialAccountStore(options = {}) {
  const environment = options.environment || process.env;
  const registryPath = options.registryPath || defaultRegistryPath(environment);
  const readSecret = options.readSecret || readKeychainSecret;
  const writeSecret = options.writeSecret || writeKeychainSecret;
  const now = options.now || (() => new Date().toISOString());
  const uuid = options.uuid || randomUUID;
  const resolvedRegistryPath = String(registryPath);

  function ensurePrivateDirectory() {
    const directory = dirname(resolvedRegistryPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
    return directory;
  }

  function readRegistryRaw() {
    if (!existsSync(resolvedRegistryPath)) return emptyRegistry();
    ensurePrivateDirectory();
    chmodSync(resolvedRegistryPath, 0o600);
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(resolvedRegistryPath, "utf8"));
    } catch {
      throw new Error("公众号账号注册表损坏；已停止账号解析以避免误发");
    }
    if (!parsed || !Array.isArray(parsed.accounts)) {
      throw new Error("公众号账号注册表格式不正确；已停止账号解析以避免误发");
    }
    const ids = new Set();
    const accounts = parsed.accounts.map(sanitizeRecord);
    for (const account of accounts) {
      if (ids.has(account.id)) throw new Error("公众号账号注册表存在重复 accountId；已停止发布");
      ids.add(account.id);
    }
    const defaultAccountId = Object.prototype.hasOwnProperty.call(parsed, "defaultAccountId")
      ? validateAccountId(parsed.defaultAccountId)
      : DEFAULT_WECHAT_OFFICIAL_ACCOUNT_ID;
    if (defaultAccountId !== DEFAULT_WECHAT_OFFICIAL_ACCOUNT_ID
      && !accounts.some((account) => account.id === defaultAccountId)) {
      throw new Error("公众号账号注册表的默认账号不存在；已停止发布以避免误发");
    }
    return { schemaVersion: REGISTRY_SCHEMA_VERSION, defaultAccountId, accounts };
  }

  function writeRegistry(registry) {
    const directory = ensurePrivateDirectory();
    const accounts = registry.accounts.map(sanitizeRecord);
    const defaultAccountId = validateAccountId(
      registry.defaultAccountId || DEFAULT_WECHAT_OFFICIAL_ACCOUNT_ID,
    );
    if (defaultAccountId !== DEFAULT_WECHAT_OFFICIAL_ACCOUNT_ID
      && !accounts.some((account) => account.id === defaultAccountId)) {
      throw new Error("公众号默认账号不存在；已停止保存以避免误发");
    }
    const safeRegistry = {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      defaultAccountId,
      accounts,
    };
    const temporaryPath = join(directory, `.accounts.${process.pid}.${Date.now()}.tmp`);
    writeFileSync(temporaryPath, `${JSON.stringify(safeRegistry, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporaryPath, 0o600);
    renameSync(temporaryPath, resolvedRegistryPath);
    chmodSync(resolvedRegistryPath, 0o600);
  }

  function legacyCredentials() {
    return {
      appId: String(environment.ZHITAI_WECHAT_MP_APP_ID || readSecret(LEGACY_APP_ID_SERVICE) || "").trim(),
      appSecret: String(environment.ZHITAI_WECHAT_MP_APP_SECRET || readSecret(LEGACY_APP_SECRET_SERVICE) || "").trim(),
    };
  }

  function readAccountCredentials(accountId) {
    return parseCredentialBundle(readSecret(credentialServiceForAccount(accountId)));
  }

  function writeAccountCredentials(accountId, { appId, appSecret }) {
    const bundle = JSON.stringify({ version: 1, appId: String(appId || "").trim(), appSecret: String(appSecret || "").trim() });
    return writeSecret(credentialServiceForAccount(accountId), bundle) === true;
  }

  function ensureLegacyDefaultMigration(registry = readRegistryRaw()) {
    if (registry.accounts.some((account) => account.id === DEFAULT_WECHAT_OFFICIAL_ACCOUNT_ID)) {
      return { registry, virtualLegacy: null };
    }
    const legacy = legacyCredentials();
    if (!legacy.appId && !legacy.appSecret) return { registry, virtualLegacy: null };

    const timestamp = now();
    const record = sanitizeRecord({
      id: DEFAULT_WECHAT_OFFICIAL_ACCOUNT_ID,
      label: "默认公众号",
      appIdHint: appIdHint(legacy.appId),
      createdAt: timestamp,
      updatedAt: timestamp,
      publishReady: null,
    });

    // 先原子写入该账号独立的凭证包，再登记元数据。旧 Keychain 项保留，
    // 直到新版链路验证稳定，避免迁移过程破坏现有账号。
    if (writeAccountCredentials(record.id, legacy)) {
      const migrated = { ...registry, accounts: [...registry.accounts, record] };
      try {
        writeRegistry(migrated);
        return { registry: migrated, virtualLegacy: null };
      } catch {
        // 凭证已安全进入独立 Keychain，但元数据暂时无法落盘；只为 default
        // 提供内存兼容视图，绝不把它当作其他显式 accountId 的回退。
      }
    }
    return { registry, virtualLegacy: { record, credential: legacy } };
  }

  function currentState() {
    return ensureLegacyDefaultMigration(readRegistryRaw());
  }

  function findRecord(accountId, { allowUnconfiguredDefault = true } = {}) {
    const state = currentState();
    const normalized = normalizeAccountId(accountId, {
      defaultAccountId: state.registry.defaultAccountId,
    });
    const record = state.registry.accounts.find((account) => account.id === normalized)
      || (normalized === DEFAULT_WECHAT_OFFICIAL_ACCOUNT_ID ? state.virtualLegacy?.record : null);
    if (record) return { accountId: normalized, record, state };
    if (normalized === DEFAULT_WECHAT_OFFICIAL_ACCOUNT_ID && allowUnconfiguredDefault) {
      return {
        accountId: normalized,
        record: sanitizeRecord({ id: normalized, label: "默认公众号" }),
        state,
      };
    }
    throw new Error(`公众号账号不存在：${normalized}`);
  }

  function credentialsFor(accountId) {
    const { accountId: normalized, record, state } = findRecord(accountId);
    let credential;
    if (state.virtualLegacy?.record.id === normalized) credential = state.virtualLegacy.credential;
    else credential = readAccountCredentials(normalized);
    return { accountId: normalized, record, ...credential };
  }

  function listAccounts() {
    const state = currentState();
    const records = [...state.registry.accounts];
    if (state.virtualLegacy && !records.some((account) => account.id === DEFAULT_WECHAT_OFFICIAL_ACCOUNT_ID)) {
      records.push(state.virtualLegacy.record);
    }
    return records.map((record) => {
      const credential = state.virtualLegacy?.record.id === record.id
        ? state.virtualLegacy.credential
        : readAccountCredentials(record.id);
      return publicAccount(record, credential, state.registry.defaultAccountId);
    });
  }

  function getAccount(accountId) {
    const { record, state } = findRecord(accountId);
    const credential = state.virtualLegacy?.record.id === record.id
      ? state.virtualLegacy.credential
      : readAccountCredentials(record.id);
    return publicAccount(record, credential, state.registry.defaultAccountId);
  }

  function saveCredentials({ accountId, label, appId, appSecret } = {}) {
    const state = currentState();
    const normalized = normalizeAccountId(accountId, {
      defaultAccountId: state.registry.defaultAccountId,
    });
    const nextAppId = String(appId || "").trim();
    const nextAppSecret = String(appSecret || "").trim();
    if (!/^wx[a-fA-F0-9]{16}$/.test(nextAppId)) {
      throw new Error("公众号 AppID 格式不正确（应为 wx 开头的 18 位标识）");
    }
    if (!/^[a-fA-F0-9]{32}$/.test(nextAppSecret)) {
      throw new Error("公众号 AppSecret 格式不正确（应为 32 位）");
    }

    const existing = state.registry.accounts.find((account) => account.id === normalized)
      || (normalized === DEFAULT_WECHAT_OFFICIAL_ACCOUNT_ID ? state.virtualLegacy?.record : null);
    const existingCredential = existing
      ? (state.virtualLegacy?.record.id === normalized
        ? state.virtualLegacy.credential
        : readAccountCredentials(normalized))
      : null;
    if (existingCredential?.appId && existingCredential.appId !== nextAppId) {
      throw new Error("公众号 AppID 与现有 accountId 不一致；请创建新账号，避免历史任务串号");
    }
    const timestamp = now();
    const record = sanitizeRecord({
      ...(existing || {}),
      id: normalized,
      label: cleanText(label, existing?.label || (normalized === DEFAULT_WECHAT_OFFICIAL_ACCOUNT_ID ? "默认公众号" : "微信公众号")),
      appIdHint: appIdHint(nextAppId),
      createdAt: existing?.createdAt || timestamp,
      updatedAt: timestamp,
      // 任一凭证保存都重新进入“未实调确认”，避免更换 AppID 后沿用旧账号
      // 的正式发布通过状态。
      publishReady: null,
      lastPublishVerifiedAt: null,
    });

    if (!writeAccountCredentials(normalized, { appId: nextAppId, appSecret: nextAppSecret })) {
      throw new Error("写入 macOS 钥匙串失败");
    }
    const accounts = state.registry.accounts.filter((account) => account.id !== normalized);
    writeRegistry({ ...state.registry, accounts: [...accounts, record] });
    return publicAccount(
      record,
      { appId: nextAppId, appSecret: nextAppSecret },
      state.registry.defaultAccountId,
    );
  }

  function createAccount({ accountId, label, appId, appSecret } = {}) {
    const normalized = accountId
      ? validateAccountId(accountId)
      : `mp_${String(uuid()).replace(/[^A-Za-z0-9]/g, "").slice(0, 32)}`;
    const state = currentState();
    if (state.registry.accounts.some((account) => account.id === normalized)
      || state.virtualLegacy?.record.id === normalized) {
      throw new Error(`公众号账号已存在：${normalized}`);
    }
    return saveCredentials({ accountId: normalized, label, appId, appSecret });
  }

  function updateAccount(accountId, { label, appId, appSecret } = {}) {
    const normalized = validateAccountId(accountId);
    const current = credentialsFor(normalized); // 显式未知 ID 在此失败，绝不回退。
    const nextAppId = appId === undefined ? current.appId : String(appId || "").trim();
    const nextAppSecret = appSecret === undefined ? current.appSecret : String(appSecret || "").trim();
    return saveCredentials({
      accountId: normalized,
      label: label === undefined ? current.record.label : label,
      appId: nextAppId,
      appSecret: nextAppSecret,
    });
  }

  function markPublishReady(accountId, publishReady) {
    const normalized = validateAccountId(accountId);
    const state = currentState();
    const index = state.registry.accounts.findIndex((account) => account.id === normalized);
    if (index < 0) return false;
    const timestamp = now();
    const accounts = state.registry.accounts.map((account, accountIndex) => accountIndex === index
      ? sanitizeRecord({ ...account, publishReady: Boolean(publishReady), lastPublishVerifiedAt: timestamp, updatedAt: timestamp })
      : account);
    writeRegistry({ ...state.registry, accounts });
    return true;
  }

  function setDefaultAccount(accountId) {
    const normalized = validateAccountId(accountId);
    const { record, state } = findRecord(normalized, { allowUnconfiguredDefault: false });
    const credential = state.virtualLegacy?.record.id === normalized
      ? state.virtualLegacy.credential
      : readAccountCredentials(normalized);
    if (!credential.appId || !credential.appSecret) {
      throw new Error("公众号默认账号尚未配置完整凭据");
    }
    if (state.registry.defaultAccountId !== normalized) {
      writeRegistry({ ...state.registry, defaultAccountId: normalized });
    }
    return publicAccount(record, credential, normalized);
  }

  return {
    registryPath: resolvedRegistryPath,
    listAccounts,
    getAccount,
    credentialsFor,
    saveCredentials,
    createAccount,
    updateAccount,
    markPublishReady,
    setDefaultAccount,
  };
}
