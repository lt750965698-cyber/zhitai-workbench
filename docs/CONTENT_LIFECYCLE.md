# 织台统一内容生命周期契约

状态：规范 v1；适用于当前本地节点、`kb.sqlite`、内容包、JSON 队列和 `/api/v1/*`。

本规范补足 [架构与信任边界](ARCHITECTURE.md) 和 [短视频知识库字段契约](VIDEO_KNOWLEDGE_SCHEMA.md)，不创建第二套内容数据库或平行任务系统。`local-agent/content-lifecycle.mjs` 是对现有事实源的只读投影与校验器；底层模块仍负责写入自己的事实。

## 1. 规范目标

统一链路为：

```text
采集 → 下载 → 入库 → 分析 → 生成 → 质检 → 人工审核 → 草稿 → 排期
     → 平台公开回读 → 指标快照 → 归档
```

每一阶段必须区分四种不同事实：

1. **受理**：请求、消息或命令已被本机接受；
2. **执行**：本机或适配器正在工作；
3. **产物完成**：本阶段要求的持久产物和校验证据均存在；
4. **外部业务成功**：平台端已回读到目标事实。

以下证据单独出现时都**不是业务成功**：

- HTTP 2xx；
- 本地节点、浏览器、CLI 或子进程存活；
- 命令退出码 0；
- 本地任务进入 `scheduled`；
- 适配器返回 accepted、queued、success 或 `submitted`；
- 平台草稿创建成功；
- 本地生成任务标记 `completed`。

公开发布的唯一完成证明是：每个目标平台都有与本次批准内容绑定的、可关联的 `public` 回读。没有回读时只能是 `submitted_unverified` 或 `needs_reconciliation`。

## 2. 身份与关联

织台不新增全局“生命周期行”。统一视图按既有身份关联：

| 时段 | 首选身份 | 次选身份 | 禁止用作身份 |
| --- | --- | --- | --- |
| 采集前 | 稳定 `sourceKey`、`delivery_id` | 外部消息事件 ID | 临时下载 URL、Cookie、签名参数 |
| 下载/入库 | 媒体 SHA-256 | 规范化来源 + 平台 `content_id` | 文件名、标题、请求时间 |
| 入库后 | SQLite `video_asset.id` | `legacy_package` 关联 | 内容包绝对路径 |
| 生成 | `asset_id + engine + engine_task_id` | 计划 SHA + 媒体 SHA | UI 队列序号 |
| 发布 | 媒体 SHA + 修订 + 平台 +账号指纹 + 模式 + 排期 | 本地 publish task ID | 原始手机号、Cookie、浏览器 profile |
| 平台回读 | 平台 + 账号指纹 +平台 task/post ID | 规范化公开 URL | 标题相似度 |
| 指标 | `asset_id + content_id + source + observation_id` | — | `captured_at` 单独作为键 |

`platform_post` 当前描述的是**采集来源帖子**，不得拿来冒充织台的出站发布回执。来源帖子与织台新发布帖子即使媒体相同，也是两个不同平台事实。

## 3. 分阶段契约

### 3.1 总表

| 阶段 | 当前唯一真相源 | 当前状态/事实 | 完成不变量 | 终态与人工接管 |
| --- | --- | --- | --- | --- |
| 采集 | SQLite `import_item`；`tasks.json` 仅为入口编排/展示 | `pending/processing`，任务可为 `queued/running/awaiting_*` | 有稳定投递身份或安全 fingerprint；已创建 batch/item；临时 URL 未落盘 | 受理不是完成；失败进入可重供或人工处理 |
| 下载 | `download_receipt` + 实际临时媒体 | `media_validation`、`outcome` | 收据有渠道、开始/完成时间、SHA、大小；媒体探测为 `ok` | `invalid/encrypted/unknown` 不得成为可搜索资产 |
| 入库 | `video_asset` + 内容包媒体；`import_item` 记录本次结果 | `success/linked/duplicate/partial/failed/orphaned` | 资产行、内容包、主媒体、metadata 文件清单一致；实际文件 SHA 匹配 | 成功吸收态为 `success/linked/duplicate`；后三种仅是“本轮轮询终止” |
| 分析 | SQLite 分析表为结构化当前值；包内 JSON/Markdown 为可审计产物 | `available/metadata_only/partial/unavailable` | 每个子产物独立标来源、时间、不可用原因；可用数据与包文件一致 | 缺能力是明确结果，不是失败；半写入需 `needs_attention` |
| 生成 | `creative-jobs.json` 仅管编排；SQLite `remake_generation` + 成片文件证明完成 | 队列 `queued/preparing/retry_wait/transient_wait/ready_*/needs_attention/completed/failed/cancelled` | `completed` 必须有同资产 generation 行、文件、大小、SHA、媒体校验 | 短暂 SQLite/Web 故障有界恢复；未知外部生成结果不重提，转人工核对 |
| 质检 | `video_asset`/generation 的媒体事实 + `assessMediaQuality()` 派生结论 | `blocked/unknown/review/standard/high` | 选中发布字节 SHA 固定；媒体校验 `ok`；blocked 永不外发 | review 需人工批准；媒体内容变化使批准失效 |
| 人工审核 | `creative-reviews.json` 保存自主审核证据；legacy publish task 仍有 `approved` 兼容布尔 | `pending_review/needs_revision/approved_for_drafts/approved_for_publish/approved_for_public/rejected` | reviewer、时间、政策版本、内容/工作流/生成证据摘要和目标范围均持久化；公开执行仍需确认门 | `approved_for_publish` 只进入严格候选池，不自动创建草稿或公开；新字节/文案/目标需新审核 |
| 草稿 | 工作台草稿用本地任务；平台草稿需平台回执 | `draft/platform_draft` | 工作台草稿已持久；平台草稿有逐目标 receipt/task ID 和回读时间 | 草稿不等于公开；公开必须新建/推进经批准的发布尝试 |
| 排期 | `publisher-schedule.json` 是原生发布的 owner；`tasks.json` 只保留不再自动执行的 legacy 任务 | `scheduled/queued/retry_wait/preflighting/submitting/...` | 本地持久化、确定性键、精确账号、绑定 SHA/审核、重启恢复、过期窗口 | 离线错过或到期不确定 → `needs_attention`/`needs_reconciliation`，不盲目补发 |
| 平台公开回读 | `publisher-receipts.json` 持久化逐目标占位与 adapter 候选；Matrix history 是只读候选，尚无统一独立回读 owner | `unknown/submitted/scheduled/draft/public/failed/needs_reconciliation` | 每目标匹配平台、账号指纹、媒体/任务、post ID 或公开 URL、visibility、回读时间和可信 source | adapter 即时 `public` 仍投影为 `submitted`；只有独立回读可成为 `public` |
| 指标快照 | SQLite `metric_snapshot` | 每次 observation 一行 | 关联确认的 `content_id`，包含 source、observation ID、captured time；缺失指标为 NULL | 相同 observation 幂等；新观察时间可追加 |
| 归档 | 当前 HEAD **无结构化真相源**；目录移动和 `ARCHIVE` 事件不够 | 目标契约：`eligible/archived/hold/restore_requested/restored` | 无活跃任务；最终内容包与 manifest SHA 完整；发布意图已回读或标 `no_publish`；保留策略明确 | `hold` 需人工处置；归档必须可验证恢复 |

