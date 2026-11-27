import { assert } from '../../shared/core/assert';
import { sourceStamps } from './frameMove';
import type { TextMatch } from './frameTextMatch';
import type { CanvasTextBreaks } from '../../shared/properties/canvasText';
import { createTextBuffer, type TextRunChange } from './frameTextBuffer';
import { placeTextCaret, textEditorRoot, textSelection, type TextSpace } from './frameTextSelection';
import { installNativeTextEvents } from './frameTextNativeEvents';
import { installInterceptedPointer, pointOnWords } from './frameTextPointer';
import { holdTextEditing, isCanvasTextEditing, styleTextEditor } from './frameTextEditing';

export interface NativeTextResult {
  /** What to save: empty when nothing changed or the edit was cancelled. */
  readonly changes: readonly TextRunChange[];
  readonly restored: boolean;
  /** Shows the typed words again: the save is on its way, so the old ones never flash. */
  readonly keep: () => void;
}

interface NativeTextCallbacks {
  readonly changed: (value: string) => void;
  readonly refused: () => void;
  readonly done: (result: NativeTextResult) => void;
}

export function openNativeText(match: TextMatch, space: TextSpace, event: MouseEvent, callbacks: NativeTextCallbacks, breaks?: CanvasTextBreaks) {
  const root = textEditorRoot(match);
  if (!root || match.nodes.map((node) => node.data).join('').length > 10_000) {
    return undefined;
  }
  const { changed, refused, done } = callbacks;
  const attributes = ['contenteditable', 'data-avb-text-editor'].map((name) => ({
    name,
    value: root.getAttribute(name),
  }));
  const restoreAttributes = () => {
    for (const attribute of attributes) {
      if (attribute.value === null) {
        root.removeAttribute(attribute.name);
      } else {
        root.setAttribute(attribute.name, attribute.value);
      }
    }
  };
  const heightBefore = root.getBoundingClientRect().height;
  installNativeTextStyle(root, breaks);
  root.setAttribute('contenteditable', 'true');
  root.setAttribute('data-avb-text-editor', '');
  // Opening the editor must not move a pixel. In Chromium an editable block with
  // `text-wrap: balance` gives the whitespace a component's slot leaves after its
  // words (the newline before the closing tag) a line of its own: the Webflow
  // heading went from 88.6px to 132.9px, 44px of blank band under its last line.
  // That whitespace is collapsed and invisible while the page is not editable, so
  // the editor keeps it out of the text it edits and puts it back on close.
  const trimmed = root.getBoundingClientRect().height > heightBefore + GROWTH_TOLERANCE_PX ? trimEdgeWhitespace(root, match.nodes) : [];
  // Where Enter types a line break, the editor shows newlines (pre-line): the template's own newlines, which the page
  // shows as spaces, are spaces while it is open, and come back when it closes without a save.
  const folded = breaks === undefined ? [] : foldSourceNewlines(space.runs.flat());
  const buffer = createTextBuffer(root, space, changed);
  if (!buffer) {
    for (const edge of folded) {
      edge.node.data = edge.data;
    }
    restoreAttributes();
    for (const edge of trimmed) {
      edge.node.data = edge.data;
    }
    return undefined;
  }
  let closed = false;
  const finish = (action: 'apply' | 'cancel') => {
    if (closed) {
      return;
    }
    closed = true;
    cleanup();
    stopPointer();
    clearNativeTextSelection(root);
    const changes = action === 'apply' ? buffer.changes() : [];
    // The original words come back first: the save is checked against them.
    const { restored, keep: keepTyped } = buffer.restore();
    const unfolded = folded.map((edge) => ({ ...edge, shown: edge.node.data }));
    for (const edge of unfolded) {
      edge.node.data = edge.data;
    }
    // The typed words are shown over the folded text they were typed in.
    const keep = () => {
      for (const edge of unfolded) {
        edge.node.data = edge.shown;
      }
      keepTyped();
    };
    restoreAttributes();
    for (const edge of trimmed) {
      edge.node.data = edge.data;
    }
    release();
    root.blur();
    done({ changes, restored, keep });
  };
  const release = holdTextEditing(root);
  const { cleanup, pressed } = installNativeTextEvents({ root, space, buffer, finish, refused, breaks });
  const stopPointer = installInterceptedPointer(root, match.nodes);
  root.focus({ preventScroll: true });
  placeTextCaret(space, event);
  return {
    finish,
    intact: buffer.intact,
    spread: buffer.spread,
    // Any words typed at all: a selection outside the opened text is offered
    // only before typing, since a press there saves that text alone.
    edited: () => buffer.changes().length > 0,
    contains: (click: MouseEvent) => {
      // A drag ends with its click on whatever holds both of its ends, and its
      // release may be over other text or none: it began here, so it is the
      // editor's, and the selection it made stands.
      if (pressed() && holdsSelection(root)) {
        return true;
      }
      const range = document.caretRangeFromPoint(click.clientX, click.clientY);
      // A press on the words themselves is the editor's even when something lies over them (a stretched link): it moved the caret.
      return pointOnWords(match.nodes, click.clientX, click.clientY) || (isCanvasTextEditing(click.target) && !!range && !!textSelection(match.nodes, range));
    },
  };
}

