import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testsDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(testsDir);
const agentEntry = join(repositoryRoot, "local-agent", "server.mjs");

const CANARIES = Object.freeze([
  "Bearer zhitai_api_fixture_credential_201",
  "session=zhitai_api_fixture_cookie_202",
  "13912345678",
  "仅供回归测试的私聊正文_203",
  "<article data-private=\"zhitai_api_html_204\">秘密</article>",
  "https://finder.video.qq.com/private.mp4?X-Amz-Signature=zhitai_api_signature_205&token=zhitai_api_token_206",
  "/Users/example/Private/zhitai_api_path_207/chat.txt",
  "C:\\Users\\example\\Private\\zhitai_api_path_208\\chat.txt",
  "zhitai_api_signature_205",
  "zhitai_api_token_206",
]);
const URL_BYPASS_VARIANTS = Object.freeze([
  `https://${encodeURIComponent(CANARIES[0])}@weixin.qq.com/sph/fixture-userinfo`,
  `https://weixin.qq.com/sph/fixture-credential?credential=${encodeURIComponent(CANARIES[0])}`,
  `https://weixin.qq.com/sph/fixture-nested?ref=${encodeURIComponent(`token=${CANARIES[8]}`)}`,
  `https://weixin.qq.com/sph/fixture-phone?phone=${CANARIES[2]}`,
  `https://weixin.qq.com/sph/fixture-path?next=${encodeURIComponent(CANARIES[6])}`,
  `https://weixin.qq.com/sph/fixture-html?preview=${encodeURIComponent(CANARIES[4])}`,
  `https://weixin.qq.com/sph/fixture-path-phone/${CANARIES[2]}`,
  "https://weixin.qq.com/sph/fixture-path-private/Users/example/Private/zhitai_api_path_207",
  `https://weixin.qq.com/sph/fixture-path-token/${encodeURIComponent(`token=${CANARIES[8]}`)}`,
  "https://weixin.qq.com/sph/fixture-extra/benign-extra-segment",
]);
const UNKNOWN_QUERY_CHANNEL = `https://weixin.qq.com/sph/fixture-query?foo=${encodeURIComponent(CANARIES[3])}`;

