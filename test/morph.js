// Patching the preview, next to a page whose own JS marks things.
//
//   node test/morph.js
//
// The canvas patches the page instead of reloading it (electron/morphClient.js).
// The patch is a diff between the server's PREVIOUS rendering and its new one,
// applied to the live document — three trees, and the live one is written only
// where the other two disagree. Finding the live node that stands for a server
// node is the part this file is about.
//
// Switching a variant made the whole page flicker and the sections below it
// jump. It was reloading: the locator gave up, and giving up means
// `location.reload()`.
//
// Why it gave up: the page has tabs, and the tab script marks the open one
// `is-active`. The locator asked for a class EQUAL to the server's, so
// `tabs_link is-active` no longer matched `tabs_link` — it scanned on to the
// next tab, which still had the pristine class, and matched that. Two tabs were
// patched as each other, the third had nothing left to match, and the page
// reloaded. Every accordion, carousel and nav on the page does the same thing.
//
// The test is whether the live node still carries the classes the SERVER gave
// it. Client code may add its own; it may not take the element's identity away.

const fs = require('fs');
const path = require('path');

const failures = [];
let checked = 0;
const check = (what, condition, detail) => {
  checked++;
  if (!condition) failures.push(`  ${what}${detail ? `\n    ${detail}` : ''}`);
};

const { JSDOM } = require('jsdom');
const dom = new JSDOM('<!doctype html><body></body>');
global.document = dom.window.document;

// morphClient is an ES module the dev server serves to the page; the patching
// half is lifted out rather than imported, as in test/comment-region.js.
const source = fs.readFileSync(path.join(__dirname, '..', 'electron', 'morphClient.js'), 'utf8');
const start = source.indexOf('const isAnchor =');
const end = source.indexOf('// A script that appears, disappears or changes');
const { patchChildren, findLive } = new Function(
  'document',
  `${source.slice(start, end)}\nreturn { patchChildren, findLive };`
)(dom.window.document);

// Every patch here goes through this: a throw is the failure mode under test
// (the client turns it into location.reload()), so it is reported as one rather
// than ending the run with a stack trace that says nothing about which case it
// was.
const patch = (live, prev, next) => {
  try {
    patchChildren(live, prev, next);
    return null;
  } catch (err) {
    return err.message;
  }
};

const tree = (html) => {
  const el = dom.window.document.createElement('div');
  el.innerHTML = html;
  return el;
};

// A tablist as the server renders it: three buttons, one class each.
const TABS = (labels) =>
  `\n  ${labels.map((l) => `<button class="tabs_link" type="button">${l}</button>`).join('\n  ')}\n`;

// The same tablist after the page's own script has run: ids, roles, and
// `is-active` on whichever tab is open.
const LIVE_TABS = (labels, active) =>
  `\n  ${labels
    .map(
      (l, i) =>
        `<button class="tabs_link${i === active ? ' is-active' : ''}" type="button" id="tab-${i}" role="tab">${l}</button>`
    )
    .join('\n  ')}\n`;

// --- the report ---------------------------------------------------------------
//
// Nothing about the tabs changed: the edit was somewhere else on the page. The
// patch has no business touching them, and must not fall over them either.
{
  const prev = tree(TABS(['One', 'Two', 'Three']));
  const next = tree(TABS(['One', 'Two', 'Three']));
  const live = tree(LIVE_TABS(['One', 'Two', 'Three'], 0));
  const was = [...live.querySelectorAll('button')];

  const threw = patch(live, prev, next);
  check('a tablist the page has marked up does not defeat the patch', threw === null, threw);
  const now = [...live.querySelectorAll('button')];
  check('the same three buttons are still there', now.length === 3 && now.every((b, i) => b === was[i]));
  check(
    'the open tab is still open',
    live.querySelectorAll('.is-active').length === 1 && now[0].classList.contains('is-active'),
    [...now].map((b) => b.className).join(' / ')
  );
  check('and each one kept its id', now.map((b) => b.id).join() === 'tab-0,tab-1,tab-2', now.map((b) => b.id).join());
}

