#!/usr/bin/env node
"use strict";

const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { postprocessAudio } = require("./audio-postprocessor.js");

const AGENT = "http://127.0.0.1:17890";
const FFMPEG = path.join(os.homedir(), ".local", "share", "zhitai-runtime", "engines", "ffmpeg", "ffmpeg");
const OUTPUT_ROOT = path.join(os.homedir(), ".local", "share", "zhitai-runtime", "generation");
const WATERMARK_ROOT = path.join(os.homedir(), ".local", "share", "zhitai-runtime", "engines", "seedance-watermark-remover");
const WATERMARK_PYTHON = path.join(WATERMARK_ROOT, ".venv", "bin", "python");
const WATERMARK_SCRIPT = path.join(os.homedir(), ".local", "share", "zhitai-runtime", "scripts", "seedance-watermark-remover.py");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sanitizeId(value) { return String(value || "job").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120); }

function shotPrompts(detail) {
  const plan = detail?.remake_plan?.plan || {};
  const workflow = plan.seedanceWorkflow || {};
  const shots = Array.isArray(workflow.shots) ? workflow.shots : [];
  const revision = String(plan.userRevisionRequest || "").trim();
  const revisionRule = revision ? "\n\n【本次返工必须执行】" + revision : "";
  return shots.map((shot, index) => ({
    index: Number(shot.index) || index + 1,
    imagePrompt: String(shot.gptImagePrompt || shot.imagePrompt || "").trim() + revisionRule,
    videoPrompt: String(shot.seedancePrompt || shot.videoPrompt || "").trim() + revisionRule,
    negativePrompt: String(shot.negativePrompt || "").trim() + (revision ? "；不得忽略用户返工意见：" + revision : ""),
    durationSeconds: Math.max(1, Math.min(10, Number(shot.durationSeconds) || 10)),
  })).filter((shot) => shot.imagePrompt && shot.videoPrompt);
}

function generationReadiness(detail) {
  const workflow = detail?.remake_plan?.plan?.seedanceWorkflow;
  if (!workflow || Number(workflow.schemaVersion || 0) < 3) {
    return { ready: false, status: "needs_analysis", error: "这条素材仍是旧的行业模板提示词，请重新分析后再生成" };
  }
  const state = workflow.generationReadiness;
  if (!state || typeof state.ready !== "boolean") {
    return { ready: false, status: "needs_analysis", error: "这条素材使用的是旧分析记录，请重新分析后再生成" };
  }
  if (!state.ready) {
    const reasons = Array.isArray(state.blockers) ? state.blockers.filter(Boolean).join("；") : "提示词需要重新分析";
    return { ready: false, status: "quality_blocked", error: `生成前质量门未通过：${reasons}` };
  }
  return { ready: true, status: "ready", error: null };
}

function doubaoVideoEntryDecision(entries, currentUrl = "", { allowCreative = false, modeReady = false } = {}) {
  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const compact = (value) => normalize(value).replace(/\s+/g, "").toLowerCase();
  const rows = (Array.isArray(entries) ? entries : []).map((entry, index) => ({
    index,
    label: normalize(entry?.label),
    href: normalize(entry?.href),
    visible: entry?.visible !== false,
    enabled: entry?.enabled !== false,
  })).filter((entry) => entry.visible && entry.enabled && entry.label);
  let pathname = "";
  try { pathname = new URL(String(currentUrl || "")).pathname.slice(0, 160); } catch { pathname = ""; }
  if (modeReady || /(?:create[-_/]?(?:ai-)?video|video[-_/]?(?:create|generation|generator)|generate[-_/]?video)/i.test(pathname)) {
    return { status: "already", kind: "video", index: -1, label: "", pathname, diagnostics: [] };
  }

  const denied = /语音|声音|音乐|朗读|播放|暂停|预览|试听|听一听|voice|audio|music|speech|microphone|preview|pause|play/i;
  const directLabels = new Set(["视频生成", "生成视频", "视频创作", "ai视频", "ai视频生成", "图生视频", "文生视频"]);
  const creativeLabels = new Set(["创作", "ai创作", "智能创作"]);
  const ranked = rows.map((entry) => {
    const label = compact(entry.label);
    let score = 0;
    let kind = "";
    if (denied.test(entry.label)) score = -1;
    else if (/(?:create[-_/]?(?:ai-)?video|video[-_/]?(?:create|generation|generator)|generate[-_/]?video)/i.test(entry.href)) { score = 150; kind = "video"; }
    else if (directLabels.has(label)) { score = 140; kind = "video"; }
    else if (/^(?:ai)?视频生成(?:入口|工具|功能)?$/.test(label) || /^生成视频(?:入口|工具|功能)?$/.test(label)) { score = 130; kind = "video"; }
    else if (/^(?:图生视频|文生视频|视频创作)$/.test(label)) { score = 125; kind = "video"; }
    else if (allowCreative && creativeLabels.has(label)) { score = 80; kind = "creative"; }
    return { ...entry, score, kind };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || a.index - b.index);
  const diagnostics = rows
    .filter((entry) => /创作|视频/.test(entry.label) && !denied.test(entry.label))
    .map((entry) => entry.label).filter((label, index, all) => all.indexOf(label) === index).slice(0, 8);
  if (!ranked.length) return { status: "missing", kind: "", index: -1, label: "", pathname, diagnostics };
  const bestScore = ranked[0].score;
  const winners = ranked.filter((entry) => entry.score === bestScore);
  const winnerKeys = new Set(winners.map((entry) => `${compact(entry.label)}|${entry.href.replace(/[?#].*$/, "")}`));
  if (winnerKeys.size > 1) {
    return { status: "ambiguous", kind: "", index: -1, label: "", pathname, diagnostics: winners.map((entry) => entry.label).slice(0, 8) };
  }
  return { status: "click", kind: winners[0].kind, index: winners[0].index, label: winners[0].label, pathname, diagnostics };
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(30_000) });
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new Error(payload?.error || payload?.message || `HTTP ${response.status}`);
  return payload;
}

