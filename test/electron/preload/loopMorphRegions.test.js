// Goal: after the canvas patches a page whose loop changed shape, each loop
// child's path names exactly its own rendered copies. The reported page has a
// stats loop of one card beside two static cards; moving the static cards into
// the loop gives a callback with three sibling roots. Selecting the loop's
// second child outlined the "43%" card, which is a copy of the FIRST child.
// The server rendering was right; the canvas kept runs from before the patch,
// because the patch reuses DOM nodes by position and the old runs stayed live.
// Method: render the page's markup as the marker plugin serves it, collect its
// regions in jsdom, then patch it to another shape with the real morph modules
// (patchChildren, then syncAnchors puts the markers back) and collect again,
// as the preload does on `avb:morphed`. Each path's runs, read in document
// order, must be the cards that path renders. Negative space: paths the new
// shape no longer renders answer with nothing, and nodes left behind by a
// patch (blank text beside a removed card) do not keep a removed run alive.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const loadRenderer = require('../../helpers/rendererModule');
const loadMorphModules = require('../../helpers/morphModules.js');
const { LIMITS } = require('#dist/shared/core/limits.js');

const ENTRIES = ['61.4%', '43%', '0ish', '4.2 days'];
const LOOP = '0.0.0';

// One stat card as the compiler leaves it: a marker pair around the card and
// one around its number, both tagged with their paths.
function card(path, number) {
  return `
          <!--avb-s:${path}-->
          <div class="stat_card_wrap" role="listitem" data-avb-p="${path}">
            <!--avb-s:${path}.0-->
            <div class="stat_card_number" data-avb-p="${path}.0">${number}</div>
            <!--avb-e:${path}.0-->
          </div>
          <!--avb-e:${path}-->`;
}

// `roots` is what the loop's callback returns for one entry: the bound card
// first, then the static cards written inside the callback. `after` are the
// static cards left beside the loop.
function rendering(roots, after) {
  const copies = ENTRIES.map((number) => roots.map((root, index) => card(`${LOOP}.${index}`, root === 'item' ? number : root)).join('')).join('\n');
  const siblings = after.map((number, index) => card(`0.0.${index + 1}`, number)).join('');
  return `<!--avb-s:0--><section class="stat_wrap" data-avb-p="0">
  <!--avb-s:0.0--><div class="stat_layout" role="list" data-avb-p="0.0">
    <!--avb-s:${LOOP}-->${copies}
    <!--avb-e:${LOOP}-->${siblings}
  </div><!--avb-e:0.0-->
</section><!--avb-e:0-->`;
}

// The page on disk: one card per entry, then the two static cards.
const ONE_ROOT = rendering(['item'], ['0ish', '4.2 days']);
// One static card moved into the loop, the other still beside it.
const TWO_ROOTS = rendering(['item', '0ish'], ['4.2 days']);
// Both moved in: the reported Navigator, three `stat_card_wrap` loop children.
const THREE_ROOTS = rendering(['item', '0ish', '4.2 days'], []);

// What each shape's paths render, in document order.
const EXPECTED = new Map([
  [ONE_ROOT, { [`${LOOP}.0`]: ENTRIES, [`${LOOP}.1`]: [], [`${LOOP}.2`]: [], '0.0.1': ['0ish'], '0.0.2': ['4.2 days'] }],
  [TWO_ROOTS, { [`${LOOP}.0`]: ENTRIES, [`${LOOP}.1`]: ['0ish', '0ish', '0ish', '0ish'], [`${LOOP}.2`]: [], '0.0.1': ['4.2 days'], '0.0.2': [] }],
  [
    THREE_ROOTS,
    {
      [`${LOOP}.0`]: ENTRIES,
      [`${LOOP}.1`]: ['0ish', '0ish', '0ish', '0ish'],
      [`${LOOP}.2`]: ['4.2 days', '4.2 days', '4.2 days', '4.2 days'],
      '0.0.1': [],
      '0.0.2': [],
    },
  ],
]);

const NAMES = new Map([
  [ONE_ROOT, 'one root'],
  [TWO_ROOTS, 'two roots'],
  [THREE_ROOTS, 'three roots'],
]);

// Opens the first rendering as a fresh page, then patches through the rest.
// Returns, after every step, which card each path's runs hold.
function walk(steps) {
  const dom = new JSDOM(`<!doctype html><body>${steps[0]}</body>`);
  global.window = dom.window;
  global.document = dom.window.document;
  try {
    const regions = loadRenderer('electron/preload/frameRegions.ts');
    const morph = loadMorphModules({ previewMarkersMax: LIMITS.previewMarkersMax, previewMorphWorkMax: LIMITS.previewMorphWorkMax });
    const parse = (html) => new dom.window.DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
    const clean = (withAnchors) => {
      const copy = withAnchors.cloneNode(true);
      morph.stripAnchors(copy);
      return copy;
    };
    const read = () =>
      Object.fromEntries(
        Object.keys(EXPECTED.get(ONE_ROOT)).map((path) => [
          path,
          (regions.runsOf(path) ?? []).map((run) => run.map((node) => node.textContent.trim()).join('')),
        ]),
      );
    regions.collectRegions();
    const seen = [read()];
    for (let index = 1; index < steps.length; index++) {
      const previous = clean(parse(steps[index - 1]));
      const nextWithAnchors = parse(steps[index]);
      morph.patchChildren(document.body, previous.body, clean(nextWithAnchors).body);
      morph.syncAnchors(document.body, nextWithAnchors.body);
      regions.collectRegions();
      seen.push(read());
    }
    return seen;
  } finally {
    dom.window.close();
    delete global.window;
    delete global.document;
  }
}

function assertSteps(steps) {
  const seen = walk(steps);
  assert.equal(seen.length, steps.length);
  steps.forEach((step, index) => {
    const label = steps
      .slice(0, index + 1)
      .map((shape) => NAMES.get(shape))
      .join(' -> ');
    assert.deepEqual(seen[index], EXPECTED.get(step), `regions after ${label}`);
  });
}

test('a fresh page collects one run per rendered copy of each loop child', () => {
  assertSteps([THREE_ROOTS]);
  assertSteps([ONE_ROOT]);
});

test("moving both static cards into the loop: the second child is the four '0ish' copies, never '43%'", () => {
  const [, after] = walk([ONE_ROOT, THREE_ROOTS]);
  assert.ok(after, 'the patched page was read');
  assert.deepEqual(after[`${LOOP}.1`], ['0ish', '0ish', '0ish', '0ish']);
  assert.ok(!after[`${LOOP}.1`].includes('43%'), "the second loop child does not answer with the first child's copy");
  assert.deepEqual(after[`${LOOP}.0`], ENTRIES, 'the first child keeps exactly its four copies');
  assertSteps([ONE_ROOT, THREE_ROOTS]);
});

test('moving the cards in one at a time, then back out, keeps every path exact', () => {
  assertSteps([ONE_ROOT, TWO_ROOTS, THREE_ROOTS]);
  assertSteps([THREE_ROOTS, ONE_ROOT]);
  assertSteps([ONE_ROOT, TWO_ROOTS, THREE_ROOTS, ONE_ROOT, TWO_ROOTS]);
});
