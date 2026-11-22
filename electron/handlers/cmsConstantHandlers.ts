// The CMS panel's file settings: a data file's plain variables, listed, and one
// added or removed, in the file's own style (electron/parse/constantFields.ts).
// Each edit is written through the file's document actor against the bytes it
// was made from, and answers with the text before and after, so the panel's
// undo can put either back, again only over the text it replaced.

import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import type { ConstantEdit, ConstantRefusal } from '../../shared/properties/cmsConstants';
import { writeProjectText } from '../documents/documentWrites';
import { readSource } from '../lib/mainLimits';
import { constantFileOf, insertConstant, readConstants, removeConstant, reorderConstants, styleOfConstants, type ConstantFile } from '../parse/constantFields';
import { cmsAbs, splitCmsRel } from './cmsFiles';
import type { MainHost } from './mainHost';

export function registerCmsConstantHandlers({ ipcMain, send }: Pick<MainHost, 'ipcMain' | 'send'>): void {
  ipcMain.handle('cms:constants', async (_event, { projectPath, rel }) => {
    const target = constantTarget(projectPath, rel);
    const listing = readConstants(readSource(target.abs), target.file);
    return listing.ok ? { ok: true, listing: listing.value } : { ok: false, refusal: listing.error };
  });

  ipcMain.handle('cms:editConstants', async (_event, { projectPath, rel, edit }) => {
    const target = constantTarget(projectPath, rel);
    const before = readSource(target.abs);
    const next = editedSource(before, edit, target.file);
    if (!next.ok) {
      return { ok: false, refusal: next.error };
    }
    // A reorder into the order the file already has changes nothing, and nothing is written.
    if (next.value === before) {
      assert(edit.kind === 'reorder', 'cms:editConstants: only a reorder can leave the file as it was');
      return { ok: true, before, after: before };
    }
    // Witnessed by the bytes the edit was made from: a write that raced this one is refused, not overwritten.
    writeProjectText(target.abs, next.value, before);
    send('cms:changed', {});
    // A page the editor has open holds its frontmatter in its model; our writes are invisible to the watcher.
    if (target.file.host === 'page') {
      send('fs:changed', { files: [target.abs] });
    }
    return { ok: true, before, after: next.value };
  });
}

function constantTarget(projectPath: string, rel: string): { readonly abs: string; readonly file: ConstantFile } {
  const { fileRel } = splitCmsRel(rel);
  const abs = cmsAbs(projectPath, fileRel);
  const file = constantFileOf(abs);
  if (file === undefined) {
    throw new Error(`src/${fileRel} is not a script or a page.`);
  }
  return { abs, file };
}

function editedSource(before: string, edit: ConstantEdit, file: ConstantFile): Result<string, ConstantRefusal> {
  switch (edit.kind) {
    case 'add': {
      const style = styleOfConstants(before, file);
      return style.ok ? insertConstant(before, edit.field, style.value) : style;
    }
    case 'remove':
      return removeConstant(before, edit.name, file);
    case 'reorder':
      return reorderConstants(before, edit.order, file);
    case 'restore':
      // An undo or redo puts back the text it replaced, only while the file still holds what it left.
      if (before === edit.expected) {
        return edit.text === before ? err('changed') : ok(edit.text);
      }
      return err('changed');
    default: {
      const exhaustive: never = edit;
      return exhaustive;
    }
  }
}
