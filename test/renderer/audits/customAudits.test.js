// Goal: a project's custom audits work end to end in the renderer. An audit run turns each enabled audit into findings of check
// `custom` that name their audit: declarations in stylesheets and `<style>` blocks carry their place (so a row opens the code at
// the line), markup matches name the element they are inside, a pattern the guard refuses is reported instead of run, and a
// disabled audit runs nothing; the view lists each audit as its own rule under its category, a project category included. The
// editor adds an audit from the Audits panel's ⋯ menu: the form fills, the live count shows how many places match (skeleton
// rows while it computes, then the count and samples), an unsafe pattern takes the error fill, and Save writes
// `.stacki/audits.json` with the audit and says so in a toast.
// Method: bundle the real modules with esbuild, parse fixture .astro sources with the editor's parser, run `runAudit` over fake
// IO, and mount the real AuditsPanel in jsdom with a fake main that records each metadata write.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { waitFor } = require('../../helpers/waitFor.js');

const output = repoPath('node_modules/.stacki-test/custom-audits.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { runAudit } from './src/features/audits/auditRunner';",
      "export { auditView } from './src/features/audits/auditView';",
      "export { updateAuditState, resetAuditState, auditState } from './src/features/audits/auditStore';",
      "export { default as AuditsPanel } from './src/features/audits/AuditsPanel';",
      "export { ConfirmHost } from './src/ui/ConfirmDialog';",
      "export { parsePageResult } from './shared/page/pageNode';",
      "export { findingsByRule } from './shared/page/auditFindings';",
      "export { EMPTY_AUDIT_IGNORES, parseAuditIgnoresSource } from './shared/properties/auditIgnores';",
      "export { formOf, auditOf, propertyNamesOf, propertyPatternOf } from './src/features/audits/customAuditForm';",
      "export { customAuditPreset } from './shared/properties/customAudits';",
    ].join('\n'),
    resolveDir: repoPath('package.json').replace(/package\.json$/, ''),
    loader: 'tsx',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
require('../../helpers/popupDom').installPopupDOM(dom.window);
global.window = dom.window;
for (const name of [
  'document',
  'navigator',
  'HTMLElement',
  'HTMLInputElement',
  'Element',
  'Node',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'getComputedStyle',
  'localStorage',
]) {
  Object.defineProperty(global, name, { value: dom.window[name], configurable: true, writable: true });
}
global.IS_REACT_ACT_ENVIRONMENT = true;
dom.window.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
dom.window.cancelAnimationFrame = (handle) => clearTimeout(handle);
global.requestAnimationFrame = dom.window.requestAnimationFrame;
global.cancelAnimationFrame = dom.window.cancelAnimationFrame;
global.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
window.avb = { listApps: async () => ({ ok: true, value: [] }) };

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const audits = require(output);
const { parsePage } = require('#dist/electron/parse/astroParser.js');

const readOf = (source) => {
  const parsed = audits.parsePageResult(parsePage(source, { locs: true }));
  assert.ok(parsed.editable, 'the fixture parses');
  return { editable: true, nodes: parsed.model.nodes, imports: parsed.model.imports, source };
};

const PROJECT = '/site';
const PAGE =
  '---\n---\n<html lang="en"><head><title>Home</title></head><body>\n<h1>TODO hero</h1>\n<style is:global>\n.hero { text-align: center; }\n.card { text-align: var(--align); }\n</style>\n</body></html>';
const SHEET = '.a { text-align: left; }\n/* text-align: right */\n.b { color: var(--swatch-red); }\n';
const scan = {
  pages: [{ path: '/site/src/pages/index.astro', name: 'index.astro', route: '/', title: 'Home' }],
  pageFolders: [],
  layouts: [],
  components: [],
  astroConfig: undefined,
};
const io = {
  readFile: async () => readOf(PAGE),
  readText: async () => undefined,
  listAssets: async () => ({ ok: true, value: [] }),
  imageSize: async () => undefined,
  renderPage: undefined,
  tree: async () => ({ tag: 'html' }),
  variables: async () => new Map(),
  styleFiles: async () => [{ rel: 'src/styles/site.css', path: '/site/src/styles/site.css' }],
  readStyle: async () => SHEET,
};

