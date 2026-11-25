// Filters, Sort and Limit on a loop over a frontmatter array of literals, shown without
// Astro. The bake rendered one copy of the loop body per item, in the array's order;
// a new query only chooses which of those copies show and in what order. So the
// array is read as data, the query is run on it the way the code Studio writes runs
// (loopQuery.ts: astroConditionCode, astroComparatorCode, sliceCode), and the result is
// a list of the array's own indexes. Anything the query cannot say exactly — custom
// code, a random order, a hand-picked selection, a list read from anywhere but a
// literal constant — has no order here, and the edit keeps its refusal.
import { assert } from '../vendor/stacki/shared/core/assert';
import { readLoop } from '../vendor/stacki/src/editor/loopQueryRead';
import { splitMapHead } from '../vendor/stacki/src/editor/loopBindings';
import { ITEM_FIELD, type LoopCondition, type LoopLiteral, type LoopQuery, type LoopSort } from '../vendor/stacki/src/editor/loopQuery';

export const LOOP_ORDER_LIMITS = {
  /** A literal array a person writes in a page: past this it is data, not markup. */
  itemsMax: 1_000,
  literalCharsMax: 200_000,
  depthMax: 16,
} as const satisfies Record<string, number>;

/** The array's indexes the loop shows, in the order it shows them. */
export type LoopOrder = readonly number[];

export interface LoopRun {
  /** The constant the loop reads. */
  readonly name: string;
  /** Item and index names, which must stay as baked for the body to read the same. */
  readonly item: string;
  readonly index: string;
  readonly order: LoopOrder;
}

/** What `head` shows, for a loop over a literal constant of `frontmatter`, or
 * undefined when the demo cannot know without running the page. */
export function loopRun(frontmatter: string, head: string | undefined): LoopRun | undefined {
  const split = splitMapHead(head);
  if (split === undefined) {
    return undefined;
  }
  const code = frontmatter.replace(/^\s*import\s[^\n]*$/gm, '');
  const reading = readLoop({ frontmatter: code, imports: [], data: split.data });
  if (reading.kind !== 'query' || reading.query.source.kind !== 'list' || reading.home !== undefined) {
    return undefined;
  }
  const items = literalArray(code, reading.query.source.collection);
  const order = items === undefined ? undefined : queryOrder(items, reading.query);
  return order === undefined ? undefined : { name: reading.query.source.collection, item: split.item, index: split.index, order };
}

/** `const name = [ … ]` read as data, when it holds nothing but literals. */
export function literalArray(frontmatter: string, name: string): readonly unknown[] | undefined {
  const declaration = new RegExp(`(?:^|[\\s;])const\\s+${name.replace(/[$]/g, '\\$')}\\s*=\\s*\\[`).exec(frontmatter);
  if (declaration === null) {
    return undefined;
  }
  const reader = new LiteralReader(frontmatter, declaration.index + declaration[0].length - 1);
  const value = reader.value(0);
  if (!Array.isArray(value) || value.length > LOOP_ORDER_LIMITS.itemsMax || reader.position - declaration.index > LOOP_ORDER_LIMITS.literalCharsMax) {
    return undefined;
  }
  return reader.failed ? undefined : value;
}

/** The literal grammar a constant of plain values uses, and nothing more: strings,
 * numbers, booleans, null, arrays and objects, with `as const` allowed after any. */
class LiteralReader {
  failed = false;
  constructor(
    private readonly text: string,
    public position: number,
  ) {}

  private fail(): undefined {
    this.failed = true;
    return undefined;
  }

  private space(): void {
    for (;;) {
      const rest = this.text.slice(this.position, this.position + 2);
      if (/^\s/.test(rest)) {
        this.position++;
      } else if (rest === '//') {
        const end = this.text.indexOf('\n', this.position);
        this.position = end < 0 ? this.text.length : end;
      } else if (rest === '/*') {
        const end = this.text.indexOf('*/', this.position + 2);
        this.position = end < 0 ? this.text.length : end + 2;
      } else {
        return;
      }
    }
  }

  value(depth: number): unknown {
    if (depth > LOOP_ORDER_LIMITS.depthMax || this.failed) {
      return this.fail();
    }
    this.space();
    const value = this.bare(depth);
    this.space();
    if (this.text.startsWith('as const', this.position)) {
      this.position += 'as const'.length;
    }
    return value;
  }

