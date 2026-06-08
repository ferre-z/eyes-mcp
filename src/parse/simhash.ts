// =============================================================================
// Eyes-MCP — 64-bit simhash for near-duplicate chunk detection.
//
// Pure functions, no I/O. Used by the parse layer to drop near-duplicate
// chunks within a shard (hamming distance < 5). Standard Manku-style
// simhash: tokenize -> hash64 -> per-bit sum -> threshold at 0.
//
// Reference: docs/03-architecture-main-and-swarm.md (parse layer 2).
// =============================================================================

import { createHash } from "node:crypto";

/**
 * Lowercase, split on non-alphanumerics, drop empties, drop tokens shorter
 * than 2 chars, and dedupe. Order is preserved (insertion order of a Set).
 */
export function tokenize(text: string): string[] {
  if (!text) return [];
  const lower = text.toLowerCase();
  const parts = lower.split(/[^a-z0-9]+/);
  const seen = new Set<string>();
  for (const p of parts) {
    if (p.length >= 2) seen.add(p);
  }
  return Array.from(seen);
}

/**
 * 64-bit hash of a single token. SHA-1 of the token; we take the first
 * 8 bytes interpreted as an unsigned big-endian 64-bit integer.
 */
export function hash64(token: string): bigint {
  const digest = createHash("sha1").update(token, "utf8").digest();
  // First 8 bytes (big-endian), as unsigned bigint.
  let acc = 0n;
  for (let i = 0; i < 8; i++) {
    acc = (acc << 8n) | BigInt(digest[i] ?? 0);
  }
  return acc & 0xffffffffffffffffn;
}

/**
 * Compute the 64-bit simhash of a list of tokens. Each bit position
 * accumulates +1 for every token whose hash has that bit set and -1
 * otherwise. The final bit is 1 iff the sum is positive, 0 otherwise.
 */
export function simhash(tokens: string[]): bigint {
  const weights = new Array<number>(64).fill(0);
  for (const t of tokens) {
    const h = hash64(t);
    for (let bit = 0; bit < 64; bit++) {
      const mask = 1n << BigInt(63 - bit);
      if ((h & mask) !== 0n) {
        weights[bit] = (weights[bit] ?? 0) + 1;
      } else {
        weights[bit] = (weights[bit] ?? 0) - 1;
      }
    }
  }
  let out = 0n;
  for (let bit = 0; bit < 64; bit++) {
    if ((weights[bit] ?? 0) > 0) {
      out |= 1n << BigInt(63 - bit);
    }
  }
  return out;
}

/** Hamming distance between two 64-bit simhashes (number of differing bits). */
export function hamming(a: bigint, b: bigint): number {
  let x = (a ^ b) & 0xffffffffffffffffn;
  let count = 0;
  while (x !== 0n) {
    count += Number(x & 1n);
    x >>= 1n;
  }
  return count;
}
