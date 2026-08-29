# 织台备份恢复演练报告

## 演练结论

- 日期：2026-08-27 至 2026-08-30（Asia/Shanghai）
- 结果：通过
- 类型：真实文件级隔离恢复演练；使用临时受控数据集，不使用 mock SQLite，不读取或复制生产秘密
- 运行时：Node.js 24.19.0，SQLite 3.53.3
- 网络/平台动作：0；未启动织台节点、浏览器、MatrixMedia 或任何发布器
- 当前用户数据：未修改、未覆盖、未删除；演练前后的独立 sentinel 字节一致
- 隐私记录：仅保留相对测试文件名和聚合计数，不记录主机名、用户名、本机绝对路径或账号身份

## 演练数据集

受控数据集刻意覆盖了真实存储形态：

- SQLite 处于 WAL 模式，writer 在整个备份期间保持打开；
- `wal_autocheckpoint=0`，1 个资产、1 个导入任务和收据等记录在已提交但未手动 checkpoint 的 WAL 中；
- 1 个知识内容包，含媒体、`metadata.json` 和脱敏元数据；
- 任务、分析/生成队列、重供队列、watcher、事件、创作审核、5 个旧发布任务、3 个持久发布排期和逐平台回执；
- 用于负向验证的未脱敏 raw、Token/密码导出、钥匙串、二维码目录、缓存、第三方引擎/虚拟环境目录、未知/plist 文件、伪媒体和符号链接。

备份 `backup_drill_001` 生成 18 个 payload 文件。业务基线为：

| 核对项 | 基线 | 恢复后 |
| --- | ---: | ---: |
| `video_asset` | 1 | 1 |
| 知识包 | 1 | 1 |
| 知识文件 | 3 | 3 |
| 总任务计数 | 12 | 12 |
| `import_item` | 1 | 1 |
| `tasks.json` | 5 | 5 |
| 分析队列 | 1 | 1 |
| 生成队列 | 1 | 1 |
| 重供队列 | 1 | 1 |
| 发布任务文件 | 5 | 5 |
| 持久发布排期 | 3 | 3 |
| 平台回执计数 | 2 | 2 |
| 下载收据 | 1 | 1 |

## 执行和证据

执行命令：

```bash
node --test --test-timeout=25000 \
  tests/backup-recovery.test.mjs \
  tests/backup-security.test.mjs \
  tests/platform-receipts.test.mjs

node --test --test-timeout=25000 \
  tests/matrix-publish-receipts.test.mjs \
  tests/zhitai-matrixmedia-adapter.test.mjs
```

关键结果：

