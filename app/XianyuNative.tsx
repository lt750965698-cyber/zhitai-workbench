"use client";

/* 织台 · 闲鱼原生控制页（V1 收口）
 * 直接使用两个引擎的现有 OpenAPI；不猜字段，未知字段原样透出；
 * 管理登录：织台内用户名/密码表单 → POST /login → token 仅存内存会话；
 * 二维码：登录后 /qr-login/generate → qr_code_url 经窄 IPC 代理取图显示 → 轮询 check；
 * 不代用户扫码、不处理验证码、不写真实任务/账号/回复配置（写操作 UI 存在但需用户确认）。
 * 普通 UI 不显示 localhost/IP/端口；原工具入口仅在「诊断/高级」折叠区。
 */

import { useEffect, useRef, useState } from "react";
import { zapi, ApiResult, apiErrorText, setSessionToken, getSessionToken } from "./zapi";

const GF = "http://127.0.0.1:8000";
const RF = "http://127.0.0.1:18090";

type GfTask = {
  id?: number | string;
  task_name?: string | null;
  is_running?: boolean | null;
  status?: string;
  enabled?: boolean;
  [k: string]: unknown;
};

type CookieRow = {
  cid?: string | null;
  runtime_status?: string | null;
  account?: string | null;
  [k: string]: unknown;
};

function text(v: unknown): string {
  return v === null || v === undefined ? "" : String(v);
}

function isDataUrl(v: string): boolean {
  return v.startsWith("data:") || v.startsWith("dataimage");
}

// runtime_status 可能是 object|string：格式化展示，避免 [object Object]
function formatRuntimeStatus(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "运行中" : "已停止";
  if (typeof v === "object") {
    const rec = v as Record<string, unknown>;
    const parts: string[] = [];
    if (rec.running !== undefined) parts.push("运行:" + (rec.running ? "是" : "否"));
    if (rec.connection_state !== undefined) parts.push("连接:" + text(rec.connection_state));
    if (rec.message_stream_status !== undefined) parts.push("消息流:" + text(rec.message_stream_status));
    if (rec.status !== undefined) parts.push(text(rec.status));
    if (rec.cookie_valid !== undefined) parts.push("Cookie:" + (rec.cookie_valid ? "有效" : "失效"));
    return parts.length ? parts.join(" · ") : JSON.stringify(rec);
  }
  return String(v);
}

