import type { Attr } from '../../shared/page/pageNode';
import { assert } from '../../shared/core/assert';
type ClassProps = Readonly<Record<string, Attr>>;
interface ClassEdit {
  readonly key: string;
  readonly value: Attr;
  readonly remove?: 'class';
}

// Putting a class on an element whose classes are not a plain string.
//
// Typing `.hero` in the style panel writes a rule for `.hero`, and a rule for a
// class the element does not carry never applies — so the class goes on the
// element too. `class="a b"` is easy. The elements worth styling often aren't
// that: a component that takes a `class` prop writes
//
//   class:list={["section", padClass("top", paddingTop), …, className]}
//
// and the app used to leave those alone, silently. Nothing appeared in the
// class attribute and nothing said why.
//
// A class:list is a list, so a class is appended to it — the same edit a person
// would make, in the same place. A `class` written as a template literal grows
// by one word inside the quotes. Other class expressions stay untouched:
// A class:list combines their result with the new name without changing the expression.

const LIST = 'class:list';

/**
 * Where a new class goes among the ones already written: at the end, or next to
 * a class the element carries. The selector field's caret can sit between two
 * chips, and a class typed there is written there, so the element's class order
 * (which is also the chips' order) matches what the person saw while typing.
 */
export type ClassPlacement =
  { readonly kind: 'end' } | { readonly kind: 'before'; readonly className: string } | { readonly kind: 'after'; readonly className: string };

export const PLACEMENT_END: ClassPlacement = { kind: 'end' };

const quoted = (name: string): string => JSON.stringify(name);

/** Every class name the attribute mentions literally. */
export function namesIn(prop: Attr | undefined): readonly string[] {
  if (!prop) {
    return [];
  }
  if (prop.type === 'string') {
    return String(prop.value).trim().split(/\s+/).filter(Boolean);
  }
  const text = String(('value' in prop ? prop.value : '') || '');
  // Quoted strings in an expression, plus the words inside a template literal —
  // the literal parts only, since `${theme}` is not a name until it runs.
  const out = [];
  for (const match of text.matchAll(/"([^"]*)"|'([^']*)'|`([^`]*)`/g)) {
    const inner = match[1] ?? match[2] ?? match[3] ?? '';
    for (const word of inner.split(/\$\{[^}]*\}|\s+/)) {
      if (word) {
        out.push(word);
      }
    }
  }
  return out;
}

/** Whether the element already carries `name`, however its classes are written. */
export function hasClass(props: ClassProps | undefined, name: unknown): boolean {
  const clean = String(name || '').trim();
  if (!clean) {
    return true;
  }
  return ['class', LIST].some((key) => namesIn(props?.[key]).includes(clean));
}

/**
 * The prop to write so the element carries `name`, plus the old prop to remove
 * when migrating to class:list. Undefined means an invalid name or attribute shape.
 *
 * Returns undefined for "already there" as well: the caller has `hasClass` for
 * telling those apart, and neither is an edit.
 */
