// Goal: `.stacki/component-canvas.json` holds exactly what the component canvas needs and nothing it cannot use: the
// split props, and per-frame preview values, sizes and backgrounds keyed by what each frame shows. Desktop, Studio and
// the CLI read it through one parser, so a file one accepts the others accept.
// Method: parse known-good files and each known-bad shape (bounds, key order, unknown keys, injected colours), write
// edits at the all-frames, per-variant and per-frame scopes and resolve frames through them, build the frames of a
// Lumos-style button (a variant union with an arrow direction only the arrow variant takes) and check the pruning, the
// layout and the frame bound, and keep settings across a rename, a deletion and a change of split. The canvas root's
// classes and surface resolve from the component, then the project, and the parser bounds and refuses bad names. A
// component's arrangement round-trips and its default is never stored; an edit to a scope reaches every frame in it,
// those with values of their own too, and frames that differ are told apart from frames that agree.
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CANVAS_LIMITS,
  EMPTY_CANVAS_FILE,
  canvasFrames,
  defaultSplit,
  dropComponentCanvas,
  effectiveSplit,
  frameKey,
  parseComponentCanvasFile,
  parseComponentCanvasSource,
  parseFrameKey,
  relinkComponentCanvas,
  resolveFrame,
  serializeComponentCanvas,
  splitCandidates,
  unionAllows,
  withFrameEdit,
  overridesIn,
  scopeHolds,
  withoutOverrides,
  withSplit,
  withProjectBackground,
  frameBackground,
  renameCanvasVariables,
  canvasAssetUses,
  relinkCanvasAssets,
  settingLevel,
  canvasRoot,
  withRootEdit,
  rootOverrides,
  PROJECT_ROOT,
  levelArrangement,
  CANVAS_LEVEL,
  chosenLayouts,
  settingMixed,
  withLevelArrangement,
} from '#dist/shared/properties/componentCanvas.js';
import { COMPONENT_CANVAS_FILE_SCHEMA } from '#dist/shared/properties/cli/files/componentCanvasFile.js';
import { checkValue } from '#dist/shared/properties/cli/stackiSchema.js';
import { validateMetadata } from '#dist/shared/properties/projectMetadata.js';

const button = 'src/components/Button.astro';

// The Lumos button: `variant` controls a union, `direction` is passed only with the arrow variant.
const unions = [
  {
    names: ['variant', 'emphasis', 'direction', 'label'],
    branches: [
      { forbids: ['direction', 'label'], pins: { variant: ['main'] }, defaults: {}, rules: {}, docs: {} },
      { forbids: ['direction', 'label', 'emphasis'], pins: { variant: ['link'] }, defaults: {}, rules: {}, docs: {} },
      { forbids: ['direction'], pins: { variant: ['play'] }, defaults: {}, rules: {}, docs: {} },
      { forbids: [], pins: { variant: ['arrow'] }, defaults: {}, rules: {}, docs: {} },
    ],
  },
];
const buttonSchema = [
  { name: 'render', type: 'boolean', optional: true, default: true, unions },
  { name: 'variant', type: 'enum', optional: true, options: ['main', 'link', 'play', 'arrow'], default: 'main', unions },
  { name: 'emphasis', type: 'enum', optional: true, options: ['primary', 'secondary'], default: 'primary', unions },
  { name: 'direction', type: 'enum', optional: true, options: ['forward', 'back'], unions },
  { name: 'label', type: 'string', optional: true, unions },
];

const held = (parts: readonly { readonly prop: string; readonly value: { readonly kind: string; readonly value?: unknown } }[]) => (name: string) => {
  const part = parts.find((candidate) => candidate.prop === name);
  return part === undefined || part.value.kind === 'unset' ? buttonSchema.find((field) => field.name === name)?.default?.toString() : String(part.value.value);
};

test('a file with every kind of entry parses and round-trips byte for byte', () => {
  const source = serializeComponentCanvas(
    parseComponentCanvasFile({
      version: 1,
      components: {
        [button]: {
          split: ['variant', 'direction'],
          frames: {
            '': { width: 'hug', background: 'var(--swatch-light)' },
            'variant=arrow': { height: 120 },
            'direction=back&variant=arrow': { props: { emphasis: 'secondary', count: 3, pressed: true }, unset: ['label'] },
          },
        },
      },
    }),
  );
  const parsed = parseComponentCanvasSource(source);
  assert.ok(parsed.ok);
  assert.equal(serializeComponentCanvas(parsed.value), source);
  assert.doesNotThrow(() => validateMetadata('componentCanvas', source));
});

