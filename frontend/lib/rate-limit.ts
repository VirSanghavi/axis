import { redis } from './redis'

type RateLimitResult = {
  allowed: boolean;
  remaining: number;
  reset: number;
};

/**
 * Circuit breaker state for Redis failures.
 * Tracks consecutive failures and trips open after threshold,
 * blocking all traffic rather than allowing it through unchecked.
 */
const circuitBreaker = {
  failures: 0,
  lastFailure: 0,
  /** After this many consecutive Redis failures, deny all traffic */
  failureThreshold: 5,
  /** How long to stay open (deny all) before allowing a probe request (ms) */
  resetTimeoutMs: 30_000,
  /** Circuit states: CLOSED (normal), OPEN (deny all), HALF_OPEN (probe) */
  get state(): 'CLOSED' | 'OPEN' | 'HALF_OPEN' {
    if (this.failures < this.failureThreshold) return 'CLOSED';
    const elapsed = Date.now() - this.lastFailure;
    if (elapsed > this.resetTimeoutMs) return 'HALF_OPEN';
    return 'OPEN';
  },
  recordSuccess() {
    this.failures = 0;
    this.lastFailure = 0;
  },
  recordFailure() {
    this.failures++;
    this.lastFailure = Date.now();
  },
};

/**
 * Standard rate limiter using Redis (Upstash) with circuit breaker.
 *
 * - CLOSED: Normal operation via Redis.
 * - OPEN: Redis is down — deny all traffic to prevent abuse.
 * - HALF_OPEN: Allow a single probe request through to test Redis recovery.
 */
export async function rateLimit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
  const now = Date.now();

  // Circuit breaker: if Redis has failed repeatedly, deny traffic
  if (circuitBreaker.state === 'OPEN') {
    console.warn('[RateLimit] Circuit breaker OPEN — denying request (Redis unavailable)');
    return { allowed: false, remaining: 0, reset: now + circuitBreaker.resetTimeoutMs };
  }

  const fullKey = `ratelimit:${key}`;

  try {
    const count = await redis.incr(fullKey);

    if (count === 1) {
      await redis.pexpire(fullKey, windowMs);
    }

    const ttl = await redis.pttl(fullKey);
    const reset = now + Math.max(0, ttl);

    // Redis responded — record success (resets circuit breaker)
    circuitBreaker.recordSuccess();

    if (count > limit) {
      return {
        allowed: false,
        remaining: 0,
        reset
      };
    }

    return {
      allowed: true,
      remaining: limit - count,
      reset
    };
  } catch (err) {
    console.error('[RateLimit] Redis error:', err);
    circuitBreaker.recordFailure();

    // Fail CLOSED: deny traffic when Redis is unreachable
    // This prevents abuse during outages at the cost of blocking legitimate users
    return { allowed: false, remaining: 0, reset: now + windowMs };
  }
}

export function getClientIp(headers: Headers) {
  return headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}
