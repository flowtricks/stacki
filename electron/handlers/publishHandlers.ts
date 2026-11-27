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
import { described } from '../../shared/properties/i18n/messageRef';
import type { CustomPublishRequest, CustomPublishResult } from '../../shared/properties/publishDeployLink';
import type { DeployLinkStore } from '../project/deployLinkStore';
import { readPackageScripts } from '../project/publishCustom';
import { readWorkerEnvironments } from '../project/publishStagingWorker';

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
  const changed =
    request.action === 'saveLink'
      ? await deployLinks.save(project, request.link, request.destination)
      : request.action === 'removeLink'
        ? deployLinks.remove(project, request.destination)
        : undefined;
  if (changed !== undefined && !changed.ok) {
    return { kind: 'failed', ...changed.error };
  }
  return {
    kind: 'ready',
    scripts: await readPackageScripts(project),
    environments: await readWorkerEnvironments(project),
    links: { production: await deployLinks.state(project, 'production'), staging: await deployLinks.state(project, 'staging') },
  };
}
