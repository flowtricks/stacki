// A picture, set as the name the file imports it under.
//
//   node test/renderer/assets/assetRef.test.js
//
//   import muchMore from '@/assets/images/app-more.webp';
//   const SCREENS = [
//     { label: "And much more", image: muchMore },
//   ];
//
// This is how Astro wants an image written — imported, so it is sized, hashed
// and served — and it is the shape the CMS understood least. `muchMore` is not
// a literal, so the whole collection was read-only: no rows, no labels, no
// picker, an error where the editor should be. And a name on its own says
// nothing, so even allowed through it would show as a word in a code box.
//
// Three things had to be true for the field to be a picture:
//
//   the name is a value    carried as the source it is and written back the
//                          same name, the way a computed constant already was
//   the import is read     `muchMore` + the line above = a file on disk
//   picking writes both    the import (made, or the file's own reused) and the
//                          name that now stands for it
//
// Two older bugs sat in the way, both in the writer, both of which this page
// would have hit on its first save: WIDTH was never defined, so any record long
// enough to ask whether it fits on one line threw instead of answering; and the
// indent was sniffed from the first indented line in the file, which in a page
// whose frontmatter opens with a block comment is ` * …` — one space.

const fs = require('fs');
const os = require('os');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

const jc = require('#dist/electron/content/jsCollections.js');
const ar = require('#dist/electron/project/assetRefs.js');
const { repoPath } = require('../../helpers/sources.js');
const { readSourceGroup } = require('../../helpers/sourceText.js');

const SCAN = { requireExport: false, allowPlainLists: true };
const read = (source) => jc.findCollections(source, SCAN).find((collection) => collection.name === 'SCREENS');
// The write, as something to compare against — a collection that cannot be read
// and a writer that throws are both answers this file has to be able to report
// rather than die on.
const writeBack = (source, data) => {
  if (!data) {
    return '(read-only)';
  }
  try {
    return jc.replaceCollection(source, 'SCREENS', data, SCAN);
  } catch (error) {
    return `(threw: ${error.message})`;
  }
};

// The page's frontmatter, as it is written.
const FM = `import Section from '@/components/Wrapper/Section.astro';
import dailyDevotionals from '@/assets/images/app-daily-devotionals.webp';
import muchMore from '@/assets/images/app-more.webp';

/*
 * The captures are imported rather than read from \`public/\`, so Astro sizes
 * and serves them and the visual editor can swap one out.
 */
const SCREENS = [
  { label: "Daily devotionals", image: dailyDevotionals },
  { label: "And much more", image: muchMore },
];
`;

// --- a name is a value -----------------------------------------------------------
{
  const col = read(FM);
  check('a collection of imported pictures is readable at all', !!col?.data, col?.reason);
  check('and the name travels as the source it is', col?.data?.[0]?.image?.__expr === 'dailyDevotionals', JSON.stringify(col?.data?.[0]));
  check('the rest of the row is ordinary data', col?.data?.[1]?.label === 'And much more', JSON.stringify(col?.data?.[1]));
  check('and writing it back changes nothing', writeBack(FM, col?.data) === FM, writeBack(FM, col?.data));
}
{
  // The boundary: a name IS the value, or the collection stays read-only. None
  // of these can be written back as what they are.
  for (const [expr, what] of [
    ['getTags()', 'a call'],
    ['a ? b : c', 'a choice'],
    ['count + 1', 'a sum'],
    ['...defaults', 'a spread'],
  ]) {
    const source = `const SCREENS = [\n  { image: ${expr} },\n];\n`;
    check(`${what} keeps the collection read-only`, read(source) !== undefined && read(source).data === undefined, JSON.stringify(read(source)?.data));
  }
  const dotted = read('const SCREENS = [\n  { image: icons.mail },\n];\n');
  check('a name with a dot in it is still one name', dotted?.data?.[0]?.image?.__expr === 'icons.mail', JSON.stringify(dotted?.data));
}

