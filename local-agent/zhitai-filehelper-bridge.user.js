// ==UserScript==
// @name         织台·文件传输助手入库桥
// @namespace    zhitai.local
// @version      1.4.1
// @description  监听网页版文件传输助手的新消息；视频号转发卡片直接提取 objectId/nonceId 自动下载入库，链接继续走原有通道。免密钥、零配置。
// @match        https://filehelper.weixin.qq.com/*
// @match        https://szfilehelper.weixin.qq.com/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// @connect      127.0.0.1
// @connect      localhost
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  const ENDPOINT = 'http://127.0.0.1:17890/api/v1/inbox';
  const CARD_ENDPOINT = 'http://127.0.0.1:17890/api/v1/channels/card';
  const NOTE_ENDPOINT = 'http://127.0.0.1:17890/api/v1/channels/note';
  const SOURCE = 'filehelper_web';
  const SEEN_KEY = 'zhitai_filehelper_seen';
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
  // 允许的子域后缀(不含 weixin.qq.com 主域)
  const SUPPORTED_SUFFIXES = [
    '.mp.weixin.qq.com', '.channels.weixin.qq.com', '.finder.video.qq.com',
    '.v.douyin.com', '.www.douyin.com', '.m.douyin.com', '.iesdouyin.com',
    '.xiaohongshu.com', '.www.xiaohongshu.com', '.xhslink.com',
  ];

  function isSupported(u) {
    let h = '', path = '';
    try {
      const p = new URL(u);
      h = p.hostname.toLowerCase();
      path = p.pathname;
    } catch (e) { return false; }
    if (!h) return false;
    // v1.3.12:排除加密链——stodownload/wxapp.tc.qq.com/finder /251/ 是视频号加密流,
    // 元宝解析不了(提交必失败),由慢点去水印(TikHub)处理,这里直接跳过。
    if (h === 'wxapp.tc.qq.com') return false;
    if (h === 'finder.video.qq.com' && (path.includes('/251/') || path.includes('stodownload'))) return false;
    if (SUPPORTED_EXACT.has(h)) {
      // weixin.qq.com 主域只放行 /sph/ 视频号短链;readtemplate/cgi-bin 等
      // 服务条款、协议页不是内容链接,必须排除(实测被误提交过)。
      if (h === 'weixin.qq.com' && path.indexOf('/sph/') !== 0) return false;
      return true;
    }
    for (let i = 0; i < SUPPORTED_SUFFIXES.length; i++) {
      if (h.endsWith(SUPPORTED_SUFFIXES[i])) return true;
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
    otherLinks: [],
    lastTextLen: 0,
    sphHints: 0,
    sphSample: '',
    hookMsgs: 0,        // webwxsync 直取消息数
    hookLinks: 0,       // 接口通道提取并提交的链接数
    hookCards: 0,       // 接口通道提取并提交的视频号卡片数
    hookResp: 0,        // 命中的网络响应数(XHR+fetch)
    hookRaw: [],        // 最近提取失败的消息摘要(诊断用,最多6条)
    loginHint: false,   // 页面是否出现登录二维码(诊断用)
  };

  function pushLog(kind, text) {
    state.log.unshift({ t: new Date().toLocaleTimeString('zh-CN', { hour12: false }), kind, text });
    if (state.log.length > 30) state.log.pop();
    render();
  }

  /* ── 去重记忆 ── */
  let seen = new Set();
  try {
    const arr = JSON.parse(GM_getValue(SEEN_KEY, '[]'));
    if (Array.isArray(arr)) seen = new Set(arr);
  } catch (e) { /* 忽略损坏记录 */ }
  let saveTimer = null;
  function remember(norm) {
    seen.add(norm);
    if (seen.size > SEEN_CAP) seen = new Set([...seen].slice(-SEEN_CAP));
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => GM_setValue(SEEN_KEY, JSON.stringify([...seen])), 800);
  }

  /* ════════════════════════════════════════════════════════════════
     XHR Hook:webwxsync 接口直取
     网页版传输助手收到消息后走 webwxsync 接口同步,响应 AddMsgList。
     视频号消息 Content 一般是转义 XML(内含 <url> <desc>),但微信可能改
     AppMsgType/结构——所以 v1.3.4 不再猜消息类型,一律先在 Content 里
     全量扫 URL(含转义后的 XML <url>),扫不到就把原始消息存进诊断。
     ════════════════════════════════════════════════════════════════ */
  let msgSeen = new Set();            // 按 MsgId 去重,避免同消息重复提交
  let recentCard = null;              // 卡片后 2 分钟内的纯文字视为用户备注/操作要求

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
      const descriptions = doc.getElementsByTagName('desc');
      let title = '';
      for (let i = descriptions.length - 1; i >= 0; i--) {
        title = (descriptions[i].textContent || '').trim();
        if (title) break;
      }
      if (!title) title = (doc.getElementsByTagName('title')[0]?.textContent || '').trim();
      return {
        objectId,
        nonceId,
        title: title || '视频号内容',
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
      data: JSON.stringify({ ...card, source: SOURCE }),
      timeout: 15000,
      onload: (r) => {
        if (r.status === 202) {
          // 只在本地节点确认收到后记已见。以前在发送前就记忆，
          // 节点暂时离线时会让该卡片永久丢失。
          remember(seenKey);
          state.submitted += 1;
          state.hookCards += 1;
          pushLog('ok', '视频号卡片已交给织台自动下载');
        } else {
          state.failed += 1;
          pushLog('err', `卡片入库返回 ${r.status}:${String(r.responseText).slice(0, 60)}`);
        }
      },
      onerror: () => { state.failed += 1; pushLog('err', '卡片提交失败(节点未启动)'); },
      ontimeout: () => { state.failed += 1; pushLog('err', '卡片提交超时'); },
    });
  }

  function submitCardNote(card, note) {
    GM_xmlhttpRequest({
      method: 'POST', url: NOTE_ENDPOINT,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ deliveryId: card.deliveryId, objectId: card.objectId, note, source: SOURCE }),
      timeout: 10000,
      onload: (r) => pushLog(r.status === 200 ? 'ok' : 'warn', r.status === 200 ? '已把你的备注附到上一条视频' : '备注暂未关联到视频'),
      onerror: () => pushLog('warn', '备注未送达织台，视频下载不受影响'),
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
    recentCard = { ...card, at: Date.now() };
    const key = 'card:' + (card.deliveryId || card.objectId);
    if (seen.has(key)) return true;
    if (!primed) { remember(key); return true; }
    submitCard(card, key);
    return true;
  }

  function rememberHookRaw(msg, link) {
    // 提取失败的消息摘要,进诊断,便于按真实结构打补丁。
    // 只记录"有内容字段但提取失败"的消息;MsgType=51 空 Content 的状态通知不记录。
    if (link) return;
    const parts = [];
    for (const fn of ['Content', 'Url', 'FileName', 'Title', 'Desc', 'Digest']) {
      const v = msg[fn];
      if (v && typeof v === 'string' && v.trim()) {
        parts.push(fn + '=' + v.replace(/\s+/g, ' ').slice(0, 160));
      }
    }
    if (!parts.length) parts.push('字段全空(Content/Url/FileName/Title/Desc 均为空)');   // 51 状态通知也记录,便于看到消息来了
    const summary = {
      t: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      MsgType: msg.MsgType, AppMsgType: msg.AppMsgType,
      fields: parts.join(' || '),
    };
    state.hookRaw.unshift(summary);
    if (state.hookRaw.length > 6) state.hookRaw.pop();
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
    if (!u || !isSupported(u) || seen.has(u) || respUrlSeen.has(u)) return;
    respUrlSeen.add(u);
    if (respUrlSeen.size > 500) respUrlSeen = new Set([...respUrlSeen].slice(-400));
    if (!primed) { remember(u); return; }   // 首扫阶段只记账,防历史同步灌库
    remember(u);
    state.hookLinks += 1;
    pushLog('ok', '接口直取:' + u.slice(0, 44));
    submit(u);
  }

  // 诊断上报:把 webwxsync 原始响应转发到本地节点存盘(v1.3.11),
  // 用于拿真实消息结构——不再靠猜,一次转发就能定位。
  let diagBudget = 0;
  function sendDiag(url, text) {
    try {
      if (Date.now() > diagBudget) {
        diagBudget = Date.now() + 10000;   // 10 秒最多发一条,防刷屏
        GM_xmlhttpRequest({
          method: 'POST',
          url: ENDPOINT.replace('/inbox', '/diag'),
          headers: { 'Content-Type': 'application/json' },
          data: JSON.stringify({ url, text: String(text).slice(0, 60000) }),
          onload: () => {},
          onerror: () => {},
        });
      }
    } catch (e) { /* ignore */ }
  }

  function scanResponse(url, text) {
    if (!text || typeof text !== 'string' || text.length < 20) return;
    // 快筛:没有视频号痕迹的响应直接跳过,保持低开销
    if (url.indexOf('webwxsync') === -1 &&
        text.indexOf('sph') === -1 &&
        text.indexOf('finder') === -1 &&
        text.indexOf('channels.weixin') === -1) return;
    state.hookResp += 1;

    // 诊断上报:webwxsync 响应原文存到节点(卡片消息结构之谜靠它解开)
    if (url.indexOf('webwxsync') !== -1) sendDiag(url, text);

    // 通道A:webwxsync 的 AddMsgList 结构解析(保留 MsgId 去重与原始消息诊断)
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
              if (note && recentCard && Date.now() - recentCard.at <= 2 * 60 * 1000) submitCardNote(recentCard, note);
              else rememberHookRaw(msg, null);
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
            scanResponse(this.responseURL || '', this.responseText || '');
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
            resp.clone().text().then((t) => scanResponse(reqUrl, t)).catch(() => {});
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
            if (!state.sphSample && el.outerHTML) state.sphSample = el.outerHTML.slice(0, 400);
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
    GM_xmlhttpRequest({
      method: 'POST',
      url: ENDPOINT,
      headers: { 'Content-Type': 'application/json' },
      data: JSON.stringify({ text: url, source: SOURCE }),
      onload: (r) => {
        if (r.status === 202) {
          state.submitted += 1;
          pushLog('ok', '已入库 ' + url.slice(0, 44));
        } else {
          state.failed += 1;
          pushLog('err', `入库返回 ${r.status}:${String(r.responseText).slice(0, 60)}`);
        }
      },
      onerror: () => {
        state.failed += 1;
        pushLog('err', '请求失败(节点未启动或被拦截)');
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
    state.sphSample = '';
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
      if (seen.has(norm)) { dupSkipped += 1; continue; }
      if (!isSupported(norm)) {
        if (/^https?:/i.test(norm) && !state.otherLinks.includes(norm)) {
          state.otherLinks.unshift(norm);
          if (state.otherLinks.length > 12) state.otherLinks.pop();
        }
        continue;
      }
      remember(norm);
      if (!primed) continue;
      pushLog('hit', '发现链接 ' + norm.slice(0, 44));
      submit(norm);
      submittedNow += 1;
    }

    if (!primed) {
      primed = true;
      pushLog('info', `已标记 ${seen.size} 条历史链接,新消息开始生效`);
    } else if (dupSkipped > 0 && submittedNow === 0) {
      // 节流:同类日志最多 30 秒一条,避免刷屏
      const now = Date.now();
      if (now - lastDupLogAt > 30000) {
        lastDupLogAt = now;
        pushLog('info', `发现 ${dupSkipped} 条链接,均已在库(去重跳过)`);
      }
    }

    state.lastScanMs = Math.round(performance.now() - t0);
    if (state.lastScanMs > SLOW_SCAN_MS) {
      if (!state.degraded && state.lastScanMs > SLOW_SCAN_MS) {
        state.degraded = true;
        pushLog('warn', `扫描偏慢(${state.lastScanMs}ms),已自动降频`);
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
    lines.push('【织台桥诊断 v1.3.4】' + new Date().toLocaleString('zh-CN', { hour12: false }));
    lines.push('页面: ' + location.href);
    lines.push('节点: ' + (state.nodeOk === true ? '已连通 17890' : state.nodeOk === false ? '连不上 17890' : '检测中') +
      ' | 成功入库 ' + state.submitted + ' | 失败 ' + state.failed);
    lines.push('扫描: ' + state.scans + ' 次 | 最近耗时 ' + state.lastScanMs + 'ms' + (state.degraded ? '(已降频)' : ''));
    lines.push('网络接口(XHR+fetch): 命中响应 ' + state.hookResp + ' 个 | 收到消息 ' + state.hookMsgs + ' 条 | 卡片 ' + state.hookCards + ' / 链接 ' + state.hookLinks);
    if (state.hookRaw.length) {
      lines.push('-- webwxsync 原始消息(提取失败,供诊断) --');
      for (const r of state.hookRaw) {
        lines.push(`  [${r.t}] MsgType=${r.MsgType} AppMsgType=${r.AppMsgType}`);
        lines.push('  ' + r.fields);
      }
    }
    lines.push('页面文本量: ' + state.lastTextLen + ' 字符 | 疑似视频号卡片: ' + state.sphHints + ' 处');
    lines.push('已见链接(去重库): ' + seen.size + ' 条');
    if (state.otherLinks.length) {
      lines.push('-- 白名单外链接 --');
      lines.push(...state.otherLinks.slice(0, 8).map((u) => '  ' + u));
    }
    if (state.log.length) {
      lines.push('-- 最近动作(最多10条) --');
      lines.push(...state.log.slice(0, 10).map((l) => '  ' + l.t + ' ' + l.text));
    }
    if (state.sphSample) {
      lines.push('-- 卡片HTML片段 --');
      lines.push(state.sphSample);
    }
    lines.push('-- 结尾 --(把以上全部粘贴发给 AI 即可)');
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
    pushLog('info', '诊断已复制到剪贴板,直接粘贴发给助手即可');
  }

  function doRender() {
    const okNode = state.nodeOk === true;
    const bText = `织台 ${okNode ? '●' : '○'} 入库 ${state.submitted}${state.failed ? ' / 失败 ' + state.failed : ''}`;
    if (bText !== lastBadgeText) { badge.textContent = bText; lastBadgeText = bText; }
    badge.style.background = okNode ? (state.degraded ? '#ba7517' : '#1d9e75') : '#e24b4a';

    if (!expanded) { panel.style.display = 'none'; return; }
    panel.style.display = 'block';

    const rows = [];
    rows.push('<div style="font-weight:500;margin-bottom:8px">织台 · 入库桥自检 v1.4.0</div>');
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

    rows.push('<button class="copybtn">📋 一键复制诊断(发给助手)</button>');
    rows.push('<button class="copybtn" id="resetbtn" style="background:#ba7517;margin-top:6px">🔄 重置已读记录(允许重新入库)</button>');

    if (state.hookRaw.length) {
      rows.push('<div class="h">webwxsync 原始消息(提取失败/在库,诊断用)</div>');
      rows.push('<div class="dim" style="font-size:10px;word-break:break-all">' + state.hookRaw.map((r) =>
        `<div style="margin-top:4px">[${r.t}] MsgType=${r.MsgType} AppMsgType=${r.AppMsgType}<br>${esc(r.fields)}</div>`,
      ).join('') + '</div>');
    }

    if (state.sphSample) {
      rows.push('<div class="h">卡片 HTML 片段(诊断用)</div>');
      rows.push('<div class="dim" style="font-size:10px;word-break:break-all">' + esc(state.sphSample) + '</div>');
    }

    if (state.otherLinks.length) {
      rows.push('<div class="h">页面上其它链接(不在白名单)</div>');
      rows.push('<div class="dim">' + state.otherLinks.map((u) => '· ' + esc(u.slice(0, 70))).join('<br>') + '</div>');
    }

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
        pushLog('info', '已重置去重记录,页面现有链接会被重新入库');
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
    pushLog('info', '已重置去重记录,页面现有链接会被重新入库');
    scheduleScan(null);
  });
  GM_registerMenuCommand('织台·立即扫描并入库当前页面', () => {
    primed = true;
    fullScanQueued = true;
    pushLog('info', '手动触发全量扫描');
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