/** How long typed words wait for their rendering: the canvas's bound for what it shows ahead of one. */
const TYPED_HOLD_MS_MAX = 20_000;
/** Saves shown at once before any rendering: past it the page's own words come back at once. */
const TYPED_PENDING_MAX = 64;
let typedPending = 0;

interface TypedWords {
  readonly node: Text;
  readonly rendered: string;
  readonly typed: string;
}

/**
 * Shows the typed words again while their save is on its way; `write` puts them into `nodes`.
 * They are a guess like every other instant edit: taken back just before the patch, shown again
 * over a render of the old file, and dropped when the save is refused or never renders.
 *
 * They used to stay in the page's own text nodes. The patch only writes a text node that still
 * says what the last rendering said, so words the render did not repeat exactly (a component
 * that reshapes them, a refused save) stayed on the canvas, and no later edit could replace
 * them: only a refresh did.
 */
export function showTypedWords(nodes: readonly Text[], write: () => void): void {
  // Read before the words change: which source the page shows now.
  let shownFrom = sourceStamps(document);
  const rendered = nodes.map((node) => node.data);
  write();
  const words: readonly TypedWords[] = nodes.flatMap((node, at) => {
    const before = rendered[at];
    return before === undefined || before === node.data ? [] : [{ node, rendered: before, typed: node.data }];
  });
  if (words.length === 0) {
    return;
  }
  if (typedPending >= TYPED_PENDING_MAX) {
    takeWordsBack(words);
    return;
  }
  typedPending += 1;
  const waiting = new AbortController();
  const listen = { signal: waiting.signal };
  let stale = false;
  const end = () => {
    clearTimeout(timer);
    waiting.abort();
    typedPending -= 1;
    assert(typedPending >= 0, 'showTypedWords: each guess ends once');
  };
  const drop = () => {
    takeWordsBack(words);
    end();
  };
  const timer = setTimeout(drop, TYPED_HOLD_MS_MAX);
  document.addEventListener(
    'avb:before-morph',
    (event) => {
      const incoming = event instanceof CustomEvent && event.detail instanceof Document ? sourceStamps(event.detail) : undefined;
      stale = shownFrom !== undefined && shownFrom !== '' && incoming === shownFrom;
      shownFrom = incoming;
      takeWordsBack(words);
    },
    listen,
  );
  document.addEventListener(
    'avb:after-patch',
    () => {
      // A render of the old file leaves the words it said; any other has answered the save.
      if (stale) {
        showWordsAgain(words);
      } else {
        end();
      }
    },
    listen,
  );
  window.addEventListener(
    'message',
    (event) => {
      const data: unknown = event.data;
      const type: unknown = typeof data === 'object' && data !== null && 'type' in data ? data.type : undefined;
      if (type === 'avb:insert-revert' || type === 'avb:move-revert') {
        drop();
      }
    },
    listen,
  );
}

