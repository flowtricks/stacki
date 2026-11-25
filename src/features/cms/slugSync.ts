// Keeping a document's slug in step with its name, as it is typed: which field
// is the slug, which field it follows, and the slug a name makes. The panel
// (RemoteFieldList.tsx) decides when to follow; this file only answers.
import { assert } from '../../../shared/core/assert';
import { remoteObject, type RemoteValue } from '../../../shared/properties/cmsRemoteSchema';
import type { RemoteDocumentField } from '../../../shared/properties/cmsRemote';
import { ENTRY_SLUG_LIMITS, slugify as entrySlugify } from '../../../shared/properties/entrySlug';

export const SLUG_SYNC_LIMITS = {
  /** Sanity's own slug default; a longer name is cut at a word where it can be. */
  slugCharsMax: ENTRY_SLUG_LIMITS.charsMax,
} as const;

/** The slug field and the text field it follows. */
export interface SlugPair {
  readonly source: string;
  readonly slug: string;
}

// The fields a slug is made from, in the order a CMS usually names its title.
const SOURCE_NAMES = ['title', 'name'] as const;

/** The document's slug and the title or name it follows, when it has both. */
export function slugPairOf(fields: readonly RemoteDocumentField[]): SlugPair | undefined {
  const slug = fields.find((field) => field.type.kind === 'slug');
  if (slug === undefined) {
    return undefined;
  }
  for (const name of SOURCE_NAMES) {
    const source = fields.find((field) => field.name === name && field.type.kind === 'string');
    if (source !== undefined) {
      assert(source.name !== slug.name, 'A slug never follows itself');
      return { source: source.name, slug: slug.name };
    }
  }
  return undefined;
}

/** "Mncedisi Hlatshwayo" → "mncedisi-hlatshwayo": one rule with an Astro entry's slug (entrySlug.ts). */
export const slugify: (text: string) => string = entrySlugify;

/** A slug field's text, from its stored `{ _type: "slug", current }`. */
export function slugText(value: RemoteValue | undefined): string {
  const current = remoteObject(value)?.['current'];
  return typeof current === 'string' ? current : '';
}

/** The stored slug for `text`; an empty slug is no value at all. */
export function slugValue(text: string): RemoteValue | undefined {
  return text === '' ? undefined : { _type: 'slug', current: text };
}

/**
 * Whether a document's slug starts in step with its name: it does when the
 * slug is empty or is what the name makes, so a slug someone wrote by hand is
 * never overwritten by opening the document.
 */
export function slugInStep(source: RemoteValue | undefined, slug: RemoteValue | undefined) {
  const current = slugText(slug);
  return current === '' || current === slugify(typeof source === 'string' ? source : '');
}
