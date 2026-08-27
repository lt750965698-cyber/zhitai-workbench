import { execFile } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import { createBeforeDispatchHandler } from "./bridge-core.mjs";

const execFileAsync = promisify(execFile);
const userHome = homedir();
const runtimeRoot = resolve(process.env.ZHITAI_RUNTIME_ROOT
  || join(userHome, ".local", "share", "zhitai-runtime"));
const submitterPath = resolve(process.env.ZHITAI_SUBMITTER_PATH
  || join(runtimeRoot, "local-agent", "inbox-submit.mjs"));
const endpoint = process.env.ZHITAI_REMOTE_ENDPOINT
  || "http://127.0.0.1:17890/api/v1/remote/command";

async function execute({ text, senderId, accountId, isGroup }) {
  const args = [submitterPath, "--endpoint", endpoint, "--text", text || "帮助", "--source", "openclaw_weixin_remote"];
  if (senderId) args.push("--sender-id", senderId);
  if (accountId) args.push("--account-id", accountId);
  if (isGroup) args.push("--group");
  try {
    const { stdout } = await execFileAsync(process.execPath, args, {
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 128 * 1024,
      windowsHide: true,
      env: {
        HOME: userHome,
        PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
        USER: process.env.USER || userInfo().username,
      },
    });
    const parsed = JSON.parse(stdout);
    if (parsed?.ok !== true || typeof parsed?.text !== "string") throw new Error("bridge_failed");
    return parsed;
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    const safeCode = /^[a-zA-Z0-9_-]{1,80}$/.test(stderr) ? stderr : "bridge_failed";
    throw new Error(safeCode);
  }
}

export default {
  id: "zhitai-inbox-bridge",
  name: "Zhitai ClawBot Remote Control",
  description: "Deterministic mobile control and link-ingest bridge for Zhitai. Recognized commands and links never dispatch to a model.",
  register(api) {
    api.on("before_dispatch", createBeforeDispatchHandler({ execute }), {
      priority: 100,
      timeoutMs: 20_000,
    });
  },
};
