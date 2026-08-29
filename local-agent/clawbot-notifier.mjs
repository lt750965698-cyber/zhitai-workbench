import { watch } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { createHmac, randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

const APPLICATIONS_ROOT = resolve(process.env.ZHITAI_APPLICATIONS_DIR || join(homedir(), "Applications"));
const OPENCLAW_RUNTIME_ROOT = resolve(process.env.ZHITAI_OPENCLAW_RUNTIME_DIR
  || join(APPLICATIONS_ROOT, "openclaw-runtime"));
const OPENCLAW_WEIXIN_ROOT = resolve(process.env.ZHITAI_OPENCLAW_WEIXIN_DIR
  || join(APPLICATIONS_ROOT, "openclaw-weixin"));
const DEFAULT_STATE_DIR = join(OPENCLAW_RUNTIME_ROOT, "state");
const DEFAULT_SEND_MODULE = join(OPENCLAW_WEIXIN_ROOT, "dist", "src", "messaging", "send.js");
const DEFAULT_SEND_MEDIA_MODULE = join(OPENCLAW_WEIXIN_ROOT, "dist", "src", "messaging", "send-media.js");
const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { return fallback; }
}

function safeError(error) {
  const text = String(error?.message || error || "clawbot_send_failed");
  if (/context.{0,24}(expired|missing|invalid|stale)|(?:expired|missing|invalid|stale).{0,24}context/i.test(text)) return "clawbot_session_refresh_required";
  if (/token|context|credential|cookie/i.test(text)) return "clawbot_session_unavailable";
  return text.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 160);
}

/**
 * 直接复用已安装的腾讯 openclaw-weixin 官方发送模块，不经过模型。
 * 账号 token/context token 只从本机读取并交给微信官方 API，不返回、不记录。
 */
export class ClawBotNotifier {
  #fingerprintKey;

  constructor({
    dataDir,
    stateDir = DEFAULT_STATE_DIR,
    sendModule = DEFAULT_SEND_MODULE,
    sendMediaModule = DEFAULT_SEND_MEDIA_MODULE,
    sendImpl = null,
    sendMediaImpl = null,
    watchImpl = watch,
    fingerprintKey = null,
  } = {}) {
    this.remoteSettingsPath = join(dataDir, "remote-control-settings.json");
    this.stateDir = stateDir;
    this.accountRoot = join(this.stateDir, "openclaw-weixin", "accounts");
    this.sendModule = sendModule;
    this.sendMediaModule = sendMediaModule;
    this.sendImpl = sendImpl;
    this.sendMediaImpl = sendMediaImpl;
    this.watchImpl = watchImpl;
    this.#fingerprintKey = Buffer.isBuffer(fingerprintKey)
      ? Buffer.from(fingerprintKey)
      : randomBytes(32);
  }

