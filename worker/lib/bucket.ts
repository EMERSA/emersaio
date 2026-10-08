/**
 * A token bucket: `burst` tokens to start, refilled at `perSecond`, one token per allowed call. Cheap, allocation
 * free and forgiving of bursts. It stands in for the Cloudflare rate limiter binding in tests and in wrangler dev;
 * BucketLimiter keeps one per key behind the binding's interface.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly burst: number;
  private readonly perSecond: number;

  constructor(burst: number, perSecond: number, nowMs = Date.now()) {
    this.burst = burst;
    this.perSecond = perSecond;
    this.tokens = burst;
    this.last = nowMs;
  }

  /** Take one token if there is one. False means the caller is early. */
  allow(nowMs = Date.now()): boolean {
    const elapsed = Math.max(0, nowMs - this.last) / 1000;
    this.last = nowMs;
    this.tokens = Math.min(this.tokens + elapsed * this.perSecond, this.burst);
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** When the bucket was last asked, so idle ones can be forgotten. */
  get lastSeen(): number {
    return this.last;
  }
}

export interface BucketLimiterOptions {
  /** How long a quiet key is remembered before a sweep forgets it. */
  idleMs?: number;
  /** The clock, replaceable in tests. */
  now?: () => number;
}

/** Sweeping is only worth its loop once the map has grown; a handful of keys can stay. */
const SWEEP_AT = 1024;

/** A rate limiter binding look-alike: one bucket per key, forgotten after a quiet half hour. */
export class BucketLimiter implements RateLimit {
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly burst: number;
  private readonly perSecond: number;
  private readonly idleMs: number;
  private readonly now: () => number;

  constructor(burst: number, perSecond: number, options: BucketLimiterOptions = {}) {
    this.burst = burst;
    this.perSecond = perSecond;
    this.idleMs = options.idleMs ?? 30 * 60 * 1000;
    this.now = options.now ?? Date.now;
  }

  /** The same shape as wrangler.jsonc's "simple" limits: `limit` requests per `period` seconds. */
  static simple(limit: number, period: number, options?: BucketLimiterOptions): BucketLimiter {
    return new BucketLimiter(limit, limit / period, options);
  }

  async limit({ key }: RateLimitOptions): Promise<RateLimitOutcome> {
    const now = this.now();
    if (this.buckets.size >= SWEEP_AT) this.sweep(now);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = new TokenBucket(this.burst, this.perSecond, now);
      this.buckets.set(key, bucket);
    }
    return { success: bucket.allow(now) };
  }

  /** Forget keys quiet for longer than idleMs, so memory is bounded by recent traffic rather than all of it. */
  sweep(now = this.now()): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastSeen >= this.idleMs) this.buckets.delete(key);
    }
  }

  /** Keys currently remembered, for tests and a status line. */
  get tracked(): number {
    return this.buckets.size;
  }
}
