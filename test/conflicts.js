// Reading a conflicted file, and putting it back together.
//
//   node test/conflicts.js
//
// This is the code that lets someone keep the heading from one branch and the
// footer from the other, so its failures are the worst kind an editor can
// have: a file that is rebuilt slightly wrong, saved, and looks fine until
// somebody notices a line is missing. Nothing throws.
//
// The rule everything here is checked against: **every line is accounted
// for.** Text outside the markers must survive exactly, text inside must
// appear if it was chosen and not if it wasn't, and a file with markers this
// cannot understand must keep all of its lines rather than losing the parts it
// failed to parse.

const { parseConflict, renderResolved, clashCount, threeWay, mergeInline } = require('../electron/conflicts.js');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const conflicted = [
  'top unchanged',
  '<<<<<<< HEAD',
  'HERO MAIN',
  '=======',
  'HERO FEATURE',
  '>>>>>>> feature',
  'middle unchanged',
  '<<<<<<< HEAD',
  'FOOTER MAIN',
  '=======',
  'FOOTER FEATURE',
  '>>>>>>> feature',
  'bottom unchanged',
].join('\n');

// --- Reading it -------------------------------------------------------------
{
  const parts = parseConflict(conflicted);
  check('both disagreements are found', clashCount(parts) === 2, String(clashCount(parts)));
  const clashes = parts.filter((p) => p.kind === 'clash');
  check('this branch’s side is read', clashes[0].ours === 'HERO MAIN', clashes[0].ours);
  check('and the incoming side', clashes[0].theirs === 'HERO FEATURE', clashes[0].theirs);
  check('the second one too', clashes[1].ours === 'FOOTER MAIN', clashes[1].ours);
  // The markers themselves must never survive into a rebuilt file.
  check(
    'no marker text is kept as content',
    !parts.some((p) => JSON.stringify(p).includes('<<<<<<<') || JSON.stringify(p).includes('=======')),
    JSON.stringify(parts)
  );
}

// --- Putting it back --------------------------------------------------------
{
  const parts = parseConflict(conflicted);
  const ours = renderResolved(parts, ['ours', 'ours']);
  check(
    'keeping this branch throughout gives this branch’s file',
    ours === 'top unchanged\nHERO MAIN\nmiddle unchanged\nFOOTER MAIN\nbottom unchanged',
    JSON.stringify(ours)
  );
  const theirs = renderResolved(parts, ['theirs', 'theirs']);
  check(
    'keeping the incoming one gives theirs',
    theirs === 'top unchanged\nHERO FEATURE\nmiddle unchanged\nFOOTER FEATURE\nbottom unchanged',
    JSON.stringify(theirs)
  );
  // The point of the whole feature: part of the file from each branch.
  const mixed = renderResolved(parts, ['theirs', 'ours']);
  check(
    'one from each branch is possible',
    mixed === 'top unchanged\nHERO FEATURE\nmiddle unchanged\nFOOTER MAIN\nbottom unchanged',
    JSON.stringify(mixed)
  );
  const both = renderResolved(parts, ['both', 'ours']);
  check(
    'keeping both puts them one after the other',
    both === 'top unchanged\nHERO MAIN\nHERO FEATURE\nmiddle unchanged\nFOOTER MAIN\nbottom unchanged',
    JSON.stringify(both)
  );
  // Agreed text is not the part being chosen between, and must come through
  // untouched no matter what is picked.
  for (const picks of [['ours', 'ours'], ['theirs', 'theirs'], ['theirs', 'ours'], ['both', 'both']]) {
    const out = renderResolved(parts, picks);
    check(
      `agreed text survives ${picks.join('/')}`,
      out.includes('top unchanged') && out.includes('middle unchanged') && out.includes('bottom unchanged'),
      out
    );
  }
}

