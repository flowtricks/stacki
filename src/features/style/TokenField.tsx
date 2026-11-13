// The inline token editor: a value with each variable drawn as a chip, read
// back to text with the chips as var() references, and edited with the caret
// stepping over whole chips (VariableConnect.tsx).

import { useEffect, useLayoutEffect, useRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { centralIcon } from '../../ui/central/CentralIcon';
import { droplet as centralDroplet, font as centralFont, number as centralNumber, ruler as centralRuler } from '../../ui/central/centralGeometry';
import type { MutableRefObject, RefObject } from 'react';
import { caretOffset, highlightCss, setCaretOffset, stepNumberAt, stepSize } from './model/cssCode';
import { isHTMLElementInDocument } from './model/dom';
import { assert } from '../../../shared/core/assert';
import { caretPlacementAt, placeCaret } from './tokenFieldCaret';
import { EMPTY_FIELD_HISTORY, type FieldHistory, type FieldSnapshot, recordEdit, redoStep, undoStep } from './tokenFieldHistory';

// ── Inline token editor ──────────────────────────────────────────────────────
// The applied variable renders as a purple chip *inside* the field, with editable
// text on either side (type `calc(` in front, ` + 10px)` behind, backspace to
// delete the whole chip). It's a contentEditable — a plain <input> can't hold an
// atomic, cursor-navigable token — that drives the real (hidden) <input> so the
// field's existing draft/live/commit logic runs unchanged: we push edits in via the
// native value setter + an `input` event, and mirror focus/blur so the parent's
// onFocus guard and onBlur commit still fire.

// Per-type glyphs as HTML strings (contentEditable can't take React children). Size
// covers most length fields; Color covers colour props. Others fall back to Size.
const TOKEN_GLYPH_ICONS = {
  Color: centralIcon(centralDroplet),
  FontFamily: centralIcon(centralFont),
  Number: centralIcon(centralNumber),
  Size: centralIcon(centralRuler),
} as const;
const tokenGlyphCache = new Map<string, string>();

export function tokenGlyph(type: string): string {
  const cached = tokenGlyphCache.get(type);
  if (cached !== undefined) {
    return cached;
  }
  // Unknown types fall back to the Size glyph, as the chips always did.
  const Icon = type === 'Color' || type === 'FontFamily' || type === 'Number' ? TOKEN_GLYPH_ICONS[type] : TOKEN_GLYPH_ICONS.Size;
  const markup = renderToStaticMarkup(<Icon size={12} />);
  tokenGlyphCache.set(type, markup);
  return markup;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// One variable in the field, as it is drawn and as it is written back.
export type Chip = { text: string; name: string; type: string };

// What the chips amount to, for the effects that redraw when they change.
export const chipKey = (chips: Chip[]): string => chips.map((chip) => `${chip.text}|${chip.name}|${chip.type}`).join(',');

// The chip markup embedded in the contentEditable. `contenteditable="false"` makes it
// atomic (a single backspace removes it); `data-chip` marks it for serialization, and
// carries the text it stands for — a value can hold several variables, and each has to
// serialize back to its own, not to whichever one the field was opened on.
export function tokenChipHtml(chip: Chip): string {
  return (
    '<span class="embed-editor_varconnect-token" contenteditable="false" data-chip="1" ' +
    `data-binding="${escapeHtml(chip.text)}">` +
    `<span class="embed-editor_varconnect-token-icon">${tokenGlyph(chip.type)}</span>` +
    `<span class="embed-editor_varconnect-token-name">${escapeHtml(chip.name)}</span>` +
    '</span>'
  );
}

// Value → contentEditable HTML: literal text, the chip in place of the variable, more
// literal text. Zero-width spaces guarantee a caret slot on either side of the chip when
// it sits at the start/end of the value — browsers won't let you type in front of a
// leading, or behind a trailing, non-editable node (so without the leading one you can't
// type `calc(` before a variable that IS the whole value). serializeTokens strips them.
export function buildTokenHtml(value: string, chips: Chip[], code = false): string {
  const write = code ? highlightCss : escapeHtml;
  if (!chips.length) {
    return write(value);
  }
  let out = '';
  let at = 0;
  chips.forEach((chip, index) => {
    const found = value.indexOf(chip.text, at);
    if (found < 0) {
      return;
    }
    let before = runHtml(value.slice(at, found), write);
    if (before === '' && index === 0) {
      before = '\u200B';
    }
    out += before + tokenChipHtml(chip);
    at = found + chip.text.length;
  });
  let after = runHtml(value.slice(at), write);
  if (after === '') {
    after = '\u200B';
  }
  return out + after;
}

// The text between two chips. A run that is only whitespace is a gap, drawn
// plain whether or not the field colours code, so it is always the one
// `spaceRun` element below; anything else is written as the field writes text.
function runHtml(text: string, write: (text: string) => string): string {
  if (text !== '' && text.trim() === '') {
    return spaceRun(escapeHtml(text));
  }
  return spaceRun(write(text));
}

// The space in `var(--space-1) var(--space-2)`, wrapped so it survives.
//
// The single-line field is a flex container (it centres the chip in a 26px row),
// and a flex container drops any run of text between two elements that is only
// whitespace: it never becomes a flex item, so the space had no width and — worse
// — no caret position. Two chips sat welded together with nowhere to click
// between them. Inside an element it is an item like any other.
//
// Only whitespace-only runs: text with anything else in it is a flex item
// already, and the serializer reads text nodes wherever they are, so nothing
// about the value changes either way.
export function spaceRun(html: string): string {
  if (html === '' || html.trim() !== '') {
    return html;
  }
  return `<span class="embed-editor_varconnect-space">${html}</span>`;
}

// The field's text with the chip standing in as a single character — what the
// colouring is recomputed from, and what the caret offsets below count. The
// zero-width spaces buildTokenHtml adds are text like any other, so they stay:
// dropping them here would shift every offset after the chip.
export const CHIP_MARK = '\u0000';

// How deep the field's markup is read. contentEditable nests typed text a level or
// two inside the spans it inserts; pasted markup can nest further, and anything
// nested past this bound is left unread rather than recursed into without end.
export const TOKEN_FIELD_LIMITS = { nestingDepthMax: 64, chipsMax: 256 } as const;

export function fieldText(root: HTMLElement): string {
  let out = '';
  const walk = (node: Node, depth: number) => {
    if (depth > TOKEN_FIELD_LIMITS.nestingDepthMax) {
      return;
    }
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        out += child.textContent ?? '';
      } else if (isHTMLElementInDocument(child, root.ownerDocument) && child.dataset['chip'] !== undefined) {
        out += CHIP_MARK;
      } else if (isHTMLElementInDocument(child, root.ownerDocument) && child.tagName === 'BR') {
        // A line break is browser filler, not text.
      } else {
        walk(child, depth + 1);
      }
    });
  };
  walk(root, 0);
  return out;
}

