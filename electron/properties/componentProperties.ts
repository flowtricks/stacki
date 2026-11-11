import { readPropertyConsumers, readBoundedSource, filesystemError } from './propertyConsumers';
// Plan against exact source revisions, then commit as one synchronous batch.
// Failed writes restore earlier files so a rename cannot leave half the site on the old API.
//
// From step 5 the batch runs through the document actors (plan §3.3): their
// actors are leased in sorted canonical-path order, each file is witnessed by
// the checksum of its `before` text, and every write — rollback included — is
// the file's diff from those bytes (a `rewrite-text`, step 10), so an outside
// edit is refused, never overwritten.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import { LIMITS } from '../../shared/core/limits';
import { PROPERTY_LIMITS } from '../../shared/properties/propertyEditing';
import type { ComponentProperties, PropertyChange, PropertyOptionRename } from '../../shared/properties/propertyEditing';
import { err, ok, type Result } from '../../shared/core/result';
import { literalOptions } from '../../shared/properties/propertyOptions';
import { sameFilesystemPath } from '../lib/platform';
import { digestOf } from '../documents/atomicWrite';
import type { DocumentActors, WriteReport } from '../documents/documentActors';
import { editPropertyDefinition, readComponentProperties } from './propertyDefinitions';
import { renameComponentOptionValues, renameComponentReferences } from './propertyRename';
import { planSharedPropertyChange, withSharedProperties } from './sharedProperties';

interface PropertyLocation {
  readonly projectPath: string;
  readonly file: string;
}
interface PropertyEditRequest extends PropertyLocation {
  readonly source: string;
  readonly change: PropertyChange;
}
export interface FileChange {
  readonly file: string;
  readonly before: string;
  readonly after: string;
}

/** Where a batch writes: the document actors, and the note that the app
 * wrote a file (the canvas may need to hear of it). The watcher tells the
 * app's own writes from outside ones by the actors' committed bytes (plan
 * §11.9). `onCommitted` hears every batch that applied, with what it changed
 * (step 6: its inverse batch is Undo). */
export interface PropertyWriter {
  readonly documents: DocumentActors;
  readonly noteWrite: (file: string) => void;
  readonly onCommitted?: (changes: readonly FileChange[]) => void;
}

/** A batch's inverse (plan §3.3, §11 step 6): each file back from what the
 * batch wrote to what it replaced. Applied as a batch of its own — every file
 * checked against the bytes the batch left before any is written, the checked
 * rollback on a failure — so a file changed since refuses the whole undo,
 * naming it, and a half-undone rename cannot happen. */
export function inverseBatch(changes: readonly FileChange[]): readonly FileChange[] {
  assert(changes.length <= PROPERTY_LIMITS.filesMax, 'A batch is bounded');
  return changes.map((change) => ({
    file: change.file,
    before: change.after,
    after: change.before,
  }));
}

/** Inverse batches waiting for Undo, kept in main so the renderer holds a
 * token, never a writable batch: the channel that applies one can write only
 * what a property edit wrote. Bounded by LIMITS.undoEntriesMax, oldest first
 * out; an expired token is refused. */
export class PropertyUndoStore {
  readonly #batches = new Map<string, readonly FileChange[]>();

  record(changes: readonly FileChange[]): string {
    const token = randomUUID();
    this.#batches.set(token, changes);
    for (const oldest of this.#batches.keys()) {
      if (this.#batches.size <= LIMITS.undoEntriesMax) {
        break;
      }
      this.#batches.delete(oldest);
    }
    assert(this.#batches.size <= LIMITS.undoEntriesMax, 'Undo batches are bounded');
    return token;
  }

