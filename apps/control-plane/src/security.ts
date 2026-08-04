/** Logging + deploy rate limiting helpers (no secrets in logs). */

const SECRET_ENV_KEYS = [
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "CURSOR_API_KEY",
  "IOS_REPOS_READ_TOKEN",
  "BSL_TEAM_ID",
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
  out = out.replace(/Bearer\s+[A-Za-z0-9._\-]+/gi, "Bearer [REDACTED]");
  return out;
}

export function logInfo(message: string, extraSecrets: string[] = []): void {
  console.log(redact(message, extraSecrets));
}

export function logError(message: string, extraSecrets: string[] = []): void {
  console.error(redact(message, extraSecrets));
}

/** Simple single-flight + cooldown rate limit for personal use. */
export class DeployGate {
  private inflight = false;
  private lastStartMs = 0;

  constructor(
    private readonly cooldownMs = 15_000,
  ) {}

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
