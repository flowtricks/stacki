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
  const buffer = createTextBuffer(root, space, changed);
  if (!buffer) {
    return undefined;
  }
  const attributes = ['contenteditable', 'data-avb-text-editor'].map((name) => ({
    name,
    value: root.getAttribute(name),
  }));
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
    for (const attribute of attributes) {
      if (attribute.value === null) {
        root.removeAttribute(attribute.name);
      } else {
        root.setAttribute(attribute.name, attribute.value);
      }
    }
    editingRoot = undefined;
    root.blur();
    done({ changes, restored, keep });
  };
  installNativeTextStyle(root);
  root.setAttribute('contenteditable', 'true');
  root.setAttribute('data-avb-text-editor', '');
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
