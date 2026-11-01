import { git, run } from '../lib/nodeTools';
import type { PublishConfig } from '../../shared/properties/publishConfig';

/** URL-based pushes need an explicit tracking update so availability sees the confirmed commit. */
export async function recordPublishedGitHub(root: string, branch: string, commit: string): Promise<void> {
  const reference = `refs/remotes/origin/${branch}`;
  const previous = await git(root, ['rev-parse', '--verify', reference])
    .then((result) => result.stdout.trim())
    .catch(() => undefined);
  if (previous !== undefined) {
    // A concurrent fetch may already know a newer commit; never move it backwards.
    const newer = await git(root, ['merge-base', '--is-ancestor', commit, previous])
      .then(() => true)
      .catch(() => false);
    if (newer) {
      return;
    }
  }
  // Compare-and-swap also protects against a fetch racing this local bookkeeping.
  await git(root, ['update-ref', reference, commit, previous ?? '0'.repeat(commit.length)]);
}

/** Resolve the selected account without changing gh's global active account. */
export async function publishingGitEnvironment(root: string, config: PublishConfig): Promise<NodeJS.ProcessEnv> {
  if (!config.githubAccount) {
    return { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  }
  const environment = { ...process.env };
  delete environment['GH_TOKEN'];
  delete environment['GITHUB_TOKEN'];
  let token: string;
  try {
    const result = await run('gh', ['auth', 'token', '--hostname', 'github.com', '--user', config.githubAccount], root, { env: environment });
    token = result.stdout.trim();
  } catch {
    throw new Error(`Sign in once with gh auth login for ${config.githubAccount}.`);
  }
  if (!/^[\w-]{10,512}$/.test(token)) {
    throw new Error('GitHub CLI returned an invalid credential.');
  }
  // The token lives only in the child environment, never in argv or repository config.
  return {
    ...environment,
    GH_TOKEN: token,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: '3',
    GIT_CONFIG_KEY_0: 'credential.helper',
    GIT_CONFIG_VALUE_0: '',
    GIT_CONFIG_KEY_1: 'credential.https://github.com.helper',
    GIT_CONFIG_VALUE_1: '!gh auth git-credential',
    GIT_CONFIG_KEY_2: 'url.https://github.com/.insteadOf',
    GIT_CONFIG_VALUE_2: 'git@github.com:',
  };
}

export async function publishingGitRemote(root: string, config: PublishConfig): Promise<string> {
  // Validate the configured identity; transport URL rewrites still apply when Git connects.
  const remote = (await git(root, ['config', '--get', 'remote.origin.url'])).stdout.trim();
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(remote);
  if (!match?.[1]) {
    throw new Error('Connect a github.com repository from the branch menu before publishing.');
  }
  // HTTPS lets a pinned account override an unrelated SSH identity without rewriting origin.
  return config.githubAccount ? `https://github.com/${match[1]}.git` : remote;
}