  private bare(depth: number): unknown {
    const character = this.text[this.position];
    if (character === '[') {
      return this.list(depth);
    }
    if (character === '{') {
      return this.object(depth);
    }
    if (character === '"' || character === "'" || character === '`') {
      return this.string(character);
    }
    const word = /^(?:-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?|true|false|null|undefined)(?![\w$])/i.exec(this.text.slice(this.position, this.position + 40));
    if (word === null) {
      return this.fail(); // A name or a call: only the page knows its value.
    }
    this.position += word[0].length;
    switch (word[0]) {
      case 'true':
        return true;
      case 'false':
        return false;
      case 'null':
        return null;
      case 'undefined':
        return undefined;
      default:
        return Number(word[0]);
    }
  }

  private list(depth: number): unknown[] | undefined {
    const items: unknown[] = [];
    this.position++;
    for (let count = 0; count <= LOOP_ORDER_LIMITS.itemsMax; count++) {
      this.space();
      if (this.text[this.position] === ']') {
        this.position++;
        return items;
      }
      items.push(this.value(depth + 1));
      this.space();
      if (this.text[this.position] === ',') {
        this.position++;
      } else if (this.text[this.position] !== ']') {
        return this.fail();
      }
      if (this.failed) {
        return undefined;
      }
    }
    return this.fail();
  }

  private object(depth: number): Record<string, unknown> | undefined {
    const object: Record<string, unknown> = {};
    this.position++;
    for (let count = 0; count <= LOOP_ORDER_LIMITS.itemsMax; count++) {
      this.space();
      if (this.text[this.position] === '}') {
        this.position++;
        return object;
      }
      const quote = this.text[this.position];
      const key = quote === '"' || quote === "'" ? this.string(quote) : /^[A-Za-z_$][\w$]*/.exec(this.text.slice(this.position))?.[0];
      if (typeof key !== 'string') {
        return this.fail();
      }
      if (quote !== '"' && quote !== "'") {
        this.position += key.length;
      }
      this.space();
      if (this.text[this.position] !== ':') {
        return this.fail(); // A shorthand property names a variable.
      }
      this.position++;
      object[key] = this.value(depth + 1);
      this.space();
      if (this.text[this.position] === ',') {
        this.position++;
      } else if (this.text[this.position] !== '}') {
        return this.fail();
      }
      if (this.failed) {
        return undefined;
      }
    }
    return this.fail();
  }

  private string(quote: string): string | undefined {
    let value = '';
    for (let index = this.position + 1; index < this.text.length; index++) {
      const character = this.text[index];
      if (character === quote) {
        this.position = index + 1;
        return value;
      }
      if (character === '\\') {
        const next = this.text[index + 1] ?? '';
        const escapes: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"', '`': '`' };
        const escaped = escapes[next];
        if (escaped === undefined) {
          return this.fail();
        }
        value += escaped;
        index++;
      } else if (quote === '`' && character === '$' && this.text[index + 1] === '{') {
        return this.fail(); // A template with a value in it.
      } else {
        value += character;
      }
    }
    return this.fail();
  }
}

/** The indexes `query` keeps, in its order, or undefined for what only code can say. */
export function queryOrder(items: readonly unknown[], query: LoopQuery): LoopOrder | undefined {
  if (query.random || query.customSort !== undefined || query.selection !== undefined || query.parameter.kind !== 'entry') {
    return undefined;
  }
  if (query.conditions.some((condition) => condition.kind === 'custom') || query.sorts.some((sort) => sort.order === 'fileSize')) {
    return undefined;
  }
  const kept = items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => {
      const results = query.conditions.map((condition) => conditionHolds(condition, item));
      return results.length === 0 || (query.match === 'all' ? results.every(Boolean) : results.some(Boolean));
    });
  const sorted = query.sorts.length === 0 ? kept : kept.toSorted((left, right) => compareItems(query.sorts, left.item, right.item));
  const end = query.limit === undefined ? undefined : query.offset + query.limit;
  const order = sorted.slice(query.offset, end).map(({ index }) => index);
  assert(order.length <= items.length, 'A query keeps at most every item');
  return order;
}

