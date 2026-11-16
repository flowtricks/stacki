// The files a variant rule edit writes besides the component (variantRuleEdits.ts):
// renaming an option renames it where instances pass it (`<Button variant="main">`),
// in the same batch, so one undo puts both back; removing an option or a prop
// that an instance still passes is refused, naming the file, as removing a prop
// is (propertyPlan.ts). Every other edit is the component's alone.
import path from 'node:path';
import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import { inFile, refusal } from '../../shared/properties/propertyErrors';
import type { VariantRuleEdit } from '../../shared/properties/variantRules';
import { sameFilesystemPath } from '../lib/platform';
import { readPropertyConsumers } from './propertyConsumers';
import { renameComponentOptionValues, renameComponentReferences } from './propertyRename';

interface VariantPlanRequest {
  readonly projectPath: string;
  readonly file: string;
}
interface VariantFileChange {
  readonly file: string;
  readonly before: string;
  readonly after: string;
}

// An option no instance can pass: what a removed option is renamed to, to see who passes it.
const REMOVED_OPTION = JSON.stringify('\u0000stacki-removed-option');
const REMOVED_PROPERTY = '_stackiDeletedProperty';

/** The batch `edit` writes: the component's own change first, then the instances it renames. */
export function planVariantRuleChanges(request: VariantPlanRequest, component: VariantFileChange, edit: VariantRuleEdit): Result<readonly VariantFileChange[]> {
  assert(sameFilesystemPath(component.file, request.file), 'planVariantRuleChanges: the batch starts with the component');
  switch (edit.kind) {
    case 'renameOption':
      return planInstanceRenames(request, component, edit.controller, edit.from, edit.to);
    case 'removeOption':
      return passedOption(request, component, edit.controller, edit.value);
    case 'removeProp':
      return passedProp(request, component, edit.prop);
    case 'setRule':
    case 'addOption':
    case 'moveOption':
    case 'setFallback':
    case 'addProp':
    case 'attachProp':
      return ok([component]);
    default: {
      const exhaustive: never = edit;
      return exhaustive;
    }
  }
}

function planInstanceRenames(
  request: VariantPlanRequest,
  component: VariantFileChange,
  controller: string,
  from: string,
  to: string,
): Result<readonly VariantFileChange[]> {
  const consumers = readPropertyConsumers(request);
  if (!consumers.ok) {
    return consumers;
  }
  const changes: VariantFileChange[] = [];
  const renames = [{ from: JSON.stringify(from), to: JSON.stringify(to) }];
  for (const consumer of consumers.value) {
    const own = sameFilesystemPath(consumer.file, request.file);
    // The component's own file may place itself; its instances are renamed in the edited text.
    const original = own ? component.after : consumer.source;
    const renamed = renameComponentOptionValues(original, consumer.names, controller, renames);
    if (!renamed.ok) {
      return err(inFile(path.relative(request.projectPath, consumer.file), renamed.error));
    }
    if (own) {
      changes.unshift({ ...component, after: renamed.value });
    } else if (renamed.value !== original) {
      changes.push({ file: consumer.file, before: original, after: renamed.value });
    }
  }
  assert(changes.length >= 1, 'planInstanceRenames: the batch holds the component');
  assert(sameFilesystemPath(changes[0]?.file ?? '', request.file), 'planInstanceRenames: the component comes first');
  return ok(changes);
}

// A removed option an instance still passes: the first file that does.
function passedOption(request: VariantPlanRequest, component: VariantFileChange, controller: string, value: string): Result<readonly VariantFileChange[]> {
  const consumers = readPropertyConsumers(request);
  if (!consumers.ok) {
    return consumers;
  }
  for (const consumer of consumers.value) {
    const source = sameFilesystemPath(consumer.file, request.file) ? component.after : consumer.source;
    const probed = renameComponentOptionValues(source, consumer.names, controller, [{ from: JSON.stringify(value), to: REMOVED_OPTION }]);
    if (!probed.ok) {
      return err(inFile(path.relative(request.projectPath, consumer.file), probed.error));
    }
    if (probed.value !== source) {
      const file = path.relative(request.projectPath, consumer.file);
      return err(refusal('in-use', 'componentProps.variants.optionPassed', { file, value, name: controller }));
    }
  }
  return ok([component]);
}

// A removed prop an instance still passes: refused as removing a prop is.
function passedProp(request: VariantPlanRequest, component: VariantFileChange, prop: string): Result<readonly VariantFileChange[]> {
  const consumers = readPropertyConsumers(request);
  if (!consumers.ok) {
    return consumers;
  }
  for (const consumer of consumers.value) {
    if (!sameFilesystemPath(consumer.file, request.file)) {
      const probed = renameComponentReferences(consumer.source, consumer.names, { from: prop, to: REMOVED_PROPERTY }, 'consumer');
      if (!probed.ok) {
        return err(inFile(path.relative(request.projectPath, consumer.file), probed.error));
      }
      if (probed.value !== consumer.source) {
        return err(refusal('in-use', 'props.edit.stillPasses', { file: path.relative(request.projectPath, consumer.file), name: prop }));
      }
    }
  }
  return ok([component]);
}
