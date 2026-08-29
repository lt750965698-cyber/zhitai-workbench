import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import audio from "../desktop/audio-postprocessor.js";

const {
  buildAudioQualityReport,
  cleanSpokenText,
  isUsableNarration,
  narrationQualityBlocker,
  narrationTimingDecision,
  normalizeNarrationEvidence,
  parseEdgeTtsSrt,
  parseVolume,
  secureOutputScope,
  selectNarration,
  truncateForDuration,
  verifiedSynthesizedNarration,
  writePrivateReportAtomic,
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
  assert.match(source, /inputAudioDiscarded:\s*Boolean\(discardInputAudio\)/);
  assert.match(source, /originalityPolicy = originality\?\.policy === "strict_full_original"/);
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

test("Edge TTS 字幕必须按顺序反读，规范化后与选中旁白严格一致", async () => {
  const srt = [
    "1", "00:00:00,000 --> 00:00:01,000", "厨房改造先统一", "",
    "2", "00:00:01,000 --> 00:00:02,000", "动线、收纳和光线。", "",
  ].join("\n");
  assert.equal(parseEdgeTtsSrt(srt), "厨房改造先统一动线、收纳和光线。");
  assert.equal(normalizeNarrationEvidence("厨房\r\n 改造"), "厨房 改造");
  assert.throws(() => parseEdgeTtsSrt(srt.replace(/^2$/m, "3")), /顺序 SRT/);
  assert.throws(() => normalizeNarrationEvidence(`旁白\u0000注入`), /控制字符/);

  const directory = await mkdtemp(join(tmpdir(), "zhitai-edge-srt-"));
  const subtitlePath = join(directory, "subtitles.srt");
  try {
    await writeFile(subtitlePath, srt, { mode: 0o600 });
    assert.equal(
      await verifiedSynthesizedNarration(subtitlePath, "厨房改造先统一 动线、收纳和光线。"),
      "厨房改造先统一动线、收纳和光线。",
    );
    await assert.rejects(
      verifiedSynthesizedNarration(subtitlePath, "厨房改造先统一动线和光线。"),
      /与选中旁白不一致/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function reportFixture(overrides = {}) {
  return {
    jobId: "creative_11111111-1111-4111-8111-111111111111",
    tts: { voice: "zh-CN-XiaoxiaoNeural", rate: "+10%" },
    narration: "厨房改造先统一动线、收纳和光线。",
    narrationSource: "originality_voiceover",
    narrationTiming: { passed: true, narrationDurationMs: 4_200 },
    finalTimingPassed: true,
    durationTarget: 10,
    outputMedia: { durationSeconds: 10 },
    media: { hasAudio: true, durationSeconds: 10 },
    discardInputAudio: true,
    originality: { policy: "strict_full_original" },
    outputSizeBytes: 4_096,
    outputSha256: "a".repeat(64),
    quality: { meanVolumeDb: -16, maxVolumeDb: -1.5 },
    checkedAt: "2026-08-30T12:00:00.000Z",
    ...overrides,
  };
}

test("音频质检报告使用固定有界字段，并保留 TTS 字幕验证证据", () => {
  const { report, json } = buildAudioQualityReport(reportFixture());
  assert.deepEqual(Object.keys(report), [
    "schemaVersion", "status", "jobId", "provider", "voice", "rate", "narrationSource", "narration",
    "narrationSha256", "narrationComplete", "narrationVerifiedFromSubtitles", "narrationDurationMs",
    "finalDurationMs", "outputDurationMs", "timingVerified", "inputHadAudio", "inputAudioDiscarded",
    "originalityPolicy", "durationSeconds", "outputSizeBytes", "outputSha256", "meanVolumeDb", "maxVolumeDb",
    "checkedAt",
  ]);
  assert.equal(report.narrationVerifiedFromSubtitles, true);
  assert.equal(report.originalityPolicy, "strict_full_original");
  assert.ok(Buffer.byteLength(json) < 16 * 1024);
  assert.throws(() => buildAudioQualityReport(reportFixture({ jobId: "creative_../../etc" })), /作业 ID/);
  assert.throws(() => buildAudioQualityReport(reportFixture({ narrationSource: "https://attacker.invalid/source" })), /旁白来源/);
  assert.throws(() => buildAudioQualityReport(reportFixture({ tts: { voice: "bad\nvoice", rate: "+10%" } })), /voice/);
});

test("非 TTS 报告明确保持无旁白语义", () => {
  const { report } = buildAudioQualityReport(reportFixture({
    tts: null,
    narration: "不能进入报告的候选文案",
    narrationSource: "voiceover_draft",
    narrationTiming: null,
    discardInputAudio: false,
    originality: { policy: "来自 HTTP 的任意值" },
  }));
  assert.equal(report.provider, "FFmpeg loudnorm");
  assert.equal(report.narrationSource, "none");
  assert.equal(report.narration, null);
  assert.equal(report.narrationComplete, false);
  assert.equal(report.narrationVerifiedFromSubtitles, false);
  assert.equal(report.narrationDurationMs, null);
  assert.equal(report.voice, null);
  assert.equal(report.rate, null);
  assert.equal(report.originalityPolicy, null);
});

test("creative 输出作用域和质检凭据使用私有权限与原子落盘", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-audio-scope-"));
  const directory = join(root, "creative_11111111-1111-4111-8111-111111111111");
  const input = join(directory, "final.visual.mp4");
  const output = join(directory, "final.mp4");
  const reportPath = join(directory, "audio-quality.json");
  try {
    const scope = await secureOutputScope(output, input, { generationRoot: root });
    assert.equal(scope.jobId, "creative_11111111-1111-4111-8111-111111111111");
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    await assert.rejects(
      secureOutputScope(
        join(root, "creative_not-a-uuid", "final.mp4"),
        join(root, "creative_not-a-uuid", "final.visual.mp4"),
        { generationRoot: root },
      ),
      /canonical creative UUID/,
    );
    await assert.rejects(
      secureOutputScope(output, input, { generationRoot: join(root, "other") }),
      /固定 generation 根目录/,
    );
    await writePrivateReportAtomic(reportPath, "{\"status\":\"passed\"}\n");
    assert.equal((await stat(reportPath)).mode & 0o777, 0o600);
    assert.equal(await readFile(reportPath, "utf8"), "{\"status\":\"passed\"}\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
