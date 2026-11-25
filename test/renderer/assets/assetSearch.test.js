// Goal: the Assets panel's search finds exactly the files a person means, across the whole project,
// by name and by path, ignoring case and accents, and costs one linear pass per keystroke however
// many files there are.
// Methodology: run the real module (src/features/assets/assetSearch.ts) through the app's bundler on
// hand-made listings: names, folders, several words, accents in the file and in the query, an empty
// query and a query of spaces, folders left out, and the pick filter. Speed is held as a ratio, never
// as milliseconds: the best of several runs over 5,000 files is compared with the same amount of
// work done as repeated passes over a 65-file listing, so a slow machine slows both alike and only a
// search that stops being linear (a pass per match, a pass per file) fails.
const test = require('node:test');
const assert = require('node:assert/strict');
const search = require('../../helpers/rendererModule')('src/features/assets/assetSearch.ts');

const folder = (rel) => ({ rel, name: rel.split('/').at(-1), parent: rel.split('/').slice(0, -1).join('/'), root: rel.split('/')[0], isDir: true });
const file = (rel, extra = {}) => ({
  rel,
  name: rel.split('/').at(-1),
  parent: rel.split('/').slice(0, -1).join('/'),
  root: rel.split('/')[0],
  isDir: false,
  size: 10,
  ...extra,
});
const accept = () => true;
const rels = (files) => files.map((entry) => entry.rel);
const find = (entries, query) => rels(search.searchAssets(search.buildAssetIndex(entries, accept), query));

const PROJECT = [
  folder('public'),
  folder('src'),
  folder('src/assets/images'),
  file('public/logo.svg'),
  file('src/assets/images/Hero.PNG'),
  file('src/assets/images/hero-small.webp'),
  file('src/assets/logo.svg'),
  file('src/assets/images/Éclair.jpg'),
  file('src/assets/fonts/inter.woff2'),
];

test('a name is found anywhere in it, whatever the case', () => {
  assert.deepEqual(find(PROJECT, 'hero'), ['src/assets/images/Hero.PNG', 'src/assets/images/hero-small.webp']);
  assert.deepEqual(find(PROJECT, 'HERO.png'), ['src/assets/images/Hero.PNG']);
  assert.deepEqual(find(PROJECT, 'small'), ['src/assets/images/hero-small.webp']);
});

test('the whole project is searched, and equal names in different folders are all found', () => {
  assert.deepEqual(find(PROJECT, 'logo'), ['public/logo.svg', 'src/assets/logo.svg']);
});

test('a path is searched too, and several words must all be there', () => {
  assert.deepEqual(find(PROJECT, 'fonts'), ['src/assets/fonts/inter.woff2']);
  assert.deepEqual(find(PROJECT, 'images hero'), ['src/assets/images/Hero.PNG', 'src/assets/images/hero-small.webp']);
  assert.deepEqual(find(PROJECT, 'images logo'), []);
  assert.deepEqual(find(PROJECT, 'public/logo'), ['public/logo.svg']);
});

test('accents do not matter in the file or in the query', () => {
  assert.deepEqual(find(PROJECT, 'eclair'), ['src/assets/images/Éclair.jpg']);
  assert.deepEqual(find(PROJECT, 'ÉCLAIR'), ['src/assets/images/Éclair.jpg']);
  assert.deepEqual(find([file('public/café.png')], 'café'), ['public/café.png']);
  assert.equal(search.foldSearchText('Éclair'), 'eclair');
});

test('an empty query, or one of spaces, finds nothing and is not a search', () => {
  assert.deepEqual(find(PROJECT, ''), []);
  assert.deepEqual(find(PROJECT, '   '), []);
  assert.equal(search.isSearching(''), false);
  assert.equal(search.isSearching(' \t '), false);
  assert.equal(search.isSearching(' a '), true);
});

test('a query with no match finds nothing, and a match is never a folder', () => {
  assert.deepEqual(find(PROJECT, 'zzz'), []);
  assert.deepEqual(find(PROJECT, 'images'), rels(PROJECT.filter((entry) => !entry.isDir && entry.rel.includes('images'))));
  assert.equal(search.buildAssetIndex(PROJECT, accept).files.length, 6);
});

test('the pick filter keeps other kinds out of the index', () => {
  const images = search.buildAssetIndex(PROJECT, (entry) => /\.(png|jpg|svg)$/i.test(entry.name));
  assert.deepEqual(rels(search.searchAssets(images, 'logo')), ['public/logo.svg', 'src/assets/logo.svg']);
  assert.deepEqual(rels(search.searchAssets(images, 'inter')), []);
});

test('an empty listing and the empty index are safe', () => {
  assert.deepEqual(find([], 'a'), []);
  assert.deepEqual(rels(search.searchAssets(search.EMPTY_ASSET_INDEX, 'a')), []);
});

test('results keep the listing order and the input is not changed', () => {
  const entries = [file('public/b-logo.svg'), file('public/a-logo.svg')];
  const copy = [...entries];
  assert.deepEqual(find(entries, 'logo'), ['public/b-logo.svg', 'public/a-logo.svg']);
  assert.deepEqual(entries, copy);
});

function listing(count) {
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    entries.push(file(`src/assets/images/group-${index % 50}/asset-${String(index).padStart(4, '0')}.${index % 2 === 0 ? 'png' : 'svg'}`));
  }
  return entries;
}

// Best of several runs: one slow slice (a garbage collection) cannot fail the ratio.
function bestOf(runs, work) {
  let best = Infinity;
  for (let run = 0; run < runs; run += 1) {
    const started = process.hrtime.bigint();
    work();
    const elapsed = Number(process.hrtime.bigint() - started);
    best = Math.min(best, elapsed);
  }
  return best;
}

test('5,000 files cost no more than the same work over 65', () => {
  const big = listing(5000);
  const small = listing(65);
  const bigIndex = search.buildAssetIndex(big, accept);
  const smallIndex = search.buildAssetIndex(small, accept);
  const passes = Math.ceil(5000 / 65);
  // A query most files match and one almost none do: the cost is the pass, not the matches.
  for (const query of ['asset', 'group-7 0007']) {
    const bigTime = bestOf(7, () => search.searchAssets(bigIndex, query));
    const smallTime = bestOf(7, () => {
      for (let pass = 0; pass < passes; pass += 1) {
        search.searchAssets(smallIndex, query);
      }
    });
    assert.ok(bigTime <= smallTime * 6, `${query}: ${bigTime} ns over 5,000 files vs ${smallTime} ns over ${passes} passes of 65`);
  }
  assert.equal(search.searchAssets(bigIndex, 'asset').length, 5000);
  assert.deepEqual(rels(search.searchAssets(bigIndex, 'asset-4999')), [big[4999].rel]);
});

test('building the index folds every path once and keeps one text per file', () => {
  const index = search.buildAssetIndex(listing(5000), accept);
  assert.equal(index.files.length, 5000);
  assert.equal(index.haystacks.length, 5000);
  assert.equal(index.haystacks[0], 'src/assets/images/group-0/asset-0000.png');
});
