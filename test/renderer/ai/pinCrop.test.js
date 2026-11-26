// Goal: the picture of the pinned area reaches the agent. It was lost without a word whenever the canvas sat on half a
// pixel (a fixed-width canvas centred in a pane with an odd amount of room, as 641.5): a crop cut to the canvas's edge
// kept that fraction, and `ai:screenshot` takes whole pixels only, so the request was refused before it was sent. The
// pin was saved with no picture. Here a crop of such a canvas is photographed, saved, read back as after reopening the
// app, sent both ways, and found as an image block in what each agent is given.
// Method: the real cropRect, pin store, send and the host's buildPrompt, bundled with esbuild, against a fake preload
// whose capture returns marked bytes. The geometry is the one measured in the app when the bug was reproduced.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/pinCrop.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export * as pins from './src/features/ai/pins/pinStore';",
      "export * as ai from './src/features/ai/aiStore';",
      "export { cropRect } from './src/features/ai/pins/pinModel';",
      "export { parseIpcPayload } from './shared/ipc/ipcPayloads';",
      "export { parsePinBrief } from './shared/properties/ai/commentPinBrief';",
      "export { parsePromptParts } from './shared/properties/ai/mentions';",
      "export { buildPrompt } from './electron/handlers/ai/promptBlocks';",
    ].join('\n'),
    resolveDir: repoPath('.'),
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['react'],
  logLevel: 'silent',
});

const storage = new Map();
global.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : JSON.parse('null')),
  setItem: (key, value) => void storage.set(key, String(value)),
  removeItem: (key) => void storage.delete(key),
  clear: () => storage.clear(),
};
global.requestAnimationFrame = (run) => setTimeout(run, 0);
const ui = require(output);

// Measured in the app: the phone-width canvas in a 1600 px window.
const CANVAS = { x: 641.5, y: 100.25, width: 479, height: 883.5 };

test('every crop of a canvas on a fraction of a pixel is whole pixels inside it, as the screenshot takes them', () => {
  const crops = [];
  // Elements at each edge and in the middle, small, as wide as the canvas and taller than it, at three zooms.
  for (const scale of [1, 0.7734375, 1.25]) {
    for (const box of [
      { x: 0, y: 0, w: 479, h: 40 },
      { x: 455, y: 860, w: 24, h: 24 },
      { x: 0, y: -300, w: 479, h: 2000 },
      { x: 200, y: 400, w: 40, h: 20 },
    ]) {
      const rect = ui.cropRect({ box, at: { x: 0.02, y: 0.1 }, scale, origin: { x: CANVAS.x, y: CANVAS.y }, clip: CANVAS });
      if (rect !== undefined) {
        crops.push(rect);
      }
    }
  }
  assert.ok(crops.length >= 8, 'the elements are on the canvas');
  for (const rect of crops) {
    assert.deepEqual(ui.parseIpcPayload('ai:screenshot', { projectPath: '/site', rect }).rect, rect, JSON.stringify(rect));
    assert.ok(rect.x >= CANVAS.x && rect.x + rect.width <= CANVAS.x + CANVAS.width, 'never wider than the canvas');
    assert.ok(rect.y >= CANVAS.y && rect.y + rect.height <= CANVAS.y + CANVAS.height, 'never taller than it');
  }
});

const CHAT = `c${'a'.repeat(24)}`;
const PICTURE = Buffer.from('the pinned area').toString('base64');
const ok = (value) => ({ ok: true, value });

