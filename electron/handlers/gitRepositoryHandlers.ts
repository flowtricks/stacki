import { mkdirSync } from 'node:fs';
import { readPublishConfig } from '../project/publishConfig';
import { publishingGitEnvironment } from '../project/publishGitHub';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { assert } from '../../shared/core/assert';
import { list, record } from '../../shared/core/boundary';
import { parseGitHubRepository, parseGitHubRepositories } from '../../shared/ipc/githubRepository';
import { run } from '../lib/nodeTools';
import { isAstroProject } from '../project/projectFiles';
import { connectRepository } from '../git/githubRepository';
import { git } from '../lib/nodeTools';
import type { MainHost } from './mainHost';
import { translateMain } from '../lib/mainLocale';
import { described } from '../../shared/properties/i18n/messageRef';
import { referencingIpc } from '../lib/referencingIpc';

export function registerGitRepositoryHandlers({ ipcMain: plainIpcMain, showOpenDialog }: Pick<MainHost, 'ipcMain' | 'showOpenDialog'>): void {
  const ipcMain = referencingIpc(plainIpcMain);
  ipcMain.handle('git:repositories', async () => {
    const response = await run('gh', ['api', 'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member'], homedir(), {
      timeout: 30000,
    });
    const data: unknown = JSON.parse(response.stdout);
    return parseGitHubRepositories(list((entry) => parseGitHubRepository(record(entry)['full_name']))(data));
  });
  ipcMain.handle('git:clone', async (_event, { repository }) => {
    const result = await showOpenDialog({
      title: translateMain('dialog.open.repositoryTarget.title'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled) {
      return { canceled: true as const };
    }
    const parent = result.filePaths[0];
    assert(parent !== undefined, 'Clone destination must exist');
    const name = repository.split('/')[1];
    assert(name !== undefined, 'Repository must have a name');
    const projectPath = join(parent, name);
    // Exclusive creation protects existing projects, including empty directories.
    mkdirSync(projectPath);
    await run('gh', ['repo', 'clone', `https://github.com/${repository}`, '.'], projectPath, {
      timeout: 180000,
    });
    if (!isAstroProject(projectPath)) {
      const cloneNotAstro = described('git.error.cloneNotAstro', { path: projectPath });
      return { canceled: false as const, error: cloneNotAstro.message, errorRef: cloneNotAstro.messageRef };
    }
    return { canceled: false as const, projectPath };
  });
  ipcMain.handle('git:connect', async (_event, payload) => {
    const environment = await publishingGitEnvironment(payload.projectPath, readPublishConfig(payload.projectPath));
    const result = await connectRepository((root, argumentsList) => git(root, argumentsList, { env: environment }), payload);
    if (!result.ok) {
      // The reference rides on the error object; `referencingIpc` appends it to the message the renderer receives.
      throw Object.assign(new Error(result.error), { messageRef: result.errorRef });
    }
    return { ok: true as const, ...result.value };
  });
}
