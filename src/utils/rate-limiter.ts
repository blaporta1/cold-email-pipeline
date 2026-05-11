export class RateLimiter {
  private tokens: number;
  private readonly maxTokens: number;
  private readonly refillRatePerMs: number;
  private lastRefill: number;

  constructor(requestsPerSecond: number, burst?: number) {
    this.maxTokens = burst ?? requestsPerSecond;
    this.tokens = this.maxTokens;
    this.refillRatePerMs = requestsPerSecond / 1000;
    this.lastRefill = Date.now();
  }

  private refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    this.tokens = Math.min(this.maxTokens, this.tokens + elapsed * this.refillRatePerMs);
    this.lastRefill = now;
  }

  async acquire(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens--;
      return;
    }
    const waitMs = Math.ceil((1 - this.tokens) / this.refillRatePerMs);
    await sleep(waitMs);
    this.tokens--;
  }
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  retries = 3,
  baseDelayMs = 1000,
): Promise<T> {
  try {
    return await fn();
  } catch (err: unknown) {
    if (retries === 0) throw err;
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status === 429) {
      await sleep(baseDelayMs * 2);
    } else if (status && status >= 400 && status < 500) {
      throw err;
    } else {
      await sleep(baseDelayMs);
    }
    return withRetry(fn, retries - 1, baseDelayMs * 2);
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export const rateLimiters = {
  hunter: new RateLimiter(1, 2),
  apollo: new RateLimiter(2, 5),
  leadmagic: new RateLimiter(3, 5),
  icypeas: new RateLimiter(2, 3),
  kitt: new RateLimiter(2, 4),
  meta: new RateLimiter(2, 3),
  scraper: new RateLimiter(5, 10),
  anthropic: new RateLimiter(3, 5),
  google: new RateLimiter(2, 4),
  instantly: new RateLimiter(5, 10),
};
