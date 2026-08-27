/* 织台桌面版 · preload：窄 IPC 桥（contextIsolation 下仅暴露白名单能力） */
"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("zhitaiBridge", {
  isDesktop: true,
  // 服务监管状态中心
  getServices: () => ipcRenderer.invoke("zhitai:services:list"),
  onServicesChanged: (callback) => {
    ipcRenderer.on("zhitai:services:changed", (_event, states) => callback(states));
  },
  // 窄 API 代理：只转发到主进程白名单（17890/8000/18090/17900）
  // headers 仅 Content-Type / Authorization（受控）；binary=true 返回 base64+mime
  api: (url, method, body, headers, timeoutMs, binary) =>
    ipcRenderer.invoke("zhitai:api", { url, method, body, headers, timeoutMs, binary }),
  // GPT 生图 / 豆包 Seedance 作为织台同一 App 的子窗口打开，登录态持久化且不增加 Dock 图标。
  openCreativeStudio: (provider, accountId) => ipcRenderer.invoke("zhitai:creative-studio:open", provider, accountId),
  runCreativeJob: (jobId, assetId, accountIds) => ipcRenderer.invoke("zhitai:creative:run", jobId, assetId, accountIds),
  syncXBookmarks: (interactive = true) => ipcRenderer.invoke("zhitai:x-bookmarks:sync", interactive),
  checkRuntimeConditions: (accountIds = [], refresh = false) => ipcRenderer.invoke("zhitai:runtime-conditions:check", accountIds, refresh),
});
