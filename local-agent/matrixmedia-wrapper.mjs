import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";

const options = parseArgs(process.argv.slice(2));
if (!options.job) fail(2, "job_file_required");

const job = JSON.parse(await readFile(options.job, "utf8"));
const binary = options.binary || process.env.ZHITAI_MATRIX_BINARY || "/Applications/matrixmedia.app/Contents/MacOS/matrixmedia";
const phone = options.phone || process.env.ZHITAI_MATRIX_PHONE || "";
const partitions = parseJsonEnv("ZHITAI_MATRIX_PARTITIONS");
const targetCopy = job.targetCopy && typeof job.targetCopy === "object" ? job.targetCopy : {};
const platformCodes = { douyin: "dy", xiaohongshu: "xhs", wechat_channels: "sph" };

if (!Array.isArray(job.targets) || !job.targets.length) fail(2, "targets_required");
if (!job.assetPath || !job.title) fail(2, "asset_and_title_required");

for (const target of job.targets) {
  const platform = platformCodes[target];
  if (!platform) fail(2, `unsupported_target_${target}`);
  const copy = targetCopy[target] && typeof targetCopy[target] === "object" ? targetCopy[target] : {};
  const partition = partitions[target];
  if (!partition && !phone) fail(2, `account_required_${target}`);

  const args = [
    "cli",
    "publish",
    "-p",
    platform,
    partition ? "--partition" : "--phone",
    partition || phone,
    "-f",
    job.assetPath,
    "-t",
    String(copy.title || job.title),
    "--name",
    `zhitai:${job.id}:${platform}`,
  ];
  if (copy.shortTitle) args.push("--bt2", String(copy.shortTitle));
  if (Array.isArray(copy.tags) && copy.tags.length) args.push("--tags", copy.tags.slice(0, 4).join(" "));
  if (copy.creativeStatement) args.push("--creative-statement", String(copy.creativeStatement));
  if (job.mode !== "publish") args.push("--draft");

  const result = await run(binary, args);
  if (result.code === 4) fail(4, `platform_needs_attention_${target}`);
  if (result.code !== 0) fail(result.code || 1, `platform_publish_failed_${target}`);
}

function parseArgs(args) {
  const parsed = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/, "");
    if (key) parsed[key] = args[index + 1];
  }
  return parsed;
}

function parseJsonEnv(name) {
  try {
    const parsed = JSON.parse(process.env[name] || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    fail(2, `${name.toLowerCase()}_invalid`);
  }
}

function run(command, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, {
      env: {
        PATH: process.env.PATH || "",
        HOME: process.env.HOME || "",
        LANG: process.env.LANG || "zh_CN.UTF-8",
        MATRIXMEDIA_DISABLE_TELEMETRY: "1",
      },
      shell: false,
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.once("error", rejectPromise);
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
}

function fail(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}
