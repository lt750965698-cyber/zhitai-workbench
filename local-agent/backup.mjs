import * as sqlite from "node:sqlite";
import { isUtf8 } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { isSensitiveFieldName } from "./content-metadata.mjs";

const { DatabaseSync } = sqlite;

export const BACKUP_FORMAT = "zhitai-bag";
export const BACKUP_FORMAT_VERSION = 1;
export const EXCLUSION_POLICY_VERSION = 1;

const BAGIT_TEXT = "BagIt-Version: 1.0\r\nTag-File-Character-Encoding: UTF-8\r\n";
const TAG_FILES = ["bagit.txt", "bag-info.txt", "manifest-sha256.txt", "manifest.json"];
const REQUIRED_ROOT_FILES = new Set([...TAG_FILES, "tagmanifest-sha256.txt"]);

const STATE_SCOPES = [
  { source: "tasks.json", category: "task_queue" },
  { source: "events.json", category: "audit_log" },
  { source: "analysis-jobs.json", category: "analysis_queue" },
  { source: "creative-jobs.json", category: "generation_queue" },
  { source: "creative-reviews.json", category: "creative_review" },
  { source: "kuaidian-commands.json", category: "resupply_queue" },
  { source: "publisher-schedule.json", category: "publisher_schedule" },
  { source: "watcher-state.json", category: "watcher_state" },
];

const STATE_DIRECTORY_SCOPES = [
  { source: "publish-jobs", category: "publish_job" },
  { source: "platform-receipts", category: "platform_receipt" },
];

const DATABASE_COUNT_TABLES = [
  "video_asset",
  "platform_post",
  "download_receipt",
  "ingest_observation",
  "import_batch",
  "import_item",
  "correction",
  "remake_generation",
  "x_bookmark",
  "x_bookmark_sync",
];

const EXCLUSION_RULES = [
  "secret_or_credential",
  "cookie_or_token",
  "login_qr",
  "private_raw",
  "diagnostic",
  "third_party_engine",
  "redownloadable_cache",
  "temporary_file",
  "symlink",
  "special_file",
];

const SENSITIVE_EXACT_NAMES = new Set([
  ".env",
  "auth.json",
  "authorization.json",
  "cookies",
  "cookies.db",
  "cookies.sqlite",
  "config.local.json",
  "credentials.json",
  "cookie.json",
  "cookies.json",
  "inbox-secret",
  "keychain",
  "keychain.db",
  "keychain.sqlite",
  "login data",
  "local state",
  "secret.json",
  "secrets.json",
  "session.json",
  "sessions.json",
  "token.json",
  "tokens.json",
  "webhook-nonces.json",
  "web data",
  "yuanbao-cookie",
]);

const SENSITIVE_EXTENSIONS = new Set([".cookie", ".key", ".keychain", ".keychain-db", ".p12", ".pem", ".secret"]);
const PRIVATE_SEGMENTS = new Set(["private", "raw-backup"]);
const SECRET_DIRECTORY_SEGMENTS = new Set(["keychain", "keychains"]);
const QR_DIRECTORY_SEGMENTS = new Set([
  "login-qr", "loginqr", "qr", "qr-code", "qr-codes", "qrcode", "qrcodes",
]);
const DIAGNOSTIC_SEGMENTS = new Set(["diag", "diagnostics"]);
const ENGINE_SEGMENTS = new Set([
  "engine", "engines", "node-modules", "pycache", "site-packages", "third-party", "vendor", "venv", "virtualenv",
]);
const CACHE_SEGMENTS = new Set(["cache", "caches", "download-cache", "redownloadable-cache"]);
const TEMP_SEGMENTS = new Set(["temp", "tmp"]);
const BROWSER_PROFILE_SEGMENTS = new Set(["browser-profile", "electron-profile", "matrix-login", "sessions", "user-data"]);
const AUDITED_TEXT_EXTENSIONS = new Set([
  ".csv", ".jsonl", ".markdown", ".md", ".ndjson", ".srt", ".tsv", ".txt", ".url", ".vtt",
]);
const MAX_AUDITED_TEXT_BYTES = 64 * 1024 * 1024;
const RECOGNIZED_BINARY_ASSET_EXTENSIONS = new Set([
  ".aac", ".avi", ".avif", ".bmp", ".flac", ".gif", ".heic", ".heif", ".ico", ".jpeg", ".jpg",
  ".m4a", ".m4v", ".mkv", ".mov", ".mp3", ".mp4", ".ogg", ".opus", ".pdf", ".png", ".tif",
  ".tiff", ".wav", ".webm", ".webp",
]);

// Backup export is deliberately more conservative than the shared metadata
// redactor. These names can carry reusable login material even when a producer
// does not call it a token/secret. A generic JSON `key` is also denied; the only
// current business exception is scoped to schema_version.key in SQLite below.
const BACKUP_SENSITIVE_FIELD_SEGMENTS = new Set([
  "backupcode",
  "backupcodes",
  "bearer",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "keychain",
  "jwt",
  "mnemonic",
  "otp",
  "passphrase",
  "privatekey",
  "qrcode",
  "qrcodes",
  "qrpayload",
  "recoverycode",
  "recoverycodes",
  "seed",
  "session",
  "sessionid",
  "sessions",
  "totp",
  "tokens",
]);

const BACKUP_SENSITIVE_TABLE_NAMES = new Set([
  "auth",
  "authentication",
  "authorization",
  "cookie",
  "cookies",
  "credential",
  "credentials",
  "keychain",
  "keys",
  "secret",
  "secrets",
  "session",
  "sessions",
  "token",
  "tokens",
]);

const SQLITE_DYNAMIC_KEY_COLUMNS = new Set([
  "field",
  "key",
  "name",
  "option",
  "param",
  "parameter",
  "property",
  "setting",
  "settingkey",
  "settingname",
]);

const SQLITE_DYNAMIC_VALUE_COLUMNS = new Set([
  "content",
  "data",
  "payload",
  "propertyvalue",
  "settingvalue",
  "value",
]);

export class BackupError extends Error {
  constructor(code, cause = null, details = null) {
    super(code, cause ? { cause } : undefined);
    this.name = "BackupError";
    this.code = code;
    if (details && typeof details === "object") this.details = details;
  }
}

function fail(code, cause = null, details = null) {
  throw new BackupError(code, cause, details);
}

function nowIso() {
  return new Date().toISOString();
}

