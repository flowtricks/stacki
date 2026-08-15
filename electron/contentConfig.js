const fs = require('fs');
const path = require('path');
const { createRequire } = require('module');
const { spawn } = require('child_process');

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

function configPathOf(projectPath) {
  for (const rel of CONFIG_FILES) {
    const abs = path.join(projectPath, rel);
    if (fs.existsSync(abs)) return { abs, rel };
  }
  return null;
}

// esbuild comes with Vite, which comes with Astro, so any project that can
// build can do this. Resolving it from the project (rather than shipping our
// own) keeps us on the version the project already runs.
function esbuildOf(projectPath) {
  const req = createRequire(path.join(projectPath, 'package.json'));
  for (const spec of ['esbuild', 'vite/node_modules/esbuild']) {
    try {
      return req(spec);
    } catch {
      /* try the next */
    }
  }
  return null;
}

// The generated bundle lives in the project so that `astro/zod` — left
// external, so the config and our stubs share one zod instance — resolves
// against the project's node_modules.
const workDirOf = (projectPath) => path.join(projectPath, 'node_modules', '.stacki');

// The stubs are copied into the project rather than bundled from where they
// sit, because in a packaged build they sit inside app.asar, which esbuild (a
// separate binary) cannot read.
function stageRunner(projectPath, configAbs) {
  const dir = workDirOf(projectPath);
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ['stub-astro-content.mjs', 'stub-astro-loaders.mjs', 'introspect.mjs']) {
    fs.writeFileSync(
      path.join(dir, name),
      fs.readFileSync(path.join(__dirname, 'content', name), 'utf8'),
      'utf8'
    );
  }
  const entry = path.join(dir, 'read-config.entry.mjs');
  fs.writeFileSync(
    entry,
    [
      `import { describe } from ${JSON.stringify('./introspect.mjs')};`,
      `import * as config from ${JSON.stringify(configAbs)};`,
      // The config, or a loader it calls, may print. The manifest is whatever
      // follows the last sentinel, so nothing it says can be mistaken for it.
      `process.stdout.write(${JSON.stringify(SENTINEL)} + JSON.stringify(describe(config)));`,
      '',
    ].join('\n'),
    'utf8'
  );
  return { dir, entry };
}

async function bundle(esbuild, projectPath, dir, entry) {
  const outfile = path.join(dir, 'read-config.mjs');
  const tsconfig = ['tsconfig.json', 'jsconfig.json']
    .map((n) => path.join(projectPath, n))
    .find((p) => fs.existsSync(p));
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
      'astro:content': path.join(dir, 'stub-astro-content.mjs'),
      'astro/loaders': path.join(dir, 'stub-astro-loaders.mjs'),
    },
    // One zod, resolved from the project — the schemas the config builds have
    // to be the same objects our introspection walks.
    external: ['astro/zod', 'astro:*'],
    // A CommonJS dependency pulled in by a loader still calls require(), which
    // an ESM bundle has no such thing as. Give it one, resolving from where the
    // bundle sits — inside the project.
    banner: {
      js: [
        "import { createRequire as __stackiRequire } from 'node:module';",
        'const require = __stackiRequire(import.meta.url);',
      ].join('\n'),
    },
    logLevel: 'silent',
    // Which files went in, so the answer can be cached until one of them
    // changes.
    metafile: true,
    sourcemap: false,
  });
  return { outfile, inputs: Object.keys(result.metafile?.inputs || {}) };
}

function run(projectPath, bundlePath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bundlePath], {
      cwd: projectPath,
      // Electron's own binary, told to behave as node, so this works the same
      // in a packaged app as it does in development.
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Reading the content config timed out.'));
    }, RUN_TIMEOUT);
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err = (err + chunk).slice(-4000)));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const at = out.lastIndexOf(SENTINEL);
      if (at === -1) {
        reject(new Error(cleanError(err) || 'The content config produced no output.'));
        return;
      }
      try {
        resolve(JSON.parse(out.slice(at + SENTINEL.length)));
      } catch (error) {
        reject(new Error(`Could not read the content config — ${error.message}`));
      }
    });
  });
}

// esbuild and node both decorate what they print; the first real lines are the
// part that names what went wrong.
function cleanError(text) {
  const lines = String(text || '')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^at\s/.test(l) && !/^node:internal/.test(l));
  return lines.slice(0, 3).join(' ').slice(0, 500);
}

const stampOf = (projectPath, inputs) =>
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

const cache = new Map(); // projectPath -> { stamp, inputs, value }

/**
 * { collections: [...] } for a project, { missing: true } when it has no
 * content config, or { error } when the config could not be read. Cached until
 * the config — or anything it imports — changes on disk.
 */
async function readContentConfig(projectPath, { force = false } = {}) {
  const found = configPathOf(projectPath);
  if (!found) return { missing: true, collections: [] };

  const cached = cache.get(projectPath);
  if (!force && cached && cached.stamp === stampOf(projectPath, cached.inputs)) {
    return cached.value;
  }

  const esbuild = esbuildOf(projectPath);
  if (!esbuild) {
    return {
      collections: [],
      configPath: found.rel,
      error: 'Reading the content config needs the project dependencies installed.',
    };
  }

  try {
    const { dir, entry } = stageRunner(projectPath, found.abs);
    const { outfile, inputs } = await bundle(esbuild, projectPath, dir, entry);
    const manifest = await run(projectPath, outfile);
    const value = { ...manifest, configPath: found.rel };
    cache.set(projectPath, { stamp: stampOf(projectPath, inputs), inputs, value });
    return value;
  } catch (err) {
    // Not cached: a config that fails to read is usually a config being
    // edited, and the next call should try again.
    cache.delete(projectPath);
    return { collections: [], configPath: found.rel, error: cleanError(err.message) };
  }
}

module.exports = { readContentConfig, configPathOf };
