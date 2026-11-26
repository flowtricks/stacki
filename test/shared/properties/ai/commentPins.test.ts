// Goal: the comment pins contract holds at every boundary. A stored board reads back whole when good, loses only a
// damaged pin when not, and is bounded; a board a writer sends is refused whole when any part is bad; the brief a
// send carries refuses every bad shape and bound; the transcript keeps only words and names; and the schedule of a
// subagents send starts every pin at once up to the concurrency bound, in number order, and runs every pin once.
// Method: known-good values and one known-bad variation each through the parsers; the schedule's properties over
// seeded random sends (xorshift, so a failing seed reproduces) plus the cases a person meets.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  PIN_LIMITS,
  parsePinBrief,
  parseSentPins,
  pinImageNote,
  pinNumberOfTitle,
  pinQuestionsOf,
  pinWaves,
  sentPinsOf,
  withoutPinNumber,
} from '#dist/shared/properties/ai/commentPinBrief.js';
import { parsePinBoard, parsePinBoardRead, parsePinBoardStrict, parsePinImages } from '#dist/shared/properties/ai/commentPins.js';
import { parseIpcPayload } from '#dist/shared/ipc/ipcPayloads.js';
import { parseChatEvent } from '#dist/shared/properties/ai/chatModel.js';

const hex = (digit: string): string => digit.repeat(16);
const pinId = (digit: string): string => `p${hex(digit)}`;
const imageId = (digit: string): string => `i${hex(digit)}`;

function pin(digit: string, number: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: pinId(digit),
    number,
    createdAt: 10,
    updatedAt: 20,
    comment: 'Make the heading bigger',
    images: [{ id: imageId(digit), kind: 'crop', name: 'Pinned area', mimeType: 'image/png' }],
    anchor: { path: '0.1.2', occurrence: 0, at: { x: 0.25, y: 0.75 }, tag: 'h1', text: 'Welcome' },
    place: {
      page: 'src/pages/index.astro',
      pageLabel: 'Home',
      file: 'src/pages/index.astro',
      locator: '0.1.2',
      elementLabel: 'Heading “Welcome”',
      breakpointPx: 768,
    },
    included: true,
    delivery: { kind: 'draft' },
    ...over,
  };
}

const board = (...pins: readonly Record<string, unknown>[]): Record<string, unknown> => ({ version: 1, pins });

test('a good board reads back whole, sent pins with their chat and turn', () => {
  const sent = pin('b', 2, { delivery: { kind: 'sent', chat: `c${'1'.repeat(24)}`, turn: `t${'2'.repeat(16)}`, mode: 'subagents', at: 30 } });
  const parsed = parsePinBoard(board(pin('a', 1), sent));
  assert.equal(parsed.pins.length, 2);
  assert.deepEqual(parsed.pins[1]?.delivery, { kind: 'sent', chat: `c${'1'.repeat(24)}`, turn: `t${'2'.repeat(16)}`, mode: 'subagents', at: 30 });
  assert.deepEqual(parsePinBoardStrict(board(pin('a', 1), sent)).pins.length, 2);
});