function policySegmentKey(value) {
  return String(value ?? "")
    .normalize("NFC")
    .trim()
    .toLowerCase()
    .replace(/[\s._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function assertSafeBackupIdentity(backupId, createdAt) {
  if (typeof backupId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(backupId)) fail("backup_id_invalid");
  if (typeof createdAt !== "string" || Number.isNaN(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) {
    fail("backup_created_at_invalid");
  }
}

function sqliteWalResetFixStatus(version) {
  const match = String(version || "").match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return "unknown";
  const [major, minor, patch] = match.slice(1).map(Number);
  const patched = major > 3
    || (major === 3 && (minor > 51
      || (minor === 51 && patch >= 3)
      || (minor === 50 && patch >= 7)
      || (minor === 44 && patch >= 6)));
  return patched ? "patched" : "runtime_upgrade_recommended";
}

function toPosixPath(value) {
  return value.split(sep).join("/");
}

function assertSafeRelativePath(value, { payload = false } = {}) {
  if (typeof value !== "string" || !value || value.includes("\0") || value.includes("\r") || value.includes("\n") || value.includes("\\")) {
    fail("unsafe_relative_path");
  }
  if (isAbsolute(value) || value.startsWith("/") || value !== posix.normalize(value) || value === "." || value === ".." || value.startsWith("../") || value.includes("/../")) {
    fail("unsafe_relative_path");
  }
  if (payload && !value.startsWith("data/")) fail("payload_path_outside_data");
  return value;
}

function pathIsInside(child, parent) {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveThroughExistingAncestor(path) {
  let cursor = resolve(path);
  const tail = [];
  while (!await pathExists(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) fail("path_has_no_existing_ancestor");
    tail.unshift(basename(cursor));
    cursor = parent;
  }
  const realAncestor = await realpath(cursor);
  return join(realAncestor, ...tail);
}

async function assertPlainDirectory(path, code) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    fail(code, error);
  }
  if (!info.isDirectory() || info.isSymbolicLink()) fail(code);
}

async function assertContainedRegularFile(path, root, code) {
  let info;
  try { info = await lstat(path); }
  catch (error) { fail(code, error); }
  if (!info.isFile() || info.isSymbolicLink()) fail(code);
  const canonical = await realpath(path);
  if (!pathIsInside(canonical, root)) fail(code);
  return { canonical, info };
}

async function sha256File(path) {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", rejectPromise);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolvePromise(hash.digest("hex")));
  });
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const SAFE_REDACTED_VALUES = /^(?:\[redacted(?::[^\]]+)?\]|redacted|user_asserted|not_stored|unavailable|null|none)?$/i;

function isBackupSensitiveFieldName(name) {
  const raw = String(name ?? "");
  if (!raw) return false;
  if (isSensitiveFieldName(raw)) return true;
  const normalized = raw.replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (normalized === "key" || BACKUP_SENSITIVE_FIELD_SEGMENTS.has(normalized)) return true;
  if (["accesskey", "apikey", "privatekey", "qrcode", "qrpayload", "secretkey", "signingkey"]
    .some((marker) => normalized.includes(marker))) return true;
  const segments = raw.split(/[_.\-[\]]+/)
    .flatMap((part) => part.split(/(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/))
    .map((segment) => segment.toLowerCase());
  return segments.some((segment) => BACKUP_SENSITIVE_FIELD_SEGMENTS.has(segment));
}

function sensitiveAssignmentInText(value) {
  const text = String(value ?? "");
  if (/\bBearer\s+(?!\[redacted\])[-A-Za-z0-9._~+/=]{8,}/i.test(text)) return true;
  if (/(?:^|[^A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{2,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?:$|[^A-Za-z0-9_-])/m.test(text)) return true;
  if (/data:image\/[a-z0-9.+-]+;base64,/i.test(text)) return true;
  const assignment = /([A-Za-z][A-Za-z0-9_.\-[\]]{0,127})(?:\\?["'])?\s*[:=：＝]\s*(?:["']([^"']*)["']|([^\s,;&}\]]*))/g;
  let match;
  while ((match = assignment.exec(text)) !== null) {
    const segments = match[1].split(/[.\-[\]]+/).filter(Boolean);
    const key = segments.at(-1) || match[1];
    if (!isBackupSensitiveFieldName(key)) continue;
    const assigned = String(match[2] ?? match[3] ?? "").trim();
    if (!SAFE_REDACTED_VALUES.test(assigned)) return true;
  }
  return false;
}

function jsonContainsSensitiveMaterial(value, depth = 0) {
  if (depth > 64) fail("json_nesting_too_deep");
  if (typeof value === "string") return sensitiveAssignmentInText(value);
  if (Array.isArray(value)) return value.some((entry) => jsonContainsSensitiveMaterial(entry, depth + 1));
  if (!value || typeof value !== "object") return false;
  for (const [key, entry] of Object.entries(value)) {
    if (isBackupSensitiveFieldName(key)) {
      const rendered = entry === null || entry === undefined ? "" : String(entry).trim();
      if (!SAFE_REDACTED_VALUES.test(rendered)) return true;
    }
    if (jsonContainsSensitiveMaterial(entry, depth + 1)) return true;
  }
  return false;
}

function auditModeForPath(path) {
  const logical = toPosixPath(String(path).toLowerCase());
  if (logical === "data/state/kb.sqlite") return "sqlite_snapshot";
  const extension = posix.extname(logical);
  if (extension === ".json") return "json";
  if (extension === ".jsonl" || extension === ".ndjson") return "json_lines";
  if (extension === ".csv") return "csv";
  if (extension === ".tsv") return "tsv";
  if (extension === ".md" || extension === ".markdown") return "markdown";
  if (AUDITED_TEXT_EXTENSIONS.has(extension)) return "text";
  if (RECOGNIZED_BINARY_ASSET_EXTENSIONS.has(extension)) return "binary_asset";
  return "unsupported";
}

function asciiAt(buffer, offset, length) {
  return buffer.length >= offset + length ? buffer.subarray(offset, offset + length).toString("ascii") : "";
}

function validateBinaryAssetHeader(path, buffer) {
  const extension = posix.extname(String(path).toLowerCase());
  const byte = (index) => buffer[index];
  let valid = false;
  if ([".mp4", ".mov", ".m4v", ".m4a", ".heic", ".heif", ".avif"].includes(extension)) {
    valid = asciiAt(buffer, 4, 4) === "ftyp";
  } else if ([".webm", ".mkv"].includes(extension)) {
    valid = byte(0) === 0x1a && byte(1) === 0x45 && byte(2) === 0xdf && byte(3) === 0xa3;
  } else if ([".jpg", ".jpeg"].includes(extension)) {
    valid = byte(0) === 0xff && byte(1) === 0xd8 && byte(2) === 0xff;
  } else if (extension === ".png") {
    valid = buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  } else if (extension === ".gif") {
    valid = asciiAt(buffer, 0, 6) === "GIF87a" || asciiAt(buffer, 0, 6) === "GIF89a";
  } else if (extension === ".webp") {
    valid = asciiAt(buffer, 0, 4) === "RIFF" && asciiAt(buffer, 8, 4) === "WEBP";
  } else if (extension === ".wav") {
    valid = asciiAt(buffer, 0, 4) === "RIFF" && asciiAt(buffer, 8, 4) === "WAVE";
  } else if (extension === ".avi") {
    valid = asciiAt(buffer, 0, 4) === "RIFF" && asciiAt(buffer, 8, 3) === "AVI";
  } else if (extension === ".mp3") {
    valid = asciiAt(buffer, 0, 3) === "ID3" || (byte(0) === 0xff && (byte(1) & 0xe0) === 0xe0);
  } else if (extension === ".flac") {
    valid = asciiAt(buffer, 0, 4) === "fLaC";
  } else if ([".ogg", ".opus"].includes(extension)) {
    valid = asciiAt(buffer, 0, 4) === "OggS";
  } else if (extension === ".aac") {
    valid = byte(0) === 0xff && (byte(1) & 0xf6) === 0xf0;
  } else if (extension === ".bmp") {
    valid = asciiAt(buffer, 0, 2) === "BM";
  } else if ([".tif", ".tiff"].includes(extension)) {
    valid = (asciiAt(buffer, 0, 4) === "II*\u0000") || (asciiAt(buffer, 0, 4) === "MM\u0000*");
  } else if (extension === ".ico") {
    valid = byte(0) === 0 && byte(1) === 0 && byte(2) === 1 && byte(3) === 0;
  } else if (extension === ".pdf") {
    valid = asciiAt(buffer, 0, 5) === "%PDF-";
  }
  if (!valid) fail("binary_asset_signature_invalid");
}

function validatePayloadHeader(path, buffer, mode) {
  if (mode === "sqlite_snapshot") {
    if (asciiAt(buffer, 0, 16) !== "SQLite format 3\u0000") fail("sqlite_snapshot_header_invalid");
    return;
  }
  validateBinaryAssetHeader(path, buffer);
}

function parseDelimitedRows(text, delimiter) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  let cells = 0;
  const pushField = () => {
    row.push(field);
    field = "";
    cells += 1;
    if (cells > 1_000_000) fail("delimited_payload_too_complex");
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }
    if (character === '"' && field === "") {
      quoted = true;
    } else if (character === delimiter) {
      pushField();
    } else if (character === "\n") {
      pushRow();
    } else if (character === "\r") {
      if (text[index + 1] === "\n") index += 1;
      pushRow();
    } else {
      field += character;
    }
  }
  if (quoted) fail("delimited_payload_invalid");
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}

function tabularContainsSensitiveMaterial(rows) {
  const nonempty = rows.filter((row) => row.some((cell) => String(cell).trim() !== ""));
  if (nonempty.length === 0) return false;
  const header = nonempty[0].map((cell) => String(cell).trim());
  for (const [column, name] of header.entries()) {
    if (!isBackupSensitiveFieldName(name)) continue;
    for (const row of nonempty.slice(1)) {
      if (sqliteValueContainsMaterial(row[column], "text")) return true;
    }
  }
  const keyColumns = header.map((name, index) => isSqliteDynamicKeyColumn(name) ? index : -1).filter((index) => index >= 0);
  const valueColumns = header.map((name, index) => isSqliteDynamicValueColumn(name) ? index : -1).filter((index) => index >= 0);
  for (const row of nonempty.slice(1)) {
    for (const keyColumn of keyColumns) {
      if (!isBackupSensitiveFieldName(row[keyColumn])) continue;
      for (const valueColumn of valueColumns) {
        if (sqliteValueContainsMaterial(row[valueColumn], "text")) return true;
      }
    }
  }
  // Headerless key/value exports are common; reject an explicit sensitive
  // field label followed by any material in the same record.
  for (const row of nonempty) {
    for (let index = 0; index + 1 < row.length; index += 1) {
      if (isBackupSensitiveFieldName(row[index]) && sqliteValueContainsMaterial(row[index + 1], "text")) return true;
    }
  }
  return false;
}

function markdownContainsSensitiveTable(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes("|")) continue;
    const cells = line.split("|").map((cell) => cell.trim());
    if (cells[0] === "") cells.shift();
    if (cells.at(-1) === "") cells.pop();
    if (cells.length > 1) rows.push(cells);
  }
  // Markdown tables may occur after ordinary prose, so also treat every row as
  // a possible explicit key/value record instead of trusting one global header.
  for (const row of rows) {
    for (let index = 0; index + 1 < row.length; index += 1) {
      if (isBackupSensitiveFieldName(row[index]) && sqliteValueContainsMaterial(row[index + 1], "text")) return true;
    }
  }
  return tabularContainsSensitiveMaterial(rows);
}

function auditContentBuffer(buffer, mode) {
  if (!Buffer.isBuffer(buffer) || !isUtf8(buffer)) fail("audited_text_not_utf8");
  const text = buffer.toString("utf8");
  if (mode === "json") {
    let value;
    try { value = JSON.parse(text); }
    catch (error) { fail("backup_json_invalid", error); }
    if (jsonContainsSensitiveMaterial(value)) fail("sensitive_content_detected");
    return;
  }
  if (mode === "json_lines") {
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let value;
      try { value = JSON.parse(line); }
      catch (error) { fail("backup_json_lines_invalid", error); }
      if (jsonContainsSensitiveMaterial(value)) fail("sensitive_content_detected");
    }
    return;
  }
  if (mode === "csv" || mode === "tsv") {
    if (tabularContainsSensitiveMaterial(parseDelimitedRows(text, mode === "csv" ? "," : "\t"))) {
      fail("sensitive_content_detected");
    }
  }
  if (mode === "markdown" && markdownContainsSensitiveTable(text)) fail("sensitive_content_detected");
  if (sensitiveAssignmentInText(text)) fail("sensitive_content_detected");
}

async function auditPayloadFile(path, mode) {
  if (mode === "unsupported") fail("unsupported_payload_file_type");
  const info = await stat(path);
  if (mode === "binary_asset" || mode === "sqlite_snapshot") {
    let handle;
    try {
      handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      const header = Buffer.alloc(Math.min(64, info.size));
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      validatePayloadHeader(path, header.subarray(0, bytesRead), mode);
      return;
    } finally {
      try { await handle?.close(); } catch { /* preserve the original validation error */ }
    }
  }
  if (info.size > MAX_AUDITED_TEXT_BYTES) fail("audited_text_too_large");
  auditContentBuffer(await readFile(path), mode);
}

