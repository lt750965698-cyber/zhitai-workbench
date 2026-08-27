/**
 * kb-d2b-sanitizer.test.mjs — D2 终审隔离纯函数/recordReceipt 测试（独立于 kb-v2d 的全局 before/server/固定 MP4）。
 *
 * A. 唯一敏感字段分类器：auth/uskey/x-uskey/authorizationHeader/cookieHeader/token_value/client_secret_value
 *    必须命中；monkey/oauth/ordinary_key/author/title/cookiePolicy/tokenizer 必须 false；
 *    x-uskey 分享 URL 必须判敏感/拒稳定/canonical 去掉 x-uskey，普通 query 保留。
 * B. assignment scanner：嵌套/索引选择器（headers[token][]=、headers[token][0]=、token[0]=）与既有
 *    quoted/转义 JSON/全角/dot/bracket/token[]/auth/uskey/x-uskey/authorizationHeader 全覆盖。
 * C. 标题路径门控（真实左边界，含转义斜杠）：UNC/POSIX/~/file_not_found:\/… 遮蔽并吞掉 marker；
 *    厨房/卫生间改造、厨房 / 卫生间、厨房/home/卫生间改造 逐字保留；sanitizeFailureText 净化转义绝对路径。
 * D. recordReceipt 每轮前后断言 receipt 与 observation 计数都恰好 +1、新行存在且 ID 新增；
 *    SELECT 含 source_url/content_id/title/fallback_reason/outcome/evidence；直接读取字段、JSON.parse
 *    evidence 逐字段独立断言（不同字段不同 marker），不 JSON.stringify 合并搜索。
 *
 * Mutation-kill 说明：
 *   1) 删 isSensitiveFieldName 的 auth/uskey/x-uskey（或 exact 集）→ B 组 auth=/uskey=/x-uskey= 样本与
 *      A4 x-uskey URL（containsSensitiveUrlMaterial/canonical/stable）必红。
 *   2) 删 recordReceipt 任一净化接线（fallbackReason 走 sanitizeFailureText / contentId 走 sanitizeReceiptTitle /
 *      observeIngest 走 sanitizeFailureText）→ 对应字段 marker 必落库 → D 组逐字段断言必红。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { openKbDb, recordReceipt, keyToEolRedactor, sanitizeFailureText, sanitizeReceiptTitle } from "../local-agent/kb.mjs";
import { isSensitiveFieldName, canonicalizeSourceUrl, isStableShareUrl, containsSensitiveUrlMaterial } from "../local-agent/content-metadata.mjs";

/* ─────────── A：分类器正反例 + x-uskey URL ─────────── */
test("A. isSensitiveFieldName 正反例（auth/uskey/x-uskey/别名/全大写复合命中；monkey/oauth/cookiePolicy/tokenizer 等 false）", () => {
  const positives = [
    "auth", "uskey", "x-uskey",
    "authorizationHeader", "cookieHeader", "token_value", "client_secret_value",
    // 全大写复合字段（camel/acronym 边界分词，ALL_CAPS 段保持整体后 lower）
    "AUTH_HEADER", "COOKIE_HEADER", "TOKEN_VALUE", "CLIENT_SECRET_VALUE", "X_USKEY", "AUTHHeader",
    "access_token", "authkey", "auth_key", "decode_key", "decodeKey", "decrypt_key", "encfilekey",
    "ws_secret", "wsSecret", "ws_time", "wsTime", "cookie", "authorization", "signature", "sig",
    "key", "api_key", "apikey", "token", "secret", "password", "expires",
    "videoUrl", "playableUrl", "downloadUrl",
    "clientSecret", "my_api_token", "user_signature", "my_auth", "x_uskey",
    "X-Amz-Signature", "x-cos-signature", "x-oss-security-token",
  ];
  for (const name of positives) assert.equal(isSensitiveFieldName(name), true, `应命中：${name}`);
  const negatives = ["monkey", "oauth", "ordinary_key", "author", "title", "cookiePolicy", "tokenizer", "likes", "comment", "favorites", "shares", "feedInfo", "durationSeconds"];
  for (const name of negatives) assert.equal(isSensitiveFieldName(name), false, `不应命中：${name}`);
});

