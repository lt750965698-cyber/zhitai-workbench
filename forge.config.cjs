"use strict";

/* global __dirname */

const path = require("node:path");

const desktopIcon = path.join(__dirname, "desktop", "assets", "icon");
const windowsIcon = `${desktopIcon}.ico`;

const runtimePaths = [
  /^\/desktop$/,
  /^\/desktop\/(?:[^/]+\.js|package\.json)$/,
  /^\/desktop\/assets$/,
  /^\/desktop\/assets\/icon\.png$/,
  /^\/dist(?:$|\/standalone(?:\/|$))/,
  /^\/local-agent$/,
  /^\/local-agent\/(?:[^/]+\.(?:mjs|js)|config\.example\.json)$/,
  /^\/node_modules$/,
  /^\/node_modules\/@electron$/,
  /^\/node_modules\/@electron\/asar(?:\/|$)/,
  /^\/node_modules\/electron-squirrel-startup(?:\/|$)/,
  /^\/(?:LICENSE|THIRD_PARTY_NOTICES\.md|package\.json)$/,
];

const alwaysIgnored = [
  /^\/(?:\.git|\.github|\.openai|\.wrangler)(?:\/|$)/,
  /^\/(?:coverage|docs|operations|out|outputs|patches|test-results|tests|work)(?:\/|$)/,
  /^\/desktop\/(?:node_modules|package-lock\.json|织台桌面版\.command)(?:\/|$)/,
  /^\/local-agent\/(?:config\.local\.json|data)(?:\/|$)/,
  /^\/local-agent\/(?:inbox-secret|yuanbao-cookie|.*\.(?:cookie|secret))(?:\/|$)/,
  /^\/node_modules\/(?:\.cache)(?:\/|$)/,
  /\/(?:\.env[^/]*|credentials[^/]*\.json|secrets[^/]*\.json)$/i,
  /\.(?:db|db-shm|db-wal|log|pem|key|crt|cer|der|p12|pfx|jks|keystore|mobileprovision)$/i,
];

module.exports = {
  packagerConfig: {
    // The web server and local node are child Node processes. Keeping the app
    // unpacked lets them use a real cwd while remaining inside the installer.
    asar: false,
    executableName: "Zhitai",
    icon: desktopIcon,
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
        setupIcon: windowsIcon,
        noMsi: true,
      },
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["win32"],
    },
  ],
};
