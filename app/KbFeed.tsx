"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

/* 主工作台内的「知识库」视图 —— 与 /kb 共享同一 API（/api/v1/kb）
 * 每条内容显示：下载渠道（快点/回退/迁移）、元数据来源（元宝/平台/缺失）、
 * 下载验证状态（ok/加密/未知）、fallback 原因、播放量未获取、证据/置信度。 */

const API = "http://127.0.0.1:17890/api/v1/kb";

type KbItem = {
  id: string;
  title: string;
  category: string;
  channel: string | null;
  observed_channel: string | null;
  metadata_source: string | null;
  coverUrl: string | null;
  media_validation: string | null;
  fallback_reason: string | null;
  author: string | null;
  plays: number | null;
  likes: number | null;
  favorites: number | null;
  duration_ms: number | null;
  created_at: string | null;
  analysis: { confidence: string | null; source: string | null };
  virality: string | null;
  source_url: string | null;
};

const channelLabel: Record<string, { text: string; cls: string }> = {
  kuaidian: { text: "快点", cls: "background:#d9f36f;color:#181a17" },
  mandian: { text: "慢点", cls: "background:#aee5cc;color:#14241c" },
  mandian_fallback: { text: "慢点回退", cls: "background:#aee5cc;color:#14241c" },
  local_unattributed: { text: "本地不明来源", cls: "background:#e5e4dc;color:#555" },
  yuanbao_fallback: { text: "回退·元宝", cls: "background:#cabaff;color:#241a3d" },
  legacy_migration: { text: "旧库迁移", cls: "background:#e5e4dc;color:#555" },
  local: { text: "本地", cls: "background:#e5e4dc;color:#555" },
  unknown: { text: "未知", cls: "background:#eee;color:#888" },
};

const valLabel: Record<string, { text: string; cls: string }> = {
  ok: { text: "✓ 可播放", cls: "background:#d3f2e4;color:#0b5d3b" },
  encrypted: { text: "⚠ 加密流", cls: "background:#ffd9cf;color:#8c2f1a" },
  unknown: { text: "？未知", cls: "background:#f0e8d5;color:#7a6214" },
  missing: { text: "✗ 缺失", cls: "background:#ffd9cf;color:#8c2f1a" },
};

function Chip({ label, style }: { label: string; style: string }) {
  return <span style={{ ...parseStyle(style), display: "inline-block", borderRadius: 999, padding: "2px 8px", fontSize: 14, fontWeight: 600, marginRight: 6, whiteSpace: "nowrap" }}>{label}</span>;
}
function parseStyle(s: string): React.CSSProperties {
  const out: Record<string, string> = {};
  for (const part of s.split(";")) {
    const i = part.indexOf(":");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out as React.CSSProperties;
}

function fmtDur(ms: number | null) {
  if (ms == null) return "未知";
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function fmtDate(v: string | null) {
  if (!v) return "—";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toLocaleDateString("zh-CN");
}
function fmtNum(v: number | null) {
  return v == null ? "null" : String(v);
}

export function KbFeed() {
  const [items, setItems] = useState<KbItem[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`${API}/videos?limit=100`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      setItems(j.items || []);
      setError(null);
    } catch {
      setError("本地节点未连接，无法读取知识库");
      setItems([]);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load 内的 setState 发生在 fetch 回调之后，非同步级联
    void load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div style={{ padding: "4px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <strong style={{ fontSize: 15 }}>短视频知识库</strong>
        <span style={{ fontSize: 13, color: "#666" }}>统一数据源 /api/v1/kb（与 /kb 页面共享）</span>
        <Link href="/kb" style={{ marginLeft: "auto", fontSize: 14, color: "#181a17", textDecoration: "none", background: "#d9f36f", borderRadius: 8, padding: "4px 10px", fontWeight: 600 }}>
          打开完整知识库 ↗
        </Link>
      </div>
      {error ? <div style={{ padding: 16, background: "#ffd9cf", borderRadius: 10, color: "#8c2f1a", fontSize: 14 }}>{error}</div> : null}
      {!items.length && !error ? <div style={{ padding: 16, color: "#888", fontSize: 14 }}>暂无内容，转发视频号/导入本地视频后自动出现。</div> : null}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {items.map((it) => {
          const ch = channelLabel[it.observed_channel || it.channel || "unknown"] || channelLabel.unknown;
          const val = valLabel[it.media_validation || "unknown"] || valLabel.unknown;
          const metaSrc = it.metadata_source === "yuanbao_enrich" ? "元宝已补" : it.metadata_source === "legacy_metadata" ? "旧库" : it.metadata_source ? "本地" : "缺失";
          return (
            <div key={it.id} style={{ background: "#fffefa", border: "1px solid #deddd5", borderRadius: 12, padding: "10px 12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                <Chip label={`渠道 ${ch.text}`} style={ch.cls} />
                <Chip label={`验证 ${val.text}`} style={val.cls} />
                <Chip label={`元数据 ${metaSrc}`} style={metaSrc === "缺失" ? "background:#eee;color:#888" : "background:#e3ecff;color:#234a9e"} />
                {it.media_validation === "encrypted" ? <Chip label={`fallback: ${it.fallback_reason || "加密流不可播"}`} style="background:#ffd9cf;color:#8c2f1a" /> : null}
                {it.fallback_reason && it.media_validation !== "encrypted" ? <Chip label={`fallback: ${it.fallback_reason}`} style="background:#f0e8d5;color:#7a6214" /> : null}
                {it.plays === null && (it.likes !== null || it.favorites !== null) ? <Chip label="播放量未获取" style="background:#f0e8d5;color:#7a6214" /> : null}
                {it.analysis?.source === "rule_inference" ? <Chip label={`分析 低置信·规则推断`} style="background:#ffead2;color:#9a5b13" /> : null}
                {it.virality === "potential_distribution_factors" ? <Chip label="病毒性 潜在传播因素" style="background:#e3ecff;color:#234a9e" /> : null}
              </div>
              <div style={{ marginTop: 6, fontSize: 14, fontWeight: 500, color: "#1d201c" }}>{it.title || "（无标题）"}</div>
              <div style={{ marginTop: 2, fontSize: 13, color: "#62675f" }}>
                分类 {it.category} ｜ {fmtDur(it.duration_ms)} ｜ 点赞 {fmtNum(it.likes)} ｜ 收藏 {fmtNum(it.favorites)} ｜ 作者 {it.author || "本地"} ｜ 入库 {fmtDate(it.created_at)}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
