// Goal: Create component's "Move styles" learns, for each class of the extracted markup, which files other
// than the page mention it, so a class only that markup uses is told from a utility or a shared class.
// Method: a small Astro project on disk per case, read by the real project walk; then the pure function on
// texts for the bounds. The negative space matters most: a rule for a class (in a stylesheet or in another
// component's <style>) is not a use, the page itself is left out, and a class nothing names maps to [].
import assert from 'node:assert/strict';
import test from 'node:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { classMentionFiles, findClassMentions } from '#dist/electron/properties/classMentions.js';
import { CLASS_USAGE_LIMITS } from '#dist/shared/properties/classUsage.js';

type Files = Readonly<Record<string, string>>;

function project(files: Files): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-class-mentions-'));
  for (const [rel, text] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  return root;
}

const STYLE_FOLDERS = ['src/styles'];

test('a class used in another file names that file; the page and rules for the class do not count', async () => {
  const root = project({
    'src/pages/index.astro': '<div class="card u-center"><h3 class="card_title">A</h3></div>',
    'src/pages/about.astro': '<p class="u-center">About</p>',
    'src/components/Hero.astro': '<section class="hero"></section>\n<style>.card { color: red; } .card_title { margin: 0; }</style>',
    'src/styles/base.css': '.card { padding: 1rem; } .card_title { font-weight: 700; } .u-center { text-align: center; }',
    'src/scripts/menu.ts': "document.querySelector('.card_title');",
  });
  try {
    const found = await findClassMentions(root, ['card', 'card_title', 'u-center'], 'src/pages/index.astro', STYLE_FOLDERS);
    assert.deepEqual(found.get('card'), [], 'a stylesheet rule and another component’s <style> rule are not uses');
    assert.deepEqual(found.get('card_title'), ['src/scripts/menu.ts'], 'a script naming the class is a use');
    assert.deepEqual(found.get('u-center'), ['src/pages/about.astro'], 'another page’s markup is a use');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('only files under src/ count: notes, a README and public/ use class names as plain words', async () => {
  const root = project({
    'src/pages/index.astro': '<div class="project"></div>',
    'LUMOS.md': 'Every project starts from the starter.',
    'README.md': '<div class="project"></div>',
    'public/embed.html': '<div class="project"></div>',
  });
  try {
    const found = await findClassMentions(root, ['project'], 'src/pages/index.astro', STYLE_FOLDERS);
    assert.deepEqual(found.get('project'), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a class nothing else names maps to [], and every class asked about gets an entry', async () => {
  const root = project({ 'src/pages/index.astro': '<div class="solo"></div>' });
  try {
    const found = await findClassMentions(root, ['solo', 'absent'], 'src/pages/index.astro', STYLE_FOLDERS);
    assert.deepEqual(
      [...found.entries()],
      [
        ['solo', []],
        ['absent', []],
      ],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('files are named in path order and at most filesPerClassMax per class', () => {
  const others = Array.from({ length: CLASS_USAGE_LIMITS.filesPerClassMax + 5 }, (_, index) => ({
    rel: `src/data/${String(index).padStart(2, '0')}.json`,
    text: '{ "class": "shared" }',
  }));
  const found = classMentionFiles({ astro: [], others: [...others].reverse() }, ['shared'], 'src/pages/index.astro');
  const files = found.get('shared') ?? [];
  assert.equal(files.length, CLASS_USAGE_LIMITS.filesPerClassMax);
  assert.deepEqual(files, [...files].sort());
  assert.equal(files[0], 'src/data/00.json');
});

test('a whole word only: a longer class that contains the name is not a mention of it', () => {
  const found = classMentionFiles({ astro: [{ rel: 'src/pages/a.astro', ownText: '<div class="card-wide cards"></div>' }], others: [] }, ['card'], 'x');
  assert.deepEqual(found.get('card'), []);
});

test('asking about too many classes, or an empty name, is a programmer error', () => {
  const many = Array.from({ length: CLASS_USAGE_LIMITS.classesMax + 1 }, (_, index) => `c${index}`);
  assert.throws(() => classMentionFiles({ astro: [], others: [] }, many, 'x'), /classes within limit/);
  assert.throws(() => classMentionFiles({ astro: [], others: [] }, [''], 'x'), /class names are non-empty/);
});
