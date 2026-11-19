// Goal: ONE state machine for every closed component that renders text (docs/canvas-closed-component-text.md),
// proved for every text-bearing element of the real Lumos example page, not for the components someone happened to try.
// Method: the fixtures are real (`test/fixtures/lumos-card/`): the project's 35 component sources, its example-components
// page, and the markup the running preview rendered for that page (captured from the app on a copy of the project).
// The real planners build the editing catalog from the real sources (page text from `canvasTextPlans`, prop text from
// `canvasPropEdits`); a JSDOM page of the captured markup gets a synthetic layout (boxes nest as the elements do); the real
// frame code (`installTextMarks`) is driven by pointer events over the first line of every text-bearing element; and the
// overlays the app would draw (`PreviewOverlays`) are rendered for each state the frame's messages produce. The table that
// results, one row per component, is printed and every row is asserted: an element that gets neither a text hover, a refused
// hover nor the component's own root hover fails the test, as does any state whose classes differ from the machine's.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { buildSync } = require('esbuild');
const loadRenderer = require('../../helpers/rendererModule');
const { ROOT, repoPath } = require('../../helpers/sources.js');
const { LIMITS } = require('#dist/shared/core/limits.js');

const FIXTURES = repoPath('test/fixtures/lumos-card');
const PROJECT = '/site';
const PAGE_FILE = '/site/src/pages/index.astro';

// --- The real project --------------------------------------------------------------------------------------------
function sourcesIn(directory, base = directory, depth = 0) {
  assert.ok(depth <= LIMITS.treeDepthMax, 'the fixture tree is shallow');
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return sourcesIn(full, base, depth + 1);
    }
    return entry.name.endsWith('.astro') ? [[path.relative(base, full).split(path.sep).join('/'), fs.readFileSync(full, 'utf8')]] : [];
  });
}
const COMPONENT_SOURCES = new Map(sourcesIn(path.join(FIXTURES, 'components')).map(([relative, text]) => [`${PROJECT}/src/components/${relative}`, text]));
const COMPONENTS = [...COMPONENT_SOURCES].map(([file, text]) => ({
  name: path.basename(file, '.astro'),
  path: file,
  // The string props the component declares, as the scanner would list them.
  schema: [...text.matchAll(/^\s+(\w+)\?:\s*string;/gm)].map((match) => ({ name: match[1], type: 'string' })),
}));
const PAGE = fs.readFileSync(path.join(FIXTURES, 'example-components.astro'), 'utf8');

// --- DOM globals for the frame code -----------------------------------------------------------------------------------
const dom = new JSDOM(`<!doctype html>${fs.readFileSync(path.join(FIXTURES, 'example-components-preview.html'), 'utf8')}`);
const { window } = dom;
for (const name of ['document', 'window', 'HTMLElement', 'Node', 'Element', 'Text', 'Comment', 'NodeFilter']) {
  global[name] = name === 'document' ? window.document : name === 'window' ? window : window[name];
}
global.location = window.location;
global.CSSStyleSheet = class {
  replaceSync() {}
};
window.document.adoptedStyleSheets = [];
global.requestAnimationFrame = (run) => {
  run(0);
  return 0;
};

// A synthetic layout: every element's box holds its own words' row first and then its children's boxes, so boxes nest as the
// elements do and a point on the first row of an element is inside it and no child.
const ROW_PX = 20;
const boxes = new WeakMap();
let cursor = 0;
function layout(element, depth) {
  assert.ok(depth <= LIMITS.treeDepthMax, 'the page tree is shallow');
  const top = cursor;
  const hasText = [...element.childNodes].some((node) => node.nodeType === 3 && node.data.trim() !== '');
  if (hasText) {
    cursor += ROW_PX;
  }
  for (const child of element.children) {
    layout(child, depth + 1);
  }
  if (cursor === top) {
    cursor += 1;
  }
  boxes.set(element, { left: depth * 6, top, width: 2000 - depth * 12, height: cursor - top });
}
layout(document.body, 0);
window.Element.prototype.getBoundingClientRect = function box() {
  const found = boxes.get(this) ?? { left: 0, top: 0, width: 0, height: 0 };
  return { ...found, right: found.left + found.width, bottom: found.top + found.height, x: found.left, y: found.top };
};
const ELEMENTS = [...document.body.querySelectorAll('*')];
document.elementFromPoint = (x, y) => {
  let found;
  for (const element of ELEMENTS) {
    const box = boxes.get(element);
    if (box && x >= box.left && x <= box.left + box.width && y >= box.top && y < box.top + box.height) {
      found = element;
    }
  }
  return found;
};

