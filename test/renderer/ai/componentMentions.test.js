// Goal: a person can mention a component and then its props, values and slots, and the agent gets
// exactly the compact reference. The scan's components become mention components whose path is the
// one the agent needs (components outside src/components, a project in a subfolder of its
// repository, a package component, a Windows path; one outside the project is dropped; a huge scan is
// cut at its bound); `@` lists components, and `@` right after a component chip lists that
// component's props, each followed by its values, then its slots, within the picker's twelve rows;
// deleting a component chip deletes its member chips in one undoable change; a chip whose component
// or member left the project is drawn invalid, and a send, steer or queued send with one is refused
// with the draft kept, while a valid one sends only the reference.
// Method: the pure model runs as plain functions; the composer is the real ComposerInput mounted with
// React in jsdom (as in composerInput.test.js: Range geometry faked, keys dispatched to the editor);
// the store runs in the same bundle against a fake preload that records every call, so the
// component list the shell hands over is the one the composer and the send check both read.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { waitFor } = require('../../helpers/waitFor.js');
const { measureSpeedFactor } = require('../../helpers/rendererModule')('test/helpers/scaleFixtures.ts');

const output = repoPath('node_modules/.stacki-test/componentMentions.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { ComposerInput } from './src/features/ai/composer/ComposerInput';",
      // The shell lends the Properties panel's field to the chip popover; the test loads it the same way.
      "import './src/app/shell/aiMemberField';",
      "export { selectionMentionOf, locatorOf } from './src/app/shell/aiSelection';",
      "export { mentionIndexOf } from './src/app/shell/aiMentionIndex';",
      "export * from './src/features/ai/mentions/projectMentions';",
      "export { stillMatching } from './src/features/ai/mentions/useMentionRows';",
      "export { CHIP_PICKER_HEIGHT_PX } from './src/ui/chipEditor/ChipPicker';",
      "export { CHIP_STYLES, CHIP_STYLE_COLOURS, CHIP_STYLE_ICONS, chipStyleOf } from './src/features/ai/mentions/mentionChips';",
      "export { PaintBrushIcon, VariableIcon } from './src/ui/Icons';",
      "export { appendSelection, shortText, setSelectionMention, addSelectionToDraft, SELECTION_MEMBERS_MAX } from './src/features/ai/mentions/selectionMention';",
      "export * from './src/features/ai/mentions/componentMentions';",
      "export { chipLook, PICKER_ROWS_MAX } from './src/features/ai/mentions/mentionChips';",
      "export { aiState, loadAiProject, openChat, queuePrompt, resetAiStore, sendPrompt, setDraft, steerPrompt } from './src/features/ai/aiStore';",
      "export { plainTextOf } from './shared/properties/ai/mentions';",
      "export { ENGLISH_TRANSLATE } from './shared/properties/i18n/englishTranslator';",
      "export { EditorView } from '@codemirror/view';",
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
  'Element',
  'Node',
  'Event',
  'KeyboardEvent',
  'MouseEvent',
  'getComputedStyle',
  'MutationObserver',
  'Window',
]) {
  Object.defineProperty(global, name, { value: dom.window[name], configurable: true, writable: true });
}
global.localStorage = dom.window.localStorage;
global.IS_REACT_ACT_ENVIRONMENT = true;
global.requestAnimationFrame = (callback) => setTimeout(() => callback(Date.now()), 0);
dom.window.requestAnimationFrame = global.requestAnimationFrame;
global.cancelAnimationFrame = (handle) => clearTimeout(handle);
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
// A caret is one box, so the picker has an anchor; jsdom has no layout of its own.
const box = { top: 10, left: 10, bottom: 30, right: 20, width: 10, height: 20 };
dom.window.Range.prototype.getBoundingClientRect = () => box;
dom.window.Range.prototype.getClientRects = () => ({
  length: 1,
  0: box,
  item: () => box,
  [Symbol.iterator]: function* () {
    yield box;
  },
});
dom.window.document.hasFocus = () => true;

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const model = require(output);
const translate = model.ENGLISH_TRANSLATE;

const text = (value) => ({ kind: 'text', text: value });
const chip = (value) => ({ kind: 'chip', chip: value });
const HERO = 'src/components/Hero.astro';
const heroChip = { kind: 'component', path: HERO, name: 'Hero' };
const member = (name, value, role = 'prop', component = HERO) => ({ kind: 'member', component, role, name, value });

// A scan entry as project:scan sends it: absolute `path`, project-relative `file`, the prop schema and the slots.
function scanned(file, { root = '/site', name, schema = [], slots = [] } = {}) {
  return {
    path: `${root}/${file}`,
    file,
    name:
      name ??
      file
        .split('/')
        .pop()
        .replace(/\.astro$/, ''),
    folder: '',
    schema,
    slots,
  };
}
const field = (name, type, extra = {}) => ({ name, type, optional: true, ...extra });
const heroScan = scanned(HERO, {
  schema: [
    field('variant', 'enum', { options: ['large', 'small', 'wide'], default: 'large', unions: [{ names: ['variant'], branches: [] }] }),
    field('title', 'string', { default: 'Welcome' }),
    field('dark', 'boolean'),
  ],
  slots: ['default', 'header'],
});
const PROJECT = { path: '/site', platform: 'darwin' };

// ---------------------------------------------------------------------------
// From the scan: the path the agent receives
// ---------------------------------------------------------------------------

test('a component’s path is relative to the project the agent runs in, wherever its folder is', () => {
  const components = model.mentionComponentsOf(
    [
      heroScan,
      scanned('src/ui/Card.astro'),
      scanned('website/blocks/Banner.astro'),
      // A package component has no `file`: its path is made relative to the project.
      { path: '/site/node_modules/lumos/src/Button.astro', name: 'Button', folder: 'lumos' },
      // Outside the project: nothing the agent could open, so it is not offered.
      { path: '/elsewhere/Stray.astro', name: 'Stray', folder: '' },
      // The same file twice (a component folder listed twice) is one component.
      scanned('src/ui/Card.astro'),
    ],
    PROJECT,
  );
  assert.deepEqual(
    components.map((component) => component.path),
    ['src/components/Hero.astro', 'src/ui/Card.astro', 'website/blocks/Banner.astro', 'node_modules/lumos/src/Button.astro'],
  );
  // A project in a subfolder of its repository: the path starts at the project, not at the repository.
  const nested = model.mentionComponentsOf(
    [scanned('src/components/Hero.astro', { root: '/repo/apps/site' }), { path: '/repo/apps/site/src/lib/Nav.astro', name: 'Nav', folder: '' }],
    { path: '/repo/apps/site', platform: 'darwin' },
  );
  assert.deepEqual(
    nested.map((component) => component.path),
    ['src/components/Hero.astro', 'src/lib/Nav.astro'],
  );
  const windows = model.mentionComponentsOf([{ path: 'C:\\Sites\\Site\\src\\ui\\Card.astro', name: 'Card', folder: '' }], {
    path: 'c:\\sites\\site',
    platform: 'win32',
  });
  assert.deepEqual(
    windows.map((component) => component.path),
    ['src/ui/Card.astro'],
    'a Windows path becomes forward slashes, the drive letter compared without case',
  );
});

test('props carry their values (a choice’s options, a switch’s true and false) and slots are listed; nothing else is kept', () => {
  const [hero] = model.mentionComponentsOf([heroScan], PROJECT);
  assert.equal(hero.path, HERO);
  assert.equal(hero.name, 'Hero');
  assert.deepEqual(
    hero.props.map(({ name, type, values, variant }) => ({ name, type, values, variant })),
    [
      { name: 'variant', type: 'enum', values: ['large', 'small', 'wide'], variant: true },
      { name: 'title', type: 'string', values: [], variant: false },
      { name: 'dark', type: 'boolean', values: ['true', 'false'], variant: false },
    ],
  );
  assert.equal(hero.props[1].field, heroScan.schema[1], 'the scan field is kept for the popover, as is');
  assert.deepEqual(hero.slots, ['default', 'header']);
});