// --- what the writer used to do to this file ---------------------------------------
{
  // A record too long for one line. WIDTH is the question "does this fit", and
  // it had no answer — the save threw ReferenceError and nothing was written.
  const long =
    `const SCREENS = [\n  {\n    label:\n` +
    `      "A label long enough that the record it sits in cannot be written on one line",\n` +
    `    image: muchMore,\n  },\n];\n`;
  const out = writeBack(long, read(long)?.data);
  check('a record too long for one line can be written at all', !/^\(threw/.test(out), out);
  check('and is written as it was', out === long, out);
}
{
  // The indent comes from the rows being rewritten. Sniffing the file at large
  // finds ` * …` inside the comment above them.
  const out = writeBack(FM, read(FM)?.data);
  check('a block comment above the rows does not set the indent', /\n  \{ label: "Daily/.test(out), out.split('\n').slice(-4).join('\n'));
  const tabbed = 'const SCREENS = [\n\t{ label: "One" },\n];\n';
  check('a file indented with tabs keeps them', writeBack(tabbed, read(tabbed)?.data) === tabbed, writeBack(tabbed, read(tabbed)?.data));
  const four = 'const SCREENS = [\n    { label: "One" },\n];\n';
  check('and one indented four keeps four', writeBack(four, read(four)?.data) === four, writeBack(four, read(four)?.data));
  // The rows answer for themselves: the code above them may be indented some
  // other way, and it is not the thing being rewritten.
  const mixed = 'function pad() {\n    return 1;\n}\n\nconst SCREENS = [\n  { label: "One" },\n];\n';
  check('code above the rows does not set it either', writeBack(mixed, read(mixed)?.data) === mixed, writeBack(mixed, read(mixed)?.data));
}

{
  // An empty collection has no rows to take the indent from, so the file is
  // asked — and in this file the only indented lines are inside the comment, which
  // say nothing, so the row takes Stacki's own tab.
  const empty = FM.replace(/const SCREENS = \[[\s\S]*?\];/, 'const SCREENS = [];');
  const out = writeBack(empty, [{ label: 'First' }]);
  check(
    'the first row added to an empty one takes a tab, not the comment’s indent',
    /\n\t\{ label: "First" \},\n/.test(out),
    out.split('\n').slice(-5).join('\n'),
  );
}

// --- reading the import above it ------------------------------------------------
{
  const imports = ar.defaultImports(FM);
  check('every default import is found', imports.map((i) => i.name).join() === 'Section,dailyDevotionals,muchMore', imports.map((i) => i.name).join());
  check('with the path it names', ar.importedAs(FM, 'muchMore')?.spec === '@/assets/images/app-more.webp', JSON.stringify(ar.importedAs(FM, 'muchMore')));
  check('a name nothing imports is not one', ar.importedAs(FM, 'nowhere') === undefined, 'it found something');
  // A name that stands for something INSIDE a module is not a file to swap.
  const other = "import { CONTACTS } from '../consts';\nimport * as icons from './icons';\n";
  check('a named or namespace import is not a file', ar.defaultImports(other).length === 0, JSON.stringify(ar.defaultImports(other)));
  check(
    'but a default beside a named one is',
    ar.defaultImports("import hero, { alt } from './hero.png';\n")[0]?.name === 'hero',
    JSON.stringify(ar.defaultImports("import hero, { alt } from './hero.png';\n")),
  );
}
{
  const resolve = (name) => (name === 'muchMore' ? 'src/assets/images/app-more.webp' : undefined);
  // A collection that could not be read has no names to bind; say so rather
  // than reading into nothing.
  const withAssets = ar.withAssets(read(FM)?.data || [], resolve);
  check('there are rows to bind at all', withAssets.length === 2, `${withAssets.length} rows`);
  check('a name bound to a picture carries the picture', withAssets[1]?.image?.__asset === 'src/assets/images/app-more.webp', JSON.stringify(withAssets[1]));
  check('and still says which name it was', withAssets[1]?.image?.__expr === 'muchMore', JSON.stringify(withAssets[1]));
  check('a name bound to something else is left alone', withAssets[0]?.image?.__asset === undefined, JSON.stringify(withAssets[0]));
  check('and the data around it is untouched', withAssets[0]?.label === 'Daily devotionals', JSON.stringify(withAssets[0]));
}

// --- writing the import for a picked one -------------------------------------------
{
  const taken = ar.defaultImports(FM).map((i) => i.name);
  check(
    'a new import is named for the file',
    ar.importName('src/assets/images/app-past-sermons.webp', taken) === 'appPastSermons',
    ar.importName('src/assets/images/app-past-sermons.webp', taken),
  );
  check(
    'a name already taken gets the next one',
    ar.importName('src/assets/images/much-more.webp', ['muchMore']) === 'muchMore2',
    ar.importName('src/assets/images/much-more.webp', ['muchMore']),
  );
  check(
    'a file starting with a digit still makes a name',
    /^[A-Za-z_$]/.test(ar.importName('src/assets/2024-hero.png', [])),
    ar.importName('src/assets/2024-hero.png', []),
  );
}
{
  const imports = ar.defaultImports(FM);
  check(
    'the path is written the way the file writes paths',
    ar.importSpecFor({
      imports,
      srcRelative: 'assets/images/x.webp',
      relative: '../../assets/images/x.webp',
    }) === '@/assets/images/x.webp',
    ar.importSpecFor({
      imports,
      srcRelative: 'assets/images/x.webp',
      relative: '../../assets/images/x.webp',
    }),
  );
  check(
    'and relative when that is how the file writes them',
    ar.importSpecFor({
      imports: ar.defaultImports("import a from '../b.astro';\n"),
      srcRelative: 'assets/x.webp',
      relative: './x.webp',
    }) === './x.webp',
    'an alias appeared from nowhere',
  );
}
{
  const next = ar.addImport(FM, 'appPastSermons', '@/assets/images/app-past-sermons.webp');
  const lines = next.split('\n');
  check(
    'a new import goes under the last one',
    lines[3] === "import appPastSermons from '@/assets/images/app-past-sermons.webp';",
    lines.slice(0, 5).join('\n'),
  );
  check('and nothing else moves', next.replace(/^.*app-past-sermons.*\n/m, '') === FM, 'the file changed around it');
  check('it reads back as an import', ar.importedAs(next, 'appPastSermons')?.spec === '@/assets/images/app-past-sermons.webp', 'not found');
  const bare = 'const SCREENS = [\n  { label: "One" },\n];\n';
  check(
    'a file with no imports gets one at the top',
    ar.addImport(bare, 'hero', './hero.png').startsWith("import hero from './hero.png';\n"),
    ar.addImport(bare, 'hero', './hero.png').split('\n')[0],
  );
  check('and the collection under it still parses', read(ar.addImport(bare, 'hero', './hero.png'))?.data?.length === 1, 'the file was broken by the import');
}

// --- what the panel does with it -----------------------------------------------------
{
  const { inferType } = require('esbuild').buildSync
    ? (() => {
        const esbuild = require('esbuild');
        const directory = repoPath('node_modules/.stacki-test');
        fs.mkdirSync(directory, { recursive: true });
        const out = path.join(directory, 'cms-schema.cjs');
        esbuild.buildSync({
          entryPoints: [repoPath('src/features/cms/cmsSchema.ts')],
          outfile: out,
          bundle: true,
          format: 'cjs',
          platform: 'node',
          logLevel: 'silent',
        });
        return require(out);
      })()
    : {};
  check(
    'a name bound to a picture is a picture',
    inferType({ __expr: 'muchMore', __asset: 'src/assets/images/app-more.webp' }) === 'image',
    inferType({ __expr: 'muchMore', __asset: 'src/assets/images/app-more.webp' }),
  );
  check('a name bound to nothing is still code', inferType({ __expr: 'FOUNDED' }) === 'code', inferType({ __expr: 'FOUNDED' }));
  check(
    'and a name bound to a file that is not a picture is code',
    inferType({ __expr: 'data', __asset: 'src/data/site.json' }) === 'code',
    inferType({ __expr: 'data', __asset: 'src/data/site.json' }),
  );
}
{
  const view = fs.readFileSync(repoPath('src/features/cms/CmsView.tsx'), 'utf8');
  const field = fs.readFileSync(repoPath('src/features/cms/CmsField.tsx'), 'utf8');
  check('the image field shows the file the name is bound to', /srcRel=\{reference\}/.test(field), 'the card would show the word instead of the picture');
  check(
    'and picking one goes through the file rather than writing a path',
    /if \(result\.ok\) \{\s*onChange\(result\.value\)/.test(field),
    'a picked asset would be written as a path a page cannot follow',
  );
  check(
    'a JSON collection keeps writing paths — it can hold no import',
    /pickAsset: model\.rel\.includes\('#'\) \? model\.pickAsset : undefined/.test(view),
    'a JSON file would be handed an identifier',
  );
  const main = readSourceGroup(['electron/handlers/cmsHandlers.ts', 'electron/handlers/cmsFiles.ts']);
  check(
    'a picked public/ file is a URL, not an import',
    /if \(root === 'public'\) \{\s*return \{ value: '\/' \+/.test(main),
    'public assets would be imported',
  );
  check('the same picture twice is one import', /const already = imports\.find\(/.test(main), 'a second import of the same file');
  check('and what is read carries what each name is bound to', /withAssets\(col\.data, assetOfImport\(/.test(main), 'the read hands over bare names');
}

if (failures.length) {
  console.error(`\nasset-ref: ${failures.length} failed, ${checked - failures.length} passed\n`);
  console.error(failures.join('\n') + '\n');
  process.exit(1);
}
console.log(`asset-ref: ${checked} passed  [a picture, set as the name it is imported under]`);