function quoteIdentifier(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function normalizedSqlIdentifier(value) {
  return String(value ?? "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}

function isSqliteDynamicKeyColumn(value) {
  const normalized = normalizedSqlIdentifier(value);
  return SQLITE_DYNAMIC_KEY_COLUMNS.has(normalized)
    || normalized.endsWith("key")
    || normalized.endsWith("name");
}

function isSqliteDynamicValueColumn(value) {
  const normalized = normalizedSqlIdentifier(value);
  return SQLITE_DYNAMIC_VALUE_COLUMNS.has(normalized) || normalized.endsWith("value");
}

function sqliteValueContainsMaterial(value, storageClass) {
  if (value === null || value === undefined) return false;
  if (storageClass === "blob") return Buffer.isBuffer(value) ? value.length > 0 : true;
  const rendered = String(value).trim();
  return rendered !== "" && !SAFE_REDACTED_VALUES.test(rendered);
}

function auditOpenDatabaseSensitiveContent(db) {
  try {
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
    for (const { name: table } of tables) {
      const tableId = quoteIdentifier(table);
      const columns = db.prepare(`PRAGMA table_info(${tableId})`).all();
      const tableSensitive = BACKUP_SENSITIVE_TABLE_NAMES.has(normalizedSqlIdentifier(table))
        || isBackupSensitiveFieldName(table);
      for (const column of columns) {
        const columnId = quoteIdentifier(column.name);
        // `schema_version.key` stores public migration labels such as `kb_migrate`;
        // the shared classifier intentionally treats a generic `key` as sensitive,
        // so scope this known business-schema exception by exact table+column.
        const schemaVersionLabel = table === "schema_version" && column.name === "key";
        const sensitiveName = !schemaVersionLabel && (tableSensitive || isBackupSensitiveFieldName(column.name));
        const structured = /(?:json|evidence|metadata|payload|response)/i.test(column.name);
        if (sensitiveName && db.prepare(`SELECT 1 AS found FROM ${tableId} WHERE typeof(${columnId})='blob' AND length(${columnId})>0 LIMIT 1`).get()) {
          fail("sensitive_content_detected");
        }
        if (sensitiveName && db.prepare(`SELECT 1 AS found FROM ${tableId} WHERE typeof(${columnId}) IN ('integer', 'real') LIMIT 1`).get()) {
          fail("sensitive_content_detected");
        }
        const rows = db.prepare(`SELECT ${columnId} AS value FROM ${tableId} WHERE typeof(${columnId})='text' AND length(${columnId})>0`).iterate();
        for (const row of rows) {
          const text = String(row.value);
          if ((sensitiveName && !SAFE_REDACTED_VALUES.test(text.trim())) || sensitiveAssignmentInText(text)) {
            fail("sensitive_content_detected");
          }
          if (structured && /^[{[]/.test(text.trim())) {
            let parsed;
            try { parsed = JSON.parse(text); }
            catch { continue; }
            if (jsonContainsSensitiveMaterial(parsed)) fail("sensitive_content_detected");
          }
        }
      }

      // Common settings/config tables keep the sensitive field name in one
      // column and its material in another. Column-by-column classification
      // cannot see that relationship, so evaluate every plausible key/value
      // pair in the same row and reject both text and BLOB material.
      const dynamicKeys = columns.filter((column) => isSqliteDynamicKeyColumn(column.name));
      const dynamicValues = columns.filter((column) => isSqliteDynamicValueColumn(column.name));
      for (const keyColumn of dynamicKeys) {
        const keyId = quoteIdentifier(keyColumn.name);
        for (const valueColumn of dynamicValues) {
          if (valueColumn.name === keyColumn.name) continue;
          const valueId = quoteIdentifier(valueColumn.name);
          const rows = db.prepare(`SELECT ${keyId} AS dynamicKey, ${valueId} AS dynamicValue, typeof(${valueId}) AS storageClass FROM ${tableId} WHERE ${keyId} IS NOT NULL AND ${valueId} IS NOT NULL`).iterate();
          for (const row of rows) {
            if (typeof row.dynamicKey !== "string" || !isBackupSensitiveFieldName(row.dynamicKey)) continue;
            if (sqliteValueContainsMaterial(row.dynamicValue, row.storageClass)) fail("sensitive_content_detected");
          }
        }
      }
    }
    return { outcome: "ok", method: "fail_closed_field_and_assignment_audit" };
  } catch (error) {
    if (error instanceof BackupError) throw error;
    fail("sqlite_sensitive_content_audit_failed", error);
  }
}

function auditSqliteSensitiveContent(dbPath) {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout=5000");
    return auditOpenDatabaseSensitiveContent(db);
  } catch (error) {
    if (error instanceof BackupError) throw error;
    fail("sqlite_sensitive_content_audit_failed", error);
  } finally {
    try { db?.close(); } catch { /* read-only best effort */ }
  }
}

function tableExists(db, table) {
  return Boolean(db.prepare("SELECT 1 AS ok FROM sqlite_schema WHERE type='table' AND name=?").get(table));
}

function pragmaScalar(db, pragma) {
  const row = db.prepare(`PRAGMA ${pragma}`).get();
  return row ? Object.values(row)[0] : null;
}

function inspectOpenDatabase(db) {
  const integrityRows = db.prepare("PRAGMA integrity_check").all();
  const integrityOk = integrityRows.length === 1 && String(Object.values(integrityRows[0] || {})[0] || "").toLowerCase() === "ok";
  const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
  const rowCounts = {};
  for (const table of DATABASE_COUNT_TABLES) {
    rowCounts[table] = tableExists(db, table)
      ? Number(db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get().count)
      : 0;
  }
  return {
    integrityCheck: integrityOk ? "ok" : "failed",
    integrityErrorCount: integrityOk ? 0 : integrityRows.length,
    foreignKeyViolations,
    journalMode: String(pragmaScalar(db, "journal_mode") || "unknown").toLowerCase(),
    userVersion: Number(pragmaScalar(db, "user_version") || 0),
    schemaVersion: Number(pragmaScalar(db, "schema_version") || 0),
    sqliteVersion: String(db.prepare("SELECT sqlite_version() AS version").get().version),
    rowCounts,
  };
}

export function inspectSqliteDatabase(dbPath) {
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA busy_timeout=5000");
    return inspectOpenDatabase(db);
  } catch (error) {
    fail("sqlite_inspection_failed", error);
  } finally {
    try { db?.close(); } catch { /* read-only best effort */ }
  }
}

async function assertSqliteSidecarsSafe(sourcePath, sourceRoot) {
  for (const suffix of ["-wal", "-shm"]) {
    const sidecar = `${sourcePath}${suffix}`;
    let info;
    try { info = await lstat(sidecar); }
    catch (error) {
      if (error?.code === "ENOENT") continue;
      fail("sqlite_sidecar_inspection_failed", error);
    }
    if (!info.isFile() || info.isSymbolicLink()) fail("sqlite_sidecar_not_regular");
    let canonical;
    try { canonical = await realpath(sidecar); }
    catch (error) { fail("sqlite_sidecar_changed_during_inspection", error); }
    if (!pathIsInside(canonical, sourceRoot)) fail("sqlite_sidecar_outside_data_root");
  }
}

async function createSqliteSnapshot(sourcePath, targetPath, { backupImpl = sqlite.backup, sourceRoot = dirname(sourcePath) } = {}) {
  if (await pathExists(targetPath)) fail("sqlite_snapshot_target_exists");
  let sourceDb;
  try {
    await assertSqliteSidecarsSafe(sourcePath, sourceRoot);
    sourceDb = new DatabaseSync(sourcePath, { readOnly: true });
    sourceDb.exec("PRAGMA busy_timeout=5000");
    await assertSqliteSidecarsSafe(sourcePath, sourceRoot);
    const sourceContentSafety = auditOpenDatabaseSensitiveContent(sourceDb);
    const sourceInspection = inspectOpenDatabase(sourceDb);
    if (sourceInspection.integrityCheck !== "ok") fail("source_integrity_check_failed");
    if (sourceInspection.foreignKeyViolations !== 0) fail("source_foreign_key_check_failed");
    const walPresent = await pathExists(`${sourcePath}-wal`);
    let method;
    if (typeof backupImpl === "function") {
      await backupImpl(sourceDb, targetPath, { rate: 256 });
      method = "sqlite_online_backup_api";
    } else {
      sourceDb.prepare("VACUUM INTO ?").run(targetPath);
      method = "sqlite_vacuum_into";
    }
    // The Online Backup API preserves the source database's WAL-mode header.
    // Normalize only the private staging copy to a standalone rollback-journal
    // database so recovery never depends on a copied -wal/-shm pair. This does
    // not checkpoint or otherwise mutate the live source database.
    let normalizedDb;
    try {
      normalizedDb = new DatabaseSync(targetPath);
      normalizedDb.exec("PRAGMA busy_timeout=5000");
      const normalizedMode = String(pragmaScalar(normalizedDb, "journal_mode=DELETE") || "").toLowerCase();
      if (normalizedMode !== "delete") fail("sqlite_snapshot_normalization_failed");
    } finally {
      try { normalizedDb?.close(); } catch { /* staging copy only */ }
    }
    if (await pathExists(`${targetPath}-wal`) || await pathExists(`${targetPath}-shm`)) fail("sqlite_snapshot_sidecar_remained");
    const snapshotInspection = inspectSqliteDatabase(targetPath);
    if (snapshotInspection.integrityCheck !== "ok") fail("snapshot_integrity_check_failed");
    if (snapshotInspection.foreignKeyViolations !== 0) fail("snapshot_foreign_key_check_failed");
    return {
      method,
      walPresent,
      walCoverage: "committed_wal_frames_consolidated_into_snapshot",
      source: sourceInspection,
      snapshot: snapshotInspection,
      sourceContentSafety,
    };
  } catch (error) {
    if (error instanceof BackupError) throw error;
    fail("sqlite_snapshot_failed", error);
  } finally {
    try { sourceDb?.close(); } catch { /* best effort */ }
  }
}

function exclusionReason(relativePath, info = null) {
  const logical = toPosixPath(relativePath);
  const segments = logical.split("/").filter(Boolean);
  const lowered = segments.map((segment) => segment.toLowerCase());
  const policySegments = segments.map(policySegmentKey);
  const name = lowered.at(-1) || "";
  if (info?.isSymbolicLink()) return "symlink";
  if (info && !info.isFile() && !info.isDirectory()) return "special_file";
  if (policySegments.some((segment) => SECRET_DIRECTORY_SEGMENTS.has(segment))) return "secret_or_credential";
  if (policySegments.some((segment) => QR_DIRECTORY_SEGMENTS.has(segment))) return "login_qr";
  if (policySegments.some((segment) => PRIVATE_SEGMENTS.has(segment))) return "private_raw";
  if (policySegments.some((segment) => DIAGNOSTIC_SEGMENTS.has(segment))) return "diagnostic";
  if (policySegments.some((segment) => BROWSER_PROFILE_SEGMENTS.has(segment))) return "cookie_or_token";
  if (policySegments.some((segment) => ENGINE_SEGMENTS.has(segment))) return "third_party_engine";
  if (policySegments.some((segment) => CACHE_SEGMENTS.has(segment))) return "redownloadable_cache";
  if (policySegments.some((segment) => TEMP_SEGMENTS.has(segment)) || name === ".ds_store" || /(?:\.tmp|\.part|\.download)$/i.test(name) || /^\.staging-/i.test(name)) {
    return "temporary_file";
  }
  // The sanitized Yuanbao record is allowed only after every enclosing
  // directory policy has run. A safe basename never overrides cache, engine,
  // diagnostics, browser-profile, QR, keychain, private, or temp exclusions.
  if (name === "raw-yuanbao.sanitized.json") return null;
  if (name === "raw-yuanbao.json") return "private_raw";
  if (SENSITIVE_EXACT_NAMES.has(name) || name.startsWith(".env.") || SENSITIVE_EXTENSIONS.has(posix.extname(name))) {
    return name.includes("cookie") || name.includes("token") ? "cookie_or_token" : "secret_or_credential";
  }
  if (/(?:^|[-_.\s])(?:access[-_.\s]?keys?|auth(?:entication|orization)?|backup[-_.\s]?codes?|bearer|cookie|cookies|credential|credentials|jwt|keychain|keychains|mnemonic|mnemonics|passphrase|passphrases|password|passwords|private[-_.\s]?keys?|recovery[-_.\s]?codes?|secret|secrets|session|sessions|token|tokens)(?:[-_.\s]|$)/i.test(name)) {
    return /cookie|session|token/i.test(name) ? "cookie_or_token" : "secret_or_credential";
  }
  if (/^(?:qr|qrcode|login[-_.]?qr)(?:[-_.].*)?\.(?:gif|jpe?g|png|webp)$/i.test(name)
    || (/(?:^|[-_.])(?:qr|qrcode)(?:[-_.]|$)/i.test(name) && /\.(?:gif|jpe?g|png|webp)$/i.test(name))
    || policySegments.includes("matrix-login")) {
    return "login_qr";
  }
  return null;
}

async function copyStableFile(sourcePath, targetPath, sourceRoot, { auditMode = null, exclusiveTarget = false } = {}) {
  await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const { canonical, info: before } = await assertContainedRegularFile(sourcePath, sourceRoot, "source_file_not_regular");
    let sourceHandle;
    let targetHandle;
    let openedInfo;
    try {
      sourceHandle = await open(canonical, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
      openedInfo = await sourceHandle.stat();
      if (!openedInfo.isFile() || openedInfo.dev !== before.dev || openedInfo.ino !== before.ino) continue;
      let auditedBuffer = null;
      if (!auditMode || auditMode === "unsupported") fail("unsupported_payload_file_type");
      if (auditMode === "binary_asset" || auditMode === "sqlite_snapshot") {
        const header = Buffer.alloc(Math.min(64, openedInfo.size));
        const { bytesRead } = await sourceHandle.read(header, 0, header.length, 0);
        validatePayloadHeader(sourcePath, header.subarray(0, bytesRead), auditMode);
        const afterAudit = await sourceHandle.stat();
        if (afterAudit.size !== openedInfo.size || afterAudit.mtimeMs !== openedInfo.mtimeMs) continue;
      } else {
        if (openedInfo.size > MAX_AUDITED_TEXT_BYTES) fail("audited_text_too_large");
        auditedBuffer = await sourceHandle.readFile();
        if (auditedBuffer.length !== openedInfo.size) continue;
        auditContentBuffer(auditedBuffer, auditMode);
        const afterAudit = await sourceHandle.stat();
        if (afterAudit.size !== openedInfo.size || afterAudit.mtimeMs !== openedInfo.mtimeMs) continue;
      }
      const targetFlags = fsConstants.O_WRONLY | fsConstants.O_CREAT
        | (exclusiveTarget ? fsConstants.O_EXCL : fsConstants.O_TRUNC);
      targetHandle = await open(targetPath, targetFlags, 0o600);
      let sourceOffset = 0;
      if (auditedBuffer) {
        let written = 0;
        while (written < auditedBuffer.length) {
          const result = await targetHandle.write(auditedBuffer, written, auditedBuffer.length - written, written);
          if (result.bytesWritten <= 0) fail("backup_copy_write_failed");
          written += result.bytesWritten;
        }
      } else {
        const buffer = Buffer.allocUnsafe(1024 * 1024);
        while (true) {
          const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, sourceOffset);
          if (bytesRead === 0) break;
          let written = 0;
          while (written < bytesRead) {
            const result = await targetHandle.write(buffer, written, bytesRead - written, sourceOffset + written);
            if (result.bytesWritten <= 0) fail("backup_copy_write_failed");
            written += result.bytesWritten;
          }
          sourceOffset += bytesRead;
        }
      }
      await targetHandle.sync();
    } finally {
      try { await targetHandle?.close(); } catch { /* retry or fail with original error */ }
      try { await sourceHandle?.close(); } catch { /* retry or fail with original error */ }
    }
    const after = await lstat(sourcePath);
    if (openedInfo.dev === after.dev && openedInfo.ino === after.ino && openedInfo.size === after.size && openedInfo.mtimeMs === after.mtimeMs) {
      await chmod(targetPath, 0o600);
      const copied = await stat(targetPath);
      return { sizeBytes: copied.size, sha256: await sha256File(targetPath) };
    }
    if (exclusiveTarget) {
      try { await rm(targetPath); } catch { /* restore root cleanup remains fail-safe */ }
    }
  }
  fail("source_changed_during_backup");
}

async function walkRegularFiles(root, visitor, relativeRoot = "") {
  const current = join(root, relativeRoot);
  const entries = await readdir(current, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, "en"));
  for (const entry of entries) {
    const rel = relativeRoot ? join(relativeRoot, entry.name) : entry.name;
    const path = join(root, rel);
    const info = await lstat(path);
    const descend = await visitor({ path, rel, info });
    if (descend !== false && info.isDirectory() && !info.isSymbolicLink()) await walkRegularFiles(root, visitor, rel);
  }
}

async function addPayloadFile({ sourcePath, sourceRoot, logicalPath, category, stagingRoot, files }) {
  const safePath = assertSafeRelativePath(logicalPath, { payload: true });
  if (files.some((entry) => entry.path === safePath)) fail("duplicate_payload_path");
  const targetPath = join(stagingRoot, ...safePath.split("/"));
  const description = await copyStableFile(sourcePath, targetPath, sourceRoot, { auditMode: auditModeForPath(safePath) });
  files.push({ path: safePath, category, ...description });
}

function incrementReason(counts, reason) {
  counts[reason] = Number(counts[reason] || 0) + 1;
}

async function collectStatePayload(dataDir, stagingRoot, files, excludedCounts) {
  for (const scope of STATE_SCOPES) {
    const sourcePath = join(dataDir, scope.source);
    if (!await pathExists(sourcePath)) continue;
    const info = await lstat(sourcePath);
    const reason = exclusionReason(scope.source, info);
    if (reason) {
      incrementReason(excludedCounts, reason);
      continue;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      incrementReason(excludedCounts, info.isSymbolicLink() ? "symlink" : "special_file");
      continue;
    }
    await addPayloadFile({
      sourcePath,
      sourceRoot: dataDir,
      logicalPath: `data/state/${scope.source}`,
      category: scope.category,
      stagingRoot,
      files,
    });
  }

  for (const scope of STATE_DIRECTORY_SCOPES) {
    const scopeRoot = join(dataDir, scope.source);
    if (!await pathExists(scopeRoot)) continue;
    const rootInfo = await lstat(scopeRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
      incrementReason(excludedCounts, rootInfo.isSymbolicLink() ? "symlink" : "special_file");
      continue;
    }
    await walkRegularFiles(scopeRoot, async ({ path, rel, info }) => {
      const reason = exclusionReason(join(scope.source, rel), info);
      if (reason) {
        incrementReason(excludedCounts, reason);
        return info.isDirectory() ? false : undefined;
      }
      if (info.isDirectory()) return;
      if (!info.isFile() || info.isSymbolicLink() || toPosixPath(rel).includes("/") || !rel.toLowerCase().endsWith(".json")) {
        incrementReason(excludedCounts, info.isSymbolicLink() ? "symlink" : "special_file");
        return;
      }
      await addPayloadFile({
        sourcePath: path,
        sourceRoot: dataDir,
        logicalPath: `data/state/${scope.source}/${toPosixPath(rel)}`,
        category: scope.category,
        stagingRoot,
        files,
      });
    });
  }
}

async function collectKnowledgePayload(knowledgeRoot, stagingRoot, files, excludedCounts) {
  await walkRegularFiles(knowledgeRoot, async ({ path, rel, info }) => {
    const reason = exclusionReason(rel, info);
    if (reason) {
      incrementReason(excludedCounts, reason);
      return info.isDirectory() ? false : undefined;
    }
    if (info.isDirectory()) return;
    if (!info.isFile() || info.isSymbolicLink()) {
      incrementReason(excludedCounts, info.isSymbolicLink() ? "symlink" : "special_file");
      return;
    }
    await addPayloadFile({
      sourcePath: path,
      sourceRoot: knowledgeRoot,
      logicalPath: `data/knowledge/${toPosixPath(rel)}`,
      category: "knowledge_content",
      stagingRoot,
      files,
    });
  });
}

async function readJsonIfPresent(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    fail("state_json_invalid", error);
  }
}