test('a huge scan is cut at its bound, and huge prop lists at theirs', () => {
  const many = Array.from({ length: model.MENTION_COMPONENTS_MAX + 50 }, (_, index) => scanned(`src/components/C${index}.astro`));
  const components = model.mentionComponentsOf(many, PROJECT);
  assert.equal(components.length, model.MENTION_COMPONENTS_MAX);
  const wide = scanned('src/components/Wide.astro', {
    schema: Array.from({ length: model.MENTION_MEMBERS_MAX + 10 }, (_, index) =>
      field(`p${index}`, 'select', { options: Array.from({ length: model.MENTION_VALUES_MAX + 5 }, (__, value) => `v${value}`) }),
    ),
  });
  const [bounded] = model.mentionComponentsOf([wide], PROJECT);
  assert.equal(bounded.props.length, model.MENTION_MEMBERS_MAX);
  assert.equal(bounded.props[0].values.length, model.MENTION_VALUES_MAX);
  const rows = model.memberRows(bounded, '', translate);
  assert.equal(rows.length, model.PICKER_ROWS_MAX, 'the picker still shows at most twelve rows');
  const started = performance.now();
  assert.equal(model.componentRows(components, 'C49', translate, model.COMPONENT_ROWS_MAX).length, model.COMPONENT_ROWS_MAX);
  const elapsedMs = performance.now() - started;
  // Half a second on the reference machine, scaled by how much slower this runner measured in the same run.
  const elapsedMsMax = 500 * measureSpeedFactor();
  assert.ok(elapsedMs < elapsedMsMax, `searching the full bound stays fast (${elapsedMs}ms)`);
});

// ---------------------------------------------------------------------------
// Picker rows, scope and dependencies
// ---------------------------------------------------------------------------

test('components match by name first, then by path, within their four rows', () => {
  const components = model.mentionComponentsOf(
    [heroScan, scanned('src/ui/HeroCard.astro'), scanned('src/ui/Card.astro'), scanned('src/hero/Banner.astro')],
    PROJECT,
  );
  const rows = model.componentRows(components, 'hero', translate, model.COMPONENT_ROWS_MAX);
  assert.deepEqual(
    rows.map((row) => row.label),
    ['Hero', 'HeroCard', 'Banner'],
    'name prefixes, then a path containing the query',
  );
  assert.deepEqual(rows[0].chip, heroChip);
  assert.equal(rows[0].group, 'Components');
  assert.equal(rows[0].description, HERO, 'the row shows where the file is');
  assert.equal(model.componentRows(components, 'zzz', translate, 4).length, 0);
});

test('a component’s members: each prop followed by its values, then the slots, narrowed by name, value or name=value', () => {
  const [hero] = model.mentionComponentsOf([heroScan], PROJECT);
  const rows = model.memberRows(hero, '', translate);
  assert.deepEqual(
    rows.map((row) => row.label),
    ['variant', 'variant = large', 'variant = small', 'variant = wide', 'title', 'dark', 'dark = true', 'dark = false', 'default slot', 'header slot'],
  );
  assert.ok(rows.every((row) => row.group === 'Hero props and slots'));
  assert.deepEqual(rows[1].chip, member('variant', 'large'));
  assert.deepEqual(rows[8].chip, member('default', undefined, 'slot'));
  assert.deepEqual(
    model.memberRows(hero, 'variant=la', translate).map((row) => row.label),
    ['variant = large'],
  );
  assert.deepEqual(
    model.memberRows(hero, 'head', translate).map((row) => row.label),
    ['header slot'],
  );
});

test('`@` is scoped to the component chip (or its member chip) right before it, and to nothing after other words', () => {
  assert.equal(model.mentionScope([text('Make '), chip(heroChip), text(' ')]), HERO);
  assert.equal(model.mentionScope([chip(heroChip), text(' '), chip(member('variant', 'large')), text('  ')]), HERO);
  assert.equal(model.mentionScope([chip(heroChip), text(' bigger ')]), undefined);
  assert.equal(model.mentionScope([chip({ kind: 'file', path: 'a.md', name: 'a.md' }), text(' ')]), undefined);
  assert.equal(model.mentionScope([]), undefined);
  // The editor's offsets count each chip as one character.
  const draft = [text('a '), chip(heroChip), text(' b '), chip(member('title'))];
  assert.deepEqual(model.segmentsBefore(draft, 3), [text('a '), chip(heroChip)]);
  assert.deepEqual(model.segmentsBefore(draft, 99), draft, 'a draft shorter than the offset is all before it');
});

test('a member chip is an orphan only when no chip of its component is left', () => {
  const card = { kind: 'component', path: 'src/ui/Card.astro', name: 'Card' };
  assert.deepEqual(model.orphanMembers([member('title'), member('header', undefined, 'slot'), card]), [0, 1]);
  assert.deepEqual(model.orphanMembers([heroChip, member('title')]), [], 'its component is still there');
  assert.deepEqual(model.orphanMembers([member('title'), heroChip]), [], 'a second chip of the component keeps its members');
});

test('a chip that no longer matches the project is a problem, and an unknown scan calls nothing invalid', () => {
  const [hero] = model.mentionComponentsOf([heroScan], PROJECT);
  assert.equal(model.chipProblem(heroChip, [hero]), undefined);
  assert.equal(model.chipProblem(member('variant', 'large'), [hero]), undefined);
  assert.equal(model.chipProblem(heroChip, []), 'component-missing');
  assert.equal(model.chipProblem(member('variant', 'huge'), [hero]), 'member-missing', 'a value no longer offered');
  assert.equal(model.chipProblem(member('subtitle'), [hero]), 'member-missing');
  assert.equal(model.chipProblem(member('footer', undefined, 'slot'), [hero]), 'member-missing');
  assert.equal(model.chipProblem(member('title'), []), 'component-missing');
  assert.equal(model.chipProblem(heroChip, undefined), undefined, 'before a scan arrives nothing is guessed invalid');
  assert.equal(model.chipProblem({ kind: 'file', path: 'a.md', name: 'a.md' }, []), undefined);
  assert.deepEqual(model.invalidMentions([chip(heroChip), text(' '), chip(member('variant', 'large'))], []), ['Hero', 'Hero prop:variant=large']);
  const look = model.chipLook(heroChip, translate, model.chipProblemText(heroChip, [], translate));
  assert.equal(look.kind, 'invalid');
  assert.equal(look.label, 'Hero', 'the label stays what the person picked');
  assert.match(look.title, /no longer in this project/);
});

// ---------------------------------------------------------------------------
// The composer
// ---------------------------------------------------------------------------

// One task boundary inside act, so queued effects and state updates land. Never a fixed pause: what an action leads
// to (the picker's rows after a keystroke and its short search delay, a chip after Enter) is waited for by polling the
// document or the draft the test reads, bounded by test/helpers/waitFor.js.
const settle = () => act(async () => new Promise((resolve) => setImmediate(resolve)));
const waitUntil = (what, until) =>
  waitFor({
    what,
    read: async () => {
      await settle();
      return until();
    },
    until: (held) => held,
  });
const roots = [];
async function mount(options = {}) {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  document.body.replaceChildren();
  const host = document.createElement('div');
  document.body.append(host);
  const record = { segments: [], root: createRoot(host), focus: React.createRef() };
  roots.push(record.root);
  function Harness() {
    const [segments, setSegments] = React.useState(record.segments);
    record.set = setSegments;
    return React.createElement(model.ComposerInput, {
      agent: 'claude',
      commands: [],
      placeholder: 'Ask anything',
      inputRef: record.focus,
      segments,
      onSegmentsChange: (next) => {
        record.segments = next;
        setSegments(next);
      },
      onSend: () => undefined,
      searchMentions: options.search ?? (async () => ({ ok: true, value: [] })),
    });
  }
  await act(async () => record.root.render(React.createElement(Harness)));
  await waitUntil('the editor is mounted', () => host.querySelector('.cm-editor') !== null);
  record.view = model.EditorView.findFromDOM(host.querySelector('.cm-editor'));
  assert.ok(record.view, 'the editor is mounted');
  // A popover of the previous test hands focus back as it leaves; let that land before this editor takes it.
  await settle();
  record.view.focus();
  return record;
}
const press = (view, key, init = {}) =>
  view.contentDOM.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }));
