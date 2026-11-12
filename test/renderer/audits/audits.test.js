// Goal: the Audits panel's renderer side does what the panel promises. The
// scope picks the right files (the current page pulls in the components it
// imports); a run gathers facts, plans fixes only the source can plan (ids made
// unique per component instance, a heading component made the h1) and reports a
// component's finding once with the pages it shows on; fixes go through edit
// gestures as one undo step that Undo and Redo revert; the agent hand-off tries
// registered handlers in priority order and falls back to the clipboard, and the
// terminal handler starts the configured agent with the prompt as one quoted
// argument; the view filters, searches, counts and groups by rule; the panel
// shows a slim "N fixes ready · Apply" row only when N > 0, a calm clean state,
// and one flat list of one-line rules, High first, that open to clickable
// occurrences; go-to selects as the Navigator does, waits for a newly opened
// file to render, then flashes; a page-level finding goes to what its fix
// would change; the rail shows the Audits button, with no
// count on it, for roles that have the panel, and ⌥A opens it.
// Method: bundle the real modules with esbuild, parse real .astro sources with
// the editor's parser for fixtures, drive the runner and the fixes with fake
// IO and a fake main that records every request, and mount the panel and the
// rail in jsdom.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/audits.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { auditPlan, importedTargets, parseAuditScope } from './src/features/audits/auditScope';",
      "export { auditCache, runAudit, frontmatterOf, headingComponents } from './src/features/audits/auditRunner';",
      "export { applyFixes, fixGesture, frontmatterGesture, newElement, absolutePath } from './src/features/audits/auditFixes';",
      "export { auditView } from './src/features/audits/auditView';",
      "export { updateAuditState, resetAuditState, auditState, storedScope } from './src/features/audits/auditStore';",
      "export { default as AuditsPanel } from './src/features/audits/AuditsPanel';",
      "export { registerAgentTaskHandler, requestAgentTask, agentTaskMessage, agentTaskHandlerNames } from './src/lib/agentTasks';",
      "export { terminalAgentHandler, agentLaunchCommand, posixQuote, onTerminalTabRequest } from './src/features/terminal/terminalAgent';",
      "export { default as LeftRail } from './src/app/LeftRail';",
      "export { setActualRole } from './src/lib/currentRole';",
      "export { parseProjectRoles, roleViewOf, ADMIN_VIEW, can } from './shared/properties/projectRoles';",
      "export { canPanel } from './src/lib/roleAccess';",
      "export { parsePageResult } from './shared/page/pageNode';",
      "export { EMPTY_AUDIT_IGNORES } from './shared/properties/auditIgnores';",
      "export { findInTree, findPattern, replacementFinding, findInData, replacedInData } from './src/features/audits/findText';",
      "export { storedFilter, breakdown } from './src/features/audits/AuditsPanel';",
      "export { reviewRows, reviewMatches } from './src/features/audits/StyleReview';",
      "export { revealNode, nextReveal, REVEAL_FLASH_MS, REVEAL_SETTLE_MS } from './src/app/shell/auditReveal';",
      "export { selectFromPanel } from './src/app/shell/panelSelection';",
      "export { occurrenceName, occurrenceNote, fixTarget, sameElementRuns, GROUP_OPEN_MAX } from './src/features/audits/AuditsPanel';",
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
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent', 'MouseEvent', 'getComputedStyle', 'localStorage']) {
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

const parse = (source) => {
  const parsed = audits.parsePageResult(parsePage(source, { locs: true }));
  assert.ok(parsed.editable, 'the fixture parses');
  return parsed;
};
const readOf = (source) => {
  const parsed = parse(source);
  return { editable: true, nodes: parsed.model.nodes, imports: parsed.model.imports, source };
};

