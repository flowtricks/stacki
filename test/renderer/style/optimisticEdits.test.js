// Goal: a committed or cleared Style panel value shows in the render of the press that made it, and
// the model that arrives afterwards never takes the field back to an older value. The pieces:
// model/optimisticProp.ts says what the model will say (a commit on the picked selector, a clear
// that brings up the next declaration in the cascade), and embed/useOptimisticEdits.ts holds each
// edited property until the newest save of it settles, so an older save finishing (with a model that
// holds the older value) is never shown, a failed save rolls back to the model, a synchronous write
// waits for the model to move, and a refused write is never held.
//
// Method: the pure functions are run on hand-built models, with frozen inputs (nothing is mutated)
// and the negative space (a model for another property, an empty name) asserting loudly. The hook
// is rendered with React in jsdom over a model the test replaces by hand, with saves as promises the
// test settles in any order; a MutationObserver records every text the field paints, so "no frame
// shows the stale value" is checked on every DOM change, not on a sample. Cost is checked against a
// baseline measured in the same run (a model of 30 properties against one of 3,000), never against
// wall-clock milliseconds: the hold reads one property's contributors, whatever the project's size.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { withinBaseline, percentile } = require('../../helpers/e2e/stageLatency.js');

let environment;

async function load() {
  if (environment !== undefined) {
    return environment;
  }
  const esbuild = require('esbuild');
  const buildDirectory = repoPath('node_modules/.stacki-test/optimistic-edits');
  fs.mkdirSync(buildDirectory, { recursive: true });
  const bundlePath = path.join(buildDirectory, `bundle-${process.pid}.js`);
  await esbuild.build({
    stdin: {
      contents: [
        `export { useOptimisticEdits } from './src/features/style/embed/useOptimisticEdits'`,
        `export { withCommitted, withCleared } from './src/features/style/model/optimisticProp'`,
      ].join('\n'),
      resolveDir: ROOT,
      loader: 'tsx',
    },
    outfile: bundlePath,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime', 'react-dom/client'],
    loader: { '.css': 'empty' },
    logLevel: 'silent',
  });
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.navigator = dom.window.navigator;
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const bundle = require(bundlePath);
  fs.rmSync(bundlePath, { force: true });
  environment = { dom, React, createRoot, ...bundle };
  return environment;
}

// One contributor of a property, with the cascade flags the resolver sets.
function contributor(selectorText, value, flags = {}) {
  return {
    selectorText,
    value,
    important: false,
    specificity: [0, 1, 0],
    order: 0,
    ruleId: selectorText,
    origin: 'embed',
    isSelected: flags.picked === true,
    ...(flags.picked === true ? { editing: true } : {}),
    winning: flags.winning === true,
    complexOnly: false,
  };
}

