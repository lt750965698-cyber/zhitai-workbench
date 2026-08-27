import { remediateToOriginalWorkflow } from "./originality-remediation.mjs";

const MIN_TOTAL_SECONDS = 10;
const MAX_TOTAL_SECONDS = 45;
const MIN_SHOT_SECONDS = 4;
const MAX_SHOT_SECONDS = 10;
const DOUBAO_GENERATION_SECONDS = 10;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizedRate(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return clamp(n > 1 ? n / 100 : n, 0, 1);
}

/**
 * 时长只做可解释的建议，不再机械固定 30 秒。优先使用真实平均观看时长/完播率，
 * 没有平台表现数据时才按原片长度收敛；调用方可显式指定目标覆盖建议。
 */
export function recommendTargetDuration({
  targetDurationSeconds,
  sourceDurationSeconds,
  averageWatchSeconds,
  completionRate,
  platform,
} = {}) {
  const requested = Number(targetDurationSeconds);
  const source = Number(sourceDurationSeconds);
  const averageWatch = Number(averageWatchSeconds);
  const rate = normalizedRate(completionRate);
  const signalsUsed = [];
  const missingSignals = [];
  let target;

  if (Number.isFinite(requested) && requested > 0) {
    target = requested;
    signalsUsed.push("人工指定时长");
  } else if (Number.isFinite(averageWatch) && averageWatch > 0) {
    target = Math.round(averageWatch * 1.25);
    signalsUsed.push("平均观看时长");
  } else if (Number.isFinite(source) && source > 0) {
    target = source <= 12 ? 10 : source <= 20 ? Math.round(source) : source <= 45 ? 20 : source <= 90 ? 25 : 30;
    signalsUsed.push("原片时长");
    missingSignals.push("平均观看时长");
  } else {
    target = 20;
    signalsUsed.push("短视频保守默认值");
    missingSignals.push("原片时长", "平均观看时长");
  }

  if (rate != null) {
    if (rate < 0.25) target -= 5;
    else if (rate < 0.4) target -= 2;
    else if (rate >= 0.65) target += 5;
    signalsUsed.push("完播率");
  } else {
    missingSignals.push("完播率");
  }

  const normalizedPlatform = text(platform).toLowerCase();
  if (normalizedPlatform) signalsUsed.push(`平台：${normalizedPlatform}`);
  else missingSignals.push("目标平台");

  target = clamp(Math.round(target), MIN_TOTAL_SECONDS, MAX_TOTAL_SECONDS);
  if (Number.isFinite(source) && source > 0 && !Number.isFinite(requested)) {
    target = Math.min(target, Math.max(MIN_TOTAL_SECONDS, Math.round(source)));
  }
  return {
    targetDurationSeconds: target,
    signalsUsed,
    missingSignals: [...new Set(missingSignals)],
    rationale: signalsUsed.includes("平均观看时长")
      ? "以真实平均观看时长为主，结合完播率调整"
      : signalsUsed.includes("原片时长")
        ? "暂无留存数据，先按原片信息密度生成较短版本"
        : "暂无表现数据，先生成可快速验收的短版本",
  };
}

function text(value, fallback = "") {
  const cleaned = String(value ?? "").replace(/\s+/g, " ").trim();
  return cleaned || fallback;
}

function shortText(value, max = 90) {
  const cleaned = normalizeNarration(value);
  return cleaned.length > max ? `${cleaned.slice(0, max - 1)}…` : cleaned;
}

