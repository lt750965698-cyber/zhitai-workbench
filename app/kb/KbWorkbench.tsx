"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

/* 织台 · 短视频知识库 MVP
 * 三源分离：本地媒体(media) / 平台帖子(post) / 内容分析(analysis)
 * 原则：平台指标绝不从 MP4 推断；「为什么火」只作证据型假设（非因果）。
 */

const API = "http://127.0.0.1:17890/api/v1/kb";
const LOCAL_AGENT = "http://127.0.0.1:17890";

type View = "dashboard" | "library" | "import" | "detail";

type KbStats = {
  total: number;
  withPlatform: number;
  withAnalysis: number;
  failed: number;
  byCategory: Record<string, number>;
  totalDurationSec: number;
  mediaCoverage: number;
};

type VideoItem = {
  id: string;
  title: string;
  category: string;
  author: string | null;
  publish_time: string | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  size_bytes: number | null;
  plays: number | null;
  likes: number | null;
  comments: number | null;
  favorites: number | null;
  shares: number | null;
  source_url: string | null;
  sha256: string | null;
  created_at: string | null;
  analysis: { confidence: string | null; source: string | null };
  virality: string | null;
  channel: string | null;
  observed_channel: string | null;
  media_validation: string | null;
  fallback_reason: string | null;
};

type ImportItem = {
  id: number;
  displayInput: string;
  input_kind: string;
  status: string;
  error: string | null;
  retry_count: number;
  asset_id: string | null;
};
type ImportBatch = {
  id: string;
  status: string;
  source_kind: string;
  created_at: string;
  total: number;
  succeeded: number;
  failed: number;
  skipped: number;
};

type PlatformPost = {
  id: number;
  content_id: string | null;
  post_id: string | null;
  url: string | null;
  author: string | null;
  publish_time: string | null;
  title: string | null;
  topics: string[] | null;
  music: string | null;
  cover_url: string | null;
  platform: string | null;
  plays: number | null;
  likes: number | null;
  comments: number | null;
  favorites: number | null;
  shares: number | null;
  fetched_at: string | null;
};

type KbAsset = {
  id: string;
  title: string | null;
  category: string | null;
  sha256: string | null;
  duration_ms: number | null;
  width: number | null;
  height: number | null;
  codec_video: string | null;
  codec_audio: string | null;
  size_bytes: number | null;
  channel: string | null;
  media_validation: string | null;
  fallback_reason: string | null;
  created_at: string | null;
  source_url: string | null;
};
type ContentAnalysis = {
  summary: string | null;
  key_points: string[] | null;
  hook_3s: string | null;
  structure: Record<string, boolean> | null;
  cta: string | null;
  audience: string[] | null;
  reusable_pattern: string[] | null;
  limitation: string | null;
  confidence: string | null;
  source: string | null;
};
type ViralityHypothesis = { claim: string; evidence: string; counter_evidence?: string; confidence: string; limitations: string[] };
type ViralityAnalysis = { hypotheses: ViralityHypothesis[] | null; note: string | null };
type TranscriptRecord = { status: string | null; note: string | null; text: string | null };
type OcrRecord = { status: string | null; note: string | null };
type CorrectionRecord = { id: number; field: string; old_value: string | null; new_value: string | null; reason: string | null; corrected_at: string | null };

type Detail = {
  asset: KbAsset;
  metadata_source: string | null;
  platform_posts: PlatformPost[];
  latest_post: PlatformPost | null;
  content_analysis: ContentAnalysis | null;
  virality_analysis: ViralityAnalysis | null;
  transcript: TranscriptRecord | null;
  ocr: OcrRecord | null;
  shots: { id: number; start_ms: number | null; end_ms: number | null; shot_size: string | null; scene: string | null }[];
  metric_snapshots: { id: number; captured_at: string; likes: number | null; likes_raw: string | null }[];
  field_provenance: { id: number; field: string; source: string; available: number; confidence: string; limitation: string }[];
  knowledge_chunks: unknown[];
  corrections: CorrectionRecord[];
};


async function getJson(url: string) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

