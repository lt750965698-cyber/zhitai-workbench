#!/usr/bin/env node
/**
 * 织台 · 视频号内容分类与分析模块
 *
 * 职责：
 *   1) classifyCategory —— 按关键词把视频号内容分到 素材 / 技能 / 其他
 *       素材 = 可作为视频复刻输入的成片 / 视觉案例（题材不限）
 *       技能 = 教程、工具、步骤、项目和方法论
 *       其他 = 未命中上述两类
 *   2) buildLocalAnalysis —— 基于已有元数据(标题/描述/作者/互动数据)生成结构化分析 md
 *   3) callYuanbaoChat —— 尽力调用元宝网页对话接口做深度分析(被签名网关拦截时优雅降级为 null)
 *   4) analyzeVideo(media) —— 组合本地分析 + 元宝视角，返回 { category, analysisMarkdown }
 *
 * 设计取舍：元宝网页对话接口需要 live-browser 的 x-uskey 签名，纯 Node 无法稳定复现，
 * 因此 callYuanbaoChat 在拿不到结果时返回 null，本地规则分析始终作为交付兜底，绝不阻断主流程。
 */

import { loadYuanbaoCookie } from "./channels-yuanbao.mjs";
import { parseFormattedCount } from "./content-metadata.mjs";

/* 已有业务题材词：仅代表“可复用案例”的一个来源，不再等同于全部素材。 */
const MATERIAL_KW = [
  "装修", "适老化", "改造", "家居", "养老", "旧房", "老房", "新房", "户型", "小户型", "卫生间", "厨房",
  "卧室", "客厅", "餐厅", "书房", "玄关", "阳台", "施工", "建材", "软装",
  "收纳", "灯光", "照明", "隔音", "防滑", "无障碍", "家具", "家电", "住宅", "公寓",
  "别墅", "民宿", "室内", "硬装", "全屋", "定制", "门窗", "地板", "瓷砖", "墙面",
  "吊顶", "水电", "防水", "涂料", "老人", "银发", "康养", "照护", "适老", "居家",
  "空间", "翻修", "焕新", "厨卫", "木作", "油漆", "电工", "泥瓦", "工期", "预算",
  "甲醛", "新风", "地暖", "智能马桶", "淋浴", "扶手", "坡道", "玄关柜", "榻榻米",
  "儿童房", "老人房", "父母房", "长辈", "卫浴", "厨柜", "衣柜", "背景墙", "飘窗",
  "防滑垫", "轮椅", "护理床", "夜灯", "适老改造", "无障碍设计", "洗澡", "如厕", "起身",
  "卫洗丽", "适老卫浴", "养老改造", "适老化设计", "老年", "爸妈", "适老家具",
];

/* AI / 大模型 / 智能体 关键词（命中即归「技能」） */
const SKILL_KW = [
  "AI", "人工智能", "大模型", "大语言模型", "深度学习", "机器学习", "神经网络",
  "提示词", "Prompt", "prompt", "智能体", "Agent", "agent", "GPT", "ChatGPT", "Claude",
  "文心", "通义", "豆包", "元宝", "混元", "扩散模型", "生成式", "AIGC", "算力", "微调",
  "向量", "知识库", "RAG", "多模态", "语音识别", "数字人", "具身智能", "编程", "代码",
  "自动化", "工作流", "爬虫", "逆向", "算法", "数据", "Python", "部署", "推理", "训练",
  "LLM", "Stable Diffusion", "Midjourney", "Sora", "文生图", "文生视频", "智能", "模型",
  "GPTs", "Copilot", "Agent", "工作流", "n8n", "Dify", "Coze", "扣子", "智谱", "Kimi",
  "开源大模型", "本地部署", "量化", "embedding", "提示工程", "上下文",
  "DeepSeek", "Codex", "Cursor", "Windsurf", "Aider", "Qwen", "GLM", "Skill", "技能教程",
  "自动化工具", "prompt工程", "Agent开发", "智能体开发",
];

