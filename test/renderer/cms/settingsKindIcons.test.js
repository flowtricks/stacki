// Goal: every kind of field a collection's settings know has an icon, and every dropdown that chooses a kind
// shows that icon at the start of each row, the same one the field-type picker's tile and the field list show.
// Method: bundle the real icon table with esbuild, then check the table against the list of kinds, draw a dropdown's
// rows for the kinds a group's field may be, and check each row's icon is the kind's own.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTranscript } = require('../../helpers/aiTranscriptDom.js');

const {
  modules: view,
  React,
  act,
  createRoot,
} = loadTranscript('settingsKindIcons', [
  "export { KIND_ICONS, KindIcon, kindOptions } from './src/features/cms/settingsKindIcons';",
  "export { SETTINGS_FIELD_KINDS, MEMBER_KINDS } from './shared/properties/collectionSettings';",
  "export { KIND_LABELS } from './src/features/cms/settingsKindLabels';",
]);

test('every kind of field has an icon and a name', () => {
  for (const kind of view.SETTINGS_FIELD_KINDS) {
    assert.equal(typeof view.KIND_ICONS[kind], 'function', `${kind} has an icon`);
    assert.equal(typeof view.KIND_LABELS[kind], 'string', `${kind} has a name`);
  }
});

test('a kind’s dropdown rows start with its own icon, for every kind a group’s field may be', async (context) => {
  const translate = (key) => key;
  const options = view.kindOptions(view.MEMBER_KINDS, translate);
  assert.equal(options.length, view.MEMBER_KINDS.length);
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  context.after(() => act(() => root.unmount()));
  for (const option of options) {
    assert.ok(option.icon, `${option.value} has an icon in its row`);
    await act(async () => root.render(option.icon));
    const drawn = container.querySelector('svg')?.outerHTML;
    await act(async () => root.render(React.createElement(view.KindIcon, { kind: option.value })));
    // The field list's mark wraps the same glyph the dropdown row draws.
    assert.equal(
      container.querySelector('svg')?.innerHTML,
      new window.DOMParser().parseFromString(drawn, 'text/html').querySelector('svg').innerHTML,
      `${option.value}: one icon everywhere`,
    );
  }
});
