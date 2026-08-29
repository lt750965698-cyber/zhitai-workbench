import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { createServer, request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { syntheticMp4Buffer } from "./fixtures/synthetic-mp4.mjs";

const testsDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(testsDir);
const agentEntry = join(repositoryRoot, "local-agent", "server.mjs");
const inboxClientEntry = join(repositoryRoot, "local-agent", "inbox-submit.mjs");
const ingestFixture = join(testsDir, "fixtures", "command-ingest-adapter.mjs");
const serviceFixture = join(testsDir, "fixtures", "managed-service.mjs");
const fixtureBytes = syntheticMp4Buffer({ mdatBeforeMoov: true, marker: "local-agent-integration" });
const webhookSecret = "fixture-webhook-secret";

test("local agent integrates content packages, approval gates, and exclusive services", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "zhitai-local-agent-test-"));
  const dataDir = join(sandbox, "data");
  const knowledgeBase = join(sandbox, "knowledge-base");
  const watcherRoot = join(sandbox, "watch");
  const temporaryHome = join(sandbox, "home");
  const temporaryAppData = join(temporaryHome, "AppData", "Roaming");
  const temporaryLocalAppData = join(temporaryHome, "AppData", "Local");
  const publicKnowledgeBase = `…/${basename(knowledgeBase)}`;
  const sourceAsset = join(sandbox, "source-video.mp4");
  const publishAsset = join(knowledgeBase, "publish-video.mp4");
  const firstServicePidFile = join(sandbox, "service-one.pid");
  const secondServicePidFile = join(sandbox, "service-two.pid");
  const setupMarkerFile = join(sandbox, "setup-opened.txt");
  const configPath = join(sandbox, "config.json");
  const port = await reservePort();
  const channelsPort = await reservePort();
  const wrongChannelsPort = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let channelsPageAvailable = false;
  const channelsServer = createServer((request, response) => {
    if (request.url === "/media.mp4") {
      response.writeHead(200, {
        "Content-Type": "video/mp4",
        "Content-Length": String(fixtureBytes.length),
      });
      response.end(fixtureBytes);
      return;
    }
    if (request.url?.startsWith("/api/channels/feed/profile?")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        code: 0,
        data: {
          data: {
            object: {
              contact: { nickname: "自定义端口作者" },
              objectDesc: {
                description: "自定义端口卡片",
                media: [{ mediaType: 4, url: `http://127.0.0.1:${channelsPort}/media.mp4` }],
              },
            },
          },
        },
      }));
      return;
    }
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ code: 0, data: { available: channelsPageAvailable } }));
  });
  await new Promise((resolvePromise) => channelsServer.listen(channelsPort, "127.0.0.1", resolvePromise));
  const serverOutput = [];
  const knownServicePids = new Set();
  let agent;

  await Promise.all([
    mkdir(watcherRoot, { recursive: true }),
    mkdir(temporaryAppData, { recursive: true }),
    mkdir(temporaryLocalAppData, { recursive: true }),
  ]);
  await writeFile(sourceAsset, fixtureBytes);
  await writeFile(publishAsset, Buffer.from("publish fixture\n", "utf8"), { flag: "w" }).catch(async (error) => {
    if (error?.code !== "ENOENT") throw error;
    const { mkdir } = await import("node:fs/promises");
    await mkdir(knowledgeBase, { recursive: true });
    await writeFile(publishAsset, Buffer.from("publish fixture\n", "utf8"));
  });
  await writeFile(configPath, `${JSON.stringify({
    host: "127.0.0.1",
    port,
    knowledgeBase,
    allowedOrigins: ["http://localhost:3000"],
    polling: { intervalMs: 250, timeoutMs: 5_000 },
    watcher: { intervalMs: 5_000, maxRetries: 3, roots: [{ dir: watcherRoot, channel: "kuaidian", recursive: true }] },
    analysis: { yuanbaoChat: false },
    adapters: {
      douyin: {
        enabled: true,
        type: "command",
        command: process.execPath,
        args: [
          ingestFixture,
          "--sourceUrl",
          "{url}",
          "--resultFile",
          "{resultFile}",
          "--assetPath",
          sourceAsset,
        ],
        importMode: "copy",
      },
      wechat: {
        enabled: true,
        type: "wechat-mp-tools",
        importMode: "copy",
      },
      publisher: { enabled: false },
    },
    services: {
      xianyu_auto_agent: {
        label: "Fixture customer service one",
        role: "xianyu_support",
        mutualExclusionGroup: "fixture-chat-owner",
        installChecks: [serviceFixture],
        start: {
          command: process.execPath,
          args: [serviceFixture, firstServicePidFile],
        },
      },
      xianyu_auto_reply_fix: {
        label: "Fixture customer service two",
        role: "xianyu_accounts",
        mutualExclusionGroup: "fixture-chat-owner",
        installChecks: [serviceFixture],
        start: {
          command: process.execPath,
          args: [serviceFixture, secondServicePidFile],
        },
      },
      openclaw_weixin: {
        label: "Fixture inbox setup",
        role: "inbox",
        installChecks: [process.execPath],
        setup: {
          command: process.execPath,
          args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(setupMarkerFile)}, "opened")`],
        },
      },
      bad_executable: {
        label: "Fixture non executable",
        installChecks: [join(repositoryRoot, "README.md")],
        start: { command: join(repositoryRoot, "README.md"), args: [] },
      },
      wx_channels_card: {
        label: "Fixture WeChat Channels parser",
        role: "ingest",
        onDemand: true,
        healthUrl: `http://127.0.0.1:${channelsPort}/api/channels/status`,
        installChecks: [process.execPath],
      },
    },
  }, null, 2)}\n`, "utf8");

  t.after(async () => {
    await terminateProcess(agent);
    await new Promise((resolvePromise) => channelsServer.close(resolvePromise));
    for (const pid of knownServicePids) {
      if (processIsAlive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // The fixture exited between the liveness check and cleanup.
        }
      }
    }
    await rm(sandbox, { recursive: true, force: true });
  });

  agent = spawn(process.execPath, [agentEntry], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HOME: temporaryHome,
      USERPROFILE: temporaryHome,
      APPDATA: temporaryAppData,
      LOCALAPPDATA: temporaryLocalAppData,
      ZHITAI_CONFIG_PATH: configPath,
      ZHITAI_DATA_DIR: dataDir,
      ZHITAI_PORT: String(port),
      ZHITAI_WEBHOOK_SECRET: webhookSecret,
      ZHITAI_DISABLE_CHANNELS_PAGE_LAUNCH: "1",
      ZHITAI_DISABLE_PUBLISHER_LOGIN_RECOVERY: "1",
      ZHITAI_MATRIX_PARTITIONS_DIR: join(dataDir, "matrix-partitions"),
      ZHITAI_CHANNELS_CARD_URL: `http://127.0.0.1:${wrongChannelsPort}`,
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });

  agent.stdout.on("data", (chunk) => serverOutput.push(chunk.toString()));
  agent.stderr.on("data", (chunk) => serverOutput.push(chunk.toString()));

  await waitFor(async () => {
    if (agent.exitCode !== null) {
      throw new Error(`local agent exited before becoming ready\n${serverOutput.join("")}`);
    }
    try {
      return (await requestJson(baseUrl, "/health")).response.status === 200;
    } catch {
      return false;
    }
  }, { description: "local agent readiness" });

  await t.test("health, tasks, and library expose isolated runtime state", async () => {
    const health = await requestJson(baseUrl, "/health");
    assert.equal(health.response.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.version, 2);
    assert.equal(health.body.queue, 0);
    assert.equal(health.body.knowledgeBase, publicKnowledgeBase);
    assert.equal(health.body.inboxMode, "signature_required");
    assert.equal(health.body.adapters.douyin.configured, true);
    assert.equal(health.body.services.xianyu_auto_agent.status, "stopped");
    assert.equal(health.body.services.xianyu_auto_agent.install.state, "ready");

    const publicConfig = await requestJson(baseUrl, "/api/v1/config");
    assert.equal(publicConfig.response.status, 200);
    assert.equal(publicConfig.body.knowledgeBase, publicKnowledgeBase);

    const readyEvent = await waitFor(async () => {
      const events = await requestJson(baseUrl, "/api/v1/events");
      return events.body.events.find((event) => event.type === "READY") || null;
    }, { description: "redacted READY event" });
    assert.match(readyEvent.message, new RegExp(`${publicKnowledgeBase}$`));
    assert.equal(readyEvent.message.includes(knowledgeBase), false);
    assert.match(serverOutput.join(""), new RegExp(`知识库目录：${publicKnowledgeBase}`));
    assert.equal(serverOutput.join("").includes(knowledgeBase), false);

    const tasks = await requestJson(baseUrl, "/api/v1/tasks");
    assert.equal(tasks.response.status, 200);
    assert.deepEqual(tasks.body, { tasks: [] });

    const library = await requestJson(baseUrl, "/api/v1/library");
    assert.equal(
      library.response.status,
      200,
      `library 查询失败：${JSON.stringify(library.body)}\n${serverOutput.join("").slice(-2000)}`,
    );
    // library 已统一到 kb.sqlite 数据源（与 /api/v1/kb 共享，不再双孤岛）
    assert.deepEqual(library.body, { items: [], source: "kb_unified" });
  });

  await t.test("视频号解析服务区分端口存活与页面业务就绪", async () => {
    const disconnected = await requestJson(baseUrl, "/api/v1/services");
    const before = disconnected.body.services.wx_channels_card;
    assert.equal(before.running, true, "HTTP 端点可达时进程仍应标记运行");
    assert.equal(before.healthy, false, "available:false 不得被 HTTP 200 或 onDemand 掩盖");
    assert.equal(before.status, "degraded");
    assert.equal(before.business.state, "page_disconnected");

    channelsPageAvailable = true;
    const connected = await requestJson(baseUrl, "/api/v1/services");
    const after = connected.body.services.wx_channels_card;
    assert.equal(after.running, true);
    assert.equal(after.healthy, true);
    assert.equal(after.status, "healthy");
    assert.equal(after.business.ready, true);
  });

  await t.test("视频号可用性探针与卡片解析共用配置的自定义引擎端口", async () => {
    const cardBody = {
      objectId: "14950209185632029317",
      nonceId: "custom_port_nonce_1",
      title: "这个浏览器标题必须被忽略",
      source: "fixture",
    };
    const created = await requestJson(baseUrl, "/api/v1/channels/card", {
      method: "POST",
      body: cardBody,
      headers: signedHeaders(cardBody, "fixture-channels-card-custom-port"),
    });
    assert.equal(created.response.status, 202);
    const completed = await waitFor(async () => {
      const tasks = await requestJson(baseUrl, "/api/v1/tasks");
      const task = tasks.body.tasks.find((item) => item.id === created.body.task.id);
      if (task?.status === "failed") throw new Error(`card ingest failed with ${task.errorCode}`);
      return task?.status === "completed" ? task : false;
    }, { description: "custom-port card ingest" });
    assert.equal(completed.title, "自定义端口卡片");
    assert.equal(completed.platform, "视频号");
    assert.equal(completed.sizeBytes >= fixtureBytes.length, true);
  });

  await t.test("signed inbox accepts one request and rejects replay or tampering", async () => {
    const unsigned = await requestJson(baseUrl, "/api/v1/inbox", {
      method: "POST",
      body: { text: "https://www.douyin.com/video/unsigned-fixture", source: "openclaw" },
    });
    assert.equal(unsigned.response.status, 401);
    assert.deepEqual(unsigned.body, { error: "invalid_webhook_headers" });

    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = "fixture_nonce_123456789";
    const body = { text: "https://www.douyin.com/video/webhook-fixture", source: "openclaw" };
    const raw = JSON.stringify(body);
    const signature = `v1=${createHmac("sha256", webhookSecret).update(`${timestamp}.${nonce}.${raw}`).digest("hex")}`;
    const headers = {
      "X-Zhitai-Timestamp": timestamp,
      "X-Zhitai-Nonce": nonce,
      "X-Zhitai-Signature": signature,
    };

    const wrongOrigin = await requestJson(baseUrl, "/api/v1/inbox", {
      method: "POST",
      headers: { ...headers, Origin: "https://attacker.example" },
      body,
    });
    assert.equal(wrongOrigin.response.status, 403);
    assert.deepEqual(wrongOrigin.body, { error: "origin_not_allowed" });

    const accepted = await requestJson(baseUrl, "/api/v1/inbox", { method: "POST", headers, body });
    assert.equal(accepted.response.status, 202);
    assert.equal(accepted.body.task.source, "openclaw");

    const replay = await requestJson(baseUrl, "/api/v1/inbox", { method: "POST", headers, body });
    assert.equal(replay.response.status, 409);
    assert.deepEqual(replay.body, { error: "webhook_replay_detected" });

    const tampered = await requestJson(baseUrl, "/api/v1/inbox", {
      method: "POST",
      headers: { ...headers, "X-Zhitai-Nonce": "fixture_nonce_987654321" },
      body,
    });
    assert.equal(tampered.response.status, 401);
    assert.deepEqual(tampered.body, { error: "invalid_signature" });

    const concurrentTimestamp = String(Math.floor(Date.now() / 1000));
    const concurrentNonce = "fixture_concurrent_nonce_123456";
    const concurrentBody = { text: "https://www.douyin.com/video/concurrent-fixture", source: "openclaw" };
    const concurrentRaw = JSON.stringify(concurrentBody);
    const concurrentHeaders = {
      "X-Zhitai-Timestamp": concurrentTimestamp,
      "X-Zhitai-Nonce": concurrentNonce,
      "X-Zhitai-Signature": `v1=${createHmac("sha256", webhookSecret).update(`${concurrentTimestamp}.${concurrentNonce}.${concurrentRaw}`).digest("hex")}`,
    };
    const concurrent = await Promise.all(Array.from({ length: 20 }, () => requestJson(baseUrl, "/api/v1/inbox", {
      method: "POST",
      headers: concurrentHeaders,
      body: concurrentBody,
    })));
    assert.equal(concurrent.filter((result) => result.response.status === 202).length, 1);
    assert.equal(concurrent.filter((result) => result.response.status === 409).length, 19);

    const unicodeTimestamp = String(Math.floor(Date.now() / 1000));
    const unicodeNonce = "fixture_unicode_nonce_123456789";
    const unicodeRaw = JSON.stringify({ text: "中文消息 https://www.douyin.com/video/unicode-fixture", source: "微信" });
    const unicodeBytes = Buffer.from(unicodeRaw, "utf8");
    const chineseOffset = unicodeBytes.indexOf(Buffer.from("中", "utf8"));
    const unicodeHeaders = {
      "Content-Type": "application/json",
      "X-Zhitai-Timestamp": unicodeTimestamp,
      "X-Zhitai-Nonce": unicodeNonce,
      "X-Zhitai-Signature": `v1=${createHmac("sha256", webhookSecret).update(`${unicodeTimestamp}.${unicodeNonce}.${unicodeRaw}`).digest("hex")}`,
    };
    const unicodeResponse = await requestRawChunks(baseUrl, "/api/v1/inbox", [
      unicodeBytes.subarray(0, chineseOffset + 1),
      unicodeBytes.subarray(chineseOffset + 1),
    ], unicodeHeaders);
    assert.equal(unicodeResponse.status, 202);
  });

  await t.test("inbox client signs a ClawBot message without exposing the secret", async () => {
    const output = await runCommand(process.execPath, [
      inboxClientEntry,
      "--endpoint",
      `${baseUrl}/api/v1/inbox`,
      "--source",
      "openclaw_weixin",
      "--text",
      "https://www.douyin.com/video/inbox-client-fixture",
    ], {
      ...process.env,
      ZHITAI_WEBHOOK_SECRET: webhookSecret,
    });
    const result = JSON.parse(output.stdout);
    assert.equal(result.ok, true);
    assert.equal(result.platform, "抖音");
    assert.match(result.taskId, /^ing_/);
    assert.equal(output.stdout.includes(webhookSecret), false);
    assert.equal(output.stderr.includes(webhookSecret), false);

    const stdinMessage = "中文输入 https://www.douyin.com/video/inbox-client-unicode";
    const stdinBytes = Buffer.from(stdinMessage, "utf8");
    const splitOffset = stdinBytes.indexOf(Buffer.from("中", "utf8")) + 1;
    const stdinOutput = await runCommand(process.execPath, [
      inboxClientEntry,
      "--endpoint",
      `${baseUrl}/api/v1/inbox`,
      "--source",
      "openclaw_weixin",
    ], { ...process.env, ZHITAI_WEBHOOK_SECRET: webhookSecret }, [
      stdinBytes.subarray(0, splitOffset),
      stdinBytes.subarray(splitOffset),
    ]);
    assert.equal(JSON.parse(stdinOutput.stdout).ok, true);
  });

  await t.test("signed ClawBot outbound receipts update transport health without message content", async () => {
    const report = async (value, nonce) => {
      const body = {
        text: JSON.stringify(value),
        source: "openclaw_weixin_outbound_result",
      };
      const raw = JSON.stringify(body);
      const timestamp = String(Math.floor(Date.now() / 1000));
      return requestJson(baseUrl, "/api/v1/notifications/clawbot/outbound-result", {
        method: "POST",
        headers: {
          "X-Zhitai-Timestamp": timestamp,
          "X-Zhitai-Nonce": nonce,
          "X-Zhitai-Signature": `v1=${createHmac("sha256", webhookSecret).update(`${timestamp}.${nonce}.${raw}`).digest("hex")}`,
        },
        body,
      });
    };

    const failed = await report({ success: false, errorCode: "session_refresh_required" }, "clawbot_receipt_failure_123456");
    assert.equal(failed.response.status, 200);
    assert.deepEqual(failed.body, { ok: true, deliveryState: "session_refresh_required" });

    const recovered = await report({ success: true, errorCode: null }, "clawbot_receipt_success_123456");
    assert.equal(recovered.response.status, 200);
    assert.deepEqual(recovered.body, { ok: true, deliveryState: "ready" });

    const rejected = await report({ success: true, errorCode: null, content: "must not be accepted" }, "clawbot_receipt_extra_12345678");
    assert.equal(rejected.response.status, 400);
    assert.deepEqual(rejected.body, { error: "invalid_clawbot_outbound_result" });
  });

  await t.test("inbox client refuses redirects instead of forwarding signed content", async (subtest) => {
    let redirectedRequestReceived = false;
    const redirectServer = createServer((request, response) => {
      if (request.url === "/start") {
        response.writeHead(307, { Location: "/capture" });
        response.end();
        return;
      }
      redirectedRequestReceived = true;
      response.writeHead(202, { "Content-Type": "application/json" });
      response.end('{"task":{"id":"unexpected"}}');
    });
    await new Promise((resolvePromise, rejectPromise) => {
      redirectServer.once("error", rejectPromise);
      redirectServer.listen(0, "127.0.0.1", resolvePromise);
    });
    subtest.after(() => new Promise((resolvePromise) => redirectServer.close(resolvePromise)));
    const address = redirectServer.address();
    const redirectPort = typeof address === "object" && address ? address.port : 0;
    await assert.rejects(runCommand(process.execPath, [
      inboxClientEntry,
      "--endpoint",
      `http://127.0.0.1:${redirectPort}/start`,
      "--text",
      "https://www.douyin.com/video/redirect-fixture",
    ], { ...process.env, ZHITAI_WEBHOOK_SECRET: webhookSecret }), /local_agent_unreachable/);
    assert.equal(redirectedRequestReceived, false);
  });

  let completedTask;
  let ingestedAsset;
  await t.test("command ingest creates a standard package with a verified SHA-256", async () => {
    const sourceUrl = "https://www.douyin.com/video/fixture-123";
    const created = await requestJson(baseUrl, "/api/v1/ingest", {
      method: "POST",
      body: { url: sourceUrl },
    });
    assert.equal(created.response.status, 202);
    assert.equal(created.body.task.status, "queued");
    assert.equal(created.body.task.adapter, "douyin");

    completedTask = await waitFor(async () => {
      const { body } = await requestJson(baseUrl, "/api/v1/tasks");
      const task = body.tasks.find((candidate) => candidate.id === created.body.task.id);
      if (task?.status === "failed") {
        throw new Error(`ingest failed with ${task.errorCode}`);
      }
      return task?.status === "completed" ? task : false;
    }, { description: "command ingest completion" });

    const expectedSha = createHash("sha256").update(fixtureBytes).digest("hex");
    const metadataPath = join(completedTask.packagePath, "metadata.json");
    const sourcePath = join(completedTask.packagePath, "source.url");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));

    assert.equal((await readFile(sourcePath, "utf8")).trim(), sourceUrl);
    assert.equal(metadata.schemaVersion, 1);
    assert.equal(metadata.id, completedTask.id);
    assert.equal(metadata.title, "集成测试内容包");
    assert.equal(metadata.platform, "抖音");
    assert.equal(metadata.authorization, "user_asserted");
    assert.equal(metadata.sizeBytes, fixtureBytes.length);
    assert.equal(metadata.files.length, 1);
    assert.equal(metadata.files[0].sha256, expectedSha);
    assert.match(metadata.files[0].path, /^assets\/01-source-video\.mp4$/);
    assert.equal((await stat(join(completedTask.packagePath, metadata.files[0].path))).size, fixtureBytes.length);

    const library = await requestJson(baseUrl, "/api/v1/library");
    assert.equal(
      library.response.status,
      200,
      `入库后 library 查询失败：${JSON.stringify(library.body)}\n${serverOutput.join("").slice(-2000)}`,
    );
    // library 已统一到 kb.sqlite；同内容(sha256)的多个旧包共享一个资产（去重），
    // 帖子/指标不丢；用 sha256 匹配（三层幂等本质键）
    const libraryItem = library.body.items.find((item) => item.sha256 === expectedSha);
    assert.ok(libraryItem, `library 应含 sha256=${expectedSha.slice(0, 8)} 的资产，实际 items=${library.body.items.length}`);
    ingestedAsset = libraryItem;
  });

  await t.test("正式发布在生成就绪或低画质门禁失败时不会调用发布引擎", async () => {
    assert.ok(ingestedAsset?.id);
    const before = await requestJson(baseUrl, "/api/v1/tasks");
    const response = await requestJson(baseUrl, "/api/v1/publish", {
      method: "POST",
      headers: { "X-Zhitai-Action": "confirm" },
      body: {
        videoId: ingestedAsset.id,
        title: "quality gate fixture",
        draft: false,
        allowQualityReview: false,
        destinations: [{ platform: "dy", phone: "fixture-account" }],
      },
      timeoutMs: 10_000,
    });
    assert.equal(response.response.status, 409);
    assert.match(String(response.body.error), /^(?:publish_generation_readiness_(?:missing|failed)|publish_quality_review_required)/);
    const after = await requestJson(baseUrl, "/api/v1/tasks");
    assert.deepEqual(after.body, before.body, "门禁失败不得创建发布任务");
  });

  await t.test("formal publish without explicit approval returns 409 and creates no task", async () => {
    const before = await requestJson(baseUrl, "/api/v1/tasks");
    const response = await requestJson(baseUrl, "/api/v1/publish", {
      method: "POST",
      headers: { "X-Zhitai-Action": "confirm" },
      body: {
        assetPath: publishAsset,
        title: "must not publish",
        targets: ["douyin"],
        mode: "publish",
      },
    });

    assert.equal(response.response.status, 409);
    assert.deepEqual(response.body, { error: "publish_approval_required" });
    const after = await requestJson(baseUrl, "/api/v1/tasks");
    assert.equal(after.body.tasks.length, before.body.tasks.length);
    assert.equal(after.body.tasks.some((task) => task.type === "publish"), false);
  });

  await t.test("fixed service setup command requires confirmation and runs without managing a daemon", async () => {
    const rejected = await requestJson(baseUrl, "/api/v1/services/openclaw_weixin/setup", {
      method: "POST",
      body: { approved: true },
    });
    assert.equal(rejected.response.status, 409);
    assert.deepEqual(rejected.body, { error: "confirmation_required" });

    const opened = await requestJson(baseUrl, "/api/v1/services/openclaw_weixin/setup", {
      method: "POST",
      headers: { "X-Zhitai-Action": "confirm" },
      body: { approved: true },
    });
    assert.equal(opened.response.status, 200);
    assert.equal(opened.body.setupLaunched, true);
    assert.equal(opened.body.service.setupAvailable, true);
    assert.equal(opened.body.service.running, false);
    assert.equal(opened.body.service.status, "needs_setup");
    assert.equal(await readFile(setupMarkerFile, "utf8"), "opened");
  });

  await t.test("non-executable service commands are invalid and cannot be started", async () => {
    const services = await requestJson(baseUrl, "/api/v1/services");
    assert.equal(services.body.services.bad_executable.install.state, "invalid");
    assert.equal(services.body.services.bad_executable.installed, false);
    const started = await requestJson(baseUrl, "/api/v1/services/bad_executable/start", {
      method: "POST",
      headers: { "X-Zhitai-Action": "confirm" },
      body: { approved: true },
    });
    assert.equal(started.response.status, 409);
    assert.deepEqual(started.body, { error: "service_install_not_ready" });
  });

  await t.test("mutually exclusive services reject the second start and stop the managed child", async () => {
    const first = await requestJson(baseUrl, "/api/v1/services/xianyu_auto_agent/start", {
      method: "POST",
      headers: { "X-Zhitai-Action": "confirm" },
    });
    assert.equal(first.response.status, 200);
    assert.equal(first.body.service.running, true);
    assert.equal(first.body.service.managed, true);

    const firstPid = Number((await waitFor(
      () => readFile(firstServicePidFile, "utf8").catch(() => ""),
      { description: "first service pid file" },
    )).trim());
    assert.equal(Number.isInteger(firstPid), true);
    assert.equal(processIsAlive(firstPid), true);
    knownServicePids.add(firstPid);

    const second = await requestJson(baseUrl, "/api/v1/services/xianyu_auto_reply_fix/start", {
      method: "POST",
      headers: { "X-Zhitai-Action": "confirm" },
    });
    assert.equal(second.response.status, 409);
    assert.deepEqual(second.body, { error: "mutual_exclusion_conflict_xianyu_auto_agent" });
    await assert.rejects(readFile(secondServicePidFile, "utf8"), { code: "ENOENT" });

    const stopped = await requestJson(baseUrl, "/api/v1/services/xianyu_auto_agent/stop", {
      method: "POST",
      headers: { "X-Zhitai-Action": "confirm" },
    });
    assert.equal(stopped.response.status, 200);
    assert.equal(stopped.body.service.running, false);
    await waitFor(() => !processIsAlive(firstPid), { description: "managed service exit" });
    await assert.rejects(readFile(firstServicePidFile, "utf8"), { code: "ENOENT" });
    knownServicePids.delete(firstPid);
  });
});

