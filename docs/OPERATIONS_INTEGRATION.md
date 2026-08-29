# 织台运营指标接入说明

版本：`1.0.0`

配套合同：[`OPERATIONS_METRICS_CONTRACT.md`](OPERATIONS_METRICS_CONTRACT.md)

配套 Schema：[`contracts/operations-metrics.schema.json`](contracts/operations-metrics.schema.json)

## 1. 接入原则

运营层是现有知识库和工作流之上的只读派生层，不是第二套业务真相源。

- 复用 `kb.sqlite`、生成队列、逐平台发布回执和创意审核事件。
- 保留现有 `metric_snapshot` 数值列与 API，新增状态和关系时采用可回滚的加法迁移。
- 运营计算必须是纯函数：不登录平台、不读取账号凭据、不触发发布、不修改原始业务记录。
- 报告必须接收固定 `asOf` 和 `dataMode`；默认只读 `observed` 数据。
- 合成验收数据写入隔离的临时库或显式 synthetic namespace，不进入生产日报。

本文将核心实现模块暂称 `local-agent/operations-metrics.mjs`。如果最终实现采用其他文件名，只需同步导入路径；字段和公式以数据合同为准。

## 2. 当前数据源与可复用字段

### 2.1 知识库 SQLite

| 运营概念 | 当前来源 | 可直接使用 | 仍需补齐 |
| --- | --- | --- | --- |
| 素材 | `video_asset` | `id`、`created_at`、媒体校验、内容包路径 | 显式 `is_synthetic` 或隔离数据集标识 |
| 入库尝试 | `import_batch` / `import_item` | 状态、重试、asset 关联 | 统一终态映射与稳定 attempt ID |
| 分析完成 | `content_analysis` | `asset_id`、`analyzed_at` | 失败/处理中/豁免的显式分析事件 |
| 生成成片 | `remake_generation` | `id`、`asset_id`、engine、status、时间、SHA | 生成 attempt 与 artifact 分离 |
| 来源帖子 | `platform_post` | 素材到来源帖、平台信息 | 不能直接当作织台发布结果帖 |
| 指标快照 | `metric_snapshot` | 数值、raw、captured_at、source、observation_id | 逐指标四态、post FK、周期槽、revision、三时间 |
| 评论反馈 | `comment_item` | 评论正文、来源、采集时间 | 运营报告只做反馈归纳，不推断因果 |
| 字段来源 | `field_provenance` | 来源、置信度、限制 | 当前粒度只有 asset + field，不足以表示逐帖子快照 |

`download_receipt` 是下载/入库收据，不是发布回执，不能计算公开率或发布回执延迟。

### 2.2 生成队列

现有 creative queue 能提供素材 ID、job ID、状态、阶段、生成 ID 和输出 URL。接入时要区分：

- `generationAttemptId`：每次实际开始的生成尝试；用于生成成功率。
- `generatedVideoId`：校验通过并登记的成片；用于审核、返工和发布血缘。

同一素材重试两次是两个 attempt；如果只生成一个有效文件，则只有一个 artifact。技术重试不得自动转成返工事件。

### 2.3 发布链路

现有发布链路已经能返回逐平台结果，但持久化和状态语义不完整：

- direct MatrixMedia 结果常见为 `{platform, success, status, message}`。
- 旧发布任务保存 `mode`、targets、task status 和 sanitized result。
- `success` / `submitted` 表示适配器已接收，不能证明帖子已公开。
- 不同链路对退出码 4 的解释存在差异，接入时必须保守归一化。

因此，运营层必须消费 `publisher-receipts` 提供的逐目的地、追加式、已脱敏回执，而不是从 UI 文案或事件日志猜测公开状态。

### 2.4 每日摘要

现有前端“每日入库摘要”可复用展示结构：

- 今天收了什么
- 特别注意
- 建议接入织台

它目前是客户端即时派生，不是可复现报告。`daily-creative` 应输出结构化 JSON envelope，再由 UI/Markdown 渲染；不能只保存一段不可复算的文本。

## 3. 推荐模块边界

```text
kb.mjs / creative-queue
publisher-receipts
creative-reviews
daily-creative
        │
        ▼
operations-metrics.mjs  ──纯计算/规范化/复盘──> JSON report
        │
        ├─> daily-creative renderer
        ├─> operations dashboard/API
        └─> 7/14/30 review artifacts
```