// A resolved property from contributors already in cascade order (the first wins).
function resolvedProp(prop, contributors) {
  const list = contributors.map((entry, index) => ({ ...entry, winning: index === 0 }));
  const picked = list.find((entry) => entry.editing === true);
  return {
    prop,
    source: picked === undefined ? 'other' : 'selected',
    ...(picked === undefined ? {} : { selectedOrigin: 'embed', selectedValue: { value: picked.value, important: false } }),
    winner: list[0],
    overridden: picked !== undefined && picked !== list[0],
    contributors: list,
  };
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

const shownOf = (resolved) =>
  resolved === undefined ? '' : resolved.source === 'selected' ? `selected:${resolved.selectedValue.value}` : `other:${resolved.winner.value}`;

test('a commit puts the value on the picked selector, from whatever the model held', async () => {
  const { withCommitted } = await load();
  const edit = { prop: 'color', value: 'color-mix(in srgb, red 10%, transparent var(--mix))', important: false, selector: 'h2.heading.text-style-h3' };
  const owned = deepFreeze(resolvedProp('color', [contributor('h2.heading.text-style-h3', 'blue', { picked: true }), contributor('.heading', 'var(--text)')]));
  const updated = withCommitted(owned, edit);
  assert.equal(shownOf(updated), `selected:${edit.value}`);
  assert.equal(updated.winner.value, edit.value, 'the picked declaration was the winner and still is');
  assert.equal(updated.contributors.length, 2);
  assert.equal(owned.contributors[0].value, 'blue', 'the model itself is not touched');

  const inherited = deepFreeze(resolvedProp('color', [contributor('.heading', 'var(--text)')]));
  const added = withCommitted(inherited, edit);
  assert.equal(shownOf(added), `selected:${edit.value}`, 'a selector that did not set it now shows it');
  assert.equal(added.contributors.length, 2);
  assert.equal(added.contributors.filter((entry) => entry.winning).length, 1, 'one winner');
  assert.equal(added.winner.selectorText, edit.selector);

  const fresh = withCommitted(undefined, edit);
  assert.equal(shownOf(fresh), `selected:${edit.value}`, 'nothing set it before');
  assert.equal(fresh.contributors.length, 1);

  const overridden = deepFreeze(resolvedProp('color', [contributor('#id', 'red'), contributor('.a', 'blue', { picked: true })]));
  const stillLosing = withCommitted(overridden, { ...edit, value: 'green' });
  assert.equal(stillLosing.winner.value, 'red', 'a more specific winner is kept');
  assert.equal(stillLosing.overridden, true);
  assert.equal(stillLosing.selectedValue.value, 'green');
});

test('a clear brings up the next declaration in the cascade, or nothing', async () => {
  const { withCleared } = await load();
  const both = deepFreeze(resolvedProp('color', [contributor('h2.heading.text-style-h3', 'blue', { picked: true }), contributor('.heading', 'var(--text)')]));
  const cleared = withCleared(both);
  assert.equal(shownOf(cleared), 'other:var(--text)');
  assert.equal(cleared.winner.winning, true);
  assert.equal(cleared.contributors.length, 1);
  assert.equal(both.contributors[1].winning, false, 'the model itself is not touched');

  const onlyPicked = deepFreeze(resolvedProp('color', [contributor('.a', 'blue', { picked: true })]));
  assert.equal(withCleared(onlyPicked), undefined, 'nothing else sets it');
  assert.equal(withCleared(undefined), undefined, 'nothing set it');

  const nothingPicked = deepFreeze(resolvedProp('color', [contributor('.heading', 'var(--text)'), contributor('body', 'black')]));
  assert.equal(shownOf(withCleared(nothingPicked)), 'other:var(--text)', 'a clear of nothing leaves the cascade as it was');
});

test('the guesses refuse a model for another property and an empty name', async () => {
  const { withCommitted } = await load();
  const model = resolvedProp('color', [contributor('.a', 'blue', { picked: true })]);
  assert.throws(
    () => withCommitted(model, { prop: 'background-color', value: 'red', important: false, selector: '.a' }),
    /withCommitted: the model is for the edited property/,
  );
  assert.throws(() => withCommitted(model, { prop: '', value: 'red', important: false, selector: '.a' }), /withCommitted: a property is named/);
});

test('reading a held property costs the same in a 3,000-property model as in a 30-property one', async () => {
  const { withCommitted, withCleared } = await load();
  const modelOf = (count) => {
    const map = new Map();
    for (let index = 0; index < count; index += 1) {
      map.set(`--p${index}`, resolvedProp(`--p${index}`, [contributor(`.r${index}`, `${index}px`)]));
    }
    map.set(
      'color',
      resolvedProp('color', [contributor('.a', 'blue', { picked: true }), contributor('.heading', 'var(--text)'), contributor('body', 'black')]),
    );
    return map;
  };
  const READS = 4000;
  const TRIALS = 7;
  const timeReads = (model) => {
    const samples = [];
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const startMs = performance.now();
      for (let read = 0; read < READS; read += 1) {
        withCommitted(model.get('color'), { prop: 'color', value: `${read}px`, important: false, selector: '.a' });
        withCleared(model.get('color'));
      }
      samples.push(performance.now() - startMs);
    }
    return percentile(samples, 50);
  };
  const small = modelOf(30);
  const large = modelOf(3000);
  timeReads(small); // Warm the JIT before either measurement counts.
  const baseline = timeReads(small);
  const measured = timeReads(large);
  const bound = withinBaseline({ measured, baseline, factorMax: 4, floor: 0.5 });
  assert.ok(bound.ok, `a held read in a big model costs ${bound.ratio.toFixed(2)}x the small model's`);
});

// ───────────────────────────── The hook, rendered ─────────────────────────────

