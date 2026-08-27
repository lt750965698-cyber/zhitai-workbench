#!/usr/bin/env node
"use strict";

const AGENT = "http://127.0.0.1:17890";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForLoad(window, timeoutMs = 30_000) {
  const started = Date.now();
  while (window.webContents.isLoading() && Date.now() - started < timeoutMs) await wait(300);
  await wait(1_500);
}

async function collectVisibleBookmarks(window) {
  return window.webContents.executeJavaScript(`(async () => {
    const collected = new Map();
    const numberFrom = (value) => {
      const text = String(value || '').replace(/,/g, '');
      const match = text.match(/(\\d+(?:\\.\\d+)?)\\s*([KMB万亿]?)/i);
      if (!match) return null;
      const units = { K:1e3, M:1e6, B:1e9, '万':1e4, '亿':1e8 };
      return Math.round(Number(match[1]) * (units[match[2].toUpperCase()] || units[match[2]] || 1));
    };
    const extract = (article) => {
      const statusLink = [...article.querySelectorAll('a[href*="/status/"]')]
        .map((a) => a.getAttribute('href') || '')
        .find((href) => /\\/status\\/\\d+/.test(href));
      const id = statusLink?.match(/\\/status\\/(\\d+)/)?.[1];
      const textNode = article.querySelector('[data-testid="tweetText"]');
      const content = (textNode?.innerText || '').trim();
      if (!id || !content) return null;
      const authorBlock = article.querySelector('[data-testid="User-Name"]');
      const authorText = (authorBlock?.innerText || '').split('\\n').map((v) => v.trim()).filter(Boolean);
      const username = authorText.find((v) => /^@/.test(v))?.slice(1) || statusLink.split('/').filter(Boolean)[0] || '';
      const author = authorText.find((v) => !/^@/.test(v) && !/^[·•]$/.test(v)) || (username ? '@' + username : 'X 用户');
      const tags = [...content.matchAll(/#([^#\\s，。！？,.!?:：；;]+)/g)].map((match) => match[1]);
      const images = [...article.querySelectorAll('img[src*="pbs.twimg.com/media"]')]
        .map((img) => ({ type:'photo', url: img.currentSrc || img.src })).filter((item) => item.url);
      const time = article.querySelector('time')?.getAttribute('datetime') || null;
      const metric = (testid) => {
        const button = article.querySelector('[data-testid="' + testid + '"]');
        return numberFrom(button?.getAttribute('aria-label') || button?.innerText || '');
      };
      const viewsLink = [...article.querySelectorAll('a[href$="/analytics"]')][0];
      return {
        tweetId:id, text:content, author, authorUsername:username,
        publishedAt:time, tags, media:images, coverUrl:images[0]?.url || null,
        metrics:{ replies:metric('reply'), retweets:metric('retweet'), likes:metric('like'), views:numberFrom(viewsLink?.getAttribute('aria-label') || viewsLink?.innerText || '') }
      };
    };
    let stableRounds = 0;
    let previousSize = 0;
    for (let round = 0; round < 14 && collected.size < 250; round++) {
      document.querySelectorAll('article[data-testid="tweet"]').forEach((article) => {
        const item = extract(article); if (item) collected.set(item.tweetId, item);
      });
      stableRounds = collected.size === previousSize ? stableRounds + 1 : 0;
      previousSize = collected.size;
      if (stableRounds >= 3) break;
      window.scrollTo(0, document.documentElement.scrollHeight);
      await new Promise((resolve) => setTimeout(resolve, 1400));
    }
    window.scrollTo(0, 0);
    return [...collected.values()];
  })()`, true);
}

function createXBookmarkRunner({ openStudio }) {
  let inFlight = null;

  async function sync({ interactive = true } = {}) {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      const opened = openStudio("x", { show: interactive });
      if (!opened?.ok || !opened.window) return { ok: false, status: "unavailable", error: opened?.error || "X 收藏窗口不可用" };
      const window = opened.window;
      await waitForLoad(window);
      const currentUrl = window.webContents.getURL();
      if (/\/i\/flow\/login|\/login|account\/login/i.test(currentUrl)) {
        if (interactive) { window.show(); window.focus(); }
        return { ok: false, status: "waiting_login", error: "请在织台的 X 收藏窗口登录一次" };
      }
      if (!/x\.com\/(?:i\/bookmarks)?/i.test(currentUrl)) {
        await window.loadURL("https://x.com/i/bookmarks");
        await waitForLoad(window);
      }
      const items = await collectVisibleBookmarks(window).catch(() => []);
      if (!items.length) {
        const pageText = await window.webContents.executeJavaScript("document.body.innerText.slice(0,2000)", true).catch(() => "");
        if (/登录|Log in|Sign in|创建你的账号/i.test(pageText)) {
          if (interactive) { window.show(); window.focus(); }
          return { ok: false, status: "waiting_login", error: "请先登录 X，再点击同步" };
        }
        return { ok: false, status: "empty", error: "没有读取到收藏帖；请确认 X 收藏页可以正常打开" };
      }
      const response = await fetch(`${AGENT}/api/v1/x-bookmarks/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ capturedAt: new Date().toISOString(), items }),
        signal: AbortSignal.timeout(60_000),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload?.ok !== true) throw new Error(payload?.error || `本地节点返回 HTTP ${response.status}`);
      return { ok: true, status: "completed", fetched: payload.fetched, imported: payload.imported, total: payload.total };
    })();
    try { return await inFlight; }
    catch (error) { return { ok: false, status: "failed", error: String(error?.message || error) }; }
    finally { inFlight = null; }
  }

  return { sync };
}

module.exports = { createXBookmarkRunner };

