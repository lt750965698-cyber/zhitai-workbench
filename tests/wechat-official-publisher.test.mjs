import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createWechatOfficialAccountStore,
  credentialServiceForAccount,
  LEGACY_APP_ID_SERVICE,
  LEGACY_APP_SECRET_SERVICE,
} from "../local-agent/wechat-official-accounts.mjs";
import { createWechatOfficialPublisher } from "../local-agent/wechat-official-publisher.mjs";

const APP_ID = "wx1234567890abcdef";
const APP_SECRET = ["01234567", "89abcdef", "01234567", "89abcdef"].join("");
const APP_ID_B = "wxabcdef1234567890";
const APP_SECRET_B = ["abcdef01", "23456789", "abcdef01", "23456789"].join("");

function harness({ legacy = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "zhitai-wechat-accounts-"));
  const registryPath = join(root, "private", "accounts.json");
  const secrets = new Map();
  if (legacy) {
    secrets.set(LEGACY_APP_ID_SERVICE, APP_ID);
    secrets.set(LEGACY_APP_SECRET_SERVICE, APP_SECRET);
  }
  let tick = 0;
  const store = createWechatOfficialAccountStore({
    registryPath,
    readSecret: (service) => secrets.get(service) || "",
    writeSecret: (service, value) => {
      secrets.set(service, String(value));
      return true;
    },
    environment: {},
    now: () => `2026-08-27T00:00:0${tick++}.000Z`,
    uuid: () => "11111111-2222-4333-8444-555555555555",
  });
  return {
    root,
    registryPath,
    secrets,
    store,
    publisher: createWechatOfficialPublisher({ accountStore: store }),
  };
}

test("自动迁移旧凭据为 default，注册表不落 AppID/AppSecret 且权限收紧", () => {
  const { registryPath, secrets, store } = harness();
  const accounts = store.listAccounts();

  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].accountId, "default");
  assert.equal(accounts[0].configured, true);
  assert.equal(accounts[0].isDefault, true);

  const registryText = readFileSync(registryPath, "utf8");
  const registry = JSON.parse(registryText);
  assert.equal(registry.schemaVersion, 2);
  assert.equal(registry.defaultAccountId, "default");
  assert.doesNotMatch(registryText, new RegExp(APP_ID));
  assert.doesNotMatch(registryText, new RegExp(APP_SECRET));
  assert.equal(statSync(registryPath).mode & 0o777, 0o600);
  assert.equal(statSync(join(registryPath, "..")).mode & 0o777, 0o700);

  const migratedBundle = secrets.get(credentialServiceForAccount("default"));
  assert.ok(migratedBundle);
  assert.deepEqual(JSON.parse(migratedBundle), {
    version: 1,
    appId: APP_ID,
    appSecret: APP_SECRET,
  });
  assert.equal(secrets.get(LEGACY_APP_SECRET_SERVICE), APP_SECRET, "迁移阶段保留旧钥匙串项");
  assert.doesNotMatch(JSON.stringify(accounts), new RegExp(`${APP_ID}|${APP_SECRET}`));
});

test("账号凭据按 accountId 隔离，更新一个账号不会覆盖另一个", () => {
  const { secrets, store } = harness({ legacy: false });
  const accountA = store.createAccount({ accountId: "account_a", label: "甲号", appId: APP_ID, appSecret: APP_SECRET });
  const accountB = store.createAccount({ accountId: "account_b", label: "乙号", appId: APP_ID_B, appSecret: APP_SECRET_B });

  assert.equal(accountA.accountId, "account_a");
  assert.equal(accountB.accountId, "account_b");
  assert.notEqual(credentialServiceForAccount("account_a"), credentialServiceForAccount("account_b"));
  assert.equal(store.credentialsFor("account_a").appSecret, APP_SECRET);
  assert.equal(store.credentialsFor("account_b").appSecret, APP_SECRET_B);

  store.updateAccount("account_a", { label: "甲号新版", appSecret: "11111111111111111111111111111111" });
  assert.equal(store.getAccount("account_a").label, "甲号新版");
  assert.equal(store.credentialsFor("account_a").appSecret, "11111111111111111111111111111111");
  assert.equal(store.credentialsFor("account_b").appSecret, APP_SECRET_B);
  assert.ok(secrets.has(credentialServiceForAccount("account_a")));
  assert.ok(secrets.has(credentialServiceForAccount("account_b")));

  assert.throws(
    () => store.saveCredentials({ accountId: "account_a", appId: APP_ID_B, appSecret: APP_SECRET_B }),
    /请创建新账号.*避免历史任务串号/,
  );

  assert.throws(() => store.getAccount("missing"), /账号不存在/);
  assert.throws(() => store.credentialsFor(""), /accountId 格式不正确/);
});