for (const agent of ['claude', 'codex']) {
  test(`${agent}: the pinned area's picture reaches the agent's input, also after the app is reopened`, async () => {
    let board = { version: 1, pins: [] };
    const files = new Map();
    const prompts = [];
    const shots = [];
    const summary = { id: CHAT, agent, title: 'New chat', pinned: false, createdAt: 1, updatedAt: 1, rank: 0, unread: false };
    global.window = {
      avb: {
        aiAgents: async () => ({
          trusted: true,
          agents: [{ agent, state: 'ready', adapterVersion: '1.0.0', running: false, downloadMegabytes: 1 }],
          options: [],
        }),
        aiChats: async () => ({ chats: [summary], sections: [] }),
        aiChatRead: async () => ok({ summary, events: [], full: false }),
        aiChatUpdate: async () => ok(summary),
        aiPinsRead: async () => ok({ board, images: [...files].map(([id, data]) => ({ id, data })) }),
        aiPinsWrite: async (payload) => {
          board = JSON.parse(JSON.stringify(payload.board));
          for (const image of payload.images) {
            files.set(image.id, image.data);
          }
          return ok({ saved: true });
        },
        aiScreenshot: async (payload) => {
          shots.push(payload.rect);
          return ok({ mimeType: 'image/png', data: PICTURE, width: payload.rect.width, height: payload.rect.height });
        },
        aiPrompt: async (payload) => {
          prompts.push(payload);
          return ok({ turn: `t${'1'.padStart(16, '0')}` });
        },
        aiAck: () => undefined,
        onAiEvents: () => () => undefined,
        onAiAgentStatus: () => () => undefined,
        onAiSetup: () => () => undefined,
      },
    };
    const translate = (key) => key;
    storage.clear();
    ui.ai.resetAiStore();
    ui.pins.resetPinStore();
    await ui.ai.loadAiProject('/site');
    await ui.ai.openChat(CHAT);
    await ui.pins.loadPins('/site');
    const id = ui.pins.dropPin(
      {
        anchor: { path: '0.1', occurrence: 0, at: { x: 0.02, y: 0.1 }, tag: 'section', text: undefined },
        place: {
          page: 'src/pages/index.astro',
          pageLabel: 'Home',
          scope: undefined,
          file: 'src/pages/index.astro',
          locator: '0.1',
          elementLabel: 'Layout',
          componentFile: undefined,
          breakpointPx: 479,
        },
      },
      translate,
    );
    // What the shell does at pin time (DesktopPins.tsx cropAt), for an element as wide as the canvas.
    const rect = ui.cropRect({ box: { x: 0, y: 0, w: 479, h: 40 }, at: { x: 0.02, y: 0.1 }, scale: 1, origin: CANVAS, clip: CANVAS });
    await ui.pins.capturePinCrop(id, rect, translate);
    assert.equal(shots.length, 1, 'captured');
    ui.pins.setPinComment(id, 'Bigger');
    ui.pins.savePinBox();
    await ui.pins.closePins();
    assert.deepEqual(
      board.pins[0].images.map((image) => image.kind),
      ['crop'],
      'saved with its picture',
    );
    await ui.pins.loadPins('/site');
    assert.equal(ui.pins.pinState().images.get(board.pins[0].images[0].id), PICTURE, 'shown after reopening');
    assert.equal(await ui.pins.sendAllPins(translate), true);
    const sent = prompts[0];
    const brief = ui.parsePinBrief(JSON.parse(JSON.stringify(sent.pins)));
    assert.deepEqual(brief.pins[0].images, [0], 'the brief says which picture is the pin’s');
    const built = ui.buildPrompt(
      { root: '/site', home: '/home', agent, embeddedContext: true, commands: new Set(), read: () => undefined },
      { text: sent.text, attachments: sent.attachments, parts: sent.parts && ui.parsePromptParts(sent.parts), pins: brief },
    );
    assert.ok(built.ok);
    const images = built.value.blocks.filter((block) => block.type === 'image');
    assert.deepEqual(images, [{ type: 'image', mimeType: 'image/png', data: PICTURE }]);
    const note = built.value.blocks[built.value.blocks.indexOf(images[0]) - 1];
    assert.match(note.text, /^Pin 1, image 1: the pinned area/);
    await ui.pins.closePins();
  });
}
