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
      '      const value = request.op === "validate" ? validate(config, request) : { error: "unknown request" };',
      '      send({ type: "reply", id: request.id, value });',
      '    } catch (err) {',
      '      send({ type: "reply", id: request.id, value: { error: String(err && err.message || err) } });',
      '    }',
      '  }',
      '});',
      'process.stdin.resume();',
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

// One live process per project, holding the config's schemas in memory.
//
// Reading the config is the expensive half — a bundle and a process start —
// and validating an entry against a schema is the cheap half, which is asked
// for on every edit. So the process that read the config stays around to answer
// those, and is replaced when the config it read changes.
const services = new Map(); // projectPath -> service
const IDLE_TIMEOUT = 5 * 60 * 1000;

function stopService(projectPath) {
  const service = services.get(projectPath);
  if (!service) return;
  services.delete(projectPath);
  clearTimeout(service.idle);
  for (const pending of service.pending.values()) pending.reject(new Error('The content config was reloaded.'));
  service.pending.clear();
  try {
    service.child.kill();
  } catch {
    /* already gone */
  }
}

function touch(service) {
  clearTimeout(service.idle);
  // Nothing to answer for a while: let the process go, and pay for the next one
  // when it is actually needed.
  service.idle = setTimeout(() => stopService(service.projectPath), IDLE_TIMEOUT);
  if (service.idle.unref) service.idle.unref();
}

async function startService(projectPath, configAbs) {
  const esbuild = esbuildOf(projectPath);
  if (!esbuild) throw new Error('Reading the content config needs the project dependencies installed.');

  const { dir, entry } = stageRunner(projectPath, configAbs);
  const { outfile, inputs } = await bundle(esbuild, projectPath, dir, entry);

  const child = spawn(process.execPath, [outfile], {
    cwd: projectPath,
    // Electron's own binary, told to behave as node, so this works the same in
    // a packaged app as it does in development.
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Deliberately not unref'd: the pipes are what carry the answers, and a
  // process with nothing else to do would exit mid-question. Callers outside
  // the app end with stopAllServices(); inside it, the idle timer does.
  const service = {
    projectPath,
    child,
    inputs,
    stamp: stampOf(projectPath, inputs),
    pending: new Map(),
    nextId: 1,
    stderr: '',
    idle: null,
  };
  services.set(projectPath, service);

  const manifest = new Promise((resolve, reject) => {
    service.resolveManifest = resolve;
    service.rejectManifest = reject;
  });

  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      const start = line.indexOf(SENTINEL);
      if (start === -1) continue; // something the project printed
      let message;
      try {
        message = JSON.parse(line.slice(start + SENTINEL.length));
      } catch {
        continue;
      }
      if (message.type === 'manifest') service.resolveManifest(message.value);
      else if (message.type === 'reply') {
        const pending = service.pending.get(message.id);
        if (pending) {
          service.pending.delete(message.id);
          pending.resolve(message.value);
        }
      }
    }
  });
  child.stderr.on('data', (chunk) => (service.stderr = (service.stderr + chunk).slice(-4000)));
  child.on('error', (err) => service.rejectManifest(err));
  child.on('exit', () => {
    service.rejectManifest(new Error(cleanError(service.stderr) || 'The content config could not be read.'));
    stopService(projectPath);
  });

  const timer = setTimeout(() => {
    service.rejectManifest(new Error('Reading the content config timed out.'));
    stopService(projectPath);
  }, RUN_TIMEOUT);
  if (timer.unref) timer.unref();

  try {
    service.manifest = await manifest;
  } finally {
    clearTimeout(timer);
  }
  touch(service);
  return service;
}

// The service for a project, started or restarted as needed. Restarted when
// anything the config imports has changed on disk since it was read.
async function serviceFor(projectPath, { force = false } = {}) {
  const existing = services.get(projectPath);
  if (existing && !force && existing.stamp === stampOf(projectPath, existing.inputs)) {
    touch(existing);
    return existing;
  }
  if (existing) stopService(projectPath);
  const found = configPathOf(projectPath);
  if (!found) return null;
  return startService(projectPath, found.abs);
}

/**
 * { collections: [...] } for a project, { missing: true } when it has no
 * content config, or { error } when the config could not be read.
 */
async function readContentConfig(projectPath, { force = false } = {}) {
  const found = configPathOf(projectPath);
  if (!found) return { missing: true, collections: [] };
  try {
    const service = await serviceFor(projectPath, { force });
    return { ...service.manifest, configPath: found.rel };
  } catch (err) {
    return { collections: [], configPath: found.rel, error: cleanError(err.message) };
  }
}

/**
 * Parses an entry's data with the collection's real schema, and reports what
 * zod says — including the rules that look at the whole entry rather than one
 * field, which are the ones a form cannot check on its own.
 */
async function validateEntry(projectPath, { collection, data }) {
  let service;
  try {
    service = await serviceFor(projectPath);
  } catch (err) {
    return { issues: [], error: cleanError(err.message) };
  }
  if (!service) return { issues: [], unchecked: true };
  touch(service);
  const id = service.nextId++;
  const reply = new Promise((resolve, reject) => {
    service.pending.set(id, { resolve, reject });
    const timer = setTimeout(() => {
      service.pending.delete(id);
      reject(new Error('Checking the entry timed out.'));
    }, RUN_TIMEOUT);
    if (timer.unref) timer.unref();
  });
  try {
    service.child.stdin.write(JSON.stringify({ id, op: 'validate', collection, data }) + '\n');
    return await reply;
  } catch (err) {
    return { issues: [], error: cleanError(err.message) };
  }
}

const stopAllServices = () => {
  for (const projectPath of [...services.keys()]) stopService(projectPath);
};

module.exports = { readContentConfig, validateEntry, configPathOf, stopService, stopAllServices };
