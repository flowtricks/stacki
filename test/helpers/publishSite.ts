// A temporary site for publishing tests: a Git repository whose GitHub origin is rewritten to a local bare
// repository, stand-in deploy CLIs that only record how they were called, and a stand-in for the computer's
// encryption. Nothing here opens a network connection or signs in anywhere.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { waitFor } from './waitFor.js';
import { git, setToolPathHome } from '#dist/electron/lib/nodeTools.js';
import type { DesktopPublisher } from '#dist/electron/project/publisher.js';
import { DeployLinkStore } from '#dist/electron/project/deployLinkStore.js';
import { list, record, text } from '#dist/shared/core/boundary.js';

setToolPathHome(os.homedir());

export const REPOSITORY_URL = 'https://github.com/example/fixture.git';

// Records each run of a package script: its name and the variables Stacki promises scripts.
const RECORD_SCRIPT = `const fs = require('node:fs');
const names = ['STACKI_PUBLISH_ENV', 'STACKI_PUBLISH_TARGET', 'CLOUDFLARE_ENV', 'WRANGLER_CI_OVERRIDE_NAME'];
const env = Object.fromEntries(names.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])));
fs.appendFileSync(LOG, JSON.stringify({ tool: 'script', argv: [process.argv[2]], env }) + '\\n');
fs.mkdirSync('dist', { recursive: true });
fs.writeFileSync('dist/index.html', process.argv[2]);
if (process.argv[2] === 'broken') process.exit(7);
`;

const FAKE_CLI = `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
const names = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_ENV', 'WRANGLER_CI_OVERRIDE_NAME', 'STACKI_PUBLISH_ENV', 'VERCEL_PROJECT_ID', 'VERCEL_ORG_ID'];
const env = Object.fromEntries(names.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])));
const at = argv.indexOf('--config');
const config = at === -1 ? undefined : JSON.parse(fs.readFileSync(argv[at + 1], 'utf8'));
fs.appendFileSync(LOG, JSON.stringify({ tool: TOOL, argv, env, config }) + '\\n');
if (TOOL === 'netlify') process.stdout.write(JSON.stringify({ site_id: argv[argv.indexOf('--site') + 1], deploy_id: 'draft1', deploy_url: 'https://draft1--site.netlify.app' }, null, 2));
if (TOOL === 'vercel') process.stdout.write('https://site-abc123.vercel.app');
if (TOOL === 'wrangler') process.stdout.write('Deployed\\n  https://staging.site.pages.dev\\n');
`;

export interface ToolCall {
  readonly tool: string;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, unknown>>;
  readonly config: Readonly<Record<string, unknown>> | undefined;
}

export interface SiteOptions {
  readonly publish: Readonly<Record<string, unknown>>;
  readonly destinations?: Readonly<Record<string, unknown>>;
  readonly files?: Readonly<Record<string, string>>;
  readonly scripts?: readonly string[];
}

const DEFAULT_SCRIPTS = ['build', 'build:staging', 'before', 'after', 'ship', 'deploy', 'deploy:staging', 'staging-before', 'broken'];

