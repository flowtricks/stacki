// The history panel's author pictures (git:avatars). The renderer sends commit hashes
// and author emails; this answers with GitHub avatar URLs only. The credential is read
// here, from the same GitHub CLI sign-in publishing uses, and never crosses to the
// renderer. A project whose origin is not on github.com is never looked up.
import { createCommitAvatarResolver, githubRepositoryFromRemote } from '../git/commitAvatars';
import { readPublishConfig } from '../project/publishConfig';
import { publishingGitEnvironment } from '../project/publishGitHub';
import { git, run } from '../lib/nodeTools';
import type { MainHost } from './mainHost';

export function registerGitAvatarHandler({ ipcMain }: Pick<MainHost, 'ipcMain'>): void {
  // One cache for the app's lifetime: commits do not change authors.
  const resolver = createCommitAvatarResolver({ fetch, now: Date.now });
  ipcMain.handle('git:avatars', async (_event, { projectPath, commits }) =>
    resolver.resolve({
      repository: () => originRepository(projectPath),
      token: () => githubToken(projectPath),
      commits,
    }),
  );
}

export async function originRepository(projectPath: string): Promise<string | undefined> {
  try {
    const remote = (await git(projectPath, ['remote', 'get-url', 'origin'], { timeout: 10_000 })).stdout;
    return githubRepositoryFromRemote(remote);
  } catch {
    return undefined;
  }
}

/** The GitHub CLI credential publishing uses (its pinned account first), or undefined. */
export async function githubToken(projectPath: string): Promise<string | undefined> {
  try {
    const environment = await publishingGitEnvironment(projectPath, readPublishConfig(projectPath));
    const configured = environment['GH_TOKEN'];
    const token =
      configured ?? (await run('gh', ['auth', 'token', '--hostname', 'github.com'], projectPath, { env: environment, timeout: 10_000 })).stdout.trim();
    return /^[\w-]{10,512}$/.test(token) ? token : undefined;
  } catch {
    // Not installed, signed out, or the pinned account is missing: no pictures, no prompt.
    return undefined;
  }
}
