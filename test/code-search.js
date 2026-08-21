// Find, inside a code block.
//
//   node test/code-search.js
//
// ⌘F in a code editor opens CodeMirror's search panel — a real piece of UI that
// arrives with browser-default chrome: a bare text field, grey bevelled buttons,
// native checkboxes. In an app with none of that anywhere else, it read as a form
// pasted into the editor.
//
// The markup stays CodeMirror's, so every command, shortcut and screen-reader
// label keeps working, and only its appearance is ours. That trade has a catch
// worth a test: we don't own the DOM we're styling. A CodeMirror upgrade that
// renames a control, or adds one, would leave a native-looking button sitting in
// the middle of the panel and nothing would say so. So this builds the panel the
// way the installed @codemirror/search builds it — reading the control names out
// of the package itself — and checks our rules actually land on it.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const root = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

// ── What CodeMirror actually renders ────────────────────────────────────────
// The SearchPanel constructor, straight from the installed package.
const searchSrc = read('node_modules/@codemirror/search/dist/index.js');
const panelSrc = searchSrc.slice(
  searchSrc.indexOf('class SearchPanel'),
  searchSrc.indexOf('commit()', searchSrc.indexOf('class SearchPanel'))
);
// Fields name themselves in their element spec; buttons are made by a helper
// that takes the name as its first argument.
const controlNames = [...new Set([
  ...[...panelSrc.matchAll(/name: "([a-zA-Z]+)"/g)].map((m) => m[1]),
  ...[...panelSrc.matchAll(/button\("([a-zA-Z]+)"/g)].map((m) => m[1]),
])];

check(
  'the panel is still built out of named controls',
  controlNames.length >= 8,
  controlNames.join(', ')
);

// The shape we style. Every name above must appear here — if CodeMirror grows a
// control, this list stops matching and the test says so rather than the panel
// quietly rendering one unstyled button.
const MIRROR = {
  search: '<input class="cm-textfield" name="search" main-field="true">',
  replace: '<input class="cm-textfield" name="replace">',
  case: '<label><input type="checkbox" name="case">match case</label>',
  re: '<label><input type="checkbox" name="re">regexp</label>',
  word: '<label><input type="checkbox" name="word">by word</label>',
  next: '<button class="cm-button" name="next">next</button>',
  prev: '<button class="cm-button" name="prev">previous</button>',
  select: '<button class="cm-button" name="select">all</button>',
  replaceAll: '<button class="cm-button" name="replaceAll">replace all</button>',
  close: '<button name="close">×</button>',
};
const missing = controlNames.filter((name) => !(name in MIRROR));
check(
  'and every one of them is a control this styling knows about',
  missing.length === 0,
  `unstyled: ${missing.join(', ')}`
);

const { JSDOM } = require('jsdom');
const dom = new JSDOM(`<!doctype html><div class="cm-editor cm-dark">
  <div class="cm-scroller"><div class="cm-content"><div class="cm-line">
    a <span class="cm-searchMatch">hit</span> and
    <span class="cm-searchMatch cm-searchMatch-selected">this one</span>
  </div></div></div>
  <div class="cm-panels cm-panels-top"></div>
  <div class="cm-panels cm-panels-bottom"><div class="cm-panel cm-search">
    ${MIRROR.search}
    ${MIRROR.next}${MIRROR.prev}${MIRROR.select}
    <label><input type="checkbox" name="case" checked>match case</label>
    ${MIRROR.re}${MIRROR.word}
    <br>
    ${MIRROR.replace}
    <button class="cm-button" name="replace">replace</button>
    ${MIRROR.replaceAll}
    ${MIRROR.close}
  </div></div>
</div>`);
const doc = dom.window.document;

// ── What our stylesheet says about it ───────────────────────────────────────
const postcss = require('postcss');
const sheet = postcss.parse(read('src/styles.css'));
const panelRules = [];
const narrowRules = [];
sheet.walkRules((rule) => {
  if (!/\.cm-panel|\.cm-panels|\.cm-search/.test(rule.selector)) return;
  const inContainer = rule.parent?.type === 'atrule' && rule.parent.name === 'container';
  ;(inContainer ? narrowRules : panelRules).push(rule);
});

check('the panel has styling of its own', panelRules.length > 10, `${panelRules.length} rules`);
check('including a compact form for narrow editors', narrowRules.length > 0, `${narrowRules.length} rules`);

// Every rule must hit something. A selector that matches nothing is styling
// written against a panel that no longer exists.
// ::placeholder / ::after aren't queryable, and a state pseudo asks about a
// moment rather than a shape — drop both and ask what the rule is aimed at.
const queryableForm = (selector) =>
  selector
    .replace(/::[a-z-]+$/, '')
    .replace(/:(hover|focus-visible|focus|active)\b/g, '')
    .replace(/:has\(\s*\)/g, ':has(*)');
const dead = [];
for (const rule of [...panelRules, ...narrowRules]) {
  for (const selector of rule.selectors) {
    let hit = false;
    try { hit = doc.querySelectorAll(queryableForm(selector)).length > 0 } catch { hit = false }
    if (!hit) dead.push(selector);
  }
}
check('and no rule is written against a panel that no longer exists', dead.length === 0, dead.join('\n    '));

// Every control is covered by at least one rule.
const covered = (el) =>
  [...panelRules, ...narrowRules].some((rule) =>
    rule.selectors.some((selector) => {
      try { return [...doc.querySelectorAll(queryableForm(selector))].includes(el) } catch { return false }
    })
  );
const q = (sel) => doc.querySelector(sel);
for (const [what, sel] of [
  ['the query field', '.cm-search input[name=search]'],
  ['the replace field', '.cm-search input[name=replace]'],
  ['find next', '.cm-search [name=next]'],
  ['find previous', '.cm-search [name=prev]'],
  ['select all', '.cm-search [name=select]'],
  ['replace', '.cm-search [name=replace].cm-button'],
  ['replace all', '.cm-search [name=replaceAll]'],
  ['close', '.cm-search [name=close]'],
  ['the match-case toggle', '.cm-search label:has([name=case])'],
  ['the regexp toggle', '.cm-search label:has([name=re])'],
  ['the whole-word toggle', '.cm-search label:has([name=word])'],
]) {
  const el = q(sel);
  check(`${what} is styled`, !!el && covered(el), sel);
}

// The panel's own line break is what puts replace on its own row; flexbox only
// honours it when it's given the full width.
const brRule = panelRules.find((rule) => /\bbr\b/.test(rule.selector));
check(
  'the row break is given a row to break',
  !!brRule && /flex-basis:\s*100%/.test(brRule.toString()),
  brRule?.toString()
);

// The magnifier in the query field is a background IMAGE, so anything setting
// the `background` shorthand on that field — including on :focus, where this
// went wrong once — wipes it.
const fieldRules = panelRules.filter((rule) => /input(\.cm-textfield|\[name=search\])/.test(rule.selector));
const shorthand = fieldRules.filter((rule) => rule.some((decl) => decl.prop === 'background'));
check(
  'nothing paints over the query field with the background shorthand',
  shorthand.length === 0,
  shorthand.map((r) => r.selector).join(', ')
);
check(
  'and the field carries a magnifier',
  fieldRules.some((rule) => rule.some((decl) => decl.prop === 'background-image' && /svg/.test(decl.value))),
  fieldRules.map((r) => r.selector).join(', ')
);

// ── Where it opens ─────────────────────────────────────────────────────────
// At the top. CodeMirror's default is the bottom, which is where a search that
// has run tends to leave you — the panel lands over the very lines it found.
for (const [what, file] of [
  ['the app editor', 'src/ui/CodeEditor.jsx'],
  ['the style panel editor', 'src/style-panel/components/CodeEditor.tsx'],
]) {
  check(`${what} opens find at the top`, /search\(\{\s*top:\s*true\s*\}\)/.test(read(file)), file);
}
check(
  'and the top panel is the one the divider goes under',
  panelRules.some((rule) => /cm-panels-top/.test(rule.selector) && /border-bottom/.test(rule.toString())),
  'a panel at the top needs its line below it, not above'
);

// ── The matches themselves ──────────────────────────────────────────────────
// CodeMirror's defaults for these (cyan on dark, magenta for the current one)
// ship in a BASE theme, which a plain stylesheet rule ties with rather than
// beats. A theme outranks a base theme by construction — so these two belong in
// the editors' themes, and a rule in styles.css would be a coin toss.
for (const [what, file] of [
  ['the app editor', 'src/ui/CodeEditor.jsx'],
  ['the style panel editor', 'src/style-panel/components/CodeEditor.tsx'],
]) {
  const src = read(file);
  check(`${what} themes its search matches`, /'\.cm-searchMatch'/.test(src), file);
  check(`${what} marks the current match apart`, /cm-searchMatch-selected/.test(src), file);
}
const appTheme = read('src/ui/CodeEditor.jsx');
check(
  'and the current match is a ring, not another wash over the selection',
  /cm-searchMatch-selected[\s\S]{0,220}outline:/.test(appTheme),
  'two translucent fills over each other came out a muddy third colour'
);
check(
  'the search-match colours are not left to a stylesheet, where they would tie',
  !/\.cm-searchMatch/.test(read('src/styles.css')),
  'styles.css sets .cm-searchMatch — a base theme ties with it'
);

if (failures.length) {
  console.error(`\ncode-search: ${failures.length} failed, ${checked - failures.length} passed\n`);
  console.error(failures.join('\n') + '\n');
  process.exit(1);
}
console.log(`code-search: ${checked} passed  [real panel DOM, real stylesheet]`);
