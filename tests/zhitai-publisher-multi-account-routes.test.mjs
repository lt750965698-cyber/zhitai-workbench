import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const serverSrc = fs.readFileSync(new URL("../local-agent/server.mjs", import.meta.url), "utf8");
const pageSrc = fs.readFileSync(new URL("../app/PublishNative.tsx", import.meta.url), "utf8");

test("发布节点公开两个平台的非敏感账号列表与新增入口", () => {
  assert.match(serverSrc, /xiaohongshu:\s*\{ accounts: xiaohongshuAccounts \}/);
  assert.match(serverSrc, /wechatOfficial:\s*\{ accounts: wechatOfficialAccounts \}/);
  assert.match(serverSrc, /pathname === "\/api\/v1\/publisher\/xhs\/accounts"/);
  assert.match(serverSrc, /xhsPublisher\.createAccount\(\{ label: json\?\.label \}\)/);
  assert.match(serverSrc, /pathname === "\/api\/v1\/publisher\/wechat-official\/accounts\/credentials"/);
  assert.match(serverSrc, /wechatOfficial\.createAccount\(payload\)/);
  assert.match(serverSrc, /wechatOfficial\.updateAccount\(json\.accountId, payload\)/);
  assert.match(serverSrc, /pathname === "\/api\/v1\/publisher\/wechat-official\/accounts\/default"/);
  assert.match(serverSrc, /wechatOfficial\.setDefaultAccount\(json\?\.accountId\)/);
  assert.match(serverSrc, /requireConfirmedAction\(request\)/);
});

test("二维码与发布请求把明确 accountId 传到对应适配器", () => {
  assert.match(serverSrc, /searchParams\.has\("accountId"\)/);
  assert.match(serverSrc, /xhsPublisher\.loginQrcode\(accountId\)/);
  assert.match(serverSrc, /xhsPublisher\.publishImageText\(\{\s*accountId,/s);
  assert.match(serverSrc, /wechatOfficial\.publishArticle\(\{\s*accountId,/s);
  assert.match(serverSrc, /accountIdByDestination:\s*\{ \[target\.destination\]: accountId \}/);
  assert.match(serverSrc, /return \{\s*destination,\s*accountId: result\.accountId,/s);
});

test("公众号首次正式发布允许受控验证，只有已证实不可用才拦截", () => {
  assert.match(serverSrc, /prepared\.mode === "publish" && verified\.publishReady === false/);
  assert.doesNotMatch(serverSrc, /prepared\.mode === "publish" && verified\.publishReady !== true/);
});

test("公众号已有草稿可只读列出并以确认动作正式提交", () => {
  assert.match(serverSrc, /pathname === "\/api\/v1\/publisher\/wechat-official\/drafts"/);
  assert.match(serverSrc, /wechatOfficial\.listDrafts\(\{/);
  assert.match(serverSrc, /pathname === "\/api\/v1\/publisher\/wechat-official\/publish-draft"/);
  assert.match(serverSrc, /requireConfirmedAction\(request\)/);
  assert.match(serverSrc, /wechatOfficial\.submitDraft\(\{/);
});

test("前端以状态实况覆盖同账号轻量记录，并按草稿权限阻止误选", () => {
  assert.match(pageSrc, /existingIndex = rows\.findIndex/);
  assert.match(pageSrc, /rows\[existingIndex\] = next/);
  assert.match(pageSrc, /record\.draftReady === false/);
  assert.match(pageSrc, /accountIdByDestination/);
});
