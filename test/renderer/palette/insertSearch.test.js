// Searching the insert palette.
//
//   node test/renderer/palette/insertSearch.test.js
//
// The palette lists things with two names: what the thing is called, and where
// it came from — `Input` in the `Form` folder, `Picture` from `astro:assets`.
// It searched the two as one string, prefix-first, and sorted by nothing else:
//
//   typing `form` put <form> in the middle of the components, because a tag and
//   a component tie at "starts with form";
//
//   typing `form ` — with the space — still offered FormattedDate, though the
//   space says the word is finished and FormattedDate is a different word;
//
//   and `Form Input`, which is how a person says which Input they mean, found
//   nothing at all: two words were one string, and no label contains it.
//
// So: words, each landing somewhere, with a finished word matching a word
// rather than beginning one. And a project's own components come first,
// wherever they matched — they are its vocabulary, and <form> is always there.

const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { repoPath } = require('../../helpers/sources.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) {
    failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
  }
};

(async () => {
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const out = path.join(buildDirectory, 'insert-rank.bundle.mjs');
  await esbuild.build({
    entryPoints: [repoPath('src/features/palette/insertRank.ts')],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
  });
  const { rankInsertItems, tagSearchText } = await import(
    `${pathToFileURL(out).href}?v=${Date.now()}`
  );

  // The palette's own shape: components carry the folder they came from, tags
  // carry the tag as their search text, and the rest are the odds and ends.
  const comp = (name, folder) => ({
    type: 'component',
    name,
    label: name,
    sub: folder,
    cat: 'components',
  });
  const tag = (tagName) => ({
    type: 'element',
    tag: tagName,
    label: `<${tagName}>`,
    search: tagName,
    cat: 'elements',
  });
  const ITEMS = [
    comp('Form', 'Form'),
    comp('FormattedDate', 'Utility'),
    comp('Choice', 'Form'),
    comp('Fieldset', 'Form'),
    comp('Input', 'Form'),
    comp('Select', 'Form'),
    comp('Textarea', 'Form'),
    comp('Card', 'Media'),
    {
      type: 'astroAsset',
      name: 'Image',
      label: '<Image>',
      sub: 'astro:assets',
      search: 'Image astro assets optimised',
      cat: 'components',
    },
    tag('form'),
    tag('input'),
    tag('select'),
    tag('div'),
    tag('textarea'),
    { type: 'map', label: 'Loop', sub: 'items.map', cat: 'other' },
    { type: 'text', label: 'Text', cat: 'other' },
  ];

  const names = (query) => rankInsertItems(ITEMS, query).map((i) => i.label);

  // --- a project's own things come first --------------------------------------------
  {
    const list = names('form');
    check('typing a word finds the component first', list[0] === 'Form', list.join(' | '));
    const firstTag = list.findIndex((label) => label.startsWith('<') && label !== '<Image>');
    const lastComp = list.reduce(
      (at, label, i) => (label.startsWith('<') && label !== '<Image>' ? at : i),
      -1,
    );
    check(
      'and no element sits above a component',
      firstTag === -1 || firstTag > lastComp,
      list.join(' | '),
    );
    check('the tag is still offered', list.includes('<form>'), list.join(' | '));
  }

  // --- a finished word is a word ------------------------------------------------------
  {
    const still = names('form');
    check(
      'while it is being typed, a beginning is enough',
      still.includes('FormattedDate'),
      still.join(' | '),
    );

    const done = names('form ');
    check('a space finishes it', !done.includes('FormattedDate'), done.join(' | '));
    check(
      'and what IS called form stays',
      done.includes('Form') && done.includes('<form>'),
      done.join(' | '),
    );
    check(
      'along with everything in the folder called Form',
      ['Choice', 'Fieldset', 'Input', 'Select', 'Textarea'].every((name) => done.includes(name)),
      done.join(' | '),
    );
    check('but nothing from another folder', !done.includes('Card'), done.join(' | '));
  }

  // A word finished by the NEXT word, not by a space of its own.
  {
    const list = names('form input');
    check('two words find the one thing they both land on', list[0] === 'Input', list.join(' | '));
    check('and not the other folders’ inputs', !list.includes('<input>'), list.join(' | '));
    check(
      'nor the component whose name merely starts that way',
      !list.includes('FormattedDate'),
      list.join(' | '),
    );
    check('nothing else creeps in', list.length === 1, list.join(' | '));
  }
  {
    const list = names('form select');
    check('the same for another of them', list.join(' | ') === 'Select', list.join(' | '));
  }
  // Order is not the point: a folder is a folder whichever end it is said from.
  {
    check(
      'said the other way round it is the same thing',
      names('input form')[0] === 'Input',
      names('input form').join(' | '),
    );
  }

  // --- the pieces of a name -------------------------------------------------------------
  {
    check(
      'a camelCase name can be found by its second word',
      names('date').includes('FormattedDate'),
      names('date').join(' | '),
    );
    check(
      'and by its first',
      names('formatted').includes('FormattedDate'),
      names('formatted').join(' | '),
    );
    check(
      'a name with a colon in it reads as it is written',
      names('astro:assets').includes('<Image>'),
      names('astro:assets').join(' | '),
    );
    check(
      'or by the word after it',
      names('assets').includes('<Image>'),
      names('assets').join(' | '),
    );
  }

  // --- what must not change --------------------------------------------------------------
  {
    check('an empty query is the list itself', rankInsertItems(ITEMS, '').length === ITEMS.length);
    check('and keeps its order', rankInsertItems(ITEMS, '')[0].label === 'Form');
    check('spaces alone are an empty query', rankInsertItems(ITEMS, '   ').length === ITEMS.length);
    check(
      'a word nothing answers to finds nothing',
      names('zzz').length === 0,
      names('zzz').join(' | '),
    );
    check(
      'the odds and ends are still findable',
      names('loop').includes('Loop'),
      names('loop').join(' | '),
    );
    // Both an element and an odd-and-end answer to "text", and the tabs say
    // which order they come in.
    const text = names('text');
    check(
      'an element is offered before the odds and ends',
      text.includes('<textarea>') && text.includes('Text'),
      text.join(' | '),
    );
    check('in that order', text.indexOf('<textarea>') < text.indexOf('Text'), text.join(' | '));
    check(
      'and both below the components',
      text.indexOf('Textarea') < text.indexOf('<textarea>'),
      text.join(' | '),
    );
  }

  // --- an element by what it is called ---------------------------------------------------
  // `p` and `img` are abbreviations; a person types `paragraph` and `image`.
  // The tag answers to its word but stays below the components that matched.
  {
    const words = (tagName) => ({ ...tag(tagName), search: tagSearchText(tagName) });
    const LISTED = [
      comp('Paragraph', 'Typography'),
      comp('Heading', 'Typography'),
      comp('ImageCard', 'Media'),
      comp('VideoEmbed', 'Media'),
      ...['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img', 'video', 'div'].map(words),
    ];
    const listed = (query) => rankInsertItems(LISTED, query).map((i) => i.label);
    const below = (list, component, tags) =>
      tags.every((label) => list.indexOf(label) > list.indexOf(component));

    const paragraph = listed('Paragraph');
    check('paragraph finds <p>', paragraph.includes('<p>'), paragraph.join(' | '));
    check('below the component', below(paragraph, 'Paragraph', ['<p>']), paragraph.join(' | '));

    const headings = ['<h1>', '<h2>', '<h3>', '<h4>', '<h5>', '<h6>'];
    const heading = listed('heading');
    check(
      'heading finds every level',
      headings.every((label) => heading.includes(label)),
      heading.join(' | '),
    );
    check('below the component', below(heading, 'Heading', headings), heading.join(' | '));
    check(
      'and in level order',
      headings.every((label, i) => heading.indexOf(label) === i + 1),
      heading.join(' | '),
    );

    const image = listed('image');
    check('image finds <img>', image.includes('<img>'), image.join(' | '));
    check('below the component', below(image, 'ImageCard', ['<img>']), image.join(' | '));

    const video = listed('video');
    check('video finds <video>', video.includes('<video>'), video.join(' | '));
    check('below the component', below(video, 'VideoEmbed', ['<video>']), video.join(' | '));

    const short = listed('p').filter((label) => label.startsWith('<'));
    check('the tag itself still leads the elements', short[0] === '<p>', short.join(' | '));
    check('an unnamed tag searches as itself', tagSearchText('div') === 'div');
    check('a word does not reach unrelated tags', !paragraph.includes('<div>'));
    let threw = '';
    try {
      tagSearchText('');
    } catch (error) {
      threw = String(error);
    }
    check(
      'an empty tag is a programmer error',
      threw.includes('An element search text needs a tag'),
      threw,
    );
  }

  // --- the palette asks for this ----------------------------------------------------------
  const palette = fs.readFileSync(repoPath('src/features/palette/InsertSearch.tsx'), 'utf8');
  check(
    'the palette ranks through it',
    /rankInsertItems\(items, query\)/.test(palette),
    'the palette scores its own way again',
  );
  check(
    'and hands it the query untrimmed, because the space means something',
    !/query\.trim\(\)/.test(palette),
    'a trimmed query cannot tell a finished word from an unfinished one',
  );

  if (failures.length) {
    console.error(
      `\ninsert-search: ${failures.length} failed, ${checked - failures.length} passed\n`,
    );
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`insert-search: ${checked} passed  [words, and where they land]`);
})();