const typeText = async (record, value) => {
  const view = record.view;
  const head = view.state.selection.main.head;
  await act(async () => view.dispatch({ changes: { from: head, insert: value }, selection: { anchor: head + value.length }, userEvent: 'input.type' }));
  await settle();
};
// The picker lists `label` (its search has answered or its built-in rows are drawn).
const untilRow = (label) => waitUntil(`the picker lists ${label}`, () => rowsOf().includes(label));
const untilPills = (count) => waitUntil(`${count} chip(s) in the draft`, () => pills().length === count);
const rowsOf = () => [...document.querySelectorAll('.chip-picker-option')].map((row) => row.querySelector('.chip-picker-label').textContent);
const groupsOf = () => [...document.querySelectorAll('.chip-picker-heading')].map((heading) => heading.textContent);
const pills = () => [...document.querySelectorAll('.cm-content .chip-editor-chip')].map((pill) => ({ label: pill.textContent, kind: pill.dataset.chipKind }));

test('in the composer: @ picks a component, @ again picks its value, and the draft says only the reference', async () => {
  model.setMentionComponents(model.mentionComponentsOf([heroScan, scanned('src/ui/Card.astro')], PROJECT));
  const record = await mount();
  await typeText(record, 'Make @he');
  await untilRow('Hero');
  assert.deepEqual(groupsOf(), ['Components']);
  assert.deepEqual(rowsOf(), ['Hero']);
  await act(async () => void press(record.view, 'Enter'));
  await untilPills(1);
  assert.deepEqual(record.segments, [text('Make '), chip(heroChip), text(' ')]);
  await typeText(record, '@');
  await untilRow('variant');
  assert.equal(groupsOf()[0], 'Hero props and slots', 'the component’s own members come first');
  assert.deepEqual(rowsOf().slice(0, 3), ['variant', 'variant = large', 'variant = small']);
  await typeText(record, 'large');
  await waitUntil('the picker narrows to variant = large', () => rowsOf()[0] === 'variant = large');
  await act(async () => void press(record.view, 'Enter'));
  await untilPills(2);
  assert.deepEqual(record.segments, [text('Make '), chip(heroChip), text(' '), chip(member('variant', 'large')), text(' ')]);
  assert.deepEqual(pills(), [
    { label: 'Hero', kind: 'component' },
    { label: 'variant = large', kind: 'member' },
  ]);
  await typeText(record, 'bigger');
  assert.equal(model.plainTextOf(record.segments), 'Make src/components/Hero.astro prop:variant=large bigger');
  // Escape closes the picker and keeps what was typed.
  await typeText(record, ' @Ca');
  await untilRow('Card');
  assert.deepEqual(rowsOf(), ['Card']);
  await act(async () => void press(record.view, 'Escape'));
  await waitUntil('the picker is closed', () => document.querySelectorAll('.chip-picker-option').length === 0);
  assert.equal(document.querySelectorAll('.chip-picker-option').length, 0);
  assert.ok(record.view.state.doc.toString().endsWith('@Ca'));
});

test('in the composer: deleting a component chip deletes its member chips, and one undo brings all back', async () => {
  model.setMentionComponents(model.mentionComponentsOf([heroScan], PROJECT));
  const record = await mount();
  await typeText(record, '@Hero');
  await untilRow('Hero');
  await act(async () => void press(record.view, 'Enter'));
  await untilPills(1);
  await typeText(record, '@title');
  await untilRow('title');
  await act(async () => void press(record.view, 'Enter'));
  await untilPills(2);
  await typeText(record, '@header');
  await untilRow('header slot');
  await act(async () => void press(record.view, 'Enter'));
  await untilPills(3);
  await typeText(record, 'please');
  assert.equal(pills().length, 3);
  // The caret after the component chip, then Backspace: the chip goes, and its members with it.
  record.view.dispatch({ selection: { anchor: 1 } });
  await act(async () => void press(record.view, 'Backspace'));
  await untilPills(0);
  assert.deepEqual(pills(), [], 'the member chips went with their component');
  assert.deepEqual(record.segments, [text(' please')]);
  await act(async () => void press(record.view, 'z', { ctrlKey: true }));
  await untilPills(3);
  assert.deepEqual(
    pills().map((pill) => pill.label),
    ['Hero', 'title', 'header slot'],
    'one undo restores the component and its members together',
  );
  assert.equal(model.plainTextOf(record.segments), 'src/components/Hero.astro prop:title slot:header please');
});

