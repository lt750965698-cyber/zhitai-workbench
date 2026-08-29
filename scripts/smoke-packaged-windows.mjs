import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, opendir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";

const inspectOnly = process.argv.includes("--inspect-only");
if (process.platform !== "win32" && !inspectOnly) {
  throw new Error("smoke_windows_package_requires_windows");
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const outRoot = join(repositoryRoot, "out");
const packageDirectory = (await readdir(outRoot, { withFileTypes: true }))
  .find((entry) => entry.isDirectory() && entry.name.endsWith("-win32-x64"));
assert.ok(packageDirectory, "Forge did not produce a Windows x64 package directory");

const packageRoot = join(outRoot, packageDirectory.name);
const executable = join(packageRoot, "Zhitai.exe");
const appRoot = join(packageRoot, "resources", "app");
const webEntry = join(appRoot, "dist", "standalone", "server.js");
const agentEntry = join(appRoot, "local-agent", "server.mjs");
for (const filePath of [executable, webEntry, agentEntry]) {
  assert.equal((await stat(filePath)).isFile(), true, `missing packaged runtime: ${filePath}`);
}

const packagedFiles = await walk(appRoot);
for (const filePath of packagedFiles) {
  const portable = relative(appRoot, filePath).split(sep).join("/");
  assert.doesNotMatch(portable, /^node_modules\/\.pnpm(?:\/|$)/u, `pnpm store leaked at package root: ${portable}`);
  assert.doesNotMatch(portable, /^(?:docs|tests|operations|test-results|coverage)\//u);
  assert.doesNotMatch(portable, /(?:^|\/)(?:\.env[^/]*|config\.local\.json|credentials[^/]*\.json|secrets[^/]*\.json)$/iu);
}

const rootModules = new Set(await readdir(join(appRoot, "node_modules")));
assert.equal(rootModules.has("electron-squirrel-startup"), true);
assert.equal(rootModules.has("@electron"), true);
for (const forbidden of ["electron", "vinext", "vite", "typescript", "drizzle-orm", "react"]) {
  assert.equal(rootModules.has(forbidden), false, `development dependency leaked at package root: ${forbidden}`);
}

if (inspectOnly) {
  console.log(`Windows package contents passed inspection: ${basename(packageRoot)}`);
  process.exit(0);
}

const sandbox = await mkdtemp(join(tmpdir(), "zhitai-windows-smoke-"));
const localAppData = join(sandbox, "AppData", "Local");
const appData = join(sandbox, "AppData", "Roaming");
const dataDir = join(localAppData, "Zhitai", "runtime", "data");
const knowledgeBase = join(sandbox, "knowledge");
const configPath = join(sandbox, "config.json");
const [webPort, agentPort] = await Promise.all([reservePort(), reservePort()]);
await Promise.all([
  mkdir(dataDir, { recursive: true }),
  mkdir(knowledgeBase, { recursive: true }),
  mkdir(appData, { recursive: true }),
]);
await writeFile(configPath, `${JSON.stringify({
  host: "127.0.0.1",
  port: agentPort,
  knowledgeBase,
  allowedOrigins: [`http://127.0.0.1:${webPort}`],
  adapters: {},
  services: {},
  watcher: { roots: [] },
  analysis: { yuanbaoChat: false },
  diagnostics: { debug: { enabled: false, expiresAt: null } },
}, null, 2)}\n`);

const commonEnv = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: "1",
  HOME: sandbox,
  USERPROFILE: sandbox,
  APPDATA: appData,
  LOCALAPPDATA: localAppData,
  ZHITAI_WINDOWS_PREVIEW: "1",
};
const web = trackedSpawn(executable, [webEntry], {
  cwd: join(appRoot, "dist", "standalone"),
  env: { ...commonEnv, HOST: "127.0.0.1", PORT: String(webPort) },
});
const agent = trackedSpawn(executable, [agentEntry], {
  cwd: appRoot,
  env: {
    ...commonEnv,
    ZHITAI_CONFIG_PATH: configPath,
    ZHITAI_DATA_DIR: dataDir,
    ZHITAI_RUNTIME_ROOT: join(localAppData, "Zhitai", "runtime"),
    ZHITAI_DISABLE_PUBLISHER_LOGIN_RECOVERY: "1",
  },
});

try {
  const webResponse = await waitForResponse(`http://127.0.0.1:${webPort}/`, web);
  assert.equal(webResponse.status, 200);
  assert.match(await webResponse.text(), /workbench-shell|织台/u);

  const healthResponse = await waitForResponse(`http://127.0.0.1:${agentPort}/health`, agent);
  const health = await healthResponse.json();
  assert.equal(health.ok, true);
  assert.equal(health.platform.mode, "windows_preview");
  assert.equal(health.capabilities.localCore, true);

  const unsupported = await fetch(`http://127.0.0.1:${agentPort}/api/v1/services`, {
    signal: AbortSignal.timeout(5_000),
  });
  assert.equal(unsupported.status, 501);
  assert.equal((await unsupported.json()).error, "unsupported_on_windows_preview");
} finally {
  await Promise.all([stopChild(web), stopChild(agent)]);
  await rm(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

const squirrelEnv = { ...process.env };
delete squirrelEnv.ELECTRON_RUN_AS_NODE;
const squirrel = trackedSpawn(executable, ["--squirrel-obsolete"], {
  cwd: packageRoot,
  env: squirrelEnv,
});
const squirrelExit = await waitForExit(squirrel, 20_000);
assert.equal(squirrelExit.code, 0, `Squirrel startup event failed: ${squirrel.output()}`);

console.log(`Windows package smoke test passed: ${basename(packageRoot)}`);

async function walk(root) {
  const files = [];
  const pending = [root];
  while (pending.length) {
    const directory = pending.pop();
    const handle = await opendir(directory);
    for await (const entry of handle) {
      const filePath = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(filePath);
      else if (entry.isFile()) files.push(filePath);
      else throw new Error(`unexpected packaged filesystem entry: ${relative(root, filePath)}`);
    }
  }
  return files;
}

function trackedSpawn(command, args, options) {
  const child = spawn(command, args, { ...options, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const append = (chunk) => { output = `${output}${chunk}`.slice(-8_000); };
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  child.output = () => output;
  return child;
}

async function waitForResponse(url, child) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`packaged service exited early: ${child.output()}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return response;
    } catch {
      // The packaged service is still starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
  throw new Error(`packaged service did not become ready: ${url}\n${child.output()}`);
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill();
  try {
    await waitForExit(child, 5_000);
  } catch {
    child.kill("SIGKILL");
    await waitForExit(child, 5_000);
  }
}

function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
  return new Promise((resolveExit, rejectExit) => {
    const timer = setTimeout(() => rejectExit(new Error(`process_exit_timeout: ${child.output()}`)), timeoutMs);
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      resolveExit({ code, signal });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      rejectExit(error);
    });
  });
}

async function reservePort() {
  const server = createServer();
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()));
  return address.port;
}
