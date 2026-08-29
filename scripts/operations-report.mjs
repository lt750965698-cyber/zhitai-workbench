#!/usr/bin/env node
/**
 * 只读运营报告 CLI。默认不寻找账号、不调用平台、不发布；所有 JSON 账本路径必须显式传入。
 */
import { DatabaseSync } from "node:sqlite";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { buildOperationsReport, renderOperationsReportMarkdown } from "../local-agent/operations-metrics.mjs";
import { buildSyntheticOperationsReport } from "../local-agent/operations-synthetic.mjs";

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}

let db;
try {
  let report;
  if (options.synthetic) {
    if (options.db || options.receipts || options.reviews || options.jobs || options.dailyState) {
      throw new Error("synthetic_mode_does_not_accept_real_input_paths");
    }
    report = buildSyntheticOperationsReport();
  } else {
    if (!options.db) throw new Error("db_path_required");
    const asOf = validIso(options.asOf) || new Date().toISOString();
    const to = validIso(options.to) || asOf;
    const from = validIso(options.from) || new Date(Date.parse(to) - 24 * 60 * 60_000).toISOString();
    db = new DatabaseSync(resolve(options.db), { readOnly: true });
    db.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 250;");
    report = buildOperationsReport(db, {
      dataMode: "observed",
      from,
      to,
      asOf,
      anchorAt: validIso(options.anchorAt) || from,
      timezone: options.timezone || "Asia/Shanghai",
      publishReceipts: await loadRows(options.receipts, "receipts"),
      creativeReviews: await loadRows(options.reviews, "reviews"),
      creativeJobs: await loadRows(options.jobs, "jobs"),
      dailyCreativeState: await loadObject(options.dailyState),
      experiments: await loadRows(options.experiments, "experiments"),
    });
  }
  const output = options.format === "json"
    ? `${JSON.stringify(report, null, 2)}\n`
    : renderOperationsReportMarkdown(report);
  process.stdout.write(output.endsWith("\n") ? output : `${output}\n`);
} catch (error) {
  process.stderr.write(`operations_report_failed:${String(error?.message || error).slice(0, 300)}\n`);
  process.stderr.write(`${usage()}\n`);
  process.exitCode = 1;
} finally {
  try { db?.close(); } catch { /* best effort */ }
}

function parseArgs(args) {
  const parsed = { format: "markdown", synthetic: false, help: false };
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--synthetic") { parsed.synthetic = true; continue; }
    if (token === "--help" || token === "-h") { parsed.help = true; continue; }
    if (!token.startsWith("--")) throw new Error(`unexpected_argument:${token}`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`argument_value_required:${token}`);
    parsed[key] = value;
    index += 1;
  }
  if (!new Set(["json", "markdown"]).has(parsed.format)) throw new Error("format_must_be_json_or_markdown");
  return parsed;
}

function validIso(value) {
  if (!value || Number.isNaN(Date.parse(String(value)))) return null;
  return new Date(Date.parse(String(value))).toISOString();
}

async function loadJson(path) {
  if (!path) return null;
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

async function loadRows(path, key) {
  const value = await loadJson(path);
  if (value === null) return [];
  if (Array.isArray(value)) return value;
  if (Array.isArray(value?.[key])) return value[key];
  throw new Error(`${key}_json_must_contain_array`);
}

async function loadObject(path) {
  const value = await loadJson(path);
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("daily_state_json_must_be_object");
  return value;
}

function usage() {
  return [
    "用法：",
    "  node scripts/operations-report.mjs --synthetic [--format markdown|json]",
    "  node scripts/operations-report.mjs --db /path/kb.sqlite --from <ISO> --to <ISO> --as-of <ISO>",
    "    [--receipts publisher-receipts.json] [--reviews creative-reviews.json]",
    "    [--jobs creative-jobs.json] [--daily-state daily-creative.json]",
    "    [--experiments experiments.json] [--anchor-at <ISO>] [--timezone Asia/Shanghai]",
    "",
    "真实模式只读本地文件，不会登录、修改账号或执行发布。合成模式拒绝真实输入路径。",
  ].join("\n");
}
