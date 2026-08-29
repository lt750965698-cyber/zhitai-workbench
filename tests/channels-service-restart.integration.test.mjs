import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const testsDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(testsDir);
const agentEntry = join(repositoryRoot, "local-agent", "server.mjs");
const engineFixture = join(testsDir, "fixtures", "channels-restart-service.mjs");

test("视频号解析引擎意外退出后单例重启并重新验证页面连接", async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "zhitai-channels-restart-"));
  const dataDir = join(sandbox, "data");
  const knowledgeBase = join(sandbox, "knowledge-base");
  const pidHistoryPath = join(sandbox, "engine-pids.txt");
  const configPath = join(sandbox, "config.json");
  const agentPort = await reservePort();
  const enginePort = await reservePort();
  const baseUrl = `http://127.0.0.1:${agentPort}`;
  const output = [];
  let agent;

  await writeFile(configPath, `${JSON.stringify({
    host: "127.0.0.1",
    port: agentPort,
    knowledgeBase,
    allowedOrigins: ["http://localhost:3000"],
    watcher: { roots: [] },
    analysis: { yuanbaoChat: false },
    adapters: { publisher: { enabled: false } },
    services: {
      wx_channels_card: {
        label: "Fixture WeChat Channels parser",
        role: "ingest",
        autoStart: true,
        onDemand: false,
        healthUrl: `http://127.0.0.1:${enginePort}/api/channels/status`,
        installChecks: [engineFixture, process.execPath],
        start: {
          command: process.execPath,
          args: [engineFixture, String(enginePort), pidHistoryPath],
        },
        stopTimeoutMs: 1_000,
      },
    },
  }, null, 2)}\n`, "utf8");

  t.after(async () => {
    await terminateProcess(agent);
    for (const pid of await readPids(pidHistoryPath)) {
      if (!processIsAlive(pid)) continue;
      try { process.kill(pid, "SIGKILL"); } catch { /* fixture already exited */ }
    }
    await rm(sandbox, { recursive: true, force: true });
  });

  agent = spawn(process.execPath, [agentEntry], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ZHITAI_CONFIG_PATH: configPath,
      ZHITAI_DATA_DIR: dataDir,
      ZHITAI_PORT: String(agentPort),
      ZHITAI_DISABLE_CHANNELS_PAGE_LAUNCH: "1",
      ZHITAI_DISABLE_PUBLISHER_LOGIN_RECOVERY: "1",
      ZHITAI_MATRIX_PARTITIONS_DIR: join(dataDir, "matrix-partitions"),
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  agent.stdout.on("data", (chunk) => output.push(chunk.toString()));
  agent.stderr.on("data", (chunk) => output.push(chunk.toString()));

  const initial = await waitForHealthyService(baseUrl, agent, output);
  assert.equal(initial.business.state, "ready");
  const [firstPid] = await waitFor(async () => {
    const pids = await readPids(pidHistoryPath);
    return pids.length === 1 ? pids : false;
  }, "initial engine pid");

  process.kill(firstPid, "SIGTERM");
  const firstRestart = await waitFor(async () => {
    const pids = await readPids(pidHistoryPath);
    return pids.length >= 2 && pids[1] !== firstPid ? pids : false;
  }, "automatic engine restart");
  const secondPid = firstRestart[1];
  assert.equal(processIsAlive(firstPid), false);
  assert.equal((await waitForHealthyService(baseUrl, agent, output)).healthy, true);

  process.kill(secondPid, "SIGTERM");
  await waitFor(() => !processIsAlive(secondPid), "second engine exit");
  const startRequests = Array.from({ length: 6 }, () => fetch(
    `${baseUrl}/api/v1/services/wx_channels_card/start`,
    {
      method: "POST",
      headers: {
        Origin: "http://localhost:3000",
        "Content-Type": "application/json",
        "X-Zhitai-Action": "confirm",
      },
      body: "{}",
    },
  ));
  const responses = await Promise.all(startRequests);
  assert.deepEqual(responses.map((response) => response.status), [200, 200, 200, 200, 200, 200]);

  const finalPids = await waitFor(async () => {
    const pids = await readPids(pidHistoryPath);
    return pids.length >= 3 ? pids : false;
  }, "single concurrent restart");
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_300));
  assert.deepEqual(await readPids(pidHistoryPath), finalPids,
    "自动重启定时器与并发手动启动不得再创建第四个进程");
  assert.equal(new Set(finalPids).size, 3);
  assert.equal(processIsAlive(finalPids[2]), true);
  assert.equal((await waitForHealthyService(baseUrl, agent, output)).business.ready, true);
});

async function waitForHealthyService(baseUrl, agent, output) {
  return waitFor(async () => {
    if (agent.exitCode !== null) throw new Error(`local agent exited\n${output.join("")}`);
    try {
      const response = await fetch(`${baseUrl}/api/v1/services`);
      if (!response.ok) return false;
      const body = await response.json();
      const service = body.services?.wx_channels_card;
      return service?.healthy === true && service?.business?.ready === true ? service : false;
    } catch {
      return false;
    }
  }, "healthy channels service");
}

async function readPids(path) {
  const raw = await readFile(path, "utf8").catch(() => "");
  return raw.split("\n")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(Number)
    .filter((value) => Number.isInteger(value) && value > 0);
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolvePromise) => server.close(resolvePromise));
  return port;
}

async function waitFor(check, description, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  throw new Error(`timed out waiting for ${description}`);
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
