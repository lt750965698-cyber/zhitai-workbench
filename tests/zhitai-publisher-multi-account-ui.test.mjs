import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const pageSrc = fs.readFileSync(new URL("../app/PublishNative.tsx", import.meta.url), "utf8");

test("发布中心为小红书和公众号提供明确的多账号添加入口", () => {
  assert.match(pageSrc, /添加小红书账号/);
  assert.match(pageSrc, /\/api\/v1\/publisher\/xhs\/accounts", "POST", \{ label \}/);
  assert.match(pageSrc, /login-qrcode" \+ query/);
  assert.match(pageSrc, /accountId=\$\{encodeURIComponent\(explicitAccountId\)\}/);

  assert.match(pageSrc, /添加公众号/);
  assert.match(pageSrc, /\/api\/v1\/publisher\/wechat-official\/accounts\/credentials/);
  assert.match(pageSrc, /accountId: explicitAccountId/);
  assert.match(pageSrc, /label: wechatLabel\.trim\(\)/);
});

test("图文发布按平台传递明确账号，同时兼容旧版单账号", () => {
  assert.match(pageSrc, /accountIdByDestination/);
  assert.match(pageSrc, /accountIds: accountIdByDestination/);
  assert.match(pageSrc, /legacy-xiaohongshu/);
  assert.match(pageSrc, /legacy-wechat-official/);
  assert.match(pageSrc, /选择小红书发布账号/);
  assert.match(pageSrc, /选择公众号发布账号/);
  assert.match(pageSrc, /请为每个图文平台选择一个已就绪的明确账号/);
  assert.match(pageSrc, /account\.isDefault && account\.ready/);
  assert.match(pageSrc, /默认草稿/);
});

test("公众号密钥只在本机密码表单录入，成功或取消后清空且不回显", () => {
  assert.match(pageSrc, /type="password" autoComplete="new-password"/);
  assert.match(pageSrc, /旧值不会回显/);
  assert.match(pageSrc, /setWechatAppId\(""\)/);
  assert.match(pageSrc, /setWechatAppSecret\(""\)/);
  assert.ok(!pageSrc.includes("wechatAppSecret: imageTextStatus"));
});

test("发布中心不包含自动播放或媒体播放器", () => {
  assert.ok(!/<(?:video|audio)\b/i.test(pageSrc));
  assert.ok(!/\bautoPlay\b|\bautoplay\b|\.play\s*\(/.test(pageSrc));
});

test("图文账号先独立加载，不等待视频账号 CLI", () => {
  assert.match(pageSrc, /const imageText = await zapi\(LOCAL_AGENT \+ "\/api\/v1\/publisher\/image-text\/status"/);
  assert.match(pageSrc, /const immediateImageAccounts = imageTextAccountsFrom\(null, nextImageTextStatus\)/);
  assert.match(pageSrc, /const \[a, h\] = await Promise\.all\(\[accountsPromise, historyPromise\]\)/);
  assert.match(pageSrc, /const statusResult = await zapi\(LOCAL_AGENT \+ "\/api\/v1\/publisher\/image-text\/status"/);
});
