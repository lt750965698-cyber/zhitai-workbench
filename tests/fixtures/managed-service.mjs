import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const pidFile = process.argv[2];
if (!pidFile) {
  process.exitCode = 2;
  throw new Error("pid_file_missing");
}

await mkdir(dirname(pidFile), { recursive: true });
await writeFile(pidFile, `${process.pid}\n`, "utf8");

const keepAlive = setInterval(() => {}, 1_000);
let stopping = false;

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    clearInterval(keepAlive);
    void rm(pidFile, { force: true }).finally(() => process.exit(0));
  });
}
