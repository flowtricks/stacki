// A collection's settings while they are being edited: each change is made to
// a copy in memory and kept in order, and nothing reaches the content config
// until Save — when the changes are sent one by one, as they were made
// (RemoteCollectionSettings.tsx). Cancel drops the copy. A change the config
// would refuse (a name that is not a key or is taken, a field that is gone) is
// refused here first, so the list never holds one that would stop a save
// halfway. A field's form works out here what it would change, so the form can
// say what is wrong beside the field and Save can take a form still open.
import { assert } from '../../../shared/core/assert';
import { described, type Described } from '../../../shared/properties/i18n/messageRef';
import {
  COLLECTION_SETTINGS_LIMITS,
  fieldNameProblem,
  pointsAtCollection,
  typedFieldName,
  type CollectionSettings,
  type FieldSettings,
  type NewFieldKind,
  type SettingsChange,
  type SettingsField,
} from '../../../shared/properties/collectionSettings';

export type DraftResult = { readonly ok: true; readonly value: CollectionSettings } | ({ readonly ok: false } & Described);

/**
 * What an open field form would save as it stands. `blank` is a new field with
 * no name yet, which is simply not saved; `invalid` stays on screen with its
 * message; `ready` holds the changes, none when an open field is unchanged.
 */
export type FieldFormState =
  { readonly kind: 'blank' } | ({ readonly kind: 'invalid' } & Described) | { readonly kind: 'ready'; readonly changes: readonly SettingsChange[] };

/** The form of a field being added, with `draft.name` as typed. */
export function newFieldFormState(
  settings: CollectionSettings,
  form: { readonly draft: SettingsField; readonly kind: NewFieldKind; readonly target: string },
): FieldFormState {
  const typed = typedFieldName(form.draft.name);
  const pointing = pointsAtCollection(form.kind);
  switch (typed.kind) {
    case 'blank':
      return typed;
    case 'invalid':
      return typed;
    case 'key':
      if (settings.fields.some((field) => field.name === typed.key)) {
        return { kind: 'invalid', ...described('cms.draft.fieldExists', { name: typed.key }) };
      }
      if (pointing && form.target === '') {
        return { kind: 'invalid', ...described('cms.draft.chooseTarget') };
      }
      return {
        kind: 'ready',
        changes: [
          { kind: 'addField', name: typed.key, fieldKind: form.kind, target: pointing ? form.target : undefined, settings: fieldSettingsOf(form.draft) },
        ],
      };
    default: {
      const exhaustive: never = typed;
      return exhaustive;
    }
  }
}

/** The form of an existing field: renamed first, so its settings follow it to the new key. */
export function openFieldFormState(settings: CollectionSettings, field: SettingsField, draft: SettingsField): FieldFormState {
  assert(field.kind === draft.kind, 'A field keeps its kind while it is edited');
  const typed = typedFieldName(draft.name);
  switch (typed.kind) {
    case 'blank':
      // An existing field cannot go without a name, so here blank is a mistake.
      return { kind: 'invalid', ...described('cms.draft.nameField') };
    case 'invalid':
      return typed;
    case 'key': {
      const name = typed.key;
      if (name !== field.name && settings.fields.some((each) => each.name === name)) {
        return { kind: 'invalid', ...described('cms.draft.fieldExists', { name }) };
      }
      const renames: readonly SettingsChange[] = name === field.name ? [] : [{ kind: 'renameField', from: field.name, to: name }];
      const update = fieldSettingsOf(draft);
      const updated = field.editable && JSON.stringify(update) !== JSON.stringify(fieldSettingsOf(field));
      return { kind: 'ready', changes: updated ? [...renames, { kind: 'updateField', update: { name, ...update } }] : renames };
    }
    default: {
      const exhaustive: never = typed;
      return exhaustive;
    }
  }
}

/** What the form saves beside a field's name: blank help text is no help text. */
export function fieldSettingsOf(field: SettingsField): FieldSettings {
  return {
    description: field.description?.trim() || undefined,
    required: field.required,
    checks: field.checks,
    options: field.options,
    defaultValue: field.defaultValue,
  };
}

/** The settings with every change made in turn, or why one cannot be, and then none are. */
export function applyDrafts(settings: CollectionSettings, changes: readonly SettingsChange[]): DraftResult {
  let value = settings;
  for (const change of changes) {
    const next = applyDraft(value, change);
    if (!next.ok) {
      return next;
    }
    value = next.value;
  }
  return { ok: true, value };
}

/**
 * Changes that did not reach the config, made again on the config as it now
 * stands, so a refused Save keeps them on screen to try again. One the config
 * has since made impossible cannot be shown, and is left out.
 */
export function replayDrafts(
  settings: CollectionSettings,
  changes: readonly SettingsChange[],
): { readonly value: CollectionSettings; readonly changes: readonly SettingsChange[] } {
  let value = settings;
  const kept: SettingsChange[] = [];
  for (const change of changes) {
    const next = applyDraft(value, change);
    if (next.ok) {
      value = next.value;
      kept.push(change);
    }
  }
  assert(kept.length <= changes.length, 'A replay adds no changes');
  return { value, changes: kept };
}

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
        return { ok: false, ...described('cms.draft.fieldsChanged') };
      }
      return { ok: true, value: { ...settings, fields: ordered } };
    }
    case 'renameField': {
      const refusal = fieldNameProblem(change.to);
      if (refusal !== undefined) {
        return { ok: false, ...refusal };
      }
      if (!has(change.from)) {
        return { ok: false, ...described('cms.draft.noField', { name: change.from }) };
      }
      if (has(change.to)) {
        return { ok: false, ...described('cms.draft.fieldExists', { name: change.to }) };
      }
      return withFields(
        settings,
        fields.map((field) => (field.name === change.from ? { ...field, name: change.to } : field)),
      );
    }
    case 'updateField': {
      const { update } = change;
      if (!has(update.name)) {
        return { ok: false, ...described('cms.draft.noField', { name: update.name }) };
      }
      return withFields(
        settings,
        fields.map((field) => (field.name === update.name ? { ...field, ...update } : field)),
      );
    }
    case 'addField': {
      const refusal = fieldNameProblem(change.name);
      if (refusal !== undefined) {
        return { ok: false, ...refusal };
      }
      if (has(change.name)) {
        return { ok: false, ...described('cms.draft.fieldExists', { name: change.name }) };
      }
      return withFields(settings, [...fields, newField(change)]);
    }
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
    return { ok: false, ...described('cms.draft.fieldsMax', { count: COLLECTION_SETTINGS_LIMITS.fieldsMax }) };
  }
  assert(new Set(fields.map((field) => field.name)).size === fields.length, 'Field names stay unique');
  return { ok: true, value: { ...settings, fields } };
}

// A field as the config will write it: with the settings it was added with.
function newField(change: Extract<SettingsChange, { readonly kind: 'addField' }>): SettingsField {
  return {
    name: change.name,
    kind: change.fieldKind,
    ...change.settings,
    editable: true,
    target: change.target,
  };
}
