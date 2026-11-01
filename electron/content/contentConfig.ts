import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { spawn, type ChildProcess } from 'child_process';

import { toRecord, toArray } from '../../shared/core/record';
import { MAIN_LIMITS } from '../lib/mainLimits';
import { contentWorkerPath } from '../lib/runtimePaths';

// Reads a project's Astro content config — src/content.config.ts — and reports
// what collections it declares.
//
// The config is TypeScript, it imports a virtual module Astro provides
// (`astro:content`), it may import the project's own loaders through its path
// aliases, and its schemas are real zod objects rather than anything
// declarative. Parsing that as text would be guesswork; the only way to know
// what a schema says is to let zod tell us. So the config is bundled with
// esbuild — the project's own copy, with `astro:content` and `astro/loaders`
// pointed at the stubs in ./content — and run once in a child process, which
// prints a manifest and exits.
//
// A child process because this executes project code: a config that throws, or
// a loader factory that hangs, must not take the app with it.

const SENTINEL = '<<<stacki:content-config>>>';
const RUN_TIMEOUT = 20000;

const CONFIG_FILES = [
  'src/content.config.ts',
  'src/content.config.js',
  'src/content.config.mjs',
  'src/content.config.mts',
  // Where the config lived before Astro 5.
  'src/content/config.ts',
  'src/content/config.js',
  'src/content/config.mjs',
];

function configPathOf(projectPath: string): { abs: string; rel: string } | undefined {
  for (const rel of CONFIG_FILES) {
    const abs = path.join(projectPath, rel);
    if (fs.existsSync(abs)) {
      return { abs, rel };
    }
  }
  return undefined;
}

// `esbuild` comes with Vite, which comes with Astro, so any project that can
// build can do this. Resolving it from the project (rather than shipping our
// own) keeps us on the version the project already runs. The build surface
// used here is the one every esbuild version this app supports exposes.
interface ProjectEsbuild {
  build(options: Record<string, unknown>): Promise<{ metafile?: { inputs?: Record<string, unknown> } }>;
}

function isProjectEsbuild(input: unknown): input is ProjectEsbuild {
  const candidate = toRecord(input);
  return candidate !== undefined && candidate !== null && typeof candidate['build'] === 'function';
}

function esbuildOf(projectPath: string): ProjectEsbuild | undefined {
  const projectRequire = createRequire(path.join(projectPath, 'package.json'));
  for (const spec of ['esbuild', 'vite/node_modules/esbuild']) {
    try {
      const mod: unknown = projectRequire(spec);
      if (isProjectEsbuild(mod)) {
        return mod;
      }
    } catch {
      /* try the next */
    }
  }
  return undefined;
}

// The generated bundle lives in the project so that `astro/zod` — left
// external, so the config and our stubs share one zod instance — resolves
// against the project's node_modules.
const workDirectoryOf = (projectPath: string): string => path.join(projectPath, 'node_modules', '.stacki');

// The stubs are copied into the project rather than bundled from where they
// sit, because in a packaged build they sit inside app.asar, which esbuild (a
// separate binary) cannot read.
function stageRunner(projectPath: string, configAbs: string): { directory: string; entry: string } {
  const directory = workDirectoryOf(projectPath);
  fs.mkdirSync(directory, { recursive: true });
  for (const name of ['stubAstroContent.mjs', 'stubAstroLoaders.mjs', 'schemaTools.mjs', 'introspect.mjs']) {
    fs.writeFileSync(path.join(directory, name), fs.readFileSync(contentWorkerPath(name), 'utf8'), 'utf8');
  }
  const entry = path.join(directory, 'read-config.entry.mjs');
  fs.writeFileSync(
    entry,
    [
      `import { describe, validate } from ${JSON.stringify('./introspect.mjs')};`,
      `import * as config from ${JSON.stringify(configAbs)};`,
      `const S = ${JSON.stringify(SENTINEL)};`,
      // The config, or a loader it calls, may print. Every answer is prefixed,
      // so nothing the project says can be mistaken for one.
      'const send = (value) => process.stdout.write(S + JSON.stringify(value) + "\\n");',
      'send({ type: "manifest", value: describe(config) });',
      // The schemas stay loaded, and answer questions about entries until the
      // app has no more to ask. Re-reading the config for every keystroke would
      // cost a process spawn each time.
      'let buffer = "";',
      'process.stdin.on("data", (chunk) => {',
      '  buffer += chunk;',
      '  let at;',
      '  while ((at = buffer.indexOf("\\n")) >= 0) {',
      '    const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);',
      '    if (!line.trim()) continue;',
      '    let request;',
      '    try { request = JSON.parse(line); } catch { continue; }',
      '    try {',
      '      const value = request.op === "validate" ? validate(config, request) : ' + '{ error: "unknown request" };',
      '      send({ type: "reply", id: request.id, value });',
      '    } catch (err) {',
      '      send({ type: "reply", id: request.id, value: ' + '{ error: String(err && err.message || err) } });',
      '    }',
      '  }',
      '});',
      'process.stdin.resume();',
      '',
    ].join('\n'),
    'utf8',
  );
  return { directory, entry };
}

