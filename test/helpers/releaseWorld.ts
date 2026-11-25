// A scripted repository and GitHub for the release script tests: git, gh and npm answer from
// plain data, files live in a map, and every write is recorded instead of run. No test that uses
// it reaches git, GitHub, npm or the disk. Each test builds a world, changes the one fact it is
// about, and reads back the calls and writes the script made.
import type { CommandRequest, CommandRunner } from '../../scripts/release/releaseCommands.mts';
import type { RepositoryFiles } from '../../scripts/release/prepare.mts';
import { fail, ok, type Result } from '../../scripts/release/releaseResult.mts';
import { REQUIRED_CHECK_JOBS } from '../../scripts/release/releaseStatus.mts';
import type { WriteRequest, WriteRunner } from '../../scripts/release/releaseWrite.mts';

export const HEAD_SHA = 'a'.repeat(40);
export const BUMP_SHA = 'c'.repeat(40);

export interface CheckRunFixture {
  readonly id: number;
  readonly headSha: string;
  readonly status: string;
  readonly conclusion: string;
  readonly jobs: readonly { readonly name: string; readonly conclusion: string }[];
}

export interface World {
  headSha: string;
  branch: string;
  remoteMain: string;
  status: string;
  tags: string[];
  localTags: string[];
  subjects: string[];
  checkRuns: CheckRunFixture[];
  environment: Result<string>;
  files: Map<string, string>;
  // Files whose writes are silently dropped, to simulate a disk that does not keep them.
  droppedWrites: Set<string>;
  commits: { readonly paths: readonly string[]; readonly subject: string }[];
  writes: WriteRequest[];
  calls: string[];
  // What `git show --name-only HEAD` answers after a commit; defaults to the committed paths.
  committedPathsOverride: readonly string[] | undefined;
}

export function versionFiles(version: string): Map<string, string> {
  const packageJson = (name: string): string => `{\n  "name": "${name}",\n  "version": "${version}",\n  "scripts": {\n    "x": "y"\n  }\n}\n`;
  const lock = (name: string): string =>
    `{\n  "name": "${name}",\n  "version": "${version}",\n  "lockfileVersion": 3,\n  "requires": true,\n  "packages": {\n    "": {\n      "name": "${name}",\n      "version": "${version}",\n      "dependencies": {\n        "dep": "^1.0.0"\n      }\n    },\n    "node_modules/dep": {\n      "version": "1.2.3"\n    }\n  }\n}\n`;
  return new Map([
    ['package.json', packageJson('stacki')],
    ['package-lock.json', lock('stacki')],
    ['packages/create-stacki/package.json', packageJson('create-stacki')],
    ['studio/package.json', packageJson('@stacki/studio')],
    ['studio/package-lock.json', lock('@stacki/studio')],
    ['studio/src/shared/release.json', `{\n  "version": "${version}"\n}\n`],
    ['docs/releases.md', `# Releasing\n\nIntro text.\n\n## ${version} the last one\n\n- Old notes.\n`],
  ]);
}

export const GREEN_JOBS = REQUIRED_CHECK_JOBS.map((name) => ({ name, conclusion: 'success' }));

export function newWorld(): World {
  return {
    headSha: HEAD_SHA,
    branch: 'main',
    remoteMain: HEAD_SHA,
    status: '',
    tags: ['v1.4.2', 'v1.4.3'],
    localTags: [],
    subjects: [
      'fix(picker): reveal the arrowed row',
      'feat(release): one-button releases',
      'test(style): keep the harness clear',
      'chore(release): version 1.4.3',
    ],
    checkRuns: [{ id: 7, headSha: HEAD_SHA, status: 'completed', conclusion: 'success', jobs: GREEN_JOBS }],
    environment: ok(
      JSON.stringify({
        name: 'release',
        protection_rules: [{ type: 'required_reviewers', prevent_self_review: false, reviewers: [{ type: 'User', reviewer: { login: 'maintainer' } }] }],
      }),
    ),
    files: versionFiles('1.4.3'),
    droppedWrites: new Set(),
    commits: [],
    writes: [],
    calls: [],
    committedPathsOverride: undefined,
  };
}

function versionOf(world: World, path: string): string {
  const text = world.files.get(path) ?? '';
  return /"version": "([^"]+)"/.exec(text)?.[1] ?? '0.0.0';
}

function runJson(world: World, run: CheckRunFixture): object {
  return { databaseId: run.id, headSha: run.headSha, status: run.status, conclusion: run.conclusion, url: `https://example.test/runs/${run.id}` };
}

