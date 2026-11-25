// A project's Astro content collections, shown in the CMS panel the way a
// connected CMS is: a collection list, a table of entries and an item editor
// (RemoteCmsBrowser.tsx, RemoteCmsView.tsx). They are presented as one more
// source beside the saved connections, under a fixed id no saved connection
// can have, so the panel's views and caches need no second path. Its calls go
// to the content handlers (contentHandlers.ts) rather than to a CMS: entries
// are the project's own files, read and written in place, with no key.
//
// What a file cannot do, the panel does not offer: there is no draft to
// publish or discard and no history but git's.

import { record, text } from '../core/boundary';
import { assert } from '../core/assert';
import type { CmsConnection } from './cmsConnections';
import { parseSettingsChange, type CollectionSettings, type SettingsChange } from './collectionSettings';
import { parseEntrySlugText } from './entrySlug';
import {
  parseRemoteCollectionName,
  type RemoteCollection,
  type RemoteDocument,
  type RemoteDocumentList,
  type RemoteDocumentSummary,
  parseRemoteDocumentId,
  parseRemoteColumns,
  parseRemoteIds,
  parseRemoteWrite,
  type RemoteWrite,
} from './cmsRemote';

/** The Astro source's id: a UUID, as every connection id is, that none is ever given. */
export const ASTRO_CONTENT_ID = '00000000-0000-4000-8000-00000a57c0de';

export const ASTRO_CONTENT_LIMITS = {
  collectionNameCharsMax: 64,
  collectionLabelCharsMax: 80,
} as const;

export interface AstroContentSource {
  readonly kind: 'astro';
  readonly id: typeof ASTRO_CONTENT_ID;
  readonly label: string;
}

export const ASTRO_CONTENT_SOURCE: AstroContentSource = {
  kind: 'astro',
  id: ASTRO_CONTENT_ID,
  // i18n-ignore: The English label for logs and tooltips; the panel shows sourceName(), translated.
  label: 'Content Collections',
};

/** Where the CMS panel's remote views read from: a saved connection, or the project's files. */
export type CmsSource = CmsConnection | AstroContentSource;

/** What the panel reads from the project's content collections. */
export type AstroRemoteRead =
  | { readonly operation: 'collections' }
  | {
      readonly operation: 'documents';
      readonly collection: string;
      readonly columns: readonly string[];
    }
  | { readonly operation: 'document'; readonly id: string }
  | { readonly operation: 'template'; readonly collection: string }
  | { readonly operation: 'settings'; readonly collection: string };

/** What a read answers: the collections, one collection's entries, or one entry. */
export type AstroRemoteReadAnswer = readonly RemoteCollection[] | RemoteDocumentList | RemoteDocument | CollectionSettings;

/** What an edit answers: the entry written, the entry made, how many went, the new collection. */
export type AstroRemoteEditAnswer = RemoteDocument | RemoteDocumentSummary | number | RemoteCollection | CollectionSettings;

/** What the panel changes in them: a field, a new or removed entry, a new collection. */
export type AstroRemoteEdit =
  | { readonly operation: 'write'; readonly write: RemoteWrite }
  /** A new slug for an entry's id: its file, or its key in a data file, and every reference to it. */
  | { readonly operation: 'rename'; readonly id: string; readonly slug: string }
  | { readonly operation: 'create'; readonly collection: string }
  | { readonly operation: 'delete'; readonly ids: readonly string[] }
  | { readonly operation: 'createCollection'; readonly name: string }
  | {
      readonly operation: 'settings';
      readonly collection: string;
      readonly change: SettingsChange;
    };

