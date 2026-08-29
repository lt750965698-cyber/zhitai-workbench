import { execFile as execFileCallback } from "node:child_process";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const DRIVER_PATH = "/Applications/CuaDriver.app/Contents/MacOS/cua-driver";
const DRIVER_DEFAULT_SOCKET = join(homedir(), "Library", "Caches", "cua-driver", "cua-driver.sock");
const WECHAT_BUNDLE_ID = "com.tencent.xinWeChat";
const WECHAT_LAUNCH_PATH = "/Applications/WeChat.app";
const WECHAT_EXECUTABLE_PATH = `${WECHAT_LAUNCH_PATH}/Contents/MacOS/WeChat`;
const TARGET_CHAT = "微信 ClawBot AI";
const KEEPALIVE_TEXT = "ZT_KEEPALIVE";
const AUTH_MARKERS = Object.freeze(["重新登录", "扫码登录", "进入微信", "安全确认"]);
const MAX_DRIVER_OUTPUT_BYTES = 2 * 1024 * 1024;
const DRIVER_TIMEOUT_MS = 8_000;
const DRIVER_START_TIMEOUT_MS = 10_000;
const DRIVER_START_POLL_MS = 250;

const ERROR_CODES = new Set([
  "driver_unavailable",
  "permission_denied",
  "auth_required",
  "target_not_ready",
  "target_ambiguous",
  "ax_incomplete",
  "state_changed",
  "send_uncertain",
]);

function result(ok, code) {
  return { ok: Boolean(ok), code: String(code) };
}

function failure(code) {
  return result(false, ERROR_CODES.has(code) ? code : "driver_unavailable");
}

function terminalFailure(code, reason = code) {
  return {
    ...failure(code),
    terminal: true,
    needs_user: true,
    reason: String(reason),
  };
}

function normalizeSpace(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isExactText(value, expected) {
  return normalizeSpace(value) === expected;
}

function extractJson(stdout) {
  const text = String(stdout ?? "").trim();
  const starts = [text.indexOf("{"), text.indexOf("[")]
    .filter((index) => index >= 0)
    .sort((a, b) => a - b);
  for (const start of starts) {
    try {
      return JSON.parse(text.slice(start));
    } catch {
      // A successful action can have a human-readable acknowledgement instead.
    }
  }
  return null;
}

function permissionResult(stdout) {
  const text = String(stdout ?? "");
  const accessibilityGranted = /Accessibility:\s*granted\b/i.test(text)
    || /辅助功能[^\n]*(?:已授权|granted)/i.test(text);
  const accessibilityDenied = /Accessibility:\s*(?:not granted|denied)\b/i.test(text)
    || /辅助功能[^\n]*(?:未授权|denied|not granted)/i.test(text);
  return {
    accessibility: accessibilityGranted && !accessibilityDenied,
  };
}

export function parseDriverPermissionOutput(stdout) {
  return extractJson(stdout) || permissionResult(stdout);
}

async function defaultDriverCall(name, args, { socket } = {}) {
  const allowed = new Set([
    "check_permissions",
    "get_config",
    "list_apps",
    "list_windows",
    "get_window_state",
    "set_value",
    "click",
  ]);
  if (!allowed.has(name) || typeof socket !== "string" || !socket.startsWith("/")) {
    throw new Error("driver_call_rejected");
  }
  const { stdout } = await execFile(
    DRIVER_PATH,
    ["call", name, JSON.stringify(args || {}), "--socket", socket, "--compact"],
    {
      encoding: "utf8",
      timeout: DRIVER_TIMEOUT_MS,
      maxBuffer: MAX_DRIVER_OUTPUT_BYTES,
      windowsHide: true,
    },
  );
  if (name === "check_permissions") return parseDriverPermissionOutput(stdout);
  return extractJson(stdout) || { acknowledged: true };
}

function extractSocketArgument(command) {
  const match = String(command ?? "").match(/(?:^|\s)--socket\s+("[^"\n]+"|'[^'\n]+'|[^\s\n]+)/);
  if (!match) return null;
  let value = match[1];
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    value = value.slice(1, -1);
  }
  return value.startsWith("/") && !value.includes("\0") ? value : null;
}

async function isPrivateUserSocket(socket) {
  try {
    const info = await lstat(socket);
    return info.isSocket()
      && info.uid === process.getuid?.()
      && (info.mode & 0o777) === 0o600;
  } catch {
    return false;
  }
}

export async function discoverInterpreterDriverSocket() {
  try {
    const { stdout } = await execFile("/bin/ps", ["-axo", "uid=,command="], {
      encoding: "utf8",
      timeout: 3_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
    });
    const uid = String(process.getuid?.() ?? "");
    const candidates = [];
    for (const line of String(stdout).split("\n")) {
      const match = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!match || match[1] !== uid) continue;
      const command = match[2];
      if (command !== `${DRIVER_PATH} serve` && !command.startsWith(`${DRIVER_PATH} serve `)) continue;
      const socket = extractSocketArgument(command) || DRIVER_DEFAULT_SOCKET;
      if (socket && await isPrivateUserSocket(socket)) candidates.push(socket);
    }
    const unique = [...new Set(candidates)];
    return unique.length === 1 ? unique[0] : null;
  } catch {
    return null;
  }
}

