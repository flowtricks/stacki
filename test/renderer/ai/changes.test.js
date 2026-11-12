// Goal: the changes card and the diff view do what they show. The card says how many files changed
// and how many lines, lists a row per file with Keep and Undo while pending and Kept or Undone after,
// opens a row to the file's diff (fetched once), reaches the existing review flow unchanged (Keep all
// and Undo all settle one file at a time), and offers "Open file" only when the shell gave it.
// The diff view draws line numbers, signs, folded context with "Show N lines", marked words, and
// coloured code.
// Method: bundle the real components and the store with esbuild, mount them in jsdom against a fake
// preload (window.avb.aiDiff answers from a table and records every call), click as a person would.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTranscript } = require('../../helpers/aiTranscriptDom.js');

const {
  modules: view,
  React,
  act,
  createRoot,
} = loadTranscript('aiChanges', [
  "export { ChangesCard } from './src/features/ai/transcript/ChangesCard';",
  "export { DiffView } from './src/features/ai/transcript/DiffView';",
  "export { resetChangeDiffs } from './src/features/ai/transcript/changeDiffs';",
  "export { loadAiProject, resetAiStore } from './src/features/ai/aiStore';",
]);

const PROJECT = '/site';
const CHAT = `c${'a'.repeat(24)}`;
const TURN = `t${'1'.repeat(16)}`;

const DIFFS = {
  '/site/src/a.ts': { oldText: 'const a = 1;\nconst b = 2;\n', newText: 'const a = 1;\nconst b = 3;\nconst c = 4;\n' },
  '/site/src/new.ts': { oldText: undefined, newText: 'export {};\n' },
  '/site/notes.md': { oldText: 'one\ntwo\n', newText: 'one\n' },
};

function fakeMain(replies = DIFFS) {
  const calls = [];
  window.avb = {
    aiAgents: async () => ({ trusted: true, agents: [], options: [] }),
    aiChats: async () => ({ chats: [], sections: [] }),
    onAiEvents: () => () => undefined,
    onAiAgentStatus: () => () => undefined,
    onAiSetup: () => () => undefined,
    aiAck: () => undefined,
    aiDiff: async (payload) => {
      calls.push(payload);
      const found = replies[payload.path];
      return found === undefined ? { ok: false, error: { code: 'invalid', message: 'settled' } } : { ok: true, value: found };
    },
  };
  return calls;
}

async function settle() {
  for (let round = 0; round < 5; round++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function mountCard(props) {
  view.resetAiStore();
  view.resetChangeDiffs();
  await view.loadAiProject(PROJECT);
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(view.ChangesCard, { projectPath: PROJECT, source: { chat: CHAT, turn: TURN }, ...props }));
  });
  await settle();
  return { container, root };
}

const files = (...entries) => entries.map(([path, change, review]) => ({ path, change, review }));
const button = (container, label) => {
  const found = [...container.querySelectorAll('button')].find(
    (element) => element.textContent.trim() === label || element.getAttribute('aria-label') === label,
  );
  assert.ok(found, `button ${label}`);
  return found;
};
const click = async (element) => {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  });
  await settle();
};

test('the head counts files and lines; each row shows its own counts, status and Keep/Undo', async (context) => {
  const calls = fakeMain();
  const { container, root } = await mountCard({
    files: files(['/site/src/a.ts', 'modified', 'pending'], ['/site/src/new.ts', 'created', 'pending'], ['/site/notes.md', 'modified', 'kept']),
    onReview: () => undefined,
  });
  context.after(() => act(() => root.unmount()));
  const head = container.querySelector('.ai-changes-card-title').textContent;
  assert.match(head, /3 files changed/);
  // The kept file was never loaded here (settled files are not asked for), so no total is claimed.
  assert.doesNotMatch(head, /\+\d/);
  assert.deepEqual(calls.map((call) => call.path).sort(), ['/site/src/a.ts', '/site/src/new.ts'], 'only pending files are fetched');
  const rows = [...container.querySelectorAll('.ai-file')];
  assert.equal(rows.length, 3);
  assert.match(rows[0].textContent, /a\.ts/);
  assert.match(rows[0].querySelector('.ai-file-counts').textContent, /\+2\s*−1/);
  assert.match(rows[1].textContent, /New/);
  assert.match(rows[1].querySelector('.ai-file-counts').textContent, /\+1\s*−0/);
  assert.equal(rows[2].querySelector('.ai-file-done').textContent, 'Kept');
  assert.equal(rows[2].querySelectorAll('.ai-file-actions button').length, 0, 'a settled file has no Keep or Undo');
});

