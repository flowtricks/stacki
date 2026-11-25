// The Settings panel's Secrets channels (shared/properties/secrets.ts), for the dev env file each
// message names: list its names, read one value on request, apply one change against a revision,
// and add the file to `.gitignore`. The work is electron/content/envSecrets.ts; this resolves the project and keeps
// secrets out of every log: no handler here prints, and the replies hold names and one value at most.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert } from '../../shared/core/assert';
import { applySecretsChange, ignoreEnvFile, listSecrets, readSecret } from '../content/envSecrets';
import { git } from '../lib/nodeTools';
import type { MainHost } from './mainHost';

export function registerSecretsHandlers(host: Pick<MainHost, 'ipcMain' | 'assertInProject'>): void {
  // The canonical project, checked to be the one the app has open.
  const root = (projectPath: string): string => {
    const canonical = fs.realpathSync(projectPath);
    host.assertInProject(path.join(canonical, 'package.json'));
    assert(path.isAbsolute(canonical), 'A project root is absolute');
    return canonical;
  };
  host.ipcMain.handle('secrets:list', (_event, input) => listSecrets(root(input.projectPath), input.file, git));
  host.ipcMain.handle('secrets:read', (_event, input) => readSecret(root(input.projectPath), input.file, input.revision, input.index));
  host.ipcMain.handle('secrets:apply', (_event, input) => applySecretsChange(root(input.projectPath), input.file, input.revision, input.change, git));
  host.ipcMain.handle('secrets:ignore', (_event, input) => ignoreEnvFile(root(input.projectPath), input.file, git));
}
