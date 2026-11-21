// Where a preview frame sends its messages to the editor. On a hosted Studio the editor and the preview are
// different origins, so the frame's own origin is the wrong target and the browser drops the message; the
// editor's origin is written into the page as a meta tag. Without the tag (local development, one origin) the
// frame's own origin is right.
export function parentOrigin(document: Pick<Document, 'querySelector'>, fallback: string): string {
  const meta = document.querySelector<HTMLMetaElement>('meta[name=studio-parent-origin]');
  const content = meta?.content ?? '';
  return content === '' ? fallback : content;
}