test('a damaged stored pin is left out alone; anything not a board is the empty board', () => {
  const bad = [
    pin('c', 3, { id: 'p123' }),
    pin('c', 3, { number: 0 }),
    pin('c', 3, { number: PIN_LIMITS.numberMax + 1 }),
    pin('c', 3, { comment: 'x'.repeat(PIN_LIMITS.commentCharsMax + 1) }),
    pin('c', 3, { updatedAt: 5 }),
    pin('c', 3, { anchor: { path: '', occurrence: 0, at: { x: 0, y: 0 }, tag: 'h1' } }),
    pin('c', 3, { anchor: { path: '0', occurrence: 0, at: { x: 1.5, y: 0 }, tag: 'h1' } }),
    pin('c', 3, { place: { page: '/etc/passwd', pageLabel: 'Home', file: 'a.astro', locator: '0', elementLabel: 'x' } }),
    pin('c', 3, { place: { page: 'a.astro', pageLabel: 'Home', file: '../a.astro', locator: '0', elementLabel: 'x' } }),
    pin('c', 3, { place: { page: 'a.astro', pageLabel: 'Home', file: 'a.astro', locator: '0.x', elementLabel: 'x' } }),
    pin('c', 3, { images: [1, 2, 3, 4, 5].map((number) => ({ id: imageId(String(number)), kind: 'crop', name: 'x', mimeType: 'image/png' })) }),
    pin('c', 3, { images: [{ id: imageId('d'), kind: 'crop', name: 'x', mimeType: 'image/svg+xml' }] }),
    pin('c', 3, { delivery: { kind: 'sent', chat: 'nope', mode: 'subagents', at: 1 } }),
    pin('c', 3, { delivery: { kind: 'sent', chat: `c${'1'.repeat(24)}`, mode: 'parallel', at: 1 } }),
    pin('c', 3, { included: 'yes' }),
  ];
  for (const entry of bad) {
    const parsed = parsePinBoard(board(pin('a', 1), entry));
    assert.equal(parsed.pins.length, 1, `left out: ${JSON.stringify(entry).slice(0, 80)}`);
    assert.throws(() => parsePinBoardStrict(board(pin('a', 1), entry)), 'a writer’s board with it is refused');
  }
  for (const input of [undefined, 'board', [], { version: 2, pins: [] }, { version: 1 }]) {
    assert.deepEqual(parsePinBoard(input), { version: 1, pins: [] });
  }
});

test('repeated ids and numbers keep the first; the board is bounded', () => {
  assert.equal(parsePinBoard(board(pin('a', 1), pin('a', 2))).pins.length, 1);
  assert.equal(parsePinBoard(board(pin('a', 1), pin('b', 1))).pins.length, 1);
  assert.throws(() => parsePinBoardStrict(board(pin('a', 1), pin('b', 1))));
  const many = Array.from({ length: PIN_LIMITS.pinsMax + 5 }, (_, index) =>
    pin(index.toString(16).padStart(2, '0').slice(0, 1), index + 1, { id: `p${index.toString(16).padStart(16, '0')}` }),
  );
  assert.equal(parsePinBoard(board(...many)).pins.length, PIN_LIMITS.pinsMax);
  assert.throws(() => parsePinBoardStrict(board(...many)));
});

test('images: base64 only, unique, bounded each and together', () => {
  assert.equal(parsePinImages([{ id: imageId('a'), data: 'aGVsbG8=' }]).length, 1);
  assert.throws(() => parsePinImages([{ id: imageId('a'), data: 'not base64!' }]));
  assert.throws(() => parsePinImages([{ id: imageId('a'), data: '' }]));
  assert.throws(() => parsePinImages([{ id: 'x', data: 'aGVsbG8=' }]));
  assert.throws(() =>
    parsePinImages([
      { id: imageId('a'), data: 'aGVsbG8=' },
      { id: imageId('a'), data: 'aGVsbG8=' },
    ]),
  );
  const big = 'A'.repeat(8 * 1024 * 1024);
  assert.throws(() => parsePinImages([{ id: imageId('a'), data: `${big}A` }]), 'one image past the prompt image bound');
  const four = ['a', 'b', 'c', 'd'].map((digit) => ({ id: imageId(digit), data: big }));
  assert.throws(() => parsePinImages(four), 'images past the board bound together');
  assert.deepEqual(parsePinBoardRead({ board: board(pin('a', 1)), images: [] }).images, []);
});

test('the IPC channels take a project and a board with the images to store', () => {
  assert.deepEqual(parseIpcPayload('ai:pinsRead', { projectPath: '/site' }), { projectPath: '/site' });
  const payload = parseIpcPayload('ai:pinsWrite', { projectPath: '/site', board: board(pin('a', 1)), images: [{ id: imageId('a'), data: 'aGVsbG8=' }] });
  assert.equal(payload.board.pins.length, 1);
  assert.throws(() => parseIpcPayload('ai:pinsWrite', { projectPath: '/site', board: board(pin('a', 1), pin('b', 1)), images: [] }));
  assert.throws(() => parseIpcPayload('ai:pinsWrite', { projectPath: '/site', board: board(), images: 'none' }));
});

