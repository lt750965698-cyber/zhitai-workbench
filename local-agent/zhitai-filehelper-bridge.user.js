// ==UserScript==
// @name         织台·文件传输助手入库桥
// @namespace    zhitai.local
// @version      1.5.1
// @description  监听网页版文件传输助手的新消息；诊断仅发送结构化计数，不保存或导出消息正文、HTML、凭据和完整 URL。
// @match        https://filehelper.weixin.qq.com/*
// @match        https://szfilehelper.weixin.qq.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-start
// ==/UserScript==

/* global GM_deleteValue */

(function () {
  'use strict';

  const ENDPOINT = 'http://127.0.0.1:17890/api/v1/inbox';
  const CARD_ENDPOINT = 'http://127.0.0.1:17890/api/v1/channels/card';
  const NOTE_ENDPOINT = 'http://127.0.0.1:17890/api/v1/channels/note';
  const SOURCE = 'filehelper_web';
  // 使用新键只读取 v2 指纹；旧版完整 URL 去重键留待显式处置，启动时不读取或改写。
  const SEEN_KEY = 'zhitai_filehelper_seen_v2';
  const LEGACY_SEEN_KEY = 'zhitai_filehelper_seen';
  const KILL_KEY = 'zhitai_bridge_disabled';
  const SEEN_CAP = 1000;

  // ── 性能护栏 ──
  const FULL_SCAN_MS = 5000;         // 全量兜底扫描间隔(DOM 通道)
  const NODE_BUDGET = 12000;         // 单次遍历元素上限
  const TEXT_BUDGET = 150000;        // 单次取文本字符上限
  const SLOW_SCAN_MS = 250;          // 慢扫描阈值,超限自动降频

  /* ── 紧急停用开关 ── */
  if (GM_getValue(KILL_KEY, false)) {
    GM_registerMenuCommand('织台·重新启用入库桥', () => {
      GM_setValue(KILL_KEY, false);
      location.reload();
    });
    console.warn('[织台] 入库桥处于停用状态,可在油猴菜单重新启用。');
    return;
  }
  GM_registerMenuCommand('织台·紧急停用入库桥(页面卡顿时用)', () => {
    GM_setValue(KILL_KEY, true);
    location.reload();
  });

  // 白名单精确化(v1.3.4):weixin.qq.com 只允许精确匹配,子域(login./res./filehelper.)
  // 一律不放行——此前用宽泛后缀匹配把 login.weixin.qq.com/qrcode 当白名单放行了。
  const SUPPORTED_EXACT = new Set([
    'weixin.qq.com', 'mp.weixin.qq.com', 'channels.weixin.qq.com', 'finder.video.qq.com',
    'v.douyin.com', 'www.douyin.com', 'douyin.com', 'm.douyin.com', 'iesdouyin.com',
    'xiaohongshu.com', 'www.xiaohongshu.com', 'xhslink.com',
  ]);
  function isSupported(u) {
    let h = '', path = '', parsed = null;
    try {
      parsed = new URL(u);
      h = parsed.hostname.toLowerCase();
      path = parsed.pathname;
    } catch (e) { return false; }
    if (!h) return false;
    if (hasSensitiveUrlMaterial(parsed)) return false;
    // v1.3.12:排除加密链——stodownload/wxapp.tc.qq.com/finder /251/ 是视频号加密流,
    // 元宝解析不了(提交必失败),由慢点去水印(TikHub)处理,这里直接跳过。
    if (h === 'wxapp.tc.qq.com') return false;
    if (h === 'finder.video.qq.com' && (path.includes('/251/') || path.includes('stodownload'))) return false;
    if (!SUPPORTED_EXACT.has(h) || h === 'finder.video.qq.com' || h === 'iesdouyin.com') return false;
    if (h === 'weixin.qq.com') return /^\/(?:sph|sf|s)\/[A-Za-z0-9_-]+\/?$/i.test(path);
    if (h === 'channels.weixin.qq.com') return /^\/mobile\/sf\/[A-Za-z0-9_-]+\/?$/i.test(path);
    if (h === 'mp.weixin.qq.com') return /^\/s\/[A-Za-z0-9_-]+\/?$/i.test(path);
    if (h === 'v.douyin.com') return /^\/[A-Za-z0-9_-]+\/?$/i.test(path);
    if (['douyin.com', 'www.douyin.com', 'm.douyin.com'].includes(h)) return /^\/video\/[A-Za-z0-9_-]+\/?$/i.test(path);
    if (h === 'xhslink.com') return /^\/[A-Za-z0-9_-]+\/?$/i.test(path);
    return /^\/(?:explore|discovery\/item)\/[A-Za-z0-9_-]+\/?$/i.test(path);
  }

  function canonicalSupportedUrl(value) {
    try {
      const parsed = new URL(value);
      if (!isSupported(parsed.toString())) return null;
      // 分享身份完全由 host + 严格路径确定；任意 query/hash 都可能夹带私聊或凭据。
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString();
    } catch (e) { return null; }
  }

  function hasSensitiveUrlMaterial(parsedUrl) {
    if (parsedUrl.username || parsedUrl.password) return true;
    let pathAndHash = `${parsedUrl.pathname || ''}${parsedUrl.hash || ''}`;
    for (let i = 0; i < 2; i++) {
      try {
        const decoded = decodeURIComponent(pathAndHash);
        if (decoded === pathAndHash) break;
        pathAndHash = decoded;
      } catch (e) { break; }
    }
    if (/(?:^|[\s?&;,/])(?:bearer(?:\s+|[A-Za-z0-9._~+/-])|(?:access[_-]?token|auth(?:orization)?|cookie|credential|password|pass[_-]?ticket|secret|session(?:_?id)?|signature|sig|token|uskey|x-uskey)\s*[=:])/i.test(pathAndHash) ||
        /(?:\+?86[ -]?)?1[3-9]\d{9}/.test(pathAndHash) ||
        /(?:^|\/)(?:Users|home|private|var|tmp|opt|srv)(?:\/|$)/i.test(pathAndHash) ||
        /<(?:html|body|script|style|div|span|p|a|img|video|article|section)\b/i.test(pathAndHash)) return true;
    const exact = new Set([
      'access_token', 'authorization', 'auth', 'authkey', 'auth_key', 'decode_key',
      'credential', 'credentials', 'decodekey', 'decrypt_key', 'decryptkey', 'encfilekey',
      'expires', 'key', 'pass_ticket', 'password', 'secret', 'session', 'session_id',
      'sessionid', 'signature', 'sig', 'token', 'uskey', 'x-uskey',
      'ws_secret', 'wssecret', 'ws_time', 'wstime',
    ]);
    for (const [rawName, rawValue] of parsedUrl.searchParams.entries()) {
      const name = String(rawName || '').toLowerCase();
      const compact = name.replace(/[^a-z0-9]/g, '');
      if (exact.has(name) || name.startsWith('x-amz-') || name.startsWith('x-cos-') || name.startsWith('x-oss-') ||
          compact.endsWith('token') || compact.endsWith('secret') || compact.endsWith('signature') ||
          compact.includes('decodekey') || compact.includes('decryptkey') || compact.includes('encfilekey')) return true;
      let value = String(rawValue || '');
      for (let i = 0; i < 2; i++) {
        try {
          const decoded = decodeURIComponent(value);
          if (decoded === value) break;
          value = decoded;
        } catch (e) { break; }
      }
      if (/(?:^|[\s?&;,/])(?:bearer(?:\s+|[A-Za-z0-9._~+/-])|(?:access[_-]?token|auth(?:orization)?|cookie|credential|password|pass[_-]?ticket|secret|session(?:_?id)?|signature|sig|token|uskey|x-uskey|x-amz-signature|x-cos-signature|x-oss-security-token)\s*[=:])/i.test(value) ||
          /(?:\+?86[ -]?)?1[3-9]\d{9}/.test(value) ||
          /(?:file:\/\/\/|(?:^|[\s=:])\/(?:Users|home|private|var|tmp|opt|srv)\/|[A-Za-z]:\\(?:Users|Documents|Desktop)\\|~\/)/i.test(value) ||
          /<(?:html|body|script|style|div|span|p|a|img|video|article|section)\b/i.test(value)) return true;
    }
    return false;
  }

  // URL 匹配:遇空白/引号/括号/CJK/全角标点即停,防吞中文。
  const URL_RE = /https?:\/\/[^\s<>"'()（）【】\u4e00-\u9fff，。；、！？…]+/giu;
  function extractUrls(text, out) {
    URL_RE.lastIndex = 0;
    let m;
    while ((m = URL_RE.exec(text)) !== null) {
      out.push(m[0].replace(/[，。；、）》】)\]}]*$/u, ''));
    }
  }

  const state = {
    scans: 0,
    nodeOk: null,
    submitted: 0,
    failed: 0,
    lastScanMs: 0,
    degraded: false,
    log: [],
    otherLinkCount: 0,
    lastTextLen: 0,
    sphHints: 0,
    unparsedCardHints: 0,
    hookMsgs: 0,        // webwxsync 直取消息数
    hookLinks: 0,       // 接口通道提取并提交的链接数
    hookCards: 0,       // 接口通道提取并提交的视频号卡片数
    hookResp: 0,        // 命中的网络响应数(XHR+fetch)
    hookShapes: [],     // 最近提取失败消息的结构计数；绝不保留字段值
    loginHint: false,   // 页面是否出现登录二维码(诊断用)
  };

  const SAFE_LOG_MESSAGES = Object.freeze({
    CARD_ACCEPTED: '视频号卡片已交给织台自动下载',
    CARD_REJECTED: '卡片入库请求被拒绝',
    CARD_OFFLINE: '卡片提交失败（节点未启动）',
    CARD_TIMEOUT: '卡片提交超时',
    LINK_DETECTED: '已识别受支持链接',
    LINK_ACCEPTED: '链接已入库',
    LINK_REJECTED: '链接入库请求被拒绝',
    LINK_OFFLINE: '请求失败（节点未启动或被拦截）',
    HISTORY_PRIMED: '历史链接已完成本地去重',
    DUPLICATES_SKIPPED: '重复链接已跳过',
    SCAN_SLOW: '扫描偏慢，已自动降频',
    DIAGNOSTIC_COPIED: '结构化诊断已复制；不含消息正文、HTML 或完整链接',
    SEEN_RESET: '已重置去重记录，页面现有链接会被重新入库',
    LEGACY_SEEN_CLEARED: '旧版完整 URL 去重项已清理',
    MANUAL_SCAN: '已手动触发全量扫描',
    NOTE_ACCEPTED: '已把备注附到上一条视频',
    NOTE_REJECTED: '备注暂未关联到视频',
    NOTE_OFFLINE: '备注未送达，视频下载不受影响',
  });

  function pushLog(kind, code, metric) {
    const safeKind = ['ok', 'err', 'hit', 'info', 'warn'].includes(kind) ? kind : 'info';
    const base = SAFE_LOG_MESSAGES[code] || '操作状态已更新';
    const count = Number.isSafeInteger(metric) && metric >= 0 ? Math.min(metric, 999999) : null;
    const text = count === null ? base : `${base}（${count}）`;
    state.log.unshift({ t: new Date().toLocaleTimeString('zh-CN', { hour12: false }), kind: safeKind, text });
    if (state.log.length > 30) state.log.pop();
    render();
  }

  /* ── 去重记忆 ── */
  let seen = new Set();
  try {
    const arr = JSON.parse(GM_getValue(SEEN_KEY, '[]'));
    if (Array.isArray(arr)) {
      seen = new Set(arr.filter((value) => /^v2:[0-9a-f]{16}$/i.test(String(value))));
    }
  } catch (e) { /* 忽略损坏记录 */ }
  let saveTimer = null;
  function remember(norm) {
    seen.add(dedupeKey(norm));
    if (seen.size > SEEN_CAP) seen = new Set([...seen].slice(-SEEN_CAP));
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => GM_setValue(SEEN_KEY, JSON.stringify([...seen])), 800);
  }

  function wasSeen(norm) {
    return seen.has(dedupeKey(norm));
  }

  // 同步去重只需稳定指纹；GM storage 永不保存完整或带签名的 URL。
  function dedupeKey(value) {
    const input = String(value || '');
    if (/^v2:[0-9a-f]{16}$/i.test(input)) return input.toLowerCase();
    let hash = 0xcbf29ce484222325n;
    for (let i = 0; i < input.length; i++) {
      hash ^= BigInt(input.charCodeAt(i));
      hash = BigInt.asUintN(64, hash * 0x100000001b3n);
    }
    return `v2:${hash.toString(16).padStart(16, '0')}`;
  }

  /* ════════════════════════════════════════════════════════════════
     XHR Hook:webwxsync 接口直取
     网页版传输助手收到消息后走 webwxsync 接口同步,响应 AddMsgList。
     视频号消息 Content 一般是转义 XML(内含 <url> <desc>),但微信可能改
     AppMsgType/结构——所以 v1.3.4 不再猜消息类型,一律先在 Content 里
     全量扫 URL(含转义后的 XML <url>)，扫不到时只记录字段存在性与长度桶。
     ════════════════════════════════════════════════════════════════ */
  let msgSeen = new Set();            // 按 MsgId 去重,避免同消息重复提交
  let recentCard = null;              // 只保留卡片身份；用户明确紧随的文字可作为业务备注

  function extractFromWxMsg(m) {
    // v1.3.5:扫描消息的多个字段(Content/Url/FileName/Title/Desc),不再只看 Content。
    // 实测网页版新版消息 MsgType=51(状态通知)Content 为空,视频号数据可能在
    // 其它顶层字段(Url 等)或同批 AddMsgList 的其它消息里。
    const fieldNames = ['Content', 'Url', 'FileName', 'Title', 'Desc', 'Digest'];
    const candidates = [];
    for (const fn of fieldNames) {
      const f = m[fn];
      if (!f || typeof f !== 'string') continue;

      // 字段里直接扫 URL
      URL_RE.lastIndex = 0;
      let mm;
      while ((mm = URL_RE.exec(f)) !== null) {
        candidates.push(mm[0].replace(/[，。；、）》】)\]}]*$/u, ''));
      }

      // 字段是(转义的)XML,解析 <url> 标签(优先最后一个,通常高清直链)。
      // 微信网页版 Content 是 HTML 实体转义(&lt; &gt; &quot; &#39; &amp;),
      // 按官方顺序反转义再交给 DOMParser,否则 getElementsByTagName 拿不到元素。
      let xmlText = f;
      try { xmlText = decodeURIComponent(xmlText); } catch (e) { /* 保持原文 */ }
      xmlText = xmlText.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
      xmlText = xmlText.replace(/<br\/>/g, "");
      if (xmlText.indexOf('<url') !== -1) {
        let doc = null;
        try { doc = new DOMParser().parseFromString(xmlText, 'text/xml'); } catch (e) { /* ignore */ }
        if (doc) {
          const urls = doc.getElementsByTagName('url');
          for (let i = urls.length - 1; i >= 0; i--) {
            const t = (urls[i].textContent || '').trim();
            if (!t) continue;
            candidates.push(t.replace(/^[^:]*:/, 'https:'));
          }
        }
      }
    }

    for (let i = candidates.length - 1; i >= 0; i--) {
      if (isSupported(candidates[i])) return candidates[i];
    }
    return candidates.length ? candidates[candidates.length - 1] : null;
  }

  function decodeWxXml(value) {
    let text = String(value || '');
    try { text = decodeURIComponent(text); } catch (e) { /* 保持原文 */ }
    return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      .replace(/<br\s*\/>/gi, '');
  }

  /** 从视频号转发卡片 XML 提取平台身份，不上传 Cookie 或加密下载地址。 */
  function extractCardFromWxMsg(msg) {
    for (const name of ['Content', 'Url', 'Digest']) {
      const raw = msg && msg[name];
      if (typeof raw !== 'string' || raw.indexOf('objectId') === -1) continue;
      const xml = decodeWxXml(raw);
      let doc;
      try { doc = new DOMParser().parseFromString(xml, 'text/xml'); } catch (e) { continue; }
      const objectId = (doc.getElementsByTagName('objectId')[0]?.textContent || '').trim();
      const nonceId = (doc.getElementsByTagName('objectNonceId')[0]?.textContent || '').trim();
      if (!/^[0-9]{6,32}$/.test(objectId) || !/^[A-Za-z0-9_-]{1,240}$/.test(nonceId)) continue;
      return {
        objectId,
        nonceId,
        deliveryId: msg.MsgId == null ? null : String(msg.MsgId),
      };
    }
    return null;
  }

  function submitCard(card, seenKey) {
    GM_xmlhttpRequest({
      method: 'POST',
      url: CARD_ENDPOINT,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({
        objectId: card.objectId,
        nonceId: card.nonceId,
        deliveryId: card.deliveryId,
        source: SOURCE,
      }),
      timeout: 15000,
      onload: (r) => {
        if (r.status === 202) {
          // 只在本地节点确认收到后记已见，避免节点短暂离线造成永久丢失。
          remember(seenKey);
          state.submitted += 1;
          state.hookCards += 1;
          pushLog('ok', 'CARD_ACCEPTED');
        } else {
          state.failed += 1;
          pushLog('err', 'CARD_REJECTED', Number(r.status));
        }
      },
      onerror: () => { state.failed += 1; pushLog('err', 'CARD_OFFLINE'); },
      ontimeout: () => { state.failed += 1; pushLog('err', 'CARD_TIMEOUT'); },
    });
  }

  function submitCardNote(card, note) {
    GM_xmlhttpRequest({
      method: 'POST',
      url: NOTE_ENDPOINT,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({
        deliveryId: card.deliveryId,
        objectId: card.objectId,
        note,
        source: SOURCE,
      }),
      timeout: 10000,
      onload: (r) => pushLog(r.status === 200 ? 'ok' : 'warn', r.status === 200 ? 'NOTE_ACCEPTED' : 'NOTE_REJECTED'),
      onerror: () => pushLog('warn', 'NOTE_OFFLINE'),
      ontimeout: () => pushLog('warn', 'NOTE_OFFLINE'),
    });
  }

  function plainNoteFromWxMsg(msg) {
    if (!msg || Number(msg.MsgType) !== 1 || typeof msg.Content !== 'string') return '';
    const text = decodeWxXml(msg.Content).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 1000 || /https?:\/\//i.test(text) || /无法显示|暂不支持|当前版本|升级至最新/.test(text)) return '';
    return text;
  }

  function trySubmitCard(card) {
    if (!card) return false;
    recentCard = { objectId: card.objectId, deliveryId: card.deliveryId, at: Date.now() };
    const key = 'card:' + (card.deliveryId || card.objectId);
    if (wasSeen(key)) return true;
    if (!primed) { remember(key); return true; }
    submitCard(card, key);
    return true;
  }

  function rememberHookShape(msg, link) {
    // 只保留结构：字段名、长度桶和有限类型码；不缓存正文、HTML、URL 或标识符。
    if (link) return;
    const presentFields = [];
    const lengthBuckets = {};
    for (const fn of ['Content', 'Url', 'FileName', 'Title', 'Desc', 'Digest']) {
      const v = msg[fn];
      if (v && typeof v === 'string' && v.trim()) {
        presentFields.push(fn);
        const length = v.length;
        lengthBuckets[fn] = length <= 64 ? '1-64' : length <= 256 ? '65-256' : '257+';
      }
    }
    const summary = {
      t: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      msgType: safeTypeCode(msg.MsgType),
      appMsgType: safeTypeCode(msg.AppMsgType),
      presentFields,
      lengthBuckets,
    };
    state.hookShapes.unshift(summary);
    if (state.hookShapes.length > 6) state.hookShapes.pop();
  }

  function safeTypeCode(value) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 && number <= 9999 ? number : 'other';
  }

  /* ════════════════════════════════════════════════════════════════
     XHR + fetch 双通道 Hook + 全响应扫描(v1.3.8)
     慢点去水印的成熟做法:不止监听 webwxsync,凡是响应文本里带
     sph/finder/channels 痕迹的(视频号分享可能走任意接口,甚至 fetch),
     一律全文本提取 URL。不再依赖消息结构猜测。
     ════════════════════════════════════════════════════════════════ */
  let respUrlSeen = new Set();        // 响应级 URL 去重窗口
  let hookInstalled = false;

  function trySubmitUrl(u) {
    const safeUrl = canonicalSupportedUrl(u);
    const responseKey = dedupeKey(safeUrl);
    if (!safeUrl || wasSeen(safeUrl) || respUrlSeen.has(responseKey)) return;
    respUrlSeen.add(responseKey);
    if (respUrlSeen.size > 500) respUrlSeen = new Set([...respUrlSeen].slice(-400));
    if (!primed) { remember(safeUrl); return; }   // 首扫阶段只记账,防历史同步灌库
    remember(safeUrl);
    state.hookLinks += 1;
    pushLog('ok', 'LINK_DETECTED');
    submit(safeUrl);
  }

  // 诊断上报只传固定字段的统计摘要。原始 URL、响应正文和消息字段值不会离开页面。
  let diagBudget = 0;
  function sendDiag(text, transport) {
    try {
      if (Date.now() > diagBudget) {
        diagBudget = Date.now() + 10000;   // 10 秒最多发一条,防刷屏
        GM_xmlhttpRequest({
          method: 'POST',
          url: ENDPOINT.replace('/inbox', '/diag'),
          headers: { 'Content-Type': 'application/json' },
          data: JSON.stringify(buildSyncDiagnostic(text, transport)),
          onload: () => {},
          onerror: () => {},
        });
      }
    } catch (e) { /* ignore */ }
  }

  function buildSyncDiagnostic(text, transport) {
    const raw = String(text || '');
    const summary = {
      schemaVersion: 2,
      source: 'filehelper_bridge',
      kind: 'sync_response',
      outcome: 'observed',
      transport: transport === 'xhr' || transport === 'fetch' ? transport : 'unknown',
      contentType: 'json',
      metrics: {
        payloadBytes: utf8Bytes(raw),
        itemCount: 0,
        messageCount: 0,
        linkCount: Math.min((raw.match(/https?:\/\//gi) || []).length, 10000),
      },
    };
    try {
      const data = JSON.parse(raw);
      const list = Array.isArray(data?.AddMsgList) ? data.AddMsgList : [];
      summary.metrics.messageCount = Math.min(list.length, 10000);
      for (const msg of list.slice(0, 10000)) {
        if (!msg || typeof msg !== 'object') continue;
        if (['Content', 'Url', 'Digest'].some((field) => typeof msg[field] === 'string' && msg[field].includes('objectId'))) {
          summary.metrics.itemCount += 1;
        }
      }
    } catch (e) { /* JSON 失败也只上报字节数与固定枚举 */ }
    return summary;
  }

  function utf8Bytes(value) {
    try { return Math.min(new TextEncoder().encode(value).byteLength, 10 * 1024 * 1024); }
    catch (e) { return Math.min(String(value).length * 3, 10 * 1024 * 1024); }
  }

  function scanResponse(url, text, transport) {
    if (!text || typeof text !== 'string' || text.length < 20) return;
    // 快筛:没有视频号痕迹的响应直接跳过,保持低开销
    if (url.indexOf('webwxsync') === -1 &&
        text.indexOf('sph') === -1 &&
        text.indexOf('finder') === -1 &&
        text.indexOf('channels.weixin') === -1) return;
    state.hookResp += 1;

    // webwxsync 只上报结构化计数，绝不发送原文或完整 URL。
    if (url.indexOf('webwxsync') !== -1) sendDiag(text, transport);

    // 通道A:webwxsync 的 AddMsgList 结构解析（MsgId 仅内存去重；诊断只留结构计数）
    if (url.indexOf('webwxsync') !== -1) {
      try {
        const data = JSON.parse(text);
        const list = data && data.AddMsgList;
        if (Array.isArray(list)) {
          for (const msg of list) {
            if (!msg || msgSeen.has(msg.MsgId)) continue;
            msgSeen.add(msg.MsgId);
            if (msgSeen.size > 2000) msgSeen = new Set([...msgSeen].slice(-1500));
            state.hookMsgs += 1;
            // 慢点去水印的经验:MsgType 51/43/49 都是视频类消息,51 不忽略
            const card = extractCardFromWxMsg(msg);
            const link = extractFromWxMsg(msg);
            if (card) trySubmitCard(card);
            else if (link) trySubmitUrl(link);
            else {
              const note = plainNoteFromWxMsg(msg);
              if (note && recentCard && Date.now() - recentCard.at <= 2 * 60 * 1000) {
                submitCardNote(recentCard, note);
              } else {
                rememberHookShape(msg, null);
              }
            }
          }
        }
      } catch (e) { /* JSON 失败则走全局提取兜底 */ }
    }

    // 通道B:全文本 URL 提取(覆盖任何接口,fetch 拉的视频号数据也能捞到)。
    // 先做实体反转义,避免 &lt;/url&gt; 之类的尾巴粘在 URL 后面。
    let flat = text;
    if (flat.indexOf('&lt;') !== -1 || flat.indexOf('&gt;') !== -1) {
      flat = flat.replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
    }
    const found = new Set();
    URL_RE.lastIndex = 0;
    let m;
    while ((m = URL_RE.exec(flat)) !== null) {
      const u = m[0].replace(/[，。；、）》】)\]}]*$/u, '');
      if (isSupported(u)) found.add(u);
    }
    // 补充:XML <url> 标签内被实体/换行包裹的链接
    const xmlSegs = flat.match(/<url[^>]*>([^<]{8,400})<\/url>/gi);
    if (xmlSegs) {
      for (const seg of xmlSegs) {
        const mm = seg.match(/https?:\/\/[^\s"<>]+/i);
        if (mm) {
          const u = mm[0].replace(/[，。；、）》】)\]}]*$/u, '');
          if (isSupported(u)) found.add(u);
        }
      }
    }
    for (const u of found) trySubmitUrl(u);
  }

  function hookNetwork() {
    if (hookInstalled) return;
    hookInstalled = true;
    // XHR 通道
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      try {
        this.addEventListener('load', () => {
          try {
            scanResponse(this.responseURL || '', this.responseText || '', 'xhr');
          } catch (e) { /* ignore */ }
        });
      } catch (e) { /* ignore */ }
      return origSend.apply(this, arguments);
    };
    // fetch 通道(新版网页版可能用 fetch 拉 webwxsync)
    const origFetch = window.fetch;
    if (typeof origFetch === 'function') {
      window.fetch = function () {
        const args = arguments;
        const reqUrl = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
        const p = origFetch.apply(this, args);
        p.then((resp) => {
          try {
            resp.clone().text().then((t) => scanResponse(reqUrl, t, 'fetch')).catch(() => {});
          } catch (e) { /* ignore */ }
        }).catch(() => {});
        return p;
      };
    }
  }

  /* ── DOM 通道:采集(全量遍历 + 卡片深挖) ── */
  function collectFrom(roots) {
    const out = [];
    let budget = NODE_BUDGET;
    let textLen = 0;
    const visited = new Set();

    function takeEl(el) {
      if (el.tagName === 'A' && el.href) out.push(el.href);
      const attrs = el.attributes;
      if (attrs) {
        for (let i = 0; i < attrs.length; i++) {
          const v = attrs[i].value;
          if (!v) continue;
          if (/^https?:\/\//i.test(v)) { out.push(v); continue; }
          if (v.startsWith('//')) { out.push('https:' + v); continue; }
          if (/(?:sph|finder|channels)/i.test(v)) {
            const mm = v.match(/https?:\/\/[^\s"'<>]+/i);
            if (mm) { out.push(mm[0]); continue; }
            state.sphHints += 1;
            state.unparsedCardHints += 1;
          }
        }
      }
      if (el.shadowRoot) walk(el.shadowRoot);
    }

    function walk(root) {
      if (!root || budget <= 0 || visited.has(root)) return;
      visited.add(root);
      if (root.nodeType === 1) takeEl(root);
      let nodes;
      try { nodes = root.querySelectorAll('*'); } catch (e) { return; }
      for (let i = 0; i < nodes.length; i++) {
        if (--budget <= 0) break;
        takeEl(nodes[i]);
      }
      if (textLen < TEXT_BUDGET) {
        const t = root.textContent || '';
        textLen += t.length;
        extractUrls(t.length > TEXT_BUDGET ? t.slice(0, TEXT_BUDGET) : t, out);
      }
    }

    for (const r of roots) walk(r);
    state.lastTextLen = textLen;
    return out;
  }

  /* ── 提交(免密钥:来源绑定) ── */
  function submit(url) {
    const safeUrl = canonicalSupportedUrl(url);
    if (!safeUrl) return;
    GM_xmlhttpRequest({
      method: 'POST',
      url: ENDPOINT,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ text: safeUrl, source: SOURCE }),
      onload: (r) => {
        if (r.status === 202) {
          state.submitted += 1;
          pushLog('ok', 'LINK_ACCEPTED');
        } else {
          state.failed += 1;
          pushLog('err', 'LINK_REJECTED', Number(r.status));
        }
      },
      onerror: () => {
        state.failed += 1;
        pushLog('err', 'LINK_OFFLINE');
      },
    });
  }

  /* ── 扫描调度 ── */
  let primed = false;
  let scanTimer = null;
  let pendingRoots = new Set();
  let fullScanQueued = false;
  let lastDupLogAt = 0;                 // 去重提示节流

  function scheduleScan(roots) {
    if (roots && roots.length) {
      for (const r of roots) pendingRoots.add(r);
      if (pendingRoots.size > 200) { fullScanQueued = true; pendingRoots.clear(); }
    } else {
      fullScanQueued = true;
    }
    if (scanTimer) return;
    const delay = state.degraded ? 2400 : 600;
    scanTimer = setTimeout(() => { scanTimer = null; runScan(); }, delay);
  }

  function runScan() {
    const t0 = performance.now();
    let roots;
    if (fullScanQueued || pendingRoots.size === 0) {
      roots = [document.documentElement];
    } else {
      const alive = [...pendingRoots].filter((n) => n.isConnected);
      roots = (alive.length !== pendingRoots.size) ? [document.documentElement] : alive;
    }
    fullScanQueued = false;
    pendingRoots.clear();
    state.sphHints = 0;
    state.unparsedCardHints = 0;
    state.loginHint = false;

    state.scans += 1;
    const candidates = collectFrom(roots);

    let submittedNow = 0;
    let dupSkipped = 0;
    for (let i = 0; i < candidates.length; i++) {
      const norm = candidates[i].split('#')[0];
      // 登录二维码检测:页面停在扫码界面时,新消息不可能到达
      if (/^https?:\/\/login\.weixin\.qq\.com\/qrcode/i.test(norm)) {
        state.loginHint = true;
        continue;
      }
      const safeUrl = canonicalSupportedUrl(norm);
      if (safeUrl && wasSeen(safeUrl)) { dupSkipped += 1; continue; }
      if (!safeUrl) {
        if (/^https?:/i.test(norm)) state.otherLinkCount = Math.min(state.otherLinkCount + 1, 999999);
        continue;
      }
      remember(safeUrl);
      if (!primed) continue;
      pushLog('hit', 'LINK_DETECTED');
      submit(safeUrl);
      submittedNow += 1;
    }

    if (!primed) {
      primed = true;
      pushLog('info', 'HISTORY_PRIMED', seen.size);
    } else if (dupSkipped > 0 && submittedNow === 0) {
      // 节流:同类日志最多 30 秒一条,避免刷屏
      const now = Date.now();
      if (now - lastDupLogAt > 30000) {
        lastDupLogAt = now;
        pushLog('info', 'DUPLICATES_SKIPPED', dupSkipped);
      }
    }

    state.lastScanMs = Math.round(performance.now() - t0);
    if (state.lastScanMs > SLOW_SCAN_MS) {
      if (!state.degraded && state.lastScanMs > SLOW_SCAN_MS) {
        state.degraded = true;
        pushLog('warn', 'SCAN_SLOW', state.lastScanMs);
      }
    } else if (state.degraded && state.lastScanMs < 80) {
      state.degraded = false;
    }
    render();
  }

  function checkNode() {
    GM_xmlhttpRequest({
      method: 'GET',
      url: 'http://127.0.0.1:17890/health',
      timeout: 6000,
      onload: (r) => { state.nodeOk = r.status === 200; render(); },
      onerror: () => { state.nodeOk = false; render(); },
      ontimeout: () => { state.nodeOk = false; render(); },
    });
  }

  /* ── 面板 ── */
  let shadow, panel, badge, expanded = false;
  function buildUI() {
    const host = document.createElement('div');
    host.setAttribute('data-zhitai', 'bridge');
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483647';
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = `
      :host{all:initial}
      .badge{position:fixed;right:16px;bottom:16px;background:#1d9e75;color:#fff;
        font:500 12px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
        padding:7px 12px;border-radius:16px;cursor:pointer;user-select:none;
        box-shadow:0 2px 8px rgba(0,0,0,.18)}
      .panel{position:fixed;right:16px;bottom:54px;display:none;width:400px;max-height:62vh;
        overflow:auto;background:#fff;color:#2c2c2a;
        font:400 12px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
        border:1px solid rgba(0,0,0,.15);border-radius:12px;padding:12px 14px;
        box-shadow:0 4px 16px rgba(0,0,0,.14)}
      .row{display:flex;justify-content:space-between;gap:12px}
      .k{color:#5f5e5a}.good{color:#0f6e56}.bad{color:#a32d2d}
      .h{margin-top:10px;font-weight:500}
      .dim{color:#5f5e5a;word-break:break-all}
      .copybtn{margin-top:10px;width:100%;padding:8px 0;background:#1d9e75;color:#fff;
        border:0;border-radius:8px;font:600 12px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer}
    `;
    shadow.appendChild(style);

    badge = document.createElement('div');
    badge.className = 'badge';
    badge.addEventListener('click', () => { expanded = !expanded; render(); });
    shadow.appendChild(badge);

    panel = document.createElement('div');
    panel.className = 'panel';
    shadow.appendChild(panel);
  }

  let renderQueued = false;
  let lastBadgeText = '';
  let lastPanelHtml = '';
  function render() {
    if (!badge || renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; doRender(); });
  }

  function buildDiagnostic() {
    const lines = [];
    lines.push('【织台桥结构化诊断 v1.5.0】' + new Date().toLocaleString('zh-CN', { hour12: false }));
    lines.push('页面类型: 文件传输助手（地址已省略）');
    lines.push('节点: ' + (state.nodeOk === true ? '已连通 17890' : state.nodeOk === false ? '连不上 17890' : '检测中') +
      ' | 成功入库 ' + state.submitted + ' | 失败 ' + state.failed);
    lines.push('扫描: ' + state.scans + ' 次 | 最近耗时 ' + state.lastScanMs + 'ms' + (state.degraded ? '(已降频)' : ''));
    lines.push('网络接口(XHR+fetch): 命中响应 ' + state.hookResp + ' 个 | 收到消息 ' + state.hookMsgs + ' 条 | 卡片 ' + state.hookCards + ' / 链接 ' + state.hookLinks);
    if (state.hookShapes.length) {
      lines.push('-- webwxsync 消息结构（不含字段值） --');
      for (const shape of state.hookShapes) {
        const fields = shape.presentFields.length ? shape.presentFields.join(',') : 'none';
        const buckets = shape.presentFields.map((field) => `${field}:${shape.lengthBuckets[field]}`).join(',') || 'none';
        lines.push(`  [${shape.t}] MsgType=${shape.msgType} AppMsgType=${shape.appMsgType} Fields=${fields} Lengths=${buckets}`);
      }
    }
    lines.push('页面文本量: ' + state.lastTextLen + ' 字符 | 疑似视频号卡片: ' + state.sphHints + ' 处');
    lines.push('已见链接(去重库): ' + seen.size + ' 条');
    lines.push('白名单外链接: ' + state.otherLinkCount + ' 条（地址已省略）');
    if (state.log.length) {
      lines.push('-- 最近动作(最多10条) --');
      lines.push(...state.log.slice(0, 10).map((l) => '  ' + l.t + ' ' + l.text));
    }
    lines.push('未解析卡片结构提示: ' + state.unparsedCardHints + ' 处（HTML 已省略）');
    lines.push('-- 结尾 --（仅包含结构化统计，可粘贴给支持人员）');
    return lines.join('\n');
  }

  function copyDiagnostic() {
    const text = buildDiagnostic();
    try { GM_setClipboard(text, 'text'); } catch (e) {
      try { navigator.clipboard.writeText(text); } catch (e2) {
        const ta = document.createElement('textarea');
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); } catch (e3) { /* ignore */ }
        ta.remove();
      }
    }
    pushLog('info', 'DIAGNOSTIC_COPIED');
  }

  function doRender() {
    const okNode = state.nodeOk === true;
    const bText = `织台 ${okNode ? '●' : '○'} 入库 ${state.submitted}${state.failed ? ' / 失败 ' + state.failed : ''}`;
    if (bText !== lastBadgeText) { badge.textContent = bText; lastBadgeText = bText; }
    badge.style.background = okNode ? (state.degraded ? '#ba7517' : '#1d9e75') : '#e24b4a';

    if (!expanded) { panel.style.display = 'none'; return; }
    panel.style.display = 'block';

    const rows = [];
    rows.push('<div style="font-weight:500;margin-bottom:8px">织台 · 入库桥自检 v1.5.0</div>');
    rows.push(line('脚本运行', `是(已扫描 ${state.scans} 次)`, true));
    rows.push(line('本地节点', state.nodeOk === null ? '检测中…' : (okNode ? '已连通 17890' : '连不上 17890'), state.nodeOk !== false));
    rows.push(line('鉴权方式', '来源绑定(免密钥)', true));
    rows.push(line('接口直取', `响应 ${state.hookResp} / 消息 ${state.hookMsgs} / 卡片 ${state.hookCards} / 链接 ${state.hookLinks}`, state.hookCards > 0 || state.hookLinks > 0 || state.hookResp === 0));
    rows.push(line('单次扫描耗时', state.lastScanMs + ' ms' + (state.degraded ? '(已降频)' : ''), !state.degraded));
    rows.push(line('页面文本量', state.lastTextLen + ' 字符', state.lastTextLen > 0));
    rows.push(line('疑似视频号卡片', state.sphHints ? state.sphHints + ' 处(未提取到标准链接)' : '0', state.sphHints === 0));
    rows.push(line('成功入库', String(state.submitted), true));

    if (state.loginHint) {
      rows.push('<div class="h" style="color:#a32d2d">⚠️ 页面显示登录二维码,请先扫码登录</div>');
      rows.push('<div class="dim">登录后新消息才会同步到页面,再转发视频号测试。</div>');
    }

    rows.push('<button class="copybtn">📋 复制结构化诊断（不含正文/链接）</button>');
    rows.push('<button class="copybtn" id="resetbtn" style="background:#ba7517;margin-top:6px">🔄 重置已读记录(允许重新入库)</button>');

    if (state.hookShapes.length) {
      rows.push('<div class="h">webwxsync 消息结构（字段值已省略）</div>');
      rows.push('<div class="dim" style="font-size:10px;word-break:break-all">' + state.hookShapes.map((shape) =>
        `<div style="margin-top:4px">[${shape.t}] MsgType=${shape.msgType} AppMsgType=${shape.appMsgType}<br>Fields=${esc(shape.presentFields.join(',') || 'none')}</div>`,
      ).join('') + '</div>');
    }

    rows.push(line('白名单外链接', `${state.otherLinkCount} 条（地址已省略）`, true));
    rows.push(line('未解析卡片结构', `${state.unparsedCardHints} 处（HTML 已省略）`, true));

    rows.push('<div class="h">最近动作</div>');
    rows.push(state.log.length
      ? '<div style="word-break:break-all">' + state.log.map((l) =>
          `<div style="color:${l.kind === 'err' ? '#a32d2d' : l.kind === 'ok' ? '#0f6e56' : l.kind === 'warn' ? '#854f0b' : '#5f5e5a'}">${l.t} ${esc(l.text)}</div>`,
        ).join('') + '</div>'
      : '<div style="color:#888780">暂无 —— 说明还没在页面上发现可识别的链接</div>');

    const html = rows.join('');
    if (html !== lastPanelHtml) {
      panel.innerHTML = html;
      lastPanelHtml = html;
      const btn = panel.querySelector('.copybtn');
      if (btn) btn.addEventListener('click', copyDiagnostic);
      const rbtn = panel.querySelector('#resetbtn');
      if (rbtn) rbtn.addEventListener('click', () => {
        seen = new Set();
        GM_setValue(SEEN_KEY, '[]');
        primed = true;
        pushLog('info', 'SEEN_RESET');
        scheduleScan(null);
      });
    }
  }

  function line(k, v, good) {
    return `<div class="row"><span class="k">${k}</span><span class="${good ? 'good' : 'bad'}">${esc(v)}</span></div>`;
  }
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /* ── 菜单 ── */
  GM_registerMenuCommand('织台·一键复制诊断信息', copyDiagnostic);
  GM_registerMenuCommand('织台·重置已读记录(允许重新入库)', () => {
    seen = new Set();
    GM_setValue(SEEN_KEY, '[]');
    primed = true;
    pushLog('info', 'SEEN_RESET');
    scheduleScan(null);
  });
  GM_registerMenuCommand('织台·隐私：清理旧版完整 URL 去重项…', () => {
    const approved = window.confirm('仅删除旧版桥保存的完整 URL 去重项；当前 v2 指纹不受影响。继续吗？');
    if (!approved) return;
    try { GM_deleteValue(LEGACY_SEEN_KEY); } catch (e) { return; }
    pushLog('info', 'LEGACY_SEEN_CLEARED');
  });
  GM_registerMenuCommand('织台·立即扫描并入库当前页面', () => {
    primed = true;
    fullScanQueued = true;
    pushLog('info', 'MANUAL_SCAN');
    scheduleScan(null);
  });

  /* ── 启动 ── */
  function boot() {
    buildUI();
    checkNode();
    setInterval(checkNode, 30000);
    setInterval(() => scheduleScan(null), FULL_SCAN_MS);
    scheduleScan(null);

    const mo = new MutationObserver((records) => {
      const roots = [];
      for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        if (rec.type === 'childList') {
          for (let j = 0; j < rec.addedNodes.length; j++) {
            const n = rec.addedNodes[j];
            if (n.nodeType === 1) roots.push(n);
            else if (n.nodeType === 3 && n.parentElement) roots.push(n.parentElement);
          }
        } else if (rec.type === 'characterData' && rec.target.parentElement) {
          roots.push(rec.target.parentElement);
        }
      }
      if (roots.length) scheduleScan(roots);
    });
    mo.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

    console.log('[织台] 入库桥 v1.4.0 已启动(卡片直取 + 链接/DOM 双通道,免密钥)。');
  }

  // document-start 立即挂 XHR hook(必须在微信页面脚本之前),UI 等 DOM 就绪
  hookNetwork();
  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
