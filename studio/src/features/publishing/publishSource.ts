import assert from 'node:assert/strict';
import { mkdir, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { ok, err, type Result } from '../../../vendor/stacki/shared/core/result';
import { readPublishRecords } from '../../../vendor/stacki/electron/project/publishRecords';
import { metadataFiles } from '../settings/projectMetadata';
import { readAssetState } from '../assets/assetState';
import { filePath } from '../../shared/validation';
import { STUDIO_PUBLISH_LIMITS as limits } from './publishLimits';
import { publishInventory, publishDisk } from './publishInventory';
import { publishGit, publishGitEnvironment, publishObject, type PublishGit } from './publishGit';
import { publishFailure } from './publishFailure';

import type { PublishedFile, PublishSource } from '../../shared/publishSource';
export type { PublishedFile, PublishSource } from '../../shared/publishSource';

/** Capture immutable Git objects while the collaboration coordinator holds edits. */
export async function capturePublishSource(root: string, temporary: string, options: { readonly assetRoot?: string } = {}): Promise<Result<PublishSource>> {
  const starts = await sourceRoots(root).then(ok, publishFailure);
  if (!starts.ok) {
    return starts;
  }
  const inventory = await publishInventory(root, starts.value, limits.sourceBytesMax);
  if (!inventory.ok) {
    return inventory;
  }
  const prepared = await mkdir(temporary, { recursive: true, mode: 0o700 }).then(ok, publishFailure);
  if (!prepared.ok) {
    return prepared;
  }
  const disk = await publishDisk(temporary, inventory.value.bytes);
  if (!disk.ok) {
    return disk;
  }
  const git = { root, directory: path.join(temporary, 'objects.git') };
  const initialized = await publishGit(git, ['init', '--bare', git.directory]);
  if (!initialized.ok) {
    return initialized;
  }
  const identifier = await capturePublishTree(git, inventory.value.files, temporary);
  if (!identifier.ok) {
    return identifier;
  }
  const files = await publishTreeFiles(git, identifier.value);
  if (!files.ok) {
    return files;
  }
  const assets = await readAssetState(options.assetRoot ?? root).then(ok, publishFailure);
  if (!assets.ok) {
    return assets;
  }
  const present = new Set(files.value.map((file) => file.path));
  return ok({
    git,
    tree: identifier.value,
    files: files.value,
    deleted: assets.value.deleted.filter((file) => !present.has(file)),
  });
}

export async function publishTreeFiles(
  git: PublishGit,
  tree: string,
  options: { readonly symbolicLinks?: 'skip' | 'reject' } = {},
): Promise<Result<readonly PublishedFile[]>> {
  assert(/^[a-f0-9]{40}$/.test(tree), 'Captured tree has a valid identifier');
  const files: PublishedFile[] = [];
  let bytes = 0;
  const read = await readPublishRecords(git.root, ['ls-tree', '-r', '-l', '-z', tree], publishGitEnvironment(git), async (record) => {
    // Startup omits links from its checkout; captures still reject links by default.
    // The record reader bounds every entry, including links omitted from the manifest.
    if (options.symbolicLinks === 'skip') {
      if (record.startsWith('120000 blob ')) {
        return ok(undefined);
      }
    }
    const parsed = parsePublishTreeFile(record);
    if (!parsed.ok) {
      return parsed;
    }
    bytes += parsed.value.size;
    if (bytes > limits.sourceBytesMax) {
      return err({ code: 'size', message: 'Captured source exceeds 8 GiB.' });
    }
    files.push(parsed.value);
    return ok(undefined);
  });
  assert(files.length <= limits.filesMax, 'Captured file count remains bounded');
  return read.ok ? ok(files) : read;
}

export function parsePublishTreeFile(value: string): Result<PublishedFile> {
  const match = /^(100644|100755) blob ([a-f0-9]{40}) +([0-9]+)\t(.+)$/.exec(value);
  if (!match) {
    return err({ code: 'tree', message: 'Publish requires regular files, not links.' });
  }
  const [, mode, sha, rawSize, file] = match;
  const size = Number(rawSize);
  if (
    (mode !== '100644' && mode !== '100755') ||
    sha === undefined ||
    file === undefined ||
    !Number.isSafeInteger(size) ||
    size > limits.fileBytesMax ||
    file.length > 500 ||
    file.split('/').some((part) => ['', '..', '.', '.git'].includes(part.toLowerCase())) ||
    file.split('/').length > limits.depthMax ||
    /^[a-z]:/i.test(file) ||
    file.startsWith('/') ||
    /[\x00-\x1f\\]/.test(file)
  ) {
    return err({ code: 'tree', message: 'Invalid publish file or file exceeds 100 MiB.' });
  }
  return ok({ path: file, sha, mode, size });
}

export async function sourceRoots(root: string): Promise<readonly string[]> {
  const starts: string[] = [];
  for (const directory of ['src', 'public']) {
    const info = await lstat(path.join(root, directory)).catch((error: unknown) => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return undefined;
      }
      throw error;
    });
    if (info) {
      starts.push(directory);
    }
  }
  for (const file of await metadataFiles(root)) {
    starts.push(filePath(file));
  }
  return starts;
}

async function capturePublishTree(git: PublishGit, files: readonly string[], temporary: string): Promise<Result<string>> {
  const list = path.join(temporary, 'paths');
  const written = await writeFile(list, files.join('\0') + (files.length ? '\0' : '')).then(ok, publishFailure);
  if (!written.ok) {
    return written;
  }
  if (files.length > 0) {
    const added = await publishGit(git, ['--literal-pathspecs', 'add', '--force', '--pathspec-from-file=' + list, '--pathspec-file-nul']);
    if (!added.ok) {
      return added;
    }
  } else {
    const empty = await publishGit(git, ['read-tree', '--empty']);
    if (!empty.ok) {
      return empty;
    }
  }
  const tree = await publishGit(git, ['write-tree']);
  if (!tree.ok) {
    return tree;
  }
  return publishObject(tree.value);
}