推荐核心导出：

```js
export const OPERATIONS_CONTRACT_VERSION = "1.0.0";

export function normalizePlatformMetric(input, options) {}
export function normalizePublishReceipts(receipts) {}
export function normalizeCreativeReviews(events) {}
export function snapshotSchedule(publishedAt) {}
export function selectSnapshotForHorizon(snapshots, options) {}
export function buildOperationsReport(db, options) {}
export function buildReviewFramework(options) {}
export function buildCheckpointReviewReport(db, options) {}
export function createExperimentCard(input) {}
export function concludeExperiment(card, result) {}
export function renderOperationsReportMarkdown(report) {}
```

`buildOperationsReport(db, options)` 当前从只读 SQLite 连接复用知识库事实，并由 `options` 注入尚未统一入库的账本：

```js
{
  from,
  to,
  asOf,
  anchorAt,
  timezone: "Asia/Shanghai",
  dataMode: "observed" | "synthetic",
  syntheticCore,       // 仅隔离验收夹具可为 true
  creativeJobs,
  publishReceipts,
  creativeReviews,
  dailyCreativeState,
  experiments,
  reportRevision
}
```

知识库事实来自 `video_asset/import_item/content_analysis/remake_generation/platform_post/metric_snapshot` 及运营补充表。函数不得自行调用 `fetch`、`spawn`、平台 CLI 或登录接口；时间、回执、审核、生成任务和实验卡均由调用方显式注入。结构校验由 `docs/contracts/operations-metrics.schema.json` 加运行时跨记录校验共同完成。

`selectSnapshotForHorizon` 只用于诊断旧 `metric_snapshot` 在目标时间附近是否存在 `ad_hoc_candidate`；其结果固定 `eligibleForScheduledSlot = false`，不得写入周期槽、不得增加 `snapshotCoverage.recordedPosts`，也不得冒充 `PT1H/P1D/P7D/P30D` 证据。

## 4. 规范化输入合同

JSON Schema 的 canonical 字段名使用 camelCase；十项稳定指标 key 和平台 metric name 使用合同规定的 snake_case 枚举。SQLite adapter 可读旧 snake_case 列，但必须在进入核心计算前一次性规范化；`metrics` 等 renderer 兼容投影保留其既有 key。

### 4.1 规范字段与 legacy adapter

JSON Schema 只描述进入核心计算后的规范结构；调用方和持久化层仍可继续读取现有账本字段。适配器必须先做显式字段映射，`operations-metrics.mjs` 不应在各指标函数内重复猜别名。

发布回执映射：

| 规范字段 | 当前/legacy 字段 | 映射要求 |
| --- | --- | --- |
| `receiptId` | `id` | 保留稳定 ID；若旧行无 ID，按 job + platform + destination 生成稳定 ID，不使用随机重跑值 |
| `revision` | 同名；缺失时为 `1` | 同一 destination 的新证据递增；幂等重放保持同 revision |
| `publishTaskId` | `jobId` | 原值映射；不可拿平台外部帖子 ID 代替 |
| `materialId` | `assetId` | 指向知识库素材 |
| `generatedVideoId` | `generationId` | 可空；空表示直接发布原素材 |
| `platformPostId` | 同名；旧行可由 destination intention 派生 | 每个平台目的地稳定且唯一，不能用素材 ID 代替 |
| `platform` | 同名、`targets[].platform` 或 `results[].platform` | 多平台数组必须先展开为逐目的地回执 |
| `accountRef` | 同名或本地账号引用 | 可空；只能是不可逆引用，不能放账号、Cookie 或 token |
| `requestedMode` | `mode` | `workbench_draft/platform_draft/publish` 规范化 |
| `status` | `state` | 按本文发布状态表映射；`success/submitted` 不得升级为公开 |
| `sourceEventAt` | `createdAt` | 只有旧账本没有更精确 dispatched/requested 时间时才回退 |
| `observedAt` | `updatedAt` | 表示拿到该 revision 回执的时间 |
| `externalPostId` | `postId`、同名或平台结果中的稳定 post ID | 缺失保持 null |
| `externalUrl` | `resultUrl`、同名或平台结果中的稳定公开 URL | 必须去掉签名参数；缺失保持 null |
| `source` | 同名 | 缺失时写明确 adapter 名，如 `legacy_publish_ledger` |
| `isSynthetic` | 同名、`is_synthetic` 或隔离 namespace | 不能仅凭 ID 文案猜测；模式必须和报告根一致 |

