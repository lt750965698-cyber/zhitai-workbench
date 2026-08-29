#!/usr/bin/env node

import {
  BackupError,
  createBackup,
  migrateBackup,
  previewMigration,
  restoreBackup,
  rollbackMigration,
  verifyBackup,
} from "./backup.mjs";

const HELP = `织台可验证备份 / 恢复 / 迁移

用法：
  node local-agent/backup-cli.mjs create --data-dir <目录> --knowledge-root <目录> --output <新备份目录>
  node local-agent/backup-cli.mjs verify --backup <备份目录>
  node local-agent/backup-cli.mjs restore --backup <备份目录> [--temp-parent <临时目录父级>]
  node local-agent/backup-cli.mjs preview --backup <备份目录> --target-root <迁移目标>
  node local-agent/backup-cli.mjs migrate --backup <备份目录> --target-root <不存在的新目标>
  node local-agent/backup-cli.mjs rollback --target-root <迁移目标> --migration-id <迁移编号>

安全边界：
  restore 始终创建新的临时隔离目录；migrate 只写入不存在的新目标；
  rollback 只接受匹配的迁移标记，并把目标改名到可恢复隔离区，不删除数据。
`;

function parseArgs(argv) {
  // npm strips its separator while some pnpm invocations forward it literally.
  // Accept both forms so documented package-manager commands remain portable.
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  const [command, ...rest] = normalizedArgv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const item = rest[index];
    if (!item.startsWith("--")) throw new BackupError("unexpected_positional_argument");
    const equal = item.indexOf("=");
    if (equal > 2) {
      options[item.slice(2, equal)] = item.slice(equal + 1);
      continue;
    }
    const key = item.slice(2);
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) throw new BackupError("option_value_required");
    options[key] = value;
    index += 1;
  }
  return { command, options };
}

function publicVerification(result) {
  return {
    ok: result.ok,
    backupId: result.backupId,
    formatVersion: result.formatVersion,
    fileCount: result.fileCount,
    sizeBytes: result.sizeBytes,
    metrics: result.metrics,
    integrityCheck: result.integrityCheck,
    foreignKeyViolations: result.foreignKeyViolations,
    manifestSha256: result.manifestSha256,
  };
}

async function main() {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (!command || command === "help" || command === "--help" || command === "-h") {
    process.stdout.write(HELP);
    return;
  }
  let result;
  if (command === "create") {
    result = await createBackup({
      dataDir: options["data-dir"],
      knowledgeRoot: options["knowledge-root"],
      outputPath: options.output,
    });
  } else if (command === "verify") {
    result = publicVerification(await verifyBackup({ backupPath: options.backup }));
  } else if (command === "restore") {
    const restored = await restoreBackup({ backupPath: options.backup, tempParent: options["temp-parent"] });
    result = { ok: true, restoreRoot: restored.restoreRoot, report: restored.report };
  } else if (command === "preview") {
    result = await previewMigration({ backupPath: options.backup, targetRoot: options["target-root"] });
  } else if (command === "migrate") {
    result = await migrateBackup({ backupPath: options.backup, targetRoot: options["target-root"] });
  } else if (command === "rollback") {
    result = await rollbackMigration({ targetRoot: options["target-root"], migrationId: options["migration-id"] });
  } else {
    throw new BackupError("unknown_command");
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

main().catch((error) => {
  const code = error instanceof BackupError ? error.code : "unexpected_failure";
  const publicError = { ok: false, error: code };
  if (error instanceof BackupError && /^migration_[0-9a-f-]{36}$/i.test(String(error.details?.migrationId || ""))) {
    publicError.migrationId = error.details.migrationId;
    publicError.targetQuarantined = Boolean(error.details.targetQuarantined);
    publicError.manualRecoveryRequired = Boolean(error.details.manualRecoveryRequired);
  }
  process.stderr.write(`${JSON.stringify(publicError)}\n`);
  process.exitCode = 1;
});
