// A Sanity document's revision history, and restoring an earlier version, as
// the Studio's History panel does.
//
//   Revisions  the transactions that touched the document or its draft, newest
//              first, from Sanity's history API, each with when and by whom
//              (names from the project's member list; an unknown author is
//              "Someone" rather than a failure).
//   Restore    the document as it stood after a transaction — its draft then,
//              else its published version — becomes the draft, with Sanity's
//              replace-draft action. Nothing is published.

import { assert } from '../../shared/core/assert';
import { CMS_REMOTE_LIMITS, type RemoteRevision } from '../../shared/properties/cmsRemote';
import { SANITY_API_VERSION, sanityGet, sanityRequest, type SanityDataset } from './sanityContent';

const MANAGE_VERSION = 'v2021-06-07';

export async function sanityRevisions(
  target: SanityDataset,
  id: string,
): Promise<RemoteRevision[]> {
  const ids = [id, `drafts.${id}`].map(encodeURIComponent).join(',');
  const text = await sanityGet(
    target,
    `${dataAddress(target)}/history/${target.dataset}/transactions/${ids}` +
      `?excludeContent=true&reverse=true&limit=${CMS_REMOTE_LIMITS.revisionsMax}`,
  );
  const rows = text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(0, CMS_REMOTE_LIMITS.revisionsMax)
    .map((line): unknown => JSON.parse(line));
  const transactions = rows.flatMap((row) => {
    const id = stringAt(row, 'id');
    const timestamp = stringAt(row, 'timestamp');
    const author = stringAt(row, 'author') ?? '';
    return id === undefined || timestamp === undefined ? [] : [{ id, timestamp, author }];
  });
  const names = await authorNames(target, [...new Set(transactions.map((entry) => entry.author))]);
  assert(transactions.length <= CMS_REMOTE_LIMITS.revisionsMax, 'History stays within its bound');
  return transactions.map((entry) => ({
    id: entry.id,
    timestamp: entry.timestamp,
    author: names.get(entry.author) ?? 'Someone',
  }));
}

export async function sanityRestore(
  target: SanityDataset,
  id: string,
  revision: string,
): Promise<void> {
  const ids = [`drafts.${id}`, id].map(encodeURIComponent).join(',');
  const text = await sanityGet(
    target,
    `${dataAddress(target)}/history/${target.dataset}/documents/${ids}` +
      `?revision=${encodeURIComponent(revision)}`,
  );
  const body: unknown = JSON.parse(text);
  const documents: unknown = isObject(body) ? Reflect.get(body, 'documents') : undefined;
  const list: readonly unknown[] = Array.isArray(documents) ? documents : [];
  const draft = list.find((entry) => idOf(entry) === `drafts.${id}`);
  const shown = draft ?? list.find((entry) => idOf(entry) === id);
  if (!isObject(shown)) {
    throw new Error('That version can no longer be read.');
  }
  // The content as it was; Sanity sets the system fields of the new draft itself.
  const attributes = Object.fromEntries(
    Object.entries(shown).filter(([key]) => !['_rev', '_createdAt', '_updatedAt'].includes(key)),
  );
  assert(typeof Reflect.get(attributes, '_type') === 'string', 'A restored version has a type');
  await sanityRequest(target, `actions/${target.dataset}`, {
    actions: [
      {
        actionType: 'sanity.action.document.replaceDraft',
        publishedId: id,
        attributes: { ...attributes, _id: `drafts.${id}` },
      },
    ],
  });
}

// Display names for user ids, from the project's members; any it cannot read are left out.
async function authorNames(
  target: SanityDataset,
  ids: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  const named = ids.filter((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id)).slice(0, 50);
  if (named.length === 0) {
    return new Map();
  }
  try {
    const project = `https://api.sanity.io/${MANAGE_VERSION}/projects/${target.projectId}`;
    const text = await sanityGet(target, `${project}/users/${named.join(',')}`);
    const body: unknown = JSON.parse(text);
    const users: readonly unknown[] = Array.isArray(body) ? body : [body];
    return new Map(
      users.flatMap((user) => {
        const id = stringAt(user, 'id');
        const name = stringAt(user, 'displayName');
        return id === undefined || name === undefined ? [] : [[id, name] as const];
      }),
    );
  } catch {
    return new Map();
  }
}

function dataAddress(target: SanityDataset): string {
  return `https://${target.projectId}.api.sanity.io/${SANITY_API_VERSION}/data`;
}

function stringAt(value: unknown, key: string): string | undefined {
  const found: unknown = isObject(value) ? Reflect.get(value, key) : undefined;
  return typeof found === 'string' ? found.slice(0, 200) : undefined;
}

function idOf(value: unknown): string | undefined {
  const id: unknown = isObject(value) ? Reflect.get(value, '_id') : undefined;
  return typeof id === 'string' ? id : undefined;
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