test('in the composer: a component that left the project turns its chips invalid at once', async () => {
  model.setMentionComponents(model.mentionComponentsOf([heroScan], PROJECT));
  const record = await mount();
  await typeText(record, '@Hero');
  await untilRow('Hero');
  await act(async () => void press(record.view, 'Enter'));
  await untilPills(1);
  await typeText(record, '@small');
  await untilRow('variant = small');
  await act(async () => void press(record.view, 'Enter'));
  await untilPills(2);
  assert.deepEqual(
    pills().map((pill) => pill.kind),
    ['component', 'member'],
  );
  await act(async () => model.setMentionComponents(model.mentionComponentsOf([], PROJECT)));
  await waitUntil('both chips are drawn invalid', () => pills().every((pill) => pill.kind === 'invalid'));
  assert.deepEqual(
    pills().map((pill) => pill.kind),
    ['invalid', 'invalid'],
  );
  assert.match(document.querySelector('.cm-content .chip-editor-chip').title, /Hero is no longer in this project/);
  assert.deepEqual(
    pills().map((pill) => pill.label),
    ['Hero', 'variant = small'],
    'the draft is not rewritten: the chips stay as picked',
  );
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

const CHAT = `c${'a'.repeat(24)}`;
const TURN = `t${'1'.repeat(16)}`;
const summary = (id) => ({ id, agent: 'claude', title: 'New chat', pinned: false, createdAt: 1, updatedAt: 1, rank: 0, unread: false });

async function startStore() {
  await act(async () => {
    for (const root of roots.splice(0)) {
      root.unmount();
    }
  });
  model.resetAiStore();
  dom.window.localStorage.clear();
  const calls = [];
  const record = (name, reply) => async (payload) => {
    calls.push({ name, payload });
    return typeof reply === 'function' ? reply(payload) : reply;
  };
  dom.window.avb = {
    platform: 'darwin',
    aiAgents: record('aiAgents', () => ({
      trusted: true,
      agents: [{ agent: 'claude', state: 'ready', adapterVersion: '1.0.0', running: false, downloadMegabytes: 1 }],
      options: [],
    })),
    aiChats: record('aiChats', () => ({ chats: [summary(CHAT)], sections: [] })),
    aiChatRead: record('aiChatRead', (payload) => ({ ok: true, value: { summary: summary(payload.chat), events: [], full: false } })),
    aiPrompt: record('aiPrompt', () => ({ ok: true, value: { turn: TURN } })),
    aiSteer: record('aiSteer', () => ({ ok: true, value: {} })),
    aiMentions: record('aiMentions', () => ({ ok: true, value: [] })),
    aiAck: () => undefined,
    onAiEvents: () => () => undefined,
    onAiAgentStatus: () => () => undefined,
    onAiSetup: () => () => undefined,
  };
  await model.loadAiProject('/site');
  await model.openChat(CHAT);
  return (name) => calls.filter((call) => call.name === name);
}

const heroDraft = { segments: [text('Make '), chip(heroChip), text(' '), chip(member('variant', 'large')), text(' bigger')], attachments: [] };

test('a send with a component that left the project is refused, says which, and keeps the draft', async () => {
  const named = await startStore();
  model.setMentionComponents(model.mentionComponentsOf([scanned('src/ui/Card.astro')], PROJECT));
  model.setDraft(CHAT, () => heroDraft);
  assert.equal(await model.sendPrompt(CHAT), false);
  assert.equal(named('aiPrompt').length, 0, 'nothing reached the agent');
  assert.equal(model.aiState().errorRef?.key, 'ai.store.mentionInvalid');
  assert.match(model.aiState().error, /Hero, Hero prop:variant=large/);
  assert.deepEqual(model.aiState().drafts.get(CHAT).segments, heroDraft.segments, 'the draft is not mangled or cleared');
  assert.equal(await model.steerPrompt(CHAT), false, 'a steer is refused the same way');
  assert.equal(named('aiSteer').length, 0);
  assert.deepEqual(model.aiState().drafts.get(CHAT).segments, heroDraft.segments);
});

test('a valid component mention sends only its compact reference, as text', async () => {
  const named = await startStore();
  model.setMentionComponents(model.mentionComponentsOf([heroScan], PROJECT));
  model.setDraft(CHAT, () => heroDraft);
  assert.equal(await model.sendPrompt(CHAT), true);
  const [call] = named('aiPrompt');
  assert.equal(call.payload.text, 'Make src/components/Hero.astro prop:variant=large bigger');
  assert.deepEqual(call.payload.parts, [{ kind: 'text', text: 'Make src/components/Hero.astro prop:variant=large bigger' }]);
});

// ---------------------------------------------------------------------------
// The component chip's popover
// ---------------------------------------------------------------------------

test('the popover’s edits: the run after a component chip, and one planned change per toggle', () => {
  const draft = [chip(heroChip), text(' '), chip(member('title')), text(' '), chip(member('variant', 'large')), text(' then '), chip(member('dark'))];
  const placed = model.placedChips(draft);
  assert.deepEqual(
    placed.map((entry) => entry.from),
    [0, 2, 4, 11],
  );
  const documentText = draft.map((segment) => (segment.kind === 'text' ? segment.text : '￼')).join('');
  const run = model.memberRun(documentText, placed, 0);
  assert.deepEqual(
    run.map((entry) => entry.chip.name),
    ['title', 'variant'],
    'a member after other words is not in the run',
  );
  const target = { componentFrom: 0, path: HERO };
  assert.deepEqual(model.planMemberEdit(documentText, run, target, { role: 'slot', name: 'header', value: undefined, on: true }), {
    kind: 'insert',
    at: 5,
    chip: member('header', undefined, 'slot'),
  });
  assert.deepEqual(model.planMemberEdit(documentText, run, target, { role: 'prop', name: 'variant', value: 'small', on: true }), {
    kind: 'replace',
    at: 4,
    chip: member('variant', 'small'),
  });
  assert.deepEqual(model.planMemberEdit(documentText, run, target, { role: 'prop', name: 'title', value: undefined, on: false }), {
    kind: 'remove',
    from: 1,
    to: 3,
  });
  assert.equal(model.planMemberEdit(documentText, run, target, { role: 'prop', name: 'title', value: undefined, on: true }), undefined, 'already so');
  assert.equal(model.planMemberEdit(documentText, run, target, { role: 'slot', name: 'header', value: undefined, on: false }), undefined, 'already off');
  assert.deepEqual(model.planMemberEdit('￼', [], target, { role: 'prop', name: 'title', value: undefined, on: true }), {
    kind: 'insert',
    at: 1,
    chip: member('title'),
  });
});

const popover = () => document.querySelector('.component-members') ?? undefined;
const rowOf = (name) => popover().querySelector(`[data-member-prop="${name}"]`);
const clickPill = async (index) => {
  await act(async () => document.querySelectorAll('.cm-content .chip-editor-chip')[index].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  await settle();
};
// Typing into a React-controlled input: set the value through the native setter, then the input event React listens for.
const typeInto = async (input, value) => {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  await settle();
};
const undo = async (record) => {
  await act(async () => void record.view.contentDOM.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })));
  await settle();
};

const fullScan = scanned(HERO, {
  schema: [...heroScan.schema, field('columns', 'number')],
  slots: ['default', 'header'],
});

// Types up to a component's name, waits for the picker to list it (it opens a measure frame after the keystroke,
// which a loaded machine can take a few rounds to reach), chooses it, and waits for its pill.
async function pickComponent(record, typed, name) {
  await typeText(record, typed);
  for (let round = 0; round < 20 && rowsOf()[0] !== name; round += 1) {
    await settle();
  }
  assert.equal(rowsOf()[0], name);
  await act(async () => void press(record.view, 'Enter'));
  for (let round = 0; round < 20 && document.querySelectorAll('.cm-content .chip-editor-chip').length === 0; round += 1) {
    await settle();
  }
  assert.ok(document.querySelector('.cm-content .chip-editor-chip'), 'the component chip is in the draft');
}

async function mountWithHero() {
  model.setMentionComponents(model.mentionComponentsOf([fullScan], PROJECT));
  const record = await mount();
  await pickComponent(record, 'Make @Hero', 'Hero');
  await typeText(record, 'bigger');
  return record;
}

test('the popover draws the Properties panel’s fields, grouped as Props, Variants and Slots; untouched rows call nothing out', async () => {
  const record = await mountWithHero();
  await clickPill(0);
  assert.ok(popover(), 'the popover opens from the chip');
  assert.equal(popover().getAttribute('aria-label'), 'Props and slots of Hero');
  assert.deepEqual(
    [...popover().querySelectorAll('.component-members-heading')].map((heading) => heading.firstChild.textContent),
    ['Props', 'Variants', 'Slots'],
  );
  assert.ok(rowOf('title').querySelector('.props-field input'), 'a string prop is the panel’s text field');
  assert.equal(rowOf('title').querySelector('.props-field input').placeholder, 'Welcome', 'its default shows dim');
  assert.ok(rowOf('dark').querySelector('.props-field'), 'a boolean prop is the panel’s switch');
  assert.ok(rowOf('columns').querySelector('.num-field input'), 'a number prop is the panel’s number field');
  assert.ok(rowOf('variant').querySelector('.props-field button'), 'a choice is the panel’s dropdown');
  assert.equal(popover().querySelectorAll('[role="radio"]').length, 0, 'no value sub-rows');
  assert.ok(popover().textContent.includes('Slot: header'));
  assert.deepEqual(record.segments, [text('Make '), chip(heroChip), text(' bigger')], 'opening and looking adds nothing');
});

test('changing a field adds or updates the member chip, clearing it removes the chip, one undo step each', async () => {
  const record = await mountWithHero();
  const caret = record.view.state.selection.main.head;
  await clickPill(0);
  const titleInput = () => rowOf('title').querySelector('.props-field input');
  await typeInto(titleInput(), 'Read more');
  assert.equal(model.plainTextOf(record.segments), 'Make src/components/Hero.astro prop:title="Read more" bigger');
  await typeInto(titleInput(), 'Hello');
  assert.equal(model.plainTextOf(record.segments), 'Make src/components/Hero.astro prop:title=Hello bigger', 'a new value updates the chip in place');
  // The number field writes on commit (Enter or leaving it), as in the panel.
  const columns = rowOf('columns').querySelector('.num-field input');
  await typeInto(columns, '3');
  await act(async () => void columns.dispatchEvent(new dom.window.FocusEvent('blur', { bubbles: false })));
  await act(async () => void columns.dispatchEvent(new dom.window.FocusEvent('focusout', { bubbles: true })));
  await settle();
  assert.equal(model.plainTextOf(record.segments), 'Make src/components/Hero.astro prop:title=Hello prop:columns=3 bigger');
  // The boolean switch: the panel's True/False pair.
  const trueButton = [...rowOf('dark').querySelectorAll('button')].find((button) => button.textContent === 'True');
  await act(async () => trueButton.click());
  await settle();
  assert.equal(model.plainTextOf(record.segments), 'Make src/components/Hero.astro prop:title=Hello prop:columns=3 prop:dark=true bigger');
  // A slot row's checkbox (a square, never a switch).
  await act(async () => rowSwitch('Slot: header').click());
  await settle();
  assert.match(model.plainTextOf(record.segments), / slot:header bigger$/);
  // Clearing the text field removes its chip.
  await typeInto(titleInput(), '');
  assert.equal(model.plainTextOf(record.segments), 'Make src/components/Hero.astro prop:columns=3 prop:dark=true slot:header bigger');
  assert.ok(record.view.state.selection.main.head >= caret, 'the caret stayed with its text');
  await undo(record);
  assert.equal(
    model.plainTextOf(record.segments),
    'Make src/components/Hero.astro prop:title=Hello prop:columns=3 prop:dark=true slot:header bigger',
    'undo takes back one change',
  );
  await undo(record);
  assert.equal(model.plainTextOf(record.segments), 'Make src/components/Hero.astro prop:title=Hello prop:columns=3 prop:dark=true bigger');
});
const rowSwitch = (label) => [...popover().querySelectorAll('[role="checkbox"]')].find((element) => element.getAttribute('aria-label') === label);