test("本地诊断 HTTP 通道在磁盘、日志、API 与导出中均不泄漏伪造敏感信息", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-diagnostics-http-"));
  const dataDir = join(root, "data");
  const knowledgeBase = join(root, "knowledge");
  const watcherRoot = join(root, "watcher-empty");
  const configPath = join(root, "config.json");
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(knowledgeBase, { recursive: true }),
    mkdir(watcherRoot, { recursive: true }),
  ]);
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const mediaFixture = await startMediaFixture();
  t.after(() => closeServer(mediaFixture.server));
  await writeFile(configPath, `${JSON.stringify({
    host: "127.0.0.1",
    port,
    knowledgeBase,
    allowedOrigins: ["http://localhost:3001"],
    webhookKeychainService: "com.zhitai.tests.diagnostics.no-secret",
    adapters: {},
    services: {},
    analysis: { yuanbaoChat: false },
    watcher: {
      intervalMs: 60_000,
      maxRetries: 1,
      roots: [{ dir: watcherRoot, channel: "fixture", recursive: false }],
    },
    diagnostics: {
      retention: { maxAgeMs: 60_000, maxFiles: 8, maxBytes: 32_768, maxEventBytes: 8_192 },
      debug: { enabled: false, expiresAt: null },
    },
  }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

  const output = [];
  const agent = spawn(process.execPath, [agentEntry], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ZHITAI_CONFIG_PATH: configPath,
      ZHITAI_DATA_DIR: dataDir,
      ZHITAI_PORT: String(port),
      ZHITAI_DISABLE_PUBLISHER_LOGIN_RECOVERY: "1",
      ZHITAI_MATRIX_PARTITIONS_DIR: join(root, "matrix-partitions"),
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  agent.stdout.on("data", (chunk) => output.push(chunk.toString()));
  agent.stderr.on("data", (chunk) => output.push(chunk.toString()));
  t.after(async () => {
    await terminate(agent);
    await rm(root, { recursive: true, force: true });
  });

  await waitFor(async () => {
    if (agent.exitCode !== null) throw new Error(`local agent exited: ${output.join("").slice(-500)}`);
    try { return (await fetch(`${baseUrl}/health`)).ok; }
    catch { return false; }
  });

  const legacyShapedPayload = {
    kind: "sync_response",
    source: "filehelper_bridge",
    outcome: "observed",
    transport: "fetch",
    contentType: "json",
    url: CANARIES[5],
    text: CANARIES.join(" | "),
    html: CANARIES[4],
    cookie: CANARIES[1],
    authorization: CANARIES[0],
    phone: CANARIES[2],
    localPath: CANARIES[6],
    nested: { path: CANARIES[7], chat: CANARIES[3] },
    metrics: { payloadBytes: 50_000, itemCount: 3, messageCount: 2, linkCount: 1 },
  };
  const diagnosticAck = await requestJson(baseUrl, "/api/v1/diag", {
    method: "POST",
    body: legacyShapedPayload,
  });
  assert.equal(diagnosticAck.response.status, 202);
  assert.equal(diagnosticAck.body.accepted, true);
  assert.deepEqual(Object.keys(diagnosticAck.body).sort(), ["accepted", "code", "debugActive", "ok", "schemaVersion"].sort());

  const signedIngest = await requestJson(baseUrl, "/api/v1/inbox", {
    method: "POST",
    body: { text: CANARIES[5], source: "filehelper_web" },
  });
  assert.equal(signedIngest.response.status, 400);
  assert.deepEqual(signedIngest.body, { error: "unsupported_or_missing_url" });
  const bypassAcks = [];
  for (const url of URL_BYPASS_VARIANTS) {
    const result = await requestJson(baseUrl, "/api/v1/inbox", {
      method: "POST",
      body: { text: url, source: "filehelper_web" },
    });
    assert.equal(result.response.status, 400);
    assert.deepEqual(result.body, { error: "unsupported_or_missing_url" });
    bypassAcks.push(result.body);
  }
  const unknownQueryAck = await requestJson(baseUrl, "/api/v1/inbox", {
    method: "POST",
    body: { text: UNKNOWN_QUERY_CHANNEL, source: "filehelper_web" },
  });
  assert.equal(unknownQueryAck.response.status, 202);
  assert.equal(unknownQueryAck.body.task.sourceUrl, "https://weixin.qq.com/sph/fixture-query");
  assert.equal(JSON.stringify(unknownQueryAck.body).includes(CANARIES[3]), false,
    "任意 query key 也必须在任务/API 边界前剥离");

  const heartbeatAck = await requestJson(baseUrl, "/api/v1/kuaidian/heartbeat", {
    method: "POST",
    body: {
      version: CANARIES[0],
      pageKind: CANARIES[6],
      originalKuaidianDetected: CANARIES[3],
      pendingReportCount: CANARIES[2],
      lastResult: CANARIES.join(" | "),
    },
  });
  assert.equal(heartbeatAck.response.status, 202);

  const cardAck = await requestJson(baseUrl, "/api/v1/channels/card", {
    method: "POST",
    body: {
      objectId: "1234567890123456",
      nonceId: "fixture_nonce_203",
      deliveryId: "fixture_delivery_203",
      title: CANARIES.join(" | "),
      source: "filehelper_web",
    },
  });
  assert.equal(cardAck.response.status, 202);

  const localTemporaryUrl = `${mediaFixture.url}/private.mp4?X-Amz-Signature=${CANARIES[8]}&token=${CANARIES[9]}`;
  const kuaidianAck = await requestJson(baseUrl, "/api/v1/kuaidian", {
    method: "POST",
    body: {
      downloadUrl: localTemporaryUrl,
      title: CANARIES.join(" | "),
      content: CANARIES[3],
      deliveryId: "fixture_delivery_kuaidian_209",
    },
  });
  assert.equal(kuaidianAck.response.status, 202);
  await waitFor(async () => {
    const jobs = await requestJson(baseUrl, "/api/v1/kuaidian/jobs");
    const item = jobs.body?.jobs?.find((job) => String(job.itemId) === String(kuaidianAck.body.itemId));
    return item && !["pending", "processing", "running"].includes(item.status);
  }, 15_000);

  const apiResults = await Promise.all([
    requestText(baseUrl, "/health"),
    requestText(baseUrl, "/api/v1/config"),
    requestText(baseUrl, "/api/v1/tasks"),
    requestText(baseUrl, "/api/v1/events"),
    requestText(baseUrl, "/api/v1/diagnostics"),
    requestText(baseUrl, "/api/v1/diagnostics/export"),
    requestText(baseUrl, "/api/v1/kb/export?format=json"),
    requestText(baseUrl, "/api/v1/kuaidian/status"),
  ]);
  for (const result of apiResults) assert.ok(result.response.ok, `API 应成功：${result.response.status}`);
  const health = JSON.parse(apiResults[0].text);
  assert.equal(health.knowledgeBase, "本机内容库", "健康 API 只返回固定标签，不返回配置中的任意路径片段");
  assert.ok(!apiResults[0].text.includes(root));
  assert.ok(!output.join("").includes(root), "启动日志不得包含配置中的私有绝对路径");
  const diagnosticsStatus = JSON.parse(apiResults[4].text);
  assert.equal(diagnosticsStatus.mode, "structured_only");
  assert.equal(diagnosticsStatus.debug.active, false);
  assert.equal(diagnosticsStatus.managedEvents.count, 1);
  const exportResponse = apiResults[5];
  assert.match(exportResponse.response.headers.get("content-disposition") || "", /zhitai-diagnostics\.json/);
  const exported = JSON.parse(exportResponse.text);
  assert.equal(exported.eventCount, 1);
  assert.deepEqual(Object.keys(exported.events[0]), [
    "schemaVersion", "recordedAt", "kind", "source", "outcome", "metrics", "signals", "debug",
  ]);
  const heartbeatStatus = JSON.parse(apiResults[7].text);
  assert.equal(heartbeatStatus.companion.version, null);
  assert.equal(heartbeatStatus.companion.pageKind, "unknown");
  assert.equal(heartbeatStatus.companion.pendingReportCount, 0);
  assert.equal(heartbeatStatus.companion.lastResult, "unknown");

  const diagnosticsDir = join(dataDir, "diag");
  if (process.platform !== "win32") {
    assert.equal((await stat(diagnosticsDir)).mode & 0o777, 0o700);
  }
  const diagnosticFiles = (await readdir(diagnosticsDir)).filter((name) => name.startsWith("zhitai-diag-v2-"));
  assert.equal(diagnosticFiles.length, 1);
  if (process.platform !== "win32") {
    assert.equal((await stat(join(diagnosticsDir, diagnosticFiles[0]))).mode & 0o777, 0o600);
  }

  const diskBuffers = await readTreeFiles(root);
  const apiAndLogs = [
    JSON.stringify(diagnosticAck.body),
    JSON.stringify(signedIngest.body),
    JSON.stringify(heartbeatAck.body),
    JSON.stringify(cardAck.body),
    JSON.stringify(kuaidianAck.body),
    JSON.stringify(unknownQueryAck.body),
    ...bypassAcks.map((body) => JSON.stringify(body)),
    ...apiResults.map((item) => item.text),
    output.join(""),
  ];
  assertNoSensitiveVariants(diskBuffers, "临时磁盘", [localTemporaryUrl]);
  assertNoSensitiveVariants(apiAndLogs, "日志/API/导出", [localTemporaryUrl]);
});

async function requestJson(baseUrl, path, { method = "GET", body } = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { response, body: text ? JSON.parse(text) : null };
}

async function requestText(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`);
  return { response, text: await response.text() };
}

