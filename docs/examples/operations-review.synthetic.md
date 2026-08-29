# 织台运营指标与复盘报告

> **合成数据验收样例**：仅用于验证数据合同、计算与展示，不代表真实运营结果，也未执行真实平台发布。

- 合同版本：1.0.0
- 数据模式：synthetic
- 窗口：2026-08-01T00:00:00.000Z — 2026-08-31T18:00:00.000Z
- as_of：2026-08-31T18:00:00.000Z（Asia/Shanghai）

## 十项运营指标

| 指标 | 结果 | 状态 |
| --- | --- | --- |
| 采集量 | 4 intake_items | available |
| 入库成功率 | 66.67% (2/3) | available |
| 分析积压 | 1 assets | available |
| 生成成功率 | 50% (1/2) | available |
| 返工率 | 50% (1/2) | available |
| 审核时长 | 5400 seconds_p50 | available |
| 草稿率 | 33.33% (1/3) | available |
| 公开率 | 33.33% (1/3) | available |
| 回执延迟 | 480 seconds_p50 | available |
| 指标新鲜度 | 21600 seconds_p90 | available |

## 反馈漏斗

### content（distinct_material）

- collected: 2
- ingested: 2
- analyzed: 1
- has_generation: 1
- has_any_post: 1

### generationAttempts（generation_attempt）

- started: 3
- terminal: 2
- completed: 1

### review（review_cycle）

- submitted_for_review: 2
- decided: 2
- outcome.approved: 1
- outcome.needsRevision: 1

### distribution（platform_destination）

- due: 3
- acknowledged: 3
- outcome.platformDraft: 1
- outcome.publicConfirmed: 1
- outcome.failed: 0
- outcome.needsAttention: 0
- outcome.unknown: 0
- publishedPosts: 3
- postsWithMetricObservation: 3
- 口径：一条成片可分叉到多个平台；不与素材阶段直接计算转换率

## 1h / 24h / 7d / 30d 快照覆盖

| 时点 | 应到帖子 | 已记录 | 有可用值 | 未记录 |
| --- | ---: | ---: | ---: | ---: |
| 1h | 3 | 3 | 3 | 0 |
| 24h | 3 | 3 | 3 | 0 |
| 7d | 3 | 3 | 3 | 0 |
| 30d | 3 | 3 | 3 | 0 |

## 7 / 14 / 30 天复盘

- D7 · ready · 截止 2026-08-08T00:00:00.000Z · 数据完整性、运营漏斗、积压与首轮信号
- D14 · ready · 截止 2026-08-15T00:00:00.000Z · 两周稳定性、分段一致性、实验样本与混杂因素
- D30 · ready · 截止 2026-08-31T00:00:00.000Z · 30 天成熟快照、复现实验、保留、迭代或停止决定

## 单变量实验卡

- synthetic-exp-topic: topic；计划样本 24 platform_post；主指标 completion_rate@24h
- synthetic-exp-hook_3s: hook_3s；计划样本 24 platform_post；主指标 completion_rate@24h
- synthetic-exp-cover: cover；计划样本 24 platform_post；主指标 completion_rate@24h
- synthetic-exp-title: title；计划样本 24 platform_post；主指标 completion_rate@24h
- synthetic-exp-duration: duration；计划样本 24 platform_post；主指标 completion_rate@24h
- synthetic-exp-publish_time: publish_time；计划样本 24 platform_post；主指标 completion_rate@24h

## 限制与下一步

- 平台 submitted/success 仅表示任务被接收，未取得 public/published 回执前不计入公开率。
- 缺失状态不会被折算为 0；permission_denied、not_collected 与 unavailable 分别统计。
- 基础知识库尚无显式 analysis eligibility/豁免字段，分析积压以当前全部素材为可分析代理口径，并在接入后替换。
- 除非实验满足预先声明的随机化与统计条件，指标同时变化只能描述为相关或伴随变化。
- 本报告使用合成数据，仅验证合同、计算和展示，不代表真实运营结果。

报告中的同时变化只表示相关或伴随关系；不得据此改写为因果结论。
