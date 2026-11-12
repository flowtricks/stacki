// Goal: the sessions list does what it shows. Chats sit under named sections that fold away, pinned first, with a
// quiet dot for unread and a loader for running; the hovered row's "⋯" and a right click open the chat's menu, whose
// letters (P pin, U unread, R rename, F fork, A archive, D delete) work while it is open and on a focused row;
// rename is in place (Enter commits, Escape cancels, empty and over-long names change nothing); delete asks first
// with Stacki's own dialog and says it cannot be undone; archived chats hide until the filter shows them and then
// restore; a drag (or Alt+Arrow) reorders inside a section and between sections through ai:chatMove, with pinned
// chats held at the top of their section, no drop into a folded section, and no dragging while a search is on;
// the open chat's header renames, offers the same menu and returns to the list.
// Method: part 1 runs the pure model (sessionsModel.ts) over fixed cases and seeded random drops. Part 2 bundles the
// real view, header, store and Stacki's confirm host with esbuild and mounts them in jsdom against a fake preload
// (window.avb) whose "main process" is the REAL list logic of electron/handlers/ai/chatStore.ts, so every move,
// pin, archive and section change comes back exactly as main would answer it. jsdom has no layout: row and
// section boxes are stubbed as stacked 30px rows for the pointer drag.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/sessions.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "import { createElement, Fragment } from 'react';",
      "import { SessionsView } from './src/features/ai/sessions/SessionsView';",
      "import { ChatHeader } from './src/features/ai/sessions/ChatHeader';",
      "import { ConfirmHost } from './src/ui/ConfirmDialog';",
      "import { useAiState } from './src/features/ai/aiStore';",
      "export * from './src/features/ai/sessions/sessionsModel';",
      "export { aiState, resetAiStore, loadAiProject, openChat, receiveEvents, setChatListFilter, DEFAULT_CHAT_FILTER } from './src/features/ai/aiStore';",
      "export * as chatStore from './electron/handlers/ai/chatStore';",
      "export { applyMove, resolveDrop } from './src/ui/sectionedDragModel';",
      'export function ListHarness() {',
      '  const state = useAiState();',
      '  return createElement(Fragment, null, createElement(ConfirmHost), createElement(SessionsView, { chats: state.chats }));',
      '}',
      'export function HeaderHarness() {',
      '  const state = useAiState();',
      '  const chat = state.open === undefined ? undefined : state.chats.find((candidate) => candidate.id === state.open);',
      '  return createElement(Fragment, null, createElement(ConfirmHost), createElement(ChatHeader, { chat }));',
      '}',
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
global.requestAnimationFrame = dom.window.requestAnimationFrame;
global.cancelAnimationFrame = (handle) => clearTimeout(handle);
global.ResizeObserver = class {
  observe() {}
  disconnect() {}
};
dom.window.HTMLElement.prototype.scrollTo = function () {};
dom.window.HTMLElement.prototype.scrollIntoView = function () {};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const sessions = require(output);
const { chatStore } = sessions;

const PROJECT = '/site';
const hex = (digit, length) => digit.repeat(length);
const chatId = (digit) => `c${hex(digit, 24)}`;
const sectionId = (digit) => `s${hex(digit, 16)}`;
const TURN = `t${'1'.repeat(16)}`;

// --- Part 1: the pure model -------------------------------------------------

function chat(digit, over = {}) {
  return {
    id: chatId(digit),
    agent: 'claude',
    title: `Chat ${digit}`,
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
    section: undefined,
    rank: 0,
    archivedAt: undefined,
    unread: false,
    context: undefined,
    forkOf: undefined,
    ...over,
  };
}
const section = (digit, name, rank, collapsed = false) => ({ id: sectionId(digit), name, collapsed, rank });
const plain = sessions.DEFAULT_CHAT_FILTER;

test('groups: the unsectioned chats first, then each section by rank, pinned first and then by rank', () => {
  const chats = [
    chat('a', { rank: 1 }),
    chat('b', { rank: 0 }),
    chat('c', { section: sectionId('2'), rank: 0 }),
    chat('d', { section: sectionId('1'), rank: 1, pinned: true }),
    chat('e', { section: sectionId('1'), rank: 0 }),
    chat('f', { section: sectionId('9'), rank: 2 }),
  ];
  const { groups } = sessions.groupSessions(chats, [section('2', 'Second', 1), section('1', 'First', 0)], plain);
  assert.deepEqual(
    groups.map((group) => [group.key, group.chats.map((entry) => entry.title)]),
    [
      ['none', ['Chat b', 'Chat a', 'Chat f']],
      [sectionId('1'), ['Chat d', 'Chat e']],
      [sectionId('2'), ['Chat c']],
    ],
    'a chat in a section that does not exist falls into the first, unsectioned one',
  );
});

test('groups: a search or filter hides empty sections and opens folded ones; archived chats show only when asked', () => {
  const chats = [
    chat('a', { title: 'Fix the hero', section: sectionId('1') }),
    chat('b', { title: 'Hero art', section: sectionId('2'), unread: true }),
    chat('c', { title: 'Other', archivedAt: 5 }),
  ];
  const sections = [section('1', 'One', 0, true), section('2', 'Two', 1)];
  const all = sessions.groupSessions(chats, sections, plain);
  assert.equal(all.groups.length, 3, 'every section is listed, empty or not');
  assert.equal(all.groups[1].collapsed, true, 'folded stays folded');
  assert.deepEqual(all.archived, [], 'archived chats stay out unless asked for');
  const searched = sessions.groupSessions(chats, sections, { ...plain, query: 'hero' });
  assert.deepEqual(
    searched.groups.map((group) => group.key),
    [sectionId('1'), sectionId('2')],
    'sections with nothing to show are gone',
  );
  assert.equal(searched.groups[0].collapsed, false, 'a folded section that has a match opens while searching');
  assert.deepEqual(
    sessions.groupSessions(chats, sections, { ...plain, onlyUnread: true }).groups.map((group) => group.chats.map((entry) => entry.title)),
    [['Hero art']],
  );
  assert.equal(sessions.groupSessions(chats, sections, { ...plain, agent: 'codex' }).groups.length, 0);
  const withArchived = sessions.groupSessions(chats, sections, { ...plain, showArchived: true });
  assert.deepEqual(
    withArchived.archived.map((entry) => entry.title),
    ['Other'],
  );
  assert.equal(
    withArchived.groups.flatMap((group) => group.chats).some((entry) => entry.archivedAt !== undefined),
    false,
    'an archived chat is never in a section',
  );
});

