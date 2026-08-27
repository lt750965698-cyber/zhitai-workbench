const VALID_ORIGINS = new Set(["ai_generated", "live_action", "mixed", "unknown"]);

function text(value, fallback = "") {
  const cleaned = String(value ?? "").replace(/\s+/g, " ").trim();
  return cleaned || fallback;
}

function list(value, limit = 12) {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(/[；;。\n]/) : [];
  return [...new Set(values.map((item) => text(item)).filter(Boolean))].slice(0, limit);
}

function originOf(raw = {}, sourceTitle = "") {
  let type = VALID_ORIGINS.has(raw?.type) ? raw.type : "unknown";
  let confidence = Math.max(0, Math.min(1, Number(raw?.confidence) || 0));
  const rawEvidence = list(raw?.evidence, 8);
  const title = text(sourceTitle);
  const titleDeclaresGeneration = /(?:^|[（(\s])(?:AI|AIGC|Seedance|MiniMax\s*H3|Grok\s*Imagine|可灵|即梦|豆包).{0,20}(?:生成|效果|视频)|^生成(?:指定|的|一条|视频)|AI生成/i.test(title);
  const diagnosticEvidence = rawEvidence.filter((line) => /生成|合成|AI|不连续|形变|畸变|融化|穿模|重复|纹理异常|几何异常|物理异常|光影矛盾|synthetic|generated|inconsisten|deform|artifact|impossible|temporal/i.test(line));
  const uncertainties = list(raw?.uncertainties, 8);
  if ((type === "ai_generated" || type === "mixed") && !titleDeclaresGeneration && !diagnosticEvidence.length) {
    type = "unknown";
    confidence = Math.min(confidence, 0.35);
    uncertainties.unshift("模型没有给出可核对的 AI 生成痕迹，已自动降为未确认");
  }
  const evidence = titleDeclaresGeneration
    ? list([`来源标题明确标注生成内容：${title}`, ...diagnosticEvidence], 8)
    : diagnosticEvidence.length ? diagnosticEvidence : rawEvidence;
  return {
    type,
    label: type === "ai_generated" ? "AI 生成" : type === "live_action" ? "实拍" : type === "mixed" ? "AI + 实拍混合" : "未确认",
    confidence,
    evidence,
    uncertainties: list(uncertainties, 8),
    limitation: "仅根据画面可见特征判断；没有原始工程或生成元数据时，不能确认具体模型。",
  };
}

function shotDigest(shots = []) {
  return shots.slice(0, 10).map((shot, index) => {
    const range = `${Number.isFinite(Number(shot?.startSeconds)) ? Number(shot.startSeconds).toFixed(1) : "?"}–${Number.isFinite(Number(shot?.endSeconds)) ? Number(shot.endSeconds).toFixed(1) : "?"}s`;
    const description = [shot?.subject, shot?.setting, shot?.shotSize, shot?.cameraAngle, shot?.cameraMovement, shot?.composition, shot?.lighting].map((item) => text(item)).filter(Boolean).join("；");
    return `${index + 1}. ${range}：${description || "画面语义待确认"}`;
  });
}

/** 把本地视觉、真实切镜、光流与音频结果合成可迁移的反推蓝图；未知项明确保留未知。 */
export function buildVideoReverseBlueprint(result = {}, shotPlan = []) {
  const visual = result?.visualSemantics && typeof result.visualSemantics === "object" ? result.visualSemantics : {};
  const localRaw = visual?.reverseBlueprint && typeof visual.reverseBlueprint === "object" ? visual.reverseBlueprint : {};
  const yuanbaoRaw = result?.yuanbaoInsight?.reverseBlueprint && typeof result.yuanbaoInsight.reverseBlueprint === "object" ? result.yuanbaoInsight.reverseBlueprint : {};
  const raw = { ...localRaw, ...Object.fromEntries(Object.entries(yuanbaoRaw).filter(([, value]) => value != null && value !== "")) };
  const originAssessment = originOf(result?.yuanbaoInsight?.originAssessment || visual?.originAssessment || {}, result?.sourceTitle || result?.metadata?.title);
  const cameraRows = Array.isArray(result?.cameraMotion?.scenes) ? result.cameraMotion.scenes : [];
  const motions = list(cameraRows.map((row) => row?.movement).filter((value) => value && value !== "unknown"), 8);
  const audio = result?.audioAnalysis?.status === "available" ? result.audioAnalysis : null;
  const transcript = list((Array.isArray(result?.transcript) ? result.transcript : []).map((row) => row?.text), 12);
  const ocr = list((Array.isArray(result?.ocrResults) ? result.ocrResults : []).map((row) => row?.text || row?.ocrText), 12);
  const referencePreferred = originAssessment.type === "ai_generated" || originAssessment.type === "mixed";
  const strategy = referencePreferred ? "reference_video_preferred" : originAssessment.type === "live_action" ? "shot_reconstruction" : "manual_review_then_reconstruct";
  const retain = list([
    ...list(raw?.retain),
    "镜头先后顺序与信息密度",
    ...(motions.length ? [`已观察运镜：${motions.join("、")}`] : []),
    "主体在画面中的相对位置与动作节奏",
  ], 10);
  const replace = list([
    ...list(raw?.replace),
    "人物脸、品牌、Logo、字幕和水印",
    "原作品的专有角色或不可授权素材",
    "换成自己的主题、主体外观与发布文案",
  ], 10);
  const negativeConstraints = list([
    ...list(raw?.negativeConstraints).filter((item) => !/没有描绘|没有显示|无法识别|未识别|不清楚/.test(item)),
    "文字乱码、Logo、水印",
    "人物或物体闪烁、融化、穿模、重复",
    "空间关系突变、动作违反重力、无支撑悬空",
    "擅自复制原人物脸或专有角色",
  ], 14);
  const consistencyAnchors = list([
    ...list(raw?.consistencyAnchors),
    text(raw?.subjectDesign), text(raw?.environment), text(raw?.materialsTextures), text(raw?.lightingColor),
  ], 12);
  const observedShots = shotDigest(shotPlan);
  const universalPrompt = text(raw?.universalPrompt) || [
    `创作一条 9:16 竖屏短视频。视觉风格：${text(raw?.visualStyle, "按参考画面保持一致，风格待确认")}。`,
    `主体与环境：${text(raw?.subjectDesign, "使用新的自有主体")}; ${text(raw?.environment, "沿用参考的空间关系但替换具体场景")}。`,
    `材质与光线：${text(raw?.materialsTextures, "保持材质稳定")}; ${text(raw?.lightingColor, "保持光向和色温连续")}。`,
    `镜头与节奏：${text(raw?.cameraGrammar, motions.length ? motions.join("、") : "按分镜表执行")}；${text(raw?.pacingEditing, "按真实切镜和信息密度执行")}。`,
    `运动与物理：${text(raw?.motionPhysics, "动作自然，接触、重力、支撑和遮挡符合真实物理规律")}。`,
    `保持：${retain.join("；")}。替换：${replace.join("；")}。禁止：${negativeConstraints.join("；")}。`,
  ].join("\n");
  const referenceVideoPrompt = [
    "使用 @视频1 作为运动与镜头参考，使用 @图片1 作为新的主体/首帧参考。",
    `只参考 @视频1 的运镜、动作轨迹、主体调度、景别变化、切镜时点和物理效果；保持：${retain.join("；")}。`,
    `必须替换：${replace.join("；")}。不要复制原人物脸、品牌、字幕、水印或专有角色。`,
    text(raw?.universalPrompt, universalPrompt),
    `负面约束：${negativeConstraints.join("；")}。`,
  ].join("\n");
  const viralEvidence = {
    available: Boolean(result?.performanceEvidence || result?.performance),
    note: "只有来源提供播放、完播率、平均观看时长或互动快照时才可判断表现；画面分析本身不能证明‘为什么火’。",
  };
  return {
    schemaVersion: 1,
    status: visual?.status === "available" ? "available" : "partial",
    languageProvider: Object.keys(yuanbaoRaw).length ? "元宝已登录网页实时签名增强（本地视觉结果转中文，不上传视频）" : "本地 Qwen 视觉结果",
    originAssessment,
    productionStrategy: {
      mode: strategy,
      referenceVideoPreferred: referencePreferred,
      primary: referencePreferred ? "Seedance 全能参考：原视频只作为动作/运镜参考，GPT 图替换主体" : "按真实分镜重建 GPT 首帧，再逐镜生成",
      fallback: "当前豆包账号若只有 Seedance 2.0，则使用 GPT 首帧 + 逐镜文字提示词，不假装已经上传参考视频。",
    },
    subjectDesign: text(raw?.subjectDesign) || null,
    environment: text(raw?.environment) || null,
    visualStyle: text(raw?.visualStyle) || null,
    materialsTextures: text(raw?.materialsTextures) || null,
    lightingColor: text(raw?.lightingColor) || null,
    cameraGrammar: text(raw?.cameraGrammar, motions.length ? motions.join("、") : "需结合运镜分析"),
    motionPhysics: text(raw?.motionPhysics, "需结合光流与逐镜人工复核"),
    pacingEditing: text(raw?.pacingEditing, observedShots.length ? `按 ${observedShots.length} 个真实/回退镜头复刻节奏` : "切镜节奏待确认"),
    audioStrategy: text(raw?.audioStrategy, audio ? "参考已分离的人声节奏与伴奏特征，文案与声音换成自有内容" : "音频分析不可用，配音和音乐需另行设计"),
    consistencyAnchors,
    negativeConstraints,
    retain,
    replace,
    universalPrompt,
    referenceVideoPrompt,
    observedShots,
    sourceEvidence: { transcript, ocr, cameraMotions: motions },
    viralEvidence,
    externalFallbacks: [
      { name: "NanoPhoto 视频反推提示词", url: "https://nanophoto.ai/zh/video-reverse-prompt", access: "网页免费；API 计费", note: "外部上传前先确认素材隐私" },
      { name: "VideoToPrompt", url: "https://videotoprompt.com/", access: "网页标称免费、无需注册", note: "限制 50MB；外部上传前先确认素材隐私" },
      { name: "VideoFlow", url: "https://videoflow.cc/zh/landing", access: "30 秒试用", note: "适合对照，不作为织台主流程" },
    ],
  };
}
