#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = dirname(scriptDir);
const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
}

const keepSandbox = args.includes("--keep-sandbox");
const explicitReport = option("--report") || process.env.ZHITAI_E2E_REPORT;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const requestedReportPath = resolve(repositoryRoot, explicitReport || join(".artifacts", "offline-e2e", `${stamp}.json`));
const fallbackReportPath = resolve(repositoryRoot, join(".artifacts", "offline-e2e", `${stamp}-bootstrap-fallback.json`));
const runId = `offline-e2e-${randomUUID()}`;
const startedAt = new Date().toISOString();
const kernelNetworkIsolation = process.env.ZHITAI_E2E_KERNEL_NETWORK === "none" ? "none" : "disabled";
const ciEnvironment = process.env.CI === "true" ? "true" : "false";
let sessionRoot = null;
let temporaryHome = null;
let temporaryTmp = null;
let temporaryAppData = null;
let temporaryLocalAppData = null;
let credentialEnvironmentSanitized = false;
const originalEnvironment = Object.fromEntries(
  [
    "HOME", "TMPDIR", "TEMP", "TMP", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME",
    "USER", "LOGNAME", "USERPROFILE", "APPDATA", "LOCALAPPDATA",
    "SystemRoot", "SystemDrive", "ComSpec", "PATHEXT",
  ]
    .map((name) => [name, process.env[name]]),
);

function installMinimalEnvironment() {
  for (const name of Object.keys(process.env)) delete process.env[name];
  const windowsSystemEnvironment = process.platform === "win32"
    ? Object.fromEntries(["SystemRoot", "SystemDrive", "ComSpec", "PATHEXT"]
      .flatMap((name) => originalEnvironment[name] ? [[name, originalEnvironment[name]]] : []))
    : {};
  Object.assign(process.env, {
    HOME: temporaryHome,
    USERPROFILE: temporaryHome,
    APPDATA: temporaryAppData,
    LOCALAPPDATA: temporaryLocalAppData,
    TMPDIR: temporaryTmp,
    TEMP: temporaryTmp,
    TMP: temporaryTmp,
    XDG_CONFIG_HOME: join(temporaryHome, ".config"),
    XDG_DATA_HOME: join(temporaryHome, ".local", "share"),
    XDG_CACHE_HOME: join(temporaryHome, ".cache"),
    USER: "zhitai-e2e",
    LOGNAME: "zhitai-e2e",
    PATH: dirname(process.execPath),
    LANG: "C.UTF-8",
    TZ: "UTC",
    CI: ciEnvironment,
    ZHITAI_E2E_OFFLINE: "1",
    ZHITAI_E2E_NETWORK_POLICY: "deny_all",
    ZHITAI_E2E_ENV_SANITIZED: "1",
    ...(kernelNetworkIsolation === "none" ? { ZHITAI_E2E_KERNEL_NETWORK: "none" } : {}),
    ...windowsSystemEnvironment,
  });
  credentialEnvironmentSanitized = true;
}

