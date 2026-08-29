import assert from "node:assert/strict";
import { win32 } from "node:path";
import test from "node:test";

import {
  childEnvironment,
  executableCandidates,
  isPathInside,
  openLocalPath,
  writableAppRoot,
} from "../local-agent/platform-utils.mjs";

test("Windows writable root uses LOCALAPPDATA and never Program Files", () => {
  const root = writableAppRoot({
    platform: "win32",
    env: { LOCALAPPDATA: "C:\\Users\\Test User\\AppData\\Local" },
    home: "C:\\Users\\Test User",
  });
  assert.equal(root, "C:\\Users\\Test User\\AppData\\Local\\Zhitai");
  assert.doesNotMatch(root, /Program Files/iu);
});

test("path containment rejects sibling prefixes, traversal and another drive", () => {
  const root = "C:\\Users\\Test User\\Zhitai Data";
  assert.equal(isPathInside(`${root}\\media\\clip.mp4`, root, win32), true);
  assert.equal(isPathInside(root, root, win32), true);
  assert.equal(isPathInside("C:\\Users\\Test User\\Zhitai Data-old\\clip.mp4", root, win32), false);
  assert.equal(isPathInside(`${root}\\..\\outside.mp4`, root, win32), false);
  assert.equal(isPathInside("D:\\media\\clip.mp4", root, win32), false);
  assert.equal(isPathInside("\\\\server\\share\\clip.mp4", root, win32), false);
});

test("Windows PATH resolution honors case-insensitive Path and PATHEXT", () => {
  const values = executableCandidates("ffmpeg", {
    platform: "win32",
    env: { Path: "C:\\Tools;D:\\Media Bin", PATHEXT: ".EXE;.CMD" },
    pathApi: win32,
  });
  assert.deepEqual(values, [
    "C:\\Tools\\ffmpeg.exe",
    "C:\\Tools\\ffmpeg.cmd",
    "D:\\Media Bin\\ffmpeg.exe",
    "D:\\Media Bin\\ffmpeg.cmd",
  ]);
});

test("safe child environment includes Windows runtime variables without arbitrary secrets", () => {
  const env = childEnvironment({ ZHITAI_DATA_DIR: "C:\\Data" }, {
    platform: "win32",
    source: {
      Path: "C:\\Windows\\System32",
      SystemRoot: "C:\\Windows",
      LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local",
      SECRET_TOKEN: "must-not-pass",
    },
  });
  assert.equal(env.PATH, "C:\\Windows\\System32");
  assert.equal(env.SYSTEMROOT, "C:\\Windows");
  assert.equal(env.LOCALAPPDATA, "C:\\Users\\Test\\AppData\\Local");
  assert.equal(env.ZHITAI_DATA_DIR, "C:\\Data");
  assert.equal(Object.hasOwn(env, "SECRET_TOKEN"), false);
});

test("openLocalPath uses explorer.exe directly without a shell", async () => {
  const calls = [];
  const opened = await openLocalPath("C:\\Users\\Test\\中文 空格", {
    platform: "win32",
    env: { SystemRoot: "C:\\Windows" },
    spawnImpl: (...args) => {
      calls.push(args);
      return { once() {}, unref() {} };
    },
  });
  assert.equal(opened, true);
  assert.deepEqual(calls[0], [
    "C:\\Windows\\explorer.exe",
    ["C:\\Users\\Test\\中文 空格"],
    { shell: false, detached: true, stdio: "ignore" },
  ]);
});