async function bundle(esbuild: ProjectEsbuild, projectPath: string, directory: string, entry: string): Promise<{ outfile: string; inputs: string[] }> {
  const outfile = path.join(directory, 'read-config.mjs');
  const tsconfig = ['tsconfig.json', 'jsconfig.json'].map((fileName) => path.join(projectPath, fileName)).find((candidate) => fs.existsSync(candidate));
  const result = await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    write: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    absWorkingDir: projectPath,
    // The project's aliases (`@/loaders/events.ts`) are how the config reaches
    // its own code.
    tsconfig,
    alias: {
      'astro:content': path.join(directory, 'stubAstroContent.mjs'),
      'astro/loaders': path.join(directory, 'stubAstroLoaders.mjs'),
    },
    // One zod, resolved from the project — the schemas the config builds have
    // to be the same objects our introspection walks.
    external: ['astro/zod', 'astro:*'],
    // A CommonJS dependency pulled in by a loader still calls require(), which
    // an ESM bundle has no such thing as. Give it one, resolving from where the
    // bundle sits — inside the project.
    banner: {
      js: ["import { createRequire as __stackiRequire } from 'node:module';", 'const require = __stackiRequire(import.meta.url);'].join('\n'),
    },
    logLevel: 'silent',
    // Which files went in, so the answer can be cached until one of them
    // changes.
    metafile: true,
    sourcemap: false,
  });
  return { outfile, inputs: Object.keys(result.metafile?.inputs ?? {}) };
}

// `esbuild` and Node both decorate what they print; the first real lines are the
// part that names what went wrong.
function cleanError(text: unknown): string {
  const lines = String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !/^at\s/.test(line) && !/^node:internal/.test(line));
  return lines.slice(0, 3).join(' ').slice(0, 500);
}

const stampOf = (projectPath: string, inputs: readonly string[]): string =>
  inputs
    .map((rel) => {
      try {
        const stat = fs.statSync(path.resolve(projectPath, rel));
        return `${rel}:${stat.mtimeMs}:${stat.size}`;
      } catch {
        return `${rel}:gone`;
      }
    })
    .join('|');

interface Pending {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
}

const RELOADED = 'The content config was reloaded.';

// One live process per project, holding the config's schemas in memory.
//
// Reading the config is the expensive half — a bundle and a process start —
// and validating an entry against a schema is the cheap half, which is asked
// for on every edit. So the process that read the config stays around to answer
// those, and is replaced when the config it read changes.
//
// The service owns its mutable state — the process, its pending requests and its timers — and
// changes it only through these methods.
class ConfigService {
  readonly projectPath: string;
  readonly configAbs: string;
  stopped = false;
  inputs: readonly string[] = [];
  stamp = '';
  ready: Promise<ConfigService> | undefined = undefined;
  manifest: unknown = undefined;
  private child: ChildProcess | undefined = undefined;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private stderr = '';
  private stdoutBuffer = '';
  private idle: NodeJS.Timeout | undefined = undefined;
  private timer: NodeJS.Timeout | undefined = undefined;
  private resolveManifest: ((value: unknown) => void) | undefined = undefined;
  private rejectManifest: ((error: unknown) => void) | undefined = undefined;

  constructor(projectPath: string, configAbs: string) {
    this.projectPath = projectPath;
    this.configAbs = configAbs;
  }

