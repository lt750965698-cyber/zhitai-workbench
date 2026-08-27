import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import runner from "../desktop/creative-runner.js";

const { createCreativeRunner, generationReadiness, shotPrompts, sanitizeId, doubaoVideoEntryDecision } = runner;

test("无人值守执行器只接收同时具备 GPT 与 Seedance 提示词的镜头", () => {
  const detail = { remake_plan: { plan: { seedanceWorkflow: { shots: [
    { index: 1, gptImagePrompt: "首帧 A", seedancePrompt: "视频 A", negativePrompt: "不要漂移", durationSeconds: 10 },
    { index: 2, gptImagePrompt: "缺视频提示词" },
    { index: 3, imagePrompt: "首帧 C", videoPrompt: "视频 C", durationSeconds: 18 },
  ] } } } };
  assert.deepEqual(shotPrompts(detail), [
    { index: 1, imagePrompt: "首帧 A", videoPrompt: "视频 A", negativePrompt: "不要漂移", durationSeconds: 10 },
    { index: 3, imagePrompt: "首帧 C", videoPrompt: "视频 C", negativePrompt: "", durationSeconds: 10 },
  ]);
});

test("生成目录 id 不允许路径跳转", () => {
  assert.equal(sanitizeId("../../job:1"), ".._.._job_1");
  assert.equal(sanitizeId("素材-01"), "__-01");
});

