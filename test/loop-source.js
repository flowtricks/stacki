// The loop's data field: a source you can type past.
//
//   node test/loop-source.js
//
// Choosing a list used to replace the whole field with a purple button, which
// said what the source was and left nowhere to say anything else about it. A
// loop is over a list, but it is very often over part of one — `.filter(…)`,
// `.slice(0, 3)`, `[0]` — and none of that could be written without first
// switching the field to a different mode.
//
// So the source is a chip drawn inside the expression, over ordinary text: the
// value is exactly what the field holds, everything after the chip is code, and
// picking a different list swaps the chip while leaving that code alone.

const path = require('path');
const { pathToFileURL } = require('url');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

// The two rules the field is built on, as the panel defines them.
const SOURCE_RE = /^\s*([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)/;
const NO_SOURCE = '[]';

function sourceChip(value) {
  const text = String(value || '').trim();
  if (!text || text === NO_SOURCE) return '';
  const match = SOURCE_RE.exec(text);
  if (!match) return '';
  let name = match[1];
  // A segment that is called is not part of the path: `posts.filter(…)` is
  // `posts`, done to — and a call on the whole thing (`getPosts()`) names a
  // function, which is not a source anything can be swapped for.
  while (text[name.length] === '(') {
    const at = name.lastIndexOf('.');
    if (at < 0) return '';
    name = name.slice(0, at);
  }
  return name;
}

function withSource(value, path) {
  const current = sourceChip(value);
  if (!current) return path;
  const text = String(value);
  const at = text.indexOf(current);
  return text.slice(0, at) + path + text.slice(at + current.length);
}

(async () => {
  // The panel's own copies, so a change there fails here rather than drifting.
  const source = require('fs').readFileSync(
    path.join(__dirname, '..', 'src', 'panels', 'PropsPanel.jsx'),
    'utf8'
  );
  check('the panel still derives the source the same way', source.includes('function sourceChip('));
  check('and still swaps it in place', source.includes('function withSource('));
  check(
    'the field is the expression, not a button',
    /chip=\{sourceChip\(fields\.data\)\}/.test(source),
    'the Data field no longer passes its source as a chip'
  );

  // What counts as the source.
  check('a lone name is the whole of it', sourceChip('legalEntries') === 'legalEntries');
  check('a path is too', sourceChip('post.data.tags') === 'post.data.tags');
  check('what follows it is not', sourceChip('posts.filter(p => !p.draft)') === 'posts');
  check('an index is not', sourceChip('posts[0]') === 'posts');
  check('nor is a call on it', sourceChip('posts.slice(0, 3)') === 'posts');
  check('no source is no chip', sourceChip('[]') === '');
  check('an empty field is no chip', sourceChip('') === '');
  check('a literal is no chip', sourceChip('[1, 2, 3]') === '');
  check('a function call is no chip', sourceChip('getPosts()') === '', sourceChip('getPosts()'));

  // Choosing a different list keeps the code around it.
  check('picking replaces the source', withSource('posts', 'authors') === 'authors');
  check(
    'and keeps what was done to it',
    withSource('posts.filter(p => !p.draft)', 'authors') === 'authors.filter(p => !p.draft)',
    withSource('posts.filter(p => !p.draft)', 'authors')
  );
  check(
    'including an index',
    withSource('post.data.tags[0]', 'legalEntries') === 'legalEntries[0]',
    withSource('post.data.tags[0]', 'legalEntries')
  );
  check('picking into an empty field just sets it', withSource('', 'authors') === 'authors');
  check('and into a literal replaces it', withSource('[1, 2]', 'authors') === 'authors');

  // The chip is the control. A second button beside it opening the same picker
  // was two affordances for one job.
  check(
    'the chip opens the picker',
    /onChipClick=\{\(\) => \(sourceMenu \? setSourceMenu\(null\) : openSourceMenu\(\)\)\}/.test(source)
  );
  check(
    'and nothing else has to',
    !source.includes('prop-source-open'),
    'the chevron beside the Data field is back'
  );
  check(
    'and the press that opens it does not also close it',
    /\.bind-menu, \.bind-handle, \.dd-source, \.cm-chip/.test(source),
    'the picker treats the chip as outside itself, so a chip press opens and closes in one go'
  );

  // Data goes into the expression as well as choosing it: a slice needs its
  // length from somewhere.
  check('the Data field takes an insert', /apiRef=\{dataApiRef\}/.test(source));
  check('and so does the Code field', /apiRef=\{codeApiRef\}/.test(source));
  check(
    'both have a handle to open it with',
    (source.match(/<BindHandle\s+active=\{insertAt\?\.field ===/g) || []).length === 2
  );

  // Renaming the item is about the source, not the expression: typing a filter
  // after a list — or dropping a value into one — must not rename the item out
  // from under the children that reference it.
  const renames = (before, after) => sourceChip(before) !== sourceChip(after);
  check('a different list renames the item', renames('posts', 'authors'));
  check('a filter typed after it does not', !renames('posts', 'posts.filter(p => !p.draft)'));
  check('nor does a value dropped into one', !renames('posts.slice(0, 3)', 'posts.slice(0, count)'));
  check('and a first list still does', renames('[]', 'posts'));

  // The chip is a mark over text, so the value never contains anything but the
  // expression itself.
  const expr = require('fs').readFileSync(path.join(__dirname, '..', 'src', 'ui', 'ExprInput.jsx'), 'utf8');
  check('the chip is a mark, not a widget', /Decoration\.mark\(\{ class: 'cm-chip' \}\)/.test(expr));
  check('and clicking it is handled', /closest\('\.cm-chip'\)/.test(expr));
  check(
    'a chip whose text is edited away stops being one',
    /stops being a chip/.test(expr),
    'the decoration is mapped through edits instead of re-found'
  );

  if (failures.length) {
    console.error(`\nloop-source: ${failures.length} failed, ${checked - failures.length} passed\n`);
    console.error(failures.join('\n') + '\n');
    process.exit(1);
  }
  console.log(`loop-source: ${checked} passed`);
})();