创意审核映射：

| 规范字段 | 当前/legacy 字段 | 映射要求 |
| --- | --- | --- |
| `reviewEventId` | `id` | 保留稳定事件 ID |
| `reviewCycleId` | 同名；旧行可按 generation + submit revision 派生 | 同一轮提交和决定必须一致 |
| `materialId` | `assetId` | 指向知识库素材 |
| `generatedVideoId` | `generationId` | 必填，不能只用 asset 粒度审核 |
| `eventType` | `status`、`state` 或事件记录类型 | 规范化为 `submitted/decision/withdrawn` |
| `decision` | `status` 或 `state` | 只在 decision 事件映射 `approved/changes_requested/rejected` |
| `submittedAt` | `createdAt` | 若旧决定行另有提交时间，优先使用更精确字段 |
| `decisionAt` | `updatedAt` | 非 decision 事件保持 null |
| `reasonCodes` | 同名；legacy `feedback` 需受控分类器显式映射 | 不保存未经脱敏的原始反馈正文作为 reason code |
| `source` | 同名 | 缺失时写 `legacy_creative_review` |
| `isSynthetic` | 同名、`is_synthetic` 或隔离 namespace | 模式必须和报告根一致 |

兼容规则：

- 入口 adapter 可以接受规范字段、legacy 字段或两者并存。
- 两者并存且值冲突时必须产生 validation error，不得静默覆盖；规范字段不自动“胜出”。
- adapter 输出必须是 Schema 中的规范结构，后续公式只读取规范字段。
- legacy 账本不因接入而被原地重写或删除。
- Schema 的 `publisherReceipt`、`creativeReviewEvent` `$defs` 用于验证 adapter 输出，而非宣称旧账本已经采用这些字段。

#### 4.1.1 canonical 报告 envelope 与当前原型投影

合同 `1.0.0` 的实际落盘/接口报告以 `buildOperationsReport()` 输出为权威，根结构为：

```js
{
  schemaVersion: "1.0.0",
  contract: "zhitai.operations_metrics",
  contractVersion: "1.0.0", // 现有 renderer 兼容
  reportId,
  reportRevision,
  reportType: "daily" | "review" | "acceptance",
  dataMode,
  synthetic,
  syntheticNotice,
  generatedAt,
  asOf,
  timezone,
  period: { startAt, endAt, cohortAnchor },
  reviewAnchorAt,
  policy,

  metrics,            // renderer 兼容投影
  kpis,               // canonical 富结构
  feedbackFunnel,     // renderer 兼容投影
  funnels,            // canonical 四轨漏斗
  reviewFramework,    // renderer 兼容投影
  reviews,            // canonical D7/D14/D30 frames

  lineage,
  snapshots,
  snapshotCoverage,
  platformMetricStates,
  dailyOperations,
  experiments,
  provenance,
  limitations
}
```

`kpis/funnels/reviews` 是严格 canonical 结构，`metrics/feedbackFunnel/reviewFramework` 是现有 renderer 的兼容投影。兼容投影只能由 canonical 计算所用的同一批中间事实生成，不得自行重算。JSON Schema 分别验证两种结构；运行时 validator 还必须断言：

- 十项 `kpis` 与 `metrics` 的值、状态、分子、分母和统计量语义一致；
- 四张 `funnels` 与兼容四轨的 stage/outcome 计数一致；
- `reviews.day7/day14/day30` 与兼容 D7/D14/D30 的 dueAt、cutoff、status 和快照时点一致；
- `schemaVersion === contractVersion === "1.0.0"`；
- `generatedAt === asOf`，且 `period.startAt/endAt` 使用 `[startAt,endAt)`。

任何 canonical/兼容冲突都使整份报告无效；不得静默选择其中一份，也不得为了兼容 renderer 降级 canonical 的 grain、coverage、provenance 或 cutoff。

当前原型到 canonical envelope 的映射：

