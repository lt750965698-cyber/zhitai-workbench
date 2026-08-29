#!/usr/bin/env node
"use strict";

const fsp = require("node:fs/promises");
const fsConstants = require("node:fs").constants;
const { createHash, randomUUID } = require("node:crypto");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const RUNTIME_ROOT = process.env.ZHITAI_RUNTIME_ROOT
  || path.join(os.homedir(), ".local", "share", "zhitai-runtime");
const FFMPEG = process.env.ZHITAI_FFMPEG
  || path.join(RUNTIME_ROOT, "engines", "ffmpeg", "ffmpeg");
const FFPROBE = process.env.ZHITAI_FFPROBE
  || path.join(RUNTIME_ROOT, "engines", "ffmpeg", "ffprobe");
const EDGE_TTS = process.env.ZHITAI_EDGE_TTS
  || path.join(RUNTIME_ROOT, "engines", "MoneyPrinterTurbo", ".venv", "bin", "edge-tts");
const DEFAULT_VOICE = process.env.ZHITAI_TTS_VOICE || "zh-CN-XiaoxiaoNeural";
const GENERATION_ROOT = path.join(os.homedir(), ".local", "share", "zhitai-runtime", "generation");
const CREATIVE_JOB_ID = /^creative_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NARRATION_SOURCES = new Set([
  "originality_voiceover", "original_shot_narration", "original_title_fallback",
  "voiceover_draft", "shot_narration", "title", "hook", "publish_copy", "title_fallback",
]);
const TTS_RATES = new Set(["+0%", "+10%", "+20%"]);
const MAX_NARRATION_CHARS = 180;
const MAX_SUBTITLE_BYTES = 64 * 1024;
const MAX_REPORT_BYTES = 16 * 1024;
const FORBIDDEN_TEXT_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u;

function run(command, args, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: `${path.dirname(FFMPEG)}:${process.env.PATH || "/usr/bin:/bin"}` },
    });
    let out = "";
    let err = "";
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill("SIGTERM"); } catch { /* best effort */ }
      finish(new Error(`${path.basename(command)} 执行超时`));
    }, timeoutMs);
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(value);
    }
    child.stdout.on("data", (chunk) => { out = (out + chunk.toString()).slice(-24_000); });
    child.stderr.on("data", (chunk) => { err = (err + chunk.toString()).slice(-24_000); });
    child.once("error", finish);
    child.once("exit", (code) => {
      if (code === 0) finish(null, { out, err });
      else finish(new Error(`${path.basename(command)} 退出码 ${code}：${String(err || out).trim().slice(-500)}`));
    });
  });
}

