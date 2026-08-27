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
      return { handled: true, text: result?.text || "织台已处理命令，请在消息中心查看记录。" };
    } catch (error) {
      const code = error instanceof Error ? error.message : "bridge_failed";
      if (code === "local_agent_unreachable") return { handled: true, text: "织台本地节点暂时离线，系统正在尝试自动恢复。" };
      return { handled: true, text: "命令执行失败，请打开织台“消息中心”查看状态。" };
    }
  };
}
