// Finding a file, and seeing where it lives.
//
//   node test/file-browser.js
//
// The browser is one component used twice — the list of everything in the
// project, and the picker for choosing what to commit — so its two pure parts
// carry both. Both fail quietly rather than loudly: a search that ranks the
// wrong file first is still a list of files, and a tree that drops a folder
// still draws. Neither throws, and neither is obvious in a screenshot.
//
// Search is subsequence matching, the way editors do it, because typing "spi"
// to reach src/pages/index is the entire point — a substring match would find
// nothing and the feature would be a filter box instead of a way to navigate.

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
  const bundlePath = path.join(buildDir, 'file-browser.bundle.js');
  await esbuild.build({
    entryPoints: [path.join(__dirname, '..', 'src', 'ui', 'FileBrowser.jsx')],
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  const { fuzzyScore, search, buildTree } = require(bundlePath);

  const f = (p, status = null) => ({ path: p, status });
  const project = [
    f('src/pages/index.astro', 'M'),
    f('src/pages/about.astro'),
    f('src/pages/blog/index.astro'),
    f('src/components/Card.astro', 'A'),
    f('src/components/Nav.astro'),
    f('src/styles/main.css'),
    f('public/logo.svg'),
    f('package.json'),
  ];
  const paths = (list) => list.map((x) => x.path);

  // --- Searching ------------------------------------------------------------
  {
    check('an empty query matches nothing', search(project, '').length === 0);
    check('and whitespace is the same', search(project, '   ').length === 0);

    // The point of the whole thing: initials across separators.
    const spi = paths(search(project, 'spi'));
    check('letters spread across a path still match', spi.includes('src/pages/index.astro'), JSON.stringify(spi));

    // A plain name should put the file of that name first, not a longer path
    // that happens to contain the letters.
    const card = paths(search(project, 'card'));
    check('a filename search finds it', card[0] === 'src/components/Card.astro', JSON.stringify(card));
    check('matching is case-insensitive', paths(search(project, 'CARD'))[0] === 'src/components/Card.astro');

    const css = paths(search(project, 'css'));
    check('an extension finds files of that type', css.includes('src/styles/main.css'), JSON.stringify(css));

    // Letters that are not all present must not match at all — a search that
    // falls back to "nearly" is a search that never says "no such file".
    check('a query with a letter too many matches nothing', search(project, 'cardz').length === 0);
    check('and one that is simply absent', search(project, 'zzz').length === 0);

    // Consecutive letters beat the same letters scattered, so the obvious
    // answer is the first one.
    check(
      'an exact name outranks an incidental match',
      paths(search(project, 'index'))[0].endsWith('index.astro'),
      JSON.stringify(paths(search(project, 'index')))
    );
    // Two files could match "index"; the shorter path wins, since it is the
    // less buried one.
    check(
      'the shallower of two matches comes first',
      paths(search(project, 'index'))[0] === 'src/pages/index.astro',
      JSON.stringify(paths(search(project, 'index')))
    );

    check('a non-match scores below zero', fuzzyScore('zzz', 'src/pages/index.astro') < 0);
    check('a match scores above it', fuzzyScore('index', 'src/pages/index.astro') > 0);
    // Long lists are cut, or a three-letter query redraws the whole project.
    const many = Array.from({ length: 500 }, (_, i) => f(`src/pages/page${i}.astro`));
    check('results are capped', search(many, 'page').length <= 60, String(search(many, 'page').length));
  }

  // --- The tree -------------------------------------------------------------
  {
    const tree = buildTree(project);
    check('top-level folders are found', [...tree.dirs.keys()].join(',') === 'public,src', [...tree.dirs.keys()].join(','));
    check('a loose file stays at the top', tree.files.map((x) => x.name).join(',') === 'package.json');
    check('folders nest', [...tree.dirs.get('src').dirs.keys()].join(',') === 'components,pages,styles');
    check('a folder inside a folder', tree.dirs.get('src').dirs.get('pages').dirs.has('blog'));

    // Every file has to land somewhere: one lost in the tree is one that
    // cannot be found or ticked, with nothing on screen to say it is missing.
    const countFiles = (node) =>
      node.files.length + [...node.dirs.values()].reduce((n, d) => n + countFiles(d), 0);
    check('no file is lost', countFiles(tree) === project.length, `${countFiles(tree)} of ${project.length}`);

    // Sorted, so the tree does not reshuffle between reads.
    const pagesFiles = tree.dirs.get('src').dirs.get('pages').files.map((x) => x.name);
    check('files are in name order', pagesFiles.join(',') === 'about.astro,index.astro', pagesFiles.join(','));

    // The status has to survive into the tree, or the browser can show where a
    // file is or that it changed, but never both.
    const idx = tree.dirs.get('src').dirs.get('pages').files.find((x) => x.name === 'index.astro');
    check('status is carried onto the row', idx.status === 'M', JSON.stringify(idx));
    check('and the full path with it', idx.path === 'src/pages/index.astro', idx.path);

    check('an empty project builds an empty tree', countFiles(buildTree([])) === 0);
  }

  if (failures.length) {
    console.error(`file-browser: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`file-browser: ${checked} passed`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
