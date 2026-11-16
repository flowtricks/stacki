import type { TextMatch } from './frameTextMatch';
import { createTextBuffer, type TextRunChange } from './frameTextBuffer';
import { placeTextCaret, textEditorRoot, textSelection, type TextSpace } from './frameTextSelection';
import { installNativeTextEvents } from './frameTextNativeEvents';

let editingRoot: HTMLElement | undefined;
let stylesheet: CSSStyleSheet | undefined;

export function isCanvasTextEditing(target: unknown): boolean {
  return target instanceof Node && !!editingRoot?.contains(target);
}

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

export function openNativeText(match: TextMatch, space: TextSpace, event: MouseEvent, callbacks: NativeTextCallbacks) {
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
  installNativeTextStyle(root);
  root.setAttribute('contenteditable', 'true');
  root.setAttribute('data-avb-text-editor', '');
  // Opening the editor must not move a pixel. In Chromium an editable block with
  // `text-wrap: balance` gives the whitespace a component's slot leaves after its
  // words (the newline before the closing tag) a line of its own: the Webflow
  // heading went from 88.6px to 132.9px, 44px of blank band under its last line.
  // That whitespace is collapsed and invisible while the page is not editable, so
  // the editor keeps it out of the text it edits and puts it back on close.
  const trimmed = root.getBoundingClientRect().height > heightBefore + GROWTH_TOLERANCE_PX ? trimEdgeWhitespace(root, match.nodes) : [];
  const buffer = createTextBuffer(root, space, changed);
  if (!buffer) {
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
    clearNativeTextSelection(root);
    const changes = action === 'apply' ? buffer.changes() : [];
    // The original words come back first: the save is checked against them.
    const { restored, keep } = buffer.restore();
    restoreAttributes();
    for (const edge of trimmed) {
      edge.node.data = edge.data;
    }
    editingRoot = undefined;
    root.blur();
    done({ changes, restored, keep });
  };
  editingRoot = root;
  const { cleanup, pressed } = installNativeTextEvents({ root, space, buffer, finish, refused });
  root.focus({ preventScroll: true });
  placeTextCaret(match.nodes, event);
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
      return isCanvasTextEditing(click.target) && !!range && !!textSelection(match.nodes, range);
    },
  };
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

function installNativeTextStyle(root: HTMLElement): void {
  const whitespace = getComputedStyle(root).whiteSpace;
  if (!stylesheet) {
    stylesheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, stylesheet];
  }
  // Editing must preserve collapsed source indentation as well as preformatted
  // text. The browser owns the caret; only its default focus outline is suppressed.
  stylesheet.replaceSync(
    '[data-avb-text-editor] { outline: none !important; caret-color: auto !important;' +
      ` white-space: ${whitespace} !important; }` +
      '[data-avb-text-editor], [data-avb-text-editor] * { cursor: text !important; }',
  );
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
