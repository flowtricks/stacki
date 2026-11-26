// GitHub supplies the two commits so the check sees the PR authors' messages,
// including after a push, rather than the synthetic merge commit used to build.
import { spawnSync } from 'node:child_process';
import { commitMessageProblems, describeCommitMessageProblem } from './commitMessage.mts';

const COMMITS_MAX = 500;
const OUTPUT_BYTES_MAX = 16 * 1024 * 1024;
const GIT_TIMEOUT_MS = 15_000;
const COMMIT_SHA = /^[0-9a-f]{40}$/;

function main(base: string | undefined, head: string | undefined): number {
  if (base === undefined || head === undefined || !COMMIT_SHA.test(base) || !COMMIT_SHA.test(head)) {
    console.error('Provide the full base and head commit hashes.');
    return 1;
  }
  const log = spawnSync('git', ['log', '-z', '--format=%H%x00%B', `--max-count=${COMMITS_MAX + 1}`, `${base}..${head}`, '--'], {
    encoding: 'utf8',
    maxBuffer: OUTPUT_BYTES_MAX,
    timeout: GIT_TIMEOUT_MS,
  });
  if (log.status !== 0) {
    console.error('Could not read PR commits.', log.error?.message ?? log.stderr);
    return 1;
  }
  const records = log.stdout === '' ? [] : log.stdout.split('\0').slice(0, -1);
  if (records.length % 2 !== 0 || records.length > COMMITS_MAX * 2) {
    console.error(`Expected up to ${COMMITS_MAX} commit and message pairs.`);
    return 1;
  }
  let failed = false;
  for (let index = 0; index < records.length; index += 2) {
    const commit = records[index];
    const message = records[index + 1];
    if (commit === undefined || !COMMIT_SHA.test(commit) || message === undefined) {
      console.error('Git returned an invalid commit record.');
      return 1;
    }
    for (const problem of commitMessageProblems(message)) {
      console.error(`${commit.slice(0, 12)}: ${describeCommitMessageProblem(problem)}`);
      failed = true;
    }
  }
  return failed ? 1 : 0;
}

process.exitCode = main(process.argv[2], process.argv[3]);
