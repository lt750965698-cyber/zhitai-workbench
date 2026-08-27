#!/usr/bin/env node
/* 织台桌面版 · 窄 IPC API 适配器（外置引擎托管）
 * 只允许代理到本机白名单引擎（17890 / 8000 / 18090 / 17900）；
 * 所有非 2xx 一律 ok:false + 友好错误（含 422）；
 * 只透传受控 headers（Content-Type / Authorization Bearer）；
 * 支持二进制代理（二维码图片/结果文件 → base64），不把原 localhost 地址暴露给 UI；
 * 响应解析与请求构造按本机 openapi.json 真实字段做宽松适配。
 */
"use strict";

const HOST_WHITELIST = new Set([
  "127.0.0.1:17890",
  "localhost:17890",
  "127.0.0.1:8000",
  "localhost:8000",
  "127.0.0.1:18090",
  "localhost:18090",
  "127.0.0.1:17900",
  "localhost:17900",
]);

const ALLOWED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const ALLOWED_HEADERS = new Set(["content-type", "authorization"]);

function mapError(status, body) {
  if (status === 401 || status === 403) return "等待登录（未授权访问）";
  if (status === 404) return "接口不存在（404）";
  if (status === 415) return "请求格式不兼容（HTTP 415），请刷新织台后重试";
  if (status === 422) {
    let detail = "请求参数不合法";
    if (body && typeof body === "object") {
      if (typeof body.detail === "string") detail = body.detail;
      else if (Array.isArray(body.detail)) detail = body.detail.map((d) => (d && d.msg) || JSON.stringify(d)).join("；");
    }
    return "请求参数不合法（422）：" + detail;
  }
  if (status === 502 || status === 504) return "引擎无响应或网关错误";
  if (status >= 500) return "引擎内部错误（HTTP " + status + "）";
  if (typeof body === "string" && body.includes("detail")) {
    try { return JSON.parse(body).detail || "请求失败"; } catch (_) { /* fallthrough */ }
  }
  if (body && typeof body === "object" && typeof body.detail === "string") return body.detail;
  return null;
}

function pickHeaders(headers = {}) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    if (ALLOWED_HEADERS.has(String(k).toLowerCase())) out[String(k).toLowerCase()] = v;
  }
  return out;
}

async function proxyRequest(req = {}, fetchImpl = globalThis.fetch) {
  const url = typeof req.url === "string" ? req.url : "";
  const method = typeof req.method === "string" ? req.method.toUpperCase() : "GET";
  let parsed;
  try { parsed = new URL(url); } catch { return { ok: false, status: 400, error: "无效的 URL" }; }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, status: 400, error: "只允许 http(s) 请求" };
  if (!HOST_WHITELIST.has(parsed.host)) return { ok: false, status: 403, error: "目标不在白名单内" };
  if (!ALLOWED_METHODS.has(method)) return { ok: false, status: 400, error: "不支持的请求方法" };

  let status = 0;
  let body = null;
  try {
    const res = await fetchImpl(url, {
      method,
      // Headers 会把大小写不同的同名键合并为逗号分隔值；统一用小写，
      // 避免 `Content-Type` + `content-type` 变成无效的
      // `application/json, application/json` 并被本地节点判为 HTTP 415。
      headers: { "content-type": "application/json", ...pickHeaders(req.headers) },
      body: method === "GET" || method === "HEAD" ? undefined : JSON.stringify(req.body ?? {}),
      signal: AbortSignal.timeout(Number(req.timeoutMs) || 30_000),
    });
    status = res.status;
    if (req.binary) {
      const buf = Buffer.from(await res.arrayBuffer());
      const ok = status >= 200 && status < 300;
      const mime = res.headers.get("content-type") || "application/octet-stream";
      const captchaId = res.headers.get("x-captcha-id") || undefined;
      if (ok) {
        return { ok: true, status, body: buf.toString("base64"), mime, captchaId };
      }
      return { ok: false, status, body: null, mime, captchaId, error: mapError(status, null) || ("HTTP " + status) };
    }
    const text = await res.text().catch(() => "");
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  } catch (e) {
    return { ok: false, status: 0, error: "引擎不可达（" + String((e && e.message) || e) + "）" };
  }

  // 非 2xx 一律 ok:false（含 400/409/429），error 依次取：上游 detail / body.message / HTTP 状态
  if (status < 200 || status >= 300) {
    const bodyMsg = body && typeof body === "object" ? body.message : null;
    return { ok: false, status, body, error: mapError(status, body) || (typeof bodyMsg === "string" ? bodyMsg : "HTTP " + status) };
  }
  return { ok: true, status, body };
}