test('narrowing and custom filters are told apart', () => {
  assert.equal(sessions.isNarrowing(plain), false);
  assert.equal(sessions.isNarrowing({ ...plain, query: '  ' }), false, 'blank spaces are no search');
  assert.equal(sessions.isNarrowing({ ...plain, query: 'x' }), true);
  assert.equal(sessions.isNarrowing({ ...plain, showArchived: true }), false);
  assert.equal(sessions.isCustomFilter({ ...plain, showArchived: true }), true);
  assert.equal(sessions.isCustomFilter(plain), false);
  assert.equal(sessions.isCustomFilter({ ...plain, query: 'x' }), false, 'a search has its own field');
  assert.equal(sessions.isCustomFilter({ ...plain, agent: 'codex' }), true);
});

const dragSections = (...lists) => lists.map((ids, index) => ({ id: index === 0 ? 'none' : sectionId(String(index)), collapsed: false, itemIds: ids }));

test('lockPinned: a pinned chat stops above the first unpinned one, an unpinned one below the last pinned', () => {
  const sections = dragSections(['p1', 'p2', 'u1', 'u2']);
  const pinned = new Set(['p1', 'p2']);
  // A pinned chat dropped among or after the unpinned ones lands at the boundary.
  assert.deepEqual(sessions.lockPinned(sections, pinned, 'p1', { sectionId: 'none', beforeId: undefined }), { sectionId: 'none', beforeId: 'u1' });
  assert.deepEqual(sessions.lockPinned(sections, pinned, 'p1', { sectionId: 'none', beforeId: 'u2' }), { sectionId: 'none', beforeId: 'u1' });
  assert.deepEqual(
    sessions.lockPinned(sections, pinned, 'p1', { sectionId: 'none', beforeId: 'p2' }),
    { sectionId: 'none', beforeId: 'p2' },
    'among the pinned is free',
  );
  // An unpinned chat dropped among the pinned ones lands at the boundary too.
  assert.deepEqual(sessions.lockPinned(sections, pinned, 'u2', { sectionId: 'none', beforeId: 'p1' }), { sectionId: 'none', beforeId: 'u1' });
  assert.deepEqual(sessions.lockPinned(sections, pinned, 'u2', { sectionId: 'none', beforeId: 'p2' }), { sectionId: 'none', beforeId: 'u1' });
  assert.deepEqual(sessions.lockPinned(sections, pinned, 'u2', { sectionId: 'none', beforeId: 'u1' }), { sectionId: 'none', beforeId: 'u1' });
});

test('lockPinned: into another section, an empty one, all-pinned, and targets it does not know', () => {
  const sections = dragSections(['u1'], ['p1', 'u2'], []);
  const pinned = new Set(['p1']);
  assert.deepEqual(sessions.lockPinned(sections, pinned, 'u1', { sectionId: sectionId('1'), beforeId: 'p1' }), { sectionId: sectionId('1'), beforeId: 'u2' });
  assert.deepEqual(sessions.lockPinned(sections, new Set(['u1']), 'u1', { sectionId: sectionId('2'), beforeId: undefined }), {
    sectionId: sectionId('2'),
    beforeId: undefined,
  });
  const allPinned = dragSections(['x'], ['p1', 'p2']);
  assert.deepEqual(sessions.lockPinned(allPinned, new Set(['p1', 'p2']), 'x', { sectionId: sectionId('1'), beforeId: undefined }), {
    sectionId: sectionId('1'),
    beforeId: undefined,
  });
  const unknownSection = { sectionId: 'nowhere', beforeId: undefined };
  assert.deepEqual(sessions.lockPinned(sections, pinned, 'u1', unknownSection), unknownSection);
  const unknownAnchor = { sectionId: 'none', beforeId: 'ghost' };
  assert.deepEqual(sessions.lockPinned(sections, pinned, 'u1', unknownAnchor), unknownAnchor);
});

test('lockPinned: after any drop the pinned chats are still first in every section (seeded random)', () => {
  const { applyMove, resolveDrop } = sessions;
  let seed = 7;
  const random = (limit) => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed % limit;
  };
  for (let round = 0; round < 300; round += 1) {
    const ids = Array.from({ length: 8 }, (_, index) => `i${index}`);
    const pinned = new Set(ids.filter((id) => random(3) === 0));
    const first = ids.filter((id) => pinned.has(id)).concat(ids.filter((id) => !pinned.has(id)));
    const cut = random(first.length + 1);
    let sections = [
      { id: 'none', collapsed: false, itemIds: first.slice(0, cut) },
      { id: sectionId('1'), collapsed: false, itemIds: first.slice(cut) },
    ];
    // Each section keeps pinned first: re-sort after the cut.
    sections = sections.map((entry) => ({
      ...entry,
      itemIds: [...entry.itemIds.filter((id) => pinned.has(id)), ...entry.itemIds.filter((id) => !pinned.has(id))],
    }));
    const item = ids[random(ids.length)];
    const destination = sections[random(2)];
    const others = destination.itemIds.filter((id) => id !== item);
    const beforeId = random(others.length + 1) === others.length ? undefined : others[random(others.length)];
    const locked = sessions.lockPinned(sections, pinned, item, { sectionId: destination.id, beforeId });
    const decision = resolveDrop(sections, item, locked);
    if (decision.kind !== 'move') {
      continue;
    }
    for (const result of applyMove(sections, decision.move)) {
      const flags = result.itemIds.map((id) => pinned.has(id));
      assert.deepEqual(
        flags,
        [...flags].sort((left, right) => Number(right) - Number(left)),
        `pinned stay first: ${result.itemIds.join(',')}`,
      );
    }
  }
});

test('rows answer to P U R F A D with no modifier and nothing else', () => {
  const press = (key, init = {}) => sessions.rowShortcut({ key, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...init });
  assert.deepEqual(
    ['p', 'u', 'r', 'f', 'a', 'd'].map((key) => press(key)),
    ['pin', 'unread', 'rename', 'fork', 'archive', 'delete'],
  );
  assert.equal(press('P'), 'pin', 'case does not matter');
  assert.equal(press('x'), undefined);
  assert.equal(press('Enter'), undefined);
  assert.equal(press('p', { metaKey: true }), undefined, 'Cmd+P is the app’s');
  assert.equal(press('d', { ctrlKey: true }), undefined);
  assert.equal(press('a', { altKey: true }), undefined);
  assert.equal(press('d', { shiftKey: true }), undefined);
});

