import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { extractTags, analyzeVideo } from "../local-agent/analyze.mjs";
import { extractMedia } from "../local-agent/channels-yuanbao.mjs";
import {
  buildAnalysisCapabilities,
  buildMetadataV2,
  buildStatsSnapshot,
  canonicalizeSourceUrl,
  containsSensitiveUrlMaterial,
  deriveContentId,
  isSensitiveFieldName,
  isStableShareUrl,
  parseFfprobePayload,
  parseFormattedCount,
  parseMdlsValue,
  sanitizeMetadataValue,
} from "../local-agent/content-metadata.mjs";

test("元宝 Cookie 会读取本机受管 WeChat MP Tools 的运行时配置", async () => {
  const source = await readFile(new URL("../local-agent/channels-yuanbao.mjs", import.meta.url), "utf8");
  assert.match(source, /\.local\/share\/zhitai-runtime\/engines\/wechat-mp-tools\/data\/app_settings\.json/);
  assert.match(source, /Application Support\/WeChat MP Tools\/data\/app_settings\.json/);
  assert.match(source, /for \(const path of GUI_SETTINGS_CANDIDATES\)/);
});

test("formatted upstream counts preserve their raw value and normalize Chinese units", () => {
  assert.deepEqual(parseFormattedCount("1.2万"), {
    value: 12_000,
    raw: "1.2万",
    approximate: true,
  });
  assert.equal(parseFormattedCount("3.4K").value, 3_400);
  assert.equal(parseFormattedCount(27).value, 27);
  assert.equal(parseFormattedCount("未知").value, null);
});

test("stats snapshot records observation provenance and never invents views", () => {
  const stats = buildStatsSnapshot({ like: "1.2万", fav: "88", comment: "--" }, {
    observedAt: "2026-08-11T08:00:00.000Z",
    source: "yuanbao+finder-preview",
    provenance: { endpointField: "feedInfo.*CountFmt" },
  });
  assert.equal(stats.observedAt, "2026-08-11T08:00:00.000Z");
  assert.equal(stats.counts.like.value, 12_000);
  assert.equal(stats.counts.like.raw, "1.2万");
  assert.equal(stats.counts.view.status, "unavailable");
  assert.equal(stats.counts.view.value, null);
  assert.equal(stats.counts.view.reason, "source_did_not_return_view_count");
  assert.deepEqual(stats.provenance, { endpointField: "feedInfo.*CountFmt" });
});

test("canonical source URLs omit download credentials and remain stable", () => {
  const signed = "https://example.test/video.mp4?b=2&token=secret&encfilekey=also-secret&a=1#part";
  const canonical = canonicalizeSourceUrl(signed);
  assert.equal(canonical, "https://example.test/video.mp4?a=1&b=2");
  assert.equal(containsSensitiveUrlMaterial(signed), true);
  assert.equal(containsSensitiveUrlMaterial(canonical), false);
  assert.equal(deriveContentId("https://weixin.qq.com/sph/AbC123", "视频号"), "视频号:sph:AbC123");
});

test("schema v2 has one normalized contract and strips signed media credentials", () => {
  const sha = "a".repeat(64);
  const metadata = buildMetadataV2({
    id: "ing_1",
    title: "示例视频",
    author: "作者",
    platform: "视频号",
    contentKind: "video",
    category: "素材",
    tags: ["适老化", "适老化"],
    sourceUrl: "https://weixin.qq.com/sph/AbC123?token=private",
    receivedVia: "manual",
    files: [{ path: "assets/01-video.mp4", sizeBytes: 12, sha256: sha }],
    rawStats: { like: "2万" },
    statsSource: "yuanbao+finder-preview",
    upstream: {
      exportId: "AbC123",
      videoUrl: "https://media.test/video?token=private",
      nested: { decodeKey: "private", safe: true },
    },
    reportPath: "analysis.md",
  });
  assert.equal(metadata.schemaVersion, 2);
  assert.equal(metadata.source.url, "https://weixin.qq.com/sph/AbC123");
  assert.equal(metadata.identity.primaryAssetSha256, sha);
  assert.equal(metadata.files[0].role, "video");
  assert.equal(metadata.stats.counts.like.value, 20_000);
  assert.equal(metadata.stats.counts.view.value, null);
  assert.equal(metadata.analysis.transcript.status, "unavailable");
  assert.equal(metadata.upstream.videoUrl, undefined);
  assert.equal(metadata.upstream.nested.decodeKey, undefined);
  assert.equal(JSON.stringify(metadata).includes("private"), false);
  assert.deepEqual(metadata.tags, ["适老化"]);
  assert.deepEqual(sanitizeMetadataValue({ cookie: "secret", safe: 1 }), { safe: 1 });
});