  take(token: string): readonly FileChange[] | undefined {
    const changes = this.#batches.get(token);
    this.#batches.delete(token);
    return changes;
  }
}

/** Apply a recorded inverse batch; the batch undoing it is recorded in turn
 * (Redo), and its token returned. */
export function revertComponentProperties(token: string, store: PropertyUndoStore, writer: PropertyWriter): Result<{ readonly undo: string }> {
  const changes = store.take(token);
  if (changes === undefined) {
    return err({ code: 'expired', message: 'This property change can no longer be undone.' });
  }
  const committed = commitPropertyChanges(changes, writer);
  if (!committed.ok) {
    return committed;
  }
  return ok({ undo: store.record(inverseBatch(changes)) });
}

/** Why a batch write failed, before the rollback decides what to report. */
interface WriteFailure {
  readonly code: 'conflict' | 'filesystem' | 'write-race';
  readonly message: string;
}

export function loadComponentProperties(location: PropertyLocation): Result<ComponentProperties> {
  const target = validateLocation(location);
  if (!target.ok) {
    return target;
  }
  const source = readBoundedSource(target.value.file);
  if (!source.ok) {
    return source;
  }
  return withSharedProperties(target.value, readComponentProperties(source.value));
}

export function updateComponentProperties(request: PropertyEditRequest, writer: PropertyWriter): Result<ComponentProperties> {
  const target = validateLocation(request);
  if (!target.ok) {
    return target;
  }
  const source = readBoundedSource(target.value.file);
  if (!source.ok) {
    return source;
  }
  if (source.value !== request.source) {
    return err({
      code: 'conflict',
      message: 'This component changed on disk. Reload before saving.',
    });
  }
  const plan = planComponentPropertyChanges({ ...request, ...target.value }, source.value);
  if (!plan.ok) {
    return plan;
  }
  const result = commitPropertyChanges(plan.value, writer);
  if (!result.ok) {
    return result;
  }
  writer.onCommitted?.(plan.value);
  const updated = plan.value.find((entry) => sameFilesystemPath(entry.file, target.value.file));
  assert(updated !== undefined, 'Property transaction includes the component');
  return withSharedProperties(target.value, readComponentProperties(updated.after));
}

// A prop a shared type declares writes that type's file and its users
// (sharedProperties.ts); every other change is the component's own.
function planComponentPropertyChanges(request: PropertyEditRequest, source: string): Result<readonly FileChange[]> {
  const shared = planSharedPropertyChange(request, source, request.change);
  if (shared !== undefined) {
    return shared;
  }
  const changed = editPropertyDefinition(source, request.change);
  if (!changed.ok) {
    return changed;
  }
  return planPropertyChanges(request, changed.value);
}

function validateLocation(location: PropertyLocation): Result<PropertyLocation> {
  let root: string;
  let file: string;
  try {
    root = fs.realpathSync(path.join(location.projectPath, 'src'));
    file = fs.realpathSync(location.file);
  } catch (error: unknown) {
    return filesystemError(error);
  }
  const relative = path.relative(root, file);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !file.endsWith('.astro')) {
    return err({
      code: 'path',
      message: 'Select an Astro component inside this project’s src folder.',
    });
  }
  return ok({ projectPath: path.dirname(root), file });
}
function planPropertyChanges(request: PropertyEditRequest, source: string): Result<readonly FileChange[]> {
  const change = request.change;
  const first = { file: request.file, before: request.source, after: source };
  if (change.kind === 'remove') {
    return planPropertyRemoval(request, first, change.name);
  }
  const propertyRename = propertyRenameForChange(change);
  const optionRenames = change.kind === 'save' ? (change.optionRenames ?? []) : [];
  if (!propertyRename && optionRenames.length === 0) {
    return ok([first]);
  }
  if (change.kind !== 'save' || !change.originalName) {
    return err({
      code: 'option',
      message: 'Only an existing property can rename options.',
    });
  }
  const valid = validateOptionRenames(request.source, source, change, optionRenames);
  if (!valid.ok) {
    return valid;
  }
  const consumers = readPropertyConsumers(request);
  if (!consumers.ok) {
    return consumers;
  }
  const changes: FileChange[] = [];
  for (const consumer of consumers.value) {
    const { file, names } = consumer;
    const own = sameFilesystemPath(file, request.file);
    const original = own ? source : consumer.source;
    const owner = own ? 'definition' : 'consumer';
    const changed = planConsumerChange(original, names, change, propertyRename, optionRenames, owner);
    if (!changed.ok) {
      return err({
        code: changed.error.code,
        message: `${path.relative(request.projectPath, file)}: ${changed.error.message}`,
      });
    }
    if (own || changed.value !== original) {
      changes.push({
        file,
        before: own ? request.source : original,
        after: changed.value,
      });
    }
  }
  assert(
    changes.some((entry) => sameFilesystemPath(entry.file, request.file)),
    'Rename plan includes the definition',
  );
  return ok(changes);
}