async function defaultLaunchInterpreter() {
  await execFile("/usr/bin/open", ["-n", "-g", "-a", "CuaDriver", "--args", "serve"], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function defaultResolveProcessExecutable(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    // `list_apps.launch_path` comes from LaunchServices and can point at a
    // stale copy when multiple apps share WeChat's bundle id. Ask the kernel's
    // process table which executable the candidate PID is actually running.
    // `-ww` is required on macOS; without it `comm` truncates the path.
    const { stdout } = await execFile(
      "/bin/ps",
      ["-ww", "-p", String(pid), "-o", "comm="],
      {
        encoding: "utf8",
        timeout: 3_000,
        maxBuffer: 16 * 1024,
        windowsHide: true,
      },
    );
    const lines = String(stdout)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.length === 1 ? lines[0] : null;
  } catch {
    return null;
  }
}

async function discoverOrLaunchDriver({ discoverSocket, launchInterpreter, wait }) {
  let socket = await discoverSocket();
  if (typeof socket === "string" && socket.startsWith("/")) return socket;
  await launchInterpreter();
  const deadline = Date.now() + DRIVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await wait(DRIVER_START_POLL_MS);
    socket = await discoverSocket();
    if (typeof socket === "string" && socket.startsWith("/")) return socket;
  }
  return null;
}

function normalizePermissions(value) {
  if (typeof value === "string") return permissionResult(value);
  const payload = value?.structuredContent || value;
  const raw = payload?.accessibility;
  if (raw === true || raw === "granted") return { accessibility: true };
  if (raw && typeof raw === "object" && (raw.granted === true || raw.status === "granted")) {
    return { accessibility: true };
  }
  return { accessibility: false };
}

function parseNodeLine(rawLine, stack) {
  const expanded = String(rawLine).replace(/\t/g, "    ");
  const indent = expanded.length - expanded.trimStart().length;
  let body = expanded.trim();
  let index = null;
  let match = body.match(/^\[element_index\s+(\d+)\]\s*(.*)$/i);
  if (match) {
    index = Number(match[1]);
    body = match[2];
  } else {
    match = body.match(/^(\d+)\s+(.*)$/);
    if (match) {
      index = Number(match[1]);
      body = match[2];
    }
  }
  const roleMarker = body.indexOf(" Role:");
  if (roleMarker < 0) return null;
  const kind = normalizeSpace(body.slice(0, roleMarker)).toLowerCase();
  const metadata = body.slice(roleMarker + 6).trim();
  const localizedRole = normalizeSpace(metadata.match(/^([^,\s]+)/)?.[1] || "");
  const valueMatch = metadata.match(/(?:^|,\s*)Value:\s*(.*?)(?=(?:,\s*[A-Za-z][A-Za-z ]*:)|(?:\s+(?:FOCUSED|Secondary Actions:|Selected\b))|$)/i);
  const hasValue = Boolean(valueMatch);
  const value = hasValue ? normalizeSpace(valueMatch[1]) : null;
  let labelPart = metadata;
  const firstComma = labelPart.indexOf(",");
  if (firstComma >= 0) labelPart = labelPart.slice(0, firstComma);
  labelPart = labelPart
    .replace(/\s+(?:FOCUSED|Secondary Actions:.*|Selected\b.*)$/i, "")
    .trim();
  const firstSpace = labelPart.indexOf(" ");
  const label = firstSpace >= 0 ? normalizeSpace(labelPart.slice(firstSpace + 1)) : "";

  while (stack.length && stack.at(-1).indent >= indent) stack.pop();
  const node = {
    indent,
    index: Number.isInteger(index) ? index : null,
    kind,
    localizedRole,
    label,
    value,
    hasValue,
    parent: stack.at(-1)?.node || null,
  };
  stack.push({ indent, node });
  return node;
}