// --- The catalog the editor would publish ---------------------------------------------------------------------------
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { canvasPropEdits } = loadRenderer('src/app/model/canvasPropText.ts');
const { canvasTextPlans } = loadRenderer('src/features/preview/canvasTextSource.ts');
const { createTreeIndex } = loadRenderer('src/editor/editorTree.ts');
const { installTextMarks, pathsOf } = loadRenderer('test/helpers/frameTextEntry.js');
const { ownerState } = loadRenderer('src/features/preview/textOwnerState.ts');

function parsed(text) {
  const result = parsePage(text, { locs: true });
  assert.equal(result.editable, true);
  return result.model;
}

let catalog;
async function buildCatalog() {
  const page = parsed(PAGE);
  const tree = createTreeIndex(page.nodes);
  const plans = canvasTextPlans(PAGE, page.nodes, (id) => tree.path(id));
  const edits = await canvasPropEdits(
    { pathFor: (id) => tree.path(id) },
    {
      projectPath: PROJECT,
      file: PAGE_FILE,
      nodes: page.nodes,
      imports: page.imports,
      components: COMPONENTS,
      label: 'Component text',
      relative: (file) => file.slice(PROJECT.length + 1),
      read: async (file) => (COMPONENT_SOURCES.has(file) ? parsed(COMPONENT_SOURCES.get(file)) : undefined),
      setProp: () => {},
    },
  );
  const targets = [...plans.map((plan) => plan.target), ...edits.filter((edit) => edit.bound?.kind !== 'blocked').map((edit) => edit.target)];
  return { type: 'avb:text-catalog', session: 's', file: 'f', checksum: 'c', targets: targets.slice(0, 2000) };
}

// --- The frame ---------------------------------------------------------------------------------------------------------
let focus = new Set();
const posted = [];
function startFrame() {
  installTextMarks({
    catalog: () => catalog,
    editing: () => undefined,
    editingElement: () => undefined,
    focus: () => focus,
    visible: () => true,
    post: (message) => posted.push(message),
  });
}
const move = (x, y) => window.dispatchEvent(new window.MouseEvent('pointermove', { clientX: x, clientY: y }));
const click = (x, y) => window.dispatchEvent(new window.MouseEvent('click', { clientX: x, clientY: y }));
const last = () => posted.at(-1);
function settle() {
  // Pointer far away on nothing: any hover ends, so the next move always reports.
  move(5000, 5000);
}

// --- The overlays the app draws -----------------------------------------------------------------------------------------
const output = repoPath('node_modules/.stacki-test/closed-component-table.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({
  stdin: { contents: `export { PreviewOverlays } from './src/features/preview/PreviewOverlays';`, resolveDir: ROOT, loader: 'ts' },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { PreviewOverlays } = require(output);

const INFO = { label: 'Owner', kind: 'component', tag: undefined, astroAsset: false, dynamicTag: false, nodeKind: 'component', isLayout: false, bound: false };
const OWNER_BOX = { x: 100, y: 100, w: 400, h: 200 };
const LAYOUT_BOX = { x: 0, y: 0, w: 900, h: 900 };
function outlines({ scope, selected, hoverPath, marks }) {
  const markup = renderToStaticMarkup(
    React.createElement(PreviewOverlays, {
      rects: { [scope]: [OWNER_BOX], layout: [LAYOUT_BOX] },
      spacing: {},
      scale: 1,
      selPath: selected,
      selOcc: 0,
      hoverPath,
      hoverOcc: 0,
      focusPath: undefined,
      focusWhole: false,
      textMarks: marks,
      overlayInfo: () => INFO,
    }),
  );
  // The owner's outline is the one at its box; the layout's is the one at the layout's.
  const found = [...markup.matchAll(/<div class="(node-outline [^"]*)" style="left:(\d+)px;top:(\d+)px/g)].map((match) => ({
    classes: match[1].split(' '),
    left: Number(match[2]),
  }));
  return {
    owner: found.find((outline) => outline.left === OWNER_BOX.x && !outline.classes.includes('text-mark'))?.classes,
    layout: found.find((outline) => outline.left === 0)?.classes,
  };
}

