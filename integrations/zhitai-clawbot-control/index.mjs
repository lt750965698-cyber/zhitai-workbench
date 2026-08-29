import { execFile } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { createBeforeDispatchHandler, createMessageSentHandler } from "./bridge-core.mjs";

const execFileAsync = promisify(execFile);
const userHome = homedir();
const runtimeRoot = resolve(process.env.ZHITAI_RUNTIME_ROOT
  || join(userHome, ".local", "share", "zhitai-runtime"));
const submitterPath = resolve(process.env.ZHITAI_SUBMITTER_PATH
  || join(runtimeRoot, "local-agent", "inbox-submit.mjs"));
const endpoint = process.env.ZHITAI_REMOTE_ENDPOINT
  || "http://127.0.0.1:17890/api/v1/remote/command";
const outboundResultEndpoint = process.env.ZHITAI_CLAWBOT_OUTBOUND_ENDPOINT
  || "http://127.0.0.1:17890/api/v1/notifications/clawbot/outbound-result";

const OUTBOUND_ERROR_CODES = new Set([
  "session_refresh_required",
  "session_unavailable",
  "rate_limited",
  "timeout",
  "network_unavailable",
  "client_error",
  "delivery_failed",
]);

function sanitizeOutboundReport(value = {}) {
  const success = value?.success === true;
  const candidate = String(value?.errorCode || "");
  return {
    success,
    errorCode: success ? null : (OUTBOUND_ERROR_CODES.has(candidate) ? candidate : "delivery_failed"),
  };
}

export function buildOutboundReportArgs(value, {
  resolvedSubmitterPath = submitterPath,
  resolvedEndpoint = outboundResultEndpoint,
} = {}) {
  return [
    resolvedSubmitterPath,
    "--endpoint",
    resolvedEndpoint,
    "--text",
    JSON.stringify(sanitizeOutboundReport(value)),
    "--source",
    "openclaw_weixin_outbound_result",
  ];
}

async function runSubmitter(args, timeout = 15_000) {
  const { stdout } = await execFileAsync(process.execPath, args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 128 * 1024,
    windowsHide: true,
    env: {
      HOME: userHome,
      PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
      USER: process.env.USER || userInfo().username,
    },
  });
  const parsed = JSON.parse(stdout);
  if (parsed?.ok !== true) throw new Error("bridge_failed");
  return parsed;
}

async function execute({ text, senderId, accountId, isGroup }) {
  const args = [submitterPath, "--endpoint", endpoint, "--text", text || "帮助", "--source", "openclaw_weixin_remote"];
  if (senderId) args.push("--sender-id", senderId);
  if (accountId) args.push("--account-id", accountId);
  if (isGroup) args.push("--group");
  try {
    const parsed = await runSubmitter(args);
    if (typeof parsed?.text !== "string") throw new Error("bridge_failed");
    return parsed;
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    const safeCode = /^[a-zA-Z0-9_-]{1,80}$/.test(stderr) ? stderr : "bridge_failed";
    throw new Error(safeCode);
  }
}

async function reportOutboundResult(value) {
  try {
    await runSubmitter(buildOutboundReportArgs(value), 12_000);
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    const safeCode = /^[a-zA-Z0-9_-]{1,80}$/.test(stderr) ? stderr : "bridge_failed";
    throw new Error(safeCode);
  }
}

export function createPlugin({ executeCommand = execute, reportOutbound = reportOutboundResult } = {}) {
  return {
    id: "zhitai-inbox-bridge",
    name: "Zhitai ClawBot Remote Control",
    description: "Deterministic mobile control and link-ingest bridge for Zhitai. Recognized commands and links never dispatch to a model.",
    register(api) {
      api.on("before_dispatch", createBeforeDispatchHandler({ execute: executeCommand }), {
        priority: 100,
        timeoutMs: 20_000,
      });
      api.on("message_sent", createMessageSentHandler({ report: reportOutbound }), {
        priority: 100,
        timeoutMs: 15_000,
      });
    },
  };
}

export default createPlugin();