function propertyRenameForChange(change: PropertyChange): { readonly from: string; readonly to: string } | undefined {
  if (change.kind !== 'save' || !change.originalName) {
    return undefined;
  }
  return change.originalName === change.property.name ? undefined : { from: change.originalName, to: change.property.name };
}

function planConsumerChange(
  source: string,
  names: ReadonlySet<string>,
  change: Extract<PropertyChange, { readonly kind: 'save' }>,
  propertyRename: { readonly from: string; readonly to: string } | undefined,
  optionRenames: readonly PropertyOptionRename[],
  owner: 'definition' | 'consumer',
): Result<string> {
  const renamed = propertyRename ? renameComponentReferences(source, names, propertyRename, owner) : ok(source);
  if (!renamed.ok || optionRenames.length === 0) {
    return renamed;
  }
  return renameComponentOptionValues(renamed.value, names, change.property.name, optionRenames);
}

function validateOptionRenames(
  beforeSource: string,
  afterSource: string,
  change: Extract<PropertyChange, { readonly kind: 'save' }>,
  renames: readonly PropertyOptionRename[],
): Result<void> {
  if (renames.length === 0) {
    return ok(undefined);
  }
  const before = readComponentProperties(beforeSource).properties.find((property) => property.name === change.originalName);
  const after = readComponentProperties(afterSource).properties.find((property) => property.name === change.property.name);
  const beforeOptions = before ? literalOptions(before.type) : undefined;
  const afterOptions = after ? literalOptions(after.type) : undefined;
  if (!beforeOptions || !afterOptions) {
    return err({
      code: 'option',
      message: 'Option renames require an editable literal union.',
    });
  }
  for (const rename of renames) {
    if (!beforeOptions.includes(rename.from) || !afterOptions.includes(rename.to)) {
      return err({
        code: 'option',
        message: 'An option rename does not match the saved union.',
      });
    }
  }
  return ok(undefined);
}

function commitPropertyChanges(changes: readonly FileChange[], writer: PropertyWriter): Result<void> {
  assert(changes.length <= PROPERTY_LIMITS.filesMax, 'Property transaction is bounded');
  assert(new Set(changes.map((change) => change.file)).size === changes.length, 'Property transaction writes each file once');
  const leased = writer.documents.withLeases(changes, (ordered) => commitLeased(ordered, writer));
  if (!leased.ok) {
    return err({ code: 'filesystem', message: leased.error });
  }
  return leased.value;
}

// Holding every actor of the batch: check all, then write each in order.
function commitLeased(changes: readonly FileChange[], writer: PropertyWriter): Result<void> {
  for (const change of changes) {
    const current = writer.documents.current(change.file);
    if (!current.ok) {
      return err({ code: 'filesystem', message: current.error.message });
    }
    if (current.value.checksum !== digestOf(change.before)) {
      return err({
        code: 'conflict',
        message: `${change.file} changed during the rename. Try again.`,
      });
    }
  }
  const written: FileChange[] = [];
  for (const change of changes) {
    writer.noteWrite(change.file);
    const report = writer.documents.writeText(change.file, change.after, digestOf(change.before));
    if (report.tag !== 'applied') {
      // An uncertain write may hold the batch's bytes; the rollback's witness
      // restores it only if it does. A refused one was never written.
      const mine = report.tag === 'uncertain' ? [...written, change] : written;
      return rollbackPropertyChanges(mine, failureOf(change.file, report), writer);
    }
    assert(report.checksum === digestOf(change.after), 'Property write reports the planned bytes');
    written.push(change);
  }
  return ok(undefined);
}

