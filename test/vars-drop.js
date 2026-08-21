// Dropping a variable into a group.
//
//   node test/vars-drop.js
//
// A group in this sheet is not a container. It is a comment in the stylesheet,
// and the variables "in" it are simply the lines between that comment and the
// next one. So moving a variable into a group is moving its line — the same
// edit as reordering within a group, aimed at a different place.
//
// The drag used to be one list per group, which meant a row could only ever land
// among its own siblings: dropping it over another group fell through to "no
// row here", and the file edit that came out of that put the line at the end of
// the rule. The variable vanished from where it was aimed and turned up at the
// bottom of the panel.
//
// The sheet now drags over one list: every group's heading, its rows, and a
// slot at its end so a group with no rows of its own is still somewhere you can
// aim. A heading is in that list because it drags too, and on its own — moving a
// comment up past three variables is how those three come to be under it.
//
// This checks the part that decides what a drop means: which line it lands in
// front of, in every column the name is declared in, and whether the thing being
// dropped is a variable or the heading itself.

const fs = require('fs');
const os = require('os');
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
  const bundlePath = path.join(buildDir, 'vars-drop.bundle.js');
  await esbuild.build({
    stdin: {
      contents: `export { movesForDrop, dropPlan, friendlyError } from './src/panels/VariablesView.jsx'`,
      resolveDir: path.join(__dirname, '..'),
      loader: 'js',
    },
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  const { movesForDrop, dropPlan, friendlyError } = require(bundlePath);

  // Two groups in one file. The first has three swatches, the second is the
  // empty one you just made; a third has one variable in it.
  const cell = (name, column = '0', selector = ':root') => ({ name, file: 'src/styles/base.css', selector, column });
  const row = (name) => ({ name, label: name.slice(2), cells: [cell(name)] });
  // titleStart is where the group's comment sits in the file. A group that has
  // one is bounded by that comment, which is what makes "the end of this group"
  // a place in the text rather than "in front of the next variable".
  const swatches = { title: 'Swatches', titleStart: 10, rows: [row('--light-100'), row('--light-200'), row('--dark-900')] };
  const empty = { title: 'Palette', titleStart: 100, rows: [] };
  const radius = { title: 'Radius', titleStart: 200, rows: [row('--radius-main')] };
  const slotsOf = (blocks) => {
    const list = [];
    blocks.forEach((block, bi) => {
      if (block.title != null) list.push({ kind: 'heading', block, bi });
      block.rows.forEach((r) => list.push({ kind: 'row', block, row: r, bi }));
      list.push({ kind: 'end', block, bi });
    });
    return list;
  };
  const slots = slotsOf([swatches, empty, radius]);
  // 0 head(Swatches) | 1 --light-100 | 2 --light-200 | 3 --dark-900 | 4 end
  // 5 head(Palette)   | 6 end
  // 7 head(Radius)    | 8 --radius-main | 9 end

  // --- within a group -------------------------------------------------------
  {
    const moves = movesForDrop(slots, 3, 1);
    check('a row dropped above another lands in front of it', moves.length === 1 && moves[0].name === '--dark-900' && moves[0].target === '--light-100', JSON.stringify(moves));
    const down = movesForDrop(slots, 1, 3);
    check('and dragging downwards lands in front of the one it stopped at', down[0]?.target === '--dark-900', JSON.stringify(down));
    check('dropping a row where it already is does nothing', movesForDrop(slots, 2, 2).length === 0, JSON.stringify(movesForDrop(slots, 2, 2)));
  }

  // --- into another group ---------------------------------------------------
  {
    // The empty group's own slot: the line lands in front of whatever follows
    // the empty group, which is the first line of the group after it — so it
    // ends up between the two comments, which is what "inside" means here.
    const moves = movesForDrop(slots, 1, 6);
    check('dropping into an empty group moves the line there', moves.length === 1 && moves[0].name === '--light-100', JSON.stringify(moves));
    // Not "in front of the next variable" — that variable is on the far side of
    // the next comment, and landing in front of it would put the line in the
    // next group. The group ends at that comment, so that is where it goes.
    check('landing in front of the comment that ends that group', moves[0].at === radius.titleStart, JSON.stringify(moves));

    const intoRadius = movesForDrop(slots, 1, 8);
    check('dropping onto a row in another group lands in front of it', intoRadius[0]?.target === '--radius-main', JSON.stringify(intoRadius));

    // The end of the last group has nothing after it: the line goes to the end
    // of the rule, which is still inside that last group.
    const toEnd = movesForDrop(slots, 1, 9);
    check('dropping past everything goes to the end of the rule', toEnd.length === 1 && toEnd[0].target === null, JSON.stringify(toEnd));

    // The slot at the end of a group with rows means "after its last row",
    // which is the same as in front of the next group's first row.
    const afterSwatches = movesForDrop(slots, 1, 4);
    check("a group's own end slot keeps the row in that group", afterSwatches[0]?.at === empty.titleStart, JSON.stringify(afterSwatches));
  }

  // --- a row that is one name in several rules ------------------------------
  {
    // A table of modes: each row is the same name declared in every mode, and
    // it has to move in each of them or the columns drift apart.
    const modeRow = (name) => ({
      name,
      label: name.slice(2),
      cells: [cell(name, '0', ':root'), cell(name, '1', '.theme-dark')],
    });
    const a = { title: 'a', rows: [modeRow('--background'), modeRow('--text')] };
    const b = { title: 'b', rows: [modeRow('--link')] };
    const modeSlots = slotsOf([a, b]);
    // These headings are shared name prefixes rather than comments (no
    // titleStart), so a name is the right thing to land in front of.
    const moves = movesForDrop(modeSlots, 1, 4); // --background into group b
    check('a row in modes moves in every rule it is declared in', moves.length === 2, JSON.stringify(moves));
    check('each in its own rule', moves.map((m) => m.selector).join('|') === ':root|.theme-dark', JSON.stringify(moves.map((m) => m.selector)));
    check('and each in front of that rule’s copy of the target', moves.every((m) => m.target === '--link'), JSON.stringify(moves));
  }

  // --- rows a column does not have ------------------------------------------
  {
    // A name declared in one mode and not another: nothing to move in the mode
    // that never had it.
    const partial = { title: 'a', rows: [{ name: '--only-light', label: 'only-light', cells: [cell('--only-light'), null] }, { name: '--both', label: 'both', cells: [cell('--both', '0'), cell('--both', '1', '.theme-dark')] }] };
    const partialSlots = slotsOf([partial]);
    const moves = movesForDrop(partialSlots, 1, 3);
    check('a column with no cell for that row is skipped', moves.length === 1 && moves[0].name === '--only-light', JSON.stringify(moves));
  }

  // --- nothing to do --------------------------------------------------------
  {
    check('dragging the end slot itself moves nothing', movesForDrop(slots, 4, 1).length === 0);
    check('and dragging a heading is not a variable move', movesForDrop(slots, 0, 8).length === 0);
    check('an out-of-range drag moves nothing', movesForDrop(slots, 99, 1).length === 0);
    check('and no slots at all is not an error', movesForDrop([], 0, 0).length === 0);
  }

  // --- when the app is half a version behind itself -------------------------
  //
  // Reloading the window rebuilds the bridge but not the main process behind
  // it, so a call added during a session exists on one side and not the other.
  // What comes back is "No handler registered for 'css:moveHeading'", which
  // reads like a broken feature instead of an app that needs restarting.
  {
    const missing = friendlyError(new Error("Error invoking remote method 'css:moveHeading': Error: No handler registered for 'css:moveHeading'"));
    check('a missing handler says to restart', /restarted/i.test(missing), missing);
    check('and does not say it in Electron’s words', !/No handler registered/.test(missing), missing);

    const real = friendlyError(new Error("Error invoking remote method 'css:moveHeading': Error: EACCES: permission denied"));
    check('a real failure still says what happened', real === 'EACCES: permission denied', real);
    check('a plain string is handled', typeof friendlyError('nope') === 'string');
  }

  // --- dragging the heading itself -----------------------------------------
  //
  // The other half of the same gesture. A heading moves alone: whichever
  // variables end up below it are the ones it heads, which is the only way a
  // group's membership can change other than moving the variables themselves.
  {
    const plan = dropPlan(slots, 0, 3); // Swatches' heading, dropped on --dark-900
    check('dragging a heading is a heading move', plan?.kind === 'heading', JSON.stringify(plan));
    check('landing above the variable it was dropped on', plan?.before === '--dark-900', JSON.stringify(plan));
    check('and it carries no variables with it', plan?.moves === undefined, JSON.stringify(plan));

    const toEnd = dropPlan(slots, 0, 9);
    check('dropped past everything it heads nothing yet', toEnd?.kind === 'heading' && toEnd.before === null, JSON.stringify(toEnd));

    const intoOther = dropPlan(slots, 7, 2);
    check('a heading can be dropped into the middle of another group', intoOther?.kind === 'heading' && intoOther.before === '--light-200', JSON.stringify(intoOther));

    check('a heading dropped where it already is does nothing', dropPlan(slots, 0, 0) === null, JSON.stringify(dropPlan(slots, 0, 0)));
    check('and dropped just below itself does nothing either', dropPlan(slots, 0, 1) === null, JSON.stringify(dropPlan(slots, 0, 1)));

    const rowPlan = dropPlan(slots, 1, 8);
    check('a row still plans a row move', rowPlan?.kind === 'rows' && rowPlan.moves[0].name === '--light-100', JSON.stringify(rowPlan));
  }

  // --- and then actually doing it -------------------------------------------
  //
  // The mapping above is what a drop MEANS; this is what the file says
  // afterwards. It is here because the mapping was right in its own terms and
  // still put the variable in the wrong group: "in front of the next variable"
  // reads past the comment that ends the group. Nothing catches that except
  // moving a line in a real file and reading the groups back.
  {
    const cssVars = require('../electron/cssVars.js');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-drop-'));
    fs.mkdirSync(path.join(dir, 'src', 'styles'), { recursive: true });
    const sheet = path.join(dir, 'src', 'styles', 't.css');
    // The shape that broke: variables, an EMPTY group, then another group. It is
    // what you get by duplicating a group, which is how you make an empty one.
    fs.writeFileSync(sheet, `:root {
  --light-100: #fff;
  --light-200: #eee;

  /* Swatches */

  /* Typography */
  --primary-family: system-ui;
  --primary-bold: 700;
}
`);
    const blocksNow = () => cssVars.readVariables(dir).files[0].groups[0].blocks;
    const groupsNow = () => blocksNow().map((b) => `${b.title}:${b.rows.map((r) => r.name).join(',')}`).join(' | ');
    const liveSlots = () => slotsOf(blocksNow());

    // Drop --light-100 on the empty group's own line.
    let live = liveSlots();
    const emptyEnd = live.findIndex((slot) => slot.kind === 'end' && slot.block.title === 'Swatches');
    const intoEmpty = movesForDrop(live, 0, emptyEnd);
    for (const m of intoEmpty) cssVars.moveVariable(dir, m);
    check('a variable dropped into an empty group ends up in it', groupsNow().includes('Swatches:--light-100'), groupsNow());
    check('and not in the group after it', !groupsNow().includes('Typography:--light-100'), groupsNow());

    // And onto a variable in another group: in front of that one.
    live = liveSlots();
    const onBold = live.findIndex((slot) => slot.kind === 'row' && slot.row.name === '--primary-bold');
    const light200 = live.findIndex((slot) => slot.kind === 'row' && slot.row.name === '--light-200');
    for (const m of movesForDrop(live, light200, onBold)) cssVars.moveVariable(dir, m);
    check('a variable dropped onto another lands in front of it', /--light-200: #eee;\n\s*--primary-bold/.test(fs.readFileSync(sheet, 'utf8')), fs.readFileSync(sheet, 'utf8'));
    check('which puts it in that group', groupsNow().includes('Typography:--primary-family,--light-200,--primary-bold'), groupsNow());

    // Dropped past everything: the end of the rule, inside the last group.
    live = liveSlots();
    const first = live.findIndex((slot) => slot.kind === 'row');
    for (const m of movesForDrop(live, first, live.length)) cssVars.moveVariable(dir, m);
    check('a variable dropped past everything goes to the last group', groupsNow().endsWith('--primary-bold,--light-100') || groupsNow().includes('--primary-bold,--light-100'), groupsNow());

    fs.rmSync(dir, { recursive: true, force: true });
  }

  if (failures.length) {
    console.error(`vars-drop: ${failures.length} of ${checked} failed\n${failures.join('\n')}`);
    process.exit(1);
  }
  console.log(`vars-drop: ${checked} passed  [within a group, into another, into an empty one]`);
})();
