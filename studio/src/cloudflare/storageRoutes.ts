import { createHash } from 'node:crypto';
import { GitHubRepository } from '../features/github/github';
import { assetPath, parseCandidate, type StoredEntry } from '../features/storage/cleanupTypes';
import type { Environment } from './environment';

// These routes are reachable only through internal()'s container-token check.
export async function storageInventory(_request: Request, environment: Environment) {
  const entries: StoredEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 100; page++) {
    const result = await environment.DRAFTS.list({ limit: 1000, ...(cursor ? { cursor } : {}) });
    entries.push(...result.objects.map(({ key, size, version }) => ({ key, size, version })));
    if (entries.length > 10_000) {
      throw new Error('Storage inventory is too large for cleanup');
    }
    if (!result.truncated) {
      return Response.json({ entries });
    }
    if (!result.cursor || result.cursor === cursor) {
      throw new Error('Incomplete storage inventory');
    }
    cursor = result.cursor;
  }
  throw new Error('Incomplete storage inventory');
}
export async function storageBaseline(_request: Request, environment: Environment) {
  const base = await environment.DRAFTS.get('metadata/base-sha');
  if (!base) {
    throw new Error('Missing published revision; cleanup is unavailable');
  }
  const sha = await base.text();
  const repository = new GitHubRepository({
    appId: environment.GITHUB_APP_ID,
    installationId: environment.GITHUB_INSTALLATION_ID,
    privateKey: environment.GITHUB_PRIVATE_KEY,
    repository: environment.GITHUB_REPOSITORY,
    branch: environment.GITHUB_BRANCH,
  });
  return Response.json({ sha, assets: await repository.publishedAssets(sha) });
}
export async function removeStoredAsset(request: Request, environment: Environment) {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  const candidate = parseCandidate(await request.json());
  const key = 'assets/' + assetPath(candidate.file);
  const object = await environment.DRAFTS.get(key);
  if (!object) {
    return Response.json({ removed: false });
  }
  if (
    object.version !== candidate.version ||
    object.size !== candidate.size ||
    object.size > 20_000_000
  ) {
    throw new Error('Upload changed since the cleanup preview; scan again');
  }
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (createHash('sha256').update(bytes).digest('hex') !== candidate.digest) {
    throw new Error('Stored upload differs from the cleanup preview');
  }
  // Upload and cleanup mutations are serialized by the project's single
  // container coordinator. Never expose this deletion route to browsers.
  await environment.DRAFTS.delete(key);
  return Response.json({ removed: true });
}
