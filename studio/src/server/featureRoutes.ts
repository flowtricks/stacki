import { pageRenameRoute } from '../features/pages/pageRenameServer';
import { gitWorkspaceRoutes } from '../features/history/gitWorkspaceRoutes';
import { availabilityRoutes } from '../features/publishing/availabilityRoutes';
import { siteRoute } from '../features/publishing/siteRoutes';
import { historyRoutes } from '../features/history/historyRoutes';
import { accountRoute } from '../features/publishing/accountRoutes';
import { repositoryRoute } from '../features/publishing/repositoryRoutes';
import { discoveryRoute } from '../features/publishing/discoveryRoutes';
import { metadataRoute } from '../features/settings/projectMetadata';
import { cmsRoutes } from '../features/cms/cmsServer';
import { cmsRemoteRoutes } from '../features/cms/cmsRemoteServer';
import { aiRoute } from '../features/ai/aiRoutes';
import { publishRoute } from '../features/publishing/publishRoutes';
import { componentUsageRoute } from '../features/components/componentUsageServer';
import { propertyRoutes } from '../features/componentProperties/propertyServer';
import { variableRoutes } from '../features/variables/variableServer';
import { StorageCleanup } from '../features/storage/cleanup';
import { styleFiles, saveSource } from '../features/settings/styleRoutes';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { aiConfiguration } from '../features/ai/agent';
import { ProposalStore } from '../features/ai/proposalStore';
import { Publisher, githubFromEnvironment } from '../features/publishing/publish';
import type { createRooms } from '../features/collaboration/rooms';
import { automaticSync } from '../features/github/automaticSync';
import { RepositorySync } from '../features/github/sync';
import { record, string } from '../shared/validation';

export function featureRoutes(root: string, rooms: ReturnType<typeof createRooms>) {
  const repository = githubFromEnvironment(root);
  const history = historyRoutes(root, repository);
  const availability = availabilityRoutes(root, repository);
  const cms = cmsRoutes(root, rooms);
  const cmsRemote = cmsRemoteRoutes(root);
  const variables = variableRoutes(root, rooms);
  const properties = propertyRoutes(root, rooms);
  const { cleanup, publisher, synchronization, proposals } = featureServices(root, rooms);
  const git = gitWorkspaceRoutes(
    root,
    repository,
    rooms,
    () => publisher.state.kind === 'building',
  );
  return async (
    request: IncomingMessage,
    response: ServerResponse,
    pathname: string,
    readBody: () => Promise<string>,
  ): Promise<boolean> => {
    if (
      (await git(request, response, pathname, readBody)) ||
      (await pageRenameRoute(root, rooms, request, response, pathname, readBody)) ||
      (await siteRoute(root, request, response, pathname)) ||
      (await availability(request, response, pathname)) ||
      (await history(request, response, pathname, readBody)) ||
      (await defaultsCanvasRoute(root, rooms, request, response, pathname, readBody)) ||
      (await metadataRoute(root, rooms, request, response, pathname, readBody)) ||
      (await discoveryRoute(root, request, response, pathname, readBody)) ||
      (await accountRoute(root, request, response, pathname, readBody)) ||
      (await repositoryRoute(root, request, response, pathname, readBody)) ||
      (await componentUsageRoute(root, request, response, pathname)) ||
      (await cms(request, response, pathname, readBody)) ||
      (await cmsRemote(request, response, pathname, readBody)) ||
      (await variables(request, response, pathname, readBody)) ||
      (await properties(request, response, pathname, readBody)) ||
      (await storageRoute(cleanup, request, response, pathname, readBody))
    ) {
      return true;
    }
    if (pathname === '/studio/api/styles' && request.method === 'GET') {
      respond(
        response,
        await styleFiles(
          root,
          new URL(request.url ?? '/', 'http://studio').searchParams.has('astro'),
        ),
      );
      return true;
    }
    if (pathname === '/studio/api/source') {
      respond(response, await saveSource(request, rooms, readBody));
      return true;
    }
    if (
      await synchronizationRoute(request, response, pathname, readBody, publisher, synchronization)
    ) {
      return true;
    }
    if (publishRoute(publisher, request, response, pathname)) {
      return true;
    }
    if (await aiRoute(proposals, request, response, pathname, readBody)) {
      return true;
    }
    return false;
  };
}
function respond(response: ServerResponse, value: unknown) {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(value));
}

function featureServices(root: string, rooms: ReturnType<typeof createRooms>) {
  const cleanup = new StorageCleanup(root, rooms.coordinator);
  const repository = githubFromEnvironment(root);
  const synchronization = new RepositorySync(root, repository, rooms);
  const publisher = publisherFor(root, rooms, cleanup, synchronization);
  const automatic = automaticSync(
    synchronization,
    () => !!repository && rooms.hasClients() && publisher.state.kind !== 'building',
  );
  rooms.sockets.once('close', automatic.stop);
  return {
    cleanup,
    publisher,
    synchronization,
    automatic,
    proposals: new ProposalStore(root, rooms),
  };
}

async function storageRoute(
  cleanup: StorageCleanup,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  readBody: () => Promise<string>,
) {
  if (pathname === '/studio/api/storage' && request.method === 'GET') {
    respond(response, await cleanup.inspect());
    return true;
  }
  if (pathname === '/studio/api/storage/cleanup' && request.method === 'POST') {
    const input = record(JSON.parse(await readBody()));
    respond(response, await cleanup.clean(input['candidates']));
    return true;
  }
  return false;
}

function publisherFor(
  root: string,
  rooms: ReturnType<typeof createRooms>,
  cleanup: StorageCleanup,
  synchronization: RepositorySync,
) {
  const publisher = new Publisher(
    root,
    synchronization.repository,
    rooms.coordinator,
    undefined,
    (files, sha) => cleanup.afterPublish(files, sha),
    undefined,
    () => synchronization.latest(),
    rooms.persist,
  );
  publisher.subscribe(rooms.publishing);
  return publisher;
}

async function syncProject(publisher: Publisher, synchronization: RepositorySync, body: string) {
  if (publisher.state.kind === 'building') {
    return {
      kind: 'failed',
      message: 'Publishing is already syncing GitHub. Wait until publishing finishes.',
    };
  }
  const input = body ? record(JSON.parse(body)) : {};
  const side = input['side'];
  return synchronization.sync(
    side === 'draft' || side === 'github' ? { side, sha: string(input['sha'], 64) } : undefined,
  );
}
import { defaultsCanvasRoute } from '../features/settings/defaultsCanvasServer';

async function synchronizationRoute(
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
  readBody: () => Promise<string>,
  publisher: Publisher,
  synchronization: RepositorySync,
) {
  if (pathname === '/studio/api/status') {
    respond(response, {
      publishing: publisher.state,
      github: !!publisher.github,
      ai: !!aiConfiguration(),
      synchronization: synchronization.state,
    });
    return true;
  }
  if (pathname === '/studio/api/sync' && request.method === 'POST') {
    respond(response, await syncProject(publisher, synchronization, await readBody()));
    return true;
  }
  return false;
}