test('the include dot mentions a prop without a value, and turns it off again', async () => {
  const record = await mountWithHero();
  await clickPill(0);
  const dot = rowOf('variant').querySelector('.component-members-include');
  assert.equal(dot.getAttribute('aria-checked'), 'false');
  await act(async () => dot.click());
  await settle();
  assert.equal(model.plainTextOf(record.segments), 'Make src/components/Hero.astro prop:variant bigger');
  assert.equal(rowOf('variant').querySelector('.component-members-include').getAttribute('aria-checked'), 'true');
  await act(async () => rowOf('variant').querySelector('.component-members-include').click());
  await settle();
  assert.equal(model.plainTextOf(record.segments), 'Make src/components/Hero.astro bigger');
});

test('every row has a square checkbox, headings carry counts, and the arrow keys move between the checkboxes', async () => {
  await mountWithHero();
  await clickPill(0);
  const boxes = [...popover().querySelectorAll('[role="checkbox"]')];
  assert.ok(boxes.length >= 3, 'props and slots each have a checkbox');
  assert.equal(popover().querySelector('[role="switch"]') ?? undefined, undefined, 'no toggle switch in the popover');
  assert.ok(
    boxes.every((box) => box.querySelector('.component-members-box')),
    'a box, not a ringed dot',
  );
  assert.ok(popover().querySelectorAll('.component-members-count').length >= 2, 'a count beside each heading');
  boxes[0].focus();
  await act(async () => void boxes[0].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })));
  assert.equal(document.activeElement, boxes[1], 'ArrowDown moves to the next row');
  await act(async () => void boxes[1].dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true })));
  assert.equal(document.activeElement, boxes[0], 'ArrowUp moves back');
});

