// Goal: every way of adding the selected element to the chat gives the same two chips, the element's whole code
// as the file has it with unsaved edits, and the file's chip; never component or slot chips. And that code is
// what the agent is sent.
// Method: bundle the shell's real "Add to chat" hook with the real store, mount it over a stand-in app whose
// save is still pending (an edit shows in the tree before the file's text has it, as a gesture does), take each
// route (the "+" menu's offer, the element menus' offer, ⌘L, the Code panel with no text selected), and read the
// draft. A stand-in agent gets the blocks the host's real prompt builder makes of that draft.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTranscript } = require('../../helpers/aiTranscriptDom.js');
const { waitFor } = require('../../helpers/waitFor.js');
const { parsePage } = require('#dist/electron/parse/astroParser.js');
const { buildPrompt } = require('#dist/electron/handlers/ai/promptBlocks.js');

const {
  modules: ui,
  React,
  act,
  createRoot,
  window,
} = loadTranscript('aiAddSelectedRoutes', [
  "export { useAddToChat, addNodeToChatOffer, addCodeToChat } from './src/app/shell/aiAddToChat';",
  "export { PlusMenu } from './src/features/ai/composer/PlusMenu';",
  "export { aiState, loadAiProject, openChat, resetAiStore, setDraft } from './src/features/ai/aiStore';",
  "export { promptPartsOf } from './shared/properties/ai/mentions';",
  "export { ENGLISH_TRANSLATE } from './shared/properties/i18n/englishTranslator';",
]);

const CHAT = `c${'b'.repeat(24)}`;
const PAGE = '/site/src/pages/index.astro';

const pageText = (second) =>
  [
    '---',
    "import Section from '../components/Section.astro';",
    '---',
    '<Section>',
    '  <p>first</p>',
    '</Section>',
    '<!-- Values -->',
    '<Section>',
    '  <Grid slot="column2">',
    `    <p>${second}</p>`,
    '  </Grid>',
    '</Section>',
    '',
  ].join('\n');

const expected = ['<Section>', '  <Grid slot="column2">', '    <p>edited, not saved yet</p>', '  </Grid>', '</Section>'].join('\n');

function startBridge() {
  ui.resetAiStore();
  window.localStorage.clear();
  const summary = { id: CHAT, agent: 'claude', title: 'Chat', pinned: false, createdAt: 1, updatedAt: 1, rank: 0, unread: false };
  window.avb = {
    platform: 'darwin',
    aiAgents: async () => ({ trusted: true, agents: [], options: [] }),
    aiChats: async () => ({ chats: [summary], sections: [] }),
    aiChatRead: async () => ({ ok: true, value: { summary, events: [], full: false } }),
    aiMentions: async () => ({ ok: true, value: [] }),
    aiAck: () => undefined,
    onAiEvents: () => () => undefined,
    onAiAgentStatus: () => () => undefined,
    onAiSetup: () => () => undefined,
  };
}

function standInApp() {
  const saved = parsePage(pageText('as it was'), { locs: true }).model;
  // The save's parse gives new handles to what changed, as a save of typed code does: the selection is followed.
  const edited = parsePage(pageText('edited, not saved yet'), { locs: true }).model;
  const pending = [...edited.nodes];
  for (let index = 0; index < pending.length; index += 1) {
    pending[index].id = `${pending[index].id}-saved`;
    pending.push(...(pending[index].children ?? []));
  }
  const state = (model, source) => ({ editable: true, model, source, parsedFrom: source });
  const pageStateRef = { current: { currentPage: { kind: 'page', path: PAGE }, pageState: state(saved, pageText('as it was')) } };
  const section = saved.nodes.filter((node) => node.name === 'Section')[1];
  return {
    flushes: 0,
    project: { path: '/site' },
    currentPage: { kind: 'page', path: PAGE },
    editStack: [{ kind: 'page', path: PAGE }],
    scan: { pages: [{ path: PAGE, name: 'index.astro', route: '/' }], layouts: [], components: [] },
    model: saved,
    selectedId: section.id,
    pageStateRef,
    async flushSave() {
      this.flushes += 1;
      pageStateRef.current = { ...pageStateRef.current, pageState: state(edited, pageText('edited, not saved yet')) };
    },
  };
}

const draft = () => ui.aiState().drafts.get(CHAT)?.segments ?? [];
const chipsOf = (segments) => segments.flatMap((segment) => (segment.kind === 'chip' ? [segment.chip] : []));

async function added(what) {
  await waitFor({
    what,
    read: async () => (await act(async () => new Promise((resolve) => setTimeout(resolve, 0))), chipsOf(draft()).length),
    until: (count) => count >= 2,
  });
  return chipsOf(draft());
}

test('every route adds the selected element’s whole code and its file, and the agent is sent that code', async (context) => {
  startBridge();
  await ui.loadAiProject('/site');
  await ui.openChat(CHAT);
  const app = standInApp();
  let opened = 0;
  function Shell() {
    ui.useAddToChat(app, { available: true, openPanel: () => (opened += 1) });
    return React.createElement(ui.PlusMenu, {
      disabled: false,
      canInsertSlash: false,
      canCopyChat: false,
      onPickImages: () => undefined,
      onInsertSlash: () => undefined,
      onInsertMention: () => undefined,
      onFind: () => undefined,
      onCopyChat: () => undefined,
    });
  }
  const host = window.document.body.appendChild(window.document.createElement('div'));
  const root = createRoot(host);
  context.after(() => act(() => root.unmount()));
  await act(async () => root.render(React.createElement(Shell)));

  const routes = [
    [
      'the "+" menu',
      async () => {
        await act(async () => host.querySelector('.ai-plus').click());
        const row = [...window.document.querySelectorAll('[role="menuitem"]')].find((item) => /Add selected Section/.test(item.textContent));
        assert.ok(row, 'the row names the selected component');
        await act(async () => row.click());
      },
    ],
    ['the canvas and Navigator menus', () => act(async () => ui.addNodeToChatOffer()(app.selectedId))],
    ['⌘L', () => window.document.body.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true, cancelable: true }))],
    ['the Code panel with no text selected', () => ui.addCodeToChat(app, { kind: 'node', id: app.selectedId }, ui.ENGLISH_TRANSLATE)],
  ];
  let first;
  for (const [route, take] of routes) {
    const before = app.flushes;
    ui.setDraft(CHAT, () => ({ segments: [], attachments: [] }));
    await take();
    const chips = await added(route);
    assert.equal(app.flushes, before + 1, `${route} saves pending edits first`);
    assert.deepEqual(
      chips.map((chip) => chip.kind),
      ['code', 'page'],
      route,
    );
    assert.equal(chips[0].code, expected, `${route}: the second Section, whole, with the unsaved words`);
    assert.deepEqual([chips[0].startLine, chips[0].endLine, chips[0].element], [8, 12, 'Section'], route);
    first ??= chips;
    assert.deepEqual(chips, first, `${route} adds exactly what the others add`);
  }
  assert.equal(opened, routes.length, 'each route shows the panel');

  const received = [];
  const standInAgent = { prompt: (blocks) => received.push(...blocks) };
  const built = buildPrompt(
    { root: '/site', home: '/home', agent: 'claude', embeddedContext: true, commands: new Set(), read: () => undefined },
    { text: '', attachments: [], parts: ui.promptPartsOf(draft(), () => '') },
  );
  assert.equal(built.ok, true);
  standInAgent.prompt(built.value.blocks);
  assert.ok(
    received.some((block) => block.type === 'text' && block.text.includes(expected) && block.text.includes('src/pages/index.astro')),
    'the exact code reaches the agent',
  );
});
