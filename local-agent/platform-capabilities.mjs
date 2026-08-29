export const WINDOWS_PREVIEW_ERROR = "unsupported_on_windows_preview";

export function platformCapabilities({ platform = process.platform, env = process.env } = {}) {
  const windowsPreview = platform === "win32" || env.ZHITAI_WINDOWS_PREVIEW === "1";
  return Object.freeze({
    platform,
    windowsPreview,
    localCore: true,
    browserStudios: true,
    browserAutomation: !windowsPreview,
    creativeAutomation: !windowsPreview,
    backgroundPublishing: !windowsPreview,
    credentialAutomation: !windowsPreview,
    externalServiceControl: !windowsPreview,
    moduleUpdates: !windowsPreview,
    nativePublishing: !windowsPreview,
    notificationAutomation: !windowsPreview,
    wechatAutomation: !windowsPreview,
  });
}

export function assertPlatformCapability(capabilities, capability) {
  if (capabilities?.[capability] === true) return;
  const error = new Error(WINDOWS_PREVIEW_ERROR);
  error.statusCode = 501;
  error.capability = String(capability || "unknown");
  throw error;
}

export function windowsPreviewStatus(capabilities) {
  return {
    supported: capabilities?.windowsPreview !== true,
    platform: capabilities?.platform || process.platform,
    mode: capabilities?.windowsPreview === true ? "windows_preview" : "native",
    reason: capabilities?.windowsPreview === true ? WINDOWS_PREVIEW_ERROR : null,
  };
}
