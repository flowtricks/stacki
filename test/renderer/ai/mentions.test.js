// Goal: mentions in the composer do what the person sees. The picker lists the built-in
// instructions, then skills, then files, within its twelve rows, and says so when there is
// nothing; a draft compares by what it reads, grows a chip at its end without touching the
// words before it and never past sixteen chips; a file dragged from the Pages or Assets
// panel becomes a chip only when its path is a project file (a folder, `..` or an absolute
// path is refused); a draft with chips survives storage and the bounds (16 chips, 256
// segments); sending expands a built-in chip into its bundled text and a build that never
// registered the text crashes before anything is sent; "Build an app" puts the chip in the
// composer (a new chat, an empty open chat, the end of a draft being typed) and never sends
// it, and with no AI chat the full instructions are copied.
// The host's side of the negative space (a path escaping the project, a link that leaves it,
// a seventeenth chip) is test/electron/handlers/ai/promptBlocks.test.ts.
// Method: the pure model is loaded through the renderer bundler; the store and the hand-off
// run bundled against a fake preload (window.avb) that records every call, with a Map-backed
// localStorage and clipboard.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

function bundle(name, contents) {
  const output = repoPath(`node_modules/.stacki-test/${name}.cjs`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  esbuild.buildSync({
    stdin: { contents, resolveDir: repoPath('package.json').replace(/package\.json$/, ''), loader: 'ts' },
    outfile: output,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    jsx: 'automatic',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    loader: { '.css': 'empty', '.svg': 'empty' },
    logLevel: 'silent',
  });
  return output;
}

// One bundle with everything the app loads (the Apps panel's prompt module provides the text), and one
// with the store alone: nothing registers the built-in text there.
const full = bundle(
  'mentionsFull',
  [
    "export * from './src/features/ai/aiStore';",
    "export * from './src/features/ai/mentions/mentionChips';",
    "export { BUILTIN_CHIPS, builtinChipText, matchingBuiltinChips, copyBuiltinChip, COPIED_LABEL_MS } from './src/features/ai/mentions/builtinChips';",
    "export { aiAgentTaskHandler } from './src/features/ai/aiAgentTask';",
    "export { registerAgentTaskHandler, requestAgentTask } from './src/lib/agentTasks';",
    "export { appBuildPrompt, requestBuildApp } from './src/features/apps/appPrompt';",
    "export { readStoredDrafts, writeStoredDrafts } from './src/features/ai/draftStorage';",
    "export { subscribeErrorToasts } from './src/ui/errorNotices';",
    "export { findTrigger, TRIGGER_QUERY_CHARS_MAX } from './src/ui/chipEditor/chipModel';",
  ].join('\n'),
);
const bare = bundle('mentionsBare', "export * from './src/features/ai/aiStore';");

const storage = new Map();
global.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : JSON.parse('null')),
  setItem: (key, value) => void storage.set(key, String(value)),
  removeItem: (key) => void storage.delete(key),
  clear: () => storage.clear(),
};
const clipboard = [];
let clipboardRefuses = false;
Object.defineProperty(global, 'navigator', {
  value: {
    platform: 'MacIntel',
    clipboard: {
      writeText: async (text) => {
        if (clipboardRefuses) {
          throw new Error('Document is not focused');
        }
        clipboard.push(text);
      },
    },
  },
  configurable: true,
});

const model = require(full);
const bareStore = require(bare);

const PROJECT = '/site';
const CHAT = `c${'a'.repeat(24)}`;
const OTHER = `c${'b'.repeat(24)}`;
const TURN = `t${'1'.repeat(16)}`;
const summary = (id) => ({ id, agent: 'claude', title: 'New chat', pinned: false, createdAt: 1, updatedAt: 1, rank: 0, unread: false });

const file = (name, folder = 'docs') => ({ kind: 'file', path: `${folder}/${name}`, name });
const skill = (name, source = 'project') => ({ kind: 'skill', name, description: `${name} does things`, source, path: `.claude/skills/${name}/SKILL.md` });
const fileChip = (pathText) => ({ kind: 'chip', chip: { kind: 'file', path: pathText, name: pathText.split('/').pop() } });
const builderChip = { kind: 'chip', chip: { kind: 'builtin', id: 'app-builder', title: 'App builder instructions' } };
const text = (value) => ({ kind: 'text', text: value });