async function waitForLoad(window, timeoutMs = 30_000) {
  const started = Date.now();
  while (window.webContents.isLoading() && Date.now() - started < timeoutMs) await wait(300);
  await wait(900);
}

async function downloadFromWindow(window, url, target, timeoutMs = 120_000) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  return new Promise((resolve, reject) => {
    const session = window.webContents.session;
    let settled = false;
    const timer = setTimeout(() => finish(new Error("下载生成结果超时")), timeoutMs);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.removeListener("will-download", onDownload);
      if (error) reject(error); else resolve(target);
    }
    function onDownload(_event, item, sourceContents) {
      if (sourceContents && sourceContents.id !== window.webContents.id) return;
      item.setSavePath(target);
      item.once("done", (_e, state) => finish(state === "completed" ? null : new Error(`下载生成结果失败：${state}`)));
    }
    session.on("will-download", onDownload);
    try { window.webContents.downloadURL(url); } catch (error) { finish(error); }
  });
}

async function downloadFromSaveButton(window, target, timeoutMs = 180_000) {
  await fsp.mkdir(path.dirname(target), { recursive: true });
  const previewReady = await window.webContents.executeJavaScript(`(async () => {
    const hasSave = () => [...document.querySelectorAll('button')].some((button) => /^保存$/.test((button.textContent || '').trim()) && button.getBoundingClientRect().width > 0);
    if (hasSave()) return true;
    const thumbnail = [...document.querySelectorAll('img')].find((img) => /video_dsz|video.*watermark/i.test(img.currentSrc || img.src || ''));
    if (!thumbnail) return false;
    (thumbnail.closest('button,[role="button"]') || thumbnail).click();
    await new Promise((resolve) => setTimeout(resolve, 800));
    return hasSave();
  })()`, true).catch(() => false);
  if (!previewReady) throw new Error("豆包结果预览无法打开，未找到“保存”按钮");
  return new Promise((resolve, reject) => {
    const session = window.webContents.session;
    let settled = false;
    const timer = setTimeout(() => finish(new Error("点击豆包保存后未收到下载文件")), timeoutMs);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      session.removeListener("will-download", onDownload);
      if (error) reject(error); else resolve(target);
    }
    function onDownload(_event, item, sourceContents) {
      if (sourceContents && sourceContents.id !== window.webContents.id) return;
      item.setSavePath(target);
      item.once("done", (_e, state) => finish(state === "completed" ? null : new Error(`豆包保存失败：${state}`)));
    }
    session.on("will-download", onDownload);
    window.webContents.executeJavaScript(`(() => {
      const buttons = [...document.querySelectorAll('button')];
      const save = buttons.find((button) => /^保存$/.test((button.textContent || '').trim()) && button.getBoundingClientRect().width > 0);
      if (!save) return false; save.click(); return true;
    })()`, true).then((clicked) => { if (!clicked) finish(new Error("豆包结果中找不到“保存”按钮")); }, finish);
  });
}

