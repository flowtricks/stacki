// The Slug field's decisions, apart from its control (EntrySlugField.tsx):
// which slug a check would save, the slug a new item takes from its name until
// someone types one, and whether that slug keeps Create from running.
//
// A new item's slug follows the name its fields give it, by the same rule its
// list row is titled by (entryTitle.ts): "61.4%" makes "61-4". Typing in the
// Slug field stops that, as the sync button does for a Sanity slug. Left empty,
// the item is made under the panel's own free name (`untitled-2`).
import { assert } from '../../../shared/core/assert';
import type { RemoteDocument, RemoteDocumentField } from '../../../shared/properties/cmsRemote';
import { remoteObject, type RemoteValue } from '../../../shared/properties/cmsRemoteSchema';
import { checkEntrySlug, slugify, type EntrySlug, type SlugCheck } from '../../../shared/properties/entrySlug';
import { entryNameOf, type TitleFields } from '../../../shared/properties/entryTitle';

/** A new item's slug: made from its name, or typed by hand. */
export type SlugDraft = { readonly kind: 'follows' } | { readonly kind: 'typed'; readonly text: string };

export const FOLLOWS_NAME: SlugDraft = { kind: 'follows' };

/** The slug a check would save, or nothing: a blocked one, or the slug already stored. */
export function committable(check: SlugCheck, stored: string): string | undefined {
  if (check.kind !== 'ok') {
    return undefined;
  }
  assert(check.slug !== '', 'A slug that passed is never empty');
  return check.slug === stored ? undefined : check.slug;
}

/** The text a new item's Slug field shows: what was typed, or what its name makes. */
export function draftSlugText(document: Pick<RemoteDocument, 'fields'>, draft: SlugDraft): string {
  switch (draft.kind) {
    case 'typed':
      return draft.text;
    case 'follows':
      return slugify(draftName(document) ?? '');
    default: {
      const exhaustive: never = draft;
      return exhaustive;
    }
  }
}

/** The name a new item's fields give it by the list's title rule, or nothing. */
export function draftName(document: Pick<RemoteDocument, 'fields'>): string | undefined {
  return entryNameOf(valuesRecord(document.fields), titleFieldsOfDocument(document.fields));
}

/**
 * What the new item's slug stops, said once: nothing when it is empty (the
 * item is made under a free name) or passes its check; the check otherwise.
 */
export function draftSlugBlock(slug: EntrySlug | undefined, text: string): SlugCheck | undefined {
  if (slug === undefined) {
    return undefined;
  }
  if (slug.rename.kind === 'locked') {
    return undefined;
  }
  if (text === '') {
    return undefined;
  }
  const check = checkEntrySlug(text, { taken: slug.taken });
  return check.kind === 'ok' ? undefined : check;
}

/** The slug a new item is renamed to once made, or nothing: an empty or blocked one. */
export function draftSlugToSave(slug: EntrySlug | undefined, text: string): string | undefined {
  if (slug === undefined) {
    return undefined;
  }
  if (slug.rename.kind === 'locked') {
    return undefined;
  }
  const check = checkEntrySlug(text, { taken: slug.taken });
  return check.kind === 'ok' ? check.slug : undefined;
}

/** A copy's Slug field: empty, with its source's slug taken too, so the copy needs one of its own. */
export function copiedSlug(slug: EntrySlug): EntrySlug {
  const taken = slug.taken.includes(slug.value) ? slug.taken : [...slug.taken, slug.value];
  assert(taken.includes(slug.value), 'A copy cannot take its source’s slug');
  return { ...slug, value: '', taken };
}

// The fields in order, as the title rule reads them: an image's path and a
// choice's value (a reference's id among them) are not names.
function titleFieldsOfDocument(fields: readonly RemoteDocumentField[]): TitleFields {
  const order = fields.map((field) => field.name);
  const skipped = fields.filter(namesNothing).map((field) => field.name);
  assert(skipped.length <= order.length, 'Only listed fields are skipped');
  return { order, skipped };
}

function namesNothing(field: RemoteDocumentField): boolean {
  if (field.type.kind !== 'string') {
    return false;
  }
  if (field.type.asset === 'image') {
    return true;
  }
  return field.type.options.length > 0;
}

function valuesRecord(fields: readonly RemoteDocumentField[]): Readonly<Record<string, RemoteValue>> {
  const values: Record<string, RemoteValue> = {};
  for (const field of fields) {
    if (field.value !== undefined) {
      values[field.name] = field.value;
    }
  }
  assert(remoteObject(values) !== undefined, 'Values are a record');
  return values;
}
