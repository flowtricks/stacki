import { readGitWorkspace } from '../history/gitWorkspaceStorage';
import { gitWorkspaceAvailability } from '../history/gitWorkspaceAvailability';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NativeRepository } from '../github/nativeRepository';
import type { PublishAvailability } from '../../../vendor/stacki/shared/properties/publishState';
import { parsePublishSource } from '../../../vendor/stacki/shared/properties/publishConfig';
import { readMetadataSource } from '../settings/projectMetadata';
import { readPublishedStatusTree, readDeployedStatusRevision } from './publishStatusRemote';
import { PublishStatusSource } from './publishStatusSource';
import { published } from './publishFailure';

interface StatusOptions {
  readonly endpoint?: string;
  readonly transport?: typeof fetch;
}

export function availabilityRoutes(root: string, repository: Pick<NativeRepository, 'historyConnection'> | undefined, options: StatusOptions = {}) {
  const source = new PublishStatusSource(root);
  let pending: Promise<PublishAvailability> | undefined;
  let cached: { readonly at: number; readonly value: PublishAvailability } | undefined;
  const read = async () => {
    if (cached && Date.now() - cached.at < 2000) {
      return cached.value;
    }
    if (pending) {
      return pending;
    }
    pending = readAvailability(root, source, repository, options);
    try {
      const value = await pending;
      cached = { at: Date.now(), value };
      return value;
    } finally {
      pending = undefined;
    }
  };
  return async (request: IncomingMessage, response: ServerResponse, pathname: string) => {
    if (pathname !== '/studio/api/publish/availability') {
      return false;
    }
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method !== 'GET') {
      response.writeHead(405, { Allow: 'GET' });
      response.end(JSON.stringify({ error: 'Publishing status is read-only.' }));
      return true;
    }
    try {
      response.end(JSON.stringify(await read()));
    } catch {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: 'Could not check publishing status. Please retry.' }));
    }
    return true;
  };
}

async function readAvailability(
  root: string,
  source: PublishStatusSource,
  repository: Pick<NativeRepository, 'historyConnection'> | undefined,
  options: StatusOptions,
): Promise<PublishAvailability> {
  if (!repository) {
    return { github: 'unknown', hosting: 'unconfigured' };
  }
  const connection = published(await repository.historyConnection());
  const workspace = await readGitWorkspace(root);
  const unpublished = workspace && !workspace.remote.some((entry) => entry.name === workspace.branch);
  const remote = unpublished ? { sha: '', files: new Map() } : await readPublishedStatusTree(connection, options.transport);
  // Inspect persisted source only; status must never write drafts, Git objects, or deployment data.
  const pending = workspace
    ? await gitWorkspaceAvailability(root, source, connection, workspace)
    : { changed: await source.differs(remote.files), commits: undefined };
  const changed = pending.changed;
  const config = parsePublishSource((await readMetadataSource(root, 'publish')).source);
  const endpoint = options.endpoint ?? process.env['STUDIO_DEPLOYMENT_URL'];
  const hosting = endpoint
    ? await readDeployedStatusRevision(endpoint, options.transport).then(
        (sha) => (!changed && sha === remote.sha ? ('current' as const) : ('pending' as const)),
        () => 'unknown' as const,
      )
    : config.hosting.provider === 'none'
      ? ('unconfigured' as const)
      : ('unknown' as const);
  return {
    github: changed ? 'pending' : 'current',
    hosting,
    // Include existing local commits; publishing adds a commit only for an uncommitted draft.
    githubPush: {
      commits: pending.commits ?? (changed ? 1 : 0),
      repositoryUrl: `https://github.com/${connection.repository}`,
    },
  };
}
