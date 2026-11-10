// The box shorthands the spacing box reads, and the padding it writes back.
// The spacing box has one field per side, so `padding: 1rem 2rem` reached no
// field while still applying on the page. Reading projects a shorthand onto the
// sides it sets (resolved.ts); a committed padding edit rewrites the rule's own
// padding in its shortest form, so one drag never leaves four longhands beside
// the shorthand they override. Sides are physical: the box draws a horizontal
// writing mode, as the canvas bands do.

import postcss, { type AtRule, type Declaration, type Rule } from 'postcss';
import { assert } from '../../../../shared/core/assert';
import { splitTopLevelSpaces } from './background';

/** A declaration's value and whether it is `!important`. */
type Declared = { readonly value: string; readonly important: boolean };

const SIDES = ['top', 'right', 'bottom', 'left'] as const;
type Side = (typeof SIDES)[number];

type Shorthand = { readonly box: 'margin' | 'padding'; readonly sides: readonly Side[] };

// Every property projected onto sides. A padding longhand is listed as a
// shorthand of one side, so a rule's padding declarations all fold the same way.
const SHORTHANDS: ReadonlyMap<string, Shorthand> = new Map<string, Shorthand>([
  ['margin', { box: 'margin', sides: SIDES }],
  ['padding', { box: 'padding', sides: SIDES }],
  ['padding-block', { box: 'padding', sides: ['top', 'bottom'] }],
  ['padding-inline', { box: 'padding', sides: ['left', 'right'] }],
  ['padding-top', { box: 'padding', sides: ['top'] }],
  ['padding-right', { box: 'padding', sides: ['right'] }],
  ['padding-bottom', { box: 'padding', sides: ['bottom'] }],
  ['padding-left', { box: 'padding', sides: ['left'] }],
]);

const NO_SIDES: ReadonlyMap<string, string> = new Map<string, string>();

/** The side longhands `prop: value` sets, by property name (`padding-left` → its
 *  value). Empty for a property the spacing box does not read, and for a value
 *  with more parts than the property has sides. `prop` is lowercase. */
export function spacingSides(prop: string, value: string): ReadonlyMap<string, string> {
  const shorthand = SHORTHANDS.get(prop);
  if (shorthand === undefined) {
    return NO_SIDES;
  }
  const parts = splitTopLevelSpaces(value);
  const first = parts[0];
  if (first === undefined) {
    return NO_SIDES;
  }
  if (parts.length > shorthand.sides.length) {
    return NO_SIDES;
  }
  // CSS fills a missing part from the opposite side, two parts back in the
  // clockwise order, and from the first part when that one is missing too.
  const sides = new Map(shorthand.sides.map((side, index) => [`${shorthand.box}-${side}`, parts[index] ?? parts[index - 2] ?? first]));
  assert(sides.size === shorthand.sides.length, 'spacingSides: one value per side');
  return sides;
}

/** Whether `prop` is one of the padding properties a padding edit rewrites. */
export function isPaddingProperty(prop: string): boolean {
  return SHORTHANDS.get(prop.trim().toLowerCase())?.box === 'padding';
}

/** Commit a padding edit on `node`, then rewrite the node's padding in its
 *  shortest form. The new declaration replaces the node's earlier ones of the
 *  same property and goes last, so it wins over a shorthand written after them.
 *  Live previews keep their single sides: cancelling restores each on its own. */
export function setPaddingDeclaration(node: Rule | AtRule, prop: string, declared: Declared): void {
  const key = prop.trim().toLowerCase();
  assert(isPaddingProperty(key), 'setPaddingDeclaration: the property is a padding property');
  const paddingFirst = paddingDeclarations(node).length === 0;
  for (const declaration of paddingDeclarations(node)) {
    if (declaration.prop.toLowerCase() === key) {
      declaration.remove();
    }
  }
  const added = postcss.decl({ prop: key, value: declared.value, important: declared.important });
  // Before any nested rule, as every declaration the panel adds (appendDecl).
  const firstNested = node.nodes?.find((child) => child.type === 'rule' || child.type === 'atrule');
  if (firstNested) {
    node.insertBefore(firstNested, added);
  } else {
    node.append(added);
    // An edit of padding already there adds no line, so it leaves the blank one.
    if (paddingFirst) {
      fillTrailingBlankLine(node);
    }
  }
  node.assign({ raws: { ...node.raws, semicolon: true } });
  assert(paddingDeclarations(node).includes(added), 'setPaddingDeclaration: the edit is written');
  compactPadding(node);
}

