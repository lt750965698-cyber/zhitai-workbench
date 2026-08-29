function firstText(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function eventChannel(event, context) {
  return firstText(context?.channelId, event?.channel, event?.OriginatingChannel, event?.Provider);
}

function eventSender(event, context) {
  const explicitSender = firstText(
    event?.From,
    event?.from,
    event?.from_user_id,
    event?.senderId,
    context?.senderId,
    context?.from,
  );
  if (explicitSender) return explicitSender;

  // OpenClaw's canonical before_dispatch hook derives conversationId from
  // OriginatingTo/To/From, but derives senderId only from MsgContext.SenderId.
  // openclaw-weixin currently populates the former fields and not SenderId, so
  // direct messages otherwise arrive here without a sender. Restrict this
  // compatibility fallback to an unambiguous Weixin direct-user address.
  const conversationId = firstText(context?.conversationId);
  return /^[A-Za-z0-9._-]{3,200}@im\.wechat$/i.test(conversationId) ? conversationId : "";
}

function eventAccount(event, context) {
  return firstText(event?.AccountId, event?.accountId, context?.accountId);
}

function eventText(event) {
  return firstText(event?.content, event?.body, event?.Body, event?.text, event?.message?.content, event?.message?.text);
}

function eventIsGroup(event, context) {
  return event?.isGroup === true || context?.isGroup === true || /group/i.test(firstText(event?.ChatType, event?.chatType, context?.chatType));
}

function canonicalPayload(value) {
  if (value?.event?.context && typeof value.event.context === "object") return value.event.context;
  if (value?.pluginContext?.context && typeof value.pluginContext.context === "object") return value.pluginContext.context;
  if (value?.context && typeof value.context === "object") return value.context;
  return value && typeof value === "object" ? value : {};
}

function outboundErrorCode(error) {
  const text = String(error || "");
  if (/ret\s*=\s*-2|prepare failed|context.{0,24}(expired|missing|invalid|stale)|session_refresh_required/i.test(text)) return "session_refresh_required";
  if (/token|context|credential|cookie|authorization|secret|session_unavailable/i.test(text)) return "session_unavailable";
  if (/\b429\b|rate.?limit|频率|限流/i.test(text)) return "rate_limited";
  if (/timeout|timed out|AbortError|ETIMEDOUT/i.test(text)) return "timeout";
  if (/ENOTFOUND|ECONNREFUSED|network|fetch failed/i.test(text)) return "network_unavailable";
  if (/HTTP\s+4\d\d/i.test(text)) return "client_error";
  return "delivery_failed";
}

export function sanitizedMessageSentResult(event) {
  const payload = canonicalPayload(event);
  const success = payload?.success === true;
  return {
    success,
    errorCode: success ? null : outboundErrorCode(payload?.error),
  };
}

export function createMessageSentHandler({ report }) {
  if (typeof report !== "function") throw new TypeError("clawbot_outbound_reporter_required");
  return async (event, context) => {
    const eventPayload = canonicalPayload(event);
    const contextPayload = canonicalPayload(context);
    const channel = firstText(
      contextPayload?.channelId,
      eventPayload?.channel,
      eventPayload?.metadata?.channel,
    );
    if (channel !== "openclaw-weixin") return undefined;
    // Intentionally pass exactly two low-cardinality fields. In particular,
    // never forward event.to, event.content, context ids or credential data to
    // the loopback status endpoint.
    await report(sanitizedMessageSentResult(event));
    return undefined;
  };
}

export function createBeforeDispatchHandler({ execute }) {
  return async (event, context) => {
    if (eventChannel(event, context) !== "openclaw-weixin") return undefined;
    if (eventIsGroup(event, context)) return { handled: true, text: "织台遥控命令只接受私聊，不在群聊执行。" };
    const text = eventText(event);
    const senderId = eventSender(event, context);
    if (!senderId) return { handled: true, text: "无法确认微信发送者，命令未执行。" };
    try {
      const result = await execute({
        text,
        senderId,
        accountId: eventAccount(event, context),
        isGroup: false,
      });
      // 固定电脑微信保活只需要一次真实入站来刷新 context。不要再向电脑
      // 微信回发“已保活”，否则夜间可能触发系统提示音；handled=true 且无
      // text 是 OpenClaw 官方 before_dispatch 契约支持的静默处理方式。
      if (result?.automatedKeepalive === true) return { handled: true };
      return { handled: true, text: result?.text || "织台已处理命令，请在消息中心查看记录。" };
    } catch (error) {
      const code = error instanceof Error ? error.message : "bridge_failed";
      if (code === "local_agent_unreachable") return { handled: true, text: "织台本地节点暂时离线，系统正在尝试自动恢复。" };
      return { handled: true, text: "命令执行失败，请打开织台“消息中心”查看状态。" };
    }
  };
}
