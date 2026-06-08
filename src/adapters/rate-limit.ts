// =============================================================================
// Eyes-MCP — in-process rate limiter (token bucket)
//
// We don't share state across processes (no Redis), so this is per-process.
// It is good enough to keep us polite to OSM (1/s), Reddit (60/hr), GitHub
// (60/hr unauth). For more accurate coordination, run a single eyes-mcp
// process — the design assumes that.
//
// API:
//   const bucket = createBucket({ capacity: 60, refillPerSec: 60/3600 });
//   await bucket.take();   // waits until a token is available
//   bucket.peek();         // ms until next token (for logging / debugging)
// =============================================================================

export interface TokenBucket {
  /** Wait until a token is available, then consume one. Resolves to waitMs. */
  take(): Promise<number>;
  /** Milliseconds until a token would be available right now. 0 if ready. */
  peek(): number;
  /** Current available tokens (fractional, for diagnostics). */
  available(): number;
}

export interface TokenBucketOptions {
  /** Max tokens that can accumulate (burst size). */
  capacity: number;
  /** Tokens added per second. */
  refillPerSec: number;
  /** Initial tokens. Default = capacity. */
  initial?: number;
  /** Optional clock override for tests. */
  now?: () => number;
}

export function createBucket(opts: TokenBucketOptions): TokenBucket {
  const capacity = Math.max(1, opts.capacity);
  const refillPerSec = Math.max(0, opts.refillPerSec);
  const now = opts.now ?? (() => Date.now());
  let tokens = Math.min(capacity, opts.initial ?? capacity);
  let lastRefillMs = now();

  function refill(): void {
    const t = now();
    if (t <= lastRefillMs) return;
    const elapsedSec = (t - lastRefillMs) / 1000;
    tokens = Math.min(capacity, tokens + elapsedSec * refillPerSec);
    lastRefillMs = t;
  }

  return {
    take(): Promise<number> {
      refill();
      if (tokens >= 1) {
        tokens -= 1;
        return Promise.resolve(0);
      }
      const deficit = 1 - tokens;
      const waitMs = refillPerSec > 0 ? Math.ceil((deficit / refillPerSec) * 1000) : 60_000;
      return new Promise((resolve) => {
        setTimeout(() => {
          refill();
          tokens = Math.max(0, tokens - 1);
          resolve(waitMs);
        }, waitMs);
      });
    },
    peek(): number {
      refill();
      if (tokens >= 1) return 0;
      const deficit = 1 - tokens;
      return refillPerSec > 0 ? Math.ceil((deficit / refillPerSec) * 1000) : 60_000;
    },
    available(): number {
      refill();
      return tokens;
    },
  };
}