### 3.2 “终态”的两个含义

现有导入状态 API 的 `terminal: true` 表示“客户端停止本轮轮询”，包括 `failed/partial/orphaned`。这些状态仍可显式重试，不能称为不可变吸收态。

本规范统一用词：

- **settled**：本轮没有后台 worker，轮询可以停止；
- **successful terminal**：完成不变量成立，普通重试不得倒退；
- **absorbing terminal**：除人工纠错/完整性修复外不可再转移；
- **needs attention**：本机确定失败或需要人工补料；
- **needs reconciliation**：外部副作用可能发生但结果不确定，严禁自动重试。

### 3.3 状态词典

下表定义本规范使用的每个状态。`completed` 只完成其所属 owner 的职责；若后续阶段的不变量尚未成立，不能把整条内容链路称为完成。

| Owner | 状态 | 精确定义 |
| --- | --- | --- |
| ingest task | `needs_setup` | 缺固定适配器或安全配置，未开始外部动作；补齐配置后可显式入队。 |
| ingest task | `awaiting_primary_download` | 已受理来源，等待主下载通道交付媒体；未入库。 |
| ingest task | `awaiting_fallback_media` | 主通道确定失败，等待用户或受控回退通道补充媒体；未入库。 |
| ingest task | `queued` | 已持久化且可由唯一 worker 领取，尚未开始执行。 |
| ingest task | `running` | 本地 owner 正在执行；重启后必须按陈旧租约规则恢复，不能并发双跑。 |
| ingest task | `completed` | 编排任务已收敛到可验证的 `success/linked/duplicate` import item；不是分析、生成或发布完成。 |
| ingest task | `failed` | 已知且本轮已停止的失败；只有确认无未知副作用后才可显式重试。 |
| ingest task | `needs_attention` | 自动处理无法安全继续，等待人工补料、纠错或决策。 |
| ingest task | `cancelled` | 本次意图被取消的吸收态；重启不得恢复执行。 |
| import item | `pending` | item 已存在但无 worker 所有权。 |
| import item | `processing` | 唯一 worker 已领取；超过陈旧阈值才可原地回收。 |
| import item | `success` | 本次导入创建了新资产，且入库完成不变量全部成立。 |
| import item | `linked` | 本次投递合法关联到既有资产，并补记来源/收据；没有复制媒体。 |
| import item | `duplicate` | 字节或稳定来源已存在，复用既有资产；仍必须绑定真实 `asset_id`。 |
| import item | `partial` | 只获得部分证据或产物；本轮 settled，但未成功入库。 |
| import item | `failed` | 确定失败且本轮 settled，可在冷却、次数和输入条件满足时显式重试。 |
| import item | `orphaned` | item 指向的资产/包缺失，或历史成功记录完整性失效；需修复或显式重试。 |
| analysis part | `available` | 该子产物真实存在，并带来源/provider 和观察时间。 |
| analysis part | `metadata_only` | 只使用元数据，没有读取对应画面/音轨/平台证据。 |
| analysis part | `partial` | 已取得一部分结果并明确列出缺失范围；不得冒充 available。 |
| analysis part | `unavailable` | 当前能力或输入不足，必须带 reason/missingCapability。 |
| creative job | `queued` | 生成编排已持久化，等待 worker。 |
| creative job | `preparing` | 正在准备分析/复刻计划；进程中断后可安全恢复为 queued。 |
| creative job | `retry_wait` | 本地 SQLite busy 等确定性暂态进入有界退避；未打开外部生成副作用窗口。 |
| creative job | `transient_wait` | 网页生成仍在同一断点短暂等待；保留 `resumeStatus`，最多三次自动唤醒。 |
| creative job | `paused` | 人工暂停或可确认未产生未知外部任务的中止。 |
| creative job | `ready_for_images` | 分析/计划完成，等待图像素材确认。 |
| creative job | `ready_for_seedance` | 图像步骤确认完成，等待 Seedance 生成。 |
| creative job | `ready_for_assembly` | 分段生成完成，等待装配与最终媒体校验。 |
| creative job | `completed` | SQLite generation、实际成片、大小/SHA 和媒体校验均存在；仅有队列 JSON 不足。 |
| creative job | `failed` | 确定失败；输入未变且无未知外部任务时可显式重试。 |
| creative job | `needs_attention` | 短重试耗尽、登录/验证码或证据不足，保留原断点等待显式恢复。 |
| creative job | `cancelled` | 本次生成意图取消的吸收态。 |
| quality | `blocked` | 媒体校验不为 `ok`；禁止任何外部草稿、排期或公开尝试。 |
| quality | `unknown` | 技术元数据不足，不能判定；公开前需补检测或人工处理。 |
| quality | `review` | 可播放但低清阈值触发，必须显式确认后才能公开。 |
| quality | `standard` | 通过基础技术质量阈值，保留原文件。 |
| quality | `high` | 达到当前高清阈值，保留原文件。 |
| human review | `pending_review` | 已冻结待审内容摘要，尚无决定。 |
| human review | `needs_revision` | 审核要求修改；旧批准不可复用。 |
| human review | `approved_for_drafts` | 只批准创建平台草稿，不授权公开。 |
| human review | `approved_for_public` | 对指定 SHA、文案修订、平台/账号和可见范围批准公开。 |
| human review | `approved_for_publish` | 当前自主审核兼容状态：通过严格机器证据门并进入发布候选池；本身不授权或触发外部发布。 |
| human review | `rejected` | 本次内容/范围被拒绝的终态；变更后必须新建审核。 |
| publish task | `draft` | 仅工作台本地草稿已保存，没有平台副作用。 |
| publish task | `needs_setup` | 发布器固定配置不完整，尚未提交。 |
| publish task | `scheduled` | 本地 timer/owner 已持久化且尚未到期；不是平台成功。 |
| publish task | `queued` | 到期或立即任务等待唯一 worker，尚未调用适配器。 |
| publish task | `retry_wait` | 只在外部调用前的确定性暂态故障中有界退避；一旦提交窗口打开不得进入此状态。 |
| publish task | `preflighting` | 正在复核 realpath、SHA、质检、批准和目标身份，尚未提交。 |
| publish task | `running` | 发布 owner 已开始；若重启时遗留，按可能已有副作用处理。 |
| publish task | `submitting` | 已进入外部调用窗口，结果未知时必须转 `needs_reconciliation`。 |
| publish task | `submitted` | legacy 适配器“已接收”；读取时一律投影为 `submitted_unverified`。 |
| publish task | `submitted_unverified` | 适配器受理/退出 0，但平台可见性尚未回读；不得标 100% 或自动重发。 |
| publish task | `platform_draft` | 逐目标平台草稿回读完成；不是公开成功，后续公开需新 attempt。 |
| publish task | `public` | 所有目标均有绑定本次内容的公开回读；唯一公开成功态。 |
| publish task | `failed` | 确认没有成功副作用的确定失败；只有显式授权才能重试。 |
| publish task | `needs_attention` | 已知部分失败、公开意图降级为草稿或需人工处置。 |
| publish task | `needs_reconciliation` | 外部副作用可能发生但无法确定；先人工/只读回读，严禁自动重发。 |
| publish task | `cancelled` | 尚未产生外部副作用的意图被取消；吸收态。 |
| platform receipt | `unknown` | 平台结果不可判定。 |
| platform receipt | `submitted` | 平台/适配器已受理，但无可见性回读。 |
| platform receipt | `scheduled` | 平台称已安排未来动作；仍需到期后回读。 |
| platform receipt | `draft` | 平台草稿可回读且有 task/receipt 身份。 |
| platform receipt | `public` | 有 post ID/公开 URL、可见性与回读时间的公开证据。 |
| platform receipt | `failed` | 平台明确拒绝或失败。 |
| platform receipt | `needs_reconciliation` | 回执彼此冲突或提交窗口超时，需人工核验。 |
| archive | `eligible` | 所有归档前置不变量成立，尚未移动/封存。 |
| archive | `archived` | manifest 和恢复验证完成的归档终态。 |
| archive | `hold` | 有活跃任务、未决回读、保留要求或完整性问题，禁止归档。 |
| archive | `restore_requested` | 已提出恢复请求，恢复验证尚未完成。 |
| archive | `restored` | 从 manifest 验证恢复成功，可重新进入只读/新 attempt 流程。 |