function arrayLength(value) {
  return Array.isArray(value) ? value.length : 0;
}

async function countFilesWithBasename(root, targetName) {
  if (!await pathExists(root)) return 0;
  let count = 0;
  await walkRegularFiles(root, async ({ rel, info }) => {
    if (info.isFile() && basename(rel) === targetName) count += 1;
  });
  return count;
}

async function collectMetrics(payloadRoot, dbInspection = null) {
  const stateRoot = await pathExists(join(payloadRoot, "state", "kb.sqlite"))
    ? join(payloadRoot, "state")
    : join(payloadRoot, "data");
  const inspection = dbInspection || inspectSqliteDatabase(join(stateRoot, "kb.sqlite"));
  const tasks = await readJsonIfPresent(join(stateRoot, "tasks.json"), []);
  const analysisJobs = await readJsonIfPresent(join(stateRoot, "analysis-jobs.json"), []);
  const creativeJobs = await readJsonIfPresent(join(stateRoot, "creative-jobs.json"), []);
  const publisherSchedule = await readJsonIfPresent(join(stateRoot, "publisher-schedule.json"), { tasks: [] });
  const publisherScheduledTasks = Array.isArray(publisherSchedule)
    ? publisherSchedule
    : Array.isArray(publisherSchedule?.tasks) ? publisherSchedule.tasks : [];
  const resupplyCommands = await readJsonIfPresent(join(stateRoot, "kuaidian-commands.json"), []);
  const events = await readJsonIfPresent(join(stateRoot, "events.json"), []);
  const publishJobsDir = join(stateRoot, "publish-jobs");
  const platformReceiptsDir = join(stateRoot, "platform-receipts");
  const knowledgeRoot = join(payloadRoot, "knowledge");
  const publishJobCount = await countJsonFiles(publishJobsDir);
  const platformReceiptFileCount = await countJsonFiles(platformReceiptsDir);
  const knowledgeFileCount = await countAllRegularFiles(knowledgeRoot);
  const knowledgePackageCount = await countFilesWithBasename(knowledgeRoot, "metadata.json");
  const taskComponents = {
    importItems: Number(inspection.rowCounts.import_item || 0),
    taskRecords: arrayLength(tasks),
    analysisJobs: arrayLength(analysisJobs),
    creativeJobs: arrayLength(creativeJobs),
    publisherScheduledTasks: arrayLength(publisherScheduledTasks),
    resupplyCommands: arrayLength(resupplyCommands),
  };
  return {
    videoAssetCount: Number(inspection.rowCounts.video_asset || 0),
    knowledgePackageCount,
    knowledgeFileCount,
    taskCount: Object.values(taskComponents).reduce((sum, value) => sum + value, 0),
    taskComponents,
    publishJobCount,
    scheduledTaskCount: (Array.isArray(tasks) ? tasks.filter((task) => task?.status === "scheduled" || task?.scheduledAt).length : 0)
      + publisherScheduledTasks.filter((task) => task?.status === "scheduled" || task?.scheduledAt).length,
    auditRecordCount: arrayLength(events) + Number(inspection.rowCounts.correction || 0) + Number(inspection.rowCounts.ingest_observation || 0),
    generationRecordCount: arrayLength(analysisJobs) + arrayLength(creativeJobs) + Number(inspection.rowCounts.remake_generation || 0),
    platformReceiptCount: platformReceiptFileCount + Number(inspection.rowCounts.platform_post || 0),
    downloadReceiptCount: Number(inspection.rowCounts.download_receipt || 0),
    databaseRowCounts: inspection.rowCounts,
  };
}

async function countJsonFiles(root) {
  if (!await pathExists(root)) return 0;
  let count = 0;
  await walkRegularFiles(root, async ({ rel, info }) => {
    if (info.isFile() && rel.toLowerCase().endsWith(".json")) count += 1;
  });
  return count;
}

async function countAllRegularFiles(root) {
  if (!await pathExists(root)) return 0;
  let count = 0;
  await walkRegularFiles(root, async ({ info }) => {
    if (info.isFile()) count += 1;
  });
  return count;
}

async function verifyDatabaseAssetsAgainstKnowledge(dbPath, knowledgeRoot) {
  const index = await knowledgeFileIndex(knowledgeRoot);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  const result = {
    databaseAssets: 0,
    assetsWithLocalReferences: 0,
    resolvedAssets: 0,
    sha256CheckedAssets: 0,
  };
  try {
    if (!tableExists(db, "video_asset")) return result;
    const columns = new Set(db.prepare("PRAGMA table_info(video_asset)").all().map((row) => row.name));
    if (!columns.has("id")) fail("video_asset_schema_invalid");
    const selected = ["id", ...["file_path", "package_path", "sha256"].filter((name) => columns.has(name))];
    const rows = db.prepare(`SELECT ${selected.map(quoteIdentifier).join(", ")} FROM video_asset`).all();
    result.databaseAssets = rows.length;
    for (const row of rows) {
      if (!row.file_path && !row.package_path) continue;
      result.assetsWithLocalReferences += 1;
      const packagePath = uniquePackageMatch(row.package_path, String(row.id), index.packageDirs, index.packageDirsByAssetId);
      const filePath = row.file_path
        ? uniqueFileInsidePackage(row.file_path, row.package_path, packagePath, index.byBasename, index.files)
        : null;
      if (!packagePath || (row.file_path && !filePath)) fail("knowledge_asset_reference_unresolved");
      if (row.sha256 && filePath) {
        if (!/^[0-9a-f]{64}$/i.test(String(row.sha256)) || await sha256File(filePath) !== String(row.sha256).toLowerCase()) {
          fail("knowledge_asset_sha256_mismatch");
        }
        result.sha256CheckedAssets += 1;
      }
      result.resolvedAssets += 1;
    }
    return result;
  } finally {
    db.close();
  }
}

function payloadManifestText(files) {
  return `${files.map((entry) => `${entry.sha256}  ${entry.path}`).join("\n")}\n`;
}

async function tagManifestText(root) {
  const lines = [];
  for (const name of TAG_FILES) lines.push(`${await sha256File(join(root, name))}  ${name}`);
  return `${lines.join("\n")}\n`;
}

function bagInfoText({ backupId, createdAt, payloadBytes, payloadFiles }) {
  return [
    `Bagging-Date: ${createdAt.slice(0, 10)}`,
    "Bag-Software-Agent: zhitai-backup/1",
    `External-Identifier: ${backupId}`,
    `Payload-Oxum: ${payloadBytes}.${payloadFiles}`,
    "",
  ].join("\r\n");
}

function validateBagInfo(text, manifest) {
  const fields = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    if (!line) continue;
    const separator = line.indexOf(": ");
    if (separator <= 0) fail("bag_info_invalid");
    const key = line.slice(0, separator);
    if (fields.has(key)) fail("bag_info_duplicate_field");
    fields.set(key, line.slice(separator + 2));
  }
  const oxum = String(fields.get("Payload-Oxum") || "").match(/^(\d+)\.(\d+)$/);
  if (!oxum || Number(oxum[1]) !== manifest.payload.sizeBytes || Number(oxum[2]) !== manifest.payload.fileCount) {
    fail("bag_info_payload_oxum_mismatch");
  }
  if (fields.get("External-Identifier") !== manifest.backupId) fail("bag_info_backup_id_mismatch");
  if (fields.get("Bagging-Date") !== String(manifest.createdAt || "").slice(0, 10)) fail("bag_info_date_mismatch");
}

async function syncFile(path) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    await handle.sync();
  } finally {
    try { await handle?.close(); } catch { /* preserve the original error */ }
  }
}

async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY);
    await handle.sync();
  } finally {
    try { await handle?.close(); } catch { /* preserve the original error */ }
  }
}

async function syncTree(root) {
  const directories = [root];
  await walkRegularFiles(root, async ({ path, info }) => {
    if (info.isDirectory()) directories.push(path);
    else if (info.isFile() && !info.isSymbolicLink()) await syncFile(path);
  });
  directories.sort((left, right) => right.split(sep).length - left.split(sep).length);
  for (const directory of directories) await syncDirectory(directory);
}

