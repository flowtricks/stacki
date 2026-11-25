import { pruneGitDrafts } from './gitWorkspacePrune';
import type { Environment } from './environment';
import { record } from '../shared/validation';
import { assert } from '../../vendor/stacki/shared/core/assert';
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
  // i18n-ignore: an object-store key, not text a person reads.
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
  if (request.method !== 'PUT') {
    return new Response('Method not allowed', { status: 405 });
  }
  // R2 refuses a stream of unknown length ("Provided readable stream must have a
  // known length"), so the declared length is checked before anything is read.
  // The container always sends a Buffer, which fetch gives a Content-Length.
  const length = gitBundleLength(request.headers.get('content-length'));
  if (length.kind === 'missing') {
    return new Response('Git checkpoint needs a Content-Length.', { status: 411 });
  }
  if (length.kind === 'oversized') {
    return new Response('Git checkpoint exceeds 96 MiB.', { status: 413 });
  }
  if (length.kind === 'empty' || request.body === null) {
    return new Response('Git checkpoint is empty.', { status: 400 });
  }
  const pruned = await pruneCloudGitBundles(environment, digest);
  if (!pruned.ok) {
    return new Response(pruned.message, { status: 503 });
  }
  return storeGitBundle(environment, key, digest, request.body, length.bytes);
}

/** The checkpoint's declared size: digits only, so a list, a sign or a fraction cannot pass. */
export function gitBundleLength(
  header: string | null,
): { readonly kind: 'missing' } | { readonly kind: 'empty' } | { readonly kind: 'oversized' } | { readonly kind: 'declared'; readonly bytes: number } {
  if (header === null || !/^[0-9]{1,16}$/.test(header)) {
    return { kind: 'missing' };
  }
  const bytes = Number(header);
  if (!Number.isSafeInteger(bytes)) {
    return { kind: 'oversized' };
  }
  if (bytes === 0) {
    return { kind: 'empty' };
  }
  if (bytes <= gitWorkspaceLimits.bundleBytes) {
    return { kind: 'declared', bytes };
  }
  return { kind: 'oversized' };
}

// Stream directly to R2: a bounded checkpoint need not fit twice in Worker memory.
// FixedLengthStream gives R2 the known length it requires and errors when the body
// ends early or runs long, so no byte counter is needed. An R2 put is atomic and the
// key is the content's SHA-256 (checked by R2 through the `sha256` option): a failed
// upload stores nothing, and deleting the key here could remove an identical object
// another upload completed, so failure needs no cleanup.
async function storeGitBundle(environment: Environment, key: string, digest: string, body: NonNullable<Request['body']>, bytes: number) {
  assert(bytes > 0, 'A Git checkpoint has content');
  assert(bytes <= gitWorkspaceLimits.bundleBytes, 'A Git checkpoint is within its limit');
  const fixed = new FixedLengthStream(bytes);
  const [piped, stored] = await Promise.allSettled([body.pipeTo(fixed.writable), environment.DRAFTS.put(key, fixed.readable, { sha256: digest })]);
  if (piped.status === 'rejected') {
    console.warn('Git checkpoint upload ended early', describeFailure(piped.reason));
    return new Response('Git checkpoint body did not match its Content-Length.', { status: 400 });
  }
  if (stored.status === 'rejected') {
    console.error('Git checkpoint storage failed', describeFailure(stored.reason));
    return new Response('Git checkpoint storage failed: ' + describeFailure(stored.reason), { status: 502 });
  }
  return new Response(null, { status: 204 });
}

function describeFailure(reason: unknown): string {
  return (reason instanceof Error ? reason.message : String(reason)).slice(0, 300);
}

type PruneResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

async function pruneCloudGitBundles(environment: Environment, digest: string): Promise<PruneResult> {
  const manifest = await readCloudGitWorkspace(environment);
  const inventory = await environment.DRAFTS.list({ prefix: 'git-bundles/', limit: 129 });
  if (inventory.truncated) {
    return { ok: false, message: 'Git checkpoint storage exceeds its 128-bundle limit.' };
  }
  const keep = new Set([digest, manifest?.bundle]);
  const cutoff = Date.now() - 30 * 60_000;
  const removed = inventory.objects.filter((object) => !keep.has(object.key.slice('git-bundles/'.length)) && object.uploaded.getTime() < cutoff);
  if (removed.length) {
    await environment.DRAFTS.delete(removed.map((object) => object.key));
  }
  if (inventory.objects.length - removed.length >= 128) {
    return { ok: false, message: 'Git checkpoint storage is busy. Retry after older checkpoints expire.' };
  }
  return { ok: true };
}
