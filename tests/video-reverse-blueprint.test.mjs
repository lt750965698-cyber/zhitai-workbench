import test from "node:test";
import assert from "node:assert/strict";
import { buildVideoReverseBlueprint } from "../local-agent/video-reverse-blueprint.mjs";

test("AI 素材优先生成参考视频反推方案且不复制身份元素", () => {
  const blueprint = buildVideoReverseBlueprint({
    visualSemantics: {
      status: "available",
      originAssessment: { type: "ai_generated", confidence: 0.86, evidence: ["连续帧中的材质纹理呈生成式平滑"] },
      reverseBlueprint: {
        subjectDesign: "圆润的原创机械生物",
        visualStyle: "写实微缩摄影与轻奇幻结合",
        materialsTextures: "拉丝金属与柔软织物",
        lightingColor: "暖橙主光、冷青轮廓光",
        consistencyAnchors: ["双眼间距", "金属外壳划痕"],
      },
    },
    cameraMotion: { status: "available", scenes: [{ movement: "slow_push_in" }] },
  }, [{ startSeconds: 0, endSeconds: 3, subject: "机械生物", cameraMovement: "slow_push_in" }]);
  assert.equal(blueprint.originAssessment.type, "ai_generated");
  assert.equal(blueprint.productionStrategy.referenceVideoPreferred, true);
  assert.match(blueprint.referenceVideoPrompt, /@视频1/);
  assert.match(blueprint.referenceVideoPrompt, /不要复制原人物脸/);
  assert.equal(blueprint.viralEvidence.available, false);
});
test("实拍素材不强制参考视频，未知爆火原因不伪造", () => {
  const blueprint = buildVideoReverseBlueprint({
    visualSemantics: { status: "available", originAssessment: { type: "live_action", confidence: 0.7 } },
  }, []);
  assert.equal(blueprint.productionStrategy.mode, "shot_reconstruction");
  assert.equal(blueprint.productionStrategy.referenceVideoPreferred, false);
  assert.match(blueprint.viralEvidence.note, /不能证明/);
});