async function ensureNonOverlappingRoots(dataDir, knowledgeRoot, outputPath) {
  await assertPlainDirectory(dataDir, "data_dir_not_plain_directory");
  await assertPlainDirectory(knowledgeRoot, "knowledge_root_not_plain_directory");
  const [realData, realKnowledge] = await Promise.all([realpath(dataDir), realpath(knowledgeRoot)]);
  if (pathIsInside(realData, realKnowledge) || pathIsInside(realKnowledge, realData)) fail("source_roots_overlap");
  // Resolve the future path through its nearest existing ancestor before any
  // mkdir. This preserves the zero-write guarantee when a rejected output is
  // nested directly or through a symlink under either live source root.
  const projected = await resolveThroughExistingAncestor(outputPath);
  if (pathIsInside(projected, realData) || pathIsInside(projected, realKnowledge)) fail("backup_output_inside_source");
  if (await pathExists(projected)) fail("backup_output_exists");
  await mkdir(dirname(projected), { recursive: true, mode: 0o700 });
  const realOutputParent = await realpath(dirname(projected));
  const candidate = join(realOutputParent, basename(projected));
  if (pathIsInside(candidate, realData) || pathIsInside(candidate, realKnowledge)) fail("backup_output_inside_source");
  if (resolve(candidate) !== resolve(projected)) fail("backup_output_parent_changed");
  if (await pathExists(candidate)) fail("backup_output_exists");
  return { realData, realKnowledge, outputPath: candidate };
}

export async function createBackup({
  dataDir,
  knowledgeRoot,
  outputPath,
  createdAt = nowIso(),
  backupId = `backup_${randomUUID()}`,
  backupImpl = sqlite.backup,
} = {}) {
  if (!dataDir || !knowledgeRoot || !outputPath) fail("create_arguments_required");
  assertSafeBackupIdentity(backupId, createdAt);
  const roots = await ensureNonOverlappingRoots(resolve(dataDir), resolve(knowledgeRoot), resolve(outputPath));
  const stagingRoot = join(dirname(roots.outputPath), `.${basename(roots.outputPath)}.partial-${randomUUID()}`);
  const lockPath = join(dirname(roots.outputPath), `.${basename(roots.outputPath)}.backup-lock`);
  let lockHandle;
  let ownsLock = false;
  const files = [];
  const excludedCounts = Object.fromEntries(EXCLUSION_RULES.map((rule) => [rule, 0]));
  try {
    try {
      lockHandle = await open(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
      ownsLock = true;
      await lockHandle.writeFile(stableJson({ format: "zhitai-backup-lock", version: 1, createdAt }));
      await lockHandle.sync();
    } catch (error) {
      fail("backup_output_locked", error);
    }
    if (await pathExists(roots.outputPath)) fail("backup_output_exists");
    const stalePartialPrefix = `.${basename(roots.outputPath)}.partial-`;
    if ((await readdir(dirname(roots.outputPath))).some((name) => name.startsWith(stalePartialPrefix))) {
      fail("stale_partial_backup_requires_manual_quarantine");
    }
    await mkdir(join(stagingRoot, "data", "state"), { recursive: true, mode: 0o700 });
    await chmod(stagingRoot, 0o700);
    const dbSource = join(roots.realData, "kb.sqlite");
    const dbTarget = join(stagingRoot, "data", "state", "kb.sqlite");
    if (!await pathExists(dbSource)) fail("sqlite_database_missing");
    const { canonical: canonicalDbSource } = await assertContainedRegularFile(dbSource, roots.realData, "sqlite_database_not_regular");
    const sqliteSnapshot = await createSqliteSnapshot(canonicalDbSource, dbTarget, { backupImpl, sourceRoot: roots.realData });
    const contentSafety = auditSqliteSensitiveContent(dbTarget);
    await chmod(dbTarget, 0o600);
    const dbInfo = await stat(dbTarget);
    files.push({
      path: "data/state/kb.sqlite",
      category: "sqlite_snapshot",
      sizeBytes: dbInfo.size,
      sha256: await sha256File(dbTarget),
    });

    await collectStatePayload(roots.realData, stagingRoot, files, excludedCounts);
    await collectKnowledgePayload(roots.realKnowledge, stagingRoot, files, excludedCounts);
    const knowledgeAssets = await verifyDatabaseAssetsAgainstKnowledge(dbTarget, join(stagingRoot, "data", "knowledge"));
    files.sort((a, b) => a.path.localeCompare(b.path, "en"));
    const payloadBytes = files.reduce((sum, entry) => sum + entry.sizeBytes, 0);
    const metrics = await collectMetrics(join(stagingRoot, "data"), sqliteSnapshot.snapshot);
    const manifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      backupId,
      createdAt,
      bagItVersion: "1.0",
      software: {
        name: "zhitai-backup",
        version: "1",
        node: process.versions.node,
        sqlite: sqliteSnapshot.snapshot.sqliteVersion,
        sqliteWalResetFixStatus: sqliteWalResetFixStatus(sqliteSnapshot.snapshot.sqliteVersion),
      },
      consistency: {
        sqlite: {
          method: sqliteSnapshot.method,
          sourceJournalMode: sqliteSnapshot.source.journalMode,
          walPresentAtSnapshot: sqliteSnapshot.walPresent,
          walCoverage: sqliteSnapshot.walCoverage,
          rawWalCopied: false,
        },
        files: {
          method: "copy_with_pre_and_post_stat_stability_check",
          retries: 2,
        },
      },
      scope: {
        included: [
          "sqlite_and_committed_wal",
          "knowledge_content_packages",
          "queues",
          "audit_records",
          "generation_records",
          "schedules",
          "platform_receipts",
        ],
        exclusions: {
          policyVersion: EXCLUSION_POLICY_VERSION,
          defaultRules: EXCLUSION_RULES,
          countsByRule: excludedCounts,
        },
      },
      verification: {
        sourceIntegrityCheck: sqliteSnapshot.source.integrityCheck,
        snapshotIntegrityCheck: sqliteSnapshot.snapshot.integrityCheck,
        snapshotForeignKeyViolations: sqliteSnapshot.snapshot.foreignKeyViolations,
        contentSafety: {
          sourceDatabase: sqliteSnapshot.sourceContentSafety,
          snapshotDatabase: contentSafety,
          auditedStructuredAndTextPayload: "ok",
          unrecognizedOpaquePayload: "rejected",
          recognizedBinaryPayload: "extension_and_magic_checked_no_content_dlp",
        },
        knowledgeAssets,
      },
      metrics,
      payload: {
        fileCount: files.length,
        sizeBytes: payloadBytes,
      },
      files,
    };

    await writeFile(join(stagingRoot, "bagit.txt"), BAGIT_TEXT, { encoding: "utf8", mode: 0o600 });
    await writeFile(join(stagingRoot, "bag-info.txt"), bagInfoText({ backupId, createdAt, payloadBytes, payloadFiles: files.length }), { encoding: "utf8", mode: 0o600 });
    await writeFile(join(stagingRoot, "manifest-sha256.txt"), payloadManifestText(files), { encoding: "utf8", mode: 0o600 });
    await writeFile(join(stagingRoot, "manifest.json"), stableJson(manifest), { encoding: "utf8", mode: 0o600 });
    await writeFile(join(stagingRoot, "tagmanifest-sha256.txt"), await tagManifestText(stagingRoot), { encoding: "utf8", mode: 0o600 });
    await verifyBackup({ backupPath: stagingRoot });
    await syncTree(stagingRoot);
    if (await pathExists(roots.outputPath)) fail("backup_output_exists");
    await rename(stagingRoot, roots.outputPath);
    await syncDirectory(dirname(roots.outputPath));
    return {
      ok: true,
      backupPath: roots.outputPath,
      backupId,
      formatVersion: BACKUP_FORMAT_VERSION,
      metrics,
      payload: manifest.payload,
      sqlite: manifest.consistency.sqlite,
    };
  } catch (error) {
    try {
      if (await pathExists(stagingRoot)) await rm(stagingRoot, { recursive: true });
    } catch { /* only our uniquely named incomplete directory */ }
    if (error instanceof BackupError) throw error;
    fail("backup_create_failed", error);
  } finally {
    try { await lockHandle?.close(); } catch { /* best effort; lock file still prevents a collision */ }
    if (ownsLock) {
      try { await rm(lockPath); } catch (error) { if (error?.code !== "ENOENT") { /* stale lock is safer than clobbering */ } }
    }
    try { await syncDirectory(dirname(roots.outputPath)); } catch { /* main durability sync already determines success */ }
  }
}

function parseChecksumManifest(text, { payload }) {
  const rows = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const match = line.match(/^([0-9a-f]{64}) {2}(.+)$/);
    if (!match) fail("checksum_manifest_invalid");
    const path = assertSafeRelativePath(match[2], { payload });
    if (rows.has(path)) fail("checksum_manifest_duplicate_path");
    rows.set(path, match[1]);
  }
  return rows;
}

function validateAppManifest(manifest) {
  if (!manifest || manifest.format !== BACKUP_FORMAT || manifest.formatVersion !== BACKUP_FORMAT_VERSION) fail("unsupported_backup_format");
  if (typeof manifest.backupId !== "string" || !manifest.backupId || !Array.isArray(manifest.files)) fail("manifest_invalid");
  assertSafeBackupIdentity(manifest.backupId, manifest.createdAt);
  const seen = new Set();
  const portableSeen = new Set();
  for (const entry of manifest.files) {
    const path = assertSafeRelativePath(entry?.path, { payload: true });
    if (!path.startsWith("data/state/") && !path.startsWith("data/knowledge/")) fail("manifest_payload_namespace_invalid");
    if (seen.has(path)) fail("manifest_duplicate_path");
    seen.add(path);
    const portableKey = path.normalize("NFC").toLowerCase();
    if (portableSeen.has(portableKey)) fail("manifest_portability_collision");
    portableSeen.add(portableKey);
    if (!/^[0-9a-f]{64}$/.test(String(entry.sha256 || "")) || !Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes < 0) fail("manifest_file_entry_invalid");
    const knowledgeRel = path.startsWith("data/knowledge/") ? path.slice("data/knowledge/".length) : null;
    if (knowledgeRel && exclusionReason(knowledgeRel)) fail("manifest_contains_excluded_path");
    if (path.startsWith("data/state/")) {
      const stateRel = path.slice("data/state/".length);
      const allowedStateFile = stateRel === "kb.sqlite" || STATE_SCOPES.some((scope) => stateRel === scope.source);
      const allowedStateLedger = STATE_DIRECTORY_SCOPES.some((scope) => {
        const prefix = `${scope.source}/`;
        const leaf = stateRel.startsWith(prefix) ? stateRel.slice(prefix.length) : "";
        return leaf && !leaf.includes("/") && leaf.toLowerCase().endsWith(".json");
      });
      if ((!allowedStateFile && !allowedStateLedger) || exclusionReason(stateRel)) fail("manifest_contains_excluded_path");
    }
  }
  if (!seen.has("data/state/kb.sqlite")) fail("manifest_database_missing");
  const payloadBytes = manifest.files.reduce((sum, entry) => sum + entry.sizeBytes, 0);
  if (manifest?.payload?.fileCount !== manifest.files.length || manifest?.payload?.sizeBytes !== payloadBytes) fail("manifest_payload_summary_mismatch");
  return manifest;
}

async function enumerateBackupFiles(root) {
  const files = [];
  await walkRegularFiles(root, async ({ rel, info }) => {
    const logical = toPosixPath(rel);
    if (info.isSymbolicLink()) fail("backup_contains_symlink");
    if (info.isFile()) files.push(logical);
    else if (!info.isDirectory()) fail("backup_contains_special_file");
  });
  return files.sort((a, b) => a.localeCompare(b, "en"));
}

