# 第三方补丁来源

`xiaohongshu-mcp-ai-declaration.patch` 是对
[`xpzouying/xiaohongshu-mcp`](https://github.com/xpzouying/xiaohongshu-mcp)
的可选源码补丁，目标基线固定为：

- commit: `6fb866a7db4e3dcce8dc00a0dde07370f3b12946`
- 上游日期：2026-08-20
- 许可证：Apache License 2.0
- 本地复核日期：2026-08-29

补丁只修改 `handlers_api.go`、`service.go` 和
`xiaohongshu/publish.go`，加入 AI 合成内容声明及“发布按钮点击前失败”的
结构化回执。修改过的第三方二进制不会随织台仓库或预览版分发。

在上述精确提交的干净源码树中验证补丁：

~~~bash
git apply --check /path/to/zhitai/patches/xiaohongshu-mcp-ai-declaration.patch
git apply /path/to/zhitai/patches/xiaohongshu-mcp-ai-declaration.patch
~~~

应用后仍须按上游说明自行构建，并保留上游 Apache-2.0 许可证。平台页面
变化可能使声明控件失效；织台要求引擎回读声明成功，否则失败关闭且不认定
发布成功。