async function sendPrompt(window, prompt, provider) {
  const result = await window.webContents.executeJavaScript(`(async () => {
    const provider = ${JSON.stringify(provider)};
    const editorSelectors = provider === 'gpt'
      ? ['#prompt-textarea', '[data-testid="composer-text-input"]', 'main form [contenteditable="true"]']
      : ['textarea', '[contenteditable="true"][role="textbox"]', '[contenteditable="true"]'];
    const editor = editorSelectors.flatMap((selector) => [...document.querySelectorAll(selector)])
      .find((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      });
    if (!editor) return { ok:false, reason:'找不到消息输入框' };
    editor.focus();
    if ('value' in editor) {
      const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(editor), 'value')?.set;
      if (setter) setter.call(editor, ${JSON.stringify(prompt)}); else editor.value = ${JSON.stringify(prompt)};
    } else {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(editor);
      selection?.removeAllRanges(); selection?.addRange(range);
      if (!document.execCommand('insertText', false, ${JSON.stringify(prompt)})) editor.textContent = ${JSON.stringify(prompt)};
    }
    editor.dispatchEvent(new InputEvent('beforeinput', { bubbles:true, cancelable:true, inputType:'insertText', data:${JSON.stringify(prompt)} }));
    editor.dispatchEvent(new InputEvent('input', { bubbles:true, inputType:'insertText', data:${JSON.stringify(prompt)} }));
    editor.dispatchEvent(new Event('change', { bubbles:true }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const form = editor.closest('form');
    const scope = form || editor.closest('[class*="composer"]') || document;
    const safe = (button) => {
      const label = [button.getAttribute('aria-label'), button.getAttribute('data-testid'), button.textContent].filter(Boolean).join(' ').trim();
      if (/语音|voice|麦克风|microphone|录音|audio|speech/i.test(label)) return false;
      return provider === 'gpt'
        ? /send-button|发送提示|发送消息|^发送$|^send$/i.test(label)
        : /发送|send/i.test(label);
    };
    const findSend = () => {
      const buttons = [...scope.querySelectorAll('button:not([disabled])')];
      const doubaoArrow = provider === 'doubao' ? [...document.querySelectorAll('button:not([disabled])')]
        .filter((button) => {
          const rect = button.getBoundingClientRect();
          const editorRect = editor.getBoundingClientRect();
          const style = getComputedStyle(button);
          const visible = rect.width >= 24 && rect.height >= 24
            && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity || 1) > 0;
          const atBottomRight = rect.left >= editorRect.left + editorRect.width * 0.60
            && rect.top >= editorRect.top + editorRect.height * 0.40
            && rect.right <= editorRect.right + 60 && rect.bottom <= editorRect.bottom + 80;
          const label = [button.getAttribute('aria-label'), button.textContent].filter(Boolean).join(' ');
          return visible && atBottomRight && !/语音|voice|麦克风|microphone|录音|audio|speech/i.test(label);
        })
        .sort((a, b) => b.getBoundingClientRect().right - a.getBoundingClientRect().right)[0] : null;
      const gptSend = provider === 'gpt' ? document.querySelector('button[data-testid="send-button"]:not([disabled])') : null;
      return gptSend
        || buttons.find((button) => button.type === 'submit' && safe(button))
        || buttons.find(safe)
        || doubaoArrow;
    };
    let send = findSend();
    // 豆包上传首帧后发送箭头会短暂 disabled；等待它真正可点击，避免误判登录失效。
    for (let attempt = 0; !send && attempt < 40; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      send = findSend();
    }
    if (!send || (provider === 'gpt' && !safe(send))) return { ok:false, reason:'找不到明确的发送按钮；为避免误触语音已停止' };
    send.click();
    return { ok:true };
  })()`, true);
  if (!result?.ok) throw new Error(result?.reason || "网页提示词发送失败");
}

async function generatedImages(window) {
  return window.webContents.executeJavaScript(`(() => [...document.querySelectorAll('[data-message-author-role="assistant"] img, main img')]
    .filter((img) => img.naturalWidth >= 256 && img.naturalHeight >= 256)
    .map((img) => img.currentSrc || img.src).filter(Boolean))()`, true).catch(() => []);
}

async function generateGptImage(window, prompt, target) {
  const before = new Set(await generatedImages(window));
  await sendPrompt(window, `请根据下面提示直接生成一张 9:16 竖屏分镜首帧，只输出图片，不要解释。\n\n${prompt}`, "gpt");
  const started = Date.now();
  while (Date.now() - started < 5 * 60_000) {
    await wait(2500);
    const urls = await generatedImages(window);
    const next = urls.find((url) => !before.has(url));
    if (next) return downloadFromWindow(window, next, target);
  }
  throw new Error("GPT 生图等待超时，可能已达到次数限制");
}

