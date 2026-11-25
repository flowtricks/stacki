// Goal: an agent's reply is drawn as the Markdown it is. A GFM table is a real table inside its own scrolling
// box, lists nest and carry task boxes, quotes and headings keep their shape, fenced code has a language label
// and a Copy that writes the code, a link opens through the shell and never navigates the window, HTML in a reply
// stays text, and a numbered options block becomes buttons that send the reply, only when the reply may still be
// answered.
// Method: bundle the real components with esbuild, mount them in jsdom with a fake preload and a fake clipboard,
// click as a person would, and read the DOM back.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTranscript } = require('../../helpers/aiTranscriptDom.js');

const {
  modules: view,
  React,
  act,
  createRoot,
} = loadTranscript('aiChatText', [
  "export { ChatText } from './src/features/ai/ChatText';",
  "export { AgentMessage } from './src/features/ai/transcript/Messages';",
  "export { answerableMessageId } from './src/features/ai/transcript/messageModel';",
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
    element.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};
const text = (value, props = {}) => React.createElement(view.ChatText, { text: value, ...props });

test('a table is a real table in its own scrolling box, with aligned cells and inline code kept', async (context) => {
  const { container, root } = await render(text('| Area | Features |\n|:---|---:|\n| Roles | `roles.json` |\n| Pages | 3 |'));
  context.after(() => act(() => root.unmount()));
  const box = container.querySelector('.ai-md-table-wrap');
  assert.ok(box, 'a box that scrolls the table, so a wide one never widens the panel');
  assert.equal(box.getAttribute('role'), 'region');
  assert.equal(box.getAttribute('tabindex'), '0', 'a keyboard can scroll it');
  assert.deepEqual(
    [...box.querySelectorAll('th')].map((cell) => cell.textContent),
    ['Area', 'Features'],
  );
  assert.equal(box.querySelectorAll('tbody tr').length, 2);
  assert.equal(box.querySelectorAll('tbody td')[1].style.textAlign, 'end');
  assert.ok(box.querySelector('td code'), 'inline code stays code in a cell');
  assert.equal(container.textContent.includes('|'), false, 'no raw pipe text');
});

test('lists nest, ordered lists keep their start, and task items carry a read-only box', async (context) => {
  const { container, root } = await render(text('3. three\n4. four\n   - nested\n\n- [x] done\n- [ ] open'));
  context.after(() => act(() => root.unmount()));
  const ordered = container.querySelector('ol');
  assert.equal(ordered.getAttribute('start'), '3');
  assert.equal(ordered.querySelectorAll(':scope > li').length, 2);
  assert.equal(ordered.querySelectorAll('ul li').length, 1, 'the nested list sits inside its item');
  const boxes = [...container.querySelectorAll('[role="checkbox"]')];
  assert.deepEqual(
    boxes.map((box) => box.getAttribute('aria-checked')),
    ['true', 'false'],
  );
  assert.equal(boxes[0].getAttribute('aria-readonly'), 'true');
});

test('headings, quotes and rules are drawn as what they are', async (context) => {
  const { container, root } = await render(text('## Title\n\n> a quote\n\n---\n\nplain'));
  context.after(() => act(() => root.unmount()));
  assert.equal(container.querySelector('h2').textContent, 'Title');
  assert.equal(container.querySelector('blockquote').textContent, 'a quote');
  assert.ok(container.querySelector('hr'));
});

test('HTML in a reply is shown as text and builds no elements', async (context) => {
  const { container, root } = await render(text('<img src=x onerror=alert(1)> and <b>bold</b>'));
  context.after(() => act(() => root.unmount()));
  assert.equal(container.querySelector('img') === null, true);
  assert.equal(container.querySelector('b') === null, true);
  assert.match(container.textContent, /<img src=x onerror=alert\(1\)>/);
});

test('fenced code shows its language and Copy writes the code', async (context) => {
  const written = [];
  Object.defineProperty(window.navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => void written.push(value) } });
  context.after(() => delete window.navigator.clipboard);
  const { container, root } = await render(text('```ts\nconst a = 1;\n```'));
  context.after(() => act(() => root.unmount()));
  assert.equal(container.querySelector('.ai-md-code-lang').textContent, 'ts');
  assert.ok(container.querySelector('pre.code-block'), 'code goes through CodeBlock, so it is highlighted');
  await click(container.querySelector('[aria-label="Copy code"]'));
  assert.deepEqual(written, ['const a = 1;']);
});

