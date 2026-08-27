import test from "node:test";
import assert from "node:assert/strict";
import { assessGenerationReadiness, buildSeedanceWorkflow, normalizeNarration, recommendTargetDuration } from "../local-agent/seedance-workflow.mjs";

test("Seedance 主工作流按来源分镜生成可发布长度的提示词", () => {
  const sourceShots = Array.from({ length: 26 }, (_, index) => ({
    startSeconds: index * 4.8,
    endSeconds: (index + 1) * 4.8,
    narration: `第 ${index + 1} 个真实观察分镜：机械生物向前行走`,
    subject: "圆润的机械生物",
    setting: "潮湿苔藓森林",
    shotSize: "中广景",
    cameraAngle: "平视",
    evidence: "PySceneDetect + 关键帧",
  }));
  const plan = buildSeedanceWorkflow({
    title: "微缩机械生物穿越苔藓森林",
    sourceShots,
    hook: "它从水滴后面醒了过来。",
    cta: "下一只机械生物会出现在哪里？",
    targetDurationSeconds: 30,
    sourceRights: { status: "licensed" },
  });

  assert.equal(plan.status, "prepared");
  assert.equal(plan.targetDurationSeconds, 30);
  assert.equal(plan.shotCount, 3);
  assert.equal(plan.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0), 30);
  for (const shot of plan.shots) {
    assert.ok(shot.durationSeconds >= 4 && shot.durationSeconds <= 10);
    assert.equal(shot.generationDurationSeconds, 10);
    assert.match(shot.gptImagePrompt, /9:16/);
    assert.match(shot.gptImagePrompt, /不要文字/);
    assert.match(shot.seedancePrompt, /@图片1/);
    assert.match(shot.seedancePrompt, new RegExp(`${shot.durationSeconds} 秒`));
    assert.match(shot.seedancePrompt, /不在视频内生成对白、字幕/);
  }
  assert.match(plan.shots[0].narration, /水滴后面醒了过来/);
  assert.match(plan.shots[1].narration, /机械生物/);
  assert.match(plan.shots.at(-1).narration, /下一只机械生物/);
  assert.doesNotMatch(JSON.stringify(plan), /一家四口|榻榻米|户型结构|农村宅基地/);
});

test("超出范围的目标时长会收敛到 10–45 秒", () => {
  assert.equal(buildSeedanceWorkflow({ targetDurationSeconds: 6 }).targetDurationSeconds, 10);
  assert.equal(buildSeedanceWorkflow({ targetDurationSeconds: 90 }).targetDurationSeconds, 45);
});

test("没有人工时长时按原片和完播率推荐，并以豆包 10 秒片段拼接", () => {
  const short = buildSeedanceWorkflow({ sourceDurationSeconds: 15 });
  assert.equal(short.targetDurationSeconds, 15);
  assert.equal(short.shotCount, 2);
  assert.deepEqual(short.shots.map((shot) => shot.generationDurationSeconds), [10, 10]);
  assert.equal(short.shots.reduce((sum, shot) => sum + shot.durationSeconds, 0), 15);

  const weakRetention = recommendTargetDuration({ sourceDurationSeconds: 80, completionRate: 0.2 });
  assert.equal(weakRetention.targetDurationSeconds, 20);
  assert.match(weakRetention.rationale, /原片/);
  assert.ok(weakRetention.signalsUsed.includes("完播率"));
});

test("ASR 文本只做通用清理，不再按装修词典擅自改写", () => {
  assert.equal(normalizeNarration("机械 生物 \u200b 缓慢前进 ， 光线变化"), "机械 生物 缓慢前进， 光线变化");
  assert.equal(normalizeNarration("塌塌米也可能是角色名"), "塌塌米也可能是角色名");
});

test("任何行业都只使用该素材自己的观察证据", () => {
  const workflow = buildSeedanceWorkflow({
    title: "火星基地机械臂维修",
    sourceDurationSeconds: 11,
    hook: "机械臂突然停在舱门前",
    sourceShots: [{
      narration: "机械臂重新校准并完成舱门维修",
      subject: "六轴机械臂",
      setting: "火星基地维修舱",
      shotSize: "wide_or_full",
      cameraAngle: "level",
      evidence: "关键帧与镜头检测",
    }],
    sourceRights: { status: "owned" },
  });
  assert.match(workflow.shots[0].gptImagePrompt, /六轴机械臂/);
  assert.match(workflow.shots[0].gptImagePrompt, /火星基地维修舱/);
  assert.doesNotMatch(`${workflow.shots[0].gptImagePrompt} ${workflow.shots[0].seedancePrompt}`, /家具数量|户型结构|中国城市住宅室内|农村宅基地/);
  assert.equal(workflow.generationReadiness.ready, true);
});

test("生成前质量门会阻止没有来源证据的行业模板", () => {
  const readiness = assessGenerationReadiness({ shots: [{
    narration: "机械生物前进",
    gptImagePrompt: "中国城市住宅室内，家具数量保持一致",
    seedancePrompt: "户型结构不变",
    observedReference: { subject: "机械生物", setting: "苔藓森林", evidence: "关键帧" },
  }] });
  assert.equal(readiness.ready, false);
  assert.match(readiness.blockers.join("；"), /行业模板内容/);
});

test("卧室提示词有房间与床的画面证据时不会被行业模板门误拦", () => {
  const readiness = assessGenerationReadiness({ shots: [{
    narration: "展示阁楼床与书桌",
    gptImagePrompt: "温暖卧室里的阁楼床和内置储物",
    seedancePrompt: "保持房间布局连续，缓慢推进",
    observedReference: { subject: "绿色扶手阁楼床", setting: "带书桌与储物的房间", evidence: "关键帧可见床和书桌" },
  }] });
  assert.equal(readiness.ready, true);
});

test("AI 素材使用反推蓝图并准备参考视频提示词", () => {
  const workflow = buildSeedanceWorkflow({
    title: "原创 AI 微缩机械生物",
    sourceDurationSeconds: 10,
    sourceVideoAvailable: true,
    sourceOrigin: { type: "ai_generated", label: "AI 生成", confidence: 0.9 },
    sourceRights: { status: "licensed" },
    reverseBlueprint: {
      subjectDesign: "圆润的原创机械生物",
      visualStyle: "写实微缩摄影",
      environment: "潮湿苔藓森林",
      materialsTextures: "拉丝金属和水珠",
      lightingColor: "暖橙主光和青色轮廓光",
      universalPrompt: "写实微缩摄影，原创机械生物在苔藓森林自然移动。",
      referenceVideoPrompt: "只参考 @视频1 的动作轨迹与运镜，使用 @图片1 替换主体。",
      consistencyAnchors: ["双眼间距", "外壳划痕"],
      negativeConstraints: ["形体融化"],
    },
    sourceShots: [{ subject: "机械生物", setting: "苔藓森林", evidence: "关键帧" }],
  });
  assert.equal(workflow.mode, "ai_reverse");
  assert.equal(workflow.referenceVideoPreferred, true);
  assert.equal(workflow.generationReadiness.ready, true);
  assert.match(workflow.shots[0].gptImagePrompt, /写实微缩摄影/);
  assert.match(workflow.shots[0].referenceVideoPrompt, /@视频1/);
});
