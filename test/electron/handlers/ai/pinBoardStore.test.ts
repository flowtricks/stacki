// Goal: a project's comment pins survive a restart, outside the project, and stay bounded. The board and each
// image are stored under the chat store's project folder; an image is written once and removed with the save that
// stops naming it; a board whose images would pass the bound is refused with nothing changed; a torn or damaged
// board reads as what survives of it; an image whose bytes are gone leaves its pin. The words given to the agent
// for a send name every pin, its paths and the waves that keep pins on one file apart, and a prompt of pins puts
// those words first while the transcript keeps only the pins' names.
// Method: the store from dist/ against a temporary folder (the injected project directory), and the pure prompt
// builder and instruction writer from dist/ on plain values.
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import { PinBoardStore } from '#dist/electron/handlers/ai/pinBoardStore.js';
import { pinInstructions } from '#dist/electron/handlers/ai/pinInstructions.js';
import { buildPrompt, type PromptSource } from '#dist/electron/handlers/ai/promptBlocks.js';
import { PIN_LIMITS } from '#dist/shared/properties/ai/commentPinBrief.js';
import { parsePinBoardStrict, toPinImageId, type PinBoard, type PinImageId } from '#dist/shared/properties/ai/commentPins.js';

const imageId = (digit: string): PinImageId => toPinImageId(`i${digit.repeat(16)}`);

function board(images: readonly string[]): PinBoard {
  return parsePinBoardStrict({
    version: 1,
    pins: [
      {
        id: `p${'a'.repeat(16)}`,
        number: 1,
        createdAt: 1,
        updatedAt: 2,
        comment: 'Bigger heading',
        images: images.map((id) => ({ id, kind: 'crop', name: 'Pinned area', mimeType: 'image/png' })),
        anchor: { path: '0.1', occurrence: 0, at: { x: 0.5, y: 0.5 }, tag: 'h1', text: 'Welcome' },
        place: { page: 'src/pages/index.astro', pageLabel: 'Home', file: 'src/pages/index.astro', locator: '0.1', elementLabel: 'Heading', breakpointPx: 768 },
        included: true,
        delivery: { kind: 'draft' },
      },
    ],
  });
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stacki-pins-'));
  const store = new PinBoardStore(() => path.join(root, 'projects', 'digest'));
  const folder = path.join(root, 'projects', 'digest', 'pins');
  return { root, store, folder };
}

test('a board and its images survive a restart; an image is written once and leaves with its pin', () => {
  const { store, folder } = setup();
  assert.deepEqual(store.read('/site'), { board: { version: 1, pins: [] }, images: [] }, 'no board yet reads empty');
  assert.equal(store.write('/site', board([imageId('1')]), [{ id: imageId('1'), data: 'aGVsbG8=' }]), true);
  const file = path.join(folder, 'images', `${imageId('1')}.bin`);
  assert.equal(fs.readFileSync(file, 'utf8'), 'hello');
  const written = fs.statSync(file).mtimeMs;
  // A later save that does not resend the image keeps the file as it was.
  assert.equal(store.write('/site', board([imageId('1')]), []), true);
  assert.equal(fs.statSync(file).mtimeMs, written);
  const read = new PinBoardStore(() => path.join(folder, '..')).read('/site');
  assert.equal(read.board.pins[0]?.comment, 'Bigger heading');
  assert.deepEqual(read.images, [{ id: imageId('1'), data: 'aGVsbG8=' }]);
  // The pin's image removed: the file goes with the save.
  assert.equal(store.write('/site', board([]), []), true);
  assert.equal(fs.existsSync(file), false);
  // An image the board does not name is never written.
  assert.equal(store.write('/site', board([]), [{ id: imageId('2'), data: 'aGVsbG8=' }]), true);
  assert.deepEqual(fs.readdirSync(path.join(folder, 'images')), []);
});

test('images past the board bound are refused with nothing changed', () => {
  const { store, folder } = setup();
  assert.equal(store.write('/site', board([]), []), true);
  const before = fs.readFileSync(path.join(folder, 'board.json'), 'utf8');
  const big = 'A'.repeat(PIN_LIMITS.boardImageCharsMax / 2 + 4);
  assert.equal(
    store.write('/site', board([imageId('1'), imageId('2')]), [
      { id: imageId('1'), data: big },
      { id: imageId('2'), data: big },
    ]),
    false,
  );
  assert.equal(fs.readFileSync(path.join(folder, 'board.json'), 'utf8'), before);
  assert.equal(fs.existsSync(path.join(folder, 'images', `${imageId('1')}.bin`)), false);
});

test('a torn board reads as empty, a missing image leaves its pin, stray files are swept', () => {
  const { store, folder } = setup();
  assert.equal(store.write('/site', board([imageId('1')]), [{ id: imageId('1'), data: 'aGVsbG8=' }]), true);
  fs.rmSync(path.join(folder, 'images', `${imageId('1')}.bin`));
  const read = store.read('/site');
  assert.deepEqual(read.board.pins[0]?.images, [], 'the pin stays, without the picture it cannot show');
  fs.writeFileSync(path.join(folder, 'images', 'left.tmp'), 'x');
  assert.equal(store.write('/site', read.board, []), true);
  assert.deepEqual(fs.readdirSync(path.join(folder, 'images')), []);
  fs.writeFileSync(path.join(folder, 'board.json'), '{"version":1,"pins":[{"id"');
  assert.deepEqual(store.read('/site').board.pins, []);
});