function cleanSpokenText(value) {
  return String(value || "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/#[^#\s]+/g, " ")
    .replace(/(?:📌|✅|☑️?|⭐|✨|🔥)/gu, " ")
    .replace(/^无画外配音[；，,:：]\s*/u, "")
    .replace(/(?:，|；)?但(?:缺乏|没有).*/u, "")
    .replace(/\s+/g, " ")
    .replace(/\s+([，。！？；：])/g, "$1")
    .trim();
}

function normalizeNarrationEvidence(value, { allowEmpty = false } = {}) {
  const normalized = String(value ?? "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t\n ]+/g, " ")
    .trim();
  if ((!allowEmpty && !normalized) || FORBIDDEN_TEXT_CONTROL.test(normalized)) {
    throw new Error("旁白证据包含空文本或控制字符");
  }
  if ([...normalized].length > MAX_NARRATION_CHARS) throw new Error("旁白证据超过长度上限");
  return normalized;
}

function narrationComparisonKey(value) {
  return normalizeNarrationEvidence(value).normalize("NFKC").replace(/\s+/gu, "");
}

function parseEdgeTtsSrt(value) {
  const source = String(value || "").replace(/^\uFEFF/u, "").replace(/\r\n?/g, "\n").trim();
  if (!source || FORBIDDEN_TEXT_CONTROL.test(source)) throw new Error("Edge TTS 字幕为空或包含控制字符");
  const cues = source.split(/\n{2,}/u);
  const texts = cues.map((cue, index) => {
    const lines = cue.split("\n");
    if (lines[0] !== String(index + 1)
      || !/^\d{2}:\d{2}:\d{2},\d{3} --> \d{2}:\d{2}:\d{2},\d{3}$/u.test(lines[1] || "")
      || lines.length < 3) {
      throw new Error("Edge TTS 字幕格式不符合顺序 SRT 契约");
    }
    const text = lines.slice(2).join(" ").trim();
    if (!text || /[<>]/u.test(text)) throw new Error("Edge TTS 字幕包含空提示或标记");
    return text;
  });
  // edge-tts 的 WordBoundary 提示可能把一句话拆成多个 cue；直接拼接可还原
  // 实际送入合成器的字符序列，比较时只规范化 Unicode 与空白。
  return normalizeNarrationEvidence(texts.join(""));
}

async function verifiedSynthesizedNarration(subtitlePath, expectedNarration) {
  let handle;
  let bytes;
  try {
    handle = await fsp.open(subtitlePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const before = await handle.stat({ bigint: true });
    const namedBefore = await fsp.lstat(subtitlePath, { bigint: true });
    if (!before.isFile() || before.size < 1n || before.size > BigInt(MAX_SUBTITLE_BYTES)
      || !namedBefore.isFile() || namedBefore.isSymbolicLink()
      || before.dev !== namedBefore.dev || before.ino !== namedBefore.ino) {
      throw new Error("subtitle_not_regular");
    }
    bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const namedAfter = await fsp.lstat(subtitlePath, { bigint: true });
    if (!after.isFile() || !namedAfter.isFile() || namedAfter.isSymbolicLink()
      || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
      || after.dev !== namedAfter.dev || after.ino !== namedAfter.ino
      || after.size !== namedAfter.size || after.mtimeNs !== namedAfter.mtimeNs
      || BigInt(bytes.length) !== after.size) {
      throw new Error("subtitle_changed_during_read");
    }
  } catch {
    throw new Error("Edge TTS 没有生成大小合规的本地字幕证据");
  } finally {
    await handle?.close().catch(() => {});
  }
  let subtitle;
  try { subtitle = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("Edge TTS 字幕不是有效 UTF-8"); }
  const actual = parseEdgeTtsSrt(subtitle);
  const expected = normalizeNarrationEvidence(expectedNarration);
  if (narrationComparisonKey(actual) !== narrationComparisonKey(expected)) {
    throw new Error("Edge TTS 字幕反读文本与选中旁白不一致");
  }
  return actual;
}

function validatedVoice(value) {
  const voice = String(value || "");
  if (voice.length > 64 || !/^[a-z]{2,3}-[A-Z]{2}-[A-Za-z0-9]+Neural$/u.test(voice)) {
    throw new Error("Edge TTS voice 不在允许格式内");
  }
  return voice;
}

async function secureOutputScope(output, input, { generationRoot = GENERATION_ROOT } = {}) {
  if (typeof output !== "string" || !path.isAbsolute(output) || path.normalize(output) !== output
    || path.basename(output) !== "final.mp4") {
    throw new Error("音频后期输出路径不符合固定文件契约");
  }
  const outputDir = path.dirname(output);
  const jobId = path.basename(outputDir);
  if (!CREATIVE_JOB_ID.test(jobId)) throw new Error("音频后期作业 ID 不是 canonical creative UUID");
  const trustedGenerationRoot = path.resolve(String(generationRoot));
  if (path.dirname(outputDir) !== trustedGenerationRoot
    || outputDir !== path.join(trustedGenerationRoot, jobId)) {
    throw new Error("音频后期输出目录不属于固定 generation 根目录");
  }
  const expectedInput = path.join(outputDir, "final.visual.mp4");
  if (typeof input !== "string" || path.normalize(input) !== expectedInput) {
    throw new Error("音频后期输入路径不属于当前 creative 作业");
  }
  await fsp.mkdir(outputDir, { recursive: true, mode: 0o700 });
  const stat = await fsp.lstat(outputDir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("音频后期作业目录不是本地实体目录");
  await fsp.chmod(outputDir, 0o700);
  return { jobId, outputDir };
}

function buildAudioQualityReport({
  jobId, tts, narration, narrationSource, narrationTiming, finalTimingPassed,
  durationTarget, outputMedia, media, discardInputAudio, originality, outputSizeBytes,
  outputSha256, quality, checkedAt,
}) {
  if (!CREATIVE_JOB_ID.test(jobId)) throw new Error("音频质检报告作业 ID 无效");
  const hasTts = Boolean(tts);
  const boundedNarration = hasTts ? normalizeNarrationEvidence(narration) : null;
  const source = hasTts && NARRATION_SOURCES.has(narrationSource) ? narrationSource : hasTts ? null : "none";
  if (hasTts && source === null) throw new Error("音频质检报告旁白来源无效");
  const voice = hasTts ? validatedVoice(tts.voice) : null;
  const rate = hasTts && TTS_RATES.has(tts.rate) ? tts.rate : null;
  if (hasTts && rate === null) throw new Error("音频质检报告语速无效");
  const originalityPolicy = originality?.policy === "strict_full_original" ? "strict_full_original" : null;
  const report = {
    schemaVersion: 1,
    status: "passed",
    jobId,
    provider: hasTts ? "MoneyPrinterTurbo Edge TTS + FFmpeg" : "FFmpeg loudnorm",
    voice,
    rate,
    narrationSource: source,
    narration: boundedNarration,
    narrationSha256: createHash("sha256").update(boundedNarration || "").digest("hex"),
    narrationComplete: Boolean(hasTts && narrationTiming?.passed && finalTimingPassed),
    narrationVerifiedFromSubtitles: hasTts,
    narrationDurationMs: hasTts ? narrationTiming?.narrationDurationMs || null : null,
    finalDurationMs: Math.round(durationTarget * 1_000),
    outputDurationMs: Math.round(outputMedia.durationSeconds * 1_000),
    timingVerified: Boolean(finalTimingPassed),
    inputHadAudio: Boolean(media.hasAudio),
    inputAudioDiscarded: Boolean(discardInputAudio),
    originalityPolicy,
    durationSeconds: Number(media.durationSeconds),
    outputSizeBytes: Number(outputSizeBytes),
    outputSha256: String(outputSha256),
    meanVolumeDb: Number(quality.meanVolumeDb),
    maxVolumeDb: Number(quality.maxVolumeDb),
    checkedAt: String(checkedAt),
  };
  const narrationDurationValid = !hasTts || (Number.isSafeInteger(report.narrationDurationMs)
    && report.narrationDurationMs > 0 && report.narrationDurationMs <= report.finalDurationMs);
  if (!/^[a-f0-9]{64}$/u.test(report.outputSha256)
    || !Number.isSafeInteger(report.outputSizeBytes) || report.outputSizeBytes < 1
    || !Number.isFinite(report.durationSeconds) || report.durationSeconds <= 0 || report.durationSeconds > 3_600
    || !Number.isSafeInteger(report.finalDurationMs) || report.finalDurationMs <= 0 || report.finalDurationMs > 3_600_000
    || !Number.isSafeInteger(report.outputDurationMs) || report.outputDurationMs <= 0 || report.outputDurationMs > 3_600_000
    || !narrationDurationValid
    || !Number.isFinite(report.meanVolumeDb) || report.meanVolumeDb < -200 || report.meanVolumeDb > 20
    || !Number.isFinite(report.maxVolumeDb) || report.maxVolumeDb < -200 || report.maxVolumeDb > 20
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(report.checkedAt)) {
    throw new Error("音频质检报告固定字段验证失败");
  }
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (Buffer.byteLength(json, "utf8") > MAX_REPORT_BYTES) throw new Error("音频质检报告超过大小上限");
  return { report, json };
}

async function writePrivateReportAtomic(reportPath, json) {
  const temporary = path.join(path.dirname(reportPath), `.audio-quality-${process.pid}-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await fsp.open(temporary, "wx", 0o600);
    await handle.writeFile(json, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fsp.chmod(temporary, 0o600);
    await fsp.rename(temporary, reportPath);
    await fsp.chmod(reportPath, 0o600);
  } catch (error) {
    await handle?.close().catch(() => {});
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function isUsableNarration(value) {
  const raw = String(value || "").trim();
  if (!raw || /^(?:待确认|未取得|无|没有可用)/u.test(raw)) return false;
  if (/^无画外配音[；，,:：]/u.test(raw)) return false;
  const clean = cleanSpokenText(raw);
  return clean.length >= 4 && !/^(?:不在视频内|画面只负责|全部单镜头)/u.test(clean);
}

function isGenericTitle(value) {
  const clean = cleanSpokenText(value).replace(/[\s._-]/g, "");
  return clean.length < 6
    || /^(?:未命名|生成|制作|测试)/u.test(clean)
    || /^(?:儿童房)?全景(?:视频)?\d*秒?$/u.test(clean)
    || /^(?:竖屏)?(?:短)?视频\d*秒?$/u.test(clean);
}

function narrationQualityBlocker(value) {
  const narration = cleanSpokenText(value);
  if (!narration) return "缺少可用配音文案";
  if (/视频前\s*\d+\s*秒|听觉钩子|视觉冲击|叙事支撑|本镜头|这一镜|(?:ASR|OCR|转写|分析结果)|观察到/iu.test(narration)) {
    return "旁白仍包含分析术语";
  }
  if (/拍摄对象|站着并说话|人物.{0,10}(?:说话|站立)|对应的主体|画面中的主体|这个主题/iu.test(narration)) {
    return "旁白使用拍摄占位描述，未对应真实观众主题";
  }
  return null;
}

function truncateForDuration(value, durationSeconds) {
  const clean = cleanSpokenText(value);
  const maxChars = Math.max(18, Math.min(150, Math.floor((Number(durationSeconds) || 10) * 4.2)));
  if (clean.length <= maxChars) return clean;
  const floor = Math.floor(maxChars * 0.62);
  const slice = clean.slice(0, maxChars + 1);
  let end = -1;
  for (const marker of ["。", "！", "？", "；", "，"]) {
    const index = slice.lastIndexOf(marker);
    if (index >= floor) end = Math.max(end, index + 1);
  }
  const result = (end > 0 ? clean.slice(0, end) : clean.slice(0, maxChars)).replace(/[，；：\s]+$/u, "");
  return /[。！？]$/u.test(result) ? result : `${result}。`;
}

function narrationTimingDecision({
  videoDurationSeconds,
  narrationDurationSeconds,
  expectedVideoDurationSeconds = null,
  toleranceSeconds = 0.08,
  tailMarginSeconds = 0.05,
} = {}) {
  const video = Number(videoDurationSeconds);
  const narration = Number(narrationDurationSeconds);
  const expected = expectedVideoDurationSeconds === null ? null : Number(expectedVideoDurationSeconds);
  if (!Number.isFinite(video) || video <= 0) return { passed: false, reason: "video_duration_invalid" };
  if (expected !== null && (!Number.isFinite(expected) || Math.abs(video - expected) > toleranceSeconds)) {
    return { passed: false, reason: "video_duration_mismatch" };
  }
  if (!Number.isFinite(narration) || narration <= 0) return { passed: false, reason: "narration_duration_invalid" };
  if (narration > video - tailMarginSeconds) return { passed: false, reason: "narration_exceeds_video" };
  return {
    passed: true,
    reason: null,
    videoDurationMs: Math.round(video * 1_000),
    narrationDurationMs: Math.round(narration * 1_000),
    remainingTailMs: Math.round((video - narration) * 1_000),
  };
}

function selectNarration(detail, shots = [], durationSeconds = 10) {
  const plan = detail?.remake_plan?.plan || {};
  const copy = plan.copywriting || {};
  const originality = plan?.seedanceWorkflow?.originality || {};
  const strictOriginal = originality.policy === "strict_full_original" && originality.status === "remediated";
  const title = detail?.asset?.title || "";
  const shotNarration = shots.map((shot) => shot?.narration).filter(isUsableNarration).join(" ");
  const candidates = strictOriginal ? [
    { source: "originality_voiceover", text: originality.originalVoiceover },
    { source: "original_shot_narration", text: shotNarration },
    ...(!isGenericTitle(title) ? [{ source: "original_title_fallback", text: title }] : []),
  ] : [
    { source: "voiceover_draft", text: copy.voiceoverDraft },
    { source: "shot_narration", text: shotNarration },
    ...(!isGenericTitle(title) ? [{ source: "title", text: title }] : []),
    { source: "hook", text: copy.hook3s },
    { source: "publish_copy", text: copy.publishCopy },
    { source: "title_fallback", text: title },
  ];
  const selected = candidates.find((candidate) => isUsableNarration(candidate.text));
  if (!selected) return { text: "", source: "unavailable" };
  return { text: truncateForDuration(selected.text, durationSeconds), source: selected.source };
}

function parseVolume(value) {
  const text = String(value || "");
  const mean = /mean_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/i.exec(text)?.[1];
  const max = /max_volume:\s*(-?(?:\d+(?:\.\d+)?|inf))\s*dB/i.exec(text)?.[1];
  const toNumber = (item) => item === undefined ? null : item.toLowerCase().includes("inf") ? -Infinity : Number(item);
  return { meanVolumeDb: toNumber(mean), maxVolumeDb: toNumber(max) };
}

async function probeMedia(filePath) {
  const { out } = await run(FFPROBE, [
    "-v", "error", "-show_entries", "format=duration:stream=index,codec_type,codec_name,duration",
    "-of", "json", filePath,
  ], { timeoutMs: 30_000 });
  const payload = JSON.parse(out || "{}");
  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  const durationSeconds = Math.max(0.1, Number(payload?.format?.duration) || 0);
  const video = streams.find((stream) => stream.codec_type === "video");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  return {
    durationSeconds,
    videoDurationSeconds: video ? Math.max(0.1, Number(video.duration) || durationSeconds) : 0,
    audioDurationSeconds: audio ? Math.max(0.1, Number(audio.duration) || durationSeconds) : 0,
    audioCodec: String(audio?.codec_name || ""),
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
  };
}

async function detectVolume(filePath) {
  const result = await run(FFMPEG, [
    "-hide_banner", "-nostats", "-i", filePath, "-map", "0:a:0", "-af", "volumedetect", "-f", "null", "-",
  ], { timeoutMs: 120_000 });
  return parseVolume(`${result.out}\n${result.err}`);
}

async function synthesizeNarration(text, outputDir, durationSeconds) {
  await fsp.access(EDGE_TTS).catch(() => { throw new Error("织台语音引擎未安装，已停止无声成片交付"); });
  const mediaPath = path.join(outputDir, "narration.mp3");
  const subtitlePath = path.join(outputDir, "subtitles.srt");
  const density = text.length / Math.max(1, Number(durationSeconds) || 10);
  const rate = density > 4.6 ? "+20%" : density > 4 ? "+10%" : "+0%";
  const voice = validatedVoice(DEFAULT_VOICE);
  const expectedNarration = normalizeNarrationEvidence(text);
  await run(EDGE_TTS, [
    "--text", expectedNarration,
    "--voice", voice,
    "--rate", rate,
    "--volume", "+0%",
    "--write-media", mediaPath,
    "--write-subtitles", subtitlePath,
  ], { timeoutMs: 180_000 });
  const result = await fsp.stat(mediaPath).catch(() => null);
  if (!result?.isFile() || result.size < 1_024) throw new Error("织台语音引擎没有生成有效配音");
  const verifiedNarration = await verifiedSynthesizedNarration(subtitlePath, expectedNarration);
  return { mediaPath, subtitlePath, voice, rate, verifiedNarration };
}

async function postprocessAudio({ input, output, detail, shots = [], expectedDurationSeconds = null }) {
  const { jobId, outputDir } = await secureOutputScope(output, input);
  const media = await probeMedia(input);
  if (!media.hasVideo) throw new Error("待后期文件没有可用视频轨");
  if (expectedDurationSeconds !== null
    && Math.abs(media.videoDurationSeconds - Number(expectedDurationSeconds)) > 0.08) {
    throw new Error(`待后期视频时长不是要求的 ${Number(expectedDurationSeconds).toFixed(3)} 秒`);
  }
  // 新一轮开始前先撤销旧质检凭据。即使后期失败并留下旧 final.mp4，
  // 持久化门也不能把上一次的报告错认成本轮已通过。
  await Promise.all([
    fsp.rm(path.join(outputDir, "audio-quality.json"), { force: true }),
    fsp.rm(path.join(outputDir, "narration.mp3"), { force: true }),
    fsp.rm(path.join(outputDir, "subtitles.srt"), { force: true }),
  ]);
  const narration = selectNarration(detail, shots, media.durationSeconds);
  const narrationBlocker = narration.text ? narrationQualityBlocker(narration.text) : null;
  if (narrationBlocker) throw new Error(`配音语义质量门未通过：${narrationBlocker}`);
  const originality = detail?.remake_plan?.plan?.seedanceWorkflow?.originality || {};
  const discardInputAudio = originality.policy === "strict_full_original"
    && originality.status === "remediated"
    && originality.sourceAudioAllowed === false;
  const tts = narration.text ? await synthesizeNarration(narration.text, outputDir, media.durationSeconds) : null;
  if (discardInputAudio && !tts) throw new Error("完全原创补救缺少原创配音文案，不能回退来源音轨");
  if (!tts && !media.hasAudio) throw new Error("成片既没有原音轨，也没有可用配音文案，已停止交付");
  const ttsMedia = tts ? await probeMedia(tts.mediaPath) : null;
  const narrationTiming = tts ? narrationTimingDecision({
    videoDurationSeconds: media.videoDurationSeconds,
    narrationDurationSeconds: ttsMedia.audioDurationSeconds || ttsMedia.durationSeconds,
    expectedVideoDurationSeconds: expectedDurationSeconds,
  }) : null;
  if (narrationTiming && !narrationTiming.passed) {
    throw new Error(`原创旁白无法完整落入视频时长（${narrationTiming.reason}），未使用 -t 截断`);
  }

  const temporary = `${output}.audio-${process.pid}-${Date.now()}.tmp.mp4`;
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", input];
  if (tts) args.push("-i", tts.mediaPath);
  const wholeDuration = media.videoDurationSeconds.toFixed(3);

  let filter;
  if (tts && media.hasAudio && !discardInputAudio) {
    filter = [
      `[0:a:0]volume=0.18,highpass=f=60,lowpass=f=12000,apad=whole_dur=${wholeDuration}[ambient]`,
      `[1:a:0]loudnorm=I=-16:LRA=7:TP=-1.5,apad=whole_dur=${wholeDuration}[voice]`,
      "[ambient][voice]amix=inputs=2:duration=longest:dropout_transition=0,loudnorm=I=-16:LRA=7:TP=-1.5[aout]",
    ].join(";");
  } else if (tts) {
    filter = `[1:a:0]loudnorm=I=-16:LRA=7:TP=-1.5,apad=whole_dur=${wholeDuration}[aout]`;
  } else {
    filter = `[0:a:0]loudnorm=I=-16:LRA=7:TP=-1.5,apad=whole_dur=${wholeDuration}[aout]`;
  }
  args.push(
    "-filter_complex", filter,
    "-map", "0:v:0", "-map", "[aout]", "-map_metadata", "0",
    "-c:v", "copy", "-c:a", "aac", "-profile:a", "aac_low", "-b:a", "160k",
    "-ar", "44100", "-ac", "2", "-shortest",
    "-movflags", "+faststart", temporary,
  );
  try {
    await run(FFMPEG, args, { timeoutMs: 300_000 });
    const outputMedia = await probeMedia(temporary);
    const durationTarget = expectedDurationSeconds === null
      ? media.videoDurationSeconds : Number(expectedDurationSeconds);
    const finalTimingPassed = outputMedia.hasVideo && outputMedia.hasAudio && outputMedia.audioCodec === "aac"
      && Math.abs(outputMedia.videoDurationSeconds - durationTarget) <= 0.08
      && Math.abs(outputMedia.durationSeconds - durationTarget) <= 0.08
      && outputMedia.audioDurationSeconds >= durationTarget - 0.12
      && (!narrationTiming
        || outputMedia.audioDurationSeconds + 0.05 >= narrationTiming.narrationDurationMs / 1_000);
    if (!finalTimingPassed) throw new Error("最终 AAC 音轨或旁白完整时长验证失败");
    const quality = await detectVolume(temporary);
    const audible = Number.isFinite(quality.meanVolumeDb) && Number.isFinite(quality.maxVolumeDb)
      && quality.meanVolumeDb >= -34 && quality.maxVolumeDb >= -18;
    if (!audible) {
      throw new Error(`音频质检未通过（平均 ${quality.meanVolumeDb ?? "未知"} dB，峰值 ${quality.maxVolumeDb ?? "未知"} dB）`);
    }
    await fsp.rename(temporary, output);
    const outputBuffer = await fsp.readFile(output);
    const { json } = buildAudioQualityReport({
      jobId,
      tts,
      narration: tts?.verifiedNarration || null,
      narrationSource: narration.source,
      narrationTiming,
      finalTimingPassed,
      durationTarget,
      outputMedia,
      media,
      discardInputAudio,
      originality,
      outputSizeBytes: outputBuffer.length,
      outputSha256: createHash("sha256").update(outputBuffer).digest("hex"),
      quality,
      checkedAt: new Date().toISOString(),
    });
    await writePrivateReportAtomic(path.join(outputDir, "audio-quality.json"), json);
    return output;
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

module.exports = {
  buildAudioQualityReport,
  cleanSpokenText,
  detectVolume,
  isGenericTitle,
  isUsableNarration,
  narrationQualityBlocker,
  narrationTimingDecision,
  normalizeNarrationEvidence,
  parseEdgeTtsSrt,
  parseVolume,
  postprocessAudio,
  probeMedia,
  secureOutputScope,
  selectNarration,
  truncateForDuration,
  verifiedSynthesizedNarration,
  writePrivateReportAtomic,
};
