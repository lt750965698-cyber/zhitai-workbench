import test from "node:test";
import assert from "node:assert/strict";
import { classifyCategory } from "../local-agent/analyze.mjs";

test("分类按内容用途而不是装修题材决定是否进入复刻素材", () => {
  assert.equal(classifyCategory("生成指定室内视频"), "素材");
  assert.equal(classifyCategory("真人感好强，提示词在评论区了"), "素材");
  assert.equal(classifyCategory("原创 AI 微缩机械生物视频，画面效果很真实"), "素材");
  assert.equal(classifyCategory("北京朝阳 56㎡老房两居改三居"), "素材");
});

test("教程、工具和步骤进入每日学习，不进入无人值守生成", () => {
  assert.equal(classifyCategory("如何制作 AI 口哨舞视频：完整步骤"), "技能");
  assert.equal(classifyCategory("GitHub 开源项目：自动生成短视频工具"), "技能");
  assert.equal(classifyCategory("如何用 AI 提升各种能力"), "技能");
});

test("普通新闻或生活视频不因单个宽泛词误判为技能", () => {
  assert.equal(classifyCategory("第二届世界人形机器人运动会开赛在即，闪电备战竞速项目"), "其他");
  assert.equal(classifyCategory("开着特斯拉，好好聊聊电车"), "其他");
});