test('the popover is keyboard reachable: the first control has focus, Escape closes and gives the composer back its caret', async () => {
  const record = await mountWithHero();
  const caret = record.view.state.selection.main.head;
  await clickPill(0);
  assert.ok(popover().contains(document.activeElement), 'focus is in the popover');
  await act(async () => void document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await settle();
  assert.equal(popover(), undefined, 'Escape closes it');
  assert.ok(record.view.hasFocus, 'focus is back in the composer');
  assert.equal(record.view.state.selection.main.head, caret, 'at the caret it had');
});

test('a component with many props opens with a search field that narrows the rows', async () => {
  const many = scanned('src/components/Wide.astro', { schema: Array.from({ length: 14 }, (_, index) => field(`p${index}`, 'string')) });
  model.setMentionComponents(model.mentionComponentsOf([many], PROJECT));
  const record = await mount();
  await pickComponent(record, '@Wide', 'Wide');
  await clickPill(0);
  const search = popover().querySelector('.component-members-search');
  assert.ok(search);
  await typeInto(search, 'p1');
  assert.deepEqual(
    [...popover().querySelectorAll('[data-member-prop]')].map((row) => row.dataset.memberProp),
    ['p1', 'p10', 'p11', 'p12', 'p13'],
  );
});

test('an invalid component chip opens no popover', async () => {
  const record = await mountWithHero();
  await act(async () => model.setMentionComponents(model.mentionComponentsOf([], PROJECT)));
  await settle();
  await clickPill(0);
  assert.equal(popover(), undefined);
  assert.ok(record.view.hasFocus);
});

// ---------------------------------------------------------------------------
// Add selected element, and one member chip's popover
// ---------------------------------------------------------------------------

const instance = {
  kind: 'component',
  id: 'n1',
  name: 'Button',
  children: [{ kind: 'text', id: 't1', value: 'Go' }],
  props: {
    element: { type: 'string', value: 'link' },
    href: { type: 'string', value: '/about' },
    variant: { type: 'string', value: 'main' },
    render: { type: 'expr', value: 'true' },
    class: { type: 'string', value: 'cta wide' },
    'data-track': { type: 'string', value: 'hero' },
    rest: { type: 'spread', value: 'props' },
  },
  attrOrder: ['element', 'href', 'variant', 'render', 'class', 'data-track', 'rest'],
};
const buttonScan = {
  ...scanned('src/components/Button.astro', {
    schema: [
      field('element', 'enum', { options: ['button', 'link'], default: 'button' }),
      field('href', 'string'),
      field('variant', 'enum', { options: ['main', 'ghost'] }),
      field('render', 'boolean'),
      field('emphasis', 'enum', { options: ['primary'], default: 'primary' }),
    ],
  }),
};

test('the selected instance becomes its component chip and every value it writes, defaults it leaves alone left out', () => {
  const place = model.locatorOf('0.2', 'src/pages/index.astro');
  assert.deepEqual(place, { file: 'src/pages/index.astro', locator: '0.2' });
  assert.deepEqual(model.locatorOf('src/components/Card.astro|1.0', 'src/pages/index.astro'), { file: 'src/components/Card.astro', locator: '1.0' });
  const selection = model.selectionMentionOf({ node: instance, component: buttonScan, file: place.file, locator: place.locator, componentFile: undefined });
  const draft = model.appendSelection([], selection);
  assert.equal(
    model.plainTextOf(draft),
    'src/components/Button.astro prop:element=link prop:href=/about prop:variant=main prop:render=true attr:class="cta wide" attr:data-track=hero slot:default ',
    'written props as prop:, the rest as attr:, the filled slot; no emphasis (a default not written), no spread',
  );
});

test('a native element becomes its file and locator, its attributes and its short text', () => {
  const element = {
    kind: 'element',
    id: 'n2',
    name: 'a',
    children: [{ kind: 'text', id: 't2', value: `  Read ${'more '.repeat(30)}` }],
    props: { href: { type: 'string', value: '/blog' }, 'aria-label': { type: 'string', value: 'Blog' }, hidden: { type: 'bare' } },
    attrOrder: ['href', 'aria-label', 'hidden'],
  };
  const selection = model.selectionMentionOf({ node: element, component: undefined, file: 'src/pages/index.astro', locator: '0.2', componentFile: undefined });
  const text = model.plainTextOf(model.appendSelection([text0('See ')], selection));
  const shortened = model.shortText(`Read ${'more '.repeat(30)}`);
  assert.equal([...shortened].length, 80);
  assert.ok(shortened.endsWith('…'));
  assert.equal(text, `See src/pages/index.astro#0.2 attr:href=/blog attr:aria-label=Blog attr:hidden text=${JSON.stringify(shortened)} `);
});
function text0(value) {
  return { kind: 'text', text: value };
}

test('more members than the bound: the first forty, then the count of the rest', () => {
  const many = {
    kind: 'element',
    id: 'n3',
    name: 'div',
    children: [],
    props: Object.fromEntries(Array.from({ length: 45 }, (_, index) => [`data-a${index}`, { type: 'string', value: String(index) }])),
  };
  const selection = model.selectionMentionOf({ node: many, component: undefined, file: 'src/pages/index.astro', locator: '3', componentFile: undefined });
  const draft = model.appendSelection([], selection);
  assert.equal(draft.filter((segment) => segment.kind === 'chip').length, 1 + model.SELECTION_MEMBERS_MAX);
  assert.ok(model.plainTextOf(draft).endsWith(' +5 more '));
});

test('clicking a member chip opens its own field: a new value updates the chip, Remove deletes it', async () => {
  model.setMentionComponents(model.mentionComponentsOf([fullScan], PROJECT));
  const record = await mount();
  const start = [text('Make '), chip(heroChip), text(' '), chip(member('title', 'Hello')), text(' bigger')];
  record.segments = start;
  await act(async () => record.set(start));
  await settle();
  await clickPill(1);
  const single = document.querySelector('.component-members.is-single');
  assert.ok(single, 'the member chip opens its popover');
  const input = single.querySelector('.props-field input');
  assert.equal(input.value, 'Hello', 'the panel’s text field holds the chip’s value');
  await typeInto(input, 'Read more');
  assert.equal(model.plainTextOf(record.segments), 'Make src/components/Hero.astro prop:title="Read more" bigger');
  await act(async () => document.querySelector('.component-members-remove').click());
  await settle();
  assert.equal(model.plainTextOf(record.segments), 'Make src/components/Hero.astro bigger');
  assert.equal(document.querySelector('.component-members.is-single') ?? undefined, undefined);
});

// ---------------------------------------------------------------------------
// The project groups: pages, layouts, variables, classes, assets; tabs, order, the fixed box, no flicker
// ---------------------------------------------------------------------------

const layoutScan = { ...scanned('src/layouts/Base.astro'), isLayout: true };
const projectIndex = {
  pages: [
    { path: 'src/pages/index.astro', route: '/' },
    { path: 'src/pages/buttons.astro', route: '/buttons' },
  ],
  variables: [
    { name: '--brand-1', path: 'src/styles/global.css', color: '#ff0066' },
    { name: '--button-radius', path: 'src/styles/global.css', color: undefined },
  ],
  classes: [
    { name: 'button-primary', path: 'src/styles/global.css', rules: 2 },
    { name: 'hero-title', path: undefined, rules: 0 },
  ],
  assets: [
    { path: 'public/images/button.png', kind: 'image', abs: '/site/public/images/button.png', thumbnailKey: 'k1' },
    { path: 'public/videos/intro.mp4', kind: 'video', abs: '/site/public/videos/intro.mp4', thumbnailKey: 'k2' },
    { path: 'public/fonts/Inter.woff2', kind: 'font', abs: '/site/public/fonts/Inter.woff2', thumbnailKey: 'k3' },
    // An asset whose extension is not its kind's is refused at the boundary.
    { path: 'public/images/notes.txt', kind: 'image', abs: '/site/public/images/notes.txt', thumbnailKey: 'k4' },
  ],
};
const buttonFile = (path) => ({
  id: `file:${path}`,
  label: path.split('/').pop(),
  description: path,
  group: 'Files',
  chip: { kind: 'file', path, name: path.split('/').pop() },
});

test('the project groups: one item in one group, files that are something else left out, best match last', () => {
  const components = model.mentionComponentsOf([scanned('src/components/Button.astro'), layoutScan], PROJECT);
  const searched = [buttonFile('src/components/Button.astro'), buttonFile('public/images/button.png'), buttonFile('docs/buttons.md')];
  const answer = model.mentionRows(searched, { components, index: model.boundedIndex(projectIndex), scope: undefined, query: 'butt', tab: 'all', translate });
  const groups = [...new Set(answer.rows.map((row) => row.group))];
  assert.ok(!answer.rows.some((row) => row.id === 'file:src/components/Button.astro'), 'the component is not a file again');
  assert.ok(!answer.rows.some((row) => row.id === 'file:public/images/button.png'), 'the image is not a file again');
  assert.ok(answer.rows.some((row) => row.id === 'file:docs/buttons.md'));
  assert.equal(answer.rows[0].label, 'Button', 'the best match (a name that starts with the query) is the top row');
  assert.equal(groups[0], 'Components', 'on a tie the kind order puts components first');
  const ranks = answer.rows.map((row) => model.rowRank(row, 'butt'));
  assert.deepEqual(ranks.slice(0, 2), [1, 1]);
  assert.ok(groups.includes('Pages') && groups.includes('CSS variables') && groups.includes('Classes') && groups.includes('Images'));
  assert.ok(!groups.includes('Videos'), 'a group with no match is absent');
  assert.equal(answer.counts.components, 1);
  assert.equal(answer.counts.assets, 1);
  assert.equal(answer.counts.layouts, 0);
});

test('a tab shows only its kind, its counts stay, and every group is capped while searching', () => {
  const many = { ...projectIndex, classes: Array.from({ length: 30 }, (_, index) => ({ name: `card-${index}`, path: 'a.css', rules: 1 })) };
  const all = model.mentionRows([], { components: [], index: many, scope: undefined, query: 'card', tab: 'all', translate });
  assert.equal(all.rows.filter((row) => row.group === 'Classes').length, model.GROUP_ROWS_MAX);
  const classes = model.mentionRows([], { components: [], index: many, scope: undefined, query: 'card', tab: 'classes', translate });
  assert.equal(classes.rows.length, 30, 'its own tab lists the kind up to the picker bound');
  assert.ok(classes.rows.every((row) => row.group === 'Classes'));
  assert.equal(classes.counts.classes, 30);
  const none = model.mentionRows([], { components: [], index: many, scope: undefined, query: 'card', tab: 'pages', translate });
  assert.deepEqual(none.rows, [], 'a tab with no match is empty, not hidden');
  assert.ok(all.rows.length <= model.MENTION_ROWS_MAX);
});

test('the index from the panels’ data: variables once per file, classes once by name, assets by kind, bounded', () => {
  const index = model.mentionIndexOf({
    projectPath: '/site',
    platform: 'darwin',
    pages: [{ path: '/site/src/pages/index.astro', name: 'index.astro', route: '/' }],
    variables: {
      files: [
        {
          rel: 'src/styles/global.css',
          name: 'global.css',
          groups: [
            {
              kind: 'single',
              label: '',
              columns: [],
              blocks: [
                {
                  kind: 'rows',
                  title: undefined,
                  rows: [{ label: 'a', cells: [{ name: '--brand-1', value: 'red', color: '#f00' }, undefined, { name: '--brand-1', value: 'red' }] }],
                },
              ],
            },
          ],
        },
      ],
      values: {},
    },
    selectors: {
      entries: [
        { id: '1', rel: 'src/styles/global.css', line: 1, selector: '.card:hover .card-title', scope: 'global', verdict: 'used' },
        { id: '2', rel: 'b.css', line: 2, selector: '.card', scope: 'global', verdict: 'used' },
      ],
      notes: [],
      files: [],
    },
    classNames: ['card', 'utility'],
    assets: {
      missing: false,
      entries: [
        { rel: 'images/a.png', name: 'a.png', parent: '', root: 'public', isDir: false, size: 1, abs: '/site/public/images/a.png' },
        { rel: 'x.txt', name: 'x.txt', parent: '', root: 'public', isDir: false, size: 1, abs: '/site/public/x.txt' },
      ],
    },
  });
  assert.deepEqual(index.pages, [{ path: 'src/pages/index.astro', route: '/' }]);
  assert.deepEqual(index.variables, [{ name: '--brand-1', path: 'src/styles/global.css', color: '#f00', group: undefined }]);
  assert.deepEqual(index.classes, [
    { name: 'card', path: 'src/styles/global.css', rules: 2 },
    { name: 'card-title', path: 'src/styles/global.css', rules: 1 },
    { name: 'utility', path: undefined, rules: 0 },
  ]);
  assert.deepEqual(
    index.assets.map((asset) => [asset.path, asset.kind]),
    [['public/images/a.png', 'image']],
    'a text file is not an asset',
  );
});

test('picking a variable, a class and an asset inserts chips that send only their reference', async () => {
  model.setMentionComponents(model.mentionComponentsOf([], PROJECT));
  model.setMentionIndexSource({ read: () => projectIndex, refresh: () => undefined });
  const record = await mount();
  await typeText(record, '@brand');
  await untilRow('--brand-1');
  await act(async () => void press(record.view, 'Enter'));
  await untilPills(1);
  await typeText(record, '@button-pri');
  await untilRow('.button-primary');
  await act(async () => void press(record.view, 'Enter'));
  await untilPills(2);
  await typeText(record, '@intro');
  await untilRow('intro.mp4');
  await act(async () => void press(record.view, 'Enter'));
  await untilPills(3);
  assert.equal(
    model.plainTextOf(record.segments),
    'css:var(--brand-1) (src/styles/global.css) css:.button-primary (src/styles/global.css) asset:public/videos/intro.mp4 ',
  );
  model.setMentionIndexSource(undefined);
});

test('the picker keeps one height whatever it holds, opens on the bottom row, and switches tabs from the keyboard', async () => {
  model.setMentionComponents(model.mentionComponentsOf([], PROJECT));
  model.setMentionIndexSource({ read: () => projectIndex, refresh: () => undefined });
  const record = await mount();
  await typeText(record, '@b');
  await untilRow('--brand-1');
  const picker = () => document.querySelector('.chip-picker');
  const height = picker().style.height;
  assert.equal(height, `${model.CHIP_PICKER_HEIGHT_PX}px`);
  const selected = () => document.querySelector('.chip-picker-option[aria-selected="true"] .chip-picker-label').textContent;
  assert.equal(selected(), rowsOf()[0], 'the top row, the best match, is highlighted');
  assert.equal(document.querySelector('.chip-picker-option[aria-selected="true"]').id.endsWith('-option-0'), true);
  await typeText(record, 'zzzz');
  await waitUntil('nothing matches', () => rowsOf().length === 0);
  assert.equal(picker().style.height, height, 'an empty list keeps the height');
  assert.ok(document.querySelector('.chip-picker-empty'), 'the empty state is drawn inside the same box');
  for (let index = 0; index < 4; index += 1) {
    await act(async () => void press(record.view, 'Backspace'));
  }
  await untilRow('--brand-1');
  await act(async () => void press(record.view, ']', { ctrlKey: true }));
  await waitUntil('the Components tab is on', () => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.startsWith('Components'));
  await act(async () => void press(record.view, '[', { ctrlKey: true }));
  await waitUntil('back on All', () => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.startsWith('All'));
  const variables = [...document.querySelectorAll('[role="tab"]')].find((element) => element.textContent.startsWith('Variables'));
  await act(async () => variables.click());
  await waitUntil('only variables', () => rowsOf().length > 0 && rowsOf().every((label) => label.startsWith('--')));
  assert.ok(record.view.hasFocus, 'a tab click leaves the caret in the composer');
  await act(async () => [...document.querySelectorAll('[role="tab"]')].find((element) => element.textContent.startsWith('All')).click());
  model.setMentionIndexSource(undefined);
});

test('no flicker: between keystrokes the last answer stays, narrowed; a late answer to an older query is dropped', async () => {
  const pending = [];
  const search = (query) =>
    new Promise((resolve) => {
      pending.push({ query, resolve });
    });
  const candidate = (name) => ({ kind: 'file', path: `docs/${name}`, name });
  model.setMentionComponents(model.mentionComponentsOf([], PROJECT));
  const record = await mount({ search });
  await typeText(record, '@g');
  // Answers come back for whichever queries were asked; only the one for what is typed now counts.
  const answer = (query, names) =>
    pending.filter((entry) => entry.query === query).forEach((entry) => entry.resolve({ ok: true, value: names.map(candidate) }));
  await waitUntil('the search for g is asked', () => pending.some((entry) => entry.query === 'g'));
  await act(async () => answer('g', ['guide.md', 'gallery.md']));
  await untilRow('guide.md');
  const seen = [];
  const observer = new dom.window.MutationObserver(() => seen.push(rowsOf()));
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  await typeText(record, 'u');
  // Before the answer to "gu" lands, the list still shows what matched "g" and still matches "gu".
  assert.deepEqual(rowsOf(), ['guide.md']);
  await waitUntil('the search for gu is asked (and held)', () => pending.some((entry) => entry.query === 'gu'));
  await typeText(record, 'i');
  await waitUntil('the search for gui is asked', () => pending.some((entry) => entry.query === 'gui'));
  await act(async () => answer('gui', ['guide.md']));
  // A late answer to "gu" (an older query) must not replace it.
  await act(async () => answer('gu', ['gulp.md']));
  await settle();
  observer.disconnect();
  assert.deepEqual(rowsOf(), ['guide.md'], 'the older answer is ignored');
  assert.ok(
    seen.every((rows) => rows.length > 0),
    'the list never emptied between keystrokes',
  );
  assert.deepEqual(model.stillMatching([candidate('guide.md'), candidate('gallery.md')], 'gu'), [candidate('guide.md')]);
});

test('image rows ask for no thumbnail while they are not known to be on screen', async () => {
  let made = 0;
  global.createImageBitmap = async () => {
    made += 1;
    throw new Error('not in this test');
  };
  model.setMentionIndexSource({ read: () => projectIndex, refresh: () => undefined });
  const record = await mount();
  await typeText(record, '@button');
  await untilRow('button.png');
  assert.ok(document.querySelector('.mention-row-thumb'), 'the image row has its thumbnail box');
  assert.equal(document.querySelector('.mention-row-thumb img') ?? undefined, undefined, 'no picture is loaded');
  assert.equal(made, 0, 'no small copy was asked for');
  delete global.createImageBitmap;
  model.setMentionIndexSource(undefined);
  assert.ok(record.view);
});

test('the ranking: exact, then prefix, then a word start, then anywhere, then the path; and the picker’s look', () => {
  const row = (label, description) => ({ id: label, label, description, group: 'g', chip: { kind: 'file', path: 'a', name: 'a' } });
  assert.deepEqual(
    ['button', 'buttons', 'icon-button', 'xbuttonx', 'card'].map((label) =>
      model.rowRank(row(label, label === 'card' ? 'src/button/card.astro' : undefined), 'button'),
    ),
    [0, 1, 2, 3, 4],
  );
  assert.equal(model.rowRank(row('--brand'), 'brand'), 0, 'a sigil is ignored');
  // The stylesheet: no fade on the tab bar, its own fill, compact one-line rows.
  const css = fs.readFileSync(repoPath('src/ui/chipEditor/chipEditor.css'), 'utf8');
  const tabs = css.slice(css.indexOf('.chip-picker-tabs {'), css.indexOf('}', css.indexOf('.chip-picker-tabs {')));
  assert.ok(!/mask-image|gradient/u.test(css.slice(css.indexOf('.chip-picker {'))), 'no mask or gradient anywhere in the picker');
  assert.match(tabs, /background: rgba\(0, 0, 0, 0\.28\)/u, 'the tab bar sits on its own darker fill');
  const option = css.slice(css.indexOf('.chip-picker-option {'), css.indexOf('}', css.indexOf('.chip-picker-option {')));
  assert.match(option, /height: 32px/u);
  assert.match(css, /\.chip-picker-tabs \.ui-tab\.on \{\s*color: #fff;/u);
});

// ---------------------------------------------------------------------------
// CSS chips: their look, and swapping one for a related class or variable
// ---------------------------------------------------------------------------

test('one table says each chip’s colour and icon: classes blue with the brush, variables purple with the swatches', () => {
  assert.equal(model.chipStyleOf({ kind: 'css', target: 'class', name: 'button', path: undefined }), 'class');
  assert.equal(model.chipStyleOf({ kind: 'css', target: 'variable', name: '--brand-1', path: undefined }), 'variable');
  assert.equal(model.CHIP_STYLE_COLOURS.class, 'blue');
  assert.equal(model.CHIP_STYLE_COLOURS.variable, 'purple');
  assert.equal(model.CHIP_STYLE_COLOURS.component, 'green');
  assert.equal(model.CHIP_STYLE_ICONS.class, model.PaintBrushIcon);
  assert.equal(model.CHIP_STYLE_ICONS.variable, model.VariableIcon);
  for (const style of model.CHIP_STYLES) {
    assert.ok(model.CHIP_STYLE_ICONS[style], `${style} has an icon`);
    assert.ok(model.CHIP_STYLE_COLOURS[style], `${style} has a colour`);
  }
  const css = fs.readFileSync(repoPath('src/features/ai/mentions/mentions.css'), 'utf8');
  assert.match(css, /\[data-chip-kind='class'\] \{\s*background: var\(--accent/u, 'a class chip is the class tag’s blue');
});

const swapIndex = {
  pages: [],
  assets: [],
  classes: [
    { name: 'card', path: 'src/styles/global.css', rules: 1 },
    { name: 'text-style-h1', path: 'src/styles/type.css', rules: 1 },
    { name: 'text-style-h3', path: 'src/styles/type.css', rules: 1 },
    { name: 'lead', path: 'src/styles/type.css', rules: 1 },
    { name: 'text-style-h6', path: 'src/styles/type.css', rules: 1 },
  ],
  variables: [
    { name: '--space-1', path: 'src/styles/global.css', color: undefined, group: 'Space' },
    { name: '--brand-1', path: 'src/styles/global.css', color: '#f06', group: 'Brand' },
    { name: '--accent', path: 'src/styles/global.css', color: '#09f', group: 'Brand' },
    { name: '--brand-2', path: 'src/styles/global.css', color: '#60f', group: 'Brand' },
  ],
};

test('related classes: the chip’s own first, its family, then its stylesheet, then the rest; one current', () => {
  const items = model.relatedItems(swapIndex, { kind: 'css', target: 'class', name: 'text-style-h3', path: 'src/styles/type.css' });
  assert.deepEqual(
    items.map((item) => item.label),
    ['.text-style-h3', '.text-style-h1', '.text-style-h6', '.lead', '.card'],
  );
  assert.deepEqual(
    items.map((item) => item.current),
    [true, false, false, false, false],
  );
  const button = model.relatedItems(
    {
      ...swapIndex,
      classes: [
        { name: 'buttons-row', path: 'a.css', rules: 1 },
        { name: 'card', path: 'a.css', rules: 1 },
        { name: 'button', path: 'a.css', rules: 1 },
      ],
    },
    { kind: 'css', target: 'class', name: 'button', path: 'a.css' },
  );
  assert.deepEqual(
    button.map((item) => item.label),
    ['.button', '.buttons-row', '.card'],
    'a name with no dash is its own family',
  );
});

test('related variables: family, then the same Variables group, then the rest; a chip the index lost still has its row', () => {
  const items = model.relatedItems(swapIndex, { kind: 'css', target: 'variable', name: '--brand-1', path: 'src/styles/global.css' });
  assert.deepEqual(
    items.map((item) => item.label),
    ['--brand-1', '--brand-2', '--accent', '--space-1'],
  );
  assert.equal(items[1].color, '#60f', 'a colour variable carries its swatch');
  const lost = model.relatedItems(swapIndex, { kind: 'css', target: 'variable', name: '--gone', path: 'src/styles/global.css' });
  assert.equal(lost[0].label, '--gone');
  assert.equal(lost[0].current, true);
});

test('clicking a class chip swaps it for a related class in place, the text around it kept, one undo step', async () => {
  model.setMentionComponents(model.mentionComponentsOf([], PROJECT));
  model.setMentionIndexSource({ read: () => swapIndex, refresh: () => undefined });
  const record = await mount();
  const start = [text('Use '), chip({ kind: 'css', target: 'class', name: 'text-style-h3', path: 'src/styles/type.css' }), text(' for titles')];
  record.segments = start;
  await act(async () => record.set(start));
  await untilPills(1);
  const caret = record.view.state.selection.main.head;
  await clickPill(0);
  const list = () => document.querySelector('.related-css');
  await waitUntil('the swap list opens', () => list() !== null);
  assert.equal(list().querySelector('[aria-selected="true"] .related-css-label').textContent, '.text-style-h3', 'the current one is highlighted');
  assert.ok(list().querySelector('.related-css-check svg'), 'and checked');
  const target = [...list().querySelectorAll('.related-css-row')].find((row) => row.textContent.includes('.text-style-h1'));
  await act(async () => target.click());
  await waitUntil('the chip is swapped', () => model.plainTextOf(record.segments).includes('text-style-h1'));
  assert.equal(model.plainTextOf(record.segments), 'Use css:.text-style-h1 (src/styles/type.css) for titles');
  assert.equal(list() ?? undefined, undefined, 'the list closes');
  assert.ok(record.view.hasFocus, 'the editor has its caret back');
  assert.equal(record.view.state.selection.main.head, caret, 'where it was');
  await act(async () => void record.view.contentDOM.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true })));
  await waitUntil('undo brings back the first class', () => model.plainTextOf(record.segments).includes('text-style-h3'));
  // The keyboard: open, move down, Enter.
  await clickPill(0);
  await waitUntil('the swap list opens again', () => list() !== null);
  await act(
    async () =>
      void list()
        .querySelector('[role="listbox"]')
        .dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })),
  );
  await act(
    async () =>
      void list()
        .querySelector('[role="listbox"]')
        .dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
  );
  await waitUntil('the next one is taken', () => model.plainTextOf(record.segments).includes('text-style-h1'));
  model.setMentionIndexSource(undefined);
});