| 当前原型字段 | canonical 字段 | adapter 规则 |
| --- | --- | --- |
| 旧 `schemaVersion: 1` | `schemaVersion: "1.0.0"` | 只在入口接受数字旧值；新报告写字符串。`contractVersion` 作为 renderer 兼容字段保留并必须相等。 |
| `reportType: "zhitai_operations_review"` | `reportType` | 日报映射 `daily`，7/14/30 映射 `review`，合成验收映射 `acceptance`。 |
| `synthetic` | `dataMode` + `syntheticNotice` | `synthetic:true` 只能映射到 synthetic 并写固定水印；不得用布尔值覆盖显式冲突的 `dataMode`。 |
| `generatedAt`、旧 `period.from/to/asOf/timezone` | `asOf`、`period.startAt/endAt/cohortAnchor`、根 `timezone` | 保持窗口 `[startAt,endAt)`；`generatedAt` 不能替代快照 `sourceEventAt`。 |
| `metrics` | `kpis` | 按下方指标表富化为 key/label/grain/unit/formula/status/value/reason/numerator/denominator/coverage/statistics/asOf。 |
| `feedbackFunnel` | `funnels` | `content → content`、`generationAttempts → generationAttempts`、`review → creativeReviews`、`distribution → platformPosts`；每轨补 key/label/grain/cohort 和四态 stage。 |
| `reviewFramework` | `reviews` | 按 `day` 转成 `day7/day14/day30`；`dataCutoff → dataCutoffAt`，并补 revision、mode、coverage、sampleSize、limitations/decisions。 |
| 入口时点 `1h/24h/7d/30d` | 报告与持久化时点 | 规范化为 `PT1H/P1D/P7D/P30D`；友好别名不得出现在报告。 |

十项兼容指标到 canonical KPI 的映射：

| `metrics` key / unit | `kpis` 字段 / key / unit | 补充要求 |
| --- | --- | --- |
| `collection_volume / intake_items` | `collectionVolume / collection_volume / count` | 主值为 intake attempts；`distinctResolvedAssets` 写入 statistics。 |
| `ingestion_success_rate / ratio` | `ingestionSuccessRate / ingestion_success_rate / ratio` | 值保持 `[0,1]`，补分子分母。 |
| `analysis_backlog / assets` | `analysisBacklog / analysis_backlog / count` | 粒度为 distinct 素材。 |
| `generation_success_rate / ratio` | `generationSuccessRate / generation_success_rate / ratio` | 分母只能是已开始的终态 attempts。 |
| `rework_rate / ratio` | `reworkRate / rework_rate / ratio` | 粒度为 distinct 已决成片。 |
| `review_duration / seconds_p50` | `reviewDurationSeconds / review_duration / seconds` | value 为 p50，statistics 保留 p90、open count/age。 |
| `draft_rate / ratio` | `draftRate / draft_rate / ratio` | 逐平台目的地。 |
| `public_rate / ratio` | `publicRate / public_rate / ratio` | `submitted` 不进入公开分子。 |
| `receipt_latency / seconds_p50` | `receiptLatencySeconds / receipt_latency / seconds` | value 为 p50，statistics 保留 p90。 |
| `metric_freshness / seconds_p90` | `metricFreshnessSeconds / metric_freshness / seconds` | value 为 p90，statistics 保留 p50/max。 |

### 4.2 发布回执 `publisher-receipts`

每个目标平台一条记录：

```json
{
  "receiptId": "pub_task_1:dy:destination_1",
  "revision": 1,
  "publishTaskId": "pub_task_1",
  "materialId": "asset_1",
  "generatedVideoId": "remake_1",
  "platformPostId": "post_intent_1",
  "platform": "dy",
  "accountRef": null,
  "requestedMode": "publish",
  "status": "submitted",
  "sourceEventAt": "2026-08-27T01:00:00.000Z",
  "observedAt": "2026-08-27T01:00:05.000Z",
  "externalPostId": null,
  "externalUrl": null,
  "source": "matrixmedia_cli",
  "isSynthetic": false
}
```

要求：

- `receiptId` 对同一发布任务、平台、账号/分区和目的地稳定；重放幂等。
- 账号只能使用本地不可逆 `accountRef`，不得保存手机号、Cookie 或登录凭据。
- 新状态作为新 revision/事件追加；不得覆盖导致无法审计。
- `externalUrl` 只能保存稳定、无签名参数的公开 URL。
- `message` 若保留，必须先过现有 failure text/sensitive field sanitizer；运营报告默认不需要原始 message。

