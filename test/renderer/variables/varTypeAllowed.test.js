// Goal: the variable picker offers what a property can hold. A gradient's stops take
// colours and lengths side by side, so its field lists both.
// Method: the pure filter, asked directly per property and variable type, including
// the negative space: fonts in a gradient, and each neighbouring rule left as it was.
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { varTypeAllowed } = load('src/features/style/sharedVars.ts');

for (const prop of ['background', 'background-image', 'BACKGROUND', 'border-image', 'mask-image']) {
  assert.equal(varTypeAllowed(prop, 'Color'), true, `${prop} takes a colour`);
  assert.equal(varTypeAllowed(prop, 'Size'), true, `${prop} takes a length`);
  assert.equal(varTypeAllowed(prop, 'FontFamily'), false, `${prop} takes no font`);
}

assert.equal(varTypeAllowed('background-color', 'Color'), true);
assert.equal(varTypeAllowed('background-color', 'Size'), false, 'a colour property stays colours only');
assert.equal(varTypeAllowed('gap', 'Color'), false, 'a length property stays free of colours');
assert.equal(varTypeAllowed('gap', 'Size'), true);
assert.equal(varTypeAllowed('background-repeat', 'Color'), false, 'a keyword property stays keywords only');
assert.equal(varTypeAllowed(undefined, 'Color'), true, 'no property means no filter');

console.log('var type allowed: ok');
