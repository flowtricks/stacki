import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import type { PublishedStatusTree } from './publishStatusRemote';
import { publishInventory } from './publishInventory';
import { sourceRoots } from './publishSource';
import { readAssetState } from '../assets/assetState';
import { STUDIO_PUBLISH_LIMITS as limits } from './publishLimits';
import { published } from './publishFailure';

interface FileDigest {
  readonly stamp: string;
  readonly sha: string;
  readonly mode: string;
}

// Status streams file bytes without writing Git objects or allocating a second source snapshot.
// Retain only the current bounded inventory; unchanged assets do not need to be hashed again.
export class PublishStatusSource {
  private cache = new Map<string, FileDigest>();
  constructor(private readonly root: string) {}

  async differs(remote: PublishedStatusTree['files']): Promise<boolean> {
    const inventory = published(await publishInventory(this.root, await sourceRoots(this.root), limits.sourceBytesMax));
    const next = new Map<string, FileDigest>();
    const deadline = Date.now() + 30_000;
    let changed = false;
    for (const file of inventory.files) {
      if (Date.now() > deadline) {
        throw new Error('Publishing status inspection timed out.');
      }
      const digest = await fileDigest(path.join(this.root, file), this.cache.get(file));
      next.set(file, digest);
      const previous = remote.get(file);
      if (digest.sha !== previous?.sha || digest.mode !== previous.mode) {
        changed = true;
      }
    }
    this.cache = next;
    const assets = await readAssetState(this.root);
    return changed || assets.deleted.some((file) => !next.has(file) && remote.has(file));
  }
}

async function fileDigest(file: string, previous: FileDigest | undefined): Promise<FileDigest> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limits.fileBytesMax) {
      throw new Error('Publishing status requires bounded regular files.');
    }
    const stamp = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
    if (previous?.stamp === stamp) {
      return previous;
    }
    const hash = createHash('sha1').update(`blob ${info.size}\0`);
    await pipeline(handle.createReadStream({ autoClose: false }), hash, {
      signal: AbortSignal.timeout(10_000),
    });
    const after = await handle.stat();
    if (info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) {
      throw new Error('The draft changed during the status check. Retry shortly.');
    }
    return { stamp, sha: hash.digest('hex'), mode: info.mode & 0o111 ? '100755' : '100644' };
  } finally {
    await handle.close();
  }
}
