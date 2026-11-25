// Writing a component rename plan, all or nothing, and taking it back.
//
// Every text the plan read is witnessed first (it must still hold exactly what the plan saw); the writes then run as one leased
// unit through the document actors, the file moves last (a case-only rename goes through a temporary name, because on a
// case-insensitive disk `Card.astro` and `card.astro` are one file), and a failure anywhere puts back every text that was
// written. The renderer gets one undo token for the whole rename; undoing writes the inverse plan the same way, and refuses (with
// nothing changed) if any file has changed since.
import fs from 'node:fs';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import { err, ok, type AppError, type Result } from '../../shared/core/result';
import { COMPONENT_RENAME_LIMITS } from '../../shared/properties/componentRename';
import { described } from '../../shared/properties/i18n/messageRef';
import { renameDigest, type RenameText } from '../project/pageRenamePlan';
import type { RenameWriter } from '../project/pageRenameWrite';
import type { ComponentRenamePlan } from './componentRenamePlan';

interface Move {
  readonly from: string;
  readonly to: string;
}

/** What is written: texts at their current paths, then one file moved. The inverse swaps both. */
interface Step {
  readonly root: string;
  readonly texts: readonly RenameText[];
  readonly witnesses: readonly { readonly file: string; readonly digest: string }[];
  readonly move: Move;
}

export function applyComponentRename(plan: ComponentRenamePlan, writer: RenameWriter): Result<void> {
  return applyStep({ root: plan.root, texts: plan.texts, witnesses: plan.witnesses, move: plan.change }, writer);
}

/** The plan run backwards: texts swap before and after at their moved paths, and the file goes back. */
export function revertComponentRename(plan: ComponentRenamePlan, writer: RenameWriter): Result<void> {
  const { from, to } = plan.change;
  return applyStep(
    {
      root: plan.root,
      move: { from: to, to: from },
      witnesses: [],
      texts: plan.texts.map((entry) => ({ file: entry.file === from ? to : entry.file, before: entry.after, after: entry.before })),
    },
    writer,
  );
}

function applyStep(step: Step, writer: RenameWriter): Result<void> {
  assert(path.isAbsolute(step.root), 'A rename writes under an absolute project root');
  for (const witness of step.witnesses) {
    const current = writer.current(path.join(step.root, witness.file));
    if (!current.ok || renameDigest(current.value) !== witness.digest) {
      return err({ code: 'conflict', ...described('error.componentRename.fileChanged', { file: witness.file }) });
    }
  }
  const texts = step.texts.map((entry) => ({ ...entry, file: path.join(step.root, entry.file) }));
  return writer.lease(texts, () => writeLeased(step, texts, writer));
}

function writeLeased(step: Step, texts: readonly RenameText[], writer: RenameWriter): Result<void> {
  const source = path.join(step.root, ...step.move.from.split('/'));
  const target = path.join(step.root, ...step.move.to.split('/'));
  for (const entry of texts) {
    const current = writer.current(entry.file);
    if (!current.ok || current.value !== entry.before) {
      return err({ code: 'conflict', ...described('error.componentRename.fileChanged', { file: path.relative(step.root, entry.file) }) });
    }
  }
  const written: RenameText[] = [];
  for (const entry of texts) {
    const saved = writer.write(entry);
    if (!saved.ok) {
      // The failed write is included: a filesystem error can come after the replacement.
      return putBack([...written, entry], saved.error, writer);
    }
    written.push(entry);
  }
  const moved = moveFile(source, target);
  return moved.ok ? moved : putBack(written, moved.error, writer);
}

function moveFile(source: string, target: string): Result<void> {
  try {
    const caseOnly = source.toLowerCase() === target.toLowerCase() && source !== target;
    if (!caseOnly && fs.existsSync(target)) {
      return err({ code: 'conflict', ...described('error.componentRename.destinationAppeared') });
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (caseOnly) {
      const temporary = path.join(path.dirname(source), `.stacki-rename-${process.pid}-${Date.now()}`);
      fs.renameSync(source, temporary);
      fs.renameSync(temporary, target);
    } else {
      fs.renameSync(source, target);
    }
    assert(fs.existsSync(target), 'A moved component is at its new path');
    return ok(undefined);
  } catch (error: unknown) {
    return err({ code: 'filesystem', message: error instanceof Error ? error.message : String(error) });
  }
}

function putBack(written: readonly RenameText[], cause: AppError, writer: RenameWriter): Result<never> {
  const failed: string[] = [];
  for (const entry of [...written].reverse()) {
    const current = writer.current(entry.file);
    if (current.ok && current.value === entry.before) {
      continue;
    }
    if (!writer.write({ ...entry, before: entry.after, after: entry.before }).ok) {
      failed.push(entry.file);
    }
  }
  return err(
    failed.length > 0
      ? { code: 'rollback', ...described('error.componentRename.restoreFailed', { detail: cause.message, files: failed.join(', ') }) }
      : { code: 'filesystem', ...described('error.componentRename.restored', { detail: cause.message }) },
  );
}

/** Renames main can still take back, oldest forgotten first. */
export class ComponentRenameStore {
  readonly #entries = new Map<string, ComponentRenamePlan>();
  #next = 0;

  record(plan: ComponentRenamePlan): string {
    this.#next += 1;
    const token = `component-rename-${this.#next}`;
    this.#entries.set(token, plan);
    while (this.#entries.size > COMPONENT_RENAME_LIMITS.undoEntriesMax) {
      const oldest = this.#entries.keys().next();
      assert(oldest.done !== true, 'A store over its bound has an oldest entry');
      this.#entries.delete(oldest.value);
    }
    return token;
  }

  get(token: string): ComponentRenamePlan | undefined {
    return this.#entries.get(token);
  }
}
