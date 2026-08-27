import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function readJson(path, fallback = null) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return fallback; }
}

function eventTime(event) {
  const value = event?.time || event?._meta?.date;
  const time = Date.parse(String(value || ""));
  return Number.isFinite(time) ? time : 0;
}

function inspectLogs(logDir) {
  let files = [];
  try {
    files = readdirSync(logDir)
      .filter((name) => /^openclaw-\d{4}-\d{2}-\d{2}\.log$/.test(name))
      .sort()
      .slice(-3);
  } catch { /* log directory missing */ }
  let lastStaleAt = 0;
  let lastMonitorAt = 0;
  let lastInboundAt = 0;
  for (const name of files) {
    let body = "";
    try { body = readFileSync(join(logDir, name), "utf8"); }
    catch { continue; }
    for (const line of body.split("\n")) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); }
      catch { continue; }
      const message = `${event?.[0] || ""} ${event?.[1] || ""} ${event?.message || ""}`;
      const time = eventTime(event);
      if (/token for .* is stale/i.test(message)) lastStaleAt = Math.max(lastStaleAt, time);
      if (/weixin monitor started/i.test(message)) lastMonitorAt = Math.max(lastMonitorAt, time);
      if (/inbound message:/i.test(message)) lastInboundAt = Math.max(lastInboundAt, time);
    }
  }
  return { lastStaleAt, lastMonitorAt, lastInboundAt };
}

function launchAgentRunning(label) {
  try {
    const output = execFileSync("/bin/launchctl", ["print", `gui/${process.getuid()}/${label}`], {
      encoding: "utf8",
      timeout: 1_500,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return /\bstate = running\b/.test(output);
  } catch { return false; }
}

export function inspectOpenclawWeixin({
  stateDir,
  logDir = "/tmp/openclaw",
  launchLabel = "com.zhitai.openclaw-weixin",
  processRunning: processOverride,
} = {}) {
  const root = resolve(stateDir || join(homedir(), ".openclaw"));
  const accountRoot = join(root, "openclaw-weixin", "accounts");
  const accountIds = readJson(join(root, "openclaw-weixin", "accounts.json"), []);
  const accounts = Array.isArray(accountIds)
    ? accountIds.map((id) => readJson(join(accountRoot, `${id}.json`))).filter(Boolean)
    : [];
  const latestSavedAt = accounts.reduce((latest, account) => {
    const time = Date.parse(String(account?.savedAt || ""));
    return Number.isFinite(time) ? Math.max(latest, time) : latest;
  }, 0);
  const logs = inspectLogs(resolve(logDir));
  const processRunning = typeof processOverride === "boolean" ? processOverride : launchAgentRunning(launchLabel);
  const config = readJson(join(root, "openclaw.json"), {});
  const bridgeEnabled = config?.plugins?.entries?.["zhitai-inbox-bridge"]?.enabled === true;
  const conversationAccess = config?.plugins?.entries?.["zhitai-inbox-bridge"]?.hooks?.allowConversationAccess === true;
  const bridgePath = (config?.plugins?.load?.paths || []).find((path) => /zhitai-inbox-bridge$/.test(String(path)));
  const bridgeReady = bridgeEnabled && conversationAccess && Boolean(bridgePath) && existsSync(join(String(bridgePath), "openclaw.plugin.json"));

  let authState = "unknown";
  if (!accounts.length || !latestSavedAt) authState = "missing";
  else if (logs.lastStaleAt > latestSavedAt) authState = "expired";
  else authState = "valid";

  const ready = processRunning && authState === "valid" && bridgeReady;
  const state = ready
    ? "ready"
    : !processRunning
      ? "stopped"
      : authState === "missing" || authState === "expired"
        ? "needs_login"
        : !bridgeReady
          ? "bridge_unavailable"
          : "degraded";
  const reason = ready
    ? "ClawBot 备用直链收件与手机控制可用：官方微信长轮询、登录态和织台桥均正常"
    : !processRunning
      ? "ClawBot 备用直链与手机控制进程未运行"
      : authState === "missing"
        ? "ClawBot 备用直链与手机控制尚未登录微信"
        : authState === "expired"
          ? "ClawBot 备用直链与手机控制登录已过期，需要重新扫码"
          : !bridgeReady
            ? "ClawBot 直链收件与审核桥未启用或未获得对话访问权限"
            : "ClawBot 备用直链与手机控制状态未知";
  const iso = (time) => time ? new Date(time).toISOString() : null;
  return {
    process: { running: processRunning },
    authentication: { state: authState, valid: authState === "valid", savedAt: iso(latestSavedAt) },
    business: {
      state,
      ready,
      reason,
      lastMonitorAt: iso(logs.lastMonitorAt),
      lastInboundAt: iso(logs.lastInboundAt),
      lastErrorAt: iso(logs.lastStaleAt),
    },
    bridge: { ready: bridgeReady },
  };
}

if (resolve(process.argv[1] || "") === fileURLToPath(import.meta.url)) {
  const result = inspectOpenclawWeixin({
    stateDir: process.argv[2],
    logDir: process.argv[3],
    launchLabel: process.argv[4],
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