// A small project: a page that uses a card twice (its svg id collides) and a heading component.
const PROJECT = '/site';
const FILES = {
  '/site/src/pages/index.astro': `---\nimport Card from '../components/Card.astro';\nimport Heading from '../components/Heading.astro';\n---\n<html lang="en"><head><title>Home</title></head><body><Heading Tag="h2">Hi</Heading><Card /><Card /><img src="/hero.png" alt="Hero"></body></html>`,
  '/site/src/pages/about.astro': `<html lang="en"><head><title>About</title></head><body><h1>About</h1><a href="/missing">Gone</a></body></html>`,
  '/site/src/components/Card.astro': `---\n---\n<svg viewBox="0 0 1 1"><clipPath id="clip0_901_5"><rect width="1" height="1" /></clipPath><g clip-path="url(#clip0_901_5)"></g></svg>`,
  '/site/src/components/Heading.astro': `---\nconst { Tag = 'h2' } = Astro.props;\n---\n<Tag><slot /></Tag>`,
};
const scan = {
  pages: [
    { path: '/site/src/pages/index.astro', name: 'index.astro', route: '/', title: 'Home' },
    { path: '/site/src/pages/about.astro', name: 'about.astro', route: '/about', title: 'About' },
  ],
  pageFolders: [],
  layouts: [],
  components: [
    { path: '/site/src/components/Card.astro', file: 'src/components/Card.astro', name: 'Card', folder: '' },
    {
      path: '/site/src/components/Heading.astro',
      file: 'src/components/Heading.astro',
      name: 'Heading',
      folder: '',
      schema: [{ name: 'Tag', type: 'string', optional: true }],
    },
  ],
  astroConfig: 'astro.config.mjs',
};
// What the dev server renders for each route: the card's markers name its own file.
const CARD = '<!--avb-s:src/components/Card.astro|0--><svg><!--avb-s:src/components/Card.astro|0.0--><clipPath id="clip0_901_5"></clipPath></svg>';
const RENDERED = {
  '/': `<html lang="en"><head><title>Home</title><meta name="description" content="${'Home page description long enough. '.repeat(2)}"><link rel="canonical" href="/"></head><body><h2>Hi</h2>${CARD}${CARD}</body></html>`,
  '/about': `<html lang="en"><head><title>About</title><meta name="description" content="${'About page description long enough. '.repeat(2)}"><link rel="canonical" href="/about"></head><body><h1>About</h1>${CARD}${CARD}</body></html>`,
};
const io = (over = {}) => ({
  readFile: async (file) => readOf(FILES[file]),
  readText: async (rel) => (rel === 'astro.config.mjs' ? 'export default {}' : rel === 'src/consts.ts' ? "export const SITE_TITLE = 'Acme';" : undefined),
  listAssets: async () => ({
    ok: true,
    value: [{ rel: 'public/hero.png', name: 'hero.png', parent: 'public', root: 'public', isDir: false, size: 10, abs: '/site/public/hero.png' }],
  }),
  imageSize: async () => ({ width: 800, height: 600 }),
  renderPage: async (route) => (RENDERED[route] === undefined ? { ok: true, status: 404, html: '' } : { ok: true, status: 200, html: RENDERED[route] }),
  tree: async (html, file) => {
    const { parsedTree } = require(rendered);
    return parsedTree(html, file);
  },
  variables: async () => new Map([['--color-ink', '#121212']]),
  styleFiles: async () => [],
  readStyle: async () => undefined,
  ...over,
});
const rendered = repoPath('node_modules/.stacki-test/audits-rendered.cjs');
esbuild.buildSync({
  entryPoints: [repoPath('src/features/audits/renderedDom.ts')],
  outfile: rendered,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'silent',
});
global.DOMParser = dom.window.DOMParser;

test('the scope names the files: the current page pulls in what it imports', async () => {
  assert.equal(audits.parseAuditScope('site'), 'site');
  assert.equal(audits.parseAuditScope('bogus'), 'site');
  // The whole site is the default for every project; a project keeps the scope its panel chose.
  localStorage.removeItem('stacki.audits.scope:/site');
  assert.equal(audits.storedScope('/site'), 'site');
  audits.resetAuditState('/site');
  assert.equal(audits.auditState().scope, 'site');
  audits.updateAuditState((current) => ({ ...current, scope: 'page' }));
  assert.equal(localStorage.getItem('stacki.audits.scope:/site'), 'page');
  assert.equal(audits.storedScope('/other'), 'site', 'another project keeps its own default');
  audits.resetAuditState('/site');
  assert.equal(audits.auditState().scope, 'page');
  localStorage.removeItem('stacki.audits.scope:/site');
  audits.resetAuditState('/site');
  const open = { path: '/site/src/pages/index.astro', kind: 'page' };
  assert.deepEqual(
    audits.auditPlan({ scope: 'page', projectPath: PROJECT, scan, open }).targets.map((target) => target.file),
    ['src/pages/index.astro'],
  );
  assert.deepEqual(audits.auditPlan({ scope: 'page', projectPath: PROJECT, scan, open: undefined }).targets, []);
  assert.equal(audits.auditPlan({ scope: 'pages', projectPath: PROJECT, scan, open }).targets.length, 2);
  assert.deepEqual(audits.auditPlan({ scope: 'components', projectPath: PROJECT, scan, open }).routes, [], 'components render no routes');
  const site = audits.auditPlan({ scope: 'site', projectPath: PROJECT, scan, open });
  assert.equal(site.targets.length, 4);
  assert.equal(site.site, true);
  assert.deepEqual(
    audits.importedTargets(parse(FILES['/site/src/pages/index.astro']).model.imports, PROJECT, scan).map((target) => target.file),
    ['src/components/Card.astro', 'src/components/Heading.astro'],
  );
  const report = await audits.runAudit(
    { settings: audits.EMPTY_AUDIT_IGNORES, scope: 'page', projectPath: PROJECT, scan, open: { ...open, read: undefined } },
    io(),
  );
  assert.equal(report.files, 3, 'the page and the two components it imports');
});

