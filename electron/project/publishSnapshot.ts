import { mkdtemp, symlink, realpath, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ok, type Result } from '../../shared/core/result';
import { checkPublishTreeSize, checkPublishWorkingSize, type PublishPurpose } from './publishSize';
import { PUBLISH_TEMPORARY_PREFIX, releasePublishTemporary } from './publishTemporary';
import { parsePublishObject, publishFilesystemFailure, readPublishHead, runPublishGit } from './publishGitCommand';

export interface PublishSource {
  readonly tree: string;
  readonly head: string | undefined;
  readonly index: string;
  readonly temporary: string;
}

export interface PublishSnapshot extends PublishSource {
  readonly root: string;
}

export async function readPublishTree(root: string): Promise<Result<string>> {
  const source = await createPublishSource(root, 'github');
  if (!source.ok) {
    return source;
  }
  // The tree is already read; a directory that will not go yet is swept later and must not fail the read.
  await releasePublishTemporary(source.value.temporary);
  return ok(source.value.tree);
}

export async function createPublishSource(root: string, purpose: PublishPurpose): Promise<Result<PublishSource>> {
  const temporary = await mkdtemp(path.join(tmpdir(), PUBLISH_TEMPORARY_PREFIX)).then(ok, publishFilesystemFailure);
  if (!temporary.ok) {
    return temporary;
  }
  // Ownership transfers only on success; failures, including assertions, still clean up the index.
  let retained = false;
  let result: Result<PublishSource>;
  try {
    result = await capturePublishSource(root, temporary.value, purpose);
    retained = result.ok;
  } finally {
    if (!retained) {
      // The capture's own failure is the answer; a stuck directory is logged and swept, never allowed to replace it.
      await releasePublishTemporary(temporary.value);
    }
  }
  return result;
}

export async function createPublishSnapshot(root: string): Promise<Result<PublishSnapshot>> {
  const source = await createPublishSource(root, 'hosting');
  if (!source.ok) {
    return source;
  }
  let retained = false;
  let result: Result<PublishSnapshot>;
  try {
    result = await materializePublishSource(root, source.value);
    retained = result.ok;
  } finally {
    if (!retained) {
      await releasePublishTemporary(source.value.temporary);
    }
  }
  return result;
}

export async function publishTree(root: string, index: string): Promise<Result<string>> {
  const options = { env: { ...process.env, GIT_INDEX_FILE: index }, timeout: 600_000 };
  // A private index captures tracked and unignored files without disturbing staged changes.
  const staged = await runPublishGit(root, ['add', '--all', '--', '.'], options);
  if (!staged.ok) {
    return staged;
  }
  const tree = await runPublishGit(root, ['write-tree'], options);
  return tree.ok ? parsePublishObject(tree.value.trim()) : tree;
}

async function capturePublishSource(root: string, temporary: string, purpose: PublishPurpose): Promise<Result<PublishSource>> {
  const index = path.join(temporary, 'index');
  const head = await readPublishHead(root);
  if (!head.ok) {
    return head;
  }
  const initialized = await runPublishGit(root, ['read-tree', head.value ?? '--empty'], {
    env: { ...process.env, GIT_INDEX_FILE: index },
  });
  if (!initialized.ok) {
    return initialized;
  }
  const working = await checkPublishWorkingSize(root, index, purpose);
  if (!working.ok) {
    return working;
  }
  const tree = await publishTree(root, index);
  if (!tree.ok) {
    return tree;
  }
  const captured = await checkPublishTreeSize(root, tree.value, purpose);
  return captured.ok ? ok({ tree: tree.value, head: head.value, index, temporary }) : captured;
}

async function materializePublishSource(root: string, source: PublishSource): Promise<Result<PublishSnapshot>> {
  const snapshot = path.join(source.temporary, 'site');
  const directory = await mkdir(snapshot).then(ok, publishFilesystemFailure);
  if (!directory.ok) {
    return directory;
  }
  const checkout = await runPublishGit(root, ['checkout-index', '--all', `--prefix=${snapshot}${path.sep}`], {
    env: { ...process.env, GIT_INDEX_FILE: source.index },
  });
  if (!checkout.ok) {
    return checkout;
  }
  const dependencies = await realpath(path.join(root, 'node_modules')).then(ok, publishFilesystemFailure);
  if (!dependencies.ok) {
    return dependencies;
  }
  const linked = await symlink(dependencies.value, path.join(snapshot, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir').then(
    ok,
    publishFilesystemFailure,
  );
  return linked.ok ? ok({ ...source, root: snapshot }) : linked;
}
