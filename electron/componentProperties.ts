import { randomUUID } from 'node:crypto';
import { readPropertyConsumers, readBoundedSource, filesystemError } from './propertyConsumers';
// Plan against exact source revisions, then commit as one synchronous batch.
// Failed writes restore earlier files so a rename cannot leave half the site on the old API.
import fs from 'node:fs';
import path from 'node:path';
import { assert } from '../shared/assert';
import { PROPERTY_LIMITS } from '../shared/component-properties';
import type {
  ComponentProperties,
  PropertyChange,
  PropertyOptionRename,
} from '../shared/component-properties';
import { err, ok, type Result } from '../shared/result';
import { literalOptions } from '../shared/property-options';
import { sameFilesystemPath } from './platform';
import { editPropertyDefinition, readComponentProperties } from './propertyDefinitions';
import { renameComponentOptionValues, renameComponentReferences } from './propertyRename';

interface PropertyLocation {
  readonly projectPath: string;
  readonly file: string;
}
interface PropertyEditRequest extends PropertyLocation {
  readonly source: string;
  readonly change: PropertyChange;
}
interface FileChange {
  readonly file: string;
  readonly before: string;
  readonly after: string;
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
  return ok(readComponentProperties(source.value));
}

export function updateComponentProperties(
  request: PropertyEditRequest,
  noteWrite: (file: string, source: string) => void
): Result<ComponentProperties> {
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
  const changed = editPropertyDefinition(source.value, request.change);
  if (!changed.ok) {
    return changed;
  }
  const plan = planPropertyChanges({ ...request, ...target.value }, changed.value);
  if (!plan.ok) {
    return plan;
  }
  const result = commitPropertyChanges(plan.value, noteWrite);
  if (!result.ok) {
    return result;
  }
  const updated = plan.value.find((entry) => sameFilesystemPath(entry.file, target.value.file));
  assert(updated !== undefined, 'Property transaction includes the component');
  return ok(readComponentProperties(updated.after));
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
function planPropertyChanges(
  request: PropertyEditRequest,
  source: string
): Result<readonly FileChange[]> {
  const change = request.change;
  const first = { file: request.file, before: request.source, after: source };
  if (change.kind === 'remove') {
    return planPropertyRemoval(request, first, change.name);
  }
  const propertyRename = propertyRenameForChange(change);
  const optionRenames = change.kind === 'save' ? change.optionRenames ?? [] : [];
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
    const changed = planConsumerChange(original, names, change, propertyRename, optionRenames, own);
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
    'Rename plan includes the definition'
  );
  return ok(changes);
}

function propertyRenameForChange(
  change: PropertyChange
): { readonly from: string; readonly to: string } | undefined {
  if (change.kind !== 'save' || !change.originalName) {
    return undefined;
  }
  return change.originalName === change.property.name
    ? undefined
    : { from: change.originalName, to: change.property.name };
}

function planConsumerChange(
  source: string,
  names: ReadonlySet<string>,
  change: Extract<PropertyChange, { readonly kind: 'save' }>,
  propertyRename: { readonly from: string; readonly to: string } | undefined,
  optionRenames: readonly PropertyOptionRename[],
  own: boolean
): Result<string> {
  const renamed = propertyRename
    ? renameComponentReferences(source, names, propertyRename, own ? 'definition' : 'consumer')
    : ok(source);
  if (!renamed.ok || optionRenames.length === 0) {
    return renamed;
  }
  return renameComponentOptionValues(renamed.value, names, change.property.name, optionRenames);
}

function validateOptionRenames(
  beforeSource: string,
  afterSource: string,
  change: Extract<PropertyChange, { readonly kind: 'save' }>,
  renames: readonly PropertyOptionRename[]
): Result<void> {
  if (renames.length === 0) {
    return ok(undefined);
  }
  const before = readComponentProperties(beforeSource).properties.find(
    (property) => property.name === change.originalName
  );
  const after = readComponentProperties(afterSource).properties.find(
    (property) => property.name === change.property.name
  );
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

function commitPropertyChanges(
  changes: readonly FileChange[],
  noteWrite: (file: string, source: string) => void
): Result<void> {
  assert(changes.length <= PROPERTY_LIMITS.filesMax, 'Property transaction is bounded');
  assert(
    new Set(changes.map((change) => change.file)).size === changes.length,
    'Property transaction writes each file once'
  );
  for (const change of changes) {
    const current = readBoundedSource(change.file);
    if (!current.ok) {
      return current;
    }
    if (current.value !== change.before) {
      return err({
        code: 'conflict',
        message: `${change.file} changed during the rename. Try again.`,
      });
    }
  }
  const written: FileChange[] = [];
  for (const change of changes) {
    noteWrite(change.file, change.after);
    const result = writePropertyFile(change.file, change.after);
    if (!result.ok) {
      return rollbackPropertyChanges(written, result.error.message, noteWrite);
    }
    written.push(change);
    const current = readBoundedSource(change.file);
    if (!current.ok) {
      return rollbackPropertyChanges(written, current.error.message, noteWrite);
    }
    assert(current.value === change.after, 'Property write readback matches planned source');
  }
  return ok(undefined);
}
function rollbackPropertyChanges(
  written: readonly FileChange[],
  reason: unknown,
  noteWrite: (file: string, source: string) => void
): Result<never> {
  const failed: string[] = [];
  for (const change of [...written].reverse()) {
    noteWrite(change.file, change.before);
    const result = writePropertyFile(change.file, change.before);
    if (!result.ok) {
      failed.push(change.file);
    }
  }
  if (failed.length) {
    return err({
      code: 'rollback',
      message: `Save failed and recovery failed for: ${failed.join(', ')}. ${String(reason)}`,
    });
  }
  return err({
    code: 'filesystem',
    message: `Save failed; changes restored. ${String(reason)}`,
  });
}

function planPropertyRemoval(
  request: PropertyEditRequest,
  change: FileChange,
  name: string
): Result<readonly FileChange[]> {
  const consumers = readPropertyConsumers(request);
  if (!consumers.ok) {
    return consumers;
  }
  for (const consumer of consumers.value) {
    const result = renameComponentReferences(
      consumer.source,
      consumer.names,
      { from: name, to: '_stackiDeletedProperty' },
      'consumer'
    );
    if (!result.ok) {
      return result;
    }
    if (result.value !== consumer.source) {
      return err({
        code: 'in-use',
        message:
          `${consumer.file} still passes ${name}. ` +
          'Remove that instance value before deleting the prop.',
      });
    }
  }
  return ok([change]);
}

function writePropertyFile(file: string, source: string): Result<void> {
  const temporary = path.join(path.dirname(file), `.stacki-properties-${randomUUID()}.tmp`);
  try {
    const mode = fs.statSync(file).mode;
    // Same-directory replacement is atomic: failed writes never truncate authored source.
    fs.writeFileSync(temporary, source, { encoding: 'utf8', flag: 'wx', mode });
    fs.renameSync(temporary, file);
  } catch (error: unknown) {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      return err({
        code: 'filesystem',
        message: `Could not save ${file} or remove temporary file ${temporary}: ${String(error)}`,
      });
    }
    return filesystemError(error);
  }
  return ok(undefined);
}
