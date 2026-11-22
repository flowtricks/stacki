// The Settings > Agents channels (shared/ipc/projectAgentChannels.ts): list the project's agent definitions
// and paired agents, save a pair, and move a definition or a pair to the Trash. The work is
// electron/project/agentFiles.ts; this resolves the project and keeps every path inside it.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { assert } from '../../shared/core/assert';
import { deleteAgent, listAgents, saveAgent } from '../project/agentFiles';
import type { MainHost } from './mainHost';

export function registerAgentHandlers(host: Pick<MainHost, 'ipcMain' | 'assertInProject' | 'shell'>): void {
  // The canonical project, checked to be the one the app has open.
  const root = (projectPath: string): string => {
    const canonical = fs.realpathSync(projectPath);
    host.assertInProject(path.join(canonical, 'package.json'));
    assert(path.isAbsolute(canonical), 'A project root is absolute');
    return canonical;
  };
  host.ipcMain.handle('agents:list', (_event, input) => listAgents(root(input.projectPath)));
  host.ipcMain.handle('agents:save', (_event, input) =>
    saveAgent(root(input.projectPath), { fields: input.fields, mode: input.mode, overwrite: input.overwrite }),
  );
  // The Trash, never a permanent delete: a definition removed by mistake can be put back.
  host.ipcMain.handle('agents:delete', (_event, input) =>
    deleteAgent(root(input.projectPath), input.target, (file) => host.shell.trashItem(host.assertInProject(file))),
  );
}
