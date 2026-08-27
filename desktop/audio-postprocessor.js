#!/usr/bin/env node
"use strict";

const fsp = require("node:fs/promises");
const { createHash } = require("node:crypto");
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
    "-v", "error", "-show_entries", "format=duration:stream=index,codec_type,codec_name",
    "-of", "json", filePath,
  ], { timeoutMs: 30_000 });
  const payload = JSON.parse(out || "{}");
  const streams = Array.isArray(payload.streams) ? payload.streams : [];
  return {
    durationSeconds: Math.max(0.1, Number(payload?.format?.duration) || 0),
    hasVideo: streams.some((stream) => stream.codec_type === "video"),
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
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
  await run(EDGE_TTS, [
    "--text", text,
    "--voice", DEFAULT_VOICE,
    "--rate", rate,
    "--volume", "+0%",
    "--write-media", mediaPath,
    "--write-subtitles", subtitlePath,
  ], { timeoutMs: 180_000 });
  const result = await fsp.stat(mediaPath).catch(() => null);
  if (!result?.isFile() || result.size < 1_024) throw new Error("织台语音引擎没有生成有效配音");
  return { mediaPath, subtitlePath, voice: DEFAULT_VOICE, rate };
}

async function postprocessAudio({ input, output, detail, shots = [] }) {
  const media = await probeMedia(input);
  if (!media.hasVideo) throw new Error("待后期文件没有可用视频轨");
  await fsp.mkdir(path.dirname(output), { recursive: true });
  // 新一轮开始前先撤销旧质检凭据。即使后期失败并留下旧 final.mp4，
  // 持久化门也不能把上一次的报告错认成本轮已通过。
  await Promise.all([
    fsp.rm(path.join(path.dirname(output), "audio-quality.json"), { force: true }),
    fsp.rm(path.join(path.dirname(output), "narration.mp3"), { force: true }),
    fsp.rm(path.join(path.dirname(output), "subtitles.srt"), { force: true }),
  ]);
  const narration = selectNarration(detail, shots, media.durationSeconds);
  const narrationBlocker = narrationQualityBlocker(narration.text);
  if (narrationBlocker) throw new Error(`配音语义质量门未通过：${narrationBlocker}`);
  const originality = detail?.remake_plan?.plan?.seedanceWorkflow?.originality || {};
  const discardInputAudio = originality.policy === "strict_full_original"
    && originality.status === "remediated"
    && originality.sourceAudioAllowed === false;
  const tts = narration.text ? await synthesizeNarration(narration.text, path.dirname(output), media.durationSeconds) : null;
  if (discardInputAudio && !tts) throw new Error("完全原创补救缺少原创配音文案，不能回退来源音轨");
  if (!tts && !media.hasAudio) throw new Error("成片既没有原音轨，也没有可用配音文案，已停止交付");

  const temporary = `${output}.audio-${process.pid}-${Date.now()}.tmp.mp4`;
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", input];
  if (tts) args.push("-i", tts.mediaPath);

  let filter;
  if (tts && media.hasAudio && !discardInputAudio) {
    filter = [
      "[0:a:0]volume=0.18,highpass=f=60,lowpass=f=12000,apad[ambient]",
      "[1:a:0]loudnorm=I=-16:LRA=7:TP=-1.5,apad[voice]",
      "[ambient][voice]amix=inputs=2:duration=first:dropout_transition=0,loudnorm=I=-16:LRA=7:TP=-1.5[aout]",
    ].join(";");
  } else if (tts) {
    filter = "[1:a:0]loudnorm=I=-16:LRA=7:TP=-1.5,apad[aout]";
  } else {
    filter = "[0:a:0]loudnorm=I=-16:LRA=7:TP=-1.5[aout]";
  }
  args.push(
    "-filter_complex", filter,
    "-map", "0:v:0", "-map", "[aout]", "-map_metadata", "0",
    "-c:v", "copy", "-c:a", "aac", "-profile:a", "aac_low", "-b:a", "160k",
    "-ar", "44100", "-ac", "2", "-t", media.durationSeconds.toFixed(3),
    "-movflags", "+faststart", temporary,
  );
  try {
    await run(FFMPEG, args, { timeoutMs: 300_000 });
    const quality = await detectVolume(temporary);
    const audible = Number.isFinite(quality.meanVolumeDb) && Number.isFinite(quality.maxVolumeDb)
      && quality.meanVolumeDb >= -34 && quality.maxVolumeDb >= -18;
    if (!audible) {
      throw new Error(`音频质检未通过（平均 ${quality.meanVolumeDb ?? "未知"} dB，峰值 ${quality.maxVolumeDb ?? "未知"} dB）`);
    }
    await fsp.rename(temporary, output);
    const outputBuffer = await fsp.readFile(output);
    const report = {
      status: "passed",
      jobId: /^creative_[0-9a-f-]{36}$/i.test(path.basename(path.dirname(output)))
        ? path.basename(path.dirname(output))
        : null,
      provider: tts ? "MoneyPrinterTurbo Edge TTS + FFmpeg" : "FFmpeg loudnorm",
      voice: tts?.voice || null,
      rate: tts?.rate || null,
      narrationSource: narration.source,
      narration: narration.text || null,
      inputHadAudio: media.hasAudio,
      inputAudioDiscarded: discardInputAudio,
      originalityPolicy: originality.policy || null,
      durationSeconds: media.durationSeconds,
      outputSizeBytes: outputBuffer.length,
      outputSha256: createHash("sha256").update(outputBuffer).digest("hex"),
      ...quality,
      checkedAt: new Date().toISOString(),
    };
    await fsp.writeFile(path.join(path.dirname(output), "audio-quality.json"), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return output;
  } catch (error) {
    await fsp.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

module.exports = {
  cleanSpokenText,
  detectVolume,
  isGenericTitle,
  isUsableNarration,
  narrationQualityBlocker,
  parseVolume,
  postprocessAudio,
  probeMedia,
  selectNarration,
  truncateForDuration,
};