function parseAxTree(tree) {
  const stack = [];
  return String(tree ?? "")
    .split("\n")
    .map((line) => parseNodeLine(line, stack))
    .filter(Boolean);
}

function nodeHasExactText(node, text) {
  return isExactText(node?.value, text) || isExactText(node?.label, text);
}

function isEditable(node) {
  return ["text area", "text field", "textarea", "textfield"].includes(node?.kind)
    || ["文本区域", "文本框", "编辑框"].includes(node?.localizedRole);
}

function isComposerEditor(node) {
  return ["text area", "textarea"].includes(node?.kind)
    || ["文本区域", "编辑框"].includes(node?.localizedRole);
}

function isTextual(node) {
  return ["text", "static text", "heading", "title"].includes(node?.kind)
    || ["文本", "静态文本", "标题"].includes(node?.localizedRole);
}

// WeChat's sidebar, search results and message history all contain ordinary
// static text.  A recipient name is therefore evidence of the active
// conversation only when AX itself exposes it with title/heading semantics.
// This deliberately sacrifices availability on incomplete AX trees rather
// than guessing from a matching string elsewhere in the window.
function isConversationTitle(node) {
  return ["heading", "title"].includes(node?.kind)
    || node?.localizedRole === "标题";
}

function ancestorChain(node) {
  const chain = [];
  for (let current = node; current; current = current.parent) chain.push(current);
  return chain.reverse();
}

function lowestCommonAncestor(...inputNodes) {
  const nodes = inputNodes.filter(Boolean);
  if (!nodes.length) return null;
  const chains = nodes.map(ancestorChain);
  const limit = Math.min(...chains.map((chain) => chain.length));
  let common = null;
  for (let index = 0; index < limit; index += 1) {
    const candidate = chains[0][index];
    if (!chains.every((chain) => chain[index] === candidate)) break;
    common = candidate;
  }
  return common;
}