test("默认草稿账号可持久切换，省略 accountId 时路由到该账号", async () => {
  const { root, registryPath, secrets, store, publisher } = harness({ legacy: false });
  store.createAccount({ accountId: "default", label: "旧默认号", appId: APP_ID, appSecret: APP_SECRET });
  store.createAccount({ accountId: "account_b", label: "乙号", appId: APP_ID_B, appSecret: APP_SECRET_B });

  const selected = store.setDefaultAccount("account_b");
  assert.equal(selected.accountId, "account_b");
  assert.equal(selected.isDefault, true);
  assert.equal(JSON.parse(readFileSync(registryPath, "utf8")).defaultAccountId, "account_b");
  assert.deepEqual(
    store.listAccounts().map(({ accountId, isDefault }) => ({ accountId, isDefault })),
    [
      { accountId: "default", isDefault: false },
      { accountId: "account_b", isDefault: true },
    ],
  );
  assert.equal(publisher.status().accountId, "account_b");
  assert.equal(publisher.status("default").accountId, "default", "显式旧账号不得被默认路由覆盖");

  const reloadedStore = createWechatOfficialAccountStore({
    registryPath,
    readSecret: (service) => secrets.get(service) || "",
    writeSecret: (service, value) => {
      secrets.set(service, String(value));
      return true;
    },
    environment: {},
  });
  assert.equal(reloadedStore.getAccount().accountId, "account_b", "进程重启后仍读取持久默认账号");

  const calls = [];
  const status = await publisher.verifyStatus({
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes("/cgi-bin/token?")) return Response.json({ access_token: "account-b-token" });
      return Response.json({ total_count: 0 });
    },
  });
  assert.equal(status.accountId, "account_b");
  assert.match(calls[0], new RegExp(`appid=${APP_ID_B}`));

  const explicitCalls = [];
  await publisher.verifyStatus({
    accountId: "default",
    fetchImpl: async (url) => {
      explicitCalls.push(String(url));
      if (String(url).includes("/cgi-bin/token?")) return Response.json({ access_token: "old-default-token" });
      return Response.json({ total_count: 0 });
    },
  });
  assert.match(explicitCalls[0], new RegExp(`appid=${APP_ID}(?:&|$)`));
  assert.doesNotMatch(explicitCalls[0], new RegExp(`appid=${APP_ID_B}`));

  const imagePath = join(root, "default-route-cover.jpg");
  writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const publishCalls = [];
  const draft = await publisher.publishArticle({
    title: "默认路由测试",
    content: "正文",
    images: [imagePath],
    fetchImpl: async (url) => {
      publishCalls.push(String(url));
      if (String(url).includes("/cgi-bin/token?")) return Response.json({ access_token: "account-b-token" });
      if (String(url).includes("/material/add_material?")) return Response.json({ media_id: "cover-media" });
      if (String(url).includes("/media/uploadimg?")) return Response.json({ url: "https://mmbiz.example/image" });
      if (String(url).includes("/draft/add?")) return Response.json({ media_id: "draft-media" });
      throw new Error("unexpected request");
    },
  });
  assert.equal(draft.accountId, "account_b");
  assert.equal(draft.status, "draft");
  assert.match(publishCalls[0], new RegExp(`appid=${APP_ID_B}`));

  assert.throws(() => store.setDefaultAccount("missing"), /账号不存在/);
  assert.equal(store.getAccount().accountId, "account_b", "失败切换不得改变持久默认账号");
});

test("注册表引用不存在的默认账号时 fail closed", () => {
  const { registryPath, store } = harness({ legacy: false });
  store.createAccount({ accountId: "only_account", label: "唯一账号", appId: APP_ID, appSecret: APP_SECRET });
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  writeFileSync(registryPath, JSON.stringify({ ...registry, defaultAccountId: "missing_account" }));
  assert.throws(() => store.listAccounts(), /默认账号不存在.*停止发布/);
});