test('with every file counted the head totals them', async (context) => {
  fakeMain();
  const { container, root } = await mountCard({
    files: files(['/site/src/a.ts', 'modified', 'pending'], ['/site/notes.md', 'modified', 'pending']),
    onReview: () => undefined,
  });
  context.after(() => act(() => root.unmount()));
  assert.match(container.querySelector('.ai-changes-total').textContent, /\+2\s*−2/);
});

test('opening a row draws that file’s diff, loaded once however often it is opened', async (context) => {
  const calls = fakeMain();
  const { container, root } = await mountCard({ files: files(['/site/src/a.ts', 'modified', 'pending']), onReview: () => undefined });
  context.after(() => act(() => root.unmount()));
  assert.equal(container.querySelector('.ai-diffview') ?? undefined, undefined, 'collapsed until opened');
  const toggle = container.querySelector('.ai-file-toggle');
  await click(toggle);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  assert.ok(container.querySelector('.history-diff-line.added'));
  assert.ok(container.querySelector('.history-diff-line.deleted'));
  await click(toggle);
  await click(toggle);
  assert.equal(calls.length, 1, 'one aiDiff call for the file');
});

test('a settled file’s row says its diff is gone; a file the host cannot diff says so', async (context) => {
  fakeMain({});
  const { container, root } = await mountCard({
    files: files(['/site/src/a.ts', 'modified', 'pending'], ['/site/notes.md', 'modified', 'undone']),
    onReview: () => undefined,
  });
  context.after(() => act(() => root.unmount()));
  const toggles = [...container.querySelectorAll('.ai-file-toggle')];
  await click(toggles[0]);
  await click(toggles[1]);
  const notes = [...container.querySelectorAll('.ai-file-gone')].map((element) => element.textContent);
  assert.deepEqual(notes, ['The diff could not be loaded.', 'The diff is no longer available once a change is undone.']);
});

test('Keep and Undo call the existing review flow with the file’s own path', async (context) => {
  fakeMain();
  const reviews = [];
  const { container, root } = await mountCard({
    files: files(['/site/src/a.ts', 'modified', 'pending']),
    onReview: (path, action) => void reviews.push([path, action]),
  });
  context.after(() => act(() => root.unmount()));
  assert.equal([...container.querySelectorAll('button')].filter((element) => /all$/.test(element.textContent)).length, 0, 'no bulk buttons for one file');
  await click(button(container, 'Keep'));
  await click(button(container, 'Undo'));
  assert.deepEqual(reviews, [
    ['/site/src/a.ts', 'keep'],
    ['/site/src/a.ts', 'undo'],
  ]);
});

test('Undo all and Keep all settle files one after another, each waiting for the last (a drifted undo opens the merge editor)', async (context) => {
  fakeMain();
  const order = [];
  let release;
  const { container, root } = await mountCard({
    files: files(['/site/src/a.ts', 'modified', 'pending'], ['/site/notes.md', 'modified', 'pending'], ['/site/src/new.ts', 'created', 'kept']),
    onReview: (path, action) => {
      order.push(`${action} ${path}`);
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  });
  context.after(() => act(() => root.unmount()));
  await click(button(container, 'Undo all'));
  assert.deepEqual(order, ['undo /site/src/a.ts'], 'the second file waits for the first');
  assert.ok(button(container, 'Keep all').disabled, 'bulk buttons are held while a review runs');
  await act(async () => release());
  await settle();
  assert.deepEqual(order, ['undo /site/src/a.ts', 'undo /site/notes.md'], 'the settled file is skipped');
  await act(async () => release());
  await settle();
  assert.equal(button(container, 'Keep all').disabled, false);
});

test('"Open file" exists only when the shell supplies it, and gets the file’s path', async (context) => {
  fakeMain();
  const opened = [];
  const first = await mountCard({ files: files(['/site/src/a.ts', 'modified', 'pending']), onReview: () => undefined });
  assert.equal(first.container.querySelectorAll('.ai-file-open-button').length, 0);
  await act(() => first.root.unmount());
  const second = await mountCard({
    files: files(['/site/src/a.ts', 'modified', 'pending']),
    onReview: () => undefined,
    onOpenFile: (path) => opened.push(path),
  });
  context.after(() => act(() => second.root.unmount()));
  await click(second.container.querySelector('.ai-file-open-button'));
  assert.deepEqual(opened, ['/site/src/a.ts']);
});

test('without a source the card still reviews, with no diffs or counts', async (context) => {
  const calls = fakeMain();
  const { container, root } = await mountCard({ files: files(['/site/src/a.ts', 'modified', 'pending']), source: undefined, onReview: () => undefined });
  context.after(() => act(() => root.unmount()));
  assert.equal(calls.length, 0);
  assert.equal(container.querySelectorAll('.ai-file-counts').length, 0);
  assert.match(container.textContent, /1 file changed/);
});

async function mountDiff(diff, props = {}) {
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(view.DiffView, { diff, projectPath: PROJECT, ...props }));
  });
  await settle();
  return { container, root };
}

