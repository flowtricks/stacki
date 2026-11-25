// Goal: the main Publish button rests as "current" exactly when its default target has nothing
// left to commit, push or deploy, using the same destination states the menu rows read.
// Method: enumerate every destination state for every target and compare against a table
// written out by hand, then check that any change at all brings the button back to "ready".
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDesktopPublishState, publishButtonState } from '#dist/shared/properties/publishState.js';

const GITHUB = ['current', 'pending', 'unknown'] as const;
const HOSTING = ['current', 'pending', 'unknown', 'unconfigured'] as const;

test('publishing everything is ready only on a confirmed need, current only when both destinations are done', () => {
  for (const github of GITHUB) {
    for (const hosting of HOSTING) {
      const needed = github === 'pending' || hosting === 'pending';
      const finished = github === 'current' && (hosting === 'current' || hosting === 'unconfigured');
      const expected = needed ? 'ready' : finished ? 'current' : 'unconfirmed';
      assert.equal(publishButtonState({ github, hosting }, 'all'), expected, `${github}/${hosting}`);
    }
  }
});

test('a single-destination default reads only its own destination', () => {
  const answer = { current: 'current', pending: 'ready', unknown: 'unconfirmed' } as const;
  for (const github of GITHUB) {
    for (const hosting of HOSTING) {
      assert.equal(publishButtonState({ github, hosting }, 'github'), answer[github], `github ${github}/${hosting}`);
      // An unconfigured host cannot be finished: the click opens its setup.
      const hostingAnswer = hosting === 'unconfigured' ? 'ready' : answer[hosting];
      assert.equal(publishButtonState({ github, hosting }, 'hosting'), hostingAnswer, `hosting ${github}/${hosting}`);
    }
  }
});

test('the accent is never the answer to a check that has not replied', () => {
  for (const target of ['all', 'github', 'hosting'] as const) {
    assert.notEqual(publishButtonState({ github: 'unknown', hosting: 'unknown' }, target), 'ready', target);
  }
  assert.notEqual(publishButtonState({ github: 'current', hosting: 'unknown' }, 'all'), 'ready');
  assert.notEqual(publishButtonState({ github: 'unknown', hosting: 'current' }, 'all'), 'ready');
});

test('the first confirmed change after a finished publish makes the button ready again', () => {
  const published = { github: 'current', hosting: 'current', githubPush: { commits: 0, repositoryUrl: 'https://github.com/a/b' } } as const;
  assert.equal(publishButtonState(published, 'all'), 'current');
  assert.equal(publishButtonState({ ...published, github: 'pending', githubPush: { commits: 1, repositoryUrl: 'https://github.com/a/b' } }, 'all'), 'ready');
  assert.equal(publishButtonState({ ...published, hosting: 'pending' }, 'all'), 'ready');
});

// A message reference beside the English text is optional on the wire (old producers send none) and dropped when invalid.
test('a publish state keeps a valid message reference and drops an invalid one', () => {
  const running = { kind: 'running', step: 'Building website…', stepRef: { key: 'publish.status.step.building' } };
  assert.deepEqual(parseDesktopPublishState(running), running);
  const failed = { kind: 'failed', message: 'Publish failed.', github: false, hosting: false, messageRef: { key: 'publish.studio.interrupted' } };
  assert.deepEqual(parseDesktopPublishState(failed), failed);
  assert.deepEqual(parseDesktopPublishState({ kind: 'running', step: 'Building website…' }), { kind: 'running', step: 'Building website…' });
  const broken = parseDesktopPublishState({ ...failed, messageRef: { key: 'not a key' } });
  assert.deepEqual(broken, { kind: 'failed', message: 'Publish failed.', github: false, hosting: false });
  assert.deepEqual(parseDesktopPublishState({ ...running, stepRef: 7 }), { kind: 'running', step: 'Building website…' });
});