## 4. 合法与禁止转移

机器可执行转移表位于 `LIFECYCLE_STATE_MACHINES`。以下是规范摘要。

### 4.1 导入项

```text
pending → processing → success | linked | duplicate | partial | failed | orphaned
processing → pending             （仅陈旧租约恢复）
failed | partial | orphaned → processing  （仅显式重试，最多 3 次）
success | linked | duplicate → orphaned   （仅完整性修复发现资产缺失）
```

禁止：成功系普通倒退、并发双 owner、临时 URL fingerprint 在无新媒体时重试、超过重试上限继续执行。

### 4.2 创作队列

```text
queued → preparing → ready_for_images → ready_for_seedance
       → ready_for_assembly → completed
preparing → retry_wait → queued（只限确定性本地暂态）
ready_* → transient_wait → 原断点（有界短重试）
queued/preparing/retry_wait/transient_wait → paused → 原断点
preparing → failed → queued（显式 retry）
非终态 → needs_attention → 原断点（显式 retry）
非终态 → cancelled
```

禁止跨级推进。非法 `advance` 必须返回冲突，不能静默 no-op 后只更新时间戳。

### 4.3 发布任务与逐平台回执

```text
draft → scheduled | queued
scheduled → queued → preflighting/running → submitting
submitting/running → submitted_unverified | platform_draft | public
                   → failed | needs_attention | needs_reconciliation
submitted_unverified → public | platform_draft | needs_reconciliation | needs_attention
needs_reconciliation → public | platform_draft | failed | needs_attention
```

附加门：

- 进入 `public` 必须携带平台回读证据；
- `failed/needs_attention → queued` 需显式 retry，且证明尚无外部副作用；
- 离开 `needs_reconciliation` 需人工接管和外部证据；
- `public/platform_draft/cancelled` 不原地重试；如需新动作，创建新 attempt；
- 多平台逐目标保存状态。一个目标公开、另一个失败时聚合为 `needs_attention`，不能汇总成公开完成。

### 4.4 全局禁止转移

- HTTP 202 → completed/public；
- process alive / exit 0 → successful terminal；
- `scheduled` → public（没有执行与回读）；
- `submitted/unknown` → queued（自动重发）；
- `blocked` 质量 → 任意外部草稿或发布；
- 旧审核 SHA → 新媒体/新文案/新目标；
- 活跃任务 → archived；
- 相同幂等键 + 不同 payload → 返回旧任务。