test("ffprobe and mdls parsers use explicit bps fields and retain raw evidence", () => {
  const parsed = parseFfprobePayload({
    format: { format_name: "mov,mp4", duration: "3.5", bit_rate: "800000" },
    streams: [
      { index: 0, codec_type: "video", codec_name: "h264", width: 1080, height: 1920, bit_rate: "700000", avg_frame_rate: "30/1" },
      { index: 1, codec_type: "audio", codec_name: "aac", sample_rate: "48000", channels: 2, bit_rate: "100000" },
    ],
  });
  assert.equal(parsed.status, "available");
  assert.equal(parsed.container.bitRateBps, 800_000);
  assert.equal(parsed.video[0].bitRateBps, 700_000);
  assert.equal(parsed.video[0].frameRate, 30);
  assert.equal(parsed.audio[0].bitRateBps, 100_000);
  assert.equal(parsed.raw.streams.length, 2);
  assert.deepEqual(parseMdlsValue("(Video, Sound)"), ["Video", "Sound"]);
  assert.deepEqual(parseMdlsValue('(\n    "H.264",\n    "AAC"\n)'), ["H.264", "AAC"]);
});

test("analysis capability manifest is honest when ASR, OCR and vision are absent", () => {
  const capabilities = buildAnalysisCapabilities({ reportPath: "analysis.md", reportMode: "metadata_only" });
  assert.equal(capabilities.report.status, "metadata_only");
  assert.equal(capabilities.transcript.status, "unavailable");
  assert.equal(capabilities.transcript.missingCapability, "asr_engine");
  assert.equal(capabilities.ocr.missingCapability, "ocr_engine");
  assert.equal(capabilities.shots.segments.length, 0);
  assert.equal(capabilities.virality.hypotheses.length, 0);
});

test("Yuanbao feed extraction keeps upstream creator and metric fields without claiming views", () => {
  const media = extractMedia({
    data: {
      authorInfo: { nickname: "示例作者", headImgUrl: "https://img.test/avatar", authIconUrl: "https://img.test/auth" },
      feedInfo: {
        description: "适老化卫生间改造",
        coverUrl: "https://img.test/cover",
        videoUrl: "https://media.test/video?token=private",
        createtime: 1_786_406_400,
        mediaType: 4,
        likeCountFmt: "1.2万",
        favCountFmt: "980",
        forwardCountFmt: "66",
        commentCountFmt: "32",
      },
    },
  });
  assert.equal(media.author, "示例作者");
  assert.equal(media.creator.avatarUrl, "https://img.test/avatar");
  assert.equal(media.stats.like, "1.2万");
  assert.equal("view" in media.stats, false);
  assert.equal(media.sourceFields.stats, "feedInfo.*CountFmt");
});

test("metadata-only analysis returns category and reusable tags with evidence limits", async () => {
  const result = await analyzeVideo({
    description: "适老化卫生间防滑扶手改造",
    stats: { like: "1.2万", fav: "2万" },
  }, { yuanbaoEnabled: false });
  assert.equal(result.category, "素材");
  assert.equal(result.reportMode, "metadata_only");
  assert.ok(result.tags.includes("适老化"));
  assert.ok(result.analysisMarkdown.includes("尚未读取视频画面或音轨"));
  assert.ok(extractTags("AI 智能体工作流").includes("智能体"));
});

/* ─────────── D2 统一分类器：isSensitiveFieldName 纯函数表（exact/alias/endsWith/prefix/负例） ─────────── */
test("isSensitiveFieldName：exact/alias/endsWith/前缀/语义段命中，monkey/oauth/ordinary_key/cookiePolicy/tokenizer 不命中", () => {
  const positives = [
    // exact / 别名
    "access_token", "authkey", "auth_key", "decode_key", "decodeKey", "decodekey",
    "decrypt_key", "decryptKey", "encfilekey", "ws_secret", "wsSecret", "wssecret",
    "ws_time", "wsTime", "wstime", "cookie", "authorization", "signature", "sig",
    "key", "api_key", "apikey", "token", "secret", "password", "expires",
    "videoUrl", "playableUrl", "downloadUrl", "videourl", "playableurl", "downloadurl",
    "x-cos-security-token", "x-oss-security-token", "x-oss-signature",
    // 归一化 endsWith token/secret/password/signature
    "clientSecret", "my_api_token", "user_signature", "access_password",
    // X-Amz-/x-cos-/x-oss- 前缀（大小写不敏感）
    "X-Amz-Signature", "X-Amz-Credential", "x-cos-signature", "x-oss-access-key-id",
    // D2 终审：auth/uskey/x-uskey（x-uskey 为元宝 live-browser 签名）恢复旧契约
    "auth", "uskey", "x-uskey",
    // D2 终审：完整语义段（下划线/短横/点/方括号 + camelCase）识别
    "authorizationHeader", "cookieHeader", "token_value", "client_secret_value", "my_auth", "x_uskey",
    // D2 终审：全大写复合字段（camel/acronym 边界分词，ALL_CAPS 段保持整体后 lower）
    "AUTH_HEADER", "COOKIE_HEADER", "TOKEN_VALUE", "CLIENT_SECRET_VALUE", "X_USKEY", "AUTHHeader",
  ];
  for (const name of positives) {
    assert.equal(isSensitiveFieldName(name), true, `应命中：${name}`);
  }
  const negatives = ["monkey", "oauth", "ordinary_key", "title", "author", "cookiePolicy", "tokenizer", "likes", "comment", "favorites", "shares", "feedInfo", "description", "durationSeconds", "width", "height"];
  for (const name of negatives) {
    assert.equal(isSensitiveFieldName(name), false, `不应命中：${name}`);
  }
});