- SQLite Online Backup API 成功生成独立快照；manifest 记录源 `journalMode=wal`、`walPresentAtSnapshot=true`、`rawWalCopied=false`。
- 快照规范化为独立 `kb.sqlite`，没有复制源 `-wal/-shm`；恢复查询到了 WAL 中的资产和任务行。
- BagIt `Payload-Oxum`、payload manifest、tagmanifest 和织台 manifest 全部通过聚合计数与 SHA-256；数据库资产引用能定位到恢复知识包。
- 未脱敏 raw、`.env.*`、Cookies/浏览器会话、Token/密码导出、Keychains、二维码文件/目录、缓存、引擎/虚拟环境、私有目录和主库/WAL sidecar 符号链接均未进入 manifest 或 payload；安全 JSON/文本文件名中的假 Token 以及 SQLite 文本中的假 Token 都在写目标前以固定错误码失败关闭，测试 marker 没有出现在输出或备份中。备份专用保守分类还逐项阻断 `credential(s)`、`privateKey/private_key`、`sessionId/session_id`、`qrCode`、`passphrase` 和 JSON 裸 `key`；唯一例外严格限定为真实 `schema_version.key=kb_migrate` 业务标签。
- SQLite EAV/config 动态键、敏感容器表和数值 OTP、CSV 敏感列、JWT/bearer 字段及原始 compact JWT 均失败关闭；未知 `.dat`、plist 被拒绝，文本改名 `.mp4` 因 magic 不符被拒绝。`raw-yuanbao.sanitized.json` 即使经完整重签注入缓存目录，验证仍拒绝。
- 恢复路径由 `mkdtemp` 新建，权限边界为隔离目录；当前数据 sentinel 未变化。
- 恢复后 `PRAGMA integrity_check` 恰好返回 `ok`，`PRAGMA foreign_key_check` 返回 0 行。
- 资产数、分任务计数、知识文件数和每个恢复文件 SHA-256 均与 manifest 一致。
- 对一个 payload 媒体文件改写后，`verify` 以大小/哈希错误 fail closed。
- `VACUUM INTO` 兼容回退也通过完整创建和验证。
- 迁移预览没有创建目标父目录；真实迁移只写入不存在的新根。
- 迁移后 `scheduled/queued/running` 旧发布任务及发布任务文件均为 `needs_attention` 且 `approved=false`；持久发布排期中的活动任务转为待重新确认或待核对；分析和生成任务为 `paused`；`draft/submitted/public` 等终态保持原值；非终态导入项/批次也被暂停；没有执行发送或发布。
- 无法解析的活动导入路径会得到 `blocked_needs_attention`，不会伪装成 ready；可证明位于内容包内的导入路径正确重绑。
- 注入迁移复制故障后，新目标自动进入可恢复 `.migration-failed-*/payload`，没有半成品目标；故障原文中的假秘密 marker 未落盘。
- 回滚拒绝恶意迁移编号和迁移后被改动的目标；合法回滚没有删除迁移数据，只把新根改名到可恢复的 `.rolled-back-*/payload` 隔离目录。
- 位于当前数据根内的深层备份输出、恶意 restore prefix、位于备份内的恢复父目录、直接或经符号链接指入备份的迁移目标均在创建目标父目录前拒绝。
- 额外文件、单独改写 manifest/tag、路径逃逸，以及攻击者完整重算校验后的 `data/state/token.json`/`data/other` 注入均失败关闭。

自动化结果：4 个相关实现文件的 `node --check` 全部通过；备份/恢复/迁移测试 12/12、路径/篡改/CLI 安全测试 8/8、平台回执与服务器接线测试 7/7，合计 27/27 通过、0 跳过、0 失败。当前 MatrixMedia 回执与适配器契约回归另有 30/30 通过、0 跳过、0 失败；相关组合共 57/57 通过。耗时会随机器与文件系统变化，因此不把单次开发机耗时作为 RTO 证据。

## RTO 说明

本次数据集很小，只用于验证正确性和安全边界，不能作为真实大型知识库的 RTO 基准。正式验收还应在目标备份介质上对完整非秘密数据集计时，测量：

1. SQLite 快照；
2. 文件复制与 SHA-256；
3. 隔离恢复；
4. 全量哈希和 SQLite/业务计数核对。

当前建议目标为：10 GiB 以内完整 RTO 不超过 30 分钟，异地或大型恢复不超过 2 小时；实测后修订。

## 尚存风险

- 本演练证明 WAL、manifest、恢复和迁移机制真实可运行，但没有复制任何本机生产知识库，以避免在公开记录中处理未审计秘密或产生额外生产副本。
- SQLite 与 JSON/知识树缺少 server 全写路径共同遵守的全局 epoch，属于经过资产交叉核对的 fuzzy snapshot，而不是全局同一时点；高变更时段仍应短暂停止导入/生成/排期修改或结合 APFS 快照，后续增加 epoch 前后相等重试。
- SHA-256 未做独立签名，不能单独抵御拥有整个备份写权限的恶意重写者。
- Node 标准 `rename` 没有目录级 no-replace 标志；实现用同名排他锁、最终存在性复核和唯一 staging 防止本工具并发覆盖，但不把本地同权限恶意进程视为可信。跨主机分发时仍应使用只读介质或独立签名。
- 已识别媒体/PDF 只做扩展名、magic、路径策略和 SHA-256，不做二进制 DLP/OCR/二维码识别；秘密若被嵌入正常二进制内容仍可能进入备份。需要抵御该威胁时，应在入库前增加专门扫描或禁用相应二进制类型。
- 本版本以前没有落盘的 MatrixMedia 直连历史回执无法补救；新回执账本只保证升级后的记录。