test('a component’s duplicate id is one finding with the pages it shows on, and a per-instance fix', async () => {
  // A second run with the cache reads no file again, and both report the same; progress counts up.
  const progress = [];
  const cache = audits.auditCache();
  const reads = [];
  const counted = () => {
    const base = io();
    return { ...base, readFile: (path) => (reads.push(path), base.readFile(path)) };
  };
  const input = {
    settings: audits.EMPTY_AUDIT_IGNORES,
    scope: 'site',
    projectPath: PROJECT,
    scan,
    open: undefined,
    cache,
    onProgress: (step) => progress.push(step),
  };
  const report = await audits.runAudit(input, counted());
  const firstReads = reads.length;
  assert.ok(firstReads > 0);
  assert.ok(progress.some((step) => step.stage === 'files' && step.done === step.total));
  assert.ok(progress.some((step) => step.stage === 'pages'));
  const again = await audits.runAudit(input, counted());
  assert.equal(reads.length, firstReads, 'unchanged files are not read again');
  assert.deepEqual(
    again.findings.map((finding) => finding.id),
    report.findings.map((finding) => finding.id),
  );
  const duplicates = report.findings.filter((finding) => finding.check === 'duplicate-id');
  assert.equal(duplicates.length, 1, 'once, against the component');
  const [duplicate] = duplicates;
  assert.equal(duplicate.file, 'src/components/Card.astro');
  assert.deepEqual(duplicate.routes, ['/', '/about']);
  assert.equal(duplicate.fix?.label, 'Make ids unique per instance');
  const edits = duplicate.fix.edits;
  assert.equal(edits[0].tag, 'frontmatter-append');
  assert.match(edits[0].code, /stackiInstanceCount \?\? 0\) \+ 1/, 'a counter, not a random number');
  assert.doesNotMatch(edits[0].code, /random/);
  assert.deepEqual(edits[1].patch, { id: { type: 'expr', value: '`clip0_901_5-${instanceKey}`' } });
  assert.deepEqual(edits[2].patch, { 'clip-path': { type: 'expr', value: '`url(#clip0_901_5-${instanceKey})`' } });
  const missingTopHeading = report.findings.find((finding) => finding.check === 'h1-count' && finding.file === 'src/pages/index.astro');
  assert.equal(missingTopHeading?.fix?.label, 'Make this heading an h1');
  assert.equal(missingTopHeading?.fix?.after, '<Heading Tag="h1">');
  assert.ok(report.findings.some((finding) => finding.check === 'sitemap'));
  assert.ok(report.findings.some((finding) => finding.check === 'link-broken' && finding.file === 'src/pages/about.astro'));
  assert.equal(typeof report.checkedAt, 'number');
  const offline = await audits.runAudit(
    { settings: audits.EMPTY_AUDIT_IGNORES, scope: 'pages', projectPath: PROJECT, scan, open: undefined },
    io({ renderPage: undefined }),
  );
  assert.deepEqual(offline.rendered, { tag: 'offline' });
  assert.ok(!offline.findings.some((finding) => finding.source === 'rendered'));
});

// A fake main: records every request, answers with a fresh checksum and an inverse that names it.
function fakeMain() {
  const requests = [];
  let version = 0;
  const reply = (request) => {
    version += 1;
    requests.push(request);
    const source = FILES['/site/src/pages/about.astro'];
    const parsed = parse(source);
    return { ok: true, value: { ...parsed, source, checksum: `c${version}`.padEnd(64, '0'), inverse: [{ span: { start: 0, end: 1 }, text: `v${version}` }] } };
  };
  return {
    requests,
    send: async (request) => reply(request),
    sendBatch: async (request) => reply(request),
  };
}

test('fixes in other files are one undo step whose Undo and Redo revert', async () => {
  const report = await audits.runAudit({ settings: audits.EMPTY_AUDIT_IGNORES, scope: 'site', projectPath: PROJECT, scan, open: undefined }, io());
  const main = fakeMain();
  const commands = [];
  const deps = {
    projectPath: PROJECT,
    open: undefined,
    readPage: async (file) => {
      const parsed = parse(FILES[file]);
      return { ...parsed, source: FILES[file], checksum: 'a'.repeat(64) };
    },
    send: main.send,
    sendBatch: main.sendBatch,
    pushCommand: (command) => commands.push(command),
  };
  const fixable = report.findings.filter((finding) => finding.fix !== undefined && finding.check !== 'duplicate-id');
  assert.ok(fixable.length >= 2, 'more than one safe fix in more than one file');
  const outcome = await audits.applyFixes(fixable, deps, 'Fix audit findings');
  assert.deepEqual(outcome.failures, []);
  assert.equal(outcome.fixed, fixable.length);
  assert.equal(commands.length, 1, 'one undo step for the whole batch');
  assert.ok(main.requests.length >= 2, 'each file written through edit requests');
  assert.ok(main.requests.every((request) => request.pagePath.startsWith('/site/')));
  const written = main.requests.length;
  await commands[0].undo();
  assert.ok(
    main.requests.slice(written).every((request) => request.edit.tag === 'revert'),
    'undo submits reverts',
  );
  const undone = main.requests.length;
  await commands[0].redo();
  assert.ok(main.requests.length > undone, 'redo reverts the reverts');
  assert.ok(main.requests.slice(undone).every((request) => request.edit.tag === 'revert'));
});

test('a fix on the open page goes on its own queue, carrying the other files as its step’s work', async () => {
  const source = '<html><head><title>T</title></head><body><img src="/hero.png" alt="Hero"></body></html>';
  const model = parse(source).model;
  const committed = [];
  const main = fakeMain();
  const finding = {
    id: 'x',
    check: 'html-lang',
    file: 'src/pages/index.astro',
    fileKind: 'page',
    element: { path: [0], tag: 'html', line: 1 },
    detail: '',
    source: 'static',
    fix: {
      label: 'Add lang',
      before: '',
      after: '',
      file: 'src/pages/index.astro',
      edits: [{ tag: 'attributes', path: [0], expect: 'html', patch: { lang: { type: 'string', value: 'en' } } }],
    },
  };
  const outcome = await audits.applyFixes(
    [finding],
    {
      projectPath: PROJECT,
      open: { path: '/site/src/pages/index.astro', model, commit: (gesture, files) => committed.push({ gesture, files }) || true },
      readPage: async () => assert.fail('the open page is never re-read'),
      send: main.send,
      sendBatch: main.sendBatch,
      pushCommand: () => assert.fail('the open page’s step is its own'),
    },
    'Add lang',
  );
  assert.equal(outcome.fixed, 1);
  assert.equal(committed.length, 1);
  assert.equal(committed[0].files, undefined);
  const after = committed[0].gesture.apply(model);
  assert.deepEqual(after.nodes[0].props.lang, { type: 'string', value: 'en' }, 'the gesture’s effect is the fix');
  const moved = audits.fixGesture(model, [{ tag: 'attributes', path: [0], expect: 'body', patch: {} }], { coalesceKey: 'k' });
  assert.equal(moved.ok, false, 'a node that is no longer the element is refused');
  const fm = audits.frontmatterGesture('const a = 1;', 'k');
  const once = fm.apply({ ...model, extraFrontmatter: '' });
  assert.equal(once.extraFrontmatter, 'const a = 1;\n');
  assert.equal(fm.apply(once), once, 'a statement already there is not added twice');
  assert.equal(audits.newElement({ name: 'meta', props: {}, content: undefined }).children, undefined, 'a void element has no children');
  assert.equal(audits.newElement({ name: 'title', props: {}, content: { kind: 'text', value: 'A & B' } }).children[0].value, 'A &amp; B');
  assert.equal(audits.absolutePath('/site', 'src/a.astro'), '/site/src/a.astro');
});

