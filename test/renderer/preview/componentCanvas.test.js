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
      assets: frame.assets,
      literals: frame.literals,
      content: frame.content,
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
  assert.ok(source.includes('<stacki-frame data-frame={"direction=back&variant=arrow"} data-label={"direction=back&variant=arrow"}'));
  assert.match(
    source,
    /data-fixed-width data-fixed-height style="width: 320px !important; height: 200px !important; background: var\(--swatch-light\) !important"/,
    'the frame is at its size and background',
  );
  assert.match(source, /<body [^>]*data-flow="column">/, 'one row for each of the first prop’s values');
  assert.ok(source.includes('label={"Back \\"\\u003cthere\\u003e\\""}'), 'text that markup would escape is a string expression');
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
  assert.deepEqual(chrome.canvasMessage({ type, canvas: ID, event: 'ready' }, ID), { event: 'ready', scale: undefined, sizes: new Map() });
  // The frames' drawn sizes: whole, bounded lengths by key; anything else is left out.
  const sizes = chrome.canvasMessage({ type, canvas: ID, event: 'sizes', frames: { a: [120, 40], b: [1.5, 2], c: [-1, 3], d: 'x', e: [9e9, 1] } }, ID).sizes;
  assert.deepEqual([...sizes], [['a', { width: 120, height: 40 }]]);
  assert.equal(chrome.canvasMessage({ type, canvas: ID, event: 'sizes', frames: 'none' }, ID).sizes.size, 0);
  // A resize on the canvas: its frame, its phase, and whole bounded sizes or hug per side; anything else is not heard.
  const resize = (extra) => chrome.canvasMessage({ type, canvas: ID, event: 'resize', frame: 'variant=main', phase: 'end', ...extra }, ID)?.resize;
  assert.deepEqual(resize({ width: 320, height: 'hug' }), { frame: 'variant=main', phase: 'end', width: 320, height: 'hug' });
  assert.deepEqual(resize({ width: 0.5 }), { frame: 'variant=main', phase: 'end', width: undefined, height: undefined }, 'not a whole size');
  assert.equal(resize({ width: 99999 })?.width, undefined, 'past the bound');
  assert.equal(resize({ phase: 'drag' }), undefined, 'an unknown phase');
  assert.match(chrome.chromeScript(ID), /data\.command === 'cancelResize'/, 'the editor can cancel a resize (Escape)');
  // The selection is the editor's: the page no longer names a pressed frame, and such a message is not heard.
  assert.equal(chrome.canvasMessage({ type, canvas: ID, event: 'select', frame: 'variant=main', chrome: true }, ID), undefined);
  assert.equal(chrome.canvasMessage({ type, canvas: ID, event: 'view', scale: 0.5 }, ID).scale, 0.5);
  assert.equal(chrome.canvasMessage({ type, canvas: ID, event: 'view', scale: -1 }, ID).scale, undefined);
  assert.equal(chrome.canvasMessage({ type, canvas: 'other', event: 'ready' }, ID), undefined, 'another canvas');
  assert.equal(chrome.canvasMessage({ type: 'avb:click-node', canvas: ID, event: 'ready' }, ID), undefined, 'another protocol');
  assert.equal(chrome.canvasMessage({ type, canvas: ID, event: 'delete' }, ID), undefined, 'an unknown event');
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

