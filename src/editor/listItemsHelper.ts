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
  '\tconst valueOf = (item, path) => path.split(".").reduce((value, key) => value?.[key], item.data);',
  '\tconst plain = (value) => (value instanceof Date ? value.valueOf() : value && typeof value === "object" && "id" in value ? value.id : value);',
  '\tconst wanted = (raw, value) =>',
  '\t\traw instanceof Date ? new Date(value).valueOf() : typeof raw === "boolean" ? value === true || value === "true"',
  '\t\t: typeof raw === "number" && value !== "" && Number.isFinite(Number(value)) ? Number(value) : value;',
  '\tconst passes = (item, test) => {',
  '\t\tconst raw = valueOf(item, test.fieldPath);',
  '\t\tconst value = Array.isArray(raw) ? raw.map(plain) : plain(raw);',
  '\t\tconst expected = wanted(raw, test.value);',
  '\t\tswitch (test.operatorName) {',
  '\t\t\tcase "eq": return value === expected;',
  '\t\t\tcase "ne": return value !== expected;',
  '\t\t\tcase "contains": return String(value ?? "").toLowerCase().includes(String(expected).toLowerCase());',
  '\t\t\tcase "idin": return Array.isArray(value) ? value.includes(expected) : value === expected;',
  '\t\t\tcase "exists": return value != null && value !== "";',
  '\t\t\tcase "not-exists": return value == null || value === "";',
  '\t\t\tcase "gt": return value > expected;',
  '\t\t\tcase "gte": return value >= expected;',
  '\t\t\tcase "lt": return value < expected;',
  '\t\t\tcase "lte": return value <= expected;',
  '\t\t\tdefault: return false;',
  '\t\t}',
  '\t};',
  '\tconst key = (value) => (value instanceof Date ? value.valueOf() : typeof value === "boolean" ? Number(value) : value);',
  '\tconst compare = (left, right) => (typeof left === "number" && typeof right === "number" ? left - right : String(left ?? "").localeCompare(String(right ?? "")));',
  '\tconst ids = options.curated?.itemIds ?? [];',
  '\tlet list = ids.length > 0 ? ids.map((id) => items.find((item) => (item.data?._id ?? item.id) === id)).filter(Boolean) : [...items];',
  '\tconst tests = options.filter?.fields ?? [];',
  '\tif (tests.length > 0) {',
  '\t\tconst any = options.filter.filterFor === "ANY";',
  '\t\tlist = list.filter((item) => (any ? tests.some((test) => passes(item, test)) : tests.every((test) => passes(item, test))));',
  '\t}',
  '\tfor (const sort of [...(options.sort ?? [])].reverse()) {',
  '\t\tlist.sort((a, b) => compare(key(valueOf(a, sort.field)), key(valueOf(b, sort.field))) * (sort.direction === "desc" ? -1 : 1));',
  '\t}',
  '\tconst offset = Number(options.offset ?? 0);',
  '\tconst limit = Number(options.limit ?? 0);',
  '\treturn list.slice(offset, limit > 0 ? offset + limit : undefined);',
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