export function worldRunner(world: World): CommandRunner {
  return (request: CommandRequest) => {
    const line = `${request.command} ${request.argumentsList.join(' ')}`;
    world.calls.push(line);
    const [first, second] = request.argumentsList;
    if (request.command === 'git') {
      if (first === 'rev-parse' && request.argumentsList.includes('--abbrev-ref')) {
        return ok(`${world.branch}\n`);
      }
      if (first === 'rev-parse' && second === '--verify' && request.argumentsList[2] === '--quiet') {
        const tag = (request.argumentsList[3] ?? '').replace('refs/tags/', '');
        return world.localTags.includes(tag) ? ok('x\n') : fail('command-failed', 'not a tag');
      }
      if (first === 'rev-parse' && request.argumentsList.includes('HEAD~1^{commit}')) {
        return ok(`${HEAD_SHA}\n`);
      }
      if (first === 'rev-parse') {
        return ok(`${world.headSha}\n`);
      }
      if (first === 'status') {
        return ok(world.status);
      }
      if (first === 'ls-remote' && second === '--tags') {
        return ok(world.tags.map((tag, index) => `${String(index).repeat(40).slice(0, 40)}\trefs/tags/${tag}`).join('\n'));
      }
      if (first === 'ls-remote') {
        const tagRef = request.argumentsList.find((argument) => argument.startsWith('refs/tags/'));
        const lines = [`${world.remoteMain}\trefs/heads/main`];
        if (tagRef !== undefined && world.tags.includes(tagRef.replace('refs/tags/', ''))) {
          lines.push(`${world.headSha}\t${tagRef}`);
        }
        return ok(lines.join('\n'));
      }
      if (first === 'show' && second === '--name-only') {
        return ok((world.committedPathsOverride ?? world.commits.at(-1)?.paths ?? []).join('\n'));
      }
      if (first === 'show') {
        const path = (second ?? '').slice((second ?? '').indexOf(':') + 1);
        return ok(world.files.get(path) ?? '');
      }
      if (first === 'rev-list' && second === '--count') {
        return ok('0\n');
      }
      if (first === 'rev-list') {
        // After a bump commit, the commit the tests started from is its parent.
        return ok(world.headSha === HEAD_SHA ? `${HEAD_SHA}\n` : `${world.headSha}\n${HEAD_SHA}\n`);
      }
      if (first === 'diff') {
        return ok((world.commits.at(-1)?.paths ?? []).join('\n'));
      }
      if (first === 'log') {
        return ok(world.subjects.join('\n'));
      }
    }
    if (request.command === 'gh') {
      if (first === 'run' && second === 'list') {
        return ok(JSON.stringify(world.checkRuns.map((run) => runJson(world, run))));
      }
      if (first === 'run' && second === 'view') {
        const run = world.checkRuns.find((candidate) => String(candidate.id) === request.argumentsList[2]);
        return run === undefined
          ? fail('command-failed', 'no run')
          : ok(JSON.stringify({ jobs: run.jobs.map((job) => ({ name: job.name, status: 'completed', conclusion: job.conclusion })) }));
      }
      if (first === 'api' && (second ?? '').endsWith('/environments/release')) {
        return world.environment;
      }
    }
    return fail('command-failed', `unscripted: ${line} (version ${versionOf(world, 'package.json')})`);
  };
}

export function worldWriter(world: World): WriteRunner {
  // The world is the fake's mutable state by design: a write changes what later reads answer.
  const state = world;
  let staged: readonly string[] = [];
  return (request: WriteRequest) => {
    world.writes.push(request);
    const [first, ...rest] = request.argumentsList.filter((argument) => !argument.startsWith('credential.helper') && argument !== '-c');
    if (request.command === 'git' && first === 'add') {
      staged = rest.slice(1);
      return ok('');
    }
    if (request.command === 'git' && first === 'commit') {
      world.commits.push({ paths: staged, subject: rest[1] ?? '' });
      state.headSha = BUMP_SHA;
      return ok('');
    }
    if (request.command === 'git' && first === 'tag') {
      world.localTags.push(rest[0] ?? '');
      return ok('');
    }
    if (request.command === 'git' && first === 'push') {
      // The push lands: origin's main and the tag now name the bump commit.
      state.remoteMain = world.headSha;
      world.tags.push(...world.localTags);
      return ok('');
    }
    return ok('');
  };
}

export function worldFiles(world: World): RepositoryFiles {
  return {
    read: (path) => {
      const text = world.files.get(path);
      return text === undefined ? fail('file-read', `${path}: missing`) : ok(text);
    },
    write: (path, text) => {
      if (!world.droppedWrites.has(path)) {
        world.files.set(path, text);
      }
      return ok(undefined);
    },
  };
}
