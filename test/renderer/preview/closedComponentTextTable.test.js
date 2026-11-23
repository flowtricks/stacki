// Goal: ONE state machine for every closed component that renders text (docs/canvas-closed-component-text.md),
// proved for every text-bearing element of the real Lumos example page, not for the components someone happened to try.
// Method: the fixtures are real (`test/fixtures/lumos-card/`): the project's 35 component sources, its example-components
// page, and the markup the running preview rendered for that page (captured from the app on a copy of the project).
// The real planners build the editing catalog from the real sources (page text from `canvasTextPlans`, prop text from
// `canvasPropEdits`); a JSDOM page of the captured markup gets a synthetic layout (boxes nest as the elements do); the real
// frame code (`installTextMarks`) is driven by pointer events over the first line of every text-bearing element; and the
// overlays the app would draw (`PreviewOverlays`) are rendered for each state the frame's messages produce. The table that
// results, one row per component, is printed and every row is asserted. Words a prop or the slot of the instance reaches get a
// click pick (no outline of their own on hover) and a double click that edits them; words the component writes itself (hardcoded or computed, no prop reaches
// them) get no text hover, no text outline and no editor, only the component's own hover (closedComponentReach.ts). An
// element that breaks either side fails the test, as does any state whose classes differ from the machine's.
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
// A range's box is its container's: the words of an element lie on its first row.
window.Range.prototype.getBoundingClientRect = function box() {
  const owner = this.startContainer.nodeType === 1 ? this.startContainer : this.startContainer.parentElement;
  const found = boxes.get(owner) ?? { left: 0, top: 0, width: 0, height: 0 };
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
const { installTextMarks, pathsOf, findTextHit } = loadRenderer('test/helpers/frameTextEntry.js');
const { ownerState } = loadRenderer('src/features/preview/textOwnerState.ts');
const { isEditableThroughProps, textReach } = require('#dist/shared/properties/closedComponentReach.js');

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
      overlayInfo: (target) => (target === 'layout' ? { ...INFO, label: 'BaseLayout', isLayout: true } : INFO),
    }),
  );
  // The owner's outline is the one at its box; the layout's is the one at the layout's.
  // Read by attribute, not by position: an outline carries other attributes too.
  const found = [...markup.matchAll(/<div [^>]*?class="(node-outline [^"]*)" style="left:(\d+)px;top:(\d+)px/g)].map((match) => ({
    classes: match[1].split(' '),
    left: Number(match[2]),
  }));
  return {
    all: found,
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
    TABLE.set(component, { elements: 0, text: 0, refused: 0, root: 0, internal: 0 });
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
    // A component's own words draw no hover of their own (the pointer on them is the instance's hover); the words the instance
    // reaches are the ones a click picks, so that is what classifies the element here.
    if (last().hover !== undefined && last().hover.kind !== 'refused') {
      failures.push(`${component} "${element.textContent.trim().slice(0, 20)}": words drew a hover of their own`);
    }
    click(at.x, at.y);
    const hover = last().picked;
    // What a double click here would type in: the hover and the editor follow one rule (closedComponentReach.ts), so they agree.
    const hit = findTextHit(catalog, { target: document.elementFromPoint(at.x, at.y), clientX: at.x, clientY: at.y });
    const hitHere = hit !== undefined && (hit.match.element === element || element.contains(hit.match.element) || hit.match.element.contains(element));
    if (hover === undefined) {
      if (instanceRoot) {
        summary.root += 1; // The component is its words: the component's own hover is the hover.
        continue;
      }
      // Words the component writes itself: no prop or slot of this instance reaches them, so no text outline, no label and no
      // editor; the pointer on them is the component's own hover. The overlays drawn for that state hold no text mark.
      summary.internal += 1;
      if (hitHere) {
        failures.push(`${component} "${element.textContent.trim().slice(0, 20)}": not hovered, yet a double click edits ${hit.target.key}`);
      }
      const drawn = outlines({ scope: 'owner', selected: undefined, hoverPath: 'owner', marks: { hover: undefined, picked: undefined } });
      if (drawn.all.some((outline) => outline.classes.includes('text-mark'))) {
        failures.push(`${component} "${element.textContent.trim().slice(0, 20)}": a text outline is drawn for words no prop reaches`);
      }
      continue;
    }
    if (hover.kind === 'refused') {
      // Only prop text the catalog names as blocked is refused; this catalog names none, so words no prop reaches never are.
      summary.refused += 1;
      failures.push(`${component} "${element.textContent.trim().slice(0, 20)}": refused, though no prop reaches it`);
      continue;
    }
    if (!hit?.target.scope || !isEditableThroughProps(textReach({ loaded: true, covering: hit.target }))) {
      failures.push(`${component} "${element.textContent.trim().slice(0, 20)}": hovered, but no prop or slot of the instance reaches it`);
    }
    summary.text += 1;
    const scope = hover.scope;
    (scopes.get(scope) ?? scopes.set(scope, []).get(scope)).push({ at, label: `${component} "${element.textContent.trim().slice(0, 20)}"` });
    if (scope === undefined) {
      failures.push(`${component}: hover names no owner for "${element.textContent.trim().slice(0, 30)}"`);
      continue;
    }
    // With nothing picked, the owner is drawn as any hovered component: no text-owner state, whatever is selected.
    for (const selected of [undefined, 'layout']) {
      const drawn = outlines({ scope, selected, hoverPath: scope, marks: { hover: undefined, picked: undefined } });
      if (drawn.owner?.includes('text-owner')) {
        failures.push(`${component} "${element.textContent.trim().slice(0, 20)}" hovered, selected ${selected}: owner is ${drawn.owner}`);
      }
      if (selected === 'layout' && drawn.layout && (drawn.layout.includes('tinted') || drawn.layout.includes('text-owner'))) {
        failures.push(`the layout changed (${drawn.layout})`);
      }
    }
    // A double click edits exactly the words under the pointer: the target it resolves from the point is the hovered one.
    if (!(hit && hit.target.scope === scope && hitHere)) {
      failures.push(
        `${component} "${element.textContent.trim().slice(0, 20)}": a double click resolves ${hit ? `${hit.target.key}` : 'nothing'}, not the hovered words`,
      );
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
    assert.equal(ownerState({ hover: undefined, picked }, { ownable: true, path: scope, slot: 'sel', pointedAt: false }), 'resting');
  }
  // A sweep of the pointer over every part of the page (every element's first row and its middle): whatever the frame reports, the
  // layout never takes any state of ours, and no more than the hovered and the picked text's owners do.
  let swept = 0;
  for (const element of ELEMENTS) {
    const box = boxes.get(element);
    for (const at of [
      { x: box.left + 3, y: box.top + 2 },
      { x: box.left + box.width / 2, y: box.top + box.height / 2 },
    ]) {
      for (const picked of [false, true]) {
        focus = new Set();
        settle();
        move(at.x, at.y);
        if (picked) {
          click(at.x, at.y);
        }
        const message = last();
        const scope = message.picked?.scope;
        const marks = { hover: undefined, picked: picked ? message.picked : undefined };
        const drawn = outlines({ scope: scope ?? 'owner', selected: 'layout', hoverPath: 'layout', marks });
        swept += 1;
        if (drawn.layout?.some((name) => ['tinted', 'text-owner', 'owner-tag', 'parent'].includes(name))) {
          failures.push(`the layout took a state at ${at.x},${at.y}: ${drawn.layout}`);
        }
      }
    }
  }
  assert.ok(swept > 1000, `${swept} pointer positions swept`);
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
    // The pointer on other words of the picked owner is the pointer on the owner itself: its plain green hover (body-hover).
    if (!(other.hover === undefined && other.picked && otherOutlines.owner?.includes('tinted') && !otherOutlines.owner.includes('text-owner'))) {
      failures.push(`${first.label} selected, ${second.label} hovered: owner is ${otherOutlines.owner}`);
    }
    settle();
    move(first.at.x, first.at.y);
    const same = last();
    const sameOutlines = outlines({ scope, selected: scope, hoverPath: scope, marks: { hover: same.hover, picked: same.picked } });
    if (!sameOutlines.owner?.includes('tinted')) {
      failures.push(`${first.label} selected and hovered: owner is ${sameOutlines.owner}`);
    }
  }
  assert.ok(pairs >= 3, `${pairs} owners with two texts`);
  const printable = [...TABLE].map(
    ([component, value]) =>
      `${component.padEnd(14)} elements ${String(value.elements).padStart(3)}  text ${String(value.text).padStart(3)}  refused ${String(value.refused).padStart(3)}  root ${String(value.root).padStart(3)}  internal ${String(value.internal).padStart(3)}`,
  );
  // Both sides of the rule are exercised by the real page: words a prop or slot reaches, and words a component writes itself.
  const totals = [...TABLE.values()].reduce((sum, value) => ({ text: sum.text + value.text, internal: sum.internal + value.internal }), {
    text: 0,
    internal: 0,
  });
  assert.ok(totals.text > 50, `${totals.text} words reached by a prop or slot`);
  assert.ok(totals.internal > 10, `${totals.internal} words a component writes itself`);
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
  assert.ok(rules.length >= 3, `${rules.length} tag rules for the text states`);
  for (const [, , selector, body] of rules) {
    const background = /background:\s*([^;]+);/.exec(body)?.[1];
    if (background !== undefined) {
      assert.doesNotMatch(background, /rgba?\(|transparent|hsla|color-mix/, `${selector}: ${background}`);
    }
    assert.doesNotMatch(body, /opacity\s*:/, `${selector}: no opacity`);
  }
  // Hover tags are unfilled (the existing rule for every hover, text included); selected tags are the solid green chip.
  assert.doesNotMatch(css, /\.node-outline\.hover\.text-mark \.node-outline-tag/, 'no tag rule of its own for hovered text');
  const rule = (selector) => css.slice(css.indexOf(`\n${selector} {`), css.indexOf('\n}', css.indexOf(`\n${selector} {`)));
  assert.match(rule('.node-outline.hover .node-outline-tag'), /background:\s*transparent;/);
  assert.match(rule('.node-outline.component .node-outline-tag'), /background:\s*var\(--green\);/);
});

