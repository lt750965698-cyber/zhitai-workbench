import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getVideoDetail, openKbDb, persistMediaAnalysis } from "../local-agent/kb.mjs";

test("媒体分析会写回数据库与复刻内容包，分镜优先使用配音稿", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-analysis-"));
  const packagePath = join(root, "package");
    const dbPath = join(root, "kb.sqlite");
    await mkdir(packagePath, { recursive: true });
    const sourceFrame = join(root, "frame-0.jpg");
    await writeFile(sourceFrame, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    const voiceStem = join(root, "voice.m4a");
    const accompanimentStem = join(root, "accompaniment.m4a");
    await writeFile(voiceStem, Buffer.from("voice"));
    await writeFile(accompanimentStem, Buffer.from("accompaniment"));
    const db = openKbDb(dbPath);

  try {
    db.prepare(
      "INSERT INTO video_asset (id,title,package_path,file_path,created_at,updated_at) VALUES (?,?,?,?,?,?)",
    ).run("asset-1", "真实样例", packagePath, join(packagePath, "video.mp4"), new Date().toISOString(), new Date().toISOString());

    const result = {
      metadata: { duration: 4, width: 1080, height: 1920, fps: 30 },
      transcriptProvider: "WhisperX 3.7.5",
      transcript: [{ time: "0:00.000", start: 0, end: 3.5, text: "这是真实配音文案", words: [{ word: "真实", start: 0.2, end: 0.5, score: 0.9 }] }],
      wordTranscript: [{ word: "真实", start: 0.2, end: 0.5, score: 0.9 }],
      whisperX: { alignment: "word", diarization: "unavailable", note: "逐词对齐可用" },
      audioAnalysis: {
        status: "available",
        provider: "Demucs 4.0.1 + librosa 0.10.2",
        voice: { pitchMedianHz: 133.8, silenceRatio: 0.15, styleObserved: "偏低沉、语流连续" },
        background: { tempoBpm: 123, presence: "检测到伴奏/环境声" },
        bgmIdentification: { status: "unavailable", title: null },
        stemFiles: { voice: voiceStem, accompaniment: accompanimentStem },
      },
      ocrResults: [
        { time: "0:00", text: "画面标题", confidence: 93 },
        { time: "0:01", text: "乱码", confidence: 12 },
      ],
      frames: [{ time: "0:00", filePath: sourceFrame }],
      visionFrames: [{ path: sourceFrame, status: "available", shotSize: "medium_close_up", cameraAngle: "level", faces: [{}], sceneLabels: [] }],
      warnings: [],
    };
    const remakePlan = {
      observed: { durationSeconds: 4, width: 1080, height: 1920, fps: 30, sceneCount: 1, sceneDetector: "PySceneDetect AdaptiveDetector" },
      copywriting: { hook3s: "这是真实配音文案", voiceoverDraft: "这是真实配音文案" },
      shotPlan: [{ startSeconds: 0, endSeconds: 4, narration: "真实配音", onScreenText: "OCR画面字", shotSize: "medium_close_up", cameraAngle: "level" }],
      audioPlan: { note: "检测到音轨" },
      propagationHypotheses: [],
      unavailable: ["BGM 曲目"],
      seedanceWorkflow: {
        status: "prepared",
        targetDurationSeconds: 30,
        aspectRatio: "9:16",
        shotCount: 1,
        shotDurationRangeSeconds: [4, 8],
        shots: [{ index: 1, role: "前三秒钩子", durationSeconds: 6, sourceStartSeconds: 0, sourceEndSeconds: 4, narration: "真实配音", gptImagePrompt: "GPT 竖屏首帧提示词", seedancePrompt: "以 @图片1 生成 6 秒", negativePrompt: "水印" }],
      },
    };

    const saved = await persistMediaAnalysis(db, "asset-1", result, remakePlan);
    assert.equal(saved.ok, true);
    assert.equal(saved.assetId, "asset-1");
    assert.equal(saved.transcript, 1);
    assert.equal(saved.ocr, 2);
    assert.equal(saved.shots, 1);
    assert.equal(saved.remake, true);
    assert.equal(saved.frames.length, 1);
    assert.equal(saved.audio.length, 2);
    assert.match(saved.frames[0].mediaUrl, /\/analysis-frames\/frame-001\.jpg$/);
    assert.equal(db.prepare("SELECT status FROM transcript WHERE asset_id=?").get("asset-1").status, "available");
    assert.equal(db.prepare("SELECT hook_3s FROM content_analysis WHERE asset_id=?").get("asset-1").hook_3s, "这是真实配音文案");
    assert.equal(db.prepare("SELECT source FROM shot WHERE asset_id=?").get("asset-1").source, "PySceneDetect");
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM knowledge_chunk WHERE asset_id=? AND kind='ocr'").get("asset-1").n, 2);

    const reproduction = await readFile(join(packagePath, "reproduction.md"), "utf8");
    assert.match(reproduction, /真实配音/);
    assert.ok(reproduction.indexOf("真实配音") < reproduction.indexOf("OCR画面字") || !reproduction.includes("OCR画面字"));
    for (const name of ["transcript.json", "transcript-words.json", "ocr.json", "frames.json", "audio.json", "visual-analysis.json", "camera-motion.json", "shots.json", "analysis.md", "reproduction.json", "reproduction.md", "seedance-workflow.json", "gpt-image-prompts.md", "seedance-prompts.md", "subtitles.srt", "voiceover.txt", "shot-list.csv", "analysis-frames/frame-001.jpg", "analysis-audio/voice.m4a", "analysis-audio/accompaniment.m4a"]) {
      await readFile(join(packagePath, name));
    }
    const detail = getVideoDetail(db, "asset-1");
    assert.equal(detail.analysis_frames.length, 1);
    assert.equal(detail.analysis_frames[0].fileName, "frame-001.jpg");
    assert.match(detail.analysis_frames[0].mediaUrl, /\/analysis-frames\/frame-001\.jpg$/);
    assert.equal(detail.analysis_audio.items.length, 2);
    assert.equal(detail.analysis_audio.voice.styleObserved, "偏低沉、语流连续");
    const shots = JSON.parse(await readFile(join(packagePath, "shots.json"), "utf8"));
    assert.equal(shots.status, "available");
    assert.equal(shots.provider, "PySceneDetect");
    assert.match(await readFile(join(packagePath, "subtitles.srt"), "utf8"), /00:00:00,000 --> 00:00:03,500/);
    assert.equal(JSON.parse(await readFile(join(packagePath, "transcript.json"), "utf8")).provider, "WhisperX 3.7.5");
    assert.equal(JSON.parse(await readFile(join(packagePath, "transcript-words.json"), "utf8")).words.length, 1);
    assert.equal(await readFile(join(packagePath, "voiceover.txt"), "utf8"), "这是真实配音文案");
    assert.match(await readFile(join(packagePath, "shot-list.csv"), "utf8"), /"1","0","4"/);
    assert.match(await readFile(join(packagePath, "gpt-image-prompts.md"), "utf8"), /GPT 竖屏首帧提示词/);
    assert.match(await readFile(join(packagePath, "seedance-prompts.md"), "utf8"), /@图片1/);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