// Only a node still holding what the guess left there, or found there, is written.
function takeWordsBack(words: readonly TypedWords[]): void {
  for (const { node, rendered, typed } of words) {
    if (node.data === typed) {
      node.data = rendered;
    }
  }
}

function showWordsAgain(words: readonly TypedWords[]): void {
  for (const { node, rendered, typed } of words) {
    if (node.isConnected && node.data === rendered) {
      node.data = typed;
    }
  }
}

function holdsSelection(root: HTMLElement): boolean {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) {
    return false;
  }
  return root.contains(selection.anchorNode) && root.contains(selection.focusNode);
}

function clearNativeTextSelection(root: HTMLElement): void {
  const selection = window.getSelection();
  if (!selection) {
    return;
  }
  // Blur removes focus, but browsers retain a highlighted Range. Clear only
  // this editor's range so a new element's native selection is left alone.
  if (root.contains(selection.anchorNode) || root.contains(selection.focusNode)) {
    selection.removeAllRanges();
  }
}

// Each text's newlines and the indentation around them, as one space: what `white-space: normal` shows for them.
function foldSourceNewlines(nodes: readonly Text[]): TrimmedEdge[] {
  const folded: TrimmedEdge[] = [];
  for (const node of nodes) {
    if (/\n/.test(node.data)) {
      folded.push({ node, data: node.data });
      node.data = node.data.replace(/[\t\f\r ]*\n[\t\n\f\r ]*/g, ' ');
    }
  }
  return folded;
}

function installNativeTextStyle(root: HTMLElement, breaks: CanvasTextBreaks | undefined): void {
  const computed = getComputedStyle(root).whiteSpace;
  // Typed line breaks show as lines; spaces still collapse as they did, so nothing moves when the editor opens.
  const whitespace = breaks !== undefined && /^(normal|nowrap)$/.test(computed) ? 'pre-line' : computed;
  // Editing must preserve collapsed source indentation as well as preformatted text.
  styleTextEditor(whitespace);
}

/** Height growth that is layout noise, not a new line: sub-pixel rounding. */
const GROWTH_TOLERANCE_PX = 0.5;

interface TrimmedEdge {
  readonly node: Text;
  readonly data: string;
}

// Whitespace-only text nodes at the very start and end of the editing root, emptied for as long as it is
// edited. Only where whitespace collapses and the root is not inline (inside a line it separates words).
function trimEdgeWhitespace(root: HTMLElement, nodes: readonly Text[]): TrimmedEdge[] {
  const style = getComputedStyle(root);
  if (style.display === 'inline' || !/^(normal|nowrap|pre-line)$/.test(style.whiteSpace)) {
    return [];
  }
  const edges: TrimmedEdge[] = [];
  const blank = (node: Text) => node.data.length > 0 && /^[\t\n\f\r ]*$/.test(node.data);
  const content = (node: Node) => !(node instanceof Comment) && !(node instanceof Text && node.data.length === 0);
  for (const direction of ['previousSibling', 'nextSibling'] as const) {
    for (const node of direction === 'previousSibling' ? nodes : [...nodes].reverse()) {
      if (!blank(node) || node.parentNode !== root) {
        break;
      }
      let sibling = node[direction] ?? undefined;
      while (sibling !== undefined && !content(sibling)) {
        sibling = sibling[direction] ?? undefined;
      }
      const others = sibling !== undefined && !(sibling instanceof Text && blank(sibling) && nodes.includes(sibling));
      if (others) {
        break;
      }
      edges.push({ node, data: node.data });
      node.data = '';
    }
  }
  return edges;
}
