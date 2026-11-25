// Goal: "Add custom styles in" follows the stylesheet that already defines the selected
// selector (src/features/style/model/selectorHome.ts), and nothing else moves it.
// Method: the pure decision as tables, with the negative space: a selector defined in one
// file, in several (exact beats a part, a more specific part beats a less specific one, the
// last rule in the cascade wins a tie, the current query beats another query, and with no
// rule in the current query the first in cascade order is the home), in none, and a rule
// for a different state or pseudo-element, which is not the selector's. Then the follow
// decision: a manual pick holds for its own selection, a new selection forgets it, and
// with no home the target is left alone.
const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../../helpers/rendererModule')('src/features/style/model/selectorHome.ts');

const ACTIVE = 'div.home-hero_height[data-home-hero-height]';
const rule = (embedKey, order, selectorTexts, context = '') => ({ embedKey, order, context, selectorTexts });
const home = (rules, active = ACTIVE, context = '') => model.selectorHomeKey(rules, context, active);

test('a selector defined in one file: that file, even when the rule names only its class', () => {
  const rules = [rule('animation', 1, ['.fade']), rule('base', 2, ['.home-hero_height'])];
  assert.equal(home(rules), 'base');
  assert.equal(home(rules, '.home-hero_height'), 'base');
});

test('several files: the exact selector beats a part, a bigger part beats a smaller one, the later rule wins a tie', () => {
  assert.equal(home([rule('a', 1, ['.home-hero_height']), rule('b', 2, [ACTIVE])]), 'b');
  assert.equal(home([rule('a', 1, [ACTIVE]), rule('b', 2, ['.home-hero_height'])]), 'a', 'exact still wins over a later part');
  assert.equal(home([rule('a', 1, ['.home-hero_height[data-home-hero-height]']), rule('b', 2, ['.home-hero_height'])]), 'a');
  assert.equal(home([rule('a', 1, ['.home-hero_height']), rule('b', 2, ['.home-hero_height'])]), 'b');
});

test('the current query wins; with no rule there, the first in cascade order elsewhere', () => {
  const mobile = '@media (max-width: 479px)';
  const rules = [
    rule('base', 1, ['.home-hero_height']),
    rule('late', 3, ['.home-hero_height'], mobile),
    rule('early', 2, ['.home-hero_height'], '@media print'),
  ];
  assert.equal(home(rules, ACTIVE, mobile), 'late');
  assert.equal(home(rules, ACTIVE, '@media (min-width: 900px)'), 'base');
  assert.equal(home([rule('late', 3, ['.home-hero_height'], mobile), rule('early', 2, ['.home-hero_height'], '@media print')], ACTIVE, ''), 'early');
});

test('no file defines it: undefined', () => {
  assert.equal(home([]), undefined);
  assert.equal(home([rule('a', 1, ['.other']), rule('b', 2, ['div']), rule('c', 3, ['*'])]), undefined);
});

test('a rule for another state, another pseudo-element or a descendant is not the selector’s', () => {
  assert.equal(home([rule('a', 1, ['.home-hero_height:hover'])]), undefined);
  assert.equal(home([rule('a', 1, ['.home-hero_height::before'])]), undefined);
  assert.equal(home([rule('a', 1, ['.wrap .home-hero_height'])]), undefined);
  assert.equal(home([rule('a', 1, ['.home-hero_height:hover'])], '.home-hero_height:hover'), 'a');
});

test('a grouped rule counts through the selector that matched', () => {
  assert.equal(home([rule('a', 1, ['.x, .home-hero_height', '.home-hero_height'])]), 'a');
});

const pick = (selectionKey, sourceKey) => ({ selectionKey, sourceKey });

test('follow: defined in a file moves there; none leaves the target alone', () => {
  assert.deepEqual(model.followSource({ selectionKey: 's1', homeKey: 'base', manualPick: undefined }), {
    kind: 'move',
    sourceKey: 'base',
    manualPick: undefined,
  });
  assert.deepEqual(model.followSource({ selectionKey: 's1', homeKey: undefined, manualPick: undefined }), { kind: 'keep', manualPick: undefined });
});

test('follow: a manual pick persists for its selection, even when the home changes, and a new selection resets it', () => {
  const manual = pick('s1', 'animation');
  assert.deepEqual(model.followSource({ selectionKey: 's1', homeKey: 'base', manualPick: manual }), { kind: 'keep', manualPick: manual });
  assert.deepEqual(model.followSource({ selectionKey: 's1', homeKey: undefined, manualPick: manual }), { kind: 'keep', manualPick: manual });
  assert.deepEqual(model.followSource({ selectionKey: 's2', homeKey: 'base', manualPick: manual }), { kind: 'move', sourceKey: 'base', manualPick: undefined });
  assert.deepEqual(model.followSource({ selectionKey: 's2', homeKey: undefined, manualPick: manual }), { kind: 'keep', manualPick: undefined });
});