/** The chips the field is showing, in the order they appear — read back before a
 *  repaint so each mark in the text is redrawn as the chip it actually was. */
export function chipsOf(root: HTMLElement): Chip[] {
  return [...root.querySelectorAll<HTMLElement>('[data-chip]')].map((element) => ({
    text: element.dataset['binding'] ?? '',
    name: element.querySelector('.embed-editor_varconnect-token-name')?.textContent ?? '',
    type: element.dataset['type'] ?? 'Size', // i18n-ignore: a variable type id.
  }));
}

/** Re-draw the field from `text`, keeping its chips, and put the caret at `at`. */
export function paint(rootElement: HTMLElement, text: string, at: number | undefined, chips: Chip[]): void {
  const parts = text.split(CHIP_MARK);
  let html = highlightCss(parts[0] ?? '');
  for (let i = 1; i < parts.length; i++) {
    const chip = chips[i - 1];
    html += (chip ? tokenChipHtml(chip) : '') + highlightCss(parts[i] ?? '');
  }
  if (html === rootElement.innerHTML) {
    return;
  }
  rootElement.innerHTML = html;
  if (at !== undefined) {
    setCaretOffset(rootElement, at);
  }
}

// contentEditable → value string. The chip serializes to `bare` when it stands alone and
// to `varForm` once wrapped in text. Callers pass the var(--…) binding for both, so the
// variable stays linked whether it's lone (`var(--x)`) or wrapped (`calc(var(--x) + 10px)`)
// — writing the plain variable NAME instead would make Webflow store a custom value and
// unlink it. The two params stay distinct for callers that want a different lone form.
export function serializeTokens(root: HTMLElement, bare: string, varForm: string): string {
  let out = '';
  let hasText = false;
  // Each chip's own variable, in the order they appear — a value can hold several,
  // and every one of them has to come back as itself.
  const chips: string[] = [];
  // Walk recursively: contentEditable may nest typed text inside a <div>/<span> it
  // inserts, so a flat childNodes pass could miss the chip (and capture its visible
  // label instead of the binding). A chip is atomic — record it, never descend into it.
  const walk = (node: Node, depth: number) => {
    if (depth > TOKEN_FIELD_LIMITS.nestingDepthMax) {
      return;
    }
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        const text = child.textContent ?? '';
        out += text;
        if (text.replace(/\u200B/g, '').trim() !== '') {
          hasText = true;
        }
      } else if (isHTMLElementInDocument(child, root.ownerDocument) && child.dataset['chip'] !== undefined) {
        chips.push(child.dataset['binding'] ?? '');
        out += '\u0000'; // the variable — resolved below once we know if it stands alone
      } else if (isHTMLElementInDocument(child, root.ownerDocument) && child.tagName === 'BR') {
        // Line breaks the browser may insert are ignored.
      } else {
        walk(child, depth + 1);
      }
    });
  };
  walk(root, 0);
  // The lone form is for a field holding one variable and nothing else — that is
  // what a native binding reads back as. Anything else writes var(…) per chip.
  let at = 0;
  return out
    .replace(/\u0000/g, () => {
      const binding = chips[at++];
      if (chips.length === 1 && !hasText) {
        return bare;
      }
      return binding || varForm;
    })
    .replace(/\u200B/g, '');
}

