/**
 * mock-enrich.mjs — 元宝补元数据测试桩（经 ZHITAI_ENRICH_SCRIPT 注入，生产不启用）
 * 返回结构化 enriched.media，验证：作者/标题/赞藏评转归一化/exportId(contentId)/封面/版式信号。
 */
export default async function mockEnrich(sourceUrl) {
  const url = String(sourceUrl || "");
  // 依据 sourceUrl 里的标记返回不同帖子（用于一资产多帖子测试）
  const postMarker = /post=(\w+)/.test(url) ? url.match(/post=(\w+)/)[1] : "default";
  const media = {
    postId: postMarker === "default" ? "mock_export_1" : `mock_export_${postMarker}`,
    title: postMarker === "default" ? "Mock标题-北京朝阳老房改造" : `Mock标题-帖子${postMarker}`,
    author: "作者",
    publishTime: "2026-08-01T00:00:00.000Z",
    likes: postMarker === "default" ? "1.2万" : "88",
    comments: "40",
    favorites: "702",
    shares: "50",
    plays: null, // 接口无播放量
    platform: "wechat_channels",
    coverUrl: "https://mock.example/cover.jpg",
    topics: ["#改造", "#收纳"],
    scalingInfo: { aspectRatio: "9:16" },
  };
  // rawForStorage 供脱敏验证（含敏感键，落盘后必须被剥除）
  return {
    raw: {
      feedInfo: {
        description: media.title,
        videoUrl: "https://finder.video.qq.com/251/x?encfilekey=SECRET&token=TOK",
        decodeKey: "DECODE",
        h264VideoInfo: { videoUrl: "https://finder.video.qq.com/251/h264?encfilekey=K" },
        cookie: "SESSION",
        author: media.author,
      },
    },
    media,
  };
}
