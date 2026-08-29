"use strict";

const runtimePaths = [
  /^\/app(?:\/|$)/,
  /^\/build(?:\/|$)/,
  /^\/desktop(?:\/|$)/,
  /^\/dist(?:\/|$)/,
  /^\/local-agent(?:\/|$)/,
  /^\/node_modules(?:\/|$)/,
  /^\/public(?:\/|$)/,
  /^\/worker(?:\/|$)/,
  /^\/(?:next\.config\.[^/]+|package\.json|vite\.config\.[^/]+)$/,
];

const alwaysIgnored = [
  /^\/(?:\.git|\.github|\.openai|\.wrangler)(?:\/|$)/,
  /^\/(?:coverage|docs|operations|out|outputs|patches|test-results|tests|work)(?:\/|$)/,
  /^\/desktop\/(?:node_modules|package-lock\.json|织台桌面版\.command)(?:\/|$)/,
  /^\/local-agent\/(?:config\.local\.json|data)(?:\/|$)/,
  /^\/node_modules\/(?:\.cache)(?:\/|$)/,
  /\.(?:db|db-shm|db-wal|log|pem|key|pfx)$/i,
];

module.exports = {
  packagerConfig: {
    // The web server and local node are child Node processes. Keeping the app
    // unpacked lets them use a real cwd while remaining inside the installer.
    asar: false,
    executableName: "Zhitai",
    appBundleId: "com.zhitai.desktop",
    appCopyright: "Copyright (c) 2026 Zhitai contributors",
    win32metadata: {
      CompanyName: "Zhitai contributors",
      FileDescription: "织台 · 内容自动化工作台",
      InternalName: "Zhitai",
      OriginalFilename: "Zhitai.exe",
      ProductName: "织台",
    },
    ignore(pathname) {
      if (!pathname) return false;
      if (alwaysIgnored.some((pattern) => pattern.test(pathname))) return true;
      return !runtimePaths.some((pattern) => pattern.test(pathname));
    },
  },
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      config: {
        name: "ZhitaiWorkbench",
        authors: "Zhitai contributors",
        description: "本地优先的内容采集、知识库、分析与多平台发布工作台。",
        setupExe: "Zhitai-Setup.exe",
        noMsi: true,
      },
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["win32"],
    },
  ],
};
