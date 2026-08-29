import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const bridgeUrl = new URL("../local-agent/zhitai-filehelper-bridge.user.js", import.meta.url);
const companionUrl = new URL("../local-agent/zhitai-kuaidian-companion.user.js", import.meta.url);

const CANARIES = [
  "Bearer zhitai_fixture_credential_91",
  "session=zhitai_fixture_cookie_92",
  "13800138000",
  "这是一段仅用于回归测试的私聊正文_93",
  "<section data-private=\"zhitai_html_94\">私密</section>",
  "https://finder.video.qq.com/private.mp4?X-Amz-Signature=zhitai_signed_95&token=zhitai_token_96",
  "/Users/example/Private/zhitai_path_97/message.txt",
  "C:\\Users\\example\\Private\\zhitai_path_98\\message.txt",
];
const URL_BYPASS_VARIANTS = [
  `https://${encodeURIComponent(CANARIES[0])}@weixin.qq.com/sph/fixture-userinfo`,
  `https://weixin.qq.com/sph/fixture-credential?credential=${encodeURIComponent(CANARIES[0])}`,
  `https://weixin.qq.com/sph/fixture-nested?ref=${encodeURIComponent(`token=${CANARIES[0]}`)}`,
  `https://weixin.qq.com/sph/fixture-phone?phone=${CANARIES[2]}`,
  `https://weixin.qq.com/sph/fixture-path?next=${encodeURIComponent(CANARIES[6])}`,
  `https://weixin.qq.com/sph/fixture-html?preview=${encodeURIComponent(CANARIES[4])}`,
  `https://weixin.qq.com/sph/fixture-path-phone/${CANARIES[2]}`,
  "https://weixin.qq.com/sph/fixture-path-private/Users/example/Private/zhitai_path_97",
  `https://weixin.qq.com/sph/fixture-path-token/${encodeURIComponent(`token=${CANARIES[0]}`)}`,
];