test('hand-offs try handlers by priority and fall back to the clipboard', async () => {
  const task = { title: 'Fix', prompt: "It's broken", context: { files: ['src/a.astro'], nodeRefs: [], findingIds: ['x'] } };
  const seen = [];
  const offLow = audits.registerAgentTaskHandler('low', 1, async () => (seen.push('low'), { tag: 'sent', where: 'low' }));
  const offHigh = audits.registerAgentTaskHandler('high', 5, async () => (seen.push('high'), { tag: 'declined' }));
  assert.deepEqual(audits.agentTaskHandlerNames(), ['high', 'low']);
  assert.deepEqual(await audits.requestAgentTask(task), { tag: 'sent', where: 'low' });
  assert.deepEqual(seen, ['high', 'low'], 'a declining handler passes to the next');
  offLow();
  offHigh();
  let copied;
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text) => void (copied = text) } });
  assert.deepEqual(await audits.requestAgentTask(task), { tag: 'copied' });
  assert.equal(copied, "It's broken");
  assert.match(audits.agentTaskMessage({ tag: 'copied' }).message, /copied/i);
  await assert.rejects(() => audits.requestAgentTask({ ...task, prompt: ' ' }), /prompt/);
});

test('the terminal handler starts the configured agent with the prompt as one quoted word', async () => {
  assert.equal(audits.posixQuote("it's"), "'it'\\''s'");
  assert.equal(audits.agentLaunchCommand('claude', 'Fix\nthis', 'darwin'), "claude 'Fix\nthis'");
  assert.equal(audits.agentLaunchCommand('codex', 'x', 'linux'), "codex 'x'");
  assert.equal(audits.agentLaunchCommand('none', 'x', 'darwin'), undefined);
  assert.equal(audits.agentLaunchCommand('custom', 'x', 'darwin'), undefined);
  assert.equal(audits.agentLaunchCommand('claude', 'x', 'win32'), undefined, 'Windows shells quote differently: the clipboard takes it');
  const tabs = [];
  const off = audits.onTerminalTabRequest((command) => tabs.push(command));
  let opened = 0;
  const handler = audits.terminalAgentHandler({ platform: 'darwin', available: () => true, openDock: () => (opened += 1), mode: () => 'claude' });
  const task = { title: 'Fix', prompt: 'Do it', context: { files: [], nodeRefs: [], findingIds: [] } };
  assert.deepEqual(await handler(task), { tag: 'sent', where: 'Claude Code in the terminal' });
  assert.deepEqual(tabs, ["claude 'Do it'"]);
  assert.equal(opened, 1);
  const noAccess = audits.terminalAgentHandler({ platform: 'darwin', available: () => false, openDock: () => assert.fail('no dock'), mode: () => 'claude' });
  assert.deepEqual(await noAccess(task), { tag: 'declined' });
  // A draft is for a message box to hold; the terminal runs the agent at once, so it declines and opens nothing.
  assert.deepEqual(await handler({ ...task, delivery: 'draft' }), { tag: 'declined' });
  assert.equal(opened, 1, 'a declined draft opens no dock');
  assert.deepEqual(tabs, ["claude 'Do it'"]);
  off();
});

const finding = (over) => ({
  id: over.id,
  file: 'src/pages/index.astro',
  fileKind: 'page',
  element: { path: [0], tag: 'img', line: 3 },
  detail: 'd',
  source: 'static',
  fix: undefined,
  ...over,
});

test('findings about one element are one run, so seven raw values in one style tag are one row, not seven', () => {
  const style = { path: [2], tag: 'style', line: 9 };
  const button = { path: [0, 1], tag: 'button', line: 4 };
  const findings = [
    finding({ id: 's1', element: style }),
    finding({ id: 's2', element: style }),
    finding({ id: 'b1', element: button }),
    finding({ id: 's3', element: style }),
    finding({ id: 'w1', element: undefined }),
    finding({ id: 'w2', element: undefined }),
  ];
  const runs = audits.sameElementRuns(findings).map((run) => run.map((entry) => entry.id));
  assert.deepEqual(
    runs,
    [['s1', 's2'], ['b1'], ['s3'], ['w1'], ['w2']],
    'only neighbours on one element join; a finding with no element of its own stands alone; order is kept',
  );
  assert.deepEqual(audits.sameElementRuns([]), [], 'nothing groups to nothing');
  assert.equal(audits.sameElementRuns(findings).flat().length, findings.length, 'no finding is lost or repeated');
});

