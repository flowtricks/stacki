// Goal: a permission request is a polished, answerable card. It says what is asked (the command or
// the edit, coloured as code), draws the agent's options allow-first with the recommended one primary,
// answers to the keys 1..n and Esc (never while the person types in a text field, never answering with
// a stop), collapses to "Allowed · npm test" once answered, and repeats itself above the composer
// only while it is waiting and scrolled out of view.
// Method: bundle the real card and pin with esbuild and mount them in jsdom; press keys on the
// document as a browser delivers them; stand in for IntersectionObserver to scroll cards away.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadTranscript } = require('../../helpers/aiTranscriptDom.js');

const {
  modules: view,
  React,
  act,
  createRoot,
  window: dom,
} = loadTranscript('aiPermissions', [
  "export { PermissionCard, PermissionPin } from './src/features/ai/transcript/PermissionCard';",
  "export { resetPermissionAttention } from './src/features/ai/transcript/permissionAttention';",
]);

const TURN = `t${'1'.repeat(16)}`;
const OPTIONS = [
  { id: 'no', name: 'No', kind: 'reject_once' },
  { id: 'always', name: 'Always allow', kind: 'allow_always' },
  { id: 'yes', name: 'Yes, proceed', kind: 'allow_once' },
];
const permission = (request, over = {}) => ({
  kind: 'permission',
  id: 1,
  turn: TURN,
  request,
  call: 'c1',
  title: 'Run npm test',
  options: OPTIONS,
  answer: undefined,
  ...over,
});
const tool = (over = {}) => ({
  kind: 'tool',
  id: 0,
  turn: TURN,
  call: 'c1',
  title: 'npm test',
  toolKind: 'execute',
  status: 'pending',
  paths: [],
  diffs: [],
  output: '',
  exitCode: undefined,
  parent: undefined,
  at: undefined,
  endedAt: undefined,
  toolName: 'Bash',
  command: 'npm test -- --watch=false',
  background: false,
  ...over,
});

async function render(element) {
  view.resetPermissionAttention();
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  await act(async () => {
    root.render(element);
  });
  return { container, root };
}
const key = async (name, over = {}, target = document.body) => {
  const event = new dom.KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true, ...over });
  await act(async () => {
    target.dispatchEvent(event);
  });
  return event;
};
const buttonTexts = (container) => [...container.querySelectorAll('.ai-permission-actions button')].map((element) => element.textContent);

test('the card shows the command as code, the options allow-first, and the recommended one as the primary button', async (context) => {
  const { container, root } = await render(
    React.createElement(view.PermissionCard, { item: permission('p1'), tool: tool(), projectPath: '/site', onAnswer: () => undefined }),
  );
  context.after(() => act(() => root.unmount()));
  assert.match(container.querySelector('.ai-ask-label').textContent, /Run a command/);
  assert.equal(container.querySelector('.ai-ask-code').textContent, 'npm test -- --watch=false');
  assert.ok(container.querySelector('.ai-ask-code .code-token'), 'the command is syntax coloured');
  assert.deepEqual(buttonTexts(container), ['Yes, proceed', 'Always allow', 'No'], 'button text is only the agent’s own words');
  const classes = [...container.querySelectorAll('.ai-permission-actions button')].map((element) => element.className);
  assert.equal(classes[0], 'ai-allow');
  assert.match(classes[1], /ai-allow-secondary/);
  assert.equal(classes[2], 'ai-reject');
  assert.deepEqual(
    [...container.querySelectorAll('.ai-permission-actions button')].map((element) => element.dataset.key),
    ['1', '2', '3'],
  );
});

test('an edit request shows the diff of the change, and a request with no tool shows its title', async (context) => {
  const edit = tool({ toolKind: 'edit', title: 'Edit src/a.ts', command: undefined, diffs: [{ path: '/site/src/a.ts', oldText: 'a\n', newText: 'b\n' }] });
  const first = await render(
    React.createElement(view.PermissionCard, {
      item: permission('p1', { title: 'Edit /site/src/a.ts' }),
      tool: edit,
      projectPath: '/site',
      onAnswer: () => undefined,
    }),
  );
  assert.match(first.container.querySelector('.ai-ask-label').textContent, /Edit a file/);
  assert.equal(first.container.querySelector('.ai-diff-path').textContent, 'src/a.ts');
  assert.ok(first.container.querySelector('.history-diff-line.added'));
  await act(() => first.root.unmount());
  const second = await render(
    React.createElement(view.PermissionCard, { item: permission('p2', { title: 'Allow /site/x?' }), projectPath: '/site', onAnswer: () => undefined }),
  );
  context.after(() => act(() => second.root.unmount()));
  assert.equal(second.container.querySelector('.ai-ask-title').textContent, 'Allow x?');
});

