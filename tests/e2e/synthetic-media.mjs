/**
 * Deterministic, tiny PCM/WAV fixtures for the offline E2E suite.
 *
 * These bytes are generated locally from a seed. They do not contain copied,
 * downloaded, recorded, or user-provided media.
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const SYNTHETIC_MEDIA_PROVENANCE = Object.freeze({
  origin: "deterministic_test_generator",
  generator: "tests/e2e/synthetic-media.mjs",
  license: "CC0-1.0",
  containsRealPeople: false,
  containsRealAccounts: false,
  containsRealChats: false,
  networkAccess: false,
  intendedUse: "offline_e2e_only",
});

const RIFF_HEADER_BYTES = 44;
const DEFAULT_SAMPLE_RATE = 8_000;
const DEFAULT_DURATION_MS = 320;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function seedToUint32(seed) {
  return createHash("sha256").update(String(seed)).digest().readUInt32LE(0);
}

function xorshift32(initial) {
  let state = initial || 0x6d2b79f5;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function wavHeader({ dataBytes, sampleRate, channels, bitsPerSample }) {
  const header = Buffer.alloc(RIFF_HEADER_BYTES);
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/**
 * Create deterministic non-silent PCM. The waveform is deliberately synthetic:
 * two simple tones plus seeded low-amplitude dither.
 */
export function createDeterministicMedia(options = {}) {
  const {
    seed = "zhitai-offline-e2e-v1",
    durationMs = DEFAULT_DURATION_MS,
    sampleRate = DEFAULT_SAMPLE_RATE,
    channels = 1,
    amplitude = 0.42,
    silent = false,
  } = options;
  if (!Number.isInteger(sampleRate) || sampleRate < 1_000 || sampleRate > 192_000) {
    throw new RangeError("sampleRate must be an integer between 1000 and 192000");
  }
  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 10_000) {
    throw new RangeError("durationMs must be greater than 0 and at most 10000");
  }
  if (!Number.isInteger(channels) || channels < 1 || channels > 2) {
    throw new RangeError("channels must be 1 or 2");
  }
  if (!Number.isFinite(amplitude) || amplitude < 0 || amplitude > 1) {
    throw new RangeError("amplitude must be between 0 and 1");
  }

  const sampleFrames = Math.max(1, Math.round(sampleRate * durationMs / 1_000));
  const bitsPerSample = 16;
  const dataBytes = sampleFrames * channels * 2;
  const pcm = Buffer.alloc(dataBytes);
  const seeded = seedToUint32(seed);
  const random = xorshift32(seeded);
  const baseFrequency = 180 + (seeded % 260);

  for (let frame = 0; frame < sampleFrames; frame += 1) {
    const time = frame / sampleRate;
    const envelope = Math.min(1, frame / 32, (sampleFrames - frame) / 32);
    const tone = Math.sin(2 * Math.PI * baseFrequency * time) * 0.78
      + Math.sin(2 * Math.PI * baseFrequency * 1.5 * time) * 0.18;
    const dither = ((random() / 0xffffffff) - 0.5) * 0.015;
    const normalized = silent ? 0 : Math.max(-1, Math.min(1, (tone + dither) * amplitude * envelope));
    const sample = Math.round(normalized * 0x7fff);
    for (let channel = 0; channel < channels; channel += 1) {
      pcm.writeInt16LE(sample, (frame * channels + channel) * 2);
    }
  }

  const bytes = Buffer.concat([
    wavHeader({ dataBytes, sampleRate, channels, bitsPerSample }),
    pcm,
  ]);
  const digest = sha256(bytes);
  return Object.freeze({
    id: `synthetic-wav-${digest.slice(0, 16)}`,
    filename: `synthetic-${digest.slice(0, 12)}.wav`,
    mediaType: "audio/wav",
    bytes,
    sha256: digest,
    size: bytes.length,
    durationMs: sampleFrames / sampleRate * 1_000,
    sampleRate,
    channels,
    silent,
    seed: String(seed),
    provenance: { ...SYNTHETIC_MEDIA_PROVENANCE, seed: String(seed) },
  });
}

export function createSilentMedia(options = {}) {
  return createDeterministicMedia({ ...options, silent: true, amplitude: 0 });
}

export function createInvalidMedia(options = {}) {
  const seed = String(options.seed ?? "invalid-zhitai-offline-e2e-v1");
  const bytes = Buffer.from(`ZHITAI_INVALID_SYNTHETIC_MEDIA\n${sha256(Buffer.from(seed))}\n`, "utf8");
  const digest = sha256(bytes);
  return Object.freeze({
    id: `synthetic-invalid-${digest.slice(0, 16)}`,
    filename: `invalid-${digest.slice(0, 12)}.bin`,
    mediaType: "application/octet-stream",
    bytes,
    sha256: digest,
    size: bytes.length,
    durationMs: 0,
    invalid: true,
    seed,
    provenance: { ...SYNTHETIC_MEDIA_PROVENANCE, seed, intentionallyInvalid: true },
  });
}

/** Inspect the subset of WAV we generate without invoking any media process. */
export function inspectSyntheticMedia(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value ?? []);
  const digest = sha256(bytes);
  if (bytes.length < RIFF_HEADER_BYTES
    || bytes.toString("ascii", 0, 4) !== "RIFF"
    || bytes.toString("ascii", 8, 12) !== "WAVE"
    || bytes.toString("ascii", 12, 16) !== "fmt "
    || bytes.toString("ascii", 36, 40) !== "data") {
    return { valid: false, silent: false, reason: "invalid_wav_header", sha256: digest, size: bytes.length };
  }
  const audioFormat = bytes.readUInt16LE(20);
  const channels = bytes.readUInt16LE(22);
  const sampleRate = bytes.readUInt32LE(24);
  const bitsPerSample = bytes.readUInt16LE(34);
  const declaredDataBytes = bytes.readUInt32LE(40);
  const availableDataBytes = bytes.length - RIFF_HEADER_BYTES;
  if (audioFormat !== 1 || bitsPerSample !== 16 || channels < 1 || channels > 2
    || declaredDataBytes <= 0 || declaredDataBytes > availableDataBytes
    || declaredDataBytes % (channels * 2) !== 0) {
    return { valid: false, silent: false, reason: "invalid_pcm_layout", sha256: digest, size: bytes.length };
  }

  let peak = 0;
  let sumSquares = 0;
  let sampleCount = 0;
  const end = RIFF_HEADER_BYTES + declaredDataBytes;
  for (let offset = RIFF_HEADER_BYTES; offset < end; offset += 2) {
    const sample = bytes.readInt16LE(offset) / 0x8000;
    peak = Math.max(peak, Math.abs(sample));
    sumSquares += sample * sample;
    sampleCount += 1;
  }
  const rms = sampleCount === 0 ? 0 : Math.sqrt(sumSquares / sampleCount);
  const frames = sampleCount / channels;
  return {
    valid: true,
    silent: peak < 0.0001,
    reason: peak < 0.0001 ? "silent_media" : null,
    sha256: digest,
    size: bytes.length,
    mediaType: "audio/wav",
    sampleRate,
    channels,
    bitsPerSample,
    durationMs: frames / sampleRate * 1_000,
    peak,
    rms,
  };
}

export function writeSyntheticMedia(filePath, fixture = createDeterministicMedia()) {
  const absolutePath = resolve(filePath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, fixture.bytes, { flag: "wx", mode: 0o600 });
  return { ...fixture, bytes: undefined, path: absolutePath };
}

export const createSyntheticMedia = createDeterministicMedia;
export const inspectSyntheticWav = inspectSyntheticMedia;
