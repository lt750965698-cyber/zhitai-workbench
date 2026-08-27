// ==UserScript==
// @name         微信网页版弹窗屏蔽器(织台)
// @namespace    zhitai
// @version      1.0.0
// @description  在页面最早期(document-start)接管 alert/confirm,静默微信网页版对视频号卡片等不支持消息的固定弹窗("无法展示该内容…"乱码提示)。与原版快点工具等脚本共存,不影响任何正常提示。
// @match        *://filehelper.weixin.qq.com/*
// @match        *://login.wx.qq.com/*
// @match        *://weixin.qq.com/*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';
    // ── 静默判定:微信对"网页版不支持的消息"会 alert 一大段含 emoji/换行/控制字符的乱码文案 ──
    // 规则:文本明显是渲染失败的乱码(含控制字符/变体选择符/超长) 或 命中已知提示词 → 吞掉。
    // 正常短提示(<60字符且不含特征词)一律透传,不影响任何脚本自己的提示。
    function isJunk(s) {
        if (!s) return false;
        if (s.length > 60) return true;                 // 微信乱码弹窗通常很长
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(s)) return true; // 控制字符
        if (/(无法展示|不支持展示|升级至最新|当前版本不支持|视频号|短视频|暂时无法)/i.test(s)) return true;
        return false;
    }
    function patch(name) {
        try {
            var orig = window[name];
            if (!orig) return;
            var wrapped = function (msg) {
                if (isJunk(String(msg == null ? '' : msg))) {
                    try { console.log('[弹窗屏蔽] 已静默:', String(msg).slice(0, 50)); } catch (e) {}
                    return undefined;
                }
                return orig.apply(this, arguments);
            };
            try { Object.defineProperty(window, name, { configurable: true, get: function () { return wrapped; } }); }
            catch (e) { window[name] = wrapped; }
        } catch (e) { /* 极老浏览器,放弃该补丁 */ }
    }
    patch('alert');
    patch('confirm');
})();