test("A4. x-uskey/X_USKEY 分享 URL：判敏感/拒稳定/canonical 去掉；普通 query 保留", () => {
  for (const [url, keyName, secret] of [
    ["https://weixin.qq.com/sph/abc?x-uskey=XUS_SECRET&foo=1", "x-uskey", "XUS_SECRET"],
    ["https://weixin.qq.com/sph/abc?X_USKEY=UPPER_SECRET&foo=1", "X_USKEY", "UPPER_SECRET"],
  ]) {
    assert.equal(containsSensitiveUrlMaterial(url), true, `${keyName} 判敏感`);
    assert.equal(isStableShareUrl(url), false, `${keyName} 拒稳定`);
    const canonical = canonicalizeSourceUrl(url);
    assert.ok(!canonical.includes(keyName) && !canonical.includes(secret), `${keyName} canonical 去掉：${canonical}`);
    assert.ok(canonical.includes("foo=1"), `${keyName} 普通 query 保留：${canonical}`);
  }
  const safe = canonicalizeSourceUrl("https://weixin.qq.com/sph/abc?foo=1");
  assert.ok(safe.includes("foo=1") && isStableShareUrl(safe), `安全稳定 URL 保留：${safe}`);
});

/* ─────────── B：assignment scanner 组合选择器 ─────────── */
test("B. keyToEolRedactor：嵌套/索引选择器 + quoted/转义 JSON/全角/dot/bracket/token[]/auth/uskey/x-uskey", () => {
  // 真正转义 JSON：运行时字符串含反斜杠 {\"token\":\"TOK_ESC\"}
  const escapedJson = String.raw`{\"token\":\"TOK_ESC\"}`;
  const cases = [
    ["headers[token][]=TOK_NESTED", "TOK_NESTED"],
    ["headers[token][0]=TOK_INDEXED", "TOK_INDEXED"],
    ["token[0]=TOK_INDEXED", "TOK_INDEXED"],
    [escapedJson, "TOK_ESC"],
    ['{"token":"TOK_JSON"}', "TOK_JSON"],
    ['{"authorization":"Bearer AUTH_JSON"}', "AUTH_JSON"],
    ["token：TOK_FULL", "TOK_FULL"],
    ["authorization＝AUTH_FULL", "AUTH_FULL"],
    ["headers[authorization]=AUTH_BRACKET", "AUTH_BRACKET"],
    ["headers.authorization=AUTH_DOT", "AUTH_DOT"],
    ["token[]=TOK_ARRAY", "TOK_ARRAY"],
    ["auth=AUTH_V", "AUTH_V"],
    ["uskey=USKEY_V", "USKEY_V"],
    ["x-uskey=XUS_V", "XUS_V"],
    ["authorizationHeader=AUTH_H_V", "AUTH_H_V"],
    ["cookieHeader=CH_V", "CH_V"],
    ["token_value=TV_V", "TV_V"],
    ["client_secret_value=CSV_V", "CSV_V"],
    // 全大写复合字段（ALL_CAPS 段保持整体后 lower）
    ["AUTH_HEADER=AUTH_CAPS_V", "AUTH_CAPS_V"],
    ["COOKIE_HEADER=CH_CAPS_V", "CH_CAPS_V"],
    ["TOKEN_VALUE=TV_CAPS_V", "TV_CAPS_V"],
    ["CLIENT_SECRET_VALUE=CSV_CAPS_V", "CSV_CAPS_V"],
    ["X_USKEY=XUS_CAPS_V", "XUS_CAPS_V"],
    ["AUTHHeader=AH_CAPS_V", "AH_CAPS_V"],
  ];
  for (const [input, marker] of cases) {
    const out = keyToEolRedactor(input);
    assert.ok(!out.includes(marker), `keyToEolRedactor 应遮蔽 ${marker}：${JSON.stringify(input)} => ${out}`);
    assert.ok(!sanitizeFailureText(input).includes(marker), `sanitizeFailureText 应遮蔽 ${marker}：${JSON.stringify(input)}`);
  }
  // 负例不遮蔽
  for (const [input, marker] of [["monkey=TOK_50", "TOK_50"], ["oauth=TOK_51", "TOK_51"], ["ordinary_key=TOK_52", "TOK_52"], ["cookiePolicy=TOK_53", "TOK_53"], ["tokenizer=TOK_54", "TOK_54"]]) {
    assert.ok(keyToEolRedactor(input).includes(marker), `负例不得遮蔽 ${marker}：${JSON.stringify(input)}`);
  }
});