test('the view filters by category, searches, hides ignored findings and groups by rule', () => {
  const findings = [
    finding({ id: 'a', check: 'img-alt' }),
    finding({ id: 'b', check: 'img-alt', file: 'src/pages/about.astro' }),
    finding({ id: 'c', check: 'link-text' }),
    finding({ id: 'd', check: 'html-lang', fix: { label: 'Add lang', before: '', after: '', file: 'f', edits: [] } }),
  ];
  const view = audits.auditView({ findings, ignored: new Set(['c']), filter: 'all', search: '', showIgnored: false });
  assert.deepEqual(view.counts, { all: 3, accessibility: 3, seo: 0, content: 0, tokens: 0, performance: 0 });
  assert.deepEqual(view.priorities, { high: 3, medium: 0, low: 0 });
  assert.equal(view.ignoredCount, 1);
  assert.deepEqual(
    view.groups.map((group) => group.priority),
    ['high'],
  );
  assert.deepEqual(
    view.groups[0].rules.map((rule) => [rule.check, rule.findings.length]),
    [
      ['img-alt', 2],
      ['html-lang', 1],
    ],
  );
  assert.equal(view.fixable.length, 1);
  assert.equal(audits.auditView({ findings, ignored: new Set(), filter: 'seo', search: '', showIgnored: false }).shown.length, 1);
  assert.equal(audits.auditView({ findings, ignored: new Set(), filter: 'all', search: 'about', showIgnored: false }).shown.length, 1);
  assert.equal(audits.auditView({ findings, ignored: new Set(['c']), filter: 'all', search: '', showIgnored: true }).shown.length, 4);
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 10)));
const panelProps = {
  project: { path: PROJECT, name: 'acme' },
  fixDeps: () => ({}),
  onReveal: () => {},
  onHover: () => {},
  onCreatePage: () => {},
  routes: ['/', '/about'],
  showToast: () => {},
};

test('the panel: a calm clean state, one flat list of one-line rules, and a fixes-ready row only when there are fixes', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const report = (findings) => ({
    scope: 'page',
    findings,
    files: 1,
    unreadable: 0,
    skipped: 0,
    rendered: { tag: 'done', pages: 1 },
    checkedAt: Date.now(),
    trees: new Map(),
  });
  await act(async () => audits.updateAuditState((state) => ({ ...state, report: report([]) })));
  await act(async () => root.render(React.createElement(audits.AuditsPanel, panelProps)));
  assert.match(container.textContent, /No issues/);
  assert.equal(container.querySelector('.audits-ready') ?? undefined, undefined, 'nothing to fix: no row');
  const reveals = [];
  await act(async () =>
    audits.updateAuditState((state) => ({
      ...state,
      report: report([
        finding({ id: 'd', check: 'link-text' }),
        finding({ id: 'a', check: 'img-alt' }),
        finding({ id: 'b', check: 'img-alt', element: { path: [1], tag: 'img', line: 9 } }),
      ]),
    })),
  );
  await act(async () => root.render(React.createElement(audits.AuditsPanel, { ...panelProps, onReveal: (file, trail) => reveals.push([file, trail]) })));
  assert.equal(container.querySelector('.audits-pill').textContent, '3');
  // The scope switch sits in the toolbar: Site by default; This page says so in the count.
  const scopeTabs = [...container.querySelectorAll('[aria-label="Audit scope"] [role="tab"]')];
  assert.deepEqual(
    scopeTabs.map((tab) => tab.textContent),
    ['Site', 'This page'],
  );
  assert.equal(scopeTabs[0].getAttribute('aria-selected'), 'true');
  await act(async () => scopeTabs[1].click());
  assert.equal(audits.auditState().scope, 'page');
  assert.equal(container.querySelector('.audits-pill').textContent, '3 on this page');
  await act(async () => audits.updateAuditState((current) => ({ ...current, scope: 'site' })));
  assert.equal(container.querySelector('.audits-ready') ?? undefined, undefined, 'no safe fix, no fixes row');
  const rows = [...container.querySelectorAll('.audits-rule > .audits-row')];
  assert.deepEqual(
    rows.map((row) => [row.querySelector('.audits-title').textContent, row.querySelector('.audits-count').textContent]),
    [
      ['Missing alt text', '2'],
      ['Vague link text', '1'],
    ],
    'flat, High first, one line each: title and count, no file',
  );
  assert.ok(rows[0].querySelector('.audits-icon.audits-high'), 'severity is the icon’s tint');
  await act(async () => rows[0].click());
  assert.equal(container.querySelector('.audits-why') ?? undefined, undefined, 'an open rule lists its findings, with no paragraph of explanation');
  const group = container.querySelector('.audits-file-group > .audits-row');
  assert.deepEqual(
    [group.querySelector('.audits-title').textContent, group.querySelector('.audits-count').textContent],
    ['index', '2'],
    'every finding is grouped by its file: the page row with the count',
  );
  assert.equal(group.getAttribute('aria-expanded'), 'true', 'a small group starts open');
  assert.ok(group.querySelector('.audits-chevron'));
  await act(async () => group.click());
  assert.equal(container.querySelectorAll('.audits-file-body').length, 0, 'the group row only folds; it goes nowhere');
  assert.deepEqual(reveals, []);
  await act(async () => group.click());
  const occurrences = container.querySelectorAll('.audits-file-body .audits-occurrence-row');
  assert.equal(occurrences.length, 2);
  assert.equal(occurrences[1].querySelector('.audits-title').textContent, 'img', 'the Navigator’s label, not the page’s name');
  assert.equal(occurrences[1].querySelector('.audits-tag') ?? undefined, undefined, 'no tag text on the right');
  assert.equal(occurrences[1].hasAttribute('title'), false, 'no tooltip');
  await act(async () => occurrences[1].click());
  assert.deepEqual(reveals, [['src/pages/index.astro', [1]]], 'the whole row goes to the element');
  await act(async () =>
    audits.updateAuditState((state) => ({
      ...state,
      report: report([
        finding({
          id: 'e',
          check: 'html-lang',
          fix: { label: 'Add lang="en"', before: '<html>', after: '<html lang="en">', file: 'src/pages/index.astro', edits: [] },
        }),
      ]),
    })),
  );
  assert.match(container.querySelector('.audits-ready').textContent, /1 fix readyApply/);
  await act(async () => root.unmount());
  audits.resetAuditState('/site');
});

