"use client";

/* 织台统一 API 通道（窄 IPC / 浏览器直连双模式）
 * 桌面版：window.zhitaiBridge 存在 → 走主进程白名单代理（17890/8000/18090/17900）
 * 浏览器：直连 fetch（可能被 CORS 拦截，用桌面版更完整）
 *
 * 会话令牌：reply-fix 管理登录 token 只保存在本模块内存（本次应用会话内），
 * 不写入 localStorage / 文件；后续 18090 请求自动带 Authorization: Bearer。
 */

export type DesktopServiceState = {
  id: string;
  label: string;
  port: number | null;
  url: string | null;
  online: boolean;
  owned: boolean;
  onDemand?: boolean;
  error: string | null;
};

export type ApiResult<T = unknown> = {
  ok: boolean;
  status: number;
  body: T | null;
  error?: string;
  mime?: string; // binary 响应时的 Content-Type
  captchaId?: string; // 验证码图片的 X-Captcha-Id
};

export type ZapiOptions = {
  timeoutMs?: number;
  binary?: boolean;
  noAuth?: boolean; // 显式不带 Bearer（如登录接口本身）
  confirmedAction?: boolean; // 用户已在织台对真实发布动作二次确认
};

export type RuntimeConditionState = "ready" | "attention" | "unknown" | "optional";
export type RuntimeIngressRole = "primary" | "fallback";

export type RuntimeCondition = {
  id: string;
  label: string;
  state: RuntimeConditionState;
  reason: string;
  checkedAt: string | null;
  optional: boolean;
  ingressRole: RuntimeIngressRole | null;
  actionView?: string | null;
};

export type RuntimeConditionsResponse = {
  ok: boolean;
  checkedAt: string | null;
  summary: {
    state: "ready" | "attention" | "unknown";
    readyCount: number;
    attentionCount: number;
    unknownCount: number;
  };
  conditions: RuntimeCondition[];
  backlog: {
    analysis: {
      total: number;
      queued: number;
      running: number;
      retryWait: number;
      completed: number;
      needsAttention: number;
      remaining: number;
    };
    creative: {
      waiting: number;
      waitingForImages?: number;
      waitingForSeedance?: number;
      waitingForAssembly?: number;
      preparing?: number;
      paused?: number;
      failed?: number;
      completed: number;
    };
  };
};

declare global {
  interface Window {
    zhitaiBridge?: {
      isDesktop: boolean;
      getServices(): Promise<DesktopServiceState[]>;
      onServicesChanged(cb: (states: DesktopServiceState[]) => void): void;
      api(url: string, method: string, body?: unknown, headers?: Record<string, string>, timeoutMs?: number, binary?: boolean): Promise<ApiResult>;
      openCreativeStudio(provider: "gpt" | "seedance" | "x" | "yuanbao", accountId?: string): Promise<{ ok: boolean; error?: string }>;
      runCreativeJob(jobId: string, assetId: string, accountIds?: string[]): Promise<{ ok: boolean; status: string; error?: string; finalVideo?: string }>;
      syncXBookmarks(interactive?: boolean): Promise<{ ok: boolean; status: string; error?: string; fetched?: number; imported?: number; total?: number }>;
      checkRuntimeConditions?(accountIds: string[], refresh?: boolean): Promise<RuntimeConditionsResponse>;
    };
  }
}

export function isDesktop(): boolean {
  return typeof window !== "undefined" && Boolean(window.zhitaiBridge?.isDesktop);
}

export async function openCreativeStudio(provider: "gpt" | "seedance" | "x" | "yuanbao", accountId?: string): Promise<{ ok: boolean; error?: string }> {
  if (typeof window !== "undefined" && window.zhitaiBridge?.openCreativeStudio) {
    return window.zhitaiBridge.openCreativeStudio(provider, accountId);
  }
  if (typeof window !== "undefined") {
    const url = provider === "gpt" ? "https://chatgpt.com/" : provider === "x" ? "https://x.com/i/bookmarks" : provider === "yuanbao" ? "https://yuanbao.tencent.com/chat/naQivTmsDa" : "https://www.doubao.com/chat/";
    window.open(url, "_blank", "noopener,noreferrer");
    return { ok: true };
  }
  return { ok: false, error: "当前环境不能打开创作窗口" };
}