test('names: trimmed, not empty, bounded', () => {
  assert.deepEqual(sessions.checkName('  Hero  ', 10), { kind: 'ok', name: 'Hero' });
  assert.deepEqual(sessions.checkName('   ', 10), { kind: 'empty' });
  assert.deepEqual(sessions.checkName('', 10), { kind: 'empty' });
  assert.deepEqual(sessions.checkName('x'.repeat(10), 10), { kind: 'ok', name: 'x'.repeat(10) });
  assert.deepEqual(sessions.checkName('x'.repeat(11), 10), { kind: 'too-long', limit: 10 });
  assert.throws(() => sessions.checkName('x', 0), /limit is positive/);
});

test('a new section’s default name never repeats one, ignoring case', () => {
  assert.equal(sessions.uniqueSectionName([], 'New section'), 'New section');
  assert.equal(sessions.uniqueSectionName(['New section'], 'New section'), 'New section 2');
  assert.equal(sessions.uniqueSectionName(['new SECTION', 'New section 2'], 'New section'), 'New section 3');
  assert.equal(sessions.uniqueSectionName(['Ideas'], 'New section'), 'New section');
});

test('Move up and Move down name the section to go before, and nothing at the ends', () => {
  const sections = [section('1', 'A', 0), section('2', 'B', 1), section('3', 'C', 2)];
  assert.equal(sessions.sectionStep(sections, sectionId('1'), 'up'), undefined);
  assert.deepEqual(sessions.sectionStep(sections, sectionId('2'), 'up'), { before: sectionId('1') });
  assert.deepEqual(sessions.sectionStep(sections, sectionId('1'), 'down'), { before: sectionId('3') });
  assert.deepEqual(sessions.sectionStep(sections, sectionId('2'), 'down'), { before: undefined }, 'down from the one before last goes last');
  assert.equal(sessions.sectionStep(sections, sectionId('3'), 'down'), undefined);
  assert.equal(sessions.sectionStep(sections, sectionId('9'), 'up'), undefined);
});

test('ages and context are written short', () => {
  const now = 10_000_000_000;
  assert.equal(sessions.ageLabel(now - 5_000, now), 'now');
  assert.equal(sessions.ageLabel(now - 5 * 60_000, now), '5m');
  assert.equal(sessions.ageLabel(now - 3 * 3_600_000, now), '3h');
  assert.equal(sessions.ageLabel(now - 2 * 86_400_000, now), '2d');
  assert.equal(sessions.ageLabel(now + 99_000, now), 'now', 'a clock that ran ahead never reads negative');
  assert.equal(sessions.contextSummary({ used: 41_250, size: 1_000_000 }), '41k of 1M tokens');
  assert.equal(sessions.contextSummary({ used: 900, size: 200_000 }), '900 of 200k tokens');
  assert.equal(sessions.contextSummary({ used: 1, size: 0 }), undefined);
  assert.equal(sessions.contextSummary(undefined), undefined);
});

// --- Part 2: the view in jsdom ----------------------------------------------

function record(digit, over = {}) {
  return { ...chat(digit), sessionId: undefined, settings: [], ...over };
}

// The fixture list: two unsectioned chats (one pinned), "Apps" with a pinned chat first, "Ideas" with a running
// one, and a folded "Old" section.
function fixtureIndex() {
  return chatStore.normalizeIndex({
    version: 2,
    trusted: true,
    sections: [section('1', 'Apps', 0), section('2', 'Ideas', 1), section('3', 'Old', 2, true)],
    chats: [
      record('a', { title: 'Fix the header', pinned: true, rank: 0, updatedAt: 3_000 }),
      record('b', { title: 'Plan the launch', rank: 1, unread: true, updatedAt: 2_000 }),
      record('c', { title: 'Pinned app chat', section: sectionId('1'), pinned: true, rank: 0 }),
      record('d', { title: 'App store flow', section: sectionId('1'), rank: 1 }),
      record('e', { title: 'Lumos rem pass', section: sectionId('1'), rank: 2 }),
      record('f', { title: 'Sidebar idea', section: sectionId('2'), rank: 0 }),
      record('7', { title: 'Running experiment', section: sectionId('2'), rank: 1 }),
      record('8', { title: 'Old thing', section: sectionId('3'), rank: 0 }),
    ],
  });
}

// A fake preload whose main process is chatStore's real list logic.
function installMain(initial = fixtureIndex()) {
  const calls = [];
  let index = initial;
  let counter = 0;
  const settle = (result) => {
    if (!result.ok) {
      return result;
    }
    index = chatStore.normalizeIndex(result.value);
    return { ok: true, value: chatStore.listOf(index) };
  };
  const record_ = (name, reply) => async (payload) => {
    calls.push({ name, payload });
    return reply(payload);
  };
  const summaryOf = (id) => chatStore.summaryOf(index.chats.find((entry) => entry.id === id));
  window.avb = {
    aiAgents: record_('aiAgents', () => ({
      trusted: true,
      agents: [{ agent: 'claude', state: 'ready', adapterVersion: '1.0.0', running: false, downloadMegabytes: 1 }],
      options: [],
    })),
    aiChats: record_('aiChats', () => chatStore.listOf(index)),
    aiChatCreate: record_('aiChatCreate', () => ({ ok: true, value: summaryOf(chatId('a')) })),
    aiChatRead: record_('aiChatRead', (payload) => ({ ok: true, value: { summary: summaryOf(payload.chat), events: [], full: false } })),
    aiChatDelete: record_('aiChatDelete', (payload) => {
      index = chatStore.normalizeIndex({ ...index, chats: index.chats.filter((entry) => entry.id !== payload.chat) });
      return { ok: true };
    }),
    aiChatUpdate: record_('aiChatUpdate', (payload) => {
      let result = { ok: true, value: index };
      if (payload.title !== undefined) {
        result = chatStore.updateChat(index, payload.chat, (entry) => ({ ...entry, title: payload.title }));
      }
      if (result.ok && payload.pinned !== undefined) {
        result = chatStore.setPinned(result.value, payload.chat, { pinned: payload.pinned });
      }
      if (result.ok && payload.archived !== undefined) {
        result = chatStore.setArchived(result.value, payload.chat, payload.archived ? 5_000 : undefined);
      }
      if (result.ok && payload.unread !== undefined) {
        result = chatStore.setUnread(result.value, payload.chat, { unread: payload.unread });
      }
      settle(result);
      return { ok: true, value: summaryOf(payload.chat) };
    }),
    aiChatFork: record_('aiChatFork', (payload) => {
      counter += 1;
      const forked = chatStore.forkRecord(index, payload.chat, chatId(String(counter)), 9_000);
      if (!forked.ok) {
        return forked;
      }
      index = forked.value.index;
      return { ok: true, value: chatStore.summaryOf(forked.value.record) };
    }),
    aiChatMove: record_('aiChatMove', (payload) => settle(chatStore.moveChat(index, payload.chat, payload.section, payload.before))),
    aiSections: record_('aiSections', (payload) => {
      const { action } = payload;
      switch (action.kind) {
        case 'create':
          counter += 1;
          return settle(chatStore.createSection(index, sectionId(String(counter + 4)), action.name));
        case 'rename':
          return settle(chatStore.renameSection(index, action.section, action.name));
        case 'delete':
          return settle(chatStore.deleteSection(index, action.section));
        case 'collapse':
          return settle(chatStore.collapseSection(index, action.section, { collapsed: action.collapsed }));
        case 'move':
          return settle(chatStore.moveSection(index, action.section, action.before));
        default:
          throw new Error('unknown section action');
      }
    }),
    aiAck: () => undefined,
    onAiEvents: () => () => undefined,
    onAiAgentStatus: () => () => undefined,
    onAiSetup: () => () => undefined,
  };
  return {
    calls,
    named: (name) => calls.filter((call) => call.name === name),
    list: () => chatStore.listOf(index),
  };
}

