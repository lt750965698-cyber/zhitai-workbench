import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getChannelsCardEngineStatus, originalChannelsVideoUrl, parseChannelsCard } from "../local-agent/channels-card.mjs";
import { downloadChannelsVideo } from "../local-agent/channels-yuanbao.mjs";

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  try {
    await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("卡片适配器使用 oid/nid 并归一化媒体字段", async () => {
  const requests = [];
  await withServer((req, res) => {
    requests.push(req.url);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/channels/status") {
      res.end(JSON.stringify({ code: 0, data: { available: true } }));
      return;
    }
    res.end(JSON.stringify({
      code: 0,
      data: {
        data: {
          object: {
            id: "1234567890123456789",
            contact: { nickname: "示例作者", headUrl: "https://example.test/avatar" },
            objectDesc: {
              description: "示例卡片",
              media: [{
                mediaType: 4,
                url: "https://finder.video.qq.com/251/20302/stodownload?encfilekey=masked&hy=SH&idx=1",
                urlToken: "&token=masked-token&basedata=masked-data&sign=masked-sign&svrnonce=123",
                decodeKey: "123456789",
                width: 1080,
                height: 1440,
                videoPlayLen: 41,
              }],
            },
            objectNonceId: "nonce_1",
          },
          commentCount: 12,
        },
      },
    }));
  }, async (baseUrl) => {
    const media = await parseChannelsCard({
      objectId: "1234567890123456789",
      nonceId: "nonce_1",
    }, { baseUrl });
    assert.equal(media.description, "示例卡片");
    assert.equal(media.author, "示例作者");
    assert.equal(media.decodeKey, "123456789");
    const parsedVideoUrl = new URL(media.videoUrl);
    assert.equal(parsedVideoUrl.searchParams.get("encfilekey"), "masked");
    assert.equal(parsedVideoUrl.searchParams.get("token"), "masked-token");
    assert.equal(parsedVideoUrl.searchParams.get("basedata"), "masked-data");
    assert.equal(parsedVideoUrl.searchParams.get("sign"), "masked-sign");
    assert.equal(parsedVideoUrl.searchParams.get("svrnonce"), "123");
    assert.deepEqual(media.fallbackVideoUrls.map((value) => [...new URL(value).searchParams.keys()].sort()), [["encfilekey", "token"]]);
    assert.equal(media.stats.comment, 12);
    assert.ok(requests.some((url) => url.includes("/api/channels/feed/profile?oid=1234567890123456789&nid=nonce_1")));
  });
});

test("profile 内层 -70003 映射为固定安全错误且不重试", async () => {
  let profileRequests = 0;
  await withServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/channels/status") {
      res.end(JSON.stringify({ code: 0, data: { available: true } }));
      return;
    }
    profileRequests += 1;
    res.end(JSON.stringify({
      code: 0,
      data: {
        errCode: -70003,
        errMsg: "JSAPI_JSONPARSE_FAILED https://finder.video.qq.com/file?token=secret",
      },
    }));
  }, async (baseUrl) => {
    await assert.rejects(
      parseChannelsCard(
        { objectId: "1234567890123456789", nonceId: "nonce_1" },
        { baseUrl, attempts: 4 },
      ),
      (error) => {
        assert.equal(error.message, "channels_card_profile_jsapi_jsonparse_failed");
        assert.doesNotMatch(error.message, /finder|token|secret/i);
        return true;
      },
    );
  });
  assert.equal(profileRequests, 1);
});

test("profile 其他内层错误只暴露数值码", async () => {
  await withServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/channels/status") {
      res.end(JSON.stringify({ code: 0, data: { available: true } }));
      return;
    }
    res.end(JSON.stringify({
      code: 0,
      data: {
        errCode: -71042,
        errMsg: "private token=do-not-leak",
      },
    }));
  }, async (baseUrl) => {
    await assert.rejects(
      parseChannelsCard(
        { objectId: "1234567890123456789", nonceId: "nonce_1" },
        { baseUrl },
      ),
      (error) => {
        assert.equal(error.message, "channels_card_profile_upstream_-71042");
        assert.doesNotMatch(error.message, /private|token|leak/i);
        return true;
      },
    );
  });
});

test("profile 内层成功但对象缺失才返回 object_missing", async () => {
  await withServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/channels/status") {
      res.end(JSON.stringify({ code: 0, data: { available: true } }));
      return;
    }
    res.end(JSON.stringify({ code: 0, data: { errCode: 0, data: {} } }));
  }, async (baseUrl) => {
    await assert.rejects(
      parseChannelsCard(
        { objectId: "1234567890123456789", nonceId: "nonce_1" },
        { baseUrl, attempts: 1 },
      ),
      (error) => {
        assert.equal(error.message, "channels_card_object_missing");
        return true;
      },
    );
  });
});

