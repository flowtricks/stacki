// Goal: the component canvas renders what the frames say and nothing else. A Lumos-style button gets a frame per variant
// with props its variant forbids left out; required props and an element id get usable values; the canvas page imports
// each component once, writes every frame's props, size and background into a page the editor's own parser reads,
// escapes what it writes, falls back to the component's name for an empty default slot and keeps insertion defaults
// under the frame's own values; and only well-formed messages from the canvas page are heard. The page's instances are
// found where the editor's parser puts them, a click anywhere in a frame names its instance and only the open canvas's
// page counts as one, and a prop value from the Settings panel becomes a preview value only when the canvas can replay it.
// Method: build layouts from hand-written schemas and stored settings, generate pages from them, parse each page with the
// app's Astro parser, and feed the message reader known-good and known-bad shapes.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule');
const { parsePage, serializePageMarked } = require('#dist/electron/parse/astroParser.js');
const model = loadRenderer('src/features/preview/componentCanvas/canvasModel.ts');
const page = loadRenderer('src/features/preview/componentCanvas/canvasPage.ts');
const chrome = loadRenderer('src/features/preview/componentCanvas/canvasChrome.ts');
const session = loadRenderer('src/features/preview/componentCanvas/componentCanvasSession.ts');

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const BUTTON = 'src/components/Button.astro';
const unions = [
  {
    names: ['variant', 'direction', 'label'],
    branches: [
      { forbids: ['direction', 'label'], pins: { variant: ['main'] }, defaults: {}, rules: {}, docs: {} },
      { forbids: [], pins: { variant: ['arrow'] }, defaults: {}, rules: {}, docs: {} },
    ],
  },
];
const button = {
  file: BUTTON,
  name: 'Button',
  schema: [
    { name: 'variant', type: 'enum', optional: true, options: ['main', 'arrow'], default: 'main', unions },
    { name: 'direction', type: 'enum', optional: true, options: ['forward', 'back'], unions },
    { name: 'label', type: 'string', optional: true, unions },
    { name: 'size', type: 'enum', optional: true, options: ['1', '2'], numeric: true, unions },
    { name: 'id', type: 'string', optional: true, unions },
    { name: 'heading', type: 'string', optional: false, unions },
    { name: 'onPress', type: 'code', optional: true, codeKind: 'function', unions },
  ],
};
const snapshot = {
  catalog: [{ file: BUTTON, name: 'Button', props: ['variant', 'label'], slots: ['default'], slotText: true }],
  config: { version: 1, components: {} },
};

function pageOf(layout, overrides = {}) {
  return page.canvasPageSource({
    id: ID,
    component: BUTTON,
    fallbackText: 'Button',
    theme: 'dark',
    snapshot,
    frames: layout.frames.map((frame) => ({
      key: frame.key,
      label: frame.key || 'Button',
      row: frame.row,
      props: frame.props,
      omitted: frame.omitted,
      width: frame.resolved.width,
      height: frame.resolved.height,
      background: frame.resolved.background,
    })),
    ...overrides,
  });
}

test('a button splits by variant; props a variant forbids are left out; required props and ids get values', () => {
  const layout = model.buildCanvasLayout(button, { frames: { '': { props: { label: 'Go', size: '2' } } } });
  assert.deepEqual(
    layout.frames.map((frame) => frame.key),
    ['variant=main', 'variant=arrow'],
  );
  const [main, arrow] = layout.frames;
  assert.equal(main.props.label, undefined, 'main forbids label');
  assert.ok(main.omitted.has('direction'));
  assert.equal(arrow.props.label, 'Go');
  assert.equal(arrow.props.size, 2, 'a numeric option is written as a number');
  assert.equal(main.props.heading, 'Heading', 'a required text prop shows its own name');
  assert.equal(main.props.id, 'stacki-canvas-1');
  assert.equal(arrow.props.id, 'stacki-canvas-2');
  assert.equal(model.frameTakes(button, main, 'direction'), false);
  assert.equal(model.frameTakes(button, arrow, 'direction'), true);
  assert.equal(model.fieldControl(button.schema[6]), undefined, 'an action has no preview control');
  assert.deepEqual(model.fieldControl(button.schema[0]), { kind: 'choice', options: ['main', 'arrow'] });
});

test('a stored value for a prop the component no longer has is ignored, not drawn', () => {
  const layout = model.buildCanvasLayout(button, { split: ['variant'], frames: { 'variant=arrow': { props: { gone: 'x' } } } });
  assert.equal(layout.frames[1].props.gone, undefined);
  assert.equal(layout.frames[1].resolved.props.gone, 'x', 'it stays in the settings');
});

