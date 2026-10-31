// What the CMS panel can do with one connected Sanity dataset, for a project at
// `root`: the same answers whichever host asks. Desktop calls it from its IPC
// handlers (cmsConnectionHandlers.ts) with a key it decrypted itself; Stacki
// Studio calls it from its server with the key its Worker decrypted for the
// request. Each read of the site's schema code is fresh, so a schema edit shows
// without a restart.

import { assert } from '../../shared/core/assert';
import type {
  RemoteAsset,
  RemoteAssetKind,
  RemoteCollection,
  RemoteDocument,
  RemoteDocumentAction,
  RemoteDocumentList,
  RemoteDocumentSummary,
  RemoteMove,
  RemoteReferenceOption,
  RemoteRevision,
  RemoteWrite,
} from '../../shared/properties/cmsRemote';
import {
  sanityCollections,
  sanityDocument,
  sanityDocuments,
  sanityReferenceOptions,
  sanityWriteDraft,
  type SanityDataset,
} from './sanityContent';
import { sanityAct, sanityCreateDraft, sanityDelete, sanityMove } from './sanityEdits';
import { sanityRestore, sanityRevisions } from './sanityHistory';
import {
  sanityConstantLists,
  sanityDocumentSchema,
  sanityNamedTypes,
  sanityTypeIcons,
} from './sanitySchema';
import { inStructureOrder, sanityStructureOrder } from './sanityStructure';
import { sanityUploadBytes } from './sanityUpload';

export interface CmsRemoteService {
  readonly collections: () => Promise<RemoteCollection[]>;
  readonly documents: (collection: string) => Promise<RemoteDocumentList>;
  readonly create: (collection: string) => Promise<RemoteDocumentSummary>;
  readonly remove: (ids: readonly string[]) => Promise<number>;
  readonly move: (move: RemoteMove) => Promise<RemoteDocumentList>;
  readonly document: (id: string) => Promise<RemoteDocument>;
  readonly write: (write: RemoteWrite) => Promise<RemoteDocument>;
  readonly act: (id: string, action: RemoteDocumentAction) => Promise<RemoteDocument | undefined>;
  readonly history: (id: string) => Promise<RemoteRevision[]>;
  readonly restore: (id: string, revision: string) => Promise<RemoteDocument>;
  readonly references: (types: readonly string[]) => Promise<RemoteReferenceOption[]>;
  readonly upload: (
    kind: RemoteAssetKind,
    file: { readonly name: string; readonly bytes: Uint8Array },
  ) => Promise<RemoteAsset>;
}

export function cmsRemoteService(root: string, target: SanityDataset): CmsRemoteService {
  assert(root.length > 0, 'A CMS service belongs to a project');
  assert(target.token.length > 0, 'A CMS service holds a key');
  const schemaOf = () => {
    const named = sanityNamedTypes(root);
    const lists = sanityConstantLists(root);
    return (type: string) => sanityDocumentSchema(named, type, lists);
  };
  const previewFor = (type: string) => sanityDocumentSchema(sanityNamedTypes(root), type)?.preview;
  const documents = (collection: string) =>
    sanityDocuments(target, collection, previewFor(collection));
  const document = (id: string) => sanityDocument(target, id, schemaOf());
  return {
    // In the order the site's own Studio lists them, each with its schema's icon.
    collections: async () => {
      const collections = await sanityCollections(target);
      const names = collections.map((collection) => collection.name);
      const order = inStructureOrder(names, sanityStructureOrder(root, names));
      const icons = sanityTypeIcons(root);
      return order.flatMap((name) =>
        collections
          .filter((entry) => entry.name === name)
          .map((entry) => ({ ...entry, icon: icons.get(name) })),
      );
    },
    documents,
    create: async (collection) => {
      const list = await sanityDocuments(target, collection);
      return sanityCreateDraft(target, collection, { orderable: list.orderable });
    },
    remove: (ids) => sanityDelete(target, ids),
    move: async (move) => {
      await sanityMove(target, move);
      return documents(move.collection);
    },
    document,
    write: async (write) => {
      await sanityWriteDraft(target, write);
      return document(write.id);
    },
    // The document as it then stands, or none when discarding a never-published draft removed it.
    act: async (id, action) => {
      await sanityAct(target, id, action);
      return document(id).catch(() => undefined);
    },
    history: (id) => sanityRevisions(target, id),
    restore: async (id, revision) => {
      await sanityRestore(target, id, revision);
      return document(id);
    },
    references: (types) => sanityReferenceOptions(target, types),
    upload: (kind, file) => sanityUploadBytes(target, kind, file.name, file.bytes),
  };
}

/**
 * No network and a timed-out request read as what they are, not as fetch's own
 * words ("fetch failed"): Stacki works offline, and only the CMS waits for it.
 */
export function cmsFailureMessage(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError') {
      return 'The CMS took too long to answer. Check your connection and try again.';
    }
    if (error instanceof TypeError && error.message === 'fetch failed') {
      return 'Can’t reach the CMS. Check your internet connection and try again.';
    }
    return error.message || 'The CMS request failed.';
  }
  return String(error) || 'The CMS request failed.';
}
