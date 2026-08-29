import assert from "node:assert/strict";
import test from "node:test";

import {
  OPEN_INTERPRETER_KEEPALIVE_TEXT,
  parseDriverPermissionOutput,
  runOpenInterpreterKeepalive as runKeepaliveImplementation,
} from "../local-agent/open-interpreter-keepalive-runner.mjs";

const PID = 4242;
const WINDOW_ID = 9001;
const TARGET_CHAT = "ClawBot 测试会话";
const OFFICIAL_WECHAT_EXECUTABLE = "/Applications/WeChat.app/Contents/MacOS/WeChat";
const BACKUP_WECHAT_EXECUTABLE = "/Applications/WeChat.tampered-backup-20260806.app/Contents/MacOS/WeChat";

function runOpenInterpreterKeepalive(options = {}) {
  return runKeepaliveImplementation({
    targetChat: TARGET_CHAT,
    resolveProcessExecutable: async (pid) => (
      pid === PID ? OFFICIAL_WECHAT_EXECUTABLE : null
    ),
    ...options,
  });
}

function tree({
  title = TARGET_CHAT,
  value = "",
  send = true,
  duplicateSend = false,
  withSearch = false,
  sidebarTarget = false,
  broadSend = false,
  sentCopies = 0,
} = {}) {
  return [
    "application Role: 应用程序 微信",
    "    standard window Role: 标准窗口 微信",
    "        split group Role: 分割组",
    "            container Role: 组",
    withSearch ? "                21 text field Role: 文本框, Value: " : "",
    sidebarTarget ? `                22 text Role: 文本, Value: ${TARGET_CHAT}` : "",
    "            container Role: 组",
    "                container Role: 组",
    `                    heading Role: 标题, Value: ${title}`,
    "                scroll area Role: 滚动区域 消息区",
    ...Array.from({ length: sentCopies }, () => "                    text Role: 文本, Value: ZT_KEEPALIVE"),
    "                container Role: 组",
    `                    31 text area Role: 文本区域, Value: ${value}`,
    send ? "                    32 button Role: 按钮 发送 Secondary Actions: Raise" : "",
    duplicateSend ? "                    33 button Role: 按钮 发送 Secondary Actions: Raise" : "",
    broadSend ? "                34 button Role: 按钮 发送 Secondary Actions: Raise" : "",
  ].filter(Boolean).join("\n");
}

function opaqueLoginTree() {
  return [
    "application Role: 应用程序 微信",
    "    0 menu bar Role: 菜单栏 Secondary Actions: Cancel",
    "    16 standard window Role: 标准窗口 微信 Secondary Actions: Raise",
    "        17 button Role: 关闭按钮 Subrole: AXCloseButton",
  ].join("\n");
}

function authTree() {
  return [
    "application Role: 应用程序 微信",
    "    standard window Role: 标准窗口 微信",
    "        container Role: 组",
    "            text Role: 文本, Value: 扫码登录",
    "            77 button Role: 按钮 二维码 Secondary Actions: Raise",
  ].join("\n");
}

function contactTree({ duplicate = false } = {}) {
  return [
    "application Role: 应用程序 微信",
    "    standard window Role: 标准窗口 微信",
    "        split group Role: 分割组",
    "            container Role: 组",
    `                41 row Role: 行 ${TARGET_CHAT} Secondary Actions: Select`,
    duplicate ? `                42 row Role: 行 ${TARGET_CHAT} Secondary Actions: Select` : "",
    "            container Role: 组",
    "                container Role: 组",
    "                    text Role: 文本, Value: 其他聊天",
    "                container Role: 组",
    "                    31 text area Role: 文本区域, Value: ",
    "                    32 button Role: 按钮 发送 Secondary Actions: Raise",
  ].filter(Boolean).join("\n");
}

