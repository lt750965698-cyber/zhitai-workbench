import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { STRICT_POLICY } from "./originality-remediation.mjs";
import { assessGenerationReadiness } from "./seedance-workflow.mjs";

function text(value, fallback = "") {
  const cleaned = String(value ?? "").replace(/\s+/g, " ").trim();
  return cleaned || fallback;
}

async function writeAtomic(filePath, value) {
  const temp = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, value, "utf8");
    await rename(temp, filePath);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

function promptMarkdown(title, workflow, kind) {
  const shots = Array.isArray(workflow?.shots) ? workflow.shots : [];
  const heading = kind === "image" ? "GPT 完全原创分镜提示词" : "豆包完全原创视频提示词";
  return `# ${heading} · ${title}\n\n` + shots.map((shot, index) => {
    const prompt = kind === "image" ? shot?.gptImagePrompt : shot?.seedancePrompt;
    const negative = kind === "image" ? "" : `\n\n负面约束：${text(shot?.negativePrompt, "无")}`;
    return `## 分镜 ${Number(shot?.index) || index + 1} · ${text(shot?.role, "原创镜头")}\n\n配音：${text(shot?.narration, "无")}\n\n${text(prompt, "缺少提示词")}${negative}\n`;
  }).join("\n");
}

function remediationMarkdown(workflow) {
  const originality = workflow?.originality || {};
  const reasons = Array.isArray(originality.reasonLabels) ? originality.reasonLabels : [];
  const actions = Array.isArray(originality.actions) ? originality.actions : [];
  return [
    "<!-- ZHITAI_ORIGINALITY_START -->",
    "## 完全原创补救",
    "",
    `- 状态：${text(originality.status, "unknown")}`,
    `- 来源权利：${text(originality.sourceRightsStatus, "unverified")}`,
    `- 原因：${reasons.join("；") || "严格原创策略"}`,
    ...actions.map((item) => `- 动作：${item}`),
    "- 音频：只使用新写旁白与新合成配音；不使用来源原音或 BGM。",
    "- 视频：只使用本任务新生成的首帧；不上传或引用来源视频。",
    "",
    "<!-- ZHITAI_ORIGINALITY_END -->",
  ].join("\n");
}

/**
 * 持久化完整原创工作流和面向执行器的提示词文件。
 * 先原子写固定文件，再更新 DB；文件阶段失败时执行器仍只能看到旧 DB 计划。
 */
export async function persistOriginalityRemediation(db, assetId, workflow) {
  const cleanId = String(assetId || "").trim();
  if (!/^[A-Za-z0-9._-]{1,160}$/.test(cleanId)) throw new Error("invalid_asset_id");
  if (workflow?.originality?.policy !== STRICT_POLICY || workflow?.originality?.status !== "remediated") {
    throw new Error("invalid_originality_workflow");
  }
  // `parseSavedWorkflow` 以持久化的 generationReadiness 判断计划是否完整；补救改写了
  // 全部分镜后必须重新计算，不能沿用旧计划的 ready，也不能缺字段导致重启后反复回队。
  const generationReadiness = assessGenerationReadiness(workflow);
  if (!generationReadiness.ready) {
    throw new Error(`originality_readiness_failed:${generationReadiness.blockers.join("；") || "unknown"}`);
  }
  const persistedWorkflow = { ...workflow, generationReadiness };
  const row = db.prepare(`SELECT v.title, v.package_path, rp.plan_json, rp.provider, rp.created_at
    FROM video_asset v JOIN remake_plan rp ON rp.asset_id=v.id WHERE v.id=?`).get(cleanId);
  if (!row?.plan_json) throw new Error("remake_plan_not_found");
  const plan = JSON.parse(row.plan_json);
  plan.seedanceWorkflow = persistedWorkflow;
  plan.originalityRemediation = persistedWorkflow.originality;
  plan.copywriting = {
    ...(plan.copywriting && typeof plan.copywriting === "object" ? plan.copywriting : {}),
    originalTitleDraft: text(persistedWorkflow.originality.originalTitle) || null,
    originalVoiceoverDraft: text(persistedWorkflow.originality.originalVoiceover) || null,
  };
  const serialized = JSON.stringify(plan);

  if (row.package_path) {
    await mkdir(row.package_path, { recursive: true });
    // 执行提示词文件的标题也必须使用新原创标题，避免把来源品牌词放在文件首行后
    // 被网页执行器整段带入模型上下文。
    const title = text(persistedWorkflow.originality.originalTitle, text(row.title, cleanId));
    const notice = remediationMarkdown(persistedWorkflow);
    let reproduction = "";
    try { reproduction = await readFile(join(row.package_path, "reproduction.md"), "utf8"); } catch { /* optional legacy file */ }
    const nextReproduction = reproduction.includes("<!-- ZHITAI_ORIGINALITY_START -->")
      ? reproduction.replace(/<!-- ZHITAI_ORIGINALITY_START -->[\s\S]*?<!-- ZHITAI_ORIGINALITY_END -->\n?/u, `${notice}\n`)
      : `${notice}\n\n${reproduction}`;
    await Promise.all([
      writeAtomic(join(row.package_path, "seedance-workflow.json"), `${JSON.stringify(persistedWorkflow, null, 2)}\n`),
      writeAtomic(join(row.package_path, "reproduction.json"), `${JSON.stringify(plan, null, 2)}\n`),
      writeAtomic(join(row.package_path, "gpt-image-prompts.md"), promptMarkdown(title, persistedWorkflow, "image")),
      writeAtomic(join(row.package_path, "seedance-prompts.md"), promptMarkdown(title, persistedWorkflow, "video")),
      writeAtomic(join(row.package_path, "voiceover.txt"), `${text(persistedWorkflow.originality.originalVoiceover)}\n`),
      writeAtomic(join(row.package_path, "originality-remediation.json"), `${JSON.stringify(persistedWorkflow.originality, null, 2)}\n`),
      writeAtomic(join(row.package_path, "reproduction.md"), nextReproduction),
    ]);
  }

  // 只替换计划正文并做比较写入：provider/created_at 是原分析证据，不应被补救流程伪装成新分析；
  // 若期间有新分析写回，宁可让任务失败重试，也不能覆盖更新后的计划。
  const result = db.prepare("UPDATE remake_plan SET plan_json=? WHERE asset_id=? AND plan_json=?")
    .run(serialized, cleanId, row.plan_json);
  if (Number(result.changes || 0) !== 1) throw new Error("remake_plan_concurrent_update");
  const verified = db.prepare("SELECT plan_json, provider, created_at FROM remake_plan WHERE asset_id=?").get(cleanId);
  let verifiedPlan;
  try { verifiedPlan = JSON.parse(verified?.plan_json || ""); }
  catch { throw new Error("remake_plan_verify_failed"); }
  if (verified?.provider !== row.provider || verified?.created_at !== row.created_at
    || verifiedPlan?.seedanceWorkflow?.originality?.policy !== STRICT_POLICY
    || verifiedPlan?.seedanceWorkflow?.generationReadiness?.ready !== true) {
    throw new Error("remake_plan_verify_failed");
  }
  return { ok: true, assetId: cleanId, workflow: persistedWorkflow, plan: verifiedPlan };
}
