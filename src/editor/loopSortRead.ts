// A sort comparator as sort keys: `(a, b) => b.data.date.valueOf() -
// a.data.date.valueOf()`, `a.data.title.localeCompare(b.data.title)`, several
// keys joined with `||`, a builder export's generated comparator, or a shuffle.
// Anything else is not a comparator the list settings can show.

import { chainOf, isName, relativeField } from './loopConditionRead';
import { LOOP_QUERY_LIMITS, type LoopSort, type LoopSortOrder } from './loopQuery';
import { namePath, type Js } from './loopSyntax';

/** Where an item keeps its fields: `data`, `fields`, or on itself. */
type ItemPath = readonly string[];

/** A function and the text its spans index. */
interface Located {
  readonly source: string;
  readonly node: Js;
}

// ---------------------------------------------------------------------------
// Comparators.
// ---------------------------------------------------------------------------

export interface Sorting {
  readonly sorts: readonly LoopSort[];
  readonly random: boolean;
}

/** A comparator as sort keys, or a shuffle; undefined when it is other code. */
export function readComparator(located: Located, itemPath: ItemPath): Sorting | undefined {
  const node = located.node;
  if (node.kind !== 'function' || node.body === undefined) {
    return undefined;
  }
  if (isShuffle(node.body)) {
    return { sorts: [], random: true };
  }
  const [first, second] = node.parameters;
  if (first?.kind !== 'name' || second?.kind !== 'name' || node.parameters.length !== 2) {
    return undefined;
  }
  const base = (name: string): readonly string[] => [name, ...itemPath];
  const keys = chainOf(node.body, '||');
  const sorts: LoopSort[] = [];
  for (const key of keys) {
    const sort = comparatorKey(key, { left: base(first.name), right: base(second.name) });
    if (sort === undefined || sorts.length >= LOOP_QUERY_LIMITS.sortsMax) {
      return undefined;
    }
    sorts.push(sort);
  }
  return { sorts, random: false };
}

// `Math.random() - 0.5` or `0.5 - Math.random()`.
function isShuffle(body: Js): boolean {
  if (body.kind !== 'binary' || body.operator !== '-') {
    return false;
  }
  const random = (node: Js): boolean =>
    node.kind === 'call' &&
    node.args.length === 0 &&
    namePath(node.callee)?.join('.') === 'Math.random';
  return (
    (random(body.left) && body.right.kind === 'number') ||
    (random(body.right) && body.left.kind === 'number')
  );
}

interface ComparatorBases {
  readonly left: readonly string[];
  readonly right: readonly string[];
}

function comparatorKey(node: Js, bases: ComparatorBases): LoopSort | undefined {
  // Generated: `(x === y ? 0 : x == null ? -1 : … : String(x).localeCompare(String(y))) * 1`,
  // `* -1` for descending; the test names the field.
  if (
    node.kind === 'binary' &&
    node.operator === '*' &&
    node.right.kind === 'number' &&
    Math.abs(node.right.value) === 1 &&
    node.left.kind === 'conditional'
  ) {
    const test = node.left.test;
    const key =
      test.kind === 'binary' && test.operator === '==='
        ? keyOf(sortValue(test.left), sortValue(test.right), bases, 'text')
        : undefined;
    return key === undefined || node.right.value > 0
      ? key
      : { ...key, direction: key.direction === 'ascending' ? 'descending' : 'ascending' };
  }
  // `A.localeCompare(B)`: alphabetical.
  if (
    node.kind === 'call' &&
    node.callee.kind === 'member' &&
    node.callee.property === 'localeCompare' &&
    node.args[0]
  ) {
    const left = sortValue(node.callee.object);
    const right = sortValue(node.args[0]);
    return keyOf(left, right, bases, 'text');
  }
  if (node.kind === 'binary' && node.operator === '-') {
    const left = sortValue(node.left);
    const right = sortValue(node.right);
    return keyOf(left, right, bases, subtractedOrder(left, right));
  }
  return undefined;
}

interface SortValue {
  readonly path: readonly string[];
  /** What the conversions said the field holds: a time, a switch, or a number. */
  readonly kind: 'date' | 'boolean' | 'number';
}

// A subtraction compares times when either side was made a date, switches
// when either side was asked `=== true`, and plain numbers otherwise.
function subtractedOrder(left: SortValue | undefined, right: SortValue | undefined): LoopSortOrder {
  if (left?.kind === 'date' || right?.kind === 'date') {
    return 'date';
  }
  return left?.kind === 'boolean' || right?.kind === 'boolean' ? 'boolean' : 'number';
}

// Peels the conversions a comparator wraps a field in: String(), Number(),
// unary +, `?? 0`, new Date(), Date.parse(), .valueOf(), .getTime(), and a
// switch's `=== true` (Stacki's own `Number(a.x === true) - …`).
function sortValue(node: Js): SortValue | undefined {
  let current = node;
  let kind: SortValue['kind'] = 'number';
  for (let depth = 0; depth < 6; depth++) {
    if (
      current.kind === 'binary' &&
      current.operator === '===' &&
      current.right.kind === 'boolean' &&
      current.right.value
    ) {
      kind = 'boolean';
      current = current.left;
    } else if (
      current.kind === 'binary' &&
      (current.operator === '??' || current.operator === '||')
    ) {
      current = current.left;
    } else if (current.kind === 'unary' && current.operator === '+') {
      current = current.value;
    } else if (
      current.kind === 'call' &&
      current.args.length === 1 &&
      current.args[0] &&
      (isName(current.callee, 'String') || isName(current.callee, 'Number'))
    ) {
      current = current.args[0];
    } else if (
      current.kind === 'call' &&
      current.args.length === 1 &&
      current.args[0] &&
      namePath(current.callee)?.join('.') === 'Date.parse'
    ) {
      kind = 'date';
      current = current.args[0];
    } else if (
      current.kind === 'new' &&
      isName(current.callee, 'Date') &&
      current.args.length === 1 &&
      current.args[0]
    ) {
      kind = 'date';
      current = current.args[0];
    } else if (
      current.kind === 'call' &&
      current.callee.kind === 'member' &&
      ['valueOf', 'getTime'].includes(current.callee.property) &&
      current.args.length === 0
    ) {
      kind = 'date';
      current = current.callee.object;
    } else {
      break;
    }
  }
  const path = namePath(current);
  return path === undefined ? undefined : { path, kind };
}

function keyOf(
  left: SortValue | undefined,
  right: SortValue | undefined,
  bases: ComparatorBases,
  order: LoopSortOrder,
): LoopSort | undefined {
  if (left === undefined || right === undefined) {
    return undefined;
  }
  const forward = relativeField(left.path, bases.left);
  const forwardRight = relativeField(right.path, bases.right);
  if (forward !== undefined && forward === forwardRight) {
    return { field: forward, direction: 'ascending', order };
  }
  const backward = relativeField(left.path, bases.right);
  const backwardRight = relativeField(right.path, bases.left);
  if (backward !== undefined && backward === backwardRight) {
    return { field: backward, direction: 'descending', order };
  }
  return undefined;
}