状态归一化：

| 上游证据 | 规范状态 | 说明 |
| --- | --- | --- |
| 工作台本地草稿 | `workbench_draft` | 未进入平台工作流 |
| 请求明确为 draft 且平台确认草稿 | `platform_draft` | 可计入草稿分子 |
| queued / scheduled / running | 同名状态 | 非终态，不进入草稿率/公开率分母 |
| CLI code 0、HTTP 2xx、`success:true`、`submitted` | `submitted` | 已接收但公开可见性未知 |
| 外部帖子 ID/稳定 URL + 平台明确公开，或用户导入确认 | `public_confirmed` | 唯一可计入公开分子的状态 |
| 明确平台失败 | `failed` | 终态失败 |
| 验证码、风控、结果未知、语义冲突 | `needs_attention` | 不自动重试，也不冒充成功 |
| 401/403 / scope 缺失 | `permission_denied` | 权限拒绝 |

退出码 4 只有在“请求模式是草稿，且适配器明确返回 draft”时才能映射 `platform_draft`；否则保守映射为 `needs_attention`。

### 4.3 创意审核 `creative-reviews`

审核必须作为显式事件，不能从 correction、生成次数或人工备注猜测：

```json
{
  "reviewEventId": "review_event_1",
  "reviewCycleId": "review_cycle_1",
  "materialId": "asset_1",
  "generatedVideoId": "remake_1",
  "eventType": "decision",
  "decision": "changes_requested",
  "submittedAt": "2026-08-27T02:00:00.000Z",
  "decisionAt": "2026-08-27T03:30:00.000Z",
  "reasonCodes": ["title_mismatch"],
  "source": "creative_reviews",
  "isSynthetic": false
}
```

规范事件：

- `submitted`：开启一个 review cycle。
- `decision`：决定为 `approved | changes_requested | rejected`。
- `withdrawn`：提交方撤回；不进入审核时长终态样本。

一次 `changes_requested` 只让对应 `generatedVideoId` 的返工标志变为 true，多条修改意见不能重复放大返工分子。重新提交开启新的 `reviewCycleId`，审核时长按 cycle 计算。

### 4.4 `daily-creative`

`daily-creative` 的结构化 envelope 至少包含：

```json
{
  "date": "2026-08-27",
  "timezone": "Asia/Shanghai",
  "asOf": "2026-08-27T15:59:59.999Z",
  "contractVersion": "1.0.0",
  "dataMode": "observed",
  "operationsReportId": "ops_2026-08-27",
  "syntheticNotice": null
}
```

兼容要求：

- `daily-creative` 只渲染 `operations-metrics` 已计算的数据，不自己重新定义公式。
- Markdown/HTML 可另存，但必须保留同 ID 的结构化 JSON。
- 合成 envelope 必须携带固定水印；观察报告的 `syntheticNotice` 为 null。
- 现有“今天收了什么 / 特别注意 / 建议接入织台”三段分别读取 KPI、limitations/alerts、actions/experiments。

## 5. 知识库与快照接入

### 5.1 非破坏式迁移

不要把现有 `plays/likes/...` 列直接改成 JSON 对象。可选方案：

1. 在现有表旁新增规范化 observation/status 表；或
2. 为现有快照添加 `platform_post_id`、`snapshot_offset`、`target_at`、`revision`、`source_event_at`、`observed_at`、`ingested_at`、`metric_status_json`、`is_synthetic` 等可空列。

无论采用哪种方案，都必须：

- 保留旧行和旧唯一键可读。
- 连续开库迁移三次不增行、不改值。
- 旧数值 0 回填为 `available + 0`。
- 旧 null 只能回填为 `unavailable + legacy_unknown`，不能猜测权限或未采集。
- 现有 `observation_id` 继续用于幂等。
- 新周期快照通过真正的 `platformPostId` 关联；仅有 `asset_id + content_id` 的旧行先做显式解析，歧义行保留 ad hoc。

### 5.2 素材、成片与帖子

现有 `platform_post` 主要表示采集来源帖，不宜静默改变语义。推荐：

