// The selected element's `style` attribute as a Style panel target (the
// "Inline styles" chip, SelectorPicker.tsx). Reads come from the attribute as
// the page model holds it; writes are the attribute's next text, made by the
// same declaration editor the page edit itself uses (shared/engine/inlineStyle.ts),
// so the order, spacing and bytes of every declaration nobody touched survive.
//
// Pure: the panel's hook (embed/useInlineTarget.ts) owns the state and the host
// call, and this file only decides what the attribute says and what it becomes.

import { assert } from '../../../../shared/core/assert';
import { LIMITS } from '../../../../shared/core/limits';
import { editInlineStyle, readInlineStyle, type InlineDeclaration } from '../../../../shared/engine/inlineStyle';
import type { StyleDeclaration } from '../../../../shared/engine/intent';
import type { HostNode } from './host';
import { readableStyleCode, readableStyleText, styleExpressionSpanInSource } from './inlineCode';
import { readStyleBranches, type StyleBranch } from './inlineBranches';

/** What the selected element's `style` attribute holds, as far as the panel goes. */
export type InlineStyle =
  // No attribute, a bare one, or one with nothing but whitespace: no chip.
  | { readonly kind: 'none' }
  // A plain string the declaration reader holds: the panel edits it.
  | { readonly kind: 'declarations'; readonly text: string; readonly declarations: readonly InlineDeclaration[] }
  // An expression the conditional model reads (`maxWidth ? `…` : undefined`, a
  // template): edited branch by branch, where `source` says (inlineBranches.ts).
  | { readonly kind: 'branched'; readonly expression: string; readonly branches: readonly StyleBranch[]; readonly source: InlineSource }
  // Code the panel cannot hold: shown read-only (`code`, model/inlineCode.ts), with why.
  | { readonly kind: 'code'; readonly reason: InlineCodeReason; readonly message: string; readonly code: string };

/** Where an expression's edits are written. */
export type InlineSource =
  // The selected node's own `style={…}`.
  | { readonly kind: 'node' }
  // The component file an instance renders (Heading.astro), at the expression's offsets.
  | { readonly kind: 'component'; readonly path: string; readonly fileName: string; readonly text: string; readonly start: number; readonly end: number };

export type InlineCodeReason =
  | 'expression'
  | 'unreadable'
  // A component instance whose rendered element carries a `style` its component
  // writes (`<Heading maxWidth={30}>`): the instance's props in Settings drive it.
  | 'component';

/** The attribute's next text: undefined removes it (the last declaration went). */
export type InlineWrite = { readonly tag: 'write'; readonly next: string | undefined } | { readonly tag: 'refused'; readonly message: string };

/** How a contributor from the style attribute is named where a selector would be.
 *  `@` cannot start a selector, so no rule's text can ever equal it. */
export const INLINE_STYLE_SELECTOR = '@inline-style';
export const INLINE_STYLE_LABEL = 'Inline styles';

export const INLINE_NONE: InlineStyle = { kind: 'none' };

// The most properties one panel gesture writes at once: a shorthand's sides,
// the spacing box's centre, a section's clear. Far above any real gesture.
const INLINE_WRITE_PROPERTIES_MAX = 64;

/** The selected node's `style` attribute, read. */
export function inlineStyleOf(node: Pick<HostNode, 'props'> | undefined): InlineStyle {
  const attribute = node?.props?.['style'];
  if (attribute === undefined) {
    return INLINE_NONE;
  }
  const value = attribute.value ?? '';
  if (value.trim() === '') {
    // `style`, `style=""` and `style={}` say nothing for the panel to show.
    return INLINE_NONE;
  }
  if (attribute.type !== 'string') {
    // `{maxWidth ? `--_mw: ${maxWidth}ch;` : undefined}`, a template: by branch.
    return expressionStyle(value, { kind: 'node' });
  }
  if (value.length > LIMITS.attrCharsMax) {
    return { kind: 'code', reason: 'unreadable', message: UNREADABLE, code: readableStyleText(value.slice(0, LIMITS.attrCharsMax)) };
  }
  const declarations = readInlineStyle(value);
  if (declarations === undefined) {
    return { kind: 'code', reason: 'unreadable', message: UNREADABLE, code: readableStyleText(value) };
  }
  if (declarations.length === 0) {
    // Only separators (`;`): nothing is declared.
    return INLINE_NONE;
  }
  return { kind: 'declarations', text: value, declarations };
}

