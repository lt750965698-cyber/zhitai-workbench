import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const options = parseArgs(process.argv.slice(2));

if (!options.resultFile || !options.assetPath || !options.sourceUrl) {
  process.exitCode = 2;
  throw new Error("fixture_arguments_missing");
}

await mkdir(dirname(options.resultFile), { recursive: true });
await writeFile(
  options.resultFile,
  `${JSON.stringify({
    title: "集成测试内容包",
    author: "测试作者",
    outputPaths: [options.assetPath],
    sourceUrl: options.sourceUrl,
  }, null, 2)}\n`,
  "utf8",
);

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/, "");
    if (key) parsed[key] = args[index + 1];
  }
  return parsed;
}
