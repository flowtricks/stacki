// Goal: the pure rules of comment pins hold. Pins number from one and the board is bounded; a crop replaces the
// last crop and images stop at their bounds; deleting asks only when words or added images would be lost; a sent
// pin reads its progress from the transcript alone, both for one message with a subagent per pin (matched by its
// "Pin <n>:" title) and for one message per pin; a send carries each pin's images in order with notes and plain
// words that hold no path; a pin stays on its element through an edit that moved it, follows its words edited in
// place, and is detached when its element is gone; a crop stays inside the canvas and its size bounds.
// Method: the real reducer folds events shaped as the host writes them (a scripted Claude run: Agent calls titled
// per pin, a permission inside one, results); the pure model (src/features/ai/pins/pinModel.ts) is called directly.
const test = require('node:test');
const assert = require('node:assert/strict');
const loadRenderer = require('../../helpers/rendererModule.js');

const model = loadRenderer('src/features/ai/pins/pinModel.ts');
const { EMPTY_CHAT, reduceChat } = loadRenderer('src/features/ai/chatReducer.ts');

const CHAT = `c${'1'.repeat(24)}`;
const TURN = `t${'2'.repeat(16)}`;
const pinId = (number) => `p${String(number).padStart(16, '0')}`;
const imageId = (number) => `i${String(number).padStart(16, '0')}`;
const EMPTY = { version: 1, pins: [] };

const anchor = { path: '0.1', occurrence: 0, at: { x: 0.5, y: 0.5 }, tag: 'h1', text: 'Welcome' };
const place = {
  page: 'src/pages/index.astro',
  pageLabel: 'Home',
  scope: undefined,
  file: 'src/pages/index.astro',
  locator: '0.1',
  elementLabel: 'Heading “Welcome”',
  componentFile: undefined,
  breakpointPx: 768,
};

function added(board, number) {
  const outcome = model.addPin(board, { id: pinId(number), anchor, place, at: 10 });
  assert.equal(outcome.kind, 'added');
  return outcome;
}

test('pins number from one, count up, start again on an empty board, and the board is bounded', () => {
  const one = added(EMPTY, 1);
  assert.equal(one.pin.number, 1);
  const two = added(one.board, 2);
  assert.equal(two.pin.number, 2);
  const removed = model.removePin(two.board, pinId(1));
  assert.equal(added(removed, 3).pin.number, 3, 'a deleted number is not reused while the board has pins');
  assert.equal(added(model.removePin(removed, pinId(2)), 4).pin.number, 1);
  let board = EMPTY;
  for (let number = 1; number <= 40; number += 1) {
    board = added(board, number).board;
  }
  assert.equal(model.addPin(board, { id: pinId(99), anchor, place, at: 1 }).kind, 'full');
});

test('images: a crop replaces the last crop, the count and the size stop the rest', () => {
  const { pin } = added(EMPTY, 1);
  const image = (number, kind, chars = 10) => ({ id: imageId(number), kind, name: `Image ${number}`, mimeType: 'image/png', chars });
  const sizes = new Map();
  const sizeOf = (id) => sizes.get(id) ?? 0;
  const first = model.addPinImages(pin, [image(1, 'crop')], 0, sizeOf);
  assert.deepEqual(
    model.workingCopy(first.pin).images.map((entry) => entry.id),
    [imageId(1)],
  );
  sizes.set(imageId(1), 10);
  const recrop = model.addPinImages(first.pin, [image(2, 'crop')], 10, sizeOf);
  assert.deepEqual(
    model.workingCopy(recrop.pin).images.map((entry) => entry.id),
    [imageId(2)],
    'the new crop takes the old one’s place',
  );
  const full = model.addPinImages(recrop.pin, [image(3, 'added'), image(4, 'added'), image(5, 'added'), image(6, 'added')], 10, sizeOf);
  assert.equal(full.kind, 'limited');
  assert.equal(full.reason, 'count');
  assert.equal(model.workingCopy(full.pin).images.length, 4);
  const heavy = model.addPinImages(pin, [image(7, 'added', 60_000_001)], 0, sizeOf);
  assert.equal(heavy.kind, 'limited');
  assert.equal(heavy.reason, 'size');
  assert.deepEqual(model.workingCopy(heavy.pin).images, []);
});