export async function syncXBookmarks(interactive = true): Promise<{ ok: boolean; status: string; error?: string; fetched?: number; imported?: number; total?: number }> {
  if (typeof window !== "undefined" && window.zhitaiBridge?.syncXBookmarks) {
    return window.zhitaiBridge.syncXBookmarks(interactive);
  }
  if (interactive) await openCreativeStudio("x");
  return { ok: false, status: "desktop_required", error: "X 收藏自动同步仅支持织台 App" };
}

export async function runCreativeJob(jobId: string, assetId: string, accountIds?: string[]): Promise<{ ok: boolean; status: string; error?: string; finalVideo?: string }> {
  if (typeof window !== "undefined" && window.zhitaiBridge?.runCreativeJob) {
    return window.zhitaiBridge.runCreativeJob(jobId, assetId, accountIds);
  }
  return { ok: false, status: "desktop_required", error: "一键无人值守生成仅支持织台 App" };
}

export async function checkRuntimeConditions(accountIds: string[] = [], refresh = false): Promise<RuntimeConditionsResponse> {
  if (typeof window !== "undefined" && window.zhitaiBridge?.checkRuntimeConditions) {
    return window.zhitaiBridge.checkRuntimeConditions(accountIds.slice(0, 8), refresh);
  }

  const query = refresh ? "?refresh=1" : "";
  const result = await zapi<RuntimeConditionsResponse>(
    `http://127.0.0.1:17890/api/v1/runtime-conditions${query}`,
    "GET",
    undefined,
    { timeoutMs: refresh ? 120_000 : 10_000 },
  );
  if (!result.ok || !result.body) {
    throw new Error(apiErrorText(result) || `运行条件暂时不可用（HTTP ${result.status}）`);
  }
  return result.body;
}

// ---- 会话内令牌（仅内存）----
let sessionToken: string | null = null;

export function setSessionToken(token: string | null): void {
  sessionToken = token && token.trim() ? token.trim() : null;
}

export function getSessionToken(): string | null {
  return sessionToken;
}

function buildHeaders(opts: ZapiOptions | undefined): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (sessionToken && !opts?.noAuth) headers.Authorization = "Bearer " + sessionToken;
  if (opts?.confirmedAction) headers["X-Zhitai-Action"] = "confirm";
  return headers;
}

export async function zapi<T = unknown>(url: string, method = "GET", body?: unknown, opts?: ZapiOptions | number): Promise<ApiResult<T>> {
  const options: ZapiOptions = typeof opts === "number" ? { timeoutMs: opts } : (opts ?? {});
  const headers = buildHeaders(options);
  if (typeof window !== "undefined" && window.zhitaiBridge) {
    return window.zhitaiBridge.api(url, method, body, headers, options.timeoutMs, options.binary) as Promise<ApiResult<T>>;
  }
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
    });
    if (options.binary) {
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      const b64 = typeof btoa === "function" ? btoa(bin) : Buffer.from(bytes).toString("base64");
      return {
        ok: res.ok,
        status: res.status,
        body: b64 as T,
        mime: res.headers.get("content-type") || "application/octet-stream",
        captchaId: res.headers.get("x-captcha-id") || undefined,
      };
    }
    const text = await res.text().catch(() => "");
    let data: unknown = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { ok: res.ok, status: res.status, body: data as T };
  } catch (e) {
    return { ok: false, status: 0, body: null, error: "引擎不可达（" + (e instanceof Error ? e.message : String(e)) + "）" };
  }
}

export function apiErrorText(r: ApiResult): string {
  if (r.error) return r.error;
  if (!r.ok) {
    const payload = r.body && typeof r.body === "object" ? r.body as Record<string, unknown> : null;
    const detail = String(payload?.message || payload?.detail || payload?.error || "").trim();
    const known: Record<string, string> = {
      content_type_must_be_json: "请求格式不兼容，请刷新织台后重试",
      origin_not_allowed: "当前页面来源未获本地节点允许，请从织台 App 内操作",
    };
    if (known[detail]) return known[detail];
    if (r.status === 401 || r.status === 403) return "登录态或权限无效，请重新登录";
    if (r.status === 404) return "当前模块接口不匹配，请先更新该模块";
    if (r.status === 415) return "请求格式不兼容（HTTP 415），请刷新织台后重试";
    if (r.status === 429) return "操作过于频繁，请稍后重试";
    if (r.status === 502 || r.status === 504) return "模块暂时无响应，请稍后重试";
    if (detail) return detail;
    return "请求失败（HTTP " + r.status + "）";
  }
  return "";
}