const TUTORIAL_INTENT_KW = [
  "教程", "教学", "如何", "怎么做", "怎样做", "步骤", "流程", "工作流", "方法", "技巧",
  "开源项目", "开源", "GitHub", "github", "仓库", "工具", "插件", "Skill", "skill", "安装", "部署",
  "课程", "指南", "文档", "入门", "实操", "调用", "接口", "API", "源码", "网站", "整理了",
];

const VISUAL_MATERIAL_KW = [
  "AI视频", "AI 视频", "AIGC视频", "生成视频", "生成的影片", "文生视频", "图生视频", "一镜到底",
  "短剧", "漫剧", "动画", "口哨舞", "动态贴图", "写真", "角色延续", "运镜", "分镜", "参考视频",
  "真人感", "电影感", "画面效果", "提示词在评论区", "提示词：", "Prompt：", "prompt：", "效果确实",
  "好可爱", "好真实", "生成指定", "Seedance", "seedance", "MinMaxH3", "Grok imagine",
];

const ALL_KW = [...MATERIAL_KW, ...SKILL_KW];

export function classifyCategory(title = "", description = "", author = "") {
  const text = `${title}\n${description}\n${author}`;
  const hit = (kw) => text.includes(kw);
  const tutorialIntent = TUTORIAL_INTENT_KW.some(hit);
  const visualMaterialIntent = VISUAL_MATERIAL_KW.some(hit)
    || (/(?:AI|AIGC|GPT|豆包|Seedance|Sora|可灵|即梦|H3)/i.test(text) && /视频|画面|角色|模特|动作|镜头|动画|写真|效果/.test(text));
  // 分类依据是用途而不是题材：明确教程先进入每日学习；纯成片/视觉案例才进入复刻素材。
  if (tutorialIntent) return "技能";
  if (visualMaterialIntent || MATERIAL_KW.some(hit)) return "素材";
  if (SKILL_KW.some(hit)) return "技能";
  return "其他";
}

export function extractTags(text = "", max = 14) {
  const tags = new Set();
  for (const kw of ALL_KW) if (text.includes(kw)) tags.add(kw);
  return [...tags].slice(0, max);
}

const CATEGORY_REASON = {
  素材: "内容更像可复刻的成片或视觉案例，归入「素材」并进入 GPT + 豆包生成流程；题材不限。",
  技能: "内容更像教程、工具、步骤、项目或方法论，归入「技能」并进入每日学习。",
  其他: "用途暂不明确，归入「其他」，建议人工快速过目后移动到对应分类。",
};