test('occurrence names, notes, and what a page-level finding goes to', () => {
  assert.equal(audits.occurrenceName({ file: 'src/components/media/Icon.astro' }), 'Icon');
  assert.equal(audits.occurrenceNote({ detail: '"Button Text" (written by the component here)' }, undefined), 'Button Text');
  assert.equal(audits.occurrenceNote({ detail: '<a href="/missing"> goes nowhere' }, undefined), '/missing');
  assert.equal(audits.occurrenceNote({ detail: '<img> with no alt' }, undefined), undefined);
  assert.equal(audits.occurrenceNote({ detail: '"x"' }, 'Third party'), 'Ignored: Third party');
  assert.equal(audits.GROUP_OPEN_MAX, 5);
  const promote = {
    file: 'src/pages/a.astro',
    fix: { label: '', before: '', after: '', file: 'src/pages/a.astro', edits: [{ tag: 'attributes', path: [0, 4], expect: 'Heading', patch: {} }] },
  };
  assert.deepEqual(audits.fixTarget(promote), [0, 4]);
  assert.equal(audits.fixTarget({ file: 'src/pages/a.astro', fix: undefined }), undefined);
  assert.equal(audits.fixTarget({ ...promote, file: 'src/pages/b.astro' }), undefined, 'a fix in another file is not this page’s element');
});

test('the rail shows Audits, without a count, to roles with the panel, and ⌥A opens it', async () => {
  const roles = audits.parseProjectRoles({ version: 1, roles: [{ id: 'admin', name: 'Admin', members: ['owner'] }] });
  assert.equal(audits.canPanel(audits.roleViewOf(roles, 'client'), 'audits'), false, 'clients do not see it by default');
  assert.equal(audits.canPanel(audits.ADMIN_VIEW, 'audits'), true);
  audits.setActualRole(audits.ADMIN_VIEW);
  const selected = [];
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(audits.LeftRail, { active: undefined, projectPath: PROJECT, onSelect: (tab) => selected.push(tab) })));
  await settle();
  const button = container.querySelector('button[aria-label="Audits (⌥A)"]');
  assert.ok(button, 'the Audits button is on the rail');
  await act(async () =>
    audits.updateAuditState((state) => ({
      ...state,
      report: {
        scope: 'page',
        findings: [finding({ id: 'a', check: 'img-alt' })],
        files: 1,
        unreadable: 0,
        skipped: 0,
        rendered: { tag: 'offline' },
        checkedAt: 0,
        trees: new Map(),
      },
    })),
  );
  assert.equal(button.querySelector('.audits-rail-count') ?? undefined, undefined, 'no count on the rail button: it lives in the panel header');
  await act(async () => window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { code: 'KeyA', key: 'å', altKey: true })));
  assert.deepEqual(selected, ['audits']);
  await act(async () => root.unmount());
});

// A fake shell that records the selection calls, in order.
function recorder() {
  const calls = [];
  let tick = 0;
  return {
    calls,
    setNavigatorSelectionTick: (update) => {
      tick = update(tick);
      calls.push(['tick', tick]);
    },
    setPseudoPick: (pick) => calls.push(['pseudo', pick]),
    setSelectedId: (id) => calls.push(['select', id]),
    setHoverNodeId: (id) => calls.push(['hover', id]),
  };
}

test('go-to selects exactly as a Navigator click does, then scrolls again once the page settles, and flashes', () => {
  const navigator = recorder();
  audits.selectFromPanel(navigator, 'n7');
  const goTo = recorder();
  const scheduled = [];
  audits.revealNode(goTo, 'n7', (run, delayMs) => scheduled.push({ run, delayMs }));
  assert.deepEqual(goTo.calls.slice(0, navigator.calls.length), navigator.calls, 'the same selection calls, in the same order');
  assert.deepEqual(goTo.calls.slice(navigator.calls.length), [['hover', 'n7']], 'then outlined');
  assert.deepEqual(
    scheduled.map((entry) => entry.delayMs),
    [audits.REVEAL_SETTLE_MS, audits.REVEAL_FLASH_MS],
  );
  scheduled.forEach((entry) => entry.run());
  assert.deepEqual(
    goTo.calls.slice(-2),
    [
      ['tick', 2],
      ['hover', undefined],
    ],
    'a second scroll request, then the flash ends',
  );
});

