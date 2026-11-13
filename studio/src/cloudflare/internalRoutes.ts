// i18n-ignore-file: HTTP API fallback text on the Studio server: it has no language, and the editor shows its own sentence for a failed request.
import { draftKey, readCloudGitWorkspace, gitWorkspaceRoute, gitBundleRoute } from './gitWorkspaceRoutes';
import { modelConfiguration } from '../features/ai/chatContracts';
import { parseAssetState, emptyAssetState } from '../features/assets/assetStateTypes';
import { authorizeConnection } from '../features/auth/connectionAuthorization';
import { storageInventory, storageBaseline, removeStoredAsset } from './storageRoutes';
import { GitHubRepository } from '../features/github/github';
import { sourcePath, filePath, record, string } from '../shared/validation';
import type { Environment } from './environment';

export async function internal(request: Request, environment: Environment): Promise<Response> {
  if (!environment.CONTAINER_TOKEN || request.headers.get('x-studio-token') !== environment.CONTAINER_TOKEN) {
    return new Response('Forbidden', { status: 403 });
  }
  const url = new URL(request.url);
  const handler = routes[url.pathname];
  return handler ? handler(request, environment, url) : new Response('Not found', { status: 404 });
}
const routes: Readonly<Record<string, (request: Request, environment: Environment, url: URL) => Promise<Response>>> = {
  '/studio/internal/ai/models': async (_request, environment) =>
    Response.json(modelConfiguration(environment.AI_BASE_URL ? environment.AI_MODEL : undefined, environment.AI_BASE_URL ? environment.AI_MODELS : undefined)),
  '/studio/internal/authorize': authorizeConnection,
  '/studio/internal/storage': storageInventory,
  '/studio/internal/storage-baseline': storageBaseline,
  '/studio/internal/storage-remove': removeStoredAsset,
  '/studio/internal/git-workspace': gitWorkspaceRoute,
  '/studio/internal/git-bundle': gitBundleRoute,
  '/studio/internal/base': internalBase,
  '/studio/internal/incoming': internalIncoming,
  '/studio/internal/chat/completions': internalCompletions,
  '/studio/internal/assets': internalAssets,
  '/studio/internal/asset-state': internalAssetState,
  '/studio/internal/asset': internalAsset,
  '/studio/internal/publish-connection': internalPublishConnection,
  '/studio/internal/review-connection': internalPublishConnection,
  '/studio/internal/state': internalState,
  '/studio/internal/files': internalFiles,
  '/studio/internal/bootstrap': internalBootstrap,
};

async function internalBase(request: Request, environment: Environment, url: URL): Promise<Response> {
  if (url.pathname === '/studio/internal/base' && request.method === 'POST') {
    const input = record(await request.json());
    const sha = string(input['sha'], 64);
    if (!/^[a-f0-9]{40}$/.test(sha)) {
      throw new Error('Invalid Git revision');
    }
    await environment.DRAFTS.put(draftKey(request, 'metadata/base-sha'), sha);
    return Response.json({ saved: true });
  }
  return new Response('Not found', { status: 404 });
}

async function internalIncoming(request: Request, environment: Environment, url: URL): Promise<Response> {
  if (url.pathname === '/studio/internal/incoming' && request.method === 'POST') {
    try {
      const input = record(await request.json());
      const repository = new GitHubRepository({
        appId: environment.GITHUB_APP_ID,
        installationId: environment.GITHUB_INSTALLATION_ID,
        privateKey: environment.GITHUB_PRIVATE_KEY,
        repository: environment.GITHUB_REPOSITORY,
        branch: (await readCloudGitWorkspace(environment))?.branch ?? environment.GITHUB_BRANCH,
      });
      return Response.json(await repository.incoming(string(input['base'], 64)));
    } catch (error) {
      return Response.json({ error: error instanceof Error ? error.message : 'GitHub sync failed' }, { status: 409 });
    }
  }
  return new Response('Not found', { status: 404 });
}

async function internalCompletions(request: Request, environment: Environment, url: URL): Promise<Response> {
  if (url.pathname === '/studio/internal/chat/completions' && request.method === 'POST') {
    if (!environment.AI_BASE_URL || !environment.AI_MODEL) {
      return new Response('Configure AI_BASE_URL and AI_MODEL', { status: 503 });
    }
    const endpoint = new URL(environment.AI_BASE_URL.replace(/\/$/, '') + '/chat/completions');
    if (endpoint.protocol !== 'https:') {
      throw new Error('Hosted AI requires HTTPS');
    }
    const input = record(await request.json());
    const models = modelConfiguration(environment.AI_MODEL, environment.AI_MODELS);
    const model = string(input['model'], 160);
    if (!models.models.includes(model)) {
      throw new Error('Model is not configured');
    }
    const messages = input['messages'];
    if (!Array.isArray(messages) || messages.length > 26 || JSON.stringify(messages).length > 1_500_000) {
      throw new Error('Invalid AI context');
    }
    return fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(environment.AI_API_KEY ? { Authorization: 'Bearer ' + environment.AI_API_KEY } : {}),
      },
      body: JSON.stringify({ model, max_tokens: 6000, messages }),
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(60_000)]),
    });
  }
  return new Response('Not found', { status: 404 });
}

