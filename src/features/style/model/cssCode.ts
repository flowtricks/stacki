// A CSS value field that behaves like a code editor: the value is coloured as
// you type, and the number under the caret answers to the arrow keys.
//
// Deliberately not CodeMirror. The variables sheet renders every value in the
// file at once — hundreds of fields — and an editor instance per cell is orders
// of magnitude more than the job needs. A value is one line of CSS with no
// nesting to track, so a regex tokeniser and the browser's own caret are
// enough, and the field stays a contentEditable that chips can live inside.

import { assert } from '../../../../shared/core/assert';
import { LIMITS } from '../../../../shared/core/limits';

/** One coloured run of the value. `text` is raw (unescaped) source. */
export type CssToken = { kind: string; text: string };

const COMMENT = /^\/\*[\s\S]*?(?:\*\/|$)/;
const STRING = /^"[^"]*"?|^'[^']*'?/;
const CUSTOM_PROP = /^--[\w-]+/;
const FUNCTION = /^[A-Za-z_][\w-]*(?=\()/;
const HEX = /^#[0-9a-fA-F]{3,8}/;
// A number, and the unit stuck to it: `16`, `1.5rem`, `.5e2%`, `-3px`.
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const UNIT = /^(?:[A-Za-z]+|%)/;
const IDENT = /^[A-Za-z_][\w-]*/;
// The flag after a value. It gets its own run so a field can draw it quieter
// than the value it qualifies, and so it never reads as a stray `!` and an ident.
const IMPORTANT = /^!\s*important\b/i;

/**
 * Split a CSS value into coloured runs. Unknown characters (punctuation,
 * whitespace, operators) come back as `plain` so joining the texts back
 * together always reproduces the input exactly.
 */
export function cssTokens(value: string): CssToken[] {
  const out: CssToken[] = [];
  const push = (kind: string, text: string) => {
    // Runs of the same kind merge, so `((` is one span rather than two.
    const last = out[out.length - 1];
    if (last && last.kind === kind) {
      last.text += text;
    } else {
      out.push({ kind, text });
    }
  };
  let rest = value;
  while (rest) {
    let match: RegExpMatchArray | undefined;
    let consumedLength = 0;
    if ((match = rest.match(COMMENT) ?? undefined)) {
      push('comment', match[0]);
      consumedLength = match[0].length;
    } else if ((match = rest.match(STRING) ?? undefined)) {
      push('string', match[0]);
      consumedLength = match[0].length;
    } else if ((match = rest.match(CUSTOM_PROP) ?? undefined)) {
      push('prop', match[0]);
      consumedLength = match[0].length;
    } else if ((match = rest.match(FUNCTION) ?? undefined)) {
      push('fn', match[0]);
      consumedLength = match[0].length;
    } else if ((match = rest.match(IMPORTANT) ?? undefined)) {
      push('important', match[0]);
      consumedLength = match[0].length;
    } else if ((match = rest.match(HEX) ?? undefined)) {
      push('hex', match[0]);
      consumedLength = match[0].length;
    } else if ((match = rest.match(NUMBER) ?? undefined)) {
      push('num', match[0]);
      consumedLength = match[0].length;
      const unit = rest.slice(match[0].length).match(UNIT);
      if (unit) {
        push('unit', unit[0]);
        consumedLength += unit[0].length;
      }
    } else if ((match = rest.match(IDENT) ?? undefined)) {
      push('ident', match[0]);
      consumedLength = match[0].length;
    } else {
      const plain = rest[0] ?? '';
      push('plain', plain);
      consumedLength = plain.length;
    }
    rest = rest.slice(consumedLength);
  }
  return out;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The value as coloured HTML. `plain` runs stay bare text so the markup — and
 *  the DOM the caret walks — is no deeper than it needs to be, except for their
 *  whitespace (see plainHtml). */
export function highlightCss(value: string): string {
  return cssTokens(value)
    .map((token) => (token.kind === 'plain' ? plainHtml(token.text) : `<span class="cx-${token.kind}">${escapeHtml(token.text)}</span>`))
    .join('');
}

// Whitespace in a coloured value is wrapped in an element of its own.
//
// The single-line field is a flex container, so every bare text run between two
// coloured spans becomes an anonymous flex item, and a flex item trims the
// whitespace at its edges and drops a run that is only whitespace. Painted bare,
// `rgb(255 255 255 / 0.09)` read `rgb(255255255/0.09)` and `in lab, x` read
// `inlab,x`: still the right text in the DOM, but the wrong value on screen. A
// `.cx-space` element is a flex item whose `white-space: pre` keeps its width,
// and its text node is still where the caret and the serializer find it.
const WHITESPACE_RUN = /(\s+)/;
const WHITESPACE = /\s/;
function plainHtml(text: string): string {
  if (WHITESPACE.test(text)) {
    return text.split(WHITESPACE_RUN).map(plainPartHtml).join('');
  }
  return escapeHtml(text);
}
// One piece of a split plain run: whitespace, other text, or the empty string
// `split` leaves at either end when the run starts or ends with whitespace.
function plainPartHtml(part: string): string {
  if (part.trim() === '') {
    return part === '' ? '' : `<span class="cx-space">${part}</span>`;
  }
  return escapeHtml(part);
}

// ───────────────────────────── Arrow-key stepping ─────────────────────────────

/** How much one press moves the number: a tenth with alt, ten with shift. */
export function stepSize(event: { altKey?: boolean; shiftKey?: boolean }): number {
  if (event.altKey) {
    return 0.1;
  }
  if (event.shiftKey) {
    return 10;
  }
  return 1;
}

// Every number in the value, with where it sits. The sign is deliberately NOT
// part of the match: in `calc(100% - 4px)` the minus is an operator, and
// stepping `4px` down through zero should read `-1px`, not `- -1px`.
const NUMBER_AT = /(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

/** Decimal places to keep: whatever the value had, but enough for the step. */
function precisionOf(text: string, step: number): number {
  const had = text.includes('.') ? (text.split('.')[1] ?? '').length : 0;
  const needed = Number.isInteger(step) ? 0 : (String(step).split('.')[1] ?? '').length;
  return Math.max(had, needed);
}

/**
 * Step the number the caret is in (or touching) by `delta`.
 *
 * Returns the new text and where the number now ends, so the caller can put the
 * caret back where the user left it, or undefined when there's no number to step —
 * in which case the key should do its normal thing.
 */
export function stepNumberAt(
  text: string,
  caret: number,
  delta: number,
  /** Floor for the stepped number — padding stops at 0, a margin doesn't. */
  min?: number,
): { text: string; caret: number } | undefined {
  NUMBER_AT.lastIndex = 0;
  let hit: { start: number; end: number; text: string } | undefined;
  // A global regex advances `lastIndex` on every match, so this visits each number once.
  for (let match = NUMBER_AT.exec(text); match !== null; match = NUMBER_AT.exec(text)) {
    const start = match.index;
    const end = start + match[0].length;
    // Touching counts: the caret sits at an edge as often as inside, and after
    // typing a number it is always at its right edge. The unit is part of the
    // number here, so the caret at the end of `1rem` still steps it.
    if (caret >= start && caret <= unitEndAt(text, start, end)) {
      hit = { start, end, text: match[0] };
      break;
    }
    if (start > caret) {
      break;
    } // numbers only get further away from here
  }
  if (!hit) {
    return undefined;
  }
  // A `-` immediately before, and not part of a larger expression, is this
  // number's sign — `-4px` steps up to `-3px`, not to `-5px`.
  const signed = hit.start > 0 && text[hit.start - 1] === '-' && !/[\d.\w%)]\s*$/.test(text.slice(0, hit.start - 1));
  const start = signed ? hit.start - 1 : hit.start;
  const current = Number((signed ? '-' : '') + hit.text);
  if (!Number.isFinite(current)) {
    return undefined;
  }
  const next = min === undefined ? current + delta : Math.max(min, current + delta);
  // Float arithmetic: 0.1 + 0.2 must read 0.3 in a field someone is watching.
  const shown = next
    .toFixed(precisionOf(hit.text, delta))
    .replace(/^(-?)0\./, '$1.')
    .replace(/\.$/, '');
  // A caret in the unit stays at the same place in the unit.
  const unitOffset = Math.max(0, caret - hit.end);
  return {
    text: text.slice(0, start) + shown + text.slice(hit.end),
    caret: start + shown.length + unitOffset,
  };
}

// One past the unit glued to the number at `start`..`end`; `end` when it has none.
// Digits glued to a name or a hex colour on their left (`#3366ff`, `translate3d`)
// have no unit: the letters after them are not one.
function unitEndAt(text: string, start: number, end: number): number {
  assert(start < end, 'unitEndAt: a number has characters');
  if (start > 0 && /[\w#]/.test(text.charAt(start - 1))) {
    return end;
  }
  const unit = /^[a-zA-Z%]*/.exec(text.slice(end))?.[0] ?? '';
  const unitEnd = end + unit.length;
  assert(unitEnd <= text.length, 'unitEndAt: the unit is inside the text');
  return unitEnd;
}

// ───────────────────────────── Caret in a rich field ─────────────────────────
//
// The field is a contentEditable holding coloured spans and, sometimes, a
// variable chip. Re-colouring rebuilds its markup, so the caret has to be
// recorded and restored as an offset into the text — the nodes it pointed at
// are gone by then. A chip counts as one character, matching the placeholder
// the value serialiser uses.

const isChip = (node: Node): boolean => node instanceof HTMLElement && node.dataset['chip'] !== undefined;

/** Where the caret is, as an offset into the field's text. */
export function caretOffset(root: HTMLElement): number | undefined {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return undefined;
  }
  const range = selection.getRangeAt(0);
  return pointOffset(root, range.endContainer, range.endOffset);
}

/**
 * The field's selection as offsets into its text, start before end; a caret is
 * a selection whose start and end are the same. Undefined when the selection is
 * not wholly in the field.
 */
export function selectionOffsets(root: HTMLElement): { readonly start: number; readonly end: number } | undefined {
  const selection = root.ownerDocument.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return undefined;
  }
  const range = selection.getRangeAt(0);
  const start = pointOffset(root, range.startContainer, range.startOffset);
  const end = pointOffset(root, range.endContainer, range.endOffset);
  if (start === undefined || end === undefined) {
    return undefined;
  }
  return start <= end ? { start, end } : { start: end, end: start };
}

// A DOM position (a container and an offset in it) as characters into the field.
function pointOffset(root: HTMLElement, container: Node, containerOffset: number): number | undefined {
  if (!root.contains(container)) {
    return undefined;
  }
  let offset = 0;
  let found = false;
  // The field's markup is spans and chips a level or two deep; the tree bound is a
  // backstop against a malformed paste, whose deeper content is not counted.
  const walk = (node: Node, depth: number) => {
    if (depth > LIMITS.treeDepthMax) {
      return;
    }
    if (found) {
      return;
    }
    if (node === container && node.nodeType !== Node.TEXT_NODE) {
      // A container-level position counts the children before it.
      let i = 0;
      for (const child of Array.from(node.childNodes)) {
        if (i++ >= containerOffset) {
          break;
        }
        walk(child, depth + 1);
      }
      found = true;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      if (node === container) {
        offset += containerOffset;
        found = true;
      } else {
        offset += (node.textContent ?? '').length;
      }
      return;
    }
    if (isChip(node)) {
      offset += 1;
      return;
    }
    node.childNodes.forEach((child) => walk(child, depth + 1));
  };
  if (container === root) {
    walk(root, -1);
  } else {
    root.childNodes.forEach((child) => walk(child, 0));
  }
  return found ? offset : undefined;
}

/** Put the caret back at `offset` characters into the field. */
export function setCaretOffset(root: HTMLElement, offset: number): void {
  const ownerDocument = root.ownerDocument;
  const selection = ownerDocument.getSelection();
  if (!selection) {
    return;
  }
  let left = offset;
  const target: { value: { node: Node; at: number } | undefined } = { value: undefined };
  const walk = (node: Node) => {
    if (target.value) {
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const length = (node.textContent ?? '').length;
      if (left <= length) {
        target.value = { node, at: left };
      } else {
        left -= length;
      }
      return;
    }
    if (isChip(node)) {
      const parent = node.parentNode;
      if (left <= 0 && parent !== null) {
        target.value = {
          node: parent,
          at: Array.from(parent.childNodes).findIndex((child) => child === node),
        };
      } else {
        left -= 1;
      }
      return;
    }
    node.childNodes.forEach(walk);
  };
  root.childNodes.forEach(walk);
  const range = ownerDocument.createRange();
  if (target.value) {
    range.setStart(target.value.node, target.value.at);
  } else {
    range.selectNodeContents(root);
    range.collapse(false);
  }
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}
