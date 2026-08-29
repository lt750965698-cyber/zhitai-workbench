import { MIN_MAX_VOLUME_DB, MIN_MEAN_VOLUME_DB } from "./audio-quality.mjs";
import { STRICT_POLICY } from "./originality-remediation.mjs";

export const AUTONOMOUS_REVIEW_POLICY_VERSION = "autonomous-content-review-v4";
export const AUTONOMOUS_REVIEWER = "zhitai_autonomous";
export const STRICT_GENERATION_ENGINES = Object.freeze(["ZhitaiSeedance", "ZhitaiLocalMotion"]);

const CONFIRMED_RIGHTS = new Set(["owned", "licensed", "public_domain", "commissioned", "confirmed"]);
const APPROVABLE_MEDIA_QUALITY = new Set(["high", "standard"]);
const SHA256 = /^[a-f0-9]{64}$/iu;

const TOPIC_GROUPS = [
  ["kitchen", /厨房|橱柜|灶台|灶具|台面|厨电|水槽/iu],
  ["children_room", /儿童房|孩子(?:的)?房间|孩子房|宝宝房|成长房|上下床/iu],
  ["bathroom", /卫生间|浴室|淋浴|马桶|洗漱|干区|湿区/iu],
  ["wall_decor", /PU\s*线条|石膏线|护墙板|墙面|背景墙|装饰板|墙板/iu],
  ["balcony", /阳台|晾晒区|洗衣区/iu],
  ["bay_window", /飘窗|窗台/iu],
  ["small_space", /小户型|老破小|两房变三房|空间改造|户型改造/iu],
  ["self_built", /自建房|宅基地|地下室|架空层|半架空/iu],
  ["entryway", /玄关|入户|鞋柜/iu],
  ["bedroom", /卧室|床头|衣柜/iu],
  ["living_room", /客厅|沙发|电视墙/iu],
  ["storage", /收纳|储物|柜体/iu],
  ["lighting", /灯光|照明|无主灯|色温/iu],
];

const GENERIC_TOPIC_TOKENS = new Set([
  "一个", "这个", "主题", "内容", "视频", "怎么", "怎样", "如何", "更清", "清楚", "楚耐", "耐看",
  "重点", "比例", "光线", "统一", "协调", "效果", "完整", "设计", "空间", "改造", "分享", "今天",
  "来看", "一起", "可以", "真的", "这样", "更加", "核心", "细节", "信息", "元素", "画面", "原创",
]);

const LOW_INFORMATION_WORDS = /(?:看起来|有质感|更加|比较|这样|整体|最后|最终|同时|然后|所以|因此|做完|效果|画面|信息|空间|清楚|耐看|好看|完整|协调|舒服|实用|高级|简洁|合理|统一|整齐|通透|方便|自然|美观|干净|一些|一点|也|就|才|会|能|让|更|很|了)/gu;

const FORBIDDEN_COPY_RULES = [
  {
    code: "analysis_language",
    message: "文案含分析或运营术语，不是面向真实观众的表达",
    pattern: /\b(?:ASR|OCR|CTA|ffprobe|FFmpeg|AAC|SHA-?256)\b|(?:平均音量|峰值|码率|任务\s*ID|分析结果|转写结果|内容分析|数据表明|完播率|平均观看|互动率|收藏率|关注转化|传播因素|审核结论|音频质检|质量门|听觉钩子|视觉冲击|叙事支撑|抓取用户注意)/iu,
  },
  {
    code: "production_language",
    message: "文案含拍摄、生成或后期制作指令，不能直接对观众发布",
    pattern: /(?:本镜头|第\s*\d+\s*(?:个)?镜头|画面中|视频中|这个视频|创作者|拍摄对象|固定机位|站着并说话|镜头运动|运镜|景别|后期选取|旁白将表达|叙事目的|提示词|负面约束|只输出干净画面|不得上传|不生成(?:文字|字幕)|\b9\s*:\s*16\b|竖屏(?:短)?视频)/iu,
  },
  {
    code: "placeholder_language",
    message: "文案仍含占位或未完成话术",
    pattern: /(?:这个主题|对应的主体|待确认|未取得|未命名|待补充|占位(?:符|话术)?|这里填写|暂无内容|\b(?:TODO|TBD|LOREM)\b|(?:^|[^A-Za-z])X{2,}(?:[^A-Za-z]|$)|\{\{?\s*(?:title|topic|content)\s*\}?\}|\[(?:title|topic|content)\])/iu,
  },
];

