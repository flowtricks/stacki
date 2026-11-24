// Goal: the CMS panel's Content Collections open on an Astro 7 project with nothing set up by hand.
// Astro 7 brings Vite 8, which bundles with rolldown and installs no esbuild; the content-config
// reader once required esbuild, so every Astro 7 project failed with "needs the project
// dependencies installed" and the panel showed only an error. These checks hold the reader to
// either bundler, and the first-open path (no config yet, then a first collection) to working.
// Method: bundlerOf is checked against throwaway projects whose node_modules hold fake bundler
// packages, for the order it tries them in and the negative space (none, a module with no build).
// The reader itself is then run for real against throwaway projects whose node_modules link the
// real `astro` and `rolldown` from studio/node_modules, and no esbuild: a project with no config,
// a valid config, one edited after a read, a malformed one, one that throws, and one with no
// dependencies at all. Studio's dependencies are installed by every CI job; without them the
// real-bundle checks skip and say why.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { bundlerOf, readContentConfig, stopAllServices } = require('#dist/electron/content/contentConfig.js');
const { parseContentConfig } = require('#dist/electron/app/mainValidation.js');
const { astroRemoteService } = require('#dist/electron/content/astroRemoteService.js');
const { repoPath } = require('../../helpers/sources.js');

const STUDIO_MODULES = repoPath('studio/node_modules');
const REAL_BUNDLER = ['astro', 'rolldown'].every((name) => fs.existsSync(path.join(STUDIO_MODULES, name, 'package.json')));
const realOnly = REAL_BUNDLER ? {} : { skip: 'studio/node_modules has no astro and rolldown (run npm --prefix studio ci)' };

const CONFIG = `import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const posts = defineCollection({
  loader: glob({ base: './src/content/posts', pattern: '**/*.md' }),
  schema: z.object({ title: z.string() }),
});

export const collections = { posts };
`;

const projects = [];
test.after(() => {
  stopAllServices();
  for (const directory of projects) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

// A throwaway project: a package.json, and the given files.
function project(files) {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-content-bundler-')));
  projects.push(directory);
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ name: 'fixture', private: true, type: 'module' }));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
    fs.writeFileSync(path.join(directory, file), text);
  }
  return directory;
}

// A package in the project's node_modules whose main module is `source`.
function fakePackage(name, source) {
  return [`node_modules/${name}/package.json`, JSON.stringify({ name, main: 'index.cjs' }), `node_modules/${name}/index.cjs`, source];
}

function withPackages(...packages) {
  const files = {};
  for (const [packageFile, packageText, mainFile, mainText] of packages) {
    files[packageFile] = packageText;
    files[mainFile] = mainText;
  }
  return files;
}

// A project whose node_modules link Studio's real astro (for astro/zod) and rolldown: an Astro 7 install, no esbuild.
function astro7Project(files) {
  const directory = project(files);
  fs.mkdirSync(path.join(directory, 'node_modules'), { recursive: true });
  for (const name of ['astro', 'rolldown']) {
    fs.symlinkSync(path.join(STUDIO_MODULES, name), path.join(directory, 'node_modules', name), 'dir');
  }
  assert.equal(fs.existsSync(path.join(directory, 'node_modules', 'esbuild')), false, 'The fixture has no esbuild');
  return directory;
}

test('a project with no bundler installed has none', () => {
  assert.equal(bundlerOf(project({})), undefined);
});

test('a bundler package with no build function is not a bundler', () => {
  const directory = project(withPackages(fakePackage('rolldown', 'module.exports = { version: "1" };')));
  assert.equal(bundlerOf(directory), undefined);
});

test('a project with only rolldown, as every Astro 7 project is, is bundled with rolldown', () => {
  const directory = project(withPackages(fakePackage('rolldown', 'exports.build = async () => ({ output: [] });')));
  assert.equal(bundlerOf(directory)?.kind, 'rolldown');
});