test('deleting asks only when words or added images would be lost', () => {
  assert.equal(model.hasContentToLose({ comment: '  ', images: [{ kind: 'crop' }] }), false);
  assert.equal(model.hasContentToLose({ comment: 'Bigger', images: [] }), true);
  assert.equal(model.hasContentToLose({ comment: '', images: [{ kind: 'added' }] }), true);
});

// A scripted Claude run: one message of pins, the coordinator starts a subagent per pin with the titles the brief asks for.
const userPins = { kind: 'user', turn: TURN, text: 'Comments on 3 pins', attachments: [], at: 1, parts: [{ kind: 'pins', mode: 'subagents', pins: [] }] };
const agentCall = (call, title, status, over = {}) => ({
  kind: 'tool',
  turn: TURN,
  call,
  title,
  toolKind: 'think',
  status,
  paths: undefined,
  diffs: undefined,
  output: undefined,
  exitCode: undefined,
  parent: undefined,
  toolName: 'Agent',
  at: 2,
  ...over,
});
const child = (call, parent) => ({ ...agentCall(call, 'Read Hero.astro', 'in_progress'), toolKind: 'read', toolName: 'Read', parent });
const sent = (number, mode = 'subagents', turn = TURN) => ({ number, delivery: { kind: 'sent', chat: CHAT, turn, mode, at: 1 } });

test('one message, a subagent per pin: each pin reads its own subagent, the rest of the run its turn', () => {
  const start = [{ kind: 'turn-start', turn: TURN, at: 1 }, userPins];
  const before = reduceChat(EMPTY_CHAT, start);
  assert.deepEqual(model.pinProgress(sent(1), before), { kind: 'working', end: 'own' }, 'before any subagent, the coordinator is working');
  const view = reduceChat(EMPTY_CHAT, [
    ...start,
    agentCall('a1', 'Pin 1: Bigger heading', 'in_progress'),
    child('r1', 'a1'),
    agentCall('a2', 'Pin 2: Fix spacing', 'completed'),
    agentCall('a4', 'Pin 4: New colour', 'in_progress'),
    { kind: 'permission', turn: TURN, request: 'p1', call: 'e4', title: 'Edit Hero.astro', options: [{ id: 'y', name: 'Allow', kind: 'allow_once' }] },
    { ...child('e4', 'a4'), toolKind: 'edit', toolName: 'Edit' },
  ]);
  assert.deepEqual(model.pinProgress(sent(1), view), { kind: 'working', end: 'own' });
  assert.deepEqual(model.pinProgress(sent(2), view), { kind: 'done' });
  assert.deepEqual(model.pinProgress(sent(3), view), { kind: 'queued' }, 'a pin whose subagent has not started yet waits');
  assert.deepEqual(
    model.pinProgress(sent(4), view),
    { kind: 'attention', reason: 'permission', request: 'p1' },
    'a permission inside its subagent needs the person, and names the card that answers it',
  );
  assert.equal(model.pinSubagentCall(view, TURN, 1), 'a1');
  const ended = reduceChat(view, [
    agentCall('a1', 'Pin 1: Bigger heading', 'failed'),
    { kind: 'turn-end', turn: TURN, stop: 'end_turn', message: undefined, at: 9 },
  ]);
  assert.deepEqual(model.pinProgress(sent(1), ended), { kind: 'unfinished', reason: 'failed' });
  assert.deepEqual(
    model.pinProgress(sent(3), ended),
    { kind: 'unfinished', reason: 'not-started' },
    'other pins had subagents and this one none: it is not claimed done',
  );
  const stopped = reduceChat(view, [{ kind: 'turn-end', turn: TURN, stop: 'cancelled', message: undefined, at: 9 }]);
  assert.deepEqual(model.pinProgress(sent(3), stopped), { kind: 'unfinished', reason: 'not-started' });
  assert.deepEqual(model.pinProgress(sent(1), undefined), { kind: 'sent' }, 'a chat not open here says only sent');
  assert.deepEqual(model.pinProgress({ number: 1, delivery: { kind: 'draft' } }, view), { kind: 'draft' });
});