function cleanText(value) {
  return String(value ?? "")
    .replace(/[\u200b-\u200d\ufeff]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function reason(code, message, scope = "content", detail = null) {
  return { code, message, scope, ...(detail ? { detail } : {}) };
}

function addReason(reasons, next) {
  if (!reasons.some((item) => item.code === next.code && item.scope === next.scope && item.detail === next.detail)) {
    reasons.push(next);
  }
}

function rightsStatus(workflow) {
  const sourceRights = workflow?.sourceRights;
  return cleanText(
    workflow?.originality?.sourceRightsStatus
      || (typeof sourceRights === "string" ? sourceRights : sourceRights?.status),
  ).toLowerCase() || "unverified";
}

function assessRights(workflow, reasons) {
  const originality = workflow?.originality || {};
  const strictOriginal = originality.policy === STRICT_POLICY && originality.status === "remediated";
  const strictIsolation = strictOriginal
    && originality.referenceVideoAllowed === false
    && originality.sourceAudioAllowed === false
    && originality.sourceMusicAllowed === false
    && originality.originalVisualsRequired === true
    && originality.originalVoiceoverRequired === true;
  const status = rightsStatus(workflow);
  const confirmed = CONFIRMED_RIGHTS.has(status);

  if (!strictIsolation && !confirmed) {
    addReason(reasons, reason(
      "rights_or_originality_unverified",
      "来源权利未确认，且没有完成与来源视频、原音和原音乐隔离的严格原创流程",
      "rights",
    ));
  } else if (strictOriginal && !strictIsolation) {
    addReason(reasons, reason(
      "strict_originality_isolation_incomplete",
      "严格原创记录不完整，尚不能证明未复用来源视频、原音或原音乐",
      "rights",
    ));
  }

  return {
    mode: strictIsolation ? "strict_full_original" : confirmed ? "confirmed_source_rights" : "unverified",
    sourceRightsStatus: status,
    strictIsolation,
    confirmedSourceRights: confirmed,
  };
}

function detectTopicGroups(value) {
  const text = cleanText(value);
  return TOPIC_GROUPS.filter(([, pattern]) => pattern.test(text)).map(([name]) => name);
}

function lexicalTopicTokens(value) {
  const text = cleanText(value).toLowerCase();
  const tokens = [];
  for (const word of text.match(/[a-z][a-z0-9_-]{1,}/gu) || []) {
    if (!GENERIC_TOPIC_TOKENS.has(word)) tokens.push(word);
  }
  for (const run of text.match(/[\p{Script=Han}]{2,}/gu) || []) {
    if (run.length === 2) tokens.push(run);
    for (let index = 0; index < run.length - 1; index += 1) tokens.push(run.slice(index, index + 2));
  }
  return unique(tokens.filter((token) => !GENERIC_TOPIC_TOKENS.has(token)));
}

function topicMatch(title, narration) {
  const titleGroups = detectTopicGroups(title);
  const narrationGroups = detectTopicGroups(narration);
  const sharedGroups = titleGroups.filter((group) => narrationGroups.includes(group));
  const titleTokens = lexicalTopicTokens(title);
  const narrationTokens = new Set(lexicalTopicTokens(narration));
  const sharedTokens = titleTokens.filter((token) => narrationTokens.has(token));
  const matched = titleGroups.length
    ? sharedGroups.length > 0 || sharedTokens.length > 0
    : titleTokens.length > 0 && sharedTokens.length > 0;
  return { matched, titleGroups, narrationGroups, sharedGroups, titleTokens, sharedTokens };
}

function meaningfulCharacterCount(value) {
  return (cleanText(value).match(/[\p{L}\p{N}]/gu) || []).length;
}

function narrationSegments(value, pattern) {
  return cleanText(value)
    .split(pattern)
    .map((item) => cleanText(item).replace(/^[，,：:\s]+|[，,：:\s]+$/gu, ""))
    .filter(Boolean);
}

function normalizedNarrationSegment(value) {
  return cleanText(value).toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

function repeatedNarrationSegments(segments, kind, minimumCharacters) {
  const occurrences = new Map();
  segments.forEach((text, index) => {
    const normalized = normalizedNarrationSegment(text);
    if (meaningfulCharacterCount(normalized) < minimumCharacters) return;
    const current = occurrences.get(normalized) || { text, count: 0, firstIndex: index };
    current.count += 1;
    occurrences.set(normalized, current);
  });
  return [...occurrences.values()]
    .filter((item) => item.count >= 2)
    .sort((left, right) => left.firstIndex - right.firstIndex)
    .map(({ text, count }) => ({ text, count, kind }));
}

function assessNarrationQuality(value) {
  const sentences = narrationSegments(value, /[。！？!?；;\n]+/u);
  const clauses = narrationSegments(value, /[。！？!?；;，,\n]+/u);
  const repeatedSentences = repeatedNarrationSegments(sentences, "sentence", 6);
  const repeatedClauses = repeatedSentences.length === 0
    ? repeatedNarrationSegments(clauses, "clause", 8)
    : [];
  const repeatedSegments = repeatedSentences.length > 0 ? repeatedSentences : repeatedClauses;
  const comparisonSegments = repeatedSentences.length > 0 ? sentences : clauses;
  const comparisonCharacters = comparisonSegments.reduce(
    (total, item) => total + meaningfulCharacterCount(item),
    0,
  );
  const repeatedCharacters = repeatedSegments.reduce(
    (total, item) => total + meaningfulCharacterCount(item.text) * item.count,
    0,
  );
  const repeatedOccurrenceCount = repeatedSegments.reduce((total, item) => total + item.count, 0);
  const repeatedCharacterShare = comparisonCharacters > 0
    ? Math.min(1, repeatedCharacters / comparisonCharacters)
    : 0;
  const repeatedOccurrenceShare = comparisonSegments.length > 0
    ? Math.min(1, repeatedOccurrenceCount / comparisonSegments.length)
    : 0;
  const minimumOccurrenceShare = repeatedSentences.length > 0 ? 0.4 : 0.6;
  const minimumCharacterShare = repeatedSentences.length > 0 ? 0.35 : 0.5;
  const excessiveRepetition = repeatedSegments.some((item) => item.count >= 3)
    || (repeatedSegments.length > 0
      && repeatedOccurrenceShare >= minimumOccurrenceShare
      && repeatedCharacterShare >= minimumCharacterShare);
  const lowInformationSentences = sentences.flatMap((text, index) => {
    const normalized = normalizedNarrationSegment(text);
    if (meaningfulCharacterCount(normalized) > 16) return [];
    const remainder = normalized.replace(LOW_INFORMATION_WORDS, "");
    return meaningfulCharacterCount(remainder) === 0 ? [{ text, index: index + 1 }] : [];
  });

  return {
    excessiveRepetition,
    sentenceCount: sentences.length,
    uniqueSentenceCount: new Set(sentences.map(normalizedNarrationSegment)).size,
    repeatedCharacterShare: Number(repeatedCharacterShare.toFixed(3)),
    repeatedSegments,
    lowInformationSentences,
  };
}

function checkCopy(value, scope, reasons, forbiddenMatches) {
  const text = cleanText(value);
  if (!text) return;
  for (const rule of FORBIDDEN_COPY_RULES) {
    const match = text.match(rule.pattern);
    if (!match) continue;
    const detail = cleanText(match[0]).slice(0, 48);
    addReason(reasons, reason(rule.code, rule.message, scope, detail));
    forbiddenMatches.push({ scope, code: rule.code, term: detail });
  }
}

function assessSemantics({ title, workflow, boundNarration }, reasons) {
  const originality = workflow?.originality || {};
  const publishTitle = cleanText(title || originality.originalTitle);
  const workflowTitle = cleanText(originality.originalTitle);
  const shots = Array.isArray(workflow?.shots) ? workflow.shots : [];
  const shotNarrations = shots.map((shot) => cleanText(shot?.narration)).filter(Boolean);
  const originalVoiceover = cleanText(originality.originalVoiceover);
  const hasBoundNarration = boundNarration !== undefined && boundNarration !== null;
  const narration = cleanText(hasBoundNarration ? boundNarration : (originalVoiceover || shotNarrations.join(" ")));
  const narrations = hasBoundNarration ? unique([narration]) : unique([originalVoiceover, ...shotNarrations]);
  const forbiddenMatches = [];

  if (meaningfulCharacterCount(publishTitle) < 3) {
    addReason(reasons, reason("title_missing", "标题缺失或没有足够的有效主题信息", "title"));
  }
  if (!narration || meaningfulCharacterCount(narration) < 8) {
    addReason(reasons, reason("narration_missing", "没有取得可直接面向观众发布的完整旁白", "narration"));
  }
  if (originality.policy === STRICT_POLICY && originality.status === "remediated" && !originalVoiceover) {
    addReason(reasons, reason("original_voiceover_missing", "严格原创流程缺少已固化的原创旁白", "narration"));
  }

  checkCopy(publishTitle, "title", reasons, forbiddenMatches);
  if (workflowTitle && workflowTitle !== publishTitle) checkCopy(workflowTitle, "workflow_title", reasons, forbiddenMatches);
  narrations.forEach((item, index) => checkCopy(item, `narration_${index + 1}`, reasons, forbiddenMatches));

  const narrationQuality = assessNarrationQuality(narration);
  if (narrationQuality.excessiveRepetition) {
    addReason(reasons, reason(
      "narration_excessive_repetition",
      "旁白大量重复同一句或片段，需要保留一次并补充新的主题信息",
      "narration",
      narrationQuality.repeatedSegments[0]?.text.slice(0, 48) || null,
    ));
  }
  if (narrationQuality.lowInformationSentences.length > 0) {
    addReason(reasons, reason(
      "narration_low_information_sentence",
      "旁白含孤立空泛句，需要改为可核对的主题信息或观众利益点",
      "narration",
      narrationQuality.lowInformationSentences[0].text.slice(0, 48),
    ));
  }

  const primaryTopic = topicMatch(publishTitle, narration);
  if (publishTitle && narration && !primaryTopic.matched) {
    addReason(reasons, reason(
      "narration_theme_mismatch",
      "旁白与发布标题没有可核对的主题重合，需要重写为同一主题",
      "semantics",
    ));
  }
  const workflowTopic = workflowTitle && workflowTitle !== publishTitle
    ? topicMatch(workflowTitle, narration)
    : null;
  if (workflowTopic && !workflowTopic.matched) {
    addReason(reasons, reason(
      "workflow_theme_mismatch",
      "旁白与严格原创工作流标题不匹配",
      "semantics",
    ));
  }

  return {
    publishTitle,
    workflowTitle: workflowTitle || null,
    narrationSource: hasBoundNarration ? "bound_audio_quality_report" : "workflow",
    narrationSampleCount: narrations.length,
    shotCount: shots.length,
    meaningfulNarrationCharacters: meaningfulCharacterCount(narration),
    audienceFacing: forbiddenMatches.length === 0,
    forbiddenMatches,
    narrationQuality,
    topic: {
      matched: primaryTopic.matched,
      titleGroups: primaryTopic.titleGroups,
      narrationGroups: primaryTopic.narrationGroups,
      sharedGroups: primaryTopic.sharedGroups,
      sharedTokens: primaryTopic.sharedTokens.slice(0, 12),
    },
  };
}

function assessMachine({ machineCheck, expectedAssetId, expectedGenerationTaskId }, reasons) {
  const passed = machineCheck?.passed === true || machineCheck?.ok === true;
  const strictGenerated = machineCheck?.strictGenerated === true || machineCheck?.requireStrictGenerated === true;
  const preparation = machineCheck?.preparation || machineCheck?.result || null;
  const binding = preparation?.scheduleBinding || machineCheck?.scheduleBinding || null;
  const generation = preparation?.generation || machineCheck?.generation || null;
  const content = preparation?.content || machineCheck?.content || null;
  const publishQuality = preparation?.publishQuality || machineCheck?.publishQuality || null;
  const payload = preparation?.payload || machineCheck?.payload || null;
  const expectedAsset = cleanText(expectedAssetId);
  const expectedTask = cleanText(expectedGenerationTaskId);

  if (!passed) {
    addReason(reasons, reason("strict_preflight_failed", "严格发布预检未通过", "machine"));
  }
  if (!strictGenerated) {
    addReason(reasons, reason("strict_preflight_not_declared", "自审没有绑定到严格生成成片预检", "machine"));
  }
  if (!expectedAsset) {
    addReason(reasons, reason("expected_asset_id_missing", "自审缺少预期素材 ID，不能核对成片归属", "machine"));
  } else if (cleanText(content?.id) !== expectedAsset) {
    addReason(reasons, reason("asset_binding_mismatch", "严格预检返回的素材 ID 与当前审核任务不一致", "machine"));
  }
  if (!expectedTask) {
    addReason(reasons, reason("expected_generation_task_id_missing", "自审缺少预期生成任务 ID，不能核对任务归属", "machine"));
  }

  const generationEngine = cleanText(binding?.generationEngine);
  const recordedGenerationEngine = cleanText(generation?.engine);
  const generationTaskId = cleanText(binding?.generationTaskId);
  const recordedGenerationTaskId = cleanText(generation?.engine_task_id);
  const mediaSha256 = cleanText(binding?.mediaSha256).toLowerCase();
  const mediaSizeBytes = Number(binding?.mediaSizeBytes);
  const audioQualitySha256 = cleanText(binding?.audioQualitySha256).toLowerCase();
  const workflowSha256 = cleanText(binding?.workflowSha256).toLowerCase();
  const contentSha256 = cleanText(content?.mediaSha256).toLowerCase();
  const generationSha256 = cleanText(generation?.sha256).toLowerCase();
  const generationSizeBytes = Number(generation?.size_bytes);
  const evidenceMode = cleanText(binding?.evidenceMode);
  const generationProvenanceSha256 = cleanText(binding?.generationProvenanceSha256).toLowerCase();
  const storyboardFingerprint = cleanText(binding?.storyboardFingerprint).toLowerCase();
  const motionManifestSha256 = cleanText(binding?.motionManifestSha256).toLowerCase();
  const storyboards = Array.isArray(binding?.storyboards) ? binding.storyboards : [];
  const localMotion = binding?.localMotion && typeof binding.localMotion === "object"
    ? binding.localMotion
    : null;

  if (!STRICT_GENERATION_ENGINES.includes(generationEngine)
    || recordedGenerationEngine !== generationEngine) {
    addReason(reasons, reason("generation_engine_invalid", "成片不是由已绑定任务的织台严格生成引擎产出，或生成记录与预检引擎不一致", "machine"));
  }
  if (!generationTaskId) {
    addReason(reasons, reason("generation_task_binding_missing", "严格预检没有返回生成任务绑定", "machine"));
  } else if (expectedTask && generationTaskId !== expectedTask) {
    addReason(reasons, reason("generation_task_binding_mismatch", "成片生成任务 ID 与当前审核任务不一致", "machine"));
  }
  if (!recordedGenerationTaskId || (generationTaskId && recordedGenerationTaskId !== generationTaskId)) {
    addReason(reasons, reason("generation_record_binding_mismatch", "生成记录与严格预检的任务 ID 绑定不一致", "machine"));
  }
  if (!SHA256.test(mediaSha256) || !Number.isFinite(mediaSizeBytes) || mediaSizeBytes <= 0) {
    addReason(reasons, reason("media_binding_invalid", "成片文件大小或 SHA-256 绑定无效", "machine"));
  } else if (!SHA256.test(contentSha256)
    || !SHA256.test(generationSha256)
    || !Number.isFinite(generationSizeBytes)
    || generationSizeBytes <= 0) {
    addReason(reasons, reason("media_record_binding_missing", "预检或数据库生成记录缺少可核对的成片大小与 SHA-256", "machine"));
  } else if (contentSha256 !== mediaSha256
    || generationSha256 !== mediaSha256
    || generationSizeBytes !== mediaSizeBytes) {
    addReason(reasons, reason("media_binding_mismatch", "预检、生成记录和实际成片的大小或 SHA-256 不一致", "machine"));
  }
  if (!SHA256.test(audioQualitySha256)) {
    addReason(reasons, reason("audio_quality_binding_missing", "缺少与当前成片绑定的 audio-quality.json 证据", "machine"));
  }
  if (!SHA256.test(workflowSha256)) {
    addReason(reasons, reason("workflow_binding_missing", "缺少与当前成片绑定的严格原创工作流证据", "machine"));
  }
  if (!SHA256.test(storyboardFingerprint)) {
    addReason(reasons, reason("storyboard_binding_missing", "缺少与当前成片和图文包绑定的分镜指纹", "machine"));
  }
  if (!SHA256.test(generationProvenanceSha256)) {
    addReason(reasons, reason("generation_provenance_missing", "缺少与当前生成引擎和任务绑定的来源指纹", "machine"));
  }
  if (storyboards.length === 0 || storyboards.some((item) => !/^storyboard-\d+\.png$/iu.test(cleanText(item?.name))
    || !SHA256.test(cleanText(item?.sha256).toLowerCase())
    || Number(item?.sizeBytes) <= 0)) {
    addReason(reasons, reason("storyboard_evidence_invalid", "分镜文件数量、大小或 SHA-256 证据无效", "machine"));
  }
  if (generationEngine === "ZhitaiLocalMotion") {
    const segments = Array.isArray(localMotion?.segments) ? localMotion.segments : [];
    const localMotionValid = evidenceMode === "local_storyboard_motion"
      && SHA256.test(generationProvenanceSha256)
      && SHA256.test(motionManifestSha256)
      && Number(localMotion?.width) === 1080
      && Number(localMotion?.height) === 1920
      && Number(localMotion?.fps) === 30
      && Number(localMotion?.totalFrames) === 750
      && Number(localMotion?.durationMs) === 25_000
      && segments.length === 3
      && segments.every((segment, index) => Number(segment?.index) === index + 1
        && /^storyboard-\d+\.png$/iu.test(cleanText(segment?.sourceStoryboard))
        && /^clip-\d+\.mp4$/iu.test(cleanText(segment?.clipName))
        && SHA256.test(cleanText(segment?.sourceStoryboardSha256).toLowerCase())
        && SHA256.test(cleanText(segment?.clipSha256).toLowerCase())
        && Number(segment?.clipSizeBytes) > 0
        && Number(segment?.width) === 1080
        && Number(segment?.height) === 1920
        && Number(segment?.fps) === 30
        && Number(segment?.frameCount) === 250
        && Number(segment?.durationMs) > 0)
      && Math.abs(segments.reduce((sum, segment) => sum + Number(segment.durationMs), 0) - 25_000) <= 2
      && localMotion?.audio?.codec === "aac"
      && localMotion?.audio?.narrationComplete === true
      && localMotion?.audio?.timingVerified === true
      && Number(localMotion?.audio?.meanVolumeDb) >= MIN_MEAN_VOLUME_DB
      && Number(localMotion?.audio?.maxVolumeDb) >= MIN_MAX_VOLUME_DB
      && SHA256.test(cleanText(localMotion?.audio?.narrationSha256).toLowerCase());
    if (!localMotionValid) {
      addReason(reasons, reason(
        "local_motion_evidence_invalid",
        "本地动画成片缺少经验证的分镜、片段、帧率、时长、配音或来源指纹证据",
        "machine",
      ));
    }
  } else if (generationEngine === "ZhitaiSeedance" && evidenceMode !== "seedance_web_generation") {
    addReason(reasons, reason("seedance_evidence_mode_invalid", "Seedance 成片缺少与网页生成流程一致的证据模式", "machine"));
  }
  if (payload?.draft !== false) {
    addReason(reasons, reason("public_preflight_not_used", "自审使用的不是公开发布级预检", "machine"));
  }
  const qualityState = cleanText(publishQuality?.state).toLowerCase();
  if (!APPROVABLE_MEDIA_QUALITY.has(qualityState)) {
    addReason(reasons, reason("public_quality_not_ready", "成片清晰度或技术元数据不足，不能无人值守批准公开发布", "machine"));
  }

  const audioQuality = machineCheck?.audioQuality;
  let audioEvidence = { reportBound: SHA256.test(audioQualitySha256) };
  if (audioQuality !== undefined && audioQuality !== null) {
    const meanVolumeDb = Number(audioQuality?.meanVolumeDb);
    const maxVolumeDb = Number(audioQuality?.maxVolumeDb);
    const audioPassed = audioQuality?.ok === true || audioQuality?.status === "passed";
    const audioIntegrity = audioQuality?.integrity !== false;
    const audioNarration = cleanText(audioQuality?.narration);
    if (!audioPassed
      || !audioIntegrity
      || !Number.isFinite(meanVolumeDb)
      || !Number.isFinite(maxVolumeDb)
      || meanVolumeDb < MIN_MEAN_VOLUME_DB
      || maxVolumeDb < MIN_MAX_VOLUME_DB) {
      addReason(reasons, reason("audio_quality_failed", "AAC 音轨的静音质检、音量阈值或文件完整性未通过", "machine"));
    }
    if (strictGenerated && !audioNarration) {
      addReason(reasons, reason(
        "audio_narration_binding_missing",
        "audio-quality.json 缺少与当前成片绑定的实际旁白文本",
        "machine",
      ));
    }
    audioEvidence = {
      ...audioEvidence,
      reportPassed: audioPassed,
      integrity: audioIntegrity,
      meanVolumeDb: Number.isFinite(meanVolumeDb) ? meanVolumeDb : null,
      maxVolumeDb: Number.isFinite(maxVolumeDb) ? maxVolumeDb : null,
      narrationBound: Boolean(audioNarration),
      thresholds: { meanVolumeDb: MIN_MEAN_VOLUME_DB, maxVolumeDb: MIN_MAX_VOLUME_DB },
    };
  }

  return {
    strictPreflightPassed: passed,
    strictGenerated,
    publicPreflight: payload?.draft === false,
    assetId: cleanText(content?.id) || null,
    generationEngine: generationEngine || null,
    generationTaskId: generationTaskId || null,
    evidenceMode: evidenceMode || null,
    generationProvenanceSha256: SHA256.test(generationProvenanceSha256) ? generationProvenanceSha256 : null,
    storyboardFingerprint: SHA256.test(storyboardFingerprint) ? storyboardFingerprint : null,
    storyboards,
    motionManifestSha256: SHA256.test(motionManifestSha256) ? motionManifestSha256 : null,
    ...(generationEngine === "ZhitaiLocalMotion" ? { localMotion } : {}),
    mediaSha256: SHA256.test(mediaSha256) ? mediaSha256 : null,
    mediaSizeBytes: Number.isFinite(mediaSizeBytes) && mediaSizeBytes > 0 ? mediaSizeBytes : null,
    audioQualitySha256: SHA256.test(audioQualitySha256) ? audioQualitySha256 : null,
    workflowSha256: SHA256.test(workflowSha256) ? workflowSha256 : null,
    publishQuality: qualityState || null,
    audioQuality: audioEvidence,
  };
}

/**
 * 组合严格发布预检的不可变证据与文本语义门，产出可直接持久化的自主审核结论。
 *
 * `machineCheck` 必须来自 `prepareMatrixPublish(..., { requireStrictGenerated: true })`
 * 的成功结果，并由调用方显式标记 `passed/ok` 与 `strictGenerated`。这里不探测、
 * 不打开也不播放媒体；失败关闭为 `needs_revision`，不会自行创建草稿或发布。
 */
export function assessAutonomousContentReview({
  title = "",
  workflow = {},
  machineCheck = null,
  expectedAssetId = "",
  expectedGenerationTaskId = "",
} = {}) {
  const reasons = [];
  const machine = assessMachine({ machineCheck, expectedAssetId, expectedGenerationTaskId }, reasons);
  const rights = assessRights(workflow, reasons);
  const semantics = assessSemantics({
    title,
    workflow,
    boundNarration: machineCheck?.audioQuality?.narration,
  }, reasons);
  const approved = reasons.length === 0;
  return {
    status: approved ? "approved_for_publish" : "needs_revision",
    approved,
    reviewer: AUTONOMOUS_REVIEWER,
    policyVersion: AUTONOMOUS_REVIEW_POLICY_VERSION,
    reasons,
    evidence: { machine, rights, semantics },
  };
}