test('a link opens through the shell, never by navigating; an unsafe target is not a link', async (context) => {
  const opened = [];
  window.avb = { openExternal: async (url) => (opened.push(url), { ok: true }) };
  const { container, root } = await render(text('See [docs](https://example.com/a) or [bad](javascript:alert(1)).'));
  context.after(() => act(() => root.unmount()));
  assert.equal(container.querySelectorAll('a').length, 1);
  const event = new window.MouseEvent('click', { bubbles: true, cancelable: true });
  await act(async () => {
    container.querySelector('a').dispatchEvent(event);
  });
  assert.equal(event.defaultPrevented, true, 'the window never navigates');
  assert.deepEqual(opened, ['https://example.com/a']);
});

test('a numbered options block is buttons that send the reply, and stays code when it may not be answered', async (context) => {
  const sent = [];
  const reply = '```\n1. Do X\n2. Do Y\n3. Leave it\n```';
  const live = await render(text(reply, { onQuickReply: (value) => void sent.push(value) }));
  context.after(() => act(() => live.root.unmount()));
  const options = [...live.container.querySelectorAll('.ai-quick-option')];
  assert.equal(options.length, 3);
  assert.equal(live.container.querySelector('pre') === null, true, 'the block is replaced by its buttons');
  assert.match(live.container.textContent, /Do X/, 'the words stay real text');
  await click(options[1]);
  assert.deepEqual(sent, ['2. Do Y']);
  const stale = await render(text(reply));
  context.after(() => act(() => stale.root.unmount()));
  assert.equal(stale.container.querySelectorAll('.ai-quick-option').length, 0);
  assert.ok(stale.container.querySelector('pre'), 'an older reply keeps its options as code');
  const other = await render(text('```ts\n1. Do X\n2. Do Y\n```', { onQuickReply: () => undefined }));
  context.after(() => act(() => other.root.unmount()));
  assert.equal(other.container.querySelectorAll('.ai-quick-option').length, 0, 'code in a language is never options');
});

test('only the last reply, once the agent is done, may be answered', () => {
  const items = [
    { kind: 'user', id: 1 },
    { kind: 'text', id: 2, role: 'agent' },
    { kind: 'tool', id: 3 },
    { kind: 'text', id: 4, role: 'agent' },
    { kind: 'turn-end', id: 5 },
  ];
  assert.equal(view.answerableMessageId(items, { running: false }), 4);
  assert.equal(view.answerableMessageId(items, { running: true }), undefined, 'not while it is still working');
  assert.equal(
    view.answerableMessageId([...items, { kind: 'user', id: 6 }], { running: false }),
    undefined,
    'a newer message from the person closes the question',
  );
  assert.equal(view.answerableMessageId([{ kind: 'text', id: 1, role: 'thought' }], { running: false }), undefined);
});

test('an agent message passes the reply handler to its text', async (context) => {
  const sent = [];
  const { container, root } = await render(
    React.createElement(view.AgentMessage, {
      text: '```\n1. A\n2. B\n```',
      at: undefined,
      collapsible: 'none',
      onQuickReply: (value) => void sent.push(value),
    }),
  );
  context.after(() => act(() => root.unmount()));
  await click(container.querySelectorAll('.ai-quick-option')[0]);
  assert.deepEqual(sent, ['1. A']);
});
