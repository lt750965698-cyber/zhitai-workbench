import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PLATFORM_RECEIPT_FIELDS,
  PLATFORM_RECEIPT_FORMAT_VERSION,
  createPlatformReceipt,
  createPlatformReceipts,
  persistPlatformReceipts,
  redactPlatformReceiptText,
} from "../local-agent/platform-receipts.mjs";
import { PLATFORMS } from "../local-agent/matrixmedia-adapter.mjs";

const RECORDED_AT = "2026-08-27T08:00:00.000Z";
const here = dirname(fileURLToPath(import.meta.url));
const serverSource = readFileSync(resolve(here, "../local-agent/server.mjs"), "utf8");

test("逐平台回执只保留固定版本和白名单字段", () => {
  const receipts = createPlatformReceipts({
    operationId: "pub_operation_1",
    videoId: "asset_42",
    source: "matrixmedia_cli",
    mode: "publish",
    scheduledAt: "2026-08-28T01:02:03.000Z",
    platforms: [
      { platform: "dy", phone: "13800138000", cookie: "DEST_COOKIE" },
      { platform: "xhs", partition: "PRIVATE_PARTITION", qrData: "QR_DESTINATION" },
    ],
    results: [
      {
        platform: "dy",
        success: true,
        status: "success",
        message: "submitted",
        token: "RESULT_TOKEN",
        authorization: "Bearer RESULT_AUTH",
        headers: { cookie: "RESULT_COOKIE" },
      },
      {
        platform: "xhs",
        success: false,
        status: "failed",
        message: "upload_failed token=UPSTREAM_TOKEN",
        phone: "13900139000",
        qrCode: "RESULT_QR",
      },
    ],
  }, {
    recordedAt: RECORDED_AT,
    receiptIdFactory: (index) => `rcpt_test_${index}`,
  });

  assert.equal(receipts.length, 2);
  assert.deepEqual(Object.keys(receipts[0]), PLATFORM_RECEIPT_FIELDS);
  assert.deepEqual(Object.keys(receipts[1]), PLATFORM_RECEIPT_FIELDS);
  assert.equal(receipts[0].formatVersion, PLATFORM_RECEIPT_FORMAT_VERSION);
  assert.equal(receipts[0].platform, "dy");
  assert.equal(receipts[1].platform, "xhs");
  assert.equal(receipts[1].message, null, "任意上游自由文本不落盘");

  const serialized = JSON.stringify(receipts);
  for (const marker of [
    "13800138000",
    "13900139000",
    "DEST_COOKIE",
    "PRIVATE_PARTITION",
    "QR_DESTINATION",
    "RESULT_TOKEN",
    "RESULT_AUTH",
    "RESULT_COOKIE",
    "UPSTREAM_TOKEN",
    "RESULT_QR",
  ]) {
    assert.ok(!serialized.includes(marker), `回执不得包含敏感假值 ${marker}`);
  }
});

test("结果按平台而非下标配对，缺失结果记为 unknown", () => {
  const receipts = createPlatformReceipts({
    source: "matrixmedia_cli",
    mode: "draft",
    platforms: ["dy", "sph"],
    results: [
      { platform: "sph", success: false, status: "failed", message: "failed" },
      { platform: "dy", success: true, status: "draft", message: "saved" },
    ],
  }, {
    recordedAt: RECORDED_AT,
    receiptIdFactory: (index) => `rcpt_missing_${index}`,
  });

  assert.equal(receipts.length, 2);
  assert.equal(receipts[0].platform, "dy");
  assert.equal(receipts[0].success, true);
  assert.equal(receipts[1].platform, "sph");
  assert.equal(receipts[1].success, false);
  assert.equal(receipts[1].status, "failed");
  assert.equal(receipts[1].message, "failed");

  const missing = createPlatformReceipts({ platforms: ["dy"], results: [] }, {
    recordedAt: RECORDED_AT,
    receiptIdFactory: () => "rcpt_unknown",
  })[0];
  assert.equal(missing.success, null);
  assert.equal(missing.status, "unknown");
  assert.equal(missing.message, "platform_result_not_observed");
});

test("回执消息脱敏 token/cookie/authorization/手机号/二维码/URL/路径", () => {
  const cases = [
    ["failed token=TOKEN_MARKER trailing text", "TOKEN_MARKER"],
    ["failed cookie='COOKIE_MARKER; still secret'", "COOKIE_MARKER"],
    ["Authorization: Bearer AUTH_MARKER", "AUTH_MARKER"],
    ["upstream returned Bearer BEARER_MARKER", "BEARER_MARKER"],
    ["phone=13800138000", "13800138000"],
    ["call +8613900139000", "13900139000"],
    ["call 138-0013-8000", "138-0013-8000"],
    ["qrCode:data:image/png;base64,QR_BASE64_MARKER", "QR_BASE64_MARKER"],
    ["二维码：QR_TEXT_MARKER", "QR_TEXT_MARKER"],
    ["failed https://upload.example/callback?token=URL_TOKEN_MARKER", "URL_TOKEN_MARKER"],
    ["failed /Users/private/account/QR_PATH_MARKER.png", "QR_PATH_MARKER"],
    [`opaque ${"A".repeat(48)}`, "A".repeat(48)],
  ];

  for (const [input, marker] of cases) {
    const output = redactPlatformReceiptText(input);
    assert.ok(!output.includes(marker), `脱敏后不得包含 ${marker}: ${output}`);
    assert.ok(!/[\r\n\u2028\u2029]/.test(output), "回执消息恒为单行");
    assert.ok(output.length <= 500, "回执消息有长度上限");
  }
});

