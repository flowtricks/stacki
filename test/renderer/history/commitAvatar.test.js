// Goal: every commit row shows its author: initials on a colour fixed per person at once,
// a GitHub picture once one is known, and the initials again if that picture fails.
// Methodology: check the pure initials and colour helpers, then mount the real timeline in
// JSDOM with a stubbed IPC boundary, answer the avatar request, and fire image load and
// error events on the rendered rows.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources');

async function bundle(entry, name) {
  const directory = repoPath('node_modules/.stacki-test/commit-avatar');
  fs.mkdirSync(directory, { recursive: true });
  const outfile = path.join(directory, `${name}.cjs`);
  await esbuild.build({
    entryPoints: [repoPath(entry)],
    outfile,
    bundle: true,
    format: 'cjs',
    platform: 'node',
    external: ['react', 'react-dom', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  return require(outfile);
}

const commit = (hash, author, email) => ({
  hash,
  shortHash: hash.slice(0, 7),
  parents: [],
  refs: [],
  isMerge: false,
  subject: `Commit ${hash.slice(0, 4)}`,
  author,
  email,
  when: '2026-10-20T10:00:00Z',
  files: [],
});

test('initials and colours are deterministic per person', async () => {
  const { authorInitials, authorColorIndex, authorColor } = await bundle('src/features/history/commitAvatars.ts', 'model');
  assert.equal(authorInitials('Ada Lovelace', 'ada@example.com'), 'AL');
  assert.equal(authorInitials('  ada   byron lovelace ', ''), 'AL');
  assert.equal(authorInitials('Stacki', 'x@example.com'), 'S');
  assert.equal(authorInitials('', 'grace.hopper@example.com'), 'GR');
  assert.equal(authorInitials('—', ''), '?');
  assert.equal(authorInitials('élodie Ünal', ''), 'ÉÜ');
  const index = authorColorIndex('Ada@Example.com', 'Ada');
  assert.equal(authorColorIndex(' ada@example.com ', 'Someone else'), index, 'the email decides, case-insensitively');
  assert.ok(Number.isInteger(index));
  assert.ok(index >= 0 && index < 6);
  assert.equal(authorColor('ada@example.com', ''), authorColor('ada@example.com', 'Ada'));
  const spread = new Set(Array.from({ length: 50 }, (_, person) => authorColorIndex(`person${person}@example.com`, '')));
  assert.ok(spread.size > 1, 'different people get different colours');
});

test('rows show initials, then the picture, then initials again on error', async () => {
  const Timeline = (await bundle('src/features/history/HistoryTimeline.tsx', 'timeline')).default;
  const dom = new JSDOM('<!doctype html><div id="root"></div>', { pretendToBeVisual: true });
  global.window = dom.window;
  global.document = dom.window.document;
  global.HTMLElement = dom.window.HTMLElement;
  global.Node = dom.window.Node;
  global.Element = dom.window.Element;
  window.matchMedia = () => ({ matches: true });
  window.setInterval = () => 0;
  window.clearInterval = () => {};
  global.IS_REACT_ACT_ENVIRONMENT = true;
  const React = require('react');
  const { act } = React;
  const { createRoot } = require('react-dom/client');
  const avatarRequests = [];
  const ada = commit('a'.repeat(40), 'Ada Lovelace', 'ada@example.com');
  const bot = commit('b'.repeat(40), 'Octo Cat', '9+octocat@users.noreply.github.com');
  window.avb = {
    gitLog: async () => ({ commits: [ada, bot], atEnd: true }),
    gitAvatars: (payload) => new Promise((resolve) => avatarRequests.push({ payload, resolve })),
  };
  const root = createRoot(document.getElementById('root'));
  try {
    await act(async () =>
      root.render(
        React.createElement(Timeline, {
          projectPath: '/project',
          branch: 'main',
          head: ada.hash,
          userEmail: undefined,
          previewRef: undefined,
          onExitPreview: () => {},
        }),
      ),
    );
    const avatars = () => [...document.querySelectorAll('.history-meta .history-avatar')];
    assert.equal(avatars().length, 2);
    const meta = document.querySelector('.history-meta');
    assert.equal(meta.firstElementChild.className, 'history-avatar', 'the avatar starts the meta line');
    assert.equal(meta.children[1].className, 'history-meta-text', 'the text has its own ellipsis box');
    // Rendering did not wait: initials are there, and the noreply picture needs no request.
    assert.equal(avatars()[0].textContent, 'AL');
    assert.equal(avatars()[0].querySelector('img') === null, true, 'no picture before an answer');
    assert.ok(avatars()[0].style.color.length > 0);
    const noreply = avatars()[1].querySelector('img');
    assert.equal(noreply.getAttribute('src'), 'https://avatars.githubusercontent.com/u/9?s=40');
    assert.equal(noreply.getAttribute('referrerpolicy'), 'no-referrer');
    assert.equal(noreply.getAttribute('loading'), 'lazy');
    assert.equal(noreply.dataset.state, 'loading');
    assert.equal(avatarRequests.length, 1);
    assert.deepEqual(avatarRequests[0].payload, { projectPath: '/project', commits: [{ hash: ada.hash, email: ada.email }] });
    await act(async () => avatarRequests[0].resolve([{ hash: ada.hash, url: 'https://avatars.githubusercontent.com/u/1?v=4' }]));
    const image = avatars()[0].querySelector('img');
    assert.equal(image.getAttribute('src'), 'https://avatars.githubusercontent.com/u/1?v=4');
    await act(async () => image.dispatchEvent(new window.Event('load')));
    assert.equal(avatars()[0].querySelector('img').dataset.state, 'ready');
    await act(async () => noreply.dispatchEvent(new window.Event('error')));
    assert.equal(avatars()[1].querySelector('img') === null, true, 'a failed picture is removed');
    assert.equal(avatars()[1].textContent, 'OC', 'and the initials remain');
  } finally {
    await act(async () => root.unmount());
  }
});

test('a malformed avatar reply leaves the initials', async () => {
  const { readCommitAvatars } = await bundle('src/features/history/commitAvatars.ts', 'bridge');
  global.window = { avb: { gitAvatars: async () => [{ hash: 'a'.repeat(40), url: 'https://tracker.example/a.png' }] } };
  assert.deepEqual(await readCommitAvatars('/project', [{ hash: 'a'.repeat(40), email: 'a@example.com' }]), []);
  global.window = { avb: { gitAvatars: async () => Promise.reject(new Error('offline')) } };
  assert.deepEqual(await readCommitAvatars('/project', [{ hash: 'a'.repeat(40), email: 'a@example.com' }]), []);
});

test('the meta line centres the avatar on the text and fits the fixed row', () => {
  const css = fs.readFileSync(repoPath('src/app/styles.css'), 'utf8');
  const rule = (selector) => {
    const match = new RegExp(`\\n${selector.replace(/[.]/g, '\\.')} \\{([^}]*)\\}`).exec(css);
    assert.ok(match, `${selector} has a rule`);
    return match[1];
  };
  const meta = rule('.history-meta');
  assert.match(meta, /display: flex;/);
  assert.match(meta, /align-items: center;/);
  assert.match(meta, /line-height: 16px;/);
  const avatar = rule('.history-avatar');
  assert.match(avatar, /width: 16px;/);
  assert.match(avatar, /height: 16px;/, 'no taller than the 16px line');
  assert.match(avatar, /place-items: center;/);
  assert.match(avatar, /flex-shrink: 0;/);
  assert.match(rule('.history-meta-text'), /text-overflow: ellipsis;/);
  // 8 top + 17 subject + 2 gap + 16 meta + 3 bottom: the 46px row the graph lane is drawn for.
  assert.match(rule('.history-commit-head'), /padding: 8px 6px 3px;/);
  assert.match(rule('.history-commit-main'), /gap: 2px;/);
});