function fmtSec(ms: number | null): string {
  if (ms == null) return "未知";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function fmtBytes(b: number | null): string {
  if (b == null) return "未知";
  return b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`;
}
function fmtDate(v: string | null): string {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString("zh-CN", { hour12: false });
}
function fmtNum(v: number | null): string {
  return v == null ? "null" : String(v);
}

const confColor: Record<string, string> = {
  high: "bg-emerald-100 text-emerald-800 border-emerald-300",
  medium: "bg-amber-100 text-amber-800 border-amber-300",
  low: "bg-orange-100 text-orange-800 border-orange-300",
};
const srcColor: Record<string, string> = {
  local_media: "bg-sky-100 text-sky-800 border-sky-300",
  yuanbao_api: "bg-violet-100 text-violet-800 border-violet-300",
  platform_api: "bg-cyan-100 text-cyan-800 border-cyan-300",
  rule_inference: "bg-orange-100 text-orange-800 border-orange-300",
  unavailable: "bg-slate-100 text-slate-600 border-slate-300",
  manual: "bg-lime-100 text-lime-800 border-lime-300",
};

function Badge({ text, cls }: { text: string; cls: string }) {
  return <span className={`inline-block rounded-full border px-2 py-0.5 text-xs font-medium ${cls}`}>{text}</span>;
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
      <div className="text-xs text-stone-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-stone-900">{value}</div>
      {sub ? <div className="mt-0.5 text-xs text-stone-400">{sub}</div> : null}
    </div>
  );
}

export function KbWorkbench() {
  const [view, setView] = useState<View>("dashboard");
  const [stats, setStats] = useState<KbStats | null>(null);
  const [videos, setVideos] = useState<VideoItem[]>([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState("");
  const [category, setCategory] = useState("");
  const [sort, setSort] = useState("created_at");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [importText, setImportText] = useState("");
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [failedItems, setFailedItems] = useState<ImportItem[]>([]);
  const [pendingItems, setPendingItems] = useState<ImportItem[]>([]);
  const [nodeOk, setNodeOk] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState("");

  const notify = useCallback((m: string) => {
    setToast(m);
    setTimeout(() => setToast(""), 2600);
  }, []);

  const loadStats = useCallback(async () => {
    try { setStats((await getJson(`${API}/stats`)).stats); } catch { setStats(null); }
  }, []);

  const loadVideos = useCallback(async () => {
    try {
      const p = new URLSearchParams();
      if (q) p.set("q", q);
      if (category) p.set("category", category);
      p.set("sort", sort);
      const j = await getJson(`${API}/videos?${p}`);
      setVideos(j.items);
      setTotal(j.total);
    } catch { setVideos([]); setTotal(0); }
  }, [q, category, sort]);

  const loadImports = useCallback(async () => {
    try {
      const j = await getJson(`${API}/imports`);
      setBatches(j.batches);
      setFailedItems(j.items.filter((i: ImportItem) => i.status === "failed"));
      setPendingItems(j.items.filter((i: ImportItem) => i.status === "pending"));
    } catch { /* ignore */ }
  }, []);

  const loadDetail = useCallback(async (id: string) => {
    try { setDetail(await getJson(`${API}/videos/${id}`)); } catch { setDetail(null); }
  }, []);

  useEffect(() => {
    fetch(`${LOCAL_AGENT}/health`).then((r) => r.json().then((j) => setNodeOk(!!j.ok))).catch(() => setNodeOk(false));
    // load* 内的 setState 均发生在 fetch 回调之后，非同步级联渲染
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadStats();
     
    void loadVideos();
     
    void loadImports();
  }, [loadStats, loadVideos, loadImports]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (view === "detail" && detailId) void loadDetail(detailId);
  }, [view, detailId, loadDetail]);

  const doImport = useCallback(async () => {
    const lines = importText.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!lines.length) { notify("请输入链接或文件路径，每行一条"); return; }
    const links = lines.filter((l) => /^https?:\/\//i.test(l));
    const files = lines.filter((l) => !/^https?:\/\//i.test(l));
    setBusy(true);
    try {
      const r = await fetch(`${API}/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ links, files }),
      });
      if (r.ok) {
        notify(`已提交 ${lines.length} 条导入（链接 ${links.length} / 文件 ${files.length}）`);
        setImportText("");
        setTimeout(() => { loadImports(); loadVideos(); loadStats(); }, 6000);
      } else notify("提交失败");
    } catch { notify("节点未连接"); }
    setBusy(false);
  }, [importText, loadImports, loadVideos, loadStats, notify]);

  const retry = useCallback(async (itemId: number) => {
    try {
      const r = await fetch(`${API}/imports/${itemId}/retry`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      const body = await r.json().catch(() => ({}));
      if (r.ok) {
        notify("已加入重试队列");
        setTimeout(loadImports, 4000);
      } else {
        notify(`重试失败：${(body as { message?: string }).message || (body as { error?: string }).error || `HTTP ${r.status}`}`);
      }
    } catch { notify("节点未连接，重试失败"); }
  }, [loadImports, notify]);

  const doExport = useCallback((format: string) => {
    window.open(`${API}/export?format=${format}`, "_blank");
  }, []);

  const doCorrect = useCallback(async (field: string, value: string) => {
    if (!detail) return;
    const reason = window.prompt(`修正「${field}」的原因（可选）：`, "人工核对");
    if (reason === null) return;
    try {
      const r = await fetch(`${API}/videos/${detail.asset.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ field, value, reason: reason || "manual" }),
      });
      if (r.ok) { notify("已修正并记录历史"); loadDetail(detail.asset.id); loadVideos(); }
      else notify("修正失败");
    } catch { notify("节点未连接"); }
  }, [detail, loadDetail, loadVideos, notify]);

  const navTab = (id: View, label: string, icon: string) => (
    <button
      onClick={() => { setView(id); if (id === "detail") setDetailId(null); }}
      className={`rounded-lg px-3 py-1.5 text-sm font-medium transition ${view === id ? "bg-stone-900 text-white" : "text-stone-600 hover:bg-stone-200"}`}
      type="button"
    >
      {icon} {label}
    </button>
  );

  const prov = detail?.field_provenance || [];

  return (
    <div className="min-h-screen bg-stone-100">
      <header className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-3">
            <span className="rounded-lg bg-stone-900 px-2.5 py-1 text-sm font-bold text-white">织台</span>
            <div>
              <div className="text-base font-semibold text-stone-900">短视频知识库</div>
              <div className="text-xs text-stone-500">三源分离 · 证据化分析 · 可搜索可复用</div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className={`h-2 w-2 rounded-full ${nodeOk === false ? "bg-red-500" : nodeOk ? "bg-emerald-500" : "bg-amber-400"}`} />
            <span className="text-xs text-stone-500">{nodeOk === false ? "本地节点离线" : nodeOk ? "节点在线 17890" : "检测中…"}</span>
            <Link href="/" className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm text-stone-600 hover:bg-stone-100">← 返回主工作台</Link>
          </div>
        </div>
      </header>

      {toast ? <div className="fixed right-4 top-4 z-50 rounded-lg bg-stone-900 px-4 py-2 text-sm text-white shadow-lg">{toast}</div> : null}

      <nav className="border-b border-stone-200 bg-white">
        <div className="mx-auto flex max-w-6xl gap-2 px-4 py-2">
          {navTab("dashboard", "仪表盘", "▦")}
          {navTab("library", "视频库", "☰")}
          {navTab("import", "批量导入", "↓")}
        </div>
      </nav>

      <main className="mx-auto max-w-6xl px-4 py-6">
        {view === "dashboard" ? (
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
              <StatCard label="视频总数" value={stats?.total ?? "—"} sub={`媒体探测覆盖率 ${stats?.mediaCoverage ?? 0}%`} />
              <StatCard label="含平台数据" value={stats?.withPlatform ?? "—"} sub="作者/发布时间/互动快照" />
              <StatCard label="已分析" value={stats?.withAnalysis ?? "—"} sub="规则推断（低置信标注）" />
              <StatCard label="失败队列" value={stats?.failed ?? "—"} sub="可重试（最多 3 次）" />
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
                <div className="mb-3 text-sm font-semibold text-stone-800">分类分布</div>
                {Object.keys(stats?.byCategory || {}).length ? (
                  <div className="space-y-2">
                    {Object.entries(stats!.byCategory).map(([k, v]) => (
                      <div key={k} className="flex items-center gap-2">
                        <span className="w-12 text-sm text-stone-600">{k}</span>
                        <div className="h-2.5 flex-1 rounded bg-stone-200">
                          <div className="h-2.5 rounded bg-stone-800" style={{ width: `${stats!.total ? (v / stats!.total) * 100 : 0}%` }} />
                        </div>
                        <span className="text-sm font-medium text-stone-700">{v}</span>
                      </div>
                    ))}
                  </div>
                ) : <div className="text-sm text-stone-400">暂无数据，去「批量导入」添加第一条视频</div>}
              </div>
              <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
                <div className="mb-3 text-sm font-semibold text-stone-800">数据原则</div>
                <ul className="space-y-1.5 text-xs leading-relaxed text-stone-600">
                  <li>• 媒体字段（时长/分辨率/编码）＝ 本地 mdls 实测，高置信</li>
                  <li>• 平台字段（作者/互动/发布时间）＝ 元宝接口快照；播放量接口未提供 → 一律 null，绝不从 MP4 推断</li>
                  <li>• 内容分析（钩子/结构/受众）＝ 规则推断，低置信，明确标注「未看画面/音频」</li>
                  <li>• 「为什么火」＝ 证据型假设（收藏&gt;点赞等），无留存/流量来源 → 仅「潜在分发因素」</li>
                  <li>• ASR/OCR/镜头切分：当前接口不可用 → 置 null，接入后可重跑分析</li>
                </ul>
              </div>
            </div>
          </div>
        ) : null}

        {view === "library" ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="搜索标题 / 链接…"
                className="w-64 rounded-lg border border-stone-300 px-3 py-1.5 text-sm outline-none focus:border-stone-500"
              />
              <select value={category} onChange={(e) => setCategory(e.target.value)} className="rounded-lg border border-stone-300 px-2 py-1.5 text-sm">
                <option value="">全部分类</option>
                <option value="素材">素材</option>
                <option value="技能">技能</option>
                <option value="其他">其他</option>
              </select>
              <select value={sort} onChange={(e) => setSort(e.target.value)} className="rounded-lg border border-stone-300 px-2 py-1.5 text-sm">
                <option value="created_at">按入库时间</option>
                <option value="duration">按时长</option>
                <option value="likes">按点赞</option>
              </select>
              <button onClick={() => { loadVideos(); }} className="rounded-lg bg-stone-900 px-3 py-1.5 text-sm text-white">查询</button>
              <div className="ml-auto flex gap-2">
                <button onClick={() => doExport("json")} className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100">导出 JSON</button>
                <button onClick={() => doExport("csv")} className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm hover:bg-stone-100">导出 CSV</button>
              </div>
            </div>
            <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white shadow-sm">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-stone-200 text-left text-xs text-stone-500">
                    <th className="px-3 py-2">标题</th>
                    <th className="px-3 py-2">分类</th>
                    <th className="px-3 py-2">渠道</th>
                    <th className="px-3 py-2">验证</th>
                    <th className="px-3 py-2">作者</th>
                    <th className="px-3 py-2">时长</th>
                    <th className="px-3 py-2">点赞</th>
                    <th className="px-3 py-2">收藏</th>
                    <th className="px-3 py-2">分析</th>
                    <th className="px-3 py-2">病毒性</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {videos.map((v) => (
                    <tr key={v.id} className="border-b border-stone-100 hover:bg-stone-50">
                      <td className="max-w-[240px] truncate px-3 py-2 font-medium text-stone-800">{v.title || "（无标题）"}</td>
                      <td className="px-3 py-2"><span className="rounded bg-stone-100 px-1.5 py-0.5 text-xs">{v.category}</span></td>
                      <td className="px-3 py-2">
                        {(v.observed_channel || v.channel) ? <Badge text={(v.observed_channel || v.channel) === "kuaidian" ? "快点已验证" : (v.observed_channel || v.channel) === "mandian_fallback" ? "慢点回退" : (v.observed_channel || v.channel) === "mandian" ? "慢点" : (v.observed_channel || v.channel) === "yuanbao_fallback" ? "回退·元宝" : (v.observed_channel || v.channel) === "legacy_migration" ? "旧库迁移" : String(v.observed_channel || v.channel)} cls={(v.observed_channel || v.channel) === "kuaidian" ? "bg-lime-100 text-lime-800 border-lime-300" : (v.observed_channel || v.channel) === "yuanbao_fallback" ? "bg-orange-100 text-orange-800 border-orange-300" : "bg-stone-100 text-stone-600 border-stone-300"} /> : <span className="text-xs text-stone-300">—</span>}
                        {v.fallback_reason ? <div className="mt-0.5 text-[10px] text-orange-600">fallback: {v.fallback_reason}</div> : null}
                      </td>
                      <td className="px-3 py-2">
                        {v.media_validation ? <Badge text={v.media_validation === "ok" ? "✓可播放" : v.media_validation === "encrypted" ? "⚠加密流" : v.media_validation} cls={v.media_validation === "ok" ? "bg-emerald-100 text-emerald-800 border-emerald-300" : v.media_validation === "encrypted" ? "bg-red-100 text-red-800 border-red-300" : "bg-stone-100 text-stone-500 border-stone-300"} /> : <span className="text-xs text-stone-300">—</span>}
                      </td>
                      <td className="px-3 py-2 text-stone-600">{v.author || "本地"}</td>
                      <td className="px-3 py-2 text-stone-600">{fmtSec(v.duration_ms)}</td>
                      <td className="px-3 py-2 text-stone-600">{fmtNum(v.likes)}</td>
                      <td className="px-3 py-2 text-stone-600">{fmtNum(v.favorites)}</td>
                      <td className="px-3 py-2">
                        {v.analysis?.source ? <Badge text={`${v.analysis.source}·${v.analysis.confidence}`} cls={confColor[v.analysis.confidence || "low"] || confColor.low} /> : <span className="text-xs text-stone-300">—</span>}
                      </td>
                      <td className="px-3 py-2">
                        {v.virality ? <Badge text={v.virality === "potential_distribution_factors" ? "潜在传播因素" : v.virality} cls="bg-sky-100 text-sky-800 border-sky-300" /> : <span className="text-xs text-stone-300">—</span>}
                      </td>
                      <td className="px-3 py-2">
                        <button onClick={() => { setDetailId(v.id); setView("detail"); }} className="rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-100">详情</button>
                      </td>
                    </tr>
                  ))}
                  {!videos.length ? <tr><td colSpan={9} className="px-3 py-8 text-center text-stone-400">暂无视频，去「批量导入」添加</td></tr> : null}
                </tbody>
              </table>
              <div className="px-3 py-2 text-xs text-stone-400">共 {total} 条</div>
            </div>
          </div>
        ) : null}

        {view === "import" ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
              <div className="mb-2 text-sm font-semibold text-stone-800">批量导入</div>
              <p className="mb-2 text-xs text-stone-500">每行一条：视频号分享链接（sph/sf）或本地 mp4 绝对路径。分享链接等待原版快点产出直链，元宝只补元数据（不负责下载）；文件走本地探测；重复 sha256 自动跳过。</p>
              <textarea
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                rows={7}
                placeholder={"https://weixin.qq.com/sph/xxx\n/Users/.../视频.mp4"}
                className="w-full rounded-lg border border-stone-300 p-2.5 font-mono text-xs outline-none focus:border-stone-500"
              />
              <button onClick={doImport} disabled={busy} className="mt-2 rounded-lg bg-stone-900 px-4 py-2 text-sm text-white disabled:opacity-50">
                {busy ? "提交中…" : "开始导入"}
              </button>
              <div className="mt-3 text-xs text-stone-500">导入异步进行：分享链接先登记为「等待原版快点产出」（awaiting_primary_download），原版快点+伴生桥产出直链后自动入库；失败项可重试（最多 3 次）。</div>
            </div>
            <div className="space-y-4">
              <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
                <div className="mb-2 text-sm font-semibold text-stone-800">最近批次</div>
                {batches.length ? batches.slice(0, 6).map((b) => (
                  <div key={b.id} className="mb-1.5 flex items-center gap-2 text-xs">
                    <span className={`rounded px-1.5 py-0.5 ${b.status === "done" ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-700"}`}>{b.status === "done" ? "完成" : "进行中"}</span>
                    <span className="text-stone-500">{b.source_kind}</span>
                    <span className="text-stone-600">✓{b.succeeded} ✗{b.failed} ⤳{b.skipped}</span>
                    <span className="ml-auto text-stone-400">{fmtDate(b.created_at)}</span>
                  </div>
                )) : <div className="text-xs text-stone-400">暂无批次</div>}
              </div>
              <div className="rounded-xl border border-red-200 bg-white p-4 shadow-sm">
                <div className="mb-2 text-sm font-semibold text-red-700">失败队列（{failedItems.length}）</div>
                {failedItems.length ? failedItems.slice(0, 10).map((i) => (
                  <div key={i.id} className="mb-1.5 flex items-center gap-2 text-xs">
                    <span className="max-w-[200px] truncate font-mono text-stone-600">{i.displayInput.slice(0, 42)}</span>
                    <span className="truncate text-red-500">{i.error?.slice(0, 40)}</span>
                    <span className="text-stone-400">重试{i.retry_count}/3</span>
                    <button onClick={() => retry(i.id)} disabled={i.retry_count >= 3} className="ml-auto rounded border border-stone-300 px-2 py-0.5 hover:bg-stone-100 disabled:opacity-40">重试</button>
                  </div>
                )) : <div className="text-xs text-stone-400">无失败项</div>}
              </div>
              <div className="rounded-xl border border-amber-200 bg-white p-4 shadow-sm">
                <div className="mb-2 text-sm font-semibold text-amber-700">等待原版快点产出（{pendingItems.length}）</div>
                {pendingItems.length ? pendingItems.slice(0, 8).map((i) => (
                  <div key={i.id} className="mb-1.5 flex items-center gap-2 text-xs">
                    <span className="max-w-[200px] truncate font-mono text-stone-600">{i.displayInput.slice(0, 42)}</span>
                    <span className="truncate text-amber-600">{(i.error || "awaiting_primary_download").slice(0, 48)}</span>
                  </div>
                )) : <div className="text-xs text-stone-400">无等待项</div>}
              </div>
            </div>
          </div>
        ) : null}

        {view === "detail" && detail ? (
          <div className="space-y-4">
            <button onClick={() => { setView("library"); }} className="text-sm text-stone-500 hover:text-stone-800">← 返回视频库</button>
            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
                <video controls src={`${API}/videos/${detail.asset.id}/media`} className="w-full rounded-lg bg-black" style={{ maxHeight: 420 }} /* eslint-disable-line jsx-a11y/media-has-caption -- 无真实字幕轨（ASR 未接入），不挂空 track */ />
                <div className="mt-3">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="text-base font-semibold text-stone-900">{detail.asset.title || "（无标题）"}</h2>
                    <button
                      onClick={() => { const t = window.prompt("修正标题：", detail.asset.title || ""); if (t !== null) doCorrect("title", t); }}
                      className="shrink-0 rounded border border-stone-300 px-2 py-1 text-xs hover:bg-stone-100"
                    >修正标题</button>
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5">
                    <Badge text={`分类 ${detail.asset.category || "其他"}`} cls="bg-stone-100 text-stone-700 border-stone-300" />
                    {detail.metadata_source ? <Badge text={`元数据 ${detail.metadata_source === "yuanbao_enrich" ? "元宝已补" : detail.metadata_source === "legacy_metadata" ? "旧库" : "本地"}`} cls={detail.metadata_source === "yuanbao_enrich" ? "bg-sky-100 text-sky-800 border-sky-300" : "bg-stone-100 text-stone-500 border-stone-300"} /> : null}
                    {detail.latest_post?.author ? <Badge text={`作者 ${detail.latest_post.author}`} cls="bg-violet-100 text-violet-800 border-violet-300" /> : null}
                    {detail.asset.sha256 ? <Badge text={`sha256 ${detail.asset.sha256.slice(0, 12)}…`} cls="bg-stone-100 text-stone-500 border-stone-300" /> : null}
                    {detail.asset.duration_ms ? <Badge text={`${fmtSec(detail.asset.duration_ms)}`} cls="bg-stone-100 text-stone-700 border-stone-300" /> : null}
                  </div>
                </div>
              </div>
              <div className="space-y-4">
                <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
                  <div className="mb-2 text-sm font-semibold text-stone-800">媒体信息（本地实测）</div>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                    {[
                      ["时长", detail.asset.duration_ms ? fmtSec(detail.asset.duration_ms) : "null（加密流或未知）"],
                      ["分辨率", detail.asset.width && detail.asset.height ? `${detail.asset.width}×${detail.asset.height}` : "null"],
                      ["编码", detail.asset.codec_video ? `${detail.asset.codec_video} / ${detail.asset.codec_audio || ""}` : "null"],
                      ["大小", fmtBytes(detail.asset.size_bytes)],
                    ].map(([k, v]) => (
                      <div key={k} className="flex justify-between border-b border-stone-100 py-1">
                        <span className="text-stone-500">{k}</span><span className="font-medium text-stone-800">{v}</span>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
                  <div className="mb-2 text-sm font-semibold text-stone-800">平台帖子（元宝接口快照 · {detail.platform_posts?.length || 0} 个）</div>
                  {detail.platform_posts?.length ? (
                    <div className="space-y-3">
                      {detail.platform_posts.map((post, idx) => (
                        <div key={post.id} className="rounded-lg border border-stone-100 p-2.5">
                          <div className="mb-1 text-xs text-stone-400">帖子 {idx + 1}{idx === 0 ? "（最新）" : ""} · {fmtDate(post.fetched_at)}</div>
                          <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
                            {[
                              ["作者", post.author || "null"],
                              ["发布时间", fmtDate(post.publish_time)],
                              ["播放量", fmtNum(post.plays)],
                              ["点赞", fmtNum(post.likes)],
                              ["收藏", fmtNum(post.favorites)],
                              ["转发", fmtNum(post.shares)],
                              ["评论", fmtNum(post.comments)],
                              ["话题", (post.topics || []).length ? (post.topics || []).join(" ") : "null"],
                            ].map(([k, v]) => (
                              <div key={k} className="flex justify-between border-b border-stone-100 py-1">
                                <span className="text-stone-500">{k}</span><span className="font-medium text-stone-800">{v}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : <div className="text-sm text-stone-400">本地文件导入，无平台数据（不推断）</div>}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-stone-800">
                  内容分析
                  {detail.content_analysis?.source ? <Badge text={`${detail.content_analysis.source}`} cls={srcColor[detail.content_analysis.source] || "bg-stone-100 text-stone-600 border-stone-300"} /> : null}
                  {detail.content_analysis?.confidence ? <Badge text={`置信度 ${detail.content_analysis.confidence}`} cls={confColor[detail.content_analysis.confidence] || confColor.low} /> : null}
                </div>
                {detail.content_analysis ? (
                  <div className="space-y-2 text-sm">
                    <div><span className="text-stone-500">前3秒钩子：</span><span className="text-stone-800">{detail.content_analysis.hook_3s}</span></div>
                    <div><span className="text-stone-500">结构线索：</span><span className="text-stone-800">{Object.entries(detail.content_analysis.structure || {}).filter(([, v]) => v).map(([k]) => k).join("、") || "—"}</span></div>
                    <div><span className="text-stone-500">CTA：</span><span className="text-stone-800">{detail.content_analysis.cta}</span></div>
                    <div><span className="text-stone-500">受众：</span><span className="text-stone-800">{(detail.content_analysis.audience || []).join("、")}</span></div>
                    <div><span className="text-stone-500">可复用模式：</span><span className="text-stone-800">{(detail.content_analysis.reusable_pattern || []).join("；") || "—"}</span></div>
                    {detail.content_analysis.limitation ? <div className="mt-2 rounded bg-amber-50 px-2 py-1.5 text-xs text-amber-800">{detail.content_analysis.limitation}</div> : null}
                  </div>
                ) : <div className="text-sm text-stone-400">未分析</div>}
              </div>
              <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
                <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-stone-800">
                  病毒性分析
                  {detail.virality_analysis ? <Badge text="证据型假设·非因果" cls="bg-sky-100 text-sky-800 border-sky-300" /> : null}
                </div>
                {detail.virality_analysis && (detail.virality_analysis.hypotheses || []).length ? (
                  <div className="space-y-2">
                    {(detail.virality_analysis.hypotheses || []).map((h: ViralityHypothesis, i: number) => (
                      <div key={i} className="rounded-lg border border-stone-200 p-2.5 text-sm">
                        <div className="font-medium text-stone-800">{h.claim}</div>
                        <div className="mt-1 text-xs text-stone-500">证据：{h.evidence}</div>
                        {h.counter_evidence ? <div className="mt-0.5 text-xs text-red-500">反证：{h.counter_evidence}</div> : null}
                        <div className="mt-1 flex items-center gap-1.5">
                          <Badge text={`置信度 ${h.confidence}`} cls={confColor[h.confidence] || confColor.low} />
                          {(h.limitations || []).map((l: string) => <Badge key={l} text={l} cls="bg-stone-100 text-stone-500 border-stone-300" />)}
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-sm text-stone-400">{detail.virality_analysis?.note || "无互动数据，不产生因果结论"}</div>
                )}
                {detail.virality_analysis?.note ? <div className="mt-2 rounded bg-sky-50 px-2 py-1.5 text-xs text-sky-800">{detail.virality_analysis.note}</div> : null}
              </div>
            </div>

            <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
              <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
                <div className="mb-2 text-sm font-semibold text-stone-800">字幕转写（ASR）</div>
                {detail.transcript?.status === "unavailable" ? (
                  <div className="rounded bg-stone-50 px-3 py-2.5 text-sm text-stone-500">
                    <span className="mb-1 block font-medium text-stone-600">unavailable</span>
                    {detail.transcript.note}
                  </div>
                ) : detail.transcript?.text ? (
                  <div className="text-sm text-stone-800">{detail.transcript.text}</div>
                ) : <div className="text-sm text-stone-400">无转写数据</div>}
              </div>
              <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
                <div className="mb-2 text-sm font-semibold text-stone-800">镜头切分 / OCR</div>
                {detail.shots?.length ? (
                  <div className="space-y-1.5 text-sm">
                    {detail.shots.map((s) => (
                      <div key={s.id} className="flex items-center gap-2 text-xs">
                        <span className="font-mono text-stone-500">{fmtSec(s.start_ms)}-{fmtSec(s.end_ms)}</span>
                        <span className="text-stone-700">{s.shot_size || s.scene || "—"}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="rounded bg-stone-50 px-3 py-2.5 text-sm text-stone-500">
                    <span className="mb-1 block font-medium text-stone-600">unavailable</span>
                    无 ffmpeg 镜头检测 / 无 OCR；接入工具后可重跑（POST /analyze）
                  </div>
                )}
              </div>
            </div>

            <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
              <div className="mb-2 text-sm font-semibold text-stone-800">字段溯源（{prov.length} 项）</div>
              <div className="max-h-64 overflow-y-auto">
                <table className="w-full text-xs">
                  <thead><tr className="border-b border-stone-200 text-left text-stone-500">
                    <th className="px-2 py-1">字段</th><th className="px-2 py-1">来源</th><th className="px-2 py-1">可用</th><th className="px-2 py-1">置信度</th><th className="px-2 py-1">局限</th>
                  </tr></thead>
                  <tbody>
                    {prov.map((p) => (
                      <tr key={p.id} className="border-b border-stone-100">
                        <td className="px-2 py-1 font-mono text-stone-700">{p.field}</td>
                        <td className="px-2 py-1"><Badge text={p.source} cls={srcColor[p.source] || "bg-stone-100 text-stone-500 border-stone-300"} /></td>
                        <td className="px-2 py-1">{p.available ? "✓" : "✗"}</td>
                        <td className="px-2 py-1"><Badge text={p.confidence} cls={confColor[p.confidence] || confColor.low} /></td>
                        <td className="px-2 py-1 text-stone-500">{p.limitation}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {detail.corrections?.length ? (
              <div className="rounded-xl border border-stone-200 bg-white p-4 shadow-sm">
                <div className="mb-2 text-sm font-semibold text-stone-800">修正历史（{detail.corrections.length}）</div>
                {detail.corrections.map((c: CorrectionRecord) => (
                  <div key={c.id} className="mb-1 text-xs text-stone-600">
                    <span className="font-mono text-stone-800">{c.field}</span>：{c.old_value?.slice(0, 30) || "∅"} → <span className="font-medium text-stone-800">{c.new_value?.slice(0, 30)}</span>（{c.reason} · {fmtDate(c.corrected_at)}）
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {view === "detail" && !detail ? (
          <div className="rounded-xl border border-stone-200 bg-white p-8 text-center text-stone-400">加载详情失败或节点离线</div>
        ) : null}
      </main>
    </div>
  );
}