test("文件助手桥只发送结构化诊断，内存面板、剪贴板和 GM 去重库不保留原文", async () => {
  const source = await readFile(bridgeUrl, "utf8");
  assert.match(source, /data:\s*JSON\.stringify\(buildSyncDiagnostic\(text, transport\)\)/);
  assert.doesNotMatch(source, /JSON\.stringify\(\{\s*url,\s*text/);
  assert.doesNotMatch(source, /location\.href/);
  assert.doesNotMatch(source, /outerHTML\.slice/);
  assert.doesNotMatch(source, /responseText\)\.slice/);
  assert.doesNotMatch(source, /hookRaw|sphSample|otherLinks/);
  assert.match(source, /const SEEN_KEY = 'zhitai_filehelper_seen_v2'/);
  assert.doesNotMatch(source, /const SEEN_KEY = 'zhitai_filehelper_seen'/,
    "新版桥不得读取旧版完整 URL 去重键");
  assert.doesNotMatch(source, /arr\.map\(dedupeKey\)/, "启动时不得读取并迁移旧版完整 URL");
  assert.match(source, /arr\.filter\(\(value\) => \/\^v2:/);
  assert.match(source, /GM_setValue\(SEEN_KEY, JSON\.stringify\(\[\.\.\.seen\]\)\)/);
  assert.match(source, /seen\.add\(dedupeKey\(norm\)\)/);
  assert.match(source, /hasSensitiveUrlMaterial\(parsed\)/);
  assert.match(source, /结构化诊断已复制；不含消息正文、HTML 或完整链接/);
  assert.doesNotMatch(extractFunction(source, "extractCardFromWxMsg"), /getElementsByTagName\(['"](?:desc|title)['"]\)/);
  assert.doesNotMatch(extractFunction(source, "submitCard"), /\btitle\b/);
});

test("结构化投影面对伪造凭据、手机号、私聊、HTML、临时 URL 和路径只留下计数", async () => {
  const source = await readFile(bridgeUrl, "utf8");
  const runtime = ["buildSyncDiagnostic", "utf8Bytes"]
    .map((name) => extractFunction(source, name))
    .join("\n");
  const context = { TextEncoder, result: null };
  vm.runInNewContext(runtime, context);
  const text = JSON.stringify({
    AddMsgList: [{
      MsgType: 49,
      AppMsgType: 2000,
      Content: CANARIES.join(" | "),
      Url: CANARIES[5],
      Title: CANARIES[3],
      Digest: CANARIES[4],
      Cookie: CANARIES[1],
    }],
  });
  context.result = vm.runInNewContext(
    `buildSyncDiagnostic(${JSON.stringify(text)}, "fetch")`,
    context,
  );
  assert.deepEqual(JSON.parse(JSON.stringify(context.result)), {
    schemaVersion: 2,
    source: "filehelper_bridge",
    kind: "sync_response",
    outcome: "observed",
    transport: "fetch",
    contentType: "json",
    metrics: {
      payloadBytes: new TextEncoder().encode(text).byteLength,
      itemCount: 0,
      messageCount: 1,
      linkCount: 2,
    },
  });
  const serialized = JSON.stringify(context.result);
  for (const marker of CANARIES) {
    assert.ok(!serialized.includes(marker), `结构化诊断不得包含测试标记：${marker.slice(0, 24)}`);
  }
});

test("浏览器桥在持久化或提交前拒绝 URL userinfo、敏感别名与编码嵌套材料", async () => {
  const source = await readFile(bridgeUrl, "utf8");
  const runtime = extractFunction(source, "hasSensitiveUrlMaterial");
  const context = { URL };
  vm.runInNewContext(runtime, context);
  for (const value of URL_BYPASS_VARIANTS) {
    assert.equal(vm.runInNewContext(`hasSensitiveUrlMaterial(new URL(${JSON.stringify(value)}))`, context), true);
  }
  assert.equal(
    vm.runInNewContext('hasSensitiveUrlMaterial(new URL("https://weixin.qq.com/sph/safe?foo=1"))', context),
    false,
  );

  const supportStart = source.indexOf("const SUPPORTED_EXACT");
  const supportEnd = source.indexOf("// URL 匹配", supportStart);
  assert.ok(supportStart >= 0 && supportEnd > supportStart);
  const supportContext = { URL };
  vm.runInNewContext(source.slice(supportStart, supportEnd), supportContext);
  assert.equal(
    vm.runInNewContext('isSupported("https://weixin.qq.com/sph/safe/extra")', supportContext),
    false,
    "稳定分享路径必须完整匹配，不能附加敏感或任意段",
  );
  assert.equal(
    vm.runInNewContext(
      'canonicalSupportedUrl("https://weixin.qq.com/sph/safe?foo=PRIVATE_CHAT_BODY_QUERY_6W2N#secret")',
      supportContext,
    ),
    "https://weixin.qq.com/sph/safe",
    "提交前必须无条件剥离任意 query/hash，避免未知字段夹带正文",
  );
});

test("独立快点伴生桥只持久化指纹，不上报标题或任意状态文本", async () => {
  const source = await readFile(companionUrl, "utf8");
  assert.doesNotMatch(source, /localStorage\.setItem\s*\(/,
    "伴生桥可以只读观察上游数据，但不得把载荷另行写回 localStorage");
  assert.match(source, /normalizeFingerprints\(REPORTED_KEY\)/);
  assert.match(source, /fingerprint\(r\.msgId\)/);
  assert.doesNotMatch(source, /title:\s*(?:item\.d|report\.title|card\.title)/);
  assert.match(source, /title:\s*"视频号内容"/);
  assert.match(source, /lastResultCode:\s*lastResultCode/);
  assert.doesNotMatch(source, /lastResult:\s*(?:item\.|report\.|card\.|getStorageSummary\()/);
  assert.match(source, /canonicalStableShareUrl\(value\)/);
});

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `找不到函数 ${name}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`函数 ${name} 未闭合`);
}
