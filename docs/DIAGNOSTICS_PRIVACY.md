# 织台诊断隐私、权限与保留策略

## 结论

诊断通道采用固定字段白名单。默认只保存服务器时间、固定枚举、布尔信号和限幅计数；未知字段不会透传。聊天正文、HTML、Cookie、Token、凭据、手机号、完整 URL、签名查询参数和绝对路径在磁盘、事件日志、状态 API 与诊断导出中均无对应字段。

浏览器桥在页面内计算结构化计数后才调用 `/api/v1/diag`。失败消息只保留字段是否存在、长度桶和有限类型码；面板与剪贴板不再包含页面地址、消息字段值、HTML 片段或链接。稳定分享链接在提交前只保留平台 host 与严格匹配的身份路径，所有 query/hash 都会丢弃，未知 query key 也不能成为私聊或凭据通道。GM 去重存储只读取新的 `v2` 指纹键；旧版完整 URL 键不会在启动时读取或迁移。

仓库中的浏览器桥不读取、备份或跨域附带 Cookie，不把完整下载 URL 写入剪贴板，也不把动态响应写入日志。运行时只保留完成当前投递所需的有界内存状态，页面关闭后由浏览器释放。

## 默认策略

| 项目 | 默认值 | 硬上限 |
| --- | ---: | ---: |
| 新格式事件保留时间 | 24 小时 | 7 天 |
| 新格式事件数量 | 100 | 500 |
| 新格式总字节 | 5 MiB | 25 MiB |
| 单事件字节 | 16 KiB | 32 KiB |
| 调试会话 | 关闭 | 最长 60 分钟 |

- 诊断目录每次初始化都校验为普通目录；POSIX 上收紧至 `0700`，Windows 上依赖当前用户 Profile 与 NTFS ACL。
- 常规文件拒绝符号链接；POSIX 上收紧至 `0600`。新文件通过 `wx` 临时文件、同步和无覆盖硬链接原子发布。
- 严格命名的临时文件同时充当 writer claim：一小时内的其他 writer/temp 会失败关闭；超过一小时的单链接残留只按 metadata 回收。`link(temp, final)` 后中断仅在 temp/final 同 inode、同 owner、双链接完全匹配时完成发布。
- 保留策略只识别 `zhitai-diag-v2-*.json`。旧 `sync-*.json` 和未知文件永远不会被自动轮转删除。
- 调试模式不会恢复正文；它只增加 payload shape、字段数、深度以及敏感类别“出现次数”等安全统计。
- POSIX 系统上，安装器、LaunchAgent 和启动器使用 `umask 077`；织台专属日志目录为 `0700`、日志文件为 `0600`，不修改用户的上层日志目录。Windows 使用当前用户的本地应用数据目录；POSIX mode 数字在 NTFS 上不等同于 ACL 保障。

配置示例：

```json
{
  "diagnostics": {
    "retention": {
      "maxAgeMs": 86400000,
      "maxFiles": 100,
      "maxBytes": 5242880,
      "maxEventBytes": 16384
    },
    "debug": {
      "enabled": false,
      "expiresAt": null
    }
  }
}
```

临时调试必须同时把 `enabled` 改为 `true`，并把 `expiresAt` 设为未来不超过 60 分钟的 ISO 时间。缺少到期时间、已经到期或窗口超过 60 分钟都会保持关闭。每次记录都会重新检查时间，进程重启不会让过期配置复活。也可使用 `ZHITAI_DIAGNOSTICS_DEBUG_ENABLED=true` 与 `ZHITAI_DIAGNOSTICS_DEBUG_EXPIRES_AT=<ISO 时间>`；同样受 60 分钟硬上限约束。

## API

- `POST /api/v1/diag`：接收诊断输入，但只写固定 schema；兼容旧客户端发送的 `url`/`text`，这些值只用于内存计数，绝不落盘或回显。
- `GET /api/v1/diagnostics`：只返回调试是否有效、到期时间、配额、受管事件数量/总大小/时间范围和固定权限模型；Windows 不伪装报告 POSIX mode 已生效。
- `GET /api/v1/diagnostics/export`：只导出重新按固定 schema 投影的新格式受管事件，不读取或打包 legacy/未知文件。
- `/api/v1/inbox` 只接受严格稳定分享路径，持久化前无条件去掉 query/hash；`/api/v1/channels/card` 与 `/api/v1/kuaidian` 忽略浏览器提供的 `title/content`，标题只能由后续可信媒体元数据补全。
- `/api/v1/kuaidian` 的临时媒体 URL 是业务下载输入而非诊断数据：只在下载所需的内存生命周期内使用，数据库只保存指纹，日志/API 不回显原 URL。

