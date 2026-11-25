// Goal: the Add elements panel offers every HTML tag the editor inserts, exactly once, each in a group, with its
// own icon and a friendly name in the English catalog; its Astro tiles are the palette's own insert types; the
// search narrows across both sections and empties cleanly; the slot is offered only inside a component; and the
// arrow keys move through the grid of groups as one grid, stopping at its ends.
// Methodology: bundle the pure catalog, the English `elements` catalog and the element icons, then check the
// catalog against HTML_TAGS and against itself (ids, groups, keys), run searches that hit one section, both, none
// and a translated label, and walk the focus over group sizes with ragged last rows, including every edge.
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const esbuild = require('esbuild');
const loadRenderer = require('../../helpers/rendererModule');
const { repoPath } = require('../../helpers/sources.js');

const catalog = loadRenderer('src/features/palette/elementsCatalog.ts');
const { HTML_TAGS } = loadRenderer('src/editor/elementSchemas.ts');
const { messages } = loadRenderer('shared/properties/i18n/messages/en/elements.ts');
const english = (key) => {
  assert.ok(Object.hasOwn(messages, key), `missing English text for ${key}`);
  return messages[key];
};

function loadIcons() {
  const { outputFiles } = esbuild.buildSync({
    entryPoints: [repoPath('src/ui/ElementIcons.tsx')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime'],
    write: false,
  });
  const bundled = outputFiles[0];
  assert.ok(bundled);
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', bundled.text)(createRequire(repoPath('node_modules/.stacki-test/element-icons.cjs')), loaded, loaded.exports);
  return loaded.exports;
}

const allTiles = () => catalog.ELEMENT_GROUPS.flatMap((group) => group.tiles);
const tagTiles = () => allTiles().filter((tile) => tile.id.startsWith('tag:') && tile.action.kind === 'insert' && tile.action.choice.type === 'element');

test('every HTML tag and inline SVG is offered exactly once, in an HTML group', () => {
  const tags = tagTiles().map((tile) => tile.action.choice.tag);
  assert.equal(new Set(tags).size, tags.length, 'no tag twice');
  assert.deepEqual([...tags].sort(), [...HTML_TAGS, 'svg'].sort(), 'the HTML section is HTML_TAGS plus svg, nothing more or less');
  for (const group of catalog.ELEMENT_GROUPS) {
    const hasTags = group.tiles.some((tile) => tile.id.startsWith('tag:'));
    assert.equal(hasTags, group.section === 'html', `${group.id}: tags live only in the HTML section`);
  }
});

test('tile ids are unique, groups are named and non-empty, and every label is in the English catalog', () => {
  const ids = allTiles().map((tile) => tile.id);
  assert.equal(new Set(ids).size, ids.length, 'no tile id twice');
  assert.ok(ids.length <= catalog.ELEMENT_TILES_MAX, 'the catalog is within its bound');
  const groupIds = catalog.ELEMENT_GROUPS.map((group) => group.id);
  assert.deepEqual(groupIds, [...catalog.ELEMENT_GROUP_IDS], 'every group drawn, in the declared order');
  for (const group of catalog.ELEMENT_GROUPS) {
    assert.ok(group.tiles.length > 0, `${group.id} has tiles`);
    assert.ok(english(group.labelKey).length > 0);
    for (const tile of group.tiles) {
      assert.ok(english(tile.labelKey).length > 0, `${tile.id} has a name`);
      assert.ok(english(tile.nameKey).length >= english(tile.labelKey).length, `${tile.id}: the full name is never shorter than the tile's`);
      assert.ok(!english(tile.labelKey).includes('\u00ad'), `${tile.id}: no soft hyphen in a tile name`);
    }
  }
  // HTML first, then Astro: the sections never interleave.
  const sections = catalog.ELEMENT_GROUPS.map((group) => group.section);
  assert.deepEqual(
    sections,
    [...sections].sort((left, right) => (left === right ? 0 : left === 'html' ? -1 : 1)),
  );
});

test('every tag tile has an icon of its own, and the Astro tiles insert what the palette inserts', () => {
  const icons = loadIcons();
  for (const tile of tagTiles()) {
    assert.ok(icons.hasElementIcon(tile.action.choice.tag), `${tile.action.choice.tag} has an icon`);
  }
  assert.equal(icons.hasElementIcon('no-such-tag'), false, 'a tag without an icon is told apart');
  const astro = catalog.ELEMENT_GROUPS.filter((group) => group.section === 'astro').flatMap((group) => group.tiles);
  const kinds = astro.map((tile) => (tile.action.kind === 'insert' ? tile.action.choice.type : tile.action.kind));
  for (const kind of ['map', 'cond', 'expr', 'text', 'comment', 'style', 'script', 'astroAsset', 'element', 'pickComponent']) {
    assert.ok(kinds.includes(kind), `the Astro section offers ${kind}`);
  }
  const astroTags = astro.flatMap((tile) => (tile.action.kind === 'insert' && tile.action.choice.type === 'element' ? [tile.action.choice.tag] : []));
  assert.deepEqual(astroTags.sort(), ['Content', 'Fragment', 'slot']);
  const component = astro.find((tile) => tile.action.kind === 'pickComponent');
  assert.equal(component?.code, undefined, 'the Component tile writes no code of its own');
});

// Bundles the element icons with the rail's feature icons, so a tile's drawing can be compared with the Audits
// panel's rail icon as rendered markup (two icons are the same drawing when their SVG markup is the same).
function loadIconDrawings() {
  const { outputFiles } = esbuild.buildSync({
    stdin: {
      contents: `export { elementIcon } from ${JSON.stringify(repoPath('src/ui/ElementIcons.tsx'))};
export { AuditsIcon } from ${JSON.stringify(repoPath('src/app/featureIcons.tsx'))};`,
      resolveDir: repoPath('.'),
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    external: ['react', 'react/jsx-runtime'],
    write: false,
  });
  const bundled = outputFiles[0];
  assert.ok(bundled);
  const loaded = { exports: {} };
  new Function('require', 'module', 'exports', bundled.text)(createRequire(repoPath('node_modules/.stacki-test/icon-drawings.cjs')), loaded, loaded.exports);
  const React = createRequire(repoPath('package.json'))('react');
  const { renderToStaticMarkup } = createRequire(repoPath('package.json'))('react-dom/server');
  return {
    tag: (tag) => renderToStaticMarkup(loaded.exports.elementIcon(tag, 20)),
    audits: renderToStaticMarkup(React.createElement(loaded.exports.AuditsIcon, { size: 20 })),
  };
}

test('Progress and Meter have drawings of their own, and neither is the Audits panel gauge', () => {
  const drawings = loadIconDrawings();
  const progress = drawings.tag('progress');
  const meter = drawings.tag('meter');
  assert.notEqual(progress, meter, 'progress and meter are told apart');
  assert.notEqual(progress, drawings.audits, 'progress is not the Audits icon');
  assert.notEqual(meter, drawings.audits, 'meter is not the Audits icon');
  for (const tile of tagTiles()) {
    const tag = tile.action.choice.tag;
    assert.notEqual(drawings.tag(tag), drawings.audits, `${tag} does not wear the Audits icon`);
    if (tag !== 'progress') {
      assert.notEqual(drawings.tag(tag), progress, `${tag} does not share the progress icon`);
    }
    if (tag !== 'meter') {
      assert.notEqual(drawings.tag(tag), meter, `${tag} does not share the meter icon`);
    }
  }
});

test('a tag that has no friendly name is a programmer error', () => {
  assert.equal(catalog.tagLabelKey('div'), 'elements.tag.div');
  assert.throws(() => catalog.tagLabelKey('blink'), /Assertion failed: elementsCatalog: blink has a friendly name/);
});

test('the search narrows across both sections, matches translated names, and can empty the panel', () => {
  const filter = (query, options = { allowSlot: true }, labelOf = english) => catalog.filterElementGroups(catalog.ELEMENT_GROUPS, query, options, labelOf);
  assert.equal(filter('').length, catalog.ELEMENT_GROUPS.length, 'no query shows every group');
  const ids = (groups) => groups.flatMap((group) => group.tiles.map((tile) => tile.id));
  assert.deepEqual(ids(filter('heading 1')), ['tag:h1']);
  const image = ids(filter('image'));
  assert.ok(image.includes('tag:img'), 'an HTML tile matches');
  assert.ok(image.includes('astro:image'), 'and an Astro tile, in one search');
  assert.ok(ids(filter('loop')).includes('astro:loop'));
  assert.deepEqual(ids(filter('TABLE   BODY')), ['tag:tbody'], 'case and extra spaces do not matter');
  assert.deepEqual(filter('zzzz-nothing'), [], 'nothing matches: no group is left');
  // A tile drawn with a short name is still found by its full name, which its tooltip shows.
  assert.equal(english('elements.tag.s'), 'Strike');
  assert.deepEqual(ids(filter('strikethrough')), ['tag:s']);
  assert.deepEqual(ids(filter('keyboard input')), ['tag:kbd']);
  // The label in the active language is searched, not only English.
  const german = (key) => (key === 'elements.tag.p' ? 'Absatz' : english(key));
  assert.deepEqual(ids(filter('absatz', { allowSlot: true }, german)), ['tag:p']);
  // A group untouched by the search is the same object, so the panel does not redraw it.
  const structure = catalog.ELEMENT_GROUPS[0];
  assert.equal(filter('').at(0), structure);
});

test('the slot is offered only inside a component', () => {
  const ids = (allowSlot) =>
    catalog.filterElementGroups(catalog.ELEMENT_GROUPS, '', { allowSlot }, english).flatMap((group) => group.tiles.map((tile) => tile.id));
  assert.ok(ids(true).includes('astro:slot'));
  assert.ok(!ids(false).includes('astro:slot'));
  assert.ok(ids(false).includes('astro:fragment'), 'the rest of its group stays');
});

test('the fold-all button folds while any group is open and opens once every group is folded', () => {
  const all = new Set(catalog.ELEMENT_GROUP_IDS);
  assert.equal(catalog.foldAllAction(new Set()), 'collapse');
  assert.equal(catalog.foldAllAction(new Set(['structure'])), 'collapse', 'some open: fold the rest');
  const allButOne = new Set(all);
  allButOne.delete('astroBlocks');
  assert.equal(catalog.foldAllAction(allButOne), 'collapse', 'one Astro group open still folds');
  assert.equal(catalog.foldAllAction(all), 'expand');
});

test('arrow keys move through the groups as one grid and stop at its ends', () => {
  const move = catalog.moveElementFocus;
  // Two groups: five tiles (rows of 3 and 2), then four (rows of 3 and 1).
  const sizes = [5, 4];
  assert.equal(move(sizes, 0, 'left'), 0, 'left stops at the first tile');
  assert.equal(move(sizes, 8, 'right'), 8, 'right stops at the last');
  assert.equal(move(sizes, 4, 'right'), 5, 'right runs on into the next group');
  assert.equal(move(sizes, 1, 'down'), 4, 'down keeps the column');
  assert.equal(move(sizes, 2, 'down'), 4, 'a short row takes its last tile');
  assert.equal(move(sizes, 4, 'down'), 6, 'down crosses into the next group, same column');
  assert.equal(move(sizes, 7, 'down'), 8, 'onto the ragged last row');
  assert.equal(move(sizes, 8, 'down'), 8, 'down stops at the last row');
  assert.equal(move(sizes, 6, 'up'), 4, 'up crosses back, clamped to the short row');
  assert.equal(move(sizes, 1, 'up'), 1, 'up stops at the first row');
  assert.equal(move([0, 3], 1, 'up'), 1, 'a folded group draws no rows');
  assert.throws(() => move(sizes, 9, 'left'), /the focus sits on a tile/);
  assert.throws(() => move([0], 0, 'left'), /the grid has a tile/);
});
