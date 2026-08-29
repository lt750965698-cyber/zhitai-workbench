import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import audio from "../desktop/audio-postprocessor.js";

const {
  cleanSpokenText,
  isUsableNarration,
  narrationQualityBlocker,
  narrationTimingDecision,
  parseVolume,
  selectNarration,
  truncateForDuration,
} = audio;

test("配音文案会去掉链接、标签和分析尾句", () => {
  assert.equal(
    cleanSpokenText("📌 客厅阳台打通 #装修 #小户型 https://example.com ，但缺乏动态叙事元素。"),
    "客厅阳台打通",
  );
  assert.equal(isUsableNarration("无画外配音；用画面建立钩子"), false);
  assert.equal(isUsableNarration("小户型两房变三房，空间立刻通透。"), true);
});

test("优先使用真实配音稿，普通素材则用去标签后的标题", () => {
  const withVoice = { asset: { title: "标题" }, remake_plan: { plan: { copywriting: { voiceoverDraft: "这是成片配音。" } } } };
  assert.deepEqual(selectNarration(withVoice, [], 10), { text: "这是成片配音。", source: "voiceover_draft" });

  const fromTitle = { asset: { title: "客厅阳台打通，小户型两房变三房 #装修 #小户型" }, remake_plan: { plan: { copywriting: {} } } };
  assert.deepEqual(selectNarration(fromTitle, [], 10), { text: "客厅阳台打通，小户型两房变三房", source: "title" });
});

test("泛化标题会退回钩子，并按成片时长截断", () => {
  const detail = { asset: { title: "儿童房-全景-10秒" }, remake_plan: { plan: { copywriting: {
    hook3s: "带绿色扶手的阁楼床缓慢推近，温暖光线让儿童房显得通透又有层次。",
  } } } };
  assert.deepEqual(selectNarration(detail, [], 10), {
    text: "带绿色扶手的阁楼床缓慢推近，温暖光线让儿童房显得通透又有层次。",
    source: "hook",
  });
  assert.ok(truncateForDuration("一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十", 5).length <= 22);
});

test("完全原创补救只选择新旁白，绝不回退来源 voiceoverDraft 或听觉钩子", () => {
  const detail = {
    asset: { title: "墙面装饰板设计" },
    remake_plan: { plan: {
      copywriting: {
        voiceoverDraft: "我怕你",
        hook3s: "视频前3秒重复原片台词作为听觉钩子",
      },
      seedanceWorkflow: { originality: {
        policy: "strict_full_original",
        status: "remediated",
        sourceAudioAllowed: false,
        originalVoiceover: "先看墙面装饰板的比例、材质与光线层次。",
      } },
    } },
  };
  assert.deepEqual(selectNarration(detail, [{ narration: "备用原创分镜旁白。" }], 10), {
    text: "先看墙面装饰板的比例、材质与光线层次。",
    source: "originality_voiceover",
  });
});

test("完全原创音频后期明确丢弃输入音轨并记录审计字段", async () => {
  const source = await readFile(new URL("../desktop/audio-postprocessor.js", import.meta.url), "utf8");
  assert.match(source, /tts && media\.hasAudio && !discardInputAudio/);
  assert.match(source, /完全原创补救缺少原创配音文案，不能回退来源音轨/);
  assert.match(source, /inputAudioDiscarded:\s*discardInputAudio/);
  assert.match(source, /originalityPolicy:\s*originality\.policy/);
});

test("解析 FFmpeg 音量质检结果", () => {
  assert.deepEqual(parseVolume("mean_volume: -16.2 dB\nmax_volume: -1.5 dB"), { meanVolumeDb: -16.2, maxVolumeDb: -1.5 });
  assert.deepEqual(parseVolume("mean_volume: -inf dB\nmax_volume: -inf dB"), { meanVolumeDb: -Infinity, maxVolumeDb: -Infinity });
});

test("配音语义门拒绝分析术语和拍摄占位描述", () => {
  assert.match(narrationQualityBlocker("视频前3秒用听觉钩子抓取注意力"), /分析术语/);
  assert.match(narrationQualityBlocker("想让拍摄对象站着并说话更清楚耐看"), /拍摄占位描述/);
  assert.equal(narrationQualityBlocker("厨房改造先统一动线、收纳和光线。"), null);
});

test("旁白必须完整落入 25 秒，超长或视频时长不符均失败关闭", () => {
  assert.deepEqual(narrationTimingDecision({
    videoDurationSeconds: 25,
    narrationDurationSeconds: 17.25,
    expectedVideoDurationSeconds: 25,
  }), {
    passed: true,
    reason: null,
    videoDurationMs: 25_000,
    narrationDurationMs: 17_250,
    remainingTailMs: 7_750,
  });
  assert.equal(narrationTimingDecision({
    videoDurationSeconds: 25,
    narrationDurationSeconds: 24.98,
    expectedVideoDurationSeconds: 25,
  }).reason, "narration_exceeds_video");
  assert.equal(narrationTimingDecision({
    videoDurationSeconds: 24.7,
    narrationDurationSeconds: 12,
    expectedVideoDurationSeconds: 25,
  }).reason, "video_duration_mismatch");
});

test("音频后期不用 -t 截断旁白，并写入可复算的完整性证据", async () => {
  const source = await readFile(new URL("../desktop/audio-postprocessor.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /"-t",\s*media\.durationSeconds/);
  assert.match(source, /"-shortest"/);
  assert.match(source, /narrationComplete:/);
  assert.match(source, /narrationSha256:/);
  assert.match(source, /narrationDurationMs:/);
  assert.match(source, /finalDurationMs:/);
  assert.match(source, /timingVerified:/);
});
