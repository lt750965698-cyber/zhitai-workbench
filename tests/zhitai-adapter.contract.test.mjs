import { test } from "node:test";
import assert from "node:assert/strict";

import adapter from "../desktop/adapter.js";

const {
  proxyRequest, mapError, parseTasks, parseAccounts, parseResultFiles,
  parseQrGenerate, parseQrCheck, parseCookies, parseLogs,
  pickHeaders, makeCreateTaskPayload, makeReplyPayload, formatRuntimeStatus,
} = adapter;

// ---- mock fetch：按路由表返回 ----
function mockFetch(routes) {
  return async (url, opts = {}) => {
    const u = String(url);
    const method = (opts.method || "GET").toUpperCase();
    for (const r of routes) {
      const hit = r.method === method && (typeof r.match === "function" ? r.match(u) : u === r.url);
      if (hit) {
        const payload = typeof r.body === "function" ? r.body() : r.body;
        const body = payload === undefined ? "" : JSON.stringify(payload);
        return new Response(body, { status: r.status || 200, headers: { "Content-Type": "application/json" } });
      }
    }
    return new Response(JSON.stringify({ detail: "not found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  };
}

// ---- 1. 白名单：非白名单目标必须被拒绝 ----
test("proxy 拒绝非白名单目标", async () => {
  const r = await proxyRequest({ url: "http://192.168.1.1/api/evil", method: "GET" }, mockFetch([]));
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
  assert.match(r.error, /白名单/);
});

test("proxy 拒绝非法 URL", async () => {
  const r = await proxyRequest({ url: "not-a-url", method: "GET" }, mockFetch([]));
  assert.equal(r.ok, false);
  assert.equal(r.status, 400);
});

// ---- 2. 任务列表（ai-goofish GET /api/tasks）----
test("任务列表：空数组与带 tasks 字段均可解析", () => {
  assert.deepEqual(parseTasks([]), []);
  assert.deepEqual(parseTasks({ tasks: [{ id: 1 }] }), [{ id: 1 }]);
  assert.deepEqual(parseTasks({ items: [{ id: 2 }] }), [{ id: 2 }]);
  assert.deepEqual(parseTasks({ unexpected: true }), []);
});

test("任务列表：proxy GET 200 透传", async () => {
  const fetchImpl = mockFetch([{ method: "GET", url: "http://127.0.0.1:8000/api/tasks", body: [] }]);
  const r = await proxyRequest({ url: "http://127.0.0.1:8000/api/tasks", method: "GET" }, fetchImpl);
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.deepEqual(parseTasks(r.body), []);
});

// ---- 3. 启动 / 停止（ai-goofish）----
test("任务启动与停止：POST 到真实路径并透传结果", async () => {
  const fetchImpl = mockFetch([
    { method: "POST", match: (u) => u.endsWith("/api/tasks/start/7"), body: { ok: true } },
    { method: "POST", match: (u) => u.endsWith("/api/tasks/stop/7"), body: { ok: true } },
  ]);
  const start = await proxyRequest({ url: "http://127.0.0.1:8000/api/tasks/start/7", method: "POST", body: {} }, fetchImpl);
  assert.equal(start.ok, true);
  const stop = await proxyRequest({ url: "http://127.0.0.1:8000/api/tasks/stop/7", method: "POST", body: {} }, fetchImpl);
  assert.equal(stop.ok, true);
});

// ---- 4. 账号列表（reply-fix GET /cookies）----
test("账号列表：未授权映射为等待登录", async () => {
  const r = await proxyRequest({ url: "http://127.0.0.1:18090/cookies", method: "GET" }, mockFetch([
    { method: "GET", url: "http://127.0.0.1:18090/cookies", status: 401, body: { detail: "未授权访问" } },
  ]));
  assert.equal(r.ok, false);
  assert.match(r.error, /等待登录/);
});

test("账号列表：已授权时解析 cookies", () => {
  assert.deepEqual(parseCookies([{ cid: "a1" }]), [{ cid: "a1" }]);
  assert.deepEqual(parseCookies({ cookies: [{ cid: "a2" }] }), [{ cid: "a2" }]);
});

// ---- 5. 二维码生成与轮询（reply-fix /qr-login/*）----
test("二维码生成：解析会话与图片地址", () => {
  const out = parseQrGenerate({ session_id: "s1", qr_image_url: "http://127.0.0.1:18090/qr/s1.png" });
  assert.equal(out.sessionId, "s1");
  assert.equal(out.qrImageUrl, "http://127.0.0.1:18090/qr/s1.png");
});

test("二维码轮询：generate 后 check 状态流转", async () => {
  let calls = 0;
  const fetchImpl = mockFetch([
    { method: "POST", url: "http://127.0.0.1:18090/qr-login/generate", body: { session_id: "sx", qr_image_url: "data:image/png;base64,xx" } },
    { method: "GET", match: (u) => u.includes("/qr-login/check/sx"), body: () => ({ status: calls++ === 0 ? "waiting" : "confirmed" }) },
  ]);
  const gen = await proxyRequest({ url: "http://127.0.0.1:18090/qr-login/generate", method: "POST", body: {} }, fetchImpl);
  assert.equal(gen.ok, true);
  const g = parseQrGenerate(gen.body);
  assert.equal(g.sessionId, "sx");
  const c1 = await proxyRequest({ url: "http://127.0.0.1:18090/qr-login/check/sx", method: "GET" }, fetchImpl);
  assert.equal(parseQrCheck(c1.body).status, "waiting");
  const c2 = await proxyRequest({ url: "http://127.0.0.1:18090/qr-login/check/sx", method: "GET" }, fetchImpl);
  assert.equal(parseQrCheck(c2.body).status, "confirmed");
});

test("二维码接口未授权：如实报等待登录", async () => {
  const r = await proxyRequest({ url: "http://127.0.0.1:18090/qr-login/generate", method: "POST", body: {} }, mockFetch([
    { method: "POST", url: "http://127.0.0.1:18090/qr-login/generate", status: 401, body: { detail: "未授权访问" } },
  ]));
  assert.equal(r.ok, false);
  assert.match(r.error, /等待登录/);
});

// ---- 6. 错误显示 ----
test("错误映射：401/403 → 等待登录；5xx → 引擎错误；不可达 → 引擎不可达", async () => {
  assert.equal(mapError(401, { detail: "未授权访问" }), "等待登录（未授权访问）");
  assert.equal(mapError(403, { detail: "forbidden" }), "等待登录（未授权访问）");
  assert.equal(mapError(502, null), "引擎无响应或网关错误");
  assert.match(mapError(0, null) ?? "", /^$/); // 0 不匹配任何分支 → null
  const r = await proxyRequest({ url: "http://127.0.0.1:8000/api/tasks", method: "GET" }, async () => { throw new Error("ECONNREFUSED"); });
  assert.equal(r.ok, false);
  assert.match(r.error, /引擎不可达/);
});

// ---- 7. 结果文件与日志 ----
test("结果文件与日志解析", () => {
  assert.deepEqual(parseResultFiles({ files: ["a.json"] }), ["a.json"]);
  assert.deepEqual(parseLogs({ logs: [{ message: "x" }] }), [{ message: "x" }]);
  assert.deepEqual(parseAccounts([{ name: "acc" }]), [{ name: "acc" }]);
});

// ---- 8. 非 2xx 一律 ok:false（含 422 上游友好错误）----
test("422 必须 ok:false 且显示上游错误，不假报成功", async () => {
  const r = await proxyRequest({ url: "http://127.0.0.1:8000/api/tasks/", method: "POST", body: { task_name: "" } }, mockFetch([
    { method: "POST", url: "http://127.0.0.1:8000/api/tasks/", status: 422, body: { detail: [{ msg: "task_name 不能为空" }, { msg: "keyword 不能为空" }] } },
  ]));
  assert.equal(r.ok, false);
  assert.match(r.error, /422/);
  assert.match(r.error, /task_name 不能为空/);
});

test("其它非 2xx（404/5xx）也 ok:false", async () => {
  const r404 = await proxyRequest({ url: "http://127.0.0.1:8000/api/nope", method: "GET" }, mockFetch([{ method: "GET", url: "http://127.0.0.1:8000/api/nope", status: 404, body: { detail: "not found" } }]));
  assert.equal(r404.ok, false);
  const r500 = await proxyRequest({ url: "http://127.0.0.1:18090/boom", method: "GET" }, mockFetch([{ method: "GET", url: "http://127.0.0.1:18090/boom", status: 500, body: { detail: "err" } }]));
  assert.equal(r500.ok, false);
});

// ---- 9. 登录 token 后 Authorization Bearer 透传 ----
test("Authorization Bearer 经 proxy 透传到上游", async () => {
  let seenAuth = null;
  const fetchImpl = async (url, opts = {}) => {
    const h = opts.headers || {};
    seenAuth = h.authorization || h.Authorization || null;
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  await proxyRequest({ url: "http://127.0.0.1:18090/cookies/details", method: "GET", headers: { Authorization: "Bearer tok123" } }, fetchImpl);
  assert.equal(seenAuth, "Bearer tok123");
});

test("受控 headers：仅透传 Content-Type / Authorization，其它被丢弃", () => {
  assert.deepEqual(pickHeaders({ Authorization: "Bearer x", "X-Evil": "1", Cookie: "sid=1", "content-type": "application/json" }), {
    authorization: "Bearer x",
    "content-type": "application/json",
  });
});

test("桌面代理不会把 Content-Type 大小写重复合并成 HTTP 415", async () => {
  let seenContentType = null;
  const fetchImpl = async (_url, opts = {}) => {
    seenContentType = new Headers(opts.headers).get("content-type");
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const result = await proxyRequest({
    url: "http://127.0.0.1:17890/api/v1/publisher/wechat-official/credentials",
    method: "POST",
    body: { appId: `wx${"0".repeat(16)}`, appSecret: "0".repeat(32) },
    headers: { "Content-Type": "application/json" },
  }, fetchImpl);
  assert.equal(result.ok, true);
  assert.equal(seenContentType, "application/json");
});

// ---- 10. 二维码 qr_code_url ----
test("parseQrGenerate 识别 qr_code_url", () => {
  const out = parseQrGenerate({ session_id: "s1", qr_code_url: "http://127.0.0.1:18090/qr/s1.png" });
  assert.equal(out.sessionId, "s1");
  assert.equal(out.qrImageUrl, "http://127.0.0.1:18090/qr/s1.png");
});

// ---- 11. 任务：真实字段 payload + PATCH + 列表别名 ----
test("makeCreateTaskPayload 只含真实必填 task_name/keyword + 可选字段", () => {
  assert.deepEqual(makeCreateTaskPayload({ task_name: "监控A", keyword: "显卡" }), { task_name: "监控A", keyword: "显卡" });
  assert.deepEqual(makeCreateTaskPayload({ task_name: "监控A", keyword: "显卡", enabled: false, min_price: "100" }), {
    task_name: "监控A", keyword: "显卡", enabled: false, min_price: "100",
  });
});

test("任务 PATCH：proxy 以 PATCH 透传 /api/tasks/{id}", async () => {
  let methodSeen = null;
  let urlSeen = null;
  const fetchImpl = async (url, opts = {}) => {
    methodSeen = opts.method; urlSeen = String(url);
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  await proxyRequest({ url: "http://127.0.0.1:8000/api/tasks/9", method: "PATCH", body: { task_name: "x", keyword: "y" } }, fetchImpl);
  assert.equal(methodSeen, "PATCH");
  assert.equal(urlSeen, "http://127.0.0.1:8000/api/tasks/9");
});

test("parseTasks 行字段 task_name/is_running（缺失时从别名补）", () => {
  assert.deepEqual(parseTasks([{ task_name: "A", is_running: true }]), [{ task_name: "A", is_running: true }]);
  const aliased = parseTasks([{ name: "B", running: false }]);
  assert.equal(aliased[0].task_name, "B");
  assert.equal(aliased[0].is_running, false);
  assert.deepEqual(parseTasks([{ id: 1 }]), [{ id: 1 }]);
});

// ---- 12. 账号：cookies/details + runtime-status ----
test("parseCookies 补 cid/runtime_status 别名且不破坏原结构", () => {
  assert.deepEqual(parseCookies([{ cid: "a1" }]), [{ cid: "a1" }]);
  const rows = parseCookies({ cookies: [{ id: "c9", status: "online" }] });
  assert.equal(rows[0].cid, "c9");
  assert.equal(rows[0].runtime_status, "online");
});

test("runtime-status：proxy 透传 /cookies/{cid}/runtime-status", async () => {
  let urlSeen = null;
  const fetchImpl = async (url) => {
    urlSeen = String(url);
    return new Response(JSON.stringify({ runtime_status: "online" }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const r = await proxyRequest({ url: "http://127.0.0.1:18090/cookies/c9/runtime-status", method: "GET" }, fetchImpl);
  assert.equal(urlSeen, "http://127.0.0.1:18090/cookies/c9/runtime-status");
  assert.equal(r.body.runtime_status, "online");
});

// ---- 13. 默认回复：读 reply_content、写 {enabled,reply_content,reply_once} ----
test("makeReplyPayload 固定字段", () => {
  assert.deepEqual(makeReplyPayload({ reply_content: "亲，您好", enabled: true, reply_once: false }), {
    enabled: true, reply_content: "亲，您好", reply_once: false,
  });
  assert.deepEqual(makeReplyPayload({}), { enabled: true, reply_content: "", reply_once: false });
});

// ---- 14. 结果详情：GET /api/results/{filename} 在代理内透传 ----
test("结果详情代理：文本/JSON 内容原样返回", async () => {
  const fetchImpl = mockFetch([{ method: "GET", url: "http://127.0.0.1:8000/api/results/demo.json", body: { hits: 3 } }]);
  const r = await proxyRequest({ url: "http://127.0.0.1:8000/api/results/demo.json", method: "GET" }, fetchImpl);
  assert.equal(r.ok, true);
  assert.deepEqual(r.body, { hits: 3 });
});

// ---- 15. 二进制代理：base64 + mime，不暴露原地址 ----
test("binary 请求返回 base64 与 mime", async () => {
  const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const fetchImpl = async () => new Response(bytes, { status: 200, headers: { "Content-Type": "image/png" } });
  const r = await proxyRequest({ url: "http://127.0.0.1:18090/qr/s1.png", method: "GET", binary: true }, fetchImpl);
  assert.equal(r.ok, true);
  assert.equal(r.mime, "image/png");
  assert.equal(typeof r.body, "string");
  assert.ok(Buffer.from(r.body, "base64").length > 0);
});

// ---- 16. 验证码：PNG + X-Captcha-Id ----
test("captcha/generate：binary 返回 base64 + mime + captchaId", async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const fetchImpl = async () => new Response(png, {
    status: 200,
    headers: { "Content-Type": "image/png", "X-Captcha-Id": "cap-1" },
  });
  const r = await proxyRequest({ url: "http://127.0.0.1:18090/captcha/generate", method: "GET", binary: true }, fetchImpl);
  assert.equal(r.ok, true);
  assert.equal(r.mime, "image/png");
  assert.equal(r.captchaId, "cap-1");
  assert.ok(Buffer.from(r.body, "base64").length >= 8);
});

// ---- 17. 登录：HTTP 200 但 success:false 表示失败；success:true 才带 token ----
test("login 业务失败：HTTP 200 + success:false 透传 message/captcha_required，不上当为成功", async () => {
  const r = await proxyRequest({ url: "http://127.0.0.1:18090/login", method: "POST", body: {} }, mockFetch([
    { method: "POST", url: "http://127.0.0.1:18090/login", body: { success: false, message: "验证码错误", captcha_required: true } },
  ]));
  assert.equal(r.ok, true); // HTTP 2xx 透传；业务层由前端判断 success
  assert.equal(r.body.success, false);
  assert.equal(r.body.message, "验证码错误");
  assert.equal(r.body.captcha_required, true);
});

test("login 成功：success:true 返回 token", async () => {
  const r = await proxyRequest({ url: "http://127.0.0.1:18090/login", method: "POST", body: { username: "admin", password: "x", captcha_id: "cap-1", captcha_code: "1234" } }, mockFetch([
    { method: "POST", url: "http://127.0.0.1:18090/login", body: { success: true, token: "tok-abc", message: "登录成功" } },
  ]));
  assert.equal(r.ok, true);
  assert.equal(r.body.success, true);
  assert.equal(r.body.token, "tok-abc");
});

// ---- 18. 非 2xx（400/409/429）一律 ok:false ----
test("400/409/429 一律 ok:false（error 取 detail→message→HTTP）", async () => {
  const r400 = await proxyRequest({ url: "http://127.0.0.1:18090/login", method: "POST", body: {} }, mockFetch([
    { method: "POST", url: "http://127.0.0.1:18090/login", status: 400, body: { message: "参数错误" } },
  ]));
  assert.equal(r400.ok, false);
  assert.match(r400.error, /参数错误/);

  const r409 = await proxyRequest({ url: "http://127.0.0.1:18090/cookies", method: "POST", body: {} }, mockFetch([
    { method: "POST", url: "http://127.0.0.1:18090/cookies", status: 409, body: { detail: "冲突" } },
  ]));
  assert.equal(r409.ok, false);
  assert.match(r409.error, /冲突/);

  const r429 = await proxyRequest({ url: "http://127.0.0.1:18090/login", method: "POST", body: {} }, mockFetch([
    { method: "POST", url: "http://127.0.0.1:18090/login", status: 429, body: {} },
  ]));
  assert.equal(r429.ok, false);
  assert.match(r429.error, /429/);
});

// ---- 19. runtime_status 格式化（object|string，不再 [object Object]）----
test("formatRuntimeStatus：object 提取 running/connection_state/message_stream_status", () => {
  assert.equal(formatRuntimeStatus("online"), "online");
  assert.equal(formatRuntimeStatus(null), "—");
  assert.equal(formatRuntimeStatus({ running: true, connection_state: "connected", message_stream_status: "streaming" }),
    "运行:是 · 连接:connected · 消息流:streaming");
  assert.equal(formatRuntimeStatus({ status: "offline" }), "offline");
  assert.ok(!formatRuntimeStatus({ running: false, connection_state: "disconnected" }).includes("[object Object]"));
});
