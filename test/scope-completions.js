// What an expression field offers while it is typed.
//
//   node test/scope-completions.js
//
// A condition reads `render && (content || background)` — three names that come
// from this file's frontmatter, and nothing in the field said so. Typing had to
// be done from memory, spelling included, while the panel beside it already knew
// every one of them: the data picker lists them. This is that list, flattened
// into completions, and the rules that keep it useful — what's in scope only,
// one level deep, and never a throw while the frontmatter is half-written.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

(async () => {
  const esbuild = require('esbuild');
  const buildDir = path.join(__dirname, '..', 'node_modules', '.stacki-test');
  fs.mkdirSync(buildDir, { recursive: true });
  const bundlePath = path.join(buildDir, 'scope-completions.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'dataSuggest.js')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    logLevel: 'silent',
  });
  const { scopeCompletions } = require(bundlePath);

  const frontmatter = `import Layout from '../layouts/Layout.astro';
const { render, content, background, title = 'Untitled' } = Astro.props;
const posts = await getCollection('blog');
const year = new Date().getFullYear();`;
  const labels = (ctx) => scopeCompletions(ctx).map((c) => c.label);

  const list = labels({ frontmatter, imports: [{ name: 'Layout' }] });
  // --- the props of this file ------------------------------------------------
  for (const name of ['render', 'content', 'background', 'title']) {
    check(`offers the prop \`${name}\``, list.includes(name), list.join(', '));
  }
  // --- and its frontmatter ---------------------------------------------------
  check('offers a frontmatter const', list.includes('year'), list.join(', '));
  check('offers a query result', list.includes('posts'), list.join(', '));
  check('offers an import', list.includes('Layout'), list.join(', '));
  check('offers each name once', new Set(list).size === list.length, list.join(', '));

  // --- nothing that isn't in scope -------------------------------------------
  //
  // The language's own completions would offer `Array`, `decodeURIComponent` and
  // every other global, which buries the six names that are about this page.
  for (const global of ['Array', 'window', 'decodeURIComponent', 'Astro']) {
    check(`does not offer \`${global}\``, !list.includes(global), list.join(', '));
  }

  // --- a field is typed into while the file is broken ------------------------
  check('a half-written frontmatter offers nothing rather than throwing', (() => {
    try {
      return Array.isArray(scopeCompletions({ frontmatter: 'const { a = ' }));
    } catch {
      return false;
    }
  })());
  check('no scope at all is an empty list', scopeCompletions({}).length === 0);

  // --- the note beside a name ------------------------------------------------
  const withDetail = scopeCompletions({ frontmatter, imports: [] }).find((c) => c.label === 'title');
  check('a value carries what it holds', !!withDetail, JSON.stringify(withDetail));

  // --- and the same names, drawn as chips ------------------------------------
  //
  // A condition reads as three values and some punctuation; the values are what
  // the eye is looking for. Only what's in scope counts — an ordinary identifier
  // drawn as a chip would claim to be a value you could swap.
  const { scopeChips } = require(bundlePath);
  const names = new Set(['render', 'content', 'background', 'post', 'items']);
  const chipped = (src) => scopeChips(src, names).map((c) => src.slice(c.from, c.to));

  check(
    'every value in a boolean is a chip',
    chipped('render && (content || background)').join(',') === 'render,content,background',
    JSON.stringify(chipped('render && (content || background)'))
  );
  check(
    'a path is one chip, not three',
    chipped('post.data.title').join(',') === 'post.data.title',
    JSON.stringify(chipped('post.data.title'))
  );
  check(
    'a call chips the value, not the method',
    chipped('items.map((i) => i.id)').join(',') === 'items',
    JSON.stringify(chipped('items.map((i) => i.id)'))
  );
  check('a name that is not in scope is not a chip', chipped('other && helper()').length === 0);
  check(
    'a word inside a string is not a value',
    chipped('content === "content"').length === 1,
    JSON.stringify(chipped('content === "content"'))
  );
  check('nothing in scope, nothing chipped', scopeChips('render && content', new Set()).length === 0);

  if (failures.length) {
    console.error(`scope-completions: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`scope-completions: ${checked} passed  [names offered, names chipped]`);
})();
