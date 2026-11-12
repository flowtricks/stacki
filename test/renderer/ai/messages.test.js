// Goal: message chrome behaves. A user bubble and an agent message show a toolbar on hover or focus
// with Copy (and the time), the last user message alone gets Edit and Resend (given by the caller),
// a long message folds behind "Show more" and unfolds, short ones never fold, and the failed-reply row
// keeps Retry first and copies its details.
// Method: bundle the real components with esbuild, mount them in jsdom with a fake clipboard, click.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTranscript } = require('../../helpers/aiTranscriptDom.js');

const {
  modules: view,
  React,
  act,
  createRoot,
} = loadTranscript('aiMessages', [
  "export { UserMessage, AgentMessage } from './src/features/ai/transcript/Messages';",
  "export { ErrorRow } from './src/features/ai/transcript/ErrorRow';",
]);

async function render(element) {
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return { container, root };
}
const click = async (element) => {
  await act(async () => {
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const action = (container, label) => container.querySelector(`.ai-msg-toolbar [aria-label="${label}"]`);
const longText = (count) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n');

function fakeClipboard(context, fail = false) {
  const written = [];
  Object.defineProperty(window.navigator, 'clipboard', {
    configurable: true,
    value: {
      writeText: async (text) => {
        if (fail) {
          throw new Error('denied');
        }
        written.push(text);
      },
    },
  });
  context.after(() => delete window.navigator.clipboard);
  return written;
}

test('a user message shows its text, attachments, time and a Copy that writes the plain text', async (context) => {
  const written = fakeClipboard(context);
  const { container, root } = await render(
    React.createElement(view.UserMessage, {
      text: 'Change line two',
      attachments: [{ kind: 'image', name: 'shot.png' }],
      at: Date.UTC(2026, 0, 2, 15, 4),
      onEdit: undefined,
      onResend: undefined,
    }),
  );
  context.after(() => act(() => root.unmount()));
  assert.equal(container.querySelector('.ai-user-text').textContent, 'Change line two');
  assert.equal(container.querySelector('.ai-message-attachments').textContent, 'shot.png');
  assert.match(container.querySelector('.ai-msg-time').textContent, /\d/);
  assert.ok(container.querySelector('.ai-msg-time').title, 'the hover title carries the full date');
  await click(action(container, 'Copy message'));
  assert.deepEqual(written, ['Change line two']);
  assert.equal(action(container, 'Copy message').title, 'Copied');
});

test('the actions row sits outside the bubble, below it, with the time and Copy, on user and agent messages', async (context) => {
  const user = await render(
    React.createElement(view.UserMessage, { text: 'Hi', attachments: [], at: Date.UTC(2026, 0, 2, 15, 4), onEdit: undefined, onResend: undefined }),
  );
  const agent = await render(React.createElement(view.AgentMessage, { text: 'Hello', at: Date.UTC(2026, 0, 2, 15, 4) }));
  context.after(async () => {
    await act(() => user.root.unmount());
    await act(() => agent.root.unmount());
  });
  for (const { container } of [user, agent]) {
    const row = container.querySelector('.ai-msg-toolbar');
    assert.ok(row.querySelector('.ai-msg-time'), 'the row carries the time');
    assert.equal(row.querySelector('[aria-label="Copy message"]').title, 'Copy message');
    assert.equal(row.closest('.ai-msg-bubble') ?? undefined, undefined, 'the row is not inside the bubble');
  }
  const bubble = user.container.querySelector('.ai-msg-bubble');
  assert.ok(bubble.querySelector('.ai-user-text'));
  assert.equal(bubble.querySelector('.ai-msg-toolbar') ?? undefined, undefined);
  assert.equal(bubble.nextElementSibling.className, 'ai-msg-toolbar', 'the row follows the bubble directly');
});

test('a refused clipboard says so instead of claiming it copied', async (context) => {
  fakeClipboard(context, true);
  const { container, root } = await render(React.createElement(view.AgentMessage, { text: 'Hello', at: undefined }));
  context.after(() => act(() => root.unmount()));
  const original = console.error;
  console.error = () => undefined;
  await click(action(container, 'Copy message'));
  console.error = original;
  assert.equal(action(container, 'Copy message').title, 'Couldn’t copy');
});

test('Edit and Resend exist only when the caller gives them, and call back without sending anything themselves', async (context) => {
  const calls = [];
  const plain = await render(React.createElement(view.UserMessage, { text: 'old', attachments: [], at: 1, onEdit: undefined, onResend: undefined }));
  assert.equal(action(plain.container, 'Edit message') ?? undefined, undefined);
  assert.equal(action(plain.container, 'Send message again') ?? undefined, undefined);
  await act(() => plain.root.unmount());
  const last = await render(
    React.createElement(view.UserMessage, { text: 'new', attachments: [], at: 1, onEdit: () => calls.push('edit'), onResend: () => calls.push('resend') }),
  );
  context.after(() => act(() => last.root.unmount()));
  await click(action(last.container, 'Edit message'));
  await click(action(last.container, 'Send message again'));
  assert.deepEqual(calls, ['edit', 'resend']);
});

test('a message without a time has no time label, and an agent message has no Edit or Resend', async (context) => {
  const { container, root } = await render(React.createElement(view.AgentMessage, { text: '**Hi**', at: undefined }));
  context.after(() => act(() => root.unmount()));
  assert.equal(container.querySelector('.ai-msg-time') ?? undefined, undefined);
  assert.equal(container.querySelector('.ai-markdown strong').textContent, 'Hi', 'markdown still renders through ChatText');
  assert.equal(container.querySelectorAll('.ai-msg-toolbar button').length, 1);
});

test('a long message folds behind Show more and unfolds; a short one never folds', async (context) => {
  const long = await render(React.createElement(view.UserMessage, { text: longText(60), attachments: [], at: 1, onEdit: undefined, onResend: undefined }));
  assert.ok(long.container.querySelector('.ai-msg-folded'));
  const more = [...long.container.querySelectorAll('.ai-msg-more')][0];
  assert.equal(more.textContent, 'Show more');
  await click(more);
  assert.equal(long.container.querySelector('.ai-msg-folded') ?? undefined, undefined);
  assert.equal(long.container.querySelector('.ai-msg-more').textContent, 'Show less');
  await act(() => long.root.unmount());
  const short = await render(React.createElement(view.UserMessage, { text: longText(40), attachments: [], at: 1, onEdit: undefined, onResend: undefined }));
  context.after(() => act(() => short.root.unmount()));
  assert.equal(short.container.querySelector('.ai-msg-more') ?? undefined, undefined);
});

test('collapsible "none" never folds, and a controlled fold follows its owner', async (context) => {
  const never = await render(React.createElement(view.AgentMessage, { text: longText(80), at: 1, collapsible: 'none' }));
  assert.equal(never.container.querySelector('.ai-msg-more') ?? undefined, undefined);
  await act(() => never.root.unmount());
  const changes = [];
  const controlled = (expanded) =>
    React.createElement(view.AgentMessage, { text: longText(80), at: 1, expanded, onExpandedChange: (value) => changes.push(value) });
  const { container, root } = await render(controlled(false));
  context.after(() => act(() => root.unmount()));
  assert.ok(container.querySelector('.ai-msg-folded'));
  await click(container.querySelector('.ai-msg-more'));
  assert.deepEqual(changes, [true]);
  assert.ok(container.querySelector('.ai-msg-folded'), 'the owner has not expanded it yet');
  await act(async () => root.render(controlled(true)));
  assert.equal(container.querySelector('.ai-msg-folded') ?? undefined, undefined);
});

test('the partsView replaces the text in the bubble but Copy still gives the plain text', async (context) => {
  const written = fakeClipboard(context);
  const chips = React.createElement('span', { className: 'chip' }, 'AGENTS.md');
  const { container, root } = await render(
    React.createElement(view.UserMessage, { text: 'See @AGENTS.md', attachments: [], at: 1, partsView: chips, onEdit: undefined, onResend: undefined }),
  );
  context.after(() => act(() => root.unmount()));
  assert.equal(container.querySelector('.ai-user-text').textContent, 'AGENTS.md');
  await click(action(container, 'Copy message'));
  assert.deepEqual(written, ['See @AGENTS.md']);
});

test('the failed-reply row keeps Retry first, hides Details until opened, and copies the details', async (context) => {
  const written = fakeClipboard(context);
  let retried = 0;
  const { container, root } = await render(React.createElement(view.ErrorRow, { message: 'Codex stopped: ECONNRESET', onRetry: () => (retried += 1) }));
  context.after(() => act(() => root.unmount()));
  const row = container.querySelector('.ai-error-row');
  assert.match(row.textContent, /The reply didn’t finish\./);
  assert.equal(row.querySelector('button').textContent, 'Retry');
  assert.equal(row.querySelector('details pre').textContent, 'Codex stopped: ECONNRESET');
  await click(row.querySelector('button'));
  assert.equal(retried, 1);
  await click(row.querySelector('.ai-error-copy'));
  assert.deepEqual(written, ['Codex stopped: ECONNRESET']);
  assert.equal(row.querySelector('.ai-error-copy').textContent, 'Copied');
});

test('the failed-reply row without a message or a retry draws neither Details nor Retry', async (context) => {
  const blank = await render(React.createElement(view.ErrorRow, { message: '   ', onRetry: undefined }));
  context.after(() => act(() => blank.root.unmount()));
  assert.equal(blank.container.querySelectorAll('button, details').length, 0);
  assert.match(blank.container.textContent, /The reply didn’t finish\./);
});
