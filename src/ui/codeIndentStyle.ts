// Which indentation a file's code editor uses, decided from the file's path alone.
//
// Why a module of its own: this is plain string logic that the page state layer needs at startup (a
// file window's indentation), while `codeEditorIndent.ts` imports CodeMirror to build the editor
// extensions. Keeping the decision here lets the first renderer chunk answer the question without
// loading the code editor (docs/startup.md).

/** Tabs everywhere, but for a format that forbids them. */
export type CodeIndentStyle = 'spaces' | 'tabs';

/** The style a file's editor uses. YAML forbids tabs in indentation, so a tab there would break the file. */
export function codeIndentStyleFor(path: string): CodeIndentStyle {
  return /\.ya?ml$/i.test(path) ? 'spaces' : 'tabs';
}