- 保留来源帖，增加 `postRole = source` 的兼容投影；
- 发布回执形成独立 `postRole = published` 的 platform post/intention；
- published post 保存 `materialId` 和可空 `generatedVideoId`；
- 若有 generation，运行时校验其 `asset_id` 必须等于 post 的 `materialId`；
- 每个目的地一条 post，不把多平台数组压成一条记录。

### 5.3 周期快照调度

调度层可以生成四个待采集目标：`PT1H / P1D / P7D / P30D`。本任务只接入记录和计算，不要求自动登录平台。

安全接入方式按优先级排序：

1. 用户导入创作者后台导出文件。
2. 已有、已授权、脱敏的平台 API 适配器。
3. 手工录入并保留来源说明。

调度到点但未配置采集器，写 `not_collected + collector_not_run`；平台无指标写 `unavailable`；权限拒绝写 `permission_denied`。不得为了填满四个槽复制上一时点数值。

## 6. 指标计算实现提示

### 6.1 防止 JOIN 放大

先按各自分析单位聚合，再组合报告：

```js
const materials = uniqueBy(rows, row => row.materialId);
const attempts = uniqueBy(rows, row => row.generationAttemptId);
const posts = uniqueBy(rows, row => row.platformPostId);
const reviewCycles = uniqueBy(rows, row => row.reviewCycleId);
```

不要对素材、成片、帖子、快照做一条宽 JOIN 后直接 `COUNT(*)`。

### 6.2 最新状态与 revision

- 发布帖子状态按 `observedAt`、revision、稳定 ID 决定截至 `asOf` 的最新证据。
- 周期快照先限定 `sourceEventAt <= dataCutoffAt`，再选最大 revision。
- `ingestedAt` 晚于 cutoff 的迟到证据可以进入重算，但报告 revision 必须增加，并保留原报告。
- future-dated 记录进入 validation errors，不进入统计。

### 6.3 状态传播

聚合时先计算数值集合和状态覆盖：

- 有合法数值时，聚合值可为 `available`，同时保留被排除的 unavailable/permission/not_collected 数量。
- 完全没有合法数值时，不得降级为 0；按最具体证据选择 `permission_denied`、`unavailable` 或 `not_collected`，并返回 reason。
- 多来源冲突不得静默选较大值；应按来源优先级/最新 revision 规则选择并记录 limitation。

## 7. 7/14/30 天复盘接入

`operations-metrics` 以 `reviewAnchorAt` 生成三个 frame：

```js
[
  { horizonDays: 7, dueAt, dataCutoffAt, status },
  { horizonDays: 14, dueAt, dataCutoffAt, status },
  { horizonDays: 30, dueAt, dataCutoffAt, status }
]
```

规则：

- `asOf < dueAt` → `not_due`，`generatedAt = null`。
- 已到期且合同要求的数据覆盖达标 → `ready`。
- 已到期但关键来源缺失/权限拒绝 → `missing_data`，仍输出限制和接入动作。
- 每个 frame 的查询硬截止在 `dataCutoffAt`；不得让第 8 天数据影响 D7。
- 重算时增加 report revision，不原地改写历史复盘。

## 8. OFAT 实验接入

实验卡应由 `creative-reviews` 或独立 experiment store 持久化，`operations-metrics` 只读取和校验。

- 枚举固定为 `topic/hook_3s/cover/title/duration/publish_time`。
- `heldConstant` 必须恰好记录其余五项。
- control/variant 的主因素值必须不同，其他冻结值必须相同。
- 实验进入 running 后锁定 baseline、successMetric、sample size plan 和 stopping rules。
- 样本单位通常是独立平台帖子，多个指标时点不是多个样本。
- synthetic 实验只能输出验收结论，不进入观测实验汇总。

JSON Schema 能检查字段和枚举；“只改变一个值”“冻结字段相同”和运行后不可改由运行时 validator 检查。

## 9. API 与报告落盘建议

如需对外提供本地 API，建议保持只读：

```text
GET /api/v1/operations/report?startAt=&endAt=&asOf=&dataMode=observed
GET /api/v1/operations/reviews?anchorAt=&asOf=
GET /api/v1/operations/experiments
```

默认值：

