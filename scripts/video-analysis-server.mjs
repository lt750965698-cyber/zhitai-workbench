#!/usr/bin/env node
/* 织台 V1 视频分析薄适配代理（127.0.0.1:17900）
 * 复用官方 MIT 项目 guimatheus92/mcp-video-analyzer 的 CLI：
 *   转写(whisper/字幕) / 关键帧 / OCR / 媒体元数据 / 时间线
 * 再用 PySceneDetect 提供真实切镜边界，薄适配后写回知识库。
 */
"use strict";

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { analyzeExtractedVideoWithYuanbao } from "../local-agent/analyze.mjs";
import { buildSeedanceWorkflow, normalizeNarration } from "../local-agent/seedance-workflow.mjs";
import { buildVideoReverseBlueprint } from "../local-agent/video-reverse-blueprint.mjs";
import { reverseVideoFramesExternal } from "../local-agent/external-video-reverse.mjs";

const HOST = "127.0.0.1";
const PORT = 17900;
const RUNTIME_ROOT = path.resolve(process.env.ZHITAI_RUNTIME_ROOT
  || path.join(os.homedir(), ".local", "share", "zhitai-runtime"));
const ENGINE_ROOT = path.join(RUNTIME_ROOT, "engines");
const ANALYZER_DIR = process.env.ZHITAI_ANALYZER_DIR
  || path.join(ENGINE_ROOT, "mcp-video-analyzer-current");
const ANALYZER_CLI = path.join(ANALYZER_DIR, "dist", "index.js");
const VISION_SCRIPT = fileURLToPath(new URL("./vision-frame-analysis.swift", import.meta.url));
const SCENE_DETECT_SCRIPT = fileURLToPath(new URL("./scene-detect.py", import.meta.url));
const WHISPERX_WORD_SCRIPT = fileURLToPath(new URL("./whisperx-word-timestamps.py", import.meta.url));
const AUDIO_FEATURE_SCRIPT = fileURLToPath(new URL("./audio-feature-analysis.py", import.meta.url));
const QWEN_VISUAL_SCRIPT = fileURLToPath(new URL("./qwen-visual-analysis.py", import.meta.url));
const CAMERA_MOTION_SCRIPT = fileURLToPath(new URL("./camera-motion-analysis.py", import.meta.url));
const WHISPER_ROOT = path.resolve(process.env.ZHITAI_WHISPER_ROOT
  || path.join(ENGINE_ROOT, "openai-whisper"));
const WHISPER_BIN = process.env.ZHITAI_WHISPER_BIN || path.join(WHISPER_ROOT, "bin", "whisper");
const PYTHON_BIN = process.env.ZHITAI_ANALYSIS_PYTHON || path.join(WHISPER_ROOT, "bin", "python");
const WHISPERX_ROOT = path.resolve(process.env.ZHITAI_WHISPERX_ROOT
  || path.join(ENGINE_ROOT, "whisperx-v3.7.5"));
const WHISPERX_BIN = process.env.ZHITAI_WHISPERX_BIN || path.join(WHISPERX_ROOT, "bin", "whisperx");
const FFMPEG_DIR = process.env.ZHITAI_FFMPEG_DIR || path.join(ENGINE_ROOT, "ffmpeg");
const MLX_VLM_PYTHON = process.env.ZHITAI_MLX_VLM_PYTHON
  || path.join(ENGINE_ROOT, "mlx-vlm-0.6.15", "bin", "python");
const NODE_BIN = process.execPath;
const KB_ROOT = path.resolve(process.env.ZHITAI_KB_ROOT
  || path.join(os.homedir(), "KnowledgeHub", "内容库"));
const MPT_ROOT = process.env.ZHITAI_MPT_ROOT || path.join(ENGINE_ROOT, "MoneyPrinterTurbo");
const MPT_API = process.env.ZHITAI_MPT_API || "http://127.0.0.1:18080";
// 完整分析包含转写、切镜、OCR 与视觉理解；较长视频常会超过旧的 5 分钟上限。
// 仍保留硬超时，避免子进程永久挂住；持久队列会在超时后按退避策略重试。
const requestedAnalyzeTimeoutMs = Number(process.env.ZHITAI_ANALYZE_TIMEOUT_MS || 30 * 60_000);
const ANALYZE_TIMEOUT_MS = Math.max(300_000, Math.min(
  3 * 60 * 60_000,
  Number.isFinite(requestedAnalyzeTimeoutMs) ? requestedAnalyzeTimeoutMs : 30 * 60_000,
));
const persistedRemakes = new Map();

const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".m4v", ".mkv", ".avi", ".flv", ".wmv", ".mpeg", ".mpg", ".m2ts", ".mts", ".3gp", ".ogv"]);

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function resolveVideoPath(input) {
  if (typeof input !== "string" || !input.trim()) return { error: "缺少 videoPath 参数" };
  const expanded = input.replace(/^~(?=\/)/, os.homedir());
  const abs = path.resolve(expanded);
  if (!abs.startsWith(path.resolve(KB_ROOT))) return { error: "只允许分析内容库内的视频（" + KB_ROOT + "）" };
  const ext = path.extname(abs).toLowerCase();
  if (!VIDEO_EXT.has(ext)) return { error: "不支持的文件类型：" + (ext || "无扩展名") };
  return { abs };
}

// 按 videoId 从本地节点下载媒体到系统临时目录，交给现有 runAnalyze
const KB_API = "http://127.0.0.1:17890";
const TMP_DIR = path.join(os.tmpdir(), "zhitai-video-analysis");

async function downloadVideoById(videoId) {
  const url = `${KB_API}/api/v1/kb/videos/${encodeURIComponent(videoId)}/media`;
  let response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  } catch (cause) {
    throw new Error("下载视频失败（本地节点 17890 不可达）：" + (cause instanceof Error ? cause.message : String(cause)));
  }
  if (!response.ok) throw new Error(`下载视频失败：本地节点返回 HTTP ${response.status}（videoId=${videoId}）`);
  if (!response.body) throw new Error("下载视频失败：媒体响应没有内容");
  fs.mkdirSync(TMP_DIR, { recursive: true });
  const safeId = String(videoId).replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
  const file = path.join(TMP_DIR, `${safeId}.mp4`);
  const writer = fs.createWriteStream(file);
  try {
    await new Promise((resolve, reject) => {
      Readable.fromWeb(response.body).pipe(writer);
      writer.on("finish", resolve);
      writer.on("error", reject);
    });
  } catch (cause) {
    throw new Error("下载视频失败（写入临时文件出错）：" + (cause instanceof Error ? cause.message : String(cause)));
  }
  const size = fs.statSync(file).size;
  if (size < 1024) throw new Error("下载的视频文件过小（" + size + " 字节），可能不是有效媒体，请确认该视频可播放");
  return file;
}

