#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const integrationsRoot = join(repositoryRoot, "integrations");

async function findTests(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await findTests(path));
    else if (entry.isFile() && entry.name.endsWith(".test.mjs")) files.push(path);
  }
  return files.sort();
}

const tests = await findTests(integrationsRoot);
if (!tests.length) {
  console.error("No integration tests found.");
  process.exitCode = 1;
} else {
  const child = spawn(process.execPath, ["--test", ...tests], {
    cwd: repositoryRoot,
    env: process.env,
    stdio: "inherit",
  });
  child.once("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = signal ? 1 : Number(code ?? 1);
  });
}
