import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0);
  return buffer;
}

function box(type, ...parts) {
  if (!/^[\x20-\x7e]{4}$/.test(type)) throw new TypeError("MP4 box type must be four ASCII characters");
  const payload = Buffer.concat(parts);
  return Buffer.concat([uint32(payload.length + 8), Buffer.from(type, "ascii"), payload]);
}

function movieHeader({ durationMs, timescale }) {
  const duration = Math.round((durationMs / 1000) * timescale);
  if (!Number.isSafeInteger(duration) || duration <= 0 || duration > 0xffff_ffff) {
    throw new RangeError("durationMs must produce a positive 32-bit mvhd duration");
  }

  const payload = Buffer.alloc(100);
  // version/flags, creation time, and modification time remain deterministically zero.
  payload.writeUInt32BE(timescale, 12);
  payload.writeUInt32BE(duration, 16);
  payload.writeUInt32BE(0x0001_0000, 20); // rate = 1.0
  payload.writeUInt16BE(0x0100, 24); // volume = 1.0

  // Unity transformation matrix (16.16 values, with the final entry in 2.30 form).
  payload.writeUInt32BE(0x0001_0000, 36);
  payload.writeUInt32BE(0x0001_0000, 52);
  payload.writeUInt32BE(0x4000_0000, 68);
  payload.writeUInt32BE(1, 96); // next_track_ID
  return box("mvhd", payload);
}

function deterministicPayload(length, marker) {
  if (!Number.isSafeInteger(length) || length < 1 || length > 16 * 1024 * 1024) {
    throw new RangeError("payloadBytes must be between 1 and 16777216");
  }
  const markerBytes = Buffer.from(String(marker), "utf8");
  const output = Buffer.alloc(length);
  let state = 0x811c9dc5;
  for (const byte of markerBytes) {
    state ^= byte;
    state = Math.imul(state, 0x01000193) >>> 0;
  }
  for (let index = 0; index < output.length; index += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    output[index] = state >>> 24;
  }
  markerBytes.copy(output, 0, 0, Math.min(markerBytes.length, output.length));
  return output;
}

/**
 * Return a deterministic, account-free MP4 container fixture.
 *
 * It intentionally contains only the boxes needed by the local media validator:
 * ftyp + moov/mvhd + mdat. No copyrighted audio/video frames or user metadata are
 * embedded. Set mdatBeforeMoov to exercise non-fast-start top-level box ordering.
 */
export function syntheticMp4Buffer({
  durationMs = 1_000,
  timescale = 1_000,
  payloadBytes = 16_384,
  marker = "zhitai-synthetic-mp4-v1",
  mdatBeforeMoov = false,
} = {}) {
  if (!Number.isSafeInteger(timescale) || timescale <= 0 || timescale > 0xffff_ffff) {
    throw new RangeError("timescale must be a positive 32-bit integer");
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    throw new RangeError("durationMs must be positive");
  }

  const ftyp = box(
    "ftyp",
    Buffer.from("isom", "ascii"),
    uint32(0x0000_0200),
    Buffer.from("isomiso2mp41", "ascii"),
  );
  const moov = box("moov", movieHeader({ durationMs, timescale }));
  const mdat = box("mdat", deterministicPayload(payloadBytes, marker));
  return Buffer.concat(mdatBeforeMoov ? [ftyp, mdat, moov] : [ftyp, moov, mdat]);
}

export async function writeSyntheticMp4(filePath, options) {
  await mkdir(dirname(filePath), { recursive: true });
  const bytes = syntheticMp4Buffer(options);
  await writeFile(filePath, bytes);
  return bytes;
}
