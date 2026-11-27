// How a site deploys to Netlify. Netlify's own files are read and never written.
//
// Two ways, chosen by the site:
// - netlify.toml names a build command: the CLI runs Netlify's build (that command, its plugins and headers), which
//   first clears .netlify/v1, so the command must produce the output again.
// - otherwise: Stacki's build, already run in the publish snapshot, is uploaded with --no-build. A Netlify build with
//   no command would clear the adapter's functions in .netlify/v1 and rebuild nothing.
// --dir is always passed unless netlify.toml names the publish folder of its own build: with no folder named, the CLI
// would upload the whole project.
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseTOML } from 'smol-toml';
import { assert } from '../../shared/core/assert';
import { record, text } from '../../shared/core/boundary';
import { toRecord } from '../../shared/core/record';
import { err, ok, type Result } from '../../shared/core/result';
import { described, type Described } from '../../shared/properties/i18n/messageRef';
import { DescribedError } from '../../shared/properties/describedError';
import { hostingCommand, type PublishCommand } from '../../shared/properties/publishCommands';
import type { NetlifyHosting } from '../../shared/properties/publishNetlify';
import { astroConfigSource, outputDirectory, siteFile } from './publishSiteBuild';
import { netlifyAPI } from './publishNetlifyCommand';
import { netlifyDeployProblem } from './publishNetlify';

const NETLIFY_ADAPTER = '@astrojs/netlify';
/** Astro adapters that build the site for another host. */
const OTHER_HOST_ADAPTERS = ['@astrojs/node', '@astrojs/vercel', '@astrojs/cloudflare', '@deno/astro-adapter'] as const;
// The deploy's JSON is the last object printed; a build log cannot start more lines with a brace than this is asked to try.
const RESULT_CANDIDATES_MAX = 64;
const IDENTIFIER_CHARS_MAX = 100;

export type NetlifyBuildPlan =
  // `directory` is absent when netlify.toml names the publish folder itself.
  { readonly kind: 'netlify-build'; readonly directory?: string } | { readonly kind: 'prebuilt'; readonly directory: string };

interface NetlifySettings {
  readonly command: boolean;
  readonly publish?: string;
  readonly base: string;
}

/** How this site would deploy, or why it cannot. Read before Publish builds anything, and again when it deploys. */
export async function netlifyBuildPlan(root: string, contexts: readonly string[] = ['production']): Promise<Result<NetlifyBuildPlan, Described>> {
  assert(path.isAbsolute(root), 'A Netlify deploy reads an absolute site folder');
  const settings = await netlifySettings(root, contexts);
  if (!settings.ok) {
    return settings;
  }
  const { command, publish, base } = settings.value;
  const config = await astroConfigSource(path.join(root, base));
  const adapter = adapterProblem(config ?? '');
  if (adapter !== undefined) {
    return err(adapter);
  }
  const named = publish ?? outputDirectory(config);
  const directory = named === undefined ? undefined : siteDirectory(base, named);
  if (directory === undefined) {
    return err(described('publish.netlify.error.outputFolder'));
  }
  if (!command) {
    return ok({ kind: 'prebuilt', directory });
  }
  return ok(publish === undefined ? { kind: 'netlify-build', directory } : { kind: 'netlify-build' });
}

export function netlifyDeployCommand(hosting: NetlifyHosting, plan: NetlifyBuildPlan): PublishCommand {
  const command = hostingCommand(hosting);
  switch (plan.kind) {
    case 'prebuilt':
      return { ...command, arguments: [...command.arguments, '--no-build', '--dir', plan.directory] };
    case 'netlify-build':
      return {
        ...command,
        // Netlify's build defaults to the `dev` context; a production deploy takes production's variables.
        arguments: [...command.arguments, '--context', 'production', ...(plan.directory === undefined ? [] : ['--dir', plan.directory])],
      };
    default: {
      const exhaustive: never = plan;
      return exhaustive;
    }
  }
}

/** One production deploy. `run` runs the CLI and returns what it printed to standard output. */
export async function deployNetlify(root: string, hosting: NetlifyHosting, run: (command: PublishCommand) => Promise<string>): Promise<void> {
  const plan = await netlifyBuildPlan(root);
  if (!plan.ok) {
    throw new DescribedError(plan.error);
  }
  if (plan.value.kind === 'prebuilt') {
    await requireBuildOutput(root, plan.value.directory);
  }
  // Asked first because `netlify deploy` run without a terminal CREATES a new site when it cannot read the one
  // named by --site (a deleted site, another account). It also reports a dead sign-in or an outage in plain words.
  await requireNetlifySite(root, hosting);
  const output = await run(netlifyDeployCommand(hosting, plan.value));
  const deployed = netlifyDeployResult(output);
  if (deployed === undefined) {
    throw new DescribedError(described('publish.netlify.error.unconfirmed'));
  }
  if (deployed.siteId !== hosting.siteId) {
    throw new DescribedError(described('publish.netlify.error.otherSite'));
  }
}

