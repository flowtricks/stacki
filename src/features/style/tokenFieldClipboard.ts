import { assert } from '../../../shared/core/assert';
import { isHTMLElementInDocument } from './model/dom';

// Copy, cut, paste and drop for the token field (TokenField.tsx).
//
// The field draws each variable as a chip: a `contenteditable="false"` element
// whose visible text is the variable's short name and an icon. Left to the
// browser, a copy writes what is drawn, and Chromium writes a non-editable
// inline-flex chip as a line break: select all over
// `color-mix(in srgb, red 10%, transparent var(--max-width-full))` and copy gave
// `color-mix(in srgb, red 10%, transparent \n)`, the variable gone. A paste of
// `var(--x)` landed as plain text. The field answers
// these events itself instead: a copy writes the CSS the selection stands for,
// byte for byte, with each chip as the reference it was made from; a paste or a
// drop reads plain text and draws every reference in it as a chip again. Plain
// text only, so what goes to another app is the CSS a person would type.

// A variable reference, the same pattern the field's chips are drawn from
// (VariableConnect.tsx, valueChips): `var(--name)` or `var(--name, fallback)`.
// An unclosed `var(` never matches, so it stays text.
export const VARIABLE_REFERENCE_PATTERN = /var\(\s*--[A-Za-z0-9_-]+[^)]*\)/gi;

export const CLIPBOARD_LIMITS = {
  // A pasted value is a line of CSS, or a few; a clipboard far past this is not a value.
  pastedCharactersMax: 65_536,
  // How many references a paste draws as chips (TOKEN_FIELD_LIMITS.chipsMax).
  referencesMax: 256,
  // How deep a copied selection is read (TOKEN_FIELD_LIMITS.nestingDepthMax).
  nestingDepthMax: 64,
} as const satisfies Record<string, number>;

// The zero-width caret slot buildTokenHtml leaves beside a chip, and the
// non-breaking space Chromium types at the end of a contentEditable: neither is
// part of the value (serializeTokens drops the first and writes the second as a space).
const CARET_SLOT_PATTERN = /​/g;
const NO_BREAK_SPACE_PATTERN = / /g;

/** A run of pasted text: literal characters, or one variable reference to draw as a chip. */
export type PastedSegment = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'reference'; readonly text: string };

/** `text` split into literal runs and the variable references between them, in order. */
export function pastedSegments(text: string): readonly PastedSegment[] {
  assert(text.length <= CLIPBOARD_LIMITS.pastedCharactersMax, 'pastedSegments: the text is bounded');
  const segments: PastedSegment[] = [];
  let at = 0;
  for (const match of text.matchAll(VARIABLE_REFERENCE_PATTERN)) {
    if (segments.length >= CLIPBOARD_LIMITS.referencesMax * 2) {
      break; // Past the bound the rest stays text, which still reads back as the same CSS.
    }
    const start = match.index;
    if (start > at) {
      segments.push({ kind: 'text', text: text.slice(at, start) });
    }
    segments.push({ kind: 'reference', text: match[0] });
    at = start + match[0].length;
  }
  if (at < text.length) {
    segments.push({ kind: 'text', text: text.slice(at) });
  }
  assert(segments.map((segment) => segment.text).join('') === text, 'pastedSegments: the segments are the text, in order');
  return segments;
}

/**
 * What a field does with the line breaks in pasted text. A multi-line editor (the Custom value
 * box, a <textarea>) keeps them; a one-line field is backed by an <input>, which would drop
 * them and weld `a\nb` into `ab`, so each break and the indent around it becomes one space.
 */
export type PastedLineBreaks = 'keep' | 'join';

/** Clipboard text as the field takes it: Windows line ends made `\n`, breaks kept or joined, cut to the bound. */
export function pastedText(raw: string, lineBreaks: PastedLineBreaks): string {
  const unixText = raw.replace(/\r\n?/g, '\n');
  const text = lineBreaks === 'keep' ? unixText : unixText.replace(/[ \t]*\n[ \t]*/g, ' ');
  assert(!text.includes('\r'), 'pastedText: no carriage return is left');
  if (text.length <= CLIPBOARD_LIMITS.pastedCharactersMax) {
    return text;
  }
  return text.slice(0, CLIPBOARD_LIMITS.pastedCharactersMax);
}

/**
 * The CSS a chip stands for. A chip made from a reference carries it; a chip
 * standing for a native binding (a variable read back by name) carries the
 * name, and is written as the field's own reference, `bare`, as serializeTokens does.
 */
export function chipSource(binding: string, bare: string): string {
  if (/^var\(/i.test(binding)) {
    return binding;
  }
  return bare;
}

/** The field's selection, widened so neither end falls inside a chip; undefined when there is nothing selected in `root`. */
export function selectionRangeIn(root: HTMLElement): Range | undefined {
  const selection = root.ownerDocument.getSelection();
  if (selection === null || selection.rangeCount === 0) {
    return undefined;
  }
  const range = selection.getRangeAt(0).cloneRange();
  if (!root.contains(range.commonAncestorContainer)) {
    return undefined;
  }
  const startChip = chipAround(root, range.startContainer);
  if (startChip !== undefined) {
    range.setStartBefore(startChip);
  }
  const endChip = chipAround(root, range.endContainer);
  if (endChip !== undefined) {
    range.setEndAfter(endChip);
  }
  assert(root.contains(range.commonAncestorContainer), 'selectionRangeIn: the widened range stays in the field');
  return range;
}

/** The CSS the field's selection stands for, or undefined when nothing is selected in it. */
export function selectedSource(root: HTMLElement, bare: string): string | undefined {
  const range = selectionRangeIn(root);
  if (range === undefined || range.collapsed) {
    return undefined;
  }
  return fragmentSource(range.cloneContents(), root.ownerDocument, bare);
}

/** The CSS the nodes under `node` stand for: text as written, each chip as its reference. */
export function fragmentSource(node: Node, ownerDocument: Document, bare: string): string {
  let out = '';
  const walk = (parent: Node, depth: number): void => {
    if (depth > CLIPBOARD_LIMITS.nestingDepthMax) {
      return;
    }
    parent.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        out += child.textContent ?? '';
      } else if (isHTMLElementInDocument(child, ownerDocument) && child.dataset['chip'] !== undefined) {
        out += chipSource(child.dataset['binding'] ?? '', bare);
      } else if (isHTMLElementInDocument(child, ownerDocument) && child.tagName === 'BR') {
        // A line break the browser adds is filler, not text (serializeTokens skips it too).
      } else {
        walk(child, depth + 1);
      }
    });
  };
  walk(node, 0);
  const source = out.replace(CARET_SLOT_PATTERN, '').replace(NO_BREAK_SPACE_PATTERN, ' ');
  assert(!source.includes('​'), 'fragmentSource: a copied value holds no caret slot');
  return source;
}

// The chip `node` is inside, if any.
function chipAround(root: HTMLElement, node: Node): HTMLElement | undefined {
  const element = isHTMLElementInDocument(node, root.ownerDocument) ? node : node.parentElement;
  const chip = element?.closest<HTMLElement>('[data-chip]') ?? undefined;
  if (chip === undefined || !root.contains(chip)) {
    return undefined;
  }
  return chip;
}
