// Goal: a sent message shows a tiny thumbnail box beside each image attachment's label, drawn from the preview stored
// with the message, and shows the label alone when there is none (a chat stored before thumbnails, a file), never an
// empty box. Until the picture decodes the box holds a skeleton, not words; the picture's alt text is the label; a
// picture that fails to decode drops its box.
// Method: bundle the real UserMessage with esbuild, mount it in jsdom with attachments of each kind, and read the
// markup; load and error events are dispatched by hand, since jsdom decodes nothing.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTranscript } = require('../../helpers/aiTranscriptDom.js');

const { modules: view, React, act, createRoot } = loadTranscript('aiSentAttachments', ["export { UserMessage } from './src/features/ai/transcript/Messages';"]);

const THUMB = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

async function render(attachments) {
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(view.UserMessage, { text: 'Look', attachments, at: 1, onEdit: undefined, onResend: undefined }));
  });
  return { container, root };
}

test('a screenshot with a stored thumbnail shows the box before its label, with the label as alt text and a skeleton until decoded', async (context) => {
  const { container, root } = await render([{ kind: 'image', name: 'Screenshot 1 (1600×933)', thumbnail: THUMB }]);
  context.after(() => act(() => root.unmount()));
  const entry = container.querySelector('.ai-message-attachment');
  assert.ok(entry.querySelector('.ai-message-thumb'), 'the thumbnail box is there');
  assert.equal(entry.firstElementChild.className, 'ai-message-thumb', 'it sits before the label');
  assert.equal(entry.querySelector('.ai-message-attachment-label').textContent, 'Screenshot 1 (1600×933)');
  const image = entry.querySelector('img');
  assert.equal(image.getAttribute('src'), THUMB);
  assert.equal(image.getAttribute('alt'), 'Screenshot 1 (1600×933)');
  assert.ok(entry.querySelector('.ui-skeleton'), 'a skeleton fills the box until the picture decodes');
  assert.equal(entry.querySelector('.ai-message-thumb').textContent, '', 'no placeholder words');
  await act(async () => {
    image.dispatchEvent(new window.Event('load'));
  });
  assert.equal(container.querySelector('.ui-skeleton') ?? undefined, undefined, 'the skeleton leaves once decoded');
  assert.equal(container.querySelector('.ai-message-thumb').getAttribute('data-decode'), 'ready');
});

test('an attachment without a thumbnail, and a file, show the label alone', async (context) => {
  const { container, root } = await render([
    { kind: 'image', name: 'Screenshot 2 (800×600)' },
    { kind: 'file', name: 'src/a.ts' },
  ]);
  context.after(() => act(() => root.unmount()));
  assert.equal(container.querySelector('.ai-message-thumb') ?? undefined, undefined, 'no box and no broken image');
  assert.equal(container.querySelector('img') ?? undefined, undefined);
  assert.deepEqual(
    [...container.querySelectorAll('.ai-message-attachment-label')].map((node) => node.textContent),
    ['Screenshot 2 (800×600)', 'src/a.ts'],
  );
});

test('every recorded frame with a thumbnail gets its own box, and a picture that fails to decode drops its box', async (context) => {
  const { container, root } = await render([
    { kind: 'image', name: 'Frame 1', thumbnail: THUMB },
    { kind: 'image', name: 'Frame 2', thumbnail: THUMB },
  ]);
  context.after(() => act(() => root.unmount()));
  assert.equal(container.querySelectorAll('.ai-message-thumb').length, 2);
  await act(async () => {
    container.querySelectorAll('img')[0].dispatchEvent(new window.Event('error'));
  });
  assert.equal(container.querySelectorAll('.ai-message-thumb').length, 1, 'the failed one shows its label alone');
  assert.equal(container.querySelectorAll('.ai-message-attachment-label').length, 2, 'both labels stay');
});