// --- Answers that are missing or wrong --------------------------------------
{
  const parts = parseConflict(conflicted);
  // No answers at all keeps this branch's work. The incoming version is still
  // on its branch; the user's own may exist nowhere else.
  const none = renderResolved(parts, []);
  check('no answer keeps your own work', none.includes('HERO MAIN') && !none.includes('HERO FEATURE'), none);
  check('an unknown answer does the same', renderResolved(parts, ['sideways', 'ours']).includes('HERO MAIN'));
  check('a missing picks argument does not throw', renderResolved(parts).includes('HERO MAIN'));
  check('and neither does a missing file', renderResolved(undefined, ['ours']) === '');
}

// --- Files that are not what we expect --------------------------------------
{
  const plain = 'just a file\nwith two lines';
  const parts = parseConflict(plain);
  check('a file with no conflict has nothing to choose', clashCount(parts) === 0);
  check('and rebuilds byte for byte', renderResolved(parts, []) === plain, JSON.stringify(renderResolved(parts, [])));

  check('empty text is handled', renderResolved(parseConflict(''), []) === '');
  check('null text is handled', renderResolved(parseConflict(null), []) === '');

  // A marker somebody left in by hand, never closed. Every line has to
  // survive: dropping the tail would silently delete the rest of the file.
  const broken = 'before\n<<<<<<< HEAD\nsomething\nafter';
  const brokenParts = parseConflict(broken);
  check('an unclosed marker is not treated as a conflict', clashCount(brokenParts) === 0, JSON.stringify(brokenParts));
  check('and no line is lost', renderResolved(brokenParts, []) === broken, JSON.stringify(renderResolved(brokenParts, [])));

  // One side empty — a block added on one branch and absent on the other.
  const added = 'a\n<<<<<<< HEAD\n=======\nnew from them\n>>>>>>> feature\nb';
  const addedParts = parseConflict(added);
  check('a one-sided change is still a choice', clashCount(addedParts) === 1);
  check('taking theirs adds the block', renderResolved(addedParts, ['theirs']) === 'a\nnew from them\nb', JSON.stringify(renderResolved(addedParts, ['theirs'])));
  // The empty side must not leave a blank line behind where nothing was.
  check('taking ours leaves nothing behind', renderResolved(addedParts, ['ours']) === 'a\n\nb', JSON.stringify(renderResolved(addedParts, ['ours'])));
  check('both is just the one that exists', renderResolved(addedParts, ['both']) === 'a\nnew from them\nb', JSON.stringify(renderResolved(addedParts, ['both'])));
}

// --- diff3, which carries the common ancestor too ---------------------------
{
  // Some people set merge.conflictStyle=diff3 globally, which adds a third
  // section. It is what both sides started from, not a third option — reading
  // it as one of the two would offer the user a version nobody wrote.
  const diff3 = [
    'a',
    '<<<<<<< HEAD',
    'mine',
    '||||||| base',
    'the original',
    '=======',
    'theirs',
    '>>>>>>> feature',
    'b',
  ].join('\n');
  const parts = parseConflict(diff3);
  check('diff3 markers still give one disagreement', clashCount(parts) === 1, JSON.stringify(parts));
  const clash = parts.find((p) => p.kind === 'clash');
  check('with this branch’s side', clash.ours === 'mine', JSON.stringify(clash.ours));
  check('and the incoming side', clash.theirs === 'theirs', JSON.stringify(clash.theirs));
  check('and the ancestor offered as neither', !JSON.stringify(clash).includes('the original'), JSON.stringify(clash));
  check('rebuilding drops the ancestor', renderResolved(parts, ['ours']) === 'a\nmine\nb', JSON.stringify(renderResolved(parts, ['ours'])));
}