function createHarness(snapshots, { apps = null, windows = null, omitTokensAt = [] } = {}) {
  const calls = [];
  let snapshotIndex = 0;
  const driverCall = async (name, args, context) => {
    calls.push({ name, args, context });
    if (name === "check_permissions") return { accessibility: true };
    if (name === "get_config") return { capture_mode: "ax" };
    if (name === "list_apps") {
      return { apps: apps || [{
        running: true,
        bundle_id: "com.tencent.xinWeChat",
        launch_path: "/Applications/WeChat.app",
        name: "微信",
        pid: PID,
      }] };
    }
    if (name === "list_windows") {
      return {
        current_space_id: 1,
        windows: windows || [{
          pid: PID,
          app_name: "微信",
          window_id: WINDOW_ID,
          title: "微信",
          bounds: { x: 0, y: 0, width: 900, height: 700 },
          is_on_screen: true,
          on_current_space: true,
        }],
      };
    }
    if (name === "get_window_state") {
      const sequence = snapshotIndex;
      const current = snapshots[Math.min(sequence, snapshots.length - 1)];
      snapshotIndex += 1;
      const snapshotId = `s${(sequence + 1).toString(16).padStart(8, "0")}`;
      const indices = [...String(current).matchAll(/^\s*(\d+)\s+/gm)].map((match) => Number(match[1]));
      return {
        pid: PID,
        window_id: WINDOW_ID,
        element_count: String(current).split("\n").length,
        tree_markdown: current,
        snapshot_id: snapshotId,
        elements: omitTokensAt.includes(sequence) ? [] : indices.map((elementIndex) => ({
          element_index: elementIndex,
          element_token: `${snapshotId}:${elementIndex}`,
        })),
      };
    }
    if (name === "set_value" || name === "click") return { acknowledged: true };
    throw new Error("unexpected_tool");
  };
  return { calls, driverCall };
}

const discoverSocket = async () => "/private/tmp/interpreter-driver.sock";

test("Cua Driver 0.22.2 check_permissions JSON 优先按结构化权限解析", () => {
  assert.deepEqual(
    parseDriverPermissionOutput('{"accessibility":true,"screen_recording":true}'),
    { accessibility: true, screen_recording: true },
  );
  assert.deepEqual(
    parseDriverPermissionOutput('Accessibility: granted\nScreen Recording: granted'),
    { accessibility: true },
  );
});

test("Cua 权限只读查询偶发超时时重试一次但不绕过授权门", async () => {
  const harness = createHarness([opaqueLoginTree()]);
  let permissionReads = 0;
  const driverCall = async (name, args, context) => {
    if (name === "check_permissions" && ++permissionReads === 1) {
      throw new Error("transient_permission_timeout");
    }
    return harness.driverCall(name, args, context);
  };
  const outcome = await runOpenInterpreterKeepalive({ discoverSocket, driverCall });
  assert.deepEqual(outcome, { ok: false, code: "auth_required" });
  assert.equal(permissionReads, 2);
  assert.equal(harness.calls.some(({ name }) => name === "set_value" || name === "click"), false);
});

test("认证页立即返回 auth_required，绝不执行任何 AX 写动作", async () => {
  const harness = createHarness([authTree()]);
  const outcome = await runOpenInterpreterKeepalive({
    discoverSocket,
    driverCall: harness.driverCall,
  });
  assert.deepEqual(outcome, { ok: false, code: "auth_required" });
  assert.equal(harness.calls.some(({ name }) => name === "set_value" || name === "click"), false);
});

test("登录窗口只暴露菜单和窗口框架时也按 auth_required 停止", async () => {
  const harness = createHarness([opaqueLoginTree()]);
  const outcome = await runOpenInterpreterKeepalive({
    discoverSocket,
    driverCall: harness.driverCall,
  });
  assert.deepEqual(outcome, { ok: false, code: "auth_required" });
  assert.equal(harness.calls.some(({ name }) => name === "set_value" || name === "click"), false);
});