test("原子持久化每平台一个 JSON，二次白名单重建且不残留临时文件", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-platform-receipts-"));
  try {
    const receipts = [
      createPlatformReceipt({
        receiptId: "rcpt_atomic_0",
        operationId: "pub_atomic",
        source: "publisher_task",
        platform: "dy",
        mode: "platform_draft",
        status: "platform_draft",
        success: true,
        message: "accepted",
        recordedAt: RECORDED_AT,
      }),
      createPlatformReceipt({
        receiptId: "rcpt_atomic_1",
        operationId: "pub_atomic",
        source: "publisher_task",
        platform: "xhs",
        mode: "publish",
        status: "failed",
        success: false,
        message: "failed authorization=Bearer NEVER_WRITE_AUTH",
        recordedAt: RECORDED_AT,
      }),
    ];
    // Simulate a compromised caller adding arbitrary upstream fields after construction.
    receipts[0].token = "NEVER_WRITE_TOKEN";
    receipts[0].cookie = "NEVER_WRITE_COOKIE";
    receipts[0].qrData = "NEVER_WRITE_QR";
    receipts[0].phone = "13700137000";

    const paths = await persistPlatformReceipts(root, receipts);
    assert.equal(paths.length, 2);
    assert.deepEqual(paths.map((path) => basename(path)).sort(), ["rcpt_atomic_0.json", "rcpt_atomic_1.json"]);

    const names = (await readdir(root)).sort();
    assert.deepEqual(names, ["rcpt_atomic_0.json", "rcpt_atomic_1.json"]);
    assert.ok(names.every((name) => !name.endsWith(".tmp")), "原子 rename 后无临时文件");

    for (const path of paths) {
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw);
      assert.deepEqual(Object.keys(parsed), PLATFORM_RECEIPT_FIELDS);
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      for (const marker of [
        "NEVER_WRITE_TOKEN",
        "NEVER_WRITE_COOKIE",
        "NEVER_WRITE_QR",
        "NEVER_WRITE_AUTH",
        "13700137000",
      ]) {
        assert.ok(!raw.includes(marker), `磁盘回执不得包含 ${marker}`);
      }
    }
    await assert.rejects(
      persistPlatformReceipts(root, [receipts[0]]),
      (error) => error?.code === "EEXIST",
      "同 receiptId 不得覆盖不可变回执",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ID 与平台严格校验，路径、URL、手机号和伪平台不进入字段", () => {
  const receipt = createPlatformReceipt({
    operationId: "https://example.invalid/path?token=marker",
    taskId: "/Users/example/My Secret/task",
    videoId: "13800138000",
    source: "matrixmedia_cli",
    platform: "dy_13800138000",
    mode: "publish",
    status: "success",
    success: false,
    message: "/Users/example/My Secret/file.mp4",
  }, { recordedAt: RECORDED_AT, receiptId: "rcpt_strict" });
  assert.equal(receipt.operationId, null);
  assert.equal(receipt.taskId, null);
  assert.equal(receipt.videoId, null);
  assert.equal(receipt.platform, "unknown");
  assert.equal(receipt.status, "unknown", "矛盾的 success/status 降为 unknown");
  assert.equal(receipt.message, null);
  const raw = JSON.stringify(receipt);
  assert.ok(!raw.includes("13800138000"));
  assert.ok(!raw.includes("My Secret"));
  assert.ok(!raw.includes("example.invalid"));
});

test("MatrixMedia 声明的全部平台代码都能保留正确归属", () => {
  for (const entry of PLATFORMS) {
    const receipt = createPlatformReceipt({
      source: "matrixmedia_cli",
      platform: entry.code,
      mode: "draft",
      status: "draft",
      success: true,
    }, { recordedAt: RECORDED_AT, receiptId: `rcpt_platform_${entry.code}` });
    assert.equal(receipt.platform, entry.code);
  }
});

test("server 在调用发布器前持久化脱敏意图，并把未知结果留给人工核对", () => {
  assert.match(serverSource, /const platformReceiptsDir = join\(dataDir, "platform-receipts"\)/);
  assert.match(serverSource, /message: "publish_intent_recorded"/);
  assert.match(serverSource, /message: "publisher_outcome_not_observed"/);
  const executeStart = serverSource.indexOf("async function executeMatrixPublish");
  const intentWrite = serverSource.indexOf("const intentPersistence = await recordPlatformReceipts", executeStart);
  const publisherCall = serverSource.indexOf("await matrix.publishWithReceipts", executeStart);
  assert.ok(executeStart >= 0 && intentWrite > executeStart && publisherCall > intentWrite);
});
