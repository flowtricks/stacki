// Goal: the Payload form of Settings → CMS connections refuses what cannot be an address before
// asking the main process, shows the main process's reason (a wrong key, a server that is not
// running) where the person is looking and leaves the form open for another try, disables saving
// while it waits, and closes only once the connection is saved. The key never shows after a save. A login
// (email and password) is offered as well as a key, "Detect" lists what the account can reach without saving
// anything, and the form no longer claims that edits are saved with ?draft=true (collections without drafts
// change live content, and it says so).
// Method: bundle the real CmsKeyForm with esbuild, mount it in jsdom over a fake preload bridge
// that records what it is sent and answers from a queue, and type into the fields.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');

const output = repoPath('node_modules/.stacki-test/cms-key-form.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
const bundled = esbuild.build({
  stdin: {
    contents: "export { CmsKeyForm } from './src/features/cmsConnections/CmsKeyForm'; export { subscribeErrorToasts } from './src/ui/errorNotices';",
    resolveDir: repoPath('.'),
    loader: 'ts',
  },
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  jsx: 'automatic',
  loader: { '.css': 'empty', '.svg': 'empty' },
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  logLevel: 'silent',
});

const dom = new JSDOM('<!doctype html><div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
global.window = dom.window;
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'HTMLInputElement', 'Event']) {
  global[name] = dom.window[name];
}
global.IS_REACT_ACT_ENVIRONMENT = true;
// A jsdom page has no <dialog> methods: the popup is a modal dialog.
dom.window.HTMLDialogElement.prototype.showModal = function showModal() {
  this.setAttribute('open', '');
};
dom.window.HTMLDialogElement.prototype.close = function close() {
  this.removeAttribute('open');
};