// Renders the hook over a model the test replaces; `saves` are the settles the test controls.
async function mountHook() {
  const { React, createRoot, useOptimisticEdits } = await load();
  const { act } = React;
  let model = new Map();
  let api;
  const saves = [];
  let settleNext = 'save'; // What the next write returns: a held save, 'until-model', or nothing.
  const deferred = () => {
    let resolve = () => undefined;
    const promise = new Promise((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };
  const write = () => {
    if (settleNext === 'until-model') {
      return 'until-model';
    }
    if (settleNext === 'refused') {
      return undefined;
    }
    const save = deferred();
    saves.push(save);
    return save.promise;
  };
  function Harness({ props }) {
    api = useOptimisticEdits(props, { setProp: write, clearProp: write, selector: 'h2.heading.text-style-h3' });
    return React.createElement('span', { id: 'shown' }, shownOf(api.read('color')));
  }
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const painted = [];
  const observer = new window.MutationObserver(() => {
    const text = container.textContent;
    if (painted[painted.length - 1] !== text) {
      painted.push(text);
    }
  });
  observer.observe(container, { childList: true, subtree: true, characterData: true });
  const render = async (next) => {
    model = next;
    await act(async () => root.render(React.createElement(Harness, { props: model })));
  };
  return {
    render,
    act,
    painted,
    saves,
    shown: () => container.textContent,
    api: () => api,
    returns: (kind) => {
      settleNext = kind;
    },
    unmount: () => {
      observer.disconnect();
      root.unmount();
      container.remove();
    },
  };
}

const own = (value) =>
  new Map([['color', resolvedProp('color', [contributor('h2.heading.text-style-h3', value, { picked: true }), contributor('.heading', 'var(--text)')])]]);
const inheritedOnly = () => new Map([['color', resolvedProp('color', [contributor('.heading', 'var(--text)')])]]);

test('a commit shows in the render of the press, and an older save never takes it back', async (context) => {
  const hook = await mountHook();
  context.after(() => hook.unmount());
  await hook.render(inheritedOnly());
  assert.equal(hook.shown(), 'other:var(--text)');
  const first = 'color-mix(in srgb, red 10%, transparent var(--mix))';
  const second = 'color-mix(in srgb, red 20%, transparent var(--mix))';
  await hook.act(async () => hook.api().setProp('color', first, false));
  assert.equal(hook.shown(), `selected:${first}`, 'the field shows the commit with its save still out');
  const fromFirst = hook.painted.length - 1;
  await hook.act(async () => hook.api().setProp('color', second, false));
  assert.equal(hook.shown(), `selected:${second}`);
  // The older save lands, with a model rebuilt from the file as it then was: an older revision.
  await hook.act(async () => hook.saves[0].resolve(true));
  await hook.render(own(first));
  assert.equal(hook.shown(), `selected:${second}`, 'the older revision is not shown');
  await hook.render(own(second));
  await hook.act(async () => hook.saves[1].resolve(true));
  assert.equal(hook.shown(), `selected:${second}`, 'settled on what the file holds');
  assert.deepEqual(hook.painted.slice(fromFirst), [`selected:${first}`, `selected:${second}`], 'no frame went back to an older value or to the inherited one');
});

test('a failed save rolls back to the model once it settles', async (context) => {
  const hook = await mountHook();
  context.after(() => hook.unmount());
  await hook.render(own('blue'));
  await hook.act(async () => hook.api().setProp('color', 'red', false));
  assert.equal(hook.shown(), 'selected:red');
  // A refused save resolves (applyEdit answers false); the model still holds the old value.
  await hook.act(async () => hook.saves[0].resolve(false));
  assert.equal(hook.shown(), 'selected:blue', 'the model is the rollback');
});

test('a clear shows the next declaration in the render of the press, and the settled model agrees', async (context) => {
  const hook = await mountHook();
  context.after(() => hook.unmount());
  await hook.render(own('blue'));
  const before = hook.painted.length;
  await hook.act(async () => hook.api().clearProp('color'));
  assert.equal(hook.shown(), 'other:var(--text)', 'the value under it shows at once, never an empty field');
  await hook.render(inheritedOnly());
  await hook.act(async () => hook.saves[0].resolve(true));
  assert.equal(hook.shown(), 'other:var(--text)');
  assert.deepEqual(hook.painted.slice(before), ['other:var(--text)'], 'one change, straight to the next value');
});

test('a synchronous write waits for the model to move, and a refused one is never held', async (context) => {
  const hook = await mountHook();
  context.after(() => hook.unmount());
  await hook.render(own('blue'));
  hook.returns('until-model');
  await hook.act(async () => hook.api().setProp('color', 'red', false));
  assert.equal(hook.shown(), 'selected:red', 'held while the model has not heard');
  await hook.render(own('red'));
  assert.equal(hook.shown(), 'selected:red', 'the moved model is read');
  await hook.render(own('green'));
  assert.equal(hook.shown(), 'selected:green', 'and nothing of the hold is left');
  hook.returns('refused');
  await hook.act(async () => hook.api().setProp('color', 'pink', false));
  assert.equal(hook.shown(), 'selected:green', 'nothing was written, so nothing is shown');
});

test('a group clear over the bound fails loudly', async (context) => {
  const hook = await mountHook();
  context.after(() => hook.unmount());
  await hook.render(own('blue'));
  const names = Array.from({ length: 65 }, (_, index) => `--p${index}`);
  assert.throws(() => hook.api().clearProp(names), /useOptimisticEdits: one clear holds a bounded group/);
});
