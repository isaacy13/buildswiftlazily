/** Shared text search for the PWA and API (branches, repos, jobs, …). */

export function normalizeSearch(s: string): string {
  return String(s ?? "").trim().toLowerCase();
}

export function looksLikeRef(ref: string): boolean {
  return (
    Boolean(ref) &&
    ref.length <= 256 &&
    !ref.includes("..") &&
    /^[A-Za-z0-9._/\-]+$/.test(ref)
  );
}

/**
 * Substring match, then whitespace/slash tokens, then hyphen-insensitive
 * compact match so "search func" and "searchfunctionality" both hit
 * `cursor/search-functionality-4b3d`.
 */
export function matchesQuery(haystack: string, query: string): boolean {
  const q = normalizeSearch(query);
  if (!q) return true;
  const hay = String(haystack ?? "").toLowerCase();
  if (hay.includes(q)) return true;
  const tokens = q.split(/[\s/]+/).filter(Boolean);
  if (tokens.length > 1 && tokens.every((t) => hay.includes(t))) return true;
  const compactHay = hay.replace(/[-_/.]+/g, "");
  const compactQ = q.replace(/[-_/.]+/g, "");
  return compactQ.length >= 2 && compactHay.includes(compactQ);
}

export function rankMatch(haystack: string, query: string): number {
  const q = normalizeSearch(query);
  if (!q) return 0;
  const hay = String(haystack ?? "").toLowerCase();
  if (hay === q) return 0;
  if (hay.startsWith(q)) return 1;
  if (hay.includes(`/${q}`) || hay.includes(`-${q}`)) return 2;
  if (hay.includes(q)) return 3;
  return 4;
}

export function filterAndRank<T>(
  items: T[],
  query: string,
  text: (item: T) => string,
  limit = Infinity,
): { matches: T[]; total: number } {
  const q = normalizeSearch(query);
  const matched = q
    ? items.filter((item) => matchesQuery(text(item), q))
    : items.slice();
  if (q) {
    matched.sort((a, b) => {
      const diff = rankMatch(text(a), q) - rankMatch(text(b), q);
      if (diff !== 0) return diff;
      return text(a).localeCompare(text(b));
    });
  }
  return {
    matches: Number.isFinite(limit) ? matched.slice(0, limit) : matched,
    total: matched.length,
  };
}