// Move a collapsed caret across the atomic chip when it sits right at the chip's edge —
// browsers otherwise stall there, so you can't arrow behind a lone variable to type
// `!important`. Returns true when it handled the key (so the caller preventDefault).
//
// "Right at the edge" ignores zero-width spaces: buildTokenHtml leaves one as the caret
// slot beside a chip at either end of the value, and a caret in front of that slot (the
// far left of a field that opens on a chip) is visually against the chip. Treating the
// slot as a character made the first ArrowRight a silent step over it, and the person
// could not tell why the caret would not move past the chip to delete it. Every chip is
// considered, not only the first: a value of two variables has two edges to step over.
export function jumpCaretPastChip(root: HTMLElement, direction: 'left' | 'right'): boolean {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || !selection.isCollapsed) {
    return false;
  }
  const chips = [...root.querySelectorAll<HTMLElement>('[data-chip]')];
  assert(chips.length <= TOKEN_FIELD_LIMITS.chipsMax, 'jumpCaretPastChip: the field holds a bounded number of chips');
  const { startContainer: node, startOffset: off } = selection.getRangeAt(0);
  const place = (target: Node, offset: number) => {
    const range = document.createRange();
    range.setStart(target, offset);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  };
  for (const chip of chips) {
    if (direction === 'right' && caretBesideChip(chip, node, off, 'before')) {
      // Against the chip's far side, so Backspace there removes the chip.
      place(slotBeside(chip, 'after'), 0);
      return true;
    }
    if (direction === 'left' && caretBesideChip(chip, node, off, 'after')) {
      const slot = slotBeside(chip, 'before');
      place(slot, slot.length);
      return true;
    }
  }
  return false;
}

