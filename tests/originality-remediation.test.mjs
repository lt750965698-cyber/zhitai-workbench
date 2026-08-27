import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assessOriginalityRisks,
  publishContentForPlan,
  publishSourceUrlForPlan,
  publishTitleForPlan,
  remediateToOriginalWorkflow,
} from "../local-agent/originality-remediation.mjs";
import { persistOriginalityRemediation } from "../local-agent/originality-remediation-store.mjs";
import { openKbDb } from "../local-agent/kb.mjs";
import { assessGenerationReadiness, buildSeedanceWorkflow } from "../local-agent/seedance-workflow.mjs";

function mismatchedWorkflow() {
  return {
    schemaVersion: 3,
    mode: "standard_remake",
    referenceVideoPreferred: true,
    shots: [{
      index: 1,
      role: "前三秒钩子",
      durationSeconds: 10,
      narration: "视频前3秒通过高频重复的‘我怕你’语音作为听觉钩子，但缺乏视觉支撑。",
      observedNarration: "我怕你",
      sourceStartSeconds: 0,
      sourceEndSeconds: 8.2,
      observedReference: {
        subject: "墙面装饰板与天花装饰",
        setting: "室内",
        evidence: "关键帧可见金色边框与灯具",
      },
      gptImagePrompt: "复现原画面的装饰板",
      seedancePrompt: "复现已观察到的镜头运动",
      referenceVideoPrompt: "上传 @视频1 参考原片动作",
      negativePrompt: "水印",
    }],
  };
}

test("权利、分析式配音和主题错配会转入完全原创补救", () => {
  const input = mismatchedWorkflow();
  const sourceTitle = "年度必入 #法比莎 #法式装修 #PU线条";
  const assessment = assessOriginalityRisks(input, { title: sourceTitle });
  assert.equal(assessment.requiresRecovery, true);
  assert.deepEqual(assessment.reasons, ["source_rights_unverified", "narration_is_analysis"]);

  const result = remediateToOriginalWorkflow(input, { title: sourceTitle });
  assert.equal(result.changed, true);
  assert.equal(result.workflow.schemaVersion, 4);
  assert.equal(result.workflow.mode, "full_original_recovery");
  assert.equal(result.workflow.referenceVideoPreferred, false);
  assert.equal(result.workflow.originality.sourceAudioAllowed, false);
  assert.equal(result.workflow.originality.sourceMusicAllowed, false);
  assert.equal(result.workflow.originality.originalVoiceoverRequired, true);
  assert.match(result.workflow.originality.originalTitle, /墙面装饰板/);
  assert.doesNotMatch(result.workflow.originality.originalTitle, /法比莎|年度必入/);
  assert.equal(result.workflow.shots[0].referenceVideoPrompt, null);
  assert.equal(result.workflow.shots[0].sourceStartSeconds, null);
  assert.equal(result.workflow.shots[0].sourceEndSeconds, null);
  assert.match(result.workflow.shots[0].narration, /墙面装饰板/);
  assert.match(result.workflow.shots[0].narration, /更清楚耐看|效果才更完整/);
  assert.match(result.workflow.shots[0].gptImagePrompt, /从空白画布重新设计/);
  assert.match(result.workflow.shots[0].seedancePrompt, /不得上传或引用来源视频/);
  assert.doesNotMatch(result.workflow.shots[0].narration, /我怕你|听觉钩子|视频前3秒/);
  assert.doesNotMatch(result.workflow.originality.originalVoiceover, /这一镜|观察|整体关系|自然收束|叙事目的/);
  assert.doesNotMatch(JSON.stringify(result.workflow.shots), /@视频1|复现已观察到的镜头运动/);
  assert.equal(assessGenerationReadiness(result.workflow).ready, true);

  const second = remediateToOriginalWorkflow(result.workflow, { title: sourceTitle });
  assert.equal(second.changed, false, "补救必须幂等，不能反复改写任务");
  assert.equal(second.workflow, result.workflow);
});

test("已确认权利且主题一致的工作流不会被误改写", () => {
  const workflow = mismatchedWorkflow();
  workflow.sourceRights = { status: "owned" };
  workflow.shots[0].narration = "墙面装饰板用比例、材质和柔和光线建立空间层次。";
  workflow.shots[0].referenceVideoPrompt = null;
  const result = remediateToOriginalWorkflow(workflow, { title: "墙面装饰板设计" });
  assert.equal(result.changed, false);
  assert.equal(result.workflow.shots[0].narration, workflow.shots[0].narration);
});