  async #resolveTargets({ includeAllAccountMatches = false } = {}) {
    const remote = await readJson(this.remoteSettingsPath, {});
    const senders = Array.isArray(remote?.allowedSenders)
      ? [...new Set(remote.allowedSenders.map(String).filter((item) => /@im\.wechat$/i.test(item)))].slice(0, 8)
      : [];
    const accountIds = await readJson(join(this.stateDir, "openclaw-weixin", "accounts.json"), []);
    const accounts = Array.isArray(accountIds) ? [...new Set(accountIds.map(String).filter(Boolean))] : [];
    const targets = [];
    for (const sender of senders) {
      for (const accountId of accounts) {
        const account = await readJson(join(this.accountRoot, `${accountId}.json`), null);
        const contextTokensPath = join(this.accountRoot, `${accountId}.context-tokens.json`);
        const contextTokens = await readJson(contextTokensPath, {});
        if (!account?.token || typeof contextTokens?.[sender] !== "string" || !contextTokens[sender]) continue;
        const contextUpdatedAt = await stat(contextTokensPath).then((value) => value.mtime.toISOString()).catch(() => null);
        targets.push({
          to: sender,
          accountId,
          token: String(account.token),
          baseUrl: String(account.baseUrl || DEFAULT_BASE_URL),
          cdnBaseUrl: String(account.cdnBaseUrl || DEFAULT_CDN_BASE_URL),
          contextToken: String(contextTokens[sender]),
          contextUpdatedAt,
        });
        if (!includeAllAccountMatches) break;
      }
    }
    return targets;
  }

  #fingerprint(namespace, ...values) {
    const hmac = createHmac("sha256", this.#fingerprintKey);
    hmac.update(String(namespace));
    for (const value of values) {
      hmac.update("\0");
      hmac.update(String(value));
    }
    return hmac.digest("hex");
  }

  #safeFreshness(target) {
    return {
      targetFingerprint: this.#fingerprint("clawbot-target-v1", target.accountId, target.to),
      contextFingerprint: this.#fingerprint(
        "clawbot-context-v1",
        target.accountId,
        target.to,
        target.contextToken,
      ),
      contextUpdatedAt: target.contextUpdatedAt || null,
    };
  }

  /**
   * Select the one paired ClawBot conversation that a fixed desktop keepalive
   * can safely refresh. The opaque HMACs are process-local capabilities: no
   * sender, account id, credential, or context token leaves this class.
   */
  async selectUniqueKeepaliveTarget() {
    const targets = await this.#resolveTargets({ includeAllAccountMatches: true });
    if (!targets.length) return { ok: false, error: "clawbot_target_unavailable" };
    if (targets.length !== 1) return { ok: false, error: "clawbot_target_ambiguous" };
    return { ok: true, ...this.#safeFreshness(targets[0]) };
  }

  /**
   * Reread freshness only for the exact process-local target selected above.
   * A changed target set, account mapping, or invalid opaque id fails closed.
   */
  async readKeepaliveTargetFreshness(targetFingerprint) {
    if (!/^[a-f0-9]{64}$/.test(String(targetFingerprint || ""))) {
      return { ok: false, error: "clawbot_target_changed" };
    }
    const targets = await this.#resolveTargets({ includeAllAccountMatches: true });
    if (targets.length !== 1) {
      return {
        ok: false,
        error: targets.length ? "clawbot_target_ambiguous" : "clawbot_target_unavailable",
      };
    }
    const freshness = this.#safeFreshness(targets[0]);
    if (freshness.targetFingerprint !== targetFingerprint) {
      return { ok: false, error: "clawbot_target_changed" };
    }
    return { ok: true, ...freshness };
  }

  /**
   * Watch only OpenClaw's context-token directory and emit a credential-free
   * freshness hint after writes settle. fs.watch can coalesce or duplicate
   * events, so callers receive one debounced callback and must reread state.
   * The returned disposer synchronously closes the watcher and pending timers.
   */
  watchContextTokens(listener, { debounceMs = 250, retryMs = 1_000 } = {}) {
    if (typeof listener !== "function") throw new TypeError("clawbot_context_listener_required");
    const settledDebounceMs = Math.max(10, Number(debounceMs) || 250);
    const settledRetryMs = Math.max(100, Number(retryMs) || 1_000);
    let watcher = null;
    let debounceTimer = null;
    let retryTimer = null;
    let disposed = false;
    let knownContexts = new Map();

    const clearDebounce = () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = null;
    };
    const clearRetry = () => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = null;
    };
    const emitFreshness = () => {
      clearDebounce();
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (disposed) return;
        void this.#resolveTargets()
          .then((targets) => {
            if (disposed) return;
            const currentContexts = new Map(targets.map((target) => {
              const freshness = this.#safeFreshness(target);
              return [freshness.targetFingerprint, freshness.contextFingerprint];
            }));
            const changedTargets = targets.filter((target) => {
              const freshness = this.#safeFreshness(target);
              const previous = knownContexts.get(freshness.targetFingerprint);
              return previous !== undefined && previous !== freshness.contextFingerprint;
            });
            knownContexts = currentContexts;
            // A write/mtime change to a shared context-token file is not proof
            // that the configured sender's session refreshed. Only a token
            // change for an already-bound target may clear session health.
            if (!changedTargets.length) return;
            const contextUpdatedAt = changedTargets
              .map((target) => target.contextUpdatedAt)
              .filter(Boolean)
              .sort()
              .at(-1) || null;
            return listener({ contextUpdatedAt });
          })
          .catch(() => {});
      }, settledDebounceMs);
      debounceTimer.unref?.();
    };
    const scheduleRetry = () => {
      if (disposed || retryTimer) return;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        arm();
      }, settledRetryMs);
      retryTimer.unref?.();
    };
    const arm = () => {
      if (disposed || watcher) return;
      try {
        watcher = this.watchImpl(this.accountRoot, { persistent: false }, (_eventType, filename) => {
          const name = filename == null ? "" : String(filename);
          if (name && !name.endsWith(".context-tokens.json")) return;
          emitFreshness();
        });
        watcher.on?.("error", () => {
          watcher?.close?.();
          watcher = null;
          scheduleRetry();
        });
      } catch {
        watcher = null;
        scheduleRetry();
      }
    };

    // Establish a sender/session baseline before trusting fs.watch events. The
    // signed inbound route remains the authoritative fallback for the tiny
    // read-to-watch gap, so a file mtime alone never becomes recovery evidence.
    void this.#resolveTargets()
      .then((targets) => {
        if (disposed) return;
        knownContexts = new Map(targets.map((target) => {
          const freshness = this.#safeFreshness(target);
          return [freshness.targetFingerprint, freshness.contextFingerprint];
        }));
        arm();
      })
      .catch(() => scheduleRetry());
    return () => {
      if (disposed) return;
      disposed = true;
      clearDebounce();
      clearRetry();
      watcher?.close?.();
      watcher = null;
    };
  }

  async status() {
    try {
      await access(this.sendModule);
      const targets = await this.#resolveTargets();
      const contextUpdatedAt = targets.map((target) => target.contextUpdatedAt).filter(Boolean).sort().at(-1) || null;
      return { ready: targets.length > 0, paired: targets.length > 0, pairedCount: targets.length, contextUpdatedAt, reason: targets.length ? null : "控制账号或微信会话未就绪" };
    } catch {
      return { ready: false, paired: false, pairedCount: 0, contextUpdatedAt: null, reason: "ClawBot 官方发送模块未就绪" };
    }
  }

  async send(title, message) {
    const targets = await this.#resolveTargets();
    if (!targets.length) return { ok: false, error: "clawbot_target_unavailable" };
    let sendMessageWeixin = this.sendImpl;
    if (!sendMessageWeixin) {
      const module = await import(pathToFileURL(this.sendModule).href);
      sendMessageWeixin = module.sendMessageWeixin;
    }
    if (typeof sendMessageWeixin !== "function") return { ok: false, error: "clawbot_sender_unavailable" };
    const titleText = String(title || "织台通知").trim();
    const chunks = splitMessage(String(message || "").trim(), 2_500);
    let accepted = 0;
    let lastError = null;
    for (const target of targets) {
      try {
        for (let index = 0; index < chunks.length; index += 1) {
          const partTitle = chunks.length > 1 ? `${titleText}（${index + 1}/${chunks.length}）` : titleText;
          await sendMessageWeixin({
            to: target.to,
            text: [partTitle, chunks[index]].filter(Boolean).join("\n"),
            opts: { baseUrl: target.baseUrl, token: target.token, contextToken: target.contextToken, timeoutMs: 10_000 },
          });
        }
        accepted += 1;
      } catch (error) {
        lastError = safeError(error);
      }
    }
    return accepted > 0 ? { ok: true, accepted } : { ok: false, error: lastError || "clawbot_send_failed" };
  }

  async sendMedia(title, message, filePath) {
    try { await access(filePath); } catch { return { ok: false, error: "clawbot_media_missing" }; }
    const targets = await this.#resolveTargets();
    if (!targets.length) return { ok: false, error: "clawbot_target_unavailable" };
    let sendWeixinMediaFile = this.sendMediaImpl;
    if (!sendWeixinMediaFile) {
      const module = await import(pathToFileURL(this.sendMediaModule).href);
      sendWeixinMediaFile = module.sendWeixinMediaFile;
    }
    if (typeof sendWeixinMediaFile !== "function") return { ok: false, error: "clawbot_media_sender_unavailable" };
    let accepted = 0;
    let lastError = null;
    for (const target of targets) {
      try {
        await sendWeixinMediaFile({
          filePath,
          to: target.to,
          text: [String(title || "织台视频"), String(message || "")].filter(Boolean).join("\n"),
          opts: { baseUrl: target.baseUrl, token: target.token, contextToken: target.contextToken, timeoutMs: 120_000 },
          cdnBaseUrl: target.cdnBaseUrl,
        });
        accepted += 1;
      } catch (error) { lastError = safeError(error); }
    }
    return accepted > 0 ? { ok: true, accepted } : { ok: false, error: lastError || "clawbot_media_send_failed" };
  }
}

function splitMessage(value, maxLength) {
  const input = String(value || "").trim();
  if (!input) return [""];
  const chunks = [];
  let current = "";
  for (const paragraph of input.split(/\n+/)) {
    if (paragraph.length > maxLength) {
      if (current) { chunks.push(current); current = ""; }
      for (let offset = 0; offset < paragraph.length; offset += maxLength) chunks.push(paragraph.slice(offset, offset + maxLength));
      continue;
    }
    const next = current ? `${current}\n${paragraph}` : paragraph;
    if (next.length > maxLength) { chunks.push(current); current = paragraph; }
    else current = next;
  }
  if (current) chunks.push(current);
  return chunks.length ? chunks : [""];
}
