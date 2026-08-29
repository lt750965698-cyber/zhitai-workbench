/**
 * Fail-closed network policy for the offline chain suite.
 *
 * This file is preloaded with `node --import` before any suite code.  The
 * harness has no socket-based fakes: every adapter is an in-process object, so
 * any network API call is a test isolation failure (including loopback).
 */
import http from "node:http";
import https from "node:https";
import http2 from "node:http2";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import childProcess from "node:child_process";
import cluster from "node:cluster";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import workerThreads from "node:worker_threads";

export const OFFLINE_NETWORK_ERROR = "ZHITAI_E2E_NETWORK_BLOCKED";
export const OFFLINE_PROCESS_ERROR = "ZHITAI_E2E_PROCESS_BLOCKED";

const originalFork = childProcess.fork.bind(childProcess);
const originalChildProcessSpawn = childProcess.ChildProcess.prototype.spawn;
let crashWorkerSpawnAllowed = false;
const crashWorkerPath = fileURLToPath(new URL("./crash-worker.mjs", import.meta.url));
const SAFE_CRASH_ENVIRONMENT = new Set([
  "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TEMP", "TMP",
  "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "PATH", "LANG", "TZ",
  "SystemRoot", "SystemDrive", "ComSpec", "PATHEXT",
  "ZHITAI_E2E_OFFLINE", "ZHITAI_E2E_NETWORK_POLICY",
]);

function blockedNetworkCall(...args) {
  const first = args[0];
  let target = typeof first === "string"
    ? first
    : first && typeof first === "object"
      ? first.href || first.hostname || first.host || first.path || "socket"
      : "socket";
  try {
    const parsed = new URL(String(target));
    target = `${parsed.protocol}//${parsed.hostname}${parsed.port ? `:${parsed.port}` : ""}`;
  } catch {
    target = "socket";
  }
  const error = new Error(`${OFFLINE_NETWORK_ERROR}:${target}`);
  error.code = OFFLINE_NETWORK_ERROR;
  throw error;
}

function blockedFetch(input) {
  try {
    blockedNetworkCall(input);
  } catch (error) {
    return Promise.reject(error);
  }
}

function blockedProcessCall() {
  const error = new Error(OFFLINE_PROCESS_ERROR);
  error.code = OFFLINE_PROCESS_ERROR;
  throw error;
}

function guardedCrashWorkerFork(modulePath, args, options) {
  const normalizedArgs = Array.isArray(args) ? args : [];
  const normalizedOptions = Array.isArray(args) ? (options || {}) : (args || {});
  let normalizedModulePath = "";
  try {
    normalizedModulePath = resolve(modulePath instanceof URL ? fileURLToPath(modulePath) : String(modulePath));
  } catch { /* invalid module paths remain blocked */ }
  const isCrashWorker = normalizedModulePath === resolve(crashWorkerPath);
  let importedLockdownPath = "";
  try {
    const importSpecifier = normalizedOptions.execArgv?.[1];
    importedLockdownPath = String(importSpecifier).startsWith("file:")
      ? fileURLToPath(importSpecifier)
      : String(importSpecifier);
  } catch { /* invalid import specifiers remain blocked */ }
  const importsLockdown = Array.isArray(normalizedOptions.execArgv)
    && normalizedOptions.execArgv.length === 2
    && normalizedOptions.execArgv[0] === "--import"
    && resolve(importedLockdownPath) === resolve(fileURLToPath(new URL("./network-lockdown.mjs", import.meta.url)));
  const environmentKeys = Object.keys(normalizedOptions.env || {});
  const safeEnvironment = normalizedOptions.env?.ZHITAI_E2E_NETWORK_POLICY === "deny_all"
    && normalizedOptions.env?.ZHITAI_E2E_OFFLINE === "1"
    && environmentKeys.every((name) => SAFE_CRASH_ENVIRONMENT.has(name));
  if (!isCrashWorker || normalizedArgs.length !== 0 || normalizedOptions.execPath !== process.execPath
    || !importsLockdown || !safeEnvironment || normalizedOptions.detached === true) {
    return blockedProcessCall();
  }
  crashWorkerSpawnAllowed = true;
  try {
    return originalFork(modulePath, normalizedArgs, normalizedOptions);
  } finally {
    crashWorkerSpawnAllowed = false;
  }
}

globalThis.fetch = blockedFetch;
if ("WebSocket" in globalThis) globalThis.WebSocket = class OfflineWebSocket {
  constructor(url) { blockedNetworkCall(url); }
};
if ("EventSource" in globalThis) globalThis.EventSource = class OfflineEventSource {
  constructor(url) { blockedNetworkCall(url); }
};

http.request = blockedNetworkCall;
http.get = blockedNetworkCall;
http.Agent.prototype.createConnection = blockedNetworkCall;
http.ClientRequest = class OfflineClientRequest {
  constructor(options) { blockedNetworkCall(options); }
};
https.request = blockedNetworkCall;
https.get = blockedNetworkCall;
https.Agent.prototype.createConnection = blockedNetworkCall;
http2.connect = blockedNetworkCall;
net.connect = blockedNetworkCall;
net.createConnection = blockedNetworkCall;
net.Socket.prototype.connect = blockedNetworkCall;
net.Server.prototype.listen = blockedNetworkCall;
tls.connect = blockedNetworkCall;
dgram.createSocket = blockedNetworkCall;
for (const name of ["bind", "connect", "send"]) {
  if (typeof dgram.Socket?.prototype?.[name] === "function") dgram.Socket.prototype[name] = blockedNetworkCall;
}
dgram.Socket = class OfflineDatagramSocket {
  constructor(options) { blockedNetworkCall(options); }
};

workerThreads.Worker = class OfflineWorker {
  constructor() { blockedProcessCall(); }
};
if ("Worker" in globalThis) globalThis.Worker = workerThreads.Worker;
cluster.fork = blockedProcessCall;

const DNS_NETWORK_METHODS = [
  "lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny",
  "resolveCaa", "resolveCname", "resolveMx", "resolveNaptr", "resolveNs",
  "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse",
];
for (const name of DNS_NETWORK_METHODS)
  if (typeof dns[name] === "function") dns[name] = blockedNetworkCall;
for (const name of DNS_NETWORK_METHODS)
  if (typeof dnsPromises[name] === "function") dnsPromises[name] = blockedNetworkCall;
for (const prototype of [dns.Resolver?.prototype, dnsPromises.Resolver?.prototype]) {
  if (!prototype) continue;
  for (const name of DNS_NETWORK_METHODS) {
    if (typeof prototype[name] === "function") prototype[name] = blockedNetworkCall;
  }
}

for (const name of ["exec", "execFile", "execFileSync", "execSync", "spawn", "spawnSync"])
  childProcess[name] = blockedProcessCall;
childProcess.fork = guardedCrashWorkerFork;
childProcess.ChildProcess.prototype.spawn = function guardedChildProcessSpawn(...args) {
  if (crashWorkerSpawnAllowed) return originalChildProcessSpawn.apply(this, args);
  return blockedProcessCall();
};
syncBuiltinESMExports();

process.env.ZHITAI_E2E_OFFLINE = "1";
process.env.ZHITAI_E2E_NETWORK_POLICY = "deny_all";
globalThis.__ZHITAI_E2E_NETWORK_LOCKDOWN__ = true;
