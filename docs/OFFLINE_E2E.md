# 织台整链离线 E2E 与故障注入

这套测试是织台整链状态契约的可执行验证：使用真实临时文件系统与临时 SQLite，所有下载、分析、生成、审核、平台发布和回读边界均由进程内模拟适配器实现。它不读取真实聊天、浏览器资料、钥匙串、账号、平台历史或个人媒体，也不会启动织台桌面端、本地 agent、MatrixMedia 或任何现有后台。

## 运行

要求 Node.js 22.13 或更高版本，不需要安装 npm 依赖：

```bash
pnpm run test:offline-e2e
```

运行器会先预加载 `tests/e2e/network-lockdown.mjs`，拒绝包括回环地址在内的全部 `fetch`、HTTP(S)、TCP、TLS、UDP 和 DNS 调用。护栏同时封锁 TCP server、UDP `Socket` 构造器/方法、Worker Threads 和普通子进程；唯一例外是参数、环境与预加载项均严格校验的崩溃注入 worker。随后为本次运行创建临时 `HOME`、临时数据库和逐场景沙箱。在导入测试代码前，runner 会删除继承自用户 shell 的所有其他环境变量，只重建临时目录、Node 路径、locale/时区与离线护栏所需的最小白名单；套件会用一个假凭据环境哨兵验证这一点。默认完成后删除沙箱，只保留：

```text
.artifacts/offline-e2e/<UTC 时间>.json
.artifacts/offline-e2e/latest.json
```

可用参数：

```bash
node --import ./tests/e2e/network-lockdown.mjs scripts/run-offline-e2e.mjs \
  --report .artifacts/offline-e2e/manual.json
```

`--keep-sandbox` 仅供本地调试；CI 不应使用。沙箱本身也只包含合成素材和假回执。runner 同时隔离 POSIX `HOME` 和 Windows `USERPROFILE`/`APPDATA`/`LOCALAPPDATA`，Windows 上仅保留启动 Node 子进程所需的 `SystemRoot`/`SystemDrive`/`ComSpec`/`PATHEXT`，不传入凭据环境变量。

临时根目录创建也属于可报告的 bootstrap 阶段。如果 `TMPDIR` 无效或临时目录不可创建，runner 仍会优先向指定报告位置、否则向仓库 `.artifacts/offline-e2e` 写入权限为 `0600` 的失败 JSON；连回退位置也不可写时，stdout 会输出一行经过脱敏的 JSON，而不会暴露失败路径。

## 合成测试素材

所有媒体在运行时由纯 Node 代码确定性生成，不提交、不复制也不读取任何真实媒体：

- `tone`：短时单声道 PCM WAV，固定采样率、频率和振幅，用于正常收件、入库、分析和产物链路；
- `silent`：容器与时长合法、样本全为零，用于验证无声媒体和质检失败；
- `invalid`：故意破坏的 RIFF/WAVE 字节，用于验证媒体门禁；
- 生成产物是另一组固定参数的合成 PCM，不包含人物、声音、账号或版权内容。

仓库原有测试使用的真实 MP4 也已替换为 `tests/fixtures/synthetic-mp4.mjs` 生成的最小结构化 MP4 夹具。该夹具只包含 `ftyp`、`moov/mvhd` 和无语义 `mdat` 字节，专门验证织台内建容器扫描与文件事务，不代表真实编码质量。

## 覆盖模型

主成功路径按顺序验证：

```text
收件 → 下载 → 媒体校验 → 入库 → 分析 → 生成产物 → 质检
     → 人工审核 → 草稿 → 排期 → 平台回读 → 指标快照
```

每次投递产生一个不变的 `correlationId`。数据库中的阶段事件、源素材 hash、`promptId`/提示词 hash、生成产物 hash、逐平台尝试、不可变成功回执、回读结果和指标观察都携带该 ID。报告中的终点 trace 会从指标快照反查到平台回执、生成产物、提示词和源素材。

故障矩阵至少包括：

