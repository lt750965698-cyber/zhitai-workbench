import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { openKbDb } from "../local-agent/kb.mjs";
import { buildOperationsReport } from "../local-agent/operations-metrics.mjs";
import { buildSyntheticOperationsReport } from "../local-agent/operations-synthetic.mjs";

async function contractValidator() {
  const schema = JSON.parse(await readFile(new URL("../docs/contracts/operations-metrics.schema.json", import.meta.url), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addSchema(schema);
  return { ajv, schema };
}

test("合成验收报告通过 Draft 2020-12 数据合同", async () => {
  const { ajv, schema } = await contractValidator();
  const validate = ajv.getSchema(schema.$id);
  const report = buildSyntheticOperationsReport();
  assert.equal(validate(report), true, ajv.errorsText(validate.errors, { separator: "\n" }));
});

test("空证据 observed 报告也通过合同，缺失 KPI 保持 not_collected 而非伪造 0%", async () => {
  const { ajv, schema } = await contractValidator();
  const validate = ajv.getSchema(schema.$id);
  const db = openKbDb(":memory:");
  try {
    const report = buildOperationsReport(db, {
      dataMode: "observed",
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-02T00:00:00.000Z",
      asOf: "2026-08-02T00:00:00.000Z",
    });
    assert.equal(report.metrics.public_rate.status, "not_collected");
    assert.equal(validate(report), true, ajv.errorsText(validate.errors, { separator: "\n" }));
  } finally {
    db.close();
  }
});

test("canonical publisherReceipt 和 creativeReviewEvent 样例通过合同", async () => {
  const { ajv, schema } = await contractValidator();
  const validateReceipt = ajv.getSchema(`${schema.$id}#/$defs/publisherReceipt`);
  const validateReview = ajv.getSchema(`${schema.$id}#/$defs/creativeReviewEvent`);
  const receipt = {
    receiptId: "receipt-a",
    revision: 2,
    publishTaskId: "task-a",
    materialId: "material-a",
    generatedVideoId: "video-a",
    platformPostId: "post-a",
    platform: "douyin",
    accountRef: "account-a",
    requestedMode: "publish",
    status: "public_confirmed",
    sourceEventAt: "2026-08-01T01:00:00.000Z",
    observedAt: "2026-08-01T01:10:00.000Z",
    externalPostId: "external-a",
    externalUrl: null,
    source: "fixture",
    isSynthetic: false,
  };
  const review = {
    reviewEventId: "review-event-a",
    reviewCycleId: "review-cycle-a",
    materialId: "material-a",
    generatedVideoId: "video-a",
    eventType: "decision",
    decision: "changes_requested",
    submittedAt: "2026-08-01T02:00:00.000Z",
    decisionAt: "2026-08-01T02:30:00.000Z",
    reasonCodes: ["hook_weak"],
    source: "fixture",
    isSynthetic: false,
  };
  assert.equal(validateReceipt(receipt), true, ajv.errorsText(validateReceipt.errors));
  assert.equal(validateReview(review), true, ajv.errorsText(validateReview.errors));
});
