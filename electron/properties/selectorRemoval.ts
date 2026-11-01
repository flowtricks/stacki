// Running the unused-selector check against a project on disk, and applying
// or undoing a cleanup. Every write is witnessed by the bytes it replaces, so a
// file changed by an editor or an AI between the check and the write is
// refused rather than overwritten, and every written file is read back.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import type { SelectorFileChange, SelectorFileDigest, SelectorRemoval } from '../../shared/properties/selectorUsage';
import type { StyleKeepList } from '../../shared/properties/styleKeepList';
import { writeProjectText } from '../documents/documentWrites';
import { planSelectorRemoval } from './selectorCleanup';
import { checkSelectorUsage } from './selectorUsageFiles';

export { checkSelectorUsage };

export async function removeUnusedSelectors(
  root: string,
  keepList: StyleKeepList,
  request: { readonly ids: readonly string[]; readonly files: readonly SelectorFileDigest[] },
): Promise<Result<SelectorRemoval>> {
  const analysis = await checkSelectorUsage(root, keepList);
  const planned = planSelectorRemoval(analysis, request.ids, request.files);
  if (!planned.ok) {
    return planned;
  }
  const written = writeChanges(root, planned.value, 'after');
  if (!written.ok) {
    return written;
  }
  return ok({ removed: new Set(request.ids).size, changes: planned.value });
}

/** Undo (`to: 'before'`) or redo (`to: 'after'`) a cleanup, if its files are as it left them. */
export function restoreSelectorFiles(root: string, changes: readonly SelectorFileChange[], to: 'before' | 'after'): Result<SelectorRemoval> {
  const written = writeChanges(root, changes, to);
  if (!written.ok) {
    return written;
  }
  return ok({ removed: 0, changes });
}

// Files are written one at a time; if one is refused, the ones already
// written are put back, so a cleanup lands in every file or in none.
function writeChanges(root: string, changes: readonly SelectorFileChange[], to: 'before' | 'after'): Result<void> {
  const done: Array<{ readonly file: string; readonly change: SelectorFileChange }> = [];
  for (const change of changes) {
    const file = projectFile(root, change.rel);
    const target = to === 'after' ? change.after : change.before;
    const expected = to === 'after' ? change.before : change.after;
    try {
      writeProjectText(file, target, expected);
    } catch (error: unknown) {
      const rollback = rollBack(done, to);
      const reason = error instanceof Error ? error.message : String(error);
      return err({ code: 'write-failed', message: rollback === undefined ? reason : `${reason} ${rollback}` });
    }
    // Pair assertion: the bytes on disk are the bytes the plan verified.
    assert(fs.readFileSync(file, 'utf8') === target, 'writeChanges: the written file reads back as planned');
    done.push({ file, change });
  }
  return ok(undefined);
}

function rollBack(done: ReadonlyArray<{ readonly file: string; readonly change: SelectorFileChange }>, to: 'before' | 'after'): string | undefined {
  const failed: string[] = [];
  for (const { file, change } of [...done].reverse()) {
    try {
      writeProjectText(file, to === 'after' ? change.before : change.after, to === 'after' ? change.after : change.before);
    } catch {
      failed.push(change.rel);
    }
  }
  return failed.length === 0 ? undefined : `These files kept the cleanup and need checking: ${failed.join(', ')}.`;
}

function projectFile(root: string, rel: string): string {
  const file = path.resolve(root, rel);
  const relative = path.relative(root, file);
  assert(relative !== '', 'projectFile: a change names a file, not the project');
  assert(!relative.startsWith('..'), 'projectFile: a change stays inside the project');
  assert(!path.isAbsolute(relative), 'projectFile: a change is relative to the project');
  return file;
}
