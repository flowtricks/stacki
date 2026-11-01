import { pruneGitDrafts } from './gitWorkspacePrune';
import type { Environment } from './environment';
import { record } from '../shared/validation';
import { gitBundleDigest, gitDraftNamespace, gitWorkspaceLimits, parseGitWorkspaceManifest } from '../features/history/gitWorkspaceContract';

const manifestKey = 'metadata/git-workspace';
export async function readCloudGitWorkspace(environment: Environment) {
  const stored = await environment.DRAFTS.get(manifestKey);
  if (stored && stored.size > gitWorkspaceLimits.manifestBytes) {
    throw new Error('Git workspace metadata exceeds its limit.');
  }
  return stored ? parseGitWorkspaceManifest(await stored.json()) : undefined;
}
export function draftKey(request: Request, name: string): string {
  const namespace = gitDraftNamespace(request.headers.get('x-studio-draft') ?? 'legacy');
  return namespace === 'legacy' ? name : `workspaces/${namespace}/${name}`;
}
export async function gitWorkspaceRoute(request: Request, environment: Environment) {
  if (request.method === 'GET') {
    return Response.json((await readCloudGitWorkspace(environment)) ?? null);
  }
  if (request.method !== 'PUT') {
    return new Response('Method not allowed', { status: 405 });
  }
  const body = await request.text();
  if (body.length > gitWorkspaceLimits.manifestBytes) {
    return new Response('Git metadata exceeds its limit.', { status: 413 });
  }
  const input: unknown = JSON.parse(body);
  const data = record(input);
  const manifest = parseGitWorkspaceManifest(data['manifest']);
  if (manifest.repository !== environment.GITHUB_REPOSITORY) {
    return new Response('Repository changed. Reload Studio.', { status: 409 });
  }
  const previous = data['previous'] === undefined ? undefined : gitDraftNamespace(data['previous']);
  const current = await environment.DRAFTS.get(manifestKey);
  const currentManifest = current ? parseGitWorkspaceManifest(await current.json()) : undefined;
  const currentRevision = currentManifest?.revision;
  if (previous !== currentRevision) {
    return new Response('Git changed during the action. Refresh and retry.', { status: 409 });
  }
  if (manifest.bundle && !(await environment.DRAFTS.head('git-bundles/' + manifest.bundle))) {
    return new Response('Git checkpoint has not finished uploading.', { status: 409 });
  }
  await pruneGitDrafts(environment, currentManifest, manifest);
  const written = await environment.DRAFTS.put(manifestKey, JSON.stringify(manifest), {
    onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: '*' },
  });
  return written ? new Response(null, { status: 204 }) : new Response('Git changed during the action. Refresh and retry.', { status: 409 });
}
export async function gitBundleRoute(request: Request, environment: Environment, url: URL) {
  const digest = gitBundleDigest(url.searchParams.get('digest'));
  const key = 'git-bundles/' + digest;
  if (request.method === 'GET') {
    const stored = await environment.DRAFTS.get(key);
    return stored ? new Response(stored.body) : new Response('Missing Git checkpoint.', { status: 404 });
  }
  if (request.method !== 'PUT' || !request.body) {
    return new Response('Method not allowed', { status: 405 });
  }
  await pruneCloudGitBundles(environment, digest);
  let bytes = 0;
  // Stream directly to R2: a bounded checkpoint need not fit twice in Worker memory.
  const bounded = request.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.length;
        if (bytes > gitWorkspaceLimits.bundleBytes) {
          throw new Error('Git checkpoint exceeds 96 MiB.');
        }
        controller.enqueue(chunk);
      },
    }),
  );
  await environment.DRAFTS.put(key, bounded, { sha256: digest });
  return new Response(null, { status: 204 });
}

async function pruneCloudGitBundles(environment: Environment, digest: string) {
  const manifest = await readCloudGitWorkspace(environment);
  const inventory = await environment.DRAFTS.list({ prefix: 'git-bundles/', limit: 129 });
  if (inventory.truncated) {
    throw new Error('Git checkpoint storage exceeds its 128-bundle limit.');
  }
  const keep = new Set([digest, manifest?.bundle]);
  const cutoff = Date.now() - 30 * 60_000;
  const removed = inventory.objects.filter((object) => !keep.has(object.key.slice('git-bundles/'.length)) && object.uploaded.getTime() < cutoff);
  if (removed.length) {
    await environment.DRAFTS.delete(removed.map((object) => object.key));
  }
  if (inventory.objects.length - removed.length >= 128) {
    throw new Error('Git checkpoint storage is busy. Retry after older checkpoints expire.');
  }
}
