import { homedir } from "node:os";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Return a path that is useful in the local UI without exposing the account
 * name or an unrelated parent directory. The real path remains available to
 * internal callers and is never changed by this helper.
 */
export function publicDisplayPath(value, { home = homedir() } = {}) {
  if (typeof value !== "string" || value.length === 0) return value;
  if (value === "~" || value.startsWith("~/")) return value;
  if (!isAbsolute(value)) return value;

  const absolutePath = resolve(value);
  const absoluteHome = resolve(home);
  const homeRelative = relative(absoluteHome, absolutePath);
  const isInHome = homeRelative === ""
    || (homeRelative !== ".." && !homeRelative.startsWith(`..${sep}`) && !isAbsolute(homeRelative));

  if (isInHome) {
    if (!homeRelative) return "~";
    return `~/${homeRelative.split(sep).join("/")}`;
  }

  const leaf = basename(absolutePath);
  return leaf ? `…/${leaf}` : "…";
}