export async function verifyBackup({ backupPath } = {}) {
  if (!backupPath) fail("backup_path_required");
  const requestedRoot = resolve(backupPath);
  await assertPlainDirectory(requestedRoot, "backup_not_plain_directory");
  const root = await realpath(requestedRoot);
  for (const name of REQUIRED_ROOT_FILES) {
    await assertContainedRegularFile(join(root, name), root, "backup_tag_file_not_regular");
  }
  let bagitText;
  let bagInfo;
  let appManifestText;
  try {
    [bagitText, bagInfo, appManifestText] = await Promise.all([
      readFile(join(root, "bagit.txt"), "utf8"),
      readFile(join(root, "bag-info.txt"), "utf8"),
      readFile(join(root, "manifest.json"), "utf8"),
    ]);
  } catch (error) {
    fail("backup_tag_file_missing", error);
  }
  if (bagitText.replace(/\r\n/g, "\n") !== BAGIT_TEXT.replace(/\r\n/g, "\n")) fail("bagit_declaration_invalid");
  let parsed;
  try { parsed = JSON.parse(appManifestText); }
  catch (error) { fail("manifest_json_invalid", error); }
  const manifest = validateAppManifest(parsed);
  const [payloadChecksums, tagChecksums] = await Promise.all([
    readFile(join(root, "manifest-sha256.txt"), "utf8").then((text) => parseChecksumManifest(text, { payload: true })),
    readFile(join(root, "tagmanifest-sha256.txt"), "utf8").then((text) => parseChecksumManifest(text, { payload: false })),
  ]).catch((error) => {
    if (error instanceof BackupError) throw error;
    fail("checksum_manifest_missing", error);
  });
  if (tagChecksums.size !== TAG_FILES.length || TAG_FILES.some((name) => !tagChecksums.has(name))) fail("tagmanifest_scope_invalid");
  for (const [name, expected] of tagChecksums) {
    if (await sha256File(join(root, name)) !== expected) fail("tag_checksum_mismatch");
  }
  validateBagInfo(bagInfo, manifest);
  if (payloadChecksums.size !== manifest.files.length) fail("payload_manifest_count_mismatch");
  for (const entry of manifest.files) {
    if (payloadChecksums.get(entry.path) !== entry.sha256) fail("payload_checksum_catalog_mismatch");
    const path = join(root, ...entry.path.split("/"));
    let info;
    try { info = await lstat(path); }
    catch (error) { fail("payload_file_missing", error); }
    if (!info.isFile() || info.isSymbolicLink()) fail("payload_file_not_regular");
    if (info.size !== entry.sizeBytes) fail("payload_size_mismatch");
    if (await sha256File(path) !== entry.sha256) fail("payload_checksum_mismatch");
  }
  const actualFiles = await enumerateBackupFiles(root);
  const expectedFiles = [...REQUIRED_ROOT_FILES, ...manifest.files.map((entry) => entry.path)].sort((a, b) => a.localeCompare(b, "en"));
  if (actualFiles.length !== expectedFiles.length || actualFiles.some((value, index) => value !== expectedFiles[index])) fail("backup_contains_unmanifested_files");
  const database = inspectSqliteDatabase(join(root, "data", "state", "kb.sqlite"));
  if (database.integrityCheck !== "ok") fail("restored_integrity_check_failed");
  if (database.foreignKeyViolations !== 0) fail("restored_foreign_key_check_failed");
  auditSqliteSensitiveContent(join(root, "data", "state", "kb.sqlite"));
  for (const entry of manifest.files) {
    const auditMode = auditModeForPath(entry.path);
    await auditPayloadFile(join(root, ...entry.path.split("/")), auditMode);
  }
  const knowledgeAssets = await verifyDatabaseAssetsAgainstKnowledge(
    join(root, "data", "state", "kb.sqlite"),
    join(root, "data", "knowledge"),
  );
  if (stableJson(knowledgeAssets) !== stableJson(manifest?.verification?.knowledgeAssets)) fail("knowledge_asset_verification_mismatch");
  const metrics = await collectMetrics(join(root, "data"), database);
  if (stableJson(metrics) !== stableJson(manifest.metrics)) fail("backup_metric_mismatch");
  return {
    ok: true,
    backupId: manifest.backupId,
    formatVersion: manifest.formatVersion,
    fileCount: manifest.files.length,
    sizeBytes: manifest.payload.sizeBytes,
    metrics,
    integrityCheck: database.integrityCheck,
    foreignKeyViolations: database.foreignKeyViolations,
    manifestSha256: sha256Text(appManifestText),
    manifest,
  };
}

function restoreRelativePath(payloadPath) {
  if (payloadPath.startsWith("data/state/")) return `data/${payloadPath.slice("data/state/".length)}`;
  if (payloadPath.startsWith("data/knowledge/")) return `knowledge/${payloadPath.slice("data/knowledge/".length)}`;
  fail("unknown_payload_mapping");
}

async function copyManifestFilesToRestore(backupRoot, restoreRoot, files) {
  for (const entry of files) {
    const targetRelative = assertSafeRelativePath(restoreRelativePath(entry.path));
    const target = join(restoreRoot, ...targetRelative.split("/"));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const description = await copyStableFile(
      join(backupRoot, ...entry.path.split("/")),
      target,
      backupRoot,
      { auditMode: auditModeForPath(entry.path), exclusiveTarget: true },
    );
    if (description.sizeBytes !== entry.sizeBytes || description.sha256 !== entry.sha256) fail("restored_file_checksum_mismatch");
  }
}

export async function restoreBackup({ backupPath, tempParent = tmpdir(), prefix = "zhitai-restore-v1-" } = {}) {
  if (!backupPath) fail("backup_path_required");
  if (typeof prefix !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(prefix) || prefix === "." || prefix === ".." || prefix.includes("..")) {
    fail("restore_prefix_invalid");
  }
  const root = resolve(backupPath);
  const verification = await verifyBackup({ backupPath: root });
  const parent = resolve(tempParent);
  const realBackup = await realpath(root);
  const parentCandidate = await resolveThroughExistingAncestor(parent);
  if (pathIsInside(parentCandidate, realBackup)) fail("restore_parent_inside_backup");
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const realParent = await realpath(parent);
  if (pathIsInside(realParent, realBackup)) fail("restore_parent_inside_backup");
  let restoreRoot;
  try {
    restoreRoot = await mkdtemp(join(realParent, prefix));
    await chmod(restoreRoot, 0o700);
    await copyManifestFilesToRestore(realBackup, restoreRoot, verification.manifest.files);
    const database = inspectSqliteDatabase(join(restoreRoot, "data", "kb.sqlite"));
    const metrics = await collectMetrics(restoreRoot, database);
    const restoredPayloadFileCount = await countAllRegularFiles(restoreRoot);
    if (stableJson(metrics) !== stableJson(verification.metrics)) fail("restore_metric_mismatch");
    const report = {
      reportFormat: "zhitai-restore-report",
      reportVersion: 1,
      restoreId: `restore_${randomUUID()}`,
      backupId: verification.backupId,
      restoredAt: nowIso(),
      mode: "temporary_isolated_directory",
      currentDataModified: false,
      checks: {
        manifest: "ok",
        payloadSha256: "ok",
        restoredFileSha256: "ok",
        integrityCheck: database.integrityCheck,
        foreignKeyViolations: database.foreignKeyViolations,
        assetCountMatches: metrics.videoAssetCount === verification.metrics.videoAssetCount,
        taskCountMatches: metrics.taskCount === verification.metrics.taskCount,
        fileCountMatches: restoredPayloadFileCount === verification.manifest.files.length,
      },
      metrics,
    };
    await writeFile(join(restoreRoot, "restore-report.json"), stableJson(report), { encoding: "utf8", mode: 0o600 });
    return { ok: true, restoreRoot, report, verification };
  } catch (error) {
    if (restoreRoot) {
      try { await rm(restoreRoot, { recursive: true }); } catch { /* only our mkdtemp directory */ }
    }
    if (error instanceof BackupError) throw error;
    fail("restore_failed", error);
  }
}

async function inspectTargetConflicts(targetRoot, manifest) {
  if (!await pathExists(targetRoot)) return { exists: false, sameFiles: 0, conflictingFiles: 0, missingFiles: manifest.files.length };
  const info = await lstat(targetRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) return { exists: true, sameFiles: 0, conflictingFiles: manifest.files.length, missingFiles: 0 };
  let sameFiles = 0;
  let conflictingFiles = 0;
  let missingFiles = 0;
  for (const entry of manifest.files) {
    const relativeTarget = restoreRelativePath(entry.path);
    const target = join(targetRoot, ...relativeTarget.split("/"));
    if (!await pathExists(target)) {
      missingFiles += 1;
      continue;
    }
    const targetInfo = await lstat(target);
    if (targetInfo.isFile() && !targetInfo.isSymbolicLink() && targetInfo.size === entry.sizeBytes && await sha256File(target) === entry.sha256) sameFiles += 1;
    else conflictingFiles += 1;
  }
  return { exists: true, sameFiles, conflictingFiles, missingFiles };
}

function countAbsolutePathReferences(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const counts = {};
    const candidates = [
      ["video_asset", "file_path"],
      ["video_asset", "package_path"],
      ["legacy_package", "package_path"],
      ["platform_post", "raw_json_path"],
      ["import_item", "input"],
    ];
    for (const [table, column] of candidates) {
      const key = `${table}.${column}`;
      if (!tableExists(db, table) || !db.prepare(`PRAGMA table_info("${table}")`).all().some((row) => row.name === column)) {
        counts[key] = 0;
        continue;
      }
      counts[key] = Number(db.prepare(`SELECT COUNT(*) AS count FROM "${table}" WHERE "${column}" LIKE '/%'`).get().count);
    }
    return counts;
  } finally {
    db.close();
  }
}

export async function previewMigration({ backupPath, targetRoot } = {}) {
  if (!backupPath || !targetRoot) fail("migration_preview_arguments_required");
  const verification = await verifyBackup({ backupPath });
  const target = await resolveThroughExistingAncestor(targetRoot);
  const realBackup = await realpath(resolve(backupPath));
  const overlapsBackup = pathIsInside(target, realBackup) || pathIsInside(realBackup, target);
  const conflicts = await inspectTargetConflicts(target, verification.manifest);
  const pathReferences = countAbsolutePathReferences(join(resolve(backupPath), "data", "state", "kb.sqlite"));
  return {
    ok: true,
    backupId: verification.backupId,
    targetRoot: target,
    canMigrate: !conflicts.exists && !overlapsBackup,
    blockedReason: conflicts.exists ? "target_already_exists" : overlapsBackup ? "target_overlaps_backup" : null,
    conflicts,
    pathRebindPreview: {
      absoluteReferenceCounts: pathReferences,
      strategy: "rebind_only_paths_resolved_inside_restored_knowledge_tree",
      unresolvedExternalPathsRemainHistoricalOnly: true,
    },
    safety: {
      existingTargetWillBeOverwritten: false,
      scheduledPublishRequiresReapproval: true,
      activeGenerationJobsWillBePaused: true,
      rollbackMode: "recoverable_rename_to_quarantine",
    },
    metrics: verification.metrics,
  };
}

async function knowledgeFileIndex(knowledgeRoot) {
  const byBasename = new Map();
  const packageDirs = new Set();
  const packageDirsByAssetId = new Map();
  const files = new Set();
  if (!await pathExists(knowledgeRoot)) return { byBasename, packageDirs, packageDirsByAssetId, files };
  await walkRegularFiles(knowledgeRoot, async ({ path, info }) => {
    if (!info.isFile()) return;
    files.add(path);
    const name = basename(path);
    if (!byBasename.has(name)) byBasename.set(name, []);
    byBasename.get(name).push(path);
    if (name === "metadata.json") {
      const packageDir = dirname(path);
      packageDirs.add(packageDir);
      try {
        const metadata = JSON.parse(await readFile(path, "utf8"));
        if (metadata?.id !== null && metadata?.id !== undefined) {
          const id = String(metadata.id);
          if (!packageDirsByAssetId.has(id)) packageDirsByAssetId.set(id, []);
          packageDirsByAssetId.get(id).push(packageDir);
        }
      } catch (error) {
        fail("migration_metadata_invalid", error);
      }
    }
  });
  return { byBasename, packageDirs, packageDirsByAssetId, files };
}

function uniquePackageMatch(oldPath, assetId, packageDirs, packageDirsByAssetId) {
  const oldName = oldPath ? basename(oldPath) : "";
  const candidates = new Set(packageDirsByAssetId.get(String(assetId)) || []);
  for (const dir of packageDirs) {
    const name = basename(dir);
    if ((oldName && name === oldName) || name === assetId || name === `kb_${assetId}`) candidates.add(dir);
  }
  return candidates.size === 1 ? [...candidates][0] : null;
}