export function normalizeNarration(value) {
  return text(value)
    .replace(/[\u200b-\u200d\ufeff]/g, "")
    .replace(/\s+([，。！？；：,.!?;:])/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

function chooseShots(sourceShots, count) {
  const rows = Array.isArray(sourceShots) ? sourceShots.filter(Boolean) : [];
  if (!rows.length) return Array.from({ length: count }, () => ({}));
  if (count === 1) return [rows[0]];
  // 只按视频真实时间轴均匀抽取，绝不再用“装修/户型/家具”等行业关键词挑镜头。
  return Array.from({ length: count }, (_, index) => {
    const sourceIndex = Math.round((index * (rows.length - 1)) / (count - 1));
    return rows[sourceIndex] || rows[0];
  });
}

function allocateDurations(totalSeconds, count) {
  const base = Math.floor(totalSeconds / count);
  let remainder = totalSeconds - base * count;
  return Array.from({ length: count }, () => {
    const duration = clamp(base + (remainder > 0 ? 1 : 0), MIN_SHOT_SECONDS, MAX_SHOT_SECONDS);
    remainder -= remainder > 0 ? 1 : 0;
    return duration;
  });
}

function roleFor(index, count) {
  if (index === 0) return "前三秒钩子";
  if (index === count - 1) return "结果与行动引导";
  const bodyRoles = ["背景与冲突", "核心过程", "关键细节", "变化与证明", "情绪或功能亮点"];
  return bodyRoles[(index - 1) % bodyRoles.length];
}

function motionFor(source, index) {
  const observed = text(source?.cameraMovement);
  if (observed && !/unknown|未确认|未知/i.test(observed)) return `复现已观察到的镜头运动：${observed}`;
  return index === 0
    ? "镜头先稳定建立主体，再做轻微、连贯的运动；运动方向必须与首帧透视一致"
    : "镜头运动幅度克制并与相邻分镜连续；没有可靠依据时保持稳定，不擅自环绕或突然变焦";
}

function translateShotSize(value, fallback) {
  const names = { extreme_wide: "大远景", wide: "广景", full: "全景", wide_or_full: "广角全景", medium_full: "中全景", medium: "中景", medium_close_up: "中近景", close_up: "细节特写", extreme_close_up: "极近景" };
  return names[value] || text(value, fallback);
}

function translateAngle(value, fallback) {
  const names = { eye_level: "正常人眼高度平视", high_angle: "轻微俯拍", low_angle: "轻微仰拍", top_down: "正俯拍", dutch_tilt: "荷兰角", level: "正常人眼高度平视", high: "轻微俯拍", low: "轻微仰拍" };
  return names[value] || text(value, fallback);
}

function narrationFor(role, topic, observed, blueprint) {
  if (observed) return observed;
  const subject = shortText(blueprint?.subjectDesign, 70) || topic;
  if (role === "前三秒钩子") return `无画外配音；用“${subject}”最有辨识度的动作或变化直接建立视觉钩子。`;
  if (role === "结果与行动引导") return `无画外配音；用“${subject}”的结果状态收束，并为循环播放保留自然衔接。`;
  return `无画外配音；本镜头围绕“${subject}”呈现${role}，不虚构原片没有的信息。`;
}

function consistencyPrompt(blueprint) {
  const anchors = Array.isArray(blueprint?.consistencyAnchors) ? blueprint.consistencyAnchors.filter(Boolean).join("；") : "";
  return `保持同一主体身份、数量、比例、材质、色彩、光向和环境连续；${anchors ? `连续性锚点：${anchors}；` : ""}接触、遮挡、重力与支撑关系符合原片可见规律。`;
}

function sourceOriginType(value) {
  const type = typeof value === "string" ? value : value?.type;
  return ["ai_generated", "live_action", "mixed", "unknown"].includes(type) ? type : "unknown";
}

function blueprintText(blueprint, key, fallback = "") {
  return text(blueprint && typeof blueprint === "object" ? blueprint[key] : "", fallback);
}

function aiImagePrompt({ topic, role, narration, shotSize, cameraAngle, source, blueprint }) {
  const anchors = Array.isArray(blueprint?.consistencyAnchors) ? blueprint.consistencyAnchors.filter(Boolean).join("；") : "";
  const negatives = Array.isArray(blueprint?.negativeConstraints) ? blueprint.negativeConstraints.filter(Boolean).join("；") : "文字、Logo、水印、闪烁、融化、穿模、重复物体";
  const observed = [source?.subject, source?.setting, source?.composition, source?.lighting].map((value) => shortText(value, 80)).filter(Boolean).join("；");
  const external = shortText(blueprint?.externalEnhancedPrompt, 500);
  return [
    `为竖屏短视频《${topic}》生成一个“${role}”分镜的全新首帧，不复制原人物脸、品牌、文字或专有角色。`,
    `本镜头表达：${narration}；已观察画面证据：${observed || "本镜头语义证据不足，只使用整片反推蓝图"}。`,
    `主体设计：${blueprintText(blueprint, "subjectDesign", source?.subject || "换成用户自己的新主体")}；环境：${blueprintText(blueprint, "environment", source?.setting || "保留参考空间关系但替换具体场景")}。`,
    `视觉风格：${blueprintText(blueprint, "visualStyle", "沿用参考片的可迁移美术语言")}；材质：${blueprintText(blueprint, "materialsTextures", "材质连续且可辨")}；光色：${blueprintText(blueprint, "lightingColor", "光向、色温连续")}。`,
    `镜头：${shotSize}，${cameraAngle}，9:16 竖构图。连续性锚点：${anchors || "主体外观、尺度、材质、色温和光向保持一致"}。`,
    external ? `外站关键帧只作视觉细节补充，不覆盖本镜头的时间位置和本地运镜证据：${external}` : "",
    `只生成干净画面；禁止：${negatives}；下方留出安全字幕区。`,
  ].filter(Boolean).join("\n");
}

/** 生成前硬门：提示词缺失、明显 ASR 错词或场景模板冲突时停止自动操作。 */
export function assessGenerationReadiness(workflow = {}) {
  const shots = Array.isArray(workflow?.shots) ? workflow.shots : [];
  const blockers = [];
  const warnings = [];
  if (!shots.length) blockers.push("没有可执行的 GPT/Seedance 分镜");
  shots.forEach((shot, index) => {
    const imagePrompt = text(shot?.gptImagePrompt || shot?.imagePrompt);
    const videoPrompt = text(shot?.seedancePrompt || shot?.videoPrompt);
    const narration = normalizeNarration(shot?.narration);
    if (!imagePrompt) blockers.push(`分镜 ${index + 1} 缺少 GPT 生图提示词`);
    if (!videoPrompt) blockers.push(`分镜 ${index + 1} 缺少豆包视频提示词`);
    if (!narration) warnings.push(`分镜 ${index + 1} 没有可用配音；将按无配音视觉镜头生成`);
    const promptText = `${imagePrompt} ${videoPrompt}`;
    const evidenceText = `${shot?.observedReference?.subject || ""} ${shot?.observedReference?.setting || ""} ${shot?.observedReference?.evidence || ""}`;
    const unsupportedTemplate = [
      { prompt: /一家四口|榻榻米|两居|三居/, evidence: /一家四口|榻榻米|两居|三居/ },
      { prompt: /家具数量|户型结构|中国城市住宅室内|客厅|卧室/, evidence: /家具|户型|住宅|室内|客厅|卧室|房间|书房|床|书桌|储物|装修/ },
      { prompt: /农村宅基地|落地柱梁|半架空|施工现场/, evidence: /农村|宅基地|柱梁|半架空|施工|工地/ },
    ].some((group) => group.prompt.test(promptText) && !group.evidence.test(evidenceText));
    if (unsupportedTemplate) blockers.push(`分镜 ${index + 1} 含有来源证据不支持的行业模板内容`);
    if (!shot?.observedReference?.evidence) warnings.push(`分镜 ${index + 1} 缺少可核对的画面依据`);
  });
  const missingSignals = Array.isArray(workflow?.durationStrategy?.missingSignals) ? workflow.durationStrategy.missingSignals : [];
  if (missingSignals.length) warnings.push(`时长仍缺少：${missingSignals.join("、")}`);
  if (["ai_generated", "mixed"].includes(workflow?.sourceOrigin?.type) && !workflow?.reverseBlueprintReady) {
    blockers.push("AI/混合素材缺少反推蓝图，不能盲目套用实拍模板");
  }
  return {
    ready: blockers.length === 0,
    status: blockers.length ? "blocked" : "ready",
    blockers: [...new Set(blockers)],
    warnings: [...new Set(warnings)],
  };
}

/**
 * 生成“GPT 首帧图 → 豆包 Seedance 2.0 单镜头 → 后期拼接”的可执行工作流。
 * 这里仅使用已经观察到的分镜/转写，不把未知的机位、光线或效果当事实。
 */
export function buildSeedanceWorkflow({
  title,
  sourceShots,
  hook,
  cta,
  targetDurationSeconds,
  sourceDurationSeconds,
  averageWatchSeconds,
  completionRate,
  platform,
  sourceOrigin,
  sourceRights,
  reverseBlueprint,
  sourceVideoAvailable = false,
} = {}) {
  const durationStrategy = recommendTargetDuration({
    targetDurationSeconds,
    sourceDurationSeconds,
    averageWatchSeconds,
    completionRate,
    platform,
  });
  const target = durationStrategy.targetDurationSeconds;
  const count = clamp(Math.ceil(target / DOUBAO_GENERATION_SECONDS), 1, 5);
  const durations = allocateDurations(target, count);
  const selected = chooseShots(sourceShots, count);
  const originType = sourceOriginType(sourceOrigin);
  const isAiReference = originType === "ai_generated" || originType === "mixed";
  let topic = text(title, "竖屏内容复刻").replace(/[（(]\s*修正\s*[）)]/g, "").trim();
  if (isAiReference && /^(?:生成|制作).{0,12}视频$|^未命名|^竖屏内容复刻/.test(topic)) {
    topic = shortText(reverseBlueprint?.subjectDesign, 54)
      .replace(/^(?:图片|画面)(?:展示|描绘|显示)(?:了)?(?:一个)?/, "")
      .replace(/[。；;]$/, "") || topic;
  }
  const reverseBlueprintReady = !isAiReference || Boolean(text(reverseBlueprint?.universalPrompt) && (text(reverseBlueprint?.visualStyle) || text(reverseBlueprint?.subjectDesign)));

  const shots = selected.map((source, index) => {
    const role = roleFor(index, count);
    const durationSeconds = durations[index];
    const generationDurationSeconds = DOUBAO_GENERATION_SECONDS;
    const observedNarration = shortText(
      index === 0 ? (hook || source?.narration || source?.onScreenText)
        : index === count - 1 ? (cta || source?.narration || source?.onScreenText)
          : (source?.narration || source?.onScreenText),
      100,
    );
    const narration = narrationFor(role, topic, observedNarration, reverseBlueprint);
    const subject = shortText(source?.subject, 100) || shortText(reverseBlueprint?.subjectDesign, 100) || `${topic}对应的主体`;
    const setting = shortText(source?.setting, 100) || shortText(reverseBlueprint?.environment, 100) || "与原片可见证据一致的环境";
    const shotSize = translateShotSize(source?.shotSize, index === 0 ? "中广景" : "中景与细节特写");
    const cameraAngle = translateAngle(source?.cameraAngle, "正常人眼高度平视");
    const lighting = text(source?.lighting, reverseBlueprint?.lightingColor || "沿用参考素材可见的光向、色温与曝光关系");
    const motion = motionFor(source, index);
    const sourceStart = Number.isFinite(Number(source?.startSeconds)) ? Number(source.startSeconds) : null;
    const sourceEnd = Number.isFinite(Number(source?.endSeconds)) ? Number(source.endSeconds) : null;

    const gptImagePrompt = isAiReference ? aiImagePrompt({ topic, role, narration, shotSize, cameraAngle, source, blueprint: reverseBlueprint }) : [
      `为竖屏短视频《${topic}》生成第 ${index + 1} 个分镜的首帧参考图，角色：${role}。`,
      `画面内容：${subject}；场景：${setting}；本镜头表达：${narration}。`,
      `镜头：${shotSize}，${cameraAngle}，9:16 竖构图；光线：${lighting}。`,
      `风格依据：${blueprintText(reverseBlueprint, "visualStyle", "保持参考素材可见的媒介与美术风格；证据不足时使用中性写实影像")}。`,
      consistencyPrompt(reverseBlueprint),
      "只生成干净画面：不要文字、字幕、数字、品牌标志、水印、边框；不要重复物体、悬空、穿模或不合理透视；下方留出安全字幕区。",
    ].join("\n");

    const seedancePrompt = [
      `以 @图片1 为首帧参考，生成 ${generationDurationSeconds} 秒、9:16 竖屏、写实风格的视频镜头；后期从中选取最稳定的 ${durationSeconds} 秒进入成片。`,
      consistencyPrompt(reverseBlueprint),
      `镜头运动：${motion}。动作自然克制，空间直线稳定，首尾画面可用于和相邻镜头顺滑拼接。`,
      `叙事目的：${role}；画外配音将表达“${narration}”，画面只负责提供对应视觉证据。`,
      "不在视频内生成对白、字幕、文字、Logo 或水印；不要快速甩镜、镜头抖动、闪烁、跳帧、物体融化、穿模、形体漂移和不自然变焦。保留轻微真实环境声，配音和音乐后期统一加入。",
    ].join("\n");
    const referenceVideoPrompt = isAiReference ? [
      `如果当前豆包模型支持“全能参考/参考视频”，上传原视频为 @视频1、上面的 GPT 新首帧为 @图片1，生成 ${generationDurationSeconds} 秒 9:16 竖屏镜头。`,
      text(reverseBlueprint?.referenceVideoPrompt, "只参考 @视频1 的运镜、动作轨迹、主体调度、景别变化、切镜时点和物理效果；不要复制人物脸、品牌、字幕、水印或专有角色。"),
      `本分镜叙事：${narration}。后期只选取最稳定的 ${durationSeconds} 秒。`,
    ].join("\n") : null;

    return {
      index: index + 1,
      role,
      durationSeconds,
      generationDurationSeconds,
      sourceStartSeconds: sourceStart,
      sourceEndSeconds: sourceEnd,
      narration,
      observedNarration: observedNarration || null,
      observedReference: {
        subject: source?.subject ?? null,
        setting: source?.setting ?? null,
        shotSize: source?.shotSize ?? null,
        cameraAngle: source?.cameraAngle ?? null,
        lighting: source?.lighting ?? null,
        evidence: source?.evidence ?? null,
      },
      gptImagePrompt,
      seedancePrompt,
      referenceVideoPrompt,
      negativePrompt: "文字、水印、Logo、闪烁、跳帧、形体漂移、穿模、畸变、重复物体、结构改变、突然变焦、快速甩镜",
      imageStatus: "待在 GPT 生成",
      videoStatus: "待在豆包 Seedance 2.0 生成",
    };
  });

  const workflow = {
    schemaVersion: 3,
    status: "prepared",
    mode: isAiReference ? "ai_reverse" : originType === "live_action" ? "live_action_remake" : "standard_remake",
    sourceOrigin: typeof sourceOrigin === "object" && sourceOrigin ? sourceOrigin : { type: originType },
    sourceRights: typeof sourceRights === "object" && sourceRights
      ? sourceRights
      : { status: typeof sourceRights === "string" ? sourceRights : "unverified" },
    reverseBlueprintReady,
    referenceVideoPreferred: isAiReference && sourceVideoAvailable,
    workflow: isAiReference ? "Local reverse blueprint → GPT new subject frame → Doubao reference video when available (2.0 fallback) → assemble" : "GPT Image → Doubao Seedance 2.0 → assemble",
    providerOrder: ["GPT Image", "豆包 Seedance 2.0"],
    targetDurationSeconds: shots.reduce((sum, shot) => sum + shot.durationSeconds, 0),
    aspectRatio: "9:16",
    shotCount: shots.length,
    shotDurationRangeSeconds: [MIN_SHOT_SECONDS, MAX_SHOT_SECONDS],
    generationClipSeconds: DOUBAO_GENERATION_SECONDS,
    durationStrategy,
    qualityGate: "单镜头先验收人物/空间一致性与运动稳定性；不合格只重做该镜头；全部通过后再拼接成片",
    manualBoundary: isAiReference
      ? "织台已准备参考视频提示词；只有豆包页面明确显示全能参考/参考视频能力时才使用原视频。当前账号若只有 Seedance 2.0，则自动退回 GPT 首帧逐镜生成，不伪装参考视频已生效。"
      : "当前复用已登录的 GPT 与豆包免费界面；豆包每镜统一生成 10 秒，织台按建议时长裁取并拼接。首次需登录，免费次数和排队状态以豆包页面实时显示为准。",
    assembly: {
      order: "按分镜序号拼接",
      transition: "以动作/视线匹配硬切为主，必要时使用 4–6 帧叠化",
      voiceover: "全部单镜头通过后统一录制或合成配音，避免 Seedance 分镜间声音不一致",
      subtitles: "使用知识库 subtitles.srt 校对后统一烧录，避免模型生成乱码字",
      music: "最后统一添加轻量 BGM，并确保人声清晰",
      publishReadyChecks: ["目标时长有原片或表现数据依据", "前 3 秒信息明确", "所有镜头无水印/乱码/形变", "9:16 画幅", "字幕与配音同步", "人工完整观看一次"],
    },
    shots,
  };
  const recovery = remediateToOriginalWorkflow(workflow, { title: topic, sourceRights });
  recovery.workflow.generationReadiness = assessGenerationReadiness(recovery.workflow);
  return recovery.workflow;
}