async function requestJson(url, options = {}) {
  const { timeoutMs = 30_000, ...fetchOptions } = options;
  const response = await fetch(url, { ...fetchOptions, signal: fetchOptions.signal || AbortSignal.timeout(timeoutMs) });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${url} 返回 HTTP ${response.status}：${payload?.message || payload?.detail || "请求失败"}`);
  return payload;
}

function readRequestJson(req, maxBytes = 1_000_000) {
  return new Promise((resolve, reject) => {
    let raw = "";
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      raw += chunk;
      if (raw.length > maxBytes) {
        settled = true;
        reject(new Error("请求体过大"));
      }
    });
    req.on("end", () => {
      if (settled) return;
      try { settled = true; resolve(JSON.parse(raw || "{}")); }
      catch { settled = true; reject(new Error("请求体不是合法 JSON")); }
    });
    req.on("error", (error) => { if (!settled) { settled = true; reject(error); } });
  });
}

async function submitRemake(input) {
  const videoId = String(input.videoId || "").trim();
  if (!videoId || !/^[A-Za-z0-9._-]{1,120}$/.test(videoId)) throw new Error("缺少或无效的 videoId");
  const detail = await requestJson(`${KB_API}/api/v1/kb/videos/${encodeURIComponent(videoId)}`, { timeoutMs: 15_000 });
  const plan = detail?.remake_plan?.plan || {};
  const script = String(input.script || plan?.copywriting?.voiceoverDraft || detail?.transcript?.text || "").trim().slice(0, 8000);
  if (!script) throw new Error("该视频还没有配音文案，请先完成视频分析");
  const subject = String(input.subject || detail?.asset?.title || "织台复刻草稿").trim().slice(0, 500);
  const videoPath = await downloadVideoById(videoId);
  const materialDir = path.join(MPT_ROOT, "storage", "local_videos");
  await fs.promises.mkdir(materialDir, { recursive: true });
  const materialName = `zhitai-${videoId.replace(/[^A-Za-z0-9._-]/g, "_")}.mp4`;
  await fs.promises.copyFile(videoPath, path.join(materialDir, materialName));
  const duration = Math.max(1, Math.round(Number(plan?.observed?.durationSeconds || detail?.asset?.duration_ms / 1000 || 5)));
  const body = {
    video_subject: subject,
    video_script: script,
    video_aspect: ["9:16", "16:9", "1:1"].includes(input.aspect) ? input.aspect : "9:16",
    video_source: "local",
    video_materials: [{ provider: "local", url: materialName, duration }],
    video_concat_mode: "sequential",
    video_clip_duration: Math.max(1, Math.min(15, Number(input.clipDuration) || 5)),
    video_count: 1,
    voice_name: String(input.voiceName || "zh-CN-XiaoxiaoNeural-Female"),
    voice_rate: Math.max(0.5, Math.min(2, Number(input.voiceRate) || 1)),
    voice_volume: 1,
    bgm_type: "",
    bgm_volume: 0,
    subtitle_enabled: input.subtitleEnabled !== false,
    font_name: "STHeitiMedium.ttc",
    font_size: 60,
    stroke_color: "#000000",
    stroke_width: 1.5,
  };
  const created = await requestJson(`${MPT_API}/api/v1/videos`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    timeoutMs: 30_000,
  });
  const taskId = String(created?.data?.task_id || "");
  if (!taskId) throw new Error("生成引擎未返回 task_id");
  return { ok: true, taskId, videoId, subject, engine: "MoneyPrinterTurbo 1.3.4", status: "processing" };
}

async function getRemakeTask(taskId, videoId = "", subject = "") {
  if (!/^[0-9a-f-]{36}$/i.test(taskId)) throw new Error("无效的生成任务 ID");
  const payload = await requestJson(`${MPT_API}/api/v1/tasks/${encodeURIComponent(taskId)}`, { timeoutMs: 15_000 });
  const task = payload?.data || {};
  const completed = Number(task.state) === 1 && Array.isArray(task.videos) && task.videos.length > 0;
  const failed = Number(task.state) === -1;
  let persisted = persistedRemakes.get(taskId) || null;
  if (completed && videoId && !persisted) {
    const saved = await requestJson(`${KB_API}/api/v1/kb/videos/${encodeURIComponent(videoId)}/remake-output`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskId, subject }),
      timeoutMs: 120_000,
    });
    persisted = saved;
    persistedRemakes.set(taskId, saved);
  }
  return {
    ok: true,
    taskId,
    state: completed ? "completed" : failed ? "failed" : "processing",
    progress: Number(task.progress) || 0,
    error: task.error || null,
    failedStage: task.failed_stage || null,
    warnings: task.warnings || [],
    mediaUrl: persisted?.mediaUrl || null,
    persisted,
  };
}

function runAnalyze(videoPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(NODE_BIN, [
      ANALYZER_CLI, "analyze", videoPath,
      "--detail", "detailed",
      "--ocr-language", "chi_sim+eng",
      "--language", "zh",
    ], {
      cwd: ANALYZER_DIR,
      env: {
        ...process.env,
        // mcp-video-analyzer 0.10.0 不再可靠地自动发现非系统 PATH 内的 ffmpeg/ffprobe。
        PATH: `${FFMPEG_DIR}:${process.env.PATH || ""}`,
        // ffmpeg-static 官方包支持此覆盖；复用织台内置 arm64 二进制，避免更新时再次下载。
        FFMPEG_BIN: path.join(FFMPEG_DIR, "ffmpeg"),
        ...(fs.existsSync(WHISPER_BIN) ? {
          WHISPER_BIN,
          WHISPER_MODEL: process.env.WHISPER_MODEL || "base",
          WHISPER_LANGUAGE: process.env.WHISPER_LANGUAGE || "zh",
        } : {}),
      },
      timeout: ANALYZE_TIMEOUT_MS,
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("error", (e) => reject(new Error("无法启动分析器：" + e.message)));
    child.on("close", (code) => {
      if (code === 0) {
        const first = out.trimStart();
        // CLI 可能输出 ```json 围栏
        const json = first.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
        try {
          resolve(JSON.parse(json));
        } catch {
          reject(new Error("分析器输出不是合法 JSON（前 300 字符：" + json.slice(0, 300) + "）"));
        }
      } else {
        reject(new Error("分析器退出码 " + code + "：stderr 尾部：" + err.slice(-600)));
      }
    });
  });
}

