// What is being typed in on the canvas, whichever editor opened it: the editor of literal words (frameTextNative.ts)
// or the editor of a block or line of words (frameRichText.ts). Every part of the canvas that would take a press for
// itself (the guard that keeps a page from acting on it, the element drag, the context menu) asks here and leaves a
// press inside the edited element to the browser. Why one place: the block editor once registered nowhere, so each of
// its presses was cancelled: a single click moved no caret and no word could be selected.

let editingRoot: HTMLElement | undefined;
let stylesheet: CSSStyleSheet | undefined;

/** Whether `target` is inside the text being edited. */
export function isCanvasTextEditing(target: unknown): boolean {
  return target instanceof Node && !!editingRoot?.contains(target);
}

/** Marks `root` as the element being typed in, until the returned release. */
export function holdTextEditing(root: HTMLElement): () => void {
  editingRoot = root;
  return () => {
    if (editingRoot === root) {
      editingRoot = undefined;
    }
  };
}

/**
 * The look of an element being typed in, for both editors: no focus ring of the browser's own (the editor's cue is
 * drawn over the canvas), the browser's caret, and the text cursor over the select mode's arrow. `whiteSpace` is set
 * by the editor that shows typed newlines.
 */
export function styleTextEditor(whiteSpace: string | undefined): void {
  if (!stylesheet) {
    stylesheet = new CSSStyleSheet();
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, stylesheet];
  }
  const preserved = whiteSpace === undefined ? '' : ` white-space: ${whiteSpace} !important;`;
  stylesheet.replaceSync(
    `[data-avb-text-editor] { outline: none !important; caret-color: auto !important;${preserved} }` +
      '[data-avb-text-editor], [data-avb-text-editor] * { cursor: text !important; }',
  );
}