test("verifyStatus 兼容旧调用 default，并区分凭证、草稿和正式发布状态", async () => {
  const { publisher } = harness();
  const calls = [];
  const result = await publisher.verifyStatus({
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes("/cgi-bin/token?")) {
        return Response.json({ access_token: "test-access-token", expires_in: 7200 });
      }
      return Response.json({ total_count: 3 });
    },
  });

  assert.equal(calls.length, 2);
  assert.equal(result.accountId, "default");
  assert.equal(result.configured, true);
  assert.equal(result.credentialReady, true);
  assert.equal(result.draftReady, true);
  assert.equal(result.publishReady, null, "未实际正式提交前不冒充已验证");
  assert.equal(result.ready, true);
  assert.equal(result.needsAttention, false);
  assert.match(result.reason, /凭证与草稿箱权限有效/);
  assert.match(result.reason, /正式发布权限尚未/);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${APP_ID}|${APP_SECRET}|test-access-token`));
});

test("verifyStatus 使用显式账号凭据，不会误用 default", async () => {
  const { publisher } = harness();
  publisher.createAccount({ accountId: "second", label: "第二个号", appId: APP_ID_B, appSecret: APP_SECRET_B });
  const calls = [];
  const result = await publisher.verifyStatus({
    accountId: "second",
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes("/cgi-bin/token?")) {
        return Response.json({ access_token: "second-token", expires_in: 7200 });
      }
      return Response.json({ total_count: 0 });
    },
  });

  assert.equal(result.accountId, "second");
  assert.match(calls[0], new RegExp(`appid=${APP_ID_B}`));
  assert.doesNotMatch(calls[0], new RegExp(`appid=${APP_ID}(?:&|$)`));
  assert.throws(() => publisher.status("missing"), /账号不存在/);
  await assert.rejects(
    publisher.verifyStatus({ accountId: "", fetchImpl: async () => { throw new Error("不应发起网络请求"); } }),
    /accountId 格式不正确/,
  );
  await assert.rejects(
    publisher.verifyStatus({ accountId: null, fetchImpl: async () => { throw new Error("不应发起网络请求"); } }),
    /accountId 格式不正确/,
  );
});

test("verifyStatus 将未完成资质认证服务号的 48001 诊断为草稿和发布均不可用", async () => {
  const { publisher } = harness();
  const calls = [];
  const result = await publisher.verifyStatus({
    accountId: "default",
    fetchImpl: async (url, options = {}) => {
      calls.push({ url: String(url), options });
      if (String(url).includes("/cgi-bin/token?")) {
        return Response.json({ access_token: "sensitive-test-token", expires_in: 7200 });
      }
      if (String(url).includes("/cgi-bin/account/getaccountbasicinfo?")) {
        return Response.json({
          account_type: 2,
          principal_name: "不得出现在状态响应中的主体",
          wx_verify_info: { qualification_verify: false, naming_verify: false },
        });
      }
      return Response.json({ errcode: 48001, errmsg: "api unauthorized" });
    },
  });

  assert.equal(calls.length, 3);
  assert.match(calls[2].url, /\/cgi-bin\/account\/getaccountbasicinfo\?/);
  assert.equal(result.accountId, "default");
  assert.equal(result.credentialReady, true);
  assert.equal(result.draftReady, false);
  assert.equal(result.publishReady, false);
  assert.equal(result.ready, false);
  assert.equal(result.needsAttention, true);
  assert.equal(result.accountType, 2);
  assert.equal(result.qualificationVerified, false);
  assert.match(result.reason, /服务号尚未完成微信资质认证/);
  assert.match(result.reason, /48001/);
  assert.equal(publisher.status("default").publishReady, false);
  assert.doesNotMatch(
    JSON.stringify(result),
    new RegExp(`${APP_ID}|${APP_SECRET}|sensitive-test-token|不得出现在状态响应中的主体`),
  );
});

test("verifyStatus 保留网络与暂时草稿接口错误为 unknown 候选", async () => {
  const { publisher } = harness();
  const result = await publisher.verifyStatus({
    fetchImpl: async (url) => {
      if (String(url).includes("/cgi-bin/token?")) {
        return Response.json({ access_token: "test-access-token", expires_in: 7200 });
      }
      throw new TypeError("fetch failed");
    },
  });

  assert.equal(result.credentialReady, true);
  assert.equal(result.draftReady, false);
  assert.equal(result.ready, false);
  assert.equal(result.needsAttention, false);
  assert.match(result.reason, /暂时无法校验/);
});

test("publishArticle 显式未知账号立即停止；正式提交成功后仅标记目标账号", async () => {
  const { root, publisher } = harness();
  publisher.createAccount({ accountId: "second", label: "第二个号", appId: APP_ID_B, appSecret: APP_SECRET_B });
  const imagePath = join(root, "cover.jpg");
  writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  let networkCalls = 0;
  await assert.rejects(
    publisher.publishArticle({ accountId: "missing", title: "不会发布", content: "不会发布", images: [imagePath], fetchImpl: async () => { networkCalls += 1; } }),
    /账号不存在/,
  );
  await assert.rejects(
    publisher.publishArticle({ accountId: null, title: "不会发布", content: "不会发布", images: [imagePath], fetchImpl: async () => { networkCalls += 1; } }),
    /accountId 格式不正确/,
  );
  assert.equal(networkCalls, 0);

  const calls = [];
  const result = await publisher.publishArticle({
    accountId: "second",
    title: "多账号安全测试",
    content: "正文",
    images: [imagePath],
    draft: false,
    fetchImpl: async (url) => {
      calls.push(String(url));
      if (String(url).includes("/cgi-bin/token?")) return Response.json({ access_token: "second-token" });
      if (String(url).includes("/material/add_material?")) return Response.json({ media_id: "cover-media" });
      if (String(url).includes("/media/uploadimg?")) return Response.json({ url: "https://mmbiz.example/image" });
      if (String(url).includes("/draft/add?")) return Response.json({ media_id: "draft-media" });
      if (String(url).includes("/freepublish/submit?")) return Response.json({ publish_id: "publish-job" });
      throw new Error("unexpected request");
    },
  });

  assert.equal(result.accountId, "second");
  assert.equal(result.status, "submitted");
  assert.match(calls[0], new RegExp(`appid=${APP_ID_B}`));
  assert.equal(publisher.status("second").publishReady, true);
  assert.equal(publisher.status("default").publishReady, null);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(`${APP_SECRET_B}|second-token`));
});

test("listDrafts 只返回安全摘要，submitDraft 首次提交后固化发布权限", async () => {
  const { publisher } = harness();
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), body: options.body ? JSON.parse(options.body) : null });
    if (String(url).includes("/cgi-bin/token?")) return Response.json({ access_token: "draft-token" });
    if (String(url).includes("/draft/batchget?")) return Response.json({
      total_count: 1,
      item_count: 1,
      item: [{
        media_id: "existing-draft",
        update_time: 1787760000,
        content: { news_item: [{ title: "儿童房布局", author: "", digest: "空间利用摘要", content: "<p>正文</p>" }] },
      }],
    });
    if (String(url).includes("/freepublish/submit?")) return Response.json({ publish_id: "existing-publish" });
    throw new Error("unexpected request");
  };

  const drafts = await publisher.listDrafts({ accountId: "default", includeContent: false, fetchImpl });
  assert.equal(drafts.totalCount, 1);
  assert.deepEqual(drafts.items[0], {
    mediaId: "existing-draft",
    updateTime: 1787760000,
    title: "儿童房布局",
    author: "",
    digest: "空间利用摘要",
  });
  assert.deepEqual(calls.find((call) => call.url.includes("/draft/batchget?")).body, {
    offset: 0,
    count: 20,
    no_content: 1,
  });

  const submitted = await publisher.submitDraft({ accountId: "default", mediaId: "existing-draft", fetchImpl });
  assert.equal(submitted.status, "submitted");
  assert.equal(submitted.publishId, "existing-publish");
  assert.equal(publisher.status("default").publishReady, true);
  assert.deepEqual(calls.find((call) => call.url.includes("/freepublish/submit?")).body, { media_id: "existing-draft" });
  assert.doesNotMatch(JSON.stringify({ drafts, submitted }), /draft-token/);
});

test("publishArticle 同一 accountId 串行执行素材与草稿链路", async () => {
  const { root, publisher } = harness();
  const imagePath = join(root, "serial-cover.jpg");
  writeFileSync(imagePath, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));

  let tokenCalls = 0;
  let materialCalls = 0;
  let releaseFirstMaterial;
  let signalFirstMaterial;
  const firstMaterialStarted = new Promise((resolve) => { signalFirstMaterial = resolve; });
  const firstMaterialRelease = new Promise((resolve) => { releaseFirstMaterial = resolve; });
  const fetchImpl = async (url) => {
    const value = String(url);
    if (value.includes("/cgi-bin/token?")) {
      tokenCalls += 1;
      return Response.json({ access_token: `token-${tokenCalls}` });
    }
    if (value.includes("/material/add_material?")) {
      materialCalls += 1;
      if (materialCalls === 1) {
        signalFirstMaterial();
        await firstMaterialRelease;
      }
      return Response.json({ media_id: `cover-${materialCalls}` });
    }
    if (value.includes("/media/uploadimg?")) return Response.json({ url: "https://mmbiz.example/image" });
    if (value.includes("/draft/add?")) return Response.json({ media_id: `draft-${materialCalls}` });
    throw new Error("unexpected request");
  };

  const first = publisher.publishArticle({ title: "第一篇", content: "正文", images: [imagePath], fetchImpl });
  await firstMaterialStarted;
  const second = publisher.publishArticle({ title: "第二篇", content: "正文", images: [imagePath], fetchImpl });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(tokenCalls, 1, "第二次发布应等待同账号第一次发布释放互斥锁");
    assert.equal(materialCalls, 1);
  } finally {
    releaseFirstMaterial();
  }

  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map((row) => row.accountId), ["default", "default"]);
  assert.equal(tokenCalls, 2);
  assert.equal(materialCalls, 2);
});