## 5. 幂等键

所有键必须为不回显原始身份的摘要；输入中禁止手机号、Cookie、临时 URL、Token、签名或绝对路径。`lifecycleIdempotencyKey()` 给出规范生成方式。可枚举账号标识的目标实现应由本机密钥 HMAC 后再参与键生成。当前 Matrix 兼容层仍使用截断 SHA-256 生成安装外也稳定的 `acct_*`，虽不回显原文但可被枚举，属于待迁移风险；生命周期键只接收已经假名化的指纹，绝不接收原始账号。

| 阶段 | v1 身份字段 | 当前可复用约束 | 冲突语义 |
| --- | --- | --- | --- |
| 采集 | `sourceKey` 或 `deliveryId` | `ux_import_item_delivery_id`、canonical source | 同键同载荷复用；不同载荷 409 |
| 下载 | source/delivery + channel | 当前 receipt 无唯一键，需由 owner item 约束 | 一个 owner 一条 attempt receipt |
| 入库 | media SHA | `ux_video_asset_sha256`（历史重复库可能缺失） | 同字节关联已有资产，不复制文件 |
| 分析 | asset ID + asset SHA + profile version | 表主键/upsert | profile 或输入 SHA 变化是新 attempt |
| 生成 | asset + plan SHA + engine/version | `(asset_id, engine, engine_task_id)` | 相同任务只登记一个 generation |
| 质检 | media SHA + policy version | 当前派生，无持久键 | 策略或媒体变化重新检测 |
| 人工审核 | media SHA + review policy version | `creative-reviews.json` 已持久化绑定证据，但尚无独立唯一键 | 相同审核证据可复用；内容变化失效 |
| 草稿 | media SHA + revision + destinations fingerprint | 原生逐目标 receipt 键已覆盖平台、账号、媒体和模式；legacy `idempotencyKey` 仍覆盖不足 | 相同键不同标题/目标/模式必须冲突 |
| 排期 | 上述字段 + canonical scheduledAt | 原生 scheduler 使用确定性 task ID；legacy tasks 最多保留 500 条且不再自动排期 | 同一逻辑排期只允许一个 timer/owner |
| 公开回读 | platform + account fingerprint + platform task/post ID | 已有逐目标 adapter receipt 占位，独立回读关联仍缺统一 owner | GET/查询可安全重试，不产生新发布 |
| 指标 | platform + content ID + observation ID | SQLite 四列 UNIQUE | 同 observation 不同载荷为数据冲突 |
| 归档 | asset + manifest SHA + retention class | 当前缺失 | 相同 manifest 重跑不重复移动/清理 |

## 6. 重试、超时与人工接管

### 6.1 重试类别

| 类别 | 可自动重试 | 要求 |
| --- | --- | --- |
| 只读探针、平台回读、指标 GET | 是 | 指数退避 + jitter + 总时限；不改变平台状态 |
| 下载前网络失败 | 有条件 | 使用相同 owner/幂等键；临时 URL 失效时要求重新供给 |
| SQLite busy、原子文件 rename 前失败 | 是 | 保持同 attempt；不得产生第二资产 |
| 分析/生成的确定失败 | 有条件 | 输入 SHA/计划未变，且确认外部没有未知任务 |
| 平台发布 preflight 失败 | 仅显式 | 没有产生外部调用证据 |
| submitting/submitted/unknown/timeout | 否 | 进入 `needs_reconciliation`，先查平台历史/公开页 |
| public/platform_draft | 否 | 新动作必须是新 attempt，不复用旧副作用 |

退避建议：`min(cap, base * 2^attempt) + random(0, jitter)`；现有导入沿用 2 秒人工冷却、15 分钟陈旧 processing 恢复、最多 3 次。平台适配器限速按平台和账号独立执行。

### 6.2 人工接管记录

人工接管至少包含：

```json
{
  "reason": "submission_outcome_unknown",
  "fromState": "submitting",
  "actor": "local-user-or-role",
  "claimedAt": "2026-08-27T00:00:00.000Z",
  "evidence": {
    "platform": "xhs",
    "accountFingerprint": "acct_...",
    "taskId": "platform-task-or-null"
  },
  "resolution": "public|draft|failed|no_side_effect",
  "resolvedAt": null,
  "newAttemptId": null
}
```

禁止保存账号原文、二维码、Cookie 或完整平台 HTML。只有 resolution=`no_side_effect` 才能授权一个新的发布 attempt；旧 attempt 仍保留审计证据。

## 7. 完成不变量

### 7.1 入库

`import_item.status ∈ {success,linked,duplicate}` 当且仅当：

- `asset_id` 非空且指向存在的 `video_asset`；
- `video_asset.media_validation = ok`；
- 主媒体存在于允许根目录，大小和 SHA 与资产/metadata 一致；
- metadata 可解析，files 只含包内相对路径；
- 新资产的资产行、平台摘要、分析初值、receipt 和 item 终态原子可见；
- duplicate/linked 不复制媒体，但新增合法来源关联/收据时不得覆盖历史事实。

### 7.2 分析与生成

- 分析 HTTP 200 只有在 SQLite 与包文件均成功写回时才能报告该子产物 available；
- `unavailable` 必须有 reason/missingCapability，不能伪造成空值成功；
- creative `completed` 必须有同资产 `remake_generation.status=completed`、有效文件、SHA、媒体校验和质检结论；
- 队列 JSON 不是生成完成的唯一证明；SQLite 行也不能替代实际媒体文件。

### 7.3 审核与发布

- 审核绑定媒体 SHA、可见文案摘要、平台/账号/可见范围和政策版本；
- 从批准到执行再次校验文件 realpath、大小和 SHA；
- 本地排期只证明将来应执行，不证明适配器或平台成功；
- 适配器 `submitted` 进度不得显示 100%；
- 每个平台独立 receipt；只有全部目标满足公开回读才是整体 public；
- 公开回读至少含 platform、account fingerprint、post ID 或公开 URL、visibility/status、observedAt，并能关联本地 task/媒体；
- 已有或可能已有外部副作用时不自动重试。