test('each known-bad shape is refused with its reason', () => {
  const bad: readonly [string, unknown][] = [
    ['version', { version: 2, components: {} }],
    ['a project .astro component', { version: 1, components: { '../outside.astro': {} } }],
    ['unknown key', { version: 1, components: { [button]: { spilt: [] } } }],
    ['at most 4 props', { version: 1, components: { [button]: { split: ['a', 'b', 'c', 'd', 'e'] } } }],
    ['twice', { version: 1, components: { [button]: { split: ['a', 'a'] } } }],
    ['sorted by name', { version: 1, components: { [button]: { frames: { 'variant=arrow&direction=back': {} } } } }],
    ['URI-encoded', { version: 1, components: { [button]: { frames: { 'variant=%E0%A4%A': {} } } } }],
    ['unknown key', { version: 1, components: { [button]: { frames: { '': { colour: 'red' } } } } }],
    ['one CSS colour', { version: 1, components: { [button]: { frames: { '': { background: 'red; color: blue' } } } } }],
    ['one CSS colour', { version: 1, components: { [button]: { frames: { '': { background: 'red" onload="x' } } } } }],
    ['whole number', { version: 1, components: { [button]: { frames: { '': { width: 12.5 } } } } }],
    ['1 to 10000', { version: 1, components: { [button]: { frames: { '': { height: 0 } } } } }],
    ['not both', { version: 1, components: { [button]: { frames: { '': { props: { label: 'x' }, unset: ['label'] } } } } }],
    ['finite', { version: 1, components: { [button]: { frames: { '': { props: { count: Number.POSITIVE_INFINITY } } } } } }],
    ['text, a number', { version: 1, components: { [button]: { frames: { '': { props: { list: [1] } } } } } }],
  ];
  for (const [reason, input] of bad) {
    assert.throws(
      () => parseComponentCanvasFile(input),
      (error: unknown) => error instanceof Error && error.message.includes(reason),
      reason,
    );
  }
  assert.equal(parseComponentCanvasSource('{broken').ok, false);
  assert.equal(parseComponentCanvasSource(' '.repeat(CANVAS_LIMITS.sourceCharsMax + 1)).ok, false);
  const tooMany = Object.fromEntries(Array.from({ length: CANVAS_LIMITS.entriesMax + 1 }, (_, index) => [`variant=v${String(index)}`, {}]));
  assert.throws(() => parseComponentCanvasFile({ version: 1, components: { [button]: { frames: tooMany } } }), /more than 256/);
  const longValue = 'x'.repeat(CANVAS_LIMITS.valueCharsMax + 1);
  assert.throws(() => parseComponentCanvasFile({ version: 1, components: { [button]: { frames: { '': { props: { label: longValue } } } } } }), /at most 16384/);
});

test('frame keys are sorted pairs, with a bare name for not set', () => {
  const key = frameKey([
    { prop: 'variant', value: { kind: 'value', value: 'arrow' } },
    { prop: 'direction', value: { kind: 'unset' } },
    { prop: 'open', value: { kind: 'value', value: true } },
  ]);
  assert.equal(key, 'direction&open=true&variant=arrow');
  assert.equal(parseFrameKey(key), key);
  assert.equal(frameKey([{ prop: 'label', value: { kind: 'value', value: 'a&b=c' } }]), 'label=a%26b%3Dc');
  assert.equal(frameKey([]), '');
});

test('the Lumos button splits by variant by default, and arrow alone gets a frame per direction', () => {
  assert.deepEqual(defaultSplit(buttonSchema), ['variant']);
  const candidates = splitCandidates(buttonSchema);
  // A switch with a default has no separate "not set"; an optional union without one does.
  assert.deepEqual(candidates.find((candidate) => candidate.name === 'direction')?.values, [
    { kind: 'value', value: 'forward' },
    { kind: 'value', value: 'back' },
    { kind: 'unset' },
  ]);
  assert.equal(candidates.find((candidate) => candidate.name === 'variant')?.values.length, 4);
  assert.equal(
    candidates.some((candidate) => candidate.name === 'label'),
    false,
  );
  const split = ['variant', 'direction'].map((name) => candidates.find((candidate) => candidate.name === name)).filter((candidate) => candidate !== undefined);
  const { frames, total } = canvasFrames(split, (prop, chosen) => unionAllows(unions, prop, held(chosen)));
  assert.deepEqual(
    frames.map((frame) => frame.key),
    ['variant=main', 'variant=link', 'variant=play', 'direction=forward&variant=arrow', 'direction=back&variant=arrow', 'direction&variant=arrow'],
  );
  assert.equal(total, 6);
  // Rows are the first split prop's values; the arrow row holds its three directions side by side.
  assert.deepEqual(
    frames.map((frame) => [frame.row, frame.column]),
    [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [3, 1],
      [3, 2],
    ],
  );
});

test('a split with no props is one frame, and frames past the bound are counted but not drawn', () => {
  assert.deepEqual(
    canvasFrames([], () => true).frames.map((frame) => frame.key),
    [''],
  );
  const wide = Array.from({ length: 3 }, (_, index) => ({
    name: `p${String(index)}`,
    values: Array.from({ length: 5 }, (__, value) => ({ kind: 'value' as const, value: `v${String(value)}` })),
  }));
  const result = canvasFrames(wide, () => true);
  assert.equal(result.total, 125);
  assert.equal(result.frames.length, CANVAS_LIMITS.framesMax);
});

