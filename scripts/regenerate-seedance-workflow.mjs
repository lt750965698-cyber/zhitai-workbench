#!/usr/bin/env node
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { openKbDb } from "../local-agent/kb.mjs";
import { buildSeedanceWorkflow } from "../local-agent/seedance-workflow.mjs";

const videoId = String(process.argv[2] || "").trim();
if (!/^[A-Za-z0-9._-]{1,120}$/.test(videoId)) throw new Error("用法：regenerate-seedance-workflow.mjs <videoId>");
const dbPath = process.env.ZHITAI_DB_PATH || join(homedir(), ".local/share/zhitai-runtime/local-agent/data/kb.sqlite");
const db = openKbDb(dbPath, { migrateSchema: false });

try {
  const row = db.prepare("SELECT v.title, v.package_path, r.plan_json FROM video_asset v JOIN remake_plan r ON r.asset_id=v.id WHERE v.id=?").get(videoId);
  if (!row?.plan_json || !row?.package_path) throw new Error("视频尚未完成分析或没有内容包");
  const plan = JSON.parse(row.plan_json);
  if (Array.isArray(plan?.reverseBlueprint?.negativeConstraints)) {
    plan.reverseBlueprint.negativeConstraints = plan.reverseBlueprint.negativeConstraints
      .filter((item) => !/没有描绘|没有显示|无法识别|未识别|不清楚/.test(String(item)));
  }
  const workflow = buildSeedanceWorkflow({
    title: row.title,
    sourceShots: plan.shotPlan,
    hook: plan?.copywriting?.hook3s,
    cta: plan?.copywriting?.cta,
    sourceDurationSeconds: plan?.observed?.durationSeconds,
    sourceOrigin: plan?.sourceOrigin,
    reverseBlueprint: plan?.reverseBlueprint,
    sourceVideoAvailable: true,
  });
  workflow.shots = workflow.shots.map((shot) => {
    const fileName = `shot-${String(shot.index).padStart(2, "0")}.png`;
    const filePath = join(row.package_path, "generated", "gpt-storyboards", fileName);
    return existsSync(filePath) ? {
      ...shot,
      imageStatus: "GPT 首帧已生成",
      imagePath: `generated/gpt-storyboards/${fileName}`,
      imageUrl: `/api/v1/kb/videos/${encodeURIComponent(videoId)}/storyboards/${fileName}`,
    } : shot;
  });
  plan.seedanceWorkflow = workflow;
  db.prepare("UPDATE remake_plan SET plan_json=?, provider=?, created_at=? WHERE asset_id=?")
    .run(JSON.stringify(plan), "zhitai-gpt-seedance-v1", new Date().toISOString(), videoId);

  const gptMd = `# GPT 分镜图提示词 · ${row.title}\n\n${workflow.shots.map((shot) => `## 分镜 ${shot.index} · ${shot.role} · ${shot.durationSeconds} 秒\n\n${shot.gptImagePrompt}\n\n图片：${shot.imagePath || "待生成"}\n`).join("\n")}`;
  const seedanceMd = `# 豆包 Seedance 2.0 提示词 · ${row.title}\n\n每次上传对应的 GPT 首帧图作为 @图片1，逐镜生成，全部验收后拼成 ${workflow.targetDurationSeconds} 秒成片。\n\n${workflow.shots.map((shot) => `## 分镜 ${shot.index} · ${shot.role}\n\n配图：${shot.imagePath || "待生成"}\n\n${shot.seedancePrompt}\n\n负面约束：${shot.negativePrompt}\n`).join("\n")}`;
  await Promise.all([
    writeFile(join(row.package_path, "seedance-workflow.json"), JSON.stringify(workflow, null, 2)),
    writeFile(join(row.package_path, "reproduction.json"), JSON.stringify(plan, null, 2)),
    writeFile(join(row.package_path, "gpt-image-prompts.md"), gptMd),
    writeFile(join(row.package_path, "seedance-prompts.md"), seedanceMd),
  ]);

  try {
    const reproductionPath = join(row.package_path, "reproduction.md");
    const current = await readFile(reproductionPath, "utf8");
    const workflowSection = `## Seedance 制作分镜\n${workflow.shots.map((shot) => `${shot.index}. ${shot.role}｜${shot.durationSeconds} 秒｜原片参考 ${shot.sourceStartSeconds ?? "?"}s–${shot.sourceEndSeconds ?? "?"}s\n   配音：${shot.narration}\n   首帧：${shot.imagePath || "待生成"}\n   完整提示词见 gpt-image-prompts.md / seedance-prompts.md`).join("\n")}\n\n`;
    const next = current.replace(/## Seedance 制作分镜\n[\s\S]*?(?=## 原片观察分镜)/, workflowSection);
    await writeFile(reproductionPath, next);
  } catch { /* 旧内容包没有 reproduction.md 时不阻断工作流刷新 */ }

  process.stdout.write(JSON.stringify({ ok: true, videoId, targetDurationSeconds: workflow.targetDurationSeconds, shots: workflow.shots.length, imagesReady: workflow.shots.filter((shot) => shot.imageUrl).length }) + "\n");
} finally {
  db.close();
}