const TEXT_ALIGN = {
  id: 'hard-coded-text-align',
  name: 'Hard-coded text-align',
  icon: 'text',
  category: 'tokens',
  severity: 'low',
  match: { scope: 'declaration', property: '^text-align$', valueMustMatch: undefined, valueMustNotMatch: 'var\\(' },
  exclude: undefined,
  message: 'Use a variable',
  enabled: true,
};
const TODO = {
  id: 'todo',
  name: 'TODO left in markup',
  icon: 'placeholder',
  category: 'Launch',
  severity: 'medium',
  match: { scope: 'markup', pattern: '\\bTODO\\b' },
  exclude: undefined,
  message: undefined,
  enabled: true,
};
const UNSAFE = { ...TODO, id: 'unsafe', name: 'Unsafe', match: { scope: 'css', pattern: '(a+)+$' } };
const OFF = { ...TEXT_ALIGN, id: 'off', name: 'Off', enabled: false };

test('an audit run finds custom audit matches with their places, reports a refused pattern, and skips a disabled audit', async () => {
  const settings = { ...audits.EMPTY_AUDIT_IGNORES, customAudits: [TEXT_ALIGN, TODO, UNSAFE, OFF] };
  const report = await audits.runAudit({ settings, scope: 'site', projectPath: PROJECT, scan, open: undefined }, io);
  const custom = report.findings.filter((finding) => finding.check === 'custom');
  const align = custom.filter((finding) => finding.custom.id === 'hard-coded-text-align');
  assert.deepEqual(align.map((finding) => [finding.file, finding.css.property, finding.css.value, finding.css.line, finding.css.place.tag]).sort(), [
    ['src/pages/index.astro', 'text-align', 'center', 6, 'style-block'],
    ['src/styles/site.css', 'text-align', 'left', 1, 'stylesheet'],
  ]);
  assert.ok(
    align.every((finding) => finding.priority === 'low'),
    'the severity is the finding’s priority',
  );
  assert.ok(
    align.every((finding) => finding.id.startsWith('custom:hard-coded-text-align|')),
    'ignores key on the audit',
  );
  const [todo] = custom.filter((finding) => finding.custom.id === 'todo');
  assert.equal(todo.element.tag, 'h1', 'a markup match names the element it is inside');
  assert.equal(todo.element.line, 4);
  assert.equal(custom.filter((finding) => finding.custom.id === 'off').length, 0, 'a disabled audit runs nothing');
  assert.deepEqual(
    report.custom.problems.map((problem) => [problem.id, problem.problem.code]),
    [['unsafe', 'nested-repeat']],
  );
  const rules = audits.findingsByRule(custom);
  assert.deepEqual(
    rules.map((rule) => rule.key),
    ['custom:hard-coded-text-align', 'custom:todo'],
  );
  const view = audits.auditView({
    findings: report.findings,
    ignored: new Set(),
    filter: 'category:Launch',
    search: '',
    showIgnored: false,
    customCategories: ['Launch'],
  });
  assert.deepEqual(view.customCategories, [{ filter: 'category:Launch', name: 'Launch', count: 1 }]);
  assert.deepEqual(
    view.shown.map((finding) => finding.custom?.id),
    ['todo'],
  );
});

test('the form round-trips: a simple rule opens simple, an expression the simple mode cannot write opens advanced', () => {
  const simple = audits.formOf(TEXT_ALIGN);
  assert.equal(simple.mode, 'simple');
  assert.equal(simple.properties, 'text-align');
  assert.equal(simple.valueLacks, 'var(');
  const saved = audits.auditOf(simple, { id: TEXT_ALIGN.id, enabled: true, taken: [] });
  assert.ok(saved.ok);
  assert.deepEqual(saved.value, TEXT_ALIGN, 'opened and saved unchanged, it is the same audit');
  assert.equal(audits.formOf(audits.customAuditPreset('core-swatch-instead-of-theme').audit).mode, 'advanced');
  assert.equal(audits.propertyPatternOf('color, border*'), '^(color|border[a-z-]*)$');
  assert.equal(audits.propertyNamesOf('^(color|border[a-z-]*)$'), 'color, border*');
  assert.equal(audits.propertyNamesOf('^(color|.*)$'), undefined);
});

// One turn of the event loop, inside act: the promises a bridge call resolves and the render they cause.
const settle = () => act(async () => new Promise((resolve) => setImmediate(resolve)));
const typeInto = async (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
};
const labelled = (text) => {
  const label = [...document.querySelectorAll('.custom-audit-dialog label')].find((candidate) => candidate.textContent.startsWith(text));
  assert.ok(label, `the editor has a ${text} field`);
  return label.querySelector('input');
};

