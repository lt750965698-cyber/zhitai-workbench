# Windows 预览版

织台 v0.2.0-alpha.1 首次提供 Windows 10（22H2）与 Windows 11 的 x64 公开预览版。每个版本同时生成：

- `Zhitai-Setup.exe`：无需管理员权限的当前用户安装包。
- `Zhitai-*.zip`：解压后直接运行的便携包。
- `SHA256SUMS.txt`：安装包和便携包的 SHA-256 校验值。

## 安装

1. 只从本项目的 GitHub Releases 页面下载安装包和 `SHA256SUMS.txt`。
2. 在 PowerShell 中运行 `Get-FileHash .\Zhitai-Setup.exe -Algorithm SHA256`，确认结果与校验文件一致。
3. 运行 `Zhitai-Setup.exe`。预览版暂未购买代码签名证书，Windows SmartScreen 可能显示“未知发布者”；确认文件来源与哈希后，可选择“更多信息”→“仍要运行”。如果下载来源或哈希不一致，请不要继续运行。

织台的应用状态、日志和本地运行数据默认保存在 `%LOCALAPPDATA%\Zhitai`，不会写入 `Program Files`。卸载应用不会自动删除这份用户数据。

## 当前支持范围

Windows 预览版支持本地工作台、知识库导入与检索、任务/人工审核流以及内容状态记录。用户可以手动打开第三方网站，但这不包括自动点击、登录、抓取或发布。Windows 上的发布相关内容可用于草稿、审核和状态记录，不会在后台执行原生第三方发布。

以下能力依赖 macOS 或尚未完成 Windows 安全适配，因此在 Windows 预览版中失败关闭：

- 微信 ClawBot、文件传输助手和浏览器点击/登录/发布自动化，以及 LaunchAgent 后台常驻；
- MatrixMedia/Cua Driver 驱动的本机平台发布；
- MoneyPrinterTurbo、闲鱼监控等外置 Python/Go 引擎的自动发现与自启动；
- 本机模块自动更新及需要 macOS 钥匙串的凭据读取。

这些限制不会阻止使用本地知识库与内容工作流。调用不支持的能力时，本地节点以 HTTP 501 和稳定错误 `unsupported_on_windows_preview` 失败关闭；不会在后台继续尝试对应动作。

## 本次预览的验证范围

- 可验证备份、隔离恢复、迁移预览和可恢复回滚；
- 脱敏诊断快照、内容生命周期契约与运营指标只读报告；
- 19 个场景、352 条断言的整链离线 E2E。Windows CI 使用进程级断网护栏；Linux Docker CI 在同一进程级护栏外另加内核级断网。

离线 E2E 使用合成媒体和模拟平台回执，验证状态、幂等、恢复、追溯与脱敏契约。它不会证明真实平台 UI/API、真实账号、媒体编解码或验证码交互在 Windows 上可用。

## 从源码构建

需要 Node.js 22.13 或更高版本、pnpm 11.19 或更高版本，以及 Windows x64：

```powershell
$env:PNPM_CONFIG_NODE_LINKER = "hoisted"
pnpm install --frozen-lockfile
pnpm lint
pnpm build
pnpm test:node
pnpm make:windows
```

构建结果位于 `out\make`。Electron Forge 依赖磁盘上的普通 `node_modules` 布局，所以 Windows 打包任务必须使用 pnpm 的 `hoisted` linker。