const sent = [];
const checks = [];
const checkAnswers = [];
const answers = [];
let release;
window.avb = {
  checkCmsConnection: async (input) => {
    checks.push(input);
    return checkAnswers.shift();
  },
  saveCmsConnection: async (input) => {
    sent.push(input);
    const next = answers.shift();
    assert.ok(next, 'an answer was queued');
    if (next === 'wait') {
      await new Promise((resolve) => {
        release = resolve;
      });
      return { ok: true, list: { encryption: 'available', connections: [] } };
    }
    return next;
  },
};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
let component;
test.before(async () => {
  await bundled;
  component = require(output);
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const fill = async (label, value) => {
  const wrapper = [...document.querySelectorAll('label')].find((item) => item.textContent.trim().startsWith(label));
  assert.ok(wrapper, `the ${label} field exists`);
  const input = wrapper.querySelector('input');
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
};
const submit = async () => {
  await act(async () => document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
  await settle();
};
const toasts = [];
const alertText = () => toasts.join(' | ');

let closed = 0;
let unsubscribe;
let root;
async function mount() {
  closed = 0;
  sent.length = 0;
  toasts.length = 0;
  unsubscribe = component.subscribeErrorToasts(
    (notice) => toasts.push(notice.message),
    () => {},
  );
  // Each test gets a clean page: a menu from the last one must not outlive it.
  document.body.innerHTML = '<div id="root"></div>';
  root = createRoot(document.getElementById('root'));
  await act(async () => root.render(React.createElement(component.CmsKeyForm, { projectPath: '/project', cms: 'payload', close: () => (closed += 1) })));
  await settle();
}
test.afterEach(async () => {
  await act(async () => root.unmount());
  unsubscribe();
});

test('an address that cannot be one never reaches the main process', async () => {
  await mount();
  await fill('Name', 'My CMS');
  await fill('Payload address', 'http://cms.example.com');
  await fill('API key', 'abc');
  await submit();
  assert.equal(sent.length, 0);
  assert.match(alertText(), /https/);
  assert.equal(closed, 0);
});

test('the main process’s reason shows, the form stays open, and a retry that works closes it', async () => {
  await mount();
  await fill('Name', 'My CMS');
  await fill('Payload address', 'http://localhost:3101');
  await fill('API key', 'wrong-key');
  answers.push({ ok: false, message: 'Payload did not accept this key.' });
  await submit();
  assert.equal(sent.length, 1);
  assert.deepEqual(
    { kind: sent[0].draft.kind, baseUrl: sent[0].draft.baseUrl, collection: sent[0].draft.collection },
    { kind: 'payload', baseUrl: 'http://localhost:3101', collection: 'users' },
  );
  assert.match(alertText(), /Payload did not accept this key\./);
  assert.equal(closed, 0);
  assert.equal(document.querySelector('button[type="submit"]').disabled, false, 'the person can try again');
  await fill('API key', 'right-key');
  answers.push('wait');
  // The save is started inside one act and left waiting: acts must not overlap.
  await act(async () => {
    document.querySelector('form').dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  assert.equal(document.querySelector('button[type="submit"]').disabled, true, 'saving is disabled while the server is asked');
  release();
  await settle();
  assert.equal(closed, 1);
});

const choose = async (triggerLabel, optionText) => {
  const trigger = [...document.querySelectorAll('button.dd-trigger')].find((button) => button.getAttribute('aria-label') === triggerLabel);
  assert.ok(trigger, `the ${triggerLabel} menu exists`);
  await act(async () => trigger.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  await settle();
  const option = [...document.querySelectorAll('.dd-option')].find((item) => item.textContent.includes(optionText));
  assert.ok(option, `the ${optionText} choice exists`);
  await act(async () => option.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  await settle();
};
const press = async (text) => {
  const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === text);
  assert.ok(button, `the ${text} button exists`);
  await act(async () => button.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  await settle();
};

test('an email and password are offered instead of a key, and are sent as the account, with the collections typed', async () => {
  await mount();
  await fill('Name', 'Login CMS');
  await fill('Payload address', 'http://localhost:3101');
  assert.ok(![...document.querySelectorAll('label')].some((item) => item.textContent.trim().startsWith('Email')), 'a key needs no email');
  await choose('Sign in with', 'Email and password');
  await fill('Email', 'admin@example.test');
  await fill('Password', 'p@ss word');
  await fill('Collections', 'posts, pages, media, posts');
  answers.push({ ok: true, list: { encryption: 'available', connections: [] } });
  await submit();
  assert.equal(sent.length, 1);
  assert.deepEqual(
    { kind: sent[0].draft.kind, auth: sent[0].draft.auth, email: sent[0].draft.email, secret: sent[0].draft.secret, collections: sent[0].draft.collections },
    { kind: 'payload', auth: 'password', email: 'admin@example.test', secret: 'p@ss word', collections: ['posts', 'pages', 'media'] },
  );
  assert.equal(closed, 1);
});

test('a login without an email, or a collection that is not a slug, never reaches the main process', async () => {
  await mount();
  await fill('Payload address', 'http://localhost:3101');
  await choose('Sign in with', 'Email and password');
  await fill('Password', 'secret');
  await submit();
  assert.equal(sent.length, 0);
  assert.match(alertText(), /email/i);
  await fill('Email', 'admin@example.test');
  await fill('Collections', 'good, not a slug!');
  await submit();
  assert.equal(sent.length, 0);
  assert.match(alertText(), /Payload collection/);
});

test('Detect lists what the account can reach, flags collections that change live, and saves nothing', async () => {
  await mount();
  await fill('Payload address', 'http://localhost:3101');
  await fill('API key', 'abc');
  checkAnswers.push({
    ok: true,
    summary: {
      user: 'admin@example.test',
      mode: 'apiKey',
      checkedAt: '2026-11-13T12:00:00.000Z',
      graphql: true,
      locales: ['en', 'fr'],
      collections: [
        { slug: 'posts', drafts: true, upload: false },
        { slug: 'pages', drafts: false, upload: false },
        { slug: 'media', drafts: false, upload: true },
      ],
    },
  });
  await press('Detect');
  assert.equal(checks.length, 1);
  assert.equal(checks[0].request.action, 'detect');
  assert.equal(checks[0].request.draft.kind, 'payload');
  const text = document.querySelector('.cms-detected').textContent;
  assert.match(text, /3 collections found/);
  assert.match(text, /posts, pages, media/);
  assert.match(text, /Edits apply live in: pages\b/, 'a collection without drafts is named, an upload collection is not');
  assert.doesNotMatch(text, /live in: .*media/);
  assert.equal(sent.length, 0, 'Detect saves nothing');
  assert.equal(closed, 0);
});

test('a failed Detect shows the server’s reason and keeps the form', async () => {
  await mount();
  await fill('Payload address', 'http://localhost:3101');
  await fill('API key', 'abc');
  checkAnswers.push({ ok: false, message: 'Nothing is answering at http://localhost:3101.' });
  await press('Detect');
  assert.match(alertText(), /Nothing is answering/);
  assert.equal(closed, 0);
});

test('the form no longer claims edits are saved with ?draft=true, and says collections without drafts are live', async () => {
  await mount();
  const text = document.body.textContent;
  assert.doesNotMatch(text, /\?draft=true/);
  assert.match(text, /collections without drafts change live content/);
  await choose('Sign in with', 'Email and password');
  assert.match(document.body.textContent, /five wrong passwords lock the account for ten minutes/);
});