test('the editor: added from the ⋯ menu, a live count with samples, an unsafe pattern flagged, Save writes the audit', async () => {
  const writes = [];
  window.avb.projectMetadata = async () => ({ ok: true, value: {} });
  window.avb.writeProjectMetadata = async (input) => {
    writes.push(input.write.source);
    return { ok: true, value: { source: input.write.source } };
  };
  const shown = [];
  audits.resetAuditState(PROJECT);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let filesRead = 0;
  const props = {
    project: { path: PROJECT, name: 'acme' },
    fixDeps: () => ({}),
    onReveal: () => {},
    onHover: () => {},
    onCreatePage: () => {},
    routes: ['/'],
    showToast: (message, kind) => shown.push([message, kind]),
    measure: () => ({ projectPath: PROJECT, devUrl: undefined, current: undefined, pages: [] }),
    sources: () => ({ current: undefined, all: [] }),
    onConfigure: () => {},
    customAuditFiles: async () => {
      filesRead += 1;
      return {
        files: [
          { file: 'src/styles/site.css', source: SHEET },
          { file: 'src/pages/index.astro', source: PAGE },
        ],
        partial: false,
      };
    },
  };
  await act(async () =>
    root.render(React.createElement(React.Fragment, undefined, React.createElement(audits.AuditsPanel, props), React.createElement(audits.ConfirmHost))),
  );
  await act(async () => container.querySelector('.panel-header .more-menu-button, .more-menu-button').click());
  const add = [...document.querySelectorAll('[role="menuitem"]')].find((row) => row.textContent === 'Add custom audit…');
  assert.ok(add, 'the ⋯ menu offers Add custom audit');
  await act(async () => add.click());
  await settle();
  assert.ok(document.querySelector('.custom-audit-dialog'), 'the editor opens');
  assert.ok(document.querySelector('.custom-audit-live'), 'the live area is there at once');
  await typeInto(labelled('Name'), 'Hard-coded text-align');
  await typeInto(labelled('Properties'), 'text-align');
  await typeInto(labelled('Value does not contain'), 'var(');
  assert.ok(document.querySelector('.custom-audit-live .ui-skeleton'), 'skeleton rows while the count computes, never a word');
  // The count is computed after the last keystroke has rested: wait on what it shows.
  await waitFor({
    what: 'the live count',
    read: async () => {
      await act(async () => undefined);
      return document.querySelector('.custom-audit-live')?.textContent ?? '';
    },
    until: (text) => /2 matches in this project/.test(text),
  });
  const live = document.querySelector('.custom-audit-live');
  assert.match(live.textContent, /2 matches in this project/);
  assert.equal(live.querySelectorAll('.custom-audit-sample').length, 2);
  assert.match(live.textContent, /site\.css:1/);
  assert.match(live.textContent, /index\.astro:6/);
  assert.equal(filesRead, 1, 'the files are read once, not on every keystroke');
  // The advanced mode carries the rule over; an unsafe expression takes the error fill and the count waits.
  const advanced = [...document.querySelectorAll('.custom-audit-dialog [role="tab"], .custom-audit-dialog button')].find(
    (button) => button.textContent === 'Regular expression',
  );
  assert.ok(advanced);
  await act(async () => advanced.click());
  const property = labelled('Property matches');
  assert.equal(property.value, '^text-align$');
  await typeInto(property, '(t+)+');
  assert.equal(property.getAttribute('aria-invalid'), 'true');
  assert.match(property.closest('label').title, /repeat inside a repeated group/);
  await typeInto(property, '^text-align$');
  assert.equal(property.getAttribute('aria-invalid') ?? undefined, undefined);
  const save = [...document.querySelectorAll('.custom-audit-dialog .modal-footer button')].find((button) => button.textContent === 'Save');
  assert.ok(save.classList.contains('primary'), 'Save is the blue primary button');
  await act(async () => save.click());
  await settle();
  await settle();
  assert.equal(writes.length, 1, 'one save, one write');
  const written = audits.parseAuditIgnoresSource(writes[0]).customAudits;
  assert.deepEqual(
    written.map((audit) => [audit.id, audit.name, audit.match.property, audit.match.valueMustNotMatch, audit.enabled]),
    [['hard-coded-text-align', 'Hard-coded text-align', '^text-align$', 'var\\(', true]],
  );
  assert.deepEqual(shown, [['Custom audit saved', 'success']]);
  assert.equal(document.querySelector('.custom-audit-dialog') ?? undefined, undefined, 'the editor closes after saving');
  assert.equal(audits.auditState().ignores.value.customAudits.length, 1, 'the panel holds the saved list');
  await act(async () => root.unmount());
});
