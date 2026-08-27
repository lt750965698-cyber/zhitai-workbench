import { homedir } from "node:os";
import { basename } from "node:path";
import { spawnSync } from "node:child_process";

export const DEFAULT_KEYCHAIN_SERVICE = "com.zhitai.inbox-webhook";

function keychainAccount() {
  return process.env.USER || basename(homedir());
}

export function readKeychainSecret(service = DEFAULT_KEYCHAIN_SERVICE) {
  if (process.platform !== "darwin" || !service) return "";
  const result = spawnSync(
    "/usr/bin/security",
    ["find-generic-password", "-s", service, "-a", keychainAccount(), "-w"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    },
  );
  return result.status === 0 ? String(result.stdout || "").trim() : "";
}

export function writeKeychainSecret(service = DEFAULT_KEYCHAIN_SERVICE, secret = "") {
  const value = String(secret || "").trim();
  if (process.platform !== "darwin" || !service || !value) return false;
  const result = spawnSync(
    "/usr/bin/security",
    ["add-generic-password", "-U", "-s", service, "-a", keychainAccount(), "-w", value],
    {
      encoding: "utf8",
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 5_000,
    },
  );
  return result.status === 0;
}