// The text node a caret on `side` of `chip` sits in. A neighbour may be a coloured run, or
// the `.cx-space` element a gap is drawn in, whose text node holds the caret: the element
// itself never does. Where no text is there (a chip welded to another chip, or to the end
// of the field) a zero-width slot is added, which the serializer strips; browsers will not
// hold a typing caret beside a non-editable node without one.
function slotBeside(chip: HTMLElement, side: 'before' | 'after'): Text {
  const ownerDocument = chip.ownerDocument;
  const sibling = (side === 'before' ? chip.previousSibling : chip.nextSibling) ?? undefined;
  const weldedChip = sibling !== undefined && isHTMLElementInDocument(sibling, ownerDocument) && sibling.dataset['chip'] !== undefined;
  const edge = sibling === undefined || weldedChip ? undefined : edgeTextNode(sibling, side === 'before' ? 'end' : 'start');
  // Checked against the node's own window: nodes from another realm are not this realm's Text.
  const TextConstructor = ownerDocument.defaultView?.Text;
  assert(TextConstructor !== undefined, 'slotBeside: the field belongs to a window');
  if (edge instanceof TextConstructor) {
    return edge;
  }
  const parent = chip.parentNode;
  assert(parent !== null, 'slotBeside: the chip is in the field');
  const slot = ownerDocument.createTextNode('\u200B');
  parent.insertBefore(slot, side === 'before' ? chip : chip.nextSibling);
  return slot;
}

const isZeroWidth = (text: string): boolean => text.replace(/\u200B/g, '') === '';

// Whether the caret at (`node`, `offset`) stands on `side` of `chip` with nothing visible
// between. The caret is either in that
// text with only zero-width spaces between it and the chip, or at the chip's parent with
// only zero-width text nodes between its child slot and the chip.
function caretBesideChip(chip: HTMLElement, node: Node, offset: number, side: 'before' | 'after'): boolean {
  const own = side === 'before' ? edgeTextNode(chip.previousSibling ?? undefined, 'end') : edgeTextNode(chip.nextSibling ?? undefined, 'start');
  if (own !== undefined && node === own) {
    const text = own.textContent ?? '';
    return isZeroWidth(side === 'before' ? text.slice(offset) : text.slice(0, offset));
  }
  if (node === chip.parentNode) {
    const children = [...node.childNodes];
    const chipIndex = children.indexOf(chip);
    assert(chipIndex >= 0, 'caretBesideChip: the chip is among its parent’s children');
    const between = side === 'before' ? children.slice(offset, chipIndex) : children.slice(chipIndex + 1, offset);
    return offset <= children.length && between.every((child) => child.nodeType === 3 && isZeroWidth(child.textContent ?? ''));
  }
  return false;
}

// The innermost node at one end of `node`: itself when it holds nothing further in.
// Bounded by the depth the field's markup is read to (TOKEN_FIELD_LIMITS).
function edgeTextNode(node: ChildNode | undefined, end: 'start' | 'end'): ChildNode | undefined {
  let current = node;
  for (let depth = 0; current !== undefined && depth < TOKEN_FIELD_LIMITS.nestingDepthMax; depth += 1) {
    const inner = end === 'start' ? current.firstChild : current.lastChild;
    if (inner === null) {
      return current;
    }
    current = inner;
  }
  return current;
}

// The keys bracket-matching cares about (see the handler below).
export const BRACKET_KEYS = new Set(['(', ')', 'Backspace']);