function entry(number: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number,
    comment: 'Bigger',
    pageLabel: 'Home',
    page: 'src/pages/index.astro',
    elementLabel: 'Heading',
    file: 'src/pages/index.astro',
    locator: '0.1',
    tag: 'h1',
    images: [number - 1],
    ...over,
  };
}

test('a brief: bounded, numbers and images unique, one pin for a single send', () => {
  const brief = parsePinBrief({ mode: 'subagents', pins: [entry(1), entry(2)] });
  assert.equal(brief.pins.length, 2);
  assert.equal(parsePinBrief({ mode: 'single', pins: [entry(3, { images: [] })] }).pins.length, 1);
  const bad = [
    { mode: 'parallel', pins: [entry(1)] },
    { mode: 'subagents', pins: [] },
    { mode: 'single', pins: [entry(1), entry(2)] },
    { mode: 'subagents', pins: [entry(1), entry(1, { images: [5] })] },
    { mode: 'subagents', pins: [entry(1, { images: [0] }), entry(2, { images: [0] })] },
    { mode: 'subagents', pins: [entry(1, { images: [16] })] },
    { mode: 'subagents', pins: [entry(1, { file: '/abs/file.astro' })] },
    { mode: 'subagents', pins: [entry(1, { locator: 'zero' })] },
    { mode: 'subagents', pins: [entry(1, { comment: 'x'.repeat(PIN_LIMITS.commentCharsMax + 1) })] },
    { mode: 'subagents', pins: [entry(1, { breakpointPx: 0 })] },
    { mode: 'subagents', pins: Array.from({ length: PIN_LIMITS.pinsPerSendMax + 1 }, (_, index) => entry(index + 1, { images: [] })) },
  ];
  for (const input of bad) {
    assert.throws(() => parsePinBrief(input), JSON.stringify(input).slice(0, 100));
  }
  assert.ok(
    parseIpcPayload('ai:prompt', {
      projectPath: '/site',
      chat: `c${'1'.repeat(24)}`,
      text: 'Comments on 2 pins',
      attachments: [],
      pins: { mode: 'subagents', pins: [entry(1, { images: [] })] },
    }).pins,
  );
});

test('the transcript keeps a pin’s number, words, names and thumbnail index: no path, locator or instruction', () => {
  const brief = parsePinBrief({ mode: 'subagents', pins: [entry(1), entry(2, { images: [] })] });
  const sent = sentPinsOf(brief);
  assert.deepEqual(sent, [
    { number: 1, comment: 'Bigger', pageLabel: 'Home', elementLabel: 'Heading', image: 0 },
    { number: 2, comment: 'Bigger', pageLabel: 'Home', elementLabel: 'Heading', image: undefined },
  ]);
  const event = parseChatEvent({
    kind: 'user',
    turn: `t${'1'.repeat(16)}`,
    text: 'Comments on 2 pins',
    attachments: [],
    at: 1,
    parts: [{ kind: 'pins', mode: 'subagents', pins: sent }],
  });
  assert.equal(event.kind, 'user');
  const stored = JSON.stringify(event);
  for (const word of ['src/pages', 'locator', '0.1', 'comment-pins', 'Agent tool']) {
    assert.ok(!stored.includes(word), `the stored message holds no ${word}`);
  }
  assert.throws(() => parseSentPins([]));
  assert.throws(() =>
    parseChatEvent({ kind: 'user', turn: `t${'1'.repeat(16)}`, text: 'x', attachments: [], at: 1, parts: [{ kind: 'pins', mode: 'x', pins: sent }] }),
  );
});

test('a subagent title names its pin: "Pin 3: …", in any case, and nothing else does', () => {
  assert.equal(pinNumberOfTitle('Pin 3: Bigger heading'), 3);
  assert.equal(pinNumberOfTitle('pin 12 - hero'), 12);
  assert.equal(pinNumberOfTitle('**Pin #4** spacing'), 4);
  for (const title of ['Spin 3', 'Pinned 3', 'Fix pin 3', 'Pin three', 'Pin 0', 'Pin 99999']) {
    assert.equal(pinNumberOfTitle(title), undefined, title);
  }
});

