import * as defaultFs from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isManagedDiagnosticFilename } from "./diagnostics.mjs";

export class DiagnosticsMaintenanceError extends Error {
  constructor(code) {
    super(code);
    this.name = "DiagnosticsMaintenanceError";
    this.code = code;
    this.stack = `${this.name}: ${code}`;
  }
}

function permissionMode(stat) {
  return (stat.mode & 0o7777).toString(8).padStart(4, "0");
}

function safeSize(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(value));
}

function addSize(left, right) {
  return Math.min(Number.MAX_SAFE_INTEGER, safeSize(left) + safeSize(right));
}

function isoOrNull(value) {
  return Number.isFinite(value) ? new Date(value).toISOString() : null;
}

function emptyPreview(directoryMode = null) {
  return {
    schemaVersion: 1,
    mode: "preview_only",
    directoryMode,
    entries: {
      total: 0,
      inspected: 0,
      vanished: 0,
    },
    regularFiles: {
      count: 0,
      managedV2Count: 0,
      legacyOrUnknownCount: 0,
      totalBytes: 0,
      mtimeRange: {
        oldest: null,
        newest: null,
      },
      permissionHistogram: {},
    },
    specialFiles: {
      count: 0,
      directories: 0,
      symlinks: 0,
      other: 0,
      inaccessible: 0,
    },
  };
}

/**
 * Read-only inventory for legacy diagnostics. This function intentionally uses
 * directory entries and lstat metadata only: it does not open or read any file,
 * follow symlinks, recurse, or return names/paths.
 */
export async function previewLegacyDiagnostics({ diagnosticsDir, fs = defaultFs } = {}) {
  if (typeof diagnosticsDir !== "string" || diagnosticsDir.length === 0) {
    throw new DiagnosticsMaintenanceError("diagnostics_directory_required");
  }

  let directoryStat;
  try {
    directoryStat = await fs.lstat(diagnosticsDir);
  } catch (error) {
    if (error?.code === "ENOENT") return emptyPreview();
    throw new DiagnosticsMaintenanceError("diagnostics_preview_failed");
  }
  if (directoryStat.isSymbolicLink()) {
    throw new DiagnosticsMaintenanceError("diagnostics_symlink_rejected");
  }
  if (!directoryStat.isDirectory()) {
    throw new DiagnosticsMaintenanceError("diagnostics_path_not_directory");
  }

  let names;
  try {
    names = await fs.readdir(diagnosticsDir);
  } catch {
    throw new DiagnosticsMaintenanceError("diagnostics_preview_failed");
  }

  const report = emptyPreview(permissionMode(directoryStat));
  report.entries.total = names.length;
  let oldestMs = Number.POSITIVE_INFINITY;
  let newestMs = Number.NEGATIVE_INFINITY;

  for (const name of names) {
    let stat;
    try {
      stat = await fs.lstat(join(diagnosticsDir, name));
    } catch (error) {
      if (error?.code === "ENOENT") {
        report.entries.vanished += 1;
      } else {
        report.specialFiles.inaccessible += 1;
        report.specialFiles.count += 1;
      }
      continue;
    }
    report.entries.inspected += 1;

    if (stat.isSymbolicLink()) {
      report.specialFiles.symlinks += 1;
      report.specialFiles.count += 1;
      continue;
    }
    if (stat.isDirectory()) {
      report.specialFiles.directories += 1;
      report.specialFiles.count += 1;
      continue;
    }
    if (!stat.isFile()) {
      report.specialFiles.other += 1;
      report.specialFiles.count += 1;
      continue;
    }

    report.regularFiles.count += 1;
    report.regularFiles.totalBytes = addSize(report.regularFiles.totalBytes, stat.size);
    if (isManagedDiagnosticFilename(name)) report.regularFiles.managedV2Count += 1;
    else report.regularFiles.legacyOrUnknownCount += 1;
    const mode = permissionMode(stat);
    report.regularFiles.permissionHistogram[mode] = (report.regularFiles.permissionHistogram[mode] ?? 0) + 1;
    if (Number.isFinite(stat.mtimeMs)) {
      oldestMs = Math.min(oldestMs, stat.mtimeMs);
      newestMs = Math.max(newestMs, stat.mtimeMs);
    }
  }

  report.regularFiles.mtimeRange.oldest = isoOrNull(oldestMs);
  report.regularFiles.mtimeRange.newest = isoOrNull(newestMs);
  return report;
}

function valueAfter(args, index, flag) {
  const argument = args[index];
  if (argument === flag) return { value: args[index + 1], consumed: 2 };
  if (argument.startsWith(`${flag}=`)) return { value: argument.slice(flag.length + 1), consumed: 1 };
  return null;
}

export async function runDiagnosticsMaintenanceCli(args = process.argv.slice(2), { fs = defaultFs } = {}) {
  const destructive = new Set(["--apply", "--delete", "--clean", "--cleanup", "--migrate", "--isolate"]);
  if (args.some((arg) => destructive.has(arg))) {
    throw new DiagnosticsMaintenanceError("destructive_action_not_implemented");
  }

  let dataDir = null;
  let diagnosticsDir = null;
  let action = "preview";
  for (let index = 0; index < args.length;) {
    const argument = args[index];
    if (argument === "preview") {
      action = "preview";
      index += 1;
      continue;
    }
    const dataOption = valueAfter(args, index, "--data-dir");
    if (dataOption) {
      dataDir = dataOption.value;
      index += dataOption.consumed;
      continue;
    }
    const diagnosticsOption = valueAfter(args, index, "--diagnostics-dir");
    if (diagnosticsOption) {
      diagnosticsDir = diagnosticsOption.value;
      index += diagnosticsOption.consumed;
      continue;
    }
    throw new DiagnosticsMaintenanceError("invalid_preview_arguments");
  }

  if (action !== "preview") throw new DiagnosticsMaintenanceError("preview_only");
  if (dataDir && diagnosticsDir) throw new DiagnosticsMaintenanceError("ambiguous_diagnostics_directory");
  if (!diagnosticsDir && dataDir) diagnosticsDir = join(dataDir, "diag");
  if (!diagnosticsDir) throw new DiagnosticsMaintenanceError("diagnostics_directory_required");
  return previewLegacyDiagnostics({ diagnosticsDir, fs });
}

const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  runDiagnosticsMaintenanceCli().then((report) => {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  }).catch((error) => {
    const code = error instanceof DiagnosticsMaintenanceError
      ? error.code
      : "diagnostics_preview_failed";
    process.stderr.write(`${JSON.stringify({ schemaVersion: 1, mode: "preview_only", error: code })}\n`);
    process.exitCode = 2;
  });
}