test("微信的高层小浮窗不会被当成主界面读取", async () => {
  const windows = [{
    pid: PID,
    app_name: "微信",
    window_id: WINDOW_ID,
    title: "微信",
    bounds: { x: 0, y: 0, width: 900, height: 700 },
    layer: 0,
    is_on_screen: true,
    on_current_space: true,
  }, {
    pid: PID,
    app_name: "微信",
    window_id: 9999,
    title: "",
    bounds: { x: 0, y: 0, width: 35, height: 19 },
    layer: 103,
    is_on_screen: true,
    on_current_space: true,
  }];
  const harness = createHarness([opaqueLoginTree()], { windows });
  const outcome = await runOpenInterpreterKeepalive({
    discoverSocket,
    driverCall: harness.driverCall,
  });
  assert.deepEqual(outcome, { ok: false, code: "auth_required" });
  assert.deepEqual(
    harness.calls.filter(({ name }) => name === "get_window_state").map(({ args }) => args.window_id),
    [WINDOW_ID],
  );
});

test("Cua 只读窗口树偶发超时时只重读一次，不执行写动作", async () => {
  const harness = createHarness([opaqueLoginTree()]);
  let reads = 0;
  const driverCall = async (name, args, context) => {
    if (name === "get_window_state" && ++reads === 1) throw new Error("transient_ax_timeout");
    return harness.driverCall(name, args, context);
  };
  const outcome = await runOpenInterpreterKeepalive({ discoverSocket, driverCall });
  assert.deepEqual(outcome, { ok: false, code: "auth_required" });
  assert.equal(reads, 2);
  assert.equal(harness.calls.some(({ name }) => name === "set_value" || name === "click"), false);
});

test("驱动未启动时会后台拉起 CuaDriver 并重新发现套接字", async () => {
  let discoveries = 0;
  let launches = 0;
  const harness = createHarness([opaqueLoginTree()]);
  const outcome = await runOpenInterpreterKeepalive({
    discoverSocket: async () => (++discoveries >= 2 ? "/private/tmp/interpreter-driver.sock" : null),
    launchInterpreter: async () => { launches += 1; },
    wait: async () => {},
    driverCall: harness.driverCall,
  });
  assert.deepEqual(outcome, { ok: false, code: "auth_required" });
  assert.equal(launches, 1);
  assert.equal(discoveries, 2);
});

test("目标联系人出现多个精确匹配时 fail closed 且不动作", async () => {
  const harness = createHarness([contactTree({ duplicate: true })]);
  const outcome = await runOpenInterpreterKeepalive({
    discoverSocket,
    driverCall: harness.driverCall,
  });
  assert.deepEqual(outcome, { ok: false, code: "target_not_ready" });
  assert.equal(harness.calls.some(({ name }) => name === "set_value" || name === "click"), false);
});

test("侧栏非动作标题不能与另一会话的编辑框误绑定", async () => {
  const harness = createHarness([tree({ title: "其他聊天", sidebarTarget: true })]);
  const outcome = await runOpenInterpreterKeepalive({
    discoverSocket,
    driverCall: harness.driverCall,
  });
  assert.deepEqual(outcome, { ok: false, code: "target_not_ready" });
  assert.equal(harness.calls.some(({ name }) => name === "set_value" || name === "click"), false);
});

test("只有名称像微信但 bundle id 不匹配时不会接管", async () => {
  const harness = createHarness([tree()], {
    apps: [{ running: true, bundle_id: "invalid.wechat.lookalike", name: "微信", pid: PID }],
  });
  const outcome = await runOpenInterpreterKeepalive({
    discoverSocket,
    driverCall: harness.driverCall,
  });
  assert.deepEqual(outcome, { ok: false, code: "target_not_ready" });
  assert.equal(harness.calls.some(({ name }) => name === "list_windows"), false);
});

test("LaunchServices 错报 backup 但实际进程是正式微信时仍接受", async () => {
  const harness = createHarness([opaqueLoginTree()], {
    apps: [{
      running: true,
      bundle_id: "com.tencent.xinWeChat",
      launch_path: "/Applications/WeChat.tampered-backup-20260806.app",
      name: "微信",
      pid: PID,
    }],
  });
  const outcome = await runOpenInterpreterKeepalive({ discoverSocket, driverCall: harness.driverCall });
  assert.deepEqual(outcome, { ok: false, code: "auth_required" });
  assert.deepEqual(
    harness.calls.filter(({ name }) => name === "list_windows").map(({ args }) => args.pid),
    [PID],
  );
});

