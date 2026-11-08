// Goal: Studio shows publishing through the same popup as Desktop, and every status Studio or its
// demo reports becomes a state that popup accepts, with the same steps and progress.
// Method: map each job status, including the demo's scripted run, through Studio's translation and
// the shared contract parser; read PublishButton's source to pin it to the vendored popup.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { parseDesktopPublishState } from '../vendor/stacki/shared/properties/publishState';
import { DemoPublish } from '../demo/publish';
import { publishStatusView, PUBLISH_INTERRUPTED_MESSAGE } from '../src/features/publishing/publishStatusView';

test('each running stage is a shared popup step with bounded progress', () => {
  const steps = (['preparing', 'building', 'committing', 'cleanup'] as const).map(
    (stage) => publishStatusView({ kind: 'building', id: 'job', stage }, 'running').state,
  );
  assert.deepEqual(steps, [
    { kind: 'running', step: 'Preparing files…', progress: { completed: 0, total: 4 } },
    { kind: 'running', step: 'Building website…', progress: { completed: 1, total: 4 } },
    { kind: 'running', step: 'Saving to GitHub…', progress: { completed: 2, total: 4 } },
    { kind: 'running', step: 'Cleaning up storage…', progress: { completed: 3, total: 4 } },
  ]);
  for (const state of steps) {
    assert.deepEqual(parseDesktopPublishState(state), state);
  }
  assert.deepEqual(publishStatusView({ kind: 'building', id: 'job', stage: 'deploying', deployment: 'pending' }, 'running').state, {
    kind: 'running',
    step: 'Deploying live website…',
    progress: { completed: 4, total: 5 },
  });
  assert.deepEqual(publishStatusView({ kind: 'building', id: 'job' }, 'running').state, { kind: 'running', step: 'Preparing publish…' });
  assert.deepEqual(publishStatusView(undefined, 'running').state, { kind: 'running', step: 'Preparing publish…' });
});

test('deploying without a pending deployment violates the stage bound', () => {
  assert.throws(() => publishStatusView({ kind: 'building', id: 'job', stage: 'deploying' }, 'running'), /Stage deploying runs within 4 stages/);
});

test('results keep Studio detail in the popup note', () => {
  const live = publishStatusView({ kind: 'committed', id: 'job', sha: 'a', url: 'https://example.com', deployment: 'live' }, 'running');
  assert.deepEqual(live, { state: { kind: 'done', github: true, hosting: true } });
  const unconnected = publishStatusView({ kind: 'committed', id: 'job', sha: 'a', url: 'https://example.com', cleanupWarning: 'Storage kept.' }, 'running');
  assert.deepEqual(unconnected, {
    state: { kind: 'done', github: true, hosting: false },
    note: 'Live deployment is not connected in this Studio. Storage kept.',
  });
  assert.equal(publishStatusView({ kind: 'failed', id: 'job', message: 'Broken' }, 'running').state.kind, 'failed');
  assert.deepEqual(publishStatusView(undefined, 'interrupted').state, { kind: 'failed', message: PUBLISH_INTERRUPTED_MESSAGE, github: false, hosting: false });
});

test('the demo run drives the shared popup from first stage to live', () => {
  let finished = 0;
  const demo = new DemoPublish({ siteURL: 'https://demo.example', saved: undefined, persist: () => undefined, finished: () => finished++ });
  const views = [publishStatusView(demo.start('all'), 'running')];
  for (let poll = 0; poll < 4; poll++) {
    views.push(publishStatusView(demo.poll(), 'running'));
  }
  for (const view of views) {
    assert.deepEqual(parseDesktopPublishState(view.state), view.state, 'The demo emits only shapes the popup accepts');
  }
  assert.deepEqual(
    views.map((view) => (view.state.kind === 'running' ? view.state.step : view.state.kind)),
    ['Preparing files…', 'Building website…', 'Saving to GitHub…', 'Deploying live website…', 'done'],
  );
  assert.deepEqual(views.at(-1), { state: { kind: 'done', github: true, hosting: true } });
  assert.equal(finished, 1);
});

test('PublishButton renders the vendored shared popup', async () => {
  const source = await readFile(new URL('../src/features/publishing/PublishButton.tsx', import.meta.url), 'utf8');
  assert.match(source, /import \{ PublishStatus \} from '\.\.\/\.\.\/\.\.\/vendor\/stacki\/src\/features\/publishing\/PublishStatus';/);
  assert.match(source, /<PublishStatus\b/);
  assert.doesNotMatch(source, /PublishProgress/);
});
