import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const agentEntry = join(repositoryRoot, "local-agent", "server.mjs");

test("Windows preview local node keeps core APIs and fails closed for native automation", {
  timeout: 20_000,
}, async (t) => {
  const sandbox = await mkdtemp(join(tmpdir(), "zhitai-windows-agent-"));
  const dataDir = join(sandbox, "data");
  const runtimeRoot = join(sandbox, "runtime");
  const knowledgeBase = join(sandbox, "knowledge");
  const configPath = join(sandbox, "config.json");
  const port = await reservePort();
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(runtimeRoot, { recursive: true }), mkdir(knowledgeBase, { recursive: true })]);
  await writeFile(configPath, `${JSON.stringify({
    host: "127.0.0.1",
    port,
    knowledgeBase,
    allowedOrigins: ["http://localhost:3001"],
    adapters: {},
    services: {},
    watcher: { roots: [] },
    analysis: { yuanbaoChat: false },
    diagnostics: { debug: { enabled: false, expiresAt: null } },
  }, null, 2)}\n`);

  let output = "";
  const child = spawn(process.execPath, [agentEntry], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      HOME: sandbox,
      APPDATA: join(sandbox, "AppData", "Roaming"),
      LOCALAPPDATA: join(sandbox, "AppData", "Local"),
      ZHITAI_CONFIG_PATH: configPath,
      ZHITAI_DATA_DIR: dataDir,
      ZHITAI_RUNTIME_ROOT: runtimeRoot,
      ZHITAI_WINDOWS_PREVIEW: "1",
      ZHITAI_DISABLE_PUBLISHER_LOGIN_RECOVERY: "1",
    },
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => { output += chunk.toString(); });
  child.stderr.on("data", (chunk) => { output += chunk.toString(); });
  t.after(async () => {
    if (child.exitCode === null) child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => child.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
    await rm(sandbox, { recursive: true, force: true });
  });

  const baseUrl = `http://127.0.0.1:${port}`;
  const health = await waitForJson(`${baseUrl}/health`, output);
  assert.equal(health.ok, true);
  assert.equal(health.platform.mode, "windows_preview");
  assert.equal(health.capabilities.localCore, true);
  assert.equal(health.capabilities.nativePublishing, false);
  assert.deepEqual(health.services, {});

  const config = await fetch(`${baseUrl}/api/v1/config`).then((response) => response.json());
  assert.equal(config.platform.mode, "windows_preview");
  assert.deepEqual(config.services, {});

  for (const [pathname, capability] of [
    ["/api/v1/services", "externalServiceControl"],
    ["/api/v1/updates", "moduleUpdates"],
    ["/api/v1/publisher/status", "backgroundPublishing"],
  ]) {
    const response = await fetch(`${baseUrl}${pathname}`);
    assert.equal(response.status, 501, pathname);
    assert.deepEqual(await response.json(), {
      error: "unsupported_on_windows_preview",
      capability,
      platform: {
        supported: false,
        platform: process.platform,
        mode: "windows_preview",
        reason: "unsupported_on_windows_preview",
      },
    });
  }

  for (const pathname of [
    "/api/v1/analysis/jobs/fixture/resume",
    "/api/v1/creative/jobs",
  ]) {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 501, pathname);
    assert.equal((await response.json()).capability, "creativeAutomation");
  }

  const diagnostics = await fetch(`${baseUrl}/api/v1/diagnostics`);
  assert.equal(diagnostics.status, 200);
  assert.equal((await diagnostics.json()).mode, "structured_only");
});

async function reservePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function waitForJson(url, output) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return response.json();
    } catch {
      // Local node is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`windows_preview_agent_not_ready: ${output.slice(-2_000)}`);
}
