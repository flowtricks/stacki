// The git panel's IPC: the repository's state, branches with parked changes,
// history, commits, restores, and publishing to GitHub.

import { definedFields } from '../../shared/core/boundary';
import { readPublishConfig } from '../project/publishConfig';
import { publishingGitEnvironment } from '../project/publishGitHub';
import type { GitInfo } from '../lib/mainTypes';
import { mergeBranch, deleteBranch, switchBranch, resolveMerge, readDefaultBranch } from '../git/gitBranches';
import { pullBranch, readIncomingCommits } from '../git/gitPull';
import * as gitHistory from '../git/gitHistory';
import { readCommitDiff } from '../git/gitCommitDiff';
import * as gitSnapshot from '../git/gitSnapshot';
import { capture } from '../lib/mainHelpers';
import { run, git } from '../lib/nodeTools';
import { parkBranch, unparkBranch, currentBranch, readGitLog, readGitIdentity, readGitParked } from '../git/gitParking';
import type { MainHost } from './mainHost';
import { registerGitAvatarHandler } from './gitAvatarHandlers';
import { registerGitHubUserSearchHandler } from './githubUserSearchHandlers';
import { ReferencedError } from '../../shared/properties/i18n/referencedError';
import { referencingIpc } from '../lib/referencingIpc';
import type { createIpcRegistrar } from '../lib/ipcRegistrar';
import { explainGitFailure, explainingGitFailures } from '../git/gitFailure';
import { projectPrefix, readHead, requireValidBranchName } from '../git/gitState';
import { parseStatusRecords } from '../git/gitHistory';
import { MAIN_LIMITS } from '../lib/mainLimits';
import { toRecord } from '../../shared/core/record';

type Registrar = ReturnType<typeof createIpcRegistrar>;

// Every failure leaving a git channel goes through `explainGitFailure`: a locked index, a refused sign-in or a missing identity reach the
// person as the sentence that says what to do, never as git's raw output with a command line in front of it.
function explainingIpc(ipcMain: { readonly handle: Registrar }): { readonly handle: Registrar } {
  const handle: Registrar = (channel, listener) => {
    ipcMain.handle(channel, (event, payload) => explainingGitFailures(async () => listener(event, payload)));
  };
  return { handle };
}

export function registerGitHandlers(host: Pick<MainHost, 'ipcMain'>): void {
  // Our own refusals (a branch changed, a merge went stale) carry a reference to their translation; this keeps it across IPC.
  const referencing = { ipcMain: explainingIpc(referencingIpc(host.ipcMain)) };
  registerGitInfoHandler(referencing);
  registerGitGhStatusHandlers(referencing);
  registerGitUnparkHandlers(referencing);
  registerGitPublishHandler(referencing);
  registerGitPullHandler(referencing);
  registerGitAvatarHandler(host);
  registerGitHubUserSearchHandler(host);
}

/**
 * Whether the folder is inside a repository's working tree. "Not a repository" is an answer; git missing, or refusing the folder because
 * another user owns it, is a failure the person must be told about, because answering "not a repository" there would offer to initialise
 * a new repository on top of an existing one (or one that cannot be created at all).
 */
async function isWorkTree(projectPath: string): Promise<boolean> {
  try {
    // A bare repository, or a folder inside `.git`, answers "false" with success: there are no files to work on there.
    return (await git(projectPath, ['rev-parse', '--is-inside-work-tree'])).stdout.trim() === 'true';
  } catch (error: unknown) {
    const code = toRecord(error)?.['code'];
    const explained = explainGitFailure(error);
    if (code === 'ENOENT' || (explained instanceof ReferencedError && explained.messageRef.key === 'git.error.unsafeDirectory')) {
      throw explained;
    }
    return false;
  }
}