export function buildLocalAnalysis({ title = "", description = "", author = "", stats = {}, category }) {
  const text = `${title}\n${description}`;
  const tags = extractTags(text);
  const like = String(stats.like ?? "0");
  const fav = String(stats.fav ?? "0");
  const forward = String(stats.forward ?? "0");
  const comment = String(stats.comment ?? "0");
  const summary = (description && description.trim())
    ? description.trim().split("\n").filter(Boolean).join("；")
    : (title || "（无文字描述，仅视频文件）");

  const nLike = parseFormattedCount(like).value || 0;
  const nFav = parseFormattedCount(fav).value || 0;
  const nForward = parseFormattedCount(forward).value || 0;
  const nComment = parseFormattedCount(comment).value || 0;
  const interactions = [];
  if (nFav >= nLike && nLike + nFav > 0) {
    interactions.push("收藏量 ≥ 点赞量，内容偏「可复用参考 / 干货」，适合长期纳入素材库查阅。");
  }
  if (nForward > 0) interactions.push(`转发 ${nForward}，传播性较好。`);
  if (nComment > 0) interactions.push(`评论 ${nComment}，存在互动讨论。`);
  if (nLike + nFav + nForward + nComment === 0) interactions.push("暂无明显互动数据。");

  const reuse =
    category === "素材"
      ? "建议作为视频视觉参考与复刻素材，反推其主体、风格、镜头、动作和节奏后生成自己的版本。"
      : category === "技能"
        ? "建议作为 AI 工具 / 方法 / 提示词的实践记录，可用于工作流沉淀与团队分享。"
        : "建议人工快速过目，判断它是待复刻成片还是学习资料后移动到对应分类。";

  return [
    `# 内容分析 · ${title || "未命名视频号内容"}`,
    "",
    `> 来源：视频号 ｜ 作者：${author || "未知"} ｜ 自动分类：**${category}**`,
    "",
    "## 一、内容概述",
    summary,
    "",
    "## 二、自动分类与理由",
    `- 分类：**${category}**`,
    `- 理由：${CATEGORY_REASON[category] || ""}`,
    "",
    "## 三、关键词 / 标签",
    tags.length ? tags.map((t) => `- ${t}`).join("\n") : "- （未提取到显著关键词）",
    "",
    "## 四、互动数据",
    `- 点赞 ${like} ｜ 收藏 ${fav} ｜ 转发 ${forward} ｜ 评论 ${comment}`,
    ...interactions.map((i) => `- ${i}`),
    "",
    "## 五、评论情况",
    nComment > 0
      ? `该视频约有 ${nComment} 条评论（评论正文需视频号签名接口抓取，当前未获取）。`
      : "该视频暂无 / 极少评论。",
    "",
    "## 六、可复用价值",
    reuse,
    "",
    "## 七、证据边界",
    "- 当前报告只依据标题、描述、作者和互动数生成，尚未读取视频画面或音轨。",
    "- 拍摄角度、镜头节奏、配音逐字稿、画面文字和爆火原因需要视觉 / ASR / OCR 能力后才能给出有证据的结论。",
    "",
    "---",
    "_本分析由本地规则引擎生成；元宝深度分析见下方「元宝视角」（若可用）。_",
    "",
  ].join("\n");
}

/* ────────────── 元宝网页对话（尽力调用，被网关拦截则降级） ────────────── */

const AGENT_ID = "naQivTmsDa";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

function yuanbaoHeaders(cookie, extra = {}) {
  return {
    "content-type": "text/plain;charset=UTF-8",
    accept: "text/event-stream, application/json, text/plain, */*",
    "accept-charset": "utf-8",
    "x-language": "zh-CN",
    "x-requested-with": "XMLHttpRequest",
    "x-platform": "win",
    "x-source": "web",
    "x-webversion": "2.63.0",
    "user-agent": UA,
    origin: "https://yuanbao.tencent.com",
    referer: "https://yuanbao.tencent.com/chat",
    cookie,
    ...extra,
  };
}

/**
 * 调用元宝网页对话接口，返回拼接后的正文文本；任何失败(含「未登录」网关拦截)返回 null。
 * 注意：元宝对话接口需要 live-browser 的 x-uskey 签名，纯 Node 调用在 cookie 仅含解析态时会被拒，
 * 此时返回 null，由上层回退到本地分析。
 */