test('the diff view names the file, counts the change, numbers the lines and signs the rows', async (context) => {
  const { container, root } = await mountDiff({ path: '/site/src/a.ts', ...DIFFS['/site/src/a.ts'] });
  context.after(() => act(() => root.unmount()));
  assert.equal(container.querySelector('.ai-diff-path').textContent, 'src/a.ts');
  assert.match(container.querySelector('.ai-diffview-counts').textContent, /\+2\s*−1/);
  const rows = [...container.querySelectorAll('.history-diff-line')].map((row) => [
    row.className.replace('history-diff-line ', ''),
    row.querySelector('.history-diff-number').textContent,
    row.querySelector('.history-diff-sign').textContent,
    row.querySelector('.history-diff-code').textContent,
  ]);
  assert.deepEqual(rows, [
    ['context', '1', '', 'const a = 1;'],
    ['deleted', '2', '−', 'const b = 2;'],
    ['added', '2', '+', 'const b = 3;'],
    ['added', '3', '+', 'const c = 4;'],
  ]);
  assert.ok(container.querySelector('.history-diff-code .code-token'), 'the code is syntax coloured');
});

test('the words that changed inside an edited line are marked', async (context) => {
  const { container, root } = await mountDiff({ path: '/site/src/a.ts', ...DIFFS['/site/src/a.ts'] });
  context.after(() => act(() => root.unmount()));
  const marks = [...container.querySelectorAll('.ai-diff-word')].map((element) => element.textContent);
  assert.deepEqual(marks, ['2', '3']);
});

test('a created file says so; a binary or unchanged file draws a note instead of rows', async (context) => {
  const created = await mountDiff({ path: '/site/src/new.ts', oldText: undefined, newText: 'x\n' });
  assert.match(created.container.querySelector('.ai-diffview-head').textContent, /New file/);
  const binary = await mountDiff({ path: '/site/a.png', oldText: 'a\u0000', newText: 'b\u0000' });
  assert.match(binary.container.textContent, /Binary file, no preview/);
  assert.equal(binary.container.querySelectorAll('.history-diff-line').length, 0);
  const same = await mountDiff({ path: '/site/a.txt', oldText: 'a\r\n', newText: 'a\n' });
  assert.match(same.container.textContent, /Only line endings changed/);
  context.after(() => act(() => Promise.all([created.root.unmount(), binary.root.unmount(), same.root.unmount()])));
});

test('unchanged lines fold behind "Show N lines", which unfolds them; header "none" leaves the path to the caller', async (context) => {
  const long = Array.from({ length: 60 }, (_, index) => `line ${index + 1}`).join('\n');
  const { container, root } = await mountDiff({ path: '/site/a.txt', oldText: long, newText: long.replace('line 30', 'LINE 30') }, { header: 'none' });
  context.after(() => act(() => root.unmount()));
  assert.equal(container.querySelectorAll('.ai-diff-path').length, 0);
  const before = container.querySelectorAll('.history-diff-line').length;
  assert.equal(before, 8, 'a change with three lines of context each side');
  const gap = [...container.querySelectorAll('.ai-diffview-gap')][0];
  assert.match(gap.textContent, /Show 26 lines/);
  await click(gap);
  assert.equal(container.querySelectorAll('.history-diff-line').length, before + 26);
  assert.equal(container.querySelectorAll('.ai-diffview-gap').length, 1, 'the other gap is still folded');
});

test('a huge rewrite draws a capped number of rows and "Show full diff" raises the cap', async (context) => {
  const old = Array.from({ length: 300 }, (_, index) => `old ${index}`).join('\n');
  const next = Array.from({ length: 300 }, (_, index) => `new ${index}`).join('\n');
  const { container, root } = await mountDiff({ path: '/site/big.txt', oldText: old, newText: next });
  context.after(() => act(() => root.unmount()));
  assert.equal(container.querySelectorAll('.history-diff-line').length, 400);
  await click(button(container, 'Show full diff'));
  assert.equal(container.querySelectorAll('.history-diff-line').length, 600);
  assert.equal([...container.querySelectorAll('button')].filter((element) => element.textContent === 'Show full diff').length, 0);
});
