import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  desktopDataRoot,
  desktopLogRoot,
  desktopProjectDir,
  desktopRuntimeRoot,
  virtualEnvironmentExecutable,
} = require("../desktop/platform.js");

test("Windows desktop state stays in LOCALAPPDATA", () => {
  const options = {
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\测试 用户\\AppData\\Local" },
    home: "C:\\Users\\测试 用户",
  };
  assert.equal(
    desktopRuntimeRoot(options),
    "C:\\Users\\测试 用户\\AppData\\Local\\Zhitai\\runtime",
  );
  assert.equal(
    desktopLogRoot(options),
    "C:\\Users\\测试 用户\\AppData\\Local\\Zhitai\\logs",
  );
});

test("packaged Windows app reads bundled runtime from app.getAppPath and writes data outside it", () => {
  const options = {
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\Test User\\AppData\\Local" },
    home: "C:\\Users\\Test User",
  };
  assert.equal(
    desktopProjectDir({
      ...options,
      isPackaged: true,
      appPath: "C:\\Program Files\\Zhitai\\resources\\app",
      moduleDir: "C:\\Program Files\\Zhitai\\resources\\app\\desktop",
    }),
    "C:\\Program Files\\Zhitai\\resources\\app",
  );
  assert.equal(
    desktopDataRoot(options),
    "C:\\Users\\Test User\\AppData\\Local\\Zhitai\\runtime\\data",
  );
});

test("packaged project directory requires Electron's resolved app path", () => {
  assert.throws(
    () => desktopProjectDir({ platform: "win32", env: {}, isPackaged: true }),
    /packaged_app_path_required/,
  );
});

test("Windows virtual environments use Scripts and exe suffixes", () => {
  assert.equal(
    virtualEnvironmentExecutable("D:\\织台 引擎", "python", "win32"),
    "D:\\织台 引擎\\.venv\\Scripts\\python.exe",
  );
});

test("explicit desktop runtime root wins", () => {
  assert.equal(
    desktopRuntimeRoot({
      platform: "win32",
      env: { ZHITAI_RUNTIME_ROOT: "E:\\Portable Data\\织台" },
      home: "C:\\Users\\tester",
    }),
    "E:\\Portable Data\\织台",
  );
});