test('finished: only a pin whose work is confirmed done, and never past a turn that ended badly', () => {
  const start = [{ kind: 'turn-start', turn: TURN, at: 1 }, userPins];
  const running = reduceChat(EMPTY_CHAT, [
    ...start,
    agentCall('a1', 'Pin 1: Bigger heading', 'completed'),
    agentCall('a2', 'Pin 2: Fix spacing', 'in_progress'),
  ]);
  assert.equal(model.pinFinished(sent(1), running), true, 'a subagent that finished while the turn runs: its pin is finished on its own');
  assert.equal(model.pinFinished(sent(2), running), false, 'one still at work is not');
  assert.equal(model.pinFinished(sent(3), running), false, 'one not started is not');
  assert.equal(model.pinFinished(sent(1), undefined), false, 'with its chat not read here, nothing is known');
  assert.equal(model.pinFinished({ number: 1, delivery: { kind: 'draft' } }, running), false, 'a draft is never finished');
  const failed = reduceChat(EMPTY_CHAT, [
    ...start,
    agentCall('a1', 'Pin 1: Bigger heading', 'completed'),
    { kind: 'turn-end', turn: TURN, stop: 'error', message: undefined, at: 9 },
  ]);
  assert.equal(model.pinFinished(sent(1), failed), true, 'a subagent whose call returned its own result finished, whatever came after');
  assert.equal(model.pinFinished(sent(3), failed), false, 'a pin with no subagent is not vouched for');
  const inBackground = reduceChat(EMPTY_CHAT, [
    ...start,
    agentCall('a1', 'Pin 1: Bigger heading', 'completed', { output: 'Async agent launched successfully.\nagentId: a1b2c3d4' }),
    { kind: 'turn-end', turn: TURN, stop: 'error', message: undefined, at: 9 },
  ]);
  assert.equal(model.pinFinished(sent(1), inBackground), false, 'one sent to the background is not finished by its launch');
  const well = reduceChat(EMPTY_CHAT, [
    ...start,
    agentCall('a1', 'Pin 1: Bigger heading', 'completed'),
    { kind: 'turn-end', turn: TURN, stop: 'end_turn', message: undefined, at: 9 },
  ]);
  assert.equal(model.pinFinished(sent(3), well), false, 'a pin never started while others were is not finished');
  const single = (stop) => reduceChat(EMPTY_CHAT, [...start, { kind: 'turn-end', turn: TURN, stop, message: undefined, at: 9 }]);
  assert.equal(model.pinFinished(sent(1, 'single'), single('end_turn')), true);
  assert.equal(model.pinFinished(sent(1, 'single'), single('cancelled')), false);
  assert.equal(model.pinFinished(sent(1, 'single'), reduceChat(EMPTY_CHAT, start)), false, 'its own turn still running');
});

test('one message per pin: waiting until it has a reply, then its reply decides', () => {
  const waiting = { number: 2, delivery: { kind: 'sent', chat: CHAT, turn: undefined, mode: 'single', at: 1 } };
  assert.deepEqual(model.pinProgress(waiting, EMPTY_CHAT), { kind: 'queued' });
  const start = [
    { kind: 'turn-start', turn: TURN, at: 1 },
    { ...userPins, parts: [{ kind: 'pins', mode: 'single', pins: [] }] },
  ];
  const running = reduceChat(EMPTY_CHAT, start);
  assert.deepEqual(model.pinProgress(sent(1, 'single'), running), { kind: 'working', end: 'own' });
  const done = reduceChat(running, [{ kind: 'turn-end', turn: TURN, stop: 'end_turn', message: undefined, at: 3 }]);
  assert.deepEqual(model.pinProgress(sent(1, 'single'), done), { kind: 'done' });
  const failed = reduceChat(running, [{ kind: 'turn-end', turn: TURN, stop: 'error', message: 'x', at: 3 }]);
  assert.deepEqual(model.pinProgress(sent(1, 'single'), failed), { kind: 'unfinished', reason: 'failed' });
});