  stop(error: Error): void {
    if (this.stopped) {
      return;
    }
    // An old child's exit can arrive after its replacement starts. It must only
    // clean up its own requests and process, never the replacement's registry.
    if (services.get(this.projectPath) === this) {
      services.delete(this.projectPath);
    }
    this.stopped = true;
    clearTimeout(this.idle);
    clearTimeout(this.timer);
    this.rejectManifest?.(error);
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
    try {
      this.child?.kill();
    } catch {
      /* already gone */
    }
  }

  touch(): void {
    if (this.stopped) {
      return;
    }
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.stop(new Error(RELOADED)), IDLE_TIMEOUT);
    this.idle.unref?.();
  }

  async start(): Promise<ConfigService> {
    try {
      const outfile = await this.bundleRunner();
      const manifest = this.spawnRunner(outfile);
      this.manifest = await manifest;
      if (this.stopped) {
        throw new Error(RELOADED);
      }
      this.touch();
      return this;
    } catch (error: unknown) {
      this.stop(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      clearTimeout(this.timer);
    }
  }

  nextRequestId(): number {
    const id = this.nextId;
    this.nextId += 1;
    return id;
  }

  // One validation round trip. The caller serializes the message first: unsupported data must
  // not leave a request waiting for a reply to a message that was never written.
  request(message: string, id: number): Promise<Record<string, unknown>> {
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const finish = <T>(value: T, callback: (value: T) => void): void => {
        clearTimeout(timer);
        this.pending.delete(id);
        callback(value);
      };
      const timer = setTimeout(() => finish(new Error('Checking the entry timed out.'), reject), RUN_TIMEOUT);
      timer.unref?.();
      this.pending.set(id, {
        // The child's reply is an object or nothing; the boundary narrows it.
        resolve: (value) => finish(toRecord(value) ?? {}, resolve),
        reject: (error) => finish(error instanceof Error ? error : new Error(String(error)), reject),
      });
      try {
        this.child?.stdin?.write(message, (error) => {
          if (error) {
            this.pending.get(id)?.reject(error);
          }
        });
      } catch (error: unknown) {
        this.pending.get(id)?.reject(error);
      }
    });
  }

  // The runner bundled from the config and its inputs, or a throw that says why it cannot be.
  private async bundleRunner(): Promise<string> {
    const { projectPath, configAbs } = this;
    if (this.stopped) {
      throw new Error(RELOADED);
    }
    const esbuild = esbuildOf(projectPath);
    if (!esbuild) {
      throw new Error('Reading the content config needs the project dependencies installed.');
    }
    const { directory, entry } = stageRunner(projectPath, configAbs);
    const { outfile, inputs } = await bundle(esbuild, projectPath, directory, entry);
    // Closing a project while esbuild is running must not leave a new child
    // behind once the asynchronous build eventually finishes.
    if (this.stopped) {
      throw new Error(RELOADED);
    }
    this.inputs = inputs;
    this.stamp = stampOf(projectPath, inputs);
    return outfile;
  }

  // Starts the runner and answers with the manifest it prints first.
  private spawnRunner(outfile: string): Promise<unknown> {
    const child = spawn(process.execPath, [outfile], {
      cwd: this.projectPath,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      // The pipe tuple is what selects the overload with non-null streams.
      stdio: ['pipe', 'pipe', 'pipe'] as const,
    });
    this.child = child;
    const manifest = new Promise<unknown>((resolve, reject) => {
      this.resolveManifest = resolve;
      this.rejectManifest = reject;
    });
    const fail = (error: Error): void => this.stop(error);
    child.stdout.on('data', (chunk) => this.readStdout(chunk));
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk).slice(-MAIN_LIMITS.runnerStderrCharsMax);
    });
    child.on('error', fail);
    child.stdin.on('error', fail);
    child.on('exit', () => fail(new Error(cleanError(this.stderr) || 'The content config could not be read.')));
    this.timer = setTimeout(() => fail(new Error('Reading the content config timed out.')), RUN_TIMEOUT);
    this.timer.unref?.();
    return manifest;
  }

  private readStdout(chunk: unknown): void {
    this.stdoutBuffer += String(chunk);
    let at;
    while ((at = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, at);
      this.stdoutBuffer = this.stdoutBuffer.slice(at + 1);
      const start = line.indexOf(SENTINEL);
      if (start === -1) {
        continue;
      }
      let message: unknown;
      try {
        message = JSON.parse(line.slice(start + SENTINEL.length));
      } catch {
        continue;
      }
      const record = toRecord(message);
      if (!record) {
        continue;
      }
      if (record['type'] === 'manifest') {
        this.resolveManifest?.(record['value']);
      } else if (record['type'] === 'reply') {
        const id = record['id'];
        this.pending.get(typeof id === 'number' ? id : -1)?.resolve(record['value']);
      }
    }
    if (this.stdoutBuffer.length > MAIN_LIMITS.runnerLineCharsMax) {
      // What is left is one unfinished line. One that never ends is a runner
      // gone wrong, not a large reply.
      this.stop(new Error('The content config runner wrote a line past its limit.'));
    }
  }
}