test('the canvas page parses, imports the component once, and writes each frame', () => {
  const layout = model.buildCanvasLayout(button, {
    split: ['variant', 'direction'],
    frames: {
      '': { background: 'var(--swatch-light)' },
      'direction=back&variant=arrow': { width: 320, height: 200, props: { label: 'Back "<there>"' } },
    },
  });
  const source = pageOf(layout);
  const importLine = 'import Button from "../../' + BUTTON + '";';
  assert.equal(source.split(importLine).length - 1, 1, 'the component is imported once');
  assert.ok(source.includes('<stacki-frame data-frame={"direction=back&variant=arrow"} data-label="direction=back&amp;variant=arrow"'));
  assert.match(
    source,
    /data-fixed-width data-fixed-height style="grid-row: 2; grid-column: 2; width: 320px; height: 200px; contain-intrinsic-size: 320px 200px; background: var\(--swatch-light\)"/,
    'the frame sits in its row and column, at its size and background',
  );
  assert.match(source, /label="Back &quot;&lt;there&gt;&quot;"/, 'prop text is escaped');
  assert.match(source, /<Button variant="main"[^>]*>Button Text<\/Button>/, 'without a project recipe, the starter defaults fill the slot');
  const chip = { ...snapshot, catalog: [{ ...snapshot.catalog[0], name: 'Chip', slotText: false }] };
  assert.match(pageOf(layout, { snapshot: chip, fallbackText: 'Chip' }), />Chip<\/Button>/, 'an empty default slot shows the component name');
  assert.doesNotMatch(source, /variant="main" direction=/, 'main is never given a direction');
  const parsed = parsePage(source);
  assert.equal(parsed.editable, true, parsed.editable ? '' : parsed.reason);
  const tags = new Set();
  const pending = [...parsed.model.nodes];
  for (let visited = 0; visited < 10_000 && pending.length > 0; visited++) {
    const node = pending.shift();
    if (node.kind === 'element') {
      tags.add(node.name);
    }
    pending.push(...(node.children ?? []));
  }
  assert.equal(pending.length, 0, 'the page is walked whole');
  assert.deepEqual(
    [...tags].filter((name) => name.startsWith('stacki-')),
    ['stacki-frame'],
    'the frames are the only element of the canvas: no world, rows or labels to point at',
  );
  assert.doesNotMatch(source, /<stacki-frame[^>]*data-transparent/, 'every frame has the all-frames background');
});

test('insertion defaults come first and the frame wins; an unset prop is not passed at all', () => {
  const withRecipe = { ...snapshot, config: { version: 1, components: { [BUTTON]: { props: { label: 'From defaults', variant: 'arrow' }, text: 'Click' } } } };
  const layout = model.buildCanvasLayout(button, { split: [], frames: { '': { unset: ['label'] } } });
  const source = pageOf(layout, { snapshot: withRecipe });
  assert.match(source, /<Button variant="arrow" id="stacki-canvas-1" heading="Heading">Click<\/Button>/);
  assert.doesNotMatch(source, /From defaults/);
});

