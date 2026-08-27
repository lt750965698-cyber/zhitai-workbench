#!/usr/bin/env node
/* 织台桌面版 · 定位 npm（显式配置 → PATH → 标准安装位置） */
"use strict";

const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

function findNpm() {
  const configured = process.env.ZHITAI_NPM_BIN;
  if (configured && path.isAbsolute(configured) && fs.existsSync(configured)) return configured;
  // PATH 里已有的 npm
  try {
    const which = execFileSync("/usr/bin/which", ["npm"], { encoding: "utf8", timeout: 3000 }).trim();
    if (which && fs.existsSync(which)) return which;
  } catch (_) { /* 继续 */ }
  // 固定候选
  const fixed = [
    path.join(os.homedir(), ".local", "share", "zhitai-runtime", "bin", "npm"),
    "/opt/homebrew/bin/npm",
    "/usr/local/bin/npm",
  ];
  for (const c of fixed) {
    if (fs.existsSync(c)) return c;
  }
  return null;
}

module.exports = { findNpm };
