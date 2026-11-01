import { assert } from '../../shared/core/assert';
import { err, ok, type Result } from '../../shared/core/result';
import { publishTree, type PublishSource } from './publishSnapshot';
import { checkPublishWorkingSize } from './publishSize';
import { parsePublishObject, readPublishHead, runPublishGit } from './publishGitCommand';

export interface PublishRepository {
  readonly branch: string;
  readonly remote: string;
  readonly environment: NodeJS.ProcessEnv;
}

export async function requirePublishMessage(root: string, source: PublishSource, message: string | undefined): Promise<Result<void>> {
  if (source.head !== undefined) {
    const headTree = await runPublishGit(root, ['rev-parse', `${source.head}^{tree}`]);
    if (!headTree.ok) {
      return headTree;
    }
    if (headTree.value.trim() === source.tree) {
      return ok(undefined);
    }
  }
  return message === undefined
    ? err({
        code: 'message-required',
        message: 'Enter a commit message before publishing changes to GitHub.',
      })
    : ok(undefined);
}

/** Fetch objects without moving refs or working files; the existing Pull flow owns merges. */
export async function checkPublishIncoming(root: string, repository: PublishRepository, head: string | undefined): Promise<Result<void>> {
  const reference = `refs/heads/${repository.branch}`;
  const options = { env: repository.environment, timeout: 120_000 };
  const advertised = await runPublishGit(root, ['ls-remote', '--refs', repository.remote, reference], options);
  if (!advertised.ok) {
    return advertised;
  }
  if (advertised.value === '') {
    return ok(undefined);
  }
  const [commit, remoteReference] = advertised.value.trim().split('\t');
  if (remoteReference !== reference || commit === undefined) {
    return err({ code: 'git-output', message: 'Git returned a different remote branch.' });
  }
  const parsed = parsePublishObject(commit);
  if (!parsed.ok) {
    return parsed;
  }
  if (head === undefined) {
    return incomingChanges();
  }
  const fetched = await runPublishGit(root, ['fetch', '--no-tags', '--no-write-fetch-head', repository.remote, commit], options);
  if (!fetched.ok) {
    return fetched;
  }
  const ancestor = await runPublishGit(root, ['merge-base', '--is-ancestor', commit, head]);
  if (ancestor.ok) {
    return ok(undefined);
  }
  return ancestor.error.exitCode === 1 ? incomingChanges() : ancestor;
}

export async function commitPublishSource(root: string, source: PublishSource, branch: string, message: string | undefined): Promise<Result<string>> {
  assert(parsePublishObject(source.tree).ok, 'Publish source carries a valid tree');
  assert(branch.length > 0, 'Publish commits belong to a named branch');
  const stable = await checkPublishIdentity(root, source, branch);
  if (!stable.ok) {
    return stable;
  }
  const bounded = await checkPublishWorkingSize(root, source.index, 'github');
  if (!bounded.ok) {
    return bounded;
  }
  const current = await publishTree(root, source.index);
  if (!current.ok) {
    return current;
  }
  if (current.value !== source.tree) {
    return changedProject();
  }
  const staged = await runPublishGit(root, ['add', '--all', '--', '.'], { timeout: 600_000 });
  if (!staged.ok) {
    return staged;
  }
  const stagedTree = await runPublishGit(root, ['write-tree']);
  if (!stagedTree.ok) {
    return stagedTree;
  }
  if (stagedTree.value.trim() !== source.tree) {
    return changedProject();
  }
  const identity = await checkPublishIdentity(root, source, branch);
  if (!identity.ok) {
    return identity;
  }
  const committed = await commitPublishChanges(root, source, message);
  if (!committed.ok) {
    return committed;
  }
  return verifyPublishCommit(root, source.tree, branch);
}

async function commitPublishChanges(root: string, source: PublishSource, message: string | undefined): Promise<Result<void>> {
  if (source.head !== undefined) {
    const headTree = await runPublishGit(root, ['rev-parse', `${source.head}^{tree}`]);
    if (!headTree.ok) {
      return headTree;
    }
    if (headTree.value.trim() === source.tree) {
      return ok(undefined);
    }
  }
  // The message is required before staging; reaching this branch without it is a caller defect.
  assert(message !== undefined, 'Changed publish source has a commit message');
  assert(message.length > 0, 'Publish commit message is nonempty');
  const result = await runPublishGit(root, ['commit', '--quiet', '--message', message]);
  return result.ok ? ok(undefined) : result;
}

async function checkPublishIdentity(root: string, source: PublishSource, branch: string): Promise<Result<void>> {
  const currentBranch = await runPublishGit(root, ['symbolic-ref', '--short', 'HEAD']);
  if (!currentBranch.ok) {
    return currentBranch;
  }
  if (currentBranch.value.trim() !== branch) {
    return changedProject();
  }
  const head = await readPublishHead(root);
  if (!head.ok) {
    return head;
  }
  return head.value === source.head ? ok(undefined) : changedProject();
}

async function verifyPublishCommit(root: string, tree: string, branch: string): Promise<Result<string>> {
  const head = await readPublishHead(root);
  if (!head.ok) {
    return head;
  }
  if (head.value === undefined) {
    return changedProject();
  }
  const identity = await runPublishGit(root, ['symbolic-ref', '--short', 'HEAD']);
  if (!identity.ok) {
    return identity;
  }
  if (identity.value.trim() !== branch) {
    return changedProject();
  }
  const committedTree = await runPublishGit(root, ['rev-parse', `${head.value}^{tree}`]);
  if (!committedTree.ok) {
    return committedTree;
  }
  return committedTree.value.trim() === tree
    ? ok(head.value)
    : err({
        code: 'commit-changed',
        message: 'Commit hooks changed the publish source. Review it and publish again.',
      });
}

function changedProject(): Result<never> {
  return err({
    code: 'source-changed',
    message: 'Project or branch changed while publishing. Publish again to include the latest edits.',
  });
}

function incomingChanges(): Result<never> {
  return err({
    code: 'incoming',
    message: 'GitHub has incoming changes. Use Pull from GitHub in the branch menu, then publish again.',
  });
}
