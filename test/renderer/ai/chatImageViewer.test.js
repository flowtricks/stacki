// Goal: every picture in a chat opens large: a sent attachment, a comment pin's crop, a queued message's image and
// Studio's message images. A reloaded chat reads the kept full copy; a chat from before copies were kept, or one
// whose copy is gone, opens its small preview and the tooltip says so. What has no picture is no button.
// Method: the real components bundled by esbuild into jsdom; a reloaded message is made by round-tripping its
// stored form through JSON and the chat parser. The image loader is a fake that records what it was asked for;
// load events are dispatched by hand, since jsdom decodes nothing, and jsdom's click stands for Enter and Space,
// which a real <button> turns into one.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTranscript } = require('../../helpers/aiTranscriptDom.js');
const { waitFor } = require('../../helpers/waitFor.js');

const {
  modules: view,
  React,
  act,
  createRoot,
} = loadTranscript('aiChatImageViewer', [
  "export { UserMessage } from './src/features/ai/transcript/Messages';",
  "export { QueuedPrompts } from './src/features/ai/composer/QueuedPrompts';",
  "export { parseChatEvent } from './shared/properties/ai/chatModel';",
]);

const THUMB = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
const FULL = 'data:image/png;base64,RlVMTA==';
const ORIGINAL = `${'a'.repeat(32)}.png`;
const NOTE = 'Only a small copy of this image was saved';

function reloaded(attachment) {
  const stored = JSON.stringify({ kind: 'user', turn: `t${'1'.repeat(16)}`, text: 'Look', attachments: [attachment], at: 1 });
  return view.parseChatEvent(JSON.parse(stored)).attachments;
}

async function mount(context, element) {
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  await act(async () => root.render(element));
  context.after(async () => {
    await act(async () => root.unmount());
    container.remove();
  });
  return container;
}

function message(attachments, loadImage) {
  return React.createElement(view.UserMessage, { text: 'Look', attachments, at: 1, loadImage, onEdit: undefined, onResend: undefined });
}

const shown = () => document.querySelector('.ai-lightbox-image') ?? undefined;
// Each read first lets React apply what has arrived.
const until = (check) =>
  waitFor({
    what: 'the expected state arrives',
    read: async () => {
      await act(async () => {});
      return Boolean(check());
    },
    until: (held) => held,
  });

async function close() {
  await act(async () => document.querySelector('.ai-lightbox-close').click());
  await until(() => shown() === undefined);
}

test('a reloaded message opens the kept full copy, with a skeleton while it is read, and Escape closes it', async (context) => {
  const asked = [];
  let answer;
  const loadImage = (image) => {
    asked.push(image);
    return new Promise((resolve) => (answer = resolve));
  };
  const container = await mount(context, message(reloaded({ kind: 'image', name: 'shot.png', thumbnail: THUMB, original: ORIGINAL }), loadImage));
  const chip = container.querySelector('button.ai-message-attachment');
  assert.equal(chip.getAttribute('aria-label'), 'Enlarge shot.png');
  assert.deepEqual(asked, [], 'nothing is read until it is opened');
  await act(async () => chip.click());
  assert.ok(document.querySelector('.ai-lightbox .ui-skeleton'), 'a skeleton while the copy is read');
  assert.equal(shown(), undefined);
  await act(async () => answer(FULL));
  assert.equal(shown().getAttribute('src'), FULL);
  assert.equal(shown().getAttribute('title') ?? undefined, undefined);
  await act(async () => shown().dispatchEvent(new window.Event('load')));
  assert.equal(document.querySelector('.ai-lightbox .ui-skeleton') ?? undefined, undefined);
  assert.deepEqual(asked, [ORIGINAL]);
  await act(async () => document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
  await until(() => shown() === undefined);
});

test('an older chat, and a copy since removed, open the small preview and say why', async (context) => {
  const asked = [];
  const older = await mount(
    context,
    message(reloaded({ kind: 'image', name: 'old.png', thumbnail: THUMB }), async (image) => void asked.push(image)),
  );
  await act(async () => older.querySelector('button.ai-message-attachment').click());
  assert.equal(shown().getAttribute('src'), THUMB);
  assert.equal(shown().getAttribute('title'), NOTE);
  assert.deepEqual(asked, [], 'there is nothing to read');
  await close();
  const gone = await mount(
    context,
    message(reloaded({ kind: 'image', name: 'gone.png', thumbnail: THUMB, original: ORIGINAL }), async () => undefined),
  );
  await act(async () => gone.querySelector('button.ai-message-attachment').click());
  await until(() => shown()?.getAttribute('src') === THUMB);
  assert.equal(shown().getAttribute('title'), NOTE);
  await close();
});

test('a message whose image left nothing behind is not a button', async (context) => {
  const container = await mount(
    context,
    message(reloaded({ kind: 'image', name: 'ancient.png' }), async () => FULL),
  );
  assert.equal(container.querySelector('button.ai-message-attachment') ?? undefined, undefined);
  assert.equal(container.querySelector('img') ?? undefined, undefined);
});

test('a queued message’s images show small and open large from what the draft holds', async (context) => {
  const draft = {
    segments: [],
    attachments: [
      { id: '1', preview: FULL, attachment: { kind: 'image', name: 'queued.png', mimeType: 'image/png', data: 'RlVMTA==' } },
      { id: '2', preview: undefined, attachment: { kind: 'file', path: 'src/a.ts' } },
    ],
  };
  const queued = [{ id: 'q', text: '', draft }];
  const container = await mount(context, React.createElement(view.QueuedPrompts, { chat: `c${'a'.repeat(24)}`, queued, paused: false }));
  const pictures = container.querySelectorAll('.ai-queued-image');
  assert.equal(pictures.length, 1, 'a file is no picture');
  await act(async () => pictures[0].click());
  assert.equal(shown().getAttribute('src'), FULL);
  await close();
});