async function inspectAndActivateDoubaoEntry(window, allowCreative, activate = true) {
  return window.webContents.executeJavaScript(`(() => {
    const nodes = [...document.querySelectorAll('button, a[href], [role="button"], [role="tab"], [tabindex="0"]')];
    const rows = nodes.map((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const visible = rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden'
        && style.display !== 'none' && Number(style.opacity || 1) > 0;
      const label = [node.getAttribute('aria-label'), node.getAttribute('title'), node.innerText, node.textContent]
        .map((value) => String(value || '').replace(/\\s+/g, ' ').trim()).find(Boolean) || '';
      const enabled = !node.matches(':disabled') && node.getAttribute('aria-disabled') !== 'true';
      return { label: label.slice(0, 80), href: String(node.getAttribute('href') || '').slice(0, 240), visible, enabled };
    });
    const editor = ['textarea', '[contenteditable="true"][role="textbox"]', '[contenteditable="true"]']
      .flatMap((selector) => [...document.querySelectorAll(selector)])
      .find((node) => {
        const rect = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      });
    const bodyText = (document.body?.innerText || '').slice(0, 120000);
    // 复用上一条 Seedance 会话时入口按钮可能消失；明确的视频任务状态 + 可用编辑器
    // 说明已经在视频模式。这里只读 DOM 文本，不打开或播放任何媒体。
    const modeReady = Boolean(editor) && /视频生成中|视频生成已提交|你的视频生成好了|预计等待\\s*\\d+\\s*分钟/.test(bodyText);
    const decide = ${doubaoVideoEntryDecision.toString()};
    const decision = decide(rows, location.href, { allowCreative: ${allowCreative ? "true" : "false"}, modeReady });
    if (${activate ? "true" : "false"} && decision.status === 'click') nodes[decision.index]?.click();
    return decision;
  })()`, true);
}

async function waitForDoubaoEntry(window, allowCreative, timeoutMs) {
  const started = Date.now();
  let result = null;
  do {
    result = await inspectAndActivateDoubaoEntry(window, allowCreative);
    if (result?.status !== "missing") return result;
    await wait(500);
  } while (Date.now() - started < timeoutMs);
  return result;
}

async function activateDoubaoVideoMode(window) {
  let result = await waitForDoubaoEntry(window, false, 8_000);
  if (result?.status === "already" || result?.status === "click") {
    if (result.status === "click") await wait(1000);
    return;
  }
  if (result?.status === "ambiguous") {
    throw new Error(`豆包“视频生成”入口不唯一，已停止避免误触（${result.diagnostics.join("、") || "无安全标签"}）`);
  }

  const creative = await waitForDoubaoEntry(window, true, 5_000);
  if (creative?.status === "ambiguous") {
    throw new Error(`豆包“创作”入口不唯一，已停止避免误触（${creative.diagnostics.join("、") || "无安全标签"}）`);
  }
  if (creative?.status === "click" && creative.kind === "video") {
    await wait(1000);
    return;
  }
  if (creative?.status === "click" && creative.kind === "creative") {
    await wait(1400);
    result = await waitForDoubaoEntry(window, false, 10_000);
    if (result?.status === "already" || result?.status === "click") {
      if (result.status === "click") await wait(1000);
      return;
    }
  }
  const pathname = result?.pathname || creative?.pathname || "/";
  const labels = [...new Set([...(result?.diagnostics || []), ...(creative?.diagnostics || [])])].slice(0, 8);
  throw new Error(`豆包页面找不到明确的“视频生成”入口（页面 ${pathname}${labels.length ? `；可见相关标签：${labels.join("、")}` : ""}）`);
}

async function attachFile(window, filePath) {
  const bytes = await fsp.readFile(filePath);
  const b64 = bytes.toString("base64");
  const name = path.basename(filePath);
  const result = await window.webContents.executeJavaScript(`(async () => {
    let input = document.querySelector('input[type="file"]');
    if (!input) {
      const button = [...document.querySelectorAll('button')].find((item) => /上传|添加|图片/.test((item.getAttribute('aria-label') || '') + (item.textContent || '')));
      button?.click(); await new Promise((resolve) => setTimeout(resolve, 500));
      input = document.querySelector('input[type="file"]');
    }
    if (!input) return { ok:false, reason:'找不到图片上传入口' };
    const raw = atob(${JSON.stringify(b64)}); const data = new Uint8Array(raw.length);
    for (let i=0;i<raw.length;i++) data[i]=raw.charCodeAt(i);
    const file = new File([data], ${JSON.stringify(name)}, { type:'image/png' });
    const transfer = new DataTransfer(); transfer.items.add(file); input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles:true }));
    return { ok:true };
  })()`, true);
  if (!result?.ok) throw new Error(result?.reason || "豆包首帧上传失败");
  await wait(1200);
}