test("新分析在来源权利未确认时直接产出原创模式，不等待失败后再停住", () => {
  const workflow = buildSeedanceWorkflow({
    title: "法式墙面与天花装饰细节",
    sourceDurationSeconds: 10,
    hook: "我怕你",
    sourceShots: [{
      narration: "我怕你",
      subject: "墙面装饰板与天花装饰",
      setting: "室内",
      evidence: "关键帧",
    }],
  });
  assert.equal(workflow.mode, "full_original_recovery");
  assert.equal(workflow.generationReadiness.ready, true);
  assert.equal(workflow.originality.sourceRightsStatus, "unverified");
  assert.equal(workflow.referenceVideoPreferred, false);
  assert.doesNotMatch(workflow.originality.originalVoiceover, /我怕你/);
  assert.doesNotMatch(workflow.originality.originalVoiceover, /这一镜|观察|整体关系|自然收束|叙事目的/);
});

test("主题事实不足时使用不虚构的通用利益点旁白", () => {
  const workflow = buildSeedanceWorkflow({
    sourceDurationSeconds: 10,
    sourceShots: [{ evidence: "只有时间边界，没有可靠画面语义" }],
  });
  assert.equal(workflow.mode, "full_original_recovery");
  assert.match(workflow.originality.originalVoiceover, /这个主题/);
  assert.match(workflow.originality.originalVoiceover, /重点、比例和光线/);
  assert.doesNotMatch(workflow.originality.originalVoiceover, /一家四口|卧室|客厅|户型|这一镜|观察|叙事目的/);
});

test("拍摄占位描述会按标题主题重写，已补救旧计划也能再次纠正", () => {
  const input = mismatchedWorkflow();
  input.shots[0].observedReference.subject = "拍摄对象站着并说话";
  input.shots[0].narration = "拍摄对象站着并说话";
  const recovered = remediateToOriginalWorkflow(input, { title: "嘉兴刚完工的厨房改造 #厨房装修" });
  assert.equal(recovered.changed, true);
  assert.match(recovered.workflow.originality.originalTitle, /厨房改造/);
  assert.match(recovered.workflow.originality.originalVoiceover, /厨房改造/);
  assert.doesNotMatch(recovered.workflow.originality.originalVoiceover, /拍摄对象|站着并说话/);

  const legacyGeneric = structuredClone(recovered.workflow);
  legacyGeneric.originality.originalTitle = "拍摄对象站着并说话怎么做得更清楚耐看？";
  legacyGeneric.originality.originalVoiceover = "想让拍摄对象站着并说话更清楚耐看，先统一重点、比例和光线。";
  legacyGeneric.shots[0].narration = legacyGeneric.originality.originalVoiceover;
  const repairedAgain = remediateToOriginalWorkflow(legacyGeneric, { title: "嘉兴刚完工的厨房改造 #厨房装修" });
  assert.equal(repairedAgain.changed, true);
  assert.match(repairedAgain.workflow.originality.originalVoiceover, /厨房改造/);
  assert.deepEqual(repairedAgain.workflow.originality.reasons.sort(), ["narration_theme_mismatch", "source_rights_unverified"]);

  const repeatedBathroom = structuredClone(recovered.workflow);
  repeatedBathroom.originality.originalTitle = "我家这4㎡硬是塞进泡澡+淋浴+马桶+洗漱怎么做得更清楚耐看？";
  repeatedBathroom.originality.originalVoiceover = "我家这4㎡硬是塞进泡澡淋浴马桶洗漱。 我家这4㎡硬是塞进泡澡淋浴马桶洗漱。";
  const bathroomRepair = remediateToOriginalWorkflow(repeatedBathroom, { title: "4㎡小户型卫生间改造 #卫生间收纳" });
  assert.equal(bathroomRepair.changed, true);
  assert.match(bathroomRepair.workflow.originality.originalTitle, /小户型卫生间布局/);
  assert.doesNotMatch(bathroomRepair.workflow.originality.originalVoiceover, /我家|硬是|塞进/);
});

