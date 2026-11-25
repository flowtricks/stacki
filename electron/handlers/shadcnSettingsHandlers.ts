import path from 'node:path';
import { realpathSync } from 'node:fs';
import { err } from '../../shared/core/result';
import type { ShadcnSettingsReply } from '../../shared/ipc/shadcnSettings';
import { changeShadcnSetting, readShadcnSettings } from '../project/shadcnSettings';
import type { MainHost } from './mainHost';

export function registerShadcnSettingsHandlers(host: Pick<MainHost, 'ipcMain' | 'assertInProject'>): void {
  const withProject = async (projectPath: string, operation: (root: string) => ShadcnSettingsReply | Promise<ShadcnSettingsReply>) => {
    try {
      const root = realpathSync(projectPath);
      host.assertInProject(path.join(root, 'components.json'));
      return await operation(root);
    } catch (error: unknown) {
      return err({ message: error instanceof Error ? error.message : String(error) });
    }
  };
  host.ipcMain.handle('project:readShadcnSettings', (_event, { projectPath }) => withProject(projectPath, readShadcnSettings));
  host.ipcMain.handle('project:changeShadcnSetting', (_event, { projectPath, setting, enabled }) =>
    withProject(projectPath, (root) => changeShadcnSetting(root, { setting, enabled })),
  );
}