test("发送提示词绝不退回点击最后一个按钮（避免误触 GPT 语音）", async () => {
  const source = await readFile(new URL("../desktop/creative-runner.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /buttons\.at\(-1\)/);
  assert.match(source, /语音\|voice\|麦克风/);
  assert.match(source, /为避免误触语音已停止/);
  assert.match(source, /editorSelectors\.flatMap/);
  assert.match(source, /attempt < 40/);
  assert.match(source, /authorizationGateOpenedAt/);
  assert.match(source, /等待你确认豆包素材授权超时/);
  assert.match(source, /authorization_required/);
  assert.match(source, /织台已保存断点并继续等待/);
  assert.match(source, /sameCheckpointConversation/);
  assert.match(source, /视频生成已提交/);
  assert.match(source, /checkpointMatches/);
  assert.match(source, /completedClip\?\.isFile\(\)/);
  assert.match(source, /\/attention/);
});

test("豆包入口识别支持链接、标签与两段式创作页，并拒绝声音控件", () => {
  assert.deepEqual(
    doubaoVideoEntryDecision([
      { label: "播放视频", href: "/chat/create-video", visible: true },
      { label: "视频生成", href: "", visible: true },
    ], "https://www.doubao.com/chat/"),
    {
      status: "click",
      kind: "video",
      index: 1,
      label: "视频生成",
      pathname: "/chat/",
      diagnostics: ["视频生成"],
    },
  );
  assert.equal(doubaoVideoEntryDecision([
    { label: "AI 创作", href: "/chat/create-image", visible: true },
  ], "https://www.doubao.com/chat/", { allowCreative: true }).kind, "creative");
  assert.equal(doubaoVideoEntryDecision([], "https://www.doubao.com/chat/create-video").status, "already");
  assert.equal(doubaoVideoEntryDecision([], "https://www.doubao.com/chat/38439092690721538", { modeReady: true }).status, "already");
  assert.equal(doubaoVideoEntryDecision([
    { label: "视频生成", href: "", visible: true, enabled: false },
  ], "https://www.doubao.com/chat/").status, "missing");
});

test("豆包入口有两个不同的同优先级目标时失败关闭", () => {
  const decision = doubaoVideoEntryDecision([
    { label: "视频生成", href: "/chat/create-video", visible: true },
    { label: "视频创作", href: "/studio/video-create", visible: true },
    { label: "语音创作", href: "/voice", visible: true },
  ], "https://www.doubao.com/chat/");
  assert.equal(decision.status, "ambiguous");
  assert.deepEqual(decision.diagnostics, ["视频生成", "视频创作"]);
});

test("旧分析和不合格分析不能绕过桌面执行器的质量门", () => {
  assert.deepEqual(generationReadiness({}), {
    ready: false,
    status: "needs_analysis",
    error: "这条素材仍是旧的行业模板提示词，请重新分析后再生成",
  });
  assert.deepEqual(generationReadiness({ remake_plan: { plan: { seedanceWorkflow: {
    schemaVersion: 3,
    generationReadiness: { ready: false, blockers: ["结构悬空"] },
  } } } }), {
    ready: false,
    status: "quality_blocked",
    error: "生成前质量门未通过：结构悬空",
  });
  assert.equal(generationReadiness({ remake_plan: { plan: { seedanceWorkflow: {
    schemaVersion: 3,
    generationReadiness: { ready: true, blockers: [] },
  } } } }).ready, true);
});

test("今日运行条件深检识别 GPT 和最多 8 个独立豆包账号", async () => {
  const opened = [];
  function fakeWindow(provider, accountId) {
    return {
      webContents: {
        getURL: () => provider === "gpt"
          ? "https://chatgpt.com/"
          : accountId === "account-2" ? "https://www.doubao.com/passport/login" : "https://www.doubao.com/chat/",
        executeJavaScript: async (source) => {
          if (provider === "gpt") return { loginRequired: false, editorReady: true };
          if (source.includes("const nodes =")) {
            if (accountId === "account-4") return { status: "missing", kind: "", index: -1, label: "", pathname: "/chat/", diagnostics: [] };
            return { status: "click", kind: "video", index: 0, label: "视频生成", pathname: "/chat/", diagnostics: ["视频生成"] };
          }
          if (accountId === "account-2") return { loginRequired: true, quotaExhausted: false, editorReady: false };
          if (accountId === "account-3") return { loginRequired: false, quotaExhausted: true, editorReady: true };
          assert.match(source, /editorReady/);
          return { loginRequired: false, quotaExhausted: false, editorReady: true };
        },
      },
    };
  }
  const creative = createCreativeRunner({
    openStudio(provider, options = {}) {
      opened.push({ provider, options });
      return { ok: true, window: fakeWindow(provider, options.accountId) };
    },
    waitForStudio: async () => {},
  });
  const report = await creative.probeAccounts([
    "account-1", "account-2", "account-3", "account-4", "account-5", "account-6", "account-7", "account-8", "account-9",
  ]);
  assert.deepEqual(report.gpt, { state: "ready", reason: "已登录，生图输入框可用" });
  assert.equal(report.doubao.length, 8);
  assert.deepEqual(report.doubao.slice(0, 3).map((row) => [row.id, row.state]), [
    ["account-1", "ready"],
    ["account-2", "attention"],
    ["account-3", "attention"],
  ]);
  assert.equal(report.doubao[0].reason, "已登录，视频生成入口可用");
  assert.equal(report.doubao[3].state, "unknown");
  assert.match(report.doubao[3].reason, /尚未确认视频生成入口/);
  assert.equal(opened.filter((row) => row.provider === "gpt").length, 1);
  assert.equal(opened.filter((row) => row.provider === "seedance").length, 8);
  assert.ok(opened.every((row) => row.options.show === false), "深检不应弹出创作窗口");
  assert.doesNotMatch(JSON.stringify(report), /cookie|token|password/i);
});

test("桌面 IPC 只暴露运行条件检查参数，不传递凭证", async () => {
  const [mainSource, preloadSource, serverSource] = await Promise.all([
    readFile(new URL("../desktop/main.js", import.meta.url), "utf8"),
    readFile(new URL("../desktop/preload.js", import.meta.url), "utf8"),
    readFile(new URL("../local-agent/server.mjs", import.meta.url), "utf8"),
  ]);
  assert.match(mainSource, /zhitai:runtime-conditions:check/);
  assert.match(mainSource, /runtime-conditions\/creative/);
  assert.match(mainSource, /runtime-conditions\?refresh=1/);
  assert.match(mainSource, /repairedJob/);
  assert.match(mainSource, /repairedLegacyReference/);
  assert.match(mainSource, /verifiedFixRetryReady/);
  assert.match(mainSource, /网页\/UI\/登录错误仍按提供方级 4 小时退避/);
  assert.match(mainSource, /lastError/);
  assert.match(mainSource, /isClearlyJobSpecificCreativeError/);
  assert.match(mainSource, /attemptedJobIds/);
  assert.match(mainSource, /needs_revision\/坏素材饿死队列/);
  assert.match(mainSource, /qualifiedCreativeReviewCount/);
  assert.match(mainSource, /MAX_CONSECUTIVE_REVISION_ATTEMPTS/);
  assert.match(serverSource, /advance\|attention/);
  assert.match(serverSource, /网页生成需处理/);
  assert.match(serverSource, /authorizedSender === true/);
  assert.match(serverSource, /await notificationCenter\?\.stop\(\)/);
  assert.match(preloadSource, /checkRuntimeConditions:\s*\(accountIds = \[\], refresh = false\)/);
  assert.doesNotMatch(preloadSource, /cookie|password|secret/i);
});
