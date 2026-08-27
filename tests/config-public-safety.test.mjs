import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const configUrl = new URL("../local-agent/config.example.json", import.meta.url);

test("公开示例配置默认不连接外部来源、不启动外置服务", async () => {
  const config = JSON.parse(await readFile(configUrl, "utf8"));
  assert.equal(config.host, "127.0.0.1");
  assert.ok(config.allowedOrigins.length > 0);
  for (const origin of config.allowedOrigins) {
    const host = new URL(origin).hostname;
    assert.ok(["127.0.0.1", "localhost", "::1"].includes(host), `非回环 origin：${origin}`);
  }
  for (const [id, adapter] of Object.entries(config.adapters)) {
    assert.equal(adapter.enabled, false, `${id} 应默认关闭`);
  }
  for (const [id, service] of Object.entries(config.services)) {
    assert.equal(service.autoStart, false, `${id} 不得默认自启`);
    assert.equal(service.onDemand, true, `${id} 应只按需启用`);
  }
  assert.deepEqual(config.watcher.roots, [], "公开默认不得扫描用户下载目录");
});