### 7.4 指标与归档

- 指标快照只追加真实观察，NULL 不替换为 0，不从互动量推导播放量；
- 出站指标必须关联出站公开回执的 content/post ID，不能关联来源帖冒充；
- 日报重算幂等；accepted/scheduled/submitted/platform_draft 不进入“公开成功”；
- 归档前无活跃 worker/timer，所有不确定发布已人工解决；
- archive manifest 列出最终包文件、大小、SHA、内容修订、回执摘要、快照范围和保留策略；
- 恢复验证在清理热数据前通过。

## 8. 当前存储逐字段映射

### 8.1 SQLite（`local-agent/kb.mjs` 是实际 DDL）

`db/schema.ts` 当前为空，不能当作 schema 真相。

| 表 | 生命周期事实 | 关键字段 | 幂等/唯一约束 | 不得解释为 |
| --- | --- | --- | --- | --- |
| `video_asset` | 入库资产、本地媒体、包位置 | `id,source_url,sha256,title,file_path,package_path,category,size_bytes,duration_ms,width,height,codec_*,bitrate_kbps,channel,content_id,media_validation,downloaded_at,captured_at,created_at,updated_at` | 非空 SHA partial unique（历史重复时可能缺） | 发布状态、审核状态 |
| `legacy_package` | 多旧包到同资产的引用 | `asset_id,legacy_id,package_path,source_url,content_id,captured_at,metadata_fingerprint` | `(legacy_id,package_path)` | 当前主包 |
| `download_receipt` | 每次下载/探测证据 | `asset_id,channel,source_url,content_id,sha256,media_validation,fallback_reason,started_at,completed_at,title,size_bytes,evidence,input_kind,outcome` | 当前无唯一键 | 资产本身或平台回读 |
| `ingest_observation` | 导入审计消息 | `asset_id,kind,message,observed_at` | 当前无唯一键 | 状态真相 |
| `import_batch` | 批次聚合 | `id,status,source_kind,created_at,total,succeeded,failed,skipped` | `id` | item 完成证明；counter 必须重算校验 |
| `import_item` | 单项采集/入库执行 | `id,batch_id,input,input_kind,display_input,delivery_id,status,error,retry_count,asset_id,updated_at` | delivery ID partial unique | 内容资产事实 |
| `platform_post` | 采集来源帖子 | `asset_id,content_id,post_id,url,author,publish_time,title,...,fetched_at` | `(asset_id,content_id)`，NULL 需警惕 | 织台出站发布回执 |
| `metric_snapshot` | 一次平台指标观察 | `asset_id,content_id,captured_at,*metrics,*_raw,avg_watch_seconds,completion_rate,retention_json,traffic_source,source,observation_id` | `(asset_id,content_id,source,observation_id)` | 当前累计值或因果证明 |
| `comment_item` | 评论证据快照 | `id,asset_id,source,external_id,author,content,likes,published_at,captured_at,fingerprint` | `(asset_id,source,fingerprint)` | 平台帖子或公开回执 |
| `transcript` | 音轨转写子产物 | `asset_id,status,language,text,segments,provider,note,captured_at` | `asset_id` | 未读取音轨时的推测文本 |
| `ocr` | 画面文字子产物 | `asset_id,status,items,provider,note,captured_at` | `asset_id` | 未读取画面时的推测文本 |
| `shot` | 镜头观察 | `id,asset_id,idx,start_ms,end_ms,shot_size,camera_angle,camera_movement,scene,composition,notes,source` | `(asset_id,idx)` | 未读取画面时的镜头描述 |
| `content_analysis` | 内容结构分析 | `asset_id,summary,key_points,hook_3s,structure,cta,audience,editing_rhythm,reusable_pattern,confidence,source,limitation,analyzed_at` | `asset_id` | 原始 transcript/OCR/镜头证据 |
| `virality_analysis` | 传播因素假设 | `asset_id,verdict_label,hypotheses,is_causal,note,analyzed_at` | `asset_id` | 真实因果结论；`is_causal=0` 为默认边界 |
| `remake_plan` | 生成输入计划 | `asset_id,plan_json,provider,created_at` | `asset_id` | 成片完成 |
| `remake_generation` | 已回收生成产物 | `id,asset_id,engine,engine_task_id,status,file_name,size_bytes,sha256,subject,created_at,completed_at` | `(asset_id,engine,engine_task_id)` | 文件存在/质检/审核的替代证明 |
| `knowledge_chunk` | 检索切片投影 | `id,asset_id,kind,start_ms,end_ms,content,tags,created_at` | 当前无稳定 chunk 唯一键 | 原始 transcript/OCR/分析证据 |
| `field_provenance` | 字段来源和限制 | `asset_id,field,source,available,confidence,limitation,captured_at` | `(asset_id,field)` | 原始证据本身 |
| `correction` | 人工字段修正 ledger | `asset_id,field,old_value,new_value,reason,corrected_at` | 当前无 correction ID 幂等键 | 未重放 correction 的 metadata 顶层值 |
| `schema_version` | 手工迁移版本标记 | `key,version` | `key` | SQLite 完整 schema 真相；核心 DDL 仍在 `kb.mjs` |
| `x_bookmark` | X 收藏内容资产 | `id,tweet_id,source_url,title,author,author_username,content_text,tags_json,media_json,cover_url,metrics_json,published_at,captured_at,created_at,updated_at` | `id/tweet_id/source_url` 各自 UNIQUE | 视频入库/发布生命周期完成 |
| `x_bookmark_sync` | X 同步 owner 状态 | `singleton,state,last_attempt_at,last_success_at,fetched,imported,error` | `singleton=1` | 每条收藏成功或统一运营日报 |

### 8.2 JSON 与内容包

