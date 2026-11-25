// Goal: a gradient the visual editor cannot show as it is opens as code, with
// a preview painted from the selected element's variables. The scallop divider
// `radial-gradient(circle at 50% 0, transparent var(--divider-size), …)` was
// read as one stop whose colour was the whole `transparent var(--divider-size)`,
// so the editor showed it wrongly, and its thumbnail painted nothing because
// this document defines none of the project's variables. Method: the fits-editor
// check over ordinary and complex gradients, then variable substitution with
// nested fallbacks, the preview style built from a layer, and the layer as one
// block of shorthand read and written back.
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { gradientFitsEditor, parseGradient } = load('src/features/style/model/gradient.ts');
const { customPropertiesIn, substituteCustomProperties } = load('src/features/style/model/cssVars.ts');
const { layerPreviewStyle } = load('src/features/style/GradientCode.tsx');
const { layerShorthand, parseLayerShorthand } = load('src/features/style/model/background.ts');

const scallop = 'radial-gradient(circle at 50% 0, transparent var(--divider-size), var(--divider-color, var(--brand-1)) var(--divider-size))';
const fits = (image) => gradientFitsEditor(parseGradient(image));

// What the visual editor can show and write as it is.
assert.equal(fits('linear-gradient(180deg, red, blue)'), true);
assert.equal(fits('radial-gradient(circle at 50% 0%, rgba(0, 0, 0, 0.4) 10%, var(--brand-1) 90%)'), true, 'a var() colour is one colour');
// What it cannot: a var() position, two positions, a var() in the geometry.
assert.equal(fits(scallop), false);
assert.equal(fits('linear-gradient(90deg, red 10% 20%, blue)'), false);
assert.equal(fits('radial-gradient(circle at var(--x) 0, red, blue)'), false);

// The variables a value reads, once each, and the value with them filled in.
assert.deepEqual(customPropertiesIn(scallop), ['--divider-size', '--divider-color', '--brand-1']);
const values = new Map([
  ['--divider-size', '12px'],
  ['--divider-color', ''],
  ['--brand-1', 'rgb(37, 99, 235)'],
]);
assert.equal(
  substituteCustomProperties(scallop, values),
  'radial-gradient(circle at 50% 0, transparent 12px, rgb(37, 99, 235) 12px)',
  'an unset variable takes its fallback, nested ones innermost first',
);
assert.equal(substituteCustomProperties('var(--missing)', new Map()), '', 'no value and no fallback paints nothing');
assert.equal(substituteCustomProperties('calc(var(--a) * 3)', new Map([['--a', '4px']])), 'calc(4px * 3)');

// The preview paints the layer at its own size, position and tiling.
const style = layerPreviewStyle(
  { image: scallop, size: 'calc(var(--divider-size) * 3) var(--divider-size)', position: '0 0', repeat: 'repeat-x', attachment: '' },
  values,
);
assert.equal(style.backgroundSize, 'calc(12px * 3) 12px');
assert.equal(style.backgroundRepeat, 'repeat-x');
assert.equal(style.backgroundPosition, '0 0');
assert.match(style.backgroundImage, /transparent 12px/);
assert.equal(
  layerPreviewStyle({ image: 'linear-gradient(red, blue)', size: '', position: '', repeat: '', attachment: '' }, new Map()).backgroundSize,
  undefined,
);

// The code view edits the whole layer as one block of shorthand, which reads
// back into the same longhands: gradient, position / size, tiling.
const layerText = `${scallop} 0 0 / calc(var(--divider-size) * 3) var(--divider-size) repeat-x`;
const layer = parseLayerShorthand(layerText);
assert.equal(layer.image, scallop);
assert.equal(layer.position, '0 0');
assert.equal(layer.size, 'calc(var(--divider-size) * 3) var(--divider-size)');
assert.equal(layer.repeat, 'repeat-x');
assert.equal(layerShorthand(layer), layerText, 'written back as it was read');
assert.equal(layerShorthand({ image: 'linear-gradient(red, blue)', size: '', position: '', repeat: '', attachment: '' }), 'linear-gradient(red, blue)');
assert.equal(
  layerShorthand({ image: 'linear-gradient(red, blue)', size: '10px', position: '', repeat: '', attachment: 'fixed' }),
  'linear-gradient(red, blue) 0 0 / 10px fixed',
);
// Not a layer: nothing, a colour alone, or a second layer after a comma.
assert.equal(parseLayerShorthand(''), undefined);
assert.equal(parseLayerShorthand('red'), undefined);
assert.equal(parseLayerShorthand('linear-gradient(red, blue), url(a.png)'), undefined);
console.log('gradient code: ok');