test('a go-to into another file waits for that file to show and for the canvas to render it', () => {
  let pending = { path: '/site/src/pages/b.astro', trail: [3, 1], phase: 'opening' };
  const step = (seen) => {
    const next = audits.nextReveal(pending, seen);
    pending = next.pending;
    return next.select;
  };
  assert.equal(step({ shownPath: '/site/src/pages/a.astro', editable: true, rendered: true }), false, 'the old page is still shown');
  assert.equal(step({ shownPath: '/site/src/pages/b.astro', editable: true, rendered: true }), false, 'a report seen as the file opens is the old page’s');
  assert.equal(pending.phase, 'rendering');
  assert.equal(step({ shownPath: '/site/src/pages/b.astro', editable: true, rendered: false }), false, 'the canvas has not rendered it yet');
  assert.equal(step({ shownPath: '/site/src/pages/b.astro', editable: true, rendered: true }), true, 'rendered: select now');
  assert.equal(pending, undefined);
});

test('an element a component wrote without markers is located at the node that rendered it', () => {
  const { parsedTree } = require(rendered);
  const tree = parsedTree(
    '<html><body><!--avb-s:src/components/Icon.astro|1--><span><svg><clipPath id="c"></clipPath></svg></span></body></html>',
    'src/pages/index.astro',
  );
  const span = tree.children[1].children[0];
  const clip = span.children[0].children[0];
  assert.deepEqual(span.source, { file: 'src/components/Icon.astro', path: [1] });
  assert.deepEqual(clip.source, { file: 'src/components/Icon.astro', path: [1], ancestor: true });
  assert.equal(clip.tag, 'clipPath', 'SVG keeps its case for display');
});

// my-site's head: the page sets `description` on its Layout, BaseLayout spreads `{...seo}` into
// BaseHead, and BaseHead writes the meta. The rendered head decides what is present; the trace
// only says where to edit.
const SITE_FILES = {
  '/site/src/pages/index.astro': `---\nimport Layout from '../layouts/BaseLayout.astro';\n---\n<Layout title="Example Components" description="Every layout variant."><h1>Hi</h1></Layout>`,
  '/site/src/layouts/BaseLayout.astro': `---\nimport BaseHead from '../components/BaseHead.astro';\nconst { theme = 'inherit', ...seo } = Astro.props;\n---\n<html lang="en"><head><BaseHead {...seo} /></head><body><slot /></body></html>`,
  '/site/src/components/BaseHead.astro': `---\nimport { SITE_DESCRIPTION } from '@/consts';\nconst { title, description = SITE_DESCRIPTION } = Astro.props;\n---\n<title>{title}</title>\n<meta name="description" content={description} />\n<link rel="canonical" href="/" />`,
};
const SITE_SCAN = {
  pages: [{ path: '/site/src/pages/index.astro', name: 'index.astro', route: '/', title: 'Example Components' }],
  pageFolders: [],
  layouts: [{ path: '/site/src/layouts/BaseLayout.astro', file: 'src/layouts/BaseLayout.astro', name: 'BaseLayout', folder: 'layouts', isLayout: true }],
  components: [{ path: '/site/src/components/BaseHead.astro', file: 'src/components/BaseHead.astro', name: 'BaseHead', folder: '' }],
  astroConfig: 'astro.config.mjs',
};
const SITE_HTML =
  '<html lang="en"><head><!--avb-s:src/layouts/BaseLayout.astro|0.0.0--><!--avb-s:src/components/BaseHead.astro|0--><title>Example Components | Acme</title>' +
  '<!--avb-s:src/components/BaseHead.astro|1--><meta name="description" content="Every layout variant.">' +
  '<!--avb-s:src/components/BaseHead.astro|2--><link rel="canonical" href="/"></head><body><h1>Hi</h1></body></html>';
const siteIO = (over = {}) =>
  io({
    readFile: async (file) => readOf(SITE_FILES[file]),
    readText: async (rel) =>
      rel === 'astro.config.mjs'
        ? "import sitemap from '@astrojs/sitemap';"
        : rel === 'src/pages/robots.txt.ts'
          ? 'export const GET = () => new Response("")'
          : undefined,
    renderPage: async (route) => (route === '/' ? { ok: true, status: 200, html: SITE_HTML } : { ok: true, status: 404, html: '' }),
    tree: async (html, file, route, options) => {
      const { parsedTree } = require(rendered);
      // A layout frame that never loaded: an empty document.
      return options.styled ? parsedTree('<html><head></head><body></body></html>', file) : parsedTree(html, file);
    },
    ...over,
  });

test('the rendered head is the truth: a layout’s props through BaseHead are present, not missing', async () => {
  for (const scope of ['page', 'site']) {
    const report = await runSite(scope);
    const checks = report.findings.map((finding) => finding.check);
    for (const check of ['title-missing', 'description-missing', 'canonical']) {
      assert.ok(!checks.includes(check), `${scope}: no ${check} while the rendered head has it`);
    }
  }
});

test('a short description is reported as too short, and located on the page’s Layout with its prop', async () => {
  const report = await runSite('page');
  const short = report.findings.find((finding) => finding.check === 'description-short');
  assert.ok(short, 'too short is its own rule');
  assert.equal(short.measure, '21 characters');
  assert.equal(short.excerpt, 'Every layout variant.');
  assert.equal(short.file, 'src/pages/index.astro');
  assert.deepEqual(short.element, { path: [0], tag: 'Layout', line: undefined });
  assert.equal(short.prop, 'description');
});

