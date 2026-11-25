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
  sanityTemplate,
  sanityWriteDraft,
  type SanityDataset,
} from './sanityContent';
import { sanityAct, sanityCreateDraft, sanityDelete, sanityMove } from './sanityEdits';
import { sanityRestore, sanityRevisions } from './sanityHistory';
import { sanityConstantLists, sanityDocumentSchema, sanityNamedTypes, sanityTypeIcons } from './sanitySchema';
import { inStructureOrder, sanityStructureOrder } from './sanityStructure';
import { sanityUploadBytes } from './sanityUpload';
import { cmsNetworkProblem } from './cmsNetworkFailure';
import { DescribedError } from '../../shared/properties/describedError';
import { described, type Described } from '../../shared/properties/i18n/messageRef';

export interface CmsRemoteService {
  readonly collections: () => Promise<RemoteCollection[]>;
  /** One collection's items, each with the `columns` fields' values to show beside it. */
  readonly documents: (collection: string, columns?: readonly string[]) => Promise<RemoteDocumentList>;
  readonly create: (collection: string) => Promise<RemoteDocumentSummary>;
  readonly remove: (ids: readonly string[]) => Promise<number>;
  readonly move: (move: RemoteMove) => Promise<RemoteDocumentList>;
  readonly document: (id: string) => Promise<RemoteDocument>;
  /** A collection's fields with no values, edited before a new item is created. */
  readonly template: (collection: string) => Promise<RemoteDocument>;
  readonly write: (write: RemoteWrite) => Promise<RemoteDocument>;
  readonly act: (id: string, action: RemoteDocumentAction) => Promise<RemoteDocument | undefined>;
  readonly history: (id: string) => Promise<RemoteRevision[]>;
  readonly restore: (id: string, revision: string) => Promise<RemoteDocument>;
  /** The documents a reference may point at; `query` narrows them by title where the CMS can search. */
  readonly references: (types: readonly string[], query?: string) => Promise<RemoteReferenceOption[]>;
  readonly upload: (kind: RemoteAssetKind, file: { readonly name: string; readonly bytes: Uint8Array }) => Promise<RemoteAsset>;
  /** The largest file `upload` accepts, when the CMS's limit differs from Sanity's. */
  readonly uploadBytesMax?: number;
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
  const documents = (collection: string, columns: readonly string[] = []) => sanityDocuments(target, collection, previewFor(collection), columns);
  const document = (id: string) => sanityDocument(target, id, schemaOf());
  return {
    // In the order the site's own Studio lists them, each with its schema's icon.
    collections: async () => {
      const collections = await sanityCollections(target);
      const names = collections.map((collection) => collection.name);
      const order = inStructureOrder(names, sanityStructureOrder(root, names));
      const icons = sanityTypeIcons(root);
      return order.flatMap((name) => collections.filter((entry) => entry.name === name).map((entry) => ({ ...entry, icon: icons.get(name) })));
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
    template: async (collection) => sanityTemplate(collection, schemaOf()),
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
    // Each choice with its picture, read by its type's own preview.
    references: (types) => {
      const named = sanityNamedTypes(root);
      return sanityReferenceOptions(target, types, (type) => sanityDocumentSchema(named, type)?.preview?.media);
    },
    upload: (kind, file) => sanityUploadBytes(target, kind, file.name, file.bytes),
  };
}

/**
 * No network and a timed-out request read as what they are, not as fetch's own
 * words ("fetch failed"): Stacki works offline, and only the CMS waits for it.
 * The reference travels beside the English text so the panel can say it in the language on screen.
 */
export function cmsFailureProblem(error: unknown): Described {
  if (error instanceof DescribedError) {
    return error.problem;
  }
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error instanceof TypeError) {
      return cmsNetworkProblem(error, undefined);
    }
    return error.message.length > 0 ? { message: error.message } : described('cmsBackend.network.failed');
  }
  const text = String(error);
  return text.length > 0 ? { message: text } : described('cmsBackend.network.failed');
}

/** The English sentence of `cmsFailureProblem`. */
export function cmsFailureMessage(error: unknown): string {
  return cmsFailureProblem(error).message;
}