export function TokenField({
  value,
  chips,
  chipBare,
  chipVar,
  className,
  ariaLabel,
  placeholder,
  disabled,
  code,
  stepMin,
  editorRef,
  onFocusField,
  onCommit,
  onDraft,
  onChipClick,
}: TokenFieldProps) {
  // Every edit, to whoever is holding this field's value. Recorded as synced too: a
  // parent that stores it hands it straight back as `value`, and rebuilding the field
  // from a value it already shows would throw the caret to the end mid-word.
  const historyRef = useRef<FieldHistory>(EMPTY_FIELD_HISTORY);
  const synced = useTokenFieldSync({ value, chips, code, editorRef, historyRef });
  const report = (element: HTMLElement) => {
    const next = serializeTokens(element, chipBare, chipVar);
    synced.current = next;
    onDraft?.(next);
  };
  const record = (element: HTMLElement, kind: string) => {
    historyRef.current = recordEdit(historyRef.current, captureField(element), { kind, atMs: Date.now(), grouped: GROUPED_EDITS.has(kind) });
  };
  const travel = (element: HTMLElement, direction: 'undo' | 'redo'): void => {
    const step = (direction === 'undo' ? undoStep : redoStep)(historyRef.current, captureField(element));
    if (step === undefined) {
      return;
    }
    historyRef.current = step.history;
    restoreField(element, step.show, { code: !!code });
    report(element);
  };
  useFieldHistoryInput(editorRef, { record, travel });
  return (
    <div
      ref={editorRef}
      className={className}
      contentEditable={!disabled}
      suppressContentEditableWarning
      role="textbox"
      aria-multiline="false"
      aria-label={ariaLabel}
      data-placeholder={placeholder || undefined}
      spellCheck={false}
      onFocus={onFocusField}
      onBlur={() => {
        const element = editorRef.current;
        onCommit(element ? serializeTokens(element, chipBare, chipVar) : '');
      }}
      onInput={(event) => {
        const element = event.currentTarget;
        // What the field holds right now — not a write, just a reading. The
        // commit still waits for blur (a half-typed expression is invalid CSS
        // and applying it would flash the canvas), but anything that only
        // WATCHES the value — a badge saying this size cannot be enlarged —
        // has to move with the keystroke or it is telling you about the value
        // you had a moment ago.
        report(element);
        // Re-colour what was just typed. The browser has already put the
        // characters in; this replaces the markup around them and puts the
        // caret back where it was, counted in characters rather than nodes.
        if (!code) {
          return;
        }
        paint(element, fieldText(element), caretOffset(element), chipsOf(element));
      }}
      onKeyDown={(event) => {
        const direction = historyKey(event);
        if (direction !== undefined) {
          // The field's own history, not the page's: the app's ⌘Z listener
          // sees this was handled and leaves the page alone.
          event.preventDefault();
          historyKeyAtMs = Date.now();
          travel(event.currentTarget, direction);
          return;
        }
        tokenFieldKeyDown(event, { code: !!code, stepMin, report, record });
      }}
      onMouseDown={(event) => {
        const chip = pressedChip(event.currentTarget, event.target);
        if (chip !== undefined) {
          event.preventDefault();
          onChipClick(chip);
          return;
        }
        if (disabled) {
          return;
        }
        tokenFieldPress(event.currentTarget, event);
      }}
    />
  );
}

// A press on the field that is not on a chip. Only a plain single press is
// placed here: a double press selects a word, and a modified one extends or
// adds to a selection, and those stay the browser's (tokenFieldCaret.ts).
export function tokenFieldPress(
  field: HTMLElement,
  press: Pick<MouseEvent, 'button' | 'detail' | 'shiftKey' | 'metaKey' | 'ctrlKey' | 'altKey' | 'clientX' | 'clientY' | 'preventDefault'>,
): void {
  if (press.button !== 0) {
    return;
  }
  if (press.detail > 1) {
    return;
  }
  if (press.shiftKey || press.metaKey || press.ctrlKey || press.altKey) {
    return;
  }
  const placement = caretPlacementAt(field, { x: press.clientX, y: press.clientY });
  if (placement.kind === 'browser') {
    return;
  }
  // The press is answered here, so the browser's own placement must not run
  // after it; focus is then given by hand, since preventing the press keeps it.
  press.preventDefault();
  if (field.ownerDocument.activeElement !== field) {
    field.focus();
  }
  placeCaret(field, placement.target);
  assert(field.ownerDocument.activeElement === field, 'tokenFieldPress: the pressed field holds focus');
}