// A row's words in reading order, one space between its parts (label, current value, shortcut).
const rowText = (row) =>
  [...row.querySelectorAll('*')]
    .filter((element) => element.children.length === 0 && element.textContent.trim() !== '')
    .map((element) => element.textContent.trim())
    .join(' ');

const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));
async function settleUi() {
  await act(async () => {
    for (let round = 0; round < 6; round += 1) {
      await wait(2);
    }
  });
}

async function mountView(harness, index) {
  sessions.resetAiStore();
  window.localStorage.clear();
  const main = installMain(index);
  await sessions.loadAiProject(PROJECT);
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(sessions[harness])));
  await settleUi();
  const click = async (element) => {
    await act(async () => {
      element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    });
    await settleUi();
  };
  const press = async (element, init) => {
    await act(async () => {
      element.dispatchEvent(new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
    });
    await settleUi();
  };
  const unmount = async () => {
    await act(async () => root.unmount());
    container.remove();
    document.body.innerHTML = '';
  };
  const titles = (selector = '.ai-list-title') => [...container.querySelectorAll(selector)].map((element) => element.textContent);
  const sectionOf = (name) => [...container.querySelectorAll('.ai-section')].find((element) => element.querySelector('.ai-section-name')?.textContent === name);
  const rowOf = (title) => [...container.querySelectorAll('.ai-list-row')].find((element) => element.querySelector('.ai-list-title')?.textContent === title);
  const menuRows = () => [...document.querySelectorAll('[role="menu"] [role^="menuitem"]')];
  const menuTexts = () => menuRows().map(rowText);
  const menuRow = (label) => menuRows().find((element) => element.textContent.startsWith(label));
  const confirmButton = (label) => [...document.querySelectorAll('.confirm-dialog button')].find((element) => element.textContent === label);
  return { container, main, click, press, unmount, titles, sectionOf, rowOf, menuRows, menuTexts, menuRow, confirmButton };
}

const FIX = chatId('a');

test('the list shows the sections with their chats, pinned first, a dot for unread, a loader for running, and no loading word', async () => {
  const view = await mountView('ListHarness');
  // The chat was opened once, so the store follows its turn after the person went back to the list.
  await act(async () => sessions.openChat(chatId('7')));
  await act(async () => sessions.openChat(undefined));
  sessions.receiveEvents({ projectPath: PROJECT, chat: chatId('7'), events: [{ kind: 'turn-start', turn: TURN, at: 1 }] });
  await settleUi();
  assert.deepEqual(
    [...view.container.querySelectorAll('.ai-section-name')].map((element) => element.textContent),
    ['No section', 'Apps', 'Ideas', 'Old'],
  );
  assert.deepEqual(view.titles(), [
    'Fix the header',
    'Plan the launch',
    'Pinned app chat',
    'App store flow',
    'Lumos rem pass',
    'Sidebar idea',
    'Running experiment',
  ]);
  assert.equal(view.rowOf('Old thing'), undefined, 'a folded section shows no rows');
  assert.ok(view.rowOf('Fix the header').classList.contains('is-pinned'));
  assert.ok(view.rowOf('Fix the header').querySelector('svg'), 'the pinned row carries a pin');
  assert.ok(view.rowOf('Plan the launch').querySelector('.ai-unread-dot'), 'the unread chat has the dot');
  assert.equal(view.rowOf('Fix the header').querySelector('.ai-unread-dot') ?? undefined, undefined);
  assert.ok(view.rowOf('Running experiment').querySelector('.loader-dots'), 'the running chat has the loader');
  assert.doesNotMatch(view.container.textContent, /Loading/);
  assert.ok(view.container.querySelector('input[aria-label="Search chats"]'), 'the search field is there');
  await view.unmount();
});

test('an empty project says what to do, with a button that starts a chat', async () => {
  const view = await mountView('ListHarness', chatStore.normalizeIndex({ version: 2, trusted: true, sections: [], chats: [] }));
  assert.match(view.container.textContent, /No chats yet/);
  assert.ok([...view.container.querySelectorAll('button')].some((button) => button.textContent.includes('New chat')));
  assert.equal(view.container.querySelector('input[aria-label="Search chats"]') ?? undefined, undefined, 'nothing to search yet');
  await view.unmount();
});

test('folding a section asks main and hides its rows; a folded one opens again', async () => {
  const view = await mountView('ListHarness');
  await view.click(view.sectionOf('Apps').querySelector('.ai-section-toggle'));
  const collapse = view.main.named('aiSections').at(-1).payload.action;
  assert.deepEqual(collapse, { kind: 'collapse', section: sectionId('1'), collapsed: true });
  assert.equal(view.rowOf('App store flow'), undefined, 'the rows are gone');
  await view.click(view.sectionOf('Old').querySelector('.ai-section-toggle'));
  assert.deepEqual(view.main.named('aiSections').at(-1).payload.action, { kind: 'collapse', section: sectionId('3'), collapsed: false });
  assert.ok(view.rowOf('Old thing'), 'the folded section opened');
  await view.unmount();
});

test('the “⋯” menu lists the actions with their letters; a letter does the action and closes the menu', async () => {
  const view = await mountView('ListHarness');
  await view.click(view.rowOf('App store flow').querySelector('.ai-row-more'));
  assert.deepEqual(view.menuTexts(), ['Pin P', 'Mark as unread U', 'Rename R', 'Fork F', 'Move to section Apps', 'Archive A', 'Delete D']);
  assert.ok(view.menuRow('Delete').classList.contains('is-danger'), 'delete is red');
  await view.press(document.activeElement, { key: 'p' });
  assert.deepEqual(view.main.named('aiChatUpdate').at(-1).payload, { projectPath: PROJECT, chat: chatId('d'), pinned: true });
  assert.equal(document.querySelector('[role="menu"]') ?? undefined, undefined, 'the menu closed');
  assert.ok(view.rowOf('App store flow').classList.contains('is-pinned'));
  await view.click(view.rowOf('App store flow').querySelector('.ai-row-more'));
  assert.ok(view.menuRow('Unpin'), 'a pinned chat offers Unpin');
  await view.press(document.activeElement, { key: 'u' });
  assert.equal(view.main.named('aiChatUpdate').at(-1).payload.unread, true);
  await view.unmount();
});

