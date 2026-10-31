import { pruneLocalGitBundles } from './gitWorkspacePrune';
import { mkdir, open, readFile, rename, writeFile, stat, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  gitWorkspaceBranch,
  gitWorkspaceLimits,
  parseGitWorkspaceManifest,
  type GitWorkspaceManifest,
} from './gitWorkspaceContract';

// Local commits have no GitHub copy. A successful action must acknowledge its
// immutable bundle and atomic manifest in durable storage before reporting success.
export async function readGitWorkspace(root: string): Promise<GitWorkspaceManifest | undefined> {
  const handle = await open(manifestPath(root), 'r').catch((error: unknown) => {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return undefined;
    }
    throw error;
  });
  if (!handle) {
    return undefined;
  }
  try {
    if ((await handle.stat()).size > gitWorkspaceLimits.manifestBytes) {
      throw new Error('Git workspace metadata exceeds its limit.');
    }
    const input: unknown = JSON.parse(await handle.readFile('utf8'));
    return parseGitWorkspaceManifest(input);
  } finally {
    await handle.close();
  }
}
export async function writeLocalGitWorkspace(root: string, manifest: GitWorkspaceManifest) {
  const body = JSON.stringify(parseGitWorkspaceManifest(manifest));
  await mkdir(path.dirname(manifestPath(root)), { recursive: true });
  await writeFile(manifestPath(root) + '.tmp', body, { mode: 0o600 });
  await rename(manifestPath(root) + '.tmp', manifestPath(root));
}
export async function gitDraftHeaders(root: string): Promise<Readonly<Record<string, string>>> {
  const manifest = await readGitWorkspace(root);
  return {
    'x-studio-token': process.env['STUDIO_CONTAINER_TOKEN'] ?? '',
    'x-studio-draft': manifest ? gitWorkspaceBranch(manifest).workspace : 'legacy',
  };
}
export async function saveGitWorkspace(
  root: string,
  manifest: GitWorkspaceManifest,
  previous: GitWorkspaceManifest | undefined,
  bundle: string | undefined,
): Promise<void> {
  parseGitWorkspaceManifest(manifest);
  await pruneLocalGitBundles(root, manifest, previous);
  const backend = process.env['STUDIO_BACKEND_URL'];
  if (backend) {
    const headers = { 'x-studio-token': process.env['STUDIO_CONTAINER_TOKEN'] ?? '' };
    if (bundle !== undefined) {
      if ((await stat(bundle)).size > gitWorkspaceLimits.bundleBytes) {
        throw new Error('Unpublished Git work exceeds the 96 MiB checkpoint limit. Push first.');
      }
      const bytes = await readFile(bundle);
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== manifest.bundle) {
        throw new Error('Git checkpoint digest changed before persistence.');
      }
      await requireStored(
        await fetch(`${backend}/studio/internal/git-bundle?digest=${digest}`, {
          method: 'PUT',
          headers,
          body: bytes,
          signal: AbortSignal.timeout(120_000),
        }),
      );
    }
    await requireStored(
      await fetch(backend + '/studio/internal/git-workspace', {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ manifest, previous: previous?.revision }),
        signal: AbortSignal.timeout(30_000),
      }),
    );
  }
  if (bundle && manifest.bundle) {
    await copyFile(bundle, path.join(root, '.stacki/studio/state/' + manifest.bundle + '.bundle'));
  }
  await writeLocalGitWorkspace(root, manifest);
}
export async function downloadGitBundle(digest: string, destination: string): Promise<void> {
  const backend = process.env['STUDIO_BACKEND_URL'];
  if (!backend) {
    throw new Error('Git checkpoint recovery needs its storage backend.');
  }
  const response = await fetch(`${backend}/studio/internal/git-bundle?digest=${digest}`, {
    headers: { 'x-studio-token': process.env['STUDIO_CONTAINER_TOKEN'] ?? '' },
    signal: AbortSignal.timeout(120_000),
  });
  await requireStored(response);
  const bytes = await boundedGitBytes(response);
  if (
    bytes.length > gitWorkspaceLimits.bundleBytes ||
    createHash('sha256').update(bytes).digest('hex') !== digest
  ) {
    throw new Error('Git checkpoint is oversized or corrupt.');
  }
  await writeFile(destination, bytes, { mode: 0o600 });
}
async function requireStored(response: Response): Promise<void> {
  if (!response.ok) {
    throw new Error(`Git checkpoint storage rejected the action (HTTP ${response.status}).`);
  }
}
function manifestPath(root: string): string {
  return path.join(root, '.stacki/studio/state/git-workspace.json');
}

async function boundedGitBytes(response: Response): Promise<Buffer> {
  if (!response.body) {
    throw new Error('Missing Git checkpoint body.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (let index = 0; index < 100_000; index++) {
      const next = await reader.read();
      if (next.done) {
        return Buffer.concat(chunks, length);
      }
      length += next.value.length;
      if (length > gitWorkspaceLimits.bundleBytes) {
        throw new Error('Git checkpoint exceeds 96 MiB.');
      }
      chunks.push(next.value);
    }
    throw new Error('Git checkpoint exceeds its streaming chunk limit.');
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

export async function copyVerifiedGitBundle(source: string, destination: string, digest: string) {
  const handle = await open(source, 'r');
  try {
    if ((await handle.stat()).size > gitWorkspaceLimits.bundleBytes) {
      throw new Error('Git checkpoint exceeds 96 MiB.');
    }
    const bytes = await handle.readFile();
    if (createHash('sha256').update(bytes).digest('hex') !== digest) {
      throw new Error('Git checkpoint is corrupt.');
    }
    await writeFile(destination, bytes, { mode: 0o600 });
  } finally {
    await handle.close();
  }
}