// Project path to its service, including one still starting.
const services = new Map<string, ConfigService>();
const IDLE_TIMEOUT = 5 * 60 * 1000;

function stopService(projectPath: string): void {
  services.get(projectPath)?.stop(new Error(RELOADED));
}

// Publish the pending service before doing any asynchronous work. Readers and
// validation requests then share its bundle, process, and completed manifest.
function serviceFor(projectPath: string, { force = false }: { readonly force?: boolean } = {}): Promise<ConfigService | undefined> {
  const found = configPathOf(projectPath);
  const existing = services.get(projectPath);
  if (!found) {
    stopService(projectPath);
    return Promise.resolve(undefined);
  }
  if (existing && !force && existing.configAbs === found.abs && (!existing.manifest || existing.stamp === stampOf(projectPath, existing.inputs))) {
    const ready = existing.ready ?? Promise.reject(new Error(RELOADED));
    return ready.then((service) => {
      if (service.stopped) {
        throw new Error(RELOADED);
      }
      service.touch();
      return service;
    });
  }
  stopService(projectPath);
  const service = new ConfigService(projectPath, found.abs);
  services.set(projectPath, service);
  // A service in the map always has ready assigned just after construction;
  // the branch is for the compiler.
  service.ready = existing?.ready ? existing.ready.catch(() => undefined).then(() => service.start()) : service.start();
  return service.ready;
}

export type ContentConfigResult =
  | { readonly missing: true; readonly collections: unknown[] }
  | { readonly collections: unknown; readonly configPath: string }
  | { readonly collections: unknown[]; readonly configPath: string; readonly error: string };

/**
 * { collections: [...] } for a project, { missing: true } when it has no
 * content config, or { error } when the config could not be read.
 */
async function readContentConfig(projectPath: string, { force = false }: { readonly force?: boolean } = {}): Promise<ContentConfigResult> {
  const found = configPathOf(projectPath);
  if (!found) {
    stopService(projectPath);
    return { missing: true, collections: [] };
  }
  try {
    const service = await serviceFor(projectPath, { force });
    const manifest = toRecord(service?.manifest) ?? {};
    // The child's manifest is { collections }; everything else it prints is
    // noise the caller never read.
    return { collections: toArray(manifest['collections']) ?? [], configPath: found.rel };
  } catch (error: unknown) {
    return {
      collections: [],
      configPath: found.rel,
      error: cleanError(error instanceof Error ? error.message : error),
    };
  }
}

/**
 * Parses an entry's data with the collection's real schema, and reports what
 * zod says — including the rules that look at the whole entry rather than one
 * field, which are the ones a form cannot check on its own.
 */
async function validateEntry(
  projectPath: string,
  { collection, data }: { readonly collection: string; readonly data: unknown },
): Promise<Record<string, unknown>> {
  let service: ConfigService | undefined;
  try {
    service = await serviceFor(projectPath);
  } catch (error: unknown) {
    return { issues: [], error: cleanError(error instanceof Error ? error.message : error) };
  }
  if (!service) {
    return { issues: [], unchecked: true };
  }
  if (service.stopped) {
    return { issues: [], error: RELOADED };
  }
  service.touch();
  const id = service.nextRequestId();
  try {
    const message = JSON.stringify({ id, op: 'validate', collection, data }) + '\n';
    return await service.request(message, id);
  } catch (error: unknown) {
    return { issues: [], error: cleanError(error instanceof Error ? error.message : error) };
  }
}

const stopAllServices = (): void => {
  for (const projectPath of [...services.keys()]) {
    stopService(projectPath);
  }
};

export { readContentConfig, validateEntry, configPathOf, stopService, stopAllServices };