test('a right click opens the same menu', async () => {
  const view = await mountView('ListHarness');
  await act(async () => view.rowOf('Lumos rem pass').dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  await settleUi();
  assert.ok(view.menuRow('Fork'));
  await view.press(document.activeElement, { key: 'Escape' });
  await view.unmount();
});

test('Move to section lists the sections with a check on the current one, and No section', async () => {
  const view = await mountView('ListHarness');
  await view.click(view.rowOf('App store flow').querySelector('.ai-row-more'));
  await view.click(view.menuRow('Move to section'));
  const rows = view.menuRows().filter((row) => row.getAttribute('role') === 'menuitemradio');
  assert.deepEqual(
    rows.map((row) => [row.textContent.trim().replace(/\s+/g, ' '), row.getAttribute('aria-checked')]),
    [
      ['Apps', 'true'],
      ['Ideas', 'false'],
      ['Old', 'false'],
      ['No section', 'false'],
    ],
  );
  await view.click(rows[1]);
  assert.deepEqual(view.main.named('aiChatMove').at(-1).payload, { projectPath: PROJECT, chat: chatId('d'), section: sectionId('2') });
  assert.deepEqual(view.titles().slice(4), ['Sidebar idea', 'Running experiment', 'App store flow'], 'it lands last in Ideas');
  await view.unmount();
});

test('letters on a focused row act on that row; other keys and modified letters do nothing', async () => {
  const view = await mountView('ListHarness');
  const button = (title) => view.rowOf(title).querySelector('.ai-list-open');
  await view.press(button('Lumos rem pass'), { key: 'x' });
  await view.press(button('Lumos rem pass'), { key: 'p', metaKey: true });
  assert.equal(view.main.named('aiChatUpdate').length, 0);
  await view.press(button('Lumos rem pass'), { key: 'p' });
  assert.deepEqual(view.main.named('aiChatUpdate').at(-1).payload, { projectPath: PROJECT, chat: chatId('e'), pinned: true });
  await view.press(button('Plan the launch'), { key: 'u' });
  assert.deepEqual(view.main.named('aiChatUpdate').at(-1).payload, { projectPath: PROJECT, chat: chatId('b'), unread: false }, 'an unread chat is marked read');
  await view.press(button('Sidebar idea'), { key: 'f' });
  assert.deepEqual(view.main.named('aiChatFork').at(-1).payload, { projectPath: PROJECT, chat: chatId('f') });
  await view.press(button('Fix the header'), { key: 'a' });
  assert.equal(view.main.named('aiChatUpdate').at(-1).payload.archived, true);
  assert.equal(view.rowOf('Fix the header'), undefined, 'archived: out of the list');
  await view.unmount();
});

test('rename in place: Enter commits, Escape cancels, empty and unchanged names change nothing, an over-long one is refused', async () => {
  const view = await mountView('ListHarness');
  const open = async (title) => {
    await view.press(view.rowOf(title).querySelector('.ai-list-open'), { key: 'r' });
    return view.container.querySelector('input.ai-rename');
  };
  const type = async (input, value) => {
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
      setter.call(input, value);
      input.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
  };
  let input = await open('Sidebar idea');
  assert.ok(input, 'the row became a field');
  assert.equal(input.value, 'Sidebar idea');
  assert.equal(input.getAttribute('maxlength'), '200', 'typing is bounded');
  assert.equal(document.activeElement, input, 'it has the keyboard, name selected');
  await type(input, '  A better name  ');
  await view.press(input, { key: 'Enter' });
  assert.deepEqual(view.main.named('aiChatUpdate').at(-1).payload, { projectPath: PROJECT, chat: chatId('f'), title: 'A better name' }, 'trimmed');
  assert.ok(view.rowOf('A better name'));
  assert.equal(view.container.querySelector('input.ai-rename') ?? undefined, undefined, 'back to a row');
  const updates = view.main.named('aiChatUpdate').length;
  input = await open('A better name');
  await type(input, 'Thrown away');
  await view.press(input, { key: 'Escape' });
  assert.ok(view.rowOf('A better name'), 'Escape keeps the old name');
  input = await open('A better name');
  await type(input, '   ');
  await view.press(input, { key: 'Enter' });
  input = await open('A better name');
  await view.press(input, { key: 'Enter' });
  assert.equal(view.main.named('aiChatUpdate').length, updates, 'empty and unchanged names are never sent');
  input = await open('A better name');
  await type(input, 'x'.repeat(201));
  await view.press(input, { key: 'Enter' });
  assert.equal(view.main.named('aiChatUpdate').length, updates, 'over the limit is refused');
  assert.ok(view.container.querySelector('input.ai-rename'), 'and the field stays so the name can be shortened');
  await type(view.container.querySelector('input.ai-rename'), 'x'.repeat(200));
  await view.press(view.container.querySelector('input.ai-rename'), { key: 'Enter' });
  assert.equal(view.main.named('aiChatUpdate').at(-1).payload.title.length, 200, 'exactly the limit is fine');
  await view.unmount();
});

test('a letter typed in the rename field is text, not a shortcut', async () => {
  const view = await mountView('ListHarness');
  await view.press(view.rowOf('Sidebar idea').querySelector('.ai-list-open'), { key: 'r' });
  await view.press(view.container.querySelector('input.ai-rename'), { key: 'd' });
  assert.equal(document.querySelector('.confirm-dialog') ?? undefined, undefined, 'D did not start a delete');
  await view.unmount();
});

test('delete asks first, says it cannot be undone, and only the confirm deletes', async () => {
  const view = await mountView('ListHarness');
  const button = () => view.rowOf('Lumos rem pass').querySelector('.ai-list-open');
  await view.press(button(), { key: 'd' });
  const dialog = document.querySelector('.confirm-dialog');
  assert.ok(dialog, 'Stacki’s own dialog, not a native one');
  assert.match(dialog.textContent, /cannot be undone/);
  assert.match(dialog.textContent, /Lumos rem pass/);
  assert.equal(view.main.named('aiChatDelete').length, 0, 'nothing deleted yet');
  await view.click(view.confirmButton('Cancel'));
  assert.equal(view.main.named('aiChatDelete').length, 0);
  assert.ok(view.rowOf('Lumos rem pass'));
  await view.click(view.rowOf('Lumos rem pass').querySelector('.ai-row-more'));
  await view.press(document.activeElement, { key: 'd' });
  await view.click(view.confirmButton('Delete chat'));
  assert.deepEqual(view.main.named('aiChatDelete').at(-1).payload, { projectPath: PROJECT, chat: chatId('e') });
  assert.equal(view.rowOf('Lumos rem pass'), undefined);
  await view.unmount();
});

test('archived chats are hidden until the filter shows them; there they restore or delete', async () => {
  const view = await mountView('ListHarness');
  await view.press(view.rowOf('Sidebar idea').querySelector('.ai-list-open'), { key: 'a' });
  assert.equal(view.rowOf('Sidebar idea'), undefined);
  assert.equal(view.container.querySelector('.ai-archived') ?? undefined, undefined, 'no Archived group by default');
  await act(async () => sessions.setChatListFilter({ ...sessions.aiState().filter, showArchived: true }));
  await settleUi();
  const group = view.container.querySelector('.ai-archived');
  assert.ok(group, 'the filter reveals it');
  assert.deepEqual(
    [...group.querySelectorAll('.ai-list-title')].map((element) => element.textContent),
    ['Sidebar idea'],
  );
  assert.equal(group.querySelector('[data-drag-item]') ?? undefined, undefined, 'archived rows are not draggable');
  await view.click(group.querySelector('.ai-row-restore'));
  assert.equal(view.main.named('aiChatUpdate').at(-1).payload.archived, false);
  assert.ok(view.sectionOf('Ideas').querySelector('.ai-list-row'), 'back in its section');
  assert.match(view.container.querySelector('.ai-archived').textContent, /No archived chats/);
  await view.unmount();
});

test('an archived chat’s menu offers Restore and Delete only', async () => {
  const view = await mountView('ListHarness');
  await view.press(view.rowOf('Sidebar idea').querySelector('.ai-list-open'), { key: 'a' });
  await act(async () => sessions.setChatListFilter({ ...sessions.aiState().filter, showArchived: true }));
  await settleUi();
  await view.click(view.container.querySelector('.ai-archived .ai-row-more'));
  assert.deepEqual(view.menuTexts(), ['Restore A', 'Delete D']);
  await view.press(document.activeElement, { key: 'Escape' });
  await view.unmount();
});

test('searching filters across sections, opens folded ones, and turns dragging off', async () => {
  const view = await mountView('ListHarness');
  assert.ok(view.container.querySelector('[data-drag-item]'), 'draggable before');
  const input = view.container.querySelector('input[aria-label="Search chats"]');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'old');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await settleUi();
  assert.deepEqual(view.titles(), ['Old thing'], 'the folded section opened for its match, the rest hid');
  assert.deepEqual(
    [...view.container.querySelectorAll('.ai-section-name')].map((element) => element.textContent),
    ['Old'],
  );
  assert.equal(view.container.querySelector('.ai-new-section') ?? undefined, undefined, 'no New section while narrowing');
  const button = view.rowOf('Old thing').querySelector('.ai-list-open');
  await view.press(button, { key: 'ArrowDown', altKey: true });
  assert.equal(view.main.named('aiChatMove').length, 0, 'Alt+Arrow does nothing while a search is on');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'zzz nothing');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await settleUi();
  assert.match(view.container.textContent, /No chat matches/);
  await view.click([...view.container.querySelectorAll('button')].find((candidate) => candidate.textContent.includes('Clear search')));
  assert.equal(sessions.aiState().filter.query, '');
  await view.unmount();
});