test('a project with esbuild keeps esbuild, as every project before Astro 7 was read', () => {
  const directory = project(
    withPackages(
      fakePackage('rolldown', 'exports.build = async () => ({ output: [] });'),
      fakePackage('esbuild', 'exports.build = async () => ({ metafile: { inputs: {} } });'),
    ),
  );
  assert.equal(bundlerOf(directory)?.kind, 'esbuild');
});

test('a bundler is resolved from a project by its full path', () => {
  assert.throws(() => bundlerOf('relative/project'), /Assertion failed: A bundler is resolved from a project by its full path/);
});

test('a project with no content config reads as missing, not as a failure', realOnly, async () => {
  const result = await readContentConfig(astro7Project({ 'src/pages/index.astro': '<h1>Home</h1>\n' }), { force: true });
  assert.equal(result.missing, true);
  assert.deepEqual(result.collections, []);
});

test('an Astro 7 project with no esbuild has its content config read', realOnly, async () => {
  const directory = astro7Project({ 'src/content.config.ts': CONFIG, 'src/content/posts/hello.md': '---\ntitle: Hello\n---\n' });
  const result = await readContentConfig(directory, { force: true });
  assert.equal(result.error, undefined);
  assert.deepEqual(
    result.collections.map((collection) => [collection.name, collection.loader.kind]),
    [['posts', 'glob']],
  );
});

test('an edit to the config after a read is seen on the next read', realOnly, async () => {
  const directory = astro7Project({ 'src/content.config.ts': CONFIG });
  assert.equal((await readContentConfig(directory, { force: true })).collections.length, 1);
  const config = path.join(directory, 'src', 'content.config.ts');
  fs.writeFileSync(
    config,
    CONFIG.replace(
      'export const collections = { posts };',
      'const notes = defineCollection({ loader: glob({ base: "./src/content/notes", pattern: "**/*.md" }) });\nexport const collections = { posts, notes };',
    ),
  );
  // A later modification time, so the bundle's inputs are seen to change even on a coarse clock.
  const later = new Date(Date.now() + 5000);
  fs.utimesSync(config, later, later);
  const reread = await readContentConfig(directory);
  assert.deepEqual(reread.collections.map((collection) => collection.name).sort(), ['notes', 'posts']);
});

test('a malformed config is an answer the panel shows, not a crash', realOnly, async () => {
  const result = await readContentConfig(astro7Project({ 'src/content.config.ts': 'export const collections = { posts: ;\n' }), { force: true });
  assert.equal(typeof result.error, 'string');
  assert.ok(result.error.length > 0);
  assert.deepEqual(result.collections, []);
});

test('a config that throws is an answer the panel shows, not a crash', realOnly, async () => {
  const result = await readContentConfig(astro7Project({ 'src/content.config.ts': 'throw new Error("config exploded");\n' }), { force: true });
  assert.match(result.error, /config exploded/);
  assert.deepEqual(result.collections, []);
});

test('a project with no dependencies installed says so', async () => {
  const result = await readContentConfig(project({ 'src/content.config.ts': CONFIG }), { force: true });
  assert.equal(result.error, 'Reading the content config needs the project dependencies installed.');
  assert.deepEqual(result.collections, []);
});

test('the first open of Content Collections on a fresh Astro 7 project: empty, then a first collection and entry', realOnly, async () => {
  const directory = astro7Project({ 'src/pages/index.astro': '<h1>Home</h1>\n' });
  const service = astroRemoteService(directory, {
    readConfig: async () => parseContentConfig(await readContentConfig(directory)),
    trash: async () => {},
  });
  assert.deepEqual(await service.collections(), []);
  await service.createCollection('posts');
  assert.ok(fs.existsSync(path.join(directory, 'src', 'content.config.ts')), 'The first collection writes the config');
  assert.deepEqual(
    (await service.collections()).map((collection) => collection.name),
    ['posts'],
  );
  const entry = await service.create('posts');
  assert.equal((await service.documents('posts')).documents[0]?.id, entry.id);
});
