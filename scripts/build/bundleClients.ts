// The two runtime scripts that cannot load modules, each bundled into the one
// file the app ships. The preload runs sandboxed, where `require` reaches only
// `electron`; the morph client reaches the canvas as one virtual module's text
// (electron/handlers/devServers.ts), where a relative import has no folder to
// resolve against. Their sources are modules all the same; this joins them.
//
//   node dist/scripts/build/bundleClients.js <preload|morph>
//
// tsc type-checks both (each under its own tsconfig, with --noEmit); this only
// emits. Every option is stated rather than left to esbuild's defaults, and the
// output is checked before the build counts as done: a bundle that would not
// load fails here, not in the canvas.
import esbuild = require('esbuild');
import fileSystem = require('node:fs');
import path = require('node:path');
import { repositoryRoot } from '../lib/repoRoot';

const CLIENTS = ['preload', 'morph'] as const;
type Client = (typeof CLIENTS)[number];

interface ClientBuild {
  readonly entry: string;
  readonly outfile: string;
  readonly format: 'cjs' | 'esm';
  readonly external: readonly string[];
  /** What is wrong with the bundle's text; empty when it can ship. */
  readonly problems: (text: string) => readonly string[];
}

const BUILDS: Readonly<Record<Client, ClientBuild>> = {
  preload: {
    entry: 'electron/preload/preload.ts',
    outfile: 'dist/electron/preload/preload.js',
    format: 'cjs',
    external: ['electron'],
    problems: preloadProblems,
  },
  morph: {
    entry: 'electron/previewClient/morphClient.ts',
    outfile: 'dist/electron/previewClient/morphClient.js',
    format: 'esm',
    external: [],
    problems: morphProblems,
  },
};

// The sandbox's require answers only for electron; anything else throws as the
// preload loads, in every frame.
function preloadProblems(text: string): readonly string[] {
  const required = [...text.matchAll(/\brequire\(\s*["']([^"']+)["']\s*\)/g)].map((match) => match[1]);
  const problems: string[] = [];
  if (required.length === 0) {
    problems.push('the preload requires nothing, so it cannot reach electron');
  }
  for (const name of required) {
    if (name !== 'electron') {
      problems.push(`the sandboxed preload requires ${String(name)}`);
    }
  }
  return problems;
}

// One module's text with nothing to import; the limits it reads are prepended
// by main as a constant it must not define itself; and it listens on Vite's
// HMR channel, which only a literal import.meta.hot reaches.
function morphProblems(text: string): readonly string[] {
  const problems: string[] = [];
  if (/^\s*import[\s{*'"]/m.test(text)) {
    problems.push('the morph client imports a module, which its virtual module cannot resolve');
  }
  if (/\bAVB_PREVIEW_LIMITS\s*=/.test(text)) {
    problems.push('the morph client defines AVB_PREVIEW_LIMITS, which main prepends');
  }
  if (!text.includes('import.meta.hot')) {
    problems.push('the morph client no longer listens on import.meta.hot');
  }
  return problems;
}

function bundle(client: Client): void {
  const root = repositoryRoot();
  const build = BUILDS[client];
  const outfile = path.resolve(root, build.outfile);
  esbuild.buildSync({
    entryPoints: [path.resolve(root, build.entry)],
    outfile,
    bundle: true,
    format: build.format,
    platform: 'browser',
    target: 'es2022',
    external: [...build.external],
    // Readable output: names stay, nothing is minified, and no source map is
    // written. Comments go, because nothing reads them in the shipped file.
    minify: false,
    keepNames: false,
    sourcemap: false,
    legalComments: 'none',
    treeShaking: true,
    charset: 'utf8',
    write: true,
    logLevel: 'warning',
  });
  const problems = build.problems(fileSystem.readFileSync(outfile, 'utf8'));
  if (problems.length > 0) {
    throw new Error(`${build.outfile} cannot ship:\n  ${problems.join('\n  ')}`);
  }
}

function clientOf(argument: string | undefined): Client {
  const client = CLIENTS.find((name) => name === argument);
  if (client === undefined) {
    throw new Error(`usage: bundleClients <${CLIENTS.join('|')}>; got ${String(argument)}`);
  }
  return client;
}

try {
  bundle(clientOf(process.argv[2]));
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
