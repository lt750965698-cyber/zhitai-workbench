function text(value, fallback = "状态未返回") {
  return String(value || fallback).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 240);
}

function accountLoggedIn(account) {
  const state = `${account?.loginStatus || ""} ${account?.status || ""}`.toLowerCase();
  return /已登录|online|logged.?in|success|valid/.test(state) && !/未登录|offline|expired|invalid|failed/.test(state);
}

function platformAccount(accounts, aliases) {
  return (Array.isArray(accounts) ? accounts : []).find((account) => {
    const value = `${account?.platform || ""} ${account?.code || ""}`.toLowerCase();
    return aliases.some((alias) => value.includes(alias)) && accountLoggedIn(account);
  }) || null;
}

function condition(id, label, state, reason, checkedAt, actionView, optional = false, ingressRole = null) {
  return { id, label, state, reason: text(reason), checkedAt: checkedAt || null, actionView, optional, ingressRole };
}

export function normalizeCreativeConditionReport(input, checkedAt = new Date().toISOString(), date = null) {
  const source = input && typeof input === "object" ? input : {};
  const normalizeState = (value) => ["ready", "attention", "unknown"].includes(value) ? value : "unknown";
  const gpt = source.gpt && typeof source.gpt === "object" ? source.gpt : {};
  const doubao = (Array.isArray(source.doubao) ? source.doubao : []).slice(0, 8).map((row, index) => ({
    id: String(row?.id || `account-${index + 1}`).replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64),
    label: text(row?.label, `豆包账号 ${index + 1}`),
    state: normalizeState(row?.state),
    reason: text(row?.reason),
  }));
  return {
    checkedAt,
    date,
    gpt: { state: normalizeState(gpt.state), reason: text(gpt.reason) },
    doubao,
  };
}