// The same tablist, with the server changing one tab's text — the node it lands
// on is the point. Matched by position, it is tab two; matched by "which one
// still has the pristine class", it was tab three.
{
  const prev = tree(TABS(['One', 'Two', 'Three']));
  const next = tree(TABS(['One', 'Renamed', 'Three']));
  const live = tree(LIVE_TABS(['One', 'Two', 'Three'], 0));
  const threw = patch(live, prev, next);
  check('the edit can be applied at all', threw === null, threw);
  const text = [...live.querySelectorAll('button')].map((b) => b.textContent);
  check('an edit lands on the tab it was made to', text.join() === 'One,Renamed,Three', text.join());
}

// Every tab marked, not just one — an accordion with several panels open, a
// carousel where every slide carries state.
{
  const prev = tree(TABS(['One', 'Two', 'Three']));
  const next = tree(TABS(['One', 'Two', 'Changed']));
  const live = tree(
    '\n  ' +
      ['One', 'Two', 'Three']
        .map((l) => `<button class="tabs_link is-seen" type="button">${l}</button>`)
        .join('\n  ') +
      '\n'
  );
  const threw = patch(live, prev, next);
  check('a class on every sibling is fine too', threw === null, threw);
  check(
    'and the edit still lands last',
    [...live.querySelectorAll('button')].map((b) => b.textContent).join() === 'One,Two,Changed',
    [...live.querySelectorAll('button')].map((b) => b.textContent).join()
  );
}

// --- what the class test is still for -----------------------------------------
//
// A class the client ADDED must not hide the node. A class the SERVER gave it
// is the evidence that this is the node: an element the client inserted, with a
// class of its own, is not it.
{
  const prev = tree('<div class="real">a</div>');
  const next = tree('<div class="real">b</div>');
  const live = tree('<div class="injected">ad</div><div class="real">a</div>');
  check('an inserted sibling does not stop the patch', patch(live, prev, next) === null);
  const divs = [...live.querySelectorAll('div')];
  check('an inserted element is stepped over, not patched', divs[0].textContent === 'ad', divs[0].outerHTML);
  check('and the server’s own element is the one that changes', divs[1].textContent === 'b', divs[1].outerHTML);
}

// A server node with no class at all: anything would satisfy "carries all of
// none", so that test would match the first same-tag node — including one the
// client put there. It has to have no class either.
{
  const prev = tree('<span>a</span>');
  const next = tree('<span>b</span>');
  const live = tree('<span class="tooltip">tip</span><span>a</span>');
  check('an inserted span does not stop it either', patch(live, prev, next) === null);
  const spans = [...live.querySelectorAll('span')];
  check('a classless server node does not match a classed live one', spans[0].textContent === 'tip', spans[0].outerHTML);
  check('it matches the classless one', spans[1].textContent === 'b', spans[1].outerHTML);
}

// The last resort is still there: when the client takes one of the server's own
// classes away, the first same-tag node is a better answer than reloading.
{
  const prev = tree('<p class="note">a</p>');
  const next = tree('<p class="note">b</p>');
  const live = tree('<p class="">a</p>');
  const threw = patch(live, prev, next);
  check('a class the client removed does not force a reload', threw === null, threw);
  check('the node is still patched', live.querySelector('p').textContent === 'b', live.innerHTML);
}

// An id is still taken at its word, ahead of any class.
{
  const prev = tree('<div id="keep" class="a">x</div>');
  const next = tree('<div id="keep" class="a">y</div>');
  const live = tree('<div class="a">decoy</div><div id="keep" class="a b">x</div>');
  check('a decoy does not stop the patch', patch(live, prev, next) === null);
  check('an id wins over a same-class sibling', live.querySelector('#keep').textContent === 'y', live.innerHTML);
  check('and the decoy is untouched', live.firstElementChild.textContent === 'decoy', live.innerHTML);
}

// --- the locator, directly ------------------------------------------------------
{
  const server = tree('<button class="tabs_link">x</button>').firstElementChild;
  const live = tree('<button class="tabs_link is-active" id="tab-0">x</button>').firstElementChild;
  check('a live node that kept the server’s class matches', findLive(live, server) === live);

  const other = tree('<button class="something-else">x</button>').firstElementChild;
  check(
    'one that never had it is only a last resort',
    findLive(other, server) === other,
    'nothing else to match, so the same-tag fallback stands'
  );
}

if (failures.length) {
  console.error(`\nmorph: ${failures.length} failed, ${checked - failures.length} passed\n`);
  console.error(failures.join('\n') + '\n');
  process.exit(1);
}
console.log(`morph: ${checked} passed  [patching a page whose own JS marks things]`);