const UNREADABLE = 'This style attribute is not a plain list of declarations.';

/** An expression as the panel edits it: by branch, or read-only with the reason. */
export function expressionStyle(expression: string, source: InlineSource): InlineStyle {
  const read = readStyleBranches(expression);
  if (read.tag === 'unsupported') {
    return { kind: 'code', reason: 'expression', message: read.reason, code: readableStyleCode(expression) };
  }
  assert(read.branches.length > 0, 'expressionStyle: an editable expression has a branch');
  return { kind: 'branched', expression, branches: read.branches, source };
}

/** The branch the panel edits: the one picked, else the first. */
export function selectedBranch(style: Extract<InlineStyle, { kind: 'branched' }>, key: string | undefined): StyleBranch {
  const first = style.branches[0];
  assert(first !== undefined, 'selectedBranch: an expression has a branch');
  return style.branches.find((branch) => branch.key === key) ?? first;
}

/** Whether the chip is shown: the attribute holds something. */
export function hasInlineChip(style: InlineStyle): boolean {
  return style.kind !== 'none';
}

/**
 * The style the chip stands for. A node's own attribute first; a component
 * instance with none of its own has the one its component writes on the element
 * it renders, which the canvas reports (`rendered`). The instance's tag holds no
 * text of it to edit, so that is always the code state.
 */
export function chipInlineStyle(
  own: InlineStyle,
  rendered: {
    readonly instance: boolean;
    readonly style: string | undefined;
    /** The component file's path and text, when held (componentSourceCache.ts). */
    readonly component: { readonly path: string; readonly text: string } | undefined;
  },
): InlineStyle {
  if (own.kind !== 'none') {
    return own;
  }
  if (!rendered.instance) {
    return own;
  }
  if (rendered.style === undefined) {
    return own;
  }
  if (rendered.style.trim() === '') {
    return own;
  }
  const component = rendered.component;
  const span = component === undefined ? undefined : styleExpressionSpanInSource(component.text);
  if (component === undefined || span === undefined) {
    // Without the component's file, what the canvas rendered, read-only.
    return { kind: 'code', reason: 'component', message: 'The component that writes this style could not be read.', code: readableStyleText(rendered.style) };
  }
  const fileName = component.path.split(/[\\/]/).pop() ?? component.path;
  return expressionStyle(span.expression, { kind: 'component', path: component.path, fileName, text: component.text, start: span.start, end: span.end });
}

/**
 * Whether the well shows the chip. Code is always shown (Settings edits it, so the
 * host need not write); declarations only where the host can write them back. A
 * ::before or ::after row styles a box the attribute never reaches.
 */
export function inlineChipShown(style: InlineStyle, host: { readonly writable: boolean; readonly pseudo: boolean }): boolean {
  if (host.pseudo) {
    return false;
  }
  switch (style.kind) {
    case 'none':
      return false;
    case 'code':
      return true;
    case 'branched':
      return true;
    case 'declarations':
      return host.writable;
    default: {
      const exhaustive: never = style;
      return exhaustive;
    }
  }
}

/** A property's declaration, as the panel writes it. */
export function inlineDeclaration(value: string, flags: { readonly important: boolean }): StyleDeclaration {
  const trimmed = value.trim();
  assert(trimmed !== '', 'inlineDeclaration: a set has a value; an empty one is a removal');
  return { tag: 'set', value: flags.important ? `${trimmed} !important` : trimmed };
}

/**
 * The attribute's text once each property is set or removed, in order, from
 * `text`. Removing every declaration removes the attribute. Refused, with
 * the reason, when a property is declared twice (which one the browser uses is
 * the cascade's call, and editing either is a guess) or the result would not
 * read back as the declarations meant.
 */
