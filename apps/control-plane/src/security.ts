/** Logging, API auth, + deploy rate limiting helpers (no secrets in logs). */

import { timingSafeEqual } from "node:crypto";

const SECRET_ENV_KEYS = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "CURSOR_API_KEY",
  "IOS_REPOS_READ_TOKEN",
  "BSL_TEAM_ID",
  "BSL_API_TOKEN",
  "BSL_ASC_KEY_ID",
  "BSL_ASC_ISSUER_ID",
  "ASC_KEY_ID",
  "ASC_ISSUER_ID",
];

export function redact(text: string, extra: string[] = []): string {
  let out = text;
  const secrets = [
    ...extra,
    ...SECRET_ENV_KEYS.map((k) => process.env[k] || "").filter((v) => v.length >= 8),
  ];
  for (const s of secrets) {
    out = out.split(s).join("[REDACTED]");
  }
  // Common token shapes
  out = out.replace(/ghp_[A-Za-z0-9_]{20,}/g, "[REDACTED_GH]");
  out = out.replace(/github_pat_[A-Za-z0-9_]{20,}/g, "[REDACTED_GH]");
  out = out.replace(/gho_[A-Za-z0-9_]{20,}/g, "[REDACTED_GH]");
  out = out.replace(/ghu_[A-Za-z0-9_]{20,}/g, "[REDACTED_GH]");
  out = out.replace(/ghs_[A-Za-z0-9_]{20,}/g, "[REDACTED_GH]");
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]");
  out = out.replace(/Basic\s+[A-Za-z0-9+/=]+/gi, "Basic [REDACTED]");
  out = out.replace(/key_[A-Za-z0-9]{20,}/g, "[REDACTED_KEY]");
  return out;
}

export function logInfo(message: string, extraSecrets: string[] = []): void {
  console.log(redact(message, extraSecrets));
}

export function logError(message: string, extraSecrets: string[] = []): void {
  console.error(redact(message, extraSecrets));
}

/** Safe client-facing error (avoid leaking stack traces / absolute paths). */
export function publicError(err: unknown): string {
  if (err instanceof Error && err.message) {
    const msg = redact(err.message);
    // Drop absolute home paths that may appear in spawn errors
    return msg.replace(/\/(?:Users|home)\/[^\s:]+/g, "~");
  }
  return "request failed";
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    // Constant-ish compare against self to avoid trivial timing on length
    timingSafeEqual(ba, ba);
    return false;
  }
  return timingSafeEqual(ba, bb);
}

/** Extract Bearer / X-BSL-Token from a request. */
export function extractApiToken(
  headerGet: (name: string) => string | undefined,
): string | null {
  const x = headerGet("x-bsl-token");
  if (x?.trim()) return x.trim();
  const auth = headerGet("authorization");
  if (!auth) return null;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  return m ? m[1].trim() : null;
}

export function apiTokenOk(expected: string, provided: string | null): boolean {
  if (!expected) return true;
  if (!provided) return false;
  return safeEqual(expected, provided);
}

/** Simple single-flight + cooldown rate limit for personal use. */
export class DeployGate {
  private inflight = false;
  private lastStartMs = 0;

  constructor(private readonly cooldownMs = 15_000) {}

  tryAcquire(): { ok: true } | { ok: false; retryAfterSec: number; reason: string } {
    const now = Date.now();
    if (this.inflight) {
      return { ok: false, retryAfterSec: 30, reason: "A deploy is already in progress" };
    }
    const since = now - this.lastStartMs;
    if (this.lastStartMs && since < this.cooldownMs) {
      const retryAfterSec = Math.ceil((this.cooldownMs - since) / 1000);
      return {
        ok: false,
        retryAfterSec,
        reason: `Deploy cooldown — try again in ${retryAfterSec}s`,
      };
    }
    this.inflight = true;
    this.lastStartMs = now;
    return { ok: true };
  }

  release(): void {
    this.inflight = false;
  }
}
