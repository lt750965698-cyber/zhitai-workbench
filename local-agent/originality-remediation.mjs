const CONFIRMED_RIGHTS = new Set(["owned", "licensed", "public_domain", "commissioned", "confirmed"]);
const STRICT_POLICY = "strict_full_original";

const REASON_LABELS = {
  source_rights_unverified: "来源素材权利状态未确认",
  narration_is_analysis: "配音文案是分析说明，不是面向观众的原创旁白",
  narration_theme_mismatch: "配音文案与画面主题不匹配",
};

const GENERIC_PRESENTATION_SUBJECT = /拍摄对象|站着并说话|人物.{0,10}(?:说话|站立)|对应的主体|画面中的主体|这个主题/iu;
const LEGACY_GENERIC_NARRATION = /更清楚耐看|突出(?:一个)?核心细节|效果才更完整/iu;

function text(value, fallback = "") {
  const cleaned = String(value ?? "").replace(/[\u200b-\u200d\ufeff]/g, "").replace(/\s+/g, " ").trim();
  return cleaned || fallback;
}

function unique(values, limit = 20) {
  return [...new Set(values.map((value) => text(value)).filter(Boolean))].slice(0, limit);
}

function clone(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function rightsStatus(workflow, sourceRights) {
  const value = sourceRights && typeof sourceRights === "object" ? sourceRights : workflow?.sourceRights;
  return text(typeof value === "string" ? value : value?.status, "unverified").toLowerCase();
}

function isAnalysisNarration(value) {
  const narration = text(value);
  if (!narration) return false;
  return /视频前\s*\d+\s*秒|\d+:\d{2}|听觉钩子|视觉冲击|叙事支撑|抓取用户注意|画外音.{0,20}(重复|出现)|(?:ASR|OCR|转写|分析结果|本镜头).{0,20}(显示|表明|说明)|试图在.{0,20}(抓住|抓取|吸引)|但缺乏.{0,30}(画面|视觉|叙事)/iu.test(narration);
}

function meaningfulCharacters(value) {
  const ignored = new Set("的了和与在是把用为从到这那一个本期视频画面镜头内容展示通过进行可以我们你我它其更最很也都中上下来".split(""));
  return new Set((text(value).toLowerCase().match(/[\p{Script=Han}a-z0-9]/gu) || []).filter((char) => !ignored.has(char)));
}

function hasThemeOverlap(narration, theme) {
  const a = meaningfulCharacters(narration);
  const b = meaningfulCharacters(theme);
  if (!a.size || !b.size) return true;
  let overlap = 0;
  for (const char of a) if (b.has(char)) overlap += 1;
  return overlap >= Math.min(2, a.size);
}

function shotTheme(shot) {
  return [
    shot?.observedReference?.subject,
    shot?.observedReference?.setting,
    shot?.originalDesignReference?.subject,
    shot?.originalDesignReference?.setting,
  ].map((value) => text(value)).filter(Boolean).join("；");
}

/**
 * 只根据已有文本元数据做保守判定；这里不声称识别了法律意义上的侵权。
 * 权利未确认时，策略是转入完全原创生成，不上传或复用来源媒体。
 */
export function assessOriginalityRisks(workflow = {}, { title = "", sourceRights = null } = {}) {
  if (workflow?.originality?.policy === STRICT_POLICY && workflow?.originality?.status === "remediated") {
    const originalTitle = text(workflow?.originality?.originalTitle);
    const genericOriginal = GENERIC_PRESENTATION_SUBJECT.test(originalTitle)
      || GENERIC_PRESENTATION_SUBJECT.test(text(workflow?.originality?.originalVoiceover))
      || LEGACY_GENERIC_NARRATION.test(originalTitle)
      || LEGACY_GENERIC_NARRATION.test(text(workflow?.originality?.originalVoiceover))
      || originalTitle.length > 32
      || /我家|硬是|塞进|赞不绝口|美到窒息|年度必入|[+#]/iu.test(originalTitle)
      || (Array.isArray(workflow?.shots) && workflow.shots.some((shot) => (
        GENERIC_PRESENTATION_SUBJECT.test(text(shot?.narration))
        || LEGACY_GENERIC_NARRATION.test(text(shot?.narration))
      )));
    const topicDrift = hasRemediatedTopicDrift(workflow, title);
    if (genericOriginal || topicDrift) {
      return {
        requiresRecovery: true,
        rightsStatus: text(workflow.originality.sourceRightsStatus, "unverified"),
        reasons: ["narration_theme_mismatch"],
        reasonLabels: [REASON_LABELS.narration_theme_mismatch],
        alreadyRemediated: false,
      };
    }
    return {
      requiresRecovery: false,
      rightsStatus: text(workflow.originality.sourceRightsStatus, "unverified"),
      reasons: [],
      reasonLabels: [],
      alreadyRemediated: true,
    };
  }

  const reasons = [];
  const status = rightsStatus(workflow, sourceRights);
  if (!CONFIRMED_RIGHTS.has(status)) reasons.push("source_rights_unverified");

  const shots = Array.isArray(workflow?.shots) ? workflow.shots : [];
  let analysisNarration = false;
  let shortMismatch = false;
  for (const shot of shots) {
    const narration = text(shot?.narration);
    if (!narration) continue;
    if (isAnalysisNarration(narration)) analysisNarration = true;
    const compact = narration.replace(/[^\p{L}\p{N}]/gu, "");
    const theme = `${title} ${shotTheme(shot)}`;
    if (compact.length <= 8 && theme.trim() && !hasThemeOverlap(narration, theme)) shortMismatch = true;
  }
  if (analysisNarration) reasons.push("narration_is_analysis");
  if (shortMismatch) reasons.push("narration_theme_mismatch");

  const normalized = unique(reasons);
  return {
    requiresRecovery: normalized.length > 0,
    rightsStatus: status,
    reasons: normalized,
    reasonLabels: normalized.map((reason) => REASON_LABELS[reason] || reason),
    alreadyRemediated: false,
  };
}

function titleTopic(value) {
  const title = text(value).replace(/#[^#\s]+/gu, " ").replace(/\s+/g, " ").trim();
  const rules = [
    // 全屋/户型信号优先于房间词；“开放式厨房”可以只是小户型改造的一项手段。
    [/两房变三房|老破小|小户型(?:空间|全屋|户型)?改造|全屋.{0,8}改造|户型改造/iu, "小户型空间改造"],
    [/PU\s*线条|法式.{0,12}(?:墙|装修|装饰)|墙面装饰板/iu, "法式墙面装饰板"],
    [/儿童房/iu, "儿童房空间设计"],
    [/卫生间.{0,12}干区|干区.{0,12}隔断/iu, "卫生间干区收纳隔断"],
    [/卫生间|浴室|淋浴|马桶|洗漱/iu, "小户型卫生间布局"],
    [/厨房|橱柜|灶台|台面/iu, "厨房改造"],
    [/飘窗/iu, "小户型飘窗一体化设计"],
    [/小户型.{0,12}改造/iu, "小户型空间改造"],
    [/地下室|半架空|宅基地|自建房/iu, "自建房架空层设计"],
    [/阳台/iu, "阳台空间改造"],
  ];
  return rules.find(([pattern]) => pattern.test(title))?.[1] || "";
}

function remediatedTopicCandidates(workflow) {
  const shots = Array.isArray(workflow?.shots) ? workflow.shots : [];
  return unique([
    workflow?.originality?.originalTitle,
    ...shots.flatMap((shot) => [
      shot?.originalDesignReference?.subject,
      shot?.observedReference?.subject,
    ]),
  ].map((value) => titleTopic(value)).filter(Boolean));
}

function hasRemediatedTopicDrift(workflow, sourceTitle) {
  const expected = titleTopic(sourceTitle);
  if (!expected) return false;
  const candidates = remediatedTopicCandidates(workflow);
  return candidates.length > 0 && candidates.some((candidate) => candidate !== expected);
}

function safeSubject(workflow, title) {
  const topic = titleTopic(title);
  if (topic) return topic;
  const shots = Array.isArray(workflow?.shots) ? workflow.shots : [];
  const subjects = unique(shots.flatMap((shot) => [
    shot?.observedReference?.subject,
    shot?.originalDesignReference?.subject,
  ]), 3);
  let observed = subjects.join("、")
    .replace(/^正在/u, "")
    .replace(/装饰墙上的装饰板/u, "墙面装饰板")
    .replace(/[，。；;].*$/u, "")
    .slice(0, 34)
    .trim();
  if (/对应的主体$/u.test(observed)) observed = "";
  if (GENERIC_PRESENTATION_SUBJECT.test(observed)) observed = "";
  if (/^(?:未命名|竖屏内容复刻|生成(?:指定|一条|视频)|制作视频)/u.test(observed)) observed = "";
  if (observed) return observed;
  let cleanTitle = text(title)
    .replace(/#[^#\s]+/gu, " ")
    .replace(/(?:年度必入|必看|封神|绝绝子|美到窒息|震惊)[！!，,：:\s]*/gu, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 34);
  if (/^(?:未命名|竖屏内容复刻|生成(?:指定|一条|视频)|制作视频)/u.test(cleanTitle)) cleanTitle = "";
  return cleanTitle || "这个主题";
}

function safeSetting(workflow) {
  const shots = Array.isArray(workflow?.shots) ? workflow.shots : [];
  return unique(shots.flatMap((shot) => [
    shot?.observedReference?.setting,
    shot?.originalDesignReference?.setting,
  ]), 2).join("、").slice(0, 30) || "全新设计的中性环境";
}

function fitNarration(value, durationSeconds) {
  const max = Math.max(22, Math.min(72, Math.floor((Number(durationSeconds) || 10) * 4.2)));
  const clean = text(value);
  if (clean.length <= max) return clean;
  const slice = clean.slice(0, max + 1);
  const end = Math.max(slice.lastIndexOf("。"), slice.lastIndexOf("，"), slice.lastIndexOf("；"));
  const shortened = (end >= Math.floor(max * 0.6) ? clean.slice(0, end + 1) : clean.slice(0, max)).replace(/[，；：\s]+$/u, "");
  return /[。！？]$/u.test(shortened) ? shortened : `${shortened}。`;
}

function narrationSequence(subject) {
  const topic = titleTopic(subject);
  const sequences = {
    小户型空间改造: [
      "小户型空间改造先理顺动线和功能分区，再用沿墙收纳减少遮挡、保住采光。",
      "收纳沿墙集中，开放区减少遮挡，让走道顺畅、自然光能进入室内。",
      "最后用通透隔断和统一材质连接各区，面积不变也能住得宽松顺手。",
    ],
    小户型卫生间布局: [
      "小户型卫生间先排好洗漱、马桶、淋浴、泡澡四区动线，再用壁龛和侧柜收纳。",
      "壁龛收沐浴用品，洗手台侧柜收日常杂物，尽量把地面空间留出来。",
      "再用玻璃隔断控制水汽，干湿分开后，四个功能用起来都更顺手。",
    ],
    卫生间干区收纳隔断: [
      "卫生间干区先留出洗漱通道，再决定隔断位置，开门和通行互不打架。",
      "镜柜收小件，侧柜放囤货，台面只留常用品，洗漱区就不容易凌乱。",
      "半墙加玻璃既挡水汽又保留采光，干区独立后早晚使用也更从容。",
    ],
    厨房改造: [
      "厨房改造先按取、洗、切、炒的顺序安排台面，做饭少走冤枉路。",
      "常用厨具留在操作区，吊柜放低频物品，转角用抽拉收纳减少死角。",
      "照明补到水槽和备餐台，柜门与台面统一后，厨房更好清洁和使用。",
    ],
    儿童房空间设计: [
      "儿童房先按睡眠、学习和收纳分区，把中间活动空间完整留出来。",
      "床下做抽屉，书桌靠近自然光，常用物品放在孩子够得到的位置。",
      "家具贴墙并固定高柜，通道更宽，孩子长大后布局也容易调整。",
    ],
    法式墙面装饰板: [
      "法式墙面装饰板先定中心线和分格比例，让门窗两侧保持均衡。",
      "线条粗细只保留两档，转角和收口对齐，墙面层次才不会显乱。",
      "暖白墙面配柔和侧光，让线条有层次，同时避免装饰堆得太满。",
    ],
    小户型飘窗一体化设计: [
      "飘窗先和书桌或收纳柜连成一体，把窗边零散位置真正利用起来。",
      "抽屉放低频物品，开放格留给常用书，坐卧区保持足够的伸腿空间。",
      "台面高度和窗扇开启范围提前校准，采光、收纳和使用互不冲突。",
    ],
    阳台空间改造: [
      "阳台先确定晾晒、清洁和休闲的使用顺序，再安排水电与柜体。",
      "洗衣机和清洁用品集中一侧，另一侧留空，日常通行不会被打断。",
      "柜体避开窗户并选耐晒材质，采光保留下来，杂物也有固定去处。",
    ],
    自建房架空层设计: [
      "架空层先区分停车、储物和活动动线，避免不同功能互相占道。",
      "沿承重边界集中收纳，主要通道保持连续，雨天进出也更方便。",
      "再补足排水、通风和照明，半室外空间才能长期稳定使用。",
    ],
  };
  return sequences[topic] || [
    `${subject}先理顺使用顺序和主要动线，再决定各部分的位置。`,
    "常用功能放在顺手的位置，收纳集中到边角，减少来回绕行。",
    "最后统一材质和照明，让每个区域直接对应日常使用需求。",
  ];
}

function originalNarration(index, count, role, subject, setting, durationSeconds) {
  const sequence = narrationSequence(subject);
  const position = index === 0 ? 0 : index === count - 1 ? 2 : 1;
  return fitNarration(sequence[position], durationSeconds);
}

function originalTitle(subject) {
  const topic = titleTopic(subject);
  const titles = {
    小户型空间改造: "小户型空间改造：动线、采光与收纳布局",
    小户型卫生间布局: "小户型卫生间布局：四区动线与收纳",
    卫生间干区收纳隔断: "卫生间干区收纳隔断：动线与采光",
    厨房改造: "厨房改造：动线与收纳",
    儿童房空间设计: "儿童房空间设计：分区与成长型收纳",
    法式墙面装饰板: "法式墙面装饰板：分格与光线设计",
    小户型飘窗一体化设计: "小户型飘窗一体化设计：布局与收纳",
    阳台空间改造: "阳台空间改造：家务动线与收纳",
    自建房架空层设计: "自建房架空层设计：功能与动线",
  };
  if (subject === "这个主题") return "从使用顺序出发安排空间";
  return titles[topic] || `${subject}的布局与使用细节`;
}

function originalImagePrompt({ index, role, subject, setting, narration }) {
  return [
    `为一条完全原创的 9:16 竖屏短视频生成第 ${index} 个“${role}”首帧。`,
    `从空白画布重新设计“${subject}”；环境采用“${setting}”这一抽象主题，但具体主体外观、空间布局、构图、比例、纹样、配色和细节组合必须全新。`,
    `本镜头配音：${narration}；画面应提供直接、清晰的视觉对应。`,
    "不得上传、描摹或引用来源视频/来源关键帧；不得复制原人物脸、品牌、Logo、台词、字幕、水印、专有角色、产品独特外观或原作品构图。",
    "只输出干净画面，不生成文字、字幕、数字、边框；避免畸变、重复物体、悬空、穿模和不合理透视；下方保留安全字幕区。",
  ].join("\n");
}

function originalVideoPrompt({ role, durationSeconds, narration }) {
  return [
    `仅以本任务新生成的 @图片1 为视觉来源，生成 10 秒、9:16 竖屏原创视频镜头；后期选取最稳定的 ${durationSeconds} 秒。`,
    "不得上传或引用来源视频，不模仿来源人物、品牌、专有角色、原片构图、具体动作编排或剪辑节奏；运动、调度和细节变化均从当前原创首帧自然推导。",
    `叙事目的：${role}；后期原创配音为“${narration}”，模型画面内不生成对白、字幕、文字、Logo、水印或音乐。`,
    "镜头运动自然克制，重力、接触、遮挡与支撑关系合理；避免快速甩镜、抖动、闪烁、跳帧、融化、穿模、漂移和突然变焦。",
  ].join("\n");
}

/** 把可补救的版权/配音/主题风险转换为可继续执行的完全原创工作流。幂等。 */
export function remediateToOriginalWorkflow(workflow = {}, { title = "", sourceRights = null } = {}) {
  const assessment = assessOriginalityRisks(workflow, { title, sourceRights });
  if (!assessment.requiresRecovery) return { workflow, changed: false, assessment };

  const next = clone(workflow && typeof workflow === "object" ? workflow : {});
  const shots = Array.isArray(next.shots) ? next.shots : [];
  const subject = safeSubject(next, title);
  const setting = safeSetting(next);
  const rewritten = shots.map((shot, index) => {
    const role = text(shot?.role, index === 0 ? "前三秒钩子" : index === shots.length - 1 ? "结果与行动引导" : "核心过程");
    const durationSeconds = Math.max(1, Math.min(10, Number(shot?.durationSeconds) || 10));
    const narration = originalNarration(index, shots.length, role, subject, setting, durationSeconds);
    return {
      ...shot,
      narration,
      observedNarration: null,
      sourceStartSeconds: null,
      sourceEndSeconds: null,
      observedReference: {
        subject,
        setting,
        shotSize: null,
        cameraAngle: null,
        lighting: null,
        evidence: "来源只用于抽象主题识别；本分镜已转为完全原创设计，不复用来源表达",
      },
      originalDesignReference: { subject, setting },
      gptImagePrompt: originalImagePrompt({ index: Number(shot?.index) || index + 1, role, subject, setting, narration }),
      seedancePrompt: originalVideoPrompt({ role, durationSeconds, narration }),
      referenceVideoPrompt: null,
      negativePrompt: unique([
        ...(text(shot?.negativePrompt) ? text(shot.negativePrompt).split(/[；;]/u) : []),
        "来源视频或关键帧", "原人物脸", "品牌与 Logo", "专有角色", "原片台词", "原片音乐", "原作品构图照搬",
      ], 20).join("；"),
    };
  });

  next.schemaVersion = Math.max(4, Number(next.schemaVersion) || 0);
  next.status = "prepared";
  next.mode = "full_original_recovery";
  next.referenceVideoPreferred = false;
  next.workflow = "Original topic abstraction → GPT original frames → Doubao image-to-video without source video → original TTS → assemble";
  next.shots = rewritten;
  const remediationReasons = unique([
    ...((Array.isArray(next?.originality?.reasons) ? next.originality.reasons : [])),
    ...assessment.reasons,
  ]);
  next.originality = {
    policy: STRICT_POLICY,
    status: "remediated",
    sourceRightsStatus: assessment.rightsStatus,
    reasons: remediationReasons,
    reasonLabels: remediationReasons.map((reason) => REASON_LABELS[reason] || reason),
    actions: [
      "不上传、不引用来源视频或关键帧",
      "从空白画布生成全新主体、布局、构图、纹样、配色与动作",
      "删除来源台词、分析式旁白与来源音乐",
      "只使用本工作流生成的原创旁白和新合成配音",
    ],
    referenceVideoAllowed: false,
    sourceAudioAllowed: false,
    sourceMusicAllowed: false,
    originalVisualsRequired: true,
    originalVoiceoverRequired: true,
    originalTitle: originalTitle(subject),
    originalVoiceover: rewritten.map((shot) => shot.narration).filter(Boolean).join(" "),
  };
  next.manualBoundary = "原创补救已自动完成；只有账号登录、平台素材授权弹窗或生成额度等外部条件需要用户处理。不得为绕过授权弹窗而复用来源媒体。";
  next.assembly = {
    ...(next.assembly && typeof next.assembly === "object" ? next.assembly : {}),
    voiceover: "仅使用 originality.originalVoiceover 的全新 TTS；不得回退来源 voiceoverDraft、ASR 台词或原音。",
    music: "默认不加 BGM；确需音乐时只使用已确认许可或公版音乐，并记录许可来源。",
    sourceAudio: "discard",
    publishReadyChecks: unique([
      ...((Array.isArray(next?.assembly?.publishReadyChecks) ? next.assembly.publishReadyChecks : [])),
      "原创画面与来源不存在可识别复刻关系",
      "配音语义与标题、画面主题一致",
      "没有来源台词、原音、原 BGM、品牌、Logo、水印或专有角色",
    ], 20),
  };
  delete next.generationReadiness;
  return { workflow: next, changed: true, assessment };
}

/** 发布图文/草稿时与音频执行器使用同一份原创文案选择规则。 */
export function publishContentForPlan(plan = {}, fallback = "") {
  const originality = plan?.seedanceWorkflow?.originality || plan?.originalityRemediation || {};
  const strictOriginal = originality.policy === STRICT_POLICY && originality.status === "remediated";
  if (strictOriginal) {
    return text(originality.originalVoiceover || plan?.copywriting?.originalVoiceoverDraft
      || "这是一条使用全新画面与全新配音制作的原创内容。");
  }
  return text(plan?.copywriting?.publishCopy || plan?.copywriting?.voiceoverDraft || fallback);
}

export function isStrictOriginalPlan(plan = {}) {
  const originality = plan?.seedanceWorkflow?.originality || plan?.originalityRemediation || {};
  return originality.policy === STRICT_POLICY && originality.status === "remediated";
}

export function publishTitleForPlan(plan = {}, fallback = "") {
  if (!isStrictOriginalPlan(plan)) return text(fallback);
  const originality = plan?.seedanceWorkflow?.originality || plan?.originalityRemediation || {};
  return text(originality.originalTitle, "原创内容");
}

export function publishSourceUrlForPlan(plan = {}, fallback = "") {
  return isStrictOriginalPlan(plan) ? "" : text(fallback);
}

export { STRICT_POLICY };