function sensitiveVariants(extraMarkers = []) {
  const values = [];
  for (const marker of [...CANARIES, ...extraMarkers]) {
    values.push(marker, encodeURIComponent(marker), Buffer.from(marker, "utf8").toString("base64"));
  }
  return [...new Set(values.filter(Boolean))];
}

function assertNoSensitiveVariants(values, label, extraMarkers = []) {
  const buffers = values.map((value) => {
    const raw = value && typeof value === "object" && "content" in value ? value.content : value;
    return Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw), "utf8");
  });
  const markers = sensitiveVariants(extraMarkers);
  for (let markerIndex = 0; markerIndex < markers.length; markerIndex += 1) {
    const marker = markers[markerIndex];
    const needle = Buffer.from(marker, "utf8");
    const bufferIndex = buffers.findIndex((buffer) => buffer.includes(needle));
    const sourceLabel = bufferIndex >= 0 && values[bufferIndex]?.name ? values[bufferIndex].name : `buffer #${bufferIndex}`;
    assert.equal(bufferIndex, -1, `${label} 不得包含测试敏感标记 #${markerIndex} (${sourceLabel})`);
  }
}

async function readTreeFiles(root) {
  const buffers = [];
  const walk = async (directory, allowMissing = false) => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (allowMissing && error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(path, true);
      } else if (entry.isFile()) {
        try {
          buffers.push({ name: entry.name, content: await readFile(path) });
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
      }
    }
  };
  await walk(root);
  return buffers;
}

async function reservePort() {
  const listener = createTcpServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const address = listener.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startMediaFixture() {
  const server = createHttpServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "video/mp4" });
    response.end(Buffer.from("not-a-real-video-fixture", "utf8"));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return { server, url: `http://127.0.0.1:${port}` };
}

async function closeServer(server) {
  if (!server?.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("timeout_waiting_for_local_agent");
}

async function terminate(child) {
  if (!child || child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