test('clicking a button answers with that option’s id', async (context) => {
  const answers = [];
  const { container, root } = await render(
    React.createElement(view.PermissionCard, { item: permission('p1'), tool: tool(), onAnswer: (id) => answers.push(id) }),
  );
  context.after(() => act(() => root.unmount()));
  await act(async () => {
    container.querySelectorAll('.ai-permission-actions button')[1].dispatchEvent(new dom.MouseEvent('click', { bubbles: true }));
  });
  assert.deepEqual(answers, ['always']);
});

test('number keys answer by the order drawn; Esc denies; a key with no button does nothing', async (context) => {
  const answers = [];
  const { root } = await render(React.createElement(view.PermissionCard, { item: permission('p1'), tool: tool(), onAnswer: (id) => answers.push(id) }));
  context.after(() => act(() => root.unmount()));
  await key('1');
  await key('2');
  await key('3');
  await key('4');
  await key('0');
  await key('Escape');
  assert.deepEqual(answers, ['yes', 'always', 'no', 'no']);
});

test('shortcuts leave text fields, modified keys and handled keys alone', async (context) => {
  const answers = [];
  const { container, root } = await render(
    React.createElement(
      'div',
      undefined,
      React.createElement('textarea', { id: 'composer' }),
      React.createElement(view.PermissionCard, { item: permission('p1'), tool: tool(), onAnswer: (id) => answers.push(id) }),
    ),
  );
  context.after(() => act(() => root.unmount()));
  const composer = container.querySelector('#composer');
  await key('1', {}, composer);
  await key('Escape', {}, composer);
  await key('1', { metaKey: true });
  await key('1', { ctrlKey: true });
  await key('1', { shiftKey: true });
  assert.deepEqual(answers, [], 'typing a digit in the composer is not an answer');
  const handled = new dom.KeyboardEvent('keydown', { key: '1', bubbles: true, cancelable: true });
  handled.preventDefault();
  await act(async () => {
    document.body.dispatchEvent(handled);
  });
  assert.deepEqual(answers, []);
});

test('Esc with no reject option answers nothing: a key can never stop the turn', async (context) => {
  const answers = [];
  const only = [{ id: 'yes', name: 'Allow', kind: 'allow_once' }];
  const { root } = await render(
    React.createElement(view.PermissionCard, { item: permission('p1', { options: only }), tool: tool(), onAnswer: (id) => answers.push(id) }),
  );
  context.after(() => act(() => root.unmount()));
  await key('Escape');
  assert.deepEqual(answers, []);
  await key('1');
  assert.deepEqual(answers, ['yes']);
});

test('with two requests waiting only the older one hears the keys', async (context) => {
  const answers = [];
  const { root } = await render(
    React.createElement(
      'div',
      undefined,
      React.createElement(view.PermissionCard, { item: permission('p1'), tool: tool(), onAnswer: (id) => answers.push(`first ${id}`) }),
      React.createElement(view.PermissionCard, { item: permission('p2'), tool: tool(), onAnswer: (id) => answers.push(`second ${id}`) }),
    ),
  );
  context.after(() => act(() => root.unmount()));
  await key('1');
  assert.deepEqual(answers, ['first yes']);
});

test('answered, the card is one line: the verdict and what was asked, with no buttons or keys', async (context) => {
  const answers = [];
  const answered = (answer) => permission('p1', { answer });
  const allowed = await render(
    React.createElement(view.PermissionCard, { item: answered({ outcome: 'selected', optionId: 'yes' }), tool: tool(), onAnswer: (id) => answers.push(id) }),
  );
  assert.equal(allowed.container.querySelector('.ai-ask-verdict').textContent, 'Allowed');
  assert.equal(allowed.container.querySelector('.ai-ask-what').textContent, 'npm test -- --watch=false');
  assert.equal(allowed.container.querySelectorAll('button').length, 0);
  await key('1');
  assert.deepEqual(answers, []);
  await act(() => allowed.root.unmount());
  const denied = await render(React.createElement(view.PermissionCard, { item: answered({ outcome: 'selected', optionId: 'no' }), onAnswer: () => undefined }));
  assert.equal(denied.container.querySelector('.ai-ask-verdict').textContent, 'Denied');
  assert.equal(denied.container.querySelector('.ai-ask-what').textContent, 'Run npm test');
  await act(() => denied.root.unmount());
  const stopped = await render(
    React.createElement(view.PermissionCard, { item: answered({ outcome: 'cancelled', optionId: undefined }), onAnswer: () => undefined }),
  );
  context.after(() => act(() => stopped.root.unmount()));
  assert.equal(stopped.container.querySelector('.ai-ask-verdict').textContent, 'Stopped');
});