test('the panel shows a subagent title without its pin number; a title that is only the number stays', () => {
  assert.equal(withoutPinNumber('Pin 3: Bigger heading'), 'Bigger heading');
  assert.equal(withoutPinNumber('pin 12 - hero'), 'hero');
  assert.equal(withoutPinNumber('**Pin #4**: spacing'), 'spacing');
  assert.equal(withoutPinNumber('Pin 3:'), 'Pin 3:', 'nothing left to show: kept');
  for (const title of ['Fix pin 3: header', 'Pinned 3: x', 'Bigger heading']) {
    assert.equal(withoutPinNumber(title), title, title);
  }
});

test('an image note names its pin on one line within the note bound', () => {
  const note = pinImageNote({ number: 2, breakpointPx: 768 }, { position: 1, kind: 'crop' });
  assert.match(note, /^Pin 2, image 1: /);
  assert.ok(!note.includes('\n'));
  assert.ok(note.length <= 500);
});

test('waves: every pin starts at once up to the bound, in number order, shared files included; the rest wait', () => {
  assert.deepEqual(pinWaves([3, 1, 4, 2]), [[1, 2, 3, 4]], 'the four pins of a review all start together');
  assert.deepEqual(pinWaves([1, 2, 3, 4, 5, 6]), [
    [1, 2, 3, 4],
    [5, 6],
  ]);
});

function xorshift(seed: number): () => number {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4_294_967_296;
  };
}

test('waves hold their properties over random sends', () => {
  for (let seed = 1; seed <= 400; seed += 1) {
    const random = xorshift(seed);
    const count = 1 + Math.floor(random() * PIN_LIMITS.pinsPerSendMax);
    const numbers = Array.from({ length: count }, (_, index) => index + 1);
    const concurrency = 1 + Math.floor(random() * 4);
    const waves = pinWaves([...numbers].reverse(), concurrency);
    assert.deepEqual(waves.flat(), numbers, `seed ${seed}: every pin runs once, in number order`);
    waves.forEach((wave, index) => {
      assert.ok(wave.length >= 1 && wave.length <= concurrency, `seed ${seed}: a wave holds 1 to ${concurrency}`);
      assert.ok(index === waves.length - 1 || wave.length === concurrency, `seed ${seed}: a pin waits only when a wave is full`);
    });
  }
});

test('a pin’s model is read whole or the pin is refused; a pin stored before models has none', () => {
  const chosen = { agent: 'claude', value: 'haiku', name: 'Haiku' };
  assert.deepEqual(parsePinBoard(board(pin('a', 1, { model: chosen }))).pins[0]?.model, chosen);
  assert.ok(!('model' in (parsePinBoard(board(pin('a', 1))).pins[0] ?? {})));
  const bad = [{ ...chosen, agent: 'other' }, { ...chosen, value: '' }, { ...chosen, name: 'x'.repeat(PIN_LIMITS.modelCharsMax + 1) }, 'haiku'];
  for (const model of bad) {
    assert.equal(parsePinBoard(board(pin('a', 1, { model }))).pins.length, 0, JSON.stringify(model).slice(0, 60));
    assert.throws(() => parsePinBoardStrict(board(pin('a', 1, { model }))));
  }
});

test('a question is read only from its written form, with bounded words and choices', () => {
  const text = 'Done with pin 1.\n**Question for pin 2:** How **tall**?\n\n1. Half\n2. `Full`\n\nThanks\n- not a choice';
  assert.deepEqual(pinQuestionsOf(text), [{ number: 2, question: 'How tall?', choices: ['Half', 'Full'] }]);
  for (const plain of ['How tall should it be?', 'I have a question for pin 2: none', 'Question for pin 0: x', 'Question for pin 2:']) {
    assert.deepEqual(pinQuestionsOf(plain), [], plain);
  }
  const many = Array.from(
    { length: 40 },
    (_, index) => `Question for pin ${index + 1}: ${'w'.repeat(900)}\n${'- a\n- b\n- c\n- d\n- e\n- f\n- g\n- h\n'}`,
  ).join('\n');
  const read = pinQuestionsOf(many);
  assert.ok(read.length <= PIN_LIMITS.questionsPerTextMax);
  assert.ok(read.every((entry) => entry.question.length <= PIN_LIMITS.questionCharsMax && entry.choices.length <= PIN_LIMITS.choicesMax));
});
