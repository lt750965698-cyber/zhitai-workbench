import assert from "node:assert/strict";
import test from "node:test";

import {
  assertPlatformCapability,
  platformCapabilities,
  WINDOWS_PREVIEW_ERROR,
  windowsPreviewStatus,
} from "../local-agent/platform-capabilities.mjs";

test("Windows preview keeps the local core and fails closed for native automation", () => {
  const capabilities = platformCapabilities({ platform: "win32", env: {} });
  assert.equal(capabilities.localCore, true);
  assert.equal(capabilities.browserStudios, true);
  for (const capability of [
    "browserAutomation",
    "creativeAutomation",
    "backgroundPublishing",
    "credentialAutomation",
    "externalServiceControl",
    "moduleUpdates",
    "nativePublishing",
    "notificationAutomation",
    "wechatAutomation",
  ]) {
    assert.equal(capabilities[capability], false, capability);
  }
});

test("the preview gate returns a stable HTTP-safe error", () => {
  const capabilities = platformCapabilities({ platform: "win32", env: {} });
  assert.throws(
    () => assertPlatformCapability(capabilities, "nativePublishing"),
    (error) => error?.message === WINDOWS_PREVIEW_ERROR
      && error?.statusCode === 501
      && error?.capability === "nativePublishing",
  );
  assert.deepEqual(windowsPreviewStatus(capabilities), {
    supported: false,
    platform: "win32",
    mode: "windows_preview",
    reason: WINDOWS_PREVIEW_ERROR,
  });
});

test("non-Windows behavior is unchanged unless preview mode is explicitly requested", () => {
  assert.equal(platformCapabilities({ platform: "darwin", env: {} }).nativePublishing, true);
  assert.equal(
    platformCapabilities({ platform: "linux", env: { ZHITAI_WINDOWS_PREVIEW: "1" } }).nativePublishing,
    false,
  );
});
