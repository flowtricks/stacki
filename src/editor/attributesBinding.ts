// An element's attributes connected to a component's attributes prop, which
// is Astro's rest props spread onto it:
//
//   <p data-testing="1" {...rest} data-text="">
//
// Astro gives a rest binding no default, so the prop's defaults are the
// attributes written before the spread: an instance passing the same name
// overrides them. The attributes after the spread are the element's own and
// override what an instance passes. That order is the whole model, so it is
// read and written here and nowhere else. Props are an ordered record
// (pageNode.ts keys a spread by its source, `...rest`), so order is kept by
// building a new record rather than patching one.
//
// Connecting puts the spread after the element's attributes, so an instance
// can override each of them (Astro: a later attribute wins), and the
// Attributes list shows them in source order with the spread last, as
// "+ items in {} rest". Class, style and directives stay after it: the class
// and style fields own them, and an instance's `class` would otherwise
// replace the component's own classes instead of reaching it through a field.
// A new attribute added while connected goes before the spread, so it stays a
// default. Disconnecting takes out the spread alone; every attribute stays.

import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import type { Attr } from '../../shared/page/pageNode';
import type { AttributeDefault } from './propDeclaration';
import type { EditorNode } from './pageView';

// Read with absent values allowed, as the props panel holds them; written without.
type Props = Readonly<Record<string, Attr | undefined>>;
type WrittenProps = Readonly<Record<string, Attr>>;

/** An element's attributes split around a rest spread. */
export interface AttributesBinding {
  /** The attributes before the spread, which the prop's defaults are. */
  readonly defaults: readonly AttributeDefault[];
  /** The names of the attributes after the spread: the element's own. */
  readonly own: readonly string[];
}

// Attributes that are never a default even when written first: the class and
// style fields own them, and a directive is not an attribute an instance passes.
const NOT_DEFAULTS = /^(class|style|class:list|slot)$|^(set|is|client|server|transition|define):/;

/** The key a spread of `local` has in an element's props. */
export function spreadKey(local: string): string {
  assert(/^[A-Za-z_$][\w$]*$/.test(local), 'spreadKey: a rest binding is an identifier');
  return `...${local}`;
}

/** How an element's attributes sit around a spread of `local`, or undefined when it has none. */
export function readAttributesBinding(props: Props | undefined, local: string): AttributesBinding | undefined {
  const entries = present(props);
  assert(entries.length <= LIMITS.attrsPerNodeMax, 'readAttributesBinding: attribute limit exceeded');
  const at = entries.findIndex(([name]) => name === spreadKey(local));
  if (at < 0) {
    return undefined;
  }
  const defaults: AttributeDefault[] = [];
  for (const [name, value] of entries.slice(0, at)) {
    if (!NOT_DEFAULTS.test(name) && (value.type === 'string' || value.type === 'bare')) {
      defaults.push({ name, value: value.type === 'string' ? value.value : '' });
    }
  }
  const own = entries.slice(at + 1).map(([name]) => name);
  assert(defaults.length + own.length < entries.length, 'readAttributesBinding: the spread is neither a default nor its own');
  return { defaults, own };
}

/**
 * The element's props connected to `local`: the attributes an instance may
 * override, `defaults`, the spread, then the element's own (class, style,
 * directives, and whatever already followed the spread). Connecting again (to
 * change the defaults) replaces the defaults before the spread and keeps every
 * other attribute where it is. A default named like one of its own attributes
 * is dropped: the own one would always win.
 */
export function boundAttributes(props: Props | undefined, local: string, defaults: readonly AttributeDefault[]): WrittenProps {
  const key = spreadKey(local);
  const entries = present(props);
  const at = entries.findIndex(([name]) => name === key);
  const connected = at >= 0;
  const before = connected ? entries.slice(0, at).filter((entry) => !isDefaultable(entry)) : entries.filter((entry) => !isOwn(entry, local));
  const after = connected ? entries.slice(at + 1) : entries.filter((entry) => isOwn(entry, local));
  const ownNames = new Set(after.map(([name]) => name));
  const replaced = new Set(defaults.map((entry) => entry.name));
  const out: Record<string, Attr> = {};
  for (const [name, value] of before) {
    if (!replaced.has(name)) {
      define(out, name, value);
    }
  }
  for (const entry of defaults) {
    if (!ownNames.has(entry.name)) {
      define(out, entry.name, entry.value === '' ? { type: 'bare' } : { type: 'string', value: entry.value });
    }
  }
  define(out, key, { type: 'spread', value: local });
  for (const [name, value] of after) {
    define(out, name, value);
  }
  assert(Object.keys(out).length <= LIMITS.attrsPerNodeMax, 'boundAttributes: attribute limit exceeded');
  assert(readAttributesBinding(out, local) !== undefined, 'boundAttributes: the spread reads back');
  return out;
}