test('a send: images in pin order with their notes, briefs naming them, words without paths', () => {
  let board = added(EMPTY, 1).board;
  board = added(board, 2).board;
  board = model.changePin(board, pinId(1), 20, (pin) => ({
    ...pin,
    savedAt: 20,
    edit: undefined,
    comment: 'Make it bigger\nand bolder',
    images: [
      { id: imageId(1), kind: 'crop', name: 'Pinned area', mimeType: 'image/png' },
      { id: imageId(2), kind: 'added', name: 'ref.jpg', mimeType: 'image/jpeg' },
    ],
  }));
  board = model.changePin(board, pinId(2), 20, (pin) => ({ ...pin, included: false, savedAt: 20, edit: undefined, comment: 'Later' }));
  const chosen = model.pinsToSend(board);
  assert.deepEqual(
    chosen.map((pin) => pin.number),
    [1],
    'an excluded pin is left for later',
  );
  const data = new Map([
    [imageId(1), 'aGVsbG8='],
    [imageId(2), 'd29ybGQ='],
  ]);
  const message = model.pinMessage(
    chosen,
    'subagents',
    (id) => data.get(id),
    (pins) => `Comments on ${pins.length} pins`,
  );
  assert.equal(message.attachments.length, 2);
  assert.match(message.attachments[0].note, /^Pin 1, image 1: the pinned area/);
  assert.match(message.attachments[1].note, /^Pin 1, image 2: an image the person added/);
  assert.deepEqual(message.brief.pins[0].images, [0, 1]);
  assert.equal(message.brief.pins[0].file, 'src/pages/index.astro');
  assert.ok(!message.text.includes('src/'), 'the plain words hold no path');
  assert.equal(model.commentLine('  First line that is long\nsecond', 10), 'First lin…');
});

function canvas(over = {}) {
  const elements = new Map([
    ['0.1', { tag: 'h1', text: 'Welcome' }],
    ['0.2', { tag: 'p', text: 'Hello' }],
  ]);
  return {
    page: 'src/pages/index.astro',
    scope: undefined,
    rendered: new Set(['0.1', '0.2', 'src/components/Card.astro|0.0']),
    owns: (path) => !path.includes('|'),
    elementAt: (path) => elements.get(path),
    find: (tag, text) => [...elements].filter(([, element]) => element.tag === tag && element.text === text).map(([path]) => path),
    ...over,
  };
}

test('anchors: stay, follow a moved element, keep words edited in place, detach when gone, wait elsewhere', () => {
  const pin = { anchor, place };
  assert.deepEqual(model.resolveAnchor(pin, canvas()), { kind: 'attached', path: '0.1', moved: false });
  // An element inserted before it: the heading is now at 0.2, and 0.1 holds something else.
  const shifted = new Map([
    ['0.1', { tag: 'div', text: undefined }],
    ['0.2', { tag: 'h1', text: 'Welcome' }],
  ]);
  assert.deepEqual(model.resolveAnchor(pin, canvas({ elementAt: (path) => shifted.get(path), find: () => ['0.2'] })), {
    kind: 'attached',
    path: '0.2',
    moved: true,
  });
  // Its words edited where it stands.
  const edited = new Map([['0.1', { tag: 'h1', text: 'Hello there' }]]);
  assert.deepEqual(model.resolveAnchor(pin, canvas({ elementAt: (path) => edited.get(path), find: () => [] })), {
    kind: 'attached',
    path: '0.1',
    moved: false,
  });
  // Gone: nothing at the path, nothing with its tag and words.
  assert.deepEqual(model.resolveAnchor(pin, canvas({ elementAt: () => undefined, find: () => [] })), { kind: 'detached' });
  // Two candidates are not one: the pin will not guess.
  assert.deepEqual(model.resolveAnchor(pin, canvas({ elementAt: () => undefined, find: () => ['0.1', '0.2'] })), { kind: 'detached' });
  assert.deepEqual(model.resolveAnchor(pin, canvas({ page: 'src/pages/about.astro' })), { kind: 'elsewhere' });
  assert.deepEqual(
    model.resolveAnchor(pin, canvas({ rendered: undefined })),
    { kind: 'attached', path: '0.1', moved: false },
    'before the canvas reports, the pin waits where it was',
  );
  const inside = { anchor: { ...anchor, path: 'src/components/Card.astro|0.0' }, place };
  assert.equal(model.resolveAnchor(inside, canvas()).kind, 'attached');
  assert.equal(model.resolveAnchor(inside, canvas({ rendered: new Set() })).kind, 'detached');
});

