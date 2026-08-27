#!/usr/bin/env node

import { createHmac, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_KEYCHAIN_SERVICE,
  readKeychainSecret,
} from "./keychain-secret.mjs";

const localAgentRoot = dirname(fileURLToPath(import.meta.url));
const args = parseArgs(process.argv.slice(2));
const configPath = process.env.ZHITAI_CONFIG_PATH || join(localAgentRoot, "config.local.json");
const config = await readConfig(configPath);
const keychainService = args.keychainService || config.webhookKeychainService || DEFAULT_KEYCHAIN_SERVICE;
const configuredSecretFile = process.env.ZHITAI_WEBHOOK_SECRET_FILE || config.webhookSecretFile || join(dirname(configPath), "inbox-secret");
const secretFile = isAbsolute(configuredSecretFile) ? configuredSecretFile : resolve(dirname(configPath), configuredSecretFile);

if (args.ensureSecret) {
  const result = await ensureSecretFile(secretFile);
  process.stdout.write(`${JSON.stringify({ ok: true, secretFileReady: true, created: result.created })}\n`);
  process.exit(0);
}

const configuredHost = String(config.host || "127.0.0.1");
const endpointHost = configuredHost === "::1" ? "[::1]" : configuredHost;
const endpoint = new URL(args.endpoint || process.env.ZHITAI_INBOX_ENDPOINT || `http://${endpointHost}:${config.port || 17890}/api/v1/inbox`);
if (!["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname.replace(/^\[|\]$/g, "")) || !["http:", "https:"].includes(endpoint.protocol)) {
  fail("endpoint_must_be_loopback");
}

const text = args.text || args.url || await readStandardInput();
if (!text || !text.trim()) fail("message_text_required");
if (Buffer.byteLength(text, "utf8") > 240_000) fail("message_too_large");

const secret = process.env.ZHITAI_WEBHOOK_SECRET
  || config.webhookSecret
  || await readSecretFile(secretFile)
  || readKeychainSecret(keychainService);
if (!secret) fail("webhook_secret_not_configured");

const payload = JSON.stringify({
  text: text.trim(),
  source: sanitizeSource(args.source || "openclaw_weixin"),
  ...(args.senderId ? { senderId: String(args.senderId).slice(0, 240) } : {}),
  ...(args.accountId ? { accountId: String(args.accountId).slice(0, 240) } : {}),
  ...(args.group ? { isGroup: true } : {}),
});
if (Buffer.byteLength(payload, "utf8") > 256_000) fail("message_too_large");
const timestamp = String(Math.floor(Date.now() / 1_000));
const nonce = randomBytes(24).toString("base64url");
const signature = `v1=${createHmac("sha256", secret).update(`${timestamp}.${nonce}.${payload}`).digest("hex")}`;

let response;
try {
  response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Zhitai-Timestamp": timestamp,
      "X-Zhitai-Nonce": nonce,
      "X-Zhitai-Signature": signature,
    },
    body: payload,
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
} catch {
  fail("local_agent_unreachable");
}

let body = {};
try {
  body = await response.json();
} catch {
  // Keep upstream response details private.
}
if (!response.ok) fail(typeof body.error === "string" ? body.error : `local_agent_http_${response.status}`);

process.stdout.write(`${JSON.stringify({
  ok: true,
  text: typeof body.text === "string" ? body.text : null,
  code: typeof body.code === "string" ? body.code : null,
  taskId: typeof body.task?.id === "string" ? body.task.id : null,
  status: typeof body.task?.status === "string" ? body.task.status : "accepted",
  platform: typeof body.task?.platform === "string" ? body.task.platform : null,
})}\n`);

async function readConfig(path) {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

async function readSecretFile(path) {
  try {
    const value = (await readFile(path, "utf8")).trim();
    return value.length >= 32 && value.length <= 256 ? value : "";
  } catch {
    return "";
  }
}

async function ensureSecretFile(path) {
  const existing = await readSecretFile(path);
  if (existing) {
    await chmod(path, 0o600);
    return { created: false };
  }
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, `${randomBytes(32).toString("hex")}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    return { created: true };
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    await chmod(path, 0o600);
    return { created: false };
  }
}

async function readStandardInput() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  let totalBytes = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.length;
    if (totalBytes > 240_000) fail("message_too_large");
    chunks.push(buffer);
  }
  const input = Buffer.concat(chunks, totalBytes).toString("utf8");
  const trimmed = input.trim();
  if (!trimmed.startsWith("{")) return trimmed;
  try {
    const parsed = JSON.parse(trimmed);
    for (const candidate of [parsed.url, parsed.text, parsed.content, parsed.message?.content, parsed.message?.text]) {
      if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    }
  } catch {
    // Plain text beginning with a brace is still a valid message.
  }
  return trimmed;
}

function parseArgs(values) {
  const parsed = {};
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--ensure-secret") parsed.ensureSecret = true;
    else if (value === "--url") parsed.url = values[++index];
    else if (value === "--text") parsed.text = values[++index];
    else if (value === "--source") parsed.source = values[++index];
    else if (value === "--sender-id") parsed.senderId = values[++index];
    else if (value === "--account-id") parsed.accountId = values[++index];
    else if (value === "--group") parsed.group = true;
    else if (value === "--endpoint") parsed.endpoint = values[++index];
    else if (value === "--keychain-service") parsed.keychainService = values[++index];
    else fail("invalid_argument");
  }
  return parsed;
}

function sanitizeSource(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "webhook";
}

function fail(code) {
  process.stderr.write(`${String(code).replace(/[^a-zA-Z0-9_-]/g, "_")}\n`);
  process.exit(1);
}