async function requestJson(baseUrl, path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method || "GET",
    headers: {
      // 服务启停等受控操作要求 Origin ∈ allowedOrigins（测试配置为 http://localhost:3000）；
      // confirm 头仅当显式传 options.action 时携带（测试需验证 409 缺确认场景）
      ...(options.method === "POST" ? { Origin: "http://localhost:3000" } : {}),
      ...(options.action ? { "X-Zhitai-Action": options.action } : {}),
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(Number(options.timeoutMs) || 2_000),
  });
  const body = await response.json();
  return { response, body };
}

function signedHeaders(body, nonce) {
  const timestamp = String(Date.now());
  const raw = JSON.stringify(body);
  return {
    "X-Zhitai-Timestamp": timestamp,
    "X-Zhitai-Nonce": nonce,
    "X-Zhitai-Signature": `v1=${createHmac("sha256", webhookSecret).update(`${timestamp}.${nonce}.${raw}`).digest("hex")}`,
  };
}

async function requestRawChunks(baseUrl, path, chunks, headers) {
  const target = new URL(path, baseUrl);
  return new Promise((resolvePromise, rejectPromise) => {
    const request = httpRequest(target, { method: "POST", headers }, (response) => {
      const responseChunks = [];
      response.on("data", (chunk) => responseChunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(responseChunks).toString("utf8");
        resolvePromise({ status: response.statusCode, body: raw ? JSON.parse(raw) : null });
      });
    });
    request.once("error", rejectPromise);
    for (const chunk of chunks) request.write(chunk);
    request.end();
  });
}