test('Alt+Arrow moves a chat within its section and across the edge into the next, through ai:chatMove', async () => {
  const view = await mountView('ListHarness');
  const button = (title) => view.rowOf(title).querySelector('.ai-list-open');
  // "App store flow" is second in Apps after the pinned chat; one place down passes "Lumos rem pass".
  await view.press(button('App store flow'), { key: 'ArrowDown', altKey: true });
  assert.deepEqual(view.main.named('aiChatMove').at(-1).payload, { projectPath: PROJECT, chat: chatId('d'), section: sectionId('1') });
  assert.deepEqual(view.titles().slice(2, 5), ['Pinned app chat', 'Lumos rem pass', 'App store flow']);
  // Past the end of Apps: the start of Ideas.
  await view.press(button('App store flow'), { key: 'ArrowDown', altKey: true });
  assert.deepEqual(view.main.named('aiChatMove').at(-1).payload, { projectPath: PROJECT, chat: chatId('d'), section: sectionId('2'), before: chatId('f') });
  assert.ok(view.sectionOf('Ideas').contains(view.rowOf('App store flow')));
  await view.unmount();
});

test('Alt+Arrow cannot carry an unpinned chat above a pinned one', async () => {
  const view = await mountView('ListHarness');
  const button = (title) => view.rowOf(title).querySelector('.ai-list-open');
  await view.press(button('App store flow'), { key: 'ArrowUp', altKey: true });
  assert.equal(view.main.named('aiChatMove').length, 0, 'the pinned chat stays first');
  await view.press(button('Plan the launch'), { key: 'ArrowUp', altKey: true });
  assert.equal(view.main.named('aiChatMove').length, 0, 'the unpinned chat is already right below the pinned one');
  assert.deepEqual(view.titles().slice(0, 2), ['Fix the header', 'Plan the launch']);
  await view.unmount();
});

// The pointer drag: stacked boxes stand in for layout.
function stubLayout(view) {
  let top = 0;
  const list = view.container.querySelector('.ai-list');
  list.getBoundingClientRect = () => ({ top: 0, bottom: 2000, left: 0, right: 300, width: 300, height: 2000 });
  for (const sectionElement of view.container.querySelectorAll('.ai-section')) {
    const start = top;
    top += sectionElement.querySelector('.ai-section-head') ? 26 : 0;
    for (const row of sectionElement.querySelectorAll('.ai-list-row')) {
      const rowTop = top;
      const rect = { top: rowTop, bottom: rowTop + 30, left: 0, right: 300, width: 300, height: 30 };
      for (const element of [row, ...row.querySelectorAll('[data-drag-item]')]) {
        element.getBoundingClientRect = () => rect;
      }
      top += 32;
    }
    top += 6;
    const box = { top: start, bottom: top, left: 0, right: 300, width: 300, height: top - start };
    sectionElement.getBoundingClientRect = () => box;
  }
}

async function pointer(type, target, y) {
  await act(async () => {
    const event = new window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 20, clientY: y, button: 0 });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    target.dispatchEvent(event);
    await wait(25);
  });
}

