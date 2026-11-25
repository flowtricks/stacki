// Short descriptions of DOM nodes for test failure messages.
//
// Why this exists: `assert.equal(nodeA, nodeB)` that fails builds its diff with node's inspector at
// depth 1000 with getters on and custom inspectors off. A node React rendered carries enumerable
// `__reactFiber$…` and `__reactProps$…` keys, so that diff walks the whole fiber tree, its props,
// state and closures. Measured: three rendered rows took 2.1 GB of memory, ten rows passed 3.9 GB in
// one second, and the Properties panel test passed 4.6 GB in five seconds. `--max-old-space-size`
// does not stop it, because the diff is built as huge strings outside the old space. A focus
// regression turned into a machine-wide out-of-memory freeze when several test runs were going.
// Compare nodes by identity (`assert.ok(a === b, ...)`) and name them with `describeElement`.

const { AssertionError } = require('node:assert');

const DESCRIPTION_CHARS_MAX = 120;

/** One line naming a node: tag, id, classes and a little text; never its object graph. */
function describeElement(node) {
  if (node === null || node === undefined) {
    return String(node);
  }
  if (typeof node !== 'object' || typeof node.nodeType !== 'number') {
    return `a ${typeof node}, not a node`;
  }
  if (node.nodeType !== 1) {
    return `${node.nodeName} node`;
  }
  const id = node.id === '' ? '' : `#${node.id}`;
  const classes = typeof node.className === 'string' && node.className.trim() !== '' ? `.${node.className.trim().split(/\s+/).join('.')}` : '';
  const label = node.getAttribute('aria-label');
  const labelText = label === null ? '' : ` [aria-label="${label}"]`;
  const text = (node.textContent ?? '').trim().replace(/\s+/g, ' ');
  const textPart = text === '' ? '' : ` "${text}"`;
  const description = `<${node.tagName.toLowerCase()}${id}${classes}${labelText}>${textPart}`;
  return description.length > DESCRIPTION_CHARS_MAX ? `${description.slice(0, DESCRIPTION_CHARS_MAX - 1)}…` : description;
}

/**
 * Assert two nodes are the same node. On failure the error carries one-line descriptions as its
 * actual and expected values, so neither the assertion's diff nor the test reporter walks a node.
 */
function assertSameElement(actual, expected, message) {
  if (actual === expected) {
    return;
  }
  const actualText = describeElement(actual);
  const expectedText = describeElement(expected);
  const prefix = message === undefined ? 'expected the same node' : message;
  // Only a message goes to the constructor: given actual and expected, it builds its own diff.
  // The descriptions are set afterwards, so the reporter prints them and never a node.
  const error = new AssertionError({ message: `${prefix}: got ${actualText}, wanted ${expectedText}` });
  error.actual = actualText;
  error.expected = expectedText;
  error.operator = 'strictEqual';
  throw error;
}

module.exports = { assertSameElement, describeElement, DESCRIPTION_CHARS_MAX };