test('the chrome refuses what could break out of its elements, and the page name is a UUID', () => {
  assert.throws(() => chrome.chromeScript('not-a-uuid'), /UUID/);
  assert.doesNotMatch(chrome.chromeScript(ID), /<\/script/);
  assert.doesNotMatch(chrome.chromeStyles('dark'), /<\//);
  assert.throws(() => page.canvasPageSource({ id: ID, component: BUTTON, fallbackText: 'x', theme: 'dark', snapshot, frames: [] }), /at least one frame/);
});

test('only well-formed messages from this canvas are heard', () => {
  const type = chrome.CANVAS_MESSAGE;
  assert.deepEqual(chrome.canvasMessage({ type, canvas: ID, event: 'select', frame: 'variant=main', chrome: true }, ID), {
    event: 'select',
    frame: 'variant=main',
    chrome: true,
    scale: undefined,
  });
  assert.equal(chrome.canvasMessage({ type, canvas: ID, event: 'view', scale: 0.5 }, ID).scale, 0.5);
  assert.equal(chrome.canvasMessage({ type, canvas: ID, event: 'view', scale: -1 }, ID).scale, undefined);
  assert.equal(chrome.canvasMessage({ type, canvas: 'other', event: 'ready' }, ID), undefined, 'another canvas');
  assert.equal(chrome.canvasMessage({ type: 'avb:click-node', canvas: ID, event: 'ready' }, ID), undefined, 'another protocol');
  assert.equal(chrome.canvasMessage({ type, canvas: ID, event: 'delete' }, ID), undefined, 'an unknown event');
  assert.equal(chrome.canvasMessage({ type, canvas: ID, event: 'select', frame: 'x'.repeat(2000) }, ID).frame, undefined, 'an oversized key');
  assert.equal(chrome.canvasMessage(undefined, ID), undefined);
  assert.equal(chrome.canvasMessage('select', ID), undefined);
});

test('every frame renders the component defaults: props, text and nested children with their own defaults', () => {
  const CARD = 'src/components/Card.astro';
  const ACTION = 'src/components/Action.astro';
  const card = {
    file: CARD,
    name: 'Card',
    schema: [
      { name: 'variant', type: 'enum', optional: true, options: ['default', 'cover'], default: 'default' },
      { name: 'heading', type: 'string', optional: true },
    ],
  };
  const defaults = {
    catalog: [
      { file: CARD, name: 'Card', props: ['variant', 'heading'], slots: ['default', 'footer'], slotText: false },
      { file: ACTION, name: 'Action', props: ['emphasis'], slots: ['default'], slotText: true },
    ],
    config: {
      version: 1,
      components: {
        [CARD]: {
          props: { heading: 'From defaults' },
          children: [
            { element: 'p', text: 'Body copy' },
            { component: ACTION, props: { slot: 'footer' } },
          ],
        },
        [ACTION]: { props: { emphasis: 'secondary' }, text: 'Read more' },
      },
    },
  };
  const layout = model.buildCanvasLayout(card, { frames: { 'variant=cover': { props: { heading: 'Cover heading' } } } });
  const source = page.canvasPageSource({
    id: ID,
    component: CARD,
    fallbackText: 'Card',
    theme: 'dark',
    snapshot: defaults,
    frames: layout.frames.map((frame) => ({
      key: frame.key,
      label: frame.key,
      row: frame.row,
      props: frame.props,
      omitted: frame.omitted,
      width: 'hug',
      height: 'hug',
      background: undefined,
    })),
  });
  const children = '<p>Body copy</p><Action emphasis="secondary" slot="footer">Read more</Action>';
  assert.ok(source.includes(`<Card heading="From defaults" variant="default">${children}</Card>`), 'defaults, nested recipe and named slot');
  assert.ok(source.includes(`<Card heading="Cover heading" variant="cover">${children}</Card>`), 'a preview value wins over the default');
  assert.doesNotMatch(source, />Card</, 'no placeholder when defaults are configured');
  assert.equal(parsePage(source).editable, true);
});

test('the project background is the canvas surface, frames without their own are transparent over it, and a gone variable falls back', () => {
  const grey = chrome.chromeStyles('dark');
  assert.match(grey, /html\[data-stacki-ready\] \{ background: #1e1e1e !important; \}/);
  assert.match(grey, /stacki-frame\[data-transparent\] \{ background: #fff; \}/, 'the page background is painted over this by the script');
  assert.doesNotMatch(chrome.chromeScript(ID), /setProperty\('--/, 'the chrome sets no custom property a variable picker would list');
  const layout = model.buildCanvasLayout(button, undefined);
  assert.match(
    pageOf(layout, { surface: 'var(--background)' }),
    /'stacki-designer'\]\.filter\(Boolean\)\.join\(' '\)\} data-stacki-surface>/,
    'a project background marks the root',
  );
  assert.doesNotMatch(pageOf(layout), /\} data-stacki-surface>/);
  const themed = chrome.chromeStyles('dark', 'var(--background)');
  assert.match(themed, /html\[data-stacki-ready\] \{ background: var\(--background, #1e1e1e\) !important; \}/, 'a variable the project drops draws the grey');
  assert.match(themed, /stacki-frame\[data-transparent\] \{ background: transparent; \}/);
  assert.match(chrome.chromeStyles('dark', '#fff'), /background: #fff !important;/);
  assert.equal(chrome.withFallback('var(--a, red)', '#000'), 'var(--a, red)', 'a fallback of its own is kept');
  assert.equal(chrome.withFallback(' var( --a ) ', '#000'), 'var(--a, #000)');
  assert.equal(chrome.withFallback('transparent', '#000'), 'transparent');
});

test('each frame instance is found by its path; a click in a frame names its instance; only the open canvas page is one', () => {
  const layout = model.buildCanvasLayout(button, { split: ['variant', 'direction'] });
  const parsed = parsePage(pageOf(layout));
  assert.equal(parsed.editable, true);
  const instances = page.canvasInstancesOf(parsed.model.nodes);
  assert.deepEqual(
    instances.map((instance) => instance.key),
    layout.frames.map((frame) => frame.key),
    'one instance per frame, in frame order',
  );
  for (const instance of instances) {
    const trail = instance.path.split('.').map(Number);
    let node = parsed.model.nodes[trail[0]];
    for (const index of trail.slice(1)) {
      node = node?.children?.[index];
    }
    assert.equal(node?.kind, 'component', `${instance.key} is a component instance`);
    assert.equal(node?.name, 'Button', 'named as the component is, not a generated binding');
  }
  const [first, second] = instances;
  const frameOf = (path) => path.split('.').slice(0, -1).join('.');
  session.noteComponentCanvas({ kind: 'idle' });
  assert.equal(session.canvasInstanceAt(first.path), undefined, 'no canvas open: nothing is a frame');
  assert.equal(session.isComponentCanvasPage(`/site/.stacki/canvas/${ID}.astro`), false);
  session.noteComponentCanvas({ kind: 'open', id: ID, instances, root: '1' });
  assert.equal(session.isCanvasRoot('1'), true, 'the root is the canvas itself');
  assert.equal(session.isCanvasRoot(first.path), false);
  assert.equal(session.canvasRootPath(), '1');
  assert.equal(session.isComponentCanvasPage(`/site/.stacki/canvas/${ID}.astro`), true);
  assert.equal(session.isComponentCanvasPage('/site/.stacki/canvas/0f8fad5b-d9cb-469f-a165-70867728950f.astro'), false, 'another canvas page is not this one');
  assert.equal(session.isComponentCanvasPage('/site/src/pages/index.astro'), false);
  assert.equal(session.canvasInstanceAt(first.path)?.key, first.key, 'the instance itself');
  assert.equal(session.canvasInstanceAt(first.path + '.0')?.key, first.key, 'inside the instance');
  assert.equal(session.canvasInstanceAt(frameOf(second.path))?.key, second.key, 'the frame itself (its caption, the space around its instance)');
  assert.equal(session.canvasInstanceAt(frameOf(frameOf(first.path))), undefined, 'the world between frames is no frame');
  assert.equal(session.canvasInstanceOf(first.path + '.0'), undefined, 'only the instance itself is the instance');
  assert.throws(() => page.canvasInstancesOf([{ kind: 'element', name: 'stacki-frame', props: {}, children: [] }]), /names its frame/);
  session.noteComponentCanvas({ kind: 'idle' });
});

test('a prop value from the Settings panel is a preview value only when the canvas can replay it', () => {
  assert.equal(model.previewValue({ type: 'string', value: 'Back' }), 'Back');
  assert.equal(model.previewValue({ type: 'bare' }), true);
  assert.equal(model.previewValue({ type: 'expr', value: 'false' }), false);
  assert.equal(model.previewValue({ type: 'expr', value: ' 12.5 ' }), 12.5);
  assert.equal(model.previewValue({ type: 'expr', value: '"quoted"' }), 'quoted');
  assert.equal(model.previewValue({ type: 'expr', value: '`a ${b}`' }), undefined, 'a template with code is code');
  assert.equal(model.previewValue({ type: 'expr', value: 'page.title' }), undefined, 'data is code');
  assert.equal(model.previewValue({ type: 'expr', value: '() => go()' }), undefined);
  assert.equal(model.previewValue({ type: 'spread', value: 'rest' }), undefined);
});

test('the canvas root is the page’s <html>: its path is found, and its classes follow the layout’s', () => {
  const layout = model.buildCanvasLayout(button, undefined);
  const source = pageOf(layout, { rootClasses: ['theme-dark', 'u-wide'] });
  assert.match(source, /class=\{\[htmlAttributes\.class, "theme-dark", "u-wide", 'stacki-designer'\]/, 'after the layout’s own, before the canvas’s');
  assert.match(pageOf(layout), /class=\{\[htmlAttributes\.class, 'stacki-designer'\]/, 'none set, the layout’s alone');
  const parsed = parsePage(source);
  assert.equal(parsed.editable, true);
  const tree = page.canvasTreeOf(parsed.model.nodes);
  assert.equal(parsed.model.nodes[Number(tree.root)].name, 'html');
  assert.ok(
    tree.instances.every((instance) => instance.path.startsWith(tree.root + '.')),
    'every frame is inside the root',
  );
  assert.throws(() => pageOf(layout, { rootClasses: ['a"b'] }), /plain class name/);
  // The preview marks every node with a path the editor names it by; the canvas's chrome and <body> get none, so a
  // click or hover between frames is the root's, and one in a frame its instance's. The instance is marked as ever.
  const marked = serializePageMarked(parsed.model, '', undefined, source);
  for (const tag of ['body']) {
    assert.doesNotMatch(marked, new RegExp(`<${tag}[^>]*data-avb-p`), `${tag} carries no path`);
  }
  const instancePath = tree.instances[0].path;
  assert.ok(marked.includes(`data-avb-p="${instancePath}"`) || marked.includes(`"${instancePath}"`), 'the instance keeps its path');
  assert.ok(marked.includes(`<!--avb-s:${instancePath}-->`), 'the instance keeps its markers');
  const bodyPath = `${tree.root}.1`;
  assert.ok(
    tree.instances.every((instance) => instance.path.split('.').length === 4),
    'html > body > frame > instance, nothing in between',
  );
  assert.ok(!marked.includes(`<!--avb-s:${bodyPath}-->`), 'the body has no marker pair');
});
