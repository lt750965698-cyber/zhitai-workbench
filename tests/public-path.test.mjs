import assert from "node:assert/strict";
import test from "node:test";

import { publicDisplayPath } from "../local-agent/public-path.mjs";

test("publicDisplayPath folds paths inside the home directory", () => {
  assert.equal(
    publicDisplayPath("/home/example/KnowledgeHub/内容库", { home: "/home/example" }),
    "~/KnowledgeHub/内容库",
  );
  assert.equal(publicDisplayPath("/home/example", { home: "/home/example" }), "~");
});

test("publicDisplayPath hides parent directories outside the home directory", () => {
  assert.equal(
    publicDisplayPath("/var/folders/private/runtime/knowledge-base", { home: "/home/example" }),
    "…/knowledge-base",
  );
});

test("publicDisplayPath leaves already-public and relative labels intact", () => {
  assert.equal(publicDisplayPath("~/KnowledgeHub/内容库", { home: "/home/example" }), "~/KnowledgeHub/内容库");
  assert.equal(publicDisplayPath("knowledge-base", { home: "/home/example" }), "knowledge-base");
});