function registerGitInfoHandler({ ipcMain }: Pick<MainHost, 'ipcMain'>): void {
  ipcMain.handle('git:info', async (_event, projectPath) => {
    if (!(await isWorkTree(projectPath))) {
      return { isRepo: false as const };
    }
    const info: GitInfo = {
      isRepo: true as const,
      branch: '',
      branches: [],
      remote: undefined,
      dirty: false,
      ahead: 0,
      // Branches holding work that was left behind on the way out, so the
      // switcher can say where it is rather than making it a thing you have to
      // remember.
      parked: [],
    };
    info.parked = await readGitParked(projectPath);
    Object.assign(info, await readGitIdentity(projectPath));
    try {
      const listed = (await git(projectPath, ['branch', '--format=%(refname:short)'])).stdout
        .split('\n')
        .map((branch) => branch.trim())
        .filter(Boolean);
      // Git lists branches alphabetically, which puts the trunk wherever its
      // name happens to fall. But the trunk is not one branch among many — it
      // is the one you came from and the one you go back to, so it goes first
      // and the rest keep the order git gave them.
      const trunk = ['main', 'master'].find((branch) => listed.includes(branch));
      info.branches = trunk ? [trunk, ...listed.filter((branch) => branch !== trunk)] : listed;
      // Named as well as ordered. Git will delete the trunk as readily as any
      // other branch — `git branch -d main` succeeds the moment main is merged
      // into whatever you are standing on — and the branch everything comes back
      // to is not one to lose to a stray click.
      info.trunk = trunk || undefined;
    } catch {
      /* empty repo */
    }
    info.defaultBranch = await readDefaultBranch(git, projectPath, info.trunk);
    try {
      info.remote = (await git(projectPath, ['remote', 'get-url', 'origin'])).stdout.trim() || undefined;
    } catch {
      info.remote = undefined;
    }
    // A failed status is not "clean": reporting `dirty: false` there would let a switch or a publish go ahead as if nothing were
    // unsaved, so the failure is thrown and the panel says so. `-z` and the prefix give project-relative, unquoted paths.
    const prefix = await projectPrefix(git, projectPath);
    const out = (await git(projectPath, ['status', '--porcelain=v1', '-z', '--', '.'])).stdout;
    const changed = parseStatusRecords(out, prefix, MAIN_LIMITS.statusFilesMax);
    info.dirty = changed.length > 0;
    info.dirtyFiles = changed.slice(0, 50).map((file) => file.path);
    // Without an upstream there's no count to give — and "0 ahead" would read
    // as "nothing to push" when in fact the branch has never been pushed at
    // all, so the two cases have to stay distinguishable.
    try {
      await git(projectPath, ['rev-parse', '--abbrev-ref', '@{upstream}']);
      info.hasUpstream = true;
    } catch {
      info.hasUpstream = false;
    }
    if (info.hasUpstream) {
      try {
        const counts = (await git(projectPath, ['rev-list', '--count', '--left-only', 'HEAD...@{upstream}'])).stdout.trim();
        info.ahead = parseInt(counts, 10) || 0;
      } catch {
        info.ahead = 0;
      }
    }
    return info;
  });
}

