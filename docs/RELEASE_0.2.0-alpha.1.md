# 织台 v0.2.0-alpha.1 发布说明

v0.2.0-alpha.1 是织台的第二个 Public Preview，也是首个 Windows x64 公开预览版。支持的 Windows 环境是 Windows 10 22H2 和 Windows 11 x64。

## 下载与安装

Release 预计提供：

- `Zhitai-Setup.exe`：当前用户安装包；
- `Zhitai-*.zip`：便携包；
- `SHA256SUMS.txt`：发行文件的 SHA-256 校验值。

只从本项目的 GitHub Releases 页面下载，并在运行前核对 SHA-256。本预览版暂未代码签名，Windows SmartScreen 可能显示“未知发布者”。若文件来源或哈希不一致，请不要继续运行。

安装和源码构建步骤见 [Windows 预览版](WINDOWS.md)。

## 本次更新

- 新增 Windows 10 22H2/Windows 11 x64 桌面预览构建；
- 新增可验证的 BagIt/SQLite 备份、隔离恢复、迁移预览与可恢复回滚；
- 新增脱敏诊断快照，便于在不携带真实凭据的前提下分享必要运行状态；
- 新增统一内容生命周期契约，明确从收件到发布回读/对账的状态与幂等边界；
- 新增运营指标数据契约、只读报告与合成示例；
- 新增 19 个场景、352 条断言的整链离线 E2E 与故障注入。Windows 使用进程级断网护栏，Linux Docker 另加内核级断网。

## Windows 功能边界

Windows 预览版面向本地工作台、知识库、任务/人工审核流与内容状态记录。下列能力尚不支持：

- 原生第三方发布；
- 第三方外置服务的自动安装、发现、启动或管理；
- 微信、浏览器点击/登录/发布等自动化；
- 依赖 macOS LaunchAgent 或钥匙串的后台与凭据流程。

对上述能力的调用以 HTTP 501 和稳定错误 `unsupported_on_windows_preview` 失败关闭，不会在后台继续执行。

## 验证声明

离线 E2E 使用临时目录、合成媒体和模拟平台回执，验证状态、幂等、恢复、追溯和脱敏契约。它不证明真实平台 UI/API、真实账号、媒体编解码或验证码交互可用。Windows 作业不宣称内核级隔离；该层仅由 Linux Docker `--network none` 提供。

备份恢复、离线 E2E 和 Windows 支持都处于 Alpha 阶段。在重要数据或真实账号上使用前，请先使用非生产副本验证恢复结果，并保留人工审核与发布决策。
