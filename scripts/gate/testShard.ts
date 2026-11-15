// Deterministic sharding for CI: `npm test -- --shard=k/n` runs the full gate's builds and only
// the suites in shard k of n. A suite's shard is a stable hash of its repository path, so the same
// suite lands in the same shard on every platform and every run, and a new suite moves no other.
// Every suite is in exactly one shard: the union of the n shards is the full suite, and no two
// shards share one (test/scripts/gate/testShard.test.ts proves both as properties).
//
// The whole-tree static checks (tsc, ESLint, Prettier, the policy scan, the adapter ratchet,
// Studio's checks) belong to shard 1, so the n shards together run exactly what `npm test` runs.

import type { Suite } from './testDiscovery';

export const SHARD_LIMITS = {
  countMax: 16,
} as const satisfies Record<string, number>;

export interface Shard {
  // 1-based, as a person writes it: shard 1 of 4.
  readonly index: number;
  readonly count: number;
}

/** `k/n` to a shard, or the reason it is not one. */
export function parseShard(text: string): Shard | string {
  const match = /^(\d{1,2})\/(\d{1,2})$/.exec(text);
  if (match === null) {
    return `--shard takes k/n, such as 1/4 (got "${text}")`;
  }
  const index = Number(match[1]);
  const count = Number(match[2]);
  if (count < 1 || count > SHARD_LIMITS.countMax) {
    return `--shard: n is 1 to ${SHARD_LIMITS.countMax}`;
  }
  if (index < 1 || index > count) {
    return `--shard: k is 1 to n (got ${index}/${count})`;
  }
  return { index, count };
}

/** FNV-1a over the path's UTF-16 code units: tiny, stable across Node versions and platforms. */
export function stableHash(text: string): number {
  let hash = 0x811c9dc5;
  for (let position = 0; position < text.length; position += 1) {
    hash ^= text.charCodeAt(position);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** The 1-based shard a suite belongs to, out of `count`. */
export function shardOf(file: string, count: number): number {
  if (!Number.isSafeInteger(count) || count < 1 || count > SHARD_LIMITS.countMax) {
    throw new Error(`shardOf: ${count} shards is outside 1 to ${SHARD_LIMITS.countMax}`);
  }
  // The path is normalized to `/`, so Windows and POSIX checkouts agree.
  return (stableHash(file.replace(/\\/g, '/')) % count) + 1;
}

/** The suites of one shard, in their original order. */
export function suitesInShard(suites: readonly Suite[], shard: Shard): readonly Suite[] {
  if (shard.index < 1 || shard.index > shard.count) {
    throw new Error(`suitesInShard: shard ${shard.index}/${shard.count} does not exist`);
  }
  const selected = suites.filter((suite) => shardOf(suite.file, shard.count) === shard.index);
  if (selected.length > suites.length) {
    throw new Error('suitesInShard: a shard cannot hold more suites than exist');
  }
  return selected;
}