test('a card that appears while the composer is empty takes the keyboard; a composer with text keeps it', async (context) => {
  view.resetPermissionAttention();
  const container = document.body.appendChild(document.createElement('div'));
  const root = createRoot(container);
  context.after(() => act(() => root.unmount()));
  const composer = document.body.appendChild(document.createElement('textarea'));
  composer.focus();
  await act(async () => {
    root.render(React.createElement(view.PermissionCard, { item: permission('p1'), tool: tool(), onAnswer: () => undefined }));
  });
  assert.equal(document.activeElement, container.querySelector('.ai-permission'), 'empty composer: focus moves to the card');
  await act(async () => root.render(React.createElement(React.Fragment)));
  composer.value = 'half a sentence';
  composer.focus();
  await act(async () => {
    root.render(React.createElement(view.PermissionCard, { item: permission('p2'), tool: tool(), onAnswer: () => undefined }));
  });
  assert.equal(document.activeElement, composer, 'typed text is not interrupted');
});

class FakeObserver {
  static all = [];
  constructor(callback) {
    this.callback = callback;
    FakeObserver.all.push(this);
  }
  observe() {}
  disconnect() {}
  report(isIntersecting) {
    this.callback([{ isIntersecting }]);
  }
}

test('the pin appears only for the oldest waiting request that is scrolled away, answers it, and shows it', async (context) => {
  global.IntersectionObserver = FakeObserver;
  FakeObserver.all = [];
  context.after(() => {
    delete global.IntersectionObserver;
  });
  const answers = [];
  const item = permission('p1');
  const { container, root } = await render(
    React.createElement(
      'div',
      undefined,
      React.createElement(view.PermissionCard, { item, tool: tool(), onAnswer: () => undefined }),
      React.createElement(view.PermissionPin, { permissions: [item], projectPath: '/site', onAnswer: (target, id) => answers.push([target.request, id]) }),
    ),
  );
  context.after(() => act(() => root.unmount()));
  assert.equal(container.querySelector('.ai-ask-pin') ?? undefined, undefined, 'a card not yet reported counts as on screen: the pin never flashes on mount');
  const observer = FakeObserver.all[0];
  await act(async () => observer.report(false));
  const pin = container.querySelector('.ai-ask-pin');
  assert.ok(pin, 'scrolled away: the question is repeated');
  assert.match(pin.textContent, /Waiting: Run npm test/);
  assert.deepEqual(
    [...pin.querySelectorAll('button')].map((element) => element.textContent),
    ['Yes, proceed', 'No', 'Show'],
  );
  await act(async () => {
    pin.querySelector('.ai-allow').dispatchEvent(new dom.MouseEvent('click', { bubbles: true }));
  });
  assert.deepEqual(answers, [['p1', 'yes']]);
  let shown = 0;
  dom.HTMLElement.prototype.scrollIntoView = function () {
    shown += 1;
  };
  await act(async () => {
    [...pin.querySelectorAll('button')].find((element) => element.textContent === 'Show').dispatchEvent(new dom.MouseEvent('click', { bubbles: true }));
  });
  assert.equal(shown, 1, '"Show" scrolls the card into view');
  await act(async () => observer.report(true));
  assert.equal(container.querySelector('.ai-ask-pin') ?? undefined, undefined, 'back on screen: the pin goes');
});

test('an answered request is never pinned, and the pin follows the oldest waiting request only', async (context) => {
  global.IntersectionObserver = FakeObserver;
  FakeObserver.all = [];
  context.after(() => {
    delete global.IntersectionObserver;
  });
  const first = permission('p1');
  const second = permission('p2', { title: 'Run npm build' });
  const { container, root } = await render(
    React.createElement(
      'div',
      undefined,
      React.createElement(view.PermissionCard, { item: first, onAnswer: () => undefined }),
      React.createElement(view.PermissionCard, { item: second, onAnswer: () => undefined }),
      React.createElement(view.PermissionPin, { permissions: [first, second], onAnswer: () => undefined }),
    ),
  );
  context.after(() => act(() => root.unmount()));
  await act(async () => FakeObserver.all.forEach((observer) => observer.report(false)));
  assert.match(container.querySelector('.ai-ask-pin').textContent, /npm test/);
  assert.doesNotMatch(container.querySelector('.ai-ask-pin').textContent, /npm build/);
  await act(async () => {
    root.render(
      React.createElement(
        'div',
        undefined,
        React.createElement(view.PermissionCard, { item: { ...first, answer: { outcome: 'selected', optionId: 'yes' } }, onAnswer: () => undefined }),
        React.createElement(view.PermissionCard, { item: second, onAnswer: () => undefined }),
        React.createElement(view.PermissionPin, {
          permissions: [{ ...first, answer: { outcome: 'selected', optionId: 'yes' } }, second],
          onAnswer: () => undefined,
        }),
      ),
    );
  });
  assert.match(container.querySelector('.ai-ask-pin').textContent, /npm build/, 'once the first is answered the pin moves to the next');
});
