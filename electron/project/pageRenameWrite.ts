import fs from 'node:fs';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import type { PageRenamePlan, RenameText } from './pageRenamePlan';

/** Witness every text before writing; restore only our own bytes if an operation fails. */
export interface RenameWriter {
  readonly current: (file: string) => Result<string>;
  readonly write: (entry: RenameText) => Result<void>;
  readonly lease: (texts: readonly RenameText[], run: () => Result<void>) => Result<void>;
}
export function applyPageRename(plan: PageRenamePlan, writer: RenameWriter): Result<void> {
  assert(plan.texts.length <= 10_000, 'Rename write batch is bounded');
  assert(path.isAbsolute(plan.root), 'Rename writes use an absolute project root');
  if (plan.change.from === plan.change.to) {
    return ok(undefined);
  }
  for (const witness of plan.witnesses) {
    const current = writer.current(path.join(plan.root, witness.file));
    if (!current.ok || current.value !== witness.source) {
      return err({ code: 'conflict', message: `${witness.file} changed. Retry the rename.` });
    }
  }
  const texts = plan.texts.map((entry) => ({ ...entry, file: path.join(plan.root, entry.file) }));
  return writer.lease(texts, () => renameLeased(plan, texts, writer));
}
function renameLeased(plan: PageRenamePlan, texts: readonly RenameText[], writer: RenameWriter): Result<void> {
  const source = path.join(plan.root, 'src/pages', plan.change.from);
  const target = path.join(plan.root, 'src/pages', plan.change.to);
  if (fs.existsSync(target)) {
    return err({ code: 'conflict', message: 'That page or folder already exists.' });
  }
  for (const entry of texts) {
    const current = writer.current(entry.file);
    if (!current.ok || current.value !== entry.before) {
      return err({ code: 'conflict', message: `${entry.file} changed. Retry the rename.` });
    }
  }
  const written: RenameText[] = [];
  for (const entry of texts) {
    const saved = writer.write(entry);
    if (!saved.ok) {
      // Include the failed write: a filesystem error can occur after replacement.
      return restoreRenameTexts([...written, entry], saved.error.message, writer);
    }
    written.push(entry);
  }
  const moved = moveRenamePath(source, target);
  return moved.ok ? moved : restoreRenameTexts(written, moved.error.message, writer);
}
function moveRenamePath(source: string, target: string): Result<void> {
  try {
    if (fs.existsSync(target)) {
      return err({ code: 'conflict', message: 'The destination appeared during the rename.' });
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(source, target);
    return ok(undefined);
  } catch (error: unknown) {
    return err({
      code: 'filesystem',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
function restoreRenameTexts(written: readonly RenameText[], message: string, writer: RenameWriter): Result<never> {
  const failed: string[] = [];
  for (const entry of [...written].reverse()) {
    const current = writer.current(entry.file);
    if (current.ok && current.value === entry.before) {
      continue;
    }
    const saved = writer.write({ ...entry, before: entry.after, after: entry.before });
    if (!saved.ok) {
      failed.push(entry.file);
    }
  }
  return err({
    code: failed.length ? 'rollback' : 'filesystem',
    message: failed.length
      ? `${message} Could not restore: ${failed.join(', ')}. Check these files before retrying.`
      : `${message} Link changes were restored.`,
  });
}

/** Used only before Studio acknowledges a durable checkpoint. */
export function undoPageRename(plan: PageRenamePlan, writer: RenameWriter): Result<void> {
  const inverse = {
    ...plan,
    change: { ...plan.change, from: plan.change.to, to: plan.change.from },
    witnesses: [],
    texts: plan.texts.map((entry) => ({
      file: plan.relocated.get(entry.file) ?? entry.file,
      before: entry.after,
      after: entry.before,
    })),
  };
  return applyPageRename(inverse, writer);
}