// reply-fix runtime_status 可能是 object|string：格式化展示，避免 [object Object]
function formatRuntimeStatus(v) {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "运行中" : "已停止";
  if (typeof v === "object") {
    const parts = [];
    if (v.running !== undefined) parts.push("运行:" + (v.running ? "是" : "否"));
    if (v.connection_state !== undefined) parts.push("连接:" + v.connection_state);
    if (v.message_stream_status !== undefined) parts.push("消息流:" + v.message_stream_status);
    if (v.status !== undefined) parts.push(String(v.status));
    if (v.cookie_valid !== undefined) parts.push("Cookie:" + (v.cookie_valid ? "有效" : "失效"));
    return parts.length ? parts.join(" · ") : JSON.stringify(v);
  }
  return String(v);
}

// ---- 响应解析（宽松适配，契约测试锚点）----

function asArray(payload, key) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload[key])) return payload[key];
  if (payload && Array.isArray(payload.items)) return payload.items;
  return [];
}

// ai-goofish GET /api/tasks → 数组；行字段 task_name / is_running（缺失时从别名补，不硬塞 null）
function parseTasks(payload) {
  return asArray(payload, "tasks").map((row) => {
    const r = row && typeof row === "object" ? { ...row } : { raw: row };
    if (r.task_name === undefined && r.name !== undefined) r.task_name = r.name;
    else if (r.task_name === undefined && r.title !== undefined) r.task_name = r.title;
    if (r.is_running === undefined && r.running !== undefined) r.is_running = r.running;
    if (r.id === undefined && r.task_id !== undefined) r.id = r.task_id;
    return r;
  });
}

// ai-goofish GET /api/accounts → 数组
function parseAccounts(payload) {
  return asArray(payload, "accounts");
}

// ai-goofish GET /api/results/files → { files: [...] }
function parseResultFiles(payload) {
  if (payload && Array.isArray(payload.files)) return payload.files;
  if (Array.isArray(payload)) return payload;
  return [];
}

// reply-fix POST /qr-login/generate → 二维码会话（含 qr_code_url）
function parseQrGenerate(payload) {
  if (!payload || typeof payload !== "object") return { raw: payload };
  const out = { raw: payload };
  const sessionKey = ["session_id", "sessionId", "qr_session", "uuid"].find((k) => k in payload);
  if (sessionKey) out.sessionId = payload[sessionKey];
  const imgKey = ["qr_code_url", "qr_image_url", "qrImageUrl", "qr_url", "qrUrl", "qr_data", "qrData", "image_url"].find((k) => k in payload);
  if (imgKey) out.qrImageUrl = payload[imgKey];
  return out;
}

// reply-fix GET /qr-login/check/{session_id} → 轮询状态（status/扫码状态字段宽松透出）
function parseQrCheck(payload) {
  if (!payload || typeof payload !== "object") return { raw: payload };
  const out = { raw: payload };
  const statusKey = ["status", "state", "login_state"].find((k) => k in payload);
  if (statusKey) out.status = payload[statusKey];
  const scanned = ["scanned", "has_scanned", "confirmed"].find((k) => k in payload);
  if (scanned) out.scanned = payload[scanned];
  return out;
}

// reply-fix GET /cookies/details 或 /cookies → 账号列表（cid / runtime_status，缺失时从别名补）
function parseCookies(payload) {
  return asArray(payload, "cookies").map((row) => {
    const r = row && typeof row === "object" ? { ...row } : { raw: row };
    if (r.cid === undefined && r.id !== undefined) r.cid = r.id;
    else if (r.cid === undefined && r.account_id !== undefined) r.cid = r.account_id;
    if (r.runtime_status === undefined && r.status !== undefined) r.runtime_status = r.status;
    else if (r.runtime_status === undefined && r.runtimeStatus !== undefined) r.runtime_status = r.runtimeStatus;
    return r;
  });
}

// reply-fix GET /logs → 最近日志
function parseLogs(payload) {
  return asArray(payload, "logs");
}

// ---- 请求构造（真实字段，前端不再手填原始 JSON）----

// ai-goofish 新建任务：必填 task_name / keyword
function makeCreateTaskPayload(fields = {}) {
  const out = {
    task_name: String(fields.task_name ?? "").trim(),
    keyword: String(fields.keyword ?? "").trim(),
  };
  for (const k of ["enabled", "min_price", "max_price", "region", "interval_minutes"]) {
    if (fields[k] !== undefined && fields[k] !== "") out[k] = fields[k];
  }
  return out;
}

// reply-fix 保存默认回复：{enabled, reply_content, reply_once}
function makeReplyPayload(fields = {}) {
  return {
    enabled: fields.enabled !== undefined ? Boolean(fields.enabled) : true,
    reply_content: String(fields.reply_content ?? ""),
    reply_once: fields.reply_once !== undefined ? Boolean(fields.reply_once) : false,
  };
}

module.exports = {
  HOST_WHITELIST,
  ALLOWED_METHODS,
  ALLOWED_HEADERS,
  proxyRequest,
  mapError,
  pickHeaders,
  parseTasks,
  parseAccounts,
  parseResultFiles,
  parseQrGenerate,
  parseQrCheck,
  parseCookies,
  parseLogs,
  makeCreateTaskPayload,
  makeReplyPayload,
  formatRuntimeStatus,
};
