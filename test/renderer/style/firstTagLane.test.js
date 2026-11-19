// Goal: a page's first styles create ONE `<style>` tag however fast they arrive
// (src/features/style/model/firstTagLane.ts), and the rules a template wraps read like
// hand-written CSS.
//
// Method: the lane is pure state, so each transition is driven directly and its negative space
// checked: a write before the lane opens, a second open, a lane of another file, a failed tag, a
// scan that never shows the tag. The panel half (a real Shift-drag making one tag) is
// firstStylesPanel.test.js. Last, the template's one-line wrappers (`@layer components {}`) are
// filled the way the panel fills them and the text is compared exactly.

const test = require('node:test');
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { FirstTagLane, LANE_SCANS_WITHOUT_TAG_MAX } = load('src/features/style/model/firstTagLane.ts');
const css = load('src/features/style/model/css.ts');
const regions = load('src/features/style/model/cssRegions.ts');
const { templateFrame } = load('shared/properties/newStyleTag.ts');

const PAGE = '/p/src/pages/index.astro';
const write = (prop, value) => ({ prop, value, important: false });
const opened = () => {
  const lane = new FirstTagLane();
  lane.open({ filePath: PAGE, requested: 'div', selector: '.class', knownKeys: ['node:/p/src/pages/index.astro:n2'] });
  return lane;
};

test('the writes of the opening event go into the tag together, under the new rule’s selector', () => {
  const lane = opened();
  assert.equal(lane.phase(), 'collecting');
  for (const side of ['top', 'right', 'bottom', 'left']) {
    lane.join('div', write(`padding-${side}`, '1rem'));
  }
  lane.join('div', write('padding-top', '2rem'));
  const first = lane.takeFirstWrites();
  assert.deepEqual(
    first.map((entry) => `${entry.prop}: ${entry.value}`),
    ['padding-right: 1rem', 'padding-bottom: 1rem', 'padding-left: 1rem', 'padding-top: 2rem'],
    'one entry per property; a property written again keeps its last value',
  );
  assert.equal(lane.phase(), 'writing');
  assert.throws(() => lane.takeFirstWrites(), /taken once/);
});

test('writes made while the tag saves wait for the scan that shows it, then drain once', () => {
  const lane = opened();
  lane.join('div', write('opacity', '0.1'));
  lane.takeFirstWrites();
  lane.join('div', write('opacity', '0.4'));
  lane.join('div', write('opacity', '0.5'));
  lane.join('.other', write('color', 'red'));
  assert.equal(lane.holds(PAGE), true);
  assert.deepEqual(lane.afterScan(PAGE, []), { kind: 'waiting' }, 'still writing');
  lane.settle('written');
  assert.deepEqual(lane.afterScan(PAGE, ['node:/p/src/pages/index.astro:n2']), { kind: 'waiting' }, 'a tag the page already had is not the new one');
  const outcome = lane.afterScan(PAGE, ['node:/p/src/pages/index.astro:n2', 'node:/p/src/pages/index.astro:n9']);
  assert.deepEqual(outcome, {
    kind: 'drain',
    tagKey: 'node:/p/src/pages/index.astro:n9',
    batches: [
      { selector: '.class', writes: [write('opacity', '0.5')] },
      { selector: '.other', writes: [write('color', 'red')] },
    ],
  });
  assert.equal(lane.holds(PAGE), false, 'drained once');
  assert.deepEqual(lane.afterScan(PAGE, []), { kind: 'idle' });
});

