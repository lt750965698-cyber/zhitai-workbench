import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getXBookmark, importXBookmarks, queryXBookmarks, xBookmarkStatus } from "../local-agent/x-bookmarks.mjs";

test("X 收藏幂等入库并生成每日清单", async () => {
  const root = await mkdtemp(join(tmpdir(), "zhitai-x-bookmarks-"));
  const db = new DatabaseSync(join(root, "kb.sqlite"));
  const input = {
    capturedAt: "2026-08-23T03:00:00.000Z",
    items: [{
      tweetId: "1234567890123456789",
      text: "一个值得每天复习的内容工作流 #效率",
      author: "织台测试",
      authorUsername: "zhitai_test",
      publishedAt: "2026-08-22T10:00:00.000Z",
      metrics: { views: 100, likes: 8, retweets: 2, replies: 1 },
    }],
  };
  try {
    const first = await importXBookmarks(db, input, { knowledgeBase: root });
    assert.equal(first.imported, 1);
    const second = await importXBookmarks(db, { ...input, capturedAt: "2026-08-24T03:00:00.000Z" }, { knowledgeBase: root });
    assert.equal(second.imported, 0);
    assert.equal(queryXBookmarks(db).length, 1);
    assert.equal(getXBookmark(db, "x_1234567890123456789").contentKind, "x_bookmark");
    assert.equal(xBookmarkStatus(db).total, 1);
    const digest = await readFile(join(root, "其他", "2026", "08", "23", "X 收藏", "2026-08-23-X收藏.md"), "utf8");
    assert.match(digest, /一个值得每天复习的内容工作流/);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