## 旧数据只读盘点

盘点命令只调用 `readdir` 与 `lstat`，不打开文件、不跟随符号链接、不输出文件名或路径。它只报告数量、总字节、时间范围、权限直方图与特殊文件数量：

```bash
node local-agent/diagnostics-maintenance.mjs preview --data-dir '<dataDir>'
```

任何 `--apply`、`--delete`、`--cleanup`、`--migrate` 或 `--isolate` 参数都会被稳定拒绝。请不要把本机盘点输出提交到公开仓库。若预览前后的数量或字节数发生漂移，说明旧运行时可能仍在写入；任何经明确授权的隔离或清理操作都必须先停写并重新预览。

## 旧数据处置预览

1. **权限迁移预览**：部署新版本后，诊断目录和常规文件会在不读取正文的前提下收紧权限。建议先停止旧服务并重新运行 metadata-only 盘点，确认数量与时间范围没有漂移。
2. **隔离预览**：经用户明确确认后，可在同一文件系统内把整个 legacy 目录原子 `rename` 到仅当前用户可访问的隔离目录。遇到跨卷 `EXDEV` 必须停止，不能退回复制正文。
3. **清理预览**：经用户明确确认后，按重新盘点得到的快照执行。实施前必须再次核对数量、总字节、时间范围和权限分布；任何漂移都应中止。当前实现没有删除入口。
4. **内容脱敏迁移不可用**：把旧原文转换成“脱敏副本”必须读取正文，与本次约束冲突，因此不提供。

## 旧版浏览器缓存处置

- 当前文件助手桥和伴生桥只在用户通过浏览器确认框明确同意后，才按固定键删除可识别的旧版敏感缓存；清理过程不读取、显示或复制键值。
- 未确认时旧值保持原状；不同用户脚本管理器或脚本作用域中的历史副本可能仍需在对应旧脚本中处理。

## 验证口径

回归夹具使用伪造 Bearer/Session、手机号、私聊正文、HTML、POSIX/Windows 私有路径以及带签名/Token 的本机临时 URL。测试同时扫描临时数据目录、子进程 stdout/stderr、状态/任务/知识库 API 与诊断导出，并检查桥的持久化、剪贴板、Cookie 和原始诊断 sink。所有网络测试只连接测试进程自己的 `127.0.0.1` 端口。

```bash
node --test tests/diagnostics.test.mjs tests/local-agent-diagnostics.integration.test.mjs tests/zhitai-diagnostics-bridge.test.mjs
pnpm lint
```

这些项目内回归不等同于第三方安全审计。

## 剩余风险

- `0700/0600` 不能防止同一 POSIX 用户、root、已授权备份、快照或恶意同用户进程读取数据；Windows 还需依赖用户 Profile 和 NTFS ACL。
- legacy 文件正文仍然存在；权限收紧降低暴露面，但在用户明确确认隔离或清理前不会消失。
- 当前已安装的旧运行时不会因工作树代码变更自动更新；安装新版本前，旧进程仍可能继续产生旧格式文件。
- 结构化计数仍可能透露活动量和时间；导出前仍应确认接收方与用途。
- 页面内存仍会在页面关闭前保留下载所需的消息结构/临时 URL（各 200 条上限）；同用户恶意脚本或被攻陷页面仍可能读取这些运行时值。
- 临时媒体 URL 与稳定分享 URL 仍会作为核心入库输入发往本机 `127.0.0.1`；第三方下载引擎的远端协议与平台行为不属于诊断保留策略。
- 主任务、内容库和第三方引擎有各自的数据契约。本策略覆盖诊断通道及其已识别的浏览器/签名 URL 旁路，不等同于对所有业务数据的删除策略。
- 一小时内的新鲜 temp 会被保守视作并发 writer；进程崩溃后最多可能暂时阻断新诊断写入一小时，这是失败关闭带来的可用性取舍。

设计依据：[OWASP Logging Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html)、[OpenTelemetry 敏感数据处理](https://opentelemetry.io/docs/security/handling-sensitive-data/) 与 [Node.js 文件权限 API](https://nodejs.org/api/fs.html)。