function registerGitGhStatusHandlers({ ipcMain }: Pick<MainHost, 'ipcMain'>): void {
  // Is the GitHub CLI usable? Checked when the publish dialog opens so a
  // missing or logged-out `gh` is stated up front, instead of surfacing as a
  // failure after the user has filled the form in.
  ipcMain.handle('git:ghStatus', async (_event, projectPath) => {
    try {
      await run('gh', ['--version'], projectPath);
    } catch {
      return { installed: false as const, authed: false as const };
    }
    try {
      // Writes its report to stderr and exits non-zero when logged out.
      const config = readPublishConfig(projectPath);
      const environment = await publishingGitEnvironment(projectPath, config);
      const result = await run('gh', ['auth', 'status'], projectPath, { env: environment });
      const out = `${result.stdout}${result.stderr}`;
      const match = out.match(/(?:account|as)\s+([\w-]+)/i);
      return {
        installed: true as const,
        authed: true as const,
        user: config.githubAccount || (match ? capture(match, 1) : undefined),
      };
    } catch {
      return { installed: true as const, authed: false as const };
    }
  });

  ipcMain.handle('git:init', async (_event, projectPath) => {
    try {
      await git(projectPath, ['init', '-b', 'main']);
    } catch {
      // Git older than 2.28 has no `-b`. Initialise, then point HEAD at main, which is what `-b` does.
      await git(projectPath, ['init']);
      await git(projectPath, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    }
    return { ok: true as const };
  });

  // Keep drafts on their original branches, including edits Git could carry across.
  ipcMain.handle('git:checkout', async (_event, { projectPath, branch, create }) => {
    const result = await switchBranch(git, {
      projectPath,
      branch,
      ...definedFields({ create }),
      park: (from) => parkBranch(projectPath, from),
      unpark: (from) => unparkBranch(projectPath, from),
    });
    if (!result.ok) {
      return result;
    }
    if (create || result.from === branch) {
      return { ...result, parkedFrom: undefined, restored: false };
    }
    // Only this destination's drafts come back; the source branch stays parked.
    const back = await unparkBranch(projectPath, branch);
    return { ...result, parkedFrom: result.parked ? result.from : undefined, ...back };
  });

  ipcMain.handle('git:log', async (_event, payload) => readGitLog(payload));
  ipcMain.handle('git:commitDiff', async (_event, payload) => readCommitDiff(git, payload));

  // Every file in the project, with what has happened to each — the file
  // browser's list, and the same status the commit picker reads.
  ipcMain.handle('git:allFiles', async (_event, { projectPath }) => gitHistory.describeFiles(await gitHistory.allFiles(git, { projectPath })));

  ipcMain.handle('git:status', async (_event, { projectPath }) => gitHistory.describeFiles(await gitHistory.status(git, { projectPath })));

  ipcMain.handle('git:worktrees', async (_event, { projectPath }) => gitHistory.worktrees(git, { projectPath }));

  // Setting work aside and picking it back up, on their own. The switch has done
  // this internally for a while; a merge that finds unsaved work in its way needs
  // the same two steps, and the user is the one deciding to take them.
  ipcMain.handle('git:park', async (_event, { projectPath }) => {
    const branch = await currentBranch(projectPath);
    const parked = await parkBranch(projectPath, branch);
    return { ok: true as const, parked, branch: branch ?? undefined };
  });
}

function registerGitUnparkHandlers({ ipcMain }: Pick<MainHost, 'ipcMain'>): void {
  ipcMain.handle('git:unpark', async (_event, { projectPath }) => {
    const branch = await currentBranch(projectPath);
    return unparkBranch(projectPath, branch);
  });

  ipcMain.handle('git:merge', async (_event, { projectPath, branch }) => mergeBranch(git, { projectPath, branch }));

  // Finishing a merge the user has chosen their way through. The conflicting
  // files come back from git:merge with both versions; this applies the answers.
  ipcMain.handle('git:resolveMerge', async (_event, { projectPath, branch, choices }) => {
    const parking = {
      park: (into: string) => parkBranch(projectPath, into),
      unpark: (into: string) => unparkBranch(projectPath, into),
    };
    return resolveMerge(git, { ...definedFields({ projectPath, branch, choices }), parking });
  });

  ipcMain.handle('git:deleteBranch', async (_event, { projectPath, branch, force }) => deleteBranch(git, definedFields({ projectPath, branch, force })));

  ipcMain.handle('git:commit', async (_event, { projectPath, message, paths }) => gitSnapshot.commit(git, definedFields({ projectPath, message, paths })));

  ipcMain.handle('git:restoreFile', async (_event, { projectPath, ref, path: filePath }) => gitSnapshot.restoreFile(git, { projectPath, ref, path: filePath }));

  // `park` is handed in rather than imported: it lives here, over the stash, and
  // is the reason going back to an old version cannot lose what is on disk now.
  ipcMain.handle('git:restoreProject', async (_event, { projectPath, ref }) => {
    const branch = await currentBranch(projectPath);
    return gitSnapshot.restoreProject(git, {
      projectPath,
      ref,
      park: () => parkBranch(projectPath, branch),
    });
  });

  ipcMain.handle('git:push', async (_event, { projectPath, branch }) => {
    // Push the named local branch to the same name, and nothing else: never a force, never "all", never whatever HEAD happens to be.
    // A detached HEAD has no branch to send, and a name git would not accept is never handed to it.
    const head = await readHead(git, projectPath);
    if (head.branch === undefined) {
      throw new ReferencedError('git.error.detachedHead');
    }
    await requireValidBranchName(git, projectPath, branch);
    const environment = await publishingGitEnvironment(projectPath, readPublishConfig(projectPath));
    await git(projectPath, ['push', '-u', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], {
      timeout: 120000,
      env: environment,
    });
    return { ok: true as const };
  });
}

function registerGitPullHandler({ ipcMain }: Pick<MainHost, 'ipcMain'>): void {
  ipcMain.handle('git:incoming', async (_event, payload) => {
    const environment = await publishingGitEnvironment(payload.projectPath, readPublishConfig(payload.projectPath));
    return readIncomingCommits((projectPath, args) => git(projectPath, args, { timeout: 30000, env: environment }), payload);
  });
  ipcMain.handle('git:pull', async (_event, payload) => {
    const environment = await publishingGitEnvironment(payload.projectPath, readPublishConfig(payload.projectPath));
    return pullBranch((projectPath, args) => git(projectPath, args, { timeout: 120000, env: environment }), payload);
  });
}

function registerGitPublishHandler({ ipcMain }: Pick<MainHost, 'ipcMain'>): void {
  ipcMain.handle('git:publish', async (_event, { projectPath, repoName, isPrivate }) => {
    try {
      await run('gh', ['--version'], projectPath);
    } catch {
      throw new ReferencedError('git.publish.cliMissing');
    }
    const args = ['repo', 'create', repoName, isPrivate ? '--private' : '--public', '--source', '.', '--remote', 'origin', '--push'];
    const environment = await publishingGitEnvironment(projectPath, readPublishConfig(projectPath));
    const result = await run('gh', args, projectPath, { timeout: 180000, env: environment });
    const output = result.stdout + result.stderr;
    // `gh` prints the new repo's URL; fall back to the remote it just set.
    let url = (output.match(/https:\/\/github\.com\/[^\s"']+/) || [])[0] || undefined;
    if (!url) {
      try {
        url = (await git(projectPath, ['remote', 'get-url', 'origin'])).stdout.trim() || undefined;
      } catch {
        /* no remote — caller just won't get a link */
      }
    }
    if (url) {
      url = url.replace(/[.,)]+$/, '').replace(/\.git$/, '');
    }
    return { ok: true as const, url, output };
  });
}