test("原创补救会同步持久化 DB、执行提示词和新旁白", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-originality-store-"));
  const packagePath = join(root, "package");
  await mkdir(packagePath, { recursive: true });
  await writeFile(join(packagePath, "reproduction.md"), "# 旧复刻说明\n", "utf8");
  const db = openKbDb(join(root, "kb.sqlite"));
  try {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO video_asset (id,title,package_path,created_at,updated_at) VALUES (?,?,?,?,?)")
      .run("asset-original", "年度必入 法比莎墙面装饰板设计", packagePath, now, now);
    db.prepare("INSERT INTO remake_plan (asset_id,plan_json,provider,created_at) VALUES (?,?,?,?)")
      .run("asset-original", JSON.stringify({ copywriting: { voiceoverDraft: "我怕你" }, seedanceWorkflow: mismatchedWorkflow() }), "legacy", now);
    const recovered = remediateToOriginalWorkflow(mismatchedWorkflow(), { title: "墙面装饰板设计" }).workflow;
    const saved = await persistOriginalityRemediation(db, "asset-original", recovered);
    assert.equal(saved.ok, true);
    const persistedRow = db.prepare("SELECT plan_json, provider, created_at FROM remake_plan WHERE asset_id=?").get("asset-original");
    const plan = JSON.parse(persistedRow.plan_json);
    assert.equal(plan.seedanceWorkflow.mode, "full_original_recovery");
    assert.equal(plan.seedanceWorkflow.generationReadiness.ready, true);
    assert.equal(persistedRow.provider, "legacy", "原创补救不能改写原分析 provider");
    assert.equal(persistedRow.created_at, now, "原创补救不能改写原分析时间");
    assert.match(plan.copywriting.originalTitleDraft, /墙面装饰板/);
    assert.match(plan.copywriting.originalVoiceoverDraft, /墙面装饰板/);
    assert.equal(plan.copywriting.voiceoverDraft, "我怕你", "保留来源分析证据，但执行器不得再使用它");
    assert.doesNotMatch(await readFile(join(packagePath, "voiceover.txt"), "utf8"), /我怕你/);
    const imagePrompts = await readFile(join(packagePath, "gpt-image-prompts.md"), "utf8");
    const videoPrompts = await readFile(join(packagePath, "seedance-prompts.md"), "utf8");
    assert.match(imagePrompts, /从空白画布重新设计/);
    assert.match(videoPrompts, /不得上传或引用来源视频/);
    assert.doesNotMatch(`${imagePrompts}\n${videoPrompts}`, /法比莎|我怕你|@视频1/);
    assert.match(await readFile(join(packagePath, "reproduction.md"), "utf8"), /完全原创补救/);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("原创补救质量门未通过时拒绝写回 DB", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-originality-blocked-"));
  const db = openKbDb(join(root, "kb.sqlite"));
  try {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO video_asset (id,title,created_at,updated_at) VALUES (?,?,?,?)")
      .run("asset-blocked", "无分镜素材", now, now);
    const originalJson = JSON.stringify({ seedanceWorkflow: mismatchedWorkflow(), marker: "keep" });
    db.prepare("INSERT INTO remake_plan (asset_id,plan_json,provider,created_at) VALUES (?,?,?,?)")
      .run("asset-blocked", originalJson, "legacy", now);
    const invalid = remediateToOriginalWorkflow({ ...mismatchedWorkflow(), shots: [] }, { title: "无分镜素材" }).workflow;
    await assert.rejects(
      persistOriginalityRemediation(db, "asset-blocked", invalid),
      /originality_readiness_failed/,
    );
    assert.equal(db.prepare("SELECT plan_json FROM remake_plan WHERE asset_id=?").get("asset-blocked").plan_json, originalJson);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("完全原创模式创建草稿时不会回退旧 publishCopy 或 voiceoverDraft", () => {
  const plan = {
    copywriting: {
      publishCopy: "这是一个8秒视频，原画外音说我怕你。",
      voiceoverDraft: "我怕你",
      originalVoiceoverDraft: "想让墙面装饰板更清楚耐看，先统一重点、比例和光线。",
    },
    seedanceWorkflow: {
      originality: {
        policy: "strict_full_original",
        status: "remediated",
        originalVoiceover: "想让墙面装饰板更清楚耐看，先统一重点、比例和光线。",
      },
    },
  };
  const content = publishContentForPlan(plan, "墙面装饰板设计");
  assert.match(content, /更清楚耐看/);
  assert.doesNotMatch(content, /8秒视频|我怕你|原画外音/);
  assert.equal(publishContentForPlan({ copywriting: { publishCopy: "普通发布文案" } }, "回退"), "普通发布文案");
  assert.equal(publishTitleForPlan(plan, "法比莎品牌原题"), "原创内容", "旧严格计划缺原创标题时也不能回退来源品牌标题");
  assert.equal(publishSourceUrlForPlan(plan, "https://source.example/post"), "");
});

test("服务端图文草稿入口统一使用原创文案选择器", async () => {
  const source = await readFile(new URL("../local-agent/server.mjs", import.meta.url), "utf8");
  assert.match(source, /content:\s*publishContentForPlan\(plan, asset\.title \|\| ""\)/);
  assert.match(source, /const publishTitle = publishTitleForPlan\(plan, asset\.title \|\| "未命名内容"\)/);
  assert.match(source, /title:\s*publishTitle,/);
  assert.match(source, /sourceUrl:\s*publishSourceUrlForPlan\(plan, asset\.source_url \|\| ""\)/);
  assert.match(source, /const creativeReviewAction = requestUrl\.pathname\.match/);
  assert.match(source, /creative_revision_feedback_required/);
  assert.match(source, /reviseCreativeReview\(Number\(creativeReviewAction\[1\]\), feedback\)/);
  assert.doesNotMatch(source, /content:\s*String\(plan\?\.copywriting\?\.publishCopy\s*\|\|\s*plan\?\.copywriting\?\.voiceoverDraft/);
});
