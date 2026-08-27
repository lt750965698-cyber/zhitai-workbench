# 第三方声明

本文件说明织台与第三方软件、模型、服务和内容的边界，不构成法律意见。

## 织台自身

除另有说明外，本仓库由织台项目原创的代码以 [MIT License](LICENSE) 发布。该许可不自动覆盖：

- npm 依赖及其传递依赖；
- 用户自行安装的外置引擎、模型和二进制；
- 平台账号、API、网页、Cookie、登录态和服务；
- 用户处理或生成的媒体；
- 来源不明或许可证不明确的脚本与素材。

出现冲突时，以第三方组件随附的许可证和固定版本源码为准。

## 包管理依赖

生产依赖的直接许可证摘要：

| 组件 | 许可证 | 用途 |
| --- | --- | --- |
| [React](https://github.com/facebook/react) / React DOM / Scheduler | MIT | 用户界面 |
| [Drizzle ORM](https://github.com/drizzle-team/drizzle-orm) | Apache-2.0 | 数据访问 |

开发、构建和桌面依赖还包括 TypeScript、Vite、Tailwind CSS、ESLint、Wrangler、Electron 等。完整版本由 pnpm-lock.yaml、desktop/package-lock.json 和各包中的 LICENSE 文件确定。

可在干净安装后运行以下命令审计当前解析结果：

~~~bash
pnpm licenses list --json
~~~

该命令只审计根 pnpm 依赖树。desktop 使用独立的 npm lockfile，必须另行检查 desktop/package-lock.json、安装后的 npm 依赖树和每个包的 LICENSE。构建或再分发时必须保留全部依赖要求的版权和许可证通知。

## 外置引擎

下列项目只通过配置、进程或 HTTP 适配器与织台连接，默认不属于织台发行物。许可证状态依据 2026-08-27 可见的上游 LICENSE 文件整理；启用或分发前必须在所选固定版本上重新核验。

| 外置项目 | 上游许可 | 重要说明 |
| --- | --- | --- |
| [wechat-mp-tools](https://github.com/x554960766/wechat-mp-tools/blob/main/LICENSE) | MIT 文本，附教育与个人研究用途免责声明 | 商业或再分发场景应先向上游确认附加说明的含义 |
| [wx_channels_download](https://github.com/ltaoo/wx_channels_download/blob/main/LICENSE) | MIT + Commons Clause | 限制销售，不能按普通 MIT 或 OSI 开源组件处理；不得打包进默认发行物 |
| [douyin-downloader](https://github.com/jiji262/douyin-downloader/blob/main/LICENSE) | MIT | 仍需遵守平台条款和内容授权 |
| [openclaw-weixin](https://github.com/Tencent/openclaw-weixin/blob/main/LICENSE) | MIT | 微信账号、会话和服务条款不由该源码许可覆盖 |
| [pywechat](https://github.com/Hello-Mr-Crab/pywechat/blob/main/LICENSE) | LGPL-2.1 | 分发或链接时需履行 LGPL 条件 |
| [MatrixMedia](https://github.com/hanliang97/MatrixMedia/blob/main/LICENSE) | GPL-2.0 | 打包、修改或组合分发可能触发 GPL 义务 |
| [xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp/blob/main/LICENSE) | Apache-2.0 | 需保留 NOTICE、版权和许可证要求（如适用） |
| [ai-goofish-monitor](https://github.com/Usagi-org/ai-goofish-monitor/blob/master/LICENSE) | MIT | 项目状态与安全性需在安装时重新评估 |
| [XianyuAutoAgent](https://github.com/shaxiu/XianyuAutoAgent/blob/main/LICENSE) | GPL-3.0 | 与其他组件组合或分发前应审查 GPL 义务 |
| [xianyu-auto-reply-fix](https://github.com/GuDong2003/xianyu-auto-reply-fix/blob/main/LICENSE) | AGPL-3.0 | 修改后提供网络服务也可能触发源代码提供义务 |
| [mcp-video-analyzer](https://github.com/guimatheus92/mcp-video-analyzer/blob/main/LICENSE) | MIT | 其调用的模型、FFmpeg 和媒体仍有独立条款 |
| [MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo/blob/main/LICENSE) | MIT | 模型、素材 API、字体、音乐和生成结果另受各自条款约束 |

以上清单表示潜在兼容接口，不表示项目维护者认可、担保、托管或分发这些工具。

## 可选模块更新器

仓库包含由用户在界面中确认后触发的本地更新器。它可能：

- 从配置的 GitHub 上游读取 latest release；
- 下载源码归档、DMG 或更新清单到本机私有 runtime；
- 在隔离目录安装 Node.js 或 Python 依赖并构建源码；
- 切换本地版本并保留部分备份；
- 修改 MatrixMedia 的 Info.plist，使其以后台附件运行，再执行本机 ad-hoc 重签名；
- 按上游清单覆盖外置项目中的特定文件。

这不表示第三方组件被捆绑进仓库或默认发行物，但下载、修改、安装和组合使用仍受上游许可证约束。当前更新器会核对标签、内部版本和部分资产大小，个别更新清单使用 MD5；它没有为所有组件验证发布者签名或通用的加密校验和。

使用者应在确认更新前独立核验上游仓库、所选版本、许可证、发行资产和变更内容。对 GPL、AGPL、Commons Clause 或附加用途说明的组件，修改或再分发前应取得合格法律意见。

## 许可证不明确的脚本

部分工作流可能与俗称“快点”的第三方浏览器用户脚本交互。项目目前没有确认该脚本存在允许复制、修改或再分发的明确许可证。

因此：

- 织台发行物不得包含其源码、混淆代码、修改版、整合版或派生 bundle；
- 文档和安装器不得引导用户复制或打包该源码；
- 只能保留不依赖具体实现的通用适配器契约；
- 使用者如自行取得该脚本，必须自行确认来源、许可证、平台规则和内容授权；
- 未取得明确许可前，不应发布相关 fork、镜像或二进制。

## 媒体与模型工具链

FFmpeg 的许可证取决于构建配置，可能是 LGPL 或 GPL。WhisperX、Demucs、视觉模型、ASR 模型、字体、音乐和生成服务也各有独立许可证或使用条款。织台的 MIT License 不覆盖它们。

启用媒体分析或生成前应记录：

- 精确版本、来源和校验和；
- 源码与模型权重许可证；
- 是否允许商业使用、衍生作品和再分发；
- 数据是否上传到第三方；
- 输出内容的归属、标注和保留政策。

## 平台与托管服务

微信、视频号、公众号、抖音、小红书、闲鱼、X、ChatGPT、豆包、Seedance、元宝、ntfy 及其他平台或服务的名称与商标属于各自权利人。织台与这些平台不存在官方隶属或背书关系。

访问平台网页、API、登录态和账号时，使用者必须遵守适用法律、平台条款、开发者政策、隐私要求、速率限制与内容授权。公开可见不等于可下载、可训练、可改编或可再发布。

## 贡献者义务

新增第三方依赖或集成的 Pull Request 必须更新本文件，并说明上游地址、固定版本、许可证、分发方式、权限、数据流和人工降级路径。许可证不明确时，只能贡献抽象接口和模拟测试。