function isDescendantOf(node, ancestor) {
  for (let current = node; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
}

function isStructuralContainer(node) {
  return ["container", "group", "split group", "scroll area"].includes(node?.kind)
    || ["组", "分割组", "滚动区域"].includes(node?.localizedRole);
}

function isChatPaneContainer(node) {
  return ["container", "group"].includes(node?.kind)
    || node?.localizedRole === "组";
}

function hasActionableAncestor(node) {
  for (let current = node?.parent; current; current = current.parent) {
    if (["row", "cell", "button", "menu item", "link"].includes(current.kind)) return true;
  }
  return false;
}

function hasExcludedTitleAncestor(node, stopAt) {
  for (let current = node?.parent; current && current !== stopAt; current = current.parent) {
    if (["row", "cell", "scroll area", "table", "outline", "menu"].includes(current.kind)) return true;
  }
  return false;
}

function nodesWithin(nodes, ancestor, predicate) {
  return nodes.filter((node) => isDescendantOf(node, ancestor) && predicate(node));
}

function editorHasValue(node, expected) {
  if (!node?.hasValue) return false;
  return isExactText(node.value, expected);
}

function findChatState(nodes, expectedEditorValue) {
  const titles = nodes.filter((node) => isConversationTitle(node)
    && nodeHasExactText(node, TARGET_CHAT)
    && !hasActionableAncestor(node));
  if (!titles.length) return { ok: false, code: "target_not_ready" };
  const editors = nodes.filter((node) => isComposerEditor(node) && Number.isInteger(node.index));
  const candidates = [];
  for (const title of titles) {
    for (const editor of editors) {
      const container = lowestCommonAncestor(title, editor);
      if (!isChatPaneContainer(container) || hasExcludedTitleAncestor(title, container)) continue;
      // The proven chat pane must contain exactly one non-actionable header,
      // exactly one composer, and no search/other editable field. This rejects
      // a broad split-view ancestor that merely contains both the sidebar and
      // the active conversation.
      const paneTitles = nodesWithin(nodes, container, (node) => isConversationTitle(node)
        && nodeHasExactText(node, TARGET_CHAT)
        && !hasActionableAncestor(node));
      const paneEditors = nodesWithin(nodes, container, isEditable);
      const paneNavigation = nodesWithin(nodes, container, (node) => [
        "row",
        "cell",
        "table",
        "outline",
        "menu item",
      ].includes(node.kind));
      if (paneTitles.length !== 1
        || paneEditors.length !== 1
        || paneEditors[0] !== editor
        || paneNavigation.length) continue;
      candidates.push({ title, editor, container });
    }
  }
  const unique = new Map(candidates.map((candidate) => [
    `${candidate.editor.index}:${nodes.indexOf(candidate.container)}`,
    candidate,
  ]));
  if (unique.size !== 1) return { ok: false, code: unique.size > 1 ? "target_ambiguous" : "target_not_ready" };
  const [{ editor, container }] = [...unique.values()];
  if (!editor.hasValue) return { ok: false, code: "state_changed" };
  if (expectedEditorValue !== undefined && !editorHasValue(editor, expectedEditorValue)) {
    return { ok: false, code: "state_changed" };
  }
  return { ok: true, editor, container };
}

function hasTranscriptAncestor(node, chatContainer) {
  for (let current = node?.parent; current && current !== chatContainer; current = current.parent) {
    if (["scroll area", "list", "table", "outline"].includes(current.kind)
      || ["滚动区域", "列表", "表格"].includes(current.localizedRole)) return true;
  }
  return false;
}

function visibleSentKeepaliveCount(nodes, chat) {
  return nodes.filter((node) => isTextual(node)
    && nodeHasExactText(node, KEEPALIVE_TEXT)
    && isDescendantOf(node, chat.container)
    && hasTranscriptAncestor(node, chat.container)
    && !hasActionableAncestor(node)).length;
}

function actionableAncestor(node, allowedKinds) {
  for (let current = node; current; current = current.parent) {
    if (Number.isInteger(current.index) && allowedKinds.has(current.kind)) return current;
  }
  return null;
}

function findExactActions(nodes, text, allowedKinds) {
  const indices = new Map();
  for (const node of nodes) {
    if (!nodeHasExactText(node, text)) continue;
    const action = actionableAncestor(node, allowedKinds);
    if (!action) continue;
    indices.set(action.index, action);
  }
  return [...indices.values()];
}

function findComposerSendActions(nodes, chat) {
  const actions = findExactActions(nodes, "发送", new Set(["button"]))
    .filter((action) => isDescendantOf(action, chat.container));
  const accepted = [];
  for (const action of actions) {
    const composer = lowestCommonAncestor(chat.editor, action);
    if (!isStructuralContainer(composer) || composer === chat.container) continue;
    if (!isDescendantOf(composer, chat.container)) continue;
    const composerEditors = nodesWithin(nodes, composer, isComposerEditor);
    if (composerEditors.length !== 1 || composerEditors[0] !== chat.editor) continue;
    accepted.push(action);
  }
  return [...new Map(accepted.map((action) => [action.index, action])).values()];
}

function authMarkerPresent(tree) {
  const text = String(tree ?? "");
  return AUTH_MARKERS.some((marker) => text.includes(marker));
}

function validWindow(window, pid) {
  return window
    && Number(window.pid) === pid
    && Number.isInteger(Number(window.window_id))
    && window.is_on_screen === true
    && window.on_current_space === true
    && Number.isFinite(Number(window.bounds?.width))
    && Number.isFinite(Number(window.bounds?.height));
}

function inspectableWindow(window, pid) {
  return validWindow(window, pid)
    && Number(window.layer ?? 0) === 0
    && Number(window.bounds.width) >= 200
    && Number(window.bounds.height) >= 100;
}

function mainWindows(windows, pid) {
  return windows.filter((window) => validWindow(window, pid)
    && Number(window.bounds.width) >= 700
    && Number(window.bounds.height) >= 500);
}

function unwrapSnapshot(value) {
  const snapshot = value?.structuredContent || value;
  return snapshot && typeof snapshot.tree_markdown === "string" ? snapshot : null;
}

function elementBinding(snapshot, elementIndex) {
  if (!snapshot || !/^s[0-9a-f]{8}$/.test(String(snapshot.snapshot_id ?? ""))) return null;
  if (!Array.isArray(snapshot.elements)) return null;
  const matches = snapshot.elements.filter((element) => Number(element?.element_index) === elementIndex
    && typeof element?.element_token === "string"
    && element.element_token.length > 0);
  if (matches.length !== 1) return null;
  return {
    element_index: elementIndex,
    snapshot_id: snapshot.snapshot_id,
    element_token: matches[0].element_token,
  };
}

async function callAx(driverCall, socket, name, args) {
  return driverCall(name, args, { socket });
}

async function getWindows(driverCall, socket, pid) {
  const value = await callAx(driverCall, socket, "list_windows", { pid, on_screen_only: false });
  const payload = value?.structuredContent || value;
  return Array.isArray(payload?.windows) ? payload.windows : null;
}

async function getSnapshot(driverCall, socket, pid, windowId) {
  const value = await callAx(driverCall, socket, "get_window_state", {
    pid,
    window_id: windowId,
    include_screenshot: false,
  });
  return unwrapSnapshot(value);
}

async function inspectVisibleWindows(driverCall, socket, pid, windows) {
  // WeChat exposes tiny high-layer status/tooltip surfaces that do not have a
  // usable AX tree. They are never message or login windows, so do not let one
  // turn a healthy driver into a false driver_unavailable result.
  const visible = windows.filter((window) => inspectableWindow(window, pid));
  if (!visible.length) return { ok: false, code: "target_not_ready" };
  if (visible.length > 12) return { ok: false, code: "target_ambiguous" };
  const snapshots = new Map();
  for (const window of visible) {
    // AX can transiently time out even while the Cua daemon and socket remain
    // healthy. This phase is strictly read-only, so one bounded reread is safe;
    // never apply this retry to set_value or the send click.
    let snapshot = await getSnapshot(
      driverCall,
      socket,
      pid,
      Number(window.window_id),
    ).catch(() => null);
    if (!snapshot) {
      snapshot = await getSnapshot(
        driverCall,
        socket,
        pid,
        Number(window.window_id),
      ).catch(() => null);
    }
    if (!snapshot) return { ok: false, code: "ax_incomplete" };
    if (authMarkerPresent(snapshot.tree_markdown)) return { ok: false, code: "auth_required" };
    snapshots.set(Number(window.window_id), snapshot);
  }
  return { ok: true, snapshots };
}

async function clearVerifiedKeepaliveDraft({
  driverCall,
  socket,
  pid,
  windowId,
  snapshot,
  expectedEditorIndex,
}) {
  if (!snapshot || authMarkerPresent(snapshot.tree_markdown)) return false;
  const current = findChatState(parseAxTree(snapshot.tree_markdown), KEEPALIVE_TEXT);
  if (!current.ok || current.editor.index !== expectedEditorIndex) return false;
  const binding = elementBinding(snapshot, expectedEditorIndex);
  if (!binding) return false;
  try {
    await callAx(driverCall, socket, "set_value", {
      pid,
      window_id: windowId,
      ...binding,
      value: "",
    });
  } catch {
    return false;
  }
  const clearedSnapshot = await getSnapshot(driverCall, socket, pid, windowId).catch(() => null);
  if (!clearedSnapshot || authMarkerPresent(clearedSnapshot.tree_markdown)) return false;
  const cleared = findChatState(parseAxTree(clearedSnapshot.tree_markdown), "");
  return cleared.ok && cleared.editor.index === expectedEditorIndex;
}

/**
 * Send the single fixed ClawBot keepalive through the maintained CuaDriver.app
 * AX daemon. The recipient and body are deliberately not parameters.
 */
export async function runOpenInterpreterKeepalive(options = {}) {
  const driverCall = typeof options.driverCall === "function" ? options.driverCall : defaultDriverCall;
  const discoverSocket = typeof options.discoverSocket === "function"
    ? options.discoverSocket
    : discoverInterpreterDriverSocket;
  const launchInterpreter = typeof options.launchInterpreter === "function"
    ? options.launchInterpreter
    : defaultLaunchInterpreter;
  const wait = typeof options.wait === "function" ? options.wait : delay;
  const resolveProcessExecutable = typeof options.resolveProcessExecutable === "function"
    ? options.resolveProcessExecutable
    : defaultResolveProcessExecutable;
  const dryRun = options.dryRun === true;

  let socket;
  try {
    socket = await discoverOrLaunchDriver({ discoverSocket, launchInterpreter, wait });
  } catch {
    return failure("driver_unavailable");
  }
  if (typeof socket !== "string" || !socket.startsWith("/")) return failure("driver_unavailable");

  let permission;
  try {
    permission = normalizePermissions(await callAx(driverCall, socket, "check_permissions", { prompt: false }));
  } catch {
    // The daemon occasionally stalls on permission introspection while AX
    // reads remain healthy. Retrying this read-only probe once avoids a false
    // driver_unavailable without bypassing the permission gate.
    try {
      permission = normalizePermissions(await callAx(
        driverCall,
        socket,
        "check_permissions",
        { prompt: false },
      ));
    } catch {
      return failure("driver_unavailable");
    }
  }
  if (!permission.accessibility) return failure("permission_denied");

  let pendingDraft = null;
  let sendAttempted = false;
  try {
    const configValue = await callAx(driverCall, socket, "get_config", {});
    const config = configValue?.structuredContent || configValue;
    // Current Cua Driver removed capture_mode; every state read below passes
    // include_screenshot:false. Retain the old fail-closed check only when a
    // legacy daemon still reports that setting.
    if (Object.hasOwn(config || {}, "capture_mode") && config.capture_mode !== "ax") {
      return failure("ax_incomplete");
    }

    const appsValue = await callAx(driverCall, socket, "list_apps", {});
    const appsPayload = appsValue?.structuredContent || appsValue;
    if (!Array.isArray(appsPayload?.apps)) return failure("ax_incomplete");
    // The bundle id is still mandatory, but LaunchServices' launch_path is
    // only advisory: it is known to report an old backup even when the PID is
    // executing the canonical /Applications/WeChat.app binary. Resolve every
    // candidate PID independently and bind only one exact executable match.
    const candidatePids = [...new Set(appsPayload.apps
      .filter((app) => app?.running === true
        && app.bundle_id === WECHAT_BUNDLE_ID
        && Number.isInteger(Number(app.pid))
        && Number(app.pid) > 0)
      .map((app) => Number(app.pid)))];
    const pids = [];
    for (const candidatePid of candidatePids) {
      const executable = await resolveProcessExecutable(candidatePid).catch(() => null);
      if (executable === WECHAT_EXECUTABLE_PATH) pids.push(candidatePid);
    }
    if (pids.length !== 1) return failure(pids.length > 1 ? "target_ambiguous" : "target_not_ready");
    const pid = pids[0];

    let windows = await getWindows(driverCall, socket, pid);
    if (!windows) return failure("ax_incomplete");
    let inspection = await inspectVisibleWindows(driverCall, socket, pid, windows);
    if (!inspection.ok) return failure(inspection.code);
    let candidates = mainWindows(windows, pid);
    if (candidates.length !== 1) {
      return failure(candidates.length > 1 ? "target_ambiguous" : "target_not_ready");
    }
    const windowId = Number(candidates[0].window_id);
    let snapshot = inspection.snapshots.get(windowId);
    if (!snapshot) return failure("ax_incomplete");
    let nodes = parseAxTree(snapshot.tree_markdown);
    if (!nodes.length) return failure("ax_incomplete");
    if (!nodes.some(isEditable) && !nodes.some((node) => nodeHasExactText(node, TARGET_CHAT))) {
      const elementCount = Number(snapshot.element_count);
      return failure(Number.isFinite(elementCount) && elementCount <= 30 ? "auth_required" : "ax_incomplete");
    }

    // Never navigate from a sidebar/search result.  The current conversation
    // must already be independently proven by its semantic AX heading.
    let chat = findChatState(nodes, undefined);
    if (!chat.ok) return failure(chat.code);

    const originalDraft = normalizeSpace(chat.editor.value);
    if (originalDraft !== "") {
      // Preserve any existing user draft, including a leftover keepalive.
      // Replacing or appending here can either destroy user text or create the
      // duplicated ZT_KEEPALIVEZT_KEEPALIVE failure this runner must prevent.
      return terminalFailure("state_changed", "draft_present");
    }
    const initialSentKeepaliveCount = visibleSentKeepaliveCount(nodes, chat);

    if (dryRun) return failure("send_uncertain");

    pendingDraft = {
      pid,
      windowId,
      editorIndex: chat.editor.index,
    };
    const editorBinding = elementBinding(snapshot, chat.editor.index);
    if (!editorBinding) return failure("ax_incomplete");
    try {
      await callAx(driverCall, socket, "set_value", {
        pid,
        window_id: windowId,
        ...editorBinding,
        value: KEEPALIVE_TEXT,
      });
    } catch {
      const cleanupSnapshot = await getSnapshot(driverCall, socket, pid, windowId).catch(() => null);
      const cleaned = await clearVerifiedKeepaliveDraft({
        driverCall,
        socket,
        pid,
        windowId,
        snapshot: cleanupSnapshot,
        expectedEditorIndex: chat.editor.index,
      });
      return cleaned
        ? failure("state_changed")
        : terminalFailure("state_changed", "draft_cleanup_unconfirmed");
    }

    const typedSnapshot = await getSnapshot(driverCall, socket, pid, windowId).catch(() => null);
    if (!typedSnapshot) {
      const retrySnapshot = await getSnapshot(driverCall, socket, pid, windowId).catch(() => null);
      const cleaned = await clearVerifiedKeepaliveDraft({
        driverCall,
        socket,
        pid,
        windowId,
        snapshot: retrySnapshot,
        expectedEditorIndex: chat.editor.index,
      });
      return cleaned
        ? failure("state_changed")
        : terminalFailure("state_changed", "draft_cleanup_unconfirmed");
    }
    if (authMarkerPresent(typedSnapshot.tree_markdown)) {
      return terminalFailure("auth_required", "draft_cleanup_unconfirmed");
    }
    const typedNodes = parseAxTree(typedSnapshot.tree_markdown);
    const typedChat = findChatState(typedNodes, KEEPALIVE_TEXT);
    if (!typedChat.ok) {
      const cleaned = await clearVerifiedKeepaliveDraft({
        driverCall,
        socket,
        pid,
        windowId,
        snapshot: typedSnapshot,
        expectedEditorIndex: chat.editor.index,
      });
      return cleaned
        ? failure("state_changed")
        : terminalFailure("state_changed", "draft_cleanup_unconfirmed");
    }
    const sendButtons = findComposerSendActions(typedNodes, typedChat);
    if (sendButtons.length !== 1) {
      const cleaned = await clearVerifiedKeepaliveDraft({
        driverCall,
        socket,
        pid,
        windowId,
        snapshot: typedSnapshot,
        expectedEditorIndex: typedChat.editor.index,
      });
      const code = sendButtons.length > 1 ? "target_ambiguous" : "state_changed";
      return cleaned ? failure(code) : terminalFailure(code, "draft_cleanup_unconfirmed");
    }
    const sendBinding = elementBinding(typedSnapshot, sendButtons[0].index);
    if (!sendBinding) {
      const cleaned = await clearVerifiedKeepaliveDraft({
        driverCall,
        socket,
        pid,
        windowId,
        snapshot: typedSnapshot,
        expectedEditorIndex: typedChat.editor.index,
      });
      return cleaned
        ? failure("ax_incomplete")
        : terminalFailure("ax_incomplete", "draft_cleanup_unconfirmed");
    }

    try {
      sendAttempted = true;
      await callAx(driverCall, socket, "click", {
        pid,
        window_id: windowId,
        ...sendBinding,
        action: "press",
      });
    } catch {
      return terminalFailure("send_uncertain");
    }

    const sentSnapshot = await getSnapshot(driverCall, socket, pid, windowId).catch(() => null);
    if (!sentSnapshot || authMarkerPresent(sentSnapshot.tree_markdown)) {
      return terminalFailure("send_uncertain");
    }
    const sentNodes = parseAxTree(sentSnapshot.tree_markdown);
    const sentChat = findChatState(sentNodes, "");
    if (!sentChat.ok
      || visibleSentKeepaliveCount(sentNodes, sentChat) <= initialSentKeepaliveCount) {
      return terminalFailure("send_uncertain");
    }
    return result(true, "keepalive_sent");
  } catch {
    if (pendingDraft && !sendAttempted) {
      const cleanupSnapshot = await getSnapshot(
        driverCall,
        socket,
        pendingDraft.pid,
        pendingDraft.windowId,
      ).catch(() => null);
      const cleaned = await clearVerifiedKeepaliveDraft({
        driverCall,
        socket,
        pid: pendingDraft.pid,
        windowId: pendingDraft.windowId,
        snapshot: cleanupSnapshot,
        expectedEditorIndex: pendingDraft.editorIndex,
      });
      if (!cleaned) return terminalFailure("driver_unavailable", "draft_cleanup_unconfirmed");
    }
    return failure("driver_unavailable");
  }
}

export const OPEN_INTERPRETER_KEEPALIVE_TARGET = TARGET_CHAT;
export const OPEN_INTERPRETER_KEEPALIVE_TEXT = KEEPALIVE_TEXT;