function runVisionAnalysis(frames) {
  const paths = Array.isArray(frames) ? frames.map((frame) => frame?.filePath).filter(Boolean).slice(0, 80) : [];
  if (!paths.length || !fs.existsSync(VISION_SCRIPT)) return Promise.resolve([]);
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/swift", [VISION_SCRIPT, ...paths], { timeout: 120_000 });
    let out = "";
    child.stdout.on("data", (data) => { out += data; });
    child.on("error", () => resolve([]));
    child.on("close", (code) => {
      if (code !== 0) { resolve([]); return; }
      try { resolve(JSON.parse(out)); } catch { resolve([]); }
    });
  });
}

function runSceneDetection(videoPath) {
  if (!fs.existsSync(PYTHON_BIN) || !fs.existsSync(SCENE_DETECT_SCRIPT)) {
    return Promise.resolve({ status: "unavailable", provider: "PySceneDetect", scenes: [] });
  }
  return new Promise((resolve) => {
    const child = spawn(PYTHON_BIN, [SCENE_DETECT_SCRIPT, videoPath], { timeout: 180_000 });
    let out = "";
    child.stdout.on("data", (data) => { out += data; });
    child.on("error", () => resolve({ status: "unavailable", provider: "PySceneDetect", scenes: [] }));
    child.on("close", (code) => {
      if (code !== 0) { resolve({ status: "unavailable", provider: "PySceneDetect", scenes: [] }); return; }
      try { resolve(JSON.parse(out)); }
      catch { resolve({ status: "unavailable", provider: "PySceneDetect", scenes: [] }); }
    });
  });
}