async function dragRow(view, title, toY) {
  stubLayout(view);
  const handle = view.rowOf(title).querySelector('[data-drag-item]');
  await pointer('pointerdown', handle, 10);
  await pointer('pointermove', window, toY);
  const line = view.container.querySelector('.drop-indicator');
  await pointer('pointerup', window, toY);
  await settleUi();
  return line;
}

test('dragging a row to another section drops it there, draws the line while dragging, and persists through ai:chatMove', async () => {
  const view = await mountView('ListHarness');
  stubLayout(view);
  // Rows: No section: a (26+) ... find the y of "Sidebar idea" to drop "Fix the header"'s neighbour above it.
  const target = view.rowOf('Sidebar idea').querySelector('[data-drag-item]').getBoundingClientRect();
  const line = await dragRow(view, 'Plan the launch', target.top + 2);
  assert.ok(line, 'the drop line was drawn while the row was held');
  assert.deepEqual(view.main.named('aiChatMove').at(-1).payload, { projectPath: PROJECT, chat: chatId('b'), section: sectionId('2'), before: chatId('f') });
  assert.ok(view.sectionOf('Ideas').contains(view.rowOf('Plan the launch')));
  assert.equal(view.container.querySelector('.drop-indicator') ?? undefined, undefined, 'the line is gone after the drop');
  await view.unmount();
});

test('a drop among the pinned chats lands at the boundary, and a drop that changes nothing is not sent', async () => {
  const view = await mountView('ListHarness');
  stubLayout(view);
  const pinnedTop = view.rowOf('Pinned app chat').querySelector('[data-drag-item]').getBoundingClientRect().top;
  await dragRow(view, 'Lumos rem pass', pinnedTop + 2);
  assert.deepEqual(
    view.main.named('aiChatMove').at(-1).payload,
    { projectPath: PROJECT, chat: chatId('e'), before: chatId('d'), section: sectionId('1') },
    'asked to go before the pinned chat, it goes before the first unpinned one',
  );
  const moves = view.main.named('aiChatMove').length;
  stubLayout(view);
  const handle = view.rowOf('Pinned app chat').querySelector('[data-drag-item]');
  await dragRow(view, 'Lumos rem pass', handle.getBoundingClientRect().top + 2);
  assert.equal(view.main.named('aiChatMove').length, moves, 'already right below the pinned chat: nothing to send');
  await view.unmount();
});

test('a drop onto a folded section is refused', async () => {
  const view = await mountView('ListHarness');
  stubLayout(view);
  const folded = view.sectionOf('Old').getBoundingClientRect();
  const line = await dragRow(view, 'Sidebar idea', folded.top + 5);
  assert.equal(line ?? undefined, undefined, 'no line over a folded section');
  assert.equal(view.main.named('aiChatMove').length, 0);
  await view.unmount();
});

test('a click on a row opens its chat and a press-and-release is never a drag', async () => {
  const view = await mountView('ListHarness');
  stubLayout(view);
  const handle = view.rowOf('Sidebar idea').querySelector('[data-drag-item]');
  await pointer('pointerdown', handle, 10);
  await pointer('pointerup', window, 10);
  await view.click(handle);
  assert.equal(view.main.named('aiChatMove').length, 0);
  assert.equal(sessions.aiState().open, chatId('f'));
  await view.unmount();
});

test('New section adds a section with a free name and puts its header into rename; deleting a section confirms and keeps its chats', async () => {
  const view = await mountView('ListHarness');
  await view.click(view.container.querySelector('.ai-new-section'));
  assert.deepEqual(view.main.named('aiSections').at(-1).payload.action, { kind: 'create', name: 'New section' });
  const input = view.container.querySelector('input.ai-section-rename');
  assert.ok(input, 'the new header asks for a name');
  assert.equal(input.value, 'New section');
  await view.press(input, { key: 'Escape' });
  await view.click(view.container.querySelector('.ai-new-section'));
  assert.equal(view.main.named('aiSections').at(-1).payload.action.name, 'New section 2', 'the second default name is free');
  await view.press(view.container.querySelector('input.ai-section-rename'), { key: 'Escape' });
  // Delete "Apps" (three chats).
  await view.click(view.sectionOf('Apps').querySelector('.ai-row-more'));
  assert.deepEqual(view.menuTexts(), ['Rename R', 'Move up', 'Move down', 'Delete section D']);
  assert.equal(view.menuRow('Move up').disabled, true, 'the first section cannot go up');
  await view.press(document.activeElement, { key: 'd' });
  const dialog = document.querySelector('.confirm-dialog');
  assert.match(dialog.textContent, /3 chats move to No section/);
  assert.match(dialog.textContent, /No chat is deleted/);
  await view.click(view.confirmButton('Cancel'));
  assert.equal(view.main.named('aiSections').filter((call) => call.payload.action.kind === 'delete').length, 0);
  await view.click(view.sectionOf('Apps').querySelector('.ai-row-more'));
  await view.press(document.activeElement, { key: 'd' });
  await view.click(view.confirmButton('Delete section'));
  assert.deepEqual(view.main.named('aiSections').at(-1).payload.action, { kind: 'delete', section: sectionId('1') });
  assert.equal(view.sectionOf('Apps'), undefined);
  assert.ok(view.rowOf('App store flow'), 'its chats are still listed');
  assert.equal(view.main.named('aiChatDelete').length, 0, 'none was deleted');
  await view.unmount();
});

test('section headers rename in place and move', async () => {
  const view = await mountView('ListHarness');
  await view.click(view.sectionOf('Ideas').querySelector('.ai-row-more'));
  await view.press(document.activeElement, { key: 'r' });
  const input = view.container.querySelector('input.ai-section-rename');
  assert.equal(input.getAttribute('maxlength'), '60');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Sparks');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await view.press(input, { key: 'Enter' });
  assert.deepEqual(view.main.named('aiSections').at(-1).payload.action, { kind: 'rename', section: sectionId('2'), name: 'Sparks' });
  await view.click(view.sectionOf('Sparks').querySelector('.ai-row-more'));
  await view.click(view.menuRow('Move up'));
  assert.deepEqual(view.main.named('aiSections').at(-1).payload.action, { kind: 'move', section: sectionId('2'), before: sectionId('1') });
  assert.deepEqual(
    [...view.container.querySelectorAll('.ai-section-name')].map((element) => element.textContent),
    ['No section', 'Sparks', 'Apps', 'Old'],
  );
  await view.unmount();
});

