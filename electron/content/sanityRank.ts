// Order ranks as Sanity's orderable-document-list plugin writes them: LexoRank
// strings like `0|i00007:` — a bucket, a six-digit base-36 integer, and an
// optional base-36 fraction after the colon. A document dragged between two
// others gets a rank strictly between theirs, so only it is written; nothing
// else is renumbered, and the Studio's own list agrees with Stacki's.
//
// The plugin's ranks compare as plain strings, which is how it sorts them
// (`order(orderRank asc)`). Every rank made here has the same bucket and an
// integer part of the same width as its neighbours, so string order and
// numeric order stay the same thing.

import { assert } from '../../shared/core/assert';

const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const BASE = 36n;
const INTEGER_DIGITS = 6;
// Fraction digits a rank may grow to before two neighbours are too close to
// split; reordering one list that many times without a rebalance is not usual.
const RANK_DIGITS_MAX = 64;
const RANK = /^([0-9]+)\|([0-9a-z]{6})(?::([0-9a-z]*))?$/;

export function isRank(value: unknown): value is string {
  return typeof value === 'string' && RANK.test(value);
}

/** A rank strictly between two (either may be absent, at an end of the list). */
export function rankBetween(after: string | undefined, before: string | undefined): string {
  const low = after === undefined ? undefined : parseRank(after);
  const high = before === undefined ? undefined : parseRank(before);
  if (low && high) {
    assert(low.bucket === high.bucket, 'Neighbouring ranks share a bucket');
    assert(compareDigits(low.digits, high.digits) < 0, 'A rank goes after the earlier neighbour');
  }
  const bucket = low?.bucket ?? high?.bucket ?? '0';
  const lowDigits = low?.digits ?? '0'.repeat(INTEGER_DIGITS);
  const highDigits = high?.digits ?? 'z'.repeat(INTEGER_DIGITS + 1);
  const digits = midpoint(lowDigits, highDigits);
  assert(compareDigits(lowDigits, digits) < 0, 'The new rank comes after the earlier one');
  assert(compareDigits(digits, highDigits) < 0, 'The new rank comes before the later one');
  const integer = digits.slice(0, INTEGER_DIGITS);
  const fraction = digits.slice(INTEGER_DIGITS);
  return `${bucket}|${integer}:${fraction}`;
}

function parseRank(rank: string): { readonly bucket: string; readonly digits: string } {
  const match = RANK.exec(rank);
  if (!match) {
    throw new Error(`Not an order rank: ${rank.slice(0, 40)}`);
  }
  const [, bucket = '0', integer = '', fraction = ''] = match;
  return { bucket, digits: (integer + fraction).replace(/0+$/, '').padEnd(INTEGER_DIGITS, '0') };
}

// The base-36 number halfway between two digit strings read as fractions,
// with as few digits as it needs (at least the integer width).
function midpoint(low: string, high: string): string {
  for (let width = Math.max(low.length, high.length); width <= RANK_DIGITS_MAX; width++) {
    const lower = toNumber(low.padEnd(width, '0'));
    const upper = toNumber(high.padEnd(width, '0'));
    if (upper - lower >= 2n) {
      const digits = fromNumber((lower + upper) / 2n, width).replace(/0+$/, '');
      return digits.padEnd(INTEGER_DIGITS, '0');
    }
  }
  throw new Error('These items are too close to reorder; reorder them in Sanity Studio once.');
}

function toNumber(digits: string): bigint {
  let value = 0n;
  for (const digit of digits) {
    const index = DIGITS.indexOf(digit);
    assert(index >= 0, 'A rank digit is base 36');
    value = value * BASE + BigInt(index);
  }
  return value;
}

function fromNumber(value: bigint, width: number): string {
  let rest = value;
  let out = '';
  for (let index = 0; index < width; index++) {
    out = DIGITS.charAt(Number(rest % BASE)) + out;
    rest /= BASE;
  }
  assert(rest === 0n, 'A rank fits its width');
  return out;
}

function compareDigits(left: string, right: string): number {
  const width = Math.max(left.length, right.length);
  const first = left.padEnd(width, '0');
  const second = right.padEnd(width, '0');
  if (first === second) {
    return 0;
  }
  return first < second ? -1 : 1;
}
