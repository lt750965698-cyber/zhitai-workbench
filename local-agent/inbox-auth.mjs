import { isIP } from "node:net";

export function isLoopbackRemoteAddress(value) {
  let address = String(value || "").trim().toLowerCase();
  const zoneIndex = address.indexOf("%");
  if (zoneIndex >= 0) address = address.slice(0, zoneIndex);
  if (address === "::1" || address === "0:0:0:0:0:0:0:1") return true;
  if (address.startsWith("::ffff:")) address = address.slice("::ffff:".length);
  if (isIP(address) !== 4) return false;
  return Number(address.split(".", 1)[0]) === 127;
}

/**
 * Choose the authentication boundary before parsing any identity from the body.
 * An explicit Origin is authoritative: a bad Origin never falls back to socket trust.
 */
export function decideInboxAuthentication({ hasSecret, allowedOrigins, origin, remoteAddress }) {
  if (origin !== undefined && origin !== null && typeof origin !== "string") return "deny";
  const requestOrigin = typeof origin === "string" ? origin : "";
  const originAllowed = Boolean(requestOrigin && allowedOrigins.includes(requestOrigin));
  if (requestOrigin && !originAllowed) return "deny";
  if (hasSecret) return "signature";
  if (originAllowed) return "origin";
  return isLoopbackRemoteAddress(remoteAddress) ? "loopback" : "deny";
}