// A fake preload that records every call. Chats created are listed from then on, as main does.
function install(store, { chats = [] } = {}) {
  const calls = [];
  const known = [...chats];
  const ok = (value) => ({ ok: true, value });
  const record = (name, reply) => async (payload) => {
    calls.push({ name, payload });
    return typeof reply === 'function' ? reply(payload) : reply;
  };
  global.window = {
    avb: {
      aiAgents: record('aiAgents', () => ({
        trusted: true,
        agents: [{ agent: 'claude', state: 'ready', adapterVersion: '1.0.0', running: false, downloadMegabytes: 1 }],
        options: [],
      })),
      aiChats: record('aiChats', () => ({ chats: [...known], sections: [] })),
      aiChatCreate: record('aiChatCreate', () => {
        const created = summary(known.length === 0 ? CHAT : OTHER);
        known.unshift(created);
        return ok(created);
      }),
      aiChatRead: record('aiChatRead', (payload) => ok({ summary: summary(payload.chat), events: [], full: false })),
      aiPrompt: record('aiPrompt', () => ok({ turn: TURN })),
      aiMentions: record('aiMentions', () => ok([])),
      aiAck: () => undefined,
      onAiEvents: () => () => undefined,
      onAiAgentStatus: () => () => undefined,
      onAiSetup: () => () => undefined,
    },
  };
  return { calls, named: (name) => calls.filter((call) => call.name === name) };
}

async function start(store, options) {
  store.resetAiStore();
  storage.clear();
  const fake = install(store, options);
  await store.loadAiProject(PROJECT);
  return fake;
}

// ---------------------------------------------------------------------------
// The picker's rows
// ---------------------------------------------------------------------------

test('the picker lists built-in instructions, then skills, then files, within its twelve rows', () => {
  const builtins = model.matchingBuiltinChips('');
  assert.equal(builtins.length, 1);
  const candidates = [skill('a'), skill('b'), ...Array.from({ length: 20 }, (_, index) => file(`f${index}.md`))];
  const rows = model.pickerRows(builtins, candidates);
  assert.equal(rows.length, model.PICKER_ROWS_MAX);
  assert.deepEqual([...new Set(rows.map((row) => row.group))], ['Built-in', 'Skills', 'Files'], 'the groups come in the plan’s order');
  assert.equal(rows[0].label, 'App builder instructions');
  assert.equal(rows[0].chip.kind, 'builtin');
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length, 'row ids are unique');
});

test('skills never crowd files out: with many of both, files keep at least four rows', () => {
  const rows = model.pickerRows(model.matchingBuiltinChips(''), [
    ...Array.from({ length: 30 }, (_, index) => skill(`s${index}`)),
    ...Array.from({ length: 30 }, (_, index) => file(`f${index}.md`)),
  ]);
  assert.equal(rows.length, 12);
  assert.ok(rows.filter((row) => row.group === 'Files').length >= 4);
  const onlySkills = model.pickerRows(
    [],
    Array.from({ length: 30 }, (_, index) => skill(`s${index}`)),
  );
  assert.equal(onlySkills.length, 12, 'with no files, skills may take every row');
});

test('the picker with no results has no rows, and the built-in instructions match by title or keyword only', () => {
  assert.deepEqual(model.pickerRows([], []), []);
  assert.equal(model.matchingBuiltinChips('zzzz').length, 0);
  assert.equal(model.matchingBuiltinChips('app').length, 1);
  assert.equal(model.matchingBuiltinChips('INSTR').length, 1, 'case does not matter');
  assert.equal(model.matchingBuiltinChips('abi').length, 1, 'a loose in-order match of the title (a-pp-b-uilder-i)');
});

test('an over-long query is not a trigger at all, so nothing is searched for it', () => {
  assert.equal(model.findTrigger(`@${'x'.repeat(model.TRIGGER_QUERY_CHARS_MAX + 1)}`, '@'), undefined);
  assert.equal(model.findTrigger('@abc', '@').query, 'abc');
});

// ---------------------------------------------------------------------------
// How chips look
// ---------------------------------------------------------------------------

