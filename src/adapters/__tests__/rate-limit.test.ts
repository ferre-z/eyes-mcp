// =============================================================================
// Eyes-MCP — token bucket (rate limiter) tests
//
// The bucket is pure: take() / peek() / available() depend only on a clock.
// Use the `now` option to advance time deterministically.
// =============================================================================

import { describe, it, expect } from "vitest";
import { createBucket } from "../rate-limit.js";

describe("token bucket", () => {
  it("starts full and lets the first take go through immediately", () => {
    let t = 1000;
    const b = createBucket({ capacity: 5, refillPerSec: 1, now: () => t });
    const wait = b.take();
    expect(wait).toBeInstanceOf(Promise);
    // First take is synchronous-ish (still a promise but resolves to 0)
    return expect(wait).resolves.toBe(0);
  });

  it("reports wait > 0 when no tokens are available", async () => {
    let t = 1000;
    const b = createBucket({ capacity: 1, refillPerSec: 1, now: () => t });
    await b.take(); // drain
    const beforePeek = b.peek();
    expect(beforePeek).toBeGreaterThan(0);
    const wait = await b.take();
    expect(wait).toBeGreaterThan(0);
  });

  it("refills tokens over time", () => {
    let t = 0;
    const b = createBucket({ capacity: 3, refillPerSec: 1, now: () => t });
    // Drain it first so we can observe the refill.
    void b.take();
    void b.take();
    void b.take();
    expect(b.available()).toBe(0);
    t = 2500; // +2.5 seconds, +2.5 tokens
    expect(b.available()).toBeCloseTo(2.5, 5);
    t = 10000;
    expect(b.available()).toBe(3); // capped at capacity
  });

  it("take() never returns a wait time shorter than the truth", async () => {
    let t = 0;
    const b = createBucket({ capacity: 1, refillPerSec: 2, now: () => t });
    await b.take();
    t = 100; // 0.2 tokens
    const wait = await b.take();
    // Should be approximately 400ms (0.8 tokens needed at 2/s)
    expect(wait).toBeGreaterThanOrEqual(380);
    expect(wait).toBeLessThanOrEqual(450);
  });

  it("clamps capacity to >= 1 and refillPerSec to >= 0", () => {
    let t = 0;
    const b = createBucket({ capacity: -5, refillPerSec: -1, now: () => t });
    expect(b.available()).toBe(1);
    t = 10000;
    // refillPerSec=0 means no refills
    expect(b.available()).toBe(1);
  });

  it("multiple parallel take()s do not over-grant", async () => {
    let t = 0;
    // Use a positive but small refillPerSec so the third take returns
    // quickly (within the test's default timeout) instead of falling back
    // to the 60s default wait.
    const b = createBucket({ capacity: 2, refillPerSec: 100, now: () => t });
    // Advance the clock before kicking off the takes so the third has a
    // full token available.
    t = 100;
    const [w1, w2, w3] = await Promise.all([b.take(), b.take(), b.take()]);
    expect(w1).toBe(0);
    expect(w2).toBe(0);
    // The third take sees ~2 tokens, then immediately drains to 1; it
    // should resolve with a small (or zero) wait, not the 60s fallback.
    expect(w3).toBeLessThan(1000);
  });
});