test('a component without a variant prop splits by a union controller, else by nothing', () => {
  const controlled = [
    {
      name: 'element',
      type: 'enum',
      optional: true,
      options: ['button', 'link'],
      unions: [{ names: ['href'], branches: [{ forbids: ['href'], pins: { element: ['button'] }, defaults: {}, rules: {}, docs: {} }] }],
    },
  ];
  assert.deepEqual(defaultSplit(controlled), ['element']);
  assert.deepEqual(defaultSplit([{ name: 'preview', type: 'boolean', optional: true }]), []);
  assert.deepEqual(defaultSplit([]), []);
  // A stored split keeps only props the component still has.
  assert.deepEqual(effectiveSplit({ split: ['variant', 'gone'] }, buttonSchema), ['variant']);
  assert.deepEqual(effectiveSplit({ split: [] }, buttonSchema), []);
  assert.deepEqual(effectiveSplit(undefined, buttonSchema), ['variant']);
});

test('frames merge all-frames, per-variant and per-frame settings, the most specific last', () => {
  let file = EMPTY_CANVAS_FILE;
  file = withFrameEdit(file, button, '', { kind: 'background', value: 'white' });
  file = withFrameEdit(file, button, '', { kind: 'field', field: 'width', value: 320 });
  file = withFrameEdit(file, button, '', { kind: 'prop', name: 'label', value: 'Go' });
  file = withFrameEdit(file, button, 'variant=arrow', { kind: 'field', field: 'width', value: 'hug' });
  file = withFrameEdit(file, button, 'direction=back&variant=arrow', { kind: 'unset', name: 'label' });
  file = withFrameEdit(file, button, 'direction=back&variant=arrow', { kind: 'background', value: 'var(--dark)' });
  const settings = file.components[button];
  const back = resolveFrame(settings, 'direction=back&variant=arrow');
  assert.equal(back.width, 'hug');
  assert.equal(back.background, 'var(--dark)');
  assert.equal(back.props['label'], undefined);
  assert.ok(back.unset.has('label'));
  assert.equal(back.origins.get('width'), 'variant=arrow');
  const main = resolveFrame(settings, 'variant=main');
  assert.equal(main.width, 320);
  assert.equal(main.height, 'hug');
  assert.equal(main.background, 'white');
  assert.equal(main.props['label'], 'Go');
  assert.equal(main.origins.get('prop:label'), '');
  // Inheriting again removes the frame's own word, and an entry left empty leaves the file.
  file = withFrameEdit(file, button, 'direction=back&variant=arrow', { kind: 'inherit', name: 'label' });
  file = withFrameEdit(file, button, 'direction=back&variant=arrow', { kind: 'background', value: undefined });
  assert.equal(file.components[button]?.frames?.['direction=back&variant=arrow'], undefined);
  assert.equal(resolveFrame(file.components[button], 'direction=back&variant=arrow').props['label'], 'Go');
});

test('settings survive a new split prop, and a stale entry is kept, not deleted', () => {
  let file = withFrameEdit(EMPTY_CANVAS_FILE, button, 'variant=arrow', { kind: 'prop', name: 'emphasis', value: 'secondary' });
  file = withSplit(file, button, ['variant', 'direction']);
  // The arrow entry still applies to every arrow frame once direction is split too.
  assert.equal(resolveFrame(file.components[button], 'direction=back&variant=arrow').props['emphasis'], 'secondary');
  file = withSplit(file, button, []);
  assert.equal(resolveFrame(file.components[button], '').props['emphasis'], undefined);
  assert.deepEqual(Object.keys(file.components[button]?.frames ?? {}), ['variant=arrow']);
  // Back to the default split with nothing set: the component leaves the file.
  file = withFrameEdit(withSplit(file, button, undefined), button, 'variant=arrow', { kind: 'inherit', name: 'emphasis' });
  assert.deepEqual(file.components, {});
});

test('edits refuse values the parser would refuse, and the entry bound holds', () => {
  assert.throws(() => withFrameEdit(EMPTY_CANVAS_FILE, button, '', { kind: 'background', value: 'red;x' }), /one CSS colour/);
  assert.throws(() => withFrameEdit(EMPTY_CANVAS_FILE, button, 'b&a', { kind: 'field', field: 'width', value: 10 }), /sorted/);
  assert.throws(() => withFrameEdit(EMPTY_CANVAS_FILE, '../x.astro', '', { kind: 'field', field: 'width', value: 10 }), /project .astro/);
  assert.throws(() => withSplit(EMPTY_CANVAS_FILE, button, ['a', 'b', 'c', 'd', 'e']), /at most 4/);
  let file = EMPTY_CANVAS_FILE;
  for (let index = 0; index < CANVAS_LIMITS.entriesMax; index++) {
    file = withFrameEdit(file, button, `variant=v${String(index)}`, { kind: 'field', field: 'width', value: 10 });
  }
  assert.throws(() => withFrameEdit(file, button, 'variant=over', { kind: 'field', field: 'width', value: 10 }), /at most 256/);
});