async function generatedVideos(window) {
  return window.webContents.executeJavaScript(`(() => [...document.querySelectorAll('video')]
    .flatMap((video) => [video.currentSrc, video.src, ...[...video.querySelectorAll('source')].map((source) => source.src)])
    .filter(Boolean))()`, true).catch(() => []);
}

async function waitForDoubaoVideo(window, before, target, onProgress = null) {
  const started = Date.now();
  let authorizationGateOpenedAt = 0;
  let lastReportedUrl = "";
  while (Date.now() - started < 12 * 60_000) {
    await wait(4000);
    const currentUrl = window.webContents.getURL();
    if (onProgress && currentUrl && currentUrl !== lastReportedUrl) {
      lastReportedUrl = currentUrl;
      await onProgress(currentUrl);
    }
    const authorizationGate = await window.webContents.executeJavaScript(`(() => {
      const text = (document.body?.innerText || '').slice(0, 20000);
      return /安全确认/.test(text) && /上传、使用的素材|均已获充分授权|无侵权违法风险/.test(text);
    })()`, true).catch(() => false);
    if (authorizationGate) {
      if (!authorizationGateOpenedAt) {
        authorizationGateOpenedAt = Date.now();
        if (window.isMinimized()) window.restore();
        window.show();
        window.focus();
        if (onProgress) {
          await onProgress(currentUrl, {
            type: "authorization_required",
            error: "豆包需要确认素材授权：请在已打开的安全确认窗口完成确认；织台已保存断点并继续等待，不会重复提交",
          });
        }
      }
      continue;
    }
    const urls = await generatedVideos(window);
    const next = urls.find((url) => !before.has(url));
    if (next) return downloadFromWindow(window, next, target, 180_000);
    const readyToSave = await window.webContents.executeJavaScript(`document.body.innerText.includes('你的视频生成好了')`, true).catch(() => false);
    if (readyToSave) return downloadFromSaveButton(window, target, 180_000);
  }
  if (authorizationGateOpenedAt) throw new Error("等待你确认豆包素材授权超时；任务未重复提交，可打开原会话确认后继续");
  throw new Error("豆包视频生成等待超时，可能需要验证或免费次数已用完");
}

async function generateDoubaoClip(window, imagePath, prompt, negativePrompt, durationSeconds, target, onSubmitted = null) {
  await activateDoubaoVideoMode(window);
  const before = new Set(await generatedVideos(window));
  await attachFile(window, imagePath);
  await sendPrompt(window, `${prompt}${negativePrompt ? `\n\n禁止：${negativePrompt}` : ""}\n\n生成 ${Math.max(1, Math.min(10, Number(durationSeconds) || 10))} 秒、9:16 竖屏视频。`, "doubao");
  if (onSubmitted) await onSubmitted(window.webContents.getURL());
  return waitForDoubaoVideo(window, before, target, onSubmitted);
}

