/**
 * VideoToPrompt 外站增强薄适配。
 *
 * 只在用户从织台明确点击“外站增强”后调用；不把它放进自动入库链路。
 * 外站本身也是在浏览器内抽取关键帧后分析，因此这里发送最多 5 张已落库关键帧，
 * 不发送 Cookie、账号信息、元数据文件或整段原视频。
 */

const ENDPOINT = "https://videotoprompt.com/api/generator/analyze";

function cleanDataUrl(value) {
  const text = String(value || "");
  if (!/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/i.test(text)) {
    throw new Error("外站增强只接受 JPEG/PNG/WebP 关键帧");
  }
  return text;
}
export async function reverseVideoFramesExternal({ frameDataUrls, title = "公开视频", timeoutMs = 90_000 } = {}) {
  const frames = Array.isArray(frameDataUrls) ? frameDataUrls.slice(0, 5).map(cleanDataUrl) : [];
  if (!frames.length) throw new Error("没有可发送的关键帧，请先完成本地视频分析");
  const prompt = [
    `请根据按时间顺序抽取的 ${frames.length} 张关键帧，反推《${String(title || "公开视频").slice(0, 120)}》的中文视频生成提示词。`,
    "结果应可直接用于 Seedance、Veo、可灵或 Wan。",
    "必须覆盖：主体外观与数量、场景空间关系、材质、光线与色彩、构图景别、镜头运动、动作轨迹、节奏、物理约束、一致性锚点和负面约束。",
    "不要臆造关键帧中不可见的品牌、人物身份、对白或因果；不要复制水印、Logo、字幕或专有角色。",
    "只输出一段完整、具体、可执行的简体中文提示词。",
  ].join("\n");
  const messages = [{
    role: "user",
    content: [
      ...frames.map((url) => ({ type: "image_url", image_url: { url } })),
      { type: "text", text: prompt },
    ],
  }];
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ messages }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.code !== 0) {
    const reason = String(payload?.message || `HTTP ${response.status}`).slice(0, 300);
    throw new Error(`VideoToPrompt 分析失败：${reason}`);
  }
  const result = String(payload?.data?.result || "").trim();
  if (!result) throw new Error("VideoToPrompt 没有返回可用提示词");
  return {
    provider: "VideoToPrompt",
    mode: "explicit_public_keyframes",
    endpoint: "https://videotoprompt.com/",
    frameCount: frames.length,
    prompt: result,
    analyzedAt: new Date().toISOString(),
    limitation: "外站只看关键帧，不含原音轨、逐帧运动矢量与平台表现数据；结果需与本地运镜/ASR证据合并。",
  };
}
