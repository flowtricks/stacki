// Whether a `<style>` the insert palette adds is written `<style is:global>`.
//
// Astro scopes a `<style>` to the file it is written in: every selector gets
// that file's `data-astro-cid-…` attribute, and only that file's own elements
// carry it. A scoped block in a component therefore stops at the component's
// edge: it misses what a page passes into the component's slots and the
// elements of every component it renders, so a class styled there does not
// style the same class anywhere else. A builder's styles (Webflow's classes)
// apply wherever the class is used, and that is how a component's styles are
// expected to behave here, so a block added to a component's own markup
// starts out global.
//
// The file being written decides it, not what the canvas shows around the
// insertion. A page's markup stays scoped, including the children a page
// passes into a component instance's slot: those are written in the page
// file, and a page's scoped block reaches them already. While a component is
// open its file is the edited model (useOpenComponent), so nothing inserted
// then lands in the page.
//
// A layout counts as a component. It wraps the page, and the rules in its own
// block are page-wide by intent (`body`, resets, type), yet a scoped block
// could not reach the page content rendered in its slot at all.

import { assert } from '../../../shared/core/assert';
import type { CurrentPage } from '../../editor/pageState';
import { projectRelativePath } from '../../lib/projectPath';

export type StyleFileKind = 'page' | 'layout' | 'component';

// The `<style>` attribute that makes a block global: written bare, as Astro
// documents it, never `is:global=""`.
export const STYLE_GLOBAL_ATTRIBUTE = 'is:global';

export function styleBlockGlobal({ fileKind }: { readonly fileKind: StyleFileKind }): boolean {
  switch (fileKind) {
    case 'page':
      return false;
    case 'layout':
      return true;
    case 'component':
      return true;
    default: {
      const exhaustive: never = fileKind;
      return exhaustive;
    }
  }
}

// What kind of file an insertion is written into. A page entry is a page
// wherever it lives (the defaults canvas under `.stacki/canvas/` is one); a
// component entry is a layout when it lives in `src/layouts/`, the folder the
// project scan reads layouts from. Anything else that is open, a route the
// visual model does not hold included, is treated as a page: the scoped
// default is the one that changes nothing beyond the file.
export function editedFileKind(open: CurrentPage | undefined, projectPath: string | undefined, platform: NodeJS.Platform): StyleFileKind {
  if (open?.kind === 'component') {
    assert(open.path.length > 0, 'editedFileKind: an open component has a path');
    if (projectPath === undefined) {
      return 'component';
    } else {
      assert(projectPath.length > 0, 'editedFileKind: a project path is not empty');
      const relative = projectRelativePath(projectPath, open.path, platform);
      return relative.startsWith('src/layouts/') ? 'layout' : 'component';
    }
  } else {
    return 'page';
  }
}