// --- Splitting one conflict into the decisions it really contains -----------
//
// The case this was built for, and the one that made the whole dialog feel
// wrong before it: a branch is made, the heading is changed on one side and
// the paragraph beneath it on the other. Git reports that as ONE conflict,
// because the two edits are adjacent — and no answer to it is right. Keeping
// either side loses an edit; keeping "both" duplicates the heading AND the
// paragraph.
//
// The two sides cannot be told apart by comparing them to each other: every
// line differs. What separates them is the ancestor.
{
  const conflicted = [
    '<<<<<<< HEAD',
    '  <h2>Heading 2</h2>',
    '  <p>Paragraph EDITED ON MAIN</p>',
    '||||||| base',
    '  <h2>Heading 2</h2>',
    '  <p>Paragraph original</p>',
    '=======',
    '  <h2>Heading 3</h2>',
    '  <p>Paragraph original</p>',
    '>>>>>>> new-branch',
  ].join('\n');
  const parts = parseConflict(conflicted);

  check('two adjacent edits are two decisions', clashCount(parts) === 2, JSON.stringify(parts));
  const clashes = parts.filter((p) => p.kind === 'clash');
  // And each is attributed to the branch that actually made it, which is what
  // lets the dialog answer them without asking.
  check('the heading is credited to the incoming branch', clashes[0].changedBy === 'theirs', JSON.stringify(clashes[0]));
  check('the paragraph to this one', clashes[1].changedBy === 'ours', JSON.stringify(clashes[1]));

  // Defaulting to whoever changed each part gives exactly what was wanted,
  // with nothing to pick by hand.
  const picks = clashes.map((c) => (c.changedBy === 'theirs' ? 'theirs' : 'ours'));
  const out = renderResolved(parts, picks);
  check('the heading comes from the branch that changed it', out.includes('Heading 3'), out);
  check('the paragraph from the branch that changed it', out.includes('EDITED ON MAIN'), out);
  check('and nothing is duplicated', !out.includes('Heading 2') && !out.includes('Paragraph original'), out);
  check('the file has just the two lines', out.split('\n').filter((l) => l.trim()).length === 2, JSON.stringify(out));
}

// --- Edits that really do overlap stay one decision -------------------------
{
  // Both branches rewrote the same line. There is no splitting this: it is a
  // genuine disagreement and has to be asked about.
  const conflicted = [
    '<<<<<<< HEAD',
    'title from main',
    '||||||| base',
    'the original title',
    '=======',
    'title from feature',
    '>>>>>>> feature',
  ].join('\n');
  const parts = parseConflict(conflicted);
  check('one line both changed is one decision', clashCount(parts) === 1, JSON.stringify(parts));
  check('and is marked as a real disagreement', parts.find((p) => p.kind === 'clash').changedBy === 'both');
}

// --- The ancestor is never offered as a version -----------------------------
{
  const parts = parseConflict(
    ['<<<<<<< HEAD', 'mine', '||||||| base', 'ORIGINAL', '=======', 'theirs', '>>>>>>> f'].join('\n')
  );
  const out = JSON.stringify(parts);
  check('the ancestor is not one of the choices', !out.includes('ORIGINAL'), out);
  check('and never lands in the rebuilt file', !renderResolved(parts, ['both']).includes('ORIGINAL'));
}

// --- The splitter on its own ------------------------------------------------
{
  const base = ['a', 'b', 'c', 'd'];
  // One side changes the first line, the other the last: two decisions, with
  // the untouched middle no longer part of either.
  const runs = threeWay(base, ['A', 'b', 'c', 'd'], ['a', 'b', 'c', 'D']);
  const clashes = runs.filter((r) => !r.common);
  check('separate edits split apart', clashes.length === 2, JSON.stringify(runs));
  check('each credited to its own side', clashes[0].changedBy === 'ours' && clashes[1].changedBy === 'theirs', JSON.stringify(clashes));
  check('untouched lines are common', runs.some((r) => r.common && r.common.includes('b')), JSON.stringify(runs));

  // Nothing changed on either side: no decisions at all.
  const none = threeWay(base, base, base).filter((r) => !r.common);
  check('an unchanged region asks nothing', none.length === 0, JSON.stringify(none));

  // One side deleted lines the other left alone.
  const del = threeWay(base, ['a', 'd'], base).filter((r) => !r.common);
  check('a deletion is one decision', del.length === 1, JSON.stringify(del));
  check('credited to the side that deleted', del[0].changedBy === 'ours', JSON.stringify(del[0]));
  check('with the other side keeping the lines', del[0].theirs.join(',') === 'b,c', JSON.stringify(del[0]));
}