test('the implicit section can neither fold, rename nor be deleted, and shows no header while there are no sections', async () => {
  const view = await mountView('ListHarness');
  const head = view.sectionOf('No section').querySelector('.ai-section-head');
  assert.ok(head.classList.contains('is-static'));
  assert.equal(head.querySelector('button') ?? undefined, undefined);
  await view.unmount();
  const bare = await mountView('ListHarness', chatStore.normalizeIndex({ version: 2, trusted: true, sections: [], chats: [record('a')] }));
  assert.equal(bare.container.querySelector('.ai-section-head') ?? undefined, undefined);
  await bare.unmount();
});

test('the section limit disables New section with the reason', async () => {
  const sections = Array.from({ length: 50 }, (_, index) => ({ id: `s${String(index).padStart(16, '0')}`, name: `S${index}`, collapsed: false, rank: index }));
  const view = await mountView('ListHarness', chatStore.normalizeIndex({ version: 2, trusted: true, sections, chats: [record('a')] }));
  const button = view.container.querySelector('.ai-new-section');
  assert.equal(button.disabled, true);
  assert.match(button.title, /at most 50 sections/);
  await view.unmount();
});

test('500 chats render in a fair time', async () => {
  const chats = Array.from({ length: 500 }, (_, index) =>
    record('a', {
      id: `c${index.toString(16).padStart(24, '0')}`,
      title: `Chat number ${index}`,
      rank: index,
      section: index % 2 === 0 ? sectionId('1') : undefined,
    }),
  );
  const started = Date.now();
  const view = await mountView('ListHarness', chatStore.normalizeIndex({ version: 2, trusted: true, sections: [section('1', 'Half', 0)], chats }));
  const elapsed = Date.now() - started;
  assert.equal(view.container.querySelectorAll('.ai-list-row').length, 500);
  assert.ok(elapsed < 4000, `rendered in ${elapsed} ms`);
  await view.unmount();
});

// --- The header --------------------------------------------------------------

test('on the list the header says Chats with a filter and a new chat button', async () => {
  const view = await mountView('HeaderHarness');
  assert.equal(view.container.querySelector('h2').textContent, 'Chats');
  assert.ok(view.container.querySelector('button[aria-label="Filter chats"]'));
  assert.ok(view.container.querySelector('button[aria-label="New chat"]'));
  assert.equal(view.container.querySelector('button[aria-label="All chats"]') ?? undefined, undefined, 'nothing to go back to');
  await view.unmount();
});

test('the filter menu toggles archived, unread and pinned, picks an agent, and marks the button while something is on', async () => {
  const view = await mountView('HeaderHarness');
  const trigger = () => view.container.querySelector('button[aria-label="Filter chats"]');
  assert.equal(trigger().classList.contains('on'), false);
  await view.click(trigger());
  assert.deepEqual(view.menuTexts(), ['Show archived', 'Only unread', 'Only pinned', 'Agent All']);
  assert.match(document.querySelector('[role="menu"]').textContent, /Drag a chat to move it/, 'it says the order is the person’s');
  await view.click(view.menuRow('Show archived'));
  assert.equal(sessions.aiState().filter.showArchived, true);
  await view.click(view.menuRow('Only unread'));
  assert.equal(sessions.aiState().filter.onlyUnread, true);
  assert.equal(trigger().classList.contains('on'), true);
  await view.click(view.menuRow('Agent'));
  const codex = view.menuRows().find((row) => row.textContent.trim() === 'Codex');
  await view.click(codex);
  assert.equal(sessions.aiState().filter.agent, 'codex');
  await view.unmount();
});

test('an open chat’s header: back, title, a menu with the same actions, and a double click renames', async () => {
  const view = await mountView('HeaderHarness');
  await act(async () => sessions.openChat(chatId('d')));
  await settleUi();
  assert.equal(view.container.querySelector('h2').textContent, 'App store flow');
  assert.ok(view.container.querySelector('button[aria-label="All chats"]'));
  await view.click(view.container.querySelector('button[aria-label="Chat actions"]'));
  assert.deepEqual(view.menuTexts(), [
    'Expand all',
    'Collapse all',
    'Pin P',
    'Mark as unread U',
    'Rename R',
    'Fork F',
    'Move to section Apps',
    'Archive A',
    'Delete D',
  ]);
  await view.press(document.activeElement, { key: 'r' });
  let input = view.container.querySelector('input.ai-header-rename');
  assert.ok(input, 'the title became a field');
  await view.press(input, { key: 'Escape' });
  await act(async () => view.container.querySelector('h2').dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true, cancelable: true })));
  input = view.container.querySelector('input.ai-header-rename');
  assert.ok(input, 'a double click renames too');
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'Checkout flow');
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  await view.press(input, { key: 'Enter' });
  assert.deepEqual(view.main.named('aiChatUpdate').at(-1).payload, { projectPath: PROJECT, chat: chatId('d'), title: 'Checkout flow' });
  assert.equal(view.container.querySelector('h2').textContent, 'Checkout flow');
  await view.click(view.container.querySelector('button[aria-label="All chats"]'));
  assert.equal(sessions.aiState().open, undefined, 'back to the list');
  await view.unmount();
});

test('archiving the open chat from its header returns to the list; deleting it asks first', async () => {
  const view = await mountView('HeaderHarness');
  await act(async () => sessions.openChat(chatId('d')));
  await settleUi();
  await view.click(view.container.querySelector('button[aria-label="Chat actions"]'));
  await view.press(document.activeElement, { key: 'd' });
  assert.ok(document.querySelector('.confirm-dialog'), 'asked first');
  assert.equal(view.main.named('aiChatDelete').length, 0);
  await view.click(view.confirmButton('Cancel'));
  await view.click(view.container.querySelector('button[aria-label="Chat actions"]'));
  await view.press(document.activeElement, { key: 'a' });
  assert.equal(sessions.aiState().open, undefined);
  assert.equal(view.container.querySelector('h2').textContent, 'Chats');
  await view.unmount();
});

test('the files hold the house rules: no native dialogs, no borders, no loading word', () => {
  for (const file of ['SessionsView.tsx', 'ChatRow.tsx', 'SectionHeader.tsx', 'ChatHeader.tsx', 'SessionsFilter.tsx', 'RenameField.tsx', 'chatActions.ts']) {
    const source = fs.readFileSync(repoPath(`src/features/ai/sessions/${file}`), 'utf8');
    assert.doesNotMatch(source, /window\.(confirm|alert|prompt)\(|\bconfirm\(|<select/, `${file}: custom dialogs and dropdowns only`);
    assert.doesNotMatch(source, /Loading/, `${file}: no loading text`);
  }
  const css = fs.readFileSync(repoPath('src/features/ai/sessions/sessions.css'), 'utf8');
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ''), /border(?!-radius)[a-z-]*\s*:/, 'backgrounds, not borders');
  void FIX;
});