export function withClass(props: ClassProps | undefined, name: unknown, placement: ClassPlacement = PLACEMENT_END): ClassEdit | undefined {
  const clean = String(name || '').trim();
  if (!clean || /\s/.test(clean)) {
    return undefined;
  }
  if (hasClass(props, clean)) {
    return undefined;
  }

  const list = props?.[LIST];
  if (list) {
    if (list.type !== 'expr') {
      return undefined;
    }
    const text = String(list.value || '').trim();
    const at = text.lastIndexOf(']');
    if (!text.startsWith('[') || at < 0) {
      // A list that isn't written as one — `class:list={props.classes}`. It
      // still takes an array, so wrap it in the one being added to.
      return { key: LIST, value: { type: 'expr', value: `[${text}, ${quoted(clean)}]` } };
    }
    const head = text.slice(0, at);
    const tail = text.slice(at);
    // Keep the shape it was written in: a list broken over lines gets its own
    // line, indented like the entry above it, trailing comma and all.
    const lines = head.split('\n');
    const last = lines.at(-1) ?? '';
    if (lines.length > 1) {
      const indent = (head.match(/\n([ \t]*)\S/) || [, '  '])[1];
      const comma = /,\s*$/.test(head) ? '' : ',';
      const closingIndent = last.match(/^[ \t]*/)?.[0] ?? '';
      const opening = `${head.replace(/\s+$/, '')}${comma}\n${indent}${quoted(clean)},`;
      return {
        key: LIST,
        value: {
          type: 'expr',
          value: `${opening}\n${closingIndent}${tail}`,
        },
      };
    }
    const placed = placedInList(text, clean, placement);
    if (placed !== undefined) {
      return { key: LIST, value: { type: 'expr', value: placed } };
    }
    const comma = /\[\s*$/.test(head) ? '' : ', ';
    return { key: LIST, value: { type: 'expr', value: `${head}${comma}${quoted(clean)}${tail}` } };
  }

  const cls = props?.['class'];
  if (!cls) {
    return { key: 'class', value: { type: 'string', value: clean } };
  }
  if (cls.type === 'string') {
    const words = namesIn(cls);
    return { key: 'class', value: { type: 'string', value: placedInWords(words, clean, placement).join(' ') } };
  }
  if (cls.type === 'expr') {
    const text = String(cls.value || '').trim();
    // A template literal is a string being built: one more word in it is one
    // more class, wherever the holes happen to be.
    if (text.startsWith('`') && text.endsWith('`') && text.length > 1) {
      return { key: 'class', value: { type: 'expr', value: `${text.slice(0, -1)} ${clean}\`` } };
    }
    return withClassExpression(text, clean);
  }
  return undefined;
}

// The words of a plain `class="…"` with `name` placed where it was asked for.
// An anchor the attribute doesn't hold places it at the end, as before.
export function placedInWords(words: readonly string[], name: string, placement: ClassPlacement): readonly string[] {
  assert(!words.includes(name), 'placedInWords: the class is not already written');
  const anchor = placement.kind === 'end' ? -1 : words.indexOf(placement.className);
  const at = anchor === -1 ? words.length : placement.kind === 'before' ? anchor : anchor + 1;
  const placed = [...words.slice(0, at), name, ...words.slice(at)];
  assert(placed.length === words.length + 1, 'placedInWords: exactly one class is added');
  return placed;
}

// A one-line `class:list={[…]}` with the new entry beside the quoted anchor. A list
// broken over lines, or one whose anchor is not a quoted entry of its own, is left
// to the append path (undefined): the entry lands last, which is still correct CSS,
// only not in the caret's order.
function placedInList(text: string, name: string, placement: ClassPlacement): string | undefined {
  if (placement.kind === 'end') {
    return undefined;
  }
  if (text.includes('\n')) {
    return undefined;
  }
  // A standalone entry only: `cond && "a"` holds the anchor too, and a name put
  // beside it there would change what the condition guards.
  const anchor = new RegExp(`([\\[,]\\s*)(["'])${escapeRegExp(placement.className)}\\2(?=\\s*[,\\]])`).exec(text);
  if (anchor === null) {
    return undefined;
  }
  const lead = anchor[1] ?? '';
  const start = anchor.index + lead.length;
  const end = anchor.index + anchor[0].length;
  assert(start < end, 'placedInList: the anchor entry is not empty');
  if (placement.kind === 'before') {
    return `${text.slice(0, start)}${quoted(name)}, ${text.slice(start)}`;
  }
  return `${text.slice(0, end)}, ${quoted(name)}${text.slice(end)}`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function withClassExpression(text: string, name: string): ClassEdit {
  // One attribute works across Astro versions. Parentheses preserve comma
  // expressions; a newline keeps trailing line comments out of the added syntax.
  const expression = text.includes('//') ? `${text}\n` : text;
  return {
    key: LIST,
    value: { type: 'expr', value: `[(${expression}), ${quoted(name)}]` },
    remove: 'class',
  };
}

export default withClass;