- `dataMode=observed`
- `timezone=Asia/Shanghai`
- `asOf` 由路由层生成并显式传给核心模块

报告落盘应采用原子临时文件 + rename，建议路径：

```text
data/operations/reports/{dataMode}/{reportId}/revision-{n}.json
data/operations/reports/{dataMode}/{reportId}/revision-{n}.md
```

不要把测试报告写进真实知识库内容包。API 返回前继续复用现有脱敏器，且不返回绝对路径、账号引用原值或平台敏感 message。

## 10. 分阶段接入步骤

### 阶段 A：纯计算和合成验收

1. 实现 `operations-metrics.mjs` 的纯函数与固定时钟。
2. 用临时 SQLite/JSON 构造 synthetic 夹具。
3. 验证十项公式、四态、四张漏斗、血缘和四时点。
4. 生成带水印的日报和 D7/D14/D30 示例。
5. 断言 publisher/platform adapter 从未被调用。

### 阶段 B：只读接入现有数据

1. 从 `video_asset/import_item/content_analysis/remake_generation/metric_snapshot` 只读提取。
2. 接入 creative queue 的持久化任务快照。
3. 对旧快照使用 `available` 或 `legacy_unknown`，不补造时点。
4. 与现有日报并行显示，先不替换旧页面。

### 阶段 C：发布回执与审核事件

1. `publisher-receipts` 在发布适配器边界持久化逐平台回执。
2. direct 与旧任务链路归一化到同一状态机。
3. `creative-reviews` 持久化 submitted/decision/withdrawn 事件。
4. 开启草稿率、公开率、回执延迟、返工率和审核时长。

### 阶段 D：真实周期快照

1. 仅在已有授权来源上配置四个目标时点。
2. 未配置、源不支持和权限拒绝分别落正确状态。
3. 监控迟到 revision、覆盖率和 freshness。
4. 达到覆盖门槛后再启用 D7/D14/D30 observed 复盘。

## 11. 自动化测试建议

当前覆盖文件：

- `tests/operations-metrics-contract.test.mjs`
- `tests/operations-experiment-review.test.mjs`
- `tests/operations-report.test.mjs`
- `tests/operations-schema-validation.test.mjs`

测试约定延续仓库现有习惯：`node:test`、`assert/strict`、`mkdtemp`、固定 ISO 时间和 `try/finally` 清理。

最低必测：

- 0、unavailable、not_collected、permission_denied 四态互不混淆。
- 分母为 0 不产生 0%/NaN。
- 1 素材 → 1 成片 → 3 帖子 → 每帖 4 快照，计数分别为 1/1/3/12。
- `submitted` 不增加公开分子。
- 旧 null 不被迁移成 0。
- 同 observation 重放不增行，迟到补数新增 revision。
- D7 不读取 cutoff 后数据。
- 两变量同时改变的实验卡被拒绝。
- synthetic 报告有水印，observed 查询默认排除 synthetic。
- 报告生成期间没有真实 fetch、CLI、登录或发布调用。

局部验证：

```bash
node --test tests/operations-metrics-contract.test.mjs
node --test tests/operations-experiment-review.test.mjs
node --test tests/operations-report.test.mjs
node --test tests/operations-schema-validation.test.mjs
```

完整验证仍使用：

```bash
pnpm test
```

## 12. 上线门槛与回滚

上线前必须满足：

- Schema、公式和运行时交叉验证全部通过。
- 新迁移连续执行三次无变化。
- 观察和合成报告物理/逻辑隔离。
- 逐平台回执可追溯且不包含凭据。
- 公开率只接受 `public_confirmed`。
- 现有知识库列表、详情、快照和发布审批测试无回归。

回滚只关闭运营路由/渲染和新调度，不删除旧业务记录。加法表或列可保留；旧 API 继续读取原数值列。不得通过删除 `kb.sqlite` 或清空用户报告实现回滚。

## 13. 参考标准

- [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12)
- [Open Data Contract Standard](https://github.com/bitol-io/open-data-contract-standard)
- [W3C PROV-O](https://www.w3.org/TR/prov-o/)
- [OpenTelemetry Logs data model](https://opentelemetry.io/docs/specs/otel/logs/data-model/)
- [FHIR Data Absent Reason](https://hl7.org/fhir/valueset-data-absent-reason.html)
