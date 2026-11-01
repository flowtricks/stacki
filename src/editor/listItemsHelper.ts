// The helper a list kept as data is read through, written into a component's
// frontmatter when one of its list's settings is linked to a property:
//
//   const listItems = (items, options) => { … };
//   const posts = listItems(await getCollection("blog"), {"filter": propFilters, "sort": […]});
//
// Code cannot be a prop's value, so a list Stacki wrote as code (a filter
// callback, a comparator) is rewritten as the data a builder's export keeps
// (optionsQuery.ts reads and writes it), and this applies that data to the
// collection's entries at build time. It lives in the component rather than a
// file of its own so linking stays one edit and one undo step, and so the
// component works wherever it is copied.
//
// Its semantics are the ones the list settings show: references compare by
// id, a switch "is off" when it is false or unset, dates compare as times,
// "contains" ignores case, and picked items are matched by the id the item
// picker lists (`data._id`, as an export has it, or the entry's id).

import { assert } from '../../shared/core/assert';
import type { ParsedFrontmatter } from './loopSyntax';

export const LIST_ITEMS_NAME = 'listItems';

// The first line of the helper, which also says it is Stacki's.
const SIGNATURE = 'const listItems = (items, options) => {';

const HELPER_LINES: readonly string[] = [
  `${SIGNATURE} // stacki:list-items: applies a list's settings kept as data`,
  '  const valueOf = (item, path) => path.split(".").reduce((value, key) => value?.[key], item.data);',
  '  const plain = (value) => (value instanceof Date ? value.valueOf() : value && typeof value === "object" && "id" in value ? value.id : value);',
  '  const wanted = (raw, value) =>',
  '    raw instanceof Date ? new Date(value).valueOf() : typeof raw === "boolean" ? value === true || value === "true"',
  '    : typeof raw === "number" && value !== "" && Number.isFinite(Number(value)) ? Number(value) : value;',
  '  const passes = (item, test) => {',
  '    const raw = valueOf(item, test.fieldPath);',
  '    const value = Array.isArray(raw) ? raw.map(plain) : plain(raw);',
  '    const expected = wanted(raw, test.value);',
  '    switch (test.operatorName) {',
  '      case "eq": return value === expected;',
  '      case "ne": return value !== expected;',
  '      case "contains": return String(value ?? "").toLowerCase().includes(String(expected).toLowerCase());',
  '      case "idin": return Array.isArray(value) ? value.includes(expected) : value === expected;',
  '      case "exists": return value != null && value !== "";',
  '      case "not-exists": return value == null || value === "";',
  '      case "gt": return value > expected;',
  '      case "gte": return value >= expected;',
  '      case "lt": return value < expected;',
  '      case "lte": return value <= expected;',
  '      default: return false;',
  '    }',
  '  };',
  '  const key = (value) => (value instanceof Date ? value.valueOf() : typeof value === "boolean" ? Number(value) : value);',
  '  const compare = (left, right) => (typeof left === "number" && typeof right === "number" ? left - right : String(left ?? "").localeCompare(String(right ?? "")));',
  '  const ids = options.curated?.itemIds ?? [];',
  '  let list = ids.length > 0 ? ids.map((id) => items.find((item) => (item.data?._id ?? item.id) === id)).filter(Boolean) : [...items];',
  '  const tests = options.filter?.fields ?? [];',
  '  if (tests.length > 0) {',
  '    const any = options.filter.filterFor === "ANY";',
  '    list = list.filter((item) => (any ? tests.some((test) => passes(item, test)) : tests.every((test) => passes(item, test))));',
  '  }',
  '  for (const sort of [...(options.sort ?? [])].reverse()) {',
  '    list.sort((a, b) => compare(key(valueOf(a, sort.field)), key(valueOf(b, sort.field))) * (sort.direction === "desc" ? -1 : 1));',
  '  }',
  '  const offset = Number(options.offset ?? 0);',
  '  const limit = Number(options.limit ?? 0);',
  '  return list.slice(offset, limit > 0 ? offset + limit : undefined);',
  '};',
];

/** The helper's declaration, as written above the first list that uses it. */
export const LIST_ITEMS_HELPER: string = HELPER_LINES.join('\n');

/**
 * What the frontmatter needs for a list kept as data: nothing when Stacki's
 * helper is already there, or the helper to add. A `listItems` of the page's
 * own that is not Stacki's is refused rather than shadowed.
 */
export function listItemsNeed(frontmatter: ParsedFrontmatter): { readonly kind: 'present' } | { readonly kind: 'add' } | { readonly kind: 'taken' } {
  if (!frontmatter.bound.has(LIST_ITEMS_NAME)) {
    return { kind: 'add' };
  }
  const declaration = frontmatter.declarations.get(LIST_ITEMS_NAME);
  const ours = declaration !== undefined && frontmatter.source.slice(declaration.statement.from, declaration.statement.to).startsWith(SIGNATURE);
  assert(LIST_ITEMS_HELPER.startsWith(SIGNATURE), 'The helper starts with its signature');
  return ours ? { kind: 'present' } : { kind: 'taken' };
}