/**
 * Takes the blank line before a block's closing brace, for a declaration just
 * appended at the block's end: the new line fills it, as typing there would.
 * Left in, the declaration landed above the line and the blank line stayed.
 */
export function fillTrailingBlankLine(node: Rule | AtRule): void {
  const after = node.raws.after;
  if (after === undefined) {
    return;
  }
  const filled = after.replace(/^[ \t]*(\r?\n)[ \t]*\r?\n/, '$1');
  assert(filled.length <= after.length, 'fillTrailingBlankLine: whitespace is only removed');
  node.assign({ raws: { ...node.raws, after: filled } });
}

/** Reset the padding sides among `props` on `node`, also when an earlier edit
 *  grouped one into an axis or the full shorthand: the other sides of that
 *  declaration keep their value. Returns whether the node changed. */
export function clearPaddingSides(node: Rule | AtRule, props: readonly string[]): boolean {
  const cleared = new Set(props.filter((prop) => SHORTHANDS.get(prop)?.sides.length === 1));
  if (cleared.size === 0) {
    return false;
  }
  let changed = false;
  for (const declaration of paddingDeclarations(node)) {
    const sides = spacingSides(declaration.prop.toLowerCase(), declaration.value);
    const kept = [...sides].filter(([prop]) => !cleared.has(prop));
    if (kept.length === sides.size) {
      continue;
    }
    // A var() may hold several lengths: its sides cannot be told apart.
    if (isOpaque(declaration)) {
      continue;
    }
    for (const [prop, value] of kept) {
      node.insertBefore(declaration, declaration.clone({ prop, value }));
    }
    declaration.remove();
    changed = true;
  }
  if (changed) {
    compactPadding(node);
  }
  return changed;
}

type SideValue = Declared & { readonly opaque: boolean };

// The padding declarations written directly on `node`, never a nested rule's.
function paddingDeclarations(node: Rule | AtRule): Declaration[] {
  return (node.nodes ?? []).filter((child): child is Declaration => child.type === 'decl' && isPaddingProperty(child.prop));
}

// A multi-side value with a var() or env() part: the function may substitute
// several lengths, so which side gets which cannot be read from the source.
function isOpaque(declaration: Declaration): boolean {
  const shorthand = SHORTHANDS.get(declaration.prop.toLowerCase());
  assert(shorthand !== undefined, 'isOpaque: the declaration is a padding declaration');
  if (shorthand.sides.length === 1) {
    return false;
  }
  return splitTopLevelSpaces(declaration.value).some(isSubstitution);
}