test('a write that went straight to the shown rule drops the older one waiting for the same property, and only that one', () => {
  // The panel's half (firstStylesPanel.test.js): 0.5 committed into the rule the scan shows while
  // 0.4 still waited; draining 0.4 afterwards wrote it over 0.5.
  const lane = opened();
  lane.join('div', write('opacity', '0.1'));
  lane.takeFirstWrites();
  lane.join('div', write('opacity', '0.4'));
  lane.join('div', write('padding-top', '1rem'));
  lane.join('.other', write('opacity', '0.9'));
  lane.settle('written');
  assert.equal(lane.supersede('div', 'opacity'), 'dropped', 'the requested selector maps to the new rule, as join does');
  assert.equal(lane.supersede('.class', 'opacity'), 'none-waiting', 'dropped once');
  assert.equal(lane.supersede('.class', 'color'), 'none-waiting', 'another property waits for nothing');
  const outcome = lane.afterScan(PAGE, ['node:/p/src/pages/index.astro:n9']);
  assert.deepEqual(outcome.batches, [
    { selector: '.class', writes: [write('padding-top', '1rem')] },
    { selector: '.other', writes: [write('opacity', '0.9')] },
  ]);
  assert.throws(() => lane.supersede('div', 'opacity'), /a lane is open/, 'the panel asks only while the lane holds');
  const fresh = opened();
  assert.throws(() => fresh.supersede('div', ''), /a write names a property/);
});

test('a failed tag lets go at once and drops what waited for it', () => {
  const lane = opened();
  lane.join('div', write('opacity', '0.1'));
  lane.takeFirstWrites();
  lane.join('div', write('opacity', '0.2'));
  lane.settle('failed');
  assert.equal(lane.holds(PAGE), false);
  assert.equal(lane.phase(), undefined);
});

test('a scan that never shows the tag stops being waited for after a bounded number of scans', () => {
  const lane = opened();
  lane.join('div', write('opacity', '0.1'));
  lane.takeFirstWrites();
  lane.join('div', write('opacity', '0.3'));
  lane.settle('written');
  for (let scan = 1; scan < LANE_SCANS_WITHOUT_TAG_MAX; scan += 1) {
    assert.deepEqual(lane.afterScan(PAGE, []), { kind: 'waiting' }, `scan ${scan}`);
  }
  const outcome = lane.afterScan(PAGE, []);
  assert.equal(outcome.kind, 'drain');
  assert.equal(outcome.tagKey, undefined, 'no tag to aim at: the ordinary path decides');
  assert.deepEqual(outcome.batches, [{ selector: '.class', writes: [write('opacity', '0.3')] }]);
});

test('another file drops the lane; misuse is a crash, not a second tag', () => {
  const lane = opened();
  assert.equal(lane.holds('/p/src/pages/about.astro'), false);
  assert.equal(lane.holds(PAGE), false, 'the page changed: the lane is gone');
  assert.throws(() => lane.join('div', write('opacity', '1')), /a lane is open/);
  const again = opened();
  assert.throws(() => again.open({ filePath: PAGE, requested: 'div', selector: '.class', knownKeys: [] }), /one tag is created at a time/);
  assert.throws(() => new FirstTagLane().open({ filePath: PAGE, requested: '', selector: '', knownKeys: [] }), /has a selector/);
  assert.throws(() => again.join('div', write('', '1')), /names a property/);
});

// The panel builds a first rule in the template's skeleton (webflow.ts blankStyleDocument) and
// writes every later property into the same rule.
const filled = (content) => {
  const frame = templateFrame(content);
  assert.equal(frame.ok, true, content);
  const skeleton = frame.frame.skeleton;
  const region = regions.parseRegion({ start: 0, end: skeleton.length, css: skeleton, root: undefined });
  assert.equal(css.createRuleAtRoot(region, '.my-class', 'padding', { value: '1rem', important: false }, frame.frame.wrappers), true);
  assert.equal(css.createRuleAtRoot(region, '.my-class', 'color', { value: 'red', important: false }, frame.frame.wrappers), true);
  return region.root.toString();
};

test('a one-line wrapper template closes on its own line once it holds a rule', () => {
  const expected = '@layer components {\n\t.my-class {\n\t\tpadding: 1rem;\n\t\tcolor: red;\n\t}\n}';
  assert.equal(filled('@layer components {}'), expected);
  assert.equal(filled('@layer components { }'), expected);
  assert.equal(filled('@layer components {\n}'), expected, 'the multi-line template it now matches');
  // A wrapper that already holds something keeps its own layout.
  assert.equal(
    filled('@layer components {\n\t/* rules */\n}'),
    '@layer components {\n\t/* rules */\n\t.my-class {\n\t\tpadding: 1rem;\n\t\tcolor: red;\n\t}\n}',
  );
});