test('a chip is drawn by kind: a file by name with its path on hover, a skill by name, the instructions with what a click does', () => {
  assert.deepEqual(model.chipLook({ kind: 'file', path: 'docs/apps.md', name: 'apps.md' }), { label: 'apps.md', title: 'docs/apps.md', kind: 'file' });
  assert.equal(model.chipLook({ kind: 'skill', name: 'lumos', source: 'project', path: '.claude/skills/lumos/SKILL.md' }).kind, 'skill');
  const builtin = model.chipLook(builderChip.chip);
  assert.equal(builtin.label, 'App builder instructions');
  assert.match(builtin.title, /Click to copy/);
});

// ---------------------------------------------------------------------------
// Drafts
// ---------------------------------------------------------------------------

test('two drafts that read the same are equal, however their text runs are split', () => {
  assert.ok(model.segmentsEqual([text('a'), text('b'), text('')], [text('ab')]));
  assert.ok(model.segmentsEqual([], [text('')]));
  assert.ok(!model.segmentsEqual([text('a')], [text('b')]));
  assert.ok(!model.segmentsEqual([fileChip('a.md')], [fileChip('b.md')]));
  assert.ok(!model.segmentsEqual([fileChip('a.md')], [text('a.md')]));
  assert.ok(model.segmentsEqual([builderChip], [builderChip]));
});

test('appending a chip keeps the words before it, spaces it from them, and adds it only below the limit', () => {
  const chip = builderChip.chip;
  assert.deepEqual(model.appendChip([], chip), [builderChip, text(' ')]);
  assert.deepEqual(model.appendChip([text('Make a timer')], chip), [text('Make a timer '), builderChip, text(' ')]);
  assert.deepEqual(model.appendChip([text('Make a timer ')], chip), [text('Make a timer '), builderChip, text(' ')], 'no second space');
  const full = Array.from({ length: 16 }, (_, index) => fileChip(`f${index}.md`));
  assert.equal(model.appendChip(full, chip), full, 'at sixteen chips the draft is returned as it was');
  assert.ok(model.hasBuiltinChip(model.appendChip([], chip), 'app-builder'));
  assert.ok(!model.hasBuiltinChip(full, 'app-builder'));
});

test('a file dragged from the Pages or Assets panel is a chip only when it is a project file', () => {
  const dragged = (type, value) => ({ types: [type], getData: (asked) => (asked === type ? value : '') });
  assert.deepEqual(model.chipFromDrag(dragged('avb/asset', 'public/logo.svg')), { kind: 'file', path: 'public/logo.svg', name: 'logo.svg' });
  assert.deepEqual(model.chipFromDrag(dragged('avb/page', JSON.stringify({ path: 'src/pages/index.astro', name: 'index' }))), {
    kind: 'file',
    path: 'src/pages/index.astro',
    name: 'index.astro',
  });
  for (const bad of ['public/images', '../secret.md', '/etc/hosts.conf', 'a/../b.md', 'C:/x.md', 'a\\b.md', '', 'a//b.md', './a.md']) {
    assert.equal(model.chipFromDrag(dragged('avb/asset', bad)), undefined, `asset ${JSON.stringify(bad)}`);
    assert.equal(model.chipFromDrag(dragged('avb/page', JSON.stringify({ path: bad, name: 'x' }))), undefined, `page ${JSON.stringify(bad)}`);
  }
  assert.equal(model.chipFromDrag(dragged('avb/page', 'not json')), undefined);
  assert.equal(model.chipFromDrag(dragged('avb/page', JSON.stringify({ name: 'x' }))), undefined);
  assert.equal(model.chipFromDrag(dragged('avb/page', JSON.stringify(['a.md']))), undefined);
  assert.equal(model.chipFromDrag({ types: ['text/plain'], getData: (asked) => (asked === 'text/plain' ? 'a.md' : '') }), undefined);
  assert.ok(model.isFileDrag(['Files', 'avb/asset']));
  assert.ok(!model.isFileDrag(['Files', 'text/plain']));
});

