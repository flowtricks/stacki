// What the canvas is editing, as the column guide sees it. The guide lays out a page's columns, so while a component is
// open (in its own canvas, in place on a page, or on its defaults page) it is not drawn, and neither its toolbar button
// nor ⇧G is there to turn it on. The saved preference is not touched: it applies again on the next page.
import { CANVAS_DIRECTORY } from '../../../shared/properties/defaultsCanvas';

export type GuideSubject = 'page' | 'component';

/** What Desktop is editing. */
export function desktopGuideSubject(editor: {
  readonly openFile: { readonly kind: string; readonly path?: string | undefined } | undefined;
  readonly componentCanvas: 'idle' | 'opening' | 'open' | undefined;
  readonly defaultsCanvas: 'idle' | 'shown';
}): GuideSubject {
  if (editor.componentCanvas !== undefined && editor.componentCanvas !== 'idle') {
    return 'component';
  }
  if (editor.defaultsCanvas === 'shown') {
    return 'component';
  }
  if (editor.openFile?.kind === 'component') {
    return 'component';
  }
  // A canvas page can stay open for a moment after its canvas has closed, while the way back loads.
  const path = editor.openFile?.path?.replaceAll('\\', '/');
  return path?.includes('/' + CANVAS_DIRECTORY) === true ? 'component' : 'page';
}

/** What Studio is editing, from the open file's project path: an Astro file outside src/pages/ is a component. */
export function studioGuideSubject(file: string): GuideSubject {
  if (!file.endsWith('.astro')) {
    return 'page';
  }
  return file.startsWith('src/pages/') ? 'page' : 'component';
}