async function callYuanbaoCookieChat(prompt, { timeoutMs = 45000 } = {}) {
  let cookie;
  try {
    cookie = await loadYuanbaoCookie();
  } catch {
    return null;
  }
  if (!cookie) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const createResp = await fetch("https://yuanbao.tencent.com/api/user/agent/conversation/create", {
      method: "POST",
      headers: yuanbaoHeaders(cookie, { "content-type": "application/json" }),
      body: JSON.stringify({ agentId: AGENT_ID }),
      signal: controller.signal,
    });
    if (!createResp.ok) return null;
    const created = await createResp.json().catch(() => null);
    const chatId = created?.id;
    if (!chatId) return null;

    const body = {
      model: "gpt_175B_0404",
      prompt,
      plugin: "Adaptive",
      displayPrompt: prompt,
      displayPromptType: 1,
      options: { imageIntention: { needIntentionModel: true, backendUpdateFlag: 2, intentionStatus: true } },
      multimedia: [],
      agentId: AGENT_ID,
      supportHint: 1,
      version: "v2",
      chatModelId: "gpt_175B_0404",
    };
    const chatResp = await fetch(`https://yuanbao.tencent.com/api/chat/${chatId}`, {
      method: "POST",
      headers: yuanbaoHeaders(cookie, { "x-agentid": `${AGENT_ID}/${chatId}` }),
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!chatResp.ok) return null;

    let buffer = "";
    let out = "";
    for await (const chunk of chatResp.body) {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("data:")) continue;
        const data = trimmed.slice(5).trim();
        if (!data || data === "[DONE]") continue;
        try {
          const j = JSON.parse(data);
          if (j.type === "error" || j.msg) {
            if (j.type === "error") return null; // 未登录 / 网关拦截
          }
          if (typeof j.content === "string" && j.content) out += j.content;
        } catch {
          /* 忽略非 JSON 行 */
        }
      }
      if (out.length > 4000) break;
    }
    return out.trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 优先走织台 App 内的已登录元宝窗口，实时捕获 x-uskey；App 未启动/未登录时才回退旧 Cookie 直连。 */
export async function callYuanbaoChatDetailed(prompt, { timeoutMs = 45000, interactive = false } = {}) {
  try {
    const response = await fetch("http://127.0.0.1:17910/v1/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, timeoutMs, interactive }),
      signal: AbortSignal.timeout(timeoutMs + 5_000),
    });
    const payload = await response.json().catch(() => null);
    if (response.ok && payload?.ok && typeof payload?.content === "string" && payload.content.trim()) {
      return { content: payload.content.trim(), provider: "yuanbao-live-browser", mode: "signed_browser_session" };
    }
  } catch { /* 织台 App 未运行或签名桥未就绪，继续旧 Cookie 回退 */ }
  const content = await callYuanbaoCookieChat(prompt, { timeoutMs });
  return content ? { content, provider: "yuanbao-cookie", mode: "cookie_fallback" } : null;
}

export async function callYuanbaoChat(prompt, options = {}) {
  const result = await callYuanbaoChatDetailed(prompt, options);
  return result?.content || null;
}

/**
 * 把本地已提取的 ASR/OCR/时间线交给元宝做文本层增强。
 * 不上传原视频或关键帧；Cookie/签名不足时返回 null，绝不伪装成功。
 */
