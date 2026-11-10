// Goal: an element's label tells a class from a tag, and a style write that changes
// nothing is recognised before it can be refused as an editor error.
// Method: the pure helpers directly, with the negative space: a tag keeps no dot, a
// slot keeps its name, an empty or already dotted class is a programmer error, and
// only a raw node holding the same bytes counts as unchanged.
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { classLabel, elementLabel } = load('src/editor/classNames.ts');
const { rawContentsMatch } = load('src/app/model/pageModelGestures.ts');

const classed = (name, value) => ({ name, props: { class: { type: 'string', value } } });

assert.equal(elementLabel(classed('div', 'label other')), '.label', 'a class has its dot');
assert.equal(elementLabel(classed('label', 'label')), '.label', 'a class named like its tag is still a class');
assert.equal(elementLabel({ name: 'label', props: {} }), 'label', 'a tag has none');
assert.equal(elementLabel({ name: 'slot', props: { name: { type: 'string', value: 'footer' } } }), 'footer', 'a named slot keeps its name');
assert.equal(elementLabel(undefined), '');
assert.throws(() => classLabel(''), /classLabel: a class has a name/);
assert.throws(() => classLabel('.a'), /classLabel: the name has no dot yet/);

const style = { id: 'n1', kind: 'raw', name: 'style', props: {}, inner: '.a { top: 0; }' };
assert.equal(rawContentsMatch(style, '.a { top: 0; }'), true);
assert.equal(rawContentsMatch(style, '.a { top: 1px; }'), false);
assert.equal(rawContentsMatch({ id: 'n2', kind: 'text', value: '.a { top: 0; }' }, '.a { top: 0; }'), false, 'only a raw node has contents');

console.log('editor labels: ok');
