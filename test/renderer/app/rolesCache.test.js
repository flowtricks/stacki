// Goal: Settings → Roles paints its real layout in the first frame. The roles file and the signed-in login are
// kept per project (src/app/roles/rolesCache.ts) and revalidated behind what is shown: the newest file read wins,
// a save's own text beats a read already under way, a failed file read keeps what is known, login reads share
// one call and a failed one is "signed out", the prefetch fills only unknown halves, and the cache holds at most
// eight projects. The tab (RolesSettings.tsx) draws its sections and card shapes before anything is read (never
// the words "Loading roles…"), draws the cached cards at once on a later open without waiting on the login (about
// a second of `gh auth status`), and swaps a newer file in place.
// Method: bundle the real cache and tab with esbuild; drive the cache with fake readers whose answers the test
// releases by hand, and mount the tab in jsdom against a fake bridge whose replies are held the same way, so
// "first frame" means the DOM straight after one synchronous render, before any reply has arrived.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const esbuild = require('esbuild');
const { JSDOM } = require('jsdom');
const { repoPath } = require('../../helpers/sources.js');
const { toastMessages } = require('../../helpers/toastCapture');

const output = repoPath('node_modules/.stacki-test/roles-cache.cjs');
fs.mkdirSync(path.dirname(output), { recursive: true });
esbuild.buildSync({
  stdin: {
    contents: [
      "export { createRolesCache, rolesCache, sameStoredRoles, ROLES_CACHE_LIMITS, EMPTY_ROLES_SNAPSHOT } from './src/app/roles/rolesCache';",
      "export { RolesSettings } from './src/app/settings/RolesSettings';",
      "export { setActualRole } from './src/lib/currentRole';",
      "export { ADMIN_VIEW, DEFAULT_PROJECT_ROLES, serializeProjectRoles } from './shared/properties/projectRoles';",
    ].join('\n'),
    resolveDir: repoPath('package.json').replace(/package\.json$/, ''),
    loader: 'ts',
  },
  outfile: output,
  inject: [repoPath('test/helpers/toastCaptureEntry.js')],
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
for (const name of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'KeyboardEvent']) {
  global[name] = dom.window[name];
}
global.IS_REACT_ACT_ENVIRONMENT = true;

/** A promise the test settles by hand. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

// The bridge's replies wait in these queues until a test releases them.
const metadataReplies = [];
const identityReplies = [];
window.avb = {
  projectMetadata: () => {
    const reply = deferred();
    metadataReplies.push(reply);
    return reply.promise;
  },
  writeProjectMetadata: async (input) => ({ ok: true, value: { source: input.write.source } }),
  rolesIdentity: () => {
    const reply = deferred();
    identityReplies.push(reply);
    return reply.promise;
  },
  onFsChanged: () => () => undefined,
};

const React = require('react');
const { act } = React;
const { createRoot } = require('react-dom/client');
const roles = require(output);
roles.setActualRole(roles.ADMIN_VIEW);

const tick = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const absent = { kind: 'absent' };
const ready = (source) => ({ kind: 'ready', roles: roles.DEFAULT_PROJECT_ROLES, source });

/** Fake readers: every call is recorded and answered when the test says. */
function fakeReaders() {
  const files = [];
  const logins = [];
  return {
    files,
    logins,
    readers: {
      readRoles: () => {
        const reply = deferred();
        files.push(reply);
        return reply.promise;
      },
      readIdentity: () => {
        const reply = deferred();
        logins.push(reply);
        return reply.promise;
      },
    },
  };
}

test('a project starts unknown, and a read fills the file half and tells listeners', async () => {
  const fake = fakeReaders();
  const cache = roles.createRolesCache(fake.readers);
  assert.equal(cache.snapshot('/a'), roles.EMPTY_ROLES_SNAPSHOT, 'nothing read: the shared empty snapshot');
  let told = 0;
  const stop = cache.subscribe(() => (told += 1));
  const read = cache.refreshStoredRoles('/a');
  fake.files[0].resolve(ready('one'));
  await read;
  assert.deepEqual(cache.snapshot('/a').file, { kind: 'known', stored: ready('one') });
  assert.equal(cache.snapshot('/a').identity.kind, 'unknown', 'the login half is untouched');
  assert.equal(told, 1);
  const before = cache.snapshot('/a');
  const again = cache.refreshStoredRoles('/a');
  fake.files[1].resolve(ready('one'));
  await again;
  assert.equal(cache.snapshot('/a'), before, 'the same text keeps the same snapshot, so readers do not re-render');
  assert.equal(told, 1);
  stop();
});

test('the newest file read wins: an older one that answers late is dropped', async () => {
  const fake = fakeReaders();
  const cache = roles.createRolesCache(fake.readers);
  const older = cache.refreshStoredRoles('/a');
  const newer = cache.refreshStoredRoles('/a');
  fake.files[1].resolve(ready('new'));
  await newer;
  fake.files[0].resolve(ready('old'));
  assert.deepEqual(await older, ready('old'), 'the caller still gets its own answer');
  assert.equal(cache.snapshot('/a').file.stored.source, 'new', 'but the cache keeps the newer one');
});

test("a save's own text beats a read already under way", async () => {
  const fake = fakeReaders();
  const cache = roles.createRolesCache(fake.readers);
  const read = cache.refreshStoredRoles('/a');
  cache.rememberStoredRoles('/a', ready('saved'));
  fake.files[0].resolve(ready('before the save'));
  await read;
  assert.equal(cache.snapshot('/a').file.stored.source, 'saved');
});

test('a failed file read keeps what is known and rejects', async () => {
  const fake = fakeReaders();
  const cache = roles.createRolesCache(fake.readers);
  cache.rememberStoredRoles('/a', ready('known'));
  const read = cache.refreshStoredRoles('/a');
  fake.files[0].reject(new Error('Disk gone'));
  await assert.rejects(read, /Disk gone/);
  assert.equal(cache.snapshot('/a').file.stored.source, 'known');
});

test('login reads share one call, and a failed one is known as signed out', async () => {
  const fake = fakeReaders();
  const cache = roles.createRolesCache(fake.readers);
  const first = cache.refreshRolesIdentity('/a');
  const second = cache.refreshRolesIdentity('/a');
  assert.equal(fake.logins.length, 1, 'a second caller shares the read under way');
  fake.logins[0].resolve('owner');
  assert.equal(await first, 'owner');
  assert.equal(await second, 'owner');
  assert.deepEqual(cache.snapshot('/a').identity, { kind: 'known', login: 'owner' });
  const failed = cache.refreshRolesIdentity('/a');
  assert.equal(fake.logins.length, 2, 'once answered, the next call reads again');
  fake.logins[1].reject(new Error('gh missing'));
  assert.equal(await failed, undefined);
  assert.deepEqual(cache.snapshot('/a').identity, { kind: 'known', login: undefined });
});

test('the prefetch reads only the halves still unknown', async () => {
  const fake = fakeReaders();
  const cache = roles.createRolesCache(fake.readers);
  cache.rememberStoredRoles('/a', absent);
  const warm = cache.prewarm('/a');
  assert.equal(fake.files.length, 0, 'a known file is not read again');
  assert.equal(fake.logins.length, 1);
  fake.logins[0].resolve('owner');
  await warm;
  await cache.prewarm('/a');
  assert.equal(fake.logins.length, 1, 'a fully known project reads nothing');
  const cold = cache.prewarm('/b');
  fake.files[0].reject(new Error('unreadable'));
  fake.logins[1].resolve(undefined);
  await cold;
  assert.equal(cache.snapshot('/b').file.kind, 'unknown', 'a failed prefetch leaves the tab to read and report');
});

test('the cache holds at most its project bound, dropping the least recent', () => {
  const cache = roles.createRolesCache(fakeReaders().readers);
  const projectsMax = roles.ROLES_CACHE_LIMITS.projectsMax;
  for (let index = 0; index <= projectsMax; index += 1) {
    cache.rememberStoredRoles(`/p${index}`, ready(`s${index}`));
  }
  assert.equal(cache.snapshot('/p0').file.kind, 'unknown', 'the oldest project went');
  assert.equal(cache.snapshot(`/p${projectsMax}`).file.kind, 'known');
  assert.equal(cache.snapshot('/p1').file.kind, 'known');
});

test('sameStoredRoles compares the text, and absent only matches absent', () => {
  assert.equal(roles.sameStoredRoles(absent, absent), true);
  assert.equal(roles.sameStoredRoles(absent, ready('x')), false);
  assert.equal(roles.sameStoredRoles(ready('x'), absent), false);
  assert.equal(roles.sameStoredRoles(ready('x'), ready('x')), true);
  assert.equal(roles.sameStoredRoles(ready('x'), ready('y')), false);
  assert.equal(roles.sameStoredRoles(ready('x'), { kind: 'invalid', message: 'bad', source: 'x' }), false);
});

let root;
function mountNow(projectPath) {
  root = createRoot(document.getElementById('root'));
  // One synchronous render: what is in the DOM now is the first frame, before any bridge reply.
  act(() => root.render(React.createElement(roles.RolesSettings, { projectPath })));
}
async function unmount() {
  await act(async () => root.unmount());
}
const cardNames = () => [...document.querySelectorAll('section.app-role h3, section.app-role .app-role-name')].map((item) => item.textContent.trim());
// A valid file needs an admin member; the defaults carry none until the first save names one.
const OWNED = {
  ...roles.DEFAULT_PROJECT_ROLES,
  roles: roles.DEFAULT_PROJECT_ROLES.roles.map((role) => (role.id === 'admin' ? { ...role, members: ['owner'] } : role)),
};
const replyFile = async (source) => {
  const reply = metadataReplies.shift();
  assert.ok(reply, 'the tab asked for the roles file');
  reply.resolve({ ok: true, value: source === undefined ? {} : { source } });
  await tick();
};

test('with nothing read yet, the first frame is the real layout with shapes, never loading words', async () => {
  metadataReplies.length = 0;
  identityReplies.length = 0;
  mountNow('/fresh');
  const screen = document.querySelector('section.app-roles');
  assert.ok(screen, 'the Roles screen is there at once');
  assert.equal(screen.getAttribute('aria-busy'), 'true');
  assert.doesNotMatch(screen.textContent, /Loading roles/, 'no plain loading text');
  assert.match(screen.textContent, /View as/, 'the access rows are drawn with their labels');
  assert.equal(document.querySelectorAll('[data-skeleton="role"]').length, 2, 'two card shapes hold the Admin and Client space');
  assert.ok(document.querySelector('.ui-skeleton'), 'the values are filled shapes');
  await replyFile(roles.serializeProjectRoles(OWNED));
  assert.equal(document.querySelectorAll('[data-skeleton="role"]').length, 0, 'the read swaps the shapes for cards');
  assert.ok(document.querySelector('section[aria-label="Admin role"]'), 'the cards show before the login answers');
  assert.doesNotMatch(toastMessages(), /Signed out/, 'an unknown login never flashes "Signed out"');
  identityReplies.shift().resolve({ login: undefined });
  await tick();
  assert.match(toastMessages(), /Signed out/, 'a known signed-out login says so, as a toast');
  assert.equal(document.querySelectorAll('.app-roles-notice, [role="alert"]').length, 0, 'and adds no paragraph to the screen');
  await unmount();
});

test('a later open paints the cached cards in the first frame and revalidates behind them', async () => {
  metadataReplies.length = 0;
  identityReplies.length = 0;
  const source = roles.serializeProjectRoles(OWNED);
  roles.rolesCache.rememberStoredRoles('/cached', { kind: 'ready', roles: OWNED, source });
  const started = performance.now();
  mountNow('/cached');
  const firstFrameMs = performance.now() - started;
  assert.equal(document.querySelectorAll('[data-skeleton="role"]').length, 0, 'no shapes: the cache answers');
  assert.ok(document.querySelector('section[aria-label="Admin role"]'), 'Admin is drawn in the first frame');
  assert.ok(document.querySelector('section[aria-label="Client role"]'), 'Client is drawn in the first frame');
  assert.ok(metadataReplies.length >= 1, 'and the file is read again behind it');
  assert.ok(identityReplies.length >= 1, 'as is the login');
  // Why log it: the number is the one the change is about (the login read alone took about a second before).
  console.log(`roles first frame from cache: ${firstFrameMs.toFixed(1)} ms, with the file and login still unanswered`);

  // Someone renamed Client elsewhere: the refresh swaps it in place.
  const renamed = {
    ...OWNED,
    roles: OWNED.roles.map((role) => (role.id === 'client' ? { ...role, name: 'Editor' } : role)),
  };
  await replyFile(roles.serializeProjectRoles(renamed));
  assert.ok(document.querySelector('section[aria-label="Editor role"]'), 'a newer file replaces the cached one in place');
  assert.equal(document.querySelectorAll('section[aria-label="Client role"]').length, 0);
  assert.ok(cardNames().length >= 2);
  await unmount();
});