async function concatClips(clips, output) {
  if (!clips.length) throw new Error("没有可拼接的视频片段");
  if (clips.length === 1) { await fsp.copyFile(clips[0], output); return output; }
  const list = `${output}.concat.txt`;
  await fsp.writeFile(list, clips.map((file) => `file '${file.replaceAll("'", "'\\''")}'`).join("\n") + "\n", "utf8");
  await new Promise((resolve, reject) => {
    const child = spawn(FFMPEG, ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", output], { stdio: "ignore" });
    child.once("error", reject); child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg 拼接失败：${code}`)));
  });
  await fsp.rm(list, { force: true });
  return output;
}

async function removeSeedanceWatermark(input, output) {
  try {
    await Promise.all([fsp.access(WATERMARK_PYTHON), fsp.access(WATERMARK_SCRIPT), fsp.access(FFMPEG)]);
  } catch {
    throw new Error("豆包视频已下载，但织台去水印引擎尚未安装；为避免交付带水印成片，本次已停止");
  }
  await fsp.rm(output, { force: true });
  await new Promise((resolve, reject) => {
    const child = spawn(WATERMARK_PYTHON, [WATERMARK_SCRIPT, input, "-o", output], {
      stdio: ["ignore", "ignore", "pipe"],
      env: { ...process.env, PATH: `${path.dirname(FFMPEG)}:${process.env.PATH || "/usr/bin:/bin"}` },
    });
    let errorText = "";
    child.stderr.on("data", (chunk) => { errorText += chunk.toString(); if (errorText.length > 8_000) errorText = errorText.slice(-8_000); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`豆包视频去水印失败（${code}）${errorText ? `：${errorText.slice(-300)}` : ""}`)));
  });
  const result = await fsp.stat(output).catch(() => null);
  if (!result?.isFile() || result.size < 1_024) throw new Error("豆包视频去水印没有生成有效文件");
  await fsp.rm(input, { force: true });
  return output;
}

function createCreativeRunner({ openStudio, waitForStudio = waitForLoad }) {
  let inFlight = null;
  let probeInFlight = null;
  async function advance(jobId, step) {
    await fetchJson(`${AGENT}/api/v1/creative/jobs/${encodeURIComponent(jobId)}/advance`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ step }),
    });
  }
  async function doubaoState(window) {
    const url = window.webContents.getURL();
    const state = await window.webContents.executeJavaScript(`(() => {
      const text = (document.body?.innerText || '').slice(0, 120000);
      const editor = ['textarea', '[contenteditable="true"][role="textbox"]', '[contenteditable="true"]']
        .map((selector) => document.querySelector(selector))
        .find((node) => node && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0);
      return {
        quotaExhausted: /(?:免费|今日|生成|视频).{0,16}(?:次数|额度).{0,16}(?:用完|不足|耗尽|上限)|(?:次数|额度).{0,16}(?:用完|不足|耗尽|上限)/i.test(text),
        loginRequired: /登录后使用|立即登录|手机号登录/.test(text),
        editorReady: Boolean(editor)
      };
    })()`, true).catch(() => ({ quotaExhausted: false, loginRequired: false, editorReady: false, probeFailed: true }));
    const loginRequired = state.loginRequired || /login|passport/.test(url);
    let videoEntry = { status: "unchecked", kind: "" };
    if (!loginRequired && !state.quotaExhausted) {
      videoEntry = await inspectAndActivateDoubaoEntry(window, false, false)
        .catch(() => ({ status: "probe_failed", kind: "" }));
    }
    return {
      ...state,
      loginRequired,
      videoModeReady: videoEntry.status === "already",
      videoEntryReady: videoEntry.status === "click" && videoEntry.kind === "video",
      videoEntryAmbiguous: videoEntry.status === "ambiguous",
    };
  }

  async function gptState(window) {
    const url = window.webContents.getURL();
    const state = await window.webContents.executeJavaScript(`(() => {
      const text = (document.body?.innerText || '').slice(0, 120000);
      const editor = ['#prompt-textarea', '[data-testid="composer-text-input"]', 'main form [contenteditable="true"]']
        .map((selector) => document.querySelector(selector))
        .find((node) => node && node.getBoundingClientRect().width > 0 && node.getBoundingClientRect().height > 0);
      return {
        loginRequired: /登录以继续|登录后继续|登录或注册|log\\s*in|sign\\s*in/i.test(text),
        editorReady: Boolean(editor)
      };
    })()`, true).catch(() => ({ loginRequired: false, editorReady: false, probeFailed: true }));
    return {
      ...state,
      loginRequired: state.loginRequired || /\/auth\/|\/login(?:[/?#]|$)|accounts\.google\.|auth0\.|\/signin(?:[/?#]|$)/i.test(url),
    };
  }

  function pageCondition(state, provider) {
    if (state?.loginRequired) {
      return { state: "attention", reason: provider === "gpt" ? "GPT 登录已失效，请重新登录" : "账号未登录或登录已失效" };
    }
    if (provider === "doubao" && state?.quotaExhausted) {
      return { state: "attention", reason: "今日视频生成次数或额度已用完" };
    }
    if (state?.editorReady && provider === "gpt") {
      return { state: "ready", reason: "已登录，生图输入框可用" };
    }
    if (state?.editorReady && provider === "doubao" && (state?.videoModeReady || state?.videoEntryReady)) {
      return { state: "ready", reason: state.videoModeReady ? "已登录，当前视频生成会话可用" : "已登录，视频生成入口可用" };
    }
    if (state?.editorReady && provider === "doubao") {
      return {
        state: "unknown",
        reason: state?.videoEntryAmbiguous
          ? "已登录，但视频生成入口不唯一，已停止避免误触"
          : "已登录且通用输入框可用，但尚未确认视频生成入口",
      };
    }
    return { state: "unknown", reason: state?.probeFailed ? "页面状态读取失败，稍后重试" : "页面已打开，但尚未找到可用输入框" };
  }
  function accountPool(values) {
    const source = Array.isArray(values) && values.length ? values : ["account-1"];
    return [...new Set(source.map((value) => sanitizeId(value)).filter(Boolean))].slice(0, 8);
  }

  async function probeAccounts(accountIds = ["account-1"]) {
    if (probeInFlight) return probeInFlight;
    probeInFlight = (async () => {
      let gpt = { state: "unknown", reason: "GPT 页面尚未检查" };
      try {
        const opened = openStudio("gpt", { show: false });
        if (!opened?.ok || !opened?.window) throw new Error(opened?.error || "GPT 窗口未打开");
        await waitForStudio(opened.window);
        gpt = pageCondition(await gptState(opened.window), "gpt");
      } catch (error) {
        gpt = { state: "unknown", reason: `GPT 检查失败：${String(error?.message || error).slice(0, 160)}` };
      }

      const doubao = [];
      const accounts = accountPool(accountIds);
      for (let index = 0; index < accounts.length; index++) {
        const id = accounts[index];
        let result;
        try {
          const opened = openStudio("seedance", { accountId: id, show: false });
          if (!opened?.ok || !opened?.window) throw new Error(opened?.error || "豆包窗口未打开");
          await waitForStudio(opened.window);
          result = pageCondition(await doubaoState(opened.window), "doubao");
        } catch (error) {
          result = { state: "unknown", reason: `检查失败：${String(error?.message || error).slice(0, 160)}` };
        }
        doubao.push({ id, label: `豆包账号 ${index + 1}`, ...result });
      }
      return { gpt, doubao };
    })();
    try { return await probeInFlight; }
    finally { probeInFlight = null; }
  }
  async function run(jobId, assetId, accountIds = ["account-1"]) {
    if (inFlight) return { ok: false, status: "busy", error: "已有生成任务正在运行" };
    inFlight = (async () => {
      const detail = await fetchJson(`${AGENT}/api/v1/kb/videos/${encodeURIComponent(assetId)}`);
      if (detail?.asset?.category !== "素材") return { ok: false, status: "not_material", error: "只有“素材”分类可以一键复刻" };
      const readiness = generationReadiness(detail);
      if (!readiness.ready) return { ok: false, status: readiness.status, error: readiness.error };
      const shots = shotPrompts(detail);
      if (!shots.length) return { ok: false, status: "needs_analysis", error: "这条素材还没有完整的 GPT/Seedance 分镜提示词，请先重新分析" };
      const outputDir = path.join(OUTPUT_ROOT, sanitizeId(jobId));
      await fsp.mkdir(outputDir, { recursive: true });
      const checkpointPath = path.join(outputDir, "run-state.json");

      const queuePayload = await fetchJson(`${AGENT}/api/v1/creative/jobs`);
      const currentJob = Array.isArray(queuePayload?.jobs) ? queuePayload.jobs.find((job) => job.id === jobId) : null;
      const currentStatus = currentJob?.status || "ready_for_images";

      const images = [];
      if (currentStatus === "ready_for_images") {
        const gpt = openStudio("gpt").window;
        await waitForLoad(gpt);
        if (/\/auth\/|\/login|accounts\.google/.test(gpt.webContents.getURL())) return { ok: false, status: "waiting_gpt_login", error: "请先在打开的 GPT 窗口登录一次，然后重新点击一键生成" };
        for (const shot of shots) {
          const target = path.join(outputDir, `storyboard-${String(shot.index).padStart(2, "0")}.png`);
          images.push(await generateGptImage(gpt, shot.imagePrompt, target));
        }
        await advance(jobId, "images_ready");
      } else {
        for (const shot of shots) {
          const target = path.join(outputDir, `storyboard-${String(shot.index).padStart(2, "0")}.png`);
          try { await fsp.access(target); images.push(target); }
          catch { return { ok: false, status: "needs_attention", error: "断点续跑缺少 GPT 分镜图，请从待 GPT 生图阶段重新开始" }; }
        }
      }

      const accounts = accountPool(accountIds);
      let checkpoint = null;
      try { checkpoint = JSON.parse(await fsp.readFile(checkpointPath, "utf8")); } catch { /* 首次运行 */ }
      const clips = [];
      for (let i = 0; i < shots.length; i++) {
        const target = path.join(outputDir, `clip-${String(shots[i].index).padStart(2, "0")}.mp4`);
        const watermarkedTarget = path.join(outputDir, `clip-${String(shots[i].index).padStart(2, "0")}.watermarked.mp4`);
        const completedClip = await fsp.stat(target).catch(() => null);
        if (completedClip?.isFile() && completedClip.size >= 1_024) {
          clips.push(target);
          continue;
        }
        let downloadedClip = null;
        const checkpointMatches = checkpoint?.jobId === jobId && checkpoint?.assetId === assetId
          && Number(checkpoint?.shotIndex) === i && accounts.includes(checkpoint?.accountId);
        const startAt = checkpointMatches
          ? accounts.indexOf(checkpoint.accountId) : i % accounts.length;
        const orderedAccounts = [...accounts.slice(startAt), ...accounts.slice(0, startAt)];
        const unavailable = [];
        for (const accountId of orderedAccounts) {
          const doubao = openStudio("seedance", { accountId, show: false }).window;
          await waitForLoad(doubao);
          if (currentStatus === "ready_for_seedance" && checkpointMatches && checkpoint?.accountId === accountId
            && /^https:\/\/(?:www\.)?doubao\.com\/chat\//.test(checkpoint?.doubaoUrl || "")
            && doubao.webContents.getURL() !== checkpoint.doubaoUrl) {
            await doubao.loadURL(checkpoint.doubaoUrl);
            await waitForLoad(doubao);
          }
          const availability = await doubaoState(doubao);
          if (availability.loginRequired) { unavailable.push(`${accountId} 未登录`); continue; }
          if (availability.quotaExhausted) { unavailable.push(`${accountId} 今日额度已用完`); continue; }
          try {
            const persistDoubaoProgress = async (doubaoUrl, attention = null) => {
              checkpoint = { jobId, assetId, accountId, doubaoUrl, shotIndex: i, submittedAt: new Date().toISOString() };
              await fsp.writeFile(checkpointPath, `${JSON.stringify(checkpoint, null, 2)}\n`, "utf8");
              if (attention?.error) {
                await fetchJson(`${AGENT}/api/v1/creative/jobs/${encodeURIComponent(jobId)}/attention`, {
                  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: attention.error }),
                }).catch(() => null);
              }
            };
            if (currentStatus === "ready_for_seedance" && checkpointMatches && checkpoint?.accountId === accountId) {
              const currentDoubaoUrl = doubao.webContents.getURL();
              let sameCheckpointConversation = false;
              try {
                const current = new URL(currentDoubaoUrl);
                const saved = new URL(checkpoint?.doubaoUrl || "");
                sameCheckpointConversation = current.hostname.replace(/^www\./, "") === saved.hostname.replace(/^www\./, "")
                  && current.pathname.replace(/\/+$/, "") === saved.pathname.replace(/\/+$/, "");
              } catch { /* 无效地址不能作为恢复依据 */ }
              const pageMatches = sameCheckpointConversation || await doubao.webContents.executeJavaScript(`document.body.innerText.includes(${JSON.stringify(String(detail?.asset?.title || "").slice(0, 16))})`, true).catch(() => false);
              const pageGenerating = await doubao.webContents.executeJavaScript(`/视频生成中|视频生成已提交|预计等待\\s*\\d+\\s*分钟/.test(document.body.innerText)`, true).catch(() => false);
              const pageReady = await doubao.webContents.executeJavaScript(`document.body.innerText.includes('你的视频生成好了')`, true).catch(() => false);
              const existing = await generatedVideos(doubao);
              if (pageMatches && pageReady) downloadedClip = await downloadFromSaveButton(doubao, watermarkedTarget, 180_000);
              else if (pageMatches && existing.length) downloadedClip = await downloadFromWindow(doubao, existing.at(-1), watermarkedTarget, 180_000);
              else if (pageMatches && pageGenerating) downloadedClip = await waitForDoubaoVideo(doubao, new Set(), watermarkedTarget, persistDoubaoProgress);
            }
            if (!downloadedClip) downloadedClip = await generateDoubaoClip(
              doubao,
              images[i],
              shots[i].videoPrompt,
              shots[i].negativePrompt,
              shots[i].durationSeconds,
              watermarkedTarget,
              persistDoubaoProgress,
            );
            break;
          } catch (error) {
            const after = await doubaoState(doubao);
            if (after.quotaExhausted) { unavailable.push(`${accountId} 今日额度已用完`); continue; }
            throw error;
          }
        }
        if (!downloadedClip) throw new Error(`没有可用的豆包账号：${unavailable.join("；") || "请先逐个登录"}`);
        clips.push(await removeSeedanceWatermark(downloadedClip, target));
      }
      await advance(jobId, "seedance_ready");
      const visualVideo = await concatClips(clips, path.join(outputDir, "final.visual.mp4"));
      const finalVideo = await postprocessAudio({
        input: visualVideo,
        output: path.join(outputDir, "final.mp4"),
        detail,
        shots: detail?.remake_plan?.plan?.seedanceWorkflow?.shots || [],
      });
      await advance(jobId, "complete");
      return { ok: true, status: "completed", finalVideo };
    })();
    try { return await inFlight; }
    catch (error) {
      const message = String(error?.message || error).slice(0, 500);
      await fetchJson(`${AGENT}/api/v1/creative/jobs/${encodeURIComponent(jobId)}/attention`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ error: message }),
      }).catch(() => null);
      return { ok: false, status: "needs_attention", error: message };
    }
    finally { inFlight = null; }
  }
  return { run, shotPrompts, probeAccounts };
}

module.exports = { createCreativeRunner, shotPrompts, generationReadiness, sanitizeId, doubaoVideoEntryDecision };