- 重复投递、双 SQLite 连接并发收件、payload conflict、伪造或过期 HMAC 签名；
- 下载 HTTP 500 后恢复；
- 无效媒体与全静音媒体；
- 登录过期与验证码转人工；
- 单平台失败和多平台部分成功；
- 仅重试失败平台、成功平台回执不可覆盖；
- 阶段执行或平台 `publishing` claim 中进程崩溃后的恢复、Mac boot ID 变化和错过排期的重新审核语义，以及恢复提交前故障的整体回滚；
- 双连接相反人工审核和重新排期的 first-writer-wins，以及草稿、排期和派发的并发重复点击幂等；
- `ENOSPC` 磁盘不足后可恢复；
- 不合格成片不计入完成量；
- token、Cookie、签名 URL、账号字段、绝对路径和注入错误消息的递归脱敏。

## 报告契约

JSON 报告顶层至少包含：

- `schemaVersion`、`suite`、`runId`、`status`、起止时间；
- `offline: true` 与 `networkPolicy: "deny_all"`；
- `environment`：临时 HOME/SQLite、合成媒体、模拟平台、内核网络隔离状态和继承凭据环境已清理的声明；
- `summary`：通过、失败和断言数；
- `scenarios[]`：稳定场景 ID、状态、耗时、故障、阶段和关联 ID；成功全链还保存脱敏的 trace proof，包括源 hash、提示词 ID/hash、产物 hash、回执 hash 与指标到回执的链接；
- `coverage`：阶段、故障与关键不变量的机器可读布尔矩阵；
- `gaps[]`：尚未覆盖的真实系统边界。

报告在写盘前再次做敏感标记扫描；发现泄漏时整次运行失败。报告文件以临时文件加原子 rename 写入，权限为 `0600`。

## CI 接入

`.github/workflows/offline-e2e.yml` 以只读仓库权限运行独立任务，checkout 不持久化 GitHub 凭据。Linux 作业先拉取同时固定 patch tag 和镜像 digest 的 Node 22.13 slim 镜像，再以 Docker `--network none`、只读容器根、临时 `/tmp`、移除 Linux capabilities 和 `no-new-privileges` 运行同一个 npm script。挂载报告目录前还会拒绝 `.artifacts` 或其子目录为符号链接的工作树。容器层切断对主机和外部网络的访问，进程内预加载护栏继续封锁 loopback 与可创建新执行上下文的 API，形成两层隔离。报告中的 `environment.kernelNetworkIsolation` 记录这一层是否启用，`credentialEnvironmentSanitized` 记录进程环境白名单已生效。第二个独立作业在 `windows-latest` 直接运行同一 Node 套件，验证 Windows 路径和子进程恢复；它保留进程内护栏，但不会宣称已启用 Linux 内核级网络隔离。本地也可在 macOS、Linux 或 Windows 直接运行。无论成功或失败，JSON 报告都会作为短期 CI artifact 上传。

如接入其他 CI，只需运行同一个 npm script，并保存 `.artifacts/offline-e2e/*.json`。不要移除 `--import ./tests/e2e/network-lockdown.mjs`。

## 明确的覆盖边界

本套件验证织台的整链状态、幂等、恢复、追溯和脱敏契约，但当前不会导入桌面端/server 的真实编排代码；它是生产端口接入该契约前的可执行参考实现，而不是“现有生产整链已经满足这些性质”的证明。它也不会证明真实平台 UI/API、真实媒体编解码器、真实验证码交互或 macOS LaunchAgent 本身可用。Docker `--network none` 只加强测试隔离，并不会把模拟适配器变成真实平台验证。真实适配器只应在另一个显式授权、人工在场、不会公开发布的验收层验证；不得把真实凭据或录制流量加入本套件。

若真实平台已接受发布、进程却在本地成功回执提交前退出，严格的远端 exactly-once 仍依赖平台幂等键和启动后的回读对账；当前 harness 会在显式调用 `recover()` 时回收孤儿 claim，不会在仍存活的进程内自动超时抢占。

设计上评估过 Nock 与 Toxiproxy：它们分别适合 HTTP 拦截和网络故障代理，但本任务还要求数据库、磁盘、进程及 boot 语义，并且必须零网络、零额外守护进程，因此采用仓库已有的 Node 测试生态与注入式故障计划。