test("metadata 声称正式但实际进程来自 backup 时拒绝绑定", async () => {
  const harness = createHarness([tree()], {
    apps: [{
      running: true,
      bundle_id: "com.tencent.xinWeChat",
      launch_path: "/Applications/WeChat.app",
      name: "微信",
      pid: PID,
    }],
  });
  const outcome = await runOpenInterpreterKeepalive({
    discoverSocket,
    driverCall: harness.driverCall,
    resolveProcessExecutable: async () => BACKUP_WECHAT_EXECUTABLE,
  });
  assert.deepEqual(outcome, { ok: false, code: "target_not_ready" });
  assert.equal(harness.calls.some(({ name }) => name === "list_windows"), false);
});

test("正式微信与同 bundle id 备份同时运行时按实际进程路径只绑定正式 PID", async () => {
  const harness = createHarness([opaqueLoginTree()], {
    apps: [{
      running: true,
      bundle_id: "com.tencent.xinWeChat",
      launch_path: "/Applications/WeChat.app",
      name: "微信",
      pid: PID,
    }, {
      running: true,
      bundle_id: "com.tencent.xinWeChat",
      launch_path: "/Applications/WeChat.tampered-backup-20260806.app",
      name: "微信",
      pid: 7331,
    }],
  });
  const outcome = await runOpenInterpreterKeepalive({
    discoverSocket,
    driverCall: harness.driverCall,
    resolveProcessExecutable: async (pid) => (
      pid === PID ? OFFICIAL_WECHAT_EXECUTABLE : BACKUP_WECHAT_EXECUTABLE
    ),
  });
  assert.deepEqual(outcome, { ok: false, code: "auth_required" });
  assert.deepEqual(
    harness.calls.filter(({ name }) => name === "list_windows").map(({ args }) => args.pid),
    [PID],
  );
});

test("同 bundle id 的多个正式微信 PID 同时存在时 fail closed", async () => {
  const secondPid = 7331;
  const harness = createHarness([tree()], {
    apps: [{
      running: true,
      bundle_id: "com.tencent.xinWeChat",
      launch_path: "/Applications/WeChat.tampered-backup-20260806.app",
      name: "微信",
      pid: PID,
    }, {
      running: true,
      bundle_id: "com.tencent.xinWeChat",
      launch_path: "/Applications/WeChat.app",
      name: "微信",
      pid: secondPid,
    }],
  });
  const outcome = await runOpenInterpreterKeepalive({
    discoverSocket,
    driverCall: harness.driverCall,
    resolveProcessExecutable: async () => OFFICIAL_WECHAT_EXECUTABLE,
  });
  assert.deepEqual(outcome, { ok: false, code: "target_ambiguous" });
  assert.equal(harness.calls.some(({ name }) => name === "list_windows"), false);
});

test("dry-run 只完成 AX 校验，不输入也不发送", async () => {
  const harness = createHarness([tree()]);
  const outcome = await runOpenInterpreterKeepalive({
    discoverSocket,
    driverCall: harness.driverCall,
    dryRun: true,
  });
  assert.deepEqual(outcome, { ok: false, code: "send_uncertain" });
  assert.equal(harness.calls.some(({ name }) => name === "set_value" || name === "click"), false);
});

test("缺少同次 snapshot_id/element_token 绑定时 fail closed", async () => {
  const harness = createHarness([tree()], { omitTokensAt: [0] });
  const outcome = await runOpenInterpreterKeepalive({ discoverSocket, driverCall: harness.driverCall });
  assert.deepEqual(outcome, { ok: false, code: "ax_incomplete" });
  assert.equal(harness.calls.some(({ name }) => name === "set_value" || name === "click"), false);
});

