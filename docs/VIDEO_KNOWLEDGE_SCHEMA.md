# 短视频知识库字段契约

当前内容包格式：schemaVersion 2。

本文描述 v0.2.0-alpha.1 实际写入的内容包，以及 SQLite 与 API 的对应关系。内容包字段使用 camelCase 与少量历史 snake_case；SQLite 和多数 API 字段使用 snake_case。预发布阶段可能调整字段，消费者必须容忍未知字段并检查 status。

本文件只定义知识内容字段；从采集到归档的状态、真相源、幂等键与完成不变量以 [统一内容生命周期契约](CONTENT_LIFECYCLE.md) 为准。

Alpha 当前会在节点启动时执行数据库迁移，但还没有交互式迁移预览、自动备份或一键回滚。升级前必须自行备份数据库与内容包。

## 数据原则

- 平台事实、本地媒体事实和模型推断分层保存；
- 缺失值使用 null 或 unavailable，不用 0、空字符串或猜测填充；
- 每个可变平台指标是带观察时间和来源的 SQLite 快照；
- 稳定分享 URL 与临时下载 URL 分离；
- 内容包文件使用相对路径、大小、角色和 SHA-256；
- 导入、重试、修正和迁移尽量保持幂等；
- 公共知识库详情和导出不包含 Cookie、Token、解密参数或主机绝对文件路径。

## 存储层

| 层 | 当前作用 | 注意 |
| --- | --- | --- |
| metadata.json | 内容包身份、来源、媒体摘要、文件清单和平台帖子摘要 | 公共、可移植，不保存绝对路径 |
| analysis.md 与 JSON 产物 | 人类可读摘要、逐字稿、OCR 和镜头状态 | 初始通常为 unavailable，深度分析后可更新 |
| SQLite | 完整索引、内部路径、指标快照、导入状态、溯源和修正 | 本地内部数据，不直接作为可分享文件 |
| API / 导出 | 面向工作台的安全投影 | 字段多为 snake_case，隐藏 file_path 与 package_path |

## 当前内容包

~~~text
content-package/
├── assets/
│   └── primary-video.mp4
├── metadata.json
├── analysis.md
├── transcript.json
├── ocr.json
├── shots.json
└── source.url
~~~

实际媒体文件名由导入标题与扩展名生成，以 metadata.json 的 files 数组为准。新包先在同一文件系统的 staging 目录写完并校验，再原子移动到最终目录。

## metadata.json

当前写入结构如下；示例值是占位符：

~~~json
{
  "schemaVersion": 2,
  "id": "kb_example",
  "identity": {
    "contentId": null,
    "sourceKey": "sha256:source-url-hash",
    "primaryAssetSha256": "media-sha256"
  },
  "title": "示例标题",
  "category": "素材",
  "platform": "wechat_channels",
  "source": {
    "url": "https://example.invalid/stable-share",
    "receivedVia": "local"
  },
  "capturedAt": "2026-01-01T00:00:00.000Z",
  "channel": "local",
  "mediaValidation": "ok",
  "fallbackReason": null,
  "media": {
    "durationMs": 1000,
    "width": 1080,
    "height": 1920,
    "codecVideo": "h264",
    "codecAudio": "aac",
    "bitrateKbps": 1000,
    "sizeBytes": 123456,
    "sha256": "media-sha256"
  },
  "files": [
    {
      "path": "assets/primary-video.mp4",
      "role": "video",
      "sizeBytes": 123456,
      "sha256": "media-sha256"
    }
  ],
  "platform_posts": [],
  "corrections": []
}
~~~

### identity

- contentId：可验证的平台内容 ID；未知时为 null；
- sourceKey：稳定来源 URL 的 SHA-256 标识；没有稳定来源时为 null；
- primaryAssetSha256：主媒体 SHA-256。

### source

当前只有：

- url：经过清理的稳定来源 URL 或 null；
- receivedVia：接收通道。

capturedAt 位于 metadata 顶层。当前格式没有 attribution 字段；如需记录授权证明，应保存在单独、受访问控制的本地记录中，不要把个人数据直接加入公共 metadata。