test('the swap list puts the caret in its search field, and a press back in the text closes it without taking the press', async () => {
  const many = {
    ...swapIndex,
    classes: Array.from({ length: 12 }, (_, index) => ({ name: `text-style-h${index}`, path: 'src/styles/type.css', rules: 1 })),
  };
  model.setMentionComponents(model.mentionComponentsOf([], PROJECT));
  model.setMentionIndexSource({ read: () => many, refresh: () => undefined });
  const record = await mount();
  const start = [text('Use '), chip({ kind: 'css', target: 'class', name: 'text-style-h3', path: 'src/styles/type.css' }), text(' for titles')];
  record.segments = start;
  await act(async () => record.set(start));
  await untilPills(1);
  const list = () => document.querySelector('.related-css') ?? undefined;
  await clickPill(0);
  await waitUntil('the swap list opens', () => list() !== undefined);
  const search = list().querySelector('.related-css-search');
  await waitUntil('the search field has the caret', () => document.activeElement === search);
  // Arrow keys and Enter still work from the field.
  await act(async () => void search.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })));
  assert.equal(list().querySelector('[aria-selected="true"]').dataset.relatedIndex, '1');
  // A press on the prompt text: the list closes, and the press is left to place the caret.
  let reached = false;
  const reach = () => {
    reached = true;
  };
  record.view.dom.addEventListener('mousedown', reach);
  const press = new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true });
  await act(async () => void record.view.contentDOM.querySelector('.cm-line').dispatchEvent(press));
  await waitUntil('the list closes', () => list() === undefined);
  record.view.dom.removeEventListener('mousedown', reach);
  // The editor's own handler takes the press (it places the caret, and prevents the browser's default as it always does).
  assert.ok(reached, 'the press reached the editor: nothing stopped it on the way');
  assert.equal(model.plainTextOf(record.segments), 'Use css:.text-style-h3 (src/styles/type.css) for titles', 'nothing was picked');
  // Escape gives the editor its caret back right after the chip.
  await clickPill(0);
  await waitUntil('the swap list opens again', () => list() !== undefined);
  await act(async () => void document.activeElement.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await waitUntil('Escape closes it', () => list() === undefined);
  assert.ok(record.view.hasFocus);
  assert.equal(record.view.state.selection.main.head, 'Use '.length + 1, 'the caret sits right after the chip');
  model.setMentionIndexSource(undefined);
});
