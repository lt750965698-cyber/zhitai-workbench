#!/usr/bin/env node
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const AGENT_ID = "naQivTmsDa";
const BRIDGE_HOST = "127.0.0.1";
const BRIDGE_PORT = 17910;
const YUANBAO_ORIGIN = "https://yuanbao.tencent.com";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isYuanbaoStudioUrl(value) {
  try {
    const url = new URL(String(value || ""));
    const expectedOrigin = new URL(YUANBAO_ORIGIN).origin;
    const isChatPath = url.pathname === "/" || url.pathname === "/chat" || url.pathname.startsWith("/chat/");
    return url.origin === expectedOrigin
      && url.hostname === "yuanbao.tencent.com"
      && !url.username
      && !url.password
      && isChatPath;
  } catch {
    return false;
  }
}

function jsonResponse(res, status, value) {
  const body = JSON.stringify(value);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function readJson(req, maxBytes = 100_000) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > maxBytes) reject(new Error("请求体过大"));
    });
    req.on("end", () => {
      try { resolve(JSON.parse(body || "{}")); }
      catch { reject(new Error("请求体不是合法 JSON")); }
    });
    req.on("error", reject);
  });
}

function normalizedHeaders(input = {}) {
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    const lower = String(key).toLowerCase();
    if (["host", "content-length", "connection", "accept-encoding"].includes(lower)) continue;
    if (lower.startsWith("sec-fetch-") || lower.startsWith("sec-ch-ua")) continue;
    out[lower] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  out.origin = YUANBAO_ORIGIN;
  out.referer = `${YUANBAO_ORIGIN}/chat/${AGENT_ID}`;
  return out;
}

function parseSse(raw) {
  let output = "";
  for (const line of String(raw || "").split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    try {
      const row = JSON.parse(data);
      if (row?.type === "error") throw new Error(row?.msg || row?.message || "元宝返回错误");
      const content = [
        row?.content,
        row?.msg,
        row?.data?.content,
        row?.data?.message?.content?.generator?.text,
        row?.choices?.[0]?.delta?.content,
        row?.choices?.[0]?.message?.content,
      ].find((value) => typeof value === "string" && value);
      if (content) output += content;
    } catch (error) {
      if (error instanceof SyntaxError) continue;
      throw error;
    }
  }
  return output.trim();
}

