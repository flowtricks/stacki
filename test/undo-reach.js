// What ⌘Z reaches.
//
//   node test/undo-reach.js
//
// Undo is a menu accelerator, so the key never reaches the page: whatever the
// handler in App.jsx decides is the only undo there is. It used to decide
//
//   if (pageStateRef.current.pageState && !cmsOpenRef.current) undo();
//
// which is "only while a page is open, and never in the CMS". Every view that
// is not a page recorded steps nobody could take: the variables panel, the
// assets panel, the CMS itself. A command carries its own inverse and needs no
// page open to run — and a snapshot with no page is dropped by undo() rather
// than applied, which is the case that guard was really about.
//
// The other half is typing. A field's undo belongs to the field: the app has no
// idea what was typed into a half-finished rename, and its own stack would jump
// somewhere else entirely. Since the accelerator swallows the key, the app has
// to hand that back deliberately.
//
// This is read from the source. The handler is three lines inside a 4700-line
// component wired to an Electron menu, and a harness able to render that would
// be testing itself.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const app = read('src', 'App.jsx');
const preload = read('electron', 'preload.js');
const main = read('electron', 'main.js');

// The handler, from the line that registers it to the one that registers redo.
const undoHandler = app.slice(
  app.indexOf("window.avb.onMenu('undo'"),
  app.indexOf("window.avb.onMenu('copy'")
);

check('undo is wired to the menu at all', undoHandler.length > 0, 'no onMenu(undo) handler');
check(
  'a page being open is no longer the price of undoing',
  !/pageStateRef\.current\.pageState\s*&&/.test(undoHandler),
  undoHandler.slice(0, 400)
);
check(
  'and neither is the CMS being closed',
  !/cmsOpenRef\.current/.test(undoHandler),
  undoHandler.slice(0, 400)
);
check('undo still runs', /\bundo\(\);/.test(undoHandler), undoHandler.slice(0, 400));
check('and redo', /\bredo\(\);/.test(undoHandler), undoHandler.slice(0, 400));

check(
  'typing gets its own undo back',
  /if \(inEditable\(\)\) \{\s*window\.avb\.nativeUndo/.test(undoHandler),
  'a field would lose its undo to the app’s stack'
);
check(
  'and its own redo',
  /if \(inEditable\(\)\) \{\s*window\.avb\.nativeRedo/.test(undoHandler),
  undoHandler.slice(0, 600)
);
// inEditable is what "typing" means here, and it is already used by copy and
// paste for the same reason.
check(
  'which means a field, a box or anything a caret is in',
  /el\.tagName === 'INPUT' \|\| el\.tagName === 'TEXTAREA' \|\| el\.isContentEditable/.test(app),
  'inEditable no longer covers the three'
);

// The bridge that hands it back. test/bridge.js checks every exposed method has
// a handler; this says which methods have to exist at all.
check('the bridge offers a native undo', /nativeUndo: invoke\('native:undo'\)/.test(preload));
check('and a native redo', /nativeRedo: invoke\('native:redo'\)/.test(preload));
check(
  'answered by the window that has the caret in it',
  /ipcMain\.handle\('native:undo'[\s\S]{0,120}webContents\.undo\(\)/.test(main),
  'native:undo does not reach webContents'
);
check(
  'and the same for redo',
  /ipcMain\.handle\('native:redo'[\s\S]{0,120}webContents\.redo\(\)/.test(main)
);

// --- what the panels record ------------------------------------------------------
//
// A panel that writes files outside the page model has to record its own
// inverse; nothing else can work it out afterwards. These are the ones that do,
// and the check is that they still do — the variables panel had three edits
// that wrote and said nothing, which is what "undo doesn't work here" was.
const vars = read('src', 'panels', 'VariablesView.jsx');
for (const [what, near] of [
  ['a value', "const save = useCallback"],
  ['a new variable', "const add = useCallback"],
  ['a row moved', "const move = useCallback"],
  ['a group moved', "const moveGroup = useCallback"],
  ['a group added', "const duplicateSection = useCallback"],
  ['a group deleted', "const deleteSection = useCallback"],
  ['a heading renamed', "const retitle = useCallback"],
]) {
  const at = vars.indexOf(near);
  const body = at === -1 ? '' : vars.slice(at, at + 1400);
  check(
    `the variables panel records ${what}`,
    at !== -1 && /writeWithUndo\(/.test(body),
    at === -1 ? `${near} is gone` : body.slice(0, 200)
  );
}
// A rename is the exception, and says so: its inverse is the rename backwards
// rather than a file put back, because it reaches files this panel never opened.
check(
  'and a rename records its own inverse',
  /onRecordUndo\?\.\(\{[\s\S]{0,200}undo: \(\) => apply\(back\)/.test(vars),
  'renaming would have nothing to undo with'
);
// Reading the files back is the inverse for the rest, so it has to cover every
// file an edit touched rather than the first one it happened to name.
check(
  'a multi-file edit is recorded as all of its files',
  /const list = \[\.\.\.new Set\(\(Array\.isArray\(rels\) \? rels : \[rels\]\)/.test(vars),
  'writeWithUndo still takes one file'
);

const assets = read('src', 'panels', 'AssetsPanel.jsx');
check('the assets panel records a move', /onRecordUndo\?\.\(\{/.test(assets));
const cms = read('src', 'panels', 'CmsView.jsx');
check('and the CMS records a save', /onRecordUndo\(\{/.test(cms));

if (failures.length) {
  console.error(`\nundo-reach: ${failures.length} failed, ${checked - failures.length} passed\n`);
  console.error(failures.join('\n') + '\n');
  process.exit(1);
}
console.log(`undo-reach: ${checked} passed  [what ⌘Z reaches]`);