export async function requireNetlifySite(root: string, hosting: NetlifyHosting): Promise<void> {
  const site = await netlifyAPI(root, 'getSite', { site_id: hosting.siteId });
  if (!site.ok) {
    throw new DescribedError(netlifyDeployProblem(site.error));
  }
  // The API also answers to a site's domain; the deploy must name the id it confirms.
  if (toRecord(site.value)?.['id'] !== hosting.siteId) {
    throw new DescribedError(described('publish.netlify.error.siteNotFound'));
  }
}

/** The site and deploy ids `netlify deploy --json` prints after any build log, or undefined when it printed none. */
export function netlifyDeployResult(output: string): { readonly siteId: string; readonly deployId: string } | undefined {
  const starts = [...output.matchAll(/^\{/gm)].map((match) => match.index).slice(-RESULT_CANDIDATES_MAX);
  for (const start of starts.reverse()) {
    let value: unknown;
    try {
      value = JSON.parse(output.slice(start).trim());
    } catch {
      continue;
    }
    const fields = toRecord(value);
    const siteId = fields?.['site_id'];
    const deployId = fields?.['deploy_id'];
    if (typeof siteId === 'string' && typeof deployId === 'string') {
      if (siteId.length <= IDENTIFIER_CHARS_MAX && deployId.length > 0 && deployId.length <= IDENTIFIER_CHARS_MAX) {
        return { siteId, deployId };
      }
    }
  }
  return undefined;
}

// Another host's adapter, or on-demand rendering with no adapter, cannot run on Netlify.
function adapterProblem(config: string): Described | undefined {
  if (config.includes(NETLIFY_ADAPTER)) {
    return undefined;
  }
  if (OTHER_HOST_ADAPTERS.some((name) => config.includes(name))) {
    return described('publish.netlify.error.otherAdapter');
  }
  if (/\boutput\s*:\s*['"`]server['"`]/.test(config)) {
    return described('publish.netlify.error.adapterNeeded');
  }
  return undefined;
}

// netlify.toml's build settings, with the deploy's contexts winning, later ones over earlier, as they do for Netlify.
async function netlifySettings(root: string, contexts: readonly string[]): Promise<Result<NetlifySettings, Described>> {
  const filename = path.join(root, 'netlify.toml');
  const source = await siteFile(filename);
  if (source === undefined) {
    return existsSync(filename) ? err(described('publish.netlify.error.config')) : ok({ command: false, base: '' });
  }
  try {
    const file = record(parseTOML(source));
    const declared = optionalTable(file['context']);
    let build: Readonly<Record<string, unknown>> = optionalTable(file['build']);
    for (const context of contexts) {
      build = { ...build, ...optionalTable(declared[context]) };
    }
    const base = build['base'] === undefined ? '' : netlifyBase(text(build['base']));
    const command = build['command'] === undefined ? '' : text(build['command']);
    const publish = build['publish'] === undefined ? undefined : text(build['publish']);
    return ok({ command: command.trim() !== '', base, ...(publish === undefined ? {} : { publish }) });
  } catch {
    return err(described('publish.netlify.error.config'));
  }
}

function netlifyBase(input: string): string {
  if (input === '' || input === '/' || input === '.') {
    return '';
  }
  const base = siteDirectory('', input);
  if (base === undefined) {
    throw new Error('netlify.toml base must stay inside the project');
  }
  return base;
}

/** A folder inside the site, never the site itself: uploading the project root would publish its source. */
export function siteDirectory(base: string, input: string): string | undefined {
  if (input.length > 256) {
    return undefined;
  }
  const relative = input.replace(/^(?:\.\/|\/)+/, '');
  if (relative.split('/').includes('..')) {
    return undefined;
  }
  const folder = path.posix.normalize(relative).replace(/\/$/, '');
  if (folder === '' || folder === '.') {
    return undefined;
  }
  return base === '' ? folder : path.posix.join(base, folder);
}

export async function requireBuildOutput(root: string, directory: string): Promise<void> {
  const folder = path.join(root, directory);
  if (!existsSync(folder)) {
    throw new DescribedError(described('publish.netlify.error.outputFolder'));
  }
  const relative = path.relative(await realpath(root), await realpath(folder));
  if (relative === '' || path.isAbsolute(relative) || relative.split(path.sep).includes('..')) {
    throw new DescribedError(described('publish.netlify.error.outputFolder'));
  }
}

function optionalTable(input: unknown): Readonly<Record<string, unknown>> {
  return input === undefined ? {} : record(input);
}