### media

当前字段为 durationMs、width、height、codecVideo、codecAudio、bitrateKbps、sizeBytes 和 sha256。

媒体验证结果位于顶层 mediaValidation；回退原因位于 fallbackReason。当前 metadata 不写 frameRate、probeProvider 或独立 missingReason。更完整的内部媒体状态可能存在于 SQLite 或适配器收据。

### files

当前每项包含 path、role、sizeBytes 和 sha256。path 必须是内容包内相对路径；读取时仍需解析真实路径并验证允许根目录。

### platform_posts

注意这里使用实际字段名 platform_posts。它只是首次入库时的平台摘要，每项当前可能包含：

- postId；
- author；
- publishTime；
- title；
- likes；
- coverUrl；
- platform。

完整的 content_id、URL、描述性字段和多次指标观察保存在 SQLite 的 platform_post 与 metric_snapshot 中，不应从 metadata 摘要反推。

### corrections

首次写入为空数组。人工修正同步到 metadata 后，每项当前包含：

- field；
- oldValue；
- newValue；
- reason；
- correctedAt。

当前没有 actor 字段。SQLite correction 表使用 old_value、new_value 和 corrected_at。

## 初始分析产物

没有配置分析引擎时，transcript.json 与 ocr.json 的真实形状为：

~~~json
{
  "status": "unavailable",
  "reason": "asr_not_configured",
  "generatedAt": null,
  "source": null,
  "kind": "transcript"
}
~~~

ocr.json 使用对应的 reason 与 kind。shots.json 初始为：

~~~json
{
  "status": "unavailable",
  "reason": "shot_analysis_not_configured",
  "segments": []
}
~~~

外置分析写回后，这些文件可能增加 provider、items、segments 或其他提供者字段。调用方应以 status 为入口，并容忍附加字段；当前版本不保证所有分析产物都具有统一的 providerVersion、confidence 或 limitation。

analysis.md 是自动生成的人类可读摘要，不是独立事实源。source.url 保存稳定来源 URL；没有稳定来源时为空行。

## SQLite 对应关系

主要表包括：

- video_asset：资产身份、内部 file_path、package_path、本地媒体与验证状态；
- platform_post：平台帖子事实，字段使用 snake_case；
- metric_snapshot：captured_at、source、observation_id 和各项指标；
- transcript、ocr、shot：结构化分析结果；
- content_analysis、virality_analysis、knowledge_chunk、field_provenance：分析与溯源；
- import_batch、import_item：导入批次、逐项状态、重试与错误；
- correction：old_value、new_value、reason 与 corrected_at；
- download_receipt、ingest_observation：收据与导入观察。

SQLite 中的绝对路径只供本地节点使用。知识库详情会移除 file_path、package_path 和 raw_json_path；导出使用列表安全投影。

## 指标与传播分析

播放量、点赞、收藏、评论和转发不能互相推导。接口没有返回的指标保持 null。

metric_snapshot 当前使用 captured_at、source 和 observation_id 标记观察。归一化值与上游原文分别保存；未知和空白不是 0。

只有互动快照时，最多输出“潜在传播因素”：

- 明确可观察证据；
- 可能的反证；
- 置信度；
- 缺失信息；
- isCausal 为 false。

判断因果或相对表现至少需要播放、曝光、完播、留存、流量来源、时间序列和可比较基准。没有这些信息时不得声称“为什么火”已得到证明。

## API 行为

- 列表支持分页、搜索、分类和稳定排序；
- 详情返回平台、本地媒体、分析、来源、快照与修正，并剥离内部绝对路径；
- 媒体接口支持合法 HTTP Range，并拒绝越界范围；
- JSON 与 CSV 导出基于列表安全投影；
- 导入与修复流程可能出现 success、partial、duplicate、linked、pending、processing、failed 或 orphaned 等状态；
- 重试保留失败信息与次数；
- 当前启动迁移具有部分幂等处理，但迁移预览、自动备份和一键回滚仍是路线图项目。

消费者不得把进程存活、退出码 0、HTTP 2xx 或缺失字段当成业务完成。