async function runCommand(command, args, env, inputChunks = []) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    if (inputChunks.length) {
      const writeNext = (index) => {
        if (index >= inputChunks.length) {
          child.stdin.end();
          return;
        }
        child.stdin.write(inputChunks[index], () => setImmediate(() => writeNext(index + 1)));
      };
      writeNext(0);
    } else {
      child.stdin.end();
    }
    child.once("error", rejectPromise);
    child.once("exit", (code) => {
      if (code === 0) resolvePromise({ stdout, stderr });
      else rejectPromise(new Error(`command_failed_${code}: ${stderr}`));
    });
  });
}

async function reservePort() {
  const probe = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    probe.once("error", rejectPromise);
    probe.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = probe.address();
  const port = typeof address === "object" && address ? address.port : null;
  await new Promise((resolvePromise, rejectPromise) => {
    probe.close((error) => error ? rejectPromise(error) : resolvePromise());
  });
  if (!port) throw new Error("failed_to_reserve_port");
  return port;
}

async function waitFor(check, { timeoutMs = 6_000, intervalMs = 40, description = "condition" } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ""}`);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function terminateProcess(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise((resolvePromise) => child.once("exit", resolvePromise));
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise((resolvePromise) => setTimeout(() => resolvePromise(false), 4_000)),
  ]);
  if (graceful) return;
  child.kill("SIGKILL");
  await exited;
}