test('no grey, muted or alpha tag or text outline exists in any state, editable or refused text alike', () => {
  const css = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');
  // Text that cannot be edited is hovered exactly like text that can: its reason comes when the person tries to edit it.
  assert.doesNotMatch(css, /text-mark\.refused|\.refused\s+\.node-outline-tag/, 'no refused look for hovered text');
  const allowed = ['var(--green)', 'var(--accent)', '#7ddc94', 'transparent'];
  const tagRules = [...css.matchAll(/(^|\n)([^{}\n]*\.node-outline[^{}\n]*\.node-outline-tag[^{}\n]*)\s*\{([^}]*)\}/g)].filter((match) =>
    /text-mark|text-owner|owner-tag|\.sel\.parent/.test(match[2]),
  );
  for (const [, , selector, body] of tagRules) {
    const background = /background:\s*([^;]+);/.exec(body)?.[1]?.trim();
    if (background !== undefined) {
      assert.ok(allowed.includes(background), `${selector} uses ${background}`);
    }
  }
  // The hovered text's outline is the component green; the owner's faint outline is a green too.
  assert.match(css, /\.node-outline\.component \{\s*outline-color: var\(--green\);/);
  assert.match(css, /\.node-outline\.text-owner \{[^}]*outline-color: color-mix\(in srgb, var\(--green\)/);
  assert.doesNotMatch(css.slice(css.indexOf('.node-outline.text-owner {'), css.indexOf('.node-outline.text-owner {') + 900), /grey|gray|#6b6b6b|128 128 128/);
});

test('editing the words of a closed component keeps the light tag of the owner and faint thick outline for the whole session', () => {
  const css = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');
  const rule = (selector) => css.slice(css.indexOf(`\n${selector} {`), css.indexOf('\n}', css.indexOf(`\n${selector} {`)));
  const tag = rule('body:has(#stacki-canvas-text-editor) .node-outline.sel.text-owner.owner-tag .node-outline-tag');
  assert.match(tag, /display:\s*inline-flex;/);
  assert.match(tag, /background:\s*#7ddc94;/, 'the light tag, never the bright selected one or an unfilled one');
  assert.match(rule('body:has(#stacki-canvas-text-editor:not([data-shared])) .node-outline.sel.parent.text-owner'), /outline-width:\s*4px;/);
  // The editor hides the tag of a selected outline (an ordinary element's own tag); the owner rule must come after that rule to win.
  assert.ok(
    css.indexOf('.node-outline.sel.text-owner.owner-tag .node-outline-tag') >
      css.indexOf('body:has(#stacki-canvas-text-editor) .node-outline.sel .node-outline-tag {'),
  );
});