| 载体 | 权威范围 | 关键字段 | 已知兼容问题 |
| --- | --- | --- | --- |
| `tasks.json` | legacy 采集/发布编排当前状态 | `id,type,status,progress,sourceUrl/assetPath,assetSha256,mode,scheduledAt,idempotencyKey,result,errorCode,timestamps` | 最多 500；采集与发布混存；legacy publish 写入已接应用层转移门，其他任务仍需各自 owner 校验 |
| `publish-jobs/<id>.json` | 命令适配器创建时输入快照 | 与 publish task 类似 | 后续不更新，不能当状态真相 |
| `creative-jobs.json` | 生成编排 | `id,assetId,status,stage,progress,generationId,outputMediaUrl,error,retryAt,nextRetryAt,resumeStatus,timestamps` | 状态写入接生命周期转移门；completed 仍必须用 SQLite/文件交叉验证 |
| `creative-reviews.json` | 自主审核证据与返工关联 | `reviewer,reviewPolicyVersion,status,workflow/artifact/provenance SHA,machineFeedback,revisionTaskId,timestamps` | `approved_for_publish` 只进入候选池，不授权外部发布 |
| `publisher-receipts.json` | 逐平台、账号、媒体和模式的 adapter 候选回执 | `dedupeKey,platform,account,content,jobId,state,taskId,postId,resultUrl,timestamps` | reserve 在外部调用前占位；即时 public token 仍不能当独立回读 |
| `publisher-schedule.json` | 原生发布排期唯一 owner | `id,status,scheduledAt,expiresAt,payload binding,targets,claim,timestamps` | 确定性 ID、重启恢复、外部调用后禁止盲重试 |
| `events.json` | 人类可读审计线索 | `id,level,type,message,taskId,createdAt` | 截断到 1000；不是状态/回执 ledger |
| `watcher-state.json` | 文件 watcher 尝试/退避 | processed、attempts、nextRetryAt、fingerprint | needs_attention key 需一致匹配验证 |
| `kuaidian-commands.json` | 快点重供命令 owner | `id,itemId,deliveryId,status,createdAt,outcome,reasonZh,ackedAt` | 最多 300；命令 ID，当前无 DB 唯一约束 | 导入 item 成功或媒体下载证据 |
| `webhook-nonces.json` | 签名收件的短期防重放 ledger | `nonce,expiresAt` | 活跃窗口内 nonce 唯一；最多 2000 | 内容幂等键或长期审计事件 |
| `metadata.json` | 可移植资产身份、文件 manifest、平台摘要、修正 | v1/v2 字段 | 通用 adapter 仍写 v1；生产有两种 v2 形状 |
| `analysis.md` 与分析 JSON | 可审计分析产物 | status/source/provider/time/reason/content | 与 SQLite 可能半写入 |
| X 日清单 Markdown | X 收藏的人类可读投影 | 日期与条目 | 不是统一运营日报状态源 |

### 8.3 API

| API | 语义 | 成功 HTTP 的实际含义 | 客户端后续动作 |
| --- | --- | --- | --- |
| `POST /api/v1/ingest`、`/inbox`、`/channels/card` | 创建/复用采集任务 | 202=已受理 | 轮询任务/导入 item；只在完成不变量成立时标已处理 |
| `POST /api/v1/kuaidian` | 认领或创建导入 item 并执行 | 202=worker 已接受；duplicate response 仍需看业务状态 | 轮询 `/kb/imports/:id/status`，仅 success/linked/duplicate 记成功 |
| `/api/v1/kb/imports/:id/retry` | 显式重试 | 202=唯一 owner 已领取 | 轮询 settled；409 表示并发/冷却，不再启动 worker |
| 分析/生成 API | 执行或推进子阶段 | 2xx=本次接口没有传输错误 | 检查 DB+文件完成证据，拒绝跨级推进 |
| `POST /api/v1/publish` | `videoId + destinations` 走逐平台 receipt/原生 scheduler；`assetPath` 为 legacy 兼容任务 | 200/202 均不等于公开，并返回 `businessSuccess:false/requiresReadback:true` | 等独立平台回读；legacy 结果不确定时转人工对账 |
| `GET /publisher/history` | 合并本地 scheduler、持久回执和 Matrix history 候选 | 200=历史读取成功 | 只有可绑定、来源可信且明确 public 的记录可完成回读 |
| `GET /health`、service status | 本地运行/安装探针 | 200=节点可应答 | 不改变任何内容业务状态 |

### 8.4 平台回执与运营日报

当前已有 `publisher-receipts.json` 逐目标账本：在外部调用前按平台、账号指纹、媒体 SHA、模式和排期原子占位，并在异常时保留 `unknown`。它目前保存的是 adapter 候选，不是完整独立平台回读；`tasks.result` 与 Matrix history 也只能作为关联输入，不能直接标 public。完整回读至少投影为：

```json
{
  "taskId": "pub_local",
  "attemptId": "attempt_1",
  "assetId": "kb_asset",
  "mediaSha256": "...",
  "platform": "xhs",
  "accountFingerprint": "acct_...",
  "intent": "public",
  "state": "submitted|scheduled|draft|public|failed|unknown",
  "platformTaskId": null,
  "postId": null,
  "resultUrl": null,
  "submittedAt": null,
  "publishedAt": null,
  "readBackAt": null,
  "source": "adapter|platform_history|public_page|manual_verified"
}
```

回执逐字段映射如下；原始账号、Cookie、二维码、完整 HTML 和临时 URL 不得进入任何字段。

