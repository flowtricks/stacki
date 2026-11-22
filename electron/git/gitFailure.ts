// Turning what git printed into something a person can act on.
//
// Git speaks to someone at a terminal who knows what an index lock or a non-fast-forward is. In an editor the same words arrive as a
// red box with no next step, so each failure that has an obvious next step is recognised here and replaced by a sentence that names it.
// Anything unrecognised keeps git's own words (already stripped of the command line by `git()` in lib/nodeTools.ts): a plain message
// is better than a wrong sentence, and it is what a person would paste into a search.
//
// The patterns match git's English output, which is why `git()` sets LC_ALL=C for every child process.
//
// Applied at the IPC edge only (`explainingGitFailures`). The modules underneath keep matching raw output for their own questions
// (a merge that needs an answer, a branch that is not fully merged), and a failure that is already one of our sentences passes through.

import { toRecord } from '../../shared/core/record';
import { ReferencedError } from '../../shared/properties/i18n/referencedError';
import { referenceOfError } from '../../shared/core/i18n/referencedMessage';
import { gitErrorFull } from './git';

interface Recognition {
  readonly pattern: RegExp;
  readonly explain: (match: RegExpMatchArray) => ReferencedError;
}

// Order matters: the first match wins, so the specific wording comes before the general one.
const RECOGNITIONS: readonly Recognition[] = [
  {
    pattern: /Unable to create '([^']*index\.lock)': File exists|Another git process seems to be running/i,
    explain: () => new ReferencedError('git.error.locked'),
  },
  {
    pattern: /detected dubious ownership in repository at '([^']+)'/i,
    explain: (match) => new ReferencedError('git.error.unsafeDirectory', { path: match[1] ?? '' }),
  },
  {
    pattern: /Author identity unknown|Please tell me who you are|unable to auto-detect email address|empty ident name/i,
    explain: () => new ReferencedError('git.error.identityMissing'),
  },
  { pattern: /nothing to commit|no changes added to commit|nothing added to commit/i, explain: () => new ReferencedError('git.error.nothingToCommit') },
  {
    pattern: /cannot do a partial commit during a (merge|cherry-pick)|cannot do a partial commit/i,
    explain: () => new ReferencedError('git.error.operationInProgress', { operation: 'merge' }),
  },
  {
    pattern: /gpg failed to sign|failed to write commit object.*sign|error: gpg|ssh-keygen.*sign|signing failed/i,
    explain: () => new ReferencedError('git.error.signingFailed'),
  },
  {
    pattern:
      /Authentication failed|could not read Username|could not read Password|Permission denied \(publickey|Invalid username or password|terminal prompts disabled/i,
    explain: () => new ReferencedError('git.error.authFailed'),
  },
  {
    pattern:
      /Could not resolve host|unable to access|Network is unreachable|Connection timed out|Connection refused|Operation timed out|Could not read from remote repository/i,
    explain: () => new ReferencedError('git.error.offline'),
  },
  { pattern: /non-fast-forward|fetch first|\[rejected\]|failed to push some refs/i, explain: () => new ReferencedError('git.error.pushRejected') },
  {
    pattern: /does not appear to be a git repository|No such remote|No configured push destination/i,
    explain: () => new ReferencedError('git.error.noRemote'),
  },
  {
    pattern: /cannot lock ref '([^']+)': '([^']+)' exists|cannot lock ref .* there are .* ref|exists; cannot create/i,
    explain: (match) => new ReferencedError('git.error.branchNameConflict', { branch: match[1]?.replace(/^refs\/heads\//, '') ?? '' }),
  },
  { pattern: /not a valid branch name|is not a valid ref name|invalid reference/i, explain: () => new ReferencedError('git.error.branchNameInvalid') },
  { pattern: /already exists/i, explain: () => new ReferencedError('git.error.branchExists') },
  {
    pattern: /unfinished merge|You have not concluded your merge|MERGE_HEAD exists|rebase-merge|rebase-apply|cherry-pick is already in progress/i,
    explain: () => new ReferencedError('git.error.operationInProgress', { operation: 'merge' }),
  },
];

const timedOut = (error: unknown): boolean => {
  const record = toRecord(error);
  return record?.['killed'] === true || record?.['code'] === 'ETIMEDOUT';
};

const notInstalled = (error: unknown): boolean => toRecord(error)?.['code'] === 'ENOENT';

const outputTooLarge = (error: unknown): boolean => toRecord(error)?.['code'] === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

/**
 * The error to show for a failed git command: one of our own sentences when the failure is recognised, else the original error.
 * A failure that already carries a reference to one of our sentences is returned as it is, so a refusal is never explained twice.
 */
export function explainGitFailure(error: unknown): unknown {
  if (referenceOfError(error) !== undefined) {
    return error;
  }
  if (notInstalled(error)) {
    return new ReferencedError('git.error.notInstalled');
  }
  if (outputTooLarge(error)) {
    return new ReferencedError('git.error.outputTooLarge');
  }
  if (timedOut(error)) {
    return new ReferencedError('git.error.timedOut');
  }
  const words = gitErrorFull(error);
  for (const { pattern, explain } of RECOGNITIONS) {
    const match = pattern.exec(words);
    if (match !== null) {
      return explain(match);
    }
  }
  return error;
}

/** Runs one IPC handler body; a git failure it throws leaves as the sentence `explainGitFailure` chooses. */
export async function explainingGitFailures<Value>(work: () => Promise<Value>): Promise<Value> {
  try {
    return await work();
  } catch (error: unknown) {
    throw explainGitFailure(error);
  }
}