async function internalAssets(request: Request, environment: Environment, url: URL): Promise<Response> {
  if (url.pathname === '/studio/internal/assets') {
    const prefix = draftKey(request, 'assets/');
    const objects = await environment.DRAFTS.list({ prefix, limit: 1000 });
    if (objects.truncated) {
      throw new Error('Asset inventory exceeds limit');
    }
    return Response.json(objects.objects.map((object) => filePath(object.key.slice(prefix.length))));
  }
  return new Response('Not found', { status: 404 });
}

async function internalAsset(request: Request, environment: Environment, url: URL): Promise<Response> {
  if (url.pathname === '/studio/internal/asset') {
    const file = filePath(url.searchParams.get('file'));
    if (request.method === 'DELETE') {
      await environment.DRAFTS.delete(draftKey(request, 'assets/' + file));
      return new Response(null, { status: 204 });
    }
    if (request.method === 'GET') {
      const object = await environment.DRAFTS.get(draftKey(request, 'assets/' + file));
      return object ? new Response(object.body) : new Response(null, { status: 404 });
    }
    if (request.method === 'PUT') {
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > 20_000_000) {
        return new Response('Asset too large', { status: 413 });
      }
      await environment.DRAFTS.put(draftKey(request, 'assets/' + file), bytes);
      return new Response(null, { status: 204 });
    }
  }
  return new Response('Not found', { status: 404 });
}

async function internalPublishConnection(request: Request, environment: Environment): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  const repository = new GitHubRepository({
    appId: environment.GITHUB_APP_ID,
    installationId: environment.GITHUB_INSTALLATION_ID,
    privateKey: environment.GITHUB_PRIVATE_KEY,
    repository: environment.GITHUB_REPOSITORY,
    branch: (await readCloudGitWorkspace(environment))?.branch ?? environment.GITHUB_BRANCH,
  });
  const connection =
    new URL(request.url).pathname === '/studio/internal/review-connection' ? await repository.reviewConnection() : await repository.publishConnection();
  return connection.ok
    ? Response.json(connection.value, { headers: { 'Cache-Control': 'no-store' } })
    : Response.json({ error: connection.error.message }, { status: 400 });
}

async function internalState(request: Request, environment: Environment, url: URL): Promise<Response> {
  if (url.pathname === '/studio/internal/state') {
    const file = sourcePath(url.searchParams.get('file'));
    const key = draftKey(request, 'documents/' + file);
    if (request.method === 'DELETE') {
      await environment.DRAFTS.delete(key);
      return new Response(null, { status: 204 });
    }
    if (request.method === 'GET') {
      const object = await environment.DRAFTS.get(key);
      return object ? new Response(object.body) : new Response(null, { status: 404 });
    }
    if (request.method === 'PUT') {
      const bytes = await request.arrayBuffer();
      if (bytes.byteLength > 8_000_000) {
        return new Response('Too large', { status: 413 });
      }
      await environment.DRAFTS.put(key, bytes);
      return new Response(null, { status: 204 });
    }
  }
  return new Response('Not found', { status: 404 });
}

async function internalFiles(request: Request, environment: Environment, url: URL): Promise<Response> {
  if (url.pathname === '/studio/internal/files') {
    const prefix = draftKey(request, 'documents/');
    const objects = await environment.DRAFTS.list({ prefix, limit: 1000 });
    if (objects.truncated) {
      throw new Error('Draft file limit exceeded');
    }
    return Response.json(objects.objects.map((object) => sourcePath(object.key.slice(prefix.length))));
  }
  return new Response('Not found', { status: 404 });
}

async function internalBootstrap(request: Request, environment: Environment): Promise<Response> {
  if (request.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }
  const repository = new GitHubRepository({
    appId: environment.GITHUB_APP_ID,
    installationId: environment.GITHUB_INSTALLATION_ID,
    privateKey: environment.GITHUB_PRIVATE_KEY,
    repository: environment.GITHUB_REPOSITORY,
    branch: (await readCloudGitWorkspace(environment))?.branch ?? environment.GITHUB_BRANCH,
  });
  const connection = await repository.publishConnection();
  if (!connection.ok) {
    return Response.json({ error: connection.error.message }, { status: 400 });
  }
  const existing = await environment.DRAFTS.get(draftKey(request, 'metadata/base-sha'));
  const workspace = await readCloudGitWorkspace(environment);
  const sha =
    workspace?.remote.find((entry) => entry.name === workspace.branch)?.head ??
    workspace?.remote[0]?.head ??
    (existing ? await existing.text() : await repository.head(connection.value.token));
  if (!/^[a-f0-9]{40}$/.test(sha)) {
    throw new Error('Invalid repository baseline.');
  }
  if (!existing) {
    await environment.DRAFTS.put(draftKey(request, 'metadata/base-sha'), sha);
  }
  return Response.json({ ...connection.value, sha, workspace }, { headers: { 'Cache-Control': 'no-store' } });
}

async function internalAssetState(request: Request, environment: Environment): Promise<Response> {
  const key = draftKey(request, 'metadata/asset-state');
  if (request.method === 'GET') {
    const object = await environment.DRAFTS.get(key);
    return Response.json(object ? parseAssetState(await object.json()) : emptyAssetState);
  }
  if (request.method === 'PUT') {
    const body = await request.text();
    if (body.length > 1_600_000) {
      return new Response('Too large', { status: 413 });
    }
    await environment.DRAFTS.put(key, JSON.stringify(parseAssetState(JSON.parse(body))));
    return new Response(null, { status: 204 });
  }
  return new Response('Method not allowed', { status: 405 });
}