const entry = (number: number, file: string, componentFile?: string) => ({
  number,
  comment: number === 2 ? 'Line one\nLine two' : `Change ${number}`,
  pageLabel: 'Home',
  page: 'src/pages/index.astro',
  elementLabel: `Element ${number}`,
  file,
  locator: `0.${number}`,
  tag: 'section',
  text: undefined,
  componentFile,
  breakpointPx: number === 1 ? 768 : undefined,
  images: number === 1 ? [0] : [],
});

test('the instructions for subagents name each pin and its paths, and start pins that share a file together', () => {
  const text = pinInstructions({
    mode: 'subagents',
    pins: [entry(1, 'src/pages/index.astro'), entry(2, 'src/pages/about.astro'), entry(3, 'src/pages/index.astro', 'src/components/Hero.astro')],
  });
  assert.match(text, /^<comment-pins>\n/);
  assert.match(text, /\n<\/comment-pins>$/);
  assert.match(text, /one subagent per pin/);
  assert.match(text, /"Pin <number>: <three to six words>"/);
  assert.match(text, /all 3 Agent calls together in one single message/, 'pins 1 and 3 share a file and still start together');
  assert.match(text, /There is no limit on how many run at once/);
  assert.ok(!/Wave \d/.test(text), 'no pin waits for another');
  assert.match(text, /never change a file with a shell command/);
  assert.match(text, /read it again and redo only your own change/);
  assert.match(text, /Question for pin <number>: /);
  assert.ok(!text.includes('Model:'), 'no model line unless a pin chose one');
  const chosen = pinInstructions({
    mode: 'subagents',
    pins: [{ ...entry(1, 'src/pages/index.astro'), model: 'haiku', modelName: 'Haiku' }, entry(2, 'src/pages/about.astro')],
  });
  assert.match(chosen, /set its Agent call's model parameter to exactly that value/);
  assert.equal(chosen.match(/\n {2}Model: haiku/g)?.length, 1, 'only the pin that chose it');
  const full = pinInstructions({ mode: 'subagents', pins: Array.from({ length: 40 }, (_, index) => entry(index + 1, 'src/pages/index.astro')) });
  assert.match(full, /all 40 Agent calls together in one single message/);
  assert.equal(full.match(/\nPin \d+\n/g)?.length, 40, 'every pin of a full board is in the one message');
  assert.match(text, /written in src\/pages\/index\.astro at child path 0\.3/);
  assert.match(text, /an instance of src\/components\/Hero\.astro/);
  assert.match(text, /canvas 768px wide/);
  assert.match(text, /Comment: Line one\n {4}Line two/);
  assert.ok(!text.includes('each after a note'), 'a subagent’s pictures are files, not images of the message');
});

test('the instructions for one pin per message ask the agent to make that change itself', () => {
  const text = pinInstructions({ mode: 'single', pins: [entry(4, 'src/pages/index.astro')] });
  assert.match(text, /Make the change it asks for/);
  assert.ok(!text.includes('subagent'));
  assert.match(text, /Pin 4\n {2}Comment: Change 4/);
  assert.match(text, /other pins and other chats may be editing the same files/);
});

test('a prompt of pins: the instructions first, the images after, the transcript keeps names only', () => {
  const source: PromptSource = { root: os.tmpdir(), home: os.tmpdir(), agent: 'claude', embeddedContext: true, commands: new Set(), read: () => undefined };
  const attachments = [
    { kind: 'image' as const, name: 'Pinned area', mimeType: 'image/png' as const, data: 'aGVsbG8=', note: 'Pin 1, image 1: the pinned area' },
  ];
  const pins = { mode: 'subagents' as const, pins: [entry(1, 'src/pages/index.astro'), entry(2, 'src/pages/about.astro')] };
  const result = buildPrompt(source, { text: 'Comments on 2 pins', attachments, parts: undefined, pins });
  assert.ok(result.ok);
  const blocks = result.value.blocks.map((block) => JSON.stringify(block));
  assert.match(blocks[0] ?? '', /comment-pins/);
  assert.match(blocks[1] ?? '', /Comments on 2 pins/);
  assert.match(blocks[2] ?? '', /Pin 1, image 1/);
  assert.match(blocks[3] ?? '', /"type":"image"/);
  assert.deepEqual(result.value.sent, [
    {
      kind: 'pins',
      mode: 'subagents',
      pins: [
        { number: 1, comment: 'Change 1', pageLabel: 'Home', elementLabel: 'Element 1', image: 0 },
        { number: 2, comment: 'Line one\nLine two', pageLabel: 'Home', elementLabel: 'Element 2', image: undefined },
      ],
    },
  ]);
  const missing = buildPrompt(source, { text: 'x', attachments: [], parts: undefined, pins });
  assert.equal(missing.ok, false, 'a pin naming an image the message does not carry is refused');
});