export function buildRuntimeConditions({
  checkedAt,
  dateKey,
  services = [],
  remote = {},
  notifications = {},
  filehelper = {},
  creative = null,
  publisherAccounts = null,
  publisherError = null,
  xiaohongshu = {},
  wechatOfficial = {},
  backlog = {},
}) {
  const serviceRows = Array.isArray(services)
    ? services
    : services && typeof services === "object"
      ? Object.values(services)
      : [];
  const service = (id) => serviceRows.find((row) => String(row?.id || "").includes(id));
  const filehelperPageConnected = filehelper?.filehelperPageConnected === true;
  const filehelperLoggedIn = filehelper?.wechatLoggedIn === true;
  const filehelperReady = filehelperPageConnected && filehelperLoggedIn;
  const conditions = [condition(
    "filehelper",
    "微信文件传输助手主入口",
    filehelperReady ? "ready" : "attention",
    filehelperReady
      ? "文件传输助手网页与微信登录均在线，可接收手机转发"
      : filehelperPageConnected
        ? "文件传输助手网页在线，但微信未登录；请扫码恢复主入口"
        : "文件传输助手网页未连接；主入口需要打开并保持登录",
    filehelper?.checkedAt || checkedAt,
    "inbox",
    false,
    "primary",
  )];

  const clawbot = service("openclaw_weixin");
  const clawbotInboundReady = clawbot?.business?.ready === true && remote?.paired === true;
  const proactiveState = String(notifications?.clawbot?.deliveryState || "unverified");
  const proactiveReady = notifications?.clawbot?.operational === true && proactiveState === "ready";
  conditions.push(condition(
    "clawbot",
    "ClawBot 入站遥控与备用通知",
    clawbotInboundReady && proactiveReady ? "ready" : "optional",
    clawbotInboundReady
      ? proactiveReady
        ? "入站遥控已配对，主动文字通知最近一次实投已受理"
        : proactiveState === "session_refresh_required"
          ? "入站遥控已配对；主动通知会话需由用户发一条新消息刷新，期间自动回退手机推送"
          : "入站遥控已配对；主动通知尚未通过真实投递验证，以消息中心结果为准"
      : `${clawbot?.business?.reason || (remote?.paired === false ? "尚未绑定 ClawBot 控制微信" : "ClawBot 备用通道未就绪")}；不阻断文件传输助手主入口`,
    checkedAt,
    "messages",
    true,
    "fallback",
  ));

  const creativeFresh = Boolean(creative?.checkedAt && dateKey && creative?.date === dateKey);
  const gpt = creativeFresh ? creative?.gpt : null;
  conditions.push(condition(
    "gpt",
    "GPT 生图",
    gpt?.state || "unknown",
    creativeFresh ? gpt?.reason : "今天尚未检查 GPT 登录",
    creative?.checkedAt || null,
    "creative",
  ));

  const doubaoRows = creativeFresh && Array.isArray(creative?.doubao) ? creative.doubao : [];
  if (!doubaoRows.length) {
    conditions.push(condition("doubao", "豆包账号池", "unknown", "今天尚未检查豆包账号", creative?.checkedAt || null, "creative"));
  } else {
    const usable = doubaoRows.filter((row) => row.state === "ready").length;
    conditions.push(condition(
      "doubao",
      `豆包账号池（${usable}/${doubaoRows.length} 可用）`,
      usable ? "ready" : doubaoRows.some((row) => row.state === "unknown") ? "unknown" : "attention",
      usable ? `至少 ${usable} 个账号可生成；失效账号会单独跳过` : "没有可用的豆包账号",
      creative.checkedAt,
      "creative",
    ));
    for (const row of doubaoRows) {
      conditions.push(condition(`doubao:${row.id}`, row.label, row.state, row.reason, creative.checkedAt, "creative", true));
    }
  }

  const publisherKnown = Array.isArray(publisherAccounts);
  const douyin = platformAccount(publisherAccounts, ["dy", "抖音", "douyin"]);
  const channels = platformAccount(publisherAccounts, ["sph", "视频号", "channels"]);
  const xhsVideo = platformAccount(publisherAccounts, ["xhs", "小红书", "xiaohongshu"]);
  conditions.push(condition("douyin", "抖音草稿账号", douyin ? "ready" : publisherKnown ? "attention" : "unknown", douyin ? "账号登录有效" : publisherKnown ? "未发现已登录抖音账号" : publisherError || "账号状态尚未检查", checkedAt, "publish"));
  conditions.push(condition("wechat_channels", "视频号草稿账号", channels ? "ready" : publisherKnown ? "attention" : "unknown", channels ? "账号登录有效" : publisherKnown ? "未发现已登录视频号账号" : publisherError || "账号状态尚未检查", checkedAt, "publish"));
  const xhsReady = Boolean(xhsVideo || xiaohongshu?.loggedIn === true);
  const xhsKnown = publisherKnown || typeof xiaohongshu?.loggedIn === "boolean";
  conditions.push(condition("xiaohongshu", "小红书账号", xhsReady ? "ready" : xhsKnown ? "attention" : "unknown", xhsReady ? "账号登录有效" : xhsKnown ? xiaohongshu?.reason || "需扫码登录小红书" : "账号状态尚未检查", checkedAt, "publish"));
  conditions.push(condition(
    "wechat_official",
    "公众号草稿接口",
    wechatOfficial?.ready === true ? "ready" : wechatOfficial?.needsAttention === true || wechatOfficial?.configured !== true ? "attention" : "unknown",
    wechatOfficial?.reason || (wechatOfficial?.ready === true ? "接口凭证与草稿权限有效" : "公众号尚未配置"),
    checkedAt,
    "publish",
  ));

  const required = conditions.filter((row) => !row.optional);
  const readyCount = required.filter((row) => row.state === "ready").length;
  const attentionCount = required.filter((row) => row.state === "attention").length;
  const unknownCount = required.filter((row) => row.state === "unknown").length;
  return {
    ok: true,
    checkedAt,
    summary: {
      state: attentionCount ? "attention" : unknownCount ? "unknown" : "ready",
      readyCount,
      attentionCount,
      unknownCount,
    },
    conditions,
    backlog,
  };
}

export { accountLoggedIn };
