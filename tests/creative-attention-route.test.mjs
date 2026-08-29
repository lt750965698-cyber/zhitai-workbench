import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const serverSource = await readFile(new URL("../local-agent/server.mjs", import.meta.url), "utf8");

test("creative attention API 持久化任务状态并保持旧响应字段", () => {
  const routeStart = serverSource.indexOf('if (action === "attention")');
  const routeEnd = serverSource.indexOf("let persistedOutput", routeStart);
  assert.ok(routeStart >= 0 && routeEnd > routeStart, "应存在 creative attention 路由");
  const route = serverSource.slice(routeStart, routeEnd);
  assert.match(route, /creativeQueue\.attention\(jobId/);
  assert.match(route, /json\?\.transient === true/);
  assert.match(route, /nextRetryAt/);
  assert.match(route, /15 \* 60_000/);
  assert.match(route, /transientExhausted/);
  assert.match(route, /transient \? "CREATIVE_TRANSIENT" : "CREATIVE_PREPARE"/);
  assert.match(route, /await notificationCenter\.send/);
  assert.doesNotMatch(route, /setTimeout/);
  assert.match(route, /const afterNotification = \(await creativeQueue\.list\(\)\)/);
  assert.match(route, /creative_attention_race_recovered/);
  assert.match(route, /GPT 原断点需要处理/);
  assert.match(route, /recorded:\s*true/);
  assert.match(route, /job,/);
});

test("creative jobs counts 将短等待算作活跃、真实错误算作需处理", () => {
  assert.match(serverSource, /active:[\s\S]{0,180}transient_wait/);
  assert.match(serverSource, /failed:[\s\S]{0,180}needs_attention/);
  assert.match(serverSource, /attention:[\s\S]{0,120}needs_attention/);
});