export async function analyzeExtractedVideoWithYuanbao(result, { timeoutMs = 12000 } = {}) {
  const transcript = Array.isArray(result?.transcript)
    ? result.transcript.map((item) => `[${item?.time || "?"}] ${String(item?.text || "").trim()}`).filter((line) => !line.endsWith("] "))
    : [];
  const ocr = Array.isArray(result?.ocrResults)
    ? result.ocrResults.filter((item) => Number(item?.confidence ?? 100) >= 65)
      .map((item) => `[${item?.time || "?"}] ${String(item?.text || item?.ocrText || "").trim()}`).filter((line) => !line.endsWith("] "))
    : [];
  const visual = result?.visualSemantics?.status === "available" ? {
    originAssessment: result.visualSemantics.originAssessment ?? null,
    reverseBlueprint: result.visualSemantics.reverseBlueprint ?? null,
    representativeFrames: Array.isArray(result.visualSemantics.items)
      ? result.visualSemantics.items.slice(0, 8).map((item) => ({
        shotSize: item?.shotSize, cameraAngle: item?.cameraAngle, composition: item?.composition,
        lighting: item?.lighting, subject: item?.subject, setting: item?.setting, evidence: item?.evidence,
      }))
      : [],
  } : null;
  const camera = result?.cameraMotion?.status === "available" ? result.cameraMotion.scenes : null;
  if (!transcript.length && !ocr.length && !visual) return null;
  const metadata = result?.metadata || {};
  const prompt = [
    "你是织台的视频复刻分析助手。只能根据下面的已观察信息作答，未知内容必须写 null，不得编造。",
    `媒体：时长 ${metadata.duration ?? "未知"} 秒，分辨率 ${metadata.width ?? "?"}×${metadata.height ?? "?"}，帧率 ${metadata.fps ?? "未知"}。`,
    "带时间码语音转写：",
    transcript.join("\n") || "（无）",
    "带时间码画面文字：",
    ocr.join("\n") || "（无）",
    "本地视觉模型的结构化观察（可能含英文，请校正并全部转成简体中文；不得补写未观察事实）：",
    visual ? JSON.stringify(visual) : "（无）",
    "本地光流运镜观察：",
    camera ? JSON.stringify(camera).slice(0, 5000) : "（无）",
    "请输出严格 JSON，字段为 summary、hook3s、copyStructure、voiceoverStyle、editingRhythm、reusableElements、propagationHypotheses、limitations、reverseBlueprint。",
    "类型必须固定：summary、hook3s、copyStructure、voiceoverStyle、editingRhythm、limitations 都是字符串；reusableElements 和 propagationHypotheses 都是字符串数组，不要返回对象。",
    "reverseBlueprint 必须包含 subjectDesign、environment、visualStyle、materialsTextures、lightingColor、cameraGrammar、motionPhysics、pacingEditing、audioStrategy、consistencyAnchors、negativeConstraints、universalPrompt、retain、replace；所有值用简体中文。",
    "propagationHypotheses 只能写内容潜力推测，不能写成爆火因果。",
  ].join("\n").slice(0, 14000);
  const response = await callYuanbaoChatDetailed(prompt, { timeoutMs });
  if (!response?.content) return null;
  const raw = response.content;
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
  try {
    const parsed = JSON.parse(cleaned);
    return { provider: response.provider, mode: `${response.mode}:extracted_multimodal_text`, ...parsed };
  } catch {
    return { provider: response.provider, mode: `${response.mode}:extracted_multimodal_text`, rawText: cleaned.slice(0, 6000) };
  }
}

/**
 * 组合分析：本地规则分析为必交付，元宝视角为增强(可用时追加)。
 * @returns {{ category: string, tags: string[], analysisMarkdown: string, reportMode: string }}
 */
export async function analyzeVideo(media, { yuanbaoEnabled = true } = {}) {
  const title = media.description || media.title || "";
  const category = classifyCategory(title, media.description || "", media.author || "");
  const tags = extractTags(`${title}\n${media.description || ""}\n${media.author || ""}`);
  let analysis = buildLocalAnalysis({
    title,
    description: media.description || "",
    author: media.author || "",
    stats: media.stats || {},
    category,
  });

  if (yuanbaoEnabled) {
    const prompt =
      "你是一个内容分析助手。请基于以下视频号内容信息，输出结构化中文分析：\n" +
      `标题/描述：${title || "（无）"}\n` +
      `作者：${media.author || "未知"}\n` +
      `互动数据：点赞 ${media.stats?.like ?? 0} 收藏 ${media.stats?.fav ?? 0} 转发 ${media.stats?.forward ?? 0} 评论 ${media.stats?.comment ?? 0}\n` +
      "请输出：\n1) 一句话内容摘要\n2) 3-5 个关键要点\n3) 这条内容最适合如何复用（结合「适老化装修」或「AI 技能」背景给出具体建议）";
    const yuanbao = await callYuanbaoChat(prompt).catch(() => null);
    if (yuanbao) {
      analysis +=
        "\n\n## 八、元宝视角（仅文本元数据）\n\n" +
        yuanbao +
        "\n\n_（以上由元宝网页对话接口生成；若显示此段说明当前 cookie 具备对话权限。）_\n";
    }
  }

  return { category, tags, analysisMarkdown: analysis, reportMode: "metadata_only" };
}
