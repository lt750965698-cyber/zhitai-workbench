#!/usr/bin/env node
// openclaw-gateway-probe.mjs
//
// 判定 openclaw-weixin 微信官方入口是否真正在线，供本地节点 /health 的
// 服务探测使用。设计目标：无论网关以何种方式拉起，都能正确反映状态。
//
//   生产路径：launchd 服务 com.zhitai.openclaw-weixin 处于 running。
//   沙箱/手动路径：网关进程（openclaw gateway run）正在本机回环监听并
//     提供 OpenClaw 控制页。当 launchctl 注册被沙箱拦截、网关改以后台
//     进程方式运行时，仍能准确量化状态，避免误报 needs_setup。
//
// 退出码：0 = 在线；1 = 离线。

import { spawnSync } from "node:child_process";

const label = process.argv[2] || "com.zhitai.openclaw-weixin";
const uid = typeof process.getuid === "function" ? process.getuid() : null;

// 1) 生产路径：launchd 服务已注册并运行中。
if (/^[a-zA-Z0-9._-]{3,128}$/.test(label) && Number.isInteger(uid)) {
  const lc = spawnSync("/bin/launchctl", ["print", `gui/${uid}/${label}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: 1_500,
  });
  if (lc.status === 0) {
    const out = String(lc.stdout || "");
    const state = out.match(/^\s*state\s*=\s*([^\s]+)\s*$/m)?.[1];
    const pid = Number(out.match(/^\s*pid\s*=\s*(\d+)\s*$/m)?.[1]);
    if (state === "running" && Number.isInteger(pid) && pid > 1) process.exit(0);
  }
}

// 2) 沙箱/手动路径：探测本机回环上的 OpenClaw 网关控制页。
//    优先探测已知控制端口 18789；失败则扫描回环监听端口逐一校验签名。
async function gatewayReachable(port) {
  for (const path of ["/", "/health"]) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        redirect: "error",
        signal: AbortSignal.timeout(800),
      });
      if (!res.ok) continue;
      const text = await res.text();
      // 控制页正文含 "OpenClaw"；本地节点(zhitai)不含，借此区分。
      if (/openclaw/i.test(text)) return true;
    } catch {
      // 该端口无响应或非网关，继续下一个候选。
    }
  }
  return false;
}

const knownPorts = [18789];
const lsof = spawnSync("/usr/sbin/lsof", ["-nP", "-iTCP", "-sTCP:LISTEN"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
  timeout: 2_000,
});
for (const line of String(lsof.stdout || "").split("\n")) {
  if (!/127\.0\.0\.1|\[::1\]|localhost/.test(line)) continue;
  const m = line.match(/:(\d+)\s+\(LISTEN\)/);
  if (m) {
    const port = Number(m[1]);
    if (!knownPorts.includes(port)) knownPorts.push(port);
  }
}

for (const port of knownPorts) {
  if (await gatewayReachable(port)) process.exit(0);
}

process.exit(1);