test('robots and sitemap count an endpoint, an integration, or the served file', async () => {
  const report = await runSite('site');
  const checks = report.findings.map((finding) => finding.check);
  assert.ok(!checks.includes('robots'), 'src/pages/robots.txt.ts makes robots.txt');
  assert.ok(!checks.includes('sitemap'), '@astrojs/sitemap makes the sitemap');
  const served = await audits.runAudit(
    { settings: audits.EMPTY_AUDIT_IGNORES, scope: 'site', projectPath: PROJECT, scan: SITE_SCAN, open: undefined },
    siteIO({
      readText: async () => undefined,
      renderPage: async (route) => ({
        ok: true,
        status: route === '/robots.txt' || route === '/sitemap.xml' ? 200 : route === '/' ? 200 : 404,
        html: route === '/' ? SITE_HTML : 'x',
      }),
    }),
  );
  assert.ok(!served.findings.some((finding) => finding.check === 'robots' || finding.check === 'sitemap'), 'the dev server’s answer counts');
  const none = await audits.runAudit(
    { settings: audits.EMPTY_AUDIT_IGNORES, scope: 'site', projectPath: PROJECT, scan: SITE_SCAN, open: undefined },
    siteIO({ readText: async (rel) => (rel === 'astro.config.mjs' ? 'export default {}' : undefined) }),
  );
  assert.ok(none.findings.some((finding) => finding.check === 'robots'));
  assert.ok(none.findings.some((finding) => finding.check === 'sitemap'));
});

function runSite(scope) {
  return audits.runAudit(
    {
      settings: audits.EMPTY_AUDIT_IGNORES,
      scope,
      projectPath: PROJECT,
      scan: SITE_SCAN,
      open: scope === 'page' ? { path: '/site/src/pages/index.astro', kind: 'page', read: undefined } : undefined,
    },
    siteIO(),
  );
}

test('find & replace matches text and attributes, finds code only when asked, and plans replacements through the fix path', () => {
  const { model } = parse(
    '<div class="Hero hero"><p>Acme makes things. acme!</p><img src="/x.png" alt="Acme logo"><script>const acme = 1;</script>{acme}</div>',
  );
  const find = (options) => audits.findInTree(model.nodes, { query: 'acme', caseSensitive: false, wholeWord: false, includeCode: false, ...options });
  assert.deepEqual(
    find({}).map((match) => [match.place.kind, match.count]),
    [
      ['text', 2],
      ['attribute', 1],
    ],
  );
  assert.deepEqual(
    find({ caseSensitive: true }).map((match) => match.count),
    [1],
  );
  assert.equal(find({ includeCode: true }).filter((match) => match.place.kind === 'code').length, 2, 'the script and the expression');
  assert.equal(
    audits.findInTree(model.nodes, { query: 'hero', caseSensitive: false, wholeWord: true, includeCode: false }).length,
    1,
    'class values are attributes too',
  );
  const pattern = audits.findPattern({ query: 'acme', caseSensitive: false, wholeWord: true });
  const [text, attribute] = find({});
  assert.deepEqual(audits.replacementFinding('src/pages/a.astro', text, pattern, 'Stacki').fix.edits, [
    { tag: 'text', path: [0, 0, 0], before: 'Acme makes things. acme!', value: 'Stacki makes things. Stacki!' },
  ]);
  assert.deepEqual(
    audits.replacementFinding('src/pages/a.astro', attribute, pattern, '$1').fix.edits[0].patch,
    { alt: { type: 'string', value: '$1 logo' } },
    'the replacement is literal',
  );
  assert.equal(
    audits.replacementFinding(
      'src/pages/a.astro',
      find({ includeCode: true }).find((match) => match.place.kind === 'code'),
      pattern,
      'x',
    ),
    undefined,
    'code is never rewritten',
  );
  assert.deepEqual(
    audits
      .findInData({ title: 'Acme', list: ['no', 'acme co'] }, pattern)
      .map((match) => match.keys.join('.'))
      .sort(),
    ['list.1', 'title'],
  );
  assert.deepEqual(audits.replacedInData({ title: 'Acme', n: 3 }, pattern, 'Stacki'), { title: 'Stacki', n: 3 });
});

test('the category is a dropdown remembered per project, and code-style rules show what kinds of values they hold', () => {
  localStorage.setItem('stacki.audits.category:/site', 'tokens');
  assert.equal(audits.storedFilter('/site'), 'tokens');
  assert.equal(audits.storedFilter('/other'), 'all');
  localStorage.setItem('stacki.audits.category:/site', 'bogus');
  assert.equal(audits.storedFilter('/site'), 'all');
  const css = (group, token) =>
    finding({
      id: `${group}${token}${Math.random()}`,
      check: 'token-value',
      css: { selector: '.a', property: 'padding', value: token, token, line: 3, group },
    });
  assert.equal(
    audits.breakdown([css('spacing', '1px'), css('spacing', '2px'), css('radius', '3px'), css('colour', '#fff'), css('colour', '#000')]),
    '2 spacing · 2 colours · 1 radius',
  );
  const rows = audits.reviewRows([css('spacing', '6px'), css('spacing', '6px'), css('spacing', '8px')], { collapse: true });
  assert.deepEqual(
    rows.map((row) => row.findings.length),
    [2, 1],
    '"6px used 2×"',
  );
  assert.equal(audits.reviewRows([css('spacing', '6px'), css('spacing', '6px')], { collapse: false }).length, 2);
  assert.equal(audits.reviewMatches(css('radius', '3px'), { kind: 'spacing', file: 'all', fixable: false }), false);
  assert.equal(audits.reviewMatches(css('radius', '3px'), { kind: 'all', file: 'all', fixable: true }), false, 'no fix');
});