// --- Two edits to the same line that never touch each other -----------------
//
// The finest grain this goes to, and the one that turns the commonest "real"
// conflict into no conflict at all: a class added to a heading on one branch
// while the words inside it were rewritten on the other. Both edited the same
// line, so git reports a clash and a line-level answer throws one edit away —
// but inside the line the changes are nowhere near each other.
//
// The danger here is the opposite of losing an edit: inventing one. A combined
// line that neither branch wrote, presented as though it were a merge, would
// be worse than asking. So the refusals are checked as carefully as the merge.
{
  check(
    'a class on one side and new words on the other combine',
    mergeInline('<h2>Hi</h2>', '<h2 class="a">Hi</h2>', '<h2>Hello</h2>') === '<h2 class="a">Hello</h2>',
    JSON.stringify(mergeInline('<h2>Hi</h2>', '<h2 class="a">Hi</h2>', '<h2>Hello</h2>'))
  );
  // Whitespace has to come through exactly. A merge that quietly reindents is
  // a merge nobody can trust with a template.
  check(
    'indentation is preserved exactly',
    mergeInline('  <p>a</p>', '  <p class="x">a</p>', '  <p>b</p>') === '  <p class="x">b</p>',
    JSON.stringify(mergeInline('  <p>a</p>', '  <p class="x">a</p>', '  <p>b</p>'))
  );

  // Both rewrote the same words: a real disagreement, and combining would
  // produce a line neither branch wrote.
  check(
    'the same words rewritten twice is still a question',
    mergeInline('<h2>Title</h2>', '<h2>From main</h2>', '<h2>From branch</h2>') === null
  );
  // Both added something at the same place — the order would be invented.
  check(
    'two attributes added at the same spot is still a question',
    mergeInline('<h2>Hi</h2>', '<h2 class="a">Hi</h2>', '<h2 id="b">Hi</h2>') === null
  );
  check('with no ancestor it will not guess', mergeInline(null, 'a', 'b') === null);
  check('and an unchanged line offers nothing', mergeInline('same', 'same', 'same') === null);
}

// --- The combined version, end to end ---------------------------------------
{
  const conflicted = [
    '<<<<<<< HEAD',
    '  <h2 class="title">Heading 2</h2>',
    '||||||| base',
    '  <h2>Heading 2</h2>',
    '=======',
    '  <h2>Heading 3</h2>',
    '>>>>>>> new-branch',
  ].join('\n');
  const parts = parseConflict(conflicted);
  const clash = parts.find((p) => p.kind === 'clash');
  check('a combinable clash carries the combined text', clash.merged != null, JSON.stringify(clash));
  check(
    'holding both edits',
    clash.merged === '  <h2 class="title">Heading 3</h2>',
    JSON.stringify(clash.merged)
  );
  check('and it is still marked as both having changed', clash.changedBy === 'both');
  check(
    'choosing it rebuilds the file with both',
    renderResolved(parts, ['merged']) === '  <h2 class="title">Heading 3</h2>',
    JSON.stringify(renderResolved(parts, ['merged']))
  );
  // Either side on its own must still be reachable — the combination is a
  // default, not a decision taken away.
  check('one side alone is still available', renderResolved(parts, ['ours']).includes('Heading 2'));
  check('and the other', renderResolved(parts, ['theirs']).includes('Heading 3'));

  // A clash with nothing to combine must not grow a merged version, or the UI
  // would offer a button that silently means "ours".
  const plain = parseConflict(
    ['<<<<<<< HEAD', 'aaa', '||||||| base', 'bbb', '=======', 'ccc', '>>>>>>> f'].join('\n')
  ).find((p) => p.kind === 'clash');
  check('an uncombinable clash has no combined version', plain.merged === undefined, JSON.stringify(plain));
  // Asking for one anyway falls back rather than rendering "undefined".
  check(
    'and asking for one falls back to your side',
    renderResolved([plain], ['merged']) === 'aaa',
    JSON.stringify(renderResolved([plain], ['merged']))
  );
}

if (failures.length) {
  console.error(`conflicts: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
  process.exit(1);
}
console.log(`conflicts: ${checked} passed`);