function createYuanbaoRunner({ openStudio, runtimeRoot }) {
  const cookiePath = path.join(runtimeRoot || path.join(os.homedir(), ".local/share/zhitai-runtime"), "local-agent", "yuanbao-cookie");
  const attachedSessions = new WeakSet();
  const seededSessions = new WeakSet();
  let captured = null;
  let capturedAt = 0;
  let server = null;
  let inFlight = null;

  function attach(window) {
    if (!window || window.isDestroyed()) return;
    const ses = window.webContents.session;
    if (!attachedSessions.has(ses)) {
      attachedSessions.add(ses);
      ses.webRequest.onBeforeSendHeaders({ urls: [`${YUANBAO_ORIGIN}/api/*`] }, (details, callback) => {
        const headers = normalizedHeaders(details.requestHeaders || {});
        if (headers["x-uskey"]) {
          captured = headers;
          capturedAt = Date.now();
        }
        callback({ requestHeaders: details.requestHeaders });
      });
    }
    if (!seededSessions.has(ses)) {
      seededSessions.add(ses);
      void seedSavedCookies(ses).then((seeded) => {
        if (!seeded || window.isDestroyed()) return;
        const refresh = () => {
          if (window.isDestroyed()) return;
          if (isYuanbaoStudioUrl(window.webContents.getURL())) window.webContents.reloadIgnoringCache();
          else void window.loadURL(`${YUANBAO_ORIGIN}/chat/${AGENT_ID}`).catch(() => {});
        };
        if (window.webContents.isLoading()) window.webContents.once("did-finish-load", () => setTimeout(refresh, 150));
        else setTimeout(refresh, 150);
      }).catch(() => {});
    }
  }

  async function seedSavedCookies(ses) {
    let raw = "";
    try { raw = fs.readFileSync(cookiePath, "utf8").trim(); } catch { return false; }
    if (!raw) return false;
    let count = 0;
    for (const part of raw.split(";")) {
      const index = part.indexOf("=");
      if (index <= 0) continue;
      const name = part.slice(0, index).trim();
      const value = part.slice(index + 1).trim();
      if (!name || !value) continue;
      await ses.cookies.set({ url: `${YUANBAO_ORIGIN}/`, name, value, path: "/", secure: true }).catch(() => {});
      count += 1;
    }
    return count > 0;
  }

  async function cookieHeader(ses) {
    const rows = await ses.cookies.get({ url: `${YUANBAO_ORIGIN}/` });
    return rows.map((row) => `${row.name}=${row.value}`).join("; ");
  }

  async function ensureHeaders({ show = false, timeoutMs = 18_000 } = {}) {
    const opened = openStudio("yuanbao", { show });
    if (!opened?.ok || !opened.window) throw new Error(opened?.error || "元宝窗口不可用");
    const window = opened.window;
    attach(window);
    if (captured?.["x-uskey"] && Date.now() - capturedAt < 5 * 60_000) {
      return { headers: captured, window };
    }
    if (!isYuanbaoStudioUrl(window.webContents.getURL())) {
      await window.loadURL(`${YUANBAO_ORIGIN}/chat/${AGENT_ID}`);
    } else {
      window.webContents.reloadIgnoringCache();
    }
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (captured?.["x-uskey"]) return { headers: captured, window };
      await wait(100);
    }
    if (show && !window.isDestroyed()) { window.show(); window.focus(); }
    throw new Error("waiting_login:请在织台元宝窗口登录一次");
  }

  async function call(prompt, { show = false, timeoutMs = 90_000 } = {}) {
    const cleanPrompt = String(prompt || "").trim().slice(0, 20_000);
    if (!cleanPrompt) throw new Error("prompt_required");
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const { headers: capturedHeaders, window } = await ensureHeaders({ show, timeoutMs: Math.min(timeoutMs, 20_000) });
      const headers = normalizedHeaders(capturedHeaders);
      headers.cookie = await cookieHeader(window.webContents.session);
      headers["content-type"] = "application/json";
      const create = await fetch(`${YUANBAO_ORIGIN}/api/user/agent/conversation/create`, {
        method: "POST", headers, body: JSON.stringify({ agentId: AGENT_ID }), signal: AbortSignal.timeout(20_000),
      });
      const created = await create.json().catch(() => null);
      if (!create.ok || !created?.id) {
        if ([401, 403].includes(create.status)) captured = null;
        throw new Error(`元宝创建会话失败（HTTP ${create.status}）`);
      }
      const chatId = String(created.id);
      const body = {
        model: "gpt_175B_0404", prompt: cleanPrompt, plugin: "Adaptive", displayPrompt: cleanPrompt,
        displayPromptType: 1, options: { imageIntention: { needIntentionModel: true, backendUpdateFlag: 2, intentionStatus: true } },
        multimedia: [], agentId: AGENT_ID, supportHint: 1, version: "v2", chatModelId: "gpt_175B_0404",
      };
      const chatHeaders = { ...headers, "content-type": "text/plain;charset=UTF-8", "x-agentid": `${AGENT_ID}/${chatId}`, referer: `${YUANBAO_ORIGIN}/chat/${chatId}` };
      const response = await fetch(`${YUANBAO_ORIGIN}/api/chat/${chatId}`, {
        method: "POST", headers: chatHeaders, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
      const raw = await response.text();
      if (!response.ok) {
        if ([401, 403].includes(response.status)) captured = null;
        throw new Error(`元宝分析失败（HTTP ${response.status}）`);
      }
      const content = parseSse(raw);
      if (!content) throw new Error("元宝没有返回可用正文");
      return { ok: true, provider: "yuanbao-live-browser", content };
    })();
    try { return await inFlight; } finally { inFlight = null; }
  }

  function startBridge() {
    if (server) return;
    server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://${BRIDGE_HOST}:${BRIDGE_PORT}`);
      if (req.method === "GET" && url.pathname === "/health") {
        jsonResponse(res, 200, { ok: true, service: "zhitai-yuanbao-live-bridge", captured: Boolean(captured?.["x-uskey"]), capturedAt: capturedAt || null });
        return;
      }
      if (req.method === "POST" && url.pathname === "/v1/chat") {
        try {
          const input = await readJson(req);
          const result = await call(input?.prompt, { show: input?.interactive === true, timeoutMs: Number(input?.timeoutMs) || 90_000 });
          jsonResponse(res, 200, result);
        } catch (error) {
          const message = String(error?.message || error);
          jsonResponse(res, message.startsWith("waiting_login:") ? 409 : 502, { ok: false, status: message.startsWith("waiting_login:") ? "waiting_login" : "failed", error: message.replace(/^waiting_login:/, "") });
        }
        return;
      }
      jsonResponse(res, 404, { ok: false, error: "not_found" });
    });
    server.listen(BRIDGE_PORT, BRIDGE_HOST);
  }

  function stopBridge() {
    try { server?.close(); } catch { /* ignore */ }
    server = null;
  }

  return { attach, call, startBridge, stopBridge };
}

module.exports = { createYuanbaoRunner, isYuanbaoStudioUrl };