test('the surface is the canvas setting, else the site page’s own; frames are transparent and the scaffolding resists the project’s CSS', () => {
  const plain = chrome.chromeStyles('dark');
  assert.doesNotMatch(plain, /data-stacki-surface\] \{ background/, 'no setting: the script paints the site page’s background, or the grey');
  assert.match(chrome.chromeScript(ID), /getComputedStyle\(root\)\.backgroundColor/, 'the root’s own background first, as a browser paints a page');
  assert.match(chrome.chromeScript(ID), /"#1e1e1e"/, 'the app’s grey where the site paints none');
  assert.match(
    plain,
    /html\[data-stacki-ready\] > body stacki-frame\[data-frame\] \{[^}]*background: transparent !important;/,
    'a frame is transparent, whatever the project paints on elements',
  );
  for (const property of ['margin: 0 !important', 'padding: 0 !important', 'border: 0 !important', 'opacity: 1 !important', 'visibility: visible !important']) {
    assert.ok(plain.includes(property), `the scaffolding pins ${property}`);
  }
  assert.doesNotMatch(chrome.chromeScript(ID), /setProperty\('--/, 'the chrome sets no custom property a variable picker would list');
  const layout = model.buildCanvasLayout(button, undefined);
  assert.match(
    pageOf(layout, { surface: 'var(--background)' }),
    /'stacki-designer'\]\.filter\(Boolean\)\.join\(' '\)\} data-stacki-surface>/,
    'a canvas background setting marks the root',
  );
  assert.doesNotMatch(pageOf(layout), /\} data-stacki-surface>/);
  const themed = chrome.chromeStyles('dark', 'var(--background)');
  assert.match(themed, /\[data-stacki-surface\] \{ background: var\(--background, #1e1e1e\) !important; \}/, 'a variable the project drops draws the grey');
  assert.match(chrome.chromeStyles('dark', '#fff'), /background: #fff !important;/);
  // Every box (a frame's, a group's at any depth) is square, paints nothing and has a quiet blue outline with room inside
  // it; hover and selection are the editor's own outlines, as on any element, so the page draws neither.
  const framed = /> body stacki-frame\[data-frame\] \{[^}]*\}/.exec(plain)?.[0] ?? '';
  const grouped = /> body stacki-group \{[^}]*\}/.exec(plain)?.[0] ?? '';
  for (const box of [framed, grouped]) {
    for (const bare of ['background: transparent !important', 'border: 0 !important', 'border-radius: 0 !important', 'box-shadow: none !important']) {
      assert.ok(box.includes(bare), `a box is ${bare}`);
    }
    assert.match(box, /outline: 1px solid rgba\(47, 128, 255, 0\.3\) !important;/, 'a quiet blue outline at rest');
  }
  assert.match(framed, /padding: 32px !important;/);
  assert.match(grouped, /padding: 46px 16px 16px !important;/, 'a group holds its heading and its frames inside its padding');
  assert.doesNotMatch(plain, /content-visibility/, 'paint containment would cut off the caption above a fixed frame');
  assert.doesNotMatch(plain, /data-box-selected|:hover/, 'the editor draws hover and selection');
  assert.match(chrome.chromeScript(ID), /outline-width: ' \+ thin \+ 'px/, 'outlines keep their width on screen at any zoom');
  assert.match(chrome.chromeScript(ID), /padding-inline: ' \+ \(32 \+ extra\)/, 'a caption wider than its component widens the frame evenly');
  const { frameGapPx, subgroupGapPx, groupGapPx, captionGapPx, headingGapPx } = chrome.CHROME_LIMITS;
  assert.ok(captionGapPx < headingGapPx && headingGapPx < frameGapPx && frameGapPx < subgroupGapPx && subgroupGapPx < groupGapPx, 'each level is spaced wider');
  assert.match(plain, /data-flow="column"\] \{ flex-direction: column !important; gap: 32px/, 'groups stack on one left edge');
  // A caption or heading the editor's tag would cover is hidden while it does, never drawn under it.
  assert.match(
    plain,
    /stacki-frame\[data-frame\]\[data-under-tag\]::before, [^{]*stacki-group\[data-group\]\[data-under-tag\]::before \{ visibility: hidden !important; \}/,
  );
  assert.match(chrome.chromeScript(ID), /data\.command === 'tag'/);
  // A lazy image waits for a viewport test a panned, zoomed canvas never answers: every image on the canvas loads now.
  assert.match(
    chrome.chromeScript(ID),
    /img\[loading="lazy"\][^;]*;\s*for \(var i = 0; i < lazy\.length; i\+\+\) lazy\[i\]\.setAttribute\('loading', 'eager'\)/,
  );
  assert.match(chrome.chromeScript(ID), /attributeFilter: \[[^\]]*'loading'/, 'an image patched back to lazy is made eager again');
  // A colour dragged in a picker is painted at once and taken back on a cancel; a value that could end a declaration is never painted.
  assert.match(chrome.chromeScript(ID), /data\.command === 'paint'/);
  assert.match(chrome.chromeScript(ID), /!\/\[;\{\}<>\]\/\.test\(data\.value\)/);
  assert.match(chrome.chromeScript(ID), /data\.restore === true/);
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

test('the panel shows every value a frame is given as set, the code’s own fallback as resting, and stores each write', () => {
  const panel = loadRenderer('src/app/model/canvasPanelValues.ts');
  const settings = {
    frames: {
      '': { props: { heading: 'Everywhere' } },
      'variant=main': { assets: { label: { file: 'src/assets/a.png', url: true } }, content: 'Words' },
    },
  };
  const layout = model.buildCanvasLayout(button, settings);
  const frame = layout.frames.find((candidate) => candidate.key === 'variant=main');
  const defaults = { props: { id: 'from-defaults' }, text: 'A <b>' };
  const input = { schema: button.schema, rest: true, settings, frame, scope: frame.key, defaults };
  const shown = panel.framePanelValues(input);
  assert.deepEqual(shown.props.label, { type: 'expr', value: 'frameAsset0.src' });
  assert.deepEqual(shown.props.variant, { type: 'string', value: 'main' }, 'a split value is the frame’s own');
  // A value the frame is given from a wider scope or the component defaults shows as real text, marked; the label's
  // colour says where it comes from (canvasFrameSettings.tsx), and showing it writes nothing.
  assert.deepEqual(shown.props.heading, { type: 'string', value: 'Everywhere' }, 'a wider value shows as the field’s text');
  assert.deepEqual(shown.props.id, { type: 'string', value: 'from-defaults' }, 'a component default shows as the field’s text');
  assert.equal(shown.schema.find((field) => field.name === 'heading').default, undefined, 'the field keeps only the code’s own fallback');
  assert.equal(shown.props.size, undefined, 'a prop nothing gives stays unset: its code fallback rests in the field');
  assert.equal(shown.schema.filter((field) => field.name === 'class').length, 1, 'a ...rest component takes a class');
  assert.equal(shown.imports, `import frameAsset0 from "${'../'.repeat(2)}src/assets/a.png";`);
  assert.deepEqual(shown.content, { html: 'Words', own: true });
  assert.deepEqual(panel.framePanelValues({ ...input, scope: '' }).content, { html: 'A &lt;b&gt;', own: true }, 'default words shown are set');
  assert.deepEqual(panel.framePanelValues({ ...input, scope: '', defaults: {} }).content, { html: '', own: false }, 'no words: nothing set');
  const stored = (value) => panel.frameEditOf('label', value, shown.bindings);
  assert.deepEqual(stored({ type: 'expr', value: 'frameAsset0.src' }), {
    kind: 'asset',
    name: 'label',
    asset: { file: 'src/assets/a.png', url: true },
  });
  assert.deepEqual(stored({ type: 'expr', value: '[{ i: frameAsset0 }]' }), {
    kind: 'literal',
    name: 'label',
    literal: { source: '[{ i: frameAsset0 }]', imports: { frameAsset0: 'src/assets/a.png' } },
  });
  assert.deepEqual(stored({ type: 'expr', value: '["a"]' }), { kind: 'literal', name: 'label', literal: '["a"]' });
  assert.deepEqual(stored(undefined), { kind: 'inherit', name: 'label' });
  assert.deepEqual(stored({ type: 'string', value: '' }), { kind: 'inherit', name: 'label' }, 'an emptied field stores nothing');
  const emptied = panel.framePanelValues({ ...input, settings: { frames: { ...settings.frames, 'variant=main': { props: { heading: '' } } } } });
  assert.deepEqual(emptied.props.heading, { type: 'string', value: 'Everywhere' }, 'an empty text saved before is no value: the given one shows');
  assert.equal(stored({ type: 'expr', value: 'Astro.props.title' }), undefined, 'code has no preview value');
  assert.deepEqual(panel.framePickEdit('image', { rel: 'public/images/a.png', root: 'public' }, 'module'), {
    kind: 'prop',
    name: 'image',
    value: '/images/a.png',
  });
  assert.equal(panel.framePickEdit('image', { rel: 'src/data/a.json', root: 'src' }, 'module'), undefined);
  assert.equal(
    panel.contentHTML([
      { kind: 'text', value: 'a < {b} ' },
      { kind: 'element', name: 'br', props: {}, children: undefined },
    ]),
    'a &lt; &#123;b&#125; <br>',
  );
});

test('a frame’s own content and files reach its instance, as text the page never runs', () => {
  const layout = model.buildCanvasLayout(button, {
    split: [],
    frames: { '': { content: 'Own {words} </stacki-frame>', assets: { heading: { file: 'src/assets/a.png' } } } },
  });
  const source = pageOf(layout);
  assert.ok(source.includes(`import canvasAsset0 from "${'../'.repeat(2)}src/assets/a.png";`));
  assert.match(source, /heading=\{canvasAsset0\}/);
  assert.match(source, /<Fragment set:html=\{"Own \\u007bwords\\u007d \\u003c\/stacki-frame\\u003e"\} \/><\/Button>/);
  const parsed = parsePage(source);
  assert.equal(parsed.editable, true, parsed.editable ? '' : parsed.reason);
  assert.equal(page.canvasTreeOf(parsed.model.nodes).instances.length, 1);
});

// The Lumos button split by variant, emphasis and direction: eleven frames.
const { CANVAS_LIMITS: LIMITS } = require('#dist/shared/properties/componentCanvas.js');
const SPLIT_UNIONS = [
  {
    names: ['variant', 'emphasis', 'direction'],
    branches: [
      { forbids: ['direction'], pins: { variant: ['main'] }, defaults: {}, rules: {}, docs: {} },
      { forbids: ['direction', 'emphasis'], pins: { variant: ['link'] }, defaults: {}, rules: {}, docs: {} },
      { forbids: ['direction'], pins: { variant: ['play', 'close'] }, defaults: {}, rules: {}, docs: {} },
      { forbids: [], pins: { variant: ['arrow'] }, defaults: {}, rules: {}, docs: {} },
    ],
  },
];
const choice = (name, options) => ({ name, type: 'enum', optional: true, options, default: options[0], unions: SPLIT_UNIONS });
const splitButton = {
  file: BUTTON,
  name: 'Button',
  schema: [
    choice('variant', ['main', 'link', 'play', 'close', 'arrow']),
    choice('emphasis', ['primary', 'secondary']),
    choice('direction', ['forward', 'back']),
  ],
};

test('frames that share a value sit in one box that says it once; a lone value gets no box and a lone inner box no level', () => {
  const groups = loadRenderer('src/features/preview/componentCanvas/canvasGroups.ts');
  const layout = model.buildCanvasLayout(splitButton, { split: ['variant', 'emphasis', 'direction'] });
  assert.equal(layout.frames.length, 11);
  const words = (parts) => parts.map((part) => `${part.prop}: ${String(part.value.value)}`).join(' · ');
  const drawn = (items, depth = 0) => {
    assert.ok(depth <= LIMITS.splitPropsMax, 'bounded by the split');
    return items.map((item) => (item.kind === 'frame' ? words(item.caption) : [words(item.header), drawn(item.children, depth + 1)]));
  };
  const both = ['emphasis: primary', 'emphasis: secondary'];
  const arrows = ['direction: forward', 'direction: back'];
  assert.deepEqual(drawn(groups.groupFrames(layout.frames)), [
    ['variant: main', both],
    'variant: link',
    ['variant: play', both],
    ['variant: close', both],
    [
      'variant: arrow',
      [
        ['emphasis: primary', arrows],
        ['emphasis: secondary', arrows],
      ],
    ],
  ]);
  // A box that would hold nothing but one box takes its header into its own.
  const narrow = layout.frames.filter((frame) => frame.key.includes('emphasis=primary&variant=arrow') || frame.key === 'variant=link');
  assert.deepEqual(drawn(groups.groupFrames(narrow)), ['variant: link', ['variant: arrow · emphasis: primary', arrows]]);
  // One split prop makes no boxes.
  const single = groups.groupFrames(model.buildCanvasLayout(splitButton, { split: ['variant'] }).frames);
  assert.ok(single.every((item) => item.kind === 'frame'));
});

test('the page draws its boxes as real elements the editor selects, names each by its caption, and finds every frame’s instance', () => {
  const groups = loadRenderer('src/features/preview/componentCanvas/canvasGroups.ts');
  const layout = model.buildCanvasLayout(splitButton, { split: ['variant', 'emphasis', 'direction'] });
  const items = (list, depth = 0) => {
    assert.ok(depth <= LIMITS.splitPropsMax, 'bounded by the split');
    return list.map((item) =>
      item.kind === 'frame'
        ? { kind: 'frame', key: item.key, caption: 'caption' }
        : { kind: 'group', key: item.key, header: 'A "box" <1>', children: items(item.children, depth + 1) },
    );
  };
  const source = pageOf(layout, { groups: items(groups.groupFrames(layout.frames)) });
  assert.equal(source.split('<stacki-group data-group={').length - 1, 6, 'groups are marked elements, named by their key');
  assert.doesNotMatch(source, /<stacki-(group|frame) data-stacki-unmarked/);
  assert.equal(source.split(' data-depth="1"').length - 1, 2, 'the two emphasis groups inside arrow are a level down');
  assert.equal(source.split(' data-heading').length - 1, 1, 'the lone top-level frame is headed as the groups are');
  assert.ok(source.includes('data-label={"A \\"box\\" \\u003c1\\u003e"}'), 'a label is a string expression with nothing the parser reads');
  const parsed = parsePage(source);
  assert.equal(parsed.editable, true, parsed.editable ? '' : parsed.reason);
  const tree = page.canvasTreeOf(parsed.model.nodes);
  assert.deepEqual(
    tree.instances.map((instance) => instance.key),
    layout.frames.map((frame) => frame.key),
    'instances are found in frame order, however deep their boxes',
  );
  assert.equal(tree.boxes.filter((box) => box.kind === 'group').length, 6);
  assert.equal(tree.boxes.filter((box) => box.kind === 'frame').length, layout.frames.length);
  assert.ok(
    tree.boxes.every((box) => box.label === (box.kind === 'group' ? 'A "box" <1>' : 'caption')),
    'each box reads back its label exactly',
  );
  for (const frame of tree.boxes.filter((box) => box.kind === 'frame')) {
    assert.ok(
      tree.instances.some((instance) => instance.path.startsWith(frame.path + '.') && instance.key === frame.key),
      'a frame box holds its instance',
    );
  }
  // Every box is marked with the path the editor selects it by; the page's <body> stays the canvas's own.
  const marked = serializePageMarked(parsed.model, '', undefined, source);
  assert.equal(marked.split(/<stacki-group[^>]*data-avb-p/).length - 1, 6, 'groups carry a path');
  assert.equal(marked.split(/<stacki-frame[^>]*data-avb-p/).length - 1, layout.frames.length, 'frames carry a path');
  assert.doesNotMatch(marked, /<body[^>]*data-avb-p/);
  // With the canvas open, a box at exactly its path is that box; anything else is no box.
  session.noteComponentCanvas({ kind: 'open', id: ID, instances: tree.instances, boxes: tree.boxes, root: tree.root });
  const group = tree.boxes.find((box) => box.kind === 'group');
  assert.equal(session.canvasBoxOf(group.path)?.key, group.key);
  assert.equal(session.canvasBoxOf(tree.instances[0].path), undefined, 'an instance is not a box');
  assert.equal(session.canvasBoxOf(tree.root), undefined, 'nor is the root');
  session.noteComponentCanvas({ kind: 'idle' });
});
