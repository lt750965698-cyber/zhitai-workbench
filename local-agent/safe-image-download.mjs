import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertNoProtocolDowngrade, assertSafeUrl } from "./downloader-adapter.mjs";

const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_REDIRECTS = 5;
const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png"]);

function imageFormat(buffer) {
  if (buffer.length >= 4
    && buffer[0] === 0xff
    && buffer[1] === 0xd8
    && buffer[2] === 0xff) {
    return { contentType: "image/jpeg", extension: "jpg" };
  }
  if (buffer.length >= 16
    && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    && buffer.subarray(12, 16).toString("ascii") === "IHDR") {
    return { contentType: "image/png", extension: "png" };
  }
  throw new Error("cover_image_magic_invalid");
}

async function cancelResponseBody(response) {
  if (response?.body && typeof response.body.cancel === "function") {
    await response.body.cancel().catch(() => {});
  }
}

/**
 * Download a public HTTPS JPEG/PNG after validating every redirect target.
 * Bytes are bounded and validated in memory before anything is written to disk.
 */
export async function downloadSafeImage(url, directory, {
  baseName = "cover",
  maxBytes = DEFAULT_MAX_BYTES,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  fetchImpl = globalThis.fetch,
  validateUrl = assertSafeUrl,
} = {}) {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(baseName)) throw new Error("cover_image_name_invalid");
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_BYTES) {
    throw new Error("cover_image_limit_invalid");
  }
  if (typeof fetchImpl !== "function" || typeof validateUrl !== "function") {
    throw new Error("cover_image_downloader_invalid");
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  let current = String(url || "");
  let redirects = 0;

  try {
    for (;;) {
      const safe = await validateUrl(current);
      if (safe.protocol !== "https:") throw new Error("cover_image_https_required");
      response = await fetchImpl(safe.toString(), {
        headers: {
          Accept: "image/jpeg,image/png",
          Referer: "https://channels.weixin.qq.com/",
        },
        redirect: "manual",
        signal: controller.signal,
      });
      if (response.status < 300 || response.status >= 400) break;

      const location = response.headers.get("location");
      await cancelResponseBody(response);
      if (!location) throw new Error("cover_redirect_missing_location");
      redirects += 1;
      if (redirects > maxRedirects) throw new Error("cover_redirect_limit_exceeded");
      current = assertNoProtocolDowngrade(safe.toString(), location).toString();
    }

    if (!response.ok) throw new Error(`cover_download_http_${response.status}`);
    const declaredType = String(response.headers.get("content-type") || "")
      .split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (!ALLOWED_IMAGE_TYPES.has(declaredType)) throw new Error("cover_content_type_invalid");

    const contentLength = Number(response.headers.get("content-length") || 0);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      await cancelResponseBody(response);
      throw new Error("cover_image_too_large");
    }
    if (!response.body || typeof response.body.getReader !== "function") {
      throw new Error("cover_image_body_missing");
    }

    const chunks = [];
    let received = 0;
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        received += chunk.length;
        if (received > maxBytes) {
          await reader.cancel().catch(() => {});
          throw new Error("cover_image_too_large");
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }

    const bytes = Buffer.concat(chunks, received);
    const format = imageFormat(bytes);
    if (format.contentType !== declaredType) throw new Error("cover_content_type_mismatch");

    await mkdir(directory, { recursive: true });
    const outputPath = join(directory, `${baseName}.${format.extension}`);
    const temporaryPath = join(directory, `.${baseName}-${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryPath, bytes, { flag: "wx", mode: 0o600 });
      await rename(temporaryPath, outputPath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => {});
      throw error;
    }
    return { path: outputPath, contentType: format.contentType, sizeBytes: received };
  } finally {
    clearTimeout(timer);
  }
}
