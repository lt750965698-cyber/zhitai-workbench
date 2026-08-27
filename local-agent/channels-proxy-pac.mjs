export const CHANNELS_PROXY_HOSTS = Object.freeze([
  "channels.weixin.qq.com",
  "mp.weixin.qq.com",
  "res.wx.qq.com",
  "kf.qq.com",
  "weixin110.qq.com",
]);

// Keep this list exact: widening it to *.qq.com would send unrelated traffic
// through the local video-card interception proxy.
export const CHANNELS_PROXY_PAC = `function FindProxyForURL(url, host) {
  if (host === "channels.weixin.qq.com" ||
      host === "mp.weixin.qq.com" ||
      host === "res.wx.qq.com" ||
      host === "kf.qq.com" ||
      host === "weixin110.qq.com") {
    return "PROXY 127.0.0.1:2023; DIRECT";
  }
  return "DIRECT";
}
`;