function uniqueFileInsidePackage(oldPath, oldPackagePath, packageDir, byBasename, files) {
  if (!oldPath || !packageDir) return null;
  if (oldPackagePath && isAbsolute(oldPath) && isAbsolute(oldPackagePath)) {
    const oldRelative = relative(oldPackagePath, oldPath);
    if (oldRelative && !oldRelative.startsWith(`..${sep}`) && oldRelative !== ".." && !isAbsolute(oldRelative)) {
      const exact = join(packageDir, oldRelative);
      if (files.has(exact)) return exact;
    }
  }
  const name = basename(oldPath);
  const candidates = (byBasename.get(name) || []).filter((path) => pathIsInside(path, packageDir));
  return candidates.length === 1 ? candidates[0] : null;
}

async function rebindMigratedDatabase(dbPath, stagedKnowledgeRoot, finalKnowledgeRoot) {
  const { byBasename, packageDirs, packageDirsByAssetId, files } = await knowledgeFileIndex(stagedKnowledgeRoot);
  const db = new DatabaseSync(dbPath);
  const oldToNew = new Map();
  const stagedPackageByAsset = new Map();
  const stats = {
    rebound: 0,
    unresolved: 0,
    blockingUnresolved: 0,
    historicalUnresolved: 0,
    importItemsPaused: 0,
    importBatchesPaused: 0,
    importPathsRebound: 0,
  };
  try {
    db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    if (tableExists(db, "video_asset")) {
      const rows = db.prepare("SELECT id, file_path, package_path FROM video_asset").all();
      const update = db.prepare("UPDATE video_asset SET file_path=?, package_path=? WHERE id=?");
      for (const row of rows) {
        const packagePath = uniquePackageMatch(row.package_path, String(row.id), packageDirs, packageDirsByAssetId);
        const filePath = uniqueFileInsidePackage(row.file_path, row.package_path, packagePath, byBasename, files);
        if (packagePath && filePath) {
          const finalPackagePath = join(finalKnowledgeRoot, relative(stagedKnowledgeRoot, packagePath));
          const finalFilePath = join(finalKnowledgeRoot, relative(stagedKnowledgeRoot, filePath));
          if (row.package_path) oldToNew.set(String(row.package_path), finalPackagePath);
          if (row.file_path) oldToNew.set(String(row.file_path), finalFilePath);
          update.run(finalFilePath, finalPackagePath, row.id);
          stagedPackageByAsset.set(String(row.id), { packagePath, oldPackagePath: row.package_path });
          stats.rebound += 2;
        } else {
          const unresolved = Number(Boolean(row.package_path)) + Number(Boolean(row.file_path));
          stats.unresolved += unresolved;
          stats.blockingUnresolved += unresolved;
        }
      }
    }
    if (tableExists(db, "legacy_package")) {
      const rows = db.prepare("SELECT id, asset_id, package_path FROM legacy_package").all();
      const update = db.prepare("UPDATE legacy_package SET package_path=? WHERE id=?");
      for (const row of rows) {
        const match = uniquePackageMatch(row.package_path, String(row.asset_id), packageDirs, packageDirsByAssetId);
        if (match) {
          const finalMatch = join(finalKnowledgeRoot, relative(stagedKnowledgeRoot, match));
          if (row.package_path) oldToNew.set(String(row.package_path), finalMatch);
          update.run(finalMatch, row.id);
          stats.rebound += 1;
        } else if (row.package_path) {
          stats.unresolved += 1;
          stats.blockingUnresolved += 1;
        }
      }
    }
    if (tableExists(db, "platform_post") && db.prepare("PRAGMA table_info(platform_post)").all().some((row) => row.name === "raw_json_path")) {
      const rows = db.prepare("SELECT id, asset_id, raw_json_path FROM platform_post WHERE raw_json_path IS NOT NULL").all();
      const update = db.prepare("UPDATE platform_post SET raw_json_path=? WHERE id=?");
      for (const row of rows) {
        const assetPackage = stagedPackageByAsset.get(String(row.asset_id)) || null;
        const packagePath = assetPackage?.packagePath
          || uniquePackageMatch(null, String(row.asset_id), packageDirs, packageDirsByAssetId);
        const match = uniqueFileInsidePackage(row.raw_json_path, assetPackage?.oldPackagePath, packagePath, byBasename, files);
        if (match) {
          const finalMatch = join(finalKnowledgeRoot, relative(stagedKnowledgeRoot, match));
          oldToNew.set(String(row.raw_json_path), finalMatch);
          update.run(finalMatch, row.id);
          stats.rebound += 1;
        } else {
          stats.unresolved += 1;
          stats.blockingUnresolved += 1;
        }
      }
    }
    if (tableExists(db, "import_item")) {
      const columns = new Set(db.prepare("PRAGMA table_info(import_item)").all().map((row) => row.name));
      const selected = ["id", ...(columns.has("input") ? ["input"] : []), ...(columns.has("status") ? ["status"] : [])];
      const activeStatuses = new Set(["pending", "processing", "running", "queued", "retrying", "awaiting_primary_download"]);
      for (const row of db.prepare(`SELECT ${selected.map(quoteIdentifier).join(", ")} FROM import_item`).all()) {
        const active = columns.has("status") ? activeStatuses.has(String(row.status || "").toLowerCase()) : true;
        const assignments = [];
        const values = [];
        if (columns.has("input") && row.input) {
          const reboundInput = oldToNew.get(String(row.input));
          if (reboundInput) {
            assignments.push(`${quoteIdentifier("input") }=?`);
            values.push(reboundInput);
            oldToNew.set(String(row.input), reboundInput);
            stats.rebound += 1;
            stats.importPathsRebound += 1;
          } else if (isAbsolute(String(row.input))) {
            stats.unresolved += 1;
            if (active) stats.blockingUnresolved += 1;
            else stats.historicalUnresolved += 1;
          }
        }
        if (active && columns.has("status")) {
          assignments.push(`${quoteIdentifier("status") }=?`);
          values.push("needs_attention");
          if (columns.has("error")) {
            assignments.push(`${quoteIdentifier("error") }=?`);
            values.push("migration_reapproval_required");
          }
          stats.importItemsPaused += 1;
        }
        if (assignments.length > 0) {
          values.push(row.id);
          db.prepare(`UPDATE import_item SET ${assignments.join(", ")} WHERE ${quoteIdentifier("id") }=?`).run(...values);
        }
      }
    }
    if (tableExists(db, "import_batch")) {
      const columns = new Set(db.prepare("PRAGMA table_info(import_batch)").all().map((row) => row.name));
      if (columns.has("status") && columns.has("id")) {
        const activeStatuses = ["pending", "processing", "running", "queued", "retrying", "awaiting_primary_download"];
        const placeholders = activeStatuses.map(() => "?").join(", ");
        const result = db.prepare(`UPDATE import_batch SET status='needs_attention' WHERE lower(COALESCE(status,'')) IN (${placeholders})`).run(...activeStatuses);
        stats.importBatchesPaused = Number(result.changes || 0);
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    try { if (db.isTransaction) db.exec("ROLLBACK"); } catch { /* preserve original */ }
    fail("migration_path_rebind_failed", error);
  } finally {
    db.close();
  }
  return { ...stats, oldToNew };
}

function deepReplaceKnownPaths(value, pathMap) {
  if (typeof value === "string") return pathMap.get(value) || value;
  if (Array.isArray(value)) return value.map((entry) => deepReplaceKnownPaths(entry, pathMap));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, deepReplaceKnownPaths(entry, pathMap)]));
}

