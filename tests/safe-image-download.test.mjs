import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { downloadSafeImage } from "../local-agent/safe-image-download.mjs";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x00, 0xff, 0xd9]);
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([0x00, 0x00, 0x00, 0x0d]),
  Buffer.from("IHDR", "ascii"),
  Buffer.alloc(13),
]);

async function withTempDirectory(run) {
  const directory = await mkdtemp(join(tmpdir(), "zhitai-cover-test-"));
  try { return await run(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

const publicUrl = async (value) => new URL(value);

test("safe cover downloader revalidates redirects and writes a matching JPEG extension", async () => {
  await withTempDirectory(async (directory) => {
    const validated = [];
    const fetched = [];
    const result = await downloadSafeImage("https://origin.example/cover", directory, {
      validateUrl: async (value) => {
        validated.push(String(value));
        return new URL(value);
      },
      fetchImpl: async (value) => {
        fetched.push(String(value));
        if (fetched.length === 1) {
          return new Response(null, { status: 302, headers: { Location: "https://cdn.example/cover.jpg" } });
        }
        return new Response(JPEG, { status: 200, headers: { "Content-Type": "image/jpeg" } });
      },
    });

    assert.deepEqual(validated, ["https://origin.example/cover", "https://cdn.example/cover.jpg"]);
    assert.deepEqual(fetched, ["https://origin.example/cover", "https://cdn.example/cover.jpg"]);
    assert.equal(result.path, join(directory, "cover.jpg"));
    assert.equal(result.contentType, "image/jpeg");
    assert.deepEqual(await readFile(result.path), JPEG);
  });
});

test("safe cover downloader accepts PNG only when Content-Type and magic agree", async () => {
  await withTempDirectory(async (directory) => {
    const result = await downloadSafeImage("https://cdn.example/cover.png", directory, {
      validateUrl: publicUrl,
      fetchImpl: async () => new Response(PNG, {
        status: 200,
        headers: { "Content-Type": "image/png; charset=binary" },
      }),
    });
    assert.equal(result.path, join(directory, "cover.png"));
    assert.deepEqual(await readFile(result.path), PNG);

    await assert.rejects(downloadSafeImage("https://cdn.example/fake.png", directory, {
      baseName: "mismatch",
      validateUrl: publicUrl,
      fetchImpl: async () => new Response(JPEG, {
        status: 200,
        headers: { "Content-Type": "image/png" },
      }),
    }), /cover_content_type_mismatch/);
    assert.deepEqual((await readdir(directory)).sort(), ["cover.png"]);
  });
});

test("safe cover downloader rejects non-images and declared or streamed oversize bodies before writing", async () => {
  await withTempDirectory(async (directory) => {
    await assert.rejects(downloadSafeImage("https://cdn.example/cover", directory, {
      validateUrl: publicUrl,
      fetchImpl: async () => new Response("not an image", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    }), /cover_content_type_invalid/);

    await assert.rejects(downloadSafeImage("https://cdn.example/large.jpg", directory, {
      maxBytes: 8,
      validateUrl: publicUrl,
      fetchImpl: async () => new Response(Buffer.alloc(9), {
        status: 200,
        headers: { "Content-Type": "image/jpeg", "Content-Length": "9" },
      }),
    }), /cover_image_too_large/);

    await assert.rejects(downloadSafeImage("https://cdn.example/chunked-large.jpg", directory, {
      baseName: "chunked",
      maxBytes: 8,
      validateUrl: publicUrl,
      fetchImpl: async () => new Response(Buffer.concat([JPEG, Buffer.from([0x00])]), {
        status: 200,
        headers: { "Content-Type": "image/jpeg" },
      }),
    }), /cover_image_too_large/);
    assert.deepEqual(await readdir(directory), []);
  });
});

test("safe cover downloader blocks unsafe redirect targets and HTTPS downgrade", async () => {
  await withTempDirectory(async (directory) => {
    let privateFetches = 0;
    await assert.rejects(downloadSafeImage("https://127.0.0.1/cover.jpg", directory, {
      fetchImpl: async () => {
        privateFetches += 1;
        return new Response(JPEG, { status: 200, headers: { "Content-Type": "image/jpeg" } });
      },
    }), /ssrf_blocked_private_ip/);
    assert.equal(privateFetches, 0, "private literal must be rejected before fetch");

    let requests = 0;
    await assert.rejects(downloadSafeImage("https://origin.example/cover", directory, {
      validateUrl: async (value) => {
        if (String(value).includes("private.example")) throw new Error("ssrf_blocked_private_ip");
        return new URL(value);
      },
      fetchImpl: async () => {
        requests += 1;
        return new Response(null, { status: 302, headers: { Location: "https://private.example/cover" } });
      },
    }), /ssrf_blocked_private_ip/);
    assert.equal(requests, 1, "unsafe redirect target must be rejected before the next request");

    await assert.rejects(downloadSafeImage("https://origin.example/cover", directory, {
      validateUrl: publicUrl,
      fetchImpl: async () => new Response(null, {
        status: 302,
        headers: { Location: "http://cdn.example/cover.jpg" },
      }),
    }), /ssrf_protocol_downgrade/);
    assert.deepEqual(await readdir(directory), []);
  });
});
