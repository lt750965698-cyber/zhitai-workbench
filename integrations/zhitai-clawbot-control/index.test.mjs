import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("ClawBot bridge derives local paths instead of embedding a developer home", async () => {
  const source = await readFile(new URL("./index.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\/Users\/[A-Za-z0-9._-]+\//);
  assert.match(source, /homedir\(\)/);
  assert.match(source, /ZHITAI_RUNTIME_ROOT/);
  assert.match(source, /ZHITAI_SUBMITTER_PATH/);
});