function whisperTimestamp(seconds) {
  const value = Math.max(0, Number(seconds) || 0);
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const secs = value % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${secs.toFixed(3).padStart(6, "0")}` : `${minutes}:${secs.toFixed(3).padStart(6, "0")}`;
}

/** WhisperX 独立引擎：逐词时间码默认可用；只有显式提供 HF token 时才启用说话人区分。 */
async function runWhisperX(videoPath) {
  if (!fs.existsSync(WHISPERX_BIN)) return { status: "unavailable", provider: "WhisperX", segments: [], words: [], diarization: "unavailable" };
  if (!fs.existsSync(WHISPERX_WORD_SCRIPT)) return { status: "unavailable", provider: "WhisperX", segments: [], words: [], diarization: "unavailable", note: "逐词适配脚本缺失" };
  const whisperXPython = path.join(path.dirname(path.dirname(WHISPERX_BIN)), "bin", "python");
  const outputDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "zhitai-whisperx-"));
  const hfToken = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN || "";
  if (!hfToken) {
    try {
      const payload = await new Promise((resolve, reject) => {
        const child = spawn(whisperXPython, [WHISPERX_WORD_SCRIPT, videoPath], {
          env: { ...process.env, PATH: `${FFMPEG_DIR}:${process.env.PATH || ""}` },
          timeout: 600_000,
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (data) => { out += data; });
        child.stderr.on("data", (data) => { err += data; if (err.length > 12_000) err = err.slice(-12_000); });
        child.on("error", (error) => reject(new Error(`WhisperX 无法启动：${error.message}`)));
        child.on("close", (code) => {
          if (code !== 0) { reject(new Error(`WhisperX 退出码 ${code}：${err.slice(-500)}`)); return; }
          try { resolve(JSON.parse(out)); } catch { reject(new Error("WhisperX 逐词输出不是合法 JSON")); }
        });
      });
      return {
        ...payload,
        segments: (Array.isArray(payload?.segments) ? payload.segments : []).map((segment) => ({
          ...segment,
          time: whisperTimestamp(segment?.start),
        })),
      };
    } finally {
      await fs.promises.rm(outputDir, { recursive: true, force: true }).catch(() => {});
    }
  }
  const args = [
    videoPath,
    "--model", process.env.WHISPERX_MODEL || "base",
    "--language", process.env.WHISPERX_LANGUAGE || "zh",
    "--device", "cpu",
    "--compute_type", "int8",
    "--batch_size", "4",
    "--vad_method", "silero",
    "--output_dir", outputDir,
    "--output_format", "json",
    "--verbose", "False",
    "--print_progress", "False",
    "--threads", "4",
  ];
  if (hfToken) args.push("--diarize", "--hf_token", hfToken);
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(WHISPERX_BIN, args, {
        env: { ...process.env, PATH: `${FFMPEG_DIR}:${process.env.PATH || ""}` },
        timeout: 900_000,
      });
      let err = "";
      child.stderr.on("data", (data) => { err += data; if (err.length > 12_000) err = err.slice(-12_000); });
      child.on("error", (error) => reject(new Error(`WhisperX 无法启动：${error.message}`)));
      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`WhisperX 退出码 ${code}：${err.slice(-500)}`)));
    });
    const jsonName = (await fs.promises.readdir(outputDir)).find((name) => name.toLowerCase().endsWith(".json"));
    if (!jsonName) throw new Error("WhisperX 没有生成 JSON 结果");
    const payload = JSON.parse(await fs.promises.readFile(path.join(outputDir, jsonName), "utf8"));
    const segments = (Array.isArray(payload?.segments) ? payload.segments : []).map((segment, index) => {
      const start = Number(segment?.start);
      const end = Number(segment?.end);
      const words = (Array.isArray(segment?.words) ? segment.words : []).map((word) => ({
        word: String(word?.word || "").trim(),
        start: Number.isFinite(Number(word?.start)) ? Number(word.start) : null,
        end: Number.isFinite(Number(word?.end)) ? Number(word.end) : null,
        score: Number.isFinite(Number(word?.score)) ? Number(word.score) : null,
        speaker: word?.speaker || segment?.speaker || null,
      })).filter((word) => word.word);
      return {
        index: index + 1,
        time: whisperTimestamp(start),
        start: Number.isFinite(start) ? start : null,
        end: Number.isFinite(end) ? end : null,
        text: String(segment?.text || "").trim(),
        speaker: segment?.speaker || words.find((word) => word.speaker)?.speaker || null,
        words,
      };
    }).filter((segment) => segment.text);
    const words = segments.flatMap((segment) => segment.words);
    return {
      status: segments.length ? "available" : "unavailable",
      provider: "WhisperX 3.7.5",
      language: payload?.language || "zh",
      segments,
      words,
      alignment: words.some((word) => word.start != null) ? "word" : "segment",
      diarization: hfToken && segments.some((segment) => segment.speaker) ? "available" : "unavailable",
      note: hfToken ? "逐词对齐与说话人区分已请求" : "逐词对齐可用；说话人区分需配置 Hugging Face 授权后启用",
    };
  } finally {
    await fs.promises.rm(outputDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function spawnChecked(command, args, { env = process.env, timeout = 900_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, timeout });
    let out = "";
    let err = "";
    child.stdout.on("data", (data) => { out += data; });
    child.stderr.on("data", (data) => { err += data; if (err.length > 20_000) err = err.slice(-20_000); });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => code === 0 ? resolve({ out, err }) : reject(new Error(`${path.basename(command)} 退出码 ${code}：${err.slice(-600)}`)));
  });
}

async function findNamedFile(root, fileName) {
  const entries = await fs.promises.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && entry.name === fileName) return candidate;
    if (entry.isDirectory()) {
      const nested = await findNamedFile(candidate, fileName);
      if (nested) return nested;
    }
  }
  return null;
}

/** Demucs 分离人声/伴奏，librosa 提取音高、停顿、节奏等可观察特征。 */
async function runAudioAnalysis(videoPath) {
  const python = path.join(path.dirname(path.dirname(WHISPERX_BIN)), "bin", "python");
  if (!fs.existsSync(python) || !fs.existsSync(AUDIO_FEATURE_SCRIPT) || !fs.existsSync(path.join(FFMPEG_DIR, "ffprobe"))) {
    return { status: "unavailable", provider: "Demucs", note: "Demucs、音频特征脚本或 FFmpeg 尚未安装" };
  }
  const outputDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "zhitai-demucs-"));
  const env = { ...process.env, PATH: `${FFMPEG_DIR}:${process.env.PATH || ""}` };
  try {
    await spawnChecked(python, ["-m", "demucs.separate", "--two-stems", "vocals", "-n", "htdemucs", "--device", "cpu", "-o", outputDir, videoPath], { env });
    const vocalsWav = await findNamedFile(outputDir, "vocals.wav");
    const backgroundWav = await findNamedFile(outputDir, "no_vocals.wav");
    if (!vocalsWav || !backgroundWav) throw new Error("Demucs 未生成完整的人声/伴奏文件");
    const featuresRun = await spawnChecked(python, [AUDIO_FEATURE_SCRIPT, vocalsWav, backgroundWav], { env, timeout: 300_000 });
    const features = JSON.parse(featuresRun.out);
    const vocalsM4a = path.join(outputDir, "voice.m4a");
    const backgroundM4a = path.join(outputDir, "accompaniment.m4a");
    await Promise.all([
      spawnChecked(path.join(FFMPEG_DIR, "ffmpeg"), ["-y", "-loglevel", "error", "-i", vocalsWav, "-vn", "-c:a", "aac", "-b:a", "96k", vocalsM4a], { env, timeout: 300_000 }),
      spawnChecked(path.join(FFMPEG_DIR, "ffmpeg"), ["-y", "-loglevel", "error", "-i", backgroundWav, "-vn", "-c:a", "aac", "-b:a", "128k", backgroundM4a], { env, timeout: 300_000 }),
    ]);
    return {
      ...features,
      status: "available",
      stemFiles: { voice: vocalsM4a, accompaniment: backgroundM4a },
      cleanupDir: outputDir,
    };
  } catch (error) {
    await fs.promises.rm(outputDir, { recursive: true, force: true }).catch(() => {});
    return { status: "unavailable", provider: "Demucs", note: error instanceof Error ? error.message : String(error) };
  }
}

async function runQwenVisualAnalysis(frames, scenes) {
  if (!fs.existsSync(MLX_VLM_PYTHON) || !fs.existsSync(QWEN_VISUAL_SCRIPT)) {
    return { status: "unavailable", provider: "Qwen2.5-VL", items: [], note: "MLX 视觉引擎尚未安装" };
  }
  const frameList = Array.isArray(frames) ? frames.filter((frame) => frame?.filePath) : [];
  const sceneList = Array.isArray(scenes) ? scenes : [];
  const selected = sceneList.length
    ? sceneList.map((scene) => nearestFrame(frameList, (Number(scene?.startSeconds) + Number(scene?.endSeconds)) / 2)).filter(Boolean)
    : frameList.slice(0, 8);
  const unique = [...new Map(selected.map((frame) => [String(frame.filePath), frame])).values()].slice(0, 8);
  if (!unique.length) return { status: "unavailable", provider: "Qwen2.5-VL", items: [], note: "没有代表帧" };
  try {
    const run = await spawnChecked(MLX_VLM_PYTHON, [QWEN_VISUAL_SCRIPT, ...unique.map((frame) => frame.filePath)], { timeout: 900_000 });
    const payload = JSON.parse(run.out);
    return {
      ...payload,
      items: (Array.isArray(payload?.items) ? payload.items : []).map((item, index) => ({
        ...item,
        path: unique[index]?.filePath || item?.path || null,
        time: unique[index]?.time || null,
      })),
    };
  } catch (error) {
    return { status: "unavailable", provider: "Qwen2.5-VL", items: [], note: error instanceof Error ? error.message : String(error) };
  }
}

async function runCameraMotion(videoPath, scenes, durationSeconds) {
  if (!fs.existsSync(PYTHON_BIN) || !fs.existsSync(CAMERA_MOTION_SCRIPT)) {
    return { status: "unavailable", provider: "OpenCV global optical flow", scenes: [], note: "运镜分析器尚未安装" };
  }
  const normalizedScenes = Array.isArray(scenes) && scenes.length ? scenes : [{ startSeconds: 0, endSeconds: Number(durationSeconds) || 0 }];
  try {
    const run = await spawnChecked(PYTHON_BIN, [CAMERA_MOTION_SCRIPT, videoPath, JSON.stringify(normalizedScenes)], { timeout: 300_000 });
    return JSON.parse(run.out);
  } catch (error) {
    return { status: "unavailable", provider: "OpenCV global optical flow", scenes: [], note: error instanceof Error ? error.message : String(error) };
  }
}

function timeSeconds(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.max(0, value);
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const parts = raw.split(":").map(Number);
  if (!parts.length || parts.some((part) => !Number.isFinite(part))) return null;
  return parts.reduce((total, part) => total * 60 + part, 0);
}

function cleanLines(values, limit = 20) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))].slice(0, limit);
}

function structuredNarration(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return normalizeNarration(value);
  if (Array.isArray(value)) return cleanLines(value.map(structuredNarration), 8).join("；");
  if (typeof value === "object") {
    const preferred = [value.text, value.visual, value.auditory, value.content, value.hook]
      .map(structuredNarration).filter(Boolean);
    if (preferred.length) return cleanLines(preferred, 8).join("；");
    return cleanLines(Object.values(value).map(structuredNarration), 8).join("；");
  }
  return "";
}

function insightLines(value, limit = 5) {
  if (Array.isArray(value)) return cleanLines(value.map(structuredNarration), limit);
  const single = structuredNarration(value);
  return single ? [single] : [];
}

function usableOcrEntries(entries) {
  return entries.filter((item) => {
    const text = String(item?.text || item?.ocrText || "").trim();
    const confidence = Number(item?.confidence);
    if (!text) return false;
    if (Number.isFinite(confidence) && confidence < 65) return false;
    const meaningful = (text.match(/[\p{L}\p{N}\u3400-\u9fff]/gu) || []).length;
    return meaningful >= 2 && meaningful / Math.max(1, text.length) >= 0.25;
  });
}

function transcriptAtSecond(entries, second) {
  if (!Number.isFinite(second)) return null;
  const timed = entries
    .map((item) => ({ item, second: timeSeconds(item?.time) }))
    .filter((entry) => entry.second != null)
    .sort((a, b) => a.second - b.second);
  let active = null;
  for (const entry of timed) {
    if (entry.second > second) break;
    active = entry.item;
  }
  return String(active?.text || "").trim() || null;
}

function transcriptForRange(entries, start, end) {
  const lines = entries
    .filter((item) => {
      const second = timeSeconds(item?.time);
      return second != null && second >= start && second < end;
    })
    .map((item) => String(item?.text || "").trim())
    .filter(Boolean);
  return cleanLines(lines, 20).join(" ") || transcriptAtSecond(entries, start);
}

function nearestFrame(frames, second) {
  return frames.reduce((best, frame) => {
    const frameSecond = timeSeconds(frame?.time);
    if (frameSecond == null) return best;
    const distance = Math.abs(frameSecond - second);
    if (!best || distance < best.distance) return { frame, distance };
    return best;
  }, null)?.frame ?? null;
}

/** 基于可观察的 ASR/OCR/时间点生成首版复刻计划；未知机位/BGM 明确留空，不虚构。 */
function buildRemakePlan(result) {
  const metadata = result?.metadata || {};
  const transcript = Array.isArray(result?.transcript) ? result.transcript : [];
  const frames = Array.isArray(result?.frames) ? result.frames : [];
  const ocr = Array.isArray(result?.ocrResults) ? result.ocrResults : [];
  const usableOcr = usableOcrEntries(ocr);
  const timeline = Array.isArray(result?.timeline) ? result.timeline : [];
  const visionFrames = Array.isArray(result?.visionFrames) ? result.visionFrames : [];
  const semanticFrames = result?.visualSemantics?.status === "available" && Array.isArray(result?.visualSemantics?.items) ? result.visualSemantics.items : [];
  const motionScenes = result?.cameraMotion?.status === "available" && Array.isArray(result?.cameraMotion?.scenes) ? result.cameraMotion.scenes : [];
  const detectedScenes = result?.sceneDetection?.status === "available" && Array.isArray(result?.sceneDetection?.scenes)
    ? result.sceneDetection.scenes
    : [];
  const audioAnalysis = result?.audioAnalysis?.status === "available" ? result.audioAnalysis : null;
  const duration = Number(metadata.duration || 0) || null;
  const yuanbaoInsight = result?.yuanbaoInsight && typeof result.yuanbaoInsight === "object" ? result.yuanbaoInsight : null;
  const narration = cleanLines(transcript.map((item) => normalizeNarration(item?.text)), 100);
  const screenText = cleanLines(usableOcr.map((item) => item?.text || item?.ocrText), 100);
  const timed = [...frames].sort((a, b) => (timeSeconds(a?.time) ?? 0) - (timeSeconds(b?.time) ?? 0));
  const shotSeeds = detectedScenes.length
    ? detectedScenes.map((scene) => ({
      startSeconds: Number(scene.startSeconds),
      endSeconds: Number(scene.endSeconds),
      frame: nearestFrame(timed, (Number(scene.startSeconds) + Number(scene.endSeconds)) / 2),
      source: "PySceneDetect AdaptiveDetector",
    }))
    : timed.map((frame, index) => ({
      startSeconds: timeSeconds(frame?.time),
      endSeconds: timeSeconds(timed[index + 1]?.time) ?? duration,
      frame,
      source: "mcp-video-analyzer 关键帧回退",
    }));
  const shotPlan = shotSeeds.map((seed, index) => {
    const start = Number.isFinite(seed.startSeconds) ? seed.startSeconds : 0;
    const end = Number.isFinite(seed.endSeconds) ? seed.endSeconds : (duration ?? start);
    const frame = seed.frame;
    const ocrAtTime = usableOcr.filter((item) => {
      const second = timeSeconds(item?.time);
      return second != null && second >= start && second < end;
    });
    const vision = visionFrames.find((item) => String(item?.path || "") === String(frame?.filePath || ""));
    const semantic = semanticFrames.find((item) => String(item?.path || "") === String(frame?.filePath || ""));
    const motion = motionScenes[index] || null;
    const semanticShotSize = semantic?.shotSize && semantic.shotSize !== "unknown" ? semantic.shotSize : null;
    const semanticAngle = semantic?.cameraAngle && semantic.cameraAngle !== "unknown" ? semantic.cameraAngle : null;
    const semanticSceneText = `${semantic?.subject || ""} ${semantic?.setting || ""} ${semantic?.composition || ""}`;
    const roomOverview = /房间|卧室|客厅|厨房|室内|全景|整体|room|bedroom|interior|whole|entire/i.test(semanticSceneText);
    const validatedShotSize = roomOverview && ["extreme_close_up", "close_up"].includes(semanticShotSize)
      ? (vision?.shotSize && vision.shotSize !== "unknown" ? vision.shotSize : "wide")
      : semanticShotSize ?? vision?.shotSize ?? null;
    return {
      index: index + 1,
      startSeconds: start,
      endSeconds: end,
      onScreenText: cleanLines(ocrAtTime.map((item) => item?.text || item?.ocrText), 8).join(" ") || null,
      narration: normalizeNarration(transcriptForRange(transcript, start, end)),
      shotSize: validatedShotSize,
      cameraAngle: semanticAngle ?? vision?.cameraAngle ?? null,
      cameraMovement: motion?.movement && motion.movement !== "unknown" ? motion.movement : null,
      composition: semantic?.composition && semantic.composition !== "unknown" ? semantic.composition : (Array.isArray(vision?.faces) && vision.faces.length ? "检测到人脸位置构图" : null),
      lighting: semantic?.lighting && semantic.lighting !== "unknown" ? semantic.lighting : null,
      subject: semantic?.subject && semantic.subject !== "unknown" ? semantic.subject : null,
      setting: semantic?.setting && semantic.setting !== "unknown" ? semantic.setting : null,
      sceneLabels: vision?.sceneLabels ?? [],
      confidence: semantic?.confidence ?? motion?.confidence ?? null,
      evidence: `${seed.source}；${semantic?.evidence || (vision?.status === "available" ? "Apple Vision 代表帧观察" : "视觉语义尚未确认")}；${roomOverview && ["extreme_close_up", "close_up"].includes(semanticShotSize) ? "镜头校验：整屋画面不能标为特写，已降为广景；" : ""}${motion?.evidence || "运镜证据不足"}`,
    };
  });
  const observedHook = transcript.find((item) => (timeSeconds(item?.time) ?? 999) <= 3)?.text
    || usableOcr.find((item) => (timeSeconds(item?.time) ?? 999) <= 3)?.text
    || usableOcr.find((item) => (timeSeconds(item?.time) ?? 999) <= 3)?.ocrText
    || narration[0] || screenText[0] || null;
  const hookCandidate = structuredNarration(yuanbaoInsight?.hook3s || observedHook) || null;
  const lastCopy = normalizeNarration(narration.at(-1) || screenText.at(-1)) || null;
  const ratio = metadata.width && metadata.height ? `${metadata.width}:${metadata.height}` : null;
  const spokenCharacters = narration.join("").replace(/[^\p{L}\p{N}\u3400-\u9fff]/gu, "").length;
  const charactersPerMinute = duration ? Math.round((spokenCharacters / duration) * 60) : null;
  const pace = charactersPerMinute == null ? null : charactersPerMinute < 180 ? "偏慢" : charactersPerMinute <= 320 ? "中等" : "偏快";
  const plan = {
    schemaVersion: 2,
    generatedAt: new Date().toISOString(),
    observed: {
      durationSeconds: duration,
      width: metadata.width ?? null,
      height: metadata.height ?? null,
      aspectRatio: ratio,
      fps: metadata.fps ?? null,
      videoCodec: metadata.videoCodec ?? null,
      audioCodec: metadata.audioCodec ?? null,
      hasAudio: metadata.hasAudio ?? null,
      transcript: narration,
      onScreenText: screenText,
      keyframeCount: frames.length,
      ocrCount: ocr.length,
      usableOcrCount: usableOcr.length,
      sceneCount: detectedScenes.length || null,
      sceneDetector: detectedScenes.length ? "PySceneDetect AdaptiveDetector" : null,
    },
    structure: {
      opening: { range: "0-3s", content: hookCandidate },
      body: { range: duration ? `3-${Math.max(3, Math.round(duration - 3))}s` : null, content: cleanLines([...narration, ...screenText], 12) },
      ending: { range: duration ? `${Math.max(0, Math.round(duration - 3))}-${Math.round(duration)}s` : null, content: lastCopy },
    },
    copywriting: {
      hook3s: hookCandidate,
      voiceoverDraft: narration.join("\n") || null,
      subtitleDraft: narration.join("\n") || screenText.join("\n") || null,
      publishCopy: typeof yuanbaoInsight?.summary === "string" && yuanbaoInsight.summary.trim()
        ? yuanbaoInsight.summary.trim()
        : narration.join("\n") || result?.sourceTitle || null,
      coverTextCandidates: cleanLines([...screenText, ...narration], 3),
      cta: lastCopy,
    },
    shotPlan,
    audioPlan: {
      voiceStyle: yuanbaoInsight?.voiceoverStyle ?? audioAnalysis?.voice?.styleObserved ?? null,
      pitchMedianHz: audioAnalysis?.voice?.pitchMedianHz ?? null,
      pauseRatio: audioAnalysis?.voice?.silenceRatio ?? null,
      pace,
      charactersPerMinute,
      bgm: audioAnalysis?.bgmIdentification?.title ?? null,
      bgmTempoBpm: audioAnalysis?.background?.tempoBpm ?? null,
      backgroundPresence: audioAnalysis?.background?.presence ?? null,
      soundEffects: [],
      note: audioAnalysis
        ? `${audioAnalysis.provider}；人声/伴奏已分离，音高、停顿和节奏为可观察特征；BGM 曲名只有指纹库匹配后才能确认`
        : metadata.hasAudio ? "检测到音轨；音频分离或特征分析暂不可用" : "未检测到音轨",
    },
    audience: [],
    reusableElements: cleanLines([
      ...(Array.isArray(yuanbaoInsight?.reusableElements) ? yuanbaoInsight.reusableElements : []),
      hookCandidate,
      ...screenText.slice(0, 3),
    ], 5),
    propagationHypotheses: insightLines(yuanbaoInsight?.propagationHypotheses, 5).length
      ? insightLines(yuanbaoInsight.propagationHypotheses, 5)
      : hookCandidate ? ["前三秒存在可复用的信息钩子（内容潜力推测，非爆火因果）"] : [],
    yuanbaoInsight,
    unavailable: [
      ...(detectedScenes.length ? [] : ["完整镜头切分"]),
      ...(shotPlan.some((shot) => shot.shotSize) ? [] : ["景别"]),
      ...(shotPlan.some((shot) => shot.cameraAngle) ? [] : ["拍摄角度"]),
      ...(shotPlan.some((shot) => shot.cameraMovement) ? [] : ["运镜"]),
      ...(shotPlan.some((shot) => shot.composition) ? [] : ["精确构图"]),
      ...(shotPlan.some((shot) => shot.lighting) ? [] : ["光线"]),
      ...(audioAnalysis ? [] : ["配音声学特征"]),
      ...(audioAnalysis?.bgmIdentification?.title ? [] : ["BGM 曲目"]),
      "评论正文", "播放量与留存",
    ],
    timeline,
  };
  plan.reverseBlueprint = buildVideoReverseBlueprint(result, shotPlan);
  plan.sourceOrigin = plan.reverseBlueprint.originAssessment;
  plan.seedanceWorkflow = buildSeedanceWorkflow({
    title: result?.sourceTitle || metadata?.title,
    sourceShots: shotPlan,
    hook: hookCandidate,
    cta: lastCopy,
    sourceDurationSeconds: duration,
    averageWatchSeconds: result?.performanceEvidence?.averageWatchSeconds ?? result?.performance?.averageWatchSeconds,
    completionRate: result?.performanceEvidence?.completionRate ?? result?.performance?.completionRate,
    platform: result?.platform ?? result?.performanceEvidence?.platform,
    sourceOrigin: plan.sourceOrigin,
    reverseBlueprint: plan.reverseBlueprint,
    sourceVideoAvailable: Boolean(result?.sourceTitle || result?.sourceVideoAvailable),
  });
  return plan;
}

async function persistAnalysis(videoId, result, remakePlan) {
  const response = await fetch(`${KB_API}/api/v1/kb/videos/${encodeURIComponent(videoId)}/analysis`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ result, remakePlan }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) throw new Error(payload?.message || payload?.error || `HTTP ${response.status}`);
  return payload;
}

function evenlyPick(items, limit = 5) {
  if (items.length <= limit) return items;
  const picked = [];
  for (let index = 0; index < limit; index += 1) {
    picked.push(items[Math.round((index * (items.length - 1)) / (limit - 1))]);
  }
  return picked;
}

async function runExternalVideoReverse(input) {
  const videoId = String(input?.videoId || "").trim();
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(videoId)) throw new Error("缺少或无效的 videoId");
  if (input?.confirmPublic !== true) throw new Error("只允许用户明确确认的公开视频进入外站增强");
  const detail = await requestJson(`${KB_API}/api/v1/kb/videos/${encodeURIComponent(videoId)}`, { timeoutMs: 15_000 });
  const frames = evenlyPick(Array.isArray(detail?.analysis_frames) ? detail.analysis_frames : [], 5);
  if (!frames.length) throw new Error("还没有已保存关键帧，请先点“开始分析”");
  const frameDataUrls = [];
  for (const frame of frames) {
    const mediaUrl = String(frame?.mediaUrl || "");
    if (!mediaUrl.startsWith("/api/v1/kb/videos/")) continue;
    const response = await fetch(`${KB_API}${mediaUrl}`, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`读取关键帧失败（HTTP ${response.status}）`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (!bytes.length || bytes.length > 4_000_000) throw new Error("关键帧大小异常，未发送外站");
    const type = String(response.headers.get("content-type") || "image/jpeg").split(";")[0];
    frameDataUrls.push(`data:${type};base64,${bytes.toString("base64")}`);
  }
  const insight = await reverseVideoFramesExternal({
    frameDataUrls,
    title: detail?.asset?.title || videoId,
  });
  const saved = await requestJson(`${KB_API}/api/v1/kb/videos/${encodeURIComponent(videoId)}/external-prompt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(insight),
    timeoutMs: 30_000,
  });
  return { ok: true, videoId, externalInsight: saved?.externalInsight || insight, persisted: Boolean(saved?.ok) };
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://" + HOST + ":" + PORT);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    });
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    const analyzerReady = fs.existsSync(ANALYZER_CLI);
    sendJson(res, 200, {
      ok: true,
      service: "zhitai-video-analysis-proxy",
      analyzer: "mcp-video-analyzer",
      analyzerReady,
      analyzerPath: ANALYZER_CLI,
      note: analyzerReady ? "可分析：转写/关键帧/OCR/媒体元数据" : "mcp-video-analyzer 未安装，等待配置",
      whisperReady: fs.existsSync(WHISPER_BIN),
      whisperXReady: fs.existsSync(WHISPERX_BIN),
      whisperXDiarizationReady: Boolean(process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN),
      demucsReady: fs.existsSync(path.join(path.dirname(path.dirname(WHISPERX_BIN)), "bin", "demucs")) && fs.existsSync(path.join(FFMPEG_DIR, "ffprobe")),
      qwenVisualReady: fs.existsSync(MLX_VLM_PYTHON) && fs.existsSync(QWEN_VISUAL_SCRIPT),
      cameraMotionReady: fs.existsSync(PYTHON_BIN) && fs.existsSync(CAMERA_MOTION_SCRIPT),
      sceneDetectReady: fs.existsSync(PYTHON_BIN) && fs.existsSync(SCENE_DETECT_SCRIPT),
      remakeEngineInstalled: fs.existsSync(path.join(MPT_ROOT, ".venv", "bin", "uvicorn")),
      remakeEngine: "MoneyPrinterTurbo 1.3.4",
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/external-analyze") {
    readRequestJson(req, 100_000)
      .then((input) => runExternalVideoReverse(input))
      .then((payload) => sendJson(res, 200, payload))
      .catch((cause) => sendJson(res, 502, { ok: false, error: cause instanceof Error ? cause.message : String(cause) }));
    return;
  }

  if (req.method === "POST" && url.pathname === "/remake") {
    readRequestJson(req)
      .then((input) => submitRemake(input))
      .then((payload) => sendJson(res, 202, payload))
      .catch((cause) => sendJson(res, 502, {
        ok: false,
        error: `复刻生成任务创建失败：${cause instanceof Error ? cause.message : String(cause)}`,
      }));
    return;
  }

  const remakeTaskMatch = url.pathname.match(/^\/remake\/tasks\/([0-9a-f-]{36})$/i);
  if (req.method === "GET" && remakeTaskMatch) {
    getRemakeTask(
      remakeTaskMatch[1],
      url.searchParams.get("videoId") || "",
      url.searchParams.get("subject") || "",
    )
      .then((payload) => sendJson(res, 200, payload))
      .catch((cause) => sendJson(res, 502, {
        ok: false,
        error: `读取复刻任务失败：${cause instanceof Error ? cause.message : String(cause)}`,
      }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/media") {
    // 关键帧图片服务：只允许读取 mcp-video-analyzer 在系统临时目录内生成的帧
    const filePath = url.searchParams.get("path") || "";
    const tmpBase = path.resolve(os.tmpdir(), "mcp-video-analyzer");
    const abs = path.resolve(filePath);
    if (!abs.startsWith(tmpBase + path.sep)) { sendJson(res, 403, { ok: false, error: "只允许访问分析器临时目录内的帧" }); return; }
    fs.readFile(abs, (err, data) => {
      if (err) { sendJson(res, 404, { ok: false, error: "帧文件不存在或已清理" }); return; }
      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      });
      res.end(data);
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/analyze") {
    let raw = "";
    req.on("data", (d) => { raw += d; if (raw.length > 1_000_000) req.destroy(); });
    req.on("end", async () => {
      let input;
      try { input = JSON.parse(raw || "{}"); } catch { sendJson(res, 400, { ok: false, error: "请求体不是合法 JSON" }); return; }
      // videoId 优先：从本地节点下载媒体到临时目录再分析；videoPath 兼容保留
      let videoPath = null;
      let source = null;
      let sourceTitle = null;
      let sourceDetail = null;
      if (typeof input.videoId === "string" && input.videoId.trim()) {
        source = input.videoId.trim();
        try {
          sourceDetail = await requestJson(`${KB_API}/api/v1/kb/videos/${encodeURIComponent(source)}`, { timeoutMs: 15_000 });
          sourceTitle = String(sourceDetail?.asset?.title || "").trim() || null;
          videoPath = await downloadVideoById(source);
        } catch (cause) {
          sendJson(res, 502, { ok: false, error: cause instanceof Error ? cause.message : String(cause) });
          return;
        }
      } else if (typeof input.videoPath === "string" && input.videoPath.trim()) {
        const { error, abs } = resolveVideoPath(input.videoPath);
        if (error) { sendJson(res, 400, { ok: false, error }); return; }
        videoPath = abs;
        source = abs;
      } else {
        sendJson(res, 400, { ok: false, error: "缺少 videoId 或 videoPath 参数" });
        return;
      }
      runAnalyze(videoPath)
        .then(async (result) => {
          result.sourceTitle = sourceTitle;
          const [visionFrames, sceneDetection, whisperX, audioAnalysis] = await Promise.all([
            runVisionAnalysis(result.frames),
            runSceneDetection(videoPath),
            runWhisperX(videoPath).catch((error) => ({ status: "unavailable", provider: "WhisperX", segments: [], words: [], diarization: "unavailable", note: error.message })),
            runAudioAnalysis(videoPath),
          ]);
          result.visionFrames = visionFrames;
          result.sceneDetection = sceneDetection;
          result.whisperX = whisperX;
          result.audioAnalysis = audioAnalysis;
          if (whisperX.status === "available" && whisperX.segments.length) {
            result.transcript = whisperX.segments;
            result.wordTranscript = whisperX.words;
            result.transcriptProvider = whisperX.provider;
          } else {
            result.transcriptProvider = "mcp-video-analyzer / OpenAI Whisper";
            result.warnings = [...(Array.isArray(result.warnings) ? result.warnings : []), `WhisperX 逐词对齐不可用：${whisperX.note || "未知原因"}`];
          }
          [result.visualSemantics, result.cameraMotion] = await Promise.all([
            runQwenVisualAnalysis(result.frames, sceneDetection?.scenes),
            runCameraMotion(videoPath, sceneDetection?.scenes, result?.metadata?.duration),
          ]);
          let yuanbaoInsight = null;
          try { yuanbaoInsight = await analyzeExtractedVideoWithYuanbao(result, { timeoutMs: 12_000 }); }
          catch { yuanbaoInsight = null; }
          result.yuanbaoInsight = yuanbaoInsight;
          result.yuanbaoInsightStatus = yuanbaoInsight ? "available" : "unavailable";
          const remakePlan = buildRemakePlan(result);
          const savedExternalInsight = sourceDetail?.remake_plan?.plan?.externalVideoInsight;
          if (savedExternalInsight && typeof savedExternalInsight === "object") remakePlan.externalVideoInsight = savedExternalInsight;
          remakePlan.yuanbaoInsight = yuanbaoInsight;
          let persisted = null;
          let persistWarning = null;
          try {
            if (typeof input.videoId === "string" && input.videoId.trim()) {
              try { persisted = await persistAnalysis(input.videoId.trim(), result, remakePlan); }
              catch (cause) { persistWarning = `分析完成，但写回知识库失败：${cause instanceof Error ? cause.message : String(cause)}`; }
            }
          } finally {
            if (audioAnalysis?.cleanupDir) await fs.promises.rm(audioAnalysis.cleanupDir, { recursive: true, force: true }).catch(() => {});
            if (result.audioAnalysis) {
              delete result.audioAnalysis.cleanupDir;
              delete result.audioAnalysis.stemFiles;
            }
          }
          sendJson(res, 200, {
            ok: true,
            videoId: typeof input.videoId === "string" ? input.videoId : null,
            videoPath,
            result,
            remakePlan,
            persisted,
            persistWarning,
          });
        })
        .catch((e) => sendJson(res, 502, { ok: false, error: e.message }));
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: "not_found" });
});

server.listen(PORT, HOST, () => {
  process.stdout.write("zhitai-video-analysis-proxy listening on http://" + HOST + ":" + PORT + "\n");
});