// A chip the person pressed: its place among the field's chips, and its variable.
export interface PressedChip {
  readonly index: number;
  readonly binding: string;
}

// The chip under a press in `field`, if the press landed on one.
export function pressedChip(field: HTMLElement, target: EventTarget): PressedChip | undefined {
  if (!isHTMLElementInDocument(target, field.ownerDocument)) {
    return undefined;
  }
  const chip = target.closest<HTMLElement>('[data-chip]');
  if (chip === null || !field.contains(chip)) {
    return undefined;
  }
  const index = [...field.querySelectorAll('[data-chip]')].indexOf(chip);
  assert(index >= 0, 'pressedChip: a chip inside the field is among its chips');
  return { index, binding: chip.dataset['binding'] ?? '' };
}

export type TokenFieldProps = {
  value: string;
  chips: Chip[];
  chipBare: string;
  chipVar: string;
  className: string;
  ariaLabel: string;
  /** Shown while the field is empty, like the input's own placeholder. */
  placeholder?: string;
  disabled?: boolean;
  editorRef: RefObject<HTMLDivElement>;
  onFocusField: () => void;
  /** Serialized value on blur — pushed to the field and committed there. No live writes
   *  fire while typing: a partial expression (`calc(var(…)`, or `cvar(…)` mid-keystroke)
   *  is invalid CSS and Webflow coerces it to 0 on the canvas. The finished value applies
   *  on blur instead. */
  onCommit: (value: string) => void;
  /** The value as it is being typed. Nothing is written — this is for whatever
   *  is watching the field rather than storing it. */
  onDraft?: (value: string) => void;
  /** A chip was pressed: which one, so a pick can swap that chip and no other. */
  onChipClick: (chip: PressedChip) => void;
  /** Treat the value as code: colour it as it is typed, and let the arrow keys
   *  step the number the caret is in. */
  code?: boolean;
  /** Floor for arrow-stepping, when the property has one (padding at 0). */
  stepMin?: number;
};

// Keeps the field's markup in step with `value`. Returns the value the DOM already
// reflects, so our own edits (which round-trip back through `value`) don't rebuild
// innerHTML and reset the caret.
export function useTokenFieldSync({
  value,
  chips,
  code,
  editorRef,
  historyRef,
}: Pick<TokenFieldProps, 'value' | 'chips' | 'editorRef'> & { code: boolean | undefined; historyRef: MutableRefObject<FieldHistory> }) {
  const synced = useRef<string | undefined>(undefined);
  // The chips are compared by what they amount to, not by array identity (the
  // caller builds a fresh array every render); the effects read the latest ones.
  const chipsKey = chipKey(chips);
  const latest = useRef({ value, chips });
  latest.current = { value, chips };

  useLayoutEffect(() => {
    const element = editorRef.current;
    if (!element || value === synced.current) {
      return;
    }
    synced.current = value;
    // Rebuilding replaces every node in here, and the caret — with the focus — goes
    // with them. That is fine for a field nobody is in, and it is what happens on
    // every keystroke otherwise: a live-writing field (an object-position offset,
    // say) writes as you type, the value comes back normalised a beat later, and the
    // field you are typing in is torn out from under you. So carry the caret across.
    const focused = element.ownerDocument.activeElement === element;
    const at = focused ? caretOffset(element) : undefined;
    // A value set while the field is in use (a variable picked into it) is a
    // step ⌘Z can take back. One set from elsewhere starts the field afresh:
    // its old steps describe a value that is no longer there.
    historyRef.current = focused
      ? recordEdit(historyRef.current, captureField(element), { kind: 'replace', atMs: Date.now(), grouped: false })
      : EMPTY_FIELD_HISTORY;
    element.innerHTML = buildTokenHtml(value, latest.current.chips, code);
    if (!focused) {
      return;
    }
    element.focus();
    if (at !== undefined) {
      setCaretOffset(element, Math.min(at, fieldText(element).length));
    }
  }, [value, chipsKey, code, editorRef, historyRef]);

  // Refresh the chip label if it resolves later (async variable load) — but only while
  // unfocused, so an active caret is never disturbed. A change of value alone is the
  // effect above's; this one answers the chips and the mode.
  useEffect(() => {
    const element = editorRef.current;
    if (!element || document.activeElement === element) {
      return;
    }
    synced.current = latest.current.value;
    element.innerHTML = buildTokenHtml(latest.current.value, latest.current.chips, code);
  }, [chipsKey, code, editorRef]);
  return synced;
}

