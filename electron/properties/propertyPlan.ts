// Stacki's source-preserving planner. Studio owns validation, commits and undo.
import { readPropertyConsumers } from './propertyConsumers';
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import type { PropertyChange, PropertyOptionRename } from '../../shared/properties/propertyEditing';
import { inFile, refusal } from '../../shared/properties/propertyErrors';
import { err, ok, type Result } from '../../shared/core/result';
import { literalOptions } from '../../shared/properties/propertyOptions';
import { sameFilesystemPath } from '../lib/platform';
import { readComponentProperties } from './propertyDefinitions';
import { renameComponentOptionValues, renameComponentReferences } from './propertyRename';
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

export function planPropertyChanges(request: PropertyEditRequest, source: string): Result<readonly FileChange[]> {
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
    return err(refusal('option', 'props.edit.optionNeedsExisting'));
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
      return err(inFile(path.relative(request.projectPath, file), changed.error));
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
    return err(refusal('option', 'props.edit.optionNeedsUnion'));
  }
  for (const rename of renames) {
    if (!beforeOptions.includes(rename.from) || !afterOptions.includes(rename.to)) {
      return err(refusal('option', 'props.edit.optionMismatch'));
    }
  }
  return ok(undefined);
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
      return err(refusal('in-use', 'props.edit.stillPasses', { file: consumer.file, name }));
    }
  }
  return ok([change]);
}
