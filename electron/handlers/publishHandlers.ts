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

export function registerPublishHandlers(host: Pick<MainHost, 'ipcMain' | 'assertInProject'>): void {
  const publisher = new DesktopPublisher();
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
      return { ok: false, error: 'Wait for publishing to finish before changing repositories.' };
    }
    return publishingRepositories(project, input.request);
  });
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
