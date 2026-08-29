# 织台可验证备份、恢复与迁移

本文档对应备份格式 `zhitai-bag` v1。实现只做本地文件和 SQLite 操作，不启动织台节点、浏览器、第三方引擎，也不调用任何发布接口。

## 方案依据

- SQLite 活跃数据库不得裸复制。默认调用 [SQLite Online Backup API](https://www.sqlite.org/backup.html) 的 Node 封装，把备份开始时的已提交状态（包括 WAL 中尚未 checkpoint 的提交）物化为独立快照；Node 22.13–22.15 没有该封装时回退到 SQLite 官方 [`VACUUM INTO`](https://sqlite.org/lang_vacuum.html#vacuuminto)。两种方式都只写隐藏 staging。
- WAL 是数据库持久状态的一部分，不能与主库错配或遗漏，见 SQLite [WAL 文档](https://sqlite.org/wal.html) 与 [数据库损坏说明](https://www.sqlite.org/howtocorrupt.html)。备份不强制 checkpoint 活跃源库，也不复制源 `-wal/-shm`；它只规范化已生成的私有快照。
- SQLite 官方在 2026 年披露的罕见 WAL-reset 竞态影响 3.7.0–3.51.2（3.44.6、3.50.7 为回移修复，3.51.3+ 已修复）。manifest 会记录 `sqliteWalResetFixStatus`；本次运行的 3.53.3 为已修复版本。旧运行时仍会先做 `integrity_check`，但生产节点应升级到官方已修复版本。
- 目录格式复用 [BagIt 1.0 / RFC 8493](https://www.rfc-editor.org/rfc/rfc8493.html)：payload 位于 `data/`，`manifest-sha256.txt` 覆盖每个 payload 文件，`tagmanifest-sha256.txt` 覆盖 manifest 自身与 BagIt 标签文件。
- [restic](https://restic.readthedocs.io/en/stable/)、[Borg](https://borgbackup.readthedocs.io/en/stable/) 或 [Kopia](https://kopia.io/docs/) 可作为已验证 BagIt 目录的外层加密、保留和异地复制工具；它们不能替代本步骤的 SQLite 一致性快照。仓库密码应留在钥匙串或独立秘密管理中。

## 备份内容和默认排除

包含范围：

- `kb.sqlite` 的一致性快照，逻辑覆盖已提交 WAL；
- 整个知识库内容包，包括分析、绩效、评论和已回存的生成成片；
- `tasks.json`、`analysis-jobs.json`、`creative-jobs.json`、`creative-reviews.json`、`kuaidian-commands.json`、`publisher-schedule.json`、`watcher-state.json`；
- `events.json`、数据库内修正/观察/下载收据；
- `publish-jobs/*.json` 的审核与排期；
- `platform-receipts/*.json` 的第一方、逐平台、白名单脱敏回执；
- 数据库内 `remake_generation`、`platform_post` 等业务记录。

织台实际生成的 JSON/JSONL、Markdown、TXT、字幕、URL、CSV/TSV 和 SQLite 字段会做失败关闭审计：发现非占位值的 Cookie、Token、Authorization、密码、签名、二维码数据或同类赋值时，仅返回 `sensitive_content_detected`，不复制也不显示命中值。JSON 逐字段检查；CSV/TSV 关联敏感表头列和 EAV key/value 行；Markdown 同时检查赋值和表格。SQLite 除逐列检查外，还关联 `settings(name,value)`、`config_key/config_value` 等动态键值，并把敏感列中的 INTEGER/REAL/BLOB 视为材料。文本源通过 `O_NOFOLLOW` 打开后先在内存审计同一字节缓冲，审计通过才写 staging；单个待审计文本上限 64 MiB。数据库会在快照前审计源连接、在快照后复核。数据库资产的包路径、文件路径及已有 SHA-256 也会和本次知识树副本交叉核对。

未知扩展、plist、HTML/XML、源码、归档及其他无法有界审计的不透明类型不会静默进入包，而会以 `unsupported_payload_file_type` 终止整次备份。允许的二进制只限明确媒体/PDF 扩展，并必须通过相应文件头 magic 校验；这防止把文本秘密简单改名成 `.mp4`，但不等同于二进制内容 DLP。

默认不会遍历整个 `dataDir`，只复制上述白名单。知识库遍历时拒绝符号链接和特殊文件，并排除：

- `Keychain/Keychains`、`*.keychain*`、`config.local.json`、`inbox-secret`、`.env`、密码导出、密钥和凭据文件；
- Cookie、Token、会话和 `webhook-nonces.json`；
- `private/raw`、`raw-backup` 和未脱敏 `raw-yuanbao.json`；
- `matrix-login`、二维码文件及 `qr/qrcode/login-qr` 等二维码目录树；
- `diag`、临时文件、可重新下载缓存；
- `engines`、`node_modules`、`.venv/venv/virtualenv`、`site-packages`、`__pycache__` 和第三方运行时。

`raw-yuanbao.sanitized.json` 只有位于正常内容包时才可包含；即使同名文件位于 `private`、缓存或引擎目录也会排除。平台回执仅允许固定 13 个非秘密字段落盘，先写不可变的发布意图，再按平台身份而非数组下标记录结果；连接中断或缺失结果记为 `unknown`。备份和 CLI 错误只输出稳定错误码，不输出上游原文或秘密值。

## 备份目录

```text
backup/
├── bagit.txt
├── bag-info.txt
├── manifest.json
├── manifest-sha256.txt
├── tagmanifest-sha256.txt
└── data/
    ├── state/
    │   ├── kb.sqlite
    │   ├── tasks.json
    │   ├── creative-jobs.json
    │   ├── publish-jobs/
    │   └── platform-receipts/
    └── knowledge/
        └── ...内容包相对路径...
```

`manifest.json` 记录格式版本、备份编号、创建时间、Node/SQLite 版本、快照机制、源 journal mode、WAL 覆盖声明、具名排除策略、相对 POSIX 路径、大小、SHA-256、内容安全审计、资产引用核对和业务计数。`bag-info.txt` 的 `Payload-Oxum` 也必须与 manifest 的总字节数、文件数一致。不会写入源绝对根路径。

## 命令

以下命令要求 Node.js 22.13 或以上。`--output` 必须是不存在的新目录，并且不能位于 `dataDir` 或知识库内部。

创建：

```bash
npm run backup -- create \
  --data-dir "/path/to/zhitai-data" \
  --knowledge-root "/path/to/内容库" \
  --output "/path/to/backups/zhitai-2026-08-27"
```

创建流程为：输出路径零写入边界预检 → 排他输出锁 → 源 SQLite/sidecar 边界与敏感内容审计 → SQLite 一致性快照与复核 → 文本先审计、二进制先验文件头校验后稳定复制 → 资产引用/哈希交叉核对 → BagIt/应用 manifest → 完整自校验 → 文件与目录 `fsync` → 同文件系统原子改名。主库、现有 `-wal/-shm` 均拒绝符号链接、非普通文件和数据根外 realpath。失败只清理由本次操作创建的随机 `.partial-*` 目录，不会改动源数据或既有备份；即使输出指定到源目录内尚不存在的深层路径，也会在创建父目录前拒绝。异常退出可能留下隐藏的 `.<输出名>.backup-lock` 和 `.<输出名>.partial-*`；确认没有同名备份进程后先把残留整体移到隔离区，再移走锁，工具会拒绝自动复用或删除残留，也绝不会借清锁覆盖现有输出。

只读验证：

```bash
npm run backup -- verify --backup "/path/to/backups/zhitai-2026-08-27"
```

验证拒绝未知格式版本、路径逃逸、未知 payload namespace、状态路径越权、重复路径、符号链接、额外/缺失文件、`Payload-Oxum`/聚合计数不一致、tag 或 payload 哈希不一致、排除目录自洽重签注入、敏感字段、不支持的文件类型、伪造媒体文件头、资产引用/已有资产哈希不一致、`integrity_check` 非 `ok`、外键错误或业务计数不匹配。

隔离恢复：

```bash
npm run backup -- restore \
  --backup "/path/to/backups/zhitai-2026-08-27" \
  --temp-parent "/path/to/private-temp"
```

`restore` 没有“覆盖当前位置”参数。它先验证 `prefix` 和目标父目录边界，再通过 `mkdtemp` 创建权限 `0700` 的新目录；位于备份内部的父目录会在创建任何内容前拒绝。恢复每个文件后重新计算 SHA-256，再核对 SQLite 完整性、外键、资产数、分队列任务数和实际恢复文件数，并写入 `restore-report.json`。用户当前 `dataDir` 和知识库从不作为覆盖或删除目标。

迁移预览：

```bash
npm run backup -- preview \
  --backup "/path/to/backups/zhitai-2026-08-27" \
  --target-root "/new/location/zhitai"
```

预览是只读操作，报告目标是否已存在、相同/冲突/缺失文件计数，以及数据库中需要重绑定的绝对路径引用数量；不会创建目标父目录。

迁移到新根：

```bash
npm run backup -- migrate \
  --backup "/path/to/backups/zhitai-2026-08-27" \
  --target-root "/new/location/zhitai"
```

迁移先执行一次完整隔离恢复，再把能唯一映射到已恢复知识包的 `video_asset.file_path/package_path`、`legacy_package.package_path` 和 `platform_post.raw_json_path` 重绑定到新根。随后：

- 所有 `queued/running/scheduled` 发布任务变成 `needs_attention`，`approved=false`；
- 持久发布排期中的 `scheduled/queued/retry_wait/preflighting/submitting` 任务停止执行并转为待重新确认或待核对；
- 活动分析任务变成 `paused`；
- 活跃生成任务变成 `paused`；
- 快点重供命令变成 `needs_attention`；
- watcher 的旧机器绝对路径状态被清空；
- 非终态 `import_item/import_batch` 统一变成 `needs_attention`；能由资产编号和包内相对路径证明的导入路径会重绑，无法解析的活动引用会阻止启用；
- 不调用网络、不启动节点、不发送、不发布。

只有不存在且不与备份重叠的目标可用；工具先原子创建新目标目录，再以排他复制写入，完整哈希和 `fsync` 后才把 `.zhitai-migration.pending.json` 改名为 `.zhitai-migration.json`。没有阻断引用时状态为 `ready_not_activated`，仍需人工检查配置和排期后再启用；有无法解析的活动引用时状态为 `blocked_needs_attention`，不得启用。复制中途失败时，新目标会按创建时的设备/inode 身份自动改名到同级 `.目标名.migration-failed-*/payload`，不会留下看似可用的半成品，也不会删除内容。

可恢复回滚：

```bash
npm run backup -- rollback \
  --target-root "/new/location/zhitai" \
  --migration-id "migration_..."
```

回滚只接受目标内的普通文件迁移标记，并核对迁移编号格式、规范目标指纹、创建时设备/inode 指纹和完成时整树 SHA-256。它不会删除内容，而是把新迁移根改名到同级 `.目标名.rolled-back-*/payload` 隔离目录；原机器数据从未被修改，因此可以继续使用。迁移编号不匹配、标记被复制/替换、目标树在迁移后变化、目标是符号链接或目标不是工具创建的迁移根时均拒绝。

## 自动化测试和恢复演练

```bash
npm run test:backup
```

测试全部使用随机临时目录、真实 SQLite 文件和真实 WAL 提交，不使用 mock 数据库；不访问网络、不 spawn 发布器。覆盖：

- writer 保持打开且未 checkpoint 的 WAL 提交进入快照；
- Online Backup 与 `VACUUM INTO` 回退；
- BagIt/tagmanifest/逐文件 SHA-256；
- `Payload-Oxum`、manifest 聚合值、未知 namespace 和允许状态路径；
- 秘密文件名与安全文件名内的 Cookie/Token、密码导出、钥匙串、二维码目录、原始响应、缓存、引擎/虚拟环境、SQLite 源符号链接和知识树符号链接排除；
- JSON 保守字段、SQLite EAV/敏感容器/数值材料、CSV 敏感列、未知扩展、plist 和伪媒体文件头均 fail closed；
- payload 位翻转、manifest/tag 独立改写和完整重算校验后的越权注入均 fail closed；
- 隔离恢复的 `integrity_check`、外键、资产数、任务数和文件哈希；
- 源内深层备份输出、恶意恢复 prefix、备份内恢复父目录、直接/符号链接迁移重叠均零写入拒绝；
- 迁移预览零写入、资产/导入路径重绑定、发布排期/分析/生成/导入安全闸；
- 各发布状态矩阵、无法解析活动导入阻断、迁移复制失败自动隔离；
- 目标已存在拒绝、回滚编号逃逸拒绝、目标变更拒绝和可恢复回滚；
- 平台回执固定字段、平台身份配对、不可覆盖写入与敏感值脱敏；
- CLI 失败只输出结构化错误码，不回显测试秘密 marker。

本次实现的实测演练记录见 [`BACKUP_RECOVERY_DRILL_REPORT.md`](BACKUP_RECOVERY_DRILL_REPORT.md)。

## RPO / RTO 建议

- 本机 RPO：不超过 15 分钟；每次升级、迁移或批量导入前额外创建一次备份。
- 异地 RPO：不超过 1 小时；只复制已经 `verify` 成功的完整 BagIt 目录。
- 常规 RTO：数据量不超过 10 GiB 时，完整复制、全量 SHA-256、SQLite 校验和计数核对不超过 30 分钟。
- 大型或异地恢复 RTO：目标不超过 2 小时；应按真实介质吞吐调整。
- 每月做一次真实隔离恢复演练；每季度做一次迁移到新根并执行可恢复回滚。

RTO 从开始读取备份算到完整校验报告通过，不能只计算文件复制时间。

## 已知风险和操作建议

- SQLite 快照是事务一致的；每个普通文件也有稳定性检查，但当前没有由 server 所有写路径共同遵守的全局 epoch/quiesce 锁，因此整包属于经过交叉核对的 fuzzy snapshot，不能宣称 SQLite、JSON 队列和知识树处于同一个全局时点。现有内容包以 staging + rename 生成且成片落盘后通常不再变化；高变更时段应短暂停止导入/生成/排期修改或使用 APFS 快照。后续建议给所有持久化写入增加全局 epoch，备份前后 epoch 不同则整轮重试。
- Online Backup 在持续高频写入下可能反复重启。应在低峰执行，并为外层调度器设置总运行时限和失败告警。
- 如果 manifest 的 `software.sqliteWalResetFixStatus` 为 `runtime_upgrade_recommended`，应在下一次维护窗升级 Node/SQLite 并重新做演练；不要把一次通过的备份当作继续长期运行旧 WAL 引擎的理由。
- 只有明确允许的媒体/PDF 扩展且文件头 magic 匹配时，二进制资产才可进入；未知/归档/其他不透明类型会让备份失败。已识别二进制仍不做内容级秘密、OCR 或二维码扫描，它们依赖路径/文件名排除、符号链接拒绝和资产引用校验。不要把秘密伪装或嵌入正常媒体/PDF；若有这类威胁模型，应在进入知识库前增加专门 DLP、OCR/二维码检测，或默认禁用 PDF/图片类扩展。
- SHA-256 可发现损坏，但攻击者若能同时重写 payload 和所有 manifest，仍可伪造。需要抗恶意篡改时，应把 `tagmanifest-sha256.txt` 的摘要保存到另一可信介质或增加独立签名。
- 路径重绑定只处理能通过资产编号、包内相对路径和唯一文件定位证明的引用。终态外部下载路径可作为历史记录保留；任何非终态无法解析引用都会变成 `needs_attention` 并把迁移标记置为 `blocked_needs_attention`。
- 第一方平台回执从本版本开始完整保存；升级前经 MatrixMedia 直连、但未落盘的历史回执无法从织台数据中追溯，不能伪造补齐。
- 不要把 `config.local.json`、钥匙串、浏览器/Electron Profile 或第三方引擎目录另行塞进 BagIt。新机器上的账号登录应单独重新建立。