/* ─────────── C：标题路径门控（真实左边界 + 转义斜杠） ─────────── */
test("C. 标题：带前缀 UNC/POSIX/~/CJK/file:///盘符/空格分隔/转义路径遮蔽并吞 marker；中文斜杠标题逐字保留", () => {
  // 原始样本必须原样作为输入（带前缀），禁止用仅路径开头替代
  for (const [input, marker] of [
    ["视频 /用户/秘密_CHINESE_PATH.mp4", "CHINESE_PATH"],
    ["错误 file:///Users/secret/FILE_URL_SECRET.mp4", "FILE_URL_SECRET"],
    ["错误 C:\\Users\\secret\\WIN_SECRET.mp4", "WIN_SECRET"],
    ["下载失败 \\\\srv\\share\\TITLE_UNC.mp4", "TITLE_UNC"],
    ["视频 /srv/acme/TITLE_POSIX.mp4", "TITLE_POSIX"],
    ["视频 ~/acme/TITLE_HOME.mp4", "TITLE_HOME"],
    ["file_not_found: /Users/private/TITLE_SPACE.mp4", "TITLE_SPACE"],
    ["path = /srv/acme/TITLE_EQ_SPACE.mp4", "TITLE_EQ_SPACE"],
    ["file_not_found:\\/Users\\/private\\/TITLE_ESC.mp4", "TITLE_ESC"],
  ]) {
    const out = sanitizeReceiptTitle(input);
    assert.ok(!out.includes(marker), `标题应遮蔽 ${marker}：${JSON.stringify(input)} => ${out}`);
    assert.ok(!out.includes("/用户/秘密") && !out.includes("file:///Users") && !out.includes("C:\\Users"), `路径整段遮蔽：${JSON.stringify(input)} => ${out}`);
  }
  for (const t of ["厨房/卫生间改造", "厨房 / 卫生间", "厨房/home/卫生间改造"]) {
    assert.equal(sanitizeReceiptTitle(t), t, `标题逐字保留：${t}`);
  }
  assert.ok(!sanitizeFailureText("file_not_found:\\/Users\\/private\\/SF_ESC.mp4").includes("SF_ESC"), "sanitizeFailureText 净化转义绝对路径");
});

