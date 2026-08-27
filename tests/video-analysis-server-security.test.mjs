import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = await readFile(
  fileURLToPath(new URL("../scripts/video-analysis-server.mjs", import.meta.url)),
  "utf8",
);

test("视频分析代理只向精确回环 Origin 开放 CORS", () => {
  assert.match(source, /function allowedLoopbackOrigin/);
  assert.match(source, /origin_not_allowed/);
  assert.doesNotMatch(source, /"Access-Control-Allow-Origin": "\*"/);
});

test("视频分析代理不向响应暴露内部异常或安装路径", () => {
  assert.doesNotMatch(source, /analyzerPath:\s*ANALYZER_CLI/);
  assert.doesNotMatch(source, /error:\s*(?:cause|e) instanceof Error \? (?:cause|e)\.message/);
  assert.doesNotMatch(source, /error:\s*(?:cause|e)\.message/);
  for (const stableCode of [
    "analysis_failed",
    "external_analysis_failed",
    "remake_submission_failed",
    "remake_status_failed",
  ]) assert.ok(source.includes(stableCode));
});