export async function publishSite(context: TestContext, options: SiteOptions) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-custom-publish-')));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'site');
  const remote = path.join(directory, 'remote.git');
  const userData = path.join(directory, 'user-data');
  const log = path.join(directory, 'calls.jsonl');
  for (const folder of [root, remote, userData, path.join(root, '.stacki'), path.join(root, 'node_modules', '.bin')]) {
    fs.mkdirSync(folder, { recursive: true });
  }
  const scripts = Object.fromEntries((options.scripts ?? DEFAULT_SCRIPTS).map((name) => [name, `node record.cjs ${name}`]));
  write(root, 'package.json', JSON.stringify({ scripts }));
  write(root, 'record.cjs', RECORD_SCRIPT.replaceAll('LOG', JSON.stringify(log)));
  write(root, '.gitignore', 'node_modules/\ndist/\n');
  write(root, '.stacki/publish.json', JSON.stringify(options.publish));
  if (options.destinations !== undefined) {
    write(root, '.stacki/publish-destinations.json', JSON.stringify(options.destinations));
  }
  for (const [name, content] of Object.entries(options.files ?? {})) {
    write(root, name, content);
  }
  for (const tool of ['wrangler', 'netlify', 'vercel']) {
    installFakeCLI(root, tool, log);
  }
  await git(root, ['init', '--initial-branch=main']);
  await git(root, ['config', 'user.name', 'Publishing Test']);
  await git(root, ['config', 'user.email', 'publishing@example.test']);
  await git(root, ['add', '--all']);
  await git(root, ['commit', '--quiet', '--message', 'Initial']);
  await git(remote, ['init', '--bare', '--initial-branch=main']);
  await git(root, ['remote', 'add', 'origin', REPOSITORY_URL]);
  await git(root, ['config', `url.${remote}.insteadOf`, REPOSITORY_URL]);
  await git(root, ['push', '--quiet', REPOSITORY_URL, 'main']);
  return {
    root,
    remote,
    userData,
    directory,
    calls: (): readonly ToolCall[] => readCalls(log),
    forget: () => fs.rmSync(log, { force: true }),
    refs: async () => (await git(remote, ['for-each-ref', '--format=%(refname) %(objectname)'])).stdout.trim(),
    revision: async (repository: string, name: string) => (await git(repository, ['rev-parse', name])).stdout.trim(),
  };
}

export function write(root: string, name: string, content: string): void {
  fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
  fs.writeFileSync(path.join(root, name), content);
}

// The site's own copy of each CLI, the one every Stacki lookup prefers, so no installed tool can run.
function installFakeCLI(root: string, tool: string, log: string): void {
  const packageName = tool === 'netlify' ? 'netlify-cli' : tool;
  const home = path.join(root, 'node_modules', packageName);
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'package.json'), JSON.stringify({ name: packageName, version: '1.0.0', bin: { [tool]: 'run.cjs' } }));
  fs.writeFileSync(path.join(home, 'run.cjs'), FAKE_CLI.replaceAll('LOG', JSON.stringify(log)).replaceAll('TOOL', JSON.stringify(tool)), { mode: 0o755 });
  if (process.platform !== 'win32') {
    fs.symlinkSync(path.join('..', packageName, 'run.cjs'), path.join(root, 'node_modules', '.bin', tool));
  }
}

function readCalls(log: string): readonly ToolCall[] {
  if (!fs.existsSync(log)) {
    return [];
  }
  return fs
    .readFileSync(log, 'utf8')
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const input: unknown = JSON.parse(line);
      const call = record(input);
      return {
        tool: text(call['tool']),
        argv: list(text)(call['argv']),
        env: record(call['env']),
        config: call['config'] === undefined ? undefined : record(call['config']),
      };
    });
}

/** The scripts that ran, in order. */
export function scriptsRun(calls: readonly ToolCall[]): readonly string[] {
  return calls.filter((call) => call.tool === 'script').map((call) => call.argv[0] ?? '');
}

export function deployCalls(calls: readonly ToolCall[]): readonly ToolCall[] {
  return calls.filter((call) => call.tool !== 'script');
}

export async function finished(publisher: DesktopPublisher, root: string) {
  return waitFor({
    what: 'the publish to finish',
    read: () => publisher.state(root),
    until: (state) => state.kind !== 'running',
    pollIntervalMs: 20,
    pollCountMax: 3000,
  });
}

/** Stands in for the operating system's encryption: reversible, and never leaves the text readable in the file. */
export function fakeLinkStore(userData: string, options: { readonly available: boolean } = { available: true }): DeployLinkStore {
  const scramble = (data: Buffer) => Buffer.from(data.map((byte) => byte ^ 0x5a));
  return new DeployLinkStore(
    {
      available: () => options.available,
      encrypt: (value) => scramble(Buffer.from(value, 'utf8')),
      decrypt: (data) => scramble(data).toString('utf8'),
    },
    () => userData,
  );
}

export function filesUnder(folder: string, skip: readonly string[] = []): readonly string[] {
  return fs
    .readdirSync(folder, { recursive: true, encoding: 'utf8' })
    .filter((name) => !skip.some((part) => name.split(path.sep).includes(part)))
    .map((name) => path.join(folder, name))
    .filter((file) => fs.lstatSync(file).isFile());
}