function failureOf(file: string, report: Exclude<WriteReport, { tag: 'applied' }>): WriteFailure {
  switch (report.tag) {
    case 'rejected':
      switch (report.reason) {
        case 'region-externally-modified':
          return { code: 'conflict', message: `${file} changed during the rename.` };
        case 'write-race':
          return {
            code: 'write-race',
            message: report.message || `${file} was changed by another writer during the save`,
          };
        case 'anchor-moved':
        case 'anchor-ambiguous':
        case 'source-invalid':
        case 'unsupported-operation':
        case 'resource-limit':
        case 'write-failed':
        case 'merge-conflict':
          return { code: 'filesystem', message: report.message || `Could not save ${file}` };
        default: {
          const exhaustive: never = report.reason;
          return exhaustive;
        }
      }
    case 'uncertain':
      return { code: 'filesystem', message: `${file} may not have been saved. ${report.message}` };
    case 'backpressured':
      throw new Error('Assertion failed: a leased actor holds no other intent to push back with');
    default: {
      const exhaustive: never = report;
      return exhaustive;
    }
  }
}

// Best-effort, not atomic (plan §3.3): each file is restored only while it
// still holds exactly the bytes this batch wrote — the restore is an intent
// witnessed by their checksum. A file somebody changed since is theirs now;
// restoring it would destroy their edit, so it is named instead.
function rollbackPropertyChanges(written: readonly FileChange[], cause: WriteFailure, writer: PropertyWriter): Result<never> {
  assert(written.length <= PROPERTY_LIMITS.filesMax, 'Rollback is bounded by the batch');
  const failed: string[] = [];
  const changed: string[] = [];
  for (const change of [...written].reverse()) {
    const restored = restorePropertyFile(change, writer);
    if (restored === 'changed') {
      changed.push(change.file);
    } else if (restored === 'failed') {
      failed.push(change.file);
    }
  }
  if (failed.length > 0 || changed.length > 0) {
    const parts = [
      failed.length > 0 ? `recovery failed for: ${failed.join(', ')}` : '',
      changed.length > 0 ? `changed by another program, left as is: ${changed.join(', ')}` : '',
    ].filter((part) => part !== '');
    return err({
      code: 'rollback',
      message: `Save failed and ${parts.join('; ')}. ${cause.message}`,
    });
  }
  return err({ code: cause.code, message: `Save failed; changes restored. ${cause.message}` });
}

function restorePropertyFile(change: FileChange, writer: PropertyWriter): 'restored' | 'changed' | 'failed' {
  writer.noteWrite(change.file);
  const report = writer.documents.writeText(change.file, change.before, digestOf(change.after));
  switch (report.tag) {
    case 'applied':
      return 'restored';
    case 'rejected':
      return report.reason === 'region-externally-modified' ? 'changed' : 'failed';
    case 'uncertain':
    case 'backpressured':
      return 'failed';
    default: {
      const exhaustive: never = report;
      return exhaustive;
    }
  }
}

function planPropertyRemoval(request: PropertyEditRequest, change: FileChange, name: string): Result<readonly FileChange[]> {
  const consumers = readPropertyConsumers(request);
  if (!consumers.ok) {
    return consumers;
  }
  for (const consumer of consumers.value) {
    const result = renameComponentReferences(consumer.source, consumer.names, { from: name, to: '_stackiDeletedProperty' }, 'consumer');
    if (!result.ok) {
      return result;
    }
    if (result.value !== consumer.source) {
      return err({
        code: 'in-use',
        message: `${consumer.file} still passes ${name}. ` + 'Remove that instance value before deleting the prop.',
      });
    }
  }
  return ok([change]);
}
