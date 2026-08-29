#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const testsRoot = join(repositoryRoot, "tests");
const files = (await readdir(testsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".test.mjs"))
  .map((entry) => join(testsRoot, entry.name))
  .sort((left, right) => left.localeCompare(right));

if (!files.length) throw new Error("no_node_tests_found");

const child = spawn(process.execPath, ["--test", ...files], {
  cwd: repositoryRoot,
  env: process.env,
  shell: false,
  stdio: "inherit",
});

child.once("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = signal ? 1 : Number(code || 0);
});
