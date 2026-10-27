// The git panel's IPC: the repository's state, branches with parked changes,
// history, commits, restores, and publishing to GitHub.

import { definedFields } from '../../shared/core/boundary';
import { readPublishConfig } from '../project/publishConfig';
import { publishingGitEnvironment } from '../project/publishGitHub';
import type { GitInfo } from '../lib/mainTypes';
import { mergeBranch, deleteBranch, switchBranch, resolveMerge } from '../git/gitBranches';
import { pullBranch, readIncomingCommits } from '../git/gitPull';
import * as gitHistory from '../git/gitHistory';
import { readCommitDiff } from '../git/gitCommitDiff';
import * as gitSnapshot from '../git/gitSnapshot';
import { capture } from '../lib/mainHelpers';
import { run, git } from '../lib/nodeTools';
import {
  parkBranch,
  unparkBranch,
  currentBranch,
  readGitLog,
  readGitIdentity,
  readGitParked,
} from '../git/gitParking';
import type { MainHost } from './mainHost';

export function registerGitHandlers(host: Pick<MainHost, 'ipcMain'>): void {
  registerGitInfoHandler(host);
  registerGitGhStatusHandlers(host);
  registerGitUnparkHandlers(host);
  registerGitPublishHandler(host);
  registerGitPullHandler(host);
}

function registerGitInfoHandler({ ipcMain }: Pick<MainHost, 'ipcMain'>): void {
  ipcMain.handle('git:info', async (_event, projectPath) => {
    try {
      await git(projectPath, ['rev-parse', '--is-inside-work-tree']);
    } catch {
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
    try {
      info.remote =
        (await git(projectPath, ['remote', 'get-url', 'origin'])).stdout.trim() || undefined;
    } catch {
      info.remote = undefined;
    }
    try {
      const out = (await git(projectPath, ['status', '--porcelain'])).stdout;
      // Porcelain v1 is "XY path" — two status columns, a space, then the path
      // (renames as "old -> new"). Don't trim the line before slicing: the
      // first column is a space for worktree-only changes.
      const lines = out.split('\n').filter((line) => line.trim());
      info.dirty = lines.length > 0;
      info.dirtyFiles = lines.slice(0, 50).map((line) => {
        const filePath = line.slice(3);
        const arrow = filePath.lastIndexOf(' -> ');
        return (arrow === -1 ? filePath : filePath.slice(arrow + 4)).replace(/^"|"$/g, '');
      });
    } catch {
      /* ignore */
    }
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
        const counts = (
          await git(projectPath, ['rev-list', '--count', '--left-only', 'HEAD...@{upstream}'])
        ).stdout.trim();
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
    await git(projectPath, ['init', '-b', 'main']);
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
  ipcMain.handle('git:allFiles', async (_event, { projectPath }) =>
    gitHistory.describeFiles(await gitHistory.allFiles(git, { projectPath })),
  );

  ipcMain.handle('git:status', async (_event, { projectPath }) =>
    gitHistory.describeFiles(await gitHistory.status(git, { projectPath })),
  );

  ipcMain.handle('git:worktrees', async (_event, { projectPath }) =>
    gitHistory.worktrees(git, { projectPath }),
  );

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

  ipcMain.handle('git:merge', async (_event, { projectPath, branch }) =>
    mergeBranch(git, { projectPath, branch }),
  );

  // Finishing a merge the user has chosen their way through. The conflicting
  // files come back from git:merge with both versions; this applies the answers.
  ipcMain.handle('git:resolveMerge', async (_event, { projectPath, branch, choices }) =>
    resolveMerge(git, definedFields({ projectPath, branch, choices })),
  );

  ipcMain.handle('git:deleteBranch', async (_event, { projectPath, branch, force }) =>
    deleteBranch(git, definedFields({ projectPath, branch, force })),
  );

  ipcMain.handle('git:commit', async (_event, { projectPath, message, paths }) =>
    gitSnapshot.commit(git, definedFields({ projectPath, message, paths })),
  );

  ipcMain.handle('git:restoreFile', async (_event, { projectPath, ref, path: filePath }) =>
    gitSnapshot.restoreFile(git, { projectPath, ref, path: filePath }),
  );

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
    const environment = await publishingGitEnvironment(projectPath, readPublishConfig(projectPath));
    await git(projectPath, ['push', '-u', 'origin', branch], {
      timeout: 120000,
      env: environment,
    });
    return { ok: true as const };
  });
}

function registerGitPullHandler({ ipcMain }: Pick<MainHost, 'ipcMain'>): void {
  ipcMain.handle('git:incoming', async (_event, payload) => {
    const environment = await publishingGitEnvironment(
      payload.projectPath,
      readPublishConfig(payload.projectPath),
    );
    return readIncomingCommits(
      (projectPath, args) => git(projectPath, args, { timeout: 30000, env: environment }),
      payload,
    );
  });
  ipcMain.handle('git:pull', async (_event, payload) => {
    const environment = await publishingGitEnvironment(
      payload.projectPath,
      readPublishConfig(payload.projectPath),
    );
    return pullBranch(
      (projectPath, args) => git(projectPath, args, { timeout: 120000, env: environment }),
      payload,
    );
  });
}

function registerGitPublishHandler({ ipcMain }: Pick<MainHost, 'ipcMain'>): void {
  ipcMain.handle('git:publish', async (_event, { projectPath, repoName, isPrivate }) => {
    try {
      await run('gh', ['--version'], projectPath);
    } catch {
      throw new Error(
        'GitHub CLI (gh) is not installed. Install it from https://cli.github.com ' +
          'and run `gh auth login`.',
      );
    }
    const args = [
      'repo',
      'create',
      repoName,
      isPrivate ? '--private' : '--public',
      '--source',
      '.',
      '--remote',
      'origin',
      '--push',
    ];
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