async function rewriteJsonPaths(path, pathMap) {
  if (!await pathExists(path)) return 0;
  let value;
  try { value = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { fail("migration_json_invalid", error); }
  const rewritten = deepReplaceKnownPaths(value, pathMap);
  const before = stableJson(value);
  const after = stableJson(rewritten);
  if (before === after) return 0;
  await writeFile(path, after, { encoding: "utf8", mode: 0o600 });
  return 1;
}

async function safeguardMigratedQueues(restoreRoot, pathMap) {
  const actions = {
    publishTasksReapprovalRequired: 0,
    publishJobFilesReapprovalRequired: 0,
    publisherSchedulesReapprovalRequired: 0,
    analysisJobsPaused: 0,
    creativeJobsPaused: 0,
    resupplyCommandsPaused: 0,
    watcherEntriesReset: 0,
    jsonFilesPathRewritten: 0,
  };
  const tasksPath = join(restoreRoot, "data", "tasks.json");
  if (await pathExists(tasksPath)) {
    const original = await readJsonIfPresent(tasksPath, []);
    const tasks = deepReplaceKnownPaths(original, pathMap);
    if (Array.isArray(tasks)) {
      for (const task of tasks) {
        if (task?.type === "publish" && ["queued", "running", "scheduled"].includes(task.status)) {
          task.migrationOriginalStatus = task.status;
          task.status = "needs_attention";
          task.approved = false;
          task.errorCode = "migration_reapproval_required";
          actions.publishTasksReapprovalRequired += 1;
        }
      }
    }
    await writeFile(tasksPath, stableJson(tasks), { encoding: "utf8", mode: 0o600 });
  }

  const publishDir = join(restoreRoot, "data", "publish-jobs");
  if (await pathExists(publishDir)) {
    await walkRegularFiles(publishDir, async ({ path, info }) => {
      if (!info.isFile() || !path.toLowerCase().endsWith(".json")) return;
      const job = deepReplaceKnownPaths(await readJsonIfPresent(path, {}), pathMap);
      if (["queued", "running", "scheduled"].includes(job?.status)) {
        job.migrationOriginalStatus = job.status;
        job.status = "needs_attention";
        job.approved = false;
        job.errorCode = "migration_reapproval_required";
        actions.publishJobFilesReapprovalRequired += 1;
      }
      await writeFile(path, stableJson(job), { encoding: "utf8", mode: 0o600 });
    });
  }

  const creativePath = join(restoreRoot, "data", "creative-jobs.json");
  if (await pathExists(creativePath)) {
    const jobs = await readJsonIfPresent(creativePath, []);
    if (Array.isArray(jobs)) {
      for (const job of jobs) {
        if (["queued", "preparing", "retry_wait", "transient_wait", "ready_for_images", "ready_for_seedance", "ready_for_assembly"].includes(job?.status)) {
          job.migrationOriginalStatus = job.status;
          job.status = "paused";
          job.error = null;
          actions.creativeJobsPaused += 1;
        }
      }
    }
    await writeFile(creativePath, stableJson(jobs), { encoding: "utf8", mode: 0o600 });
  }

  const analysisPath = join(restoreRoot, "data", "analysis-jobs.json");
  if (await pathExists(analysisPath)) {
    const jobs = deepReplaceKnownPaths(await readJsonIfPresent(analysisPath, []), pathMap);
    if (Array.isArray(jobs)) {
      for (const job of jobs) {
        if (["queued", "running", "retry_wait"].includes(job?.status)) {
          job.migrationOriginalStatus = job.status;
          job.status = "paused";
          job.progress = 0;
          job.nextAttemptAt = null;
          job.error = null;
          actions.analysisJobsPaused += 1;
        }
      }
    }
    await writeFile(analysisPath, stableJson(jobs), { encoding: "utf8", mode: 0o600 });
  }

  const publisherSchedulePath = join(restoreRoot, "data", "publisher-schedule.json");
  if (await pathExists(publisherSchedulePath)) {
    const store = deepReplaceKnownPaths(await readJsonIfPresent(publisherSchedulePath, { version: 1, revision: 0, tasks: [] }), pathMap);
    const scheduledTasks = Array.isArray(store) ? store : store?.tasks;
    if (!Array.isArray(scheduledTasks)) fail("migration_publisher_schedule_invalid");
    for (const task of scheduledTasks) {
      if (!["scheduled", "queued", "retry_wait", "preflighting", "submitting"].includes(task?.status)) continue;
      task.migrationOriginalStatus = task.status;
      task.status = task.status === "submitting" ? "needs_reconciliation" : "needs_attention";
      task.error = "migration_reapproval_required";
      task.claim = null;
      task.nextAttemptAt = null;
      task.approved = false;
      for (const target of Array.isArray(task.targets) ? task.targets : []) {
        if (target?.status === "submitting") {
          target.migrationOriginalStatus = target.status;
          target.status = "unknown";
          target.error = "migration_reconciliation_required";
        } else if (target?.status === "pending") {
          target.migrationOriginalStatus = target.status;
          target.status = "failed";
          target.error = "migration_reapproval_required";
        }
      }
      actions.publisherSchedulesReapprovalRequired += 1;
    }
    await writeFile(publisherSchedulePath, stableJson(store), { encoding: "utf8", mode: 0o600 });
  }

  const creativeReviewsPath = join(restoreRoot, "data", "creative-reviews.json");
  actions.jsonFilesPathRewritten += await rewriteJsonPaths(creativeReviewsPath, pathMap);

  const commandPath = join(restoreRoot, "data", "kuaidian-commands.json");
  if (await pathExists(commandPath)) {
    const commands = await readJsonIfPresent(commandPath, []);
    if (Array.isArray(commands)) {
      for (const command of commands) {
        if (command?.status === "queued") {
          command.migrationOriginalStatus = command.status;
          command.status = "needs_attention";
          command.reasonZh = "迁移后需人工重新确认";
          actions.resupplyCommandsPaused += 1;
        }
      }
    }
    await writeFile(commandPath, stableJson(commands), { encoding: "utf8", mode: 0o600 });
  }

  const watcherPath = join(restoreRoot, "data", "watcher-state.json");
  if (await pathExists(watcherPath)) {
    const watcher = await readJsonIfPresent(watcherPath, { processed: [], files: {} });
    actions.watcherEntriesReset = Object.keys(watcher?.files || {}).length;
    await writeFile(watcherPath, stableJson({ processed: [], files: {}, migrationReset: true }), { encoding: "utf8", mode: 0o600 });
  }

  const metadataPaths = [];
  const knowledgeRoot = join(restoreRoot, "knowledge");
  if (await pathExists(knowledgeRoot)) {
    await walkRegularFiles(knowledgeRoot, async ({ path, info }) => {
      if (info.isFile() && basename(path) === "metadata.json") metadataPaths.push(path);
    });
  }
  for (const path of metadataPaths) actions.jsonFilesPathRewritten += await rewriteJsonPaths(path, pathMap);
  return actions;
}

async function treeDigest(root, ignoredNames = new Set()) {
  const entries = [];
  await walkRegularFiles(root, async ({ path, rel, info }) => {
    if (!info.isFile() || ignoredNames.has(basename(rel))) return;
    entries.push({ path: toPosixPath(rel), sizeBytes: info.size, sha256: await sha256File(path) });
  });
  entries.sort((a, b) => a.path.localeCompare(b.path, "en"));
  return { entries, sha256: sha256Text(stableJson(entries)) };
}

async function copyTreeExclusive(sourceRoot, targetRoot) {
  await walkRegularFiles(sourceRoot, async ({ path, rel, info }) => {
    const target = join(targetRoot, rel);
    if (info.isDirectory()) {
      await mkdir(target, { mode: 0o700 });
      return;
    }
    if (!info.isFile() || info.isSymbolicLink()) fail("migration_stage_contains_special_file");
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await copyFile(path, target, fsConstants.COPYFILE_EXCL);
    await chmod(target, 0o600);
  });
}

async function quarantineFailedMigration({ targetCandidate, targetIdentity, realParent, migrationId, errorCode }) {
  let current;
  try { current = await lstat(targetCandidate); }
  catch { return false; }
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== targetIdentity.dev || current.ino !== targetIdentity.ino) return false;
  const quarantineContainer = await mkdtemp(join(realParent, `.${basename(targetCandidate)}.migration-failed-`));
  await chmod(quarantineContainer, 0o700);
  const quarantinePayload = join(quarantineContainer, "payload");
  let renamed = false;
  try {
    await rename(targetCandidate, quarantinePayload);
    renamed = true;
    await writeFile(join(quarantineContainer, "failure.json"), stableJson({
      format: "zhitai-migration-failure",
      version: 1,
      migrationId,
      failedAt: nowIso(),
      errorCode,
      targetDeleted: false,
      recoverable: true,
    }), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await syncTree(quarantineContainer);
    await syncDirectory(realParent);
    return true;
  } catch {
    if (!renamed) {
      try { await rm(quarantineContainer, { recursive: true }); } catch { /* empty unique failure container */ }
    }
    return renamed;
  }
}

export async function migrateBackup({ backupPath, targetRoot, copyTreeImpl = copyTreeExclusive } = {}) {
  if (!backupPath || !targetRoot) fail("migration_arguments_required");
  const preview = await previewMigration({ backupPath, targetRoot });
  if (!preview.canMigrate) {
    fail(preview.blockedReason === "target_overlaps_backup" ? "migration_target_overlaps_backup" : "migration_target_exists");
  }
  const target = resolve(targetRoot);
  const targetParent = dirname(target);
  await mkdir(targetParent, { recursive: true, mode: 0o700 });
  const realBackup = await realpath(resolve(backupPath));
  const realParent = await realpath(targetParent);
  const targetCandidate = join(realParent, basename(target));
  if (pathIsInside(targetCandidate, realBackup) || pathIsInside(realBackup, targetCandidate)) fail("migration_target_overlaps_backup");
  const migrationId = `migration_${randomUUID()}`;
  let restored;
  let targetIdentity = null;
  try {
    restored = await restoreBackup({ backupPath, tempParent: realParent, prefix: ".zhitai-migration-stage-" });
    const finalKnowledgeRoot = join(targetCandidate, "knowledge");
    const currentStageKnowledge = join(restored.restoreRoot, "knowledge");
    const rebind = await rebindMigratedDatabase(
      join(restored.restoreRoot, "data", "kb.sqlite"),
      currentStageKnowledge,
      finalKnowledgeRoot,
    );
    const safetyActions = await safeguardMigratedQueues(restored.restoreRoot, rebind.oldToNew);
    const postTransformDb = inspectSqliteDatabase(join(restored.restoreRoot, "data", "kb.sqlite"));
    if (postTransformDb.integrityCheck !== "ok" || postTransformDb.foreignKeyViolations !== 0) fail("migration_transformed_database_invalid");
    const stageDigest = await treeDigest(restored.restoreRoot);

    await mkdir(targetCandidate, { mode: 0o700 });
    const createdTargetInfo = await lstat(targetCandidate);
    if (!createdTargetInfo.isDirectory() || createdTargetInfo.isSymbolicLink()) fail("migration_target_not_plain_directory");
    targetIdentity = { dev: createdTargetInfo.dev, ino: createdTargetInfo.ino };
    const pending = {
      markerFormat: "zhitai-migration-marker",
      markerVersion: 1,
      migrationId,
      backupId: restored.verification.backupId,
      targetRootFingerprint: sha256Text(targetCandidate),
      targetIdentityFingerprint: sha256Text(`${targetIdentity.dev}:${targetIdentity.ino}`),
      status: "copying",
      createdAt: nowIso(),
    };
    const pendingPath = join(targetCandidate, ".zhitai-migration.pending.json");
    await writeFile(pendingPath, stableJson(pending), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await copyTreeImpl(restored.restoreRoot, targetCandidate);
    const targetDigest = await treeDigest(targetCandidate, new Set([".zhitai-migration.pending.json"]));
    if (stageDigest.sha256 !== targetDigest.sha256) fail("migration_copy_checksum_mismatch");
    await syncTree(targetCandidate);
    const marker = {
      ...pending,
      status: rebind.blockingUnresolved > 0 ? "blocked_needs_attention" : "ready_not_activated",
      completedAt: nowIso(),
      originalCurrentDataModified: false,
      networkOrPublishActionsPerformed: false,
      rollbackMode: "recoverable_rename_to_quarantine",
      pathRebind: {
        rebound: rebind.rebound,
        unresolved: rebind.unresolved,
        blockingUnresolved: rebind.blockingUnresolved,
        historicalUnresolved: rebind.historicalUnresolved,
        importItemsPaused: rebind.importItemsPaused,
        importBatchesPaused: rebind.importBatchesPaused,
        importPathsRebound: rebind.importPathsRebound,
      },
      safetyActions,
      integrityCheck: postTransformDb.integrityCheck,
      foreignKeyViolations: postTransformDb.foreignKeyViolations,
      treeSha256: targetDigest.sha256,
    };
    const finalMarkerPath = join(targetCandidate, ".zhitai-migration.json");
    const finalMarkerTemp = join(targetCandidate, `.zhitai-migration.final-${randomUUID()}.tmp`);
    await writeFile(finalMarkerTemp, stableJson(marker), { encoding: "utf8", mode: 0o600, flag: "wx" });
    await syncFile(finalMarkerTemp);
    await rename(finalMarkerTemp, finalMarkerPath);
    await syncDirectory(targetCandidate);
    await rm(pendingPath);
    await syncDirectory(targetCandidate);
    await syncDirectory(realParent);
    try { await rm(restored.restoreRoot, { recursive: true }); } catch { /* verified staging copy can remain safely */ }
    return { ok: true, targetRoot: targetCandidate, migrationId, status: marker.status, marker };
  } catch (error) {
    if (restored?.restoreRoot) {
      try { await rm(restored.restoreRoot, { recursive: true }); } catch { /* only isolated staging */ }
    }
    let targetQuarantined = false;
    if (targetIdentity) {
      try {
        targetQuarantined = await quarantineFailedMigration({
          targetCandidate,
          targetIdentity,
          realParent,
          migrationId,
          errorCode: error instanceof BackupError ? error.code : "migration_failed",
        });
      } catch { /* preserve the original migration error and flag manual recovery */ }
    }
    const migrationError = error instanceof BackupError ? error : new BackupError("migration_failed", error);
    migrationError.details = { migrationId, targetQuarantined, manualRecoveryRequired: Boolean(targetIdentity && !targetQuarantined) };
    throw migrationError;
  }
}

function safeRollbackTarget(target) {
  const resolved = resolve(target);
  if (resolved === resolve(sep) || resolved === resolve(homedir()) || basename(resolved) === "") fail("rollback_target_too_broad");
  return resolved;
}

export async function rollbackMigration({ targetRoot, migrationId } = {}) {
  if (!targetRoot || !migrationId) fail("rollback_arguments_required");
  if (!/^migration_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(migrationId))) {
    fail("rollback_migration_id_invalid");
  }
  const target = safeRollbackTarget(targetRoot);
  await assertPlainDirectory(target, "rollback_target_not_plain_directory");
  const realTarget = await realpath(target);
  const targetInfo = await lstat(realTarget);
  let markerPath = join(target, ".zhitai-migration.json");
  if (!await pathExists(markerPath)) markerPath = join(target, ".zhitai-migration.pending.json");
  let marker;
  try {
    const { canonical } = await assertContainedRegularFile(markerPath, realTarget, "rollback_marker_invalid");
    marker = JSON.parse(await readFile(canonical, "utf8"));
  }
  catch (error) {
    if (error instanceof BackupError) throw error;
    fail("rollback_marker_missing", error);
  }
  if (marker?.markerFormat !== "zhitai-migration-marker" || marker?.migrationId !== migrationId) fail("rollback_migration_id_mismatch");
  if (marker?.targetRootFingerprint !== sha256Text(realTarget)) fail("rollback_target_fingerprint_mismatch");
  if (marker?.targetIdentityFingerprint !== sha256Text(`${targetInfo.dev}:${targetInfo.ino}`)) fail("rollback_target_identity_mismatch");
  if (marker?.treeSha256) {
    const currentDigest = await treeDigest(realTarget, new Set([".zhitai-migration.json", ".zhitai-migration.pending.json"]));
    if (currentDigest.sha256 !== marker.treeSha256) fail("rollback_target_changed_since_migration");
  }
  const quarantineContainer = await mkdtemp(join(dirname(realTarget), `.${basename(realTarget)}.rolled-back-`));
  await chmod(quarantineContainer, 0o700);
  const quarantine = join(quarantineContainer, "payload");
  try {
    await rename(realTarget, quarantine);
  } catch (error) {
    try { await rm(quarantineContainer, { recursive: true }); } catch { /* empty unique rollback container */ }
    fail("rollback_rename_failed", error);
  }
  return {
    ok: true,
    migrationId,
    targetRoot: realTarget,
    quarantineRoot: quarantine,
    recoverable: true,
    deleted: false,
  };
}
