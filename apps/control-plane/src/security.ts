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
  /** Mac login keychain password for unattended codesign — treat as highly sensitive. */
  "BSL_KEYCHAIN_PASSWORD",
];

export function redact(text: string, extra: string[] = []): string {
  let out = text;
  const secrets = [
    ...extra,
    ...SECRET_ENV_KEYS.flatMap((k) => {
      const v = process.env[k] || "";
      // Login passwords can be short; redact from length 4. Other tokens need 8+.
      const min = k === "BSL_KEYCHAIN_PASSWORD" ? 4 : 8;
      return v.length >= min ? [v] : [];
    }),
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
  console.log(stampLogLine(redact(message, extraSecrets)));
}

export function logError(message: string, extraSecrets: string[] = []): void {
  console.error(stampLogLine(redact(message, extraSecrets)));
}

/** Local wall clock for job/console logs (Mac timezone). */
export function formatLogClock(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const LOG_TS_RE = /^\[?\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}/;

/** Prefix a log line with local time unless it already has a timestamp. */
export function stampLogLine(line: string, d = new Date()): string {
  const text = String(line ?? "");
  if (!text.trim()) return text;
  if (LOG_TS_RE.test(text.trimStart())) return text;
  return `${formatLogClock(d)} ${text}`;
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
  private inflightJobId: string | null = null;

  constructor(private readonly cooldownMs = 15_000) {}

  /**
   * @param findLiveJobId optional lookup used to recover jobId and to self-heal
   *   a stuck gate (inflight with no live job / no bound id).
   */
  tryAcquire(
    findLiveJobId?: () => string | undefined,
  ):
    | { ok: true }
    | { ok: false; retryAfterSec: number; reason: string; jobId?: string } {
    const now = Date.now();
    if (this.inflight) {
      const liveId = this.inflightJobId || findLiveJobId?.() || undefined;
      if (!liveId) {
        // Gate held but nothing to reattach to — release so the operator is not stuck.
        this.inflight = false;
        this.inflightJobId = null;
      } else {
        if (!this.inflightJobId) this.inflightJobId = liveId;
        return {
          ok: false,
          retryAfterSec: 30,
          reason: "A deploy is already in progress",
          jobId: liveId,
        };
      }
    }
    const since = now - this.lastStartMs;
    if (this.lastStartMs && since < this.cooldownMs) {
      const retryAfterSec = Math.ceil((this.cooldownMs - since) / 1000);
      return {
        ok: false,
        retryAfterSec,
        reason: `Deploy cooldown — try again in ${retryAfterSec}s`,
        jobId: this.inflightJobId || findLiveJobId?.() || undefined,
      };
    }
    this.inflight = true;
    this.lastStartMs = now;
    return { ok: true };
  }

  /** Attach the job id once the local deploy is queued (for reattach on 429). */
  bindJob(jobId: string): void {
    this.inflightJobId = jobId;
  }

  getInflightJobId(): string | null {
    return this.inflightJobId;
  }

  isInflight(): boolean {
    return this.inflight;
  }

  /** Release only if this job still owns the gate (cancel / finish). */
  releaseIfJob(jobId: string): void {
    if (this.inflightJobId === jobId || (!this.inflightJobId && this.inflight)) {
      this.release();
    }
  }

  release(): void {
    this.inflight = false;
    this.inflightJobId = null;
  }
}
