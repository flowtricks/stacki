// Goal: give Git workflow tests an isolated origin and working draft.
// Method: use ordinary Git commits and a private Studio object store; no GitHub writes.
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { GitWorkspace } from '../src/features/history/gitWorkspace';
import { writeLocalGitWorkspace } from '../src/features/history/gitWorkspaceStorage';
import type { GitWorkspaceManifest } from '../src/features/history/gitWorkspaceContract';
const execute = promisify(execFile);
export async function createGitWorkspaceFixture(options: { readonly root?: string } = {}) {
  const parent = await mkdtemp(path.join(tmpdir(), 'studio-git-workspace-'));
  const remote = path.join(parent, 'remote');
  const root = options.root ?? path.join(parent, 'site');
  await mkdir(path.join(remote, 'src/pages'), { recursive: true });
  const git = async (...args: string[]) =>
    (
      await execute('git', args, {
        cwd: remote,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Test',
          GIT_AUTHOR_EMAIL: 'test@example.com',
          GIT_COMMITTER_NAME: 'Test',
          GIT_COMMITTER_EMAIL: 'test@example.com',
        },
      })
    ).stdout.trim();
  await git('init', '--quiet', '--initial-branch=main');
  await writeFile(path.join(remote, 'src/pages/index.astro'), '<h1>Original</h1>');
  await writeFile(path.join(remote, 'src/pages/about.astro'), '<h1>About</h1>');
  await git('add', '.');
  await git('commit', '--quiet', '-m', 'Initial');
  const head = await git('rev-parse', 'HEAD');
  await mkdir(path.join(root, '.stacki/studio/state'), { recursive: true });
  await mkdir(path.join(root, 'src/pages'), { recursive: true });
  await writeFile(path.join(root, 'src/pages/index.astro'), '<h1>Changed</h1>');
  await writeFile(path.join(root, 'src/pages/about.astro'), '<h1>Draft</h1>');
  const directory = path.join(root, '.stacki/studio/state/workspace.git');
  await git('clone', '--bare', '--quiet', remote, directory);
  const manifest: GitWorkspaceManifest = {
    version: 1,
    revision: randomUUID(),
    repository: 'owner/site',
    branch: 'main',
    branches: [{ name: 'main', head, workspace: 'legacy' }],
    remote: [{ name: 'main', head }],
    parked: [],
    draft: undefined,
    bundle: undefined,
  };
  await writeLocalGitWorkspace(root, manifest);
  const connection = { repository: 'owner/site', branch: 'main', token: '' };
  const workspace = new GitWorkspace(root, async () => ({ ok: true, value: connection }));
  return { parent, remote, root, workspace, connection, head, git };
}