| 规范字段 | 当前来源/迁移来源 | 语义与约束 |
| --- | --- | --- |
| `taskId` | legacy `tasks.json.id`；原生 scheduler task ID；即时发布使用 generation/video job 关联 | 本地发布意图 owner；不得只依赖标题或绝对路径。 |
| `attemptId` | receipt `id + attemptCount` 可作兼容关联，但尚无独立一等字段 | 每次可能产生平台副作用的尝试 ID；重试必须保留旧 attempt 并增加新序号。 |
| `assetId` | direct path 的 `videoId`；legacy path 需由 `assetPath` 反查 `video_asset.id` | 只使用稳定资产 ID，不用绝对路径作关联键。 |
| `mediaSha256` | `tasks.json.assetSha256` 或执行前重新计算 | 必须等于审核绑定和实际提交的字节 SHA。 |
| `platform` | `destinations[].platform` / `targets[]` / Matrix history platform | 一个平台一个 receipt，禁止只存聚合字符串。 |
| `accountFingerprint` | 当前 Matrix 层为截断 SHA-256 `acct_*`；目标迁移为本机密钥 HMAC | 仅是假名，不得回传 phone/cookie/profile 原文；当前可枚举风险必须在迁移前明确。 |
| `intent` | direct `draft + scheduledAt`；legacy `mode + scheduledAt` | 规范化为 `public/platform_draft/scheduled_public/scheduled_draft`。 |
| `state` | 结构化 adapter 结果 + 只读平台回读 | 只能是词典中的 receipt 状态；退出码 0 默认 `submitted`。 |
| `platformTaskId` | adapter `taskId/scheduleId` 或 Matrix history task id | 平台受理/排期身份，不等于 post ID。 |
| `postId` | adapter 明确 post/note/item/aweme id 或平台回读 | 公开/指标关联身份；不能用来源帖 `platform_post.content_id` 代替。 |
| `resultUrl` | adapter 明确公开 URL 或平台回读 | 仅保留规范化 http(s) 公共 URL；签名/临时 URL 禁止落盘。 |
| `submittedAt` | 本地外部调用完成时间 | 证明提交窗口结束，不证明公开。 |
| `publishedAt` | 平台声明的发布时间 | 需要平台证据；本机时钟不能伪造。 |
| `readBackAt` | 平台历史/公开页/人工证据的观察时间 | `public` 必填；应与证据来源一起写入。 |
| `source` | adapter/history/public page/manual resolution | 证据来源枚举；manual 必须同时有 actor/reason。 |

当前 UI 的“每日入库摘要”也是逐字段投影，而非持久运营日报：

| 当前显示字段 | 当前计算 | 可保留用途 | 不能证明 |
| --- | --- | --- | --- |
| `summaryDate` | 浏览器本地日期或日期筛选值 | 人类浏览分组 | 稳定业务时区或 SLA 窗口 |
| `summaryItems` | `LibraryItem.createdAt` 的本地日期等于 `summaryDate` | 当日可见内容列表 | 当日采集/下载/入库各阶段分别成功 |
| `videoItems` | `summaryItems` 中 `contentKind != x_bookmark` | 视频列表数量 | 已分析、已审核或已发布 |
| `xItems` | `summaryItems` 中 `contentKind == x_bookmark` | X 收藏列表数量 | 统一视频生命周期完成 |
| `materialCount` | 当日视频中 `category=素材` | 生成候选提示 | 生成完成或可公开 |
| `skillCount` | 当日视频中 `category=技能` | 每日学习候选 | 人工学习完成 |
| `missingAnalysisCount` | `overview` 和 `analysisText` 均空 | 补分析提醒 | 各分析子表都 unavailable/partial 的精确数量 |
| `topEngagement` | 已知 views/likes/favorites/comments/shares 简单求和后取最大 | UI 提醒 | 播放表现、因果或跨平台可比性 |
| `workflowCandidates` | 标题/概览/分析/标签的本地正则建议 | 人工流程建议 | 系统自动执行授权 |
| `dailyLearning.doneIds` | 浏览器 localStorage | 单机个人勾选体验 | 审核、归档或组织学习记录 |
| X 日清单 `rows.length` | `x_bookmark.created_at` 按本地日期过滤 | 人类可读收藏清单 | 运营日报真相源 |

正式运营日报建议使用固定 `reportDate + timezone + schemaVersion` 作为投影身份，并逐字段查询现有 owner：

| 报表字段 | 唯一计算来源 | 纳入条件 |
| --- | --- | --- |
| `captureAccepted` | `import_batch` + `import_item` | 当日创建的稳定投递；只称 accepted。历史 item 缺 `created_at` 时标 `dataGap`，不得用 `updated_at` 伪造。 |
| `ingestSucceeded` | `import_item` + `video_asset` + 文件验证 | `success/linked/duplicate` 且入库不变量通过。 |
| `analysisAvailable` | 各分析表与包文件 | 子产物 available、来源/时间存在且双写一致。 |
| `generationCompleted` | `remake_generation` + 成片文件 | completed、SHA/大小/媒体验证通过。 |
| `reviewPending` | `creative-reviews.json` | 当前审核状态为 pending/needs_revision，且证据绑定仍有效；JSON 不可读时列 `dataGap`，不能报 0。 |
| `scheduledLocal` | `publisher-schedule.json`；`tasks.json` 仅兼容历史 | 原生 owner status=scheduled；单列展示，不计成功。 |
| `submittedUnverified` | `tasks.json` + receipts | submitted/submitted_unverified/unknown；单列待回读。 |
| `publicTargets` | 逐平台 outbound receipts | `isPublicReadbackReceipt=true`；按目标计数。 |
| `publicAttempts` | publish task + 全部目标 receipts | 所有目标 public，才按 attempt 计成功。 |
| `metricsObserved` | `metric_snapshot` | 当日 `captured_at` 且幂等身份完整。 |
| `archiveCompleted` | archive manifest/ledger | manifest SHA 与恢复验证通过；当前缺 owner 时返回 `null + dataGap`。 |
| `needsAttention` | import/creative/publish owners | failed/partial/orphaned/needs_attention，按 owner 分组。 |
| `needsReconciliation` | publish task/receipts | 外部结果不确定，独立列出且不得并入失败或成功。 |

运营日报是这些事实源的幂等投影，不是新真相源：

- 今日采集：`import_item` 创建/更新时间；
- 今日入库：成功系 item + 验证资产；
- 今日分析/生成：分析时间、generation completed + 文件验证；
- 待审核/待对账：review/task 状态；
- 已排期：本地 scheduler；
- 已提交未验证：submitted/unknown；
- 已公开：逐平台 public receipts；
- 指标：`metric_snapshot`；
- 已归档：archive manifest/ledger。