export function parseAstroRemoteRead(input: unknown): AstroRemoteRead {
  const value = record(input);
  switch (value['operation']) {
    case 'collections':
      return { operation: 'collections' };
    case 'documents': {
      const collection = parseRemoteCollectionName(value['collection']);
      assert(collection.length > 0, 'A read names its collection');
      const columns = value['columns'] === undefined ? [] : parseRemoteColumns(value['columns']);
      return { operation: 'documents', collection, columns };
    }
    case 'settings':
      return { operation: 'settings', collection: parseRemoteCollectionName(value['collection']) };
    case 'template':
      return { operation: 'template', collection: parseRemoteCollectionName(value['collection']) };
    case 'document': {
      const id = parseRemoteDocumentId(value['id']);
      // Every entry id holds its collection before a dot (astroRemoteService.ts);
      // one without is refused there, with a reason, rather than here.
      assert(id.length <= 128, 'An entry id fits the remote id bound');
      return { operation: 'document', id };
    }
    default:
      throw new Error('Unknown content collection read.');
  }
}

export function parseAstroRemoteEdit(input: unknown): AstroRemoteEdit {
  const value = record(input);
  switch (value['operation']) {
    case 'write': {
      const write = parseRemoteWrite(value['write']);
      assert(!write.field.startsWith('_'), 'A write names a content field, not a system key');
      return { operation: 'write', write };
    }
    case 'rename': {
      const slug = parseEntrySlugText(value['slug']);
      assert(slug.length > 0, 'A rename names its new slug');
      return { operation: 'rename', id: parseRemoteDocumentId(value['id']), slug };
    }
    case 'create':
      return { operation: 'create', collection: parseRemoteCollectionName(value['collection']) };
    case 'delete': {
      const ids = parseRemoteIds(value['ids']);
      assert(ids.length > 0, 'A delete names at least one entry');
      return { operation: 'delete', ids };
    }
    case 'settings':
      return {
        operation: 'settings',
        collection: parseRemoteCollectionName(value['collection']),
        change: parseSettingsChange(value['change']),
      };
    case 'createCollection':
      return { operation: 'createCollection', name: parseAstroCollectionName(value['name']) };
    default:
      throw new Error('Unknown content collection edit.');
  }
}

// Words a collection's `const` may not be named: JavaScript's reserved words,
// and the names the generated config itself declares or imports.
const RESERVED = new Set([
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'enum',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  'yield',
  'collections',
  'defineCollection',
  'glob',
  'file',
  'z',
  'reference',
]);

/**
 * A collection name as typed ("Blog posts") made into the identifier Astro
 * names it by (`blogPosts`): words joined in camel case, letters and digits
 * only, starting with a letter. A name that leaves nothing, starts with a
 * digit, or is a reserved word is refused rather than silently altered further.
 */
export function parseAstroCollectionName(input: unknown): string {
  const label = text(input).trim();
  if (label.length === 0) {
    throw new Error('Name the collection.');
  }
  if (label.length > ASTRO_CONTENT_LIMITS.collectionLabelCharsMax) {
    throw new Error('A collection name is at most 80 characters.');
  }
  const words = label.split(/[^A-Za-z0-9]+/).filter((word) => word.length > 0);
  const name = words.map((word, index) => (index === 0 ? word.charAt(0).toLowerCase() + word.slice(1) : word.charAt(0).toUpperCase() + word.slice(1))).join('');
  if (!/^[a-z][A-Za-z0-9]*$/.test(name)) {
    throw new Error('A collection name starts with a letter.');
  }
  if (name.length > ASTRO_CONTENT_LIMITS.collectionNameCharsMax) {
    throw new Error('A collection name is at most 64 letters.');
  }
  if (RESERVED.has(name)) {
    throw new Error(`“${name}” is reserved in a content config. Choose another name.`);
  }
  assert(/^[a-z]/.test(name), 'A collection identifier starts with a lowercase letter');
  assert(parseRemoteCollectionName(name) === name, 'A collection identifier is a valid name');
  return name;
}

/** Whether `source` is the project's own content collections rather than a saved connection. */
export function isAstroContent(source: CmsSource): source is AstroContentSource {
  if (source.kind === 'astro') {
    assert(source.id === ASTRO_CONTENT_ID, 'The content source has its fixed id');
    return true;
  }
  assert(source.id !== ASTRO_CONTENT_ID, 'No saved connection takes the content source’s id');
  return false;
}