test("已验证的唯一私聊只写入固定 ASCII 文本并语义点击唯一发送按钮", async () => {
  const harness = createHarness([
    tree({ withSearch: true }),
    tree({ value: OPEN_INTERPRETER_KEEPALIVE_TEXT, withSearch: true }),
    tree({ withSearch: true, sentCopies: 1 }),
  ]);
  const outcome = await runOpenInterpreterKeepalive({
    discoverSocket,
    driverCall: harness.driverCall,
  });
  assert.deepEqual(outcome, { ok: true, code: "keepalive_sent" });
  const writes = harness.calls.filter(({ name }) => name === "set_value");
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].args, {
    pid: PID,
    window_id: WINDOW_ID,
    element_index: 31,
    snapshot_id: "s00000001",
    element_token: "s00000001:31",
    value: "ZT_KEEPALIVE",
  });
  const clicks = harness.calls.filter(({ name }) => name === "click");
  assert.equal(clicks.length, 1);
  assert.deepEqual(clicks[0].args, {
    pid: PID,
    window_id: WINDOW_ID,
    element_index: 32,
    snapshot_id: "s00000002",
    element_token: "s00000002:32",
    action: "press",
  });
});

test("输入后聊天标题发生变化时返回 state_changed 且绝不点击发送", async () => {
  const harness = createHarness([
    tree(),
    tree({ title: "其他聊天", value: OPEN_INTERPRETER_KEEPALIVE_TEXT }),
  ]);
  const outcome = await runOpenInterpreterKeepalive({
    discoverSocket,
    driverCall: harness.driverCall,
  });
  assert.deepEqual(outcome, {
    ok: false,
    code: "state_changed",
    terminal: true,
    needs_user: true,
    reason: "draft_cleanup_unconfirmed",
  });
  assert.equal(harness.calls.filter(({ name }) => name === "set_value").length, 1);
  assert.equal(harness.calls.some(({ name }) => name === "click"), false);
});

test("输入后只发现会话容器里的无关发送按钮时清空草稿并停止", async () => {
  const harness = createHarness([
    tree({ send: false, broadSend: true }),
    tree({ value: OPEN_INTERPRETER_KEEPALIVE_TEXT, send: false, broadSend: true }),
    tree({ send: false, broadSend: true }),
  ]);
  const outcome = await runOpenInterpreterKeepalive({
    discoverSocket,
    driverCall: harness.driverCall,
  });
  assert.deepEqual(outcome, { ok: false, code: "state_changed" });
  assert.deepEqual(
    harness.calls.filter(({ name }) => name === "set_value").map(({ args }) => args.value),
    ["ZT_KEEPALIVE", ""],
  );
  assert.equal(harness.calls.some(({ name }) => name === "click"), false);
});

test("输入后同一编辑区出现两个发送按钮时清空草稿并 fail closed", async () => {
  const harness = createHarness([
    tree({ duplicateSend: true }),
    tree({ value: OPEN_INTERPRETER_KEEPALIVE_TEXT, duplicateSend: true }),
    tree({ duplicateSend: true }),
  ]);
  const outcome = await runOpenInterpreterKeepalive({
    discoverSocket,
    driverCall: harness.driverCall,
  });
  assert.deepEqual(outcome, { ok: false, code: "target_ambiguous" });
  assert.deepEqual(
    harness.calls.filter(({ name }) => name === "set_value").map(({ args }) => args.value),
    ["ZT_KEEPALIVE", ""],
  );
  assert.equal(harness.calls.some(({ name }) => name === "click"), false);
});

test("set_value 超时但可能已写入时会先精确回读再清空", async () => {
  const harness = createHarness([
    tree(),
    tree({ value: OPEN_INTERPRETER_KEEPALIVE_TEXT }),
    tree(),
  ]);
  let injectedTimeout = false;
  const driverCall = async (name, args, context) => {
    const response = await harness.driverCall(name, args, context);
    if (name === "set_value" && args.value === OPEN_INTERPRETER_KEEPALIVE_TEXT && !injectedTimeout) {
      injectedTimeout = true;
      throw new Error("simulated_timeout_after_write");
    }
    return response;
  };
  const outcome = await runOpenInterpreterKeepalive({ discoverSocket, driverCall });
  assert.deepEqual(outcome, { ok: false, code: "state_changed" });
  assert.deepEqual(
    harness.calls.filter(({ name }) => name === "set_value").map(({ args }) => args.value),
    ["ZT_KEEPALIVE", ""],
  );
  assert.equal(harness.calls.some(({ name }) => name === "click"), false);
});

