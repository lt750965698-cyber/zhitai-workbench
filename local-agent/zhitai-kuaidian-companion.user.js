// ==UserScript==
// @name         织台·快点伴生桥（V1 控制台）
// @namespace    zhitai.local/kuaidian-companion
// @version      0.2.8
// @description  织台知识库·快点伴生桥（V1 控制台）：每 5s 心跳（仅 version/pageKind/原版快点检测/
//               待报数/有限结果码，绝不带 cookie、标题、正文或下载 URL）；只读观察原版快点的 okd
//               解析结果，增量去重上报 {downloadUrl, sourceUrl?, deliveryId?} 到本地节点 /api/v1/kuaidian；
//               上报 202 后轮询 item 终态，仅 success/duplicate/linked 写入 reported，失败/部分/孤立/
//               超时/陈旧 processing 保持可重试（needs attention）；重供命令轮询：按 deliveryId 找回
//               okd 消息重提交、轮询同 item 终态并 ack，浏览器离线或消息已消失时报中文不可恢复原因。
//               okd[].m 是微信 MsgId（本机投递 ID），只作为 deliveryId 上报，绝不冒充平台 contentId。
//               主下载仍由【原版快点脚本】完成；本脚本只负责上报与重供，不 patch alert、不复制原版快点代码。
// @match        https://filehelper.weixin.qq.com/*
// @match        https://szfilehelper.weixin.qq.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  var API_BASE = "http://127.0.0.1:17890";
  var REPORTED_KEY = "zhitai_kuaidian_reported";
  var CARD_REPORTED_KEY = "zhitai_kuaidian_card_reported";
  var CARD_SEEDED_KEY = "zhitai_kuaidian_card_seeded";
  var POLL_MS = 3000;
  var HEARTBEAT_MS = 5000;
  var STATUS_POLL_MS = 2000;
  var STATUS_POLL_MAX = 45; // 45×2s≈90s 未达终态 → needs attention（可重试）
  var COMMAND_POLL_MS = 8000;
  var VERSION = "0.2.8";

  /** 网页脚本在线不等于微信已登录。只根据聊天发送区判断登录态，
   *  不根据 cookie 或历史下载记录猜测，避免登录二维码页面被误报为可入库。 */
  function detectWechatLoggedIn() {
    try {
      if (typeof window.__zhitaiWechatLoggedIn === "function") {
        return Boolean(window.__zhitaiWechatLoggedIn());
      }
      return Boolean(document.querySelector(".chat-send__button"));
    } catch (e) {
      return false;
    }
  }

  /** FNV-1a 双 32 位指纹：仅作本机去重，GM storage 不保留 MsgId/objectId 原值。 */
  function fingerprint(value) {
    var text = String(value == null ? "" : value);
    var h1 = 0x811c9dc5;
    var h2 = 0x9e3779b9;
    for (var i = 0; i < text.length; i++) {
      var code = text.charCodeAt(i);
      h1 = Math.imul(h1 ^ code, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ code, 0x85ebca6b) >>> 0;
    }
    return "v2:" + h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
  }

  function normalizeFingerprints(key) {
    var value = GM_getValue(key, []);
    var rows = Array.isArray(value) ? value : [];
    var normalized = [];
    for (var i = 0; i < rows.length; i++) {
      var current = String(rows[i] == null ? "" : rows[i]);
      var safe = /^v2:[0-9a-f]{16}$/.test(current) ? current : fingerprint(current);
      if (normalized.indexOf(safe) === -1) normalized.push(safe);
    }
    normalized = normalized.slice(-2000);
    if (JSON.stringify(rows) !== JSON.stringify(normalized)) GM_setValue(key, normalized);
    return normalized;
  }

  function isRemembered(rows, value) {
    return rows.indexOf(value) !== -1 || rows.indexOf(fingerprint(value)) !== -1;
  }

  function decodeSpdXml(value) {
    var text = String(value || "");
    try { text = decodeURIComponent(text); } catch (e) { /* 保持原文 */ }
    return text
      .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&")
      .replace(/<br\s*\/>/gi, "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
  }

  function readXmlValues(xml, tag) {
    if (!/^[A-Za-z][A-Za-z0-9:_-]*$/.test(String(tag || ""))) return [];
    var out = [];
    try {
      var doc = new DOMParser().parseFromString(String(xml || ""), "text/xml");
      var parseErrors = doc.getElementsByTagName("parsererror");
      var nodes = doc.getElementsByTagName(tag);
      if (!parseErrors.length && nodes.length) {
        for (var i = 0; i < nodes.length; i++) {
          var parsedValue = String(nodes[i].textContent || "").trim();
          if (parsedValue) out.push(parsedValue);
        }
        return out;
      }
    } catch (e) { /* 回退到不执行标记的字符扫描器 */ }

    var source = String(xml || "");
    var lower = source.toLowerCase();
    var openPrefix = "<" + String(tag).toLowerCase();
    var closeTag = "</" + String(tag).toLowerCase() + ">";
    var cursor = 0;
    while (cursor < source.length) {
      var openAt = lower.indexOf(openPrefix, cursor);
      if (openAt === -1) break;
      var afterName = lower.charAt(openAt + openPrefix.length);
      if (afterName !== ">" && !/\s/.test(afterName)) {
        cursor = openAt + openPrefix.length;
        continue;
      }
      var contentAt = lower.indexOf(">", openAt + openPrefix.length);
      if (contentAt === -1) break;
      var closeAt = lower.indexOf(closeTag, contentAt + 1);
      if (closeAt === -1) break;
      var rawValue = source.slice(contentAt + 1, closeAt);
      var plainValue = "";
      var insideTag = false;
      for (var j = 0; j < rawValue.length; j++) {
        var character = rawValue.charAt(j);
        if (character === "<") { insideTag = true; continue; }
        if (insideTag && character === ">") { insideTag = false; continue; }
        if (!insideTag) plainValue += character;
      }
      plainValue = plainValue.trim();
      if (plainValue) out.push(plainValue);
      cursor = closeAt + closeTag.length;
    }
    return out;
  }

  /** 从原版快点 spD 的消息 XML 直接取视频号卡片身份。
   *  这是网页端已显示“已转发”、但 webwxsync hook 没拿到卡片时的主通道。 */
  function extractCardFromSpdItem(item) {
    if (!item) return null;
    var xml = decodeSpdXml(item.C || item.Content || "");
    if (xml.indexOf("objectId") === -1) return null;
    var objectId = (readXmlValues(xml, "objectId")[0] || "").trim();
    var nonceId = (readXmlValues(xml, "objectNonceId")[0] || "").trim();
    if (!/^[0-9]{6,32}$/.test(objectId) || !/^[A-Za-z0-9_-]{1,240}$/.test(nonceId)) return null;
    var deliveryId = item.m == null ? null : String(item.m);
    return {
      objectId: objectId,
      nonceId: nonceId,
      title: "视频号内容",
      deliveryId: deliveryId,
      key: deliveryId ? "msg:" + deliveryId : "object:" + objectId,
    };
  }

  function collectCardCandidates(spdRaw) {
    var spd;
    try { spd = JSON.parse(spdRaw || "[]"); } catch (e) { return []; }
    if (!Array.isArray(spd)) return [];
    var out = [];
    for (var i = 0; i < spd.length; i++) {
      var card = extractCardFromSpdItem(spd[i]);
      if (card) out.push(card);
    }
    return out;
  }

  /** 稳定分享 host 白名单（spD.u 回退用）：微信 sph/s/sf、视频号 mobile/sf、抖音短链、小红书短链 */
  function canonicalStableShareUrl(value) {
    if (typeof value !== "string") return null;
    var url;
    try { url = new URL(value); } catch (e) { return null; }
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password || url.port) return null;
    var material = String(url.pathname || "") + String(url.hash || "");
    for (var decodeIndex = 0; decodeIndex < 2; decodeIndex++) {
      try {
        var decoded = decodeURIComponent(material);
        if (decoded === material) break;
        material = decoded;
      } catch (e) { break; }
    }
    if (/(?:^|[\s?&;,/])(?:bearer(?:\s+|[A-Za-z0-9._~+/-])|(?:access[_-]?token|auth(?:orization)?|cookie|credential|password|pass[_-]?ticket|secret|session(?:_?id)?|signature|sig|token|uskey|x-uskey)\s*[=:])/i.test(material)
      || /(?:\+?86[ -]?)?1[3-9]\d{9}/.test(material)
      || /(?:^|\/)(?:Users|home|private|var|tmp|opt|srv)(?:\/|$)/i.test(material)
      || /<(?:html|body|script|style|div|span|p|a|img|video|article|section)\b/i.test(material)) return null;
    for (var entry of url.searchParams.entries()) {
      var name = String(entry[0] || "").toLowerCase();
      var queryValue = String(entry[1] || "");
      for (var queryDecodeIndex = 0; queryDecodeIndex < 2; queryDecodeIndex++) {
        try {
          var decodedQuery = decodeURIComponent(queryValue);
          if (decodedQuery === queryValue) break;
          queryValue = decodedQuery;
        } catch (e) { break; }
      }
      if (/(?:token|secret|signature|credential|session|password|auth|cookie|key)/i.test(name)
        || /(?:token|secret|signature|credential|session|password|auth|cookie)\s*[=:]/i.test(queryValue)
        || /(?:\+?86[ -]?)?1[3-9]\d{9}/.test(queryValue)
        || /(?:file:\/\/\/|\/(?:Users|home|private|var|tmp|opt|srv)\/|[A-Za-z]:\\(?:Users|Documents|Desktop)\\)/i.test(queryValue)
        || /<(?:html|body|script|style|div|span|p|a|img|video|article|section)\b/i.test(queryValue)) return null;
    }
    var host = url.hostname.toLowerCase();
    var pathname = url.pathname;
    var supported = (host === "weixin.qq.com" && /^\/(?:sph|s|sf)\/[A-Za-z0-9_-]+\/?$/i.test(pathname))
      || (host === "channels.weixin.qq.com" && /^\/mobile\/sf\/[A-Za-z0-9_-]+\/?$/i.test(pathname))
      || (host === "v.douyin.com" && /^\/[A-Za-z0-9_-]+\/?$/i.test(pathname))
      || (host === "xhslink.com" && /^\/[A-Za-z0-9_-]+\/?$/i.test(pathname));
    if (!supported) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  }

  function isStableShareHost(u) {
    return canonicalStableShareUrl(u) !== null;
  }

  /** 安全 atob 解码 spD.u 作为稳定源 URL 回退：u 可能是 ba() 的 base64 结果，或已是分享 URL。
   *  仅接受白名单分享 host；解码失败/非白名单 → null。 */
  function resolveSpdU(spdItem) {
    if (!spdItem) return null;
    var raw = spdItem.u;
    if (typeof raw !== "string" || !raw) return null;
    if (/^https?:\/\//i.test(raw)) return canonicalStableShareUrl(raw);
    var decoded = null;
    try { decoded = atob(String(raw)); } catch (e) { return null; }
    if (typeof decoded !== "string" || !/^https?:\/\//i.test(decoded)) return null;
    var m = decoded.match(/https?:\/\/[^\s"'<>]+/);
    return m ? canonicalStableShareUrl(m[0]) : null;
  }

  /** 从 spD 原始消息 XML（C 字段）提取真实分享链接（sph/sf 等稳定 URL） */
  function extractSourceUrl(c) {
    if (!c) return null;
    var parser = new DOMParser();
    var doc;
    try { doc = parser.parseFromString(c, "text/xml"); } catch (e) { return null; }
    var urls = doc.getElementsByTagName("url");
    for (var i = 0; i < urls.length; i++) {
      var u = String(urls[i].textContent || "").trim();
      var safeUrl = canonicalStableShareUrl(u);
      if (safeUrl) return safeUrl;
    }
    return null;
  }

  /** 解析 okd 增量：返回待上报数组 [{ downloadUrl, sourceUrl, deliveryId, msgId }]。
   *  sourceUrl 优先取消息 XML C 的稳定 url，其次安全 atob(spD.u) 回退；两者都取不到 → null。 */
  function collectReports(okdRaw, spdRaw, reported) {
    var out = [];
    var okd = null;
    var spd = null;
    try { okd = JSON.parse(okdRaw || "[]"); } catch (e) { return out; }
    try { spd = JSON.parse(spdRaw || "[]"); } catch (e) { spd = []; }
    if (!Array.isArray(okd)) return out;
    var spdByMsg = {};
    var claimedMsg = {};
    for (var r = 0; r < reported.length; r++) claimedMsg[reported[r]] = true;
    for (var i = 0; i < spd.length; i++) {
      if (spd[i] && spd[i].m) spdByMsg[spd[i].m] = spd[i];
    }
    for (var j = 0; j < okd.length; j++) {
      var item = okd[j];
      if (!item || !item.u) continue;
      var msgId = item.m || null;
      // 原版快点 1.3.0 在当前链路中曾把 a.m 误写成 a.MsgId，导致 okd 项缺 m。
      // 按原始转发顺序和标题补回对应 MsgId，既可接住旧记录，也不会修改 localStorage。
      if (!msgId) {
        for (var k = 0; k < spd.length; k++) {
          var candidate = spd[k];
          if (!candidate || !candidate.m || claimedMsg[candidate.m]) continue;
          if (candidate.d === item.d) { msgId = candidate.m; break; }
        }
      }
      if (!msgId) continue;
      claimedMsg[msgId] = true;
      if (reported.indexOf(msgId) !== -1) continue;
      var spdItem = spdByMsg[msgId];
      var sourceUrl = extractSourceUrl(spdItem ? spdItem.C : null) || resolveSpdU(spdItem) || null;
      out.push({
        downloadUrl: item.u,
        sourceUrl: sourceUrl, // 取不到真实分享 URL → null（元数据 unavailable，绝不用下载直链冒充）
        deliveryId: msgId, // 微信 MsgId/投递 ID，不是平台 contentId
        msgId: msgId,
      });
    }
    return out;
  }

  /** 终态集合：只有这些状态才停止轮询 */
  function isTerminalStatus(s) {
    return ["success", "duplicate", "linked", "completed", "failed", "partial", "orphaned", "needs_attention", "cancelled"].indexOf(s) !== -1;
  }
  /** 只有成功系才可写 REPORTED_KEY */
  function isReportedSuccess(s) {
    return ["success", "duplicate", "linked", "completed"].indexOf(s) !== -1;
  }

  /** 有界轮询到终态：fetchStatus(cb) 每次返回 {status, itemId} 或 null（网络错）；
   *  超时返回 {terminal:false, timedOut:true}。scheduler 可注入（测试传可控调度，默认全局 setTimeout）。 */
  function pollUntilTerminal(fetchStatus, opts) {
    opts = opts || {};
    var maxTries = opts.maxTries || STATUS_POLL_MAX;
    var delay = opts.delay || STATUS_POLL_MS;
    var schedule = opts.scheduler || function (fn, ms) { return setTimeout(fn, ms); };
    var tries = 0;
    function step(onDone) {
      if (tries >= maxTries) { onDone({ terminal: false, timedOut: true, status: null }); return; }
      tries++;
      fetchStatus(function (statusRow) {
        if (!statusRow) { schedule(function () { step(onDone); }, delay); return; }
        if (isTerminalStatus(statusRow.status)) {
          onDone({ terminal: true, status: statusRow.status, itemId: statusRow.itemId });
        } else {
          schedule(function () { step(onDone); }, delay);
        }
      });
    }
    return { run: step };
  }

  /** 在途报告（防重复 in-flight）：key 为 msgId 或 cmd:id */
  var inFlight = {};

  function getCardReported() {
    return normalizeFingerprints(CARD_REPORTED_KEY);
  }

  function rememberCardReported(key) {
    var done = getCardReported();
    var safe = fingerprint(key);
    if (done.indexOf(safe) === -1) done.push(safe);
    GM_setValue(CARD_REPORTED_KEY, done.slice(-2000));
  }

  function fetchTaskStatus(taskId, cb) {
    GM_xmlhttpRequest({
      method: "GET",
      url: API_BASE + "/api/v1/tasks",
      timeout: 10000,
      onload: function (res) {
        var body = null;
        try { body = JSON.parse(res.responseText || "{}"); } catch (e) { /* ignore */ }
        var tasks = body && Array.isArray(body.tasks) ? body.tasks : [];
        var task = null;
        for (var i = 0; i < tasks.length; i++) {
          if (tasks[i] && tasks[i].id === taskId) { task = tasks[i]; break; }
        }
        cb(task ? { status: task.status, itemId: task.id } : null);
      },
      onerror: function () { cb(null); },
      ontimeout: function () { cb(null); },
    });
  }

  function submitCardCandidate(card) {
    var flightKey = "card:" + card.key;
    if (inFlight[flightKey]) return;
    inFlight[flightKey] = true;
    GM_xmlhttpRequest({
      method: "POST",
      url: API_BASE + "/api/v1/channels/card",
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({
        objectId: card.objectId,
        nonceId: card.nonceId,
        title: "视频号内容",
        deliveryId: card.deliveryId,
        source: "filehelper_spd",
      }),
      timeout: 15000,
      onload: function (res) {
        delete inFlight[flightKey];
        if (res.status === 202) {
          var body = null;
          try { body = JSON.parse(res.responseText || "{}"); } catch (e) { /* ignore */ }
          var taskId = body && body.task && body.task.id;
          if (!taskId) {
            lastResultCode = "needs_attention";
            return;
          }
          lastResultCode = "card_accepted";
          pollUntilTerminal(function (cb) { fetchTaskStatus(taskId, cb); }, {}).run(function (result) {
            if (result.terminal && isReportedSuccess(result.status)) {
              rememberCardReported(card.key);
              lastResultCode = "reported_success";
            } else {
              lastResultCode = "needs_attention";
            }
          });
        } else {
          lastResultCode = "card_rejected";
        }
      },
      onerror: function () {
        delete inFlight[flightKey];
        lastResultCode = "card_unreachable";
      },
      ontimeout: function () {
        delete inFlight[flightKey];
        lastResultCode = "card_timeout";
      },
    });
  }

  function pollCards() {
    try {
      var cards = collectCardCandidates(localStorage.getItem("spD") || "[]");
      if (!cards.length) return;
      var reported = getCardReported();

      // 首次升级时只补处理最新一张卡片：历史记录标记为已见，
      // 避免安装新版后突然下载几十条旧视频。之后新增的卡片逐条处理。
      if (!GM_getValue(CARD_SEEDED_KEY, false)) {
        for (var i = 0; i < cards.length - 1; i++) {
          var safe = fingerprint(cards[i].key);
          if (reported.indexOf(safe) === -1) reported.push(safe);
        }
        GM_setValue(CARD_REPORTED_KEY, reported.slice(-2000));
        GM_setValue(CARD_SEEDED_KEY, true);
      }

      reported = getCardReported();
      for (var j = 0; j < cards.length; j++) {
        if (isRemembered(reported, cards[j].key)) continue;
        submitCardCandidate(cards[j]);
      }
    } catch (e) { /* localStorage/GM 不可用时不阻塞原页 */ }
  }

  function fetchItemStatus(itemId, cb) {
    GM_xmlhttpRequest({
      method: "GET",
      url: API_BASE + "/api/v1/kb/imports/" + itemId + "/status",
      timeout: 10000,
      onload: function (res) {
        var b = null;
        try { b = JSON.parse(res.responseText || "{}"); } catch (e) { /* ignore */ }
        cb(b);
      },
      onerror: function () { cb(null); },
      ontimeout: function () { cb(null); },
    });
  }

  /** 上报单条：202 → 解析 itemId → 轮询终态 → 仅成功系写 reported；失败/超时保持可重试 */
  function reportOne(report, onDone) {
    var payload = {
      downloadUrl: report.downloadUrl,
      sourceUrl: report.sourceUrl,
      deliveryId: report.deliveryId,
    };
    GM_xmlhttpRequest({
      method: "POST",
      url: API_BASE + "/api/v1/kuaidian",
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify(payload),
      timeout: 15000,
      onload: function (res) {
        if (res.status !== 202) { onDone({ accepted: false }); return; }
        var body = null;
        try { body = JSON.parse(res.responseText || "{}"); } catch (e) { /* ignore */ }
        var itemId = body && body.itemId;
        if (!itemId) { onDone({ accepted: true, reported: false, needsAttention: true }); return; }
        var poll = pollUntilTerminal(function (cb) { fetchItemStatus(itemId, cb); }, {});
        poll.run(function (result) {
          delete inFlight[report.msgId];
          if (result.terminal && isReportedSuccess(result.status)) {
            onDone({ accepted: true, reported: true, status: result.status });
          } else {
            // failed/partial/orphaned/超时/陈旧 processing：不写 reported，保持可重试（needs attention）
            onDone({ accepted: true, reported: false, status: result.status || null, needsAttention: true });
          }
        });
      },
      onerror: function () { onDone({ accepted: false }); },
      ontimeout: function () { onDone({ accepted: false }); },
    });
  }

  function poll() {
    try {
      var okdRaw = localStorage.getItem("okd");
      if (!okdRaw) return;
      var spdRaw = localStorage.getItem("spD");
      var reported = normalizeFingerprints(REPORTED_KEY);
      var reports = collectReports(okdRaw, spdRaw, reported);
      if (!reports.length) return;
      reports.forEach(function (r) {
        if (inFlight[r.msgId]) return; // 防重复 in-flight
        inFlight[r.msgId] = true;
        reportOne(r, function (result) {
          delete inFlight[r.msgId];
          lastResultCode = result && result.reported
            ? "reported_success"
            : (result && result.needsAttention ? "needs_attention" : "report_failed");
          if (result && result.reported) {
            var done = normalizeFingerprints(REPORTED_KEY);
            var safe = fingerprint(r.msgId);
            if (done.indexOf(safe) === -1) done.push(safe);
            GM_setValue(REPORTED_KEY, done.slice(-2000));
          }
          // 失败/超时：不写 reported → 下次轮询仍可重试（needs attention）
        });
      });
    } catch (e) {
      /* localStorage/GM 不可用时不阻塞页面 */
    }
  }

  /** 原版快点检测：基于实际 okd/spD 数据存在（诚实，绝不凭安装标签判在线） */
  function detectOriginalKuaidian() {
    try {
      var okd = JSON.parse(localStorage.getItem("okd") || "[]");
      if (Array.isArray(okd) && okd.length) return true;
      var spd = JSON.parse(localStorage.getItem("spD") || "[]");
      if (Array.isArray(spd) && spd.length) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  var lastResultCode = "idle";

  function getStorageSummary() {
    var forwarded = 0;
    var parsed = 0;
    try {
      var spd = JSON.parse(localStorage.getItem("spD") || "[]");
      if (Array.isArray(spd)) forwarded = spd.length;
    } catch (e) { /* ignore */ }
    try {
      var okd = JSON.parse(localStorage.getItem("okd") || "[]");
      if (Array.isArray(okd)) parsed = okd.length;
    } catch (e) { /* ignore */ }
    return "已转发" + forwarded + "｜直连解析" + parsed;
  }

  /** 心跳：每 5s 上报安全字段（版本/页面类型/原版快点检测/待报数/上次结果），绝不含 cookie/下载 URL */
  function heartbeat() {
    try {
      var reported = normalizeFingerprints(REPORTED_KEY);
      var pendingReportCount = 0;
      try {
        var reports = collectReports(
          localStorage.getItem("okd") || "[]",
          localStorage.getItem("spD") || "[]",
          reported
        );
        pendingReportCount = reports.filter(function (it) { return !inFlight[it.msgId]; }).length;
      } catch (e) { /* ignore */ }
      GM_xmlhttpRequest({
        method: "POST",
        url: API_BASE + "/api/v1/kuaidian/heartbeat",
        headers: { "Content-Type": "application/json" },
        data: JSON.stringify({
          version: VERSION,
          pageKind: "filehelper",
          wechatLoggedIn: detectWechatLoggedIn(),
          originalKuaidianDetected: detectOriginalKuaidian(),
          pendingReportCount: pendingReportCount,
          lastResultCode: lastResultCode,
          lastResult: lastResultCode,
        }),
        timeout: 8000,
        onload: function () {},
        onerror: function () {},
        ontimeout: function () {},
      });
    } catch (e) { /* ignore */ }
  }

  function ackCommand(id, outcome, reasonZh) {
    GM_xmlhttpRequest({
      method: "POST",
      url: API_BASE + "/api/v1/kuaidian/commands/" + encodeURIComponent(id) + "/ack",
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({ outcome: outcome, reasonZh: reasonZh || null }),
      timeout: 8000,
      onload: function () {},
      onerror: function () {},
      ontimeout: function () {},
    });
  }

  /** 重供：按 deliveryId 找回 okd 消息 → 用当前本地结果重提交 → 轮询同 item 终态 → ack。
   *  浏览器离线或 okd 已无该消息 → 中文不可恢复原因；绝不报重试成功。 */
  function handleCommand(cmd) {
    inFlight["cmd:" + cmd.id] = true;
    var okd = null;
    try { okd = JSON.parse(localStorage.getItem("okd") || "[]"); } catch (e) { okd = []; }
    var item = null;
    if (cmd.deliveryId && Array.isArray(okd)) {
      for (var i = 0; i < okd.length; i++) {
        if (okd[i] && okd[i].m === cmd.deliveryId) { item = okd[i]; break; }
      }
    }
    if (!item) {
      ackCommand(cmd.id, "not_found", "无法恢复：文件传输助手网页版已无该消息，请重新转发");
      delete inFlight["cmd:" + cmd.id];
      return;
    }
    var spd = null;
    try { spd = JSON.parse(localStorage.getItem("spD") || "[]"); } catch (e) { spd = []; }
    var spdItem = null;
    if (Array.isArray(spd)) {
      for (var k = 0; k < spd.length; k++) {
        if (spd[k] && spd[k].m === item.m) { spdItem = spd[k]; break; }
      }
    }
    var sourceUrl = extractSourceUrl(spdItem ? spdItem.C : null) || resolveSpdU(spdItem) || null;
    GM_xmlhttpRequest({
      method: "POST",
      url: API_BASE + "/api/v1/kuaidian",
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify({
        downloadUrl: item.u,
        sourceUrl: sourceUrl,
        deliveryId: item.m,
      }),
      timeout: 15000,
      onload: function (res) {
        if (res.status !== 202) {
          ackCommand(cmd.id, "failed", "重报被服务端拒绝");
          delete inFlight["cmd:" + cmd.id];
          return;
        }
        var body = null;
        try { body = JSON.parse(res.responseText || "{}"); } catch (e) { /* ignore */ }
        var itemId = body && body.itemId;
        if (!itemId) {
          ackCommand(cmd.id, "failed", "重报未获得 item");
          delete inFlight["cmd:" + cmd.id];
          return;
        }
        var poll = pollUntilTerminal(function (cb) { fetchItemStatus(itemId, cb); }, {});
        poll.run(function (result) {
          delete inFlight["cmd:" + cmd.id];
          if (result.terminal && isReportedSuccess(result.status)) {
            ackCommand(cmd.id, "success", null);
          } else {
            ackCommand(cmd.id, "failed", "重供后仍未成功（" + (result.status || "超时") + "）");
          }
        });
      },
      onerror: function () {
        ackCommand(cmd.id, "failed", "浏览器网络不可达，无法重供");
        delete inFlight["cmd:" + cmd.id];
      },
      ontimeout: function () {
        ackCommand(cmd.id, "failed", "重供超时");
        delete inFlight["cmd:" + cmd.id];
      },
    });
  }

  function pollCommands() {
    GM_xmlhttpRequest({
      method: "GET",
      url: API_BASE + "/api/v1/kuaidian/commands",
      timeout: 10000,
      onload: function (res) {
        try {
          var body = JSON.parse(res.responseText || "{}");
          var commands = Array.isArray(body.commands) ? body.commands : [];
          commands.forEach(function (cmd) {
            if (!cmd || !cmd.id) return;
            if (inFlight["cmd:" + cmd.id]) return;
            handleCommand(cmd);
          });
        } catch (e) { /* ignore */ }
      },
      onerror: function () {},
      ontimeout: function () {},
    });
  }

  // 立即 + 定时轮询
  setTimeout(pollCards, 800);
  setInterval(pollCards, POLL_MS);
  setTimeout(poll, 1500);
  setInterval(poll, POLL_MS);
  setTimeout(heartbeat, 1000);
  setInterval(heartbeat, HEARTBEAT_MS);
  setTimeout(pollCommands, 4000);
  setInterval(pollCommands, COMMAND_POLL_MS);

  // 测试注入点：暴露纯函数（非 GM 环境可验证）
  if (typeof window !== "undefined") {
    window.__zhitaiCompanion = {
      collectReports: collectReports,
      collectCardCandidates: collectCardCandidates,
      extractCardFromSpdItem: extractCardFromSpdItem,
      readXmlValues: readXmlValues,
      extractSourceUrl: extractSourceUrl,
      resolveSpdU: resolveSpdU,
      isStableShareHost: isStableShareHost,
      isTerminalStatus: isTerminalStatus,
      isReportedSuccess: isReportedSuccess,
      pollUntilTerminal: pollUntilTerminal,
      getStorageSummary: getStorageSummary,
      fingerprint: fingerprint,
      canonicalStableShareUrl: canonicalStableShareUrl,
      API_BASE: API_BASE,
      VERSION: VERSION,
    };
  }
})();
