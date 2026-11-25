// Goal: switching a background layer's Type starts it over as that kind's
// default, clearing its size, position and tiling. It used to carry the old
// gradient's stops into the new kind, so a scallop divider switched from radial
// to linear kept its `var()` stops and its tiled `background` size under the
// new type. Method: the panel's own switch over a layer stack, with the writer
// as a spy, from that divider to each kind, and the negative space: the same
// kind writes nothing, and the other layers stay as they were.
const assert = require('node:assert/strict');
const load = require('../../helpers/rendererModule');
const { setLayerKind } = load('src/features/style/BackgroundLayerEditor.tsx');
const { blankLayer } = load('src/features/style/model/background.ts');

const divider = {
  image: 'radial-gradient(circle at 50% 0, transparent var(--divider-size), var(--divider-color) var(--divider-size))',
  size: 'calc(var(--divider-size) * 3) var(--divider-size)',
  position: '0 0',
  repeat: 'repeat-x',
  attachment: '',
};
const photo = { image: 'url(photo.png)', size: 'cover', position: 'center', repeat: 'no-repeat', attachment: '' };
const switched = (next, displayKind) => {
  const writes = [];
  setLayerKind({ next, displayKind, props: { layers: [divider, photo], index: 0, applyLayers: (layers) => writes.push(layers) } });
  return writes;
};

for (const kind of ['linear', 'image', 'color']) {
  const writes = switched(kind, 'radial');
  assert.equal(writes.length, 1, `${kind}: one write`);
  assert.deepEqual(writes[0][0], blankLayer(kind), `${kind}: the default layer, nothing carried`);
  assert.deepEqual(writes[0][1], photo, `${kind}: the other layer is untouched`);
}
assert.equal(switched('linear', 'radial')[0][0].size, '', 'the tiled size is cleared');
assert.equal(switched('linear', 'radial')[0][0].repeat, '', 'and so is the tiling');
assert.deepEqual(switched('radial', 'radial'), [], 'the same kind writes nothing');
console.log('layer kind switch: ok');