test("点击发送后超时标记 send_uncertain，不再改写可能已发送的草稿", async () => {
  const harness = createHarness([
    tree(),
    tree({ value: OPEN_INTERPRETER_KEEPALIVE_TEXT }),
  ]);
  const driverCall = async (name, args, context) => {
    const response = await harness.driverCall(name, args, context);
    if (name === "click" && args.element_index === 32) throw new Error("simulated_timeout_after_click");
    return response;
  };
  const outcome = await runOpenInterpreterKeepalive({ discoverSocket, driverCall });
  assert.deepEqual(outcome, {
    ok: false,
    code: "send_uncertain",
    terminal: true,
    needs_user: true,
    reason: "send_uncertain",
  });
  assert.deepEqual(
    harness.calls.filter(({ name }) => name === "set_value").map(({ args }) => args.value),
    ["ZT_KEEPALIVE"],
  );
  assert.equal(harness.calls.filter(({ name }) => name === "click").length, 1);
});

test("当前是错误群聊时，即使侧栏出现目标名称也绝不写入或点击", async () => {
  const harness = createHarness([tree({ title: "5群禁广告-全城全品类撸货 (192)", sidebarTarget: true })]);
  const outcome = await runOpenInterpreterKeepalive({ discoverSocket, driverCall: harness.driverCall });
  assert.deepEqual(outcome, { ok: false, code: "target_not_ready" });
  assert.equal(harness.calls.some(({ name }) => name === "set_value" || name === "click"), false);
});

test("搜索框和模糊结果中的目标文字不能充当当前会话标题", async () => {
  const searchResultTree = tree({ title: "其他聊天", withSearch: true, sidebarTarget: true })
    .replace("21 text field Role: 文本框, Value: ", `21 text field Role: 文本框, Value: ${TARGET_CHAT}`)
    .replace(`22 text Role: 文本, Value: ${TARGET_CHAT}`, `22 row Role: 行 ${TARGET_CHAT}候选 Secondary Actions: Select`);
  const harness = createHarness([searchResultTree]);
  const outcome = await runOpenInterpreterKeepalive({ discoverSocket, driverCall: harness.driverCall });
  assert.deepEqual(outcome, { ok: false, code: "target_not_ready" });
  assert.equal(harness.calls.some(({ name }) => name === "set_value" || name === "click"), false);
});

test("普通静态文本即使精确等于目标也不能充当当前会话标题", async () => {
  const staticOnly = tree().replace("heading Role: 标题", "text Role: 文本");
  const harness = createHarness([staticOnly]);
  const outcome = await runOpenInterpreterKeepalive({ discoverSocket, driverCall: harness.driverCall });
  assert.deepEqual(outcome, { ok: false, code: "target_not_ready" });
  assert.equal(harness.calls.some(({ name }) => name === "set_value" || name === "click"), false);
});

test("已有重复保活草稿时保留原文并进入 needs_user 终态", async () => {
  const harness = createHarness([tree({ value: "ZT_KEEPALIVEZT_KEEPALIVE" })]);
  const outcome = await runOpenInterpreterKeepalive({ discoverSocket, driverCall: harness.driverCall });
  assert.deepEqual(outcome, {
    ok: false,
    code: "state_changed",
    terminal: true,
    needs_user: true,
    reason: "draft_present",
  });
  assert.equal(harness.calls.some(({ name }) => name === "set_value" || name === "click"), false);
});

test("点击已确认但回读没有新增出站气泡时标记发送不确定且禁止自动重试", async () => {
  const harness = createHarness([
    tree(),
    tree({ value: OPEN_INTERPRETER_KEEPALIVE_TEXT }),
    tree(),
  ]);
  const outcome = await runOpenInterpreterKeepalive({ discoverSocket, driverCall: harness.driverCall });
  assert.deepEqual(outcome, {
    ok: false,
    code: "send_uncertain",
    terminal: true,
    needs_user: true,
    reason: "send_uncertain",
  });
  assert.equal(harness.calls.filter(({ name }) => name === "click").length, 1);
  assert.deepEqual(
    harness.calls.filter(({ name }) => name === "set_value").map(({ args }) => args.value),
    ["ZT_KEEPALIVE"],
  );
});