test('a draft with chips survives a reload; a stored draft with a bad chip is dropped alone', async () => {
  await start(model);
  const draft = [text('Look at '), fileChip('docs/apps.md'), text(' and '), builderChip, text(' ')];
  model.writeStoredDrafts(PROJECT, new Map([[CHAT, draft]]));
  assert.ok(model.segmentsEqual(model.readStoredDrafts(PROJECT).get(CHAT), draft));

  const key = `stacki.ai.drafts.${PROJECT}`;
  const stored = JSON.parse(localStorage.getItem(key));
  const bad = [text('x'), { kind: 'chip', chip: { kind: 'file', path: '../secret.md', name: 'secret.md' } }];
  const unknown = [{ kind: 'chip', chip: { kind: 'bogus' } }];
  stored.drafts.push({ chat: OTHER, segments: bad }, { chat: `c${'c'.repeat(24)}`, segments: unknown });
  localStorage.setItem(key, JSON.stringify(stored));
  const restored = model.readStoredDrafts(PROJECT);
  assert.deepEqual([...restored.keys()], [CHAT], 'a path escaping the project and an unknown chip kind are dropped; the good draft stays');
});

test('a draft past the bounds is cut to sixteen chips and 256 segments, never refused', async () => {
  await start(model);
  const many = Array.from({ length: 127 }, (_, index) => fileChip(`docs/f${index}.md`));
  model.setDraft(CHAT, () => ({ segments: many, attachments: [] }));
  const kept = model.aiState().drafts.get(CHAT).segments;
  assert.equal(model.chipCountOf(kept), 16);
  const alternating = Array.from({ length: 300 }, (_, index) => (index % 2 === 0 ? text('a') : fileChip(`docs/f${index}.md`)));
  model.setDraft(CHAT, () => ({ segments: alternating, attachments: [] }));
  assert.ok(model.aiState().drafts.get(CHAT).segments.length <= 256);
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

test('sending expands the App builder chip into its bundled text, with the plain text as the fallback', async () => {
  const fake = await start(model, { chats: [summary(CHAT)] });
  await model.openChat(CHAT);
  model.setDraft(CHAT, () => ({ segments: [text('Make a timer. '), builderChip, text(' Thanks.')], attachments: [] }));
  assert.equal(await model.sendPrompt(CHAT), true);
  const payload = fake.named('aiPrompt')[0].payload;
  assert.equal(payload.text, 'Make a timer. App builder instructions Thanks.');
  assert.deepEqual(
    payload.parts.map((part) => part.kind),
    ['text', 'builtin', 'text'],
  );
  assert.equal(payload.parts[1].id, 'app-builder');
  assert.equal(payload.parts[1].text, model.appBuildPrompt(), 'the part carries exactly the bundled instructions');
  assert.equal(model.aiState().drafts.get(CHAT).segments.length, 0, 'the draft is cleared once it is taken');
});

test('a build that never registered the built-in text crashes before sending, and the draft is kept', async () => {
  const fake = await start(bareStore, { chats: [summary(CHAT)] });
  await bareStore.openChat(CHAT);
  bareStore.setDraft(CHAT, () => ({ segments: [builderChip], attachments: [] }));
  await assert.rejects(bareStore.sendPrompt(CHAT), /built-in chip text is registered/);
  assert.equal(fake.named('aiPrompt').length, 0, 'nothing was sent');
  assert.equal(bareStore.aiState().drafts.get(CHAT).segments.length, 1, 'the words are not lost');
});

test('the bundled text is checked: it is never empty and fits a prompt part', () => {
  const text = model.builtinChipText('app-builder');
  assert.ok(text.length > 0);
  assert.ok(text.length <= 60_000);
});

// ---------------------------------------------------------------------------
// "Build an app"
// ---------------------------------------------------------------------------

function handler(opened) {
  return model.aiAgentTaskHandler({ projectPath: () => PROJECT, available: () => true, openPanel: () => opened.push('opened') });
}
const buildTask = () => ({
  title: 'Build an app',
  prompt: model.appBuildPrompt(),
  delivery: 'draft',
  draftChip: 'app-builder',
  context: { files: [], nodeRefs: [], findingIds: [] },
});

test('Build an app puts the chip in the composer of a new chat and never sends it', async () => {
  const fake = await start(model);
  const opened = [];
  const answer = await handler(opened)(buildTask());
  assert.equal(answer.tag, 'sent');
  assert.deepEqual(opened, ['opened']);
  assert.equal(fake.named('aiChatCreate').length, 1);
  const chat = model.aiState().open;
  assert.ok(model.hasBuiltinChip(model.aiState().drafts.get(chat).segments, 'app-builder'));
  assert.equal(model.draftText(model.aiState().drafts.get(chat)).trim(), 'App builder instructions', 'the chip, not the long text, is in the box');
  assert.equal(fake.named('aiPrompt').length, 0, 'a draft is never sent');
});

test('Build an app asks the message box for the keyboard, in a new chat and in one already open', async () => {
  await start(model, { chats: [summary(CHAT)] });
  const before = model.aiState().composerFocusRequests;
  await handler([])(buildTask());
  assert.equal(model.aiState().composerFocusRequests, before + 1, 'the box is asked to focus once the chip is placed');
  await handler([])(buildTask());
  assert.equal(model.aiState().composerFocusRequests, before + 2, 'a chat that already holds the chip is focused again');
});

test('Build an app appends the chip to a draft being typed, keeping its words, and does not add it twice', async () => {
  const fake = await start(model, { chats: [summary(CHAT)] });
  await model.openChat(CHAT);
  model.setDraft(CHAT, () => ({ segments: [text('Make me a timer')], attachments: [] }));
  const opened = [];
  assert.equal((await handler(opened)(buildTask())).tag, 'sent');
  assert.equal(fake.named('aiChatCreate').length, 0, 'the open chat took it');
  const segments = model.aiState().drafts.get(CHAT).segments;
  assert.deepEqual(segments, [text('Make me a timer '), builderChip, text(' ')]);
  await handler(opened)(buildTask());
  assert.equal(model.chipCountOf(model.aiState().drafts.get(CHAT).segments), 1, 'a second click adds no second chip');
});

test('Build an app reuses an empty open chat, and starts a new one when the open chat has messages but no draft', async () => {
  const fake = await start(model, { chats: [summary(CHAT)] });
  await model.openChat(CHAT);
  await handler([])(buildTask());
  assert.equal(fake.named('aiChatCreate').length, 0, 'an empty chat with an empty box is reused');
  assert.ok(model.hasBuiltinChip(model.aiState().drafts.get(CHAT).segments, 'app-builder'));

  model.setDraft(CHAT, () => ({ segments: [], attachments: [] }));
  model.receiveEvents({
    projectPath: PROJECT,
    chat: CHAT,
    events: [{ kind: 'user', turn: TURN, text: 'hello', attachments: [], at: 1 }],
  });
  await handler([])(buildTask());
  assert.equal(fake.named('aiChatCreate').length, 1, 'a chat with a conversation is left alone');
  assert.notEqual(model.aiState().open, CHAT);
});

test('Build an app at the mention limit is declined, so the prompt is copied instead', async () => {
  await start(model, { chats: [summary(CHAT)] });
  await model.openChat(CHAT);
  const sixteen = Array.from({ length: 16 }, (_, index) => fileChip(`docs/f${index}.md`));
  model.setDraft(CHAT, () => ({ segments: sixteen, attachments: [] }));
  assert.equal((await handler([])(buildTask())).tag, 'declined');
});

test('with no AI chat to take it, Build an app copies the full instructions and says so', async () => {
  clipboard.length = 0;
  const unregister = model.registerAgentTaskHandler('declines', 50, async () => ({ tag: 'declined' }));
  const notices = [];
  await model.requestBuildApp((message, kind) => notices.push({ message, kind }));
  unregister();
  assert.deepEqual(clipboard, [model.appBuildPrompt()], 'the whole prompt is on the clipboard');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].kind, 'success');
  assert.match(notices[0].message, /prompt is copied/);
});

test('a chip click copies the same text; a refused copy reports a toast and reads as not copied', async () => {
  clipboard.length = 0;
  assert.equal(await model.copyBuiltinChip('app-builder'), true);
  assert.deepEqual(clipboard, [model.appBuildPrompt()]);
  const toasts = [];
  const stop = model.subscribeErrorToasts(
    (toast) => toasts.push(toast),
    () => undefined,
  );
  clipboardRefuses = true;
  assert.equal(await model.copyBuiltinChip('app-builder'), false);
  clipboardRefuses = false;
  stop();
  assert.equal(toasts.length, 1);
  assert.match(JSON.stringify(toasts[0]), /Couldn.t copy the instructions/);
});
