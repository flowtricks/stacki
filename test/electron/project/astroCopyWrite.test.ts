// Goal: making the Astro copy on disk leaves the original byte for byte as it was, produces exactly the
// planned project, keeps file modes, and on any failure leaves nothing behind: no target and no temporary
// folder. A target that exists, a location inside the original, a missing or read-only location, and a bad
// name are refused before anything is written.
// Method: a fixture site written under the OS temp directory (never a real project), hashed file by file
// before and after; the copy is made beside it as the dialog would, then walked and compared with the exact
// expected tree. Failures are made real: an unreadable asset (the copy fails part way), and a target created
// while the copy runs (the second check before the rename). Each test removes its folders.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ASTRO_COPY_TEMPORARY_PREFIX, checkAstroCopyTarget, createAstroCopy } from '#dist/electron/project/astroCopyWrite.js';

const SITE: Readonly<Record<string, string>> = {
  'index.html':
    '<!doctype html><html><head><link rel="stylesheet" href="css/site.css"></head><body>Hello {name}<script src="js/app.js"></script></body></html>',
  'about/index.html': '<p>About</p><img src="../img/logo.png">',
  'about.html': '<p>Old about</p>',
  'Old.htm': '<p>Old</p>',
  '_partial.html': '<p>{partial}</p>',
  'css/site.css': 'body { color: red }',
  'js/app.js': 'console.log("hi")',
  'img/logo.png': '\u0089PNG',
  'package.json': '{"name":"old"}',
  '.env': 'SECRET=1',
  'node_modules/x/index.js': '',
};

interface Fixture {
  readonly parent: string;
  readonly source: string;
  readonly dispose: () => void;
}

function fixture(files: Readonly<Record<string, string>> = SITE): Fixture {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-astro-copy-')));
  const source = path.join(parent, 'shop');
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(source, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
  if (files['js/app.js'] !== undefined) {
    fs.chmodSync(path.join(source, 'js', 'app.js'), 0o755);
  }
  return {
    parent,
    source,
    dispose: () => {
      for (const file of walk(parent)) {
        fs.chmodSync(path.join(parent, file), 0o644);
      }
      fs.rmSync(parent, { recursive: true, force: true });
    },
  };
}

// Every file under `root`, relative and sorted.
function walk(root: string): readonly string[] {
  const found: string[] = [];
  const pending = [root];
  // The fixtures are a few folders deep; each folder is read once.
  while (pending.length > 0) {
    const folder = pending.pop();
    assert.ok(folder !== undefined);
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      const absolute = path.join(folder, entry.name);
      if (entry.isDirectory()) {
        pending.push(absolute);
      } else {
        found.push(path.relative(root, absolute).split(path.sep).join('/'));
      }
    }
  }
  return found.sort();
}

function hashes(root: string): Readonly<Record<string, string>> {
  return Object.fromEntries(
    walk(root).map((file) => [
      file,
      crypto
        .createHash('sha256')
        .update(fs.readFileSync(path.join(root, file)))
        .digest('hex'),
    ]),
  );
}

const read = (root: string, relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

test('the copy is the planned project, the original is untouched byte for byte, and modes are kept', async (context) => {
  const site = fixture();
  context.after(site.dispose);
  const before = hashes(site.source);
  const logs: string[] = [];
  const made = await createAstroCopy({ sourcePath: site.source, parentPath: site.parent, name: 'shop-astro' }, (text) => logs.push(text));
  assert.ok(made.ok, JSON.stringify(made));
  const target = path.join(site.parent, 'shop-astro');
  assert.equal(made.value.projectPath, target);
  assert.deepEqual(hashes(site.source), before, 'the original is unchanged');
  assert.deepEqual(walk(target), [
    '.gitignore',
    'astro.config.mjs',
    'package.json',
    'public/Old.htm',
    'public/_partial.html',
    'public/about.html',
    'public/css/site.css',
    'public/img/logo.png',
    'public/js/app.js',
    'src/pages/Old.astro',
    'src/pages/about/index.astro',
    'src/pages/index.astro',
    'tsconfig.json',
  ]);
  assert.equal(
    read(target, 'src/pages/index.astro'),
    '<!doctype html><html><head><link rel="stylesheet" href="css/site.css"></head><body>Hello &#123;name&#125;<script is:inline src="js/app.js"></script></body></html>',
  );
  assert.equal(read(target, 'public/_partial.html'), '<p>{partial}</p>', 'a kept page is copied as it was');
  assert.equal(read(target, 'public/css/site.css'), 'body { color: red }');
  assert.match(read(target, 'public/Old.htm'), /url=Old\.html/);
  // Windows has no execute bit: a file's mode there is always 0o666 or 0o444, so a mode is only kept where the platform has modes.
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(target, 'public/js/app.js')).mode & 0o777, 0o755);
  }
  assert.deepEqual(made.value.plan.keptAsFiles, ['_partial.html', 'about.html']);
  assert.equal(made.value.plan.skippedCount, 3, '.env, node_modules and the old package.json');
  assert.deepEqual(
    fs.readdirSync(site.parent).filter((name) => name.startsWith(ASTRO_COPY_TEMPORARY_PREFIX)),
    [],
  );
  assert.match(logs.join(''), /3 pages, 5 files/);
});

