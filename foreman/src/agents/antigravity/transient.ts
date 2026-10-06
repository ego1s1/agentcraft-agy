// Transient network failure detection for the Antigravity backend.
//
// When an `agy` turn dies because the network blipped (WiFi drop, DNS hiccup,
// LLM endpoint timeout), the failure surfaces as a transport-level error. Those
// are worth an automatic retry with backoff. Anything else (auth, bad model,
// the agent itself giving up) keeps the old behaviour: the task goes `blocked`
// immediately so the user sees it.

/** How many times a failed turn is retried before the task goes blocked. */
export const DEFAULT_TRANSIENT_RETRIES = 3;

/** Backoff between transient retries: attempt 0 waits 10s, then 30s, then 90s. */
export const TRANSIENT_RETRY_DELAYS_MS: readonly number[] = [10_000, 30_000, 90_000];

export function transientRetryDelayMs(attempt: number, delays: readonly number[] = TRANSIENT_RETRY_DELAYS_MS): number {
  if (attempt < 0) return delays[0] ?? 10_000;
  return delays[Math.min(attempt, delays.length - 1)] ?? 10_000;
}

// Fatal: never retry these, even if a transient-looking substring also matches.
const FATAL_PATTERNS: RegExp[] = [
  /auth[^a-z]*(fail|expir|invalid|denied|error|revoked)/i,
  /unauthori[sz]ed/i,
  /forbidden/i,
  /invalid api key/i,
  /quota exceeded|quota exhausted|billing|payment required|usage limit/i,
  /model[^a-z]*not found|unknown model|model .*not (available|supported)/i,
  /permission denied/i,
  /not a git repository/i,
];

// Transient: transport-level failures that usually clear on their own.
const TRANSIENT_PATTERNS: RegExp[] = [
  /timed?\s*out/i, // "timed out", "timeout", "operation timed out"
  /temporar(y|ily)/i,
  /econnreset|etimedout|eai_again|enotfound|econnaborted|econnrefused|enetunreach|ehostunreach|enetdown|epipe/i,
  /socket hang ?up/i,
  /reset by peer|broken pipe/i,
  /can't assign requested address|cannot assign requested address/i,
  /network (is )?(down|unreachable|reset)|network error|network changed|net::/i,
  /\bdns\b|getaddrinfo/i,
  /service unavailable|server unavailable/i,
  /(^|[^0-9])(429|502|503|504)([^0-9]|$)/, // rate-limited or a 5xx from the API edge
  /too many requests|rate[ -]?limit(ed|er)?\b/i,
  /retryable["'\s:]*true/i, // the provider itself says "try again"
];

export function isTransientError(message: string | null | undefined): boolean {
  if (!message) return false;
  if (FATAL_PATTERNS.some((re) => re.test(message))) return false;
  return TRANSIENT_PATTERNS.some((re) => re.test(message));
}
