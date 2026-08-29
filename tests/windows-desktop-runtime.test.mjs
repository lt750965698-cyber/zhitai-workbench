import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";

import { AnalysisQueue } from "../local-agent/analysis-queue.mjs";
import { CreativeQueue } from "../local-agent/creative-queue.mjs";

const require = createRequire(import.meta.url);
const launcher = require("../desktop/launcher.js");
const repositoryRoot = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

test("desktop entry exits Squirrel events before loading runtime and creates userData before setPath", () => {
  const source = readFileSync(path.join(repositoryRoot, "desktop", "main.js"), "utf8");
  const squirrel = source.indexOf('require("electron-squirrel-startup")');
  const launcher = source.indexOf('require("./launcher.js")');
  const mkdir = source.indexOf("fs.mkdirSync(userDataPath");
  const setPath = source.indexOf('app.setPath("userData", userDataPath)');
  assert.equal(squirrel >= 0 && squirrel < launcher, true);
  assert.equal(mkdir >= 0 && mkdir < setPath, true);
  assert.match(source, /com\.squirrel\.ZhitaiWorkbench\.Zhitai/);
  assert.match(source, /zhitai:creative:run[\s\S]+WINDOWS_PREVIEW[\s\S]+creativeAutomation/);
  assert.match(source, /zhitai:x-bookmarks:sync[\s\S]+WINDOWS_PREVIEW[\s\S]+browserAutomation/);
});

function fakeChild() {
  return {
    pid: process.pid,
    exitCode: null,
    killed: false,
    on() {},
    kill(signal) {
      this.killed = signal === "SIGTERM";
    },
  };
}

test("Windows preview starts only the bundled local node and standalone web server", () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), "zhitai-windows-launcher-"));
  const calls = [];
  const nodeBin = "C:\\Program Files\\Zhitai\\Zhitai.exe";
  launcher.init({
    projectDir: repositoryRoot,
    runtimeRoot: "C:\\Users\\Test User\\AppData\\Local\\Zhitai\\runtime",
    dataDir: "C:\\Users\\Test User\\AppData\\Local\\Zhitai\\runtime\\data",
    localAgentScript: path.join(repositoryRoot, "local-agent", "server.mjs"),
    logDir: sandbox,
    nodeBin,
    packaged: true,
    windowsPreview: true,
    spawn: (...args) => {
      calls.push(args);
      return fakeChild();
    },
  });

  try {
    const definitions = launcher.serviceDefs();
    assert.deepEqual(definitions.map(({ id }) => id), ["local-agent", "web"]);

    definitions.find(({ id }) => id === "local-agent").start();
    definitions.find(({ id }) => id === "web").start();

    const [agent, web] = calls;
    assert.equal(agent[0], nodeBin);
    assert.deepEqual(agent[1], [path.join(repositoryRoot, "local-agent", "server.mjs")]);
    assert.equal(agent[2].env.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(agent[2].env.ZHITAI_WINDOWS_PREVIEW, "1");
    assert.equal(agent[2].env.ZHITAI_DATA_DIR.endsWith("Zhitai\\runtime\\data"), true);
    assert.notEqual(agent[0], "/bin/zsh");

    assert.equal(web[0], nodeBin);
    assert.deepEqual(web[1], [path.join(repositoryRoot, "dist", "standalone", "server.js")]);
    assert.equal(web[2].cwd, path.join(repositoryRoot, "dist", "standalone"));
    assert.equal(web[2].env.PORT, "3001");
    assert.equal(web[2].env.HOST, "127.0.0.1");
    assert.equal(web[2].env.ELECTRON_RUN_AS_NODE, "1");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("Windows preview owns and terminates the local node with the desktop app", async () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), "zhitai-windows-stop-"));
  let child;
  let probes = 0;
  launcher.init({
    projectDir: repositoryRoot,
    runtimeRoot: sandbox,
    dataDir: path.join(sandbox, "data"),
    localAgentScript: path.join(repositoryRoot, "local-agent", "server.mjs"),
    logDir: sandbox,
    nodeBin: process.execPath,
    packaged: true,
    windowsPreview: true,
    spawn: () => {
      child = fakeChild();
      return child;
    },
    httpUp: async () => {
      probes += 1;
      return probes > 1;
    },
    sleep: async () => {},
  });

  try {
    const state = await launcher.ensureService("local-agent");
    assert.equal(state.online, true);
    assert.equal(state.owned, true);
    launcher.stopOwned();
    assert.equal(child.killed, true);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

test("Windows preview queues remain inspectable without draining restored work", async () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), "zhitai-windows-queues-"));
  let analysisRuns = 0;
  let creativeRuns = 0;
  const analysis = new AnalysisQueue({
    filePath: path.join(sandbox, "analysis.json"),
    autoDrain: false,
    analyze: async () => { analysisRuns += 1; },
  });
  const creative = new CreativeQueue({
    filePath: path.join(sandbox, "creative.json"),
    autoDrain: false,
    analyze: async () => { creativeRuns += 1; },
  });
  try {
    await analysis.init();
    await creative.init();
    await analysis.enqueueMany([{ assetId: "analysis-fixture", title: "分析任务" }]);
    await creative.create({ assetId: "creative-fixture", title: "生成任务" });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(analysisRuns, 0);
    assert.equal(creativeRuns, 0);
    assert.equal((await analysis.list())[0].status, "queued");
    assert.equal((await creative.list())[0].status, "queued");
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});
