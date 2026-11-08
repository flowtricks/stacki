// One `astro build` for the bake, run in a child process. A build that fails part-way
// leaves Vite's servers and watchers open, and a component probe that throws is
// exactly such a failure; in the bake's own process those handles would keep the
// bake from ever exiting. A child is ended once it has answered, so whatever the
// build left open goes with it. The child is this same file (or the bundle that holds
// it), started with BAKE_CHILD_COMMAND as its first argument.
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { err, ok, type Result } from '../../../vendor/stacki/shared/core/result';
import { assert } from '../../../vendor/stacki/shared/core/assert';
import { record } from '../../shared/validation';
import { bakeIntegration } from './bakeIntegration';
import { parseBakedContent, readContent, type BakedContent } from './bakeContent';
import { parseTemplateOutputs, type TemplateOutput } from './bakeTemplates';

export const BAKE_CHILD_COMMAND = '__stacki-bake-build';
/** A site's build is minutes at most; past this the child is ended and the bake fails. */
const BUILD_TIMEOUT_MS = 30 * 60_000;
const PROBE_PAGES_MAX = 2_000;

export type BakeError = { readonly code: string; readonly message: string };

/** Everything the child needs, as plain data: it builds its own integration from it. */
export interface BuildRequest {
  readonly root: string;
  readonly base: string;
  readonly outDir: string;
  /** Probe markup by page file. */
  readonly probes: readonly (readonly [string, string])[];
  readonly recipes: readonly { readonly pattern: string; readonly entrypoint: string }[];
  /** Whether to read the site's content collections once the build is done. */
  readonly content: boolean;
}

interface BuildReply {
  readonly ok: boolean;
  readonly message: string;
  readonly route: string | undefined;
  readonly content?: unknown;
  readonly templates?: unknown;
}

/** A finished build, and the content collections when they were asked for. */
export interface BuildDone {
  readonly content: BakedContent | undefined;
  /** Each template page's documents, in the order the build wrote them. */
  readonly templates: readonly TemplateOutput[];
}

/** Whether Astro can be loaded from the project, checked before any build starts. */
export function astroEntry(root: string): Result<string, BakeError> {
  try {
    return ok(createRequire(path.join(root, 'package.json')).resolve('astro'));
  } catch {
    return err({ code: 'astro-missing', message: `Astro is not installed in ${root}. Run npm install there first.` });
  }
}

export function runBuild(request: BuildRequest): Promise<Result<BuildDone, BakeError>> {
  assert(path.isAbsolute(request.root), 'The build root is absolute');
  assert(request.probes.length <= PROBE_PAGES_MAX, 'Probe pages stay within their limit');
  return new Promise((resolve) => {
    const child = fork(fileURLToPath(import.meta.url), [BAKE_CHILD_COMMAND], { cwd: request.root, stdio: 'inherit' });
    let settled = false;
    const finish = (result: Result<BuildDone, BakeError>) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        child.kill();
        resolve(result);
      }
    };
    const timer = setTimeout(() => finish(err({ code: 'build-timeout', message: 'astro build did not finish in time' })), BUILD_TIMEOUT_MS);
    child.once('message', (message: unknown) => finish(replyResult(message)));
    child.once('error', (error) => finish(err({ code: 'build-failed', message: `astro build could not start: ${String(error)}` })));
    child.once('exit', (code) => finish(err({ code: 'build-failed', message: `astro build ended without an answer (exit ${String(code)})` })));
    child.send(request);
  });
}

function replyResult(message: unknown): Result<BuildDone, BakeError> {
  const data = record(message);
  if (data['ok'] === true) {
    return ok({ content: parseBakedContent(data['content']), templates: parseTemplateOutputs(data['templates']) });
  }
  const route = typeof data['route'] === 'string' ? data['route'] : undefined;
  const text = typeof data['message'] === 'string' ? data['message'] : 'unknown error';
  return err({ code: 'build-failed', message: `astro build failed${route === undefined ? '' : ` rendering ${route} `}: ${text}` });
}

// `compressHTML` would drop the marker comments. `cssTarget: false` keeps Vite from
// lowering CSS through a pass that hoists every same-named `@layer` into its first
// occurrence, which would erase the boundary between `<style>` blocks. Both apply
// to this build alone. Stylesheets stay links so every one passes through `bakePage`.
function buildConfig(request: BuildRequest, templates: (outputs: readonly TemplateOutput[]) => void): Record<string, unknown> {
  const probes = new Map(request.probes);
  return {
    root: request.root,
    outDir: request.outDir,
    base: request.base,
    compressHTML: false,
    build: { inlineStylesheets: 'never' },
    logLevel: 'warn',
    vite: { build: { cssMinify: false, cssTarget: false } },
    integrations: [bakeIntegration({ root: request.root, base: request.base, probes: (file) => probes.get(file), recipes: request.recipes, templates })],
  };
}

const FAILED_ROUTE = /Caught error rendering (\/\S*?):/;
const ESCAPE = String.fromCharCode(27);

/** Astro names the page that failed only in its log, never in the error it throws; the
 * bake's retry needs that name. The log still reaches the terminal as it was. */
function watchFailedRoute(): () => string | undefined {
  let route: string | undefined;
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      const text = String(chunk).split(ESCAPE).join('');
      route ??= FAILED_ROUTE.exec(text.replace(/\[[0-9;]*m/g, ''))?.[1];
      return Reflect.apply(original, stream, [chunk, ...rest]) as boolean;
    }) as typeof stream.write;
  }
  return () => route;
}

function parseRequest(input: unknown): BuildRequest {
  const data = record(input);
  const text = (value: unknown): string => {
    if (typeof value !== 'string') {
      throw new Error('Bake build request: expected text');
    }
    return value;
  };
  const list = (value: unknown): readonly unknown[] => {
    if (!Array.isArray(value) || value.length > PROBE_PAGES_MAX) {
      throw new Error('Bake build request: expected a bounded list');
    }
    return value;
  };
  return {
    root: text(data['root']),
    base: text(data['base']),
    outDir: text(data['outDir']),
    probes: list(data['probes']).map((entry) => {
      const pair = list(entry);
      return [text(pair[0]), text(pair[1])] as const;
    }),
    recipes: list(data['recipes']).map((entry) => {
      const recipe = record(entry);
      return { pattern: text(recipe['pattern']), entrypoint: text(recipe['entrypoint']) };
    }),
    content: data['content'] === true,
  };
}

async function child(input: unknown): Promise<BuildReply> {
  const request = parseRequest(input);
  const entry = astroEntry(request.root);
  if (!entry.ok) {
    return { ok: false, message: entry.error.message, route: undefined };
  }
  const build = record(await import(pathToFileURL(entry.value).href))['build'];
  if (typeof build !== 'function') {
    return { ok: false, message: 'This Astro version has no build API', route: undefined };
  }
  const failedRoute = watchFailedRoute();
  let templates: readonly TemplateOutput[] = [];
  try {
    await Reflect.apply(build, undefined, [buildConfig(request, (outputs) => (templates = outputs))]);
    return { ok: true, message: '', route: undefined, content: request.content ? await readContent(request.root) : undefined, templates };
  } catch (error: unknown) {
    return { ok: false, message: String(error), route: failedRoute() };
  }
}

// The child's side. It answers once and exits, leaving nothing of the build behind.
if (process.argv[2] === BAKE_CHILD_COMMAND && process.send !== undefined) {
  process.once('message', (message: unknown) => {
    void child(message)
      .catch((error: unknown) => ({ ok: false, message: String(error), route: undefined }))
      .then((reply) => process.send?.(reply, () => process.exit(0)));
  });
}