test('a point and a crop: inside the box, padded, bounded, and inside the canvas', () => {
  assert.deepEqual(model.pointInBox({ x: 100, y: 50, w: 200, h: 100 }, { x: 150, y: 100 }), { x: 0.25, y: 0.5 });
  assert.deepEqual(model.pointInBox({ x: 0, y: 0, w: 0, h: 0 }, { x: 5, y: 5 }), { x: 0.5, y: 0.5 });
  assert.deepEqual(model.markerPosition({ x: 10, y: 20, w: 100, h: 40 }, { x: 0.5, y: 0.5 }, 2), { left: 120, top: 80 });
  const clip = { x: 300, y: 100, width: 800, height: 600 };
  const small = model.cropRect({ box: { x: 10, y: 10, w: 20, h: 10 }, at: { x: 0.5, y: 0.5 }, scale: 1, origin: { x: 300, y: 100 }, clip });
  assert.ok(small.width >= 160 && small.height >= 100);
  assert.ok(small.x >= clip.x && small.y >= clip.y, 'never outside the canvas');
  const large = model.cropRect({ box: { x: 0, y: 0, w: 4000, h: 3000 }, at: { x: 0.05, y: 0.05 }, scale: 1, origin: { x: 300, y: 100 }, clip });
  assert.ok(large.width <= 960 && large.height <= 640);
  assert.equal(model.cropRect({ box: { x: 5000, y: 5000, w: 10, h: 10 }, at: { x: 0, y: 0 }, scale: 1, origin: { x: 300, y: 100 }, clip }), undefined);
});

test('saving: words or an added image save, a crop alone does not; Send all takes only what was saved', () => {
  const { pin } = added(EMPTY, 1);
  const crop = { id: imageId(1), kind: 'crop', name: 'Pinned area', mimeType: 'image/png' };
  const withCrop = { ...pin, edit: { comment: '  ', images: [crop] } };
  assert.equal(model.hasPersonContent(model.workingCopy(withCrop)), false, 'a crop alone is not a comment');
  assert.throws(() => model.savePinEdit(withCrop, 30), /a pin is saved with words or an added image/);
  const typed = { ...withCrop, edit: { comment: 'Bigger', images: [crop] } };
  const saved = model.savePinEdit(typed, 30);
  assert.equal(saved.comment, 'Bigger');
  assert.equal(saved.savedAt, 30);
  assert.equal(saved.edit, undefined);
  assert.equal(model.pinsToSend({ version: 1, pins: [typed] }).length, 0, 'an unsaved pin is never sent');
  assert.equal(model.pinsToSend({ version: 1, pins: [saved] }).length, 1);
  const editing = { ...saved, edit: { comment: 'Much bigger', images: [crop] } };
  assert.equal(model.pinsToSend({ version: 1, pins: [editing] })[0].comment, 'Bigger', 'Send all takes the saved words, never the box');
});

test('closing: discard drops a pin never saved and only the changes of a saved one; keep saves content', () => {
  const { pin } = added(EMPTY, 1);
  const typed = { ...pin, edit: { comment: 'Bigger', images: [] } };
  assert.equal(model.closeOutcome(pin, 'discard'), 'remove');
  assert.equal(model.closeOutcome(pin, 'keep'), 'remove', 'an empty pin never saved is let go');
  assert.equal(model.closeOutcome(typed, 'discard'), 'remove');
  assert.equal(model.closeOutcome(typed, 'keep'), 'save', 'a press elsewhere never loses typed words');
  const saved = model.savePinEdit(typed, 30);
  assert.equal(model.closeOutcome(saved, 'discard'), 'unchanged');
  const changed = { ...saved, edit: { comment: 'Smaller', images: [] } };
  assert.equal(model.closeOutcome(changed, 'discard'), 'discard');
  assert.equal(model.discardPinEdit(changed).comment, 'Bigger', 'the saved comment stays');
  assert.equal(model.closeOutcome(changed, 'keep'), 'save');
  const cleared = { ...saved, edit: { comment: '', images: [] } };
  assert.equal(model.closeOutcome(cleared, 'keep'), 'discard', 'an emptied box keeps what was saved');
  const sent = { ...changed, delivery: { kind: 'sent', chat: CHAT, turn: TURN, mode: 'subagents', at: 1 } };
  assert.equal(model.closeOutcome(sent, 'discard'), 'unchanged');
  assert.equal(model.hasUnsavedChanges(saved), false);
  assert.equal(model.hasUnsavedChanges(changed), true);
});