// The field's keys: Enter commits by blurring; in code mode brackets pair up and
// the arrow keys step the number under the caret; Left/Right step over a chip.
export function tokenFieldKeyDown(
  event: React.KeyboardEvent<HTMLDivElement>,
  {
    code,
    stepMin,
    report,
    record,
  }: { code: boolean; stepMin: number | undefined; report: (element: HTMLElement) => void; record: (element: HTMLElement, kind: string) => void },
): void {
  if (event.key === 'Enter') {
    event.preventDefault();
    event.currentTarget.blur();
    return;
  }
  const element = event.currentTarget;
  if (code) {
    const edit = codeKeyEdit(event, element, stepMin);
    if (edit !== 'unhandled') {
      if (edit !== undefined) {
        event.preventDefault();
        record(element, `key:${event.key}`);
        paint(element, edit.text, edit.caret, chipsOf(element));
        report(element);
      }
      return;
    }
  }
  if (event.key === 'ArrowRight' && jumpCaretPastChip(element, 'right')) {
    event.preventDefault();
  } else if (event.key === 'ArrowLeft' && jumpCaretPastChip(element, 'left')) {
    event.preventDefault();
  }
}

// What a key does to a code field: the new text and caret, `undefined` for a key
// this mode claims but that changes nothing (an arrow with no number under the
// caret — the key then does whatever it normally does), or 'unhandled'.
//
// Brackets, the way an editor does them — a CSS value is nested calls more often
// than not, and `calc(min(` is four keystrokes of closing parens to remember.
// Typing `(` puts the pair in and leaves the caret between them; typing `)` where
// one already sits steps over it instead of doubling it; backspacing between an
// empty pair takes both. Only with a collapsed caret: over a selection these keys
// mean what they always did.
export function codeKeyEdit(
  event: React.KeyboardEvent<HTMLDivElement>,
  element: HTMLElement,
  stepMin: number | undefined,
): { text: string; caret: number } | undefined | 'unhandled' {
  const plain = !event.metaKey && !event.ctrlKey && !event.altKey;
  if (plain && BRACKET_KEYS.has(event.key)) {
    const at = caretOffset(element);
    const collapsed = element.ownerDocument.getSelection()?.isCollapsed !== false;
    if (at !== undefined && collapsed) {
      const edit = bracketEdit(fieldText(element), at, event.key);
      if (edit !== undefined) {
        return edit;
      }
    }
  }
  if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
    const at = caretOffset(element);
    const step = stepSize(event) * (event.key === 'ArrowUp' ? 1 : -1);
    return at === undefined ? undefined : stepNumberAt(fieldText(element), at, step, stepMin);
  }
  return 'unhandled';
}

const NUMBER_WITH_UNIT = /^[-+]?(?:\d+\.?\d*|\.\d+)[a-zA-Z%]*/;