test('a rename moves the key, a deletion drops it, and other components are untouched', () => {
  const card = 'src/components/Card.astro';
  let file = withSplit(EMPTY_CANVAS_FILE, button, ['variant']);
  file = withSplit(file, card, []);
  const renamed = relinkComponentCanvas(file, button, 'src/components/ui/Action.astro');
  assert.deepEqual(Object.keys(renamed.components).sort(), [card, 'src/components/ui/Action.astro']);
  // A target that already has settings keeps them; the rename plan refuses an existing file anyway.
  assert.equal(relinkComponentCanvas(file, button, card), file);
  const dropped = dropComponentCanvas(renamed, (component) => component.startsWith('src/components/ui/'));
  assert.deepEqual(Object.keys(dropped.components), [card]);
});

test('the CLI key reference accepts what the app writes', () => {
  const file = withFrameEdit(withSplit(EMPTY_CANVAS_FILE, button, ['variant', 'direction']), button, 'direction&variant=arrow', {
    kind: 'prop',
    name: 'label',
    value: 'Next',
  });
  assert.equal(
    checkValue({ kind: 'object', fields: COMPONENT_CANVAS_FILE_SCHEMA.fields }, JSON.parse(serializeComponentCanvas(file)), 'componentCanvas'),
    undefined,
  );
  assert.notEqual(
    checkValue(
      { kind: 'object', fields: COMPONENT_CANVAS_FILE_SCHEMA.fields },
      { version: 1, components: { [button]: { frames: { 'a=b&&c': {} } } } },
      'componentCanvas',
    ),
    undefined,
  );
});