test('moving: a pin keeps its number, words, images and unsaved changes; a sent pin does not move', () => {
  const { pin } = added(EMPTY, 1);
  const editing = { ...pin, edit: { comment: 'Unsaved words', images: [] } };
  const target = { anchor: { ...anchor, path: '0.4', tag: 'p', text: 'Hello' }, place: { ...place, locator: '0.4', elementLabel: 'Paragraph' } };
  const moved = model.movePinAnchor(editing, target);
  assert.equal(moved.number, 1);
  assert.equal(moved.anchor.path, '0.4');
  assert.equal(moved.place.elementLabel, 'Paragraph');
  assert.deepEqual(moved.edit, editing.edit);
  assert.throws(() => model.movePinAnchor({ ...editing, delivery: { kind: 'sent', chat: CHAT, turn: TURN, mode: 'single', at: 1 } }, target));
});

// The pin's model list: model names only, one row per model, the chat's own row being the one that follows it.
const CHAT_ROW = model.PIN_FOLLOWS_CHAT;
const named = (value, name, description) => ({ value, name, description });
const modelOption = (currentValue, choices) => [{ id: 'model', name: 'Model', category: 'model', currentValue, choices }];
const CLAUDE = [
  named('default', 'Default (recommended)', 'Opus 5.5 · Best for everyday, complex tasks'),
  named('opus', 'Opus 5.5'),
  named('fable', 'Fable 5.2'),
  named('sonnet', 'Sonnet 5.5'),
  named('haiku', 'Haiku 5.5'),
];
function rowsFor(options, pin = {}, { agent = 'claude', mode = 'subagents' } = {}) {
  const choices = model.pinModelChoices(mode, options);
  const resolved = model.resolvePinModel(pin, agent, options);
  const listed = model.pinModelRows({ choices, options, resolved, unnamed: 'Chat model' });
  return {
    rows: listed.rows.map((row) => `${row.value || '(chat)'} ${row.label}`),
    selected: listed.selected || '(chat)',
    shown: listed.rows.find((row) => row.value === listed.selected)?.label,
  };
}

test('the chat’s model is one row: an untouched pin is on it, and picking it follows the chat', () => {
  assert.deepEqual(rowsFor(modelOption('sonnet', CLAUDE)), {
    rows: ['opus Opus 5.5', 'fable Fable 5.2', '(chat) Sonnet 5.5', 'haiku Haiku 5.5'],
    selected: '(chat)',
    shown: 'Sonnet 5.5',
  });
  const other = rowsFor(modelOption('sonnet', CLAUDE), { model: { agent: 'claude', value: 'opus', name: 'Opus 5.5' } });
  assert.equal(other.selected, 'opus');
  assert.equal(other.shown, 'Opus 5.5');
  assert.ok(other.rows.includes(`${CHAT_ROW || '(chat)'} Sonnet 5.5`), 'the way back to following the chat');
});

test('a pin that chose the chat’s own model keeps that choice, on the one row for it', () => {
  const same = rowsFor(modelOption('sonnet', CLAUDE), { model: { agent: 'claude', value: 'sonnet', name: 'Sonnet 5.5' } });
  assert.deepEqual(same.rows, ['opus Opus 5.5', 'fable Fable 5.2', 'sonnet Sonnet 5.5', 'haiku Haiku 5.5']);
  assert.equal(same.selected, 'sonnet', 'stored as chosen: it stays on this model when the chat changes');
  const moved = rowsFor(modelOption('haiku', CLAUDE), { model: { agent: 'claude', value: 'sonnet', name: 'Sonnet 5.5' } });
  assert.equal(moved.selected, 'sonnet');
});

test('a chat on Claude’s Default is found by the model it stands for, without the tagline', () => {
  assert.deepEqual(rowsFor(modelOption('default', CLAUDE)), {
    rows: ['(chat) Opus 5.5', 'fable Fable 5.2', 'sonnet Sonnet 5.5', 'haiku Haiku 5.5'],
    selected: '(chat)',
    shown: 'Opus 5.5',
  });
});

test('a chat model that is no choice, or has no known name, gets one row of its own, first', () => {
  const full = rowsFor(modelOption('claude-opus-4-8', [...CLAUDE, named('claude-opus-4-8', 'Opus 4.8')]));
  assert.deepEqual(full.rows, ['(chat) Opus 4.8', 'opus Opus 5.5', 'fable Fable 5.2', 'sonnet Sonnet 5.5', 'haiku Haiku 5.5']);
  const unknown = rowsFor(modelOption('something-new', CLAUDE));
  assert.equal(unknown.rows[0], '(chat) Chat model');
  assert.equal(unknown.shown, 'Chat model');
  assert.equal(unknown.rows.length, 5);
});

