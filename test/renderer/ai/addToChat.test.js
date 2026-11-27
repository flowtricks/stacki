// Goal: "Add to chat" puts a code chip and a place chip into the chat's box at its caret without touching what
// was typed (with the box open or not), refuses what does not fit with a toast and leaves the draft as it was,
// names the place for what the file is, and a chip's card shows its value and never outlives its chip. A copied
// selection of the transcript writes each chip out where it stood.
// Method: bundle the real store, the add, the composer's editor and the shell's chip builder with esbuild, and
// drive them in jsdom: the editor takes real transactions, the card real pointer and focus events (the tooltip's
// wait is waited out on what appears, never a fixed pause).
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTranscript } = require('../../helpers/aiTranscriptDom.js');
const { waitFor, waitForSteady } = require('../../helpers/waitFor.js');

const {
  modules: ui,
  React,
  act,
  createRoot,
  window,
} = loadTranscript('aiAddToChat', [
  "export { addSelectionToChat, withSelectionChips } from './src/features/ai/addToChat';",
  "export { composerTarget, composerCaretMemory, registerComposerTarget } from './src/features/ai/composerTargets';",
  "export { aiState, loadAiProject, openChat, resetAiStore, setDraft } from './src/features/ai/aiStore';",
  "export { ComposerInput } from './src/features/ai/composer/ComposerInput';",
  "export { MentionChipView } from './src/features/ai/mentions/MentionChipView';",
  "export { selectionTextWithChips } from './src/features/ai/transcript/chipCopy';",
  "export { selectionChipsOf } from './src/app/shell/aiSelection';",
  "export { subscribeErrorToasts } from './src/ui/errorNotices';",
  "export { ENGLISH_TRANSLATE } from './shared/properties/i18n/englishTranslator';",
]);

for (const name of ['MutationObserver', 'Window']) {
  Object.defineProperty(global, name, { value: window[name], configurable: true, writable: true });
}
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};
const box = { top: 10, left: 10, bottom: 30, right: 20, width: 10, height: 20 };
window.Range.prototype.getBoundingClientRect = () => box;
window.Range.prototype.getClientRects = () => ({ length: 0, item: () => undefined, [Symbol.iterator]: function* () {} });

const CHAT = `c${'a'.repeat(24)}`;
const text = (value) => ({ kind: 'text', text: value });
const code = { kind: 'code', path: 'src/pages/index.astro', startLine: 2, endLine: 3, element: 'Section', code: '<Section>\n</Section>' };
const page = { kind: 'page', role: 'page', path: 'src/pages/index.astro', name: 'Home', route: '/', viewedOn: undefined };
const chips = { code, page };
const toasts = [];
ui.subscribeErrorToasts(
  (notice) => toasts.push(notice.message),
  () => undefined,
);

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

// Waits for what the screen shows, letting React flush between looks.
async function settled(what, read, until) {
  await waitFor({ what, read: async () => (await act(async () => new Promise((resolve) => setTimeout(resolve, 0))), read()), until });
}

const draft = () => ui.aiState().drafts.get(CHAT)?.segments ?? [];
const kinds = (segments) => segments.map((segment) => (segment.kind === 'text' ? segment.text : segment.chip.kind));

test('with the box closed, the chips go in where its caret was and the typed words stay; nothing is sent', async () => {
  startBridge();
  await ui.loadAiProject('/site');
  await ui.openChat(CHAT);
  ui.setDraft(CHAT, () => ({ segments: [text('make this bigger')], attachments: [] }));
  ui.composerCaretMemory(CHAT).write(5);
  assert.equal(await ui.addSelectionToChat('/site', chips, ui.ENGLISH_TRANSLATE), true);
  assert.deepEqual(kinds(draft()), ['make ', 'code', ' ', 'page', ' this bigger']);
  // The caret ends after what was added, so a second selection follows the first.
  assert.equal(await ui.addSelectionToChat('/site', chips, ui.ENGLISH_TRANSLATE), true);
  assert.deepEqual(kinds(draft()), ['make ', 'code', ' ', 'page', ' ', 'code', ' ', 'page', ' this bigger']);
});