// The bracket pairing for one key at caret `at`, or undefined when it doesn't apply.
export function bracketEdit(text: string, at: number, key: string): { text: string; caret: number } | undefined {
  if (key === '(') {
    // `calc|32px` is a value being wrapped, so the closing bracket goes after it.
    const wrapped = NUMBER_WITH_UNIT.exec(text.slice(at))?.[0] ?? '';
    const closeAt = at + wrapped.length;
    return { text: `${text.slice(0, at)}(${wrapped})${text.slice(closeAt)}`, caret: at + 1 };
  }
  if (key === ')' && text[at] === ')') {
    return { text, caret: at + 1 };
  }
  if (key === 'Backspace' && text[at - 1] === '(' && text[at] === ')') {
    return { text: text.slice(0, at - 1) + text.slice(at + 1), caret: at - 1 };
  }
  return undefined;
}

// Edits that group into one undo step when they follow each other quickly.
const GROUPED_EDITS: ReadonlySet<string> = new Set(['insertText', 'deleteContentBackward', 'deleteContentForward']);

// When the field last answered ⌘Z itself. The menu's Undo may also reach the
// field a moment later as a `historyUndo` input; that is the same press, and
// taking it again would undo two steps.
let historyKeyAtMs = 0;
const HISTORY_ECHO_MS = 250;

/** ⌘Z is undo; ⇧⌘Z and ⌘Y are redo; anything else is neither. */
export function historyKey(event: {
  readonly key: string;
  readonly metaKey: boolean;
  readonly ctrlKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}): 'undo' | 'redo' | undefined {
  if (!event.metaKey && !event.ctrlKey) {
    return undefined;
  }
  if (event.altKey) {
    return undefined;
  }
  const key = event.key.toLowerCase();
  if (key === 'z') {
    return event.shiftKey ? 'redo' : 'undo';
  }
  return key === 'y' && !event.shiftKey ? 'redo' : undefined;
}

// Every change the browser is about to make to the field is recorded first, so
// it can be undone; the menu's Undo and Redo arrive here as history inputs and
// are answered from the field's own history.
function useFieldHistoryInput(
  editorRef: RefObject<HTMLDivElement>,
  handlers: { readonly record: (element: HTMLElement, kind: string) => void; readonly travel: (element: HTMLElement, direction: 'undo' | 'redo') => void },
): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    const element = editorRef.current;
    if (!element) {
      return undefined;
    }
    const onBeforeInput = (event: InputEvent): void => {
      if (event.inputType === 'historyUndo' || event.inputType === 'historyRedo') {
        event.preventDefault();
        if (Date.now() - historyKeyAtMs > HISTORY_ECHO_MS) {
          latest.current.travel(element, event.inputType === 'historyUndo' ? 'undo' : 'redo');
        }
        return;
      }
      latest.current.record(element, event.inputType);
    };
    element.addEventListener('beforeinput', onBeforeInput);
    return () => element.removeEventListener('beforeinput', onBeforeInput);
  }, [editorRef]);
}

/** What the field shows now: its text with each chip as one mark, the chips, and the caret. */
export function captureField(element: HTMLElement): FieldSnapshot {
  const text = fieldText(element);
  return { text, chips: chipsOf(element), caret: caretOffset(element) ?? text.length };
}

/** Show `snapshot` in the field, caret included. */
export function restoreField(element: HTMLElement, snapshot: FieldSnapshot, options: { readonly code: boolean }): void {
  const write = options.code ? highlightCss : escapeHtml;
  const parts = snapshot.text.split(CHIP_MARK);
  assert(parts.length - 1 <= snapshot.chips.length, 'restoreField: every mark in the text has its chip');
  let html = write(parts[0] ?? '');
  for (let index = 1; index < parts.length; index++) {
    const chip = snapshot.chips[index - 1];
    html += (chip === undefined ? '' : tokenChipHtml(chip)) + write(parts[index] ?? '');
  }
  element.innerHTML = html;
  assert(fieldText(element).length === snapshot.text.length, 'restoreField: the field shows the snapshot text');
  if (element.ownerDocument.activeElement === element) {
    setCaretOffset(element, Math.min(snapshot.caret, snapshot.text.length));
  }
}