export function inlineStyleWrite(text: string, properties: readonly string[], declaration: StyleDeclaration): InlineWrite {
  assert(properties.length > 0, 'inlineStyleWrite: a write names a property');
  assert(properties.length <= INLINE_WRITE_PROPERTIES_MAX, 'inlineStyleWrite: a write names a handful of properties');
  if (text.length > LIMITS.attrCharsMax) {
    return { tag: 'refused', message: 'This style attribute is too long to edit here. Edit it in Settings.' };
  }
  let next = text;
  for (const property of properties) {
    assert(property.trim() === property, 'inlineStyleWrite: property names come trimmed');
    assert(property !== '', 'inlineStyleWrite: property names are not empty');
    const edited = editInlineStyle(next, property, declaration);
    if (edited.tag === 'ambiguous') {
      return { tag: 'refused', message: `${property} is declared twice in the style attribute. Edit it in Settings.` };
    }
    if (edited.tag === 'unreadable') {
      return { tag: 'refused', message: 'The style attribute is not a plain list of declarations. Edit it in Settings.' };
    }
    next = edited.text;
  }
  if (next.length > LIMITS.attrCharsMax) {
    return { tag: 'refused', message: 'That would make the style attribute too long.' };
  }
  const read = readInlineStyle(next);
  if (read === undefined) {
    // A value with a stray bracket or quote would break every declaration after it.
    return { tag: 'refused', message: 'That value would break the style attribute. Check its brackets and quotes.' };
  }
  if (declaration.tag === 'set') {
    // A value holding its own top-level `;` would write a second declaration nobody asked for.
    const alone = readInlineStyle(`x: ${declaration.value}`);
    if (alone?.length !== 1) {
      return { tag: 'refused', message: 'A value cannot hold a “;” of its own here.' };
    }
  }
  if (read.length === 0) {
    return { tag: 'write', next: undefined };
  }
  assert(next.trim() !== '', 'inlineStyleWrite: a list with declarations has text');
  return { tag: 'write', next };
}

/** A plain string attribute as the CSS code editor's one branch: always applied. */
export function plainStyleBranch(text: string): StyleBranch {
  assert(text.length <= LIMITS.attrCharsMax, 'plainStyleBranch: an attribute is inside its bound');
  return { key: '0', label: 'always', start: 0, end: text.length, form: { kind: 'string', quote: '"' }, body: text };
}

/**
 * The attribute's next text from the CSS code editor's whole declaration list: the
 * text as typed (every byte the person left alone stays), undefined to remove it
 * when emptied, refused while it is not a declaration list the panel reads back.
 */
export function plainStyleCommit(body: string): InlineWrite {
  if (body.length > LIMITS.attrCharsMax) {
    return { tag: 'refused', message: 'That would make the style attribute too long.' };
  }
  if (body.trim() === '') {
    return { tag: 'write', next: undefined };
  }
  if (readInlineStyle(body) === undefined) {
    return { tag: 'refused', message: 'The style attribute is not a list of declarations yet: check its colons, brackets and quotes.' };
  }
  return { tag: 'write', next: body };
}

/** The text to edit from: the host's, unless a write the panel made has not reached it yet. */
export interface HeldInlineWrite {
  readonly nodeId: string;
  /** The host's text when the write was made. */
  readonly base: string | undefined;
  /** What the write made it. */
  readonly next: string | undefined;
}

/**
 * Two writes in one tick (the spacing box's centre sets four sides) both read the
 * attribute before the page model has taken the first: the second would drop it.
 * While the host still shows the text the held write started from, that write's
 * result is the attribute.
 */
export function inlineEditBase(hostText: string | undefined, nodeId: string, held: HeldInlineWrite | undefined): string {
  if (held === undefined) {
    return hostText ?? '';
  }
  if (held.nodeId !== nodeId) {
    return hostText ?? '';
  }
  if (held.base === hostText) {
    return held.next ?? '';
  }
  return hostText ?? '';
}