function redactForReport(value, key = "", depth = 0) {
  if (depth > 12 || value === null || value === undefined) return value;
  if (key !== "credentialEnvironmentSanitized"
    && /(secret|token|cookie|authorization|signature|password|phone|account|chat|decode.?key|encfilekey)/i.test(key)) {
    return "[REDACTED]";
  }
  if (Array.isArray(value)) return value.map((item) => redactForReport(item, key, depth + 1));
  if (typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, childValue]) => [
      childKey,
      redactForReport(childValue, childKey, depth + 1),
    ]));
  }
  if (typeof value !== "string") return value;
  let result = value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED]")
    .replace(/(?:\/Users|\/home)\/[^\s"']+/g, "[PRIVATE_PATH]")
    .replace(/[A-Za-z]:\\[^\s"']+/g, "[PRIVATE_PATH]");
  result = result.replace(/https?:\/\/[^\s"']+/gi, (candidate) => {
    try {
      const parsed = new URL(candidate);
      parsed.username = "";
      parsed.password = "";
      if (parsed.pathname && parsed.pathname !== "/") parsed.pathname = "/[REDACTED_PATH]";
      if (parsed.search) parsed.search = "?[REDACTED]";
      parsed.hash = "";
      return parsed.toString();
    } catch {
      return "[REDACTED_URL]";
    }
  });
  return result
    .replace(/(^|[\s("'=])\/(?:[^/\s"'<>]+\/)*[^/\s"'<>]*/g, "$1[PRIVATE_PATH]")
    .slice(0, 2_000);
}

async function writeJsonAtomic(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temp, path);
  await chmod(path, 0o600);
}

let report;
try {
  if (globalThis.__ZHITAI_E2E_NETWORK_LOCKDOWN__ !== true) {
    throw new Error("offline_network_lockdown_not_preloaded");
  }
  sessionRoot = await mkdtemp(join(tmpdir(), "zhitai-offline-e2e-run-"));
  temporaryHome = join(sessionRoot, "home");
  temporaryTmp = join(sessionRoot, "tmp");
  temporaryAppData = join(temporaryHome, "AppData", "Roaming");
  temporaryLocalAppData = join(temporaryHome, "AppData", "Local");
  installMinimalEnvironment();
  await Promise.all([
    mkdir(temporaryHome, { recursive: true }),
    mkdir(temporaryTmp, { recursive: true }),
    mkdir(temporaryAppData, { recursive: true }),
    mkdir(temporaryLocalAppData, { recursive: true }),
    mkdir(process.env.XDG_CONFIG_HOME, { recursive: true }),
    mkdir(process.env.XDG_DATA_HOME, { recursive: true }),
    mkdir(process.env.XDG_CACHE_HOME, { recursive: true }),
  ]);
  const { runOfflineE2ESuite } = await import("../tests/e2e/suite.mjs");
  report = await runOfflineE2ESuite({ runId, sessionRoot, keepSandbox });
} catch (error) {
  report = {
    schemaVersion: 1,
    suite: "zhitai-offline-chain-e2e",
    runId,
    status: "failed",
    offline: true,
    networkPolicy: process.env.ZHITAI_E2E_NETWORK_POLICY || "missing",
    environment: {
      credentialEnvironmentSanitized,
      kernelNetworkIsolation: kernelNetworkIsolation === "none",
    },
    startedAt,
    finishedAt: new Date().toISOString(),
    summary: { passed: 0, failed: 1, assertions: 0 },
    scenarios: [{ id: "suite_bootstrap", status: "failed", error: redactForReport(String(error?.message || error)) }],
  };
}

report = redactForReport(report);
let writtenReportPath = null;
try {
  await writeJsonAtomic(requestedReportPath, report);
  writtenReportPath = requestedReportPath;
  const requestedLatestPath = join(dirname(requestedReportPath), "latest.json");
  if (resolve(requestedLatestPath) !== resolve(requestedReportPath)) {
    try { await writeJsonAtomic(requestedLatestPath, report); } catch { /* primary timestamped report is authoritative */ }
  }
} catch (primaryWriteError) {
  report = redactForReport({
    ...report,
    status: "failed",
    summary: {
      ...(report.summary || {}),
      failed: Number(report.summary?.failed || 0) + 1,
    },
    scenarios: [
      ...(report.scenarios || []),
      {
        id: "report_write_fallback",
        status: "failed",
        error: {
          code: primaryWriteError?.code || "REPORT_WRITE_FAILED",
          message: redactForReport(primaryWriteError?.message || String(primaryWriteError)),
        },
      },
    ],
  });
  try {
    await writeJsonAtomic(fallbackReportPath, report);
    writtenReportPath = fallbackReportPath;
    try { await writeJsonAtomic(join(dirname(fallbackReportPath), "latest.json"), report); } catch { /* fallback file exists */ }
  } catch (fallbackWriteError) {
    report = redactForReport({
      ...report,
      fallbackError: {
        code: fallbackWriteError?.code || "REPORT_FALLBACK_WRITE_FAILED",
        message: fallbackWriteError?.message || String(fallbackWriteError),
      },
    });
  }
}

const summary = report.summary || {};
process.stdout.write(`${report.status === "passed" ? "PASS" : "FAIL"} ${report.suite} `
  + `(${summary.passed || 0} passed, ${summary.failed || 0} failed, ${summary.assertions || 0} assertions)\n`);
if (writtenReportPath) {
  const relativeReport = relative(repositoryRoot, writtenReportPath);
  process.stdout.write(`report: ${relativeReport.startsWith("..") ? "[external-report]" : relativeReport}\n`);
} else {
  process.stdout.write(`${JSON.stringify(redactForReport(report))}\n`);
}

for (const [name, value] of Object.entries(originalEnvironment)) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
if (!keepSandbox && sessionRoot) {
  try { await rm(sessionRoot, { recursive: true, force: true }); } catch { /* report already persisted */ }
}
process.exitCode = report.status === "passed" ? 0 : 1;
