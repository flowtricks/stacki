// A collection's settings while they are being edited: each change is made to
// a copy in memory and kept in order, and nothing reaches the content config
// until Save — when the changes are sent one by one, as they were made
// (RemoteCollectionSettings.tsx). Cancel drops the copy. A change the config
// would refuse (a name that is taken, a field that is gone) is refused here
// first, so the list never holds one that would stop a save halfway.
import { assert } from '../../../shared/core/assert';
import {
  COLLECTION_SETTINGS_LIMITS,
  type CollectionSettings,
  type SettingsChange,
  type SettingsField,
} from '../../../shared/properties/collectionSettings';

export type DraftResult =
  | { readonly ok: true; readonly value: CollectionSettings }
  | { readonly ok: false; readonly message: string };

/** The settings with `change` made, or why it cannot be. */
export function applyDraft(settings: CollectionSettings, change: SettingsChange): DraftResult {
  const { fields } = settings;
  const has = (name: string) => fields.some((field) => field.name === name);
  switch (change.kind) {
    case 'renameCollection':
      return { ok: true, value: { ...settings, name: change.to } };
    case 'deleteCollection':
      return { ok: true, value: { ...settings, fields: [] } };
    case 'reorder': {
      const ordered = change.order.flatMap((name) => fields.filter((field) => field.name === name));
      if (ordered.length !== fields.length) {
        return { ok: false, message: 'The fields changed since they were listed.' };
      }
      return { ok: true, value: { ...settings, fields: ordered } };
    }
    case 'renameField':
      if (!has(change.from)) {
        return { ok: false, message: `There is no field ${change.from}.` };
      }
      if (has(change.to)) {
        return { ok: false, message: `A field named ${change.to} already exists.` };
      }
      return withFields(
        settings,
        fields.map((field) => (field.name === change.from ? { ...field, name: change.to } : field)),
      );
    case 'updateField': {
      const { update } = change;
      if (!has(update.name)) {
        return { ok: false, message: `There is no field ${update.name}.` };
      }
      return withFields(
        settings,
        fields.map((field) => (field.name === update.name ? { ...field, ...update } : field)),
      );
    }
    case 'addField':
      if (has(change.name)) {
        return { ok: false, message: `A field named ${change.name} already exists.` };
      }
      return withFields(settings, [...fields, newField(change)]);
    case 'removeField':
      return withFields(
        settings,
        fields.filter((field) => field.name !== change.name),
      );
    default: {
      const exhaustive: never = change;
      return exhaustive;
    }
  }
}

function withFields(settings: CollectionSettings, fields: readonly SettingsField[]): DraftResult {
  if (fields.length > COLLECTION_SETTINGS_LIMITS.fieldsMax) {
    return { ok: false, message: 'A collection holds at most 200 fields.' };
  }
  assert(
    new Set(fields.map((field) => field.name)).size === fields.length,
    'Field names stay unique',
  );
  return { ok: true, value: { ...settings, fields } };
}

// A field as the config will write it: optional, with no other settings yet.
function newField(change: Extract<SettingsChange, { readonly kind: 'addField' }>): SettingsField {
  return {
    name: change.name,
    kind: change.fieldKind,
    description: undefined,
    required: false,
    checks: {},
    options: change.fieldKind === 'option' ? ['Option 1', 'Option 2'] : undefined,
    defaultValue: undefined,
    editable: true,
    target: change.target,
  };
}