/** The element's props with the spread of `local` taken out; every attribute stays where it was. */
export function unboundAttributes(props: Props | undefined, local: string): WrittenProps {
  const key = spreadKey(local);
  const out: Record<string, Attr> = {};
  for (const [name, value] of present(props)) {
    if (name !== key) {
      define(out, name, value);
    }
  }
  assert(readAttributesBinding(out, local) === undefined, 'unboundAttributes: the spread is gone');
  assert(Object.keys(out).length >= present(props).length - 1, 'unboundAttributes: only the spread is taken out');
  return out;
}

/**
 * The element's props with `name` added as a default of the spread of
 * `local`: just before the spread, so an instance can still override it.
 * Without the spread, `name` goes last, as any new attribute does.
 */
export function withDefaultAttribute(props: Props | undefined, local: string, name: string, value: Attr): WrittenProps {
  const key = spreadKey(local);
  assert(name !== key, 'withDefaultAttribute: the spread is not a default');
  assert(!Object.hasOwn(props ?? {}, name), 'withDefaultAttribute: the attribute is new');
  const out: Record<string, Attr> = {};
  for (const [entryName, entryValue] of present(props)) {
    if (entryName === key) {
      define(out, name, value);
    }
    define(out, entryName, entryValue);
  }
  if (!Object.hasOwn(out, name)) {
    define(out, name, value);
  }
  assert(Object.keys(out).length <= LIMITS.attrsPerNodeMax + 1, 'withDefaultAttribute: attribute limit exceeded');
  return out;
}

/**
 * Whether the markup reads `local` anywhere but the one spread being taken
 * out: another element's `{...rest}`, or an expression such as `{rest.id}`.
 * Reading the text, not the tree, so every use counts, and a use counted
 * wrongly only keeps the prop (the safe side).
 */
export function restUsedElsewhere(markup: string, local: string): boolean {
  assert(/^[A-Za-z_$][\w$]*$/.test(local), 'restUsedElsewhere: a rest binding is an identifier');
  assert(markup.length <= LIMITS.sourceBytesMax, 'restUsedElsewhere: the markup is bounded');
  const word = new RegExp(`(?<![\\w$])${local.replace(/\$/g, '\\$')}(?![\\w$])`, 'g');
  let count = 0;
  for (const match of markup.matchAll(word)) {
    assert(match.index <= markup.length, 'restUsedElsewhere: a match is in the markup');
    count++;
    if (count > 1) {
      return true;
    }
  }
  return false;
}

// An attribute that stays after the spread when one is connected: the class
// and style fields' own, a directive, or another spread.
function isOwn([name, value]: readonly [string, Attr], local: string): boolean {
  return NOT_DEFAULTS.test(name) || (value.type === 'spread' && name !== spreadKey(local));
}

// An attribute before the spread that is one of the prop's defaults.
function isDefaultable([name, value]: readonly [string, Attr]): boolean {
  return !NOT_DEFAULTS.test(name) && (value.type === 'string' || value.type === 'bare');
}

// The attributes that have a value, in order.
function present(props: Props | undefined): readonly (readonly [string, Attr])[] {
  const out: (readonly [string, Attr])[] = [];
  for (const [name, value] of Object.entries(props ?? {})) {
    if (value !== undefined) {
      out.push([name, value]);
    }
  }
  return out;
}

// `__proto__` is an ordinary attribute name; assigning it would hit the setter.
function define(target: Record<string, Attr>, name: string, value: Attr): void {
  Object.defineProperty(target, name, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * The node with its attributes replaced, in the order given: the source spans
 * describe the attributes as they were, so they go, and the attribute order is
 * the new one (pageEdits.ts writes a node from its props and that order, as
 * loopRebind.ts does for its rewrites).
 */
export function withAttributes(node: EditorNode, props: WrittenProps): EditorNode {
  const { attrSpans: staleSpans, ...rest } = node;
  void staleSpans;
  const order = Object.keys(props);
  assert(order.length <= LIMITS.attrsPerNodeMax, 'withAttributes: attribute limit exceeded');
  const out: EditorNode = { ...rest, props, attrOrder: order };
  assert(out.attrSpans === undefined, 'withAttributes: stale spans are gone');
  return out;
}