// --- The table ----------------------------------------------------------------------------------------------------------
const TABLE = new Map();
const failures = [];
const scopes = new Map();
function row(component) {
  if (!TABLE.has(component)) {
    TABLE.set(component, { elements: 0, text: 0, refused: 0, root: 0, none: [] });
  }
  return TABLE.get(component);
}

test('every text-bearing element of the real page follows the state machine', async () => {
  catalog = await buildCatalog();
  startFrame();
  assert.ok(catalog.targets.length > 100, `${catalog.targets.length} targets`);
  const elements = ELEMENTS.filter((element) => {
    const own = [...element.childNodes].some((node) => node.nodeType === 3 && node.data.trim() !== '');
    return own && pathsOf(element).some((token) => token.includes('|')) && !['SCRIPT', 'STYLE'].includes(element.tagName);
  });
  assert.ok(elements.length > 150, `${elements.length} text-bearing elements`);
  for (const element of elements) {
    const tokens = pathsOf(element);
    const files = tokens.filter((token) => token.includes('|'));
    const rootFile = files.find((token) => /^\d+$/.test(token.slice(token.lastIndexOf('|') + 1))) ?? files[0];
    const component = path.basename(rootFile.slice(0, rootFile.lastIndexOf('|')), '.astro');
    const summary = row(component);
    summary.elements += 1;
    const box = boxes.get(element);
    const at = { x: box.left + 30, y: box.top + 5 };
    const instanceRoot = tokens.some((token) => !token.includes('|'));
    focus = new Set();
    settle();
    move(at.x, at.y);
    const hover = last().hover;
    if (hover === undefined) {
      if (instanceRoot) {
        summary.root += 1; // The component is its words: the component's own hover is the hover.
      } else {
        summary.none.push(element.textContent.trim().slice(0, 24));
        failures.push(`${component}: no hover over "${element.textContent.trim().slice(0, 30)}"`);
      }
      continue;
    }
    if (hover.kind === 'refused') {
      summary.refused += 1;
      continue;
    }
    summary.text += 1;
    const scope = hover.scope;
    (scopes.get(scope) ?? scopes.set(scope, []).get(scope)).push({ at, label: `${component} "${element.textContent.trim().slice(0, 20)}"` });
    if (scope === undefined) {
      failures.push(`${component}: hover names no owner for "${element.textContent.trim().slice(0, 30)}"`);
      continue;
    }
    // State field: nothing selected, then the layout, then the owner itself selected.
    for (const selected of [undefined, 'layout', scope]) {
      const drawn = outlines({ scope, selected, hoverPath: scope, marks: { hover, picked: undefined } });
      const label = `${component} "${element.textContent.trim().slice(0, 20)}" hovered, selected ${selected}`;
      if (!(drawn.owner?.includes('text-owner') && !drawn.owner.includes('owner-tag'))) {
        failures.push(`${label}: owner is ${drawn.owner}`);
      }
      if (selected === 'layout' && drawn.layout && (drawn.layout.includes('tinted') || drawn.layout.includes('text-owner'))) {
        failures.push(`${label}: the layout changed (${drawn.layout})`);
      }
    }
    // One click picks the hovered words at once, whatever is selected.
    focus = new Set();
    settle();
    move(at.x, at.y);
    click(at.x, at.y);
    const picked = last().picked;
    if (picked === undefined) {
      failures.push(`${component} "${element.textContent.trim().slice(0, 20)}": one click did not pick the words`);
      continue;
    }
    // Words picked, instance selected: resting, then the pointer on the instance's body, then on the words again.
    focus = new Set([scope]);
    settle();
    click(at.x, at.y);
    settle();
    const resting = last();
    const restingOutlines = outlines({ scope, selected: scope, hoverPath: undefined, marks: { hover: undefined, picked: resting.picked ?? picked } });
    if (!(restingOutlines.owner?.includes('text-owner') && restingOutlines.owner.includes('owner-tag'))) {
      failures.push(`${component} "${element.textContent.trim().slice(0, 20)}": resting owner is ${restingOutlines.owner}`);
    }
    const bodyOutlines = outlines({ scope, selected: scope, hoverPath: scope, marks: { hover: undefined, picked: resting.picked ?? picked } });
    if (!(bodyOutlines.owner?.includes('tinted') && !bodyOutlines.owner.includes('text-owner'))) {
      failures.push(`${component} "${element.textContent.trim().slice(0, 20)}": body-hover owner is ${bodyOutlines.owner}`);
    }
    assert.equal(ownerState({ hover: undefined, picked }, { path: scope, slot: 'sel', pointedAt: false }), 'resting');
  }
  // Selected text A with the pointer on text B of the same owner, on A itself, and on the owner's body.
  let pairs = 0;
  for (const [scope, texts] of scopes) {
    if (texts.length < 2) {
      continue;
    }
    pairs += 1;
    const [first, second] = texts;
    focus = new Set([scope]);
    settle();
    click(first.at.x, first.at.y);
    settle();
    move(second.at.x, second.at.y);
    const other = last();
    const otherOutlines = outlines({ scope, selected: scope, hoverPath: scope, marks: { hover: other.hover, picked: other.picked } });
    if (!(other.hover && other.picked && otherOutlines.owner?.includes('text-owner') && otherOutlines.owner.includes('owner-tag'))) {
      failures.push(`${first.label} selected, ${second.label} hovered: owner is ${otherOutlines.owner}`);
    }
    settle();
    move(first.at.x, first.at.y);
    const same = last();
    const sameOutlines = outlines({ scope, selected: scope, hoverPath: scope, marks: { hover: same.hover, picked: same.picked } });
    if (!sameOutlines.owner?.includes('owner-tag')) {
      failures.push(`${first.label} selected and hovered: owner is ${sameOutlines.owner}`);
    }
  }
  assert.ok(pairs >= 3, `${pairs} owners with two texts`);
  const printable = [...TABLE].map(
    ([component, value]) =>
      `${component.padEnd(14)} elements ${String(value.elements).padStart(3)}  text ${String(value.text).padStart(3)}  refused ${String(value.refused).padStart(3)}  root ${String(value.root).padStart(3)}  none ${value.none.length}`,
  );
  console.log(`# component text table\n# ${printable.join('\n# ')}`);
  assert.deepEqual(failures.slice(0, 20), [], `${failures.length} deviations`);
});

