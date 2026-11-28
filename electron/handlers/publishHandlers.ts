import { PublishingAccount } from '../project/publishAccount';
import { publishingRepositories } from '../project/publishRepositories';
import { discoverPublishing } from '../project/publishDiscovery';
import { ensureToolPath } from '../lib/nodeTools';
import path from 'node:path';
import { realpathSync } from 'node:fs';
import type { MainHost } from './mainHost';
import { DesktopPublisher } from '../project/publisher';
import { readPublishAvailability } from '../project/publishAvailability';
import { readProjectMetadata } from '../project/projectMetadata';
import { publishedProjectSiteURL } from '../project/publishSite';
import { translateMain } from '../lib/mainLocale';
import { setUpWorkerHosting } from '../project/publishWorkerSetup';
import { createNetlifySite } from '../project/publishNetlify';
import { described, type Described } from '../../shared/properties/i18n/messageRef';
import {
  PRODUCTION_LINK,
  type CustomPublishRequest,
  type CustomPublishResult,
  type DeployLinkState,
  type DeployLinkStates,
} from '../../shared/properties/publishDeployLink';
import type { DestinationId } from '../../shared/properties/publishDestinations';
import { err, type Result } from '../../shared/core/result';
import type { DeployLinkStore } from '../project/deployLinkStore';
import { readPackageScripts } from '../project/publishCustom';
import { readWorkerEnvironments } from '../project/publishDestinationWorker';
import { readPublishDestinations } from '../project/publishDestination';

export function registerPublishHandlers(host: Pick<MainHost, 'ipcMain' | 'assertInProject'>, deployLinks: DeployLinkStore): void {
  const publisher = new DesktopPublisher(undefined, { deployLinks });
  const account = new PublishingAccount();
  host.ipcMain.handle('publish:discover', async (_event, input) => {
    const project = root(input.projectPath);
    await ensureToolPath();
    return discoverPublishing(project, input.request);
  });
  const root = (projectPath: string) => {
    const canonical = realpathSync(projectPath);
    host.assertInProject(path.join(canonical, '.stacki', 'publish.json'));
    return canonical;
  };
  host.ipcMain.handle('publish:account', (_event, input) => account.request(root(input.projectPath), input.request));
  host.ipcMain.handle('publish:repository', async (_event, input) => {
    const project = root(input.projectPath);
    await ensureToolPath();
    if (input.request.action !== 'list' && publisher.state(project).kind === 'running') {
      return { ok: false, error: translateMain('error.publish.repositoriesBusy') };
    }
    return publishingRepositories(project, input.request);
  });
  host.ipcMain.handle('publish:workerSetup', async (_event, input) => {
    const project = root(input.projectPath);
    await ensureToolPath();
    // Setup may change the site's dependencies; it must not race a publish that is building them.
    if (publisher.state(project).kind === 'running') {
      return { kind: 'failed', ...described('publish.worker.setup.busy') };
    }
    return setUpWorkerHosting(project, input.worker);
  });
  host.ipcMain.handle('publish:netlifySite', async (_event, input) => {
    const project = root(input.projectPath);
    await ensureToolPath();
    return createNetlifySite(project, input.site);
  });
  host.ipcMain.handle('publish:custom', (_event, input) => customPublishRequest(root(input.projectPath), input.request, deployLinks));
  host.ipcMain.handle('publish:start', (_event, input) => publisher.start(root(input.projectPath), input.target, input.commitMessage));
  host.ipcMain.handle('publish:state', (_event, projectPath) => publisher.state(root(projectPath)));
  host.ipcMain.handle('publish:availability', (_event, projectPath) => readPublishAvailability(root(projectPath)));
  host.ipcMain.handle('publish:siteURL', async (_event, projectPath) => {
    const project = root(projectPath);
    await ensureToolPath();
    // URL discovery is independent of the local status check, which must stay responsive offline.
    try {
      const metadata = readProjectMetadata(project, 'publish');
      return metadata.ok ? await publishedProjectSiteURL(project, metadata.value.source) : undefined;
    } catch {
      return undefined;
    }
  });
}

// Nothing here sends or runs anything: it lists the site's script and environment names and keeps deploy links. Only a publish uses either.
async function customPublishRequest(project: string, request: CustomPublishRequest, deployLinks: DeployLinkStore): Promise<CustomPublishResult> {
  await ensureToolPath();
  const changed = request.action === 'read' ? undefined : await changeDeployLink(project, request, deployLinks);
  if (changed !== undefined && !changed.ok) {
    return { kind: 'failed', ...changed.error };
  }
  return {
    kind: 'ready',
    scripts: await readPackageScripts(project),
    environments: await readWorkerEnvironments(project),
    links: await deployLinkStates(project, deployLinks),
  };
}

/** The saved destinations' ids. An unreadable file names none: its destinations cannot be edited or published. */
function destinationIds(project: string): readonly DestinationId[] {
  try {
    return readPublishDestinations(project).destinations.map((destination) => destination.id);
  } catch {
    return [];
  }
}

async function changeDeployLink(
  project: string,
  request: Exclude<CustomPublishRequest, { readonly action: 'read' }>,
  deployLinks: DeployLinkStore,
): Promise<Result<undefined, Described>> {
  if (request.action === 'removeLink') {
    // A removed destination is no longer in the file, and its link must still be removable.
    return deployLinks.remove(project, request.destination);
  }
  const ids = destinationIds(project);
  // Only production and saved destinations keep links, so a project's links stay bounded.
  if (request.destination !== PRODUCTION_LINK && !ids.includes(request.destination)) {
    return err(described('publish.destination.error.notSetUp'));
  }
  return deployLinks.save(project, request.link, request.destination, ids);
}

async function deployLinkStates(project: string, deployLinks: DeployLinkStore): Promise<DeployLinkStates> {
  const destinations: [DestinationId, DeployLinkState][] = [];
  for (const id of destinationIds(project)) {
    destinations.push([id, await deployLinks.state(project, id)]);
  }
  return {
    production: await deployLinks.state(project, PRODUCTION_LINK),
    destinations: Object.fromEntries(destinations),
    unsaved: deployLinks.unsavedState(),
  };
}
