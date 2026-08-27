#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const label = process.argv[2];
if (!/^[a-zA-Z0-9._-]{3,128}$/.test(label || "")) process.exit(2);
const uid = typeof process.getuid === "function" ? process.getuid() : null;
if (!Number.isInteger(uid)) process.exit(2);

const result = spawnSync("/bin/launchctl", ["print", `gui/${uid}/${label}`], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
  timeout: 1_500,
});
if (result.status !== 0) process.exit(1);
const output = String(result.stdout || "");
const state = output.match(/^\s*state\s*=\s*([^\s]+)\s*$/m)?.[1];
const pid = Number(output.match(/^\s*pid\s*=\s*(\d+)\s*$/m)?.[1]);
process.exit(state === "running" && Number.isInteger(pid) && pid > 1 ? 0 : 1);