test('a copy that fails part way leaves no target and no temporary folder, and the original stays', async (context) => {
  if (process.getuid?.() === 0) {
    context.skip('root reads every file');
    return;
  }
  const site = fixture();
  context.after(site.dispose);
  fs.chmodSync(path.join(site.source, 'img', 'logo.png'), 0o000);
  const before = walk(site.source);
  const made = await createAstroCopy({ sourcePath: site.source, parentPath: site.parent, name: 'shop-astro' }, () => {});
  assert.equal(made.ok, false);
  assert.ok(!made.ok && made.error.code === 'copy-failed', JSON.stringify(made));
  assert.deepEqual(fs.readdirSync(site.parent), ['shop']);
  assert.deepEqual(walk(site.source), before);
});

test('a target that appears while the copy runs is never overwritten', async (context) => {
  const site = fixture();
  context.after(site.dispose);
  const target = path.join(site.parent, 'shop-astro');
  // The first log line comes after the boundary check and before the files are written.
  const made = await createAstroCopy({ sourcePath: site.source, parentPath: site.parent, name: 'shop-astro' }, (text) => {
    if (!fs.existsSync(target)) {
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'mine.txt'), 'keep me');
    }
    assert.ok(text.length > 0);
  });
  assert.deepEqual(made, { ok: false, error: { code: 'target-exists' } });
  assert.equal(read(target, 'mine.txt'), 'keep me');
  assert.deepEqual(fs.readdirSync(target), ['mine.txt']);
  assert.deepEqual(fs.readdirSync(site.parent).sort(), ['shop', 'shop-astro']);
});

test('the boundary check refuses a bad name, an existing target, a place inside the original, and a missing or read-only location', (context) => {
  const site = fixture();
  context.after(site.dispose);
  const ask = (parentPath: string, name: string) => checkAstroCopyTarget({ sourcePath: site.source, parentPath, name });
  assert.deepEqual(ask(site.parent, 'shop-astro'), { ok: true, value: { targetPath: path.join(site.parent, 'shop-astro') } });
  assert.deepEqual(ask(site.parent, ''), { ok: false, error: 'name-empty' });
  assert.deepEqual(ask(site.parent, 'a:b'), { ok: false, error: 'name-invalid' });
  assert.deepEqual(ask(site.parent, 'shop'), { ok: false, error: 'target-exists' });
  assert.deepEqual(ask(site.source, 'copy'), { ok: false, error: 'inside-original' });
  assert.deepEqual(ask(path.join(site.source, 'css'), 'copy'), { ok: false, error: 'inside-original' });
  assert.deepEqual(ask(path.join(site.parent, 'gone'), 'copy'), { ok: false, error: 'location-missing' });
  assert.deepEqual(ask(path.join(site.source, 'index.html'), 'copy'), { ok: false, error: 'location-missing' });
  if (process.getuid?.() !== 0) {
    const locked = path.join(site.parent, 'locked');
    fs.mkdirSync(locked, { mode: 0o555 });
    assert.deepEqual(ask(locked, 'copy'), { ok: false, error: 'location-unwritable' });
    fs.chmodSync(locked, 0o755);
  }
  assert.throws(() => ask('relative/place', 'copy'), /Assertion failed/);
  assert.throws(() => checkAstroCopyTarget({ sourcePath: `${site.source}/../shop`, parentPath: site.parent, name: 'x' }), /Assertion failed/);
});

test('a refused request writes nothing at all', async (context) => {
  const site = fixture({ 'notes.md': '# no pages' });
  context.after(site.dispose);
  assert.deepEqual(await createAstroCopy({ sourcePath: site.source, parentPath: site.parent, name: 'shop-astro' }, () => {}), {
    ok: false,
    error: { code: 'not-plain-website' },
  });
  assert.deepEqual(await createAstroCopy({ sourcePath: site.source, parentPath: site.parent, name: 'shop' }, () => {}), {
    ok: false,
    error: { code: 'target-exists' },
  });
  assert.deepEqual(fs.readdirSync(site.parent), ['shop']);
});