test('Codex lists every model once, and a choice that cannot be used shows the chat’s model', () => {
  const codex = modelOption('gpt-b', [named('gpt-a', 'GPT A'), named('gpt-b', 'GPT B')]);
  assert.deepEqual(rowsFor(codex, {}, { agent: 'codex', mode: 'single' }), { rows: ['gpt-a GPT A', '(chat) GPT B'], selected: '(chat)', shown: 'GPT B' });
  const gone = rowsFor(codex, { model: { agent: 'claude', value: 'opus', name: 'Opus 5.5' } }, { agent: 'codex', mode: 'single' });
  assert.equal(gone.shown, 'GPT B');
});

test('at work: waiting, working or asking for permission; a pin that asked a question or ended is not', () => {
  const at = (kind, over = {}) => model.pinRunning({ kind, ...over });
  assert.equal(at('queued'), true);
  assert.equal(at('working', { end: 'reply' }), true);
  assert.equal(at('attention', { reason: 'permission', request: 'p1' }), true);
  assert.equal(at('attention', { reason: 'question' }), false);
  for (const kind of ['draft', 'done', 'unfinished', 'unreported', 'sent']) {
    assert.equal(at(kind), false, kind);
  }
});

// Two pins of one message, each with its own subagent doing something different: a row shows its own and no other.
const step = (call, parent, toolKind, file) => ({
  kind: 'tool',
  turn: TURN,
  call,
  title: `Step ${call}`,
  toolKind,
  status: 'in_progress',
  paths: [file],
  diffs: undefined,
  output: undefined,
  exitCode: undefined,
  parent,
  toolName: undefined,
  at: 3,
});
const brief = (numbers) => ({
  ...userPins,
  parts: [{ kind: 'pins', mode: 'subagents', pins: numbers.map((number) => ({ number, comment: 'x', pageLabel: 'Home', elementLabel: 'Heading' })) }],
});

test('live work: each pin has its own subagent’s newest step, and nothing before that is its own', () => {
  const started = reduceChat(EMPTY_CHAT, [{ kind: 'turn-start', turn: TURN, at: 1 }, brief([1, 2, 3]), step('own', undefined, 'read', 'src/a.astro')]);
  assert.deepEqual(model.pinWork(sent(1), started), { kind: 'none' }, 'the reply’s own work is for all its pins, so it is shown for none');
  const view = reduceChat(started, [
    agentCall('a1', 'Pin 1: Bigger', 'in_progress'),
    agentCall('a2', 'Pin 2: Bluer', 'in_progress'),
    step('s1', 'a1', 'edit', 'src/components/Hero.astro'),
    step('s2', 'a2', 'read', 'src/styles/base.css'),
  ]);
  const activity = (number) => {
    const work = model.pinWork(sent(number), view);
    return work.kind === 'subagent' ? work.agent.activity : work.kind;
  };
  assert.deepEqual(activity(1), { kind: 'file', verb: 'editing', file: 'Hero.astro' });
  assert.deepEqual(activity(2), { kind: 'file', verb: 'reading', file: 'base.css' });
  assert.equal(activity(3), 'none', 'a pin not started yet shows no other pin’s work');
});

test('live work: a pin worked by the reply itself shows the reply’s newest step: one message a pin, or a send of one', () => {
  for (const mode of ['single', 'subagents']) {
    const items = [
      { kind: 'turn-start', turn: TURN, at: 5 },
      { ...brief([1]), parts: [{ kind: 'pins', mode, pins: brief([1]).parts[0].pins }] },
    ];
    const quiet = reduceChat(EMPTY_CHAT, items);
    assert.deepEqual(model.pinWork(sent(1, mode), quiet), { kind: 'reply', activity: { kind: 'starting' }, startedAt: 5 });
    const working = reduceChat(quiet, [step('r1', undefined, 'edit', 'src/pages/index.astro')]);
    assert.deepEqual(model.pinWork(sent(1, mode), working).activity, { kind: 'file', verb: 'editing', file: 'index.astro' });
  }
});