test("分享 URL canonical 丢弃全部 query，敏感参数拒绝稳定分类", () => {
  for (const [url, keyName, secret] of [
    ["https://weixin.qq.com/sph/abc?x-uskey=XUS_SECRET&foo=1", "x-uskey", "XUS_SECRET"],
    ["https://weixin.qq.com/sph/abc?X_USKEY=UPPER_SECRET&foo=1", "X_USKEY", "UPPER_SECRET"],
  ]) {
    assert.equal(containsSensitiveUrlMaterial(url), true, `${keyName} 判敏感`);
    assert.equal(isStableShareUrl(url), false, `${keyName} 拒稳定`);
    const canonical = canonicalizeSourceUrl(url);
    assert.ok(!canonical.includes(keyName) && !canonical.includes(secret), `${keyName} canonical 去掉：${canonical}`);
    assert.equal(new URL(canonical).search, "", `${keyName} URL 的全部 query 均应丢弃`);
  }
  const safe = "https://weixin.qq.com/sph/abc?foo=1";
  assert.equal(canonicalizeSourceUrl(safe), "https://weixin.qq.com/sph/abc");
  assert.equal(isStableShareUrl(safe), true, "稳定路径可识别，但 canonical 绝不保留任意 query");
  const privateChat = "仅供回归测试的私聊正文_query_301";
  assert.equal(
    canonicalizeSourceUrl(`https://weixin.qq.com/sph/abc?foo=${encodeURIComponent(privateChat)}`).includes(privateChat),
    false,
    "未知 query key 也不能成为正文隐蔽通道",
  );
});

test("URL 凭据旁路：userinfo、敏感别名、嵌套 token、手机号、HTML 与私有路径均拒绝并从 canonical 移除", () => {
  const marker = "BearerTokenCanaryURL91";
  const variants = [
    [`https://${marker}@weixin.qq.com/sph/abc`, marker],
    [`https://weixin.qq.com/sph/abc?credential=${marker}&foo=1`, marker],
    [`https://weixin.qq.com/sph/abc?ref=${encodeURIComponent(`token=${marker}`)}&foo=1`, marker],
    ["https://weixin.qq.com/sph/abc?phone=13912345678&foo=1", "13912345678"],
    [`https://weixin.qq.com/sph/abc?next=${encodeURIComponent("/Users/example/Private/chat.txt")}&foo=1`, "/Users/example/Private/chat.txt"],
    [`https://weixin.qq.com/sph/abc?preview=${encodeURIComponent("<article>private</article>")}&foo=1`, "<article>private</article>"],
    ["https://weixin.qq.com/sph/abc/13912345678", "13912345678"],
    ["https://weixin.qq.com/sph/abc/Users/example/Private/chat.txt", "Users/example/Private/chat.txt"],
    [`https://weixin.qq.com/sph/abc/${encodeURIComponent(`token=${marker}`)}`, marker],
  ];
  for (const [url, secret] of variants) {
    assert.equal(containsSensitiveUrlMaterial(url), true, `应拒绝敏感 URL：${url}`);
    assert.equal(isStableShareUrl(url), false, "敏感 URL 不得成为稳定来源");
    const canonical = canonicalizeSourceUrl(url);
    assert.equal(canonical.includes(secret), false, "canonical 不得保留敏感值");
    assert.equal(canonical.includes(encodeURIComponent(secret)), false, "canonical 不得保留编码后的敏感值");
  }
  assert.equal(isStableShareUrl("https://weixin.qq.com/sph/abc/extra"), false, "稳定分享 path 必须完整匹配");
});