test('with the box open, the chips go in at the editor’s caret as one edit the draft hears', async (context) => {
  startBridge();
  await ui.loadAiProject('/site');
  await ui.openChat(CHAT);
  ui.setDraft(CHAT, () => ({ segments: [text('before after')], attachments: [] }));
  const host = window.document.body.appendChild(window.document.createElement('div'));
  const root = createRoot(host);
  context.after(() => act(() => root.unmount()));
  const handle = React.createRef();
  let latest = draft();
  await act(async () => {
    root.render(
      React.createElement(ui.ComposerInput, {
        agent: 'claude',
        commands: [],
        placeholder: 'Message',
        inputRef: handle,
        segments: draft(),
        onSegmentsChange: (segments) => {
          latest = segments;
          ui.setDraft(CHAT, (current) => ({ ...current, segments }));
        },
        onSend: () => undefined,
        searchMentions: async () => ({ ok: true, value: [] }),
        caretMemory: { read: () => 7, write: () => undefined },
      }),
    );
  });
  context.after(ui.registerComposerTarget(CHAT, (change) => handle.current.editBeforeCaret(change)));
  await act(async () => {
    await ui.addSelectionToChat('/site', chips, ui.ENGLISH_TRANSLATE);
  });
  assert.deepEqual(kinds(latest), ['before ', 'code', ' ', 'page', ' after']);
  const pills = [...host.querySelectorAll('.cm-content .chip-editor-chip')];
  assert.deepEqual(
    pills.map((pill) => pill.textContent),
    ['Section · L2–3', 'Home'],
  );
  assert.equal(pills[0].getAttribute('title') ?? '', '', 'its card is the only tip');
  assert.equal(pills[0].tabIndex, 0, 'the keyboard can reach it');

  // Focus opens the card at once, with the code highlighted in a scrollable block.
  await act(async () => pills[0].dispatchEvent(new window.FocusEvent('focus')));
  const card = () => window.document.querySelector('.ai-chip-card');
  assert.equal(card().querySelector('.ai-chip-card-code').textContent, code.code);
  assert.equal(card().querySelector('.ai-chip-card-code').tabIndex, 0);
  assert.match(card().textContent, /src\/pages\/index\.astro/);
  await act(async () => pills[0].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
  assert.equal(card() ?? undefined, undefined, 'Escape closes it');

  // The pointer rests, the card opens; moving into the card keeps it; the chip going takes it along.
  await act(async () => pills[0].dispatchEvent(new window.MouseEvent('mouseenter')));
  await settled('the card to open after the pointer rests', card, (found) => (found ?? undefined) !== undefined);
  await act(async () => pills[0].dispatchEvent(new window.MouseEvent('mouseleave')));
  await act(async () =>
    card()
      .querySelector('.ai-chip-card-body')
      .dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })),
  );
  // Past the leave wait: the card is still there once it has held through many more looks than that wait takes.
  await waitForSteady({
    what: 'the card to stay while the pointer is on it',
    read: async () => (await act(async () => new Promise((resolve) => setImmediate(resolve))), Boolean(card())),
    until: (shown) => shown,
    steadyPollCount: 12,
  });
  assert.ok(card(), 'the card stays while the pointer is on it');
  await act(async () => pills[0].remove());
  await settled('the card to leave with its chip', card, (found) => (found ?? undefined) === undefined);
});

test('what does not fit is refused whole with a toast, and the draft is left as it was', async () => {
  startBridge();
  await ui.loadAiProject('/site');
  await ui.openChat(CHAT);
  const eight = Array.from({ length: 8 }, () => ({ kind: 'chip', chip: { ...code, code: 'x' } }));
  ui.setDraft(CHAT, () => ({ segments: eight, attachments: [] }));
  for (const [selection, message] of [
    [chips, /up to|can hold 8/],
    [{ code: { ...code, code: 'x'.repeat(20_001) }, page }, /over 20000|over 20,000/],
    [{ code: { ...code, code: '  \n ' }, page }, /no code/],
  ]) {
    toasts.length = 0;
    assert.equal(await ui.addSelectionToChat('/site', selection, ui.ENGLISH_TRANSLATE), false);
    assert.match(toasts.join('\n'), message);
    assert.equal(draft().filter((segment) => segment.kind === 'chip').length, 8, 'nothing was added or cut');
  }
});

test('the second chip names the file for what it is, and the page on the canvas when that is another file', () => {
  const place = (openPath, canvasPagePath) => ({
    projectPath: '/site',
    platform: 'darwin',
    openPath,
    canvasPagePath,
    pages: [{ path: '/site/src/pages/index.astro', name: 'index.astro', route: '/' }],
    layouts: [{ path: '/site/src/layouts/Base.astro', name: 'Base' }],
    components: [{ path: '/site/src/components/Hero.astro', name: 'Hero' }],
    pageName: () => 'Home',
  });
  const selection = { code: '<a/>', startLine: 1, endLine: 1, element: 'a' };
  const placeOf = (openPath, canvas) => ui.selectionChipsOf(place(openPath, canvas), selection).page;
  assert.deepEqual(placeOf('/site/src/pages/index.astro', '/site/src/pages/index.astro'), page);
  assert.equal(placeOf('/site/src/layouts/Base.astro').role, 'layout');
  const hero = placeOf('/site/src/components/Hero.astro', '/site/src/pages/index.astro');
  assert.deepEqual([hero.role, hero.name, hero.viewedOn], ['component', 'Hero', 'src/pages/index.astro']);
  const styles = placeOf('/site/src/styles/global.css');
  assert.deepEqual([styles.role, styles.name], ['file', 'global.css']);
  assert.equal(ui.selectionChipsOf(place('/elsewhere/a.astro'), selection), undefined, 'a file outside the project is not added');
});

test('copying a selection with chips writes each chip out where it stood, the code on its own lines', async (context) => {
  const host = window.document.body.appendChild(window.document.createElement('div'));
  const root = createRoot(host);
  context.after(() => act(() => root.unmount()));
  await act(async () => {
    root.render(
      React.createElement(
        'p',
        {},
        'make ',
        React.createElement(ui.MentionChipView, { chip: code }),
        ' on ',
        React.createElement(ui.MentionChipView, { chip: page }),
        ' bigger',
      ),
    );
  });
  const range = window.document.createRange();
  range.selectNodeContents(host.querySelector('p'));
  const selection = window.getSelection();
  selection.removeAllRanges();
  selection.addRange(range);
  assert.equal(
    ui.selectionTextWithChips(selection, (fragment) => fragment.textContent),
    'make\nsrc/pages/index.astro, lines 2–3\n<Section>\n</Section>\non Home (src/pages/index.astro) bigger',
  );
  range.setStart(host.querySelector('p').firstChild, 0);
  range.setEnd(host.querySelector('p').firstChild, 4);
  selection.removeAllRanges();
  selection.addRange(range);
  assert.equal(
    ui.selectionTextWithChips(selection, (fragment) => fragment.textContent),
    undefined,
    'a selection without a chip is the browser’s own',
  );
});
