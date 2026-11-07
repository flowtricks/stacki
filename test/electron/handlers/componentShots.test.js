// Goal: the run controller starts a photograph run when the pictures are out of date, never twice for the
// same state of a project, never drops another project's request, and lets go of a run when told to.
// Methodology: a fake host stands in for the dev server, the disk and the windows, and a fake run is a
// promise the test settles by hand. Each rule is driven through list/schedule/stop and read off the calls
// the fake run received, including the isCurrent answers a real run would act on.
const test = require('node:test');
const assert = require('node:assert/strict');
const { ComponentShots } = require('#dist/electron/handlers/componentShots.js');

const FIRST_PROJECT = '/projects/a';
const SECOND_PROJECT = '/projects/b';

function harness() {
  const state = {
    server: { projectPath: FIRST_PROJECT, url: 'http://127.0.0.1:4321' },
    alive: true,
    fingerprints: { [FIRST_PROJECT]: 'fp-a1', [SECOND_PROJECT]: 'fp-b1' },
    stored: {},
    runs: [],
    sent: [],
  };
  const host = {
    devServers: { current: () => state.server, readTrailingSlash: () => 'ignore' },
    userDataPath: () => '/userData',
    send: (channel, payload) => state.sent.push([channel, payload]),
    run: (run) =>
      new Promise((resolve) => {
        state.runs.push({ run, finish: resolve });
      }),
    fingerprint: (projectPath) => state.fingerprints[projectPath],
    stored: (projectPath) => state.stored[projectPath],
    image: (projectPath, component) => `image:${projectPath}:${component}`,
    alive: async () => state.alive,
    pages: () => ({ pages: [], dynamicPages: [] }),
  };
  return { state, controller: new ComponentShots(host) };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
const fresh = (fingerprint) => ({ version: 1, fingerprint, capturedAt: 1, shots: [] });

test('an out-of-date project starts one run, however often it is asked', async () => {
  const { state, controller } = harness();
  assert.deepEqual(controller.list(FIRST_PROJECT), { shots: [] });
  controller.list(FIRST_PROJECT);
  controller.list(FIRST_PROJECT);
  await tick();
  assert.equal(state.runs.length, 1);
  assert.equal(state.runs[0].run.projectPath, FIRST_PROJECT);
  assert.equal(state.runs[0].run.devUrl, 'http://127.0.0.1:4321');
  controller.list(FIRST_PROJECT);
  assert.equal(state.runs.length, 1, 'asking while it runs starts nothing');
  state.stored[FIRST_PROJECT] = fresh('fp-a1');
  state.runs[0].finish({ ok: true, shots: 3 });
  await tick();
  controller.list(FIRST_PROJECT);
  assert.equal(state.runs.length, 1, 'a project whose pictures match its files starts nothing');
});

test('a run that failed is not repeated for the same files, and is for changed ones', async () => {
  const { state, controller } = harness();
  controller.list(FIRST_PROJECT);
  await tick();
  state.runs[0].finish({ ok: false, error: 'boom' });
  await tick();
  controller.list(FIRST_PROJECT);
  controller.list(FIRST_PROJECT);
  await tick();
  assert.equal(state.runs.length, 1, 'opening the palette again does not start the same failing run');
  state.fingerprints[FIRST_PROJECT] = 'fp-a2';
  controller.list(FIRST_PROJECT);
  await tick();
  assert.equal(state.runs.length, 2);
});

test('a run ended because the project went away is worth another try', async () => {
  const { state, controller } = harness();
  controller.list(FIRST_PROJECT);
  await tick();
  state.runs[0].finish({ ok: false, error: 'skipped' });
  await tick();
  controller.list(FIRST_PROJECT);
  await tick();
  assert.equal(state.runs.length, 2);
});

test('without a usable dev server nothing runs, and nothing is held against the project', async () => {
  const { state, controller } = harness();
  state.alive = false;
  controller.list(FIRST_PROJECT);
  await tick();
  assert.equal(state.runs.length, 0);
  state.alive = true;
  controller.list(FIRST_PROJECT);
  await tick();
  assert.equal(state.runs.length, 1);
  state.runs[0].finish({ ok: true, shots: 0 });
  await tick();
  state.server = { projectPath: SECOND_PROJECT, url: 'http://127.0.0.1:4400' };
  state.fingerprints[FIRST_PROJECT] = 'fp-a9';
  controller.list(FIRST_PROJECT);
  await tick();
  assert.equal(state.runs.length, 1, 'a dev server for another project is not this project’s');
});

test('another project’s request waits behind the running one, which steps aside at its next checkpoint', async () => {
  const { state, controller } = harness();
  controller.list(FIRST_PROJECT);
  await tick();
  const first = state.runs[0];
  assert.equal(first.run.isCurrent(), true);
  state.server = { projectPath: SECOND_PROJECT, url: 'http://127.0.0.1:4400' };
  controller.list(SECOND_PROJECT);
  assert.equal(first.run.isCurrent(), false, 'FIRST_PROJECT is told to stop');
  assert.equal(state.runs.length, 1, 'SECOND_PROJECT has not started while FIRST_PROJECT still holds the queue');
  first.finish({ ok: false, error: 'skipped' });
  await tick();
  assert.equal(state.runs.length, 2);
  assert.equal(state.runs[1].run.projectPath, SECOND_PROJECT);
  assert.equal(state.runs[1].run.isCurrent(), true);
  state.runs[1].finish({ ok: true, shots: 1 });
  await tick();
});

test('stop ends the run in progress, and a later ask starts a fresh one', async () => {
  const { state, controller } = harness();
  controller.list(FIRST_PROJECT);
  await tick();
  assert.equal(state.runs[0].run.isCurrent(), true);
  controller.stop();
  assert.equal(state.runs[0].run.isCurrent(), false);
  state.runs[0].finish({ ok: false, error: 'skipped' });
  await tick();
  controller.list(FIRST_PROJECT);
  await tick();
  assert.equal(state.runs.length, 2);
  assert.equal(state.runs[1].run.isCurrent(), true, 'the new run belongs to the new era');
});

test('progress is announced with the project it is for', async () => {
  const { state, controller } = harness();
  controller.list(FIRST_PROJECT);
  await tick();
  state.runs[0].run.onProgress();
  assert.deepEqual(state.sent, [['componentShots:changed', { projectPath: FIRST_PROJECT }]]);
});

test('a photograph is read through the host, for the project and component asked', () => {
  const { controller } = harness();
  assert.equal(controller.read(FIRST_PROJECT, '/projects/a/src/components/Hero.astro'), 'image:/projects/a:/projects/a/src/components/Hero.astro');
});

test('stored pictures are listed with their sizes and nothing else', () => {
  const { state, controller } = harness();
  state.stored[FIRST_PROJECT] = {
    version: 1,
    fingerprint: 'fp-a1',
    capturedAt: 1,
    shots: [{ component: '/x/Hero.astro', file: '0123456789abcdef.jpg', width: 1440, height: 800 }],
  };
  assert.deepEqual(controller.list(FIRST_PROJECT), { shots: [{ component: '/x/Hero.astro', width: 1440, height: 800 }] });
});
