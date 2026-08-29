# 织台运营指标数据合同

版本：`1.0.0`

状态：Draft

生效日期：2026-08-27
机器可读合同：[`docs/contracts/operations-metrics.schema.json`](contracts/operations-metrics.schema.json)

## 1. 目标与边界

本合同统一织台从素材采集、知识库入库、分析、生成、审核、平台投递到指标回收的运营口径。它解决四类问题：

1. 同一指标在日报、看板和 7/14/30 天复盘中使用同一公式、粒度和分母。
2. 平台返回的真实 `0` 与未取得数据严格分开。
3. 素材、生成成片、多个平台帖子和多时点快照可追溯，不因一对多 JOIN 放大漏斗。
4. 合成验收数据与观察数据隔离，任何相关性都不自动写成因果。

本合同不授权登录平台、修改账号、抓取受限数据或执行真实发布。它只定义本地已有证据、用户导入证据和经过脱敏的发布回执如何被计算和呈现。

文中的“必须”“不得”“应”是规范性要求。JSON Schema 使用官方 [JSON Schema Draft 2020-12](https://json-schema.org/draft/2020-12)。

## 2. 公共约定

### 2.1 时间、窗口与确定性

- 存储时间必须是带时区的 RFC 3339 字符串，推荐统一写 UTC `Z`。
- 日报展示时区固定为 `Asia/Shanghai`；报告必须显式返回 `timezone`。
- 统计窗口采用左闭右开 `[startAt, endAt)`。
- 所有派生结果必须接收显式 `asOf`，不得在纯计算函数中偷偷读取当前系统时间。
- 同一输入、合同版本和 `asOf` 必须产生结构等价的结果。
- 迟到数据采用追加 revision，不覆盖较早观测；报告必须说明其 `dataCutoffAt`。

三个时间字段不得混用：

| 字段 | 含义 |
| --- | --- |
| `sourceEventAt` | 平台或业务事件实际发生/被测量的时间 |
| `observedAt` | 织台或适配器看到该事件、拿到回执的时间 |
| `ingestedAt` | 记录被持久化到织台的时间 |

由此派生：

- 回执延迟 = `observedAt - sourceEventAt`
- 快照迟到 = `observedAt - targetAt`
- 指标新鲜度 = `report.asOf - latest available sourceEventAt`

任一结果小于 0 时，该记录为无效时间证据，不得钳制成 0。

### 2.2 数据模式

每份报告只能选择一种 `dataMode`：

- `observed`：来自本地业务记录或用户明确导入的观察证据。
- `synthetic`：为自动化测试、看板验收或示例报告生成的合成数据。

同一报告不得混合两种模式。canonical lineage 实体、快照、实验卡和复盘 frame 的 `isSynthetic` 必须与根级 `dataMode` 一致；未重复携带该标志的 renderer 兼容投影整体继承根模式，不得从另一模式拼入记录。合成报告顶部必须展示：

> 合成数据验收样例，仅用于验证数据合同、计算与展示，不代表真实运营结果，也未执行真实平台发布。

合成数据只能证明“结构、状态机和公式可运行”，不能支持业务成效结论。默认生产查询必须排除合成数据，只有显式传入 `dataMode: "synthetic"` 才能读取。

### 2.3 证据与来源

每个可展示结果必须能追溯到来源系统、稳定记录 ID 和时间。允许的来源包括：

- 知识库 SQLite：`video_asset`、`import_item`、`content_analysis`、`remake_generation`、`metric_snapshot`、`comment_item`。
- 织台生成队列的持久化任务。
- 经脱敏持久化的逐平台发布回执。
- 显式创意审核事件。
- 用户手工导入的创作者后台指标。

短期直链、Cookie、令牌、手机号、账号凭据和平台原始敏感响应不得进入运营合同或示例报告。

## 3. 指标值与缺失语义

所有平台指标和运营 KPI 都必须携带 `status` 与 `value`。规范状态为：

| 状态 | `value` | 含义 | 典型 reasonCode |
| --- | --- | --- | --- |
| `available` | 非空，允许 `0` | 已采集到合法数值 | `null` |
| `unavailable` | `null` | 已尝试或源预期应提供，但源不支持、暂时错误或响应无该字段 | `source_unsupported`、`source_omitted_field`、`rate_limited`、`collector_error`、`legacy_unknown` |
| `not_collected` | `null` | 截至 `asOf` 尚未到采集时点、未执行采集或无符合条件的分母 | `snapshot_not_due`、`collector_not_run`、`no_eligible_records`、`no_terminal_attempts` |
| `permission_denied` | `null` | 已尝试，但被权限、授权范围或平台策略拒绝 | `api_scope_missing`、`account_permission_denied` |

强制约束：

- `{status:"available", value:0}` 是合法真实零值。
- 非 `available` 状态不得携带任何数值。
- `available` 不得搭配 `null`、`NaN` 或无穷值。
- 计数不得为负；比例内部统一存 `[0,1]`，展示层再格式化为百分比。
- 不得使用 `COALESCE(metric, 0)` 把未知状态并入总和或比率。
- 比率分母为 0 时返回 `not_collected + no_eligible_records`，不得返回 `0%`。
- 比率必须返回 `numerator` 和 `denominator`；分布指标必须返回样本量及所需分位数。报告根的 `snapshotCoverage` 与 `platformMetricStates` 统一返回覆盖和四态计数，使使用者能判断“数值低”还是“数据覆盖低”。

旧 `metric_snapshot` 的数值列继续保留以兼容现有 API。迁移不得根据 `NULL` 猜测 `not_collected` 或 `permission_denied`；无法恢复来源语义的历史 `NULL` 统一标为 `unavailable + legacy_unknown`。

## 4. 业务实体、血缘与分析单位

### 4.1 规范关系

```text
material（素材）
  └─< generated_video（生成成片）
        └─< platform_post（逐平台帖子/投递目的地）
              └─< metric_snapshot（1h/24h/7d/30d，多 revision）
```

- 一个素材可以有零到多个生成成片。
- 一个生成成片可以投递到零到多个平台帖子。
- 同一素材也允许不经过生成、直接形成平台帖子；此时帖子 `sourceRef.kind = material`。
- 平台帖子必须保留所属 `materialId`。若来源为生成成片，该成片也必须属于同一素材。
- 每个平台帖子独立保存平台、投递模式、外部帖子 ID、公开确认和回执；一个平台成功不得代表其他平台成功。
- 快照必须直接关联 `platformPostId`，不能只按素材取“最新非空指标”，以免不同帖子或平台串值。

### 4.2 不得跨粒度串成一个漏斗

一份报告包含四张独立漏斗：

| 漏斗 | 分析单位 | 示例阶段 |
| --- | --- | --- |
| 内容漏斗 | distinct `materialId` | collected → ingested → analyzed → has_generation → has_any_post |
| 生成尝试漏斗 | distinct `generationAttemptId` | started → terminal → completed |
| 审核漏斗 | distinct `reviewCycleId` / `generatedVideoId` | submitted → decided → approved / changes_requested |
| 平台帖子漏斗 | distinct `platformPostId` 或逐目的地回执 | due → acknowledged → draft / public / failed / unknown |

不得把“1 个成片 → 3 个帖子”直接计算成 300% 转换率。内容漏斗的 `has_any_post` 仍按 distinct 素材计；帖子漏斗另按三个帖子计。

### 4.3 cohort

- 流量型指标使用报告窗口内发生的事件。
- 转换型漏斗必须先固定 cohort。例如，内容转化默认以 `material.firstIngestedAt ∈ [startAt,endAt)` 为 cohort，再观察这些素材截至 `asOf` 的下游状态。
- 窗口前入库、窗口内公开的帖子可以进入“平台事件量”，但不能混入该窗口的入库 cohort 转换率。
- 报告必须输出 `cohortAnchor` 和分析单位。

## 5. 四个指标快照时点

规范快照偏移使用 ISO 8601 duration：

| 展示名 | `snapshotOffset` | `targetAt` |
| --- | --- | --- |
| 1 小时 | `PT1H` | `publishedAt + 1h` |
| 24 小时 | `P1D` | `publishedAt + 24h` |
| 7 天 | `P7D` | `publishedAt + 7d` |
| 30 天 | `P30D` | `publishedAt + 30d` |

采集器可接受 `1h/24h/7d/30d` 作为输入别名，但持久化和报告必须规范化为上表值。

快照规则：

1. 周期快照唯一粒度为 `(platformPostId, snapshotOffset, revision)`。
2. 同一次观测由稳定 `observationId` 幂等；重放不得新增 revision。
3. 迟到补数新增 revision，旧 revision 不删除、不覆盖。
4. `targetAt` 只由帖子 `publishedAt + snapshotOffset` 计算，不能用“最近一个任意快照”冒充时点快照。
5. 尚未到 `targetAt` 时，每个预期指标明确为 `not_collected + snapshot_not_due`。
6. 到点后平台无此能力为 `unavailable`；明确 401/403 或授权范围不足为 `permission_denied`。
7. 一个快照中的不同指标可以有不同状态，例如播放量不可用但点赞数为 0。
8. 旧的无时点 `metric_snapshot` 保留为 `ad_hoc` 证据；除非有明确调度证据，不得回填成四个周期槽位。

## 6. 十项运营指标

所有比率内部为 `[0,1]`。表中的“终态”“合格记录”和状态集合必须由适配器映射表固定，不能按文案模糊匹配。

### 6.1 采集量 `collection_volume`

- 粒度：distinct `ingestAttemptId`，对应现有日报中的 `import_item.id`；一条 intake attempt 无论结果如何只计一次。
- 窗口：尝试所属 `import_batch.created_at ∈ [startAt,endAt)`；若未来记录逐条 `receivedAt`，则使用逐条时间并提高合同版本说明切换点。
- 公式：`COUNT(DISTINCT ingestAttemptId)`，状态为 `success | linked | duplicate | failed | partial | orphaned | needs_attention | pending | processing | awaiting_primary_download` 的尝试都计入。
- 分母：无，`denominator = null`。
- 排除：相同稳定 `ingestAttemptId` 的幂等重放；不得因一次尝试同时产生多个素材/帖子而放大计数。
- 辅助值：canonical `kpis.collectionVolume.statistics.distinctResolvedAssets`（兼容投影为 `metrics.collection_volume.distinctResolvedAssets`）统计窗口内 `success | linked | duplicate` 尝试解析出的 distinct `materialId`；它不是采集量主值，也不替换主粒度。
- 空窗口但数据源可读取时：`available + 0`。

### 6.2 入库成功率 `ingestion_success_rate`

- 粒度：distinct `import_item.id` 或规范化 `ingestAttemptId`。
- cohort：尝试创建时间在报告窗口内。
- 分子：终态 `success | linked | duplicate`。
- 分母：全部终态尝试 `success | linked | duplicate | failed | partial | orphaned | needs_attention`。
- 排除：`pending | processing | awaiting_primary_download` 等非终态，另报活跃/积压数。
- 公式：`successfulTerminalAttempts / allTerminalAttempts`。
- 无终态尝试：`not_collected + no_terminal_attempts`。

### 6.3 分析积压 `analysis_backlog`

- 类型：截至 `asOf` 的 gauge，不是窗口流量。
- 粒度：distinct `materialId`。
- 公式：`eligibleForAnalysis AND no successful terminal analysis asOf` 的素材数。
- 合格性必须由明确状态确定；媒体无效、已豁免或已归档条目不得靠标题猜测。
- 分母：无；应附带 backlog age 的 p50/p90 作为辅助统计。
- 数据源可读且无积压：`available + 0`。

### 6.4 生成成功率 `generation_success_rate`

- 粒度：distinct `generationAttemptId`，不是生成成片数。
- 分子：终态 `completed` 且产物校验通过的尝试。
- 分母：实际开始后进入终态的 `completed | failed | timed_out | invalid_output`。
- 排除：`queued | running`，以及执行前由用户取消的任务。
- 公式：`completedAttempts / terminalStartedAttempts`。
- 同一素材多次尝试分别计数；另可报告 distinct 成片 yield，但不得混用分母。

### 6.5 返工率 `rework_rate`

- 粒度：distinct 已送审 `generatedVideoId`。
- 分子：至少一次收到显式 `changes_requested` 的已决成片。
- 分母：至少有一个终态审核决定 `approved | changes_requested | rejected` 的已送审成片。
- 公式：`videosWithExplicitRework / reviewedVideos`。
- 技术重试、重复导出、同素材多次生成和知识库 `correction` 不自动等同返工。

### 6.6 审核时长 `review_duration`

- 粒度：一个 `reviewCycleId`。
- 单条值：首次终态决定时间 `decisionAt - submittedAt`，单位秒。
- 汇总主值：p50，报告 unit 为 `seconds_p50`；同时必须给出 sample count、p90 seconds 和 open review count/open age。
- 未完成审核不进入时长分布；负时长为无效证据，不得改成 0。

### 6.7 草稿率 `draft_rate`

- 粒度：逐平台 `platformPostId` / destination receipt 的截至 `asOf` 最新状态。
- 分子：最新状态为 `platform_draft`。
- 分母：已到执行时间且已进入平台工作流的帖子，状态为 `platform_draft | submitted | public_confirmed | failed | needs_attention`。
- 排除：`workbench_draft | queued | scheduled | running` 和尚未到期的排期。
- `submitted` 是可见性未知状态，不计草稿分子，也不计公开分子。

### 6.8 公开率 `public_rate`

- 粒度与分母：与草稿率完全相同，保证两项可比较。
- 分子：只有具备平台外部 ID/URL、平台明确状态或用户导入确认的 `public_confirmed`。
- `submitted`、CLI 退出码 0、HTTP 2xx 或适配器 `success:true` 只表示已提交/已接收，不得映射成已公开。
- 应同时输出 visibility coverage 和 `submitted_unknown` 数量。

### 6.9 回执延迟 `receipt_latency`

- 粒度：逐平台 destination receipt。
- 单条值：`observedAt - sourceEventAt`，其中 source event 是投递请求实际发出的时间。
- 汇总主值：p50，报告 unit 为 `seconds_p50`；同时输出 sample count、p90 seconds 和无回执数。
- 下载收据 `download_receipt.started_at/completed_at` 不是发布回执，不得用于本指标。

### 6.10 指标新鲜度 `metric_freshness`

- 粒度：每个合格平台帖子。
- 单条值：`asOf - 该帖子最新 available 指标的 sourceEventAt`。
- 汇总主值：p90，报告 unit 为 `seconds_p90`；同时输出 p50 seconds、max seconds 和四态覆盖。
- 无任何 available 指标的帖子不进入数值分布，但必须进入状态覆盖。
- 不同平台、帖子和指标不得通过素材级“最新非空值”相互补齐。

## 7. OFAT 实验卡

允许的唯一主要变量为：

- `topic`：选题
- `hook_3s`：前三秒
- `cover`：封面
- `title`：标题
- `duration`：时长
- `publish_time`：发布时间

每张实验卡必须同时具备：

1. `primaryFactor`，且 control 与 variant 只改变这一项。
2. `heldConstant`，准确列出另外五项的冻结值或冻结版本/hash。
3. 基线种类、窗口、样本量、指标值与数据状态。
4. 明确分析单位、平台、内容系列、受众和分配方法。
5. 预注册主成功指标、方向、最小可检测效果和观察窗口。
6. 每组计划样本量、最小时长、最长时长、护栏和数据质量停止条件。
7. 结论模板、效应量/区间、样本量、限制和下一步。

运行时校验必须拒绝：

- control 与 variant 没有变化；
- 两个或以上主要变量同时变化；
- 计划样本量小于 1；
- 实验开始后更换主指标、基线或停止条件；
- 把同一帖子四个快照当成四个独立样本；
- 未达到预注册样本量/观察期就自动宣布胜出。

`allocationMethod` 可为 `randomized | matched | observational`，`evidenceLevel` 可为 `descriptive | associational | causal_randomized`。无随机分配、平台算法或其他变量未受控时只能写相关/伴随变化。即使是随机实验，报告也必须限定为“在本次实验条件下的证据”，不能无边界外推。

默认结论模板：

> 在本合同记录的样本与观察窗口内，变体与主指标出现【方向/幅度】的伴随变化。当前证据等级为【evidenceLevel】，样本量为【n】，数据覆盖为【coverage】。该结果不应被解释为超出实验设计范围的因果结论；建议【继续扩大样本 / 保留基线 / 停止 / 复现实验】。

## 8. 7/14/30 天复盘

每个运营 cohort 或计划必须保存 `reviewAnchorAt`。三个到期点为：

- D7：`reviewAnchorAt + 7d`
- D14：`reviewAnchorAt + 14d`
- D30：`reviewAnchorAt + 30d`

复盘状态：

| 状态 | 含义 |
| --- | --- |
| `not_due` | `asOf < dueAt`，不得生成成熟结论 |
| `ready` | 已到期且核心证据满足合同 |
| `missing_data` | 已到期，但关键指标缺失、权限拒绝或覆盖不足 |

每份复盘必须固定 `dataCutoffAt = dueAt`。D7 不得读取第 8 天数据，D14 不得读取第 15 天数据，D30 同理；迟到数据可通过新 revision 重新生成同一 horizon 的报告，但必须提高报告 revision 并保留旧版本。

建议内容：

| 阶段 | 必须检查 |
| --- | --- |
| D7 | 数据完整性、四态分布、运营漏斗、积压、1h/24h/7d 首轮信号、异常与权限 |
| D14 | 两周稳定性、平台/内容分段一致性、实验样本量、混杂因素和护栏 |
| D30 | 30d 快照、成熟状态分布、实验保留/停止/复现决定、后续接入优先级 |

所有阶段必须带 `asOf`、合同版本、数据模式、样本量、覆盖率、新鲜度和限制。复盘可以提出后续假设，不得将观察相关性写成因果。

## 9. 报告结构与合规措辞

规范报告根必须使用 `schemaVersion: "1.0.0"` 与 `contract: "zhitai.operations_metrics"`。`kpis/funnels/reviews` 是带公式、grain、coverage、cohort 和 cutoff 的严格 canonical 结构；`metrics/feedbackFunnel/reviewFramework` 是现有 renderer 的兼容投影。两组字段不要求对象形状相同，但必须由同一批中间事实生成，并在运行时交叉验证数值、状态、分母、统计量、stage、时点和 cutoff 的语义一致性。

日报和示例报告建议沿用现有“每日入库摘要”的信息架构：

1. 报告日期、`asOf`、时区、合同版本、数据模式。
2. “今天收了什么”：十项 KPI 表，显示数值、分子、分母、覆盖率和新鲜度。
3. “特别注意”：积压、permission denied、迟到快照、未知公开状态和数据限制。
4. “建议接入织台”：实验进度、待补回执、待复盘项目和接入建议。
5. 四张分粒度漏斗。
6. 多平台帖子与 1h/24h/7d/30d 快照矩阵。
7. D7/D14/D30 复盘。

允许措辞：

- “在该样本中观察到……”
- “两项指标同时变化，可能存在相关性。”
- “结果不足以支持因果结论。”
- “平台已接收任务，尚未确认公开可见。”

禁止措辞：

- “已证明”“必然导致”“因为换封面所以提升”。
- 合成报告中的“真实发布成功”“实际公开率”。
- 将 `submitted` 写成“已公开”。
- 将 `unavailable`、`not_collected` 或 `permission_denied` 展示成 0。

## 10. 质量规则与验收

P0 质量规则：

- 四态和值互斥规则 100% 通过。
- 每个 KPI 的公式、粒度、分子和分母与本合同一致。
- 所有血缘引用存在，跨素材 generation/post 关系为 0 条。
- `(platformPostId, snapshotOffset, revision)` 唯一；`observationId` 重放幂等。
- 未来时间、负时长、负计数、比率越界为 0 条。
- 合成/观察模式混合为 0 条。
- 报告中 `submitted → public_confirmed` 的无证据升级为 0 条。
- D7/D14/D30 使用 cutoff 之后数据为 0 条。

推荐验收夹具：4 个入库尝试（成功、linked、失败、pending），3 个生成尝试（完成、失败、running），1 个生成成片对应 3 个平台帖子（draft、submitted unknown、public confirmed），每帖 4 个周期快照。夹具必须整体标为 synthetic。

## 11. 版本与兼容策略

- `schemaVersion` 使用语义化版本。
- 新增可选字段为 minor；修改枚举、公式、粒度或分母为 major。
- 公式修复必须提高合同版本；`schemaVersion` 是 canonical 版本，`contractVersion` 为现有 renderer 保留的兼容别名，两者必须相等。
- 旧数值列继续作为兼容投影；新状态字段是运营合同的权威语义。
- JSON Schema 负责结构和条件约束；跨记录唯一性、时间先后、OFAT 只变一个值、外键归属及 cutoff 防泄漏由运行时校验和自动化测试负责。