test('the stylesheet gives each state its look: the tag goes in the field, stays light when resting', () => {
  const css = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');
  const rule = (selector) => css.slice(css.indexOf(`\n${selector} {`), css.indexOf('\n}', css.indexOf(`\n${selector} {`)));
  assert.match(rule('.node-outline.text-owner'), /outline-width:\s*4px;/);
  assert.match(rule('.node-outline.text-owner'), /outline-color:\s*color-mix\(in srgb, var\(--green\)/);
  assert.match(rule('.node-outline.text-owner .node-outline-tag'), /display:\s*none;/);
  assert.match(rule('.node-outline.text-owner.owner-tag .node-outline-tag'), /display:\s*inline-flex;/);
  assert.match(rule('.node-outline.sel.parent.tinted:not(.text-owner)'), /outline-color:\s*var\(--green\);/);
  // Rule 3 keeps rule 2's tag: both are the selected parent's light filled tag, and body-hover has no tag rule of its own.
  assert.match(rule('.node-outline.text-owner.owner-tag .node-outline-tag'), /background:\s*#7ddc94;/);
  assert.match(rule('.node-outline.sel.parent .node-outline-tag'), /background:\s*#7ddc94;/);
  assert.equal(css.includes('.node-outline.sel.parent.tinted:not(.text-owner) .node-outline-tag'), false, 'no unfilled tag variant for body-hover');
});

test('no tag of the text and owner states is translucent', () => {
  const css = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');
  const rules = [...css.matchAll(/(^|\n)([^{}\n]*\.node-outline-tag[^{}\n]*)\s*\{([^}]*)\}/g)].filter((match) =>
    /text-mark|text-owner|owner-tag|\.sel\.parent/.test(match[2]),
  );
  assert.ok(rules.length >= 4, `${rules.length} tag rules for the text states`);
  for (const [, , selector, body] of rules) {
    const background = /background:\s*([^;]+);/.exec(body)?.[1];
    if (background !== undefined) {
      assert.doesNotMatch(background, /rgba?\(|transparent|hsla|color-mix/, `${selector}: ${background}`);
    }
    assert.doesNotMatch(body, /opacity\s*:/, `${selector}: no opacity`);
  }
  assert.match(css, /\.node-outline\.hover\.text-mark \.node-outline-tag \{[^}]*background: var\(--green\);/, 'the hovered text tag is the solid green chip');
});
