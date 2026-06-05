// URL guard for skills-web. The contract is fail-closed: if no allowlist is
// configured the skill refuses every call, even otherwise-valid HTTPS URLs.
// This forces the operator to opt-in to specific domains rather than letting
// a chatty model walk into SSRF, internal-service probes, or surprise egress.

export type UrlCheckResult =
  | { ok: true; url: URL }
  | { ok: false; reason: string };

export interface UrlCheckOpts {
  /**
   * Exact-match hostnames the skill is allowed to fetch. A leading "*." marks
   * a wildcard suffix: "*.example.com" admits "api.example.com" and any
   * deeper subdomain but NOT "example.com" itself. Empty / unset = refuse all.
   */
  allowlist?: ReadonlySet<string>;
}

const PRIVATE_HOST_LITERALS: ReadonlySet<string> = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "::",
  "metadata.google.internal",
]);

// Lightweight private-range check on common literal forms. We don't try to
// resolve DNS — the allowlist is the primary gate; this is a secondary
// guard against obvious internal-service URLs that someone forgot to remove.
function looksPrivate(host: string): boolean {
  const h = host.toLowerCase();
  if (PRIVATE_HOST_LITERALS.has(h)) return true;
  // IPv4 RFC1918 + link-local
  if (/^10\.\d+\.\d+\.\d+$/.test(h)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(h)) return true;
  if (/^169\.254\.\d+\.\d+$/.test(h)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(h)) return true;
  // IPv6 ULA / link-local
  if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
  if (/^fe80:/.test(h)) return true;
  return false;
}

function hostMatches(host: string, allow: ReadonlySet<string>): boolean {
  const h = host.toLowerCase();
  if (allow.has(h)) return true;
  for (const entry of allow) {
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1); // ".example.com"
      if (h.endsWith(suffix) && h.length > suffix.length) return true;
    }
  }
  return false;
}

export function checkUrl(rawUrl: unknown, opts: UrlCheckOpts = {}): UrlCheckResult {
  if (typeof rawUrl !== "string" || rawUrl.length === 0) {
    return { ok: false, reason: "url must be a non-empty string" };
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { ok: false, reason: `not a valid URL: ${rawUrl}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `scheme '${parsed.protocol}' not allowed (only http/https)` };
  }
  if (!parsed.hostname) {
    return { ok: false, reason: "url has no hostname" };
  }
  if (looksPrivate(parsed.hostname)) {
    return { ok: false, reason: `host '${parsed.hostname}' looks like a private/loopback address` };
  }
  const allow = opts.allowlist;
  if (!allow || allow.size === 0) {
    return {
      ok: false,
      reason:
        "no domain allowlist configured (set MINICLAW_WEB_ALLOWLIST to a comma-separated list of hostnames)",
    };
  }
  if (!hostMatches(parsed.hostname, allow)) {
    return {
      ok: false,
      reason: `host '${parsed.hostname}' is not on the allowlist (${[...allow].join(", ")})`,
    };
  }
  return { ok: true, url: parsed };
}

export function parseAllowlistEnv(value: string | undefined): ReadonlySet<string> {
  if (!value) return new Set();
  const entries = value
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0);
  return new Set(entries);
}
