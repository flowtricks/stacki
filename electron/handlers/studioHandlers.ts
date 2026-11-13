import * as path from 'node:path';
// Setup is scoped to the open project. Local bundles are selected in main,
// never accepted as arbitrary paths from renderer input.
import { installStudio, automaticStudio, readStudioRelease, studioStatus, type StudioReleaseEnvironment } from '../project/studioSetup';
import { errorMessage } from '../lib/mainHelpers';
import type { MainHost } from './mainHost';
import { translateMain } from '../lib/mainLocale';
import type { StudioInstallResult } from '../../shared/ipc/studioSetup';
import { createStudioProgress } from '../project/studioProgress';

export function registerStudioHandlers(
  host: Pick<MainHost, 'ipcMain' | 'assertInProject' | 'showOpenDialog' | 'send'>,
  environment: StudioReleaseEnvironment,
  desktopVersion: () => string,
): void {
  host.ipcMain.handle('studio:status', (_event, project) => studioStatus(path.dirname(host.assertInProject(path.join(project, 'studio'))), desktopVersion()));
  host.ipcMain.handle('studio:install', async (_event, options): Promise<StudioInstallResult> => {
    const project = path.dirname(host.assertInProject(path.join(options.projectPath, 'studio')));
    const progress = createStudioProgress({ projectPath: options.projectPath, requestId: options.requestId }, (value) => host.send('studio:progress', value));
    try {
      const status = await studioStatus(project, desktopVersion());
      if (status.kind !== 'missing') {
        return {
          kind: 'error',
          message: translateMain('error.studio.exists'),
        };
      }
      progress.update({ kind: 'stage', stage: 'release' });
      const release = await selectRelease(host, options.source, desktopVersion(), environment);
      if (!release) {
        return { kind: 'canceled' };
      }
      return {
        kind: 'installed',
        version: await installStudio(project, release, progress.update),
      };
    } catch (error: unknown) {
      return { kind: 'error', message: errorMessage(error) };
    } finally {
      progress.close();
    }
  });
}

async function selectRelease(host: Pick<MainHost, 'showOpenDialog'>, source: 'published' | 'file', version: string, environment: StudioReleaseEnvironment) {
  if (source === 'published') {
    return automaticStudio(version, environment);
  }
  const selection = await host.showOpenDialog({
    title: translateMain('dialog.open.studioRelease.title'),
    properties: ['openFile'],
    filters: [{ name: translateMain('dialog.open.studioRelease.filter'), extensions: ['json'] }],
  });
  const file = selection.filePaths[0];
  return selection.canceled || !file ? undefined : readStudioRelease(file);
}