// `item.title`, `item.Picture?.width`: a missing parent reads as undefined, as the
// written code's optional chaining does. ITEM_FIELD is the item itself, in a list
// of plain values (fieldAccess writes it as the bare item).
function fieldOf(item: unknown, path: string): unknown {
  if (path === ITEM_FIELD) {
    return item;
  }
  let value: unknown = item;
  for (const segment of path.split('.')) {
    if (value === null || value === undefined) {
      return undefined;
    }
    value = typeof value === 'object' ? (Object.entries(value).find(([key]) => key === segment)?.[1] ?? undefined) : undefined;
  }
  return value;
}

function literalValue(literal: LoopLiteral): string | number {
  switch (literal.kind) {
    case 'text':
      return literal.text;
    case 'number':
      return literal.number;
    case 'reference':
      return literal.id;
    default: {
      const exhaustive: never = literal;
      return exhaustive;
    }
  }
}

function referenceId(value: unknown): unknown {
  if (typeof value === 'object' && value !== null && 'id' in value) {
    return value.id ?? value;
  }
  return value;
}

function textOf(value: unknown): string {
  return value === null || value === undefined ? '' : String(value);
}

// `value?.length ?? 0`: a list's count, or a text's length.
function lengthOf(value: unknown): number {
  return Array.isArray(value) || typeof value === 'string' ? value.length : 0;
}

function time(value: unknown): number {
  return new Date(typeof value === 'string' || typeof value === 'number' ? value : String(value)).valueOf();
}

// Each case mirrors the JavaScript astroConditionCode writes for the same condition.
function conditionHolds(condition: LoopCondition, item: unknown): boolean {
  assert(condition.kind === 'test', 'Custom conditions never reach evaluation');
  const field = fieldOf(item, condition.field);
  switch (condition.operator) {
    case 'is':
      return (condition.value.kind === 'reference' ? referenceId(field) : field) === literalValue(condition.value);
    case 'isNot':
      return (condition.value.kind === 'reference' ? referenceId(field) : field) !== literalValue(condition.value);
    case 'contains':
      return textOf(field).toLowerCase().includes(condition.value.toLowerCase());
    case 'has': {
      const list = Array.isArray(field) ? field : [];
      const wanted = literalValue(condition.value);
      return condition.value.kind === 'reference' ? list.some((value) => referenceId(value) === wanted) : list.includes(wanted);
    }
    case 'isSet':
      return field !== null && field !== undefined;
    case 'isEmpty':
      return field === null || field === undefined;
    case 'isTrue':
      return field === true;
    case 'isFalse':
      return field !== true;
    case 'greater':
      return Number(field) > condition.value;
    case 'less':
      return Number(field) < condition.value;
    case 'atLeast':
      return Number(field) >= condition.value;
    case 'atMost':
      return Number(field) <= condition.value;
    case 'before':
      return time(field) < time(condition.value);
    case 'after':
      return time(field) > time(condition.value);
    case 'inPast':
      return time(field) <= Date.now();
    case 'inFuture':
      return time(field) > Date.now();
    default: {
      const exhaustive: never = condition;
      return exhaustive;
    }
  }
}

// Mirrors astroComparatorCode: keys joined with `||`, so NaN and 0 fall through.
function compareItems(sorts: readonly LoopSort[], left: unknown, right: unknown): number {
  let result = 0;
  for (const sort of sorts) {
    const [first, second] = sort.direction === 'ascending' ? [left, right] : [right, left];
    result = result || compareValues(sort, fieldOf(first, sort.field), fieldOf(second, sort.field));
  }
  return result;
}

function compareValues(sort: LoopSort, left: unknown, right: unknown): number {
  switch (sort.order) {
    case 'text':
      return textOf(left).localeCompare(textOf(right));
    case 'number':
      return Number(left ?? 0) - Number(right ?? 0);
    case 'date':
      return time(left) - time(right);
    case 'boolean':
      return Number(left === true) - Number(right === true);
    case 'natural':
      return textOf(left).localeCompare(textOf(right), undefined, { numeric: true, sensitivity: 'base' });
    case 'length':
      return textOf(left).length - textOf(right).length;
    case 'count':
      return lengthOf(left) - lengthOf(right);
    case 'fileSize':
      return Number.NaN; // Refused before evaluation; a file has no size in the browser.
    default: {
      const exhaustive: never = sort.order;
      return exhaustive;
    }
  }
}