export function XianyuNative() {
  const [desktopMode, setDesktopMode] = useState<boolean | null>(null);
  const [gfOnline, setGfOnline] = useState<boolean | null>(null);
  const [rfOnline, setRfOnline] = useState<boolean | null>(null);

  // ---- reply-fix 管理登录（token 仅内存）+ 验证码 ----
  const [rfAuth, setRfAuth] = useState<"checking" | "anon" | "ok">("checking");
  const [loginUser, setLoginUser] = useState("");
  const [loginPass, setLoginPass] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);
  const [loginMsg, setLoginMsg] = useState("");
  const [captchaSrc, setCaptchaSrc] = useState<string | null>(null);
  const [captchaId, setCaptchaId] = useState<string | null>(null);
  const [captchaCode, setCaptchaCode] = useState("");

  // ---- 账号 / 回复 ----
  const [cookies, setCookies] = useState<CookieRow[]>([]);
  const [rfMsg, setRfMsg] = useState("");
  const [replyCid, setReplyCid] = useState("");
  const [replyEnabled, setReplyEnabled] = useState(true);
  const [replyOnce, setReplyOnce] = useState(false);
  const [replyContent, setReplyContent] = useState("");
  const [replyLoading, setReplyLoading] = useState(false);

  // ---- 二维码 ----
  const [qrOpen, setQrOpen] = useState(false);
  const [qrSession, setQrSession] = useState<string | null>(null);
  const [qrImageSrc, setQrImageSrc] = useState<string | null>(null);
  const [qrStatus, setQrStatus] = useState("准备打开二维码…");
  const qrTimer = useRef<ReturnType<typeof setInterval> | null>(null);

  // ---- ai-goofish 任务 ----
  const [tasks, setTasks] = useState<GfTask[]>([]);
  const [gfMsg, setGfMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [editingId, setEditingId] = useState<string | number | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [taskName, setTaskName] = useState("");
  const [taskKeyword, setTaskKeyword] = useState("");
  const [taskEnabled, setTaskEnabled] = useState(true);

  // ---- 结果 ----
  const [resultFiles, setResultFiles] = useState<string[]>([]);
  const [resultView, setResultView] = useState<{ name: string; content: string } | null>(null);

  const showGf = (m: string) => setGfMsg(m);
  const showRf = (m: string) => setRfMsg(m);

  // ---------- ai-goofish ----------
  async function loadGf() {
    const [t, f] = await Promise.all([
      zapi(`${GF}/api/tasks`, "GET", undefined, { timeoutMs: 6000 }),
      zapi(`${GF}/api/results/files`, "GET", undefined, { timeoutMs: 6000 }),
    ]);
    if (t.ok && Array.isArray(t.body)) setTasks(t.body as GfTask[]);
    else showGf(apiErrorText(t) || "任务列表读取失败");
    if (f.ok && f.body && Array.isArray((f.body as { files?: unknown[] }).files)) {
      setResultFiles((f.body as { files: string[] }).files);
    }
  }

  async function startTask(id: string | number) {
    setBusy(true);
    const r = await zapi(`${GF}/api/tasks/start/${id}`, "POST", {}, { timeoutMs: 6000 });
    showGf(r.ok ? "已发送启动请求" : "启动失败：" + apiErrorText(r));
    setBusy(false);
    if (r.ok) void loadGf();
  }

  async function stopTask(id: string | number) {
    setBusy(true);
    const r = await zapi(`${GF}/api/tasks/stop/${id}`, "POST", {}, { timeoutMs: 6000 });
    showGf(r.ok ? "已发送停止请求" : "停止失败：" + apiErrorText(r));
    setBusy(false);
    if (r.ok) void loadGf();
  }

  async function deleteTask(id: string | number) {
    if (!window.confirm(`确定删除任务 ${id}？此操作会修改真实任务数据。`)) return;
    const r = await zapi(`${GF}/api/tasks/${id}`, "DELETE", {}, { timeoutMs: 6000 });
    showGf(r.ok ? "已删除" : "删除失败：" + apiErrorText(r));
    if (r.ok) void loadGf();
  }

  function createPayload() {
    return {
      task_name: taskName.trim(),
      keyword: taskKeyword.trim(),
      enabled: taskEnabled,
    };
  }

  async function createTask() {
    if (!taskName.trim() || !taskKeyword.trim()) { showGf("请填写任务名称与关键词"); return; }
    if (!window.confirm("确认创建任务？此操作会写入真实任务数据（验收不执行）。")) return;
    const r = await zapi(`${GF}/api/tasks/`, "POST", createPayload(), { timeoutMs: 8000 });
    showGf(r.ok ? "任务已创建" : "创建失败：" + apiErrorText(r));
    setShowCreate(false);
    setTaskName("");
    setTaskKeyword("");
    if (r.ok) void loadGf();
  }

  async function saveEdit(id: string | number) {
    if (!window.confirm("确认保存任务修改？此操作会修改真实任务数据（验收不执行）。")) return;
    const r = await zapi(`${GF}/api/tasks/${id}`, "PATCH", createPayload(), { timeoutMs: 8000 });
    showGf(r.ok ? "已保存" : "保存失败：" + apiErrorText(r));
    setEditingId(null);
    if (r.ok) void loadGf();
  }

  // ---------- reply-fix 管理登录 ----------
  async function loadCaptcha() {
    setCaptchaSrc(null);
    setCaptchaId(null);
    setCaptchaCode("");
    const r = await zapi(`${RF}/captcha/generate`, "GET", undefined, { noAuth: true, timeoutMs: 10000, binary: true });
    if (!r.ok || !r.body) { setLoginMsg("验证码获取失败：" + apiErrorText(r) || "验证码获取失败"); return; }
    setCaptchaSrc(`data:${r.mime || "image/png"};base64,${r.body}`);
    setCaptchaId(r.captchaId || null);
  }

  async function submitLogin() {
    if (!loginUser.trim() || !loginPass) { setLoginMsg("请输入管理后台用户名与密码"); return; }
    if (!captchaId || !captchaCode.trim()) { setLoginMsg("请输入验证码（引擎已启用登录验证码）"); return; }
    setLoginBusy(true);
    setLoginMsg("");
    const r = await zapi(`${RF}/login`, "POST", {
      username: loginUser.trim(),
      password: loginPass,
      captcha_id: captchaId,
      captcha_code: captchaCode.trim(),
    }, { noAuth: true, timeoutMs: 10000 });
    setLoginBusy(false);
    if (!r.ok) { setLoginMsg("登录失败：" + apiErrorText(r)); return; }
    const raw = r.body as Record<string, unknown> | null;
    if (raw && raw.success === false) {
      // HTTP 200 但业务失败：显示上游 message。
      // 验证码是一次性使用（上游校验通过即删除，失败后旧 captcha_id 已失效），
      // 因此只要 success:false 就无条件刷新验证码——不能以 captcha_required 为依据
      // （密码错误时 captcha_required 可能为 false，但旧验证码同样不可再用）。
      setLoginMsg(text(raw.message) || "登录失败");
      void loadCaptcha();
      return;
    }
    const token = text(raw?.token) || text(raw?.access_token) || text((raw?.data as Record<string, unknown> | null)?.token);
    if (!token) { setLoginMsg("引擎已响应但未返回令牌（上游字段变化）：" + JSON.stringify(raw)); return; }
    setSessionToken(token);
    setLoginMsg("管理后台登录成功（令牌仅本次会话内存保存）");
    setRfAuth("ok");
    setLoginPass("");
    setCaptchaCode("");
    void loadRf();
  }

  async function logoutRf() {
    setSessionToken(null);
    setRfAuth("anon");
    setCookies([]);
  }

  // ---------- reply-fix 账号/回复/二维码 ----------
  async function loadRf() {
    const r = await zapi(`${RF}/cookies/details`, "GET", undefined, { timeoutMs: 8000 });
    if (r.ok) {
      setRfAuth("ok");
      const arr = Array.isArray(r.body) ? r.body : Array.isArray((r.body as { cookies?: unknown[] })?.cookies) ? (r.body as { cookies: unknown[] }).cookies : [];
      setCookies(arr.map((c) => {
        const rec = (c ?? {}) as Record<string, unknown>;
        return {
          ...rec,
          cid: text(rec.cid) || text(rec.id) || text(rec.account_id) || null,
          runtime_status: formatRuntimeStatus(rec.runtime_status ?? rec.status ?? rec.runtimeStatus),
        };
      }));
    } else {
      setRfAuth(r.status === 401 || r.status === 403 ? "anon" : "checking");
      setCookies([]);
      if (r.status !== 401 && r.status !== 403) showRf(apiErrorText(r));
    }
  }

  async function refreshRuntime(cid: string) {
    const r = await zapi(`${RF}/cookies/${encodeURIComponent(cid)}/runtime-status`, "GET", undefined, { timeoutMs: 8000 });
    if (!r.ok) { showRf("运行态刷新失败：" + apiErrorText(r)); return; }
    const raw = r.body as Record<string, unknown> | null;
    const status = formatRuntimeStatus(raw?.runtime_status ?? raw?.status ?? raw?.runtimeStatus ?? raw);
    setCookies((prev) => prev.map((c) => (c.cid === cid ? { ...c, runtime_status: status } : c)));
  }

  async function loadReply(cid: string) {
    setReplyCid(cid);
    setReplyLoading(true);
    setReplyEnabled(true);
    setReplyOnce(false);
    setReplyContent("");
    const r = await zapi(`${RF}/default-replies/${encodeURIComponent(cid)}`, "GET", undefined, { timeoutMs: 8000 });
    setReplyLoading(false);
    if (r.ok) {
      const b = r.body as Record<string, unknown> | null;
      setReplyContent(text(b?.reply_content) || text(b?.reply) || text(b?.content) || "");
      if (typeof b?.enabled === "boolean") setReplyEnabled(b.enabled);
      if (typeof b?.reply_once === "boolean") setReplyOnce(b.reply_once);
    } else {
      setReplyContent("");
      showRf("读取默认回复失败：" + apiErrorText(r));
    }
  }

  async function saveReply() {
    if (!replyCid) return;
    if (!window.confirm("确认保存默认回复？此操作会修改真实回复配置（验收不执行）。")) return;
    const r = await zapi(`${RF}/default-replies/${encodeURIComponent(replyCid)}`, "PUT",
      { enabled: replyEnabled, reply_content: replyContent, reply_once: replyOnce }, { timeoutMs: 8000 });
    showRf(r.ok ? "已保存" : "保存失败：" + apiErrorText(r));
  }

  async function fetchQrImage(qrUrl: string): Promise<string> {
    if (isDataUrl(qrUrl)) return qrUrl;
    const abs = qrUrl.startsWith("http") ? qrUrl : RF + (qrUrl.startsWith("/") ? qrUrl : "/" + qrUrl);
    const r = await zapi(abs, "GET", undefined, { timeoutMs: 10000, binary: true });
    if (!r.ok || !r.body) throw new Error(apiErrorText(r) || "二维码图片获取失败");
    return `data:${r.mime || "image/png"};base64,${r.body}`;
  }

  async function openQr() {
    setQrOpen(true);
    setQrSession(null);
    setQrImageSrc(null);
    if (rfAuth !== "ok") {
      setQrStatus("请先在「管理后台登录」中登录，再生成二维码。");
      return;
    }
    setQrStatus("正在向引擎申请二维码…");
    const r = await zapi(`${RF}/qr-login/generate`, "POST", {}, { timeoutMs: 10000 });
    if (!r.ok) {
      setQrStatus("二维码接口不可用：" + apiErrorText(r));
      return;
    }
    const raw = r.body as Record<string, unknown> | null;
    const sessionId = text(raw?.session_id) || text(raw?.sessionId) || text(raw?.qr_session) || text(raw?.uuid);
    const qrUrl = text(raw?.qr_code_url) || text(raw?.qr_image_url) || text(raw?.qrUrl) || text(raw?.qr_data);
    if (!sessionId) {
      setQrStatus("引擎已响应但未返回会话标识（上游字段变化）：" + JSON.stringify(raw));
      return;
    }
    setQrSession(sessionId);
    setQrStatus(qrUrl ? "请用闲鱼 App 扫码" : "二维码已生成（未返回图片地址，请查看原始响应）");
    if (qrUrl) {
      try {
        const src = await fetchQrImage(qrUrl);
        setQrImageSrc(src);
      } catch (e) {
        setQrStatus("二维码图片获取失败：" + (e instanceof Error ? e.message : String(e)));
      }
    }
    if (qrTimer.current) clearInterval(qrTimer.current);
    qrTimer.current = setInterval(async () => {
      const c = await zapi(`${RF}/qr-login/check/${encodeURIComponent(sessionId)}`, "GET", undefined, { timeoutMs: 8000 });
      if (!c.ok) { setQrStatus("轮询失败：" + apiErrorText(c)); return; }
      const st = text((c.body as Record<string, unknown> | null)?.status) || text((c.body as Record<string, unknown> | null)?.state) || "";
      setQrStatus(st ? `扫码状态：${st}` : "等待扫码…");
      if (/成功|已登录|success|confirmed|logged/i.test(st)) {
        if (qrTimer.current) clearInterval(qrTimer.current);
        setQrStatus("已登录（" + st + "）");
        void loadRf();
      }
    }, 3000);
  }

  function closeQr() {
    if (qrTimer.current) clearInterval(qrTimer.current);
    qrTimer.current = null;
    setQrOpen(false);
  }

  // ---------- 结果文件（织台内查看） ----------
  async function openResult(filename: string) {
    const r = await zapi(`${GF}/api/results/${encodeURIComponent(filename)}`, "GET", undefined, { timeoutMs: 8000 });
    if (!r.ok) { showGf("结果读取失败：" + apiErrorText(r)); return; }
    const content = typeof r.body === "string" ? r.body : JSON.stringify(r.body, null, 2);
    setResultView({ name: filename, content });
  }

  // 进入待登录态时自动加载验证码（首次 anon 渲染）
  useEffect(() => {
    if (rfAuth === "anon") void loadCaptcha();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rfAuth]);

  // ---------- 引擎健康轮询 ----------
  useEffect(() => {
    // 首帧与 SSR 保持 null；挂载后再识别是否为带窄 IPC 桥的织台 App。
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDesktopMode(Boolean(window.zhitaiBridge?.isDesktop));
  }, []);

  useEffect(() => {
    if (desktopMode !== true) return;
    let alive = true;
    const poll = async () => {
      const g = await zapi(`${GF}/health`, "GET", undefined, { timeoutMs: 4000 });
      const r = await zapi(`${RF}/health`, "GET", undefined, { noAuth: true, timeoutMs: 9000 });
      if (!alive) return;
      setGfOnline(g.ok);
      setRfOnline(r.ok);
      if (g.ok) void loadGf();
      if (r.ok) void loadRf();
    };
    void poll();
    const t = setInterval(poll, 9000);
    return () => { alive = false; clearInterval(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktopMode]);

  if (desktopMode !== true) {
    return (
      <section className="xianyu-overview xianyu-desktop-required">
        <div>
          <span className="eyebrow-pill"><i /> 织台运行环境</span>
          <h2>{desktopMode === null ? "正在连接织台 App…" : "闲鱼控制请在织台 App 内使用"}</h2>
          <p>{desktopMode === null ? "正在识别桌面能力。" : "当前是普通浏览器页面，无法使用本机 IPC 桥；这不代表闲鱼后台已离线。请从“织台.app”打开本页。"}</p>
        </div>
      </section>
    );
  }

  return (
    <>
      <section className="xianyu-overview">
        <div><span className="eyebrow-pill"><i /> 织台账号中心</span><h2>监控与多账号，<br />一个入口全部原生操作。</h2><p>两个引擎作为外置后台，由织台通过 OpenAPI 控制；普通界面不显示引擎地址，登录在织台内完成。</p></div>
        <div className="xianyu-score">
          <EmptyRing value={`${[gfOnline, rfOnline].filter(Boolean).length}/2`} label="引擎在线" />
          <p><strong>{gfOnline && rfOnline ? "两个引擎均在线" : gfOnline ? "仅监控引擎在线" : rfOnline ? "仅多账号引擎在线" : "引擎均未连接"}</strong>
          <span>{rfAuth === "ok" ? "多账号管理已登录" : rfAuth === "anon" ? "多账号管理待登录" : "检测登录状态中"}</span></p>
        </div>
      </section>

      {/* ---------- reply-fix：管理登录 + 账号中心 ---------- */}
      <section className="panel table-panel">
        <div className="panel-heading table-heading">
          <div><span>多账号引擎</span><h3>账号中心</h3></div>
          <div className="filter-pills">
            <button type="button" className="active">{rfOnline ? "在线" : "离线"}</button>
            {rfAuth === "ok" ? <button type="button" onClick={() => void openQr()}>二维码登录</button> : null}
            {rfAuth === "ok" ? <button type="button" onClick={logoutRf}>退出管理登录</button> : null}
          </div>
        </div>
        {rfMsg && <p className="xianyu-msg">{rfMsg}</p>}
        {loginMsg && <p className="xianyu-msg">{loginMsg}</p>}

        {rfAuth === "checking" && <div className="empty-state"><span>…</span><strong>检测登录状态中</strong></div>}

        {rfAuth === "anon" && (
          <div className="reply-login-form">
            <p style={{ fontSize: 13, color: "#767b72", margin: "0 0 10px" }}>引擎要求先登录管理后台（令牌仅保存在本次会话内存，不写入文件；引擎已启用登录验证码）：</p>
            <div className="inline-capture">
              <input value={loginUser} onChange={(e) => setLoginUser(e.target.value)} placeholder="管理后台用户名" style={{ flex: 1 }} />
              <input type="password" value={loginPass} onChange={(e) => setLoginPass(e.target.value)} placeholder="密码" style={{ flex: 1 }} />
            </div>
            <div className="inline-capture" style={{ marginTop: 8 }}>
              {captchaSrc ? <img src={captchaSrc} alt="验证码" style={{ height: 36, borderRadius: 6, border: "1px solid #dad9d2" }} onClick={() => void loadCaptcha()} title="点击刷新验证码" /> : <span style={{ fontSize: 13, color: "#8a8f86" }}>验证码加载中…</span>}
              <input value={captchaCode} onChange={(e) => setCaptchaCode(e.target.value)} placeholder="验证码" style={{ flex: 1 }} />
              <button className="primary-button" type="button" onClick={() => void submitLogin()} disabled={loginBusy || !captchaId}>{loginBusy ? "登录中…" : "登录管理后台"}</button>
            </div>
            <p style={{ fontSize: 13, color: "#a0a39c", margin: "8px 0 0" }}>不替你输入凭证；验证码图片在织台内显示（点击可刷新），织台不处理其它验证码类型。</p>
          </div>
        )}

        {rfAuth === "ok" && (
          <>
            <div className="data-table task-table">
              <div className="table-row table-header"><span>账号</span><span>运行态</span><span>默认回复</span></div>
              {cookies.map((c, i) => {
                const account = text(c.account) || text(c.account_name) || text(c.username) || text(c.cid) || "未命名账号";
                return (
                  <div className="table-row" key={i}>
                    <div className="table-content-cell"><p><strong>{account}</strong><small>ID：{text(c.cid) || "—"}</small></p></div>
                    <span>{text(c.runtime_status) || "运行中"}</span>
                    <span className="row-actions">
                      {c.cid ? <button type="button" onClick={() => void refreshRuntime(text(c.cid))}>刷新运行态</button> : null}
                      {c.cid ? <button type="button" onClick={() => void loadReply(text(c.cid))}>查看/编辑回复</button> : null}
                    </span>
                  </div>
                );
              })}
              {!cookies.length && <div className="empty-state"><span>◇</span><strong>暂无账号</strong><p>等待登录后显示真实账号列表；可用「二维码登录」为账号扫码。</p></div>}
            </div>
            {replyCid && (
              <div style={{ padding: 14, borderTop: "1px solid var(--line)" }}>
                <p style={{ fontSize: 13, color: "#767b72", margin: "0 0 8px" }}>默认回复 · {replyCid}（保存会修改真实配置，验收不执行）：</p>
                {replyLoading ? <p style={{ fontSize: 13 }}>读取中…</p> : (
                  <>
                    <label style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 8, fontSize: 13 }}>
                      <span><input type="checkbox" checked={replyEnabled} onChange={(e) => setReplyEnabled(e.target.checked)} /> 启用</span>
                      <span><input type="checkbox" checked={replyOnce} onChange={(e) => setReplyOnce(e.target.checked)} /> 只回复一次</span>
                    </label>
                    <textarea value={replyContent} onChange={(e) => setReplyContent(e.target.value)} rows={3} style={{ width: "100%", fontSize: 14, border: "1px solid #dad9d2", borderRadius: 8, padding: 8, background: "#fffefa" }} />
                    <div style={{ marginTop: 8 }}><button className="secondary-button" type="button" onClick={() => void saveReply()} disabled={!rfOnline}>保存默认回复</button></div>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </section>

      {/* ---------- 二维码弹窗 ---------- */}
      {qrOpen && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && closeQr()}>
          <section className="modal-card" role="dialog" aria-modal="true">
            <button className="modal-close" type="button" onClick={closeQr} aria-label="关闭">×</button>
            <span className="modal-kicker">多账号引擎</span>
            <h2>二维码登录</h2>
            <p>{qrStatus}</p>
            {qrImageSrc && <img src={qrImageSrc} alt="登录二维码" style={{ width: 220, height: 220, display: "block", margin: "12px auto", borderRadius: 10 }} />}
            {!qrImageSrc && qrSession && <p style={{ textAlign: "center", fontSize: 13, color: "#767b72" }}>会话：{qrSession}</p>}
            <div className="modal-note"><span>i</span> 织台只展示二维码并轮询状态，不会代你扫码，也不处理验证码。</div>
          </section>
        </div>
      )}

      {/* ---------- ai-goofish：任务 ---------- */}
      <section className="panel table-panel">
        <div className="panel-heading table-heading">
          <div><span>监控引擎</span><h3>监控任务</h3></div>
          <div className="filter-pills">
            <button type="button" className="active">{gfOnline ? "在线" : "离线"}</button>
            <button type="button" onClick={() => { setShowCreate((v) => !v); setEditingId(null); }}>＋ 新建任务</button>
          </div>
        </div>
        {gfMsg && <p className="xianyu-msg">{gfMsg}</p>}
        <div className="data-table task-table">
          <div className="table-row table-header"><span>任务</span><span>运行</span><span>操作</span></div>
          {tasks.map((task) => (
            <div className="table-row" key={text(task.id)}>
              <div className="table-content-cell"><p><strong>{text(task.task_name) || "未命名任务"}</strong><small>关键词：{text(task.keyword) || "—"}</small></p></div>
              <span>{task.is_running ? "运行中" : text(task.status) || "已停止"}</span>
              <span className="row-actions">
                {editingId === task.id ? (
                  <>
                    <button type="button" onClick={() => { setEditingId(task.id ?? null); setTaskName(text(task.task_name)); setTaskKeyword(text(task.keyword)); setTaskEnabled(task.enabled !== false); }} disabled>编辑中…</button>
                  </>
                ) : (
                  <>
                    <button type="button" onClick={() => { setEditingId(task.id ?? null); setTaskName(text(task.task_name)); setTaskKeyword(text(task.keyword)); setTaskEnabled(task.enabled !== false); setShowCreate(false); }}>编辑</button>
                    <button type="button" onClick={() => void startTask(text(task.id))} disabled={busy}>启动</button>
                    <button type="button" onClick={() => void stopTask(text(task.id))} disabled={busy}>停止</button>
                    <button type="button" onClick={() => void deleteTask(text(task.id))} disabled={busy}>删除</button>
                  </>
                )}
              </span>
            </div>
          ))}
          {!tasks.length && <div className="empty-state"><span>◇</span><strong>{gfOnline ? "暂无监控任务" : "监控引擎离线"}</strong><p>{gfOnline ? "用「新建任务」创建（写入真实数据，验收不执行）。" : "启动引擎后这里显示真实任务。"}</p></div>}
        </div>
        {(showCreate || editingId !== null) && (
          <div style={{ padding: 14, borderTop: "1px solid var(--line)" }}>
            <p style={{ fontSize: 13, color: "#767b72", margin: "0 0 8px" }}>{editingId !== null ? `编辑任务 ${text(editingId)}（PATCH，验收不执行）` : "新建任务（必填：任务名称、关键词）"}：</p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input value={taskName} onChange={(e) => setTaskName(e.target.value)} placeholder="任务名称（task_name）" style={{ minWidth: 180, height: 34, border: "1px solid #dadbd3", borderRadius: 8, padding: "0 10px", fontSize: 13, background: "#f7f6f2" }} />
              <input value={taskKeyword} onChange={(e) => setTaskKeyword(e.target.value)} placeholder="关键词（keyword）" style={{ minWidth: 180, height: 34, border: "1px solid #dadbd3", borderRadius: 8, padding: "0 10px", fontSize: 13, background: "#f7f6f2" }} />
              <label style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 13 }}><input type="checkbox" checked={taskEnabled} onChange={(e) => setTaskEnabled(e.target.checked)} /> 启用</label>
            </div>
            <div style={{ marginTop: 8, display: "flex", gap: 8 }}>
              {editingId !== null
                ? <button className="primary-button" type="button" onClick={() => void saveEdit(editingId)} disabled={!gfOnline}>保存修改</button>
                : <button className="primary-button" type="button" onClick={() => void createTask()} disabled={!gfOnline}>创建任务</button>}
              <button className="secondary-button" type="button" onClick={() => { setShowCreate(false); setEditingId(null); }}>取消</button>
            </div>
          </div>
        )}
      </section>

      {/* ---------- ai-goofish：结果（织台内查看） ---------- */}
      <section className="panel table-panel">
        <div className="panel-heading table-heading"><div><span>监控结果</span><h3>结果文件</h3></div><span>{resultFiles.length} 个</span></div>
        <div className="data-table task-table">
          <div className="table-row table-header"><span>文件名</span><span /></div>
          {resultFiles.map((f, i) => (
            <div className="table-row" key={i}>
              <div className="table-content-cell"><p><strong>{text(f)}</strong></p></div>
              <span className="row-actions"><button type="button" onClick={() => void openResult(text(f))}>在织台内查看</button></span>
            </div>
          ))}
          {!resultFiles.length && <div className="empty-state"><span>▤</span><strong>暂无结果文件</strong><p>任务运行后产生的扫描结果会出现在这里。</p></div>}
        </div>
      </section>

      {/* ---------- 结果内容弹窗 ---------- */}
      {resultView && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && setResultView(null)}>
          <section className="modal-card" role="dialog" aria-modal="true">
            <button className="modal-close" type="button" onClick={() => setResultView(null)} aria-label="关闭">×</button>
            <span className="modal-kicker">监控结果</span>
            <h2>{resultView.name}</h2>
            <pre style={{ whiteSpace: "pre-wrap", fontSize: 13, background: "#f7f6f2", padding: 10, borderRadius: 8, maxHeight: 420, overflow: "auto" }}>{resultView.content}</pre>
          </section>
        </div>
      )}

      {/* ---------- 诊断 / 高级 ---------- */}
      <details className="xianyu-diagnostic">
        <summary>诊断 / 高级（打开原工具界面）</summary>
        <div>
          <a href={GF} target="_blank" rel="noreferrer">打开监控引擎原界面</a>
          <a href={RF} target="_blank" rel="noreferrer">打开多账号引擎原界面</a>
          <span className="listener-managed-label">XianyuAutoAgent：备选 / 未启动（与多账号同账号互斥）</span>
        </div>
      </details>
    </>
  );
}

function EmptyRing({ value, label }: { value: string; label: string }) {
  return (
    <div className="ring-stat" aria-label={`${label} ${value}`}>
      <div className="ring-stat-inner"><strong>{value}</strong><span>{label}</span></div>
    </div>
  );
}