// A var() or env() standing for a whole part of a value.
const isSubstitution = (part: string): boolean => /^(var|env)\(/i.test(part);

// What each side resolves to within one node: a later declaration wins, unless
// an earlier one is `!important` and it is not. Undefined when a declaration
// cannot be read side by side, which leaves the node as written.
function paddingSideValues(declarations: readonly Declaration[]): ReadonlyMap<string, SideValue> | undefined {
  const values = new Map<string, SideValue>();
  for (const declaration of declarations) {
    const sides = spacingSides(declaration.prop.toLowerCase(), declaration.value);
    if (sides.size === 0) {
      return undefined;
    }
    const important = declaration.important;
    const opaque = isOpaque(declaration);
    for (const [prop, value] of sides) {
      const earlier = values.get(prop);
      if (earlier?.important === true && !important) {
        continue;
      }
      values.set(prop, { value, important, opaque });
    }
  }
  return values;
}

type Compact = Declared & { readonly prop: string };

// The fewest declarations that set `values`: `padding` when the four sides
// agree, else an axis property for each pair that agrees and a side otherwise.
// A var() or env() is never grouped: the shorthand it would make is one the
// next edit could not split again (isOpaque), so the result would depend on the
// order of the edits.
function compactForm(values: ReadonlyMap<string, SideValue>): readonly Compact[] {
  const equal = (first: Side, second: Side): boolean => {
    const one = values.get(`padding-${first}`);
    const other = values.get(`padding-${second}`);
    if (one === undefined || other === undefined) {
      return false;
    }
    if (isSubstitution(one.value)) {
      return false;
    }
    return one.value === other.value && one.important === other.important;
  };
  const written = (prop: string, side: Side): readonly Compact[] => {
    const entry = values.get(`padding-${side}`);
    return entry ? [{ prop, value: entry.value, important: entry.important }] : [];
  };
  if (SIDES.every((side) => equal('top', side))) {
    return written('padding', 'top');
  }
  // Every side set alike (same importance, no var() whose sides could not be
  // read back apart): one `padding` in its shortest form, as it is written by
  // hand: `padding: 0.2em 0.59em`, not `padding-block` and `padding-inline`.
  const whole = shorthandOf(values);
  if (whole !== undefined) {
    return [whole];
  }
  const block = equal('top', 'bottom') ? written('padding-block', 'top') : [...written('padding-top', 'top'), ...written('padding-bottom', 'bottom')];
  const inline = equal('left', 'right') ? written('padding-inline', 'left') : [...written('padding-right', 'right'), ...written('padding-left', 'left')];
  return [...block, ...inline];
}

function shorthandOf(values: ReadonlyMap<string, SideValue>): Compact | undefined {
  const sides = SIDES.map((side) => values.get(`padding-${side}`));
  const [top, right, bottom, left] = sides;
  if (top === undefined || right === undefined || bottom === undefined || left === undefined) {
    return undefined;
  }
  // A side read off a shorthand may carry no `important` at all: unset is not important.
  const important = top.important === true;
  if (sides.some((side) => side === undefined || (side.important === true) !== important || isSubstitution(side.value))) {
    return undefined;
  }
  // SIDES is top, right, bottom, left: the shorthand's own order.
  const parts = [top.value, right.value, bottom.value, left.value];
  if (right.value === left.value) {
    parts.pop();
    if (top.value === bottom.value) {
      parts.pop();
    }
  }
  assert(parts.length >= 2, 'A shorthand of unequal sides names at least two');
  return { prop: 'padding', value: parts.join(' '), important };
}

// Rewrite the node's own padding in its shortest form, where its first padding
// declaration stands, so an edit changes the authored lines in place. Only what
// the node declares is compacted, never a value it inherits from another rule.
// A side still held by an opaque shorthand keeps every declaration as written:
// splitting that value would be a guess.
function compactPadding(node: Rule | AtRule): void {
  const declarations = paddingDeclarations(node);
  const anchor = declarations[0];
  if (anchor === undefined) {
    return;
  }
  const values = paddingSideValues(declarations);
  if (values === undefined) {
    return;
  }
  if ([...values.values()].some((entry) => entry.opaque)) {
    return;
  }
  const compact = compactForm(values);
  assert(compact.length > 0, 'compactPadding: a padding declaration sets a side');
  assert(compact.length <= SIDES.length, 'compactPadding: at most one declaration per side');
  for (const entry of compact) {
    node.insertBefore(anchor, anchor.clone(entry));
  }
  for (const declaration of declarations) {
    declaration.remove();
  }
  // The form changed, never a side: the node resolves as it did.
  const rewritten = paddingSideValues(paddingDeclarations(node));
  assert(rewritten !== undefined, 'compactPadding: the compact form reads side by side');
  assert(rewritten.size === values.size, 'compactPadding: the same sides stay set');
  for (const [prop, entry] of values) {
    assert(rewritten.get(prop)?.value === entry.value, `compactPadding: ${prop} keeps its value`);
  }
}
