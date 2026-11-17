// Goal: comparing React-rendered nodes in a test can never take the machine's memory. A failing
// `assert.equal(nodeA, nodeB)` inspects the whole fiber tree for its diff (over 4 GB in five
// seconds for the Properties panel test); `assertSameElement` must fail with a one-line message and
// carry descriptions, not nodes, so neither the diff nor the test reporter walks the tree.
// Method: render a few hundred stateful rows into jsdom with React, then compare two different
// inputs through the helper and pin its message, its cost in time and memory, and its success path.
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { JSDOM } = require('jsdom');
const { assertSameElement, describeElement, DESCRIPTION_CHARS_MAX } = require('../../helpers/domIdentity.js');

const ROW_COUNT = 300;

test('a failed node comparison is one short line, whatever the React tree behind it', async () => {
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node']) {
    global[key] = key === 'window' ? dom.window : dom.window[key];
  }
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { createRoot } = require('react-dom/client');
  const Row = ({ index }) => {
    const [value, setValue] = React.useState(`item ${index}`);
    return React.createElement(
      'div',
      { className: 'row' },
      React.createElement('input', { value, 'aria-label': `Row ${index}`, onChange: (event) => setValue(event.target.value) }),
    );
  };
  const root = createRoot(document.getElementById('root'));
  await React.act(async () => {
    root.render(
      React.createElement(
        'div',
        {},
        Array.from({ length: ROW_COUNT }, (_, index) => React.createElement(Row, { key: index, index })),
      ),
    );
  });
  const inputs = document.querySelectorAll('input');
  assert.equal(inputs.length, ROW_COUNT);
  assert.ok(
    Object.keys(inputs[0]).some((key) => key.startsWith('__reactFiber$')),
    'the nodes carry the fiber keys that made the diff explode',
  );

  assertSameElement(inputs[0], inputs[0]);
  const rssBefore = process.memoryUsage().rss;
  const startedMs = performance.now();
  let failure;
  try {
    assertSameElement(inputs[1], inputs[0], 'the first row has the keyboard');
  } catch (error) {
    failure = error;
  }
  const elapsedMs = performance.now() - startedMs;
  assert.ok(failure instanceof assert.AssertionError);
  assert.equal(failure.message, 'the first row has the keyboard: got <input [aria-label="Row 1"]>, wanted <input [aria-label="Row 0"]>');
  assert.equal(typeof failure.actual, 'string');
  assert.equal(typeof failure.expected, 'string');
  assert.ok(elapsedMs < 1000, `failing took ${elapsedMs} ms`);
  assert.ok(process.memoryUsage().rss - rssBefore < 64 * 1024 * 1024, 'failing allocated next to nothing');
  assert.throws(() => assertSameElement(undefined, inputs[0]), { message: /^expected the same node: got undefined, wanted <input/ });
  await React.act(async () => root.unmount());
});

test('descriptions name the node and stay one bounded line', () => {
  const dom = new JSDOM('<!doctype html><button id="go" class="a  b" aria-label="Go">Go   now</button><p></p>');
  const button = dom.window.document.getElementById('go');
  assert.equal(describeElement(button), '<button#go.a.b [aria-label="Go"]> "Go now"');
  assert.equal(describeElement(undefined), 'undefined');
  assert.equal(describeElement('text'), 'a string, not a node');
  assert.equal(describeElement(dom.window.document), '#document node');
  button.textContent = 'x'.repeat(DESCRIPTION_CHARS_MAX * 2);
  const long = describeElement(button);
  assert.equal(long.length, DESCRIPTION_CHARS_MAX);
  assert.ok(long.endsWith('…'));
});