/* ─────────── D：recordReceipt 逐字段独立断言（每轮计数 +1） ─────────── */
test("D. recordReceipt：每轮 receipt/observation 计数恰好 +1、ID 新增；source_url/content_id/title/fallback_reason/outcome/evidence 逐字段 marker 独立消失", () => {
  const mdb = openKbDb(":memory:");
  const iso = new Date().toISOString();
  const count = (t) => mdb.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
  const maxId = (t) => mdb.prepare(`SELECT COALESCE(MAX(id),0) m FROM ${t}`).get().m;
  const runRound = (label, receipt, expectPerField) => {
    const recBefore = count("download_receipt");
    const obsBefore = count("ingest_observation");
    const recMaxBefore = maxId("download_receipt");
    const obsMaxBefore = maxId("ingest_observation");
    recordReceipt(mdb, receipt, { assetId: null, outcome: receipt.outcomeOverride || "ok" });
    // 计数恰好 +1
    assert.equal(count("download_receipt"), recBefore + 1, `${label}: receipt 计数 +1`);
    assert.equal(count("ingest_observation"), obsBefore + 1, `${label}: observation 计数 +1`);
    // 新行存在且 ID 新增
    assert.ok(maxId("download_receipt") > recMaxBefore, `${label}: receipt ID 新增`);
    assert.ok(maxId("ingest_observation") > obsMaxBefore, `${label}: observation ID 新增`);
    // SELECT 必须含 source_url/content_id/title/fallback_reason/outcome/evidence
    const row = mdb.prepare("SELECT source_url, content_id, title, fallback_reason, outcome, evidence FROM download_receipt ORDER BY id DESC LIMIT 1").get();
    const obsRow = mdb.prepare("SELECT message FROM ingest_observation ORDER BY id DESC LIMIT 1").get();
    const evidence = JSON.parse(row.evidence || "{}");
    // expectPerField: [[字段名, markers[]]...] —— 从实际落库字段取值逐 marker 独立断言
    for (const [field, markers] of expectPerField) {
      const text = String(row[field] ?? obsRow[field] ?? evidence[field] ?? "");
      for (const marker of markers) {
        assert.ok(!text.includes(marker), `${label}.${field} 不得泄漏 ${marker}（实际：${text}）`);
      }
    }
    return { row, obsRow, evidence };
  };
  try {
    // 轮1：sourceUrl x-uskey + contentId 带前缀 CJK 路径（不同 marker）
    runRound("round1", {
      channel: "d2sink", sourceUrl: "https://weixin.qq.com/sph/abc?x-uskey=SRC_USKEY_SEC", title: "t1",
      contentId: "视频 /用户/秘密_CONTENT_SEC.mp4", mediaValidation: "ok", startedAt: iso, completedAt: iso,
      fallbackReason: null, error: null, sizeBytes: null, sha256: null,
    }, [
      ["source_url", ["x-uskey", "SRC_USKEY_SEC"]],
      ["content_id", ["CONTENT_SEC", "/用户/秘密"]],
    ]);
    // 轮2：title 带前缀内嵌 file:// 路径 + fallbackReason token（不同 marker）
    runRound("round2", {
      channel: "d2sink", sourceUrl: null, title: "错误 file:///Users/secret/FILE_TITLE_SEC.mp4",
      contentId: "wechat_channels:sph:normal_id_2", mediaValidation: "ok", startedAt: iso, completedAt: iso,
      fallbackReason: 'token="FB_SEC"', error: null, sizeBytes: null, sha256: null,
    }, [
      ["title", ["FILE_TITLE_SEC", "file:///Users"]],
      ["fallback_reason", ["FB_SEC"]],
    ]);
    // 轮6：title 带前缀盘符 + contentId 带前缀 CJK 路径（不同 marker）
    runRound("round6", {
      channel: "d2sink", sourceUrl: null, title: "错误 C:\\Users\\secret\\WIN_TITLE_SEC.mp4",
      contentId: "错误 /srv/acme/CJK_CONTENT_SEC.mp4", mediaValidation: "ok", startedAt: iso, completedAt: iso,
      fallbackReason: null, error: null, sizeBytes: null, sha256: null,
    }, [
      ["title", ["WIN_TITLE_SEC", "C:\\Users"]],
      ["content_id", ["CJK_CONTENT_SEC", "/srv/acme"]],
    ]);
    // 轮3：error→observation + outcome（不同 marker）
    const { obsRow: obs3 } = runRound("round3", {
      channel: "d2sink", sourceUrl: null, title: "t3",
      contentId: "wechat_channels:sph:normal_id_3", mediaValidation: "ok", startedAt: iso, completedAt: iso,
      fallbackReason: null, error: 'token="ERR_SEC"', sizeBytes: null, sha256: null,
      outcomeOverride: 'failed:token="OUT_SEC"',
    }, [
      ["outcome", ["OUT_SEC"]],
    ]);
    assert.ok(!obs3.message.includes("ERR_SEC"), "observation.message 不得泄漏 ERR_SEC");
    assert.ok(!obs3.message.includes("OUT_SEC"), "observation.message 不得泄漏 OUT_SEC");
    // 轮4：evidence.note + evidence 敏感键对象整键剔除（每个值不同 marker，含全大写复合键）
    const { evidence: ev4 } = runRound("round4", {
      channel: "d2sink", sourceUrl: null, title: "t4",
      contentId: "wechat_channels:sph:normal_id_4", mediaValidation: "ok", startedAt: iso, completedAt: iso,
      fallbackReason: null, error: null, sizeBytes: null, sha256: null,
      validationEvidence: {
        note: 'token="EV_SEC"',
        auth: "AUTH_OBJ_SEC", uskey: "USKEY_OBJ_SEC", "x-uskey": "XUS_OBJ_SEC",
        authorizationHeader: "AH_OBJ_SEC", cookieHeader: "CH_OBJ_SEC",
        token_value: "TV_OBJ_SEC", client_secret_value: "CSV_OBJ_SEC",
        AUTH_HEADER: "AUTH_H_CAPS_SEC", COOKIE_HEADER: "CH_CAPS_SEC",
        TOKEN_VALUE: "TV_CAPS_SEC", CLIENT_SECRET_VALUE: "CSV_CAPS_SEC", X_USKEY: "XUS_CAPS_SEC",
      },
    }, [
      ["note", ["EV_SEC"]],
    ]);
    assert.ok(!String(ev4.note || "").includes("EV_SEC"), "evidence.note 不得泄漏 EV_SEC");
    for (const key of ["auth", "uskey", "x-uskey", "authorizationHeader", "cookieHeader", "token_value", "client_secret_value", "AUTH_HEADER", "COOKIE_HEADER", "TOKEN_VALUE", "CLIENT_SECRET_VALUE", "X_USKEY"]) {
      assert.equal(ev4[key], undefined, `evidence 敏感键 ${key} 整键剔除`);
    }
    for (const marker of ["AUTH_OBJ_SEC", "USKEY_OBJ_SEC", "XUS_OBJ_SEC", "AH_OBJ_SEC", "CH_OBJ_SEC", "TV_OBJ_SEC", "CSV_OBJ_SEC", "AUTH_H_CAPS_SEC", "CH_CAPS_SEC", "TV_CAPS_SEC", "CSV_CAPS_SEC", "XUS_CAPS_SEC"]) {
      assert.ok(!JSON.stringify(ev4).includes(marker), `evidence 不得含 ${marker}`);
    }
    // 轮5：旧 URL-first 变异杀灭 —— 每字段使用完整 http://x/video?token="TOK Q" <FIELD_TAIL_SENTINEL>，
    // 对反序列化后的实际字段直接断言秘密值 TOK Q、残余片段 " Q""、以及各自哨兵全部不存在
    const { row: row5, obsRow: obs5, evidence: ev5 } = runRound("round5", {
      channel: "d2sink", sourceUrl: null,
      title: 'http://x/video?token="TOK Q" TITLE_TAIL_SEC',
      contentId: "wechat_channels:sph:normal_id_5", mediaValidation: "ok", startedAt: iso, completedAt: iso,
      fallbackReason: 'http://x/video?token="TOK Q" FB_TAIL_SEC',
      error: 'http://x/video?token="TOK Q" ERR_TAIL_SEC',
      validationEvidence: { note: 'http://x/video?token="TOK Q" EV_TAIL_SEC' },
      outcomeOverride: 'failed:http://x/video?token="TOK Q" OUT_TAIL_SEC',
    }, [
      ["title", ["TOK Q", " Q\"", "TITLE_TAIL_SEC"]],
      ["outcome", ["TOK Q", " Q\"", "OUT_TAIL_SEC"]],
      ["fallback_reason", ["TOK Q", " Q\"", "FB_TAIL_SEC"]],
      ["note", ["TOK Q", " Q\"", "EV_TAIL_SEC"]],
      ["message", ["TOK Q", " Q\"", "ERR_TAIL_SEC", "OUT_TAIL_SEC"]],
    ]);
    assert.ok(!obs5.message.includes("TOK Q") && !obs5.message.includes(' Q"') && !obs5.message.includes("ERR_TAIL_SEC"), `observation.message 无 TOK Q/残余 Q"/哨兵：${obs5.message}`);
    assert.ok(!String(row5.title).includes("TOK Q") && !String(row5.title).includes(' Q"') && !String(row5.title).includes("TITLE_TAIL_SEC"), `title 无 TOK Q/残余 Q"/哨兵：${row5.title}`);
    assert.ok(!String(ev5.note || "").includes("TOK Q") && !String(ev5.note || "").includes("EV_TAIL_SEC"), `evidence.note 无秘密/哨兵：${ev5.note}`);
  } finally {
    mdb.close();
  }
});