test("原始画质 URL 剔除转码档参数，只保留上游官方实现要求的两项", () => {
  const result = originalChannelsVideoUrl(
    "https://finder.video.qq.com/251/20302/stodownload?encfilekey=file-key&bizid=1023&dotrans=0&hy=SH&idx=1&token=media-token&X-snsvideoflag=xWT111",
  );
  const parsed = new URL(result);
  assert.equal(parsed.searchParams.get("encfilekey"), "file-key");
  assert.equal(parsed.searchParams.get("token"), "media-token");
  assert.deepEqual([...parsed.searchParams.keys()].sort(), ["encfilekey", "token"]);
});

test("完整签名地址失效时会自动尝试下一个媒体候选", async () => {
  const requests = [];
  const targetDir = await mkdtemp(join(tmpdir(), "zhitai-card-download-"));
  try {
    await withServer((req, res) => {
      requests.push(req.url);
      if (req.url === "/expired") {
        res.writeHead(400, { "Content-Type": "application/octet-stream" });
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": "12000" });
      res.end(Buffer.alloc(12000, 7));
    }, async (baseUrl) => {
      const saved = await downloadChannelsVideo({
        videoUrl: `${baseUrl}/expired`,
        fallbackVideoUrls: [`${baseUrl}/signed`],
        description: "候选地址测试",
      }, targetDir);
      assert.equal((await stat(saved.path)).size, 12000);
    });
    assert.deepEqual(requests, ["/expired", "/signed"]);
  } finally {
    await rm(targetDir, { recursive: true, force: true });
  }
});

test("微信视频号页面未连接时返回明确错误", async () => {
  await withServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ code: 0, data: { available: false } }));
  }, async (baseUrl) => {
    await assert.rejects(
      parseChannelsCard({ objectId: "1234567890123456789", nonceId: "nonce_1" }, { baseUrl }),
      /channels_card_wechat_page_not_connected/,
    );
  });
});

test("视频号引擎状态严格区分 HTTP 在线与页面可用", async () => {
  let available = false;
  await withServer((_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ code: 0, data: { available } }));
  }, async (baseUrl) => {
    assert.deepEqual(await getChannelsCardEngineStatus({ baseUrl }), { online: true, available: false });
    available = true;
    assert.deepEqual(await getChannelsCardEngineStatus({ baseUrl }), { online: true, available: true });
  });
});

test("状态端点启动中的 503 或非 JSON 响应统一标记为可恢复", async () => {
  let invalidJson = false;
  await withServer((_req, res) => {
    if (invalidJson) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("starting");
      return;
    }
    res.writeHead(503, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ code: 1, msg: "starting" }));
  }, async (baseUrl) => {
    await assert.rejects(
      getChannelsCardEngineStatus({ baseUrl }),
      /channels_card_engine_starting/,
    );
    invalidJson = true;
    await assert.rejects(
      getChannelsCardEngineStatus({ baseUrl }),
      /channels_card_engine_starting/,
    );
  });
});

test("文件助手桥包含卡片提取与专用上报端点", async () => {
  const source = await readFile(new URL("../local-agent/zhitai-filehelper-bridge.user.js", import.meta.url), "utf8");
  assert.match(source, /\/api\/v1\/channels\/card/);
  assert.match(source, /getElementsByTagName\('objectId'\)/);
  assert.match(source, /getElementsByTagName\('objectNonceId'\)/);
  assert.match(source, /trySubmitCard\(card\)/);
});

test("快点伴生桥可从 spD 已转发记录补提取卡片", async () => {
  const source = await readFile(new URL("../local-agent/zhitai-kuaidian-companion.user.js", import.meta.url), "utf8");
  const body = source.replace(/^\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/m, "");
  const windowObj = {};
  const store = {};
  const localStorage = { getItem: (key) => store[key] ?? null };
  const GM_getValue = (key, fallback) => store[key] ?? fallback;
  const GM_setValue = (key, value) => { store[key] = value; };
  class DOMParserStub {
    parseFromString() { return { getElementsByTagName: () => [] }; }
  }
  const run = new Function(
    "window", "localStorage", "GM_getValue", "GM_setValue", "GM_xmlhttpRequest", "DOMParser", "setTimeout", "setInterval",
    body,
  );
  run(windowObj, localStorage, GM_getValue, GM_setValue, () => {}, DOMParserStub, () => 0, () => 0);
  const xml = "&lt;msg&gt;&lt;finderFeed&gt;&lt;objectId&gt;14989479495539628554&lt;/objectId&gt;"
    + "&lt;objectNonceId&gt;nonce_direct_1&lt;/objectNonceId&gt;&lt;desc&gt;直转卡片&lt;/desc&gt;"
    + "&lt;/finderFeed&gt;&lt;/msg&gt;";
  const cards = windowObj.__zhitaiCompanion.collectCardCandidates(JSON.stringify([
    { m: "msg-direct-1", d: "最新视频", C: xml },
  ]));
  assert.equal(cards.length, 1);
  assert.equal(cards[0].objectId, "14989479495539628554");
  assert.equal(cards[0].nonceId, "nonce_direct_1");
  assert.equal(cards[0].deliveryId, "msg-direct-1");
  assert.equal(cards[0].title, "最新视频");
});