test('the project background is kept through every edit, and a file without it is what older versions wrote', () => {
  const older = parseComponentCanvasFile({ version: 1, components: { [button]: { split: [] } } });
  assert.equal(older.background, undefined);
  let file = withProjectBackground(older, 'var(--background)');
  assert.equal(file.background, 'var(--background)');
  file = withFrameEdit(withSplit(file, button, ['variant']), button, 'variant=main', { kind: 'background', value: 'white' });
  file = relinkComponentCanvas(file, button, 'src/components/Action.astro');
  file = dropComponentCanvas(file, () => false);
  assert.equal(file.background, 'var(--background)');
  const source = serializeComponentCanvas(file);
  assert.match(source, /^{\n  "version": 1,\n  "background": "var\(--background\)",/);
  const parsed = parseComponentCanvasSource(source);
  assert.ok(parsed.ok);
  assert.equal(parsed.value.background, 'var(--background)');
  assert.equal(withProjectBackground(file, undefined).background, undefined);
  assert.equal(serializeComponentCanvas(withProjectBackground(file, undefined)).includes('"background": "var'), false);
  // The background is one CSS value, as a frame's is.
  assert.throws(() => withProjectBackground(file, 'red; color: blue'), /one CSS colour/);
  assert.throws(() => parseComponentCanvasFile({ version: 1, background: '', components: {} }), /CSS colour/);
  assert.throws(() => parseComponentCanvasFile({ version: 1, background: 'x'.repeat(CANVAS_LIMITS.backgroundCharsMax + 1), components: {} }), /CSS colour/);
});

test('a frame shows its own background, then its scopes and component, then the project, then nothing', () => {
  let file = withProjectBackground(EMPTY_CANVAS_FILE, 'var(--background)');
  assert.deepEqual(frameBackground(file, resolveFrame(file.components[button], 'variant=main'), button), {
    value: 'var(--background)',
    source: { kind: 'project' },
  });
  file = withFrameEdit(file, button, '', { kind: 'background', value: 'black' });
  assert.deepEqual(frameBackground(file, resolveFrame(file.components[button], 'variant=main'), button), {
    value: 'black',
    source: { kind: 'entry', key: '' },
  });
  file = withFrameEdit(file, button, 'variant=main', { kind: 'background', value: 'transparent' });
  assert.deepEqual(frameBackground(file, resolveFrame(file.components[button], 'variant=main'), button), {
    value: 'transparent',
    source: { kind: 'entry', key: 'variant=main' },
  });
  const none = withProjectBackground(EMPTY_CANVAS_FILE, undefined);
  assert.deepEqual(frameBackground(none, resolveFrame(undefined, ''), button), { value: undefined, source: { kind: 'none' } });
});

test('renaming a variable renames it in every background, and leaves longer names and the file otherwise alone', () => {
  let file = withProjectBackground(EMPTY_CANVAS_FILE, 'var(--surface)');
  file = withFrameEdit(file, button, '', { kind: 'background', value: 'var( --surface-2, var(--surface))' });
  const renamed = renameCanvasVariables(file, (name) => (name === '--surface' ? '--canvas' : name));
  assert.equal(renamed.background, 'var(--canvas)');
  assert.equal(renamed.components[button]?.frames?.['']?.background, 'var( --surface-2, var(--canvas))');
  assert.equal(
    renameCanvasVariables(file, (name) => name),
    file,
    'nothing to rename keeps the same file',
  );
});

// A wider edit never drops a narrower value: a component's own root setting is the person's override (a blue label they
// reset), so an All components edit leaves it, and the app says why nothing changed on that canvas.
test('a project root edit leaves a component’s own value, and says when that value hides it', () => {
  let file = withRootEdit(EMPTY_CANVAS_FILE, { kind: 'component', file: button }, { kind: 'classes', value: ['theme-invert'] });
  file = withRootEdit(file, PROJECT_ROOT, { kind: 'classes', value: ['theme-dark'] });
  assert.deepEqual(canvasRoot(file, button).classes, ['theme-invert']);
  assert.equal(rootOverrides(file, button, 'classes'), true);
  assert.equal(rootOverrides(file, button, 'background'), false);
  // None is a value of its own too: it holds over the project's classes until it is reset.
  const none = withRootEdit(file, { kind: 'component', file: button }, { kind: 'classes', value: [] });
  assert.deepEqual(canvasRoot(none, button).classes, []);
  assert.equal(rootOverrides(none, button, 'classes'), true);
  const reset = withRootEdit(none, { kind: 'component', file: button }, { kind: 'classes', value: undefined });
  assert.deepEqual(canvasRoot(reset, button).classes, ['theme-dark']);
  assert.equal(rootOverrides(reset, button, 'classes'), false);
});

test('the canvas root: classes and surface from the component, else the project; bounded, and older files still read', () => {
  const component = { kind: 'component', file: button } as const;
  assert.deepEqual(canvasRoot(EMPTY_CANVAS_FILE, button), { background: undefined, backgroundSource: 'none', classes: [], classesSource: 'none' });
  let file = withRootEdit(EMPTY_CANVAS_FILE, PROJECT_ROOT, { kind: 'classes', value: ['theme-dark'] });
  file = withRootEdit(file, PROJECT_ROOT, { kind: 'background', value: 'var(--background)' });
  assert.deepEqual(canvasRoot(file, button), {
    background: 'var(--background)',
    backgroundSource: 'project',
    classes: ['theme-dark'],
    classesSource: 'project',
  });
  file = withRootEdit(file, component, { kind: 'classes', value: ['theme-brand', 'u-text-large'] });
  assert.deepEqual(canvasRoot(file, button).classes, ['theme-brand', 'u-text-large'], "a component's list replaces the project's");
  assert.equal(canvasRoot(file, button).classesSource, 'component');
  assert.equal(canvasRoot(file, 'src/components/Card.astro').classesSource, 'project', 'other components keep the project list');
  assert.deepEqual(frameBackground(file, resolveFrame(file.components[button], 'variant=main'), button), {
    value: 'var(--background)',
    source: { kind: 'project' },
  });
  file = withRootEdit(file, component, { kind: 'background', value: '#000' });
  assert.deepEqual(frameBackground(file, resolveFrame(file.components[button], 'variant=main'), button), { value: '#000', source: { kind: 'root' } });
  const text = serializeComponentCanvas(file);
  const parsed = parseComponentCanvasSource(text);
  assert.ok(parsed.ok);
  assert.equal(serializeComponentCanvas(parsed.value), text, 'round-trips byte for byte, classes in their order');
  assert.doesNotThrow(() => validateMetadata('componentCanvas', text), 'the metadata transport accepts it');
  assert.equal(
    checkValue({ kind: 'object', fields: COMPONENT_CANVAS_FILE_SCHEMA.fields }, JSON.parse(text), 'componentCanvas'),
    undefined,
    'the CLI reference accepts what the app writes',
  );
  // Cleared at the component, the project's shows again, and the component leaves the file when nothing else is set.
  file = withRootEdit(file, component, { kind: 'classes', value: undefined });
  file = withRootEdit(file, component, { kind: 'background', value: undefined });
  assert.equal(file.components[button], undefined);
  assert.deepEqual(canvasRoot(file, button).classes, ['theme-dark']);
  // The project's root survives a frame edit, a split change and a background change.
  file = withSplit(withFrameEdit(file, button, '', { kind: 'background', value: 'red' }), button, ['variant']);
  file = withProjectBackground(file, '#111');
  assert.deepEqual(file.classes, ['theme-dark']);
  // Bounds and refusals.
  const many = Array.from({ length: CANVAS_LIMITS.rootClassesMax + 1 }, (_, index) => `c${String(index)}`);
  assert.throws(() => withRootEdit(EMPTY_CANVAS_FILE, PROJECT_ROOT, { kind: 'classes', value: many }), /at most/);
  assert.throws(() => withRootEdit(EMPTY_CANVAS_FILE, PROJECT_ROOT, { kind: 'classes', value: ['a b'] }), /not a class name/);
  assert.throws(() => withRootEdit(EMPTY_CANVAS_FILE, PROJECT_ROOT, { kind: 'classes', value: ['"><script>'] }), /not a class name/);
  assert.throws(() => withRootEdit(EMPTY_CANVAS_FILE, PROJECT_ROOT, { kind: 'classes', value: ['stacki-designer'] }), /keeps for itself/);
  assert.throws(() => withRootEdit(EMPTY_CANVAS_FILE, PROJECT_ROOT, { kind: 'classes', value: ['x', 'x'] }), /twice/);
  assert.throws(
    () => withRootEdit(EMPTY_CANVAS_FILE, PROJECT_ROOT, { kind: 'classes', value: ['x'.repeat(CANVAS_LIMITS.classNameCharsMax + 1)] }),
    /not a class name/,
  );
  assert.throws(() => parseComponentCanvasFile({ version: 1, components: { [button]: { root: { colour: 'red' } } } }), /unknown key colour/);
  assert.throws(() => parseComponentCanvasFile({ version: 1, classes: 'theme-dark', components: {} }), /list/);
  // A file from before the root has none, and reads as before.
  assert.deepEqual(parseComponentCanvasFile({ version: 1, components: { [button]: { split: ['variant'] } } }), {
    version: 1,
    components: { [button]: { split: ['variant'] } },
  });
});

test('a frame holds imported files, literal data and slot content, each prop in one place; older files read as before', () => {
  const settings = {
    frames: {
      '': { assets: { image: { file: 'src/assets/a.png' } }, content: 'All' },
      'variant=arrow': {
        literals: { items: { source: '[{ icon: one }]', imports: { one: 'src/assets/one.svg' } } },
        props: { image: '/public.png' },
        content: 'Arrow {braces} <strong>bold</strong>',
      },
    },
  };
  const file = parseComponentCanvasFile({ version: 1, components: { [button]: settings } });
  assert.deepEqual(parseComponentCanvasFile(JSON.parse(serializeComponentCanvas(file))), file);
  checkValue({ kind: 'object', fields: COMPONENT_CANVAS_FILE_SCHEMA.fields }, JSON.parse(serializeComponentCanvas(file)), 'componentCanvas');
  const arrow = resolveFrame(file.components[button], 'variant=arrow');
  assert.deepEqual(arrow.assets, {}, 'a narrower text value takes the prop out of the wider asset');
  assert.equal(arrow.props['image'], '/public.png');
  assert.equal(arrow.content, 'Arrow {braces} <strong>bold</strong>');
  assert.equal(resolveFrame(file.components[button], 'variant=main').assets['image']?.file, 'src/assets/a.png');
  const refused = (entry: unknown, reason: RegExp) =>
    assert.throws(() => parseComponentCanvasFile({ version: 1, components: { [button]: { frames: { '': entry } } } }), reason);
  refused({ props: { image: 'x' }, assets: { image: { file: 'src/a.png' } } }, /set once/);
  refused({ unset: ['image'], assets: { image: { file: 'src/a.png' } } }, /either given a value or unset/);
  refused({ assets: { image: { file: 'public/a.png' } } }, /under src/);
  refused({ literals: { items: 'process.exit()' } }, /literal/);
  refused({ content: '<script>run()</script>' }, /no script/);
  refused({ content: '<img src="x" onerror="run()">' }, /no script/);
  refused({ content: 'x'.repeat(CANVAS_LIMITS.contentCharsMax + 1) }, /at most/);
});

test('edits move a prop between its places, and an all-frames write leaves narrower values alone', () => {
  let file = withFrameEdit(EMPTY_CANVAS_FILE, button, 'variant=arrow', { kind: 'prop', name: 'label', value: 'Arrow' });
  file = withFrameEdit(file, button, '', { kind: 'prop', name: 'label', value: 'All' });
  assert.equal(resolveFrame(file.components[button], 'variant=arrow').props['label'], 'Arrow');
  assert.equal(resolveFrame(file.components[button], 'variant=main').props['label'], 'All');
  file = withFrameEdit(file, button, '', { kind: 'asset', name: 'label', asset: { file: 'src/a.png', url: true } });
  assert.deepEqual(file.components[button]?.frames?.[''], { assets: { label: { file: 'src/a.png', url: true } } });
  file = withFrameEdit(file, button, '', { kind: 'inherit', name: 'label' });
  assert.equal(file.components[button]?.frames?.[''], undefined);
  file = withFrameEdit(file, button, '', { kind: 'content', value: '' });
  assert.equal(resolveFrame(file.components[button], 'variant=main').content, '', 'an empty slot is a value');
});

test('a setting says whether it is set at the scope, inherited from a wider one or overridden on the frame', () => {
  let file = withFrameEdit(EMPTY_CANVAS_FILE, button, '', { kind: 'field', field: 'width', value: 300 });
  const frame = 'variant=arrow';
  const level = (scope: string) => settingLevel(file.components[button], frame, scope, 'width');
  assert.deepEqual(level(''), { kind: 'own' });
  assert.deepEqual(level(frame), { kind: 'inherited', from: '' });
  file = withFrameEdit(file, button, frame, { kind: 'field', field: 'width', value: 120 });
  assert.deepEqual(level(frame), { kind: 'own' });
  assert.deepEqual(level(''), { kind: 'overridden', by: frame });
  assert.deepEqual(settingLevel(file.components[button], frame, frame, 'height'), { kind: 'none' });
});

test('a moved file keeps being the one a frame names, itself or inside a list', () => {
  const file = parseComponentCanvasFile({
    version: 1,
    components: {
      [button]: {
        frames: { '': { assets: { image: { file: 'src/assets/a.png' } }, literals: { list: { source: '[a]', imports: { a: 'src/assets/a.png' } } } } },
      },
    },
  });
  const moved = relinkCanvasAssets(file, 'src/assets', 'src/media');
  assert.deepEqual(
    canvasAssetUses(moved).map((use) => [use.owner, use.prop, use.file]),
    [
      [button, 'image', 'src/media/a.png'],
      [button, 'list', 'src/media/a.png'],
    ],
  );
  assert.equal(relinkCanvasAssets(file, 'src/other', 'src/elsewhere'), file);
});

test('overrides: frames a scope reaches that a narrower entry sets are found, kept across wider edits, and reset', () => {
  const button = 'src/components/Button.astro';
  const frames = ['emphasis=primary&variant=main', 'emphasis=secondary&variant=main', 'variant=link'] as const;
  let file = withFrameEdit(EMPTY_CANVAS_FILE, button, 'emphasis=primary&variant=main', { kind: 'field', field: 'width', value: 200 });
  file = withFrameEdit(file, button, 'variant=main', { kind: 'field', field: 'height', value: 90 });
  // A later all-frames width leaves the frame's own width in place: it still wins on that frame.
  file = withFrameEdit(file, button, '', { kind: 'field', field: 'width', value: 400 });
  const settings = file.components[button];
  assert.equal(resolveFrame(settings, frames[0]).width, 200, 'the frame’s own width survives an all-frames edit');
  assert.equal(resolveFrame(settings, frames[1]).width, 400);
  assert.deepEqual(overridesIn(settings, frames, '', 'width'), [{ frame: frames[0], from: frames[0] }]);
  assert.deepEqual(overridesIn(settings, frames, 'variant=main', 'width'), [{ frame: frames[0], from: frames[0] }], 'within a variant too');
  assert.deepEqual(overridesIn(settings, frames, frames[0], 'width'), [], 'a frame overrides nothing of its own');
  assert.deepEqual(
    overridesIn(settings, frames, '', 'height').map((entry) => entry.frame),
    [frames[0], frames[1]],
    'a variant’s height overrides all frames for both of its frames',
  );
  assert.deepEqual(overridesIn(settings, frames, 'variant=link', 'height'), [], 'a scope reaches only its own frames');
  assert.equal(scopeHolds('', 'variant=main'), true);
  assert.equal(scopeHolds('variant=main', 'emphasis=primary&variant=main'), true);
  assert.equal(scopeHolds('variant=main', 'variant=link'), false);
  // Reset: every narrower entry drops the setting; the scope's own and wider stay; empty entries go.
  const reset = withoutOverrides(file, button, '', 'width');
  assert.equal(resolveFrame(reset.components[button], frames[0]).width, 400);
  assert.equal(resolveFrame(reset.components[button], frames[0]).height, 90, 'only the setting reset is dropped');
  assert.equal(reset.components[button]?.frames?.[frames[0]], undefined, 'an entry left empty is removed');
  const heightReset = withoutOverrides(file, button, '', 'height');
  assert.equal(heightReset.components[button]?.frames?.['variant=main'], undefined);
  assert.equal(withoutOverrides(file, button, '', 'prop:label'), file, 'nothing narrower says label: the file is unchanged');
});

test('an empty text stored by an older version is no value: the wider one shows through', () => {
  const settings = { frames: { '': { props: { label: 'Go' } }, 'variant=main': { props: { label: '', size: 2 } } } };
  const resolved = resolveFrame(settings, 'variant=main');
  assert.equal(resolved.props['label'], 'Go');
  assert.equal(resolved.origins.get('prop:label'), '');
  assert.equal(resolved.props['size'], 2);
});

test('each level has its own layout: none reaches another, the default is no setting, and unknown values are refused', () => {
  const levels = { groups: ['variant=main', 'variant=arrow', 'emphasis=primary&variant=arrow'], stacked: true };
  const shown = (file: Parameters<typeof withLevelArrangement>[0]) =>
    [CANVAS_LEVEL, ...levels.groups].map((level) => levelArrangement(file.components[button], level, levels).value);
  assert.deepEqual(shown(EMPTY_CANVAS_FILE), ['column', 'row', 'row', 'row'], 'grouped: the canvas goes down, groups across');
  assert.equal(levelArrangement(undefined, CANVAS_LEVEL, { groups: [], stacked: false }).value, 'row', 'frames alone sit side by side');
  const top = withLevelArrangement(EMPTY_CANVAS_FILE, button, CANVAS_LEVEL, 'row', levels);
  assert.deepEqual(shown(top), ['row', 'row', 'row', 'row']);
  assert.deepEqual(top.components[button], { layouts: { [CANVAS_LEVEL]: 'row' } }, 'across is a choice for a canvas that goes down');
  const one = withLevelArrangement(top, button, 'variant=arrow', 'column', levels);
  assert.deepEqual(shown(one), ['row', 'row', 'column', 'row'], 'one group changes alone, its own groups too');
  const text = serializeComponentCanvas(one);
  const parsed = parseComponentCanvasSource(text);
  assert.ok(parsed.ok);
  assert.deepEqual(shown(parsed.value), shown(one), 'read back');
  assert.equal(
    checkValue({ kind: 'object', fields: COMPONENT_CANVAS_FILE_SCHEMA.fields }, JSON.parse(text), 'componentCanvas'),
    undefined,
    'the CLI accepts it',
  );
  // Reset, or choosing the default, removes that level's setting alone; the last one takes the component with it.
  const back = withLevelArrangement(one, button, CANVAS_LEVEL, undefined, levels);
  assert.deepEqual(back.components[button], { layouts: { 'variant=arrow': 'column' } });
  assert.deepEqual(withLevelArrangement(back, button, 'variant=arrow', 'row', levels).components, {});
  assert.throws(() => parseComponentCanvasFile({ version: 1, components: { [button]: { layouts: { [CANVAS_LEVEL]: 'grid' } } } }), /row, column or wrap/);
  assert.throws(() => parseComponentCanvasFile({ version: 1, components: { [button]: { layouts: [] } } }));
  assert.throws(() => parseComponentCanvasFile({ version: 1, components: { [button]: { arrange: 'grid' } } }), /row, column or wrap/);
  assert.throws(() => parseComponentCanvasFile({ version: 1, components: { [button]: { layouts: { '': 'row' } } } }), /keyed/);
  const many = Object.fromEntries(Array.from({ length: CANVAS_LIMITS.entriesMax + 1 }, (_, index) => [`a=${String(index)}`, 'row']));
  assert.throws(() => parseComponentCanvasFile({ version: 1, components: { [button]: { layouts: many } } }), /levels/);
});

test('a canvas arranged before levels had their own looks the same, and its first layout edit keeps every level', () => {
  const levels = { groups: ['variant=main', 'variant=arrow'], stacked: true };
  const old = (arrange: string) => parseComponentCanvasFile({ version: 1, components: { [button]: { arrange } } });
  const shown = (file: ReturnType<typeof old>, at = levels) =>
    [CANVAS_LEVEL, ...at.groups].map((level) => levelArrangement(file.components[button], level, at).value);
  // As each was drawn: stacked reached every level; wrap reached the groups, and a top level only where it went across.
  assert.deepEqual(shown(old('column')), ['column', 'column', 'column']);
  assert.deepEqual(shown(old('wrap')), ['column', 'wrap', 'wrap']);
  assert.deepEqual(shown(old('wrap'), { groups: [], stacked: false }), ['wrap']);
  assert.deepEqual(shown(old('row')), ['column', 'row', 'row']);
  assert.equal(levelArrangement(old('wrap').components[button], CANVAS_LEVEL, levels).chosen, false);
  assert.equal(levelArrangement(old('wrap').components[button], 'variant=main', levels).chosen, true, 'a saved choice reads as set');
  const edited = withLevelArrangement(old('wrap'), button, 'variant=arrow', 'column', levels);
  assert.deepEqual(shown(edited), ['column', 'wrap', 'column']);
  assert.equal(edited.components[button]?.arrange, undefined, 'the single value is gone');
  // Reset is never a silent no-op over the old value: the level goes to its default and stays there.
  const reset = withLevelArrangement(old('column'), button, 'variant=main', undefined, levels);
  assert.deepEqual(shown(reset), ['column', 'row', 'column']);
  assert.deepEqual(chosenLayouts(reset.components[button], levels), { [CANVAS_LEVEL]: 'column', 'variant=arrow': 'column' });
});

test('frames that differ are told apart from frames that agree, a frame’s own value among them', () => {
  const button = 'src/components/Button.astro';
  const frames = ['emphasis=primary&variant=main', 'emphasis=secondary&variant=main', 'variant=link'];
  const file = withFrameEdit(EMPTY_CANVAS_FILE, button, frames[0] ?? '', { kind: 'field', field: 'width', value: 200 });
  const settings = file.components[button];
  assert.equal(settingMixed(settings, frames, '', 'width'), true, 'one frame’s own width differs from the others’ hug');
  assert.equal(settingMixed(settings, frames, 'variant=link', 'width'), false, 'one frame never differs from itself');
  assert.equal(settingMixed(settings, frames, '', 'height'), false, 'all hug');
  const labelled = withFrameEdit(EMPTY_CANVAS_FILE, button, 'variant=link', { kind: 'prop', name: 'label', value: 'Own' });
  assert.equal(settingMixed(labelled.components[button], frames, '', 'prop:label'), true);
  assert.equal(settingMixed(labelled.components[button], frames, 'variant=main', 'prop:label'), false, 'outside the scope it does not count');
});
