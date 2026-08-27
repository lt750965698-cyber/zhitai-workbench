"use client";

/* 织台桌面版 · 状态中心（仅桌面版显示）
 * 展示主进程服务监管结果：哪些模块在线、哪些是本次织台自启、单项失败的可读错误。
 *
 * hydration 约束：SSR 与客户端首帧必须一致地返回 null —— 初始 desktop=false，
 * 渲染期绝不调用 isDesktop()（它读 window，SSR 与客户端结果不同会触发 hydration mismatch）；
 * 仅在 useEffect 挂载后开启桌面模式，再读取 window.zhitaiBridge。
 */

import { useEffect, useState } from "react";
import { DesktopServiceState } from "./zapi";

export function DesktopStatus() {
  const [desktop, setDesktop] = useState(false);
  const [states, setStates] = useState<DesktopServiceState[]>([]);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const bridge = typeof window === "undefined" ? undefined : window.zhitaiBridge;
    if (!bridge) return;
    // 仅挂载后进入桌面模式（SSR 与客户端首帧保持一致，避免 hydration mismatch）
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setDesktop(true);
    let cancelled = false;
    bridge.getServices().then((list) => {
      if (!cancelled) setStates(list);
    }).catch(() => {});
    bridge.onServicesChanged((list) => {
      if (!cancelled) setStates(list);
    });
    return () => { cancelled = true; };
  }, []);

  if (!desktop) return null;

  // 按需引擎未启动是正常待命，不是故障；只统计应常驻但离线的服务。
  const failed = states.filter((s) => !s.online && !s.onDemand);
  return (
    <div className="desktop-status">
      <button type="button" className="desktop-status-head" onClick={() => setVisible((v) => !v)} aria-expanded={visible}>
        <span className={`node-signal ${failed.length === 0 ? "online" : "offline"}`} />
        <span><strong>桌面服务状态</strong><small>{failed.length === 0 ? "常驻服务全部就绪" : `${failed.length} 项未就绪`}</small></span>
        <b>{visible ? "−" : "+"}</b>
      </button>
      {visible && (
        <ul className="desktop-status-list">
          {states.map((s) => (
            <li key={s.id}>
              <span className={`node-signal ${s.online ? "online" : s.onDemand ? "checking" : "offline"}`} />
              <p><strong>{s.label}</strong><small>{s.online ? "在线" : s.onDemand ? "按需待命" : "离线"}{s.owned ? " · 织台自启" : ""}</small></p>
              {s.error && <em title={s.error}>{s.error}</em>}
            </li>
          ))}
          {!states.length && <li><p><strong>等待主进程报告…</strong></p></li>}
        </ul>
      )}
    </div>
  );
}