前端按 `created_at` 即时计算的“每日入库”和 localStorage 学习进度可以继续展示，但不得作为运营成功、SLA 或归档依据。

## 9. 兼容迁移建议

迁移按小步执行，任何一步先在数据库和内容包副本上 dry-run。

本轮已落地且保持旧响应字段兼容的 M0 子集：

- 新增只读状态机、幂等键、回读聚合和跨 owner 快照验证器；不新增第二份持久状态；
- creative queue 与 legacy publish task 的实际写入已接合法转移门；`completeWithPersistence()` 在任何成片/SQLite 副作用前拒绝非法生成完成；
- Matrix 即时输出（即使自称 published）最多成为 `submitted` 候选，API 明示 `businessSuccess:false/requiresReadback:true`；
- 原生 Matrix 发布在外部调用前写逐平台 receipt 占位；相同平台、账号、媒体、模式和排期不会重复触发外部调用；
- 原生排期使用确定性 task ID、本地 owner、精确账号、重启恢复和过期窗口，到点只走立即提交路径；
- legacy 发布器受理后停在 `submitted_unverified`/90%，外部调用窗口后的超时、终止、非确定错误进入 `needs_reconciliation`；
- direct publish 在调用 CLI 前重新校验允许根、realpath、大小、SQLite SHA、实际 SHA、生成工作流和自主审核绑定；
- 服务重启把遗留 running/submitting 发布任务转为 `needs_reconciliation`，legacy submitted 映射为 `submitted_unverified`；
- 视频号卡片 HTTP 202 只记 accepted；伴生桥轮询 task 到 `completed` 后才写 reported；
- 自主审核把 reviewer、政策版本和生成证据摘要持久化为候选证据，`approved_for_publish` 不自动触发外部发布；
- 前端把 submitted、待对账和 public 分开显示，不再把草稿/提交计入公开成功。

### M0：剩余语义兼容（无需新增生命周期数据库）

- 为即时发布补一等 task/attempt owner，而不是只复用 generation/video job 关联；
- 把独立 Matrix history/公开页回读与本地 receipt 做严格平台、账号、媒体和 task 关联；
- 将当前可枚举的账号 SHA 指纹迁移为安装密钥 HMAC，并为旧 receipt 提供只读兼容映射；
- 对原生 scheduler 的内部转移也复用同一契约断言或生成式转移测试；
- legacy `submitted` 继续只读投影为 `submitted_unverified`，不批量改写历史。

### M1：统一 metadata 与重建

- 所有生产入库改走 `buildMetadataV2()`；兼容读取 v1；
- 固定 `bitrateKbps/bitRateBps`、unavailable reason 与字段命名的读写映射；
- correction 同步 metadata 顶层且保留真实 reason；重建器按时间重放 corrections；
- 内容包增加快照/分析/生成 manifest 的稳定摘要，而不是复制凭据或原始私有响应；
- 修正文档“可完整重建”为分层恢复目标，并以恢复演练验证。

### M2：在现有事实源内补证据

- 不复用 `platform_post`；在现有 `kb.sqlite` 增加出站 receipt/review/archive 表，或在 tasks ledger 完成等价的逐平台结构后再迁入 SQLite；
- 添加 schema revision 与受控迁移：预览、备份、事务、验证、回滚；
- 对 status 加应用层验证，稳定后再加 SQLite CHECK/外键；
- 发布幂等键保留完整载荷 fingerprint；相同键不同载荷返回 409；
- 日报通过查询现有表生成，可缓存但缓存不是真相源。

### M3：回读与归档

- 优先官方平台查询；其次可关联的 Matrix history；最后允许带证据的人工核验；
- 平台公开后才建立出站 content ID 与指标采集计划；
- 归档先生成 manifest、验证恢复，再按保留策略转冷存；失败进入 hold。

迁移应选择性复用仓库已有的发布回执分类、幂等摘要和崩溃后 `needs_reconciliation` 算法；状态仍回写现有 JSON/SQLite owner，不另建生命周期孤岛。

## 10. 已知未解决风险

1. 通用采集仍可能写 schemaVersion 1，与文档 v2 冲突；
2. `tasks.json`、`publish-jobs`、scheduler、receipts、SQLite 和内容包缺少贯穿的一等 attempt ID；
3. 即时 direct publish 有逐目标幂等 receipt，但仍缺独立 publish task owner；
4. 当前有持久 adapter receipt 和自主审核证据，但仍无统一独立公开回读和归档实体；
5. Matrix 账号指纹使用无盐截断 SHA-256，可枚举账号需迁移为安装密钥 HMAC；
6. 分析/生成跨 DB 与文件系统不是单事务，存在半完成窗口；
7. 历史重复 SHA 会导致唯一索引缺席；
8. `platform_post.content_id IS NULL` 时 SQLite UNIQUE 不能去重；
9. metric observation ID 多处随机生成，调用者重试不能复用；
10. legacy publish idempotency 只查未截断 tasks 且忽略 failed，历史清理后可能重发；
11. legacy publish job 创建快照后不随任务更新，适配器可能读取陈旧状态；
12. 人工 title/author correction 当前不能从磁盘完整重建；
13. watcher 的 needs-attention processed key 形状可能导致重复扫描；
14. 运营日报和学习完成度目前主要是前端/Markdown 投影；
15. adapter 与 Matrix history 的 public 候选尚未自动完成严格的本地 task/媒体/readBackAt 关联；
16. 现有测试有本机绝对 MP4 依赖，尚未完全可移植。

这些风险不能通过把 UI 文案改成“完成”来关闭；必须由持久证据、回读和契约测试逐项消除。

## 11. 可执行验证

快速运行：

```bash
node --test tests/content-lifecycle.contract.test.mjs
```

该套件覆盖非法转移、幂等冲突、2xx/进程/排期/提交假完成、生成与入库交叉不变量、审核 SHA 绑定、逐平台公开回读、指标快照和归档。验证器只读输入快照，不访问账号、不读取凭据、不调用真实发布。
